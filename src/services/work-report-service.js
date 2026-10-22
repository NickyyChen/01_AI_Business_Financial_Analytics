/**
 * work-report-service.js - 工作周报/月报自动生成
 *
 * 整合日历 + 妙记 + Bitable工作事项，通过 LLM 生成结构化报告
 */

const calendarService = require('./calendar-service');
const minutesService = require('./minutes-service');
const memory = require('./memory-manager');
const llm = require('../clients/llm-client');
const client = require('../clients/feishu-client');
const config = require('../../config');
const tokenStore = require('../stores/user-token-store');
const logger = require('../utils/logger');

// ==================== 报告类型 ====================

const REPORT_TYPES = {
  WEEKLY: { label: '周报', days: 7, calDays: 7, minDays: 7 },
  MONTHLY: { label: '月报', days: 30, calDays: 30, minDays: 30 },
  DAILY: { label: '日报', days: 1, calDays: 1, minDays: 1 },
};

// ==================== 数据收集 ====================

/**
 * 收集用户的全部工作数据
 * @param {string} openId
 * @param {string} userId - 用于查 Bitable 的 ID（姓名或员工ID）
 * @param {string} reportType - 'WEEKLY' | 'MONTHLY' | 'DAILY'
 * @returns {object} 汇总数据
 */
async function collectWorkData(openId, userId, reportType) {
  const rt = REPORT_TYPES[reportType] || REPORT_TYPES.WEEKLY;
  const data = {
    reportType: rt.label,
    period: buildPeriodString(rt.days),
    calendar: null,
    minutes: null,
    chatSnapshots: null,
    bitableMemory: null,
    hasUserToken: false,
  };

  // 1. 检查用户是否有 user_access_token
  const userToken = await tokenStore.getUserAccessToken(openId);
  data.hasUserToken = !!userToken;

  // 2. 并行拉取数据
  const tasks = [];

  // 日历数据（需要 user_token）
  if (userToken) {
    tasks.push(
      calendarService.queryUserCalendar(openId, rt.calDays)
        .then(r => { data.calendar = r; })
        .catch(e => { logger.warn(`[WorkReport] 日历拉取失败: ${e.message}`); })
    );

    // 妙记数据（需要 user_token）
    tasks.push(
      minutesService.queryUserMinutes(openId, rt.minDays)
        .then(r => { data.minutes = r; })
        .catch(e => { logger.warn(`[WorkReport] 妙记拉取失败: ${e.message}`); })
    );
  }

  // Bitable 历史数据（显式指定选表，确保 meetings/chat/workItems 都被加载）
  const reportTables = new Set(['profile', 'employeeProfile', 'meetings', 'calendar', 'workItems', 'projects']);
  tasks.push(
    memory.getUserMemory(userId, { userName: userId, question: `生成${rt.label}`, plannedTables: reportTables })
      .then(r => { data.bitableMemory = r; })
      .catch(e => { logger.warn(`[WorkReport] Bitable 记忆拉取失败: ${e.message}`); })
  );

  // 群聊摘要（从 CHAT_SNAPSHOT 按时间范围拉取）
  tasks.push(
    fetchChatSnapshots(userId, rt.days)
      .then(r => { data.chatSnapshots = r; })
      .catch(e => { logger.warn(`[WorkReport] 群聊摘要拉取失败: ${e.message}`); })
  );

  await Promise.all(tasks);

  return data;
}

/**
 * 从 CHAT_SNAPSHOT 表拉取指定用户近 N 天的群聊摘要
 */
async function fetchChatSnapshots(userId, days) {
  try {
    if (!config.TABLES.CHAT_SNAPSHOT) return [];
    const cutoff = Date.now() - days * 24 * 3600 * 1000;
    const filter = `OR(CurrentValue.[员工ID]="${userId}",CurrentValue.[姓名]="${userId}")`;
    const records = await client.listRecords(config.TABLES.CHAT_SNAPSHOT, { filter, page_size: 50 });
    return records.filter(r => {
      const t = (r.fields || {})['采集时间'] || (r.fields || {})['创建时间'];
      if (!t) return true;
      return t >= cutoff;
    });
  } catch (e) {
    logger.warn(`[WorkReport] CHAT_SNAPSHOT 查询失败: ${e.message}`);
    return [];
  }
}

/**
 * 构建时间范围字符串
 */
function buildPeriodString(days) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 3600 * 1000);
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${fmt(start)} ~ ${fmt(end)}`;
}

// ==================== 报告生成 ====================

/**
 * 生成工作报告
 * @param {string} openId
 * @param {string} userId - Bitable 查询ID
 * @param {string} userName - 用户姓名
 * @param {string} reportType - 'WEEKLY' | 'MONTHLY' | 'DAILY'
 * @param {string} [customRequest] - 用户的自定义要求
 * @returns {object} { success, report, needAuth }
 */
async function generateReport(openId, userId, userName, reportType, customRequest) {
  logger.info(`[WorkReport] 开始生成 ${reportType} | ${userName} (${openId})`);

  // 1. 收集数据
  const workData = await collectWorkData(openId, userId, reportType);

  // 2. 构建数据摘要文本
  const dataSummary = buildDataSummary(workData);

  // 3. 如果没有任何数据
  if (!dataSummary.trim()) {
    return {
      success: false,
      report: '暂无足够的工作数据来生成报告。请确保您已授权日历和妙记权限，或系统中有您的工作记录。',
      needAuth: !workData.hasUserToken,
    };
  }

  // 4. 通过 LLM 生成报告
  const prompt = buildReportPrompt(workData.reportType, workData.period, userName, dataSummary, customRequest);

  try {
    const result = await llm.ask(prompt.system, prompt.user, {
      temperature: 0.4,
      max_output_tokens: 4096,
    });

    logger.info(`[WorkReport] 报告生成完成: ${result.length} 字`);

    // 5. 写入工作总结到 Bitable（异步，不阻塞）
    memory.writeWorkSummary(userId, {
      period: workData.period,
      content: result.slice(0, 2000),
      highlights: '',
      issues: '',
    }).catch(e => logger.warn(`[WorkReport] 总结写入失败: ${e.message}`));

    return { success: true, report: result, needAuth: false };
  } catch (e) {
    logger.error(`[WorkReport] LLM 生成失败: ${e.message}`);
    return {
      success: false,
      report: `报告生成失败：${e.message}`,
      needAuth: false,
    };
  }
}

/**
 * 构建数据摘要文本
 */
function buildDataSummary(workData) {
  const parts = [];

  // 日历数据
  if (workData.calendar && workData.calendar.success && workData.calendar.text) {
    parts.push(`===== 日历/日程数据 =====`);
    parts.push(workData.calendar.text);
  }

  // 妙记数据
  if (workData.minutes && workData.minutes.success && workData.minutes.text) {
    parts.push(`===== 妙记/会议纪要 =====`);
    parts.push(workData.minutes.text);
  }

  // 群聊摘要数据
  if (workData.chatSnapshots && workData.chatSnapshots.length > 0) {
    const chatLines = [`===== 群聊摘要 =====\n共 ${workData.chatSnapshots.length} 条群聊记录\n`];
    for (const r of workData.chatSnapshots.slice(0, 15)) {
      const f = r.fields || {};
      const chatName = f['群名称'] || f['群名'] || '(未知群)';
      const time = f['采集时间'] ? new Date(f['采集时间']).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';
      let line = `- ${chatName}`;
      if (time) line += ` | ${time}`;
      if (f['摘要'] || f['AI摘要']) {
        line += `\n  摘要: ${String(f['摘要'] || f['AI摘要']).slice(0, 300)}`;
      }
      if (f['待办事项'] || f['待办']) {
        line += `\n  待办: ${String(f['待办事项'] || f['待办']).slice(0, 200)}`;
      }
      if (f['@提及']) {
        line += `\n  @提及: ${String(f['@提及']).slice(0, 100)}`;
      }
      chatLines.push(line);
    }
    parts.push(chatLines.join('\n'));
  }

  // Bitable 历史数据
  if (workData.bitableMemory) {
    const memText = memory.formatMemoryForLLM(workData.bitableMemory);
    if (memText.trim()) {
      parts.push(`===== 组织系统数据 =====`);
      parts.push(memText);
    }
  }

  return parts.join('\n\n');
}

/**
 * 构建报告生成的 Prompt
 */
function buildReportPrompt(reportLabel, period, userName, dataSummary, customRequest) {
  const system = `你是企业组织智能助手，负责根据员工的工作数据生成高质量的${reportLabel}。

要求：
1. 报告结构清晰，包含以下板块（根据数据情况灵活调整）：
   - 本期概览（一句话总结本期工作重心和成果）
   - 重点工作（按重要性排列，每项包含具体内容和结果）
   - 会议参与（会议数量、重要会议摘要、会议中产生的待办）
   - 群聊协作（从群聊摘要中提取关键讨论、决策、@提及事项）
   - 协作沟通（跨部门协作、关键沟通）
   - 待办清单（汇总整理所有待办来源，标注来源和优先级）
     * 从会议纪要/妙记中提取的待办
     * 从群聊@提及或讨论中产生的待办
     * 从日历未来事项中识别的准备工作
     * 从工作事项表中的未完成事项
   - 下期重点（基于待办清单，提炼下期 3-5 个核心工作方向）
   - 问题与建议（如有）

2. 格式要求：
   - 使用中文，语言简洁专业
   - 用 markdown 格式，标题用 **加粗** 而非 # 号（飞书消息不支持 #）
   - 具体日期和数字，不要模糊表述
   - 待办清单每项标注来源（如 [会议]、[群聊]、[日历]、[系统]）
   - 合理分段，条理清晰

3. 数据原则：
   - 只基于提供的数据生成，不编造内容
   - 如果某类数据缺失，跳过对应板块，不要提及缺失
   - 优先突出有价值的工作内容
   - 待办清单要做去重合并，相似待办合并为一条`;

  let user = `请为 **${userName}** 生成 **${reportLabel}**\n时间范围：${period}\n`;

  if (customRequest) {
    user += `\n用户特别要求：${customRequest}\n`;
  }

  user += `\n以下是收集到的工作数据：\n\n${dataSummary}`;

  return { system, user };
}

// ==================== 意图解析 ====================

/**
 * 2026-04-23 财务经营类关键词黑名单
 *
 * 这些词出现在问题里时，即便也含"月报/周报/日报"，
 * 也**不应该**走本 service（个人工作报告，依赖日历+妙记+工作事项），
 * 而应交给财务 Agent Pipeline（Plan → Execute → Aggregate）
 * 基于飞书多维表生成部门/项目经营总结。
 *
 * 命名规则（减少误伤）：
 * - 尽量用"双字 / 复合词"，避免把单字 "利/成" 这种容易出现在无关语境里的短词纳入
 * - 只匹配财务经营域的专有名词
 */
const FINANCE_OVERRIDE_KEYWORDS = [
  // 复合"经营"
  '经营月报', '经营周报', '经营日报',
  '经营总结', '经营体检', '经营复盘', '经营分析', '经营总览', '经营情况',
  // 部门/项目的经营报告
  '部门月报', '部门周报', '部门经营',
  '项目月报', '项目周报', '项目经营',
  // 财务核心指标（单独出现几乎都是财务问句）
  '利润率', '利润总览', '亏损',
  '回款', '应收', '开票', '逾期',
  '成本', '超支', '超预算', '预实', '预算',
  '人均创收', '人效', 'FTE', '工时',
  '同比', '环比', '账期',
  // 本年/年初累计
  '本年累计', '年初至今', 'YTD',
];

/**
 * 判断问题是否属于"财务经营类"（应走 Pipeline，不走个人工作报告）
 * @param {string} lower - 已 toLowerCase 的问题文本
 * @returns {boolean}
 */
function _isFinanceBusinessQuery(lower) {
  return FINANCE_OVERRIDE_KEYWORDS.some(k => lower.includes(k.toLowerCase()));
}

/**
 * 从用户消息中解析报告类型
 * @param {string} content
 * @returns {string} 'WEEKLY' | 'MONTHLY' | 'DAILY' | null
 */
function detectReportType(content) {
  const lower = (content || '').toLowerCase();

  // 2026-04-23 修复：财务经营类月报/周报/日报 归财务 Agent Pipeline 处理
  // e.g. "给我一份部门经营月报摘要" / "项目经营周报" / "今年部门利润月报"
  // 返回 null → 由 pipeline 基于 finance 工具生成（见 P1 planner 复合 Plan）
  if (_isFinanceBusinessQuery(lower)) {
    return null;
  }

  if (lower.includes('日报') || lower.includes('今日总结') || lower.includes('今天总结')) {
    return 'DAILY';
  }
  if (lower.includes('月报') || lower.includes('月度总结') || lower.includes('本月总结') || lower.includes('这个月总结')) {
    return 'MONTHLY';
  }
  if (lower.includes('周报') || lower.includes('本周总结') || lower.includes('这周总结') || lower.includes('每周总结') || lower.includes('工作总结') || lower.includes('工作报告')) {
    return 'WEEKLY';
  }
  return null;
}

module.exports = {
  generateReport,
  detectReportType,
  REPORT_TYPES,
  // 导出辅助判断，bot.js 在 isPrivateOnlyQuery 里复用同一组关键词
  _isFinanceBusinessQuery,
  FINANCE_OVERRIDE_KEYWORDS,
};
