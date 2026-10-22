/**
 * team-tools.js - 团队概况工具
 *
 * 封装 team-aggregator 调用。
 * 这是少数需要做 I/O 的"混合工具"，因为团队数据来自多个异构源。
 * executor 会用 await 调用。
 */

const teamAggregator = require('../services/team-aggregator');

// ==================== E1. 团队概况 ====================

async function overview(memory, scope) {
  if (!scope || (!scope.isGlobal && (!scope.subordinateNames || scope.subordinateNames.length === 0))) {
    return { empty: true, message: '当前用户无下属记录，暂无法查看团队汇总' };
  }

  const empName = scope.empName || '';
  const summary = await teamAggregator.getTeamDailySummary(empName, scope);

  if (!summary || !summary.members || summary.members.length === 0) {
    return { empty: true, message: '团队成员数据暂时为空' };
  }

  const periodLabel = summary.period === 'weekly' ? '本周（周报口径）' : '今日（日报口径）';
  return {
    period: summary.period || 'daily',
    totalMembers: summary.stats?.totalMembers || summary.members.length,
    activeMembers: summary.stats?.activeMembers || 0,
    members: summary.members.map(m => ({
      name: m.name || '',
      dept: m.dept || '',
      status: m.status || '',
      todayTasks: m.todayTasks || m.tasks || [],
      projectProgress: m.projectProgress || [],
    })),
    stats: summary.stats || {},
    _sourceTable: 'WORK_ITEMS（工作事项）+ EMPLOYEE_MASTER（员工主档）',
    _periodLabel: periodLabel,
  };
}

module.exports = { overview };
