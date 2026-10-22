/**
 * sign-delivery-tools.js - 签约交付分析工具
 *
 * 数据源：🟩 签约交付表（SIGN_DELIVERY，tblAw6pgYhgeBgvr），
 * 记录已签约并在履约的项目（含续签、交付进度、回款状态）。
 *
 * 所有函数签名: (memory, scope) => structuredResult
 */

const FM = require('../utils/field-mapping');
const displayUtils = require('./display-result-set-utils');

const SF = FM.SIGN_DELIVERY_FIELDS;

// "是否续签" 实际枚举：续签 / 新签 / 空
function _isRenewal(f) {
  return FM.str(f, SF.IS_RENEWAL) === '续签';
}

function _person(f, key) {
  const v = f[key];
  if (Array.isArray(v)) return v[0]?.name || v[0]?.en_name || '';
  return FM.str(f, key);
}

function _parseTs(v) {
  const n = Number(v);
  if (!n || !isFinite(n)) return null;
  return new Date(n);
}

function _ymKey(ts) {
  if (!ts) return '';
  return `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}`;
}

function _signValue(row, sortBy) {
  if (sortBy === 'contractAmount' || sortBy === 'amount') return row.contractAmount ?? row.amount ?? row.totalAmount;
  if (sortBy === 'totalAmount') return row.totalAmount ?? row.contractAmount ?? row.amount;
  if (sortBy === 'performedAmount' || sortBy === 'performed') return row.performedAmount ?? row.performed;
  if (sortBy === 'collectedAmount' || sortBy === 'collected') return row.collectedAmount ?? row.collected;
  if (sortBy === 'performedRate') return row.performedRate;
  if (sortBy === 'collectedRate') return row.collectedRate;
  if (sortBy === 'renewalRate') return row.renewalRate;
  if (sortBy === 'renewalAmount') return row.renewalAmount;
  if (sortBy === 'renewalCount') return row.renewalCount;
  if (sortBy === 'count' || sortBy === 'contractCount') return row.contractCount ?? row.count ?? row.totalCount;
  return row.contractAmount ?? row.amount ?? row.totalAmount;
}

function _signSortBy(params, fallback) {
  const raw = String(params && params.sortBy || '').trim();
  if (['contractAmount', 'amount', 'totalAmount', 'performedAmount', 'performed', 'collectedAmount', 'collected', 'performedRate', 'collectedRate', 'renewalRate', 'renewalAmount', 'renewalCount', 'count', 'contractCount'].includes(raw)) return raw;
  return fallback;
}

function _buildSignDisplay({ toolId, type, rows, params, scope, sortBy, rowMapper, orderFallback = 'desc' }) {
  if (!displayUtils.shouldBuild(params, scope)) return {};
  const sortOrder = displayUtils.order(params, orderFallback);
  const sorted = displayUtils.sortRows(rows, sortBy, sortOrder, _signValue, row => row.name || row.dept || row.customer);
  return displayUtils.build({
    toolId,
    type,
    rows: sorted,
    params,
    scope,
    sortBy,
    sortOrder,
    rowMapper,
  });
}

// ==================== T1. 签约总览 ====================

function overview(memory, scope, opts = {}) {
  const records = memory.signDeliveries || [];
  if (records.length === 0) return { empty: true, message: '暂无签约交付数据' };

  const byDept = {};
  const byMonth = {};
  let totalContractAmount = 0;
  let totalPerformed = 0;
  let totalCollected = 0;
  let renewalCount = 0;
  let renewalAmount = 0;
  let financeCount = 0;

  for (const r of records) {
    const f = r.fields || {};
    const dept = FM.str(f, SF.DEPT) || '未分部门';
    const amount = FM.num(f, SF.CONTRACT_AMOUNT);
    const performed = FM.num(f, SF.PERFORM_AMOUNT);
    const collected = FM.num(f, SF.COLLECTED_AMOUNT);
    const isRenewal = _isRenewal(f);
    const isFinance = FM.str(f, SF.IS_FINANCE) === '金融';
    const signTs = _parseTs(f[SF.SIGN_DATE]);

    totalContractAmount += amount;
    totalPerformed += performed;
    totalCollected += collected;
    if (isRenewal) { renewalCount++; renewalAmount += amount; }
    if (isFinance) financeCount++;

    byDept[dept] = byDept[dept] || { count: 0, amount: 0, performed: 0, collected: 0, renewalCount: 0 };
    byDept[dept].count++;
    byDept[dept].amount += amount;
    byDept[dept].performed += performed;
    byDept[dept].collected += collected;
    if (isRenewal) byDept[dept].renewalCount++;

    if (signTs) {
      const ym = _ymKey(signTs);
      byMonth[ym] = byMonth[ym] || { count: 0, amount: 0, renewalCount: 0 };
      byMonth[ym].count++;
      byMonth[ym].amount += amount;
      if (isRenewal) byMonth[ym].renewalCount++;
    }
  }

  const deptStats = Object.entries(byDept).map(([name, d]) => ({
    dept: name,
    contractCount: d.count,
    contractAmount: d.amount,
    performedAmount: d.performed,
    collectedAmount: d.collected,
    performedRate: d.amount > 0 ? d.performed / d.amount : null,
    collectedRate: d.amount > 0 ? d.collected / d.amount : null,
    renewalCount: d.renewalCount,
    renewalRate: d.count > 0 ? d.renewalCount / d.count : null,
  })).sort((a, b) => b.contractAmount - a.contractAmount);

  const monthStats = Object.entries(byMonth)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([ym, d]) => ({ month: ym, count: d.count, amount: d.amount, renewalCount: d.renewalCount }));
  const q = String((scope && scope.question) || '');
  const displayPayload = _buildSignDisplay({
    toolId: 'signDelivery.overview',
    type: /月份|月度|按月/.test(q) ? 'signDelivery.months' : 'signDelivery.depts',
    rows: /月份|月度|按月/.test(q) ? monthStats : deptStats,
    params: opts,
    scope,
    sortBy: _signSortBy(opts, /回款|收款/.test(q) ? 'collectedAmount' : /履约/.test(q) ? 'performedAmount' : 'contractAmount'),
    rowMapper: row => ({
      type: row.month ? 'month' : 'dept',
      name: row.month || row.dept,
      contractCount: row.contractCount ?? row.count,
      contractAmount: row.contractAmount ?? row.amount,
      performedAmount: row.performedAmount,
      collectedAmount: row.collectedAmount,
      performedRate: row.performedRate,
      collectedRate: row.collectedRate,
      renewalCount: row.renewalCount,
      renewalRate: row.renewalRate,
    }),
  });

  return {
    totalCount: records.length,
    totalContractAmount,
    totalPerformedAmount: totalPerformed,
    totalCollectedAmount: totalCollected,
    renewalCount,
    renewalAmount,
    renewalRate: records.length > 0 ? renewalCount / records.length : null,
    financeCount,
    deptStats,
    monthStats,
    ...displayPayload,
  };
}

// ==================== T2. 续约分析 ====================

function renewalAnalysis(memory, scope, params = {}) {
  const records = memory.signDeliveries || [];
  if (records.length === 0) return { empty: true, message: '暂无签约交付数据' };

  const renewalList = [];
  const nonRenewalList = [];
  const byCustomer = {};

  for (const r of records) {
    const f = r.fields || {};
    const isRenewal = _isRenewal(f);
    const customer = FM.str(f, SF.REL_CUSTOMER) || FM.str(f, SF.CUSTOMER_ENTITY) || '未知客户';
    const entry = {
      name: FM.str(f, SF.NAME),
      dept: FM.str(f, SF.DEPT),
      owner: _person(f, SF.OWNER),
      customer,
      amount: FM.num(f, SF.CONTRACT_AMOUNT),
      parent: FM.str(f, SF.RENEWAL_PARENT),
      signDate: FM.str(f, SF.SIGN_DATE),
      contractType: FM.str(f, SF.CONTRACT_TYPE),
    };
    if (isRenewal) renewalList.push(entry);
    else nonRenewalList.push(entry);

    byCustomer[customer] = byCustomer[customer] || { totalCount: 0, totalAmount: 0, renewalCount: 0, renewalAmount: 0 };
    byCustomer[customer].totalCount++;
    byCustomer[customer].totalAmount += entry.amount;
    if (isRenewal) {
      byCustomer[customer].renewalCount++;
      byCustomer[customer].renewalAmount += entry.amount;
    }
  }

  const customerStats = Object.entries(byCustomer).map(([c, d]) => ({
    customer: c,
    totalCount: d.totalCount,
    totalAmount: d.totalAmount,
    renewalCount: d.renewalCount,
    renewalAmount: d.renewalAmount,
    renewalRate: d.totalCount > 0 ? d.renewalCount / d.totalCount : null,
  })).sort((a, b) => b.totalAmount - a.totalAmount);
  const q = String((scope && scope.question) || '');
  const source = /没续|未续|未留存|未续签/.test(q)
    ? customerStats.filter(c => c.renewalCount === 0)
    : customerStats;
  const displayPayload = _buildSignDisplay({
    toolId: 'signDelivery.renewal',
    type: 'signDelivery.renewalCustomers',
    rows: source,
    params,
    scope,
    sortBy: _signSortBy(params, /续签率|留存率/.test(q) ? 'renewalRate' : 'totalAmount'),
    rowMapper: row => ({
      type: 'customer',
      name: row.customer,
      totalCount: row.totalCount,
      totalAmount: row.totalAmount,
      renewalCount: row.renewalCount,
      renewalAmount: row.renewalAmount,
      renewalRate: row.renewalRate,
    }),
  });

  return {
    renewalCount: renewalList.length,
    renewalAmount: renewalList.reduce((s, e) => s + e.amount, 0),
    nonRenewalCount: nonRenewalList.length,
    nonRenewalAmount: nonRenewalList.reduce((s, e) => s + e.amount, 0),
    overallRenewalRate: records.length > 0 ? renewalList.length / records.length : null,
    topRenewalCustomers: customerStats.filter(c => c.renewalCount > 0).slice(0, 15),
    topNonRenewalCustomers: customerStats.filter(c => c.renewalCount === 0).sort((a, b) => b.totalAmount - a.totalAmount).slice(0, 10),
    renewalSamples: renewalList.sort((a, b) => b.amount - a.amount).slice(0, 10),
    ...displayPayload,
  };
}

// ==================== T3. 交付风险 ====================

function deliveryRisk(memory, scope, params = {}) {
  const records = memory.signDeliveries || [];
  if (records.length === 0) return { empty: true, message: '暂无签约交付数据' };

  const now = Date.now();
  const risks = [];

  for (const r of records) {
    const f = r.fields || {};
    const contractEnd = _parseTs(f[SF.CONTRACT_END]);
    const performEnd = _parseTs(f[SF.PERFORM_END]);
    const amount = FM.num(f, SF.CONTRACT_AMOUNT);
    const performed = FM.num(f, SF.PERFORM_AMOUNT);
    const collected = FM.num(f, SF.COLLECTED_AMOUNT);

    const reasons = [];
    // 逾期未交付：合同结束日已过但实际履约结束时间为空或晚于合同结束
    if (contractEnd && contractEnd.getTime() < now) {
      if (!performEnd) reasons.push('合同已到期，实际履约结束时间未填');
      else if (performEnd.getTime() > contractEnd.getTime()) {
        const days = Math.round((performEnd.getTime() - contractEnd.getTime()) / (86400 * 1000));
        reasons.push(`交付逾期 ${days} 天`);
      }
      if (amount > 0 && performed < amount * 0.9) reasons.push(`履约金额不足：${(performed / amount * 100).toFixed(0)}% < 90%`);
    }
    // 回款滞后
    if (amount > 0 && performed > 0 && collected < performed * 0.3) {
      reasons.push(`回款严重滞后（已履约 ${(performed / 10000).toFixed(1)}万，仅回款 ${(collected / 10000).toFixed(1)}万）`);
    }

    if (reasons.length === 0) continue;

    risks.push({
      name: FM.str(f, SF.NAME),
      dept: FM.str(f, SF.DEPT),
      owner: _person(f, SF.OWNER),
      amount,
      performed,
      collected,
      contractEndStr: FM.str(f, SF.CONTRACT_END),
      reasons,
    });
  }

  risks.sort((a, b) => b.amount - a.amount);

  // 按部门聚合
  const byDept = {};
  for (const r of risks) {
    byDept[r.dept] = byDept[r.dept] || { count: 0, amount: 0 };
    byDept[r.dept].count++;
    byDept[r.dept].amount += r.amount;
  }

  return {
    riskCount: risks.length,
    totalRiskAmount: risks.reduce((s, r) => s + r.amount, 0),
    byDept: Object.entries(byDept).map(([dept, d]) => ({ dept, count: d.count, amount: d.amount }))
      .sort((a, b) => b.amount - a.amount),
    topRisks: risks.slice(0, 15),
    ..._buildSignDisplay({
      toolId: 'signDelivery.deliveryRisk',
      type: 'signDelivery.riskProjects',
      rows: risks,
      params,
      scope,
      sortBy: _signSortBy(params, /履约/.test(String((scope && scope.question) || '')) ? 'performed' : 'amount'),
      rowMapper: row => ({
        type: 'project',
        name: row.name,
        dept: row.dept,
        owner: row.owner,
        amount: row.amount,
        performed: row.performed,
        collected: row.collected,
        contractEndStr: row.contractEndStr,
        reasons: row.reasons,
      }),
    }),
  };
}

module.exports = {
  overview,
  renewalAnalysis,
  deliveryRisk,
};
