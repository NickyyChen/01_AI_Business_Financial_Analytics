/**
 * analytics-tools.js - 分析类工具
 *
 * 从 completion-rate-skill 提取的纯计算逻辑。
 * 完成率、人效分析。
 */

const riskEngine = require('../engines/risk-engine');
const { parseMonth4 } = require('../utils/field-mapping');
const projectScope = require('./project-scope-utils');

const BOOKED_ACTUAL_KEYWORDS = ['实际入账', '入账口径', '入账', '账面', '按入账', '未回滚', '不回滚', '原始实际'];
const ALLOCATED_PROFIT_KEYWORDS = ['分摊后项目利润', '分摊后项目净利润', '扣除管理赋能', '项目分摊', '净贡献'];

const PROJECT_MASTER_SCOPE_FIELDS = [
  '26年项目名称',
  '项目名称（管报）',
  '25年项目名称',
  '项目名称',
  ...projectScope.DEFAULT_PROJECT_CANDIDATES,
];

function _questionText(scope) {
  return String((scope && (scope.question || scope.message || scope.userQuestion || scope.query)) || '');
}

function _resolveActualCaliber(scope) {
  if (scope && (scope.actualCaliber === 'booked' || scope.actualCaliber === 'rollback')) return scope.actualCaliber;
  const q = _questionText(scope);
  return BOOKED_ACTUAL_KEYWORDS.some((kw) => q.includes(kw)) ? 'booked' : 'rollback';
}

function _resolveProfitView(scope) {
  if (scope && (scope.profitView === 'allocated' || scope.profitView === 'fulfillment')) return scope.profitView;
  const q = _questionText(scope);
  return ALLOCATED_PROFIT_KEYWORDS.some((kw) => q.includes(kw)) ? 'allocated' : 'fulfillment';
}

function _raw(row) {
  return (row && row.fields) || row || {};
}

function _first(fields, names) {
  for (const name of names) {
    if (fields[name] != null && fields[name] !== '') return fields[name];
  }
  return null;
}

function _num(fields, names) {
  const value = _first(fields, names);
  if (value == null) return null;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function _text(fields, names) {
  const value = _first(fields, names);
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item && typeof item === 'object') return item.text || item.name || item.value || '';
      return String(item);
    }).filter(Boolean).join('、');
  }
  if (typeof value === 'object') return value.text || value.name || value.value || '';
  return String(value).trim();
}

function _ym(value) {
  const s = String(value || '').replace(/[^0-9]/g, '');
  if (s.length >= 6) return Number(s.slice(-4));
  if (s.length === 4) return Number(s);
  return value;
}

function _normalizeRollbackRow(row, scope) {
  const f = _raw(row);
  const revenue = _num(f, ['履约收入', '回滚履约收入']) ?? 0;
  const cost = _num(f, ['履约成本', '回滚履约成本']) ?? 0;
  const fulfillmentProfit = _num(f, ['履约利润', '回滚履约利润']) ?? (revenue - cost);
  const allocatedProfit = _num(f, ['分摊后项目净利润']);
  const profit = _resolveProfitView(scope) === 'allocated'
    ? (allocatedProfit ?? 0)
    : fulfillmentProfit;
  return {
    fields: {
      是否交付项目: _text(f, ['是否交付项目', '项目名', '项目名称', '项目名称（管报）', '项目']),
      月份: _ym(_first(f, ['月份', '回滚月份', '年月'])),
      一级部门: _text(f, ['一级部门', '部门', '所属部门']),
      项目状态: _text(f, ['项目状态', '状态']),
      履约收入: revenue,
      履约成本: cost,
      履约利润: profit,
      人力成本: _num(f, ['人力成本', '入账人力成本']) ?? 0,
    },
  };
}

function _projectRows(memory, scope) {
  if (
    _resolveActualCaliber(scope) === 'rollback'
    && Array.isArray(memory.rollbackProjectActual)
    && memory.rollbackProjectActual.length > 0
  ) {
    return memory.rollbackProjectActual.map((row) => _normalizeRollbackRow(row, scope));
  }
  return memory.projectMonthly || memory.actualProject || [];
}

function _filterProjectRows(records, scope) {
  return projectScope.filterRecordsByProjectScope(records, scope, projectScope.DEFAULT_PROJECT_CANDIDATES);
}

function _filterProjectMasterRows(records, scope) {
  return projectScope.filterRecordsByProjectScope(records, scope, PROJECT_MASTER_SCOPE_FIELDS);
}

function _filterWorktimeRows(records, scope) {
  return projectScope.filterRecordsByProjectScope(records, scope, projectScope.WORKTIME_PROJECT_CANDIDATES);
}

function _withProjectScopeFilteredMemory(memory, scope) {
  const src = memory || {};
  if (!projectScope.shouldApplyProjectScope(scope)) return src;
  return {
    ...src,
    rollbackProjectActual: _filterProjectRows(src.rollbackProjectActual, scope),
    projectMonthly: _filterProjectRows(src.projectMonthly, scope),
    actualProject: _filterProjectRows(src.actualProject, scope),
    performanceTargets: _filterProjectRows(src.performanceTargets, scope),
    budgetProject: _filterProjectRows(src.budgetProject, scope),
    projectMaster: _filterProjectMasterRows(src.projectMaster, scope),
    projectStaffing: _filterWorktimeRows(src.projectStaffing, scope),
    projectTeamStaffing: _filterWorktimeRows(src.projectTeamStaffing, scope),
  };
}

function _buildScopeLabel(scope) {
  const projects = Array.isArray(scope && scope._queryProjectNames)
    ? scope._queryProjectNames.filter(Boolean)
    : [];
  if (projects.length === 1) return `项目/成本池：${projects[0]}`;
  if (projects.length > 1) return `项目/成本池合集（${projects.length}个项目/成本池）`;
  if (scope && scope.isGlobal) return '全公司';
  const depts = Array.isArray(scope && scope.depts) ? scope.depts.filter(Boolean) : [];
  if (depts.length === 1) return depts[0];
  if (depts.length > 1) return `${depts.join(' + ')}（${depts.length} 个部门合计）`;
  return '(未知)';
}

// ==================== C1. 完成率 + 人效分析 ====================

function completion(memory, scope) {
  const rawMemory = memory || {};
  const rawProjectRows = _projectRows(rawMemory, scope);
  memory = _withProjectScopeFilteredMemory(rawMemory, scope);
  const projectRows = _projectRows(memory, scope);
  const projectScopeGuard = projectScope.projectScopeGuard(scope, rawProjectRows.length, projectRows.length);
  const periodOpts = _buildPeriodOpts(scope);
  // 2026-04-17 修复：FTE 应基于团队全量（与 finance-tools 一致），而非仅本人
  const personal = memory.projectStaffing || [];
  const team     = memory.projectTeamStaffing || [];
  const staffing = team.length > 0 ? _mergeStaffing(personal, team) : personal;
  const metrics = riskEngine.extractMetrics(
    projectRows,
    memory.performanceTargets || [],
    memory.projectMaster || [],
    memory.profile,
    staffing,
    periodOpts,
  );

  const projRates = metrics['_projectProfitRates'] || {};
  const projFTE = metrics['_projectFTE'] || {};
  const projEfficiencies = metrics['_projectEfficiencies'] || {};

  const projectList = Object.entries(projRates).map(([key, s]) => {
    const fte = projFTE[key] || 0;
    const efficiency = projEfficiencies[key] || 0;
    return {
      key,
      revenue: s.revenue,
      cost: s.cost,
      profit: s.profit,
      profitRate: s.rate,
      fte,
      perCapitaRevenue: efficiency,
      efficiencyLevel: efficiency >= 20000 ? 'good' : efficiency >= 10000 ? 'warning' : 'critical',
    };
  });

  const completionData = {
    revenueCompletion: metrics['收入完成率'] ?? null,
    profitCompletion: metrics['利润完成率'] ?? null,
    targetRevenue: metrics['目标收入'] || 0,
    targetProfit: metrics['目标利润'] || 0,
    actualRevenue: metrics['实际收入'] || metrics['履约收入'] || 0,
    actualProfit: metrics['实际利润'] || metrics['履约利润'] || 0,
  };

  const revenueGap = completionData.actualRevenue - completionData.targetRevenue;
  const profitGap = completionData.actualProfit - completionData.targetProfit;

  const efficiencyData = {
    totalFTE: metrics['当月总FTE'] || 0,
    perCapitaRevenue: metrics['人均创收'] ?? null,
    perCapitaCost: metrics['FTE人均成本'] ?? null,
    lowEfficiencyProjects: projectList
      .filter(p => p.efficiencyLevel === 'critical')
      .sort((a, b) => a.perCapitaRevenue - b.perCapitaRevenue),
  };

  // P1-1 修复：summary.profitRate 直接由 履约收入/利润 聚合计算，不再依赖 metrics['利润率']
  // 原因：metrics['利润率'] 在某些 period 分支下分母可能被截断，导致 CEO 全局场景出现 4186% 异常值。
  // 同时加防御性 clamp：超过 ±500% 视为数据异常，置 null 并打 warn。
  const totalRevenue = metrics['履约收入'] || 0;
  const totalCost    = metrics['履约成本'] || 0;
  const totalProfit  = metrics['履约利润'] || 0;
  let summaryProfitRate = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : null;
  if (summaryProfitRate != null && Math.abs(summaryProfitRate) > 500) {
    try {
      const logger = require('../utils/logger');
      logger.warn(`[analytics.completion] 利润率异常 ${summaryProfitRate.toFixed(2)}% | rev=${totalRevenue} profit=${totalProfit}, 已 clamp 为 null`);
    } catch (_) { /* ignore logger init issues */ }
    summaryProfitRate = null;
  }

  return {
    completion: {
      ...completionData,
      revenueGap,
      profitGap,
      revenueOnTrack: revenueGap >= 0,
      profitOnTrack: profitGap >= 0,
    },
    efficiency: efficiencyData,
    projects: projectList.sort((a, b) => b.revenue - a.revenue),
    summary: {
      totalRevenue,
      totalCost,
      totalProfit,
      profitRate: summaryProfitRate,
      projectCount: Object.keys(projRates).length,
    },
    actualCaliber: _resolveActualCaliber(scope),
    profitView: _resolveProfitView(scope),
    _sourceTable: `${_resolveActualCaliber(scope) === 'rollback' && Array.isArray(memory.rollbackProjectActual) && memory.rollbackProjectActual.length > 0 ? 'ROLLBACK_PROJECT_ACTUAL（项目层-回滚实际）' : 'ACTUAL_PROJECT（实际：项目层，实际入账口径）'} + BUDGET_PROJECT（预算：项目层）+ ACTUAL_WORKTIME（实际：26年工时）`,
    _periodLabel: _buildPeriodLabel(projectRows, periodOpts),
    _scopeGuard: projectScopeGuard,
    _scopeLabel: _buildScopeLabel(scope),
    _glossary: {
      '投入人力': '即工时折算的全职人力当量；1.0 表示一名员工 100% 精力投入；0.5 表示半个月人力',
      '人均月创收': '总营收 ÷ 投入人力',
    },
  };
}

function _buildPeriodOpts(scope) {
  const fallback = { period: 'ytd', periodYear: new Date().getFullYear() };
  if (!scope || !scope.period || scope.period === 'latest') return fallback;
  const p = scope.period;
  if (p === 'ytd') return { period: 'ytd', periodYear: scope.periodYear || fallback.periodYear };
  if (typeof p === 'object' && p.year) return { period: p };
  return fallback;
}

function _buildPeriodLabel(projectMonthly, periodOpts) {
  const period = periodOpts.period;
  if (typeof period === 'object' && period.year && period.month) {
    return `${period.year}年${period.month}月（单月口径）`;
  }
  if (period === 'ytd') {
    const year = periodOpts.periodYear || new Date().getFullYear();
    let maxMonth = 0, minMonth = 13;
    for (const r of (projectMonthly || [])) {
      const f = r.fields || {};
      const { year: yr, month: mo } = parseMonth4(f['月份']);
      if (yr === year && mo > 0) {
        if (mo > maxMonth) maxMonth = mo;
        if (mo < minMonth) minMonth = mo;
      }
    }
    if (maxMonth === 0) return `${year}年（年初至今累计）`;
    if (minMonth === maxMonth) return `${year}年${maxMonth}月（单月口径）`;
    return `${year}年${minMonth}-${maxMonth}月累计（年初至今）`;
  }
  return '当前最新月（单月口径）';
}

function _mergeStaffing(personal, team) {
  const seen = new Set();
  const merged = [];
  for (const r of team) {
    const id = r.record_id || r.id;
    if (id) seen.add(id);
    merged.push(r);
  }
  for (const r of personal) {
    const id = r.record_id || r.id;
    if (id && seen.has(id)) continue;
    merged.push(r);
  }
  return merged;
}

module.exports = { completion };
