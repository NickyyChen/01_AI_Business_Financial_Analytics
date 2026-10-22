/**
 * planning-context-builder.js
 *
 * Build a compact, structured memory for the next Plan stage. This is not a
 * replacement for conversationHistory; it only keeps the entities and ranks
 * needed to resolve follow-up references such as “第一名那个项目”.
 */

const MAX_ENTITIES = 24;
const MAX_FACTS = 12;
const config = require('../../config');

function _str(v, max = 160) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function _metricObject(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const n = _num(v);
    if (n !== undefined) out[k] = n;
  }
  return out;
}

function _pushEntity(entities, entity) {
  if (!entity || !entity.name) return;
  const name = _cleanEntityName(entity.name);
  if (!_isLikelyEntityName(name, entity.type || 'project')) return;
  entities.push({
    rank: Number(entity.rank) || entities.length + 1,
    type: entity.type || 'project',
    name: _str(name, 96),
    sourceTool: entity.sourceTool || '',
    metrics: _metricObject(entity.metrics),
  });
}

function _cleanEntityName(value) {
  return String(value == null ? '' : value)
    .replace(/\*\*/g, '')
    .replace(/^[🔴🟠🟡🟢✅⚠️\s]+/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function _isLikelyEntityName(name, type = 'project') {
  const s = _str(name, 120);
  if (!s) return false;
  if (/^\d+$/.test(s)) return false;
  if (/^-?\d+(?:\.\d+)?\s*(万|元|%|人|FTE)?$/.test(s)) return false;
  if (/^(排名|项目名称|项目|客户|部门|履约收入|履约利润|利润率|履约月份|月份|已回款|未回款|回款率|金额|状态|预计回款|实际回款|数据)$/.test(s)) return false;
  if (type === 'project' && /^(合计|总计|小计|核心结论|几个看点|需要|口径说明)$/.test(s)) return false;
  return true;
}

function _rankProfitProjects(projects, question) {
  const q = String(question || '');
  const list = Array.isArray(projects) ? [...projects] : [];
  if (/收入|履约/.test(q) && !/亏损|利润最低|成本/.test(q)) {
    return list.sort((a, b) => Number(b.revenue || 0) - Number(a.revenue || 0));
  }
  if (/成本/.test(q) && !/利润率/.test(q)) {
    return list.sort((a, b) => Number(b.cost || 0) - Number(a.cost || 0));
  }
  if (/利润率|毛利率/.test(q)) {
    return list.sort((a, b) => Number(a.rate ?? a.profitRate ?? 0) - Number(b.rate ?? b.profitRate ?? 0));
  }
  if (/盈利|利润最高/.test(q) && !/亏损|最低/.test(q)) {
    return list.sort((a, b) => Number(b.profit || 0) - Number(a.profit || 0));
  }
  return list.sort((a, b) => Number(a.profit || 0) - Number(b.profit || 0));
}

function _extractFromProfitOverview(result, question) {
  const entities = [];
  const projects = _rankProfitProjects(result && result.projects, question).slice(0, MAX_ENTITIES);
  projects.forEach((p, idx) => _pushEntity(entities, {
    rank: idx + 1,
    type: 'project',
    name: p.key || p.name,
    sourceTool: 'finance.profitOverview',
    metrics: {
      revenue: p.revenue,
      cost: p.cost,
      profit: p.profit,
      profitRate: p.rate ?? p.profitRate,
      laborCost: p.laborCost,
    },
  }));
  return entities;
}

function _extractFromReceivables(result, question) {
  const q = String(question || '');
  const projects = Array.isArray(result && result.projects) ? [...result.projects] : [];
  const ranked = /未回|应收|outstanding/i.test(q)
    ? projects.sort((a, b) => Number(b.outstandingHistorical ?? b.outstanding ?? 0) - Number(a.outstandingHistorical ?? a.outstanding ?? 0))
    : projects.sort((a, b) => Number(b.overdueAmount || 0) - Number(a.overdueAmount || 0));
  return ranked.slice(0, MAX_ENTITIES).map((p, idx) => ({
    rank: idx + 1,
    type: 'project',
    name: p.name,
    sourceTool: 'finance.receivables',
    metrics: {
      overdueAmount: p.overdueAmount,
      overdueCount: p.overdueCount,
      outstanding: p.outstandingHistorical ?? p.outstanding,
      received: p.receivedHistorical ?? p.received,
      collectRate: p.collectRate,
      riskScore: p.riskScore,
    },
})).filter(e => e.name);
}

function _extractDisplayResultSet(results) {
  for (const [toolId, result] of Object.entries(results || {})) {
    const set = result && result.displayResultSet;
    const rows = Array.isArray(set && set.rows) ? set.rows : [];
    if (rows.length === 0) continue;
    return {
      type: _str(set.type || '', 80),
      toolId: _str(set.toolId || toolId, 80),
      sortBy: _str(set.sortBy || '', 40),
      order: _str(set.order || '', 10),
      metric: _str(set.metric || '', 40),
      top: Number(set.top) || rows.length,
      rows: rows.slice(0, MAX_ENTITIES).map((row, idx) => ({
        ...row,
        rank: Number(row.rank) || idx + 1,
        type: row.type || 'project',
        name: _str(row.name || row.key || row.project || '', 120),
      })).filter(row => row.name),
    };
  }
  return null;
}

function _extractFromDisplayResultSet(displayResultSet) {
  const entities = [];
  const rows = Array.isArray(displayResultSet && displayResultSet.rows) ? displayResultSet.rows : [];
  rows.slice(0, MAX_ENTITIES).forEach((row, idx) => _pushEntity(entities, {
    rank: Number(row.rank) || idx + 1,
    type: row.type || 'project',
    name: row.name || row.key || row.project,
    sourceTool: displayResultSet.toolId || row.sourceTool || '',
    metrics: row,
  }));
  return entities;
}

function _extractFromCustomerAnalysis(result) {
  const entities = [];
  const customers = Array.isArray(result && result.allCustomers)
    ? result.allCustomers
    : (Array.isArray(result && result.topCustomers) ? result.topCustomers : []);
  customers.slice(0, MAX_ENTITIES).forEach((c, idx) => _pushEntity(entities, {
    rank: idx + 1,
    type: 'customer',
    name: c.name || c.customer,
    sourceTool: 'customer.analysis',
    metrics: {
      totalAmount: c.totalAmount ?? c.amount,
      projectCount: c.projectCount,
      activeCount: c.activeCount,
    },
  }));

  if (entities.length < MAX_ENTITIES && Array.isArray(result && result.serviceProjects)) {
    result.serviceProjects.slice(0, MAX_ENTITIES - entities.length).forEach((p, idx) => _pushEntity(entities, {
      rank: idx + 1,
      type: 'project',
      name: p.name,
      sourceTool: 'customer.analysis',
      metrics: {
        amount: p.amount,
      },
    }));
  }
  return entities;
}

function _extractFromLaborCost(result) {
  const entities = [];
  const lines = Array.isArray(result && result.topProjectsByManpower) ? result.topProjectsByManpower : [];
  for (const [idx, line] of lines.slice(0, MAX_ENTITIES).entries()) {
    const clean = String(line || '').replace(/^\s*\d+[.、]\s*/, '');
    const withoutTag = clean.replace(/^\[[^\]]+\]\s*/, '');
    const name = (withoutTag.split(/[：:]/)[0] || '').trim();
    if (!name) continue;
    _pushEntity(entities, {
      rank: idx + 1,
      type: 'project',
      name,
      sourceTool: 'finance.laborCost',
      metrics: {},
    });
  }
  return entities;
}

function _extractFromBudgetComparison(result) {
  const entities = [];
  const byProject = Array.isArray(result && result.byProject) ? result.byProject : [];
  const byDept = Array.isArray(result && result.byDept) ? result.byDept : [];
  byProject.slice(0, MAX_ENTITIES).forEach((p, idx) => _pushEntity(entities, {
    rank: idx + 1,
    type: 'project',
    name: p.project || p.name,
    sourceTool: 'finance.budgetComparison',
    metrics: {
      budgetRevenue: p.budgetRevenue,
      actualRevenue: p.actualRevenue,
      deviationRate: p.deviationRate,
      revenueDevRate: p.revenueDevRate,
    },
  }));
  if (entities.length === 0) {
    byDept.slice(0, MAX_ENTITIES).forEach((d, idx) => _pushEntity(entities, {
      rank: idx + 1,
      type: 'dept',
      name: d.dept || d.name,
      sourceTool: 'finance.budgetComparison',
      metrics: {
        budgetRevenue: d.budgetRevenue,
        actualRevenue: d.actualRevenue,
        deviationRate: d.deviationRate,
        revenueDevRate: d.revenueDevRate,
      },
    }));
  }
  return entities;
}

function extractEntitiesFromText(text, question = '') {
  const entities = [];
  const type = /客户/.test(question) ? 'customer' : (/部门|行业群|中心|事业部/.test(question) ? 'dept' : 'project');
  const lines = String(text || '').split(/\r?\n/);

  for (const line of lines) {
    if (entities.length >= MAX_ENTITIES) break;
    const m = line.match(/^\s*(\d+)[.、]\s*([^：:|（(，,]+)(?:[：:|（(，,]|$)/);
    if (m) {
      _pushEntity(entities, {
        rank: Number(m[1]),
        type,
        name: m[2],
        sourceTool: 'assistant.reply',
        metrics: {},
      });
    }
  }

  if (entities.length < MAX_ENTITIES) {
    const tableRows = lines.filter(line => /^\s*\|.*\|\s*$/.test(line) && !/^\s*\|\s*-+/.test(line));
    const header = tableRows[0] || '';
    const headerCells = header.split('|')
      .map(s => s.trim())
      .filter((_, i, arr) => !(i === 0 || i === arr.length - 1));
    const nameCol = headerCells.findIndex(h => /项目|客户|部门|行业群|名称/.test(h));
    if (nameCol >= 0) {
      for (const [idx, row] of tableRows.slice(1).entries()) {
        if (entities.length >= MAX_ENTITIES) break;
        const cells = row.split('|').map(s => s.trim()).filter((_, i, arr) => !(i === 0 || i === arr.length - 1));
        const name = cells[nameCol];
        if (name && !/^[-:]+$/.test(name)) {
          _pushEntity(entities, {
            rank: idx + 1,
            type,
            name,
            sourceTool: 'assistant.reply.table',
            metrics: {},
          });
        }
      }
    }
  }

  return _dedupeEntities(entities);
}

function _dedupeEntities(entities) {
  const seen = new Set();
  const out = [];
  for (const e of entities || []) {
    if (!e || !e.name) continue;
    const key = `${e.type || ''}::${e.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...e, rank: out.length + 1 });
    if (out.length >= MAX_ENTITIES) break;
  }
  return out;
}

function _buildFacts(results) {
  const facts = [];
  for (const [toolId, result] of Object.entries(results || {})) {
    const sheet = Array.isArray(result && result._factSheet)
      ? result._factSheet
      : (Array.isArray(result && result.factSheet) ? result.factSheet : []);
    for (const line of sheet.slice(0, 4)) {
      facts.push({ sourceTool: toolId, text: _str(line, 220) });
      if (facts.length >= MAX_FACTS) return facts;
    }
  }
  return facts;
}

function _inferTopicKeyword(message, entities) {
  const q = String(message || '');
  const explicit = q.match(/带有\s*["“”']?([^"“”'\s，,。]+)\s*["“”']?\s*字样/)
    || q.match(/([A-Za-z0-9\u4e00-\u9fa5]{2,20})(?:相关|系|项目)/);
  if (explicit && explicit[1]) return _str(explicit[1], 80);
  for (const token of ['华为', '安踏', 'PUMA', 'puma', '农本方', '安德玛']) {
    if (q.includes(token)) return token === 'puma' ? 'PUMA' : token;
  }
  const firstEntity = (entities || []).find(e => e && e.name);
  if (firstEntity) {
    const name = String(firstEntity.name || '');
    const prefix = name.split(/[-—_]/)[0];
    if (prefix && prefix.length <= 12) return _str(prefix, 80);
  }
  return '';
}

function _inferMetric(message, toolIds) {
  const q = String(message || '');
  if (/实际收款|实际收到|到账|回款|收款/.test(q)) return 'actual_receipts';
  if (/未回款|应收|逾期/.test(q)) return 'receivables';
  if (/履约金额|履约收入|履约/.test(q)) return 'delivery_revenue';
  if (/利润率/.test(q)) return 'profit_rate';
  if (/利润/.test(q)) return 'profit';
  if ((toolIds || []).includes('finance.receivables')) return 'receivables';
  if ((toolIds || []).includes('finance.profitOverview')) return 'profit_overview';
  return '';
}

function _inferResultSetType(toolIds, metric) {
  if ((toolIds || []).includes('finance.receivables')) return 'invoice.receipts';
  if ((toolIds || []).includes('finance.profitOverview')) return 'finance.projectMetrics';
  if ((toolIds || []).includes('finance.budgetQuery')) return 'budget.query';
  if (metric === 'actual_receipts' || metric === 'receivables') return 'invoice.receipts';
  return '';
}

function _buildQueryState({ message, planResult, results, entities, visibleEntities, facts, displayResultSet = null }) {
  const tools = Object.keys(results || {});
  const metric = _inferMetric(message, tools);
  const resultSetType = _inferResultSetType(tools, metric);
  const topicKeyword = _inferTopicKeyword(message, entities);
  const visibleProjects = (visibleEntities || [])
    .filter(e => e && e.type === 'project' && e.name)
    .slice(0, 12)
    .map(e => e.name);
  const queryScopeProjects = Array.isArray(planResult?.query_scope?.targetProjects)
    ? planResult.query_scope.targetProjects.map(p => _str(p, 120)).filter(Boolean).slice(0, 20)
    : [];
  const queryScopeSource = planResult?.query_scope?.scopeSource || '';
  const shouldTrustQueryScopeProjects = queryScopeProjects.length > 0
    && ['inherited_result_set', 'pending_clarification', 'explicit_project'].includes(queryScopeSource);
  const displayProjects = Array.isArray(displayResultSet && displayResultSet.rows)
    ? displayResultSet.rows.map(row => _str(row.name || row.key || row.project, 120)).filter(Boolean)
    : [];
  const sourceProjects = displayProjects.length > 0
    ? displayProjects
    : shouldTrustQueryScopeProjects ? queryScopeProjects : (visibleProjects.length > 0 ? visibleProjects : (entities || [])
    .filter(e => e && e.type === 'project' && e.name)
    .slice(0, 12)
    .map(e => e.name));
  const targetProjects = [...new Set(sourceProjects)];
  const state = {
    topicKeyword,
    targetProjects,
    dept: Array.isArray(planResult?.query_scope?.depts) && planResult.query_scope.depts.length > 0
      ? _str(planResult.query_scope.depts[0], 80)
      : '',
    scopeSource: planResult?.query_scope?.scopeSource || '',
    period: planResult && planResult.period ? _str(planResult.period, 40) : '',
    metric,
    resultSetType,
    sourceTools: tools,
    sourceTables: Array.isArray(planResult && planResult.tables_needed) ? planResult.tables_needed.slice(0, 12) : [],
    lastAnswerFields: [],
    availableTransforms: [],
    facts: (facts || []).slice(0, 4),
  };
  if (displayResultSet && displayProjects.length > 0) {
    state.displayResultSet = {
      ...displayResultSet,
      rows: displayResultSet.rows.slice(0, MAX_ENTITIES),
    };
  }
  if (resultSetType === 'invoice.receipts') {
    state.lastAnswerFields = ['项目', '履约月份', '实际回款时间', '实际收款', '未回款金额', '回款率'];
    state.availableTransforms = ['按履约月份展开', '按实际到账日展开', '按项目汇总', '解释未回款口径', '核对待认领款'];
  } else if (resultSetType === 'finance.projectMetrics') {
    state.lastAnswerFields = ['项目', '履约收入', '履约成本', '履约利润', '利润率'];
    state.availableTransforms = ['按项目展开', '按月份展开', '解释利润率口径'];
  }
  if (!state.topicKeyword && targetProjects.length === 0 && !state.metric && !state.resultSetType) return null;
  return state;
}

function buildPlanningContext({ message = '', planResult = null, toolResults = null, reply = '', userName = '', role = '' } = {}) {
  const results = toolResults && toolResults.results ? toolResults.results : {};
  const entities = [];
  const replyEntities = reply ? extractEntitiesFromText(reply, message) : [];
  const displayResultSet = config.DISPLAY_RESULT_SET_CONTEXT_ENABLED
    ? _extractDisplayResultSet(results)
    : null;
  if (displayResultSet) {
    entities.push(..._extractFromDisplayResultSet(displayResultSet));
  }
  for (const [toolId, result] of Object.entries(results)) {
    if (!result || typeof result !== 'object' || result.empty || result.incomplete) continue;
    if (toolId === 'finance.profitOverview') entities.push(..._extractFromProfitOverview(result, message));
    else if (toolId === 'finance.receivables') entities.push(..._extractFromReceivables(result, message));
    else if (toolId === 'customer.analysis') entities.push(..._extractFromCustomerAnalysis(result, message));
    else if (toolId === 'finance.laborCost') entities.push(..._extractFromLaborCost(result));
    else if (toolId === 'finance.budgetComparison') entities.push(..._extractFromBudgetComparison(result));
  }

  if (entities.length === 0 && replyEntities.length > 0) {
    entities.push(...replyEntities);
  }

  const deduped = _dedupeEntities(entities);
  const facts = _buildFacts(results);
  const visibleDeduped = _dedupeEntities(replyEntities);
  const queryState = _buildQueryState({ message, planResult, results, entities: deduped, visibleEntities: visibleDeduped, facts, displayResultSet });
  if (deduped.length === 0 && facts.length === 0 && Object.keys(results).length === 0) return null;

  return {
    version: 1,
    createdAt: Date.now(),
    userName: _str(userName, 60),
    role: _str(role, 30),
    question: _str(message, 180),
    period: planResult && planResult.period ? _str(planResult.period, 40) : '',
    intent: planResult && (planResult.intent || planResult._shortcutIntent) ? _str(planResult.intent || planResult._shortcutIntent, 80) : '',
    tools: Object.keys(results),
    tables: Array.isArray(planResult && planResult.tables_needed) ? planResult.tables_needed.slice(0, 16) : [],
    entities: deduped,
    facts,
    queryState,
  };
}

function trimPlanningContext(contexts, opts = {}) {
  const maxTurns = opts.maxTurns || 3;
  return (Array.isArray(contexts) ? contexts : [])
    .filter(Boolean)
    .slice(-maxTurns)
    .map(ctx => ({
      ...ctx,
      question: _str(ctx.question, 180),
      tools: Array.isArray(ctx.tools) ? ctx.tools.slice(0, 8) : [],
      tables: Array.isArray(ctx.tables) ? ctx.tables.slice(0, 12) : [],
      entities: Array.isArray(ctx.entities) ? ctx.entities.slice(0, MAX_ENTITIES) : [],
      facts: Array.isArray(ctx.facts) ? ctx.facts.slice(0, MAX_FACTS) : [],
      queryState: ctx.queryState || null,
    }));
}

function formatPlanningContextForPlanner(contexts) {
  const trimmed = trimPlanningContext(contexts);
  if (trimmed.length === 0) return '';

  const lines = ['=== 最近计划记忆（仅用于解析追问指代，不可替代本次工具计算）==='];
  trimmed.forEach((ctx, ctxIdx) => {
    lines.push(`第${ctxIdx + 1}段：${ctx.question || '(无问题)'}${ctx.period ? `；口径=${ctx.period}` : ''}${ctx.tools && ctx.tools.length ? `；工具=${ctx.tools.join(',')}` : ''}`);
    if (Array.isArray(ctx.entities) && ctx.entities.length > 0) {
      const entityText = ctx.entities.slice(0, 12)
        .map(e => `${e.rank}.${e.type || 'entity'}:${e.name}`)
        .join('；');
      lines.push(`实体排序：${entityText}`);
    }
    if (Array.isArray(ctx.facts) && ctx.facts.length > 0) {
      lines.push(`关键事实：${ctx.facts.slice(0, 3).map(f => f.text).join('；')}`);
    }
    if (ctx.queryState) {
      const qs = ctx.queryState;
      const projectText = Array.isArray(qs.targetProjects) && qs.targetProjects.length
        ? `；项目集=${qs.targetProjects.slice(0, 8).join('、')}`
        : '';
      const displayText = qs.displayResultSet && Array.isArray(qs.displayResultSet.rows)
        ? `；displayRows=${qs.displayResultSet.rows.length}`
        : '';
      lines.push(`上一轮查询状态：topic=${qs.topicKeyword || ''}；metric=${qs.metric || ''}；resultSet=${qs.resultSetType || ''}${projectText}${displayText}`);
    }
  });
  lines.push('规则：当用户说“第一名/第二个/那个项目/该客户”等追问时，优先用上述实体排序解析；解析后仍必须按本次问题重新规划和取数。');
  return lines.join('\n');
}

module.exports = {
  buildPlanningContext,
  trimPlanningContext,
  formatPlanningContextForPlanner,
  extractEntitiesFromText,
};
