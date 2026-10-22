'use strict';

const config = require('../../config');
const minimaxClient = require('../clients/minimax-client');
const logger = require('../utils/logger');

let jsonrepairLib = null;
try { jsonrepairLib = require('jsonrepair'); } catch (_e) { jsonrepairLib = null; }

const ROUTES = new Set(['plan', 'casual', 'clarify']);
const INTENT_TYPES = new Set([
  'normal_query',
  'casual_chat',
  'result_set_reference',
  'clarification_slot_answer',
  'metric_definition',
  'correction_or_recompute',
  'new_query_explicit_target',
  'ambiguous_reference',
]);

const CASUAL_PATTERNS = /^(你好|hello|hi|hey|嗨|谢谢|好的|收到|ok|okay|哈哈|嗯|嗯嗯|感谢|辛苦了|辛苦|再见|拜拜|早上好|上午好|中午好|下午好|晚上好|早安|晚安|在吗|在不在|你在吗|测试|test|666|谢谢你|多谢|thanks|thank you)\s*[!！。.~？?]*$/i;
const BUSINESS_WORDS = /(收入|成本|利润|利润率|预算|预实|完成率|回款|收款|应收|逾期|账期|账龄|开票|合同|履约|人力|FTE|项目|部门|行业群|客户|经营|风险|预警|同比|环比|排名|TOP|top|最高|最低|最差|亏损|盈利|金额|多少|几个|哪几个|明细|清单|分析|为什么|原因)/;
const FOLLOWUP_WORDS = /(这个|那个|这些|这几个|上述|上面|前面|刚才|上一轮|它们|其中|第\s*[一二两三四五六七八九十\d]+|^那|为什么|为啥|原因|差在哪|你看呗|看呗|继续|展开|明细|表格|分别|对应)/;
const RECEIVABLE_METRIC_CLARIFICATION = '你说的“回款最差”想按哪个口径看：回款率、未回款金额、回款金额，还是逾期账龄？确认口径后我会只看上一轮这些项目。';

function _str(v, max = 600) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function _uniq(list, max = 20) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const s = _str(item, 120);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
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

function _recentMessages(conversationHistory = []) {
  return (Array.isArray(conversationHistory) ? conversationHistory : [])
    .slice(-6)
    .map(m => ({
      role: _str(m && m.role, 20),
      content: _str(m && m.content, 500),
    }))
    .filter(m => m.role && m.content);
}

function _lastPlanningContext(planningContext = []) {
  const contexts = Array.isArray(planningContext) ? planningContext.filter(Boolean) : [];
  const last = contexts[contexts.length - 1] || null;
  if (!last) return null;
  const queryState = last.queryState || last.lastQueryState || {};
  const targetProjects = Array.isArray(queryState.targetProjects)
    ? queryState.targetProjects
    : (Array.isArray(last.entities) ? last.entities.filter(e => e && e.type === 'project').map(e => e.name) : []);
  return {
    question: _str(last.question, 220),
    period: _str(last.period || queryState.period, 80),
    intent: _str(last.intent, 100),
    tools: Array.isArray(last.tools) ? last.tools.slice(0, 8) : [],
    tables: Array.isArray(last.tables) ? last.tables.slice(0, 12) : [],
    targetProjects: _uniq(targetProjects, 24),
    metric: _str(queryState.metric, 80),
    resultSetType: _str(queryState.resultSetType, 100),
    dept: _str(queryState.dept, 80),
  };
}

function _summarizePendingClarification(pendingClarification) {
  if (!pendingClarification || typeof pendingClarification !== 'object') return null;
  const base = pendingClarification.baseQueryState || {};
  return {
    type: _str(pendingClarification.type, 80),
    originalMessage: _str(pendingClarification.originalMessage, 260),
    clarificationQuestion: _str(pendingClarification.clarificationQuestion, 260),
    candidates: _uniq(pendingClarification.candidates, 8),
    expiresAt: Number(pendingClarification.expiresAt || 0),
    baseQueryState: {
      dept: _str(base.dept, 80),
      period: _str(base.period, 80),
      metric: _str(base.metric, 80),
      resultSetType: _str(base.resultSetType, 100),
      targetProjects: _uniq(base.targetProjects, 24),
    },
  };
}

function _buildRouterInput({ message, planningContext, conversationHistory, pendingClarification, userName, role }) {
  return {
    message: _str(message, 500),
    userName: _str(userName, 80),
    role: _str(role, 40),
    recentMessages: _recentMessages(conversationHistory),
    lastPlanningContext: _lastPlanningContext(planningContext),
    pendingClarification: _summarizePendingClarification(pendingClarification),
    allowedRoutes: ['plan', 'casual', 'clarify'],
    allowedIntentTypes: [...INTENT_TYPES],
  };
}

function _hasPendingSlotAnswer(message, pendingClarification) {
  if (!pendingClarification || pendingClarification.type !== 'receivable_metric') return false;
  const q = _str(message, 80);
  if (!q) return false;
  if (/^(回款率|收款率|回款比例|未回款金额|未回金额|应收金额|应收款|回款金额|已回款金额|收款金额|到账金额|账龄|逾期账龄|拖了多久)$/.test(q)) {
    return true;
  }
  const candidates = _uniq(pendingClarification.candidates, 10);
  return candidates.some(c => c && q.includes(c));
}

function _hasProjectSet(planningContext = []) {
  const last = _lastPlanningContext(planningContext);
  return !!(last && Array.isArray(last.targetProjects) && last.targetProjects.length > 0);
}

function _isAmbiguousReceivableWorst(message, planningContext) {
  const q = _str(message, 120);
  if (!_hasProjectSet(planningContext)) return false;
  if (!/(回款|收款|应收)/.test(q)) return false;
  if (!/(最差|较差|很差|最低|最不好|哪个.*差|差的是哪个|风险最高)/.test(q)) return false;
  if (/风险/.test(q)) return false;
  return !/(回款率|收款率|未回款金额|未回金额|回款金额|到账金额|账龄|逾期)/.test(q);
}

function _normalizeRoute(raw, fallbackInput) {
  const out = raw && typeof raw === 'object' ? { ...raw } : {};
  if (!ROUTES.has(out.route)) out.route = 'plan';
  if (!INTENT_TYPES.has(out.intentType)) {
    out.intentType = out.route === 'casual' ? 'casual_chat' : (out.route === 'clarify' ? 'ambiguous_reference' : 'normal_query');
  }
  let confidence = Number(out.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  out.confidence = Math.max(0, Math.min(1, confidence));
  out.isFollowup = !!out.isFollowup;
  out.shouldUsePlanningContext = !!out.shouldUsePlanningContext;
  out.clarificationQuestion = _str(out.clarificationQuestion, 260);
  out.reason = _str(out.reason, 400);
  out.slotValues = out.slotValues && typeof out.slotValues === 'object' ? out.slotValues : {};
  delete out.rewriteMessage;

  const message = _str(fallbackInput && fallbackInput.message, 160);
  const hasBusiness = BUSINESS_WORDS.test(message);
  const hasProjectSetContext = !!(
    fallbackInput
    && fallbackInput.lastPlanningContext
    && Array.isArray(fallbackInput.lastPlanningContext.targetProjects)
    && fallbackInput.lastPlanningContext.targetProjects.length > 0
  );
  const ambiguousReceivableWorst = /(回款|收款|应收)/.test(message)
    && /(最差|较差|很差|最低|最不好|哪个.*差|差的是哪个|风险最高)/.test(message)
    && !/风险/.test(message)
    && !/(回款率|收款率|未回款金额|未回金额|回款金额|到账金额|账龄|逾期)/.test(message);
  if (ambiguousReceivableWorst && hasProjectSetContext) {
    out.route = 'clarify';
    out.intentType = 'ambiguous_reference';
    out.confidence = Math.max(out.confidence, 0.9);
    out.isFollowup = true;
    out.shouldUsePlanningContext = true;
    if (!/(回款率|未回款金额|回款金额|逾期|账龄)/.test(out.clarificationQuestion)) {
      out.clarificationQuestion = RECEIVABLE_METRIC_CLARIFICATION;
    }
    out.reason = [out.reason, '回款最差缺少比较口径，强制澄清'].filter(Boolean).join('；');
  }
  if (out.route === 'casual' && hasBusiness) {
    out.route = 'plan';
    out.intentType = out.intentType === 'casual_chat' ? 'normal_query' : out.intentType;
    out.reason = [out.reason, '业务关键词保护：casual 改为 plan'].filter(Boolean).join('；');
  }
  if (out.route === 'clarify' && hasBusiness && hasProjectSetContext && !ambiguousReceivableWorst) {
    out.route = 'plan';
    out.intentType = out.intentType === 'ambiguous_reference' ? 'result_set_reference' : out.intentType;
    out.reason = [out.reason, '上一轮有项目集且本轮有业务指标，交给 Planner 结合上下文规划'].filter(Boolean).join('；');
  }

  if (out.route === 'clarify') {
    const canClarify = out.confidence >= 0.75 && out.clarificationQuestion;
    if (!canClarify) {
      out.route = 'plan';
      out.intentType = 'normal_query';
      out.reason = [out.reason, '低置信或缺少澄清问题，交给 Planner'].filter(Boolean).join('；');
    }
  }

  if (out.route === 'plan' && (out.isFollowup || out.intentType === 'result_set_reference' || out.intentType === 'clarification_slot_answer')) {
    out.shouldUsePlanningContext = true;
  }

  out.shouldRunPlanner = out.route === 'plan';
  out.shouldClarify = out.route === 'clarify';
  return out;
}

function _fallbackRoute(payload = {}) {
  const { message, planningContext = [], pendingClarification = null, conversationHistory = [] } = payload;
  const q = _str(message, 180);
  const hasHistory = (Array.isArray(conversationHistory) && conversationHistory.length > 0)
    || (Array.isArray(planningContext) && planningContext.length > 0);

  if (!q || CASUAL_PATTERNS.test(q)) {
    return {
      route: 'casual',
      intentType: 'casual_chat',
      confidence: 0.86,
      isFollowup: false,
      shouldUsePlanningContext: false,
      reason: 'fallback casual pattern',
    };
  }

  if (_hasPendingSlotAnswer(q, pendingClarification)) {
    return {
      route: 'plan',
      intentType: 'clarification_slot_answer',
      confidence: 0.9,
      isFollowup: true,
      shouldUsePlanningContext: true,
      slotValues: { metric: q },
      reason: 'fallback pending clarification slot answer',
    };
  }

  if (_isAmbiguousReceivableWorst(q, planningContext)) {
    return {
      route: 'clarify',
      intentType: 'ambiguous_reference',
      confidence: 0.88,
      isFollowup: true,
      shouldUsePlanningContext: true,
      clarificationQuestion: RECEIVABLE_METRIC_CLARIFICATION,
      reason: 'fallback ambiguous receivable worst metric',
    };
  }

  if (FOLLOWUP_WORDS.test(q) && hasHistory) {
    return {
      route: 'plan',
      intentType: 'result_set_reference',
      confidence: 0.78,
      isFollowup: true,
      shouldUsePlanningContext: true,
      reason: 'fallback followup with context',
    };
  }

  if (BUSINESS_WORDS.test(q)) {
    return {
      route: 'plan',
      intentType: 'normal_query',
      confidence: 0.76,
      isFollowup: false,
      shouldUsePlanningContext: hasHistory,
      reason: 'fallback business keyword',
    };
  }

  return {
    route: 'casual',
    intentType: 'casual_chat',
    confidence: 0.62,
    isFollowup: false,
    shouldUsePlanningContext: false,
    reason: 'fallback no business signal',
  };
}

const INTENT_ROUTER_SYSTEM_PROMPT = [
  '你是 Agent 入口意图路由器，只负责判断消息该走哪条链路，不回答业务问题。',
  '你只能输出 JSON，不能输出自然语言解释。',
  'route 只能是：plan、casual、clarify。',
  'plan：经营/财务/项目/部门/客户/风险/回款等需要 Planner 和工具链处理的问题，也包括基于上一轮结果集的追问。',
  'casual：纯寒暄、感谢、无业务意图的闲聊。',
  'clarify：用户问题缺少关键槽位，且无法从 pendingClarification、lastPlanningContext、recentMessages 中恢复时才使用。',
  '重要：不要改写用户问题，不要输出 rewriteMessage，不要编造项目/部门/金额。',
  '如果用户说“这些项目/这几个/为什么这些差/你看呗/继续/展开明细”等，并且 lastPlanningContext 有项目集或事实，通常 route=plan，shouldUsePlanningContext=true。',
  '如果存在 pendingClarification，用户回复“回款率/未回款金额/回款金额/账龄”等候选槽位时，route=plan，intentType=clarification_slot_answer。',
  '如果用户问“回款最差的是哪个”但未说明按回款率、未回款金额、回款金额还是账龄，且上下文有项目集，route=clarify 并给出澄清问题。',
  '低置信时选择 route=plan，让 Planner 结合上下文继续判断；不要轻易 clarify。',
  '输出字段：route, intentType, confidence, isFollowup, shouldUsePlanningContext, clarificationQuestion, slotValues, reason。',
].join('\n');

async function routeIntent(payload = {}, opts = {}) {
  const input = _buildRouterInput(payload);
  const provider = (config.INTENT_ROUTER_PROVIDER || config.FOLLOWUP_INTENT_PROVIDER || 'minimax').toLowerCase();

  if (provider === 'minimax' && config.MINIMAX_API_KEY) {
    try {
      const messages = [
        { role: 'system', content: [{ type: 'input_text', text: INTENT_ROUTER_SYSTEM_PROMPT }] },
        { role: 'user', content: [{ type: 'input_text', text: JSON.stringify(input) }] },
      ];
      const res = await minimaxClient.chat(messages, {
        model: config.INTENT_ROUTER_MODEL || config.FOLLOWUP_INTENT_MODEL || config.MINIMAX_MODEL,
        temperature: 0.01,
        max_output_tokens: 900,
        textFormat: { type: 'json_object' },
        parent: opts.parent,
        generationName: 'intent-router-minimax',
      });
      const parsed = _parseJSON(res && res.text);
      if (parsed) {
        return {
          ..._normalizeRoute(parsed, input),
          _provider: 'minimax',
          _rawText: res.text,
        };
      }
      logger.warn(`[IntentRouter] MiniMax JSON 解析失败，走规则兜底: ${(res && res.text || '').slice(0, 200)}`);
    } catch (e) {
      logger.warn(`[IntentRouter] MiniMax 路由失败，走规则兜底: ${e.message}`);
    }
  }

  return {
    ..._normalizeRoute(_fallbackRoute(payload), input),
    _provider: 'fallback-rule',
  };
}

module.exports = {
  routeIntent,
  _fallbackRoute,
  _normalizeRoute,
};
