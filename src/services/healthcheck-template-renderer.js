'use strict';

function fmtMoney(value) {
  if (value == null || Number.isNaN(Number(value))) return '--';
  const n = Number(value);
  if (n === 0) return '0万';
  return `${(n / 10000).toFixed(1)}万`;
}

function fmtPercent(value) {
  if (value == null || Number.isNaN(Number(value))) return '--';
  return `${Number(value).toFixed(1)}%`;
}

function fmtNumber(value, suffix = '') {
  if (value == null || Number.isNaN(Number(value))) return '--';
  return `${Number(value).toFixed(1)}${suffix}`;
}

function mdCell(value) {
  return String(value == null ? '--' : value)
    .replace(/\|/g, '｜')
    .replace(/\r?\n/g, ' ');
}

function table(headers, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '暂无可展示数据。';
  const head = `| ${headers.map(mdCell).join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map(row => `| ${row.map(mdCell).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

function pickDeptBudgetRow(budgetComparison, scope) {
  const rows = Array.isArray(budgetComparison && budgetComparison.byDept) ? budgetComparison.byDept : [];
  const depts = Array.isArray(scope && scope.depts) ? scope.depts : [];
  if (rows.length > 0 && depts.length > 0) {
    return rows.find(row => depts.includes(row.dept)) || rows[0];
  }

  const projectRows = Array.isArray(budgetComparison && budgetComparison.byProject) ? budgetComparison.byProject : [];
  if (projectRows.length === 0) return rows[0] || null;
  const aggregate = projectRows.reduce((acc, row) => {
    acc.budgetRevenue += Number(row.budgetRevenue || 0);
    acc.actualRevenue += Number(row.actualRevenue || 0);
    acc.budgetProfit += Number(row.budgetProfit || 0);
    acc.actualProfit += Number(row.actualProfit || 0);
    return acc;
  }, {
    dept: '负责项目预算合计',
    budgetRevenue: 0,
    actualRevenue: 0,
    budgetProfit: 0,
    actualProfit: 0,
  });
  const gap = aggregate.actualRevenue - aggregate.budgetRevenue;
  aggregate.gap = gap;
  aggregate.deviationRate = aggregate.budgetRevenue !== 0 ? +(gap / aggregate.budgetRevenue * 100).toFixed(1) : null;
  aggregate.level = aggregate.deviationRate != null && aggregate.deviationRate < -10 ? 'warning' : 'ok';
  return aggregate;
}

function buildScoreDetail(scoreDetail) {
  if (!scoreDetail || typeof scoreDetail !== 'object') return '--';
  const deducted = [];
  const notDeducted = [];
  for (const [key, raw] of Object.entries(scoreDetail)) {
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    if (value === 0) {
      notDeducted.push(key);
    } else {
      deducted.push(`${key} ${value > 0 ? '+' : ''}${value}`);
    }
  }
  if (deducted.length === 0 && notDeducted.length === 0) return '--';
  if (notDeducted.length === 0) return deducted.join('、');
  if (deducted.length === 0) return `未扣分：${notDeducted.join('、')}`;
  return `${deducted.join('、')}；未扣分：${notDeducted.join('、')}`;
}

function profitMetricLabel(healthCheck) {
  return healthCheck && healthCheck.profitView === 'allocated'
    ? '分摊后项目净利润'
    : '履约利润';
}

function bookedHealthCheckFromResults(results) {
  return results && results.bookedActual && results.bookedActual.healthCheck
    ? results.bookedActual.healthCheck
    : null;
}

function buildOverviewHeaders(currentMonthLabel, bookedHealthCheck) {
  if (!bookedHealthCheck) {
    return ['指标', '累计', currentMonthLabel ? `本月（${currentMonthLabel}）` : '本月'];
  }
  const rollbackMonthHeader = currentMonthLabel ? `${currentMonthLabel}（回滚）` : '本月（回滚）';
  const bookedMonthHeader = currentMonthLabel ? `${currentMonthLabel}（入账）` : '本月（入账）';
  return [
    '指标',
    '累计（回滚）',
    rollbackMonthHeader,
    '累计（入账）',
    bookedMonthHeader,
  ];
}

function buildOverviewCoreRows(healthCheck, bookedHealthCheck = null) {
  const pm = healthCheck.profitMetrics || {};
  const cm = pm.currentMonth || {};
  const profitLabel = profitMetricLabel(healthCheck);
  const rows = [
    ['履约收入', `**${fmtMoney(pm.revenue)}**`, cm.revenue != null ? `**${fmtMoney(cm.revenue)}**` : '--'],
    ['履约成本', `**${fmtMoney(pm.cost)}**`, cm.cost != null ? `**${fmtMoney(cm.cost)}**` : '--'],
    [profitLabel, `**${fmtMoney(pm.profit)}**`, cm.profit != null ? `**${fmtMoney(cm.profit)}**` : '--'],
    ['利润率', `**${fmtPercent(pm.profitRate)}**`, cm.profitRate != null ? `**${fmtPercent(cm.profitRate)}**` : '--'],
  ];
  if (!bookedHealthCheck) return rows;

  const bpm = bookedHealthCheck.profitMetrics || {};
  const bcm = bpm.currentMonth || {};
  const bookedValues = [
    [`**${fmtMoney(bpm.revenue)}**`, bcm.revenue != null ? `**${fmtMoney(bcm.revenue)}**` : '--'],
    [`**${fmtMoney(bpm.cost)}**`, bcm.cost != null ? `**${fmtMoney(bcm.cost)}**` : '--'],
    [`**${fmtMoney(bpm.profit)}**`, bcm.profit != null ? `**${fmtMoney(bcm.profit)}**` : '--'],
    [`**${fmtPercent(bpm.profitRate)}**`, bcm.profitRate != null ? `**${fmtPercent(bcm.profitRate)}**` : '--'],
  ];
  return rows.map((row, index) => [...row, ...bookedValues[index]]);
}

function buildOverviewRiskRows(healthCheck, budgetRow) {
  const pm = healthCheck.profitMetrics || {};
  const rm = healthCheck.receivableMetrics || {};
  const hm = healthCheck.humanMetrics || {};
  const efficiency = hm.perCapitaRevenue != null && Number(hm.totalFTE || 0) > 0
    ? `**${fmtMoney(hm.perCapitaRevenue)}**`
    : '--（无有效精力）';
  return [
    ['预算偏差', budgetRow && budgetRow.deviationRate != null
      ? `**${fmtPercent(budgetRow.deviationRate)}**（实际履约收入 ${fmtMoney(budgetRow.actualRevenue)} / 预算履约收入 ${fmtMoney(budgetRow.budgetRevenue)}）`
      : fmtPercent(pm.deviationRate),
    ],
    ['人效', efficiency],
    ['亏损项目数', `**${pm.lossCount || 0}个**`],
    ['逾期项目数', `**${rm.overdueProjectCount || 0}个**`],
    ['逾期金额', `**${fmtMoney(rm.overdueAmount || 0)}**${rm.overdueCount ? `（${rm.overdueCount}笔）` : ''}`],
  ];
}

function monthKey(row) {
  if (!row) return '';
  return row.month != null ? String(row.month) : String(row.monthLabel || row.month || '');
}

function sortMonthKeys(keys, rowByKey) {
  return [...keys].sort((a, b) => {
    const ar = rowByKey.get(a) || {};
    const br = rowByKey.get(b) || {};
    const av = Number(ar.month || a);
    const bv = Number(br.month || b);
    if (Number.isFinite(av) && Number.isFinite(bv) && av !== bv) return av - bv;
    return String(ar.monthLabel || a).localeCompare(String(br.monthLabel || b), 'zh-CN');
  });
}

function buildMonthlyHeaders(bookedHealthCheck, profitLabel) {
  if (!bookedHealthCheck) return ['月份', '履约收入', '履约成本', profitLabel, '利润率'];
  return [
    '月份',
    '履约收入（回滚）',
    '履约成本（回滚）',
    `${profitLabel}（回滚）`,
    '利润率（回滚）',
    '履约收入（入账）',
    '履约成本（入账）',
    '履约利润（入账）',
  ];
}

function buildMonthlyRows(profitTrend, healthCheck, bookedHealthCheck = null) {
  const series = Array.isArray(profitTrend && profitTrend.series)
    ? profitTrend.series
    : (healthCheck && healthCheck.monthlyTrend && Array.isArray(healthCheck.monthlyTrend.series) ? healthCheck.monthlyTrend.series : []);
  if (!bookedHealthCheck) {
    return series.map(row => [
      row.monthLabel || row.month || '--',
      fmtMoney(row.revenue),
      fmtMoney(row.cost),
      fmtMoney(row.profit),
      fmtPercent(row.profitRate),
    ]);
  }

  const bookedSeries = bookedHealthCheck && bookedHealthCheck.monthlyTrend && Array.isArray(bookedHealthCheck.monthlyTrend.series)
    ? bookedHealthCheck.monthlyTrend.series
    : [];
  const rollbackByKey = new Map(series.map(row => [monthKey(row), row]));
  const bookedByKey = new Map(bookedSeries.map(row => [monthKey(row), row]));
  const rowByKey = new Map([...rollbackByKey, ...bookedByKey]);
  const keys = sortMonthKeys(new Set([...rollbackByKey.keys(), ...bookedByKey.keys()]), rowByKey);
  return keys.map(key => {
    const rollback = rollbackByKey.get(key) || {};
    const booked = bookedByKey.get(key) || {};
    return [
      rollback.monthLabel || booked.monthLabel || rollback.month || booked.month || '--',
      rollback.revenue != null ? fmtMoney(rollback.revenue) : '--',
      rollback.cost != null ? fmtMoney(rollback.cost) : '--',
      rollback.profit != null ? fmtMoney(rollback.profit) : '--',
      rollback.profitRate != null ? fmtPercent(rollback.profitRate) : '--',
      booked.revenue != null ? fmtMoney(booked.revenue) : '--',
      booked.cost != null ? fmtMoney(booked.cost) : '--',
      booked.profit != null ? fmtMoney(booked.profit) : '--',
    ];
  });
}

function buildReceivableSummaryRows(receivables) {
  const ytd = receivables && receivables.breakdown && receivables.breakdown.ytd;
  if (!ytd) return [];
  return [
    ['回款计划履约额', fmtMoney(ytd.totalDelivered)],
    ['未回款', fmtMoney(ytd.totalOutstanding)],
    ['回款率', fmtPercent(ytd.collectRate)],
    ['本年实际到账', fmtMoney(ytd.totalReceivedByDate)],
  ];
}

function buildReceivableNote(bookedHealthCheck, receivables) {
  const base = bookedHealthCheck
    ? '回款情况按开票回款计划表统计；经营总览和月度趋势中，回滚列按项目层回滚实际表统计，入账列按经营实际表统计，两者可能因回款计划拆分、回滚分摊或数据维护时点存在差异。'
    : '回款情况按开票回款计划表统计；经营总览按经营实际表统计，两者可能因回款计划拆分或数据维护时点存在差异。';
  const filter = receivables && receivables._deptTypeFilter;
  const revenueTypeFilter = receivables && receivables._revenueTypeFilter;
  const notes = [base];
  if (filter && filter.enabled) {
    notes.push(`全公司权限下，回款情况仅统计部门类型=业务的记录，已排除后台/不计入/调整/无映射等非业务回款记录 ${filter.excludedCount || 0} 条。`);
  }
  if (revenueTypeFilter && revenueTypeFilter.enabled) {
    notes.push('回款计划履约额按预计首次回款时间/预计回款时间命中本年截至月的记录汇总履约收入；仅当两个预计回款字段都为空时，才用实际回款时间命中本年截至月兜底；未回款=回款计划履约额-本年实际到账；回款率=本年实际到账/回款计划履约额；本年实际到账仅统计基础服务费/GMV分成/代收/代垫款。');
  }
  return notes.join('');
}

function formatInvoiceMonth(month) {
  const s = String(month || '').replace(/[^0-9]/g, '');
  if (s.length < 4) return '';
  const mm = Number(s.slice(-2));
  return mm >= 1 && mm <= 12 ? `${mm}月` : '';
}

function formatDateYearMonth(value) {
  if (!value) return '';
  const raw = Array.isArray(value) ? value[0] : value;
  const text = String(raw || '').trim();
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 1e9) {
    const date = new Date(numeric > 1e12 ? numeric : numeric * 1000);
    if (!Number.isNaN(date.getTime())) {
      const yy = date.getFullYear();
      const mm = date.getMonth() + 1;
      return mm >= 1 && mm <= 12 ? `${yy}年${mm}月` : '';
    }
  }
  const m = text.match(/(\d{4})[\/\-.年](\d{1,2})/);
  if (!m) return '';
  const yy = Number(m[1]);
  const mm = Number(m[2]);
  return yy >= 1900 && mm >= 1 && mm <= 12 ? `${yy}年${mm}月` : '';
}

function buildOverdueMonthLabel(project) {
  const details = Array.isArray(project && project.overdueDetails) ? project.overdueDetails : [];
  const labels = new Map();
  for (const detail of details) {
    const dateLabel = formatDateYearMonth(detail.expectedDate);
    const label = dateLabel ? `预计回款${dateLabel}` : '';
    if (label && !labels.has(dateLabel)) labels.set(dateLabel, label);
  }
  return Array.from(labels.entries())
    .sort(([a], [b]) => {
      const ma = String(a).match(/(\d{4})年(\d{1,2})月/);
      const mb = String(b).match(/(\d{4})年(\d{1,2})月/);
      const ka = ma ? Number(ma[1]) * 100 + Number(ma[2]) : 0;
      const kb = mb ? Number(mb[1]) * 100 + Number(mb[2]) : 0;
      return ka - kb;
    })
    .map(([, label]) => label)
    .join('、') || '--';
}

function buildOverdueRows(receivables, healthCheck) {
  const projects = Array.isArray(receivables && receivables.projects) ? receivables.projects : [];
  if (projects.length > 0) {
    return projects
      .filter(project => Number(project.overdueCount || 0) > 0)
      .sort((a, b) => Number(b.overdueAmount || 0) - Number(a.overdueAmount || 0))
      .slice(0, 5)
      .map(project => [
        project.name,
        fmtMoney(project.overdueAmount),
        `${project.overdueCount || 0}笔`,
        buildOverdueMonthLabel(project),
      ]);
  }

  const overdueProjects = healthCheck && healthCheck.receivableMetrics && Array.isArray(healthCheck.receivableMetrics.overdueProjects)
    ? healthCheck.receivableMetrics.overdueProjects
    : [];
  return overdueProjects.slice(0, 5).map(line => [line, '--', '--', '--']);
}

function buildCostRows(costBreakdown, healthCheck) {
  const healthRows = healthCheck && healthCheck.costStructure && Array.isArray(healthCheck.costStructure.rows)
    ? healthCheck.costStructure.rows
    : null;
  const rows = healthRows || (Array.isArray(costBreakdown && costBreakdown.costStructure) ? costBreakdown.costStructure : []);
  return rows.slice(0, 8).map(row => [
    row.label,
    fmtMoney(row.amount),
    fmtPercent(row.percentage),
  ]);
}

function bookedProjectProfit(bookedActual, projectName) {
  const map = bookedActual && bookedActual.projectProfitByName;
  if (map && Object.prototype.hasOwnProperty.call(map, projectName)) return map[projectName];
  const projects = bookedActual && bookedActual.profitOverview && Array.isArray(bookedActual.profitOverview.projects)
    ? bookedActual.profitOverview.projects
    : [];
  const found = projects.find(project => (project.key || project.name) === projectName);
  return found || null;
}

function buildLossHeaders(bookedActual, profitLabel) {
  if (!bookedActual) return ['项目', profitLabel, '利润率', '亏损月份'];
  return ['项目', `${profitLabel}（回滚）`, '利润率（回滚）', '亏损月份（回滚）', '履约利润（入账）'];
}

function buildLossRows(healthCheck, costBreakdown, bookedActual = null) {
  const riskProjects = Array.isArray(healthCheck && healthCheck.riskProjects) ? healthCheck.riskProjects : [];
  if (Array.isArray(healthCheck && healthCheck.riskProjects)) {
    return riskProjects.slice(0, 5).map(project => [
      project.name,
      fmtMoney(project.profit),
      fmtPercent(project.profitRate),
      project.lossMonthLabel || (
        project.lossMonths != null && project.totalMonths != null ? `${project.lossMonths}个月` : '--'
      ),
      ...(bookedActual ? [fmtMoney((bookedProjectProfit(bookedActual, project.name) || {}).profit)] : []),
    ]);
  }

  const lossProjects = Array.isArray(costBreakdown && costBreakdown.lossProjects) ? costBreakdown.lossProjects : [];
  return lossProjects.slice(0, 5).map(project => [
    project.name,
    fmtMoney(project.profit),
    fmtPercent(project.profitRate),
    '--',
    ...(bookedActual ? [fmtMoney((bookedProjectProfit(bookedActual, project.name) || {}).profit)] : []),
  ]);
}

function buildBudgetRows(budgetRow, profitLabel = '履约利润') {
  if (!budgetRow) return [];
  return [
    ['履约收入', fmtMoney(budgetRow.budgetRevenue), fmtMoney(budgetRow.actualRevenue), fmtPercent(budgetRow.deviationRate)],
    [profitLabel, fmtMoney(budgetRow.budgetProfit), fmtMoney(budgetRow.actualProfit), fmtMoney(Number(budgetRow.actualProfit || 0) - Number(budgetRow.budgetProfit || 0))],
  ];
}

function buildActionItems({ overdueRows, lossRows, budgetRow }) {
  const lines = [];
  if (overdueRows.length > 0) {
    lines.push(`1. 优先推进 ${overdueRows[0][0]} 回款，当前逾期 ${overdueRows[0][1]}。`);
  }
  if (lossRows.length > 0) {
    lines.push(`${lines.length + 1}. 复盘 ${lossRows[0][0]} 的亏损原因，重点看交付投入、报价和客户验收节奏。`);
  }
  if (budgetRow && Number(budgetRow.gap || 0) < 0) {
    lines.push(`${lines.length + 1}. 跟进预算履约收入缺口，当前实际履约收入较同期预算少 ${fmtMoney(Math.abs(budgetRow.gap))}。`);
  }
  if (lines.length === 0) {
    lines.push('1. 当前未识别到明确红色动作项，建议继续关注利润率、回款率和预算偏差。');
  }
  return lines.join('\n');
}

function renderHealthcheckMarkdown({ recipientName, scope, results, generatedAt }) {
  const healthCheck = results.healthCheck || {};
  const profitLabel = profitMetricLabel(healthCheck);
  const profitTrend = results.profitTrend || {};
  const receivables = results.receivables || {};
  const costBreakdown = results.costBreakdown || {};
  const budgetComparison = results.budgetComparison || {};
  const budgetRow = pickDeptBudgetRow(budgetComparison, scope);
  const periodLabel = healthCheck._periodLabel || profitTrend._periodLabel || budgetComparison._periodLabel || '本期';
  const scopeLabel = healthCheck._scopeLabel || receivables._scopeLabel || (Array.isArray(scope && scope.depts) && scope.depts.length ? scope.depts.join('、') : '当前权限范围');
  const bookedHealthCheck = bookedHealthCheckFromResults(results);
  const bookedActual = results.bookedActual || null;

  const overviewCoreRows = buildOverviewCoreRows(healthCheck, bookedHealthCheck);
  const overviewRiskRows = buildOverviewRiskRows(healthCheck, budgetRow);
  const currentMonthLabel = healthCheck && healthCheck.profitMetrics && healthCheck.profitMetrics.currentMonth
    ? healthCheck.profitMetrics.currentMonth.shortMonthLabel
    : null;
  const monthlyRows = buildMonthlyRows(profitTrend, healthCheck, bookedHealthCheck);
  const receivableSummaryRows = buildReceivableSummaryRows(receivables);
  const overdueRows = buildOverdueRows(receivables, healthCheck);
  const costRows = buildCostRows(costBreakdown, healthCheck);
  const lossRows = buildLossRows(healthCheck, costBreakdown, bookedActual);
  const budgetRows = buildBudgetRows(budgetRow, profitLabel);
  const actionItems = buildActionItems({ overdueRows, lossRows, budgetRow });
  const overviewHeaders = buildOverviewHeaders(currentMonthLabel, bookedHealthCheck);
  const monthlyHeaders = buildMonthlyHeaders(bookedHealthCheck, profitLabel);
  const lossHeaders = buildLossHeaders(bookedActual, profitLabel);
  const receivableNote = buildReceivableNote(bookedHealthCheck, receivables);

  const lines = [
    `${recipientName}，以下为财务 Agent 按你当前权限生成的经营体检数据。`,
    '',
    `**生成时间**：${generatedAt}`,
    `**时间口径**：${periodLabel}`,
    `**数据范围**：${scopeLabel}`,
    '',
    '---',
    '',
    '**一、本期经营总览**',
    '',
    table(overviewHeaders, overviewCoreRows),
    '',
    table(['指标', '累计'], overviewRiskRows),
    '',
    `**健康度评分**：${healthCheck.healthScore ?? '--'} 分（${healthCheck.healthLevel || '--'}）`,
    `**健康度扣分项**：${buildScoreDetail(healthCheck.scoreDetail)}`,
    '',
    '---',
    '',
    '**二、月度趋势**',
    '',
    table(monthlyHeaders, monthlyRows),
    '',
    '---',
    '',
    '**三、回款情况**',
    '',
    table(['指标', '数值'], receivableSummaryRows),
    '',
    receivableNote,
    '',
    '**逾期 TOP 项目**',
    '',
    table(['项目', '逾期金额', '笔数', '逾期年月'], overdueRows),
    '',
    '---',
    '',
    '**四、成本结构**',
    '',
    table(['科目', '金额', '占比'], costRows),
    '',
    '**亏损 TOP 项目**',
    '',
    table(lossHeaders, lossRows),
    '',
    '---',
    '',
    '**五、预算执行**',
    '',
    table(['指标', '预算', '实际', '偏差'], budgetRows),
    '',
    '---',
    '',
    '**六、下期重点**',
    '',
    actionItems,
  ];

  return lines.join('\n');
}

module.exports = {
  renderHealthcheckMarkdown,
  fmtMoney,
  fmtPercent,
};
