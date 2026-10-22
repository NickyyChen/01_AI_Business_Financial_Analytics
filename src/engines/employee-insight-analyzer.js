/**
 * employee-insight-analyzer.js - 员工风险洞察分析引擎
 *
 * 对单个员工的对话/会议/工作数据做 LLM 分析，
 * 识别异动风险、离职倾向，输出结构化洞察。
 *
 * 输入：employee memory（来自 memory-manager）
 * 输出：写入「【龙虾】员工风险洞察」表的字段结构
 */

const llm = require('../clients/llm-client');
const config = require('../../config');
const client = require('../clients/feishu-client');
const logger = require('../utils/logger');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ==================== 系统提示词 ====================

const SYSTEM_PROMPT = `你是一位专业的组织健康分析师，专注于通过员工行为数据识别潜在风险。

分析原则：
1. 基于客观数据，避免主观偏见
2. 区分短期情绪波动与持续性风险信号
3. 对置信度低的判断如实说明
4. 建议要具体可操作，不要泛泛而谈

你的输出必须是严格的 JSON 格式，不得包含任何 markdown 符号或额外解释。`;

// ==================== 数据准备 ====================

/**
 * 从 memory 中提取用于风险分析的文本摘要
 * 控制 token 量，只保留关键信息
 */
function buildAnalysisContext(memory, periodDays) {
  const parts = [];
  const cutoff = Date.now() - periodDays * 24 * 3600 * 1000;

  // 员工档案
  if (memory.profile) {
    const p = memory.profile;
    parts.push(`【员工基本信息】
姓名: ${p['姓名'] || ''}
部门: ${p['标准部门'] || ''}
职级: ${p['当前职级'] || ''}
在岗状态: ${p['在岗状态'] || ''}
直接上级: ${p['直接上级'] || ''}`);
  }

  // 近期会议摘要（筛选周期内）
  const recentMeetings = (memory.meetings || []).filter(r => {
    const t = (r.fields || {})['会议时间'];
    return !t || t >= cutoff;
  }).slice(0, 15);

  if (recentMeetings.length > 0) {
    parts.push(`【近期会议记录】(${recentMeetings.length}条)`);
    for (const r of recentMeetings) {
      const f = r.fields || {};
      const time = f['会议时间'] ? new Date(f['会议时间']).toLocaleDateString('zh-CN') : '';
      let line = `- ${time} 「${f['会议主题'] || '(无主题)'}」`;
      if (f['AI摘要'] && f['AI摘要'] !== '(待获取)' && f['AI摘要'] !== '(来自日历同步)') {
        line += `\n  摘要: ${f['AI摘要'].slice(0, 200)}`;
      }
      if (f['待办事项']) line += `\n  待办: ${f['待办事项'].slice(0, 100)}`;
      parts.push(line);
    }
  }

  // 群聊摘要
  const recentChats = (memory.chats || []).slice(0, 8);
  if (recentChats.length > 0) {
    parts.push(`【群聊摘要】(${recentChats.length}条)`);
    for (const r of recentChats) {
      const f = r.fields || {};
      parts.push(`- ${f['群名称'] || ''}: ${(f['摘要'] || '').slice(0, 150)}`);
    }
  }

  // 工作事项状态
  const recentItems = (memory.workItems || []).filter(r => {
    const t = (r.fields || {})['创建时间'];
    return !t || t >= cutoff;
  }).slice(0, 15);

  if (recentItems.length > 0) {
    const byStatus = {};
    for (const r of recentItems) {
      const s = (r.fields || {})['状态'] || '未知';
      byStatus[s] = (byStatus[s] || 0) + 1;
    }
    parts.push(`【工作事项状态分布】
${Object.entries(byStatus).map(([k, v]) => `${k}: ${v}条`).join('  ')}`);

    const overdueOrBlocked = recentItems.filter(r => {
      const s = (r.fields || {})['状态'] || '';
      return s.includes('延期') || s.includes('阻塞') || s.includes('暂停');
    });
    if (overdueOrBlocked.length > 0) {
      parts.push(`【异常状态事项】`);
      for (const r of overdueOrBlocked.slice(0, 5)) {
        const f = r.fields || {};
        parts.push(`- [${f['状态']}] ${f['事项标题'] || ''}`);
      }
    }
  }

  // 工作总结
  const summaries = (memory.workItems || []).filter(r =>
    ((r.fields || {})['来源'] || '') === 'OrgAgent'
  ).slice(0, 3);

  // 日程（看参会频率/类型）
  const calItems = (memory.calendar || []).filter(r => {
    const t = (r.fields || {})['开始时间'];
    return !t || t >= cutoff;
  }).slice(0, 20);

  if (calItems.length > 0) {
    const typeCount = {};
    for (const r of calItems) {
      const t = (r.fields || {})['日程类型'] || '其他';
      typeCount[t] = (typeCount[t] || 0) + 1;
    }
    parts.push(`【日程类型分布】(最近${periodDays}天共${calItems.length}条)
${Object.entries(typeCount).map(([k, v]) => `${k}:${v}`).join('  ')}`);
  }

  return parts.join('\n\n');
}

// ==================== LLM 分析 ====================

/**
 * 调用 LLM 对员工数据做风险分析
 * @param {string} name        - 员工姓名
 * @param {string} contextText - 分析上下文
 * @param {number} periodDays  - 分析周期天数
 * @returns {object} 结构化分析结果
 */
async function analyzeWithLLM(name, contextText, periodDays) {
  const periodLabel = periodDays <= 7 ? '周' : '月';

  const userPrompt = `请对以下员工「${name}」最近${periodDays}天的工作数据进行风险洞察分析。

=== 数据 ===
${contextText}
=== 数据结束 ===

请输出如下 JSON（所有字段必须存在，值可为 null）：
{
  "conversation_count": <数字，统计到的对话/会议/事项总数>,
  "topic_distribution": {
    "<话题类别>": <占比0-100>,
    ...
  },
  "sentiment_trend": {
    "overall": "<积极/中性/消极>",
    "trend": "<上升/平稳/下降>",
    "signals": ["<具体信号1>", "<具体信号2>"]
  },
  "anomaly_risk": "<无|低|中|高>",
  "turnover_risk": "<无|低|中|高>",
  "confidence": <0-100的数字>,
  "risk_keywords": "<逗号分隔的关键词，无风险时为空字符串>",
  "risk_basis": "<AI分析理由，150字以内，无风险时说明正常依据>",
  "suggestion": "<给组织的具体关注建议，100字以内，无风险时写'持续关注，定期沟通'>",
  "data_quality": "<充足|一般|不足>"
}`;

  try {
    const raw = await llm.ask(SYSTEM_PROMPT, userPrompt, {
      temperature: 0.2,
      max_output_tokens: 1000,
    });

    // 提取 JSON（防止 LLM 偶尔输出 markdown 包裹）
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('LLM 未返回 JSON');

    const result = JSON.parse(jsonMatch[0]);
    return { success: true, data: result };
  } catch (e) {
    logger.warn(`[InsightAnalyzer] LLM 分析失败 (${name}): ${e.message}`);
    return {
      success: false,
      data: {
        conversation_count: 0,
        topic_distribution: {},
        sentiment_trend: { overall: '未知', trend: '未知', signals: [] },
        anomaly_risk: '无',
        turnover_risk: '无',
        confidence: 0,
        risk_keywords: '',
        risk_basis: `数据分析失败: ${e.message}`,
        suggestion: '建议人工核查',
        data_quality: '不足',
      },
    };
  }
}

// ==================== 写入 Bitable ====================

/**
 * 将分析结果写入「【龙虾】员工风险洞察」表（当日幂等）
 */
async function writeInsight(empId, openId, name, period, analysisResult) {
  const today = new Date().toISOString().slice(0, 10);
  const tableId = config.TABLES.EMPLOYEE_INSIGHT;

  if (!tableId) {
    logger.error('[InsightAnalyzer] config.TABLES.EMPLOYEE_INSIGHT 未配置');
    return null;
  }

  const d = analysisResult.data;

  // 删除今日同员工同周期的旧记录（幂等）
  const filter = `AND(CurrentValue.[员工OpenID]="${openId || empId}",CurrentValue.[分析日期]="${today}",CurrentValue.[分析周期]="${period}")`;
  try {
    const old = await client.listRecords(tableId, { filter });
    for (const r of old) {
      await client.deleteRecord(tableId, r.record_id);
      await sleep(50);
    }
  } catch (e) {
    logger.warn(`[InsightAnalyzer] 清理旧记录失败: ${e.message}`);
  }

  const fields = {
    '员工OpenID':       openId || empId,
    '员工姓名':         name,
    '分析日期':         new Date(today).getTime(),
    '分析周期':         period,
    '对话数量':         Number(d.conversation_count) || 0,
    '话题分布':         JSON.stringify(d.topic_distribution || {}, null, 2),
    '情绪趋势':         JSON.stringify(d.sentiment_trend || {}, null, 2),
    '异动风险':         d.anomaly_risk || '无',
    '离职风险':         d.turnover_risk || '无',
    '风险置信度':       Number(d.confidence) || 0,
    '风险关键词':       d.risk_keywords || '',
    '风险依据':         d.risk_basis || '',
    '给组织的关注建议': d.suggestion || '',
  };

  try {
    const record = await client.createRecord(tableId, fields);
    return record;
  } catch (e) {
    logger.error(`[InsightAnalyzer] 写入失败 (${name}): ${e.message}`);
    return null;
  }
}

// ==================== 主入口 ====================

/**
 * 分析单个员工
 * @param {object} empFields  - EMPLOYEE 表的 fields 对象
 * @param {object} memory     - memoryManager.getUserMemory() 返回值
 * @param {'周'|'月'} period  - 分析周期
 * @returns {object} { name, anomalyRisk, turnoverRisk, confidence, record }
 */
async function analyzeEmployee(empFields, memory, period = '周') {
  const name   = empFields['姓名'] || '';
  const empId  = empFields['员工ID'] || name;
  const openId = empFields['飞书OpenID'] || '';
  const periodDays = period === '月' ? 30 : 7;

  logger.info(`[InsightAnalyzer] 分析: ${name} (${period})`);

  const contextText = buildAnalysisContext(memory, periodDays);

  // 数据量太少时降低置信度但仍分析
  if (!contextText.trim() || contextText.length < 50) {
    logger.info(`[InsightAnalyzer] ${name} 数据不足，跳过`);
    return { name, anomalyRisk: '无', turnoverRisk: '无', confidence: 0, skipped: true };
  }

  const result = await analyzeWithLLM(name, contextText, periodDays);
  const record = await writeInsight(empId, openId, name, period, result);

  return {
    name,
    openId,
    anomalyRisk:  result.data.anomaly_risk  || '无',
    turnoverRisk: result.data.turnover_risk || '无',
    confidence:   result.data.confidence   || 0,
    suggestion:   result.data.suggestion   || '',
    dataQuality:  result.data.data_quality || '不足',
    record,
  };
}

module.exports = { analyzeEmployee, buildAnalysisContext, writeInsight };
