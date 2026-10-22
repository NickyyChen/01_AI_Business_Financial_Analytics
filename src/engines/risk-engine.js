const logger = require('../utils/logger');
const { parseMonth4, lookupFirst } = require('../utils/field-mapping');
const {
  filterActualWorktimeRows,
  filterBudgetWorktimeRows,
} = require('../utils/worktime-caliber');

const LOSS_PROJECT_STATUSES = new Set(['履约中', '已结案', '预计新签']);

function _textValue(v) {
  if (v == null) return '';
  if (Array.isArray(v)) {
    const first = v[0];
    if (first == null) return '';
    if (typeof first === 'string') return _stripOptionLiteral(first);
    return _stripOptionLiteral(first.text || first.name || first.value || '');
  }
  if (typeof v === 'object') return _stripOptionLiteral(v.text || v.name || v.value || '');
  return _stripOptionLiteral(String(v));
}

function _stripOptionLiteral(s) {
  const raw = String(s || '').trim();
  const m = raw.match(/^\["(.+)"\]$/);
  return m ? m[1].trim() : raw;
}

function _addStatusKey(index, key, status) {
  const k = _textValue(key);
  const s = _textValue(status);
  if (k && s && !index.has(k)) index.set(k, s);
}

function buildProjectStatusIndex(projectMaster) {
  const index = new Map();
  for (const r of (projectMaster || [])) {
    const f = r.fields || {};
    const status = f['项目状态'];
    _addStatusKey(index, f['26年项目名称'], status);
    _addStatusKey(index, f['项目名称（管报）'], status);
    _addStatusKey(index, f['合同名'], status);
  }
  return index;
}

function isLossProjectStatusEligible(status) {
  return LOSS_PROJECT_STATUSES.has(_textValue(status));
}

function _resolveBudgetWorktimeProjectKey(fields, actualProjectKeys = new Set()) {
  const matched = lookupFirst(fields['匹配项目']);
  if (matched) return matched;

  const raw = _textValue(fields['标准项目名称新'] || fields['项目名称']);
  if (!raw) return '';
  if (actualProjectKeys.has(raw)) return raw;

  const parts = raw.split(/[+＋]/).map(part => part.trim()).filter(Boolean);
  const hits = parts.filter(part => actualProjectKeys.has(part));
  return hits.length === 1 ? hits[0] : raw;
}
/**
 * risk-engine.js - 经营风险调控规则引擎
 *
 * 纯函数模块：从 Bitable 原始记录中提取经营指标，
 * 对比 RISK_CONTROL_RULE 规则表的阈值，返回触发结果。
 *
 * 数据源（2026-04 新表体系）：
 *   projectMonthly   ← ACTUAL_PROJECT（实际：项目层）
 *   performanceTargets ← BUDGET_PROJECT（预算：项目层）
 *   projectMaster    ← PROJECT_NAME_UNIQUE（项目名称唯一值）
 *   projectStaffing  ← ACTUAL_WORKTIME（实际：26年工时）
 */

// ==================== 比较运算 ====================

const COMPARE_FNS = {
  '>':  (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<':  (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '=':  (a, b) => a === b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
};

// ==================== 指标提取 ====================

/**
 * 从用户记忆数据中计算经营指标
 * @param {Array} projectMonthly   - PROJECT_MONTHLY 记录
 * @param {Array} performanceTargets - PERFORMANCE_TARGET 记录
 * @param {Array} projectMaster    - PROJECT_MASTER 记录（用于项目状态）
 * @param {object|null} profile    - 员工档案 fields
 * @param {Array} [projectStaffing] - PROJECT_STAFFING 记录（人力成本分析）
 * @returns {object} { 指标名: 数值, ... }
 */
function extractMetrics(projectMonthly, performanceTargets, projectMaster, profile, projectStaffing, opts = {}) {
  const metrics = {};

  const period = (opts && opts.period) || 'latest';
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const periodYear = (opts && opts.periodYear) || (typeof period === 'object' ? period.year : currentYear);

  // 2026-04-23 修复：经营分析类默认"截止上月"（opts.cutoffYm 由 finance-tools._buildPeriodOpts 统一注入）
  //   cutoffYm 传入时以 YY×100+MM 编码（例如 2603 = 26年3月），与 ACTUAL_DEPT 表的"月份"字段同口径。
  //   但 extractMetrics 内部后续比较用的是 YYYY×100+MM（parseMonth4 返回 yr=2026），
  //   所以此处把 cutoffYm 映射为与 yr×100+mo 可比的 4 位年形式（cutoffYmFull）。
  //   若调用方未传（老调用链），fallback 到"当月"保持向后兼容。
  const _rawCutoff = (opts && typeof opts.cutoffYm === 'number')
    ? opts.cutoffYm
    : (currentYear % 100) * 100 + currentMonth;
  const cutoffYm = _rawCutoff;                                               // 2-digit year，用于对外接口
  const cutoffYmFull = (2000 + Math.floor(_rawCutoff / 100)) * 100 + (_rawCutoff % 100); // 4-digit year，内部比较用
  const excludeCurrentMonth = (opts && opts.excludeCurrentMonth === true);
  const projectStatusIndex = buildProjectStatusIndex(projectMaster);
  const actualWorktimeCaliber = filterActualWorktimeRows(projectStaffing || []);
  const effectiveProjectStaffing = actualWorktimeCaliber.rows;
  metrics['_worktimeCaliber'] = {
    actual: actualWorktimeCaliber.summary,
  };

  // —— 按项目汇总月报（支持 latest / ytd / 指定月）——
  const projectStats = {};
  if (period === 'ytd') {
    for (const r of projectMonthly) {
      const f = r.fields || {};
      const key = _textValue(f['是否交付项目']);
      if (!key) continue;
      const { year: yr, month: mo } = parseMonth4(f['月份']);
      if (yr !== periodYear) continue;
      // 2026-04-23 修复：YTD 累加加月份上限（默认截止上月），避免本月冲销污染年累计
      if (mo && (yr * 100 + mo) > cutoffYmFull) continue;
      if (!projectStats[key]) {
        projectStats[key] = {
          revenue: 0,
          cost: 0,
          profit: 0,
          laborCost: 0,
          status: projectStatusIndex.get(key) || _textValue(f['项目状态']),
        };
      } else if (!projectStats[key].status) {
        projectStats[key].status = projectStatusIndex.get(key) || _textValue(f['项目状态']);
      }
      projectStats[key].revenue += Number(f['履约收入']) || 0;
      projectStats[key].cost += Number(f['履约成本']) || 0;
      projectStats[key].profit += Number(f['履约利润']) || 0;
      projectStats[key].laborCost += Number(f['人力成本']) || 0;
    }
  } else if (typeof period === 'object' && period.year && period.month) {
    const targetYm = period.year * 100 + period.month;
    for (const r of projectMonthly) {
      const f = r.fields || {};
      const key = _textValue(f['是否交付项目']);
      if (!key) continue;
      const { year: yr, month: mo } = parseMonth4(f['月份']);
      if (yr * 100 + mo !== targetYm) continue;
      if (!projectStats[key]) {
        projectStats[key] = {
          revenue: 0,
          cost: 0,
          profit: 0,
          laborCost: 0,
          status: projectStatusIndex.get(key) || _textValue(f['项目状态']),
        };
      } else if (!projectStats[key].status) {
        projectStats[key].status = projectStatusIndex.get(key) || _textValue(f['项目状态']);
      }
      projectStats[key].revenue += Number(f['履约收入']) || 0;
      projectStats[key].cost += Number(f['履约成本']) || 0;
      projectStats[key].profit += Number(f['履约利润']) || 0;
      projectStats[key].laborCost += Number(f['人力成本']) || 0;
    }
  } else {
    // latest 分支：按项目取最新月聚合（profitOverview 默认口径）
    // 2026-04-23 修复：默认 cutoff=上月，避免本月仅有冲销/部分数据被当作项目"最新月"快照
    for (const r of projectMonthly) {
      const f = r.fields || {};
      const key = _textValue(f['是否交付项目']);
      if (!key) continue;
      const { year: yr, month: mo } = parseMonth4(f['月份']);
      const ym = yr * 100 + mo;
      if (ym > cutoffYmFull) continue;
      if (!projectStats[key] || ym > projectStats[key]._ym) {
        projectStats[key] = {
          _ym: ym,
          revenue: Number(f['履约收入']) || 0,
          cost: Number(f['履约成本']) || 0,
          profit: Number(f['履约利润']) || 0,
          laborCost: Number(f['人力成本']) || 0,
          status: projectStatusIndex.get(key) || _textValue(f['项目状态']),
        };
      }
    }
  }

  // —— 汇总整体指标 ——
  let totalRevenue = 0, totalCost = 0, totalProfit = 0, totalLaborCost = 0;
  for (const s of Object.values(projectStats)) {
    totalRevenue += s.revenue;
    totalCost += s.cost;
    totalProfit += s.profit;
    totalLaborCost += s.laborCost || 0;
  }

  metrics['履约收入'] = totalRevenue;
  metrics['履约成本'] = totalCost;
  metrics['履约利润'] = totalProfit;
  metrics['人力成本'] = totalLaborCost;
  metrics['利润率'] = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;
  metrics['参与项目数'] = Object.keys(projectStats).length;

  // —— 计算在建/执行中项目数 ——
  if (projectMaster && projectMaster.length > 0) {
    const activeStatuses = ['执行中', '在建', '进行中', '实施中'];
    const activeCount = projectMaster.filter(r => {
      const status = (r.fields || {})['项目状态'] || '';
      return activeStatuses.some(s => status.includes(s));
    }).length;
    metrics['在建项目数'] = activeCount;
  }

  // —— 业绩目标完成率（BUDGET_PROJECT 提供预算，ACTUAL_PROJECT 提供实际）——
  // 2026-04-21 P0 修复：
  //   Bug A：YTD 完成率原本分母是全年 12 个月预算，分子是 YTD（1~当月）实际，
  //          量纲不对齐导致"4 月 300 万 / 全年 2957 万 = 10.16%" 这种荒唐结论。
  //   Bug B：performanceTargets 在 memory-manager 里用 fetchAllRecords 拉的是全公司预算，
  //          没按部门/scope 过滤，分母从"X行业群 580 万"炸成"全公司 2957 万"。
  //   本次修复：
  //     (1) YTD 分母只累加 "月份 ≤ 当前月" 的预算，与分子同期对齐；
  //     (2) 用 projectMonthly / projectMaster 里出现的项目名作为白名单，
  //         把 performanceTargets 先按"当前用户可见项目"过滤再聚合；
  //     (3) 单独暴露 年度预算收入/利润 便于下游计算"全年目标进度"。
  let latestTarget = null;

  // 构造"可见项目 key 集合"，用于把 BUDGET_PROJECT 收敛到当前 scope 的项目
  const _visibleKeys = new Set();
  const _extractKey = (v) => {
    if (v == null) return '';
    if (Array.isArray(v)) {
      const it = v[0];
      if (it == null) return '';
      if (typeof it === 'string') return it;
      return it.text || it.name || '';
    }
    if (typeof v === 'string') {
      const m = v.match(/^\["(.+)"\]$/);
      return m ? m[1] : v;
    }
    return String(v);
  };
  for (const r of (projectMonthly || [])) {
    const k = _extractKey((r.fields || {})['是否交付项目']);
    if (k) _visibleKeys.add(k);
  }
  for (const r of (projectMaster || [])) {
    const f = r.fields || {};
    const k = _extractKey(f['26年项目名称']) || _extractKey(f['项目名称（管报）']);
    if (k) _visibleKeys.add(k);
  }
  // 如果 _visibleKeys 为空（未接入项目 memory 或全局权限），则不按项目过滤，走"全量"兜底
  const _inScope = (rec) => {
    if (_visibleKeys.size === 0) return true;
    const k = _extractKey((rec.fields || {})['是否交付项目']);
    return k ? _visibleKeys.has(k) : false;
  };

  // 全年预算（12 个月总和），独立于"同期完成率"使用，始终累计全年
  let fullYearTargetRev = 0, fullYearTargetProfit = 0, fullYearCnt = 0;
  for (const r of performanceTargets) {
    if (!_inScope(r)) continue;
    const f = r.fields || {};
    const { year: yr } = parseMonth4(f['月份']);
    if (yr !== periodYear) continue;
    fullYearTargetRev += Number(f['履约收入']) || 0;
    fullYearTargetProfit += Number(f['履约利润']) || 0;
    fullYearCnt++;
  }
  if (fullYearCnt > 0) {
    metrics['年度预算收入'] = fullYearTargetRev;
    metrics['年度预算利润'] = fullYearTargetProfit;
  }
  if (period === 'ytd') {
    // 当跨年查询（periodYear !== currentYear）时，"YTD" 等价于整年；只在当年查询时按 cutoff 截断。
    // 2026-04-23 修复：capMonth 与实际分子的 cutoffYm 严格对齐（默认截止上月），
    //   否则"实际截到上月、预算算到当月"会造成分母偏大、完成率人为偏低。
    const capMonth = (periodYear === currentYear) ? (cutoffYm % 100) : 12;
    let sumTargetRev = 0, sumTargetProfit = 0, cnt = 0;
    for (const r of performanceTargets) {
      if (!_inScope(r)) continue;
      const f = r.fields || {};
      const { year: yr, month: mo } = parseMonth4(f['月份']);
      if (yr !== periodYear) continue;
      if (!mo || mo > capMonth) continue;   // ← 关键：YTD 同期，仅累加到 cutoff 月
      sumTargetRev += Number(f['履约收入']) || 0;
      sumTargetProfit += Number(f['履约利润']) || 0;
      cnt++;
    }
    if (cnt > 0) {
      latestTarget = { '月目标收入': sumTargetRev, '月目标利润': sumTargetProfit, '实际收入': totalRevenue, '实际利润': totalProfit };
    }
  } else if (typeof period === 'object' && period.year && period.month) {
    const targetYm = period.year * 100 + period.month;
    let monthBudgetRev = 0, monthBudgetProfit = 0;
    for (const r of performanceTargets) {
      if (!_inScope(r)) continue;
      const f = r.fields || {};
      const { year: yr, month: mo } = parseMonth4(f['月份']);
      if (yr * 100 + mo === targetYm) {
        monthBudgetRev += Number(f['履约收入']) || 0;
        monthBudgetProfit += Number(f['履约利润']) || 0;
      }
    }
    let monthActualRev = 0, monthActualProfit = 0;
    for (const r of projectMonthly) {
      const f = r.fields || {};
      const { year: yr, month: mo } = parseMonth4(f['月份']);
      if (yr * 100 + mo === targetYm) {
        monthActualRev += Number(f['履约收入']) || 0;
        monthActualProfit += Number(f['履约利润']) || 0;
      }
    }
    if (monthBudgetRev > 0 || monthBudgetProfit > 0) {
      latestTarget = { '月目标收入': monthBudgetRev, '月目标利润': monthBudgetProfit, '实际收入': monthActualRev, '实际利润': monthActualProfit };
    }
  } else {
    // 2026-04-23 修复：选"最新预算月"时同样遵守 cutoffYm，避免挑到未来/本月预算行作对比
    let latestYm = 0, latestBudgetRev = 0, latestBudgetProfit = 0;
    for (const r of performanceTargets) {
      if (!_inScope(r)) continue;
      const f = r.fields || {};
      const { year: yr, month: mo } = parseMonth4(f['月份']);
      const ym = yr * 100 + mo;
      if (ym > cutoffYmFull) continue;
      if (ym > latestYm) {
        latestYm = ym; latestBudgetRev = Number(f['履约收入']) || 0; latestBudgetProfit = Number(f['履约利润']) || 0;
      }
    }
    if (latestYm > 0) {
      let latestActualRev = 0, latestActualProfit = 0;
      for (const r of projectMonthly) {
        const f = r.fields || {};
        const { year: yr, month: mo } = parseMonth4(f['月份']);
        if (yr * 100 + mo === latestYm) {
          latestActualRev += Number(f['履约收入']) || 0;
          latestActualProfit += Number(f['履约利润']) || 0;
        }
      }
      latestTarget = { '月目标收入': latestBudgetRev, '月目标利润': latestBudgetProfit, '实际收入': latestActualRev, '实际利润': latestActualProfit };
    }
  }

  if (latestTarget) {
    const targetRevenue = Number(latestTarget['月目标收入']) || 0;
    const targetProfit  = Number(latestTarget['月目标利润']) || 0;
    const actualRevenue = Number(latestTarget['实际收入']) || 0;
    const actualProfit  = Number(latestTarget['实际利润']) || 0;

    if (targetRevenue > 0) {
      metrics['收入完成率'] = (actualRevenue / targetRevenue) * 100;
    }
    if (targetProfit > 0) {
      metrics['利润完成率'] = (actualProfit / targetProfit) * 100;
    }
    metrics['目标收入'] = targetRevenue;
    metrics['目标利润'] = targetProfit;
    metrics['实际收入'] = actualRevenue;
    metrics['实际利润'] = actualProfit;

    // 2026-04-21 P0：新增"年度目标进度"（YTD 实际 / 全年预算），便于下游区分两种口径
    if (period === 'ytd' && fullYearTargetRev > 0) {
      metrics['年度目标进度-收入'] = (actualRevenue / fullYearTargetRev) * 100;
    }
    if (period === 'ytd' && fullYearTargetProfit > 0) {
      metrics['年度目标进度-利润'] = (actualProfit / fullYearTargetProfit) * 100;
    }
  }

  // —— 预算人力成本（BUDGET_PROJECT.人力成本），用于预算人均月成本 = 预算人力成本 / 预算 FTE ——
  let budgetLaborCost = 0;
  const budgetProjectLaborCost = {};
  if (Array.isArray(performanceTargets) && performanceTargets.length > 0) {
    const addBudgetLabor = (rec) => {
      const f = rec.fields || {};
      const laborCost = Number(f['人力成本']) || 0;
      if (!laborCost) return;
      budgetLaborCost += laborCost;
      const key = _extractKey(f['是否交付项目']) || _extractKey(f['26年项目名称']) || _extractKey(f['项目名称（管报）']);
      if (key) budgetProjectLaborCost[key] = (budgetProjectLaborCost[key] || 0) + laborCost;
    };

    if (period === 'ytd') {
      const capMonth = (periodYear === currentYear) ? (cutoffYm % 100) : 12;
      for (const r of performanceTargets) {
        const f = r.fields || {};
        const { year: yr, month: mo } = parseMonth4(f['月份']);
        if (yr !== periodYear) continue;
        if (!mo || mo > capMonth) continue;
        addBudgetLabor(r);
      }
    } else if (typeof period === 'object' && period.year && period.month) {
      const targetYm = period.year * 100 + period.month;
      for (const r of performanceTargets) {
        const f = r.fields || {};
        const { year: yr, month: mo } = parseMonth4(f['月份']);
        if (yr * 100 + mo === targetYm) addBudgetLabor(r);
      }
    } else {
      // latest：按项目取截止期内最新预算月，避免把多个月预算累加成单月口径。
      const latestByProject = {};
      for (const r of performanceTargets) {
        const f = r.fields || {};
        const { year: yr, month: mo } = parseMonth4(f['月份']);
        const ym = yr * 100 + mo;
        if (!ym || ym > cutoffYmFull) continue;
        const key = _extractKey(f['是否交付项目']) || _extractKey(f['26年项目名称']) || _extractKey(f['项目名称（管报）']) || '(unknown)';
        if (!latestByProject[key] || ym > latestByProject[key].ym) {
          latestByProject[key] = { ym, rec: r };
        }
      }
      for (const item of Object.values(latestByProject)) addBudgetLabor(item.rec);
    }
  }
  if (budgetLaborCost !== 0) {
    metrics['预算人力成本'] = budgetLaborCost;
    metrics['_budgetProjectLaborCost'] = budgetProjectLaborCost;
  }

  // —— 履约偏差指标（实际 vs 目标，支持负目标）——
  if (latestTarget) {
    const targetRevenue = Number(latestTarget['月目标收入']) || 0;
    const actualRevenue = Number(latestTarget['实际收入']) || 0;
    if (targetRevenue !== 0) {
      metrics['履约偏差率'] = ((actualRevenue - targetRevenue) / Math.abs(targetRevenue)) * 100;
    } else {
      metrics['履约偏差率'] = 0;
    }
    const targetProfit = Number(latestTarget['月目标利润']) || 0;
    const actualProfit = Number(latestTarget['实际利润']) || 0;
    if (targetProfit !== 0) {
      metrics['利润偏差率'] = ((actualProfit - targetProfit) / Math.abs(targetProfit)) * 100;
    } else {
      metrics['利润偏差率'] = 0;
    }
  }

  // —— 单项目利润率分析（找出亏损项目）——
  // 口径（2026-04-17 修正）：
  //   亏损项目    = profit < 0（不管 revenue 是否为 0，管理/支撑/商务等纯成本支出也计入）
  //   低毛利项目  = profit >= 0 且 revenue > 0 且 rate ∈ [0, 10)（排除 0 收入避免错归类）
  //   纯成本项目  = profit < 0 且 revenue = 0（从亏损项目中再细分出来，便于可选回答口径）
  const projectProfitRates = {};
  const lossProjectExcludedByStatus = [];
  let lossProjectCount = 0;         // profit < 0 且项目状态在亏损统计口径内
  let pureCostLossCount = 0;        // 亏损统计口径内，profit < 0 且 revenue = 0
  let deliveryLossCount = 0;        // 亏损统计口径内，profit < 0 且 revenue > 0（业务交付型亏损）
  let lowMarginProjectCount = 0;    // profit >= 0 且 revenue > 0 且 rate < 10
  for (const [key, s] of Object.entries(projectStats)) {
    const rate = s.revenue > 0 ? (s.profit / s.revenue) * 100 : 0;
    const isPureCost = s.revenue === 0 && s.profit < 0;
    const status = _textValue(s.status || projectStatusIndex.get(key));
    const lossStatusEligible = isLossProjectStatusEligible(status);
    projectProfitRates[key] = {
      revenue: s.revenue, cost: s.cost, profit: s.profit, laborCost: s.laborCost || 0, rate,
      isPureCost,
      status,
      lossStatusEligible,
      isNonProject: !lossStatusEligible,
    };
    if (s.profit < 0) {
      if (lossStatusEligible) {
        lossProjectCount++;
        if (isPureCost) pureCostLossCount++;
        else deliveryLossCount++;
      } else {
        lossProjectExcludedByStatus.push({
          key,
          status: status || '(空)',
          profit: s.profit,
        });
      }
    } else if (s.revenue > 0 && rate < 10) {
      lowMarginProjectCount++;
    }
  }
  metrics['亏损项目数'] = lossProjectCount;
  metrics['纯成本亏损项目数'] = pureCostLossCount;
  metrics['交付亏损项目数'] = deliveryLossCount;
  metrics['低利润项目数'] = lowMarginProjectCount;
  metrics['_projectProfitRates'] = projectProfitRates;
  metrics['_lossProjectStatusFilter'] = Array.from(LOSS_PROJECT_STATUSES);
  metrics['_lossProjectExcludedByStatus'] = lossProjectExcludedByStatus;

  // —— 人力成本指标（FTE 投入分析，支持 period）——
  //
  // 口径说明（2026-04-20 修订，避免 Agent 误用）：
  //   · 累计 FTE·月 (manpowerMonths)：周期内所有月的精力之和（人力投入总量）
  //     例：3 个月 1 人满岗 = 3.0 FTE·月
  //   · 月均 FTE (fteMonthlyAvg)：累计 ÷ 覆盖月份数（平均每月在编人力）
  //     例：3 个月 1 人满岗 = 1.0 月均 FTE
  //   · 参与人次 (peopleCount)：周期内唯一出现过的人名数（不按月去重）
  //     例：3 个月各换 1 人 = 3 人参与
  //
  // 为兼容旧代码，`当月总FTE` 在 YTD 下仍输出"月均 FTE"；
  // 新增 `FTE累计人月` / `FTE覆盖月份数` / `_projectFTEYtd` / `_projectPeople` 暴露累计口径与人数。
  if (effectiveProjectStaffing.length > 0) {
    let fteYear, fteMonth, isYtdFTE = false;
    if (period === 'ytd') {
      fteYear = periodYear;
      isYtdFTE = true;
    } else if (typeof period === 'object' && period.year && period.month) {
      fteYear = period.year;
      fteMonth = period.month;
    } else {
      fteYear = currentYear;
      fteMonth = currentMonth;
    }

    let totalFTEYtd = 0;                     // 累计 FTE·月（原始累加）
    const projectFTEYtd = {};                // { projKey: 累计 FTE·月 }
    const projectPeople = {};                // { projKey: Set<姓名> }
    const personSetAll = new Set();          // 全局参与人次
    const ytdMonthSet = new Set();
    // 2026-05-08 M5：按月度记录 FTE，供 laborCost 输出 monthlyByDept / byProject.monthly 字段
    //   这样 LLM 就有可索引的月度网格，不会再凭"4个月汇总"反推单月填"暂无"
    const projectFTEByMonth = {};            // { projKey: { mo: { fte, people: Set } } }
    const deptFTEByMonth    = {};            // { dept:    { mo: { fte, people: Set } } }
    // 2026-05-11：人员维度预实对比需要项目×人员的同口径 FTE 聚合。
    //   这里与项目级 FTE 使用同一批实际工时、同一时间裁剪，避免 Answer 从 memoryDigest 摘要自行拼表。
    const projectPersonFTEYtd = {};           // { projKey: { personName: 累计 FTE } }
    const projectPersonFTEByMonth = {};       // { projKey: { personName: { mo: FTE } } }
    const projectPersonRecordCount = {};      // { projKey: 参与聚合的人员工时记录数 }
    for (const r of effectiveProjectStaffing) {
      const f = r.fields || {};
      const { year, month } = parseMonth4(f['月份-转换'] || f['月份']);
      if (isYtdFTE) {
        if (year !== fteYear) continue;
        if (month && (year * 100 + month) > cutoffYmFull) continue;
        ytdMonthSet.add(month);
      } else {
        if (year !== fteYear || month !== fteMonth) continue;
      }
      const effort = Number(f['精力']) || 0;
      if (effort <= 0) continue;
      const projKey = lookupFirst(f['匹配项目']) || f['标准项目名称新'] || '';
      const person = f['姓名'] || '';
      const dept = f['管报-一级部门（手工）'] || f['一级部门'] || '';
      totalFTEYtd += effort;
      // 2026-05-08 M5：月度 key 用 YYMM 格式（如 2601 = 26年1月），与 ACTUAL_DEPT.月份 对齐
      const ymKey = month ? ((fteYear % 100) * 100 + month) : 0;
      if (projKey) {
        projectFTEYtd[projKey] = (projectFTEYtd[projKey] || 0) + effort;
        if (person) {
          if (!projectPeople[projKey]) projectPeople[projKey] = new Set();
          projectPeople[projKey].add(person);
          if (!projectPersonFTEYtd[projKey]) projectPersonFTEYtd[projKey] = {};
          projectPersonFTEYtd[projKey][person] = (projectPersonFTEYtd[projKey][person] || 0) + effort;
          projectPersonRecordCount[projKey] = (projectPersonRecordCount[projKey] || 0) + 1;
        }
        if (ymKey) {
          if (!projectFTEByMonth[projKey]) projectFTEByMonth[projKey] = {};
          if (!projectFTEByMonth[projKey][ymKey]) projectFTEByMonth[projKey][ymKey] = { fte: 0, people: new Set() };
          projectFTEByMonth[projKey][ymKey].fte += effort;
          if (person) projectFTEByMonth[projKey][ymKey].people.add(person);
          if (person) {
            if (!projectPersonFTEByMonth[projKey]) projectPersonFTEByMonth[projKey] = {};
            if (!projectPersonFTEByMonth[projKey][person]) projectPersonFTEByMonth[projKey][person] = {};
            projectPersonFTEByMonth[projKey][person][ymKey] =
              (projectPersonFTEByMonth[projKey][person][ymKey] || 0) + effort;
          }
        }
      }
      if (dept && ymKey) {
        if (!deptFTEByMonth[dept]) deptFTEByMonth[dept] = {};
        if (!deptFTEByMonth[dept][ymKey]) deptFTEByMonth[dept][ymKey] = { fte: 0, people: new Set() };
        deptFTEByMonth[dept][ymKey].fte += effort;
        if (person) deptFTEByMonth[dept][ymKey].people.add(person);
      }
      if (person) personSetAll.add(person);
    }

    const monthsCovered = isYtdFTE ? Math.max(ytdMonthSet.size, 1) : 1;
    // 月均 FTE：YTD 时 = 累计 / 覆盖月数；非 YTD（单月）时 = 累计本身
    const totalFTEMonthlyAvg = totalFTEYtd / monthsCovered;
    const projectFTEMonthlyAvg = {};
    for (const k of Object.keys(projectFTEYtd)) {
      projectFTEMonthlyAvg[k] = projectFTEYtd[k] / monthsCovered;
    }
    const projectPeopleCount = {};
    for (const k of Object.keys(projectPeople)) {
      projectPeopleCount[k] = projectPeople[k].size;
    }

    // 兼容旧口径：外部消费者（包含 profitOverview / analytics-tools）用的仍是月均 FTE
    metrics['当月总FTE'] = totalFTEMonthlyAvg;
    metrics['当月项目数_有人员'] = Object.keys(projectFTEYtd).length;
    metrics['_projectFTE'] = projectFTEMonthlyAvg;

    // 新增累计口径（供 laborCost / Answer prompt 明确表达）
    metrics['FTE累计人月'] = totalFTEYtd;
    metrics['FTE覆盖月份数'] = monthsCovered;
    metrics['FTE参与人次'] = personSetAll.size;
    metrics['_projectFTEYtd'] = projectFTEYtd;
    metrics['_projectPeople'] = projectPeopleCount;
    // 2026-05-08 M5：月度网格（项目×月、部门×月），供 laborCost 输出 monthlyByDept
    metrics['_projectFTEByMonth'] = projectFTEByMonth;
    metrics['_deptFTEByMonth'] = deptFTEByMonth;
    // 2026-05-11：项目×人员实际 FTE，供 laborCost.personBudgetCompare 使用。
    metrics['_actualProjectPersonFTEYtd'] = projectPersonFTEYtd;
    metrics['_actualProjectPersonFTEByMonth'] = projectPersonFTEByMonth;
    metrics['_actualProjectPersonRecordCount'] = projectPersonRecordCount;
    // 暴露给下方 budget 聚合做"同期对比"
    metrics['_actualYtdMonthSet'] = isYtdFTE ? [...ytdMonthSet] : (fteMonth ? [fteMonth] : []);

    // 人均创收 / FTE人均成本：单位统一为"元/FTE·月"（每个 FTE 一个月贡献/承担多少）
    // 2026-04-20 口径修正：之前错写成 YTD累计收入 ÷ 月均FTE，结果单位是"元·月/FTE"，
    //   在 YTD 下会被放大 monthsCovered 倍（3 个月就放大 3 倍）。
    //   正确做法：YTD累计收入 ÷ 累计 FTE·月（= totalFTEYtd）= 真正"每 FTE 每月贡献多少元"。
    //   对单月请求 monthsCovered=1，两种算法结果相同，所以不影响单月报表。
    if (totalRevenue > 0 && totalFTEYtd > 0) {
      metrics['人均创收'] = totalRevenue / totalFTEYtd;
    }
    if (totalFTEYtd > 0) {
      metrics['FTE人均成本'] = totalLaborCost / totalFTEYtd;
    }
  }

  // ==================== 2026-04-23 方案 C：预算工时聚合（与实际同口径）====================
  // 目标：让 finance.laborCost 能直接输出"实际 vs 预算"的超编清单
  // 数据来源：memory.budgetWorktime（BUDGET_WORKTIME）通过 opts.budgetStaffing 透传
  // 聚合规则：与上面 projectStaffing 完全一致，保证 actual vs budget 可直接做 key-by-key diff
  const budgetStaffing = opts && opts.budgetStaffing;
  if (Array.isArray(budgetStaffing) && budgetStaffing.length > 0) {
    const budgetWorktimeCaliber = filterBudgetWorktimeRows(budgetStaffing);
    metrics['_worktimeCaliber'].budget = budgetWorktimeCaliber.summary;
    const effectiveBudgetStaffing = budgetWorktimeCaliber.rows;
    let budYear, budMonth, isBudYtd = false;
    if (period === 'ytd') {
      budYear = periodYear;
      isBudYtd = true;
    } else if (typeof period === 'object' && period.year && period.month) {
      budYear = period.year;
      budMonth = period.month;
    } else {
      budYear = currentYear;
      budMonth = currentMonth;
    }

    // 同期对比约束：预算表可能包含未来月份（如 1-5 月全年 forecast），
    // 但实际表只有 YTD 已发生月份（如 1-3 月），必须把预算限制到与 actual 相同月份集合，
    // 否则会把"3 个月实际"与"5 个月预算"混比，超编率失真（实际可能变负，因为分母变大）。
    // 2026-04-23 方案 C 核心约束：预实对比必须同期
    const actualMonths = Array.isArray(metrics['_actualYtdMonthSet']) ? metrics['_actualYtdMonthSet'] : [];
    const monthWhitelist = new Set(actualMonths);

    let budTotalYtd = 0;
    const budProjectFTEYtd = {};
    const budDeptFTEYtd = {};
    const budMonthSet = new Set();
    let _budRecSkippedFuture = 0;
    // 2026-05-08 M5：预算月度网格（项目×月、部门×月），用于单月超编对比
    const budProjectFTEByMonth = {};
    const budDeptFTEByMonth    = {};
    // 2026-05-11：项目×人员预算 FTE，与项目级预算使用同一时间裁剪和同一项目 key。
    const budProjectPersonFTEYtd = {};        // { projKey: { personName: 累计预算 FTE } }
    const budProjectPersonFTEByMonth = {};    // { projKey: { personName: { mo: 预算 FTE } } }
    const budProjectPersonRecordCount = {};   // { projKey: 参与聚合的人员预算工时记录数 }
    const actualProjectKeys = new Set(Object.keys(metrics['_projectFTEYtd'] || {}));
    for (const r of effectiveBudgetStaffing) {
      const f = r.fields || {};
      const { year, month } = parseMonth4(f['月份-转换'] || f['月份']);
      if (isBudYtd) {
        if (year !== budYear) continue;
        if (monthWhitelist.size > 0 && !monthWhitelist.has(month)) { _budRecSkippedFuture++; continue; }
        if (monthWhitelist.size === 0 && month && (year * 100 + month) > cutoffYmFull) { _budRecSkippedFuture++; continue; }
        budMonthSet.add(month);
      } else {
        if (year !== budYear || month !== budMonth) continue;
      }
      const effort = Number(f['精力']) || 0;
      if (effort <= 0) continue;
      const projKey = _resolveBudgetWorktimeProjectKey(f, actualProjectKeys);
      const person = f['姓名'] || '';
      const dept    = f['管报-一级部门（手工）'] || f['一级部门'] || '';
      budTotalYtd += effort;
      const ymKey = month ? ((budYear % 100) * 100 + month) : 0;
      if (projKey) {
        budProjectFTEYtd[projKey] = (budProjectFTEYtd[projKey] || 0) + effort;
        if (person) {
          if (!budProjectPersonFTEYtd[projKey]) budProjectPersonFTEYtd[projKey] = {};
          budProjectPersonFTEYtd[projKey][person] = (budProjectPersonFTEYtd[projKey][person] || 0) + effort;
          budProjectPersonRecordCount[projKey] = (budProjectPersonRecordCount[projKey] || 0) + 1;
        }
        if (ymKey) {
          if (!budProjectFTEByMonth[projKey]) budProjectFTEByMonth[projKey] = {};
          budProjectFTEByMonth[projKey][ymKey] = (budProjectFTEByMonth[projKey][ymKey] || 0) + effort;
          if (person) {
            if (!budProjectPersonFTEByMonth[projKey]) budProjectPersonFTEByMonth[projKey] = {};
            if (!budProjectPersonFTEByMonth[projKey][person]) budProjectPersonFTEByMonth[projKey][person] = {};
            budProjectPersonFTEByMonth[projKey][person][ymKey] =
              (budProjectPersonFTEByMonth[projKey][person][ymKey] || 0) + effort;
          }
        }
      }
      if (dept) {
        budDeptFTEYtd[dept] = (budDeptFTEYtd[dept] || 0) + effort;
        if (ymKey) {
          if (!budDeptFTEByMonth[dept]) budDeptFTEByMonth[dept] = {};
          budDeptFTEByMonth[dept][ymKey] = (budDeptFTEByMonth[dept][ymKey] || 0) + effort;
        }
      }
    }
    if (_budRecSkippedFuture > 0) {
      logger.info(`[Risk-Engine] 预算工时 同期对比裁剪：跳过 actual 月份外 ${_budRecSkippedFuture} 条（budget 可能含未来月份 forecast）`);
    }
    const budMonthsCovered = isBudYtd ? Math.max(budMonthSet.size, 1) : 1;

    const budProjectFTEMonthlyAvg = {};
    for (const k of Object.keys(budProjectFTEYtd)) budProjectFTEMonthlyAvg[k] = budProjectFTEYtd[k] / budMonthsCovered;
    const budDeptFTEMonthlyAvg = {};
    for (const k of Object.keys(budDeptFTEYtd)) budDeptFTEMonthlyAvg[k] = budDeptFTEYtd[k] / budMonthsCovered;

    metrics['FTE预算累计人月']      = budTotalYtd;
    metrics['FTE预算覆盖月份数']    = budMonthsCovered;
    metrics['FTE预算月均']          = budTotalYtd / budMonthsCovered;
    if (budTotalYtd > 0 && (metrics['预算人力成本'] || 0) !== 0) {
      metrics['预算FTE人均成本'] = metrics['预算人力成本'] / budTotalYtd;
    }
    metrics['_budgetProjectFTEYtd']        = budProjectFTEYtd;
    metrics['_budgetProjectFTEMonthlyAvg'] = budProjectFTEMonthlyAvg;
    metrics['_budgetDeptFTEYtd']           = budDeptFTEYtd;
    metrics['_budgetDeptFTEMonthlyAvg']    = budDeptFTEMonthlyAvg;
    // 2026-05-08 M5：预算月度网格暴露
    metrics['_budgetProjectFTEByMonth']    = budProjectFTEByMonth;
    metrics['_budgetDeptFTEByMonth']       = budDeptFTEByMonth;
    // 2026-05-11：项目×人员预算 FTE，供人员维度预实对比使用。
    metrics['_budgetProjectPersonFTEYtd'] = budProjectPersonFTEYtd;
    metrics['_budgetProjectPersonFTEByMonth'] = budProjectPersonFTEByMonth;
    metrics['_budgetProjectPersonRecordCount'] = budProjectPersonRecordCount;
  }

  // —— 员工档案维度指标 ——
  if (profile) {
    const onJobStatus = profile['在岗状态'] || profile['员工状态'] || '';
    metrics['在岗状态文本'] = onJobStatus;
  }

  // —— 按部门汇总指标（部门人效 / 部门营收，支持 period）——
  if (projectMaster && projectMaster.length > 0 && effectiveProjectStaffing.length > 0) {
    let deptFteYear, deptFteMonth, isDeptYtd = false;
    if (period === 'ytd') {
      deptFteYear = periodYear;
      isDeptYtd = true;
    } else if (typeof period === 'object' && period.year && period.month) {
      deptFteYear = period.year;
      deptFteMonth = period.month;
    } else {
      deptFteYear = currentYear;
      deptFteMonth = currentMonth;
    }

    const deptRevenue = {};
    const deptFTE = {};
    const deptCost = {};
    const deptLaborCost = {};
    for (const r of projectMaster) {
      const f = r.fields || {};
      const key = f['26年项目名称'] || '';
      const dept = f['项目归属部门'] || f['一级部门'] || '';
      if (!key || !dept) continue;
      const stat = projectStats[key];
      if (stat) {
        deptRevenue[dept] = (deptRevenue[dept] || 0) + stat.revenue;
        deptCost[dept] = (deptCost[dept] || 0) + stat.cost;
        deptLaborCost[dept] = (deptLaborCost[dept] || 0) + (stat.laborCost || 0);
      }
    }
    const deptYtdMonths = new Set();
    const deptFTEYtd = {};                          // 累计 FTE·月（保留原始累加）
    for (const r of effectiveProjectStaffing) {
      const f = r.fields || {};
      const { year, month } = parseMonth4(f['月份-转换'] || f['月份']);
      if (isDeptYtd) {
        if (year !== deptFteYear) continue;
        // 2026-04-23 修复：部门 FTE YTD 同样截止 cutoffYm
        if (month && (year * 100 + month) > cutoffYmFull) continue;
        deptYtdMonths.add(month);
      } else {
        if (year !== deptFteYear || month !== deptFteMonth) continue;
      }
      const dept = f['管报-一级部门（手工）'] || f['一级部门'] || '';
      const effort = Number(f['精力']) || 0;
      if (dept && effort > 0) {
        deptFTEYtd[dept] = (deptFTEYtd[dept] || 0) + effort;
      }
    }
    const deptMonthsCovered = isDeptYtd ? Math.max(deptYtdMonths.size, 1) : 1;
    // 月均 FTE：累计÷覆盖月数（兼容旧字段 `_deptFTE`）
    for (const key of Object.keys(deptFTEYtd)) {
      deptFTE[key] = deptFTEYtd[key] / deptMonthsCovered;
    }

    let totalDeptFTEYtd = 0;
    for (const fte of Object.values(deptFTEYtd)) totalDeptFTEYtd += fte;
    // 部门人效：用累计人月作分母，单位"元/FTE·月"
    if (totalDeptFTEYtd > 0 && totalRevenue > 0) {
      metrics['部门人效'] = totalRevenue / totalDeptFTEYtd;
    }
    metrics['_deptRevenue'] = deptRevenue;
    metrics['_deptFTE'] = deptFTE;                 // 月均（保留兼容）
    metrics['_deptFTEYtd'] = deptFTEYtd;           // 累计（新增）
    metrics['_deptMonthsCovered'] = deptMonthsCovered;
    metrics['_deptCost'] = deptCost;
    metrics['_deptLaborCost'] = deptLaborCost;
  }

  // —— 项目人效（按项目维度：项目收入 / 项目FTE）——
  if (metrics['_projectFTE'] && metrics['_projectProfitRates']) {
    const projectFTE = metrics['_projectFTE'];
    const projRates = metrics['_projectProfitRates'];
    let minProjectEfficiency = Infinity;
    const projectEfficiencies = {};
    for (const [key, fte] of Object.entries(projectFTE)) {
      if (fte <= 0) continue;
      const rev = (projRates[key] || {}).revenue || 0;
      const eff = rev / fte;
      projectEfficiencies[key] = eff;
      if (eff < minProjectEfficiency) minProjectEfficiency = eff;
    }
    if (minProjectEfficiency < Infinity) {
      metrics['项目人效'] = minProjectEfficiency;
    }
    metrics['_projectEfficiencies'] = projectEfficiencies;
  }

  // —— 节损指标（利润为负的项目的损失分析）——
  let totalLoss = 0;
  let lossMonthCount = 0;
  const monthProfits = {};
  for (const r of projectMonthly) {
    const f = r.fields || {};
    const { year: yr, month: mo } = parseMonth4(f['月份']);
    const ym = yr * 100 + mo;
    if (!ym) continue;
    const profit = Number(f['履约利润']) || 0;
    monthProfits[ym] = (monthProfits[ym] || 0) + profit;
  }
  const sortedMonths = Object.keys(monthProfits).sort((a, b) => Number(b) - Number(a));
  let consecutiveLossMonths = 0;
  for (const ym of sortedMonths) {
    if (monthProfits[ym] < 0) {
      consecutiveLossMonths++;
      totalLoss += Math.abs(monthProfits[ym]);
    } else {
      break;
    }
  }
  if (sortedMonths.length > 0) {
    const latestProfit = monthProfits[sortedMonths[0]] || 0;
    if (latestProfit < 0) {
      const latestRevenue = _sumMonthlyField(projectMonthly, Number(sortedMonths[0]), '履约收入');
      metrics['节损额'] = Math.abs(latestProfit);
      if (latestRevenue > 0) {
        metrics['节损率'] = (Math.abs(latestProfit) / latestRevenue) * 100;
      }
    }
  }
  if (consecutiveLossMonths > 0) {
    metrics['节损周期'] = consecutiveLossMonths;
    metrics['利润连续节损'] = '节损';
  }
  metrics['累计节损'] = totalLoss;

  // —— 合同状态（从 PROJECT_MASTER 中查找已运营但未签合同的项目）——
  if (projectMaster && projectMaster.length > 0) {
    const activeStatuses = ['执行中', '在建', '进行中', '实施中'];
    for (const r of projectMaster) {
      const f = r.fields || {};
      const status = f['项目状态'] || '';
      const contractStatus = f['合同状态'] || '';
      const isActive = activeStatuses.some(s => status.includes(s));
      if (isActive && (contractStatus === '未签合同' || contractStatus.includes('未签'))) {
        metrics['合同状态'] = '未签合同';
        break;
      }
    }
  }

  // —— 月节损偏离预估（最新月利润 vs 目标利润的偏差）——
  if (latestTarget && sortedMonths.length > 0) {
    const latestProfit = monthProfits[sortedMonths[0]] || 0;
    const targetProfit = Number(latestTarget['月目标利润']) || 0;
    if (targetProfit > 0 && latestProfit < targetProfit) {
      metrics['月节损偏离预估比'] = ((targetProfit - latestProfit) / targetProfit) * 100;
    }
  }

  // —— 人力编制偏差（实际 FTE vs 预算 FTE）——
  if (metrics['_projectFTEYtd'] && metrics['_budgetProjectFTEYtd']) {
    const actualProjectFTE = metrics['_projectFTEYtd'];
    const budgetProjectFTE = metrics['_budgetProjectFTEYtd'];
    let maxOverstaffing = 0;
    const keys = new Set([...Object.keys(actualProjectFTE), ...Object.keys(budgetProjectFTE)]);
    for (const key of keys) {
      const diff = (actualProjectFTE[key] || 0) - (budgetProjectFTE[key] || 0);
      if (diff > maxOverstaffing) maxOverstaffing = diff;
    }
    metrics['人力编制偏差'] = maxOverstaffing;
  } else if (projectMaster && projectMaster.length > 0 && metrics['_projectFTE']) {
    // 兼容旧数据：没有预算工时表时才读取项目主档上的编制数字。
    const projectFTE = metrics['_projectFTE'];
    let maxOverstaffing = 0;
    for (const r of projectMaster) {
      const f = r.fields || {};
      const key = f['26年项目名称'] || '';
      const budgetedFTE = Number(f['编制人数'] || f['预算人数'] || 0);
      if (!key || budgetedFTE <= 0) continue;
      const actualFTE = projectFTE[key] || 0;
      const diff = actualFTE - budgetedFTE;
      if (diff > maxOverstaffing) maxOverstaffing = diff;
    }
    metrics['人力编制偏差'] = maxOverstaffing;
  }

  // —— 营收环比（上月 vs 上上月）——
  if (sortedMonths.length >= 2) {
    const curMonthRevenue = _sumMonthlyField(projectMonthly, Number(sortedMonths[0]), '履约收入');
    const prevMonthRevenue = _sumMonthlyField(projectMonthly, Number(sortedMonths[1]), '履约收入');
    if (prevMonthRevenue > 0) {
      metrics['部门营收预测环比'] = ((curMonthRevenue - prevMonthRevenue) / prevMonthRevenue) * 100;
    }
  }

  // —— 营收较3个月均值偏差 ——
  if (sortedMonths.length >= 4) {
    const curMonthRevenue = _sumMonthlyField(projectMonthly, Number(sortedMonths[0]), '履约收入');
    let sum3 = 0;
    for (let i = 1; i <= 3; i++) {
      sum3 += _sumMonthlyField(projectMonthly, Number(sortedMonths[i]), '履约收入');
    }
    const avg3 = sum3 / 3;
    if (avg3 > 0) {
      metrics['部门营收较3个月均值'] = ((curMonthRevenue - avg3) / avg3) * 100;
    }
  }

  return metrics;
}

function _sumMonthlyField(projectMonthly, targetYm, fieldName) {
  let sum = 0;
  for (const r of projectMonthly) {
    const f = r.fields || {};
    const { year, month } = parseMonth4(f['月份']);
    const ym = year * 100 + month;
    if (ym === targetYm) sum += Number(f[fieldName]) || 0;
  }
  return sum;
}

// ==================== 单条规则评估 ====================

/**
 * 判断单条规则是否触发
 * @param {object} ruleFields - 规则 .fields
 * @param {object} metrics    - extractMetrics 输出
 * @returns {{ triggered: boolean, actual: number|null }}
 */
function evaluateRule(ruleFields, metrics) {
  const indicatorName = (ruleFields['指标名称'] || '').trim();
  const operator = (ruleFields['比较符'] || '').trim();
  const threshold = parseFloat(ruleFields['阈值']);

  if (!indicatorName || !operator || isNaN(threshold)) {
    return { triggered: false, actual: null };
  }

  const actual = metrics[indicatorName];
  if (actual == null) {
    return { triggered: false, actual: null }; // 无数据，不触发
  }

  const compareFn = COMPARE_FNS[operator];
  if (!compareFn) {
    logger.warn(`[RuleEngine] 未知比较符: "${operator}"`);
    return { triggered: false, actual };
  }

  return { triggered: compareFn(Number(actual), threshold), actual };
}

// ==================== 角色适用性 ====================

/**
 * 判断规则是否适用于该用户角色
 * @param {string} applicableType - 规则的「适用对象类型」字段值
 * @param {string} userRole       - CEO | 项目总监 | 项目经理 | 管理者 | 组织部 | 员工
 * @returns {boolean}
 */
function isRuleApplicable(applicableType, userRole) {
  if (!applicableType) return true;
  const t = applicableType.toLowerCase();
  if (t.includes('全员') || t.includes('all')) return true;
  if (t.includes('ceo') || t.includes('总经理')) return userRole === 'CEO';
  if (t.includes('总监')) {
    return ['CEO', '项目总监'].includes(userRole);
  }
  if (t.includes('管理') || t.includes('经理')) {
    return ['CEO', '项目总监', '项目经理', '管理者'].includes(userRole);
  }
  if (t.includes('项目')) {
    return ['CEO', '项目总监', '项目经理', '管理者'].includes(userRole);
  }
  if (t.includes('员工')) return true;
  return false;
}

// ==================== 用户全量评估 ====================

/**
 * 对单个用户执行全部规则评估
 * @param {Array}  rules    - RISK_CONTROL_RULE 原始记录数组
 * @param {object} memory   - memoryManager.getUserMemory() 返回值
 * @param {string} userRole - CEO | 管理者 | 组织部 | 员工
 * @returns {Array} 触发的告警列表
 */
function evaluateUserRules(rules, memory, userRole) {
  const metrics = extractMetrics(
    memory.projectMonthly || [],
    memory.performanceTargets || [],
    memory.projectMaster || [],
    memory.profile,
    memory.projectStaffing || []
  );

  const alerts = [];
  for (const r of rules) {
    const f = r.fields || {};
    if (f['是否启用'] !== true && f['是否启用'] !== 'true') continue;
    if (!isRuleApplicable(f['适用对象类型'], userRole)) continue;

    const { triggered, actual } = evaluateRule(f, metrics);
    if (!triggered) continue;

    alerts.push({
      ruleName:       f['规则名称'] || '',
      level:          f['响应级别'] || '',
      color:          f['预警颜色'] || '',
      indicatorName:  f['指标名称'] || '',
      operator:       f['比较符'] || '',
      threshold:      f['阈值'],
      unit:           f['阈值单位'] || '',
      action:         f['调控动作'] || '',
      cyclePeriod:    f['连续周期要求'] || '',
      actualValue:    actual,
      applicableType: f['适用对象类型'] || '',
    });
  }

  return alerts;
}

// ==================== 逐项全量排查 ====================

/**
 * 对全部规则逐条排查，返回每条的达标/触发/数据缺失状态
 * @param {Array}  rules    - RISK_CONTROL_RULE 原始记录数组
 * @param {object} memory   - memoryManager.getUserMemory() 返回值
 * @param {string} userRole - CEO | 管理者 | 组织部 | 员工
 * @returns {Array<{ status: 'pass'|'triggered'|'nodata'|'skipped', ... }>}
 */
function fullCheckup(rules, memory, userRole) {
  const metrics = extractMetrics(
    memory.projectMonthly || [],
    memory.performanceTargets || [],
    memory.projectMaster || [],
    memory.profile,
    memory.projectStaffing || []
  );

  const results = [];
  for (const r of rules) {
    const f = r.fields || {};
    const ruleName      = f['规则名称'] || f['风险指标名称'] || '';
    const indicatorName = (f['指标名称'] || '').trim();
    const operator      = (f['比较符'] || '').trim();
    const threshold     = parseFloat(f['阈值']);
    const unit          = f['阈值单位'] || '';
    const color         = f['预警颜色'] || '';
    const level         = f['响应级别'] || '';
    const action        = f['调控动作'] || '';
    const cyclePeriod   = f['连续规则要求'] || f['连续周期要求'] || '';
    const applicable    = f['适用对象类型'] || '';
    const enabled       = f['是否启用'] === true || f['是否启用'] === 'true';

    if (!enabled) {
      results.push({
        status: 'skipped', ruleName, indicatorName, operator,
        threshold, unit, color, level, action, cyclePeriod,
        actualValue: null, reason: '规则未启用',
      });
      continue;
    }

    if (!isRuleApplicable(applicable, userRole)) {
      results.push({
        status: 'skipped', ruleName, indicatorName, operator,
        threshold, unit, color, level, action, cyclePeriod,
        actualValue: null, reason: '不适用于当前角色',
      });
      continue;
    }

    if (!indicatorName || !operator || isNaN(threshold)) {
      results.push({
        status: 'nodata', ruleName, indicatorName, operator,
        threshold, unit, color, level, action, cyclePeriod,
        actualValue: null, reason: '规则配置不完整',
      });
      continue;
    }

    const actual = metrics[indicatorName];
    if (actual == null) {
      results.push({
        status: 'nodata', ruleName, indicatorName, operator,
        threshold, unit, color, level, action, cyclePeriod,
        actualValue: null, reason: '暂无该指标数据',
      });
      continue;
    }

    const compareFn = COMPARE_FNS[operator];
    if (!compareFn) {
      results.push({
        status: 'nodata', ruleName, indicatorName, operator,
        threshold, unit, color, level, action, cyclePeriod,
        actualValue: actual, reason: `未知比较符 "${operator}"`,
      });
      continue;
    }

    const triggered = compareFn(Number(actual), threshold);
    results.push({
      status: triggered ? 'triggered' : 'pass',
      ruleName, indicatorName, operator, threshold, unit,
      color, level, action, cyclePeriod,
      actualValue: actual, reason: null,
    });
  }

  return results;
}

module.exports = {
  extractMetrics,
  evaluateRule,
  evaluateUserRules,
  fullCheckup,
  isRuleApplicable,
  LOSS_PROJECT_STATUSES,
  buildProjectStatusIndex,
  isLossProjectStatusEligible,
};
