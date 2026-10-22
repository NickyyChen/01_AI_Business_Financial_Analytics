const FM = require('../utils/field-mapping');
const projectScope = require('./project-scope-utils');

const ROLLBACK_PROJECT_FIELDS = {
  project: ['项目名', '项目名称', '项目', '是否交付项目'],
  month: ['回滚月份', '月份'],
  dept: ['一级部门', '部门', '归属一级部门'],
  revenue: ['履约收入'],
  cost: ['履约成本'],
  profit: ['履约利润'],
  managementEnablement: ['部门管理赋能'],
  allocationRatio: ['分摊比例'],
  projectAllocation: ['项目分摊'],
  allocatedNetProfit: ['分摊后项目净利润'],
};

const PROJECT_SCOPE_FIELDS = [
  FM.ACTUAL_PROJECT_FIELDS.PROJECT_NAME,
  ...projectScope.DEFAULT_PROJECT_CANDIDATES,
];

const ALLOCATED_PROFIT_KEYWORDS = [
  '分摊后',
  '分摊后的项目利润',
  '分摊后项目净利润',
  '扣除管理赋能',
  '扣除项目分摊',
  '项目分摊后',
  '净贡献',
];

function _resolveProfitView(scope) {
  if (scope && (scope.profitView === 'allocated' || scope.profitView === 'fulfillment')) {
    return scope.profitView;
  }
  const q = String((scope && (scope.question || scope.rawQuestion)) || '');
  return ALLOCATED_PROFIT_KEYWORDS.some((kw) => q.includes(kw)) ? 'allocated' : 'fulfillment';
}

function _selectedRollbackProfit(item, scope) {
  return _resolveProfitView(scope) === 'allocated'
    ? (item.allocatedNetProfit == null ? 0 : item.allocatedNetProfit)
    : item.profit;
}

const COMPANY_ROLLBACK_FIELDS = {
  month: ['月份', '回滚月份'],
  revenueCurrent: ['26年履约收入', '本年履约收入'],
  revenuePrevious: ['25年履约收入.', '25年履约收入', '上年履约收入'],
  revenueGap: ['履约收入同比增长额'],
  revenueRate: ['履约收入同比增长率'],
  profitCurrent: ['26年履约利润', '本年履约利润'],
  profitPrevious: ['25年履约利润', '上年履约利润'],
  profitGap: ['履约利润同比增长额'],
  profitRate: ['履约利润同比增长率'],
};

function _lookup(fields, names) {
  if (!fields || !Array.isArray(names)) return undefined;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(fields, name) && fields[name] !== undefined && fields[name] !== null && fields[name] !== '') {
      return fields[name];
    }
  }
  return undefined;
}

function _text(fields, names) {
  const raw = _lookup(fields, names);
  if (raw == null) return '';
  if (Array.isArray(raw)) return FM.lookupFirst(raw).trim();
  if (typeof raw === 'object') return String(raw.text || raw.name || raw.value || '').trim();
  return String(raw).trim();
}

function _recordForProjectName(project) {
  return { fields: { 项目名: project, 项目名称: project, 是否交付项目: project } };
}

function _filterProjectRows(records, scope) {
  return projectScope.filterRecordsByProjectScope(records, scope, PROJECT_SCOPE_FIELDS);
}

function _filterNormalizedProjectItems(items, scope) {
  const rows = Array.isArray(items) ? items : [];
  if (!projectScope.shouldApplyProjectScope(scope)) return rows;
  return rows.filter(item => projectScope.recordMatchesProjectScope(_recordForProjectName(item && item.project), scope, PROJECT_SCOPE_FIELDS));
}

function _scopeLabel(scope, fallback = '当前可见范围') {
  const projects = Array.isArray(scope && scope._queryProjectNames)
    ? scope._queryProjectNames.filter(Boolean)
    : [];
  if (projects.length === 1) return `项目/成本池：${projects[0]}`;
  if (projects.length > 1) return `项目/成本池合集（${projects.length}个项目/成本池）`;
  if (scope && scope.isGlobal) return '全公司';
  const depts = Array.isArray(scope && scope.depts) ? scope.depts.filter(Boolean) : [];
  if (depts.length > 0) return depts.join(' + ');
  return fallback;
}

function _number(fields, names) {
  const raw = _lookup(fields, names);
  if (raw == null || raw === '') return 0;
  const num = Number(raw);
  return Number.isFinite(num) ? num : 0;
}

function _parseRate(raw) {
  if (raw == null || raw === '') return null;
  const str = String(raw).trim();
  if (!str) return null;
  const cleaned = str.replace(/%/g, '');
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return null;
  return str.includes('%') ? num : (Math.abs(num) <= 1 ? +(num * 100).toFixed(1) : +num.toFixed(1));
}

function _rateFromFields(fields, names) {
  const raw = _lookup(fields, names);
  return _parseRate(raw);
}

function _parseYm(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 1 || digits.length === 2) {
    const month = Number(digits);
    if (month >= 1 && month <= 12) return new Date().getFullYear() * 100 + month;
  }
  if (digits.length >= 5 && /^20\d{2}\d{1,2}$/.test(digits)) {
    const year = Number(digits.slice(0, 4));
    const month = Number(digits.slice(4));
    if (month >= 1 && month <= 12) return year * 100 + month;
  }
  if (digits.length === 4 || digits.length === 6) {
    const parsed = FM.parseMonth4(digits);
    if (parsed.year && parsed.month) return parsed.year * 100 + parsed.month;
  }
  return 0;
}

function _ymLabel(ym) {
  if (!ym) return '未知月份';
  const year = Math.floor(ym / 100);
  const month = ym % 100;
  return `${year}年${month}月`;
}

function _currentYm() {
  const now = new Date();
  return now.getFullYear() * 100 + (now.getMonth() + 1);
}

function _previousYm(ym) {
  const year = Math.floor(ym / 100);
  const month = ym % 100;
  return (year - 1) * 100 + month;
}

function _defaultCutoffYm(scope) {
  const current = _currentYm();
  if (scope && scope.period === 'current') return current;
  const year = Math.floor(current / 100);
  const month = current % 100;
  return month === 1 ? (year - 1) * 100 + 12 : year * 100 + (month - 1);
}

function _parseExplicitMonthPeriod(period) {
  const raw = String(period || '').trim().toLowerCase();
  if (!raw) return 0;
  let match = raw.match(/^(\d{4})$/);
  if (match) {
    const parsed = FM.parseMonth4(match[1]);
    return parsed.year && parsed.month >= 1 && parsed.month <= 12 ? parsed.year * 100 + parsed.month : 0;
  }
  match = raw.match(/^(20\d{2})[-/](\d{1,2})$/);
  if (match) return Number(match[1]) * 100 + Number(match[2]);
  match = raw.match(/^(20\d{2})(\d{2})$/);
  if (match) return Number(match[1]) * 100 + Number(match[2]);
  return 0;
}

function _parseQuarterPeriod(period) {
  const raw = String(period || '').trim().toLowerCase();
  const match = raw.match(/^(20\d{2})-?q([1-4])$/);
  if (!match) return null;
  const year = Number(match[1]);
  const quarter = Number(match[2]);
  const startMonth = (quarter - 1) * 3 + 1;
  return {
    year,
    quarter,
    startYm: year * 100 + startMonth,
    endYm: year * 100 + (startMonth + 2),
  };
}

function _uniqueSortedMonths(months) {
  return [...new Set((months || []).filter(Boolean))].sort((a, b) => a - b);
}

function _selectComparisonWindow(scope, months) {
  const availableMonths = _uniqueSortedMonths(months);
  if (availableMonths.length === 0) return null;

  const cutoffYm = _defaultCutoffYm(scope);
  const cutoffMonths = availableMonths.filter((ym) => ym <= cutoffYm);
  const latestSource = cutoffMonths.length > 0 ? cutoffMonths : availableMonths;
  const latestYm = latestSource[latestSource.length - 1];
  const explicitMonth = _parseExplicitMonthPeriod(scope && scope.period);
  const quarter = _parseQuarterPeriod(scope && scope.period);
  const rawPeriod = String((scope && scope.period) || '').trim().toLowerCase();

  if (explicitMonth) {
    return {
      mode: 'month',
      currentMonths: [explicitMonth],
      previousMonths: [_previousYm(explicitMonth)],
      label: `${_ymLabel(explicitMonth)} 同比 ${_ymLabel(_previousYm(explicitMonth))}`,
      anchorYm: explicitMonth,
    };
  }

  if (quarter) {
    const currentMonths = [];
    for (let month = quarter.startYm % 100; month <= quarter.endYm % 100; month += 1) {
      currentMonths.push(quarter.year * 100 + month);
    }
    return {
      mode: 'quarter',
      currentMonths,
      previousMonths: currentMonths.map(_previousYm),
      label: `${quarter.year}年Q${quarter.quarter} 同比`,
      anchorYm: currentMonths[currentMonths.length - 1],
    };
  }

  if (rawPeriod === 'ytd' || /^20\d{2}$/.test(rawPeriod)) {
    const targetYear = /^20\d{2}$/.test(rawPeriod) ? Number(rawPeriod) : Math.floor(latestYm / 100);
    const endMonth = targetYear === Math.floor(latestYm / 100)
      ? (latestYm % 100)
      : Math.max(...availableMonths.filter((ym) => Math.floor(ym / 100) === targetYear).map((ym) => ym % 100), 0);
    const currentMonths = [];
    for (let month = 1; month <= endMonth; month += 1) currentMonths.push(targetYear * 100 + month);
    return {
      mode: 'ytd',
      currentMonths,
      previousMonths: currentMonths.map(_previousYm),
      label: `${targetYear}年1-${endMonth}月累计同比`,
      anchorYm: currentMonths[currentMonths.length - 1],
    };
  }

  return {
    mode: 'latest',
    currentMonths: [latestYm],
    previousMonths: [_previousYm(latestYm)],
    label: `${_ymLabel(latestYm)} 同比 ${_ymLabel(_previousYm(latestYm))}`,
    anchorYm: latestYm,
  };
}

function _aggregateRows(rows, monthsSet, mapper) {
  const agg = { revenue: 0, cost: 0, profit: 0, humanCost: 0, matchedRows: 0 };
  for (const row of rows || []) {
    const fields = row.fields || {};
    const ym = mapper.month(fields);
    if (!ym || !monthsSet.has(ym)) continue;
    agg.revenue += mapper.revenue(fields);
    agg.cost += mapper.cost(fields);
    agg.profit += mapper.profit(fields);
    if (mapper.humanCost) agg.humanCost += mapper.humanCost(fields);
    agg.matchedRows += 1;
  }
  return agg;
}

function _decorateAggregate(agg) {
  return {
    revenue: +agg.revenue.toFixed(0),
    cost: +agg.cost.toFixed(0),
    profit: +agg.profit.toFixed(0),
    matchedRows: agg.matchedRows,
    profitRate: agg.revenue !== 0 ? +((agg.profit / agg.revenue) * 100).toFixed(1) : null,
  };
}

function _buildDelta(current, previous) {
  return {
    revenue: +(current.revenue - previous.revenue).toFixed(0),
    cost: +(current.cost - previous.cost).toFixed(0),
    profit: +(current.profit - previous.profit).toFixed(0),
    revenueYoYRate: previous.revenue !== 0 ? +(((current.revenue - previous.revenue) / Math.abs(previous.revenue)) * 100).toFixed(1) : null,
    costYoYRate: previous.cost !== 0 ? +(((current.cost - previous.cost) / Math.abs(previous.cost)) * 100).toFixed(1) : null,
    profitYoYRate: previous.profit !== 0 ? +(((current.profit - previous.profit) / Math.abs(previous.profit)) * 100).toFixed(1) : null,
    profitRateDelta: current.profitRate != null && previous.profitRate != null
      ? +(current.profitRate - previous.profitRate).toFixed(1)
      : null,
  };
}

function _buildProjectDeltas(rows, currentMonths, previousMonths) {
  const currentSet = new Set(currentMonths);
  const previousSet = new Set(previousMonths);
  const byProject = new Map();
  for (const row of rows || []) {
    const fields = row.fields || {};
    const ym = _parseYm(FM.str(fields, FM.ACTUAL_PROJECT_FIELDS.MONTH));
    if (!ym || (!currentSet.has(ym) && !previousSet.has(ym))) continue;
    const project = FM.str(fields, FM.ACTUAL_PROJECT_FIELDS.PROJECT_NAME) || '(未命名项目)';
    const dept = FM.str(fields, FM.ACTUAL_PROJECT_FIELDS.DEPT) || '';
    const key = `${project}||${dept}`;
    if (!byProject.has(key)) {
      byProject.set(key, {
        project,
        dept,
        currentRevenue: 0,
        previousRevenue: 0,
        currentProfit: 0,
        previousProfit: 0,
      });
    }
    const item = byProject.get(key);
    if (currentSet.has(ym)) {
      item.currentRevenue += FM.num(fields, FM.ACTUAL_PROJECT_FIELDS.REVENUE);
      item.currentProfit += FM.num(fields, FM.ACTUAL_PROJECT_FIELDS.PROFIT);
    }
    if (previousSet.has(ym)) {
      item.previousRevenue += FM.num(fields, FM.ACTUAL_PROJECT_FIELDS.REVENUE);
      item.previousProfit += FM.num(fields, FM.ACTUAL_PROJECT_FIELDS.PROFIT);
    }
  }

  return [...byProject.values()]
    .map((item) => ({
      project: item.project,
      dept: item.dept,
      revenueDelta: +(item.currentRevenue - item.previousRevenue).toFixed(0),
      profitDelta: +(item.currentProfit - item.previousProfit).toFixed(0),
      currentRevenue: +item.currentRevenue.toFixed(0),
      previousRevenue: +item.previousRevenue.toFixed(0),
      currentProfit: +item.currentProfit.toFixed(0),
      previousProfit: +item.previousProfit.toFixed(0),
    }))
    .filter((item) => item.currentRevenue !== 0 || item.previousRevenue !== 0 || item.currentProfit !== 0 || item.previousProfit !== 0)
    .sort((a, b) => Math.abs(b.profitDelta) - Math.abs(a.profitDelta));
}

function yoyComparison(memory, scope) {
  const hasProjectScope = projectScope.shouldApplyProjectScope(scope);
  const actualDeptRows = hasProjectScope ? [] : (memory.actualDept || []);
  const rawActualProjectRows = memory.actualProject || memory.projectMonthly || [];
  const actualProjectRows = _filterProjectRows(rawActualProjectRows, scope);
  const projectScopeGuard = projectScope.projectScopeGuard(scope, rawActualProjectRows.length, actualProjectRows.length);
  const deptMonths = actualDeptRows.map((row) => _parseYm(FM.str(row.fields || {}, FM.ACTUAL_DEPT_FIELDS.MONTH)));
  const projectMonths = actualProjectRows.map((row) => _parseYm(FM.str(row.fields || {}, FM.ACTUAL_PROJECT_FIELDS.MONTH)));
  const window = _selectComparisonWindow(scope, actualDeptRows.length > 0 ? deptMonths : projectMonths);

  if (!window) {
    return { empty: true, message: '暂无可用于普通同比分析的实际经营数据' };
  }

  const mapper = actualDeptRows.length > 0
    ? {
        month: (fields) => _parseYm(FM.str(fields, FM.ACTUAL_DEPT_FIELDS.MONTH)),
        revenue: (fields) => FM.num(fields, FM.ACTUAL_DEPT_FIELDS.REVENUE),
        cost: (fields) => FM.num(fields, FM.ACTUAL_DEPT_FIELDS.COST),
        profit: (fields) => FM.num(fields, FM.ACTUAL_DEPT_FIELDS.PROFIT),
        humanCost: (fields) => FM.num(fields, FM.ACTUAL_DEPT_FIELDS.LABOR_COST),
      }
    : {
        month: (fields) => _parseYm(FM.str(fields, FM.ACTUAL_PROJECT_FIELDS.MONTH)),
        revenue: (fields) => FM.num(fields, FM.ACTUAL_PROJECT_FIELDS.REVENUE),
        cost: (fields) => FM.num(fields, FM.ACTUAL_PROJECT_FIELDS.COST),
        profit: (fields) => FM.num(fields, FM.ACTUAL_PROJECT_FIELDS.PROFIT),
        humanCost: (fields) => FM.num(fields, FM.ACTUAL_PROJECT_FIELDS.LABOR_COST),
      };
  const sourceRows = actualDeptRows.length > 0 ? actualDeptRows : actualProjectRows;
  const currentRaw = _aggregateRows(sourceRows, new Set(window.currentMonths), mapper);
  const previousRaw = _aggregateRows(sourceRows, new Set(window.previousMonths), mapper);
  const current = _decorateAggregate(currentRaw);
  const previous = _decorateAggregate(previousRaw);
  const delta = _buildDelta(current, previous);
  const projectDeltas = _buildProjectDeltas(actualProjectRows, window.currentMonths, window.previousMonths);

  const humanCostYoY = (currentRaw.humanCost || previousRaw.humanCost) ? {
    current: +currentRaw.humanCost.toFixed(0),
    previous: +previousRaw.humanCost.toFixed(0),
    gap: +(currentRaw.humanCost - previousRaw.humanCost).toFixed(0),
    rate: previousRaw.humanCost > 0
      ? +(((currentRaw.humanCost - previousRaw.humanCost) / Math.abs(previousRaw.humanCost)) * 100).toFixed(1)
      : null,
  } : null;

  const fmtWan = v => (v / 10000).toFixed(1);
  const factSheet = [
    `同比口径：${window.label}`,
    `收入：今年 ${fmtWan(current.revenue)}万 / 去年 ${fmtWan(previous.revenue)}万 / 同比 ${delta.revenueYoYRate ?? '—'}%`,
    `总成本：今年 ${fmtWan(current.cost)}万 / 去年 ${fmtWan(previous.cost)}万 / 同比 ${delta.costYoYRate ?? '—'}%`,
    `利润：今年 ${fmtWan(current.profit)}万 / 去年 ${fmtWan(previous.profit)}万 / 同比 ${delta.profitYoYRate ?? '—'}%`,
  ];
  if (humanCostYoY) {
    factSheet.push(`人力成本：今年 ${fmtWan(humanCostYoY.current)}万 / 去年 ${fmtWan(humanCostYoY.previous)}万 / 差额 ${fmtWan(humanCostYoY.gap)}万 / 同比 ${humanCostYoY.rate ?? '—'}%`);
  }

  return {
    comparisonType: 'standard_yoy',
    mode: window.mode,
    periodLabel: window.label,
    current,
    previous,
    delta,
    humanCostYoY,
    factSheet,
    currentMonths: window.currentMonths.map(_ymLabel),
    previousMonths: window.previousMonths.map(_ymLabel),
    topProjectLift: projectDeltas.filter((item) => item.profitDelta > 0).slice(0, 5),
    topProjectDrag: projectDeltas.filter((item) => item.profitDelta < 0).slice(0, 5),
    _sourceTable: actualDeptRows.length > 0
      ? 'ACTUAL_DEPT（实际：部门层，实际入账口径）+ ACTUAL_PROJECT（实际：项目层，项目贡献拆解）'
      : 'ACTUAL_PROJECT（实际：项目层，实际入账口径）',
    _periodLabel: window.label,
    _scopeGuard: projectScopeGuard,
    _scopeLabel: _scopeLabel(scope),
    _cohesionHint: '这是实际入账口径同比，不是默认经营回滚口径；只有用户明确问入账/账面/不回滚同比时才使用。',
  };
}

function _selectRollbackMonth(scope, months) {
  const availableMonths = _uniqueSortedMonths(months);
  if (availableMonths.length === 0) return 0;
  const explicitMonth = _parseExplicitMonthPeriod(scope && scope.period);
  if (explicitMonth && availableMonths.includes(explicitMonth)) return explicitMonth;
  const cutoff = _defaultCutoffYm(scope);
  const cutoffMonths = availableMonths.filter((ym) => ym <= cutoff);
  return cutoffMonths.length > 0 ? cutoffMonths[cutoffMonths.length - 1] : availableMonths[availableMonths.length - 1];
}

// 2026-05-08 M4 辅助函数：从 ACTUAL_DEPT 取最大已录月份（防 rollbackDeptYoy 选到未来预测月）
//   返回 6-digit YYYYMM 格式（与 _parseYm/_currentYm 对齐）；若 ACTUAL_DEPT 字段是 4-digit YYMM，
//   自动加 2000 转 6-digit。
function _getActualDeptMaxYm(actualDeptRows) {
  let max = 0;
  for (const r of actualDeptRows || []) {
    const f = r.fields || {};
    const v = f['月份'];
    let ym = 0;
    if (typeof v === 'number') ym = v;
    else if (typeof v === 'string') ym = Number(v) || 0;
    else if (Array.isArray(v) && v[0] != null) {
      ym = typeof v[0] === 'number' ? v[0] : (Number(v[0]) || 0);
    }
    // 4-digit YYMM → 6-digit YYYYMM
    if (ym >= 100 && ym < 10000) {
      const yy = Math.floor(ym / 100);
      const mo = ym % 100;
      if (yy >= 20 && yy <= 99 && mo >= 1 && mo <= 12) ym = (2000 + yy) * 100 + mo;
    }
    // 必须有真实数据（履约收入 ≠ 0），过滤掉空行/未来月份
    const rev = Number(f['履约收入']) || 0;
    if (ym && rev !== 0 && ym > max) max = ym;
  }
  return max;
}

// 2026-05-08 M4：rollbackDeptYoy 改为 **YTD 累计口径**（口径已确认）
//   关键变更：
//   1) effectiveCutoff = min(scope cutoff, ACTUAL_DEPT 最大已录月)，防选到 5/6 月未来预测
//   2) 不再取单月，改为累加 1月 ~ effectiveCutoff 所有月份的 26/25 收入/成本/利润
//   3) 新增输出 costCurrent / costPrevious / profitCurrent / profitPrevious 字段
//   4) profitRate 处理"扭亏为盈"场景（25 年负利润情况下不能简单除）
function rollbackDeptYoy(memory, scope) {
  const rows = memory.deptYoy || [];
  if (rows.length === 0) return { empty: true, message: '暂无部门层回滚同比数据' };

  const F = FM.DEPT_YOY_FIELDS;
  const items = rows.map((row) => {
    const fields = row.fields || {};
    // 优先用 26年月份 字段（原 MONTH 字段很多行为空）
    const month26Raw = FM.str(fields, F.MONTH_26) || FM.str(fields, F.MONTH);
    return {
      dept: FM.str(fields, F.DEPT) || '(未知部门)',
      monthYm: _parseYm(month26Raw),
      // 26 年 / 25 年 收入/成本/利润 全维度
      revenueCurrent:  FM.num(fields, F.REVENUE_26),
      revenuePrevious: FM.num(fields, F.REVENUE_25),
      costCurrent:     FM.num(fields, F.COST_26),
      costPrevious:    FM.num(fields, F.COST_25),
      profitCurrent:   FM.num(fields, F.PROFIT_26),
      profitPrevious:  FM.num(fields, F.PROFIT_25),
      // 增长额/率（行内已预计算，仅作参考）
      revenueGap:  FM.num(fields, F.YOY_REVENUE_GAP),
      revenueRate: _rateFromFields(fields, [F.YOY_REVENUE_RATE]),
      revenueDesc: FM.str(fields, F.YOY_REVENUE_DESC),
      profitGapRow:  FM.num(fields, F.YOY_PROFIT_GAP),
      profitRateRow: _rateFromFields(fields, [F.YOY_PROFIT_RATE]),
    };
  }).filter((item) => item.monthYm);
  if (items.length === 0) {
    return { empty: true, message: '暂无部门层回滚同比可解析月份数据' };
  }

  // 关键约束：cutoff 必须 ≤ ACTUAL_DEPT 实际已录最大月，防选未来预测
  // 注意：_defaultCutoffYm / _parseYm / actualMaxYm 都已统一为 6-digit YYYYMM 格式
  const actualMaxYm = _getActualDeptMaxYm(memory.actualDept || []);
  const scopeCutoff = _defaultCutoffYm(scope);
  const effectiveCutoff = actualMaxYm > 0 ? Math.min(scopeCutoff, actualMaxYm) : scopeCutoff;
  const cutoffYear = Math.floor(effectiveCutoff / 100);   // 2026
  const cutoffMo = effectiveCutoff % 100;                  // 4

  // 取 1月 ~ effectiveCutoff 的所有行（YTD 累计）
  const ytdItems = items.filter((item) => {
    const yy = Math.floor(item.monthYm / 100);
    const mo = item.monthYm % 100;
    return yy === cutoffYear && mo >= 1 && mo <= cutoffMo;
  });

  if (ytdItems.length === 0) {
    return { empty: true, message: `无 ${effectiveCutoff} 月以内的已发生回滚同比数据` };
  }

  // 按部门累加 26/25 收入/成本/利润
  const deptAgg = new Map();
  for (const item of ytdItems) {
    const cur = deptAgg.get(item.dept) || {
      revenue26: 0, revenue25: 0, cost26: 0, cost25: 0, profit26: 0, profit25: 0, monthCount: 0,
    };
    cur.revenue26 += item.revenueCurrent;
    cur.revenue25 += item.revenuePrevious;
    cur.cost26    += item.costCurrent;
    cur.cost25    += item.costPrevious;
    cur.profit26  += item.profitCurrent;
    cur.profit25  += item.profitPrevious;
    cur.monthCount++;
    deptAgg.set(item.dept, cur);
  }

  // 构造输出
  function _calcRate(cur, prev) {
    if (prev > 0) return +((cur / prev - 1) * 100).toFixed(1);
    if (prev < 0 && cur > 0) return null;        // 扭亏为盈，无法用%表示
    if (prev === 0) return cur === 0 ? 0 : null; // 25 为 0 时同比无意义
    return +((cur - prev) / Math.abs(prev) * 100).toFixed(1);
  }

  const deptItems = [...deptAgg.entries()].map(([dept, agg]) => {
    const profitGap = agg.profit26 - agg.profit25;
    return {
      dept,
      revenueCurrent:  +agg.revenue26.toFixed(0),
      revenuePrevious: +agg.revenue25.toFixed(0),
      revenueGap:      +(agg.revenue26 - agg.revenue25).toFixed(0),
      revenueRate:     _calcRate(agg.revenue26, agg.revenue25),
      costCurrent:     +agg.cost26.toFixed(0),
      costPrevious:    +agg.cost25.toFixed(0),
      costGap:         +(agg.cost26 - agg.cost25).toFixed(0),
      costRate:        _calcRate(agg.cost26, agg.cost25),
      profitCurrent:   +agg.profit26.toFixed(0),
      profitPrevious:  +agg.profit25.toFixed(0),
      profitGap:       +profitGap.toFixed(0),
      profitRate:      _calcRate(agg.profit26, agg.profit25),
      // 扭亏为盈标记：25年负利润 + 26年正利润
      profitFlipPositive: agg.profit25 < 0 && agg.profit26 > 0,
      monthCount:      agg.monthCount,
    };
  }).sort((a, b) => b.profitGap - a.profitGap);

  const periodLabel = `${cutoffYear}年1-${cutoffMo}月累计 vs ${cutoffYear - 1}年同期累计`;

  // 2026-05-08 M1：factSheet 防幻觉 —— 每部门一行预渲染 26 vs 25 累计同比
  function _wan(v) { return ((v || 0) / 10000).toFixed(2) + '万'; }
  const _factSheet = [
    `⚠️ 以下数字均为 ${cutoffYear}年1-${cutoffMo}月 vs ${cutoffYear - 1}年1-${cutoffMo}月 YTD 累计同比（已按 ACTUAL_DEPT 已录最大月 ${actualMaxYm} 截断，不含 5/6 月预测）`,
  ];
  for (const d of deptItems) {
    const rateStr = d.revenueRate !== null ? ((d.revenueRate >= 0 ? '+' : '') + d.revenueRate + '%') : '—';
    const profitNote = d.profitFlipPositive
      ? `扭亏为盈 +${_wan(d.profitGap)}`
      : (d.profitRate !== null
        ? `${d.profitRate >= 0 ? '+' : ''}${d.profitRate}%`
        : '—');
    _factSheet.push(
      `[${d.dept}][${cutoffYear}年1-${cutoffMo}月] 收入: ${_wan(d.revenueCurrent)} vs ${_wan(d.revenuePrevious)} (${rateStr}) | ` +
      `成本: ${_wan(d.costCurrent)} vs ${_wan(d.costPrevious)} | ` +
      `利润: ${_wan(d.profitCurrent)} vs ${_wan(d.profitPrevious)} (${profitNote})`,
    );
  }

  return {
    comparisonType: 'rollback_dept_yoy_ytd',
    cutoffMonth:  effectiveCutoff,
    monthLabel:   periodLabel,
    items:        deptItems,
    topGrowth:    deptItems.filter((d) => d.profitGap > 0).slice(0, 5),
    topDecline:   deptItems.filter((d) => d.profitGap < 0).slice(0, 5),
    actualMaxYm,                                // 透明展示已录最大月
    _factSheet,
    _sourceTable: 'DEPT_YOY（部门层同比（回滚））— YTD 累计口径',
    _periodLabel: periodLabel,
    _cohesionHint: `回滚口径部门同比 — YTD 累计（截至 ${cutoffMo} 月）：\n` +
      `· 已自动按 ACTUAL_DEPT 实际录入最大月（${actualMaxYm}）截断，不会取到未来预测月份。\n` +
      `· 26/25 年的收入/成本/利润均为 1-${cutoffMo} 月累加值，profitRate 在"25年负利润扭亏到26年正利润"场景下为 null（用 profitFlipPositive=true 标记）。\n` +
      `· 需要实际入账口径同比请改用 finance.yoyComparison。`,
  };
}

function rollbackCompanyYoy(memory, scope) {
  const rows = memory.companyYoy || [];
  if (rows.length === 0) return { empty: true, message: '暂无公司层回滚同比数据' };

  const items = rows.map((row) => {
    const fields = row.fields || {};
    return {
      monthYm: _parseYm(_text(fields, COMPANY_ROLLBACK_FIELDS.month)),
      revenueCurrent: _number(fields, COMPANY_ROLLBACK_FIELDS.revenueCurrent),
      revenuePrevious: _number(fields, COMPANY_ROLLBACK_FIELDS.revenuePrevious),
      revenueGap: _number(fields, COMPANY_ROLLBACK_FIELDS.revenueGap),
      revenueRate: _rateFromFields(fields, COMPANY_ROLLBACK_FIELDS.revenueRate),
      profitCurrent: _number(fields, COMPANY_ROLLBACK_FIELDS.profitCurrent) || _number(fields, ['\u5c65\u7ea6\u5229\u6da6']),
      profitPrevious: _number(fields, COMPANY_ROLLBACK_FIELDS.profitPrevious) || _number(fields, ['\u5c65\u7ea6\u5229\u6da6.']),
      profitGap: _number(fields, COMPANY_ROLLBACK_FIELDS.profitGap),
      profitRate: _rateFromFields(fields, COMPANY_ROLLBACK_FIELDS.profitRate),
    };
  }).filter((item) => item.monthYm);
  if (items.length === 0) {
    return { empty: true, message: '暂无公司层回滚同比可解析月份数据' };
  }

  const selectedMonth = _selectRollbackMonth(scope, items.map((item) => item.monthYm));
  const selectedItem = items.find((item) => item.monthYm === selectedMonth) || items.sort((a, b) => b.monthYm - a.monthYm)[0];

  return {
    comparisonType: 'rollback_company_yoy',
    monthYm: selectedItem.monthYm,
    monthLabel: _ymLabel(selectedItem.monthYm),
    current: {
      revenue: selectedItem.revenueCurrent,
      profit: selectedItem.profitCurrent,
    },
    previous: {
      revenue: selectedItem.revenuePrevious,
      profit: selectedItem.profitPrevious,
    },
    delta: {
      revenue: selectedItem.revenueGap,
      revenueYoYRate: selectedItem.revenueRate,
      profit: selectedItem.profitGap,
      profitYoYRate: selectedItem.profitRate,
    },
    _sourceTable: 'COMPANY_YOY（公司层面同比（回滚））',
    _periodLabel: _ymLabel(selectedItem.monthYm),
    _cohesionHint: '这是公司层回滚同比，只能代表回滚后管理口径；回答时请显式说明“回滚口径”。',
  };
}

function _extractRollbackTrend(fields) {
  const trend = {};
  for (const [key, raw] of Object.entries(fields || {})) {
    let match = key.match(/^(\d{1,2})月履约收入$/);
    if (match) {
      const month = Number(match[1]);
      trend[month] = trend[month] || { month };
      trend[month].revenue = Number(raw) || 0;
      continue;
    }
    match = key.match(/^(\d{1,2})月履约利润$/);
    if (match) {
      const month = Number(match[1]);
      trend[month] = trend[month] || { month };
      trend[month].profit = Number(raw) || 0;
      continue;
    }
    match = key.match(/^(\d{1,2})月履约成本$/);
    if (match) {
      const month = Number(match[1]);
      trend[month] = trend[month] || { month };
      trend[month].cost = Number(raw) || 0;
    }
  }
  return Object.values(trend)
    .filter((item) => Object.prototype.hasOwnProperty.call(item, 'revenue') || Object.prototype.hasOwnProperty.call(item, 'profit') || Object.prototype.hasOwnProperty.call(item, 'cost'))
    .sort((a, b) => a.month - b.month);
}

function rollbackRevenueMom(memory, scope) {
  const rows = memory.revenueMom || [];
  if (rows.length === 0) return { empty: true, message: '暂无回滚环比数据' };

  const rawItems = rows.map((row) => {
    const fields = row.fields || {};
    const trend = _extractRollbackTrend(fields);
    if (trend.length < 2) return null;
    const current = trend[trend.length - 1];
    const previous = trend[trend.length - 2];
    const revenueDelta = (current.revenue || 0) - (previous.revenue || 0);
    const profitDelta = (current.profit || 0) - (previous.profit || 0);
    return {
      dept: _text(fields, ['一级部门']),
      project: _text(fields, ['项目', '项目名称', '项目名']),
      currentMonth: current.month,
      previousMonth: previous.month,
      revenueCurrent: current.revenue || 0,
      revenuePrevious: previous.revenue || 0,
      revenueDelta: +revenueDelta.toFixed(0),
      revenueMoMRate: previous.revenue ? +((revenueDelta / Math.abs(previous.revenue)) * 100).toFixed(1) : null,
      profitCurrent: current.profit || 0,
      profitPrevious: previous.profit || 0,
      profitDelta: +profitDelta.toFixed(0),
      profitMoMRate: previous.profit ? +((profitDelta / Math.abs(previous.profit)) * 100).toFixed(1) : null,
      costCurrent: current.cost || 0,
      costPrevious: previous.cost || 0,
    };
  }).filter(Boolean);
  const items = _filterNormalizedProjectItems(rawItems, scope);
  const projectScopeGuard = projectScope.projectScopeGuard(scope, rawItems.length, items.length);
  if (items.length === 0) return {
    empty: true,
    message: '暂无匹配当前项目范围的回滚环比数据',
    _sourceTable: 'REVENUE_MOM（履约收入&利润环比（回滚））',
    _scopeGuard: projectScopeGuard,
    _scopeLabel: _scopeLabel(scope),
  };

  items.sort((a, b) => Math.abs(b.profitDelta) - Math.abs(a.profitDelta));
  const targetMonth = items.length > 0 ? Math.max(...items.map((item) => item.currentMonth)) : 0;
  const latestItems = items.filter((item) => item.currentMonth === targetMonth);

  return {
    comparisonType: 'rollback_mom',
    monthPair: latestItems.length > 0 ? `${latestItems[0].previousMonth}月 -> ${latestItems[0].currentMonth}月` : '',
    items: latestItems.length > 0 ? latestItems : items,
    topGrowth: (latestItems.length > 0 ? latestItems : items).filter((item) => item.profitDelta > 0).slice(0, 5),
    topDecline: (latestItems.length > 0 ? latestItems : items).filter((item) => item.profitDelta < 0).slice(0, 5),
    _sourceTable: 'REVENUE_MOM（履约收入&利润环比（回滚））',
    _periodLabel: latestItems.length > 0 ? `${latestItems[0].previousMonth}月 -> ${latestItems[0].currentMonth}月` : '回滚环比',
    _scopeGuard: projectScopeGuard,
    _scopeLabel: _scopeLabel(scope),
    _cohesionHint: '这是回滚口径环比，回答时请直接说明“回滚后从上月到本月的变化”；普通环比请改用 finance.profitTrend。',
  };
}

function _makeJoinKey(project, ym, dept) {
  return `${project || ''}||${ym || 0}||${dept || ''}`;
}

function _normalizeRollbackProjectRow(row) {
  const fields = row.fields || {};
  const allocatedNetProfitRaw = _lookup(fields, ROLLBACK_PROJECT_FIELDS.allocatedNetProfit);
  return {
    project: _text(fields, ROLLBACK_PROJECT_FIELDS.project) || '(未命名项目)',
    dept: _text(fields, ROLLBACK_PROJECT_FIELDS.dept),
    monthYm: _parseYm(_text(fields, ROLLBACK_PROJECT_FIELDS.month)),
    revenue: _number(fields, ROLLBACK_PROJECT_FIELDS.revenue),
    cost: _number(fields, ROLLBACK_PROJECT_FIELDS.cost),
    profit: _number(fields, ROLLBACK_PROJECT_FIELDS.profit),
    managementEnablement: _number(fields, ROLLBACK_PROJECT_FIELDS.managementEnablement),
    allocationRatio: _lookup(fields, ROLLBACK_PROJECT_FIELDS.allocationRatio),
    projectAllocation: _number(fields, ROLLBACK_PROJECT_FIELDS.projectAllocation),
    allocatedNetProfit: allocatedNetProfitRaw == null || allocatedNetProfitRaw === '' ? null : (Number(allocatedNetProfitRaw) || 0),
  };
}

function _loadErrors(memory, tableKey) {
  const trace = memory && memory._traceMeta;
  const errors = trace && Array.isArray(trace.fetchErrors) ? trace.fetchErrors : [];
  return errors.filter((err) => err && err.tableKey === tableKey);
}

function _wan(v) {
  return `${((Number(v) || 0) / 10000).toFixed(2)}万`;
}

function rollbackHealthCheck(memory, scope) {
  const loadErrors = _loadErrors(memory, 'rollbackProjectActual');
  const allRows = (memory.rollbackProjectActual || [])
    .map(_normalizeRollbackProjectRow)
    .filter((item) => item.project && item.monthYm);
  const rows = _filterNormalizedProjectItems(allRows, scope);
  const projectScopeGuard = projectScope.projectScopeGuard(scope, allRows.length, rows.length);

  if (rows.length === 0) {
    if (loadErrors.length > 0) {
      return {
        empty: true,
        incomplete: true,
        message: '本次项目层回滚实际表读取失败，无法生成回滚经营体检。',
        loadErrors,
        _sourceTable: 'ROLLBACK_PROJECT_ACTUAL（项目层-回滚实际）',
        _scopeGuard: projectScopeGuard,
        _scopeLabel: _scopeLabel(scope),
      };
    }
    return {
      empty: true,
      message: '暂无项目层回滚实际明细',
      _sourceTable: 'ROLLBACK_PROJECT_ACTUAL（项目层-回滚实际）',
      _scopeGuard: projectScopeGuard,
      _scopeLabel: _scopeLabel(scope),
    };
  }

  const cutoff = _selectRollbackMonth(scope, rows.map((item) => item.monthYm));
  const cutoffYear = Math.floor(cutoff / 100);
  const cutoffMo = cutoff % 100;
  const scopeDepts = scope && Array.isArray(scope.depts) ? scope.depts.filter(Boolean) : [];
  const scopedRows = rows.filter((item) => {
    if (scopeDepts.length > 0 && item.dept && !scopeDepts.includes(item.dept)) return false;
    const yy = Math.floor(item.monthYm / 100);
    const mo = item.monthYm % 100;
    return yy === cutoffYear && mo >= 1 && mo <= cutoffMo;
  });

  if (scopedRows.length === 0) {
    return {
      empty: true,
      message: `${cutoffYear}年1-${cutoffMo}月没有匹配当前 scope 的回滚实际数据`,
      _sourceTable: 'ROLLBACK_PROJECT_ACTUAL（项目层-回滚实际）',
      _periodLabel: `${cutoffYear}年1-${cutoffMo}月累计，回滚实际口径`,
      _scopeGuard: projectScopeGuard,
      _scopeLabel: _scopeLabel(scope),
    };
  }

  const projectAgg = new Map();
  const deptAgg = new Map();
  const total = { revenue: 0, cost: 0, profit: 0 };
  let allocatedProfitRows = 0;
  let allocatedProfitMissingRows = 0;
  const profitView = _resolveProfitView(scope);

  for (const item of scopedRows) {
    const profit = _selectedRollbackProfit(item, scope);
    if (item.allocatedNetProfit != null) allocatedProfitRows++;
    if (profitView === 'allocated' && item.allocatedNetProfit == null) allocatedProfitMissingRows++;
    total.revenue += item.revenue;
    total.cost += item.cost;
    total.profit += profit;

    const p = projectAgg.get(item.project) || {
      project: item.project,
      dept: item.dept,
      revenue: 0,
      cost: 0,
      profit: 0,
      months: new Set(),
    };
    p.revenue += item.revenue;
    p.cost += item.cost;
    p.profit += profit;
    p.months.add(item.monthYm);
    projectAgg.set(item.project, p);

    const d = deptAgg.get(item.dept || '(未分部门)') || { dept: item.dept || '(未分部门)', revenue: 0, cost: 0, profit: 0, projectSet: new Set() };
    d.revenue += item.revenue;
    d.cost += item.cost;
    d.profit += profit;
    d.projectSet.add(item.project);
    deptAgg.set(d.dept, d);
  }

  const projectItems = [...projectAgg.values()].map((item) => ({
    project: item.project,
    dept: item.dept,
    revenue: +item.revenue.toFixed(0),
    cost: +item.cost.toFixed(0),
    profit: +item.profit.toFixed(0),
    profitRate: item.revenue ? +(item.profit / item.revenue * 100).toFixed(1) : null,
    monthCount: item.months.size,
  })).sort((a, b) => b.profit - a.profit);

  const deptItems = [...deptAgg.values()].map((item) => ({
    dept: item.dept,
    revenue: +item.revenue.toFixed(0),
    cost: +item.cost.toFixed(0),
    profit: +item.profit.toFixed(0),
    profitRate: item.revenue ? +(item.profit / item.revenue * 100).toFixed(1) : null,
    projectCount: item.projectSet.size,
  })).sort((a, b) => b.profit - a.profit);

  const profitRate = total.revenue ? +(total.profit / total.revenue * 100).toFixed(1) : null;
  const periodLabel = `${cutoffYear}年1-${cutoffMo}月累计，回滚实际口径`;
  const scopeLabel = _scopeLabel(scope, scopeDepts.length > 0 ? scopeDepts.join(' + ') : '当前可见范围');

  const factSheet = [
    `[${scopeLabel}][${periodLabel}] 收入 ${_wan(total.revenue)} | 成本 ${_wan(total.cost)} | 利润 ${_wan(total.profit)} | 利润率 ${profitRate !== null ? profitRate + '%' : '—'}`,
    profitView === 'allocated'
      ? `项目数 ${projectItems.length} 个；亏损项目 ${projectItems.filter((p) => p.profit < 0).length} 个；利润字段使用“分摊后项目净利润”（缺失行按 0 处理并在结果中标注，缺失 ${allocatedProfitMissingRows} 行）`
      : `项目数 ${projectItems.length} 个；亏损项目 ${projectItems.filter((p) => p.profit < 0).length} 个；利润字段使用“履约利润”（默认经营口径）`,
  ];
  for (const item of projectItems.slice(0, 5)) {
    factSheet.push(`盈利贡献项目：${item.project}（${item.dept || '?'}）收入 ${_wan(item.revenue)}，利润 ${_wan(item.profit)}，利润率 ${item.profitRate !== null ? item.profitRate + '%' : '—'}`);
  }
  for (const item of projectItems.filter((p) => p.profit < 0).sort((a, b) => a.profit - b.profit).slice(0, 5)) {
    factSheet.push(`亏损项目：${item.project}（${item.dept || '?'}）收入 ${_wan(item.revenue)}，利润 ${_wan(item.profit)}，利润率 ${item.profitRate !== null ? item.profitRate + '%' : '—'}`);
  }

  return {
    comparisonType: 'rollback_health_check',
    cutoffMonth: cutoff,
    scopeLabel,
    periodLabel,
    metrics: {
      revenue: +total.revenue.toFixed(0),
      cost: +total.cost.toFixed(0),
      profit: +total.profit.toFixed(0),
      profitRate,
    },
    profitView,
    deptSummary: deptItems,
    projectSummary: {
      totalProjects: projectItems.length,
      lossProjects: projectItems.filter((p) => p.profit < 0).sort((a, b) => a.profit - b.profit).slice(0, 10),
      topProfitProjects: projectItems.filter((p) => p.profit >= 0).slice(0, 10),
    },
    allocatedProfitRows,
    allocatedProfitMissingRows,
    rowCount: scopedRows.length,
    factSheet,
    _factSheet: factSheet,
    _sourceTable: 'ROLLBACK_PROJECT_ACTUAL（项目层-回滚实际）',
    _periodLabel: periodLabel,
    _scopeGuard: projectScopeGuard,
    _scopeLabel: scopeLabel,
    _cohesionHint: profitView === 'allocated'
      ? '这是回滚实际口径经营体检，且用户明确要求分摊后项目利润：项目和部门总览均来自 ROLLBACK_PROJECT_ACTUAL，利润字段使用“分摊后项目净利润”。禁止把“履约利润”和“分摊后项目净利润”混在同一列。'
      : '这是回滚实际口径经营体检：项目和部门总览均来自 ROLLBACK_PROJECT_ACTUAL，默认经营利润字段使用“履约利润”。只有用户明确要求分摊后项目利润时，才使用“分摊后项目净利润”。',
  };
}

function rollbackProjectDrilldown(memory, scope) {
  const profitView = _resolveProfitView(scope);
  const allRollbackRows = (memory.rollbackProjectActual || [])
    .map(_normalizeRollbackProjectRow)
    .filter((item) => item.project && item.monthYm);
  const rollbackRows = _filterNormalizedProjectItems(allRollbackRows, scope);
  const projectScopeGuard = projectScope.projectScopeGuard(scope, allRollbackRows.length, rollbackRows.length);
  if (rollbackRows.length === 0) return {
    empty: true,
    message: '暂无项目层回滚实际明细',
    _scopeGuard: projectScopeGuard,
    _scopeLabel: _scopeLabel(scope),
  };

  const selectedMonth = _selectRollbackMonth(scope, rollbackRows.map((item) => item.monthYm));
  const selectedRows = rollbackRows.filter((item) => item.monthYm === selectedMonth);

  const actualIndex = new Map();
  for (const row of _filterProjectRows((memory.actualProject || memory.projectMonthly || []), scope)) {
    const fields = row.fields || {};
    const project = FM.str(fields, FM.ACTUAL_PROJECT_FIELDS.PROJECT_NAME);
    const dept = FM.str(fields, FM.ACTUAL_PROJECT_FIELDS.DEPT);
    const monthYm = _parseYm(FM.str(fields, FM.ACTUAL_PROJECT_FIELDS.MONTH));
    if (!project || !dept || !monthYm) continue;
    const key = _makeJoinKey(project, monthYm, dept);
    if (!actualIndex.has(key)) {
      actualIndex.set(key, { revenue: 0, cost: 0, profit: 0 });
    }
    const entry = actualIndex.get(key);
    entry.revenue += FM.num(fields, FM.ACTUAL_PROJECT_FIELDS.REVENUE);
    entry.cost += FM.num(fields, FM.ACTUAL_PROJECT_FIELDS.COST);
    entry.profit += FM.num(fields, FM.ACTUAL_PROJECT_FIELDS.PROFIT);
  }

  const items = selectedRows.map((item) => {
    const joined = actualIndex.get(_makeJoinKey(item.project, item.monthYm, item.dept)) || null;
    const baseProfit = _selectedRollbackProfit(item, scope);
    return {
      project: item.project,
      dept: item.dept,
      monthYm: item.monthYm,
      monthLabel: _ymLabel(item.monthYm),
      profitView,
      rollbackRevenue: item.revenue,
      rollbackCost: item.cost,
      rollbackProfit: item.profit,
      managementEnablement: item.managementEnablement,
      allocationRatio: item.allocationRatio,
      projectAllocation: item.projectAllocation,
      allocatedNetProfit: item.allocatedNetProfit,
      actualRevenue: joined ? +joined.revenue.toFixed(0) : null,
      actualCost: joined ? +joined.cost.toFixed(0) : null,
      actualProfit: joined ? +joined.profit.toFixed(0) : null,
      rollbackImpactProfit: joined ? +(baseProfit - joined.profit).toFixed(0) : null,
      joinMatched: !!joined,
    };
  }).sort((a, b) => Math.abs(b.rollbackImpactProfit || 0) - Math.abs(a.rollbackImpactProfit || 0));

  const matchedCount = items.filter((item) => item.joinMatched).length;

  return {
    comparisonType: 'rollback_project_drilldown',
    monthYm: selectedMonth,
    monthLabel: _ymLabel(selectedMonth),
    profitView,
    items,
    joinCoverage: {
      matched: matchedCount,
      total: items.length,
      ratio: items.length > 0 ? +((matchedCount / items.length) * 100).toFixed(1) : 0,
    },
    topImpact: items.slice(0, 10),
    _sourceTable: 'ROLLBACK_PROJECT_ACTUAL（项目层-回滚实际）+ ACTUAL_PROJECT（按 项目名 + 月份 + 一级部门 复合键联接）',
    _periodLabel: _ymLabel(selectedMonth),
    _scopeGuard: projectScopeGuard,
    _scopeLabel: _scopeLabel(scope),
    _cohesionHint: '这是回滚原因下钻明细，联接键是“项目名 + 月份 + 一级部门”，不是 SourceID；回答时请优先解释哪些项目带来了回滚影响。',
  };
}

function rollbackCompanyYoyFixed(memory, scope) {
  const rows = memory.companyYoy || [];
  if (rows.length === 0) return { empty: true, message: '\u6682\u65e0\u516c\u53f8\u5c42\u56de\u6eda\u540c\u6bd4\u6570\u636e' };

  const items = rows.map((row) => {
    const fields = row.fields || {};
    return {
      monthYm: _parseYm(_text(fields, COMPANY_ROLLBACK_FIELDS.month)),
      revenueCurrent: _number(fields, COMPANY_ROLLBACK_FIELDS.revenueCurrent),
      revenuePrevious: _number(fields, COMPANY_ROLLBACK_FIELDS.revenuePrevious),
      profitCurrent: _number(fields, COMPANY_ROLLBACK_FIELDS.profitCurrent) || _number(fields, ['\u5c65\u7ea6\u5229\u6da6']),
      profitPrevious: _number(fields, COMPANY_ROLLBACK_FIELDS.profitPrevious) || _number(fields, ['\u5c65\u7ea6\u5229\u6da6.']),
    };
  }).filter((item) => item.monthYm);

  if (items.length === 0) {
    return { empty: true, message: '\u6682\u65e0\u516c\u53f8\u5c42\u56de\u6eda\u540c\u6bd4\u53ef\u89e3\u6790\u6708\u4efd\u6570\u636e' };
  }

  const selectedMonth = _selectRollbackMonth(scope, items.map((item) => item.monthYm))
    || items.slice().sort((a, b) => b.monthYm - a.monthYm)[0].monthYm;
  const summary = items
    .filter((item) => item.monthYm === selectedMonth)
    .reduce((acc, item) => {
      acc.revenueCurrent += item.revenueCurrent;
      acc.revenuePrevious += item.revenuePrevious;
      acc.profitCurrent += item.profitCurrent;
      acc.profitPrevious += item.profitPrevious;
      return acc;
    }, {
      revenueCurrent: 0,
      revenuePrevious: 0,
      profitCurrent: 0,
      profitPrevious: 0,
    });

  const revenueGap = +(summary.revenueCurrent - summary.revenuePrevious).toFixed(0);
  const profitGap = +(summary.profitCurrent - summary.profitPrevious).toFixed(0);
  const revenueRate = summary.revenuePrevious !== 0
    ? +((revenueGap / Math.abs(summary.revenuePrevious)) * 100).toFixed(1)
    : null;
  const profitRate = summary.profitPrevious !== 0
    ? +((profitGap / Math.abs(summary.profitPrevious)) * 100).toFixed(1)
    : null;

  return {
    comparisonType: 'rollback_company_yoy',
    monthYm: selectedMonth,
    monthLabel: _ymLabel(selectedMonth),
    current: {
      revenue: +summary.revenueCurrent.toFixed(0),
      profit: +summary.profitCurrent.toFixed(0),
    },
    previous: {
      revenue: +summary.revenuePrevious.toFixed(0),
      profit: +summary.profitPrevious.toFixed(0),
    },
    delta: {
      revenue: revenueGap,
      revenueYoYRate: revenueRate,
      profit: profitGap,
      profitYoYRate: profitRate,
    },
    _sourceTable: 'COMPANY_YOY\uff08\u516c\u53f8\u5c42\u9762\u540c\u6bd4\uff08\u56de\u6eda\uff09\uff09',
    _periodLabel: _ymLabel(selectedMonth),
    _cohesionHint: '\u8fd9\u662f\u516c\u53f8\u5c42\u56de\u6eda\u540c\u6bd4\uff0c\u53ea\u80fd\u4ee3\u8868\u56de\u6eda\u540e\u7ba1\u7406\u53e3\u5f84\uff1b\u56de\u7b54\u65f6\u8bf7\u663e\u5f0f\u8bf4\u660e\u201c\u56de\u6eda\u53e3\u5f84\u201d\u3002',
  };
}

module.exports = {
  yoyComparison,
  rollbackHealthCheck,
  rollbackDeptYoy,
  rollbackCompanyYoy: rollbackCompanyYoyFixed,
  rollbackRevenueMom,
  rollbackProjectDrilldown,
};
