'use strict';

const config = require('../../config');
const minimaxClient = require('../clients/minimax-client');
const logger = require('../utils/logger');
const { resolveReference } = require('./reference-resolver');

let jsonrepairLib = null;
try { jsonrepairLib = require('jsonrepair'); } catch (_e) { jsonrepairLib = null; }

const PASS_THROUGH_INTENTS = new Set([
  'normal_query',
  'metric_definition',
  'result_set_reference',
  'correction_or_recompute',
  'new_query_explicit_target',
  'clarification_rejection',
]);

const CLARIFYABLE_INTENTS = new Set(['single_entity_reference', 'ambiguous_reference']);

function _str(v, max = 600) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}...` : s;
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
      role: m.role,
      content: _str(m.content, 500),
    }))
    .filter(m => m.role && m.content);
}

function _recentUserMessages(conversationHistory = []) {
  return _recentMessages(conversationHistory)
    .filter(m => m.role === 'user')
    .map(m => m.content);
}

function _recentAssistantMessages(conversationHistory = []) {
  return _recentMessages(conversationHistory)
    .filter(m => m.role === 'assistant')
    .map(m => m.content);
}

function _lastUserBeforeLatest(conversationHistory = []) {
  const users = _recentUserMessages(conversationHistory);
  return users.length > 0 ? users[users.length - 1] : '';
}

function _lastPlanningContext(planningContext = []) {
  const contexts = Array.isArray(planningContext) ? planningContext.filter(Boolean) : [];
  const last = contexts[contexts.length - 1] || null;
  if (!last) return null;
  return {
    question: _str(last.question, 220),
    period: _str(last.period, 80),
    intent: _str(last.intent, 100),
    tools: Array.isArray(last.tools) ? last.tools.slice(0, 8) : [],
    tables: Array.isArray(last.tables) ? last.tables.slice(0, 10) : [],
    entities: Array.isArray(last.entities)
      ? last.entities.slice(0, 16).map(e => ({
          rank: e.rank,
          type: e.type,
          name: _str(e.name, 120),
          sourceTool: e.sourceTool || '',
        }))
      : [],
    facts: Array.isArray(last.facts)
      ? last.facts.slice(0, 6).map(f => ({ sourceTool: f.sourceTool || '', text: _str(f.text, 240) }))
      : [],
    queryState: last.queryState || last.lastQueryState || null,
  };
}

function _buildClassifierInput({ message, planningContext, conversationHistory, userName, role }) {
  const lastContext = _lastPlanningContext(planningContext);
  return {
    message: _str(message, 500),
    userName: _str(userName, 80),
    role: _str(role, 40),
    recentMessages: _recentMessages(conversationHistory),
    recentUserMessages: _recentUserMessages(conversationHistory),
    recentAssistantMessages: _recentAssistantMessages(conversationHistory),
    lastQueryState: lastContext && (lastContext.queryState || {
      question: lastContext.question,
      period: lastContext.period,
      intent: lastContext.intent,
      tools: lastContext.tools,
      tables: lastContext.tables,
      entities: lastContext.entities,
      facts: lastContext.facts,
    }),
    planningContextEntities: lastContext ? lastContext.entities : [],
    allowedIntentTypes: [
      'metric_definition',
      'result_set_reference',
      'correction_or_recompute',
      'new_query_explicit_target',
      'single_entity_reference',
      'ambiguous_reference',
      'clarification_rejection',
      'normal_query',
    ],
  };
}

function _looksLikeFollowup(message, conversationHistory = [], planningContext = []) {
  const q = String(message || '').trim();
  if (!q) return false;
  if (!conversationHistory.length && !planningContext.length) return false;
  return /(这个|那个|这些|这几个|上述|上面|前面|刚才|上一|它|其|第\s*[一二两三四五六七八九十\d]+|^那|为什么|为啥|原因|差在哪|你看呗|看呗|看一下|也请|继续|不对|有误|算错|不止|重新算|重算|纠正|更正|定义|口径|什么意思|怎么算|对应履约月份|追溯|表格|列出|展开|明细|领取|认领|我没有说过)/.test(q);
}

function _normalizeIntent(raw, originalMessage) {
  const out = raw && typeof raw === 'object' ? { ...raw } : {};
  const allowed = new Set([
    ...PASS_THROUGH_INTENTS,
    ...CLARIFYABLE_INTENTS,
  ]);
  if (!allowed.has(out.intentType)) out.intentType = 'normal_query';
  let confidence = Number(out.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  out.confidence = Math.max(0, Math.min(1, confidence));
  out.shouldClarify = !!out.shouldClarify;
  out.shouldPassToPlanner = out.shouldPassToPlanner !== false;
  out.isFollowup = out.isFollowup !== false && out.intentType !== 'normal_query';
  out.needsSingleEntity = !!out.needsSingleEntity;
  out.inheritedContext = out.inheritedContext && typeof out.inheritedContext === 'object' ? out.inheritedContext : {};
  out.rewriteMessage = _str(out.rewriteMessage || '', 600);
  out.missingSlots = Array.isArray(out.missingSlots) ? out.missingSlots.map(s => String(s || '')).filter(Boolean) : [];
  out.clarificationQuestion = _str(out.clarificationQuestion || '', 220);
  out.reason = _str(out.reason || '', 400);

  if (PASS_THROUGH_INTENTS.has(out.intentType)) {
    out.shouldClarify = false;
    out.shouldPassToPlanner = true;
  }

  if (CLARIFYABLE_INTENTS.has(out.intentType)) {
    const canClarify = out.shouldClarify && out.confidence >= 0.75;
    out.shouldClarify = canClarify;
    out.shouldPassToPlanner = !canClarify;
    if (canClarify && !out.clarificationQuestion) {
      out.clarificationQuestion = '我需要确认一下你具体指的是哪个对象，可以发名称或序号，我再继续查。';
    }
  }

  if (!out.rewriteMessage && out.shouldPassToPlanner) out.rewriteMessage = originalMessage;
  return out;
}

function _fallbackClassify({ message, planningContext, conversationHistory }) {
  const q = String(message || '').trim();
  const lastUser = _lastUserBeforeLatest(conversationHistory);
  const lastContext = _lastPlanningContext(planningContext);
  const base = {
    confidence: 0.68,
    isFollowup: true,
    shouldPassToPlanner: true,
    shouldClarify: false,
    inheritedContext: lastContext || {},
    rewriteMessage: q,
    missingSlots: [],
    reason: 'fallback rule classifier',
    _provider: 'fallback-rule',
  };

  if (!q) return { ...base, intentType: 'normal_query', isFollowup: false };
  if (/我没有说过|没说过/.test(q)) {
    return {
      ...base,
      intentType: 'clarification_rejection',
      confidence: 0.82,
      rewriteMessage: lastUser || q,
      reason: '用户反驳上一轮澄清，恢复最近一次用户问题',
    };
  }
  if (/(定义|口径|是什么意思|什么意思|怎么算|计算逻辑|包含|不包含|来源)/.test(q)) {
    return { ...base, intentType: 'metric_definition', confidence: 0.82 };
  }
  if (/(不对|有误|算错|不是|不止|重新算|重算|匹配|追溯|纠正|更正|领取|认领)/.test(q)) {
    return { ...base, intentType: 'correction_or_recompute', confidence: 0.78 };
  }
  if (/(这些|这几个|上述|上面|这几笔|这几项|这几个项目|这些收款|这些款项|分别|明细|表格|列出|展开|对应履约月份|为什么|为啥|原因|差在哪|你看呗|看呗|继续看|继续)/.test(q)) {
    return { ...base, intentType: 'result_set_reference', confidence: 0.8 };
  }
  if (/(PUMA|安踏|华为|农本方|健康美学|耐消行业|鞋服行业|X行业|x行业|我部门|我们部门|Q1|[1-9]\s*月|202\d年|履约|回款|利润|收入)/.test(q)) {
    return { ...base, intentType: 'new_query_explicit_target', confidence: 0.74 };
  }
  const old = resolveReference({ message, planningContext, conversationHistory });
  if (old && old.resolved) {
    return {
      ...base,
      intentType: 'single_entity_reference',
      confidence: 0.8,
      rewriteMessage: old.resolvedMessage,
      inheritedContext: { entity: old.entity },
      reason: 'fallback resolved by legacy reference resolver',
    };
  }
  if (/^(那)?(这个|那个|它|这个呢|那个呢|那它呢|第一个\??)$/.test(q) || /第\s*[一二两三四五六七八九十\d]+/.test(q)) {
    return {
      ...base,
      intentType: 'ambiguous_reference',
      confidence: 0.82,
      shouldClarify: true,
      shouldPassToPlanner: false,
      clarificationQuestion: '我需要确认一下你具体指的是上一轮里的哪个项目或哪笔款项，可以发名称或序号。',
      reason: '只有代词/序号，缺少指标和动作，无法安全继承上下文',
    };
  }
  return { ...base, intentType: 'normal_query', isFollowup: false };
}

const FOLLOWUP_CLASSIFIER_SYSTEM_PROMPT = [
  '你是追问意图分类器，不负责回答用户问题。',
  '你只能输出 JSON，不能输出自然语言解释。',
  '不要编造项目、部门、金额，只能基于输入上下文判断。',
  'intentType 必须是 allowedIntentTypes 之一。',
  '如果用户是在问字段定义、口径、纠错重算、结果集展开，shouldClarify 必须为 false。',
  '只有用户问题缺少必要对象、无法从上下文补齐，且确实是单个对象指代时，shouldClarify 才能为 true。',
  '低置信时 shouldPassToPlanner=true，shouldClarify=false。',
  'rewriteMessage 应把可继承上下文写清楚，供 Planner 使用。',
  '输出字段：intentType, confidence, shouldClarify, shouldPassToPlanner, isFollowup, needsSingleEntity, inheritedContext, rewriteMessage, missingSlots, clarificationQuestion, reason。',
].join('\n');

async function classifyFollowupIntent(payload = {}, opts = {}) {
  const { message, planningContext = [], conversationHistory = [] } = payload;
  if (!_looksLikeFollowup(message, conversationHistory, planningContext)) {
    return _normalizeIntent({
      intentType: 'normal_query',
      confidence: 0.9,
      shouldClarify: false,
      shouldPassToPlanner: true,
      isFollowup: false,
      reason: 'not followup-like',
    }, message);
  }

  const provider = (config.FOLLOWUP_INTENT_PROVIDER || 'minimax').toLowerCase();
  const input = _buildClassifierInput(payload);

  if (provider === 'minimax' && config.MINIMAX_API_KEY) {
    try {
      const messages = [
        { role: 'system', content: [{ type: 'input_text', text: FOLLOWUP_CLASSIFIER_SYSTEM_PROMPT }] },
        { role: 'user', content: [{ type: 'input_text', text: JSON.stringify(input) }] },
      ];
      const res = await minimaxClient.chat(messages, {
        model: config.FOLLOWUP_INTENT_MODEL || config.MINIMAX_MODEL,
        temperature: 0.01,
        max_output_tokens: 1200,
        textFormat: { type: 'json_object' },
        parent: opts.parent,
        generationName: 'followup-intent-minimax',
      });
      const parsed = _parseJSON(res && res.text);
      if (parsed) {
        return {
          ..._normalizeIntent(parsed, message),
          _provider: 'minimax',
          _rawText: res.text,
        };
      }
      logger.warn(`[FollowupIntent] MiniMax JSON 解析失败，走规则兜底: ${(res && res.text || '').slice(0, 200)}`);
    } catch (e) {
      logger.warn(`[FollowupIntent] MiniMax 分类失败，走规则兜底: ${e.message}`);
    }
  }

  return _normalizeIntent(_fallbackClassify(payload), message);
}

module.exports = {
  classifyFollowupIntent,
  _fallbackClassify,
  _normalizeIntent,
  _looksLikeFollowup,
};
