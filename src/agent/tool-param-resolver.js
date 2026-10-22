'use strict';

const CN_NUM = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

const MAX_TOP = 50;

function _isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function _cnToNumber(raw) {
  const s = String(raw || '').replace(/[第前后名个项位\s]/g, '');
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  if (CN_NUM[s]) return CN_NUM[s];
  if (s.length === 2 && s[0] === '十' && CN_NUM[s[1]]) return 10 + CN_NUM[s[1]];
  if (s.length === 2 && s[1] === '十' && CN_NUM[s[0]]) return CN_NUM[s[0]] * 10;
  if (s.length === 3 && s[1] === '十' && CN_NUM[s[0]] && CN_NUM[s[2]]) {
    return CN_NUM[s[0]] * 10 + CN_NUM[s[2]];
  }
  return null;
}

function normalizeTop(value) {
  const n = typeof value === 'string' && !/^\d+$/.test(value.trim())
    ? _cnToNumber(value)
    : Number(value);
  if (!Number.isFinite(n)) return undefined;
  const int = Math.floor(n);
  if (int <= 0) return undefined;
  return Math.min(int, MAX_TOP);
}

function normalizeOrder(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'asc' || raw === 'ascending' || raw === 'low_to_high') return 'asc';
  if (raw === 'desc' || raw === 'descending' || raw === 'high_to_low') return 'desc';
  if (/升序|从低到高|最低|最少|最差/.test(raw)) return 'asc';
  if (/降序|从高到低|最高|最多|最大|最好/.test(raw)) return 'desc';
  return undefined;
}

function _normalizeProfitSortBy(value) {
  const raw = String(value || '').trim();
  const lower = raw.toLowerCase();
  if (['revenue', 'income', 'delivery_revenue'].includes(lower) || /收入|履约/.test(raw)) return 'revenue';
  if (['cost', 'expense'].includes(lower) || /成本|费用/.test(raw)) return 'cost';
  if (['profitrate', 'profit_rate', 'rate', 'margin'].includes(lower) || /利润率|毛利率|净利率/.test(raw)) return 'profitRate';
  if (['profit', 'loss', 'margin_amount'].includes(lower) || /利润|盈利|亏损/.test(raw)) return 'profit';
  return undefined;
}

function _normalizeReceivableSortBy(value) {
  const raw = String(value || '').trim();
  const lower = raw.toLowerCase();
  if (['collectrate', 'collect_rate', 'collectionrate', 'collection_rate', 'rate'].includes(lower) || /回款率|收款率/.test(raw)) return 'collectRate';
  if (['outstanding', 'unpaid', 'receivable', 'ar'].includes(lower) || /未回款|应收|没回|未收/.test(raw)) return 'outstanding';
  if (['received', 'receipt', 'actual_received'].includes(lower) || /已回款|已收|到账|实际收款|回款金额/.test(raw)) return 'received';
  if (['overdueamount', 'overdue_amount', 'overdue'].includes(lower) || /逾期金额|到期未回|超期/.test(raw)) return 'overdueAmount';
  if (['riskscore', 'risk_score', 'risk'].includes(lower) || /风险|账龄/.test(raw)) return 'riskScore';
  return undefined;
}

function _normalizeCostSortBy(value) {
  const raw = String(value || '').trim();
  const lower = raw.toLowerCase();
  if (['totalcost', 'total_cost', 'cost', 'expense'].includes(lower) || /总成本|成本|费用/.test(raw)) return 'totalCost';
  if (['amount', 'categoryamount', 'category_amount'].includes(lower) || /科目金额|金额/.test(raw)) return 'amount';
  if (['operatingcost', 'operating_cost'].includes(lower) || /经营成本|履约成本/.test(raw)) return 'operatingCost';
  if (['revenue', 'income'].includes(lower) || /收入|履约/.test(raw)) return 'revenue';
  if (['profit', 'loss'].includes(lower) || /利润|亏损/.test(raw)) return 'profit';
  if (['profitrate', 'profit_rate', 'margin'].includes(lower) || /利润率/.test(raw)) return 'profitRate';
  return undefined;
}

function _normalizeLaborSortBy(value) {
  const raw = String(value || '').trim();
  const lower = raw.toLowerCase();
  if (['manpowermonths', 'manpower_months', 'fte', '投入人力', '人力投入'].includes(lower) || /投入人力|人力投入|FTE|fte|工时/.test(raw)) return 'manpowerMonths';
  if (['peoplecount', 'people_count', 'headcount'].includes(lower) || /人数|人头|参与人数/.test(raw)) return 'peopleCount';
  if (['revenue', 'income'].includes(lower) || /收入/.test(raw)) return 'revenue';
  if (['laborcost', 'labor_cost', 'cost'].includes(lower) || /人力成本/.test(raw)) return 'laborCost';
  if (['profit', 'loss'].includes(lower) || /利润|亏损/.test(raw)) return 'profit';
  if (['profitrate', 'profit_rate'].includes(lower) || /利润率/.test(raw)) return 'profitRate';
  if (['percapitarevenue', 'per_capita_revenue', 'efficiency'].includes(lower) || /人效|人均创收/.test(raw)) return 'perCapitaRevenue';
  if (['percapitacost', 'per_capita_cost'].includes(lower) || /人均.*成本/.test(raw)) return 'perCapitaCost';
  if (['percapitaprofit', 'per_capita_profit'].includes(lower) || /人均.*利润|负人效/.test(raw)) return 'perCapitaProfit';
  if (['gapfte', 'gap_fte', 'overrun'].includes(lower) || /超编|编制|超预算/.test(raw)) return 'gapFTE';
  return undefined;
}

function _normalizeHealthSortBy(value) {
  const raw = String(value || '').trim();
  const lower = raw.toLowerCase();
  if (['overdueamount', 'overdue_amount', 'overdue'].includes(lower) || /逾期|未回款|应收/.test(raw)) return 'overdueAmount';
  if (['overduecount', 'overdue_count'].includes(lower) || /逾期.*笔|逾期.*数/.test(raw)) return 'overdueCount';
  if (['profit', 'loss'].includes(lower) || /亏损|利润/.test(raw)) return 'profit';
  if (['profitrate', 'profit_rate'].includes(lower) || /利润率/.test(raw)) return 'profitRate';
  if (['lossmonths', 'loss_months'].includes(lower) || /连续亏损|亏损月/.test(raw)) return 'lossMonths';
  return undefined;
}

function _normalizeCustomerSortBy(value) {
  const raw = String(value || '').trim();
  const lower = raw.toLowerCase();
  if (['totalamount', 'total_amount', 'amount', 'contractamount', 'contract_amount'].includes(lower) || /合作金额|客户金额|合同金额|金额/.test(raw)) return 'totalAmount';
  if (['projectcount', 'project_count', 'count'].includes(lower) || /项目数|项目最多/.test(raw)) return 'projectCount';
  if (['activecount', 'active_count', 'servicecount', 'service_count'].includes(lower) || /服务中|履约中|活跃/.test(raw)) return 'activeCount';
  return undefined;
}

function _normalizePresaleSortBy(toolId, value) {
  const raw = String(value || '').trim();
  const lower = raw.toLowerCase();
  if (['winrate', 'win_rate', 'rate', 'conversionrate', 'conversion_rate'].includes(lower) || /赢单率|赢率|转化率/.test(raw)) return 'winRate';
  if (['estamount', 'est_amount', 'estimatedamount', 'estimated_amount', 'amount'].includes(lower) || /预估金额|预计金额|商机金额|管线金额|大单|金额/.test(raw)) return 'estAmount';
  if (['estwinrate', 'est_win_rate', 'probability'].includes(lower) || /预估赢率|预计赢率|概率/.test(raw)) return 'estWinRate';
  if (['wonamount', 'won_amount'].includes(lower) || /赢单金额|中标金额/.test(raw)) return 'wonAmount';
  if (['lostamount', 'lost_amount'].includes(lower) || /丢单金额|落选金额/.test(raw)) return 'lostAmount';
  if (['ongoingamount', 'ongoing_amount'].includes(lower) || /跟进中金额|在进金额/.test(raw)) return 'ongoingAmount';
  if (['staledays', 'stale_days'].includes(lower) || /滞留|多久|未流转|没有流转/.test(raw)) return 'staleDays';
  if (['total', 'totalcount', 'total_count', 'count'].includes(lower) || /总数|项目数|商机数|线索数/.test(raw)) return toolId === 'presale.overview' ? 'totalCount' : 'total';
  if (['won', 'woncount', 'won_count'].includes(lower) || /赢单数|中标数|赢的多/.test(raw)) return 'won';
  if (['lost', 'lostcount', 'lost_count'].includes(lower) || /丢单数|落选数|失败数/.test(raw)) return 'lost';
  if (['ongoing', 'ongoingcount', 'ongoing_count'].includes(lower) || /跟进中|在进|待跟进/.test(raw)) return 'ongoing';
  return undefined;
}

function _normalizeSignSortBy(toolId, value) {
  const raw = String(value || '').trim();
  const lower = raw.toLowerCase();
  if (toolId === 'signDelivery.deliveryRisk') {
    if (['amount', 'contractamount', 'contract_amount'].includes(lower) || /金额|风险|逾期|延期|滞后/.test(raw)) return 'amount';
    if (['performed', 'performedamount', 'performed_amount'].includes(lower) || /履约|交付/.test(raw)) return 'performed';
    if (['collected', 'collectedamount', 'collected_amount'].includes(lower) || /回款|收款/.test(raw)) return 'collected';
  }
  if (['contractamount', 'contract_amount', 'amount', 'signamount', 'sign_amount'].includes(lower) || /签约金额|合同金额|合同额|签约额/.test(raw)) return 'contractAmount';
  if (['totalamount', 'total_amount'].includes(lower) || /总金额|客户金额|合作金额/.test(raw)) return 'totalAmount';
  if (['performedamount', 'performed_amount', 'performed'].includes(lower) || /履约金额|交付金额|已履约/.test(raw)) return 'performedAmount';
  if (['collectedamount', 'collected_amount', 'collected'].includes(lower) || /回款金额|收款金额|已回款/.test(raw)) return 'collectedAmount';
  if (['performedrate', 'performed_rate'].includes(lower) || /履约率|交付率/.test(raw)) return 'performedRate';
  if (['collectedrate', 'collected_rate'].includes(lower) || /回款率|收款率/.test(raw)) return 'collectedRate';
  if (['renewalrate', 'renewal_rate', 'retentionrate', 'retention_rate'].includes(lower) || /续签率|续约率|留存率/.test(raw)) return 'renewalRate';
  if (['renewalamount', 'renewal_amount'].includes(lower) || /续签金额|续约金额/.test(raw)) return 'renewalAmount';
  if (['renewalcount', 'renewal_count'].includes(lower) || /续签数|续约数/.test(raw)) return 'renewalCount';
  if (['count', 'contractcount', 'contract_count'].includes(lower) || /签约数|合同数|数量/.test(raw)) return 'contractCount';
  return undefined;
}

function normalizeSortBy(toolId, value) {
  if (toolId === 'finance.profitOverview') return _normalizeProfitSortBy(value);
  if (toolId === 'finance.receivables') return _normalizeReceivableSortBy(value);
  if (toolId === 'finance.costBreakdown') return _normalizeCostSortBy(value);
  if (toolId === 'finance.laborCost') return _normalizeLaborSortBy(value);
  if (toolId === 'finance.healthCheck') return _normalizeHealthSortBy(value);
  if (toolId === 'customer.analysis') return _normalizeCustomerSortBy(value);
  if (toolId === 'presale.overview' || toolId === 'presale.winLoss' || toolId === 'presale.pending') {
    return _normalizePresaleSortBy(toolId, value);
  }
  if (toolId === 'signDelivery.overview' || toolId === 'signDelivery.renewal' || toolId === 'signDelivery.deliveryRisk') {
    return _normalizeSignSortBy(toolId, value);
  }
  return String(value || '').trim() || undefined;
}

function _defaultOrderForSortBy(sortBy) {
  if (sortBy === 'profit' || sortBy === 'profitRate' || sortBy === 'collectRate') return 'asc';
  if (sortBy === 'revenue' || sortBy === 'cost' || sortBy === 'outstanding'
    || sortBy === 'received' || sortBy === 'overdueAmount' || sortBy === 'riskScore'
    || sortBy === 'totalCost' || sortBy === 'amount' || sortBy === 'operatingCost'
    || sortBy === 'manpowerMonths' || sortBy === 'peopleCount' || sortBy === 'laborCost'
    || sortBy === 'perCapitaRevenue' || sortBy === 'perCapitaCost' || sortBy === 'gapFTE'
    || sortBy === 'overdueCount' || sortBy === 'lossMonths'
    || sortBy === 'totalAmount' || sortBy === 'projectCount' || sortBy === 'activeCount'
    || sortBy === 'winRate' || sortBy === 'estAmount' || sortBy === 'estWinRate'
    || sortBy === 'wonAmount' || sortBy === 'lostAmount' || sortBy === 'ongoingAmount'
    || sortBy === 'staleDays' || sortBy === 'total' || sortBy === 'totalCount'
    || sortBy === 'won' || sortBy === 'lost' || sortBy === 'ongoing'
    || sortBy === 'contractAmount' || sortBy === 'performedAmount' || sortBy === 'collectedAmount'
    || sortBy === 'performedRate' || sortBy === 'collectedRate' || sortBy === 'renewalRate'
    || sortBy === 'renewalAmount' || sortBy === 'renewalCount' || sortBy === 'contractCount') {
    return 'desc';
  }
  return undefined;
}

function _inferTop(message, planResult) {
  const q = String(message || '').replace(/\s+/g, '');
  const topMatch = q.match(/top([0-9一二两三四五六七八九十]{1,3})/i)
    || q.match(/前([0-9一二两三四五六七八九十]{1,3})(?:名|个|项|位|$)/)
    || q.match(/最高的([0-9一二两三四五六七八九十]{1,3})个/)
    || q.match(/最低的([0-9一二两三四五六七八九十]{1,3})个/)
    || q.match(/最差的([0-9一二两三四五六七八九十]{1,3})个/)
    || q.match(/([0-9一二两三四五六七八九十]{1,3})个(?:项目|客户|部门)?/);
  if (topMatch) return normalizeTop(topMatch[1]);
  if (/(哪个|哪一个|哪项|哪一项|第一名|第一个|第一项)/.test(q)) return 1;
  if (/(最高|最低|最差|最好|最大|最小).{0,6}(项目|客户|部门|负责人|那个|这个)[？?。!！吗呢]*$/.test(q)) return 1;
  if (/(几个|哪几个|前几|top几)/i.test(q)) return 5;

  const targetProjects = Array.isArray(planResult?.query_scope?.targetProjects)
    ? planResult.query_scope.targetProjects.filter(Boolean)
    : [];
  const source = String(planResult?.query_scope?.scopeSource || '');
  if (targetProjects.length > 0 && ['inherited_result_set', 'pending_clarification', 'explicit_project'].includes(source)) {
    return normalizeTop(targetProjects.length);
  }
  return undefined;
}

function _inferProfitMetric(message) {
  const q = String(message || '');
  if (/亏损|利润最低|亏得|最亏|赔钱/.test(q)) return { sortBy: 'profit', order: 'asc' };
  if (/利润率|毛利率|净利率/.test(q)) {
    return { sortBy: 'profitRate', order: /(最低|最差|低|倒数)/.test(q) ? 'asc' : 'desc' };
  }
  if (/成本|费用/.test(q) && !/利润率/.test(q)) {
    return { sortBy: 'cost', order: /(最低|最少|低)/.test(q) ? 'asc' : 'desc' };
  }
  if (/(收入|履约)/.test(q) && !/回款|收款|未回|应收/.test(q)) {
    return { sortBy: 'revenue', order: /(最低|最少|低|最差|倒数)/.test(q) ? 'asc' : 'desc' };
  }
  if (/利润|盈利/.test(q)) {
    return { sortBy: 'profit', order: /(最低|最差|低|倒数)/.test(q) ? 'asc' : 'desc' };
  }
  return {};
}

function _inferReceivableMetric(message) {
  const q = String(message || '');
  const wantsHigh = /(最高|最多|最大|从高到低|降序)/.test(q);
  const wantsLow = /(最低|最少|最小|从低到高|升序)/.test(q);
  if (/回款率|收款率/.test(q)) {
    return { sortBy: 'collectRate', order: wantsHigh || (/(最好|高)/.test(q) && !wantsLow) ? 'desc' : 'asc', metric: 'collectRate' };
  }
  if (/未回款|应收|没回|未收/.test(q)) {
    return { sortBy: 'outstanding', order: wantsLow && !wantsHigh ? 'asc' : 'desc', metric: 'outstanding' };
  }
  if (/已回款|已收|到账|实际收款|回款金额/.test(q)) {
    return { sortBy: 'received', order: (wantsLow || /(少|差)/.test(q)) && !wantsHigh ? 'asc' : 'desc', metric: 'received' };
  }
  if (/逾期金额|到期未回|超期/.test(q)) {
    return { sortBy: 'overdueAmount', order: (wantsLow || /少/.test(q)) && !wantsHigh ? 'asc' : 'desc', metric: 'overdueAmount' };
  }
  if (/风险|账龄|逾期/.test(q)) {
    return { sortBy: 'riskScore', order: wantsLow && !wantsHigh ? 'asc' : 'desc', metric: 'riskScore' };
  }
  if (/回款|收款|应收/.test(q)) {
    return { sortBy: 'collectRate', order: 'asc', metric: 'collectRate' };
  }
  return {};
}

function _lowIntent(q) {
  return /(最低|最少|最小|最差|倒数|低|少|差)/.test(q);
}

function _inferCostMetric(message) {
  const q = String(message || '');
  const category = (() => {
    if (/外包/.test(q)) return '外包费用';
    if (/差旅/.test(q)) return '差旅费用';
    if (/人力/.test(q)) return '人力成本';
    if (/市场/.test(q)) return '市场费用';
    if (/增值税|税/.test(q)) return '增值税';
    if (/公共基金/.test(q)) return '公共基金';
    if (/办公|人头办公/.test(q)) return '人头办公费';
    if (/渠道/.test(q)) return '渠道引荐费';
    if (/客户分成|分成/.test(q)) return '客户分成';
    if (/其他/.test(q)) return '其他费用';
    return '';
  })();
  if (category) return { sortBy: 'amount', order: _lowIntent(q) ? 'asc' : 'desc', metric: category };
  if (/亏损|利润最低|最亏|赔钱/.test(q)) return { sortBy: 'profit', order: 'asc' };
  if (/利润率/.test(q)) return { sortBy: 'profitRate', order: _lowIntent(q) ? 'asc' : 'desc' };
  if (/收入|履约/.test(q)) return { sortBy: 'revenue', order: _lowIntent(q) ? 'asc' : 'desc' };
  if (/履约成本|经营成本/.test(q)) return { sortBy: 'operatingCost', order: _lowIntent(q) ? 'asc' : 'desc' };
  if (/成本|费用|花在哪|结构|拆解/.test(q)) return { sortBy: 'totalCost', order: _lowIntent(q) ? 'asc' : 'desc' };
  return {};
}

function _inferLaborMetric(message) {
  const q = String(message || '');
  if (/超编|超过预算|编制/.test(q)) return { sortBy: 'gapFTE', order: _lowIntent(q) ? 'asc' : 'desc' };
  if (/负人效|人均.*亏|人效.*差|人效.*低/.test(q)) return { sortBy: 'perCapitaProfit', order: 'asc' };
  if (/人效|人均创收/.test(q)) return { sortBy: 'perCapitaRevenue', order: _lowIntent(q) ? 'asc' : 'desc' };
  if (/人均.*成本/.test(q)) return { sortBy: 'perCapitaCost', order: _lowIntent(q) ? 'asc' : 'desc' };
  if (/人力成本/.test(q)) return { sortBy: 'laborCost', order: _lowIntent(q) ? 'asc' : 'desc' };
  if (/人数|人头|参与人数/.test(q)) return { sortBy: 'peopleCount', order: _lowIntent(q) ? 'asc' : 'desc' };
  if (/FTE|fte|人力|投入|工时/.test(q)) return { sortBy: 'manpowerMonths', order: _lowIntent(q) ? 'asc' : 'desc' };
  return {};
}

function _inferHealthMetric(message) {
  const q = String(message || '');
  if (/逾期|回款|应收|未回款/.test(q)) return { sortBy: 'overdueAmount', order: _lowIntent(q) ? 'asc' : 'desc' };
  if (/连续亏损|亏损月/.test(q)) return { sortBy: 'lossMonths', order: _lowIntent(q) ? 'asc' : 'desc' };
  if (/利润率/.test(q)) return { sortBy: 'profitRate', order: _lowIntent(q) ? 'asc' : 'desc' };
  if (/风险|体检|健康|亏损|利润/.test(q)) return { sortBy: 'profit', order: 'asc' };
  return {};
}

function _inferCustomerMetric(message) {
  const q = String(message || '');
  if (/服务中|履约中|活跃/.test(q)) return { sortBy: /项目/.test(q) ? 'activeCount' : 'projectCount', order: _lowIntent(q) ? 'asc' : 'desc', metric: 'service' };
  if (/项目数|项目最多|项目最少/.test(q)) return { sortBy: 'projectCount', order: _lowIntent(q) ? 'asc' : 'desc' };
  if (/客户|合作|金额|合同/.test(q)) return { sortBy: 'totalAmount', order: _lowIntent(q) ? 'asc' : 'desc' };
  return {};
}

function _inferPresaleMetric(toolId, message) {
  const q = String(message || '');
  const metric = /SKU|sku/.test(q) ? 'sku' : /部门|行业群|团队/.test(q) ? 'dept' : /负责人|谁|人员/.test(q) ? 'owner' : '';
  let base = {};
  if (/赢单率|赢率|转化率/.test(q)) base = { sortBy: 'winRate', order: _lowIntent(q) ? 'asc' : 'desc' };
  else if (/预估赢率|预计赢率|概率/.test(q)) base = { sortBy: 'estWinRate', order: _lowIntent(q) ? 'asc' : 'desc' };
  else if (/赢单金额|中标金额/.test(q)) base = { sortBy: 'wonAmount', order: _lowIntent(q) ? 'asc' : 'desc' };
  else if (/丢单金额|落选金额/.test(q)) base = { sortBy: 'lostAmount', order: _lowIntent(q) ? 'asc' : 'desc' };
  else if (/滞留|多久|未流转|没有流转/.test(q)) base = { sortBy: 'staleDays', order: _lowIntent(q) ? 'asc' : 'desc' };
  else if (/赢单数|中标数|赢的多/.test(q)) base = { sortBy: 'won', order: _lowIntent(q) ? 'asc' : 'desc' };
  else if (/丢单数|落选数|失败数/.test(q)) base = { sortBy: 'lost', order: _lowIntent(q) ? 'asc' : 'desc' };
  else if (/总数|项目数|商机数|线索数/.test(q)) base = { sortBy: toolId === 'presale.overview' ? 'totalCount' : 'total', order: _lowIntent(q) ? 'asc' : 'desc' };
  else if (/售前|商机|线索|大单|金额|管线|跟进中|在进|待跟进/.test(q)) base = { sortBy: 'estAmount', order: _lowIntent(q) ? 'asc' : 'desc' };
  if (metric && toolId === 'presale.winLoss') base.metric = metric;
  return base;
}

function _inferSignMetric(toolId, message) {
  const q = String(message || '');
  if (/续签率|续约率|留存率/.test(q)) return { sortBy: 'renewalRate', order: _lowIntent(q) ? 'asc' : 'desc' };
  if (/续签金额|续约金额/.test(q)) return { sortBy: 'renewalAmount', order: _lowIntent(q) ? 'asc' : 'desc' };
  if (/续签数|续约数/.test(q)) return { sortBy: 'renewalCount', order: _lowIntent(q) ? 'asc' : 'desc' };
  if (/履约率|交付率/.test(q)) return { sortBy: 'performedRate', order: _lowIntent(q) ? 'asc' : 'desc' };
  if (/回款率|收款率/.test(q)) return { sortBy: 'collectedRate', order: _lowIntent(q) ? 'asc' : 'desc' };
  if (/履约|交付/.test(q)) return { sortBy: toolId === 'signDelivery.deliveryRisk' ? 'performed' : 'performedAmount', order: _lowIntent(q) ? 'asc' : 'desc' };
  if (/回款|收款/.test(q)) return { sortBy: toolId === 'signDelivery.deliveryRisk' ? 'collected' : 'collectedAmount', order: _lowIntent(q) ? 'asc' : 'desc' };
  if (/客户金额|合作金额|总金额/.test(q) && toolId === 'signDelivery.renewal') return { sortBy: 'totalAmount', order: _lowIntent(q) ? 'asc' : 'desc' };
  if (/签约数|合同数|数量/.test(q)) return { sortBy: 'contractCount', order: _lowIntent(q) ? 'asc' : 'desc' };
  if (/签约|合同|金额|风险|逾期|延期|滞后/.test(q)) return { sortBy: toolId === 'signDelivery.deliveryRisk' ? 'amount' : 'contractAmount', order: _lowIntent(q) ? 'asc' : 'desc' };
  return {};
}

function _sanitizeToolParams(toolId, params) {
  if (!_isObject(params)) return {};
  const out = {};
  const top = normalizeTop(params.top);
  if (top !== undefined) out.top = top;
  const sortBy = normalizeSortBy(toolId, params.sortBy);
  if (sortBy) out.sortBy = sortBy;
  const order = normalizeOrder(params.order);
  if (order) out.order = order;
  if (toolId !== 'finance.receivables' && typeof params.metric === 'string' && params.metric.trim()) {
    const metric = params.metric.trim().slice(0, 40);
    out.metric = metric;
  }
  if (toolId === 'finance.receivables') {
    const metric = normalizeSortBy(toolId, params.metric) || sortBy;
    if (metric) out.metric = metric;
  }
  if (out.sortBy && !out.order) out.order = _defaultOrderForSortBy(out.sortBy);
  return out;
}

function _inferToolParams(toolId, message, planResult) {
  const inferred = {};
  const top = _inferTop(message, planResult);
  if (top !== undefined) inferred.top = top;
  const metricParams = (() => {
    if (toolId === 'finance.profitOverview') return _inferProfitMetric(message);
    if (toolId === 'finance.receivables') return _inferReceivableMetric(message);
    if (toolId === 'finance.costBreakdown') return _inferCostMetric(message);
    if (toolId === 'finance.laborCost') return _inferLaborMetric(message);
    if (toolId === 'finance.healthCheck') return _inferHealthMetric(message);
    if (toolId === 'customer.analysis') return _inferCustomerMetric(message);
    if (toolId === 'presale.overview' || toolId === 'presale.winLoss' || toolId === 'presale.pending') {
      return _inferPresaleMetric(toolId, message);
    }
    if (toolId === 'signDelivery.overview' || toolId === 'signDelivery.renewal' || toolId === 'signDelivery.deliveryRisk') {
      return _inferSignMetric(toolId, message);
    }
    return {};
  })();
  Object.assign(inferred, metricParams);
  if (inferred.sortBy && !inferred.order) inferred.order = _defaultOrderForSortBy(inferred.sortBy);
  return inferred;
}

function resolveToolParams({ message = '', planResult = null, enableRuleFallback = false } = {}) {
  if (!planResult || !Array.isArray(planResult.tools_needed)) return {};
  const toolSet = new Set(planResult.tools_needed);
  const raw = _isObject(planResult.tool_params) ? planResult.tool_params : {};
  const out = {};

  for (const toolId of toolSet) {
    const cleaned = _sanitizeToolParams(toolId, raw[toolId]);
    const inferred = enableRuleFallback ? _inferToolParams(toolId, message, planResult) : {};
    const preferInferredMetric = enableRuleFallback
      && (inferred.sortBy || inferred.metric || inferred.order)
      && /(用户补充|补充口径|按|从低到高|从高到低|最高|最低|最多|最少|最大|最小)/.test(String(message || ''));
    const preferInferredTop = enableRuleFallback
      && inferred.top
      && /(top\s*[0-9一二两三四五六七八九十]+|TOP\s*[0-9一二两三四五六七八九十]+|前[0-9一二两三四五六七八九十]+|[0-9一二两三四五六七八九十]+个)/.test(String(message || ''));
    const merged = preferInferredMetric
      ? {
        ...cleaned,
        ...(preferInferredTop ? { top: inferred.top } : {}),
        ...(inferred.sortBy ? { sortBy: inferred.sortBy } : {}),
        ...(inferred.order ? { order: inferred.order } : {}),
        ...(inferred.metric ? { metric: inferred.metric } : {}),
        ...(!cleaned.top && inferred.top ? { top: inferred.top } : {}),
      }
      : {
        ...inferred,
        ...cleaned,
        ...(preferInferredTop ? { top: inferred.top } : {}),
      };
    if (cleaned.sortBy && !cleaned.order) merged.order = _defaultOrderForSortBy(cleaned.sortBy);
    const finalParams = _sanitizeToolParams(toolId, merged);
    if (Object.keys(finalParams).length > 0) out[toolId] = finalParams;
  }

  return out;
}

function applyToolParamsToPlan(planResult, opts = {}) {
  if (!planResult || typeof planResult !== 'object') return planResult;
  const params = resolveToolParams({
    message: opts.message || opts.originalMessage || '',
    planResult,
    enableRuleFallback: !!opts.enableRuleFallback,
  });
  planResult.tool_params = params;
  return planResult;
}

module.exports = {
  applyToolParamsToPlan,
  resolveToolParams,
  normalizeTop,
  normalizeOrder,
  normalizeSortBy,
};
