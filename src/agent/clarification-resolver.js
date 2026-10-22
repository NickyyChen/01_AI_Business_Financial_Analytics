'use strict';

const config = require('../../config');
const llm = require('../clients/llm-client');
const minimaxClient = require('../clients/minimax-client');
const logger = require('../utils/logger');

let jsonrepairLib = null;
try { jsonrepairLib = require('jsonrepair'); } catch (_e) { jsonrepairLib = null; }

const ACTIONS = new Set(['continue', 'clarify_again', 'cancel', 'new_query']);
const SCOPE_SOURCES = new Set(['pending_clarification', 'inherited_result_set', 'explicit_project', 'explicit_new_query', 'user_scope', 'none']);

const RESOLVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string' },
    confidence: { type: 'number' },
    effectiveMessage: { type: 'string' },
    clarificationQuestion: { type: 'string' },
    reply: { type: 'string' },
    targetProjects: { type: 'array', items: { type: 'string' } },
    depts: { type: 'array', items: { type: 'string' } },
    period: { type: 'string' },
    metric: { type: 'string' },
    scopeSource: { type: 'string' },
    reason: { type: 'string' },
  },
  required: [
    'action',
    'confidence',
    'effectiveMessage',
    'clarificationQuestion',
    'reply',
    'targetProjects',
    'depts',
    'period',
    'metric',
    'scopeSource',
    'reason',
  ],
};

function _str(value, max = 800) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function _uniq(list, max = 50) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const text = _str(item, 160);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function _isExpired(pending, now = Date.now()) {
  if (!pending) return true;
  const expiresAt = Number(pending.expiresAt || 0);
  return expiresAt > 0 && expiresAt < now;
}

function _isCancelReply(message) {
  const q = String(message || '').replace(/\s+/g, '').trim();
  if (!q) return false;
  if (/(我要|改查|重新查|帮我查|帮我看|看一下|查一下|项目|部门|公司|中心|TOP|top|收入|利润|回款)/.test(q)
    && !/^(算了|不用|别|取消|不看|先不|暂时不用)/.test(q)) {
    return false;
  }
  return /^(算了|不用了?|不用查了?|不用看了?|别查了?|别看了?|不查了?|不看了?|取消|不用继续了?|先不查了?|先不用了?|暂时不用了?|先这样)[吧了啊呢哈啦。.!！?？]*$/.test(q)
    || (/^(算了|不用查|不用看|别查|别看|不查了|不看了|取消|先不查|暂时不用)/.test(q)
      && /(不用|不查|不看|别查|取消|不继续|先这样)/.test(q));
}

function _parseJSON(text) {
  if (!text) return null;
  const raw = String(text).trim();
  try { return JSON.parse(raw); } catch (_) {}
  const code = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (code) {
    try { return JSON.parse(code[1].trim()); } catch (_) {}
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const slice = raw.slice(start, end + 1);
    try { return JSON.parse(slice); } catch (_) {}
    if (jsonrepairLib) {
      try { return JSON.parse(jsonrepairLib.jsonrepair(slice)); } catch (_) {}
    }
  }
  if (jsonrepairLib) {
    try { return JSON.parse(jsonrepairLib.jsonrepair(raw)); } catch (_) {}
  }
  return null;
}

function _summarizeContext(planningContext = []) {
  return (Array.isArray(planningContext) ? planningContext : [])
    .filter(Boolean)
    .slice(-3)
    .map(ctx => ({
      question: _str(ctx.question, 220),
      period: _str(ctx.period || (ctx.queryState && ctx.queryState.period), 80),
      tools: Array.isArray(ctx.tools) ? ctx.tools.slice(0, 8) : [],
      queryState: ctx.queryState ? {
        dept: _str(ctx.queryState.dept, 80),
        period: _str(ctx.queryState.period, 80),
        metric: _str(ctx.queryState.metric, 80),
        resultSetType: _str(ctx.queryState.resultSetType, 100),
        targetProjects: _uniq(ctx.queryState.targetProjects, 20),
      } : null,
    }));
}

function _buildPrompt({ message, pendingClarification, planningContext }) {
  return [
    '你是一个澄清回复解析器。用户上一轮被系统追问，本轮回复可能是自然语言，不一定包含候选词。',
    '你的任务是结合 pendingClarification、候选项、上一轮上下文和用户本轮回复，判断是否已经补齐槽位。',
    '',
    '动作定义：',
    '- continue：用户回复足够明确，生成 effectiveMessage，并填写 targetProjects/depts/period/metric/scopeSource。',
    '- clarify_again：仍不明确，输出 clarificationQuestion。',
    '- cancel：用户表示不用了/取消/算了，不再执行工具。',
    '- new_query：用户没有回答追问，而是提出了一个新的完整问题。',
    '',
    '规则：',
    '1. 不要要求用户只能回答“是/否”；要理解“对，就这个”“看钱没回最多的”“按盈利能力”“就上个月完整月份”等自然表达。',
    '2. 如果用户确认候选实体（如“对/就这个/查这个管理项目”），选择候选项。',
    '3. 如果用户改说另一个部门/项目/口径，用用户本轮回复覆盖候选。',
    '4. 如果 action=continue，effectiveMessage 必须是一句可交给查询 Planner 的完整中文问题，不能只写短槽位。',
    '5. 不能臆造候选列表之外的项目名；除非用户本轮明确写出了新的项目或部门名称。',
    '',
    `pendingClarification=${JSON.stringify(pendingClarification || {})}`,
    `recentPlanningContext=${JSON.stringify(_summarizeContext(planningContext))}`,
    `用户本轮回复=${_str(message, 500)}`,
  ].join('\n');
}

function _normalizeResult(raw, pendingClarification, message) {
  const out = raw && typeof raw === 'object' ? { ...raw } : {};
  if (!ACTIONS.has(out.action)) out.action = 'clarify_again';
  let confidence = Number(out.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  out.confidence = Math.max(0, Math.min(1, confidence));
  out.targetProjects = _uniq(out.targetProjects, 50);
  out.depts = _uniq(out.depts, 12);
  out.period = _str(out.period, 80);
  out.metric = _str(out.metric, 80);
  out.scopeSource = SCOPE_SOURCES.has(out.scopeSource) ? out.scopeSource : 'pending_clarification';
  out.effectiveMessage = _str(out.effectiveMessage, 600);
  out.clarificationQuestion = _str(out.clarificationQuestion, 300);
  out.reply = _str(out.reply, 300);
  out.reason = _str(out.reason, 400);

  if (out.action === 'continue' && !out.effectiveMessage) {
    const base = _str(pendingClarification && pendingClarification.originalMessage, 260);
    const projects = out.targetProjects.length ? `；仅限这些项目：${out.targetProjects.join('、')}` : '';
    const depts = out.depts.length ? `；按这些部门：${out.depts.join('、')}` : '';
    out.effectiveMessage = `${base || '继续上一轮查询'}；用户补充：${_str(message, 200)}${projects}${depts}`;
  }

  if (out.action === 'clarify_again' && !out.clarificationQuestion) {
    out.clarificationQuestion = pendingClarification && pendingClarification.clarificationQuestion
      ? pendingClarification.clarificationQuestion
      : '我还需要确认一下你具体指的是哪个对象或口径，可以直接回复完整名称。';
  }

  if (out.action === 'cancel' && !out.reply) {
    out.reply = '好的，这次查询我先不继续了。';
  }

  if (out.action === 'new_query' && !out.effectiveMessage) {
    out.effectiveMessage = _str(message, 500);
  }

  return out;
}

function _shanghaiYearMonth(now = Date.now()) {
  const date = new Date(now);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  const year = Number((parts.find(p => p.type === 'year') || {}).value);
  const month = Number((parts.find(p => p.type === 'month') || {}).value);
  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    const fallback = new Date(now);
    return { year: fallback.getUTCFullYear(), month: fallback.getUTCMonth() + 1 };
  }
  return { year, month };
}

function _previousMonth(now = Date.now()) {
  const cur = _shanghaiYearMonth(now);
  let year = cur.year;
  let month = cur.month - 1;
  if (month <= 0) {
    year -= 1;
    month = 12;
  }
  const mm = String(month).padStart(2, '0');
  return {
    period: `${year}-${mm}`,
    label: `${year}年${month}月`,
    monthLabel: `${month}月`,
  };
}

function _currentYear(now = Date.now()) {
  return _shanghaiYearMonth(now).year;
}

function _periodRangeFromOriginal(pendingClarification, now = Date.now()) {
  const source = String(pendingClarification && pendingClarification.originalMessage || '').replace(/\s+/g, '');
  if (!source) return null;
  const range = source.match(/(?:(20\d{2})年?)?([1-9]|1[0-2])月?(?:~|至|到|-|—)(?:(20\d{2})年?)?([1-9]|1[0-2])月?/);
  if (range) {
    const startYear = Number(range[1] || range[3] || _currentYear(now));
    const endYear = Number(range[3] || range[1] || startYear);
    const startMonth = Number(range[2]);
    const endMonth = Number(range[4]);
    if (
      Number.isFinite(startYear)
      && Number.isFinite(endYear)
      && startMonth >= 1
      && startMonth <= 12
      && endMonth >= 1
      && endMonth <= 12
    ) {
      return {
        period: `${startYear}-${String(startMonth).padStart(2, '0')}~${endYear}-${String(endMonth).padStart(2, '0')}`,
        label: startYear === endYear
          ? `${startYear}年${startMonth}-${endMonth}月`
          : `${startYear}年${startMonth}月-${endYear}年${endMonth}月`,
      };
    }
  }
  const single = source.match(/(20\d{2})年?([1-9]|1[0-2])月/)
    || source.match(/(?:^|[^\d])([1-9]|1[0-2])月/);
  if (single) {
    const year = single.length >= 3 ? Number(single[1]) : _currentYear(now);
    const month = single.length >= 3 ? Number(single[2]) : Number(single[1]);
    if (Number.isFinite(year) && month >= 1 && month <= 12) {
      return {
        period: `${year}-${String(month).padStart(2, '0')}`,
        label: `${year}年${month}月`,
      };
    }
  }
  return null;
}

function _deterministicPeriodFromReply(message, pendingClarification, now = Date.now()) {
  const q = String(message || '').replace(/\s+/g, '');
  const pendingSlots = Array.isArray(pendingClarification && pendingClarification.missingSlots)
    ? pendingClarification.missingSlots
    : [];
  const asksPeriod = pendingSlots.includes('period') || /哪个月|哪月|月份|period/.test(String(pendingClarification && pendingClarification.clarificationQuestion || ''));
  if (!asksPeriod) return null;
  if (/(上个月完整月份|上个完整月份|最近完整月份|上月完整月份|上个月|上月)/.test(q)) {
    return _previousMonth(now);
  }
  const explicitMonth = q.match(/(?:20)?(\d{2})年?([1-9]|1[0-2])月/)
    || q.match(/([1-9]|1[0-2])月/);
  if (explicitMonth) {
    const cur = _shanghaiYearMonth(now);
    const year = explicitMonth.length >= 3
      ? (String(explicitMonth[1]).length === 2 ? 2000 + Number(explicitMonth[1]) : Number(explicitMonth[1]))
      : cur.year;
    const month = explicitMonth.length >= 3 ? Number(explicitMonth[2]) : Number(explicitMonth[1]);
    if (Number.isFinite(year) && Number.isFinite(month) && month >= 1 && month <= 12) {
      return {
        period: `${year}-${String(month).padStart(2, '0')}`,
        label: `${year}年${month}月`,
        monthLabel: `${month}月`,
      };
    }
  }
  return null;
}

function _replaceMonthText(text, periodInfo) {
  const source = String(text || '').trim();
  if (!source) return '';
  let out = source
    .replace(/20\d{2}-\d{2}(?:~20\d{2}-\d{2})?/g, periodInfo.period)
    .replace(/20\d{2}年\s*(?:1[0-2]|0?[1-9])月?\s*(?:~|至|到|-|—)\s*(?:20\d{2}年)?\s*(?:1[0-2]|0?[1-9])月/g, periodInfo.label)
    .replace(/20\d{2}年\s*(?:1[0-2]|0?[1-9])月/g, periodInfo.label)
    .replace(/20\d{2}-(?:1[0-2]|0[1-9])/g, periodInfo.period);
  if (out === source) {
    out = `${source}；用户补充时间口径：${periodInfo.label}`;
  }
  return out;
}

function _pendingProjects(pendingClarification) {
  const base = pendingClarification && pendingClarification.baseQueryState || {};
  const projects = Array.isArray(base.targetProjects) ? base.targetProjects : [];
  return _uniq(projects, 50);
}

function _semanticMetricFromReply(message, pendingClarification) {
  const q = String(message || '').replace(/\s+/g, '');
  const pendingText = JSON.stringify({
    type: pendingClarification && pendingClarification.type,
    missingSlots: pendingClarification && pendingClarification.missingSlots,
    candidates: pendingClarification && pendingClarification.candidates,
    question: pendingClarification && pendingClarification.clarificationQuestion,
  });
  const isReceivable = /receivable|回款|收款|应收|未回|逾期|到账/.test(pendingText);
  const isRanking = /ranking_metric|排序|排名|口径|利润率|收入|利润|风险|成本/.test(pendingText);

  if (isReceivable) {
    if (/(未回|没回|未收|应收|欠款|钱.*没.*回|款.*没.*回)/.test(q)) {
      return {
        metric: 'outstanding',
        label: '未回款金额',
        phrase: '按未回款金额从高到低',
        toolHint: 'finance.receivables',
      };
    }
    if (/(回款率|收款率|回收率|比例|率)/.test(q)) {
      return {
        metric: 'collectRate',
        label: '回款率',
        phrase: '按回款率从低到高',
        toolHint: 'finance.receivables',
      };
    }
    if (/(已回|已收|到账|实际回款|回款金额|收款金额)/.test(q)) {
      return {
        metric: 'received',
        label: '已回款金额',
        phrase: '按已回款金额从高到低',
        toolHint: 'finance.receivables',
      };
    }
    if (/(账龄|逾期|超期|风险)/.test(q)) {
      return {
        metric: 'overdue',
        label: '逾期账龄',
        phrase: '按逾期风险从高到低',
        toolHint: 'finance.receivables',
      };
    }
  }

  if (isRanking) {
    if (/(盈利能力|利润率|毛利率|净利率)/.test(q)) {
      return {
        metric: 'profit_rate',
        label: '利润率',
        phrase: '按利润率从低到高',
        toolHint: 'finance.profitOverview',
      };
    }
    if (/(亏损|利润|盈利)/.test(q)) {
      return {
        metric: 'profit',
        label: '利润',
        phrase: /(最好|最高|盈利)/.test(q) && !/(最差|最低|亏损)/.test(q) ? '按利润从高到低' : '按利润从低到高',
        toolHint: 'finance.profitOverview',
      };
    }
    if (/(收入|履约)/.test(q)) {
      return {
        metric: 'revenue',
        label: '收入',
        phrase: '按收入从高到低',
        toolHint: 'finance.profitOverview',
      };
    }
    if (/(成本|费用)/.test(q)) {
      return {
        metric: 'cost',
        label: '成本',
        phrase: '按成本从高到低',
        toolHint: 'finance.profitOverview',
      };
    }
  }

  return null;
}

function _semanticSlotResolution(message, pendingClarification, now = Date.now()) {
  if (!pendingClarification) return null;
  const base = pendingClarification.baseQueryState || {};
  const projects = _pendingProjects(pendingClarification);
  const projectSuffix = projects.length ? `；仅限这些项目：${projects.join('、')}` : '';

  if (pendingClarification.type === 'entity_resolution') {
    const q = String(message || '').replace(/\s+/g, '');
    const candidates = Array.isArray(pendingClarification.candidates) ? pendingClarification.candidates : [];
    const projectCandidates = candidates
      .filter(item => item && (item.type === 'project' || /项目|成本池/.test(String(item.type || item.label || item.name || ''))))
      .map(item => _str(item.name || item.value || item.label, 120))
      .filter(Boolean);
    const named = projectCandidates.find(name => q.includes(name.replace(/—虚拟项目$/, '')) || q.includes(name));
    const affirmative = /^(对|是|嗯|好|可以|就|查|看|这个|那个)/.test(q) || /(就查|查这个|看这个|这个管理项目|管理项目)/.test(q);
    const selected = named || (affirmative
      ? [...projectCandidates].sort((a, b) => {
        const av = /虚拟项目/.test(a) ? 1 : 0;
        const bv = /虚拟项目/.test(b) ? 1 : 0;
        if (av !== bv) return av - bv;
        return a.length - b.length;
      })[0]
      : '');
    if (selected) {
      const originalPeriod = _periodRangeFromOriginal(pendingClarification, now);
      const periodText = originalPeriod ? `${originalPeriod.label}` : '';
      return _normalizeResult({
        action: 'continue',
        confidence: 0.9,
        effectiveMessage: `查询${selected}项目${periodText ? periodText : ''}的盈亏数据`,
        clarificationQuestion: '',
        reply: '',
        targetProjects: [selected],
        depts: [],
        period: originalPeriod ? originalPeriod.period : (base.period || ''),
        metric: base.metric || 'profit',
        scopeSource: 'explicit_project',
        reason: `代码事实校准：用户确认实体候选，选择项目/成本池「${selected}」`,
      }, pendingClarification, message);
    }
  }

  const metric = _semanticMetricFromReply(message, pendingClarification);
  if (metric) {
    return _normalizeResult({
      action: 'continue',
      confidence: 0.88,
      effectiveMessage: `${pendingClarification.originalMessage || '继续上一轮查询'}；用户补充口径：${metric.phrase}${projectSuffix}`,
      clarificationQuestion: '',
      reply: '',
      targetProjects: projects,
      depts: base.dept ? [base.dept] : [],
      period: base.period || '',
      metric: metric.metric,
      scopeSource: 'pending_clarification',
      reason: `代码事实校准：自然语言回复明确映射到候选口径「${metric.label}」`,
    }, pendingClarification, message);
  }

  const periodInfo = _deterministicPeriodFromReply(message, pendingClarification, now);
  if (periodInfo) {
    return _normalizeResult({
      action: 'continue',
      confidence: 0.9,
      effectiveMessage: `${pendingClarification.originalMessage || '继续上一轮查询'}；用户补充时间口径：${periodInfo.label}${projectSuffix}`,
      clarificationQuestion: '',
      reply: '',
      targetProjects: projects,
      depts: base.dept ? [base.dept] : [],
      period: periodInfo.period,
      metric: base.metric || '',
      scopeSource: 'pending_clarification',
      reason: `代码事实校准：自然语言回复明确映射到时间口径「${periodInfo.label}」`,
    }, pendingClarification, message);
  }

  return null;
}

function _applyDeterministicFacts(resolution, pendingClarification, message, now) {
  const periodInfo = _deterministicPeriodFromReply(message, pendingClarification, now);
  if (periodInfo && resolution.action === 'continue') {
    resolution.period = periodInfo.period;
    resolution.effectiveMessage = _replaceMonthText(
      resolution.effectiveMessage || pendingClarification && pendingClarification.originalMessage || message,
      periodInfo
    );
    resolution.reason = [
      resolution.reason,
      `代码事实校准：用户回复的相对月份已按 Asia/Shanghai 解析为 ${periodInfo.label}`,
    ].filter(Boolean).join('；');
  }
  const originalPeriod = !periodInfo && resolution.action === 'continue'
    ? _periodRangeFromOriginal(pendingClarification, now)
    : null;
  if (originalPeriod) {
    resolution.period = originalPeriod.period;
    resolution.effectiveMessage = _replaceMonthText(
      resolution.effectiveMessage || pendingClarification && pendingClarification.originalMessage || message,
      originalPeriod
    );
    resolution.reason = [
      resolution.reason,
      `代码事实校准：保留待澄清原问题中的时间范围 ${originalPeriod.label}`,
    ].filter(Boolean).join('；');
  }
  return resolution;
}

async function _callLLM(prompt, parent) {
  const input = [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }];
  const textFormat = {
    type: 'json_schema',
    name: 'clarification_resolution',
    schema: RESOLVE_SCHEMA,
    strict: true,
  };
  const provider = (config.PLAN_PROVIDER || 'ark').toLowerCase();
  if (provider === 'minimax' && config.MINIMAX_API_KEY) {
    try {
      return await minimaxClient.chat(input, {
        model: config.MINIMAX_MODEL,
        temperature: 0,
        max_output_tokens: 900,
        textFormat,
        parent,
        generationName: 'clarification-resolver-minimax',
      });
    } catch (error) {
      logger.warn(`[ClarificationResolver] MiniMax 失败，降级 Ark: ${error.message}`);
    }
  }
  return llm.chat(input, {
    model: config.ARK_PLAN_MODEL || config.ARK_MODEL,
    temperature: 0,
    max_output_tokens: 900,
    textFormat,
    parent,
    generationName: 'clarification-resolver-ark',
  });
}

function _lockedScopeFromResolution(resolution, pendingClarification) {
  const base = pendingClarification && pendingClarification.baseQueryState || {};
  const source = resolution.scopeSource === 'explicit_project'
    ? 'explicit_project'
    : resolution.scopeSource === 'explicit_new_query'
      ? 'explicit_new_query'
      : 'pending_clarification';
  return {
    source,
    targetProjects: resolution.targetProjects,
    targetEntities: resolution.targetProjects.map((name, idx) => ({ type: 'project', name, rank: idx + 1 })),
    depts: resolution.depts.length ? resolution.depts : (base.dept ? [base.dept] : []),
    period: resolution.period || base.period || '',
    metric: resolution.metric || base.metric || '',
    resultSetType: base.resultSetType || '',
    sourceTools: Array.isArray(base.sourceTools) ? base.sourceTools.slice(0, 8) : [],
    confidence: resolution.confidence,
    reason: resolution.reason || 'LLM clarification resolver',
  };
}

async function resolveClarification({ message = '', pendingClarification = null, planningContext = [], parent = null, now = Date.now() } = {}) {
  if (!config.CLARIFICATION_LLM_RESOLVER_ENABLED) return null;
  if (!pendingClarification || _isExpired(pendingClarification, now)) return null;
  if (_isCancelReply(message)) {
    const resolution = _normalizeResult({
      action: 'cancel',
      confidence: 1,
      effectiveMessage: '',
      clarificationQuestion: '',
      reply: '好的，这次查询我先不继续了。',
      targetProjects: [],
      depts: [],
      period: '',
      metric: '',
      scopeSource: 'none',
      reason: '代码事实校准：用户明确取消待澄清查询',
    }, pendingClarification, message);
    logger.info(`[ClarificationResolver] action=${resolution.action} confidence=${resolution.confidence} reason=${resolution.reason}`);
    return {
      action: 'cancel',
      reply: resolution.reply,
      pendingClarification: null,
      raw: resolution,
    };
  }

  const prompt = _buildPrompt({ message, pendingClarification, planningContext });
  const response = await _callLLM(prompt, parent);
  const parsed = _parseJSON(response && response.text);
  let resolution = _normalizeResult(parsed, pendingClarification, message);
  const semanticResolution = _semanticSlotResolution(message, pendingClarification, now);
  if (
    semanticResolution
    && !['cancel', 'new_query'].includes(resolution.action)
  ) {
    resolution = semanticResolution;
  }
  resolution = _applyDeterministicFacts(
    resolution,
    pendingClarification,
    message,
    now
  );
  logger.info(`[ClarificationResolver] action=${resolution.action} confidence=${resolution.confidence} reason=${resolution.reason}`);

  if (resolution.action === 'continue') {
    return {
      action: 'continue',
      effectiveMessage: resolution.effectiveMessage,
      lockedScope: _lockedScopeFromResolution(resolution, pendingClarification),
      intent: {
        route: 'plan',
        intentType: 'clarification_slot_answer',
        confidence: resolution.confidence,
        isFollowup: true,
        shouldUsePlanningContext: true,
        shouldRunPlanner: true,
        shouldClarify: false,
        reason: resolution.reason || 'LLM clarification resolved',
      },
      pendingClarification: null,
      raw: resolution,
    };
  }

  if (resolution.action === 'clarify_again') {
    return {
      action: 'clarify',
      clarificationQuestion: resolution.clarificationQuestion,
      pendingClarification: {
        ...pendingClarification,
        clarificationQuestion: resolution.clarificationQuestion,
        createdAt: now,
        expiresAt: now + 10 * 60 * 1000,
      },
      raw: resolution,
    };
  }

  if (resolution.action === 'cancel') {
    return {
      action: 'cancel',
      reply: resolution.reply,
      pendingClarification: null,
      raw: resolution,
    };
  }

  return {
    action: 'new_query',
    effectiveMessage: resolution.effectiveMessage || _str(message, 500),
    pendingClarification: null,
    intent: {
      route: 'plan',
      intentType: 'normal_query',
      confidence: resolution.confidence,
      isFollowup: false,
      shouldUsePlanningContext: false,
      shouldRunPlanner: true,
      shouldClarify: false,
      reason: resolution.reason || 'LLM clarification reply is a new query',
    },
    raw: resolution,
  };
}

module.exports = {
  resolveClarification,
  _normalizeResult,
  _buildPrompt,
  _isExpired,
};
