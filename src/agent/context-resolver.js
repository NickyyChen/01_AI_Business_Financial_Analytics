'use strict';

const CN_NUM = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

function _str(value, max = 300) {
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

function _lastPlanningContext(planningContext = []) {
  const contexts = Array.isArray(planningContext) ? planningContext.filter(Boolean) : [];
  return contexts[contexts.length - 1] || null;
}

function _displayRows(ctx) {
  const rows = ctx && ctx.queryState && ctx.queryState.displayResultSet
    && Array.isArray(ctx.queryState.displayResultSet.rows)
    ? ctx.queryState.displayResultSet.rows
    : [];
  return rows.filter(row => row && (row.name || row.key || row.project));
}

function _contextProjects(ctx) {
  const displayProjects = _displayRows(ctx).map(row => row.name || row.key || row.project);
  if (displayProjects.length > 0) return _uniq(displayProjects);
  const stateProjects = ctx && ctx.queryState && Array.isArray(ctx.queryState.targetProjects)
    ? ctx.queryState.targetProjects
    : [];
  if (stateProjects.length > 0) return _uniq(stateProjects);
  const entities = Array.isArray(ctx && ctx.entities) ? ctx.entities : [];
  return _uniq(entities.filter(e => e && e.type === 'project' && e.name).map(e => e.name));
}

function _contextMetric(ctx) {
  return _str((ctx && ctx.queryState && ctx.queryState.metric) || '');
}

function _contextResultSetType(ctx) {
  return _str((ctx && ctx.queryState && ctx.queryState.resultSetType) || '');
}

function _contextPeriod(ctx) {
  return _str((ctx && ctx.queryState && ctx.queryState.period) || (ctx && ctx.period) || '');
}

function _contextDept(ctx) {
  return _str((ctx && ctx.queryState && ctx.queryState.dept) || '');
}

function _contextSourceTools(ctx) {
  const fromState = ctx && ctx.queryState && Array.isArray(ctx.queryState.sourceTools)
    ? ctx.queryState.sourceTools
    : [];
  const fromCtx = Array.isArray(ctx && ctx.tools) ? ctx.tools : [];
  return _uniq(fromState.length > 0 ? fromState : fromCtx, 12);
}

function _baseLockedScope(source = 'none', ctx = null, overrides = {}) {
  const projects = _contextProjects(ctx);
  const dept = _contextDept(ctx);
  return {
    source,
    targetProjects: projects,
    targetEntities: [],
    depts: dept ? [dept] : [],
    period: _contextPeriod(ctx),
    metric: _contextMetric(ctx),
    resultSetType: _contextResultSetType(ctx),
    sourceTools: _contextSourceTools(ctx),
    confidence: 0.7,
    reason: '',
    ...overrides,
  };
}

function _cnToNumber(raw) {
  const s = String(raw || '').replace(/[第名个项号\s]/g, '');
  if (/^\d+$/.test(s)) return Number(s);
  if (CN_NUM[s]) return CN_NUM[s];
  if (s.length === 2 && s[0] === '十' && CN_NUM[s[1]]) return 10 + CN_NUM[s[1]];
  if (s.length === 2 && s[1] === '十' && CN_NUM[s[0]]) return CN_NUM[s[0]] * 10;
  if (s.length === 3 && s[1] === '十' && CN_NUM[s[0]] && CN_NUM[s[2]]) {
    return CN_NUM[s[0]] * 10 + CN_NUM[s[2]];
  }
  return null;
}

function _detectRank(message) {
  const q = String(message || '');
  const match = q.match(/第\s*([一二两三四五六七八九十\d]{1,3})\s*(?:名|个|项|号)?/)
    || q.match(/([一二两三四五六七八九十\d]{1,3})\s*(?:号|个)\s*(?:项目|客户|部门|那个|这个)/);
  return match ? _cnToNumber(match[1]) : null;
}

function _findRankedEntity(ctx, rank, message = '') {
  if (!ctx || !rank) return null;
  const q = String(message || '');
  const wantedType = /客户/.test(q) ? 'customer'
    : /部门|行业群|中心|事业部|团队/.test(q) ? 'dept'
      : /项目|回款|利润|收入|成本|预算|风险|人力|FTE/.test(q) ? 'project'
        : '';
  const displayEntity = _displayRows(ctx)
    .map((row, idx) => ({
      rank: Number(row.rank) || idx + 1,
      type: row.type || 'project',
      name: row.name || row.key || row.project,
      sourceTool: (ctx.queryState.displayResultSet && ctx.queryState.displayResultSet.toolId) || row.sourceTool || '',
      metrics: row.metrics || row,
    }))
    .find(e => e && Number(e.rank) === rank && (!wantedType || e.type === wantedType));
  if (displayEntity) return displayEntity;
  const entities = Array.isArray(ctx.entities) ? ctx.entities : [];
  return entities.find(e => e && Number(e.rank) === rank && (!wantedType || e.type === wantedType))
    || entities.find(e => e && Number(e.rank) === rank)
    || null;
}

function _isMetricConceptQuestion(message) {
  const q = String(message || '').trim();
  if (!q) return false;
  if (!/(定义|口径|是什么意思|什么意思|怎么算|计算逻辑|包含|不包含|来源|区别|差异)/.test(q)) return false;
  return !/(多少|几个|几笔|排名|最高|最低|最差|统计|列出|明细|清单|哪个|哪几个|情况|趋势|分析|为什么|原因|风险)/.test(q);
}

function _hasStrongProjectSetReference(message) {
  const q = String(message || '').trim();
  return /(这些|这几个|上述|上面|前面|上一轮|刚才|它们|其中).{0,12}(项目|款|回款|利润|收入|风险)?/.test(q)
    || /(项目|款|回款|利润|收入|风险).{0,12}(这些|这几个|上述|上面|前面|上一轮|刚才|它们|其中)/.test(q);
}

function _isExplicitNewRangeRequest(message) {
  const q = String(message || '').trim();
  if (!q) return false;
  if (_hasStrongProjectSetReference(q)) return false;
  if (/(整体|全量|全部|所有|整个|全司|全公司|公司|我们部门|我部门|部门整体|行业群整体|中心整体|事业部整体)/.test(q)) {
    return true;
  }
  return /(健康美学|健慷美学|耐消|鞋服|时尚|快消|公域|生态|X行业|x行业|社区运营|内容业务|品牌连锁|TOC创新)/.test(q);
}

function _isContinuationRequest(message) {
  const q = String(message || '').trim();
  return /^(你看呗|看呗|看一下|继续|继续看|查一下|拉一下|那你看|你查一下|好你看|好的你看|展开|明细)[吧呗啊\s]*$/.test(q);
}

function _isSinglePronounReference(message) {
  const q = String(message || '').trim();
  return /^(那)?(这个|那个|它|这个呢|那个呢|那它呢|这个项目|那个项目|该项目|这个客户|那个客户|该客户)[？?吧呢\s]*$/.test(q);
}

function _isReceivableContext(ctx) {
  const metric = `${_contextMetric(ctx)} ${_contextResultSetType(ctx)}`;
  const tools = new Set(_contextSourceTools(ctx));
  return /receivable|receipt|actual_receipts|invoice|回款|收款|应收/.test(metric)
    || tools.has('finance.receivables');
}

function _recentAssistantText(conversationHistory = []) {
  return (Array.isArray(conversationHistory) ? conversationHistory : [])
    .filter(m => m && m.role === 'assistant')
    .slice(-2)
    .map(m => _str(m.content, 800))
    .join('\n');
}

function _hasDetailContinuationSignal(conversationHistory = []) {
  return /让我拉一下|详细开票回款|INVOICE|明细|预计回款|实际状态|展开/.test(_recentAssistantText(conversationHistory));
}

function resolveContext({
  message = '',
  routerIntent = null,
  planningContext = [],
  conversationHistory = [],
  pendingClarification = null,
} = {}) {
  const ctx = _lastPlanningContext(planningContext);
  const q = _str(message, 260);
  const empty = {
    isFollowup: !!(routerIntent && routerIntent.isFollowup),
    resolved: false,
    needsClarification: false,
    lockedScope: _baseLockedScope('none', null, {
      targetProjects: [],
      confidence: 0,
      reason: 'no context resolution applied',
    }),
  };

  if (!q) return empty;

  if (pendingClarification && pendingClarification.baseQueryState && Array.isArray(pendingClarification.baseQueryState.targetProjects)) {
    const candidates = pendingClarification.candidates || [];
    if (candidates.some(c => q.includes(String(c || '')))) {
      return {
        isFollowup: true,
        resolved: true,
        needsClarification: false,
        lockedScope: _baseLockedScope('pending_clarification', { queryState: pendingClarification.baseQueryState }, {
          confidence: 0.93,
          reason: 'pending clarification slot answer inherits previous scope',
        }),
      };
    }
  }

  if (!ctx) return empty;

  if (_isMetricConceptQuestion(q)) {
    return {
      isFollowup: true,
      resolved: false,
      needsClarification: false,
      lockedScope: _baseLockedScope('none', ctx, {
        targetProjects: [],
        confidence: 0.86,
        reason: 'metric concept question should not inherit project set',
      }),
    };
  }

  if (_isExplicitNewRangeRequest(q)) {
    return {
      isFollowup: false,
      resolved: false,
      needsClarification: false,
      lockedScope: _baseLockedScope('explicit_new_query', ctx, {
        targetProjects: [],
        confidence: 0.9,
        reason: 'explicit new range overrides previous project set',
      }),
    };
  }

  const rank = _detectRank(q);
  if (rank) {
    const entity = _findRankedEntity(ctx, rank, q);
    if (entity && entity.name) {
      return {
        isFollowup: true,
        resolved: true,
        needsClarification: false,
        lockedScope: _baseLockedScope('planning_context', ctx, {
          targetProjects: entity.type === 'project' ? [entity.name] : [],
          targetEntities: [{ ...entity, rank }],
          confidence: 0.92,
          reason: `rank reference resolved from planningContext: ${rank}`,
        }),
      };
    }
    return {
      isFollowup: true,
      resolved: false,
      needsClarification: true,
      clarificationSlot: 'target_entity',
      clarificationQuestion: `我需要确认一下你说的“第${rank}个”具体是哪一个对象，可以发名称或序号。`,
      lockedScope: _baseLockedScope('none', ctx, {
        targetProjects: [],
        confidence: 0.78,
        reason: `rank reference ${rank} cannot be resolved`,
      }),
    };
  }

  if (_hasStrongProjectSetReference(q)) {
    const projects = _contextProjects(ctx);
    if (projects.length > 0) {
      return {
        isFollowup: true,
        resolved: true,
        needsClarification: false,
        lockedScope: _baseLockedScope('planning_context', ctx, {
          targetProjects: projects,
          confidence: 0.9,
          reason: 'strong project-set reference inherits previous result set',
        }),
      };
    }
  }

  if (_isContinuationRequest(q) && _isReceivableContext(ctx) && _hasDetailContinuationSignal(conversationHistory)) {
    const projects = _contextProjects(ctx);
    if (projects.length > 0) {
      return {
        isFollowup: true,
        resolved: true,
        needsClarification: false,
        lockedScope: _baseLockedScope('planning_context', ctx, {
          targetProjects: projects,
          confidence: 0.88,
          reason: 'receivable detail continuation inherits previous result set',
        }),
      };
    }
  }

  if (_isSinglePronounReference(q)) {
    const projects = _contextProjects(ctx);
    if (projects.length === 1) {
      return {
        isFollowup: true,
        resolved: true,
        needsClarification: false,
        lockedScope: _baseLockedScope('planning_context', ctx, {
          targetProjects: projects,
          confidence: 0.84,
          reason: 'single pronoun resolved because previous context has one project',
        }),
      };
    }
    return {
      isFollowup: true,
      resolved: false,
      needsClarification: true,
      clarificationSlot: 'target_entity',
      clarificationQuestion: '你说的是哪个项目？可以发项目名称，或回复上一轮列表里的序号。',
      lockedScope: _baseLockedScope('none', ctx, {
        targetProjects: [],
        confidence: 0.78,
        reason: 'single pronoun has multiple candidate projects',
      }),
    };
  }

  return empty;
}

function scopeSourceForPlan(lockedScope) {
  if (!lockedScope || !lockedScope.source) return 'none';
  if (lockedScope.source === 'pending_clarification') return 'pending_clarification';
  if (lockedScope.source === 'planning_context') return 'inherited_result_set';
  if (lockedScope.source === 'explicit_project') return 'explicit_project';
  if (lockedScope.source === 'explicit_new_query') return 'explicit_new_query';
  return 'none';
}

function _ensureArrayProperty(obj, key) {
  if (!obj || typeof obj !== 'object') return [];
  if (!Array.isArray(obj[key])) obj[key] = [];
  return obj[key];
}

function _ensureTool(planResult, toolId, tables = []) {
  const tools = _ensureArrayProperty(planResult, 'tools_needed');
  if (!tools.includes(toolId)) tools.push(toolId);
  const tableList = _ensureArrayProperty(planResult, 'tables_needed');
  for (const table of tables) {
    if (table && !tableList.includes(table)) tableList.push(table);
  }
  if (!planResult.tool_params || typeof planResult.tool_params !== 'object' || Array.isArray(planResult.tool_params)) {
    planResult.tool_params = {};
  }
  if (!planResult.tool_params[toolId] || typeof planResult.tool_params[toolId] !== 'object' || Array.isArray(planResult.tool_params[toolId])) {
    planResult.tool_params[toolId] = {};
  }
  return planResult.tool_params[toolId];
}

function _metricToolSpec(metric) {
  const raw = String(metric || '').trim();
  const normalized = raw.replace(/[\s_-]/g, '').toLowerCase();
  if (!normalized) return null;
  if (['revenue', 'income', 'deliveryrevenue', '履约收入', '收入'].includes(normalized)) {
    return { toolId: 'finance.profitOverview', sortBy: 'revenue', order: 'desc' };
  }
  if (['profitrate', 'rate', 'margin', '利润率', '盈利能力'].includes(normalized)) {
    return { toolId: 'finance.profitOverview', sortBy: 'profitRate', order: 'asc' };
  }
  if (['profit', 'loss', '履约利润', '利润', '亏损', '盈亏'].includes(normalized)) {
    return { toolId: 'finance.profitOverview' };
  }
  if (['cost', 'expense', '履约成本', '成本', '费用'].includes(normalized)) {
    return { toolId: 'finance.profitOverview', sortBy: 'cost', order: 'desc' };
  }
  if (['outstanding', 'unpaid', 'receivable', 'ar', '未回款金额', '未回款', '应收'].includes(normalized)) {
    return { toolId: 'finance.receivables', sortBy: 'outstanding', order: 'desc', metric: 'outstanding' };
  }
  if (['collectrate', 'collectionrate', '回款率', '收款率'].includes(normalized)) {
    return { toolId: 'finance.receivables', sortBy: 'collectRate', order: 'asc', metric: 'collectRate' };
  }
  if (['received', 'receipt', 'actualreceived', '已回款', '已回款金额', '到账'].includes(normalized)) {
    return { toolId: 'finance.receivables', sortBy: 'received', order: 'desc', metric: 'received' };
  }
  if (['overdue', 'overdueamount', 'risk', 'riskscore', '逾期', '账龄', '风险'].includes(normalized)) {
    return { toolId: 'finance.receivables', sortBy: 'riskScore', order: 'desc', metric: 'riskScore' };
  }
  return null;
}

function _ensureToolForLockedMetric(planResult, lockedScope, source) {
  const projects = Array.isArray(lockedScope && lockedScope.targetProjects) ? lockedScope.targetProjects : [];
  if (projects.length === 0) return;
  if (!['inherited_result_set', 'pending_clarification', 'explicit_project'].includes(source)) return;

  const spec = _metricToolSpec(lockedScope.metric);
  if (!spec) return;

  const tables = spec.toolId === 'finance.receivables'
    ? ['cashflow', 'projectMaster']
    : ['projectMaster', 'rollbackProjectActual', 'actualProject', 'budgetProject'];
  const params = _ensureTool(planResult, spec.toolId, tables);
  if (spec.sortBy && !params.sortBy) params.sortBy = spec.sortBy;
  if (spec.order && !params.order) params.order = spec.order;
  if (spec.metric && !params.metric) params.metric = spec.metric;
}

function applyLockedScopeToPlan(planResult, lockedScope) {
  if (!planResult || !lockedScope) return planResult;
  const projects = _uniq(lockedScope.targetProjects, 50);
  const source = scopeSourceForPlan(lockedScope);
  if (!planResult.query_scope || typeof planResult.query_scope !== 'object') {
    planResult.query_scope = { depts: [], subDepts: [], targetProjects: [], scopeSource: 'none' };
  }
  if (!Array.isArray(planResult.query_scope.depts)) planResult.query_scope.depts = [];
  if (!Array.isArray(planResult.query_scope.subDepts)) planResult.query_scope.subDepts = [];

  if (source === 'explicit_new_query') {
    planResult.query_scope.targetProjects = [];
    planResult.query_scope.scopeSource = 'explicit_new_query';
    return planResult;
  }

  if (projects.length > 0 && ['inherited_result_set', 'pending_clarification', 'explicit_project'].includes(source)) {
    planResult.query_scope.targetProjects = projects;
    planResult.query_scope.scopeSource = source;
    if (lockedScope.period) {
      planResult.period = lockedScope.period;
    }
    if (lockedScope.depts && lockedScope.depts.length > 0 && planResult.query_scope.depts.length === 0) {
      planResult.query_scope.depts = _uniq(lockedScope.depts, 8);
    }
    planResult.reasoning_framework = [
      planResult.reasoning_framework,
      `本轮已由 Context Resolver 锁定上一轮范围，只能在这些项目内回答：${projects.join('、')}。`,
    ].filter(Boolean).join('\n');
    _ensureToolForLockedMetric(planResult, lockedScope, source);
  }
  return planResult;
}

module.exports = {
  resolveContext,
  applyLockedScopeToPlan,
  scopeSourceForPlan,
  _detectRank,
  _isExplicitNewRangeRequest,
  _isMetricConceptQuestion,
};
