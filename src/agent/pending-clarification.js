'use strict';

const PENDING_TTL_MS = 10 * 60 * 1000;
const PROJECT_SCOPE_SOURCES = new Set(['inherited_result_set', 'pending_clarification', 'explicit_project']);

function _str(v, max = 800) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function _uniq(list) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const s = _str(item, 120);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function _lastPlanningContext(planningContext = []) {
  const contexts = Array.isArray(planningContext) ? planningContext.filter(Boolean) : [];
  return contexts[contexts.length - 1] || null;
}

function _contextProjects(ctx) {
  const fromState = ctx && ctx.queryState && Array.isArray(ctx.queryState.targetProjects)
    ? ctx.queryState.targetProjects
    : [];
  if (fromState.length > 0) return _uniq(fromState).slice(0, 20);
  const fromEntities = Array.isArray(ctx && ctx.entities)
    ? ctx.entities.filter(e => e && e.type === 'project' && e.name).map(e => e.name)
    : [];
  return _uniq(fromEntities).slice(0, 20);
}

function _contextDept(ctx) {
  const qs = ctx && ctx.queryState;
  if (qs && qs.dept) return _str(qs.dept, 80);
  const entities = Array.isArray(ctx && ctx.entities) ? ctx.entities : [];
  const deptEntity = entities.find(e => e && e.type === 'dept' && e.name);
  return deptEntity ? _str(deptEntity.name, 80) : '';
}

function _periodLabel(period) {
  const p = _str(period, 40);
  if (!p) return '';
  if (p === '2026-04') return '2026年1-4月';
  if (/^\d{4}-\d{2}$/.test(p)) {
    const [year, month] = p.split('-');
    return `${year}年1-${Number(month)}月`;
  }
  if (p === 'ytd') return '年初至今';
  return p;
}

function _resultSetLabel(qs) {
  const resultSetType = _str(qs && qs.resultSetType, 80);
  const metric = _str(qs && qs.metric, 80);
  if (resultSetType === 'finance.projectMetrics' && /profit|rate/.test(metric)) return '上一轮项目';
  if (resultSetType === 'finance.projectMetrics') return '上一轮项目';
  if (resultSetType === 'invoice.receipts') return '上一轮回款项目';
  return '上一轮项目';
}

function _buildBaseQueryState(planningContext = []) {
  const ctx = _lastPlanningContext(planningContext);
  if (!ctx) return null;
  const qs = ctx.queryState || {};
  const targetProjects = _contextProjects(ctx);
  return {
    dept: _contextDept(ctx),
    period: _str(qs.period || ctx.period, 40),
    metric: _str(qs.metric, 80),
    resultSetType: _str(qs.resultSetType, 100),
    sourceTools: Array.isArray(qs.sourceTools) ? qs.sourceTools.slice(0, 8) : (Array.isArray(ctx.tools) ? ctx.tools.slice(0, 8) : []),
    sourceTables: Array.isArray(qs.sourceTables) ? qs.sourceTables.slice(0, 12) : (Array.isArray(ctx.tables) ? ctx.tables.slice(0, 12) : []),
    targetProjects,
    scopeSource: 'inherited_result_set',
  };
}

function buildPendingClarification({ message = '', clarification = '', planningContext = [], now = Date.now() } = {}) {
  const text = `${message}\n${clarification}`;
  const baseQueryState = _buildBaseQueryState(planningContext);
  const safeBaseQueryState = baseQueryState || {
    dept: '',
    period: '',
    metric: '',
    resultSetType: '',
    sourceTools: [],
    sourceTables: [],
    targetProjects: [],
    scopeSource: 'pending_clarification',
  };

  if (/(哪个月|哪月|月份|月度|时间|period)/.test(text)) {
    return {
      type: 'slot_clarification',
      originalMessage: _str(message, 300),
      clarificationQuestion: _str(clarification, 300),
      missingSlots: ['period'],
      candidates: [],
      restoreRule: { intentType: 'period_slot_answer', scopeSource: 'pending_clarification' },
      createdAt: now,
      expiresAt: now + PENDING_TTL_MS,
      baseQueryState: safeBaseQueryState,
    };
  }

  if (/(回款|收款|应收|账龄|逾期)/.test(text) && baseQueryState && baseQueryState.targetProjects.length > 0) {
    return {
      type: 'receivable_metric',
      originalMessage: _str(message, 300),
      clarificationQuestion: _str(clarification, 300),
      candidates: ['回款率', '未回款金额', '回款金额', '逾期账龄'],
      createdAt: now,
      expiresAt: now + PENDING_TTL_MS,
      baseQueryState,
    };
  }

  if (/(按哪个|什么口径|哪个口径|排序|排名|最好|最差|最高|最低)/.test(text)) {
    return {
      type: 'slot_clarification',
      originalMessage: _str(message, 300),
      clarificationQuestion: _str(clarification, 300),
      missingSlots: ['ranking_metric'],
      candidates: [
        { label: '收入', value: 'revenue' },
        { label: '利润', value: 'profit' },
        { label: '利润率', value: 'profit_rate' },
        { label: '回款', value: 'receivables' },
        { label: '风险', value: 'risk' },
      ],
      restoreRule: { intentType: 'ranking_metric_slot_answer', scopeSource: 'pending_clarification' },
      createdAt: now,
      expiresAt: now + PENDING_TTL_MS,
      baseQueryState: safeBaseQueryState,
    };
  }
  return null;
}

function _isExpired(pending, now = Date.now()) {
  if (!pending) return true;
  const expiresAt = Number(pending.expiresAt || 0);
  return expiresAt > 0 && expiresAt < now;
}

function _receivableMetricAnswer(message) {
  const q = _str(message, 80);
  if (!q) return null;
  if (/^(回款率|收款率|按回款率|回款比例|收回来比例)$/.test(q)) {
    return {
      key: 'receivable_rate',
      label: '回款率',
      action: '按回款率从低到高找出回款最差的项目',
    };
  }
  if (/^(未回款金额|未回金额|应收金额|应收款|没回来的金额)$/.test(q)) {
    return {
      key: 'outstanding_amount',
      label: '未回款金额',
      action: '按未回款金额从高到低找出回款压力最大的项目',
    };
  }
  if (/^(回款金额|已回款金额|收款金额|到账金额)$/.test(q)) {
    return {
      key: 'received_amount',
      label: '回款金额',
      action: '按已回款金额从低到高找出回款金额最差的项目',
    };
  }
  if (/^(账龄|逾期账龄|应收账款账龄|拖了多久)$/.test(q)) {
    return {
      key: 'receivable_aging',
      label: '逾期账龄',
      action: '按逾期账龄和到期未回情况找出回款风险最高的项目',
    };
  }
  return null;
}

function _receivableMetricFromQuestion(message) {
  const q = _str(message, 120);
  if (!q) return null;
  if (/(回款率|收款率|回款比例|收款比例|收回来比例)/.test(q)) {
    return {
      key: 'receivable_rate',
      label: '回款率',
      action: '按回款率从低到高找出回款最差的项目',
    };
  }
  if (/(未回款金额|未回金额|未回款|应收金额|应收款|没回来|没收回)/.test(q)) {
    return {
      key: 'outstanding_amount',
      label: '未回款金额',
      action: '按未回款金额从高到低找出回款压力最大的项目',
    };
  }
  if (/(回款金额|已回款金额|收款金额|到账金额|已到账|到账)/.test(q)) {
    return {
      key: 'received_amount',
      label: '回款金额',
      action: '按已回款金额从低到高找出回款金额最差的项目',
    };
  }
  if (/(账龄|逾期|到期未回|风险)/.test(q)) {
    return {
      key: 'receivable_aging',
      label: '逾期账龄',
      action: '按逾期账龄和到期未回情况找出回款风险最高的项目',
    };
  }
  return null;
}

function _hasProjectSetReference(message) {
  const q = _str(message, 120);
  return /(^那|这些|这几个|上述|上面|前面|上一轮|刚才|它们|其中)/.test(q);
}

function _isExplicitNewRangeRequest(message) {
  const q = _str(message, 160);
  if (!q) return false;
  if (/(这些|这几个|上述|上面|前面|上一轮|刚才|它们|其中).{0,8}(项目|款|回款|利润|收入)?/.test(q)) {
    return false;
  }
  if (/(整体|全量|全部|所有|整个|全司|公司|我们部门|我部门|部门整体|行业群整体|中心整体|事业部整体)/.test(q)) {
    return true;
  }
  return /(健康美学|健慷美学|耐消|鞋服|时尚|快消|公域|生态|X行业|x行业|社区运营|内容业务|品牌连锁|TOC创新)/.test(q);
}

function _isAmbiguousReceivableWorst(message) {
  const q = _str(message, 120);
  if (!/(回款|收款|应收)/.test(q)) return false;
  if (!/(最差|较差|很差|最低|最不好|哪个.*差|差的是哪个|风险最高)/.test(q)) return false;
  return !_receivableMetricFromQuestion(q);
}

function buildReceivableMetricClarification({ message = '', planningContext = [], now = Date.now() } = {}) {
  if (_isExplicitNewRangeRequest(message)) return null;
  if (!_hasProjectSetReference(message) || !_isAmbiguousReceivableWorst(message)) return null;
  const baseQueryState = _buildBaseQueryState(planningContext);
  if (!baseQueryState || baseQueryState.targetProjects.length === 0) return null;

  const clarificationQuestion = '你说的“回款最差”想按哪个口径看：回款率、未回款金额、回款金额，还是逾期账龄？确认口径后我会只看上一轮这些项目。';
  return {
    clarificationQuestion,
    pendingClarification: {
      type: 'receivable_metric',
      originalMessage: _str(message, 300),
      clarificationQuestion,
      candidates: ['回款率', '未回款金额', '回款金额', '逾期账龄'],
      createdAt: now,
      expiresAt: now + PENDING_TTL_MS,
      baseQueryState,
    },
  };
}

function restorePendingClarification({ message = '', pendingClarification = null, now = Date.now() } = {}) {
  if (!pendingClarification || _isExpired(pendingClarification, now)) return null;
  if (pendingClarification.type !== 'receivable_metric') return null;
  const metric = _receivableMetricAnswer(message);
  if (!metric) return null;

  const base = pendingClarification.baseQueryState || {};
  const targetProjects = _uniq(base.targetProjects).slice(0, 20);
  if (targetProjects.length === 0) return null;

  const deptPart = base.dept ? `${base.dept}` : '';
  const periodPart = _periodLabel(base.period);
  const resultSet = _resultSetLabel(base);
  const prefix = ['在', deptPart, periodPart, resultSet].filter(Boolean).join('');
  const effectiveMessage = `${prefix}中，${metric.action}；仅限这些项目：${targetProjects.join('、')}`;

  return {
    effectiveMessage,
    inheritedScope: {
      ...base,
      metric: metric.key,
      metricLabel: metric.label,
      targetProjects,
      scopeSource: 'pending_clarification',
    },
    intent: {
      intentType: 'clarification_slot_answer',
      confidence: 0.98,
      isFollowup: true,
      shouldPassToPlanner: true,
      shouldClarify: false,
      rewriteMessage: effectiveMessage,
      reason: 'pending clarification slot answer restored deterministically',
    },
  };
}

function restoreProjectSetMetricRequest({ message = '', planningContext = [] } = {}) {
  const q = _str(message, 120);
  if (!q || !/(回款|收款|应收|账龄|逾期|到账)/.test(q)) return null;
  if (_isExplicitNewRangeRequest(q)) return null;
  if (/(定义|口径|是什么意思|什么意思|怎么算|计算逻辑|包含|不包含|来源|区别|差异)/.test(q)) return null;
  const metric = _receivableMetricFromQuestion(q) || _receivableMetricAnswer(q);
  if (!metric) return null;
  if (!_hasProjectSetReference(q) && q.length > 12) return null;

  const base = _buildBaseQueryState(planningContext);
  const targetProjects = _uniq(base && base.targetProjects).slice(0, 20);
  if (!base || targetProjects.length === 0) return null;

  const deptPart = base.dept ? `${base.dept}` : '';
  const periodPart = _periodLabel(base.period);
  const resultSet = _resultSetLabel(base);
  const prefix = ['在', deptPart, periodPart, resultSet].filter(Boolean).join('');
  const effectiveMessage = `${prefix}中，${metric.action}；仅限这些项目：${targetProjects.join('、')}`;

  return {
    effectiveMessage,
    inheritedScope: {
      ...base,
      metric: metric.key,
      metricLabel: metric.label,
      resultSetType: 'invoice.receipts',
      sourceTools: ['finance.receivables'],
      targetProjects,
      scopeSource: 'inherited_result_set',
    },
    intent: {
      intentType: 'result_set_reference',
      confidence: 0.94,
      isFollowup: true,
      shouldPassToPlanner: true,
      shouldClarify: false,
      rewriteMessage: effectiveMessage,
      reason: 'receivables metric request restored from previous project set',
    },
  };
}

function restoreProjectSetProfitMetricRequest({ message = '', planningContext = [] } = {}) {
  const q = _str(message, 120);
  if (!q || !_hasProjectSetReference(q)) return null;
  if (_isExplicitNewRangeRequest(q)) return null;
  if (/(定义|口径|是什么意思|什么意思|怎么算|计算逻辑|包含|不包含|来源|区别|差异)/.test(q)) return null;
  if (!/(利润率|利润|毛利率|亏损|盈利|收入|成本)/.test(q)) return null;

  const base = _buildBaseQueryState(planningContext);
  const targetProjects = _uniq(base && base.targetProjects).slice(0, 20);
  if (!base || targetProjects.length === 0) return null;

  const metric = /利润率|毛利率/.test(q) ? 'profit_rate'
    : /亏损|盈利|利润/.test(q) ? 'profit'
      : /成本/.test(q) ? 'cost'
        : 'revenue';
  const action = metric === 'profit_rate'
    ? '分析这些项目的利润率并按利润率排序'
    : metric === 'profit'
      ? '分析这些项目的履约利润和亏损情况'
      : metric === 'cost'
        ? '分析这些项目的履约成本情况'
        : '分析这些项目的履约收入情况';

  const deptPart = base.dept ? `${base.dept}` : '';
  const periodPart = _periodLabel(base.period);
  const resultSet = _resultSetLabel(base);
  const prefix = ['在', deptPart, periodPart, resultSet].filter(Boolean).join('');
  const effectiveMessage = `${prefix}中，${action}；仅限这些项目：${targetProjects.join('、')}`;

  return {
    effectiveMessage,
    inheritedScope: {
      ...base,
      metric,
      resultSetType: 'finance.projectMetrics',
      sourceTools: ['finance.profitOverview'],
      targetProjects,
      scopeSource: 'inherited_result_set',
    },
    intent: {
      intentType: 'result_set_reference',
      confidence: 0.93,
      isFollowup: true,
      shouldPassToPlanner: true,
      shouldClarify: false,
      rewriteMessage: effectiveMessage,
      reason: 'profit metric request restored from previous project set',
    },
  };
}

function _isReceivableContext(ctx) {
  const qs = ctx && ctx.queryState;
  const tools = new Set([
    ...(Array.isArray(ctx && ctx.tools) ? ctx.tools : []),
    ...(Array.isArray(qs && qs.sourceTools) ? qs.sourceTools : []),
  ]);
  return tools.has('finance.receivables')
    || /receivable|receipt|actual_receipts/.test(_str(qs && (qs.metric || qs.resultSetType), 120));
}

function restoreContextContinuation({ message = '', planningContext = [], conversationHistory = [] } = {}) {
  const q = _str(message, 120);
  if (!q) return null;
  if (_isExplicitNewRangeRequest(q)) return null;
  const ctx = _lastPlanningContext(planningContext);
  if (!ctx || !_isReceivableContext(ctx)) return null;
  const targetProjects = _contextProjects(ctx);
  if (targetProjects.length === 0) return null;

  const isReason = /(为什么|原因|差在哪|为啥)/.test(q) && /(这几个|这些|上述|上面|差|回款)/.test(q);
  const isContinue = /^(你看呗|看呗|看一下|继续|继续看|查一下|拉一下|那你看|你查一下|好你看|好的你看)[吧呗啊\s]*$/.test(q);
  if (!isReason && !isContinue) return null;

  const recentAssistant = (Array.isArray(conversationHistory) ? conversationHistory : [])
    .filter(m => m && m.role === 'assistant')
    .slice(-2)
    .map(m => _str(m.content, 500))
    .join('\n');
  const continueFromDetailPrompt = /让我拉一下|详细开票回款|INVOICE|明细|预计回款|实际状态/.test(recentAssistant);
  if (isContinue && !continueFromDetailPrompt && !/回款/.test(recentAssistant)) return null;

  const qs = ctx.queryState || {};
  const deptPart = _contextDept(ctx);
  const periodPart = _periodLabel(qs.period || ctx.period);
  const prefix = ['分析上一轮', deptPart, periodPart, '回款率较差的这些项目'].filter(Boolean).join('');
  const effectiveMessage = `${prefix}为什么回款差；请查询 INVOICE 明细，按预计回款日期、实际回款金额、未回款金额、逾期状态、账期节点解释原因；仅限这些项目：${targetProjects.join('、')}`;

  return {
    effectiveMessage,
    inheritedScope: {
      dept: deptPart,
      period: qs.period || ctx.period || '',
      metric: 'receivable_reason',
      resultSetType: 'invoice.receipts',
      sourceTools: ['finance.receivables'],
      targetProjects,
      scopeSource: 'inherited_result_set',
    },
    intent: {
      intentType: 'result_set_reference',
      confidence: 0.92,
      isFollowup: true,
      shouldPassToPlanner: true,
      shouldClarify: false,
      rewriteMessage: effectiveMessage,
      reason: 'receivables continuation restored deterministically',
    },
  };
}

function applyInheritedScopeToPlan(planResult, referenceResolution) {
  if (!planResult || !referenceResolution) return planResult;
  const inherited = referenceResolution.inheritedScope
    || (referenceResolution.followupIntent && referenceResolution.followupIntent.inheritedScope)
    || null;
  if (!inherited) return planResult;

  const targetProjects = _uniq(inherited.targetProjects).slice(0, 50);
  const scopeSource = PROJECT_SCOPE_SOURCES.has(inherited.scopeSource)
    ? inherited.scopeSource
    : 'inherited_result_set';
  if (targetProjects.length === 0 || !PROJECT_SCOPE_SOURCES.has(scopeSource)) return planResult;

  if (!planResult.query_scope || typeof planResult.query_scope !== 'object') {
    planResult.query_scope = { depts: [] };
  }
  if (!Array.isArray(planResult.query_scope.depts)) planResult.query_scope.depts = [];
  if (inherited.dept && planResult.query_scope.depts.length === 0) {
    planResult.query_scope.depts = [inherited.dept];
  }
  planResult.query_scope.targetProjects = targetProjects;
  planResult.query_scope.scopeSource = scopeSource;

  if (/receivable|回款|收款|应收|账龄/.test(`${inherited.metric || ''} ${referenceResolution.resolvedMessage || ''}`)) {
    planResult.tools_needed = Array.isArray(planResult.tools_needed) ? planResult.tools_needed : [];
    planResult.tables_needed = Array.isArray(planResult.tables_needed) ? planResult.tables_needed : [];
    if (!planResult.tools_needed.includes('finance.receivables')) planResult.tools_needed.unshift('finance.receivables');
    for (const table of ['cashflow', 'projectMaster']) {
      if (!planResult.tables_needed.includes(table)) planResult.tables_needed.push(table);
    }
  }

  planResult.reasoning_framework = [
    planResult.reasoning_framework,
    `本轮继承上一轮项目范围，只能在这些项目内回答：${targetProjects.join('、')}。`,
  ].filter(Boolean).join('\n');
  return planResult;
}

function projectScopeFromPlan(planResult) {
  const qs = planResult && planResult.query_scope;
  const scopeSource = qs && PROJECT_SCOPE_SOURCES.has(qs.scopeSource) ? qs.scopeSource : '';
  const targetProjects = _uniq(qs && qs.targetProjects).slice(0, 50);
  if (!scopeSource || targetProjects.length === 0) return null;
  return { scopeSource, targetProjects };
}

module.exports = {
  PENDING_TTL_MS,
  PROJECT_SCOPE_SOURCES,
  buildPendingClarification,
  buildReceivableMetricClarification,
  restorePendingClarification,
  restoreProjectSetMetricRequest,
  restoreProjectSetProfitMetricRequest,
  restoreContextContinuation,
  applyInheritedScopeToPlan,
  projectScopeFromPlan,
  _contextProjects,
};
