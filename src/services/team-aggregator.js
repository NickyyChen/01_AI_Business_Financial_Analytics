/**
 * team-aggregator.js - 团队数据聚合服务
 *
 * 为管理者提供团队维度的工作汇总（按人按天/周）。
 * 数据来源：WORK_ITEM、MEETING_SNAPSHOT、CALENDAR_EVENT、CHAT_SNAPSHOT、WORK_SUMMARY
 *
 * 两种视角:
 *   1. 按人: 每个成员的工作项、会议、日程、待办
 *   2. 按项目: 跨人员聚合的项目进度、风险、待办
 */

const config = require('../../config');
const client = require('../clients/feishu-client');
const memoryManager = require('./memory-manager');
const permManager = require('../permissions/permission-manager');
const logger = require('../utils/logger');
const FM = require('../utils/field-mapping');

/**
 * 获取团队每日工作汇总
 * @param {string} managerName - 管理者姓名
 * @param {object} scope       - AccessScope（含 subordinateNames）
 * @param {string} [dateStr]   - 目标日期 YYYY-MM-DD，默认今天
 * @returns {object} { members, projectSummary, stats }
 */
async function getTeamDailySummary(managerName, scope, dateStr) {
  const memberNames = scope.subordinateNames || [];
  if (memberNames.length === 0) {
    return { members: [], projectSummary: [], stats: { totalMembers: 0 } };
  }

  const targetDate = dateStr || new Date().toISOString().slice(0, 10);
  logger.info(`[TeamAggregator] 日汇总: ${managerName} | ${memberNames.length}人 | ${targetDate}`);

  const members = await _aggregateMembers(memberNames, targetDate, targetDate);
  const projectSummary = _aggregateByProject(members);
  const stats = _computeStats(members);

  return { members, projectSummary, stats, date: targetDate };
}

/**
 * 获取团队每周工作汇总
 * @param {string} managerName - 管理者姓名
 * @param {object} scope       - AccessScope
 * @param {object} [weekRange] - { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }
 * @returns {object}
 */
async function getTeamWeeklySummary(managerName, scope, weekRange) {
  const memberNames = scope.subordinateNames || [];
  if (memberNames.length === 0) {
    return { members: [], projectSummary: [], stats: { totalMembers: 0 } };
  }

  // 默认本周（周一到周日）
  const now = new Date();
  const dow = now.getDay() || 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - dow + 1);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const start = weekRange?.start || monday.toISOString().slice(0, 10);
  const end = weekRange?.end || sunday.toISOString().slice(0, 10);

  logger.info(`[TeamAggregator] 周汇总: ${managerName} | ${memberNames.length}人 | ${start}~${end}`);

  const members = await _aggregateMembers(memberNames, start, end);
  const projectSummary = _aggregateByProject(members);
  const stats = _computeStats(members);

  return { members, projectSummary, stats, weekRange: { start, end } };
}

/**
 * 对每个成员并行加载和聚合数据
 */
async function _aggregateMembers(memberNames, startDate, endDate) {
  const batchSize = 5;
  const results = [];

  for (let i = 0; i < memberNames.length; i += batchSize) {
    const batch = memberNames.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(
      batch.map(name => _loadMemberData(name, startDate, endDate))
    );
    for (let j = 0; j < batch.length; j++) {
      if (batchResults[j].status === 'fulfilled') {
        results.push(batchResults[j].value);
      } else {
        results.push({ name: batch[j], meetings: [], calendar: [], workItems: [], projects: [], error: batchResults[j].reason?.message });
      }
    }
  }

  return results;
}

async function _loadMemberData(memberName, startDate, endDate) {
  const escName = memberName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const [meetingsRes, calendarRes, workItemsRes, staffingRes] = await Promise.allSettled([
    config.TABLES.MEETING_SNAPSHOT
      ? client.listRecords(config.TABLES.MEETING_SNAPSHOT, {
          filter: `OR(CurrentValue.[姓名]="${escName}",CurrentValue.[员工ID]="${escName}")`,
          page_size: 50,
        })
      : [],
    config.TABLES.CALENDAR_EVENT
      ? client.listRecords(config.TABLES.CALENDAR_EVENT, {
          filter: `OR(CurrentValue.[姓名]="${escName}",CurrentValue.[员工ID]="${escName}")`,
          page_size: 50,
        })
      : [],
    config.TABLES.WORK_ITEM
      ? client.listRecords(config.TABLES.WORK_ITEM, {
          filter: `OR(CurrentValue.[员工ID]="${escName}",CurrentValue.[姓名]="${escName}")`,
          page_size: 50,
        })
      : [],
    // P1-2 修复：旧 PROJECT_STAFFING 已废弃，切换到 ACTUAL_WORKTIME（实际：26年工时）
    config.TABLES.ACTUAL_WORKTIME
      ? client.listRecords(config.TABLES.ACTUAL_WORKTIME, {
          filter: `CurrentValue.[${FM.ACTUAL_WORKTIME_FIELDS.NAME}]="${escName}"`,
          page_size: 100,
        })
      : [],
  ]);

  const meetings = _filterByDate(
    meetingsRes.status === 'fulfilled' ? meetingsRes.value : [],
    '会议时间', startDate, endDate
  );
  const calendar = _filterByDate(
    calendarRes.status === 'fulfilled' ? calendarRes.value : [],
    '开始时间', startDate, endDate
  );
  const workItems = workItemsRes.status === 'fulfilled' ? workItemsRes.value : [];
  const staffing = staffingRes.status === 'fulfilled' ? staffingRes.value : [];

  // 提取项目列表 — 新表 ACTUAL_WORKTIME 的项目字段是 "匹配项目"（lookup 数组）
  const projects = [...new Set(
    staffing
      .map(r => FM.lookupFirst((r.fields || {})[FM.ACTUAL_WORKTIME_FIELDS.PROJECT_MATCH]))
      .filter(Boolean)
  )];

  // 统计待办事项
  const todoItems = workItems.filter(r => {
    const status = (r.fields || {})['状态'] || '';
    return status.includes('待') || status.includes('进行');
  });

  return {
    name: memberName,
    meetings: meetings.map(r => {
      const f = r.fields || {};
      return {
        topic: f['会议主题'] || '(无主题)',
        time: f['会议时间'] ? new Date(f['会议时间']).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '',
        duration: f['会议时长（分钟）'] || 0,
        summary: (f['AI摘要'] && f['AI摘要'] !== '(待获取)') ? f['AI摘要'].slice(0, 200) : '',
      };
    }),
    calendar: calendar.map(r => {
      const f = r.fields || {};
      return {
        title: f['日程标题'] || '(无主题)',
        time: f['开始时间'] ? new Date(f['开始时间']).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '',
        type: f['日程类型'] || '',
      };
    }),
    workItems: workItems.slice(0, 20).map(r => {
      const f = r.fields || {};
      return {
        title: f['事项标题'] || '',
        type: f['事项类型'] || '',
        status: f['状态'] || '',
      };
    }),
    todoCount: todoItems.length,
    projects,
  };
}

/**
 * 过滤指定日期范围内的记录
 */
function _filterByDate(records, timeField, startDate, endDate) {
  const startTs = new Date(startDate + 'T00:00:00+08:00').getTime();
  const endTs = new Date(endDate + 'T23:59:59+08:00').getTime();

  return records.filter(r => {
    const f = r.fields || {};
    const ts = Number(f[timeField]);
    if (!ts) return false;
    return ts >= startTs && ts <= endTs;
  });
}

/**
 * 按项目维度聚合（跨人员）
 */
function _aggregateByProject(members) {
  const projectMap = {};

  for (const member of members) {
    for (const projKey of member.projects) {
      if (!projectMap[projKey]) {
        projectMap[projKey] = { key: projKey, members: [], meetingCount: 0, todoCount: 0 };
      }
      projectMap[projKey].members.push(member.name);
      projectMap[projKey].meetingCount += member.meetings.length;
      projectMap[projKey].todoCount += member.todoCount;
    }
  }

  return Object.values(projectMap).sort((a, b) => b.members.length - a.members.length);
}

function _computeStats(members) {
  return {
    totalMembers: members.length,
    totalMeetings: members.reduce((s, m) => s + m.meetings.length, 0),
    totalTodos: members.reduce((s, m) => s + m.todoCount, 0),
    totalCalendarEvents: members.reduce((s, m) => s + m.calendar.length, 0),
    activeProjects: [...new Set(members.flatMap(m => m.projects))].length,
  };
}

/**
 * 将团队汇总格式化为可读文本
 */
function formatTeamSummary(summary, viewMode = 'byPerson') {
  const lines = [];

  if (summary.weekRange) {
    lines.push(`📋 **团队周报** | ${summary.weekRange.start} ~ ${summary.weekRange.end}\n`);
  } else {
    lines.push(`📋 **团队日报** | ${summary.date}\n`);
  }

  // 总览统计
  const s = summary.stats;
  lines.push(`👥 团队: ${s.totalMembers}人 | 📅 日程: ${s.totalCalendarEvents}个 | 🤝 会议: ${s.totalMeetings}场 | ✅ 待办: ${s.totalTodos}项 | 📁 项目: ${s.activeProjects}个`);
  lines.push('');

  if (viewMode === 'byProject') {
    return lines.join('\n') + _formatByProject(summary);
  }
  return lines.join('\n') + _formatByPerson(summary);
}

function _formatByPerson(summary) {
  const lines = [];
  for (const member of summary.members) {
    lines.push(`\n👤 **${member.name}** | 项目:${member.projects.length}个 | 会议:${member.meetings.length}场 | 待办:${member.todoCount}项`);

    if (member.meetings.length > 0) {
      lines.push('  🤝 会议:');
      for (const m of member.meetings.slice(0, 3)) {
        lines.push(`    • ${m.topic} (${m.duration}分钟)`);
      }
      if (member.meetings.length > 3) lines.push(`    ...共${member.meetings.length}场`);
    }

    if (member.workItems.length > 0) {
      const todos = member.workItems.filter(w => w.status.includes('待') || w.status.includes('进行'));
      if (todos.length > 0) {
        lines.push('  ✅ 待办:');
        for (const w of todos.slice(0, 3)) {
          lines.push(`    • [${w.status}] ${w.title}`);
        }
        if (todos.length > 3) lines.push(`    ...共${todos.length}项`);
      }
    }

    if (member.projects.length > 0) {
      lines.push(`  📁 参与项目: ${member.projects.slice(0, 5).join('、')}${member.projects.length > 5 ? '等' : ''}`);
    }
  }
  return lines.join('\n');
}

function _formatByProject(summary) {
  const lines = [];
  if (summary.projectSummary.length === 0) {
    lines.push('暂无项目数据。');
    return lines.join('\n');
  }

  for (const proj of summary.projectSummary.slice(0, 10)) {
    lines.push(`\n📁 **${proj.key}**`);
    lines.push(`  团队: ${proj.members.join('、')} (${proj.members.length}人)`);
    lines.push(`  会议: ${proj.meetingCount}场 | 待办: ${proj.todoCount}项`);
  }
  return lines.join('\n');
}

module.exports = {
  getTeamDailySummary,
  getTeamWeeklySummary,
  formatTeamSummary,
};
