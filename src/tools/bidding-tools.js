/**
 * bidding-tools.js - 招投标分析工具
 *
 * 数据源：⭕ 招投标表（BIDDING_PROJECT，tblsY02GCG9oM4Cn），
 * 记录公开招投标/议标/竞争性磋商等流程。
 *
 * 所有函数签名: (memory, scope) => structuredResult
 */

const FM = require('../utils/field-mapping');

const BF = FM.BIDDING_PROJECT_FIELDS;

function _person(f, key) {
  const v = f[key];
  if (Array.isArray(v)) return v[0]?.name || v[0]?.en_name || '';
  return FM.str(f, key);
}

/**
 * "投标结果" 是多选字段，值形如 ["已中标（首选）"] / ["未中标（原因未知）"] / ["弃标"] / ["流标"] / ["入库/资质审核"]。
 * 归一化分类：
 *   won      = 已中标（首选/备选）
 *   lost     = 未中标（各种原因）
 *   void     = 弃标 / 流标 / 废标 / 未投标
 *   ongoing  = 入库/资质审核 / (空) / 其他
 */
function _resultRaw(f) {
  const v = f[BF.BID_RESULT];
  if (Array.isArray(v)) return (v[0] || '').toString().trim();
  return FM.str(f, BF.BID_RESULT);
}

function _resultClass(result) {
  const r = (result || '').trim();
  if (!r) return 'ongoing';
  if (r.startsWith('已中标') || r === '中标') return 'won';
  if (r.startsWith('未中标')) return 'lost';
  if (r === '弃标' || r === '流标' || r === '废标' || r.startsWith('未投标')) return 'void';
  if (r.startsWith('入库') || r.includes('资质审核')) return 'ongoing';
  return 'ongoing';
}

// ==================== T1. 招投标总览 ====================

function overview(memory, _scope) {
  const records = memory.biddings || [];
  if (records.length === 0) return { empty: true, message: '暂无招投标数据' };

  const byDept = {};
  const byType = {};
  const byIndustry = {};
  let wonCount = 0, lostCount = 0, voidCount = 0, ongoingCount = 0;
  let totalBidAmount = 0, totalFinalAmount = 0;

  for (const r of records) {
    const f = r.fields || {};
    const result = _resultRaw(f);
    const cls = _resultClass(result);
    const dept = FM.str(f, BF.DEPT) || '未分部门';
    const type = FM.str(f, BF.TYPE) || '未分类型';
    const industry = FM.str(f, BF.INDUSTRY) || '未分行业';
    const bidAmt = FM.num(f, BF.BID_AMOUNT);
    const finalAmt = FM.num(f, BF.FINAL_AMOUNT);

    totalBidAmount += bidAmt;
    if (cls === 'won') { wonCount++; totalFinalAmount += finalAmt; }
    else if (cls === 'lost') lostCount++;
    else if (cls === 'void') voidCount++;
    else ongoingCount++;

    byDept[dept] = byDept[dept] || { count: 0, won: 0, lost: 0, void: 0, ongoing: 0, finalAmount: 0 };
    byDept[dept].count++;
    byDept[dept][cls]++;
    if (cls === 'won') byDept[dept].finalAmount += finalAmt;

    byType[type] = byType[type] || { count: 0, won: 0, lost: 0 };
    byType[type].count++;
    if (cls === 'won') byType[type].won++;
    if (cls === 'lost') byType[type].lost++;

    byIndustry[industry] = byIndustry[industry] || { count: 0, won: 0, lost: 0 };
    byIndustry[industry].count++;
    if (cls === 'won') byIndustry[industry].won++;
    if (cls === 'lost') byIndustry[industry].lost++;
  }

  const decisive = wonCount + lostCount;
  const overallWinRate = decisive > 0 ? wonCount / decisive : null;

  const deptStats = Object.entries(byDept).map(([name, d]) => {
    const dec = d.won + d.lost;
    return {
      dept: name,
      totalCount: d.count,
      wonCount: d.won,
      lostCount: d.lost,
      voidCount: d.void,
      ongoingCount: d.ongoing,
      winRate: dec > 0 ? d.won / dec : null,
      finalAmount: d.finalAmount,
    };
  }).sort((a, b) => b.totalCount - a.totalCount);

  const typeStats = Object.entries(byType).map(([name, d]) => {
    const dec = d.won + d.lost;
    return {
      type: name,
      totalCount: d.count,
      winRate: dec > 0 ? d.won / dec : null,
    };
  }).sort((a, b) => b.totalCount - a.totalCount);

  const industryStats = Object.entries(byIndustry).map(([name, d]) => {
    const dec = d.won + d.lost;
    return {
      industry: name,
      totalCount: d.count,
      winRate: dec > 0 ? d.won / dec : null,
    };
  }).sort((a, b) => b.totalCount - a.totalCount);

  return {
    totalCount: records.length,
    wonCount,
    lostCount,
    voidCount,
    ongoingCount,
    overallWinRate,
    totalBidAmount,
    totalFinalAmount,
    deptStats,
    typeStats,
    industryStats: industryStats.slice(0, 15),
  };
}

// ==================== T2. 失败原因分析 ====================

function failureAnalysis(memory, _scope) {
  const records = memory.biddings || [];
  if (records.length === 0) return { empty: true, message: '暂无招投标数据' };

  const reasons = {}; // 关键词 → count
  const details = [];

  for (const r of records) {
    const f = r.fields || {};
    const result = _resultRaw(f);
    const cls = _resultClass(result);
    if (cls !== 'lost' && cls !== 'void') continue;
    const reason = FM.str(f, BF.RESULT_REASON);
    const customer = FM.str(f, BF.CUSTOMER);
    const proj = FM.str(f, BF.PROJECT_NAME);
    const dept = FM.str(f, BF.DEPT);
    const bidAmt = FM.num(f, BF.BID_AMOUNT);

    details.push({
      customer, proj, dept,
      result,
      reason,
      bidAmount: bidAmt,
    });

    // 关键词提取（粗糙但可用）
    const tokens = reason
      .replace(/[，,。；;、\s]+/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 2 && t.length <= 10);
    for (const t of tokens) {
      reasons[t] = (reasons[t] || 0) + 1;
    }
  }

  const topKeywords = Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([k, v]) => ({ keyword: k, count: v }));

  return {
    failureCount: details.length,
    topKeywords,
    samples: details.slice(0, 15),
  };
}

// ==================== T3. 中标明细 ====================

function wonList(memory, _scope, opts = {}) {
  const topN = Math.max(1, Math.min(50, opts.topN || 15));
  const records = memory.biddings || [];
  if (records.length === 0) return { empty: true, message: '暂无招投标数据' };

  const won = records
    .filter(r => _resultClass(_resultRaw(r.fields || {})) === 'won')
    .map(r => {
      const f = r.fields || {};
      return {
        customer: FM.str(f, BF.CUSTOMER),
        project: FM.str(f, BF.PROJECT_NAME),
        dept: FM.str(f, BF.DEPT),
        owner: _person(f, BF.OWNER),
        industry: FM.str(f, BF.INDUSTRY),
        type: FM.str(f, BF.TYPE),
        bidAmount: FM.num(f, BF.BID_AMOUNT),
        finalAmount: FM.num(f, BF.FINAL_AMOUNT),
      };
    })
    .sort((a, b) => b.finalAmount - a.finalAmount);

  return {
    wonCount: won.length,
    totalFinalAmount: won.reduce((s, e) => s + e.finalAmount, 0),
    top: won.slice(0, topN),
  };
}

module.exports = {
  overview,
  failureAnalysis,
  wonList,
};
