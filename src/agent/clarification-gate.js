'use strict';

const {
  buildReceivableMetricClarification,
  restorePendingClarification,
} = require('./pending-clarification');
const config = require('../../config');

const PENDING_TTL_MS = 10 * 60 * 1000;

function _str(value, max = 300) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function _uniq(list, max = 30) {
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

function _lastPlanningContext(planningContext = []) {
  const contexts = Array.isArray(planningContext) ? planningContext.filter(Boolean) : [];
  return contexts[contexts.length - 1] || null;
}

function _baseQueryStateFromContext(ctx) {
  if (!ctx) return {};
  const qs = ctx.queryState || {};
  const projects = Array.isArray(qs.targetProjects) && qs.targetProjects.length > 0
    ? qs.targetProjects
    : (Array.isArray(ctx.entities) ? ctx.entities.filter(e => e && e.type === 'project').map(e => e.name) : []);
  return {
    dept: _str(qs.dept || ''),
    period: _str(qs.period || ctx.period || ''),
    metric: _str(qs.metric || ''),
    resultSetType: _str(qs.resultSetType || ''),
    sourceTools: Array.isArray(qs.sourceTools) ? qs.sourceTools.slice(0, 8) : (Array.isArray(ctx.tools) ? ctx.tools.slice(0, 8) : []),
    sourceTables: Array.isArray(qs.sourceTables) ? qs.sourceTables.slice(0, 12) : (Array.isArray(ctx.tables) ? ctx.tables.slice(0, 12) : []),
    targetProjects: _uniq(projects, 30),
    scopeSource: 'inherited_result_set',
  };
}

function _buildSlotPending({
  message = '',
  clarificationQuestion = '',
  missingSlots = [],
  candidates = [],
  baseQueryState = {},
  restoreRule = {},
  now = Date.now(),
} = {}) {
  return {
    type: 'slot_clarification',
    originalMessage: _str(message, 300),
    clarificationQuestion: _str(clarificationQuestion, 300),
    missingSlots: Array.isArray(missingSlots) ? missingSlots : [],
    candidates: Array.isArray(candidates) ? candidates : [],
    baseQueryState,
    restoreRule,
    createdAt: now,
    expiresAt: now + PENDING_TTL_MS,
  };
}

function _candidateLabels(candidates = []) {
  return (Array.isArray(candidates) ? candidates : [])
    .map(c => (c && typeof c === 'object') ? c.label : c)
    .map(v => _str(v, 80))
    .filter(Boolean);
}

function _matchCandidate(message, candidates = []) {
  const q = _str(message, 80);
  if (!q) return null;
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const label = _str(candidate && typeof candidate === 'object' ? candidate.label : candidate, 80);
    const value = _str(candidate && typeof candidate === 'object' ? candidate.value : candidate, 80);
    if (!label && !value) continue;
    if (q === label || q === value || (label && q.includes(label)) || (value && q.includes(value))) {
      return candidate && typeof candidate === 'object' ? candidate : { label, value: label };
    }
  }
  return null;
}

function _lockedScopeFromPending(pending, slotValue = null) {
  const base = pending.baseQueryState || {};
  return {
    source: 'pending_clarification',
    targetProjects: _uniq(base.targetProjects, 50),
    targetEntities: [],
    depts: base.dept ? [base.dept] : [],
    period: _str(base.period || ''),
    metric: _str((slotValue && (slotValue.value || slotValue.label)) || base.metric || ''),
    resultSetType: _str(base.resultSetType || ''),
    sourceTools: Array.isArray(base.sourceTools) ? base.sourceTools.slice(0, 8) : [],
    confidence: 0.94,
    reason: 'restored from pending clarification slot answer',
  };
}

function restoreFromPending({ message = '', pendingClarification = null, now = Date.now() } = {}) {
  if (!pendingClarification) return null;
  if (!config.CLARIFICATION_KEYWORD_FALLBACK_ENABLED) return null;

  const legacy = restorePendingClarification({ message, pendingClarification, now });
  if (legacy) {
    return {
      restored: true,
      effectiveMessage: legacy.effectiveMessage,
      lockedScope: {
        source: 'pending_clarification',
        targetProjects: _uniq(legacy.inheritedScope && legacy.inheritedScope.targetProjects, 50),
        targetEntities: [],
        depts: legacy.inheritedScope && legacy.inheritedScope.dept ? [legacy.inheritedScope.dept] : [],
        period: _str(legacy.inheritedScope && legacy.inheritedScope.period || ''),
        metric: _str(legacy.inheritedScope && (legacy.inheritedScope.metricLabel || legacy.inheritedScope.metric) || ''),
        resultSetType: _str(legacy.inheritedScope && legacy.inheritedScope.resultSetType || ''),
        sourceTools: Array.isArray(legacy.inheritedScope && legacy.inheritedScope.sourceTools) ? legacy.inheritedScope.sourceTools : [],
        confidence: 0.98,
        reason: 'legacy receivable pending clarification restored',
      },
      intent: legacy.intent,
    };
  }

  if (pendingClarification.type !== 'slot_clarification') return null;
  if (pendingClarification.expiresAt && Number(pendingClarification.expiresAt) < now) return null;
  const matched = _matchCandidate(message, pendingClarification.candidates);
  if (!matched) return null;
  const label = matched.label || matched.value || _str(message, 80);
  const base = pendingClarification.baseQueryState || {};
  const projects = _uniq(base.targetProjects, 30);
  const effectiveMessage = projects.length > 0
    ? `在上一轮这些项目中，按${label}继续分析；仅限这些项目：${projects.join('、')}`
    : `${pendingClarification.originalMessage || ''}；补充条件：${label}`;
  return {
    restored: true,
    effectiveMessage,
    lockedScope: _lockedScopeFromPending(pendingClarification, matched),
    intent: {
      intentType: 'clarification_slot_answer',
      confidence: 0.92,
      isFollowup: true,
      shouldPassToPlanner: true,
      shouldClarify: false,
      rewriteMessage: effectiveMessage,
      reason: 'generic slot clarification restored',
    },
  };
}

function _ambiguousReceivableWorst(message, contextResolution) {
  const q = _str(message, 160);
  if (!/(回款|收款|应收)/.test(q)) return false;
  if (!/(最差|较差|很差|最低|最不好|哪个.*差|差的是哪个|风险最高)/.test(q)) return false;
  if (/风险/.test(q)) return false;
  if (/(回款率|收款率|未回款金额|未回金额|回款金额|到账金额|账龄|逾期)/.test(q)) return false;
  const projects = contextResolution && contextResolution.lockedScope && contextResolution.lockedScope.targetProjects;
  return Array.isArray(projects) && projects.length > 0;
}

function _periodAmbiguous(message) {
  const q = _str(message, 120);
  return /^(那)?(这个月|那个月|本月|上月|最近)$/.test(q);
}

function _rankingMetricAmbiguous(message, contextResolution) {
  const q = _str(message, 160);
  if (!/(排名|最好|最差|最高|最低|top|TOP)/.test(q)) return false;
  if (/(收入|利润率|利润|回款|收款|应收|逾期|风险|成本|人力|FTE)/.test(q)) return false;
  const projects = contextResolution && contextResolution.lockedScope && contextResolution.lockedScope.targetProjects;
  return Array.isArray(projects) && projects.length > 0;
}

function checkClarification({
  message = '',
  planningContext = [],
  contextResolution = null,
  pendingClarification = null,
  now = Date.now(),
} = {}) {
  const restored = restoreFromPending({ message, pendingClarification, now });
  if (restored) {
    return {
      action: 'continue',
      restored: true,
      effectiveMessage: restored.effectiveMessage,
      lockedScope: restored.lockedScope,
      intent: restored.intent,
    };
  }

  if (contextResolution && contextResolution.needsClarification) {
    const ctx = _lastPlanningContext(planningContext);
    const baseQueryState = _baseQueryStateFromContext(ctx);
    const question = contextResolution.clarificationQuestion
      || '你说的是哪个项目？可以发项目名称，或回复上一轮列表里的序号。';
    return {
      action: 'clarify',
      clarificationQuestion: question,
      pendingClarification: _buildSlotPending({
        message,
        clarificationQuestion: question,
        missingSlots: [contextResolution.clarificationSlot || 'target_entity'],
        candidates: [],
        baseQueryState,
        restoreRule: { intentType: 'single_entity_reference', scopeSource: 'pending_clarification' },
        now,
      }),
    };
  }

  if (_ambiguousReceivableWorst(message, contextResolution)) {
    const legacy = buildReceivableMetricClarification({ message, planningContext, now });
    if (legacy) {
      return {
        action: 'clarify',
        clarificationQuestion: legacy.clarificationQuestion,
        pendingClarification: legacy.pendingClarification,
      };
    }
  }

  if (_periodAmbiguous(message)) {
    const ctx = _lastPlanningContext(planningContext);
    const question = '你想看哪个月份？可以直接回“4月”或“2026年4月”。';
    return {
      action: 'clarify',
      clarificationQuestion: question,
      pendingClarification: _buildSlotPending({
        message,
        clarificationQuestion: question,
        missingSlots: ['period'],
        candidates: [],
        baseQueryState: _baseQueryStateFromContext(ctx),
        restoreRule: { intentType: 'period_slot_answer', scopeSource: 'pending_clarification' },
        now,
      }),
    };
  }

  if (_rankingMetricAmbiguous(message, contextResolution)) {
    const ctx = _lastPlanningContext(planningContext);
    const question = '你想按哪个口径排序：收入、利润、利润率、回款，还是风险？';
    return {
      action: 'clarify',
      clarificationQuestion: question,
      pendingClarification: _buildSlotPending({
        message,
        clarificationQuestion: question,
        missingSlots: ['ranking_metric'],
        candidates: [
          { label: '收入', value: 'revenue' },
          { label: '利润', value: 'profit' },
          { label: '利润率', value: 'profit_rate' },
          { label: '回款', value: 'receivables' },
          { label: '风险', value: 'risk' },
        ],
        baseQueryState: _baseQueryStateFromContext(ctx),
        restoreRule: { intentType: 'ranking_metric_slot_answer', scopeSource: 'pending_clarification' },
        now,
      }),
    };
  }

  return { action: 'continue' };
}

module.exports = {
  PENDING_TTL_MS,
  checkClarification,
  restoreFromPending,
  _buildSlotPending,
  _candidateLabels,
};
