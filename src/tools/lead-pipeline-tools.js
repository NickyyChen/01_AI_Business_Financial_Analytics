/**
 * lead-pipeline-tools.js - 商机管线分析工具（售前前置漏斗）
 *
 * 数据源：商机管线表（LEAD_PIPELINE，tblztxNuZDjRTcv4），
 * 记录销售漏斗最前端的线索/商机（客户品牌→商机阶段→售前输出/丢标）。
 *
 * 单位约定（与飞书表一致）：
 *   - EST_AMOUNT_WAN / WEIGHTED_WAN 存储单位为"万"（不是元）；对外返回直接沿用"万"，
 *     避免二次换算误差。若下游需要元，由 Answer LLM 再做 ×10000 即可。
 *   - WIN_RATE 存储为 0~1 的小数，对外保持小数；展示成百分比由 Answer 做。
 *
 * 所有函数签名: (memory, scope) => structuredResult
 */

const FM = require('../utils/field-mapping');

const LF = FM.LEAD_PIPELINE_FIELDS;

/**
 * 归一化商机阶段。飞书单选值样例：
 *   "售前输出" / "待投入" / "意向中" / "已投标" / "已签约" / "丢单" / "暂停" / ""
 * 分类规则（用于漏斗统计）：
 *   active   = 仍在活跃跟进（售前输出/意向中/待投入/已投标/报名中 等）
 *   won      = 已签约 / 赢单
 *   lost     = 丢单 / 失败 / 未中标
 *   paused   = 暂停 / 搁置
 *   unknown  = 空或无法识别
 */
function _classifyStage(stage) {
  const s = (stage || '').trim();
  if (!s) return 'unknown';
  if (s.includes('签约') || s.includes('赢单') || s.includes('中标') || s === '已签约') return 'won';
  if (s.includes('丢') || s.includes('失败') || s === '废标' || s === '流标') return 'lost';
  if (s.includes('暂停') || s.includes('搁置')) return 'paused';
  return 'active';
}

// ==================== T1. 商机管线总览 ====================

function overview(memory, _scope) {
  const records = memory.leadPipeline || [];
  if (records.length === 0) return { empty: true, message: '暂无商机管线数据（LEAD_PIPELINE 表无记录或权限过滤后为空）' };

  const byStage = {};
  const byIndustry = {};
  const byOwner = {};
  let totalEstAmountWan = 0;
  let totalWeightedWan = 0;
  let active = 0, won = 0, lost = 0, paused = 0, unknown = 0;

  for (const r of records) {
    const f = r.fields || {};
    const stage = FM.str(f, LF.STAGE) || '未分阶段';
    const industry = FM.str(f, LF.INDUSTRY) || '未分行业';
    const owner = FM.str(f, LF.OWNER) || '未分负责人';
    const estWan = FM.num(f, LF.EST_AMOUNT_WAN);
    const wWan = FM.num(f, LF.WEIGHTED_WAN);
    const winRate = FM.num(f, LF.WIN_RATE);
    const cls = _classifyStage(stage);

    totalEstAmountWan += estWan;
    totalWeightedWan += wWan;
    if (cls === 'won') won++;
    else if (cls === 'lost') lost++;
    else if (cls === 'paused') paused++;
    else if (cls === 'unknown') unknown++;
    else active++;

    byStage[stage] = byStage[stage] || { count: 0, estAmountWan: 0, weightedWan: 0, winRateSum: 0, winRateN: 0 };
    byStage[stage].count++;
    byStage[stage].estAmountWan += estWan;
    byStage[stage].weightedWan += wWan;
    if (winRate > 0) { byStage[stage].winRateSum += winRate; byStage[stage].winRateN++; }

    byIndustry[industry] = byIndustry[industry] || { count: 0, estAmountWan: 0, weightedWan: 0 };
    byIndustry[industry].count++;
    byIndustry[industry].estAmountWan += estWan;
    byIndustry[industry].weightedWan += wWan;

    byOwner[owner] = byOwner[owner] || { count: 0, estAmountWan: 0, weightedWan: 0 };
    byOwner[owner].count++;
    byOwner[owner].estAmountWan += estWan;
    byOwner[owner].weightedWan += wWan;
  }

  const stageStats = Object.entries(byStage).map(([k, v]) => ({
    stage: k,
    count: v.count,
    estAmountWan: v.estAmountWan,
    weightedWan: v.weightedWan,
    avgWinRate: v.winRateN > 0 ? v.winRateSum / v.winRateN : null,
  })).sort((a, b) => b.weightedWan - a.weightedWan);

  const industryStats = Object.entries(byIndustry).map(([k, v]) => ({
    industry: k,
    count: v.count,
    estAmountWan: v.estAmountWan,
    weightedWan: v.weightedWan,
  })).sort((a, b) => b.weightedWan - a.weightedWan);

  const ownerStats = Object.entries(byOwner).map(([k, v]) => ({
    owner: k,
    count: v.count,
    estAmountWan: v.estAmountWan,
    weightedWan: v.weightedWan,
  })).sort((a, b) => b.weightedWan - a.weightedWan);

  return {
    totalCount: records.length,
    activeCount: active,
    wonCount: won,
    lostCount: lost,
    pausedCount: paused,
    unknownCount: unknown,
    totalEstAmountWan,
    totalWeightedWan,
    stageStats,
    industryStats: industryStats.slice(0, 15),
    ownerStats: ownerStats.slice(0, 15),
    unit: '万元（预估/加权金额字段原单位）',
  };
}

// ==================== T2. 漏斗阶段转化（按阶段分段呈现） ====================

function stageFunnel(memory, _scope) {
  const records = memory.leadPipeline || [];
  if (records.length === 0) return { empty: true, message: '暂无商机管线数据' };

  // 把阶段按"漏斗顺序"排序输出，便于 Answer LLM 画漏斗
  const PREFERRED_ORDER = ['待投入', '意向中', '售前输出', '已投标', '商务谈判', '已签约', '丢单', '暂停'];
  const byStage = {};
  for (const r of records) {
    const f = r.fields || {};
    const stage = FM.str(f, LF.STAGE) || '未分阶段';
    const estWan = FM.num(f, LF.EST_AMOUNT_WAN);
    const wWan = FM.num(f, LF.WEIGHTED_WAN);
    byStage[stage] = byStage[stage] || { count: 0, estAmountWan: 0, weightedWan: 0 };
    byStage[stage].count++;
    byStage[stage].estAmountWan += estWan;
    byStage[stage].weightedWan += wWan;
  }

  const entries = Object.entries(byStage).map(([stage, d]) => ({
    stage,
    count: d.count,
    estAmountWan: d.estAmountWan,
    weightedWan: d.weightedWan,
  }));

  entries.sort((a, b) => {
    const ia = PREFERRED_ORDER.indexOf(a.stage);
    const ib = PREFERRED_ORDER.indexOf(b.stage);
    const na = ia < 0 ? 999 : ia;
    const nb = ib < 0 ? 999 : ib;
    if (na !== nb) return na - nb;
    return b.weightedWan - a.weightedWan;
  });

  const totalCount = records.length;
  const totalEstWan = entries.reduce((s, e) => s + e.estAmountWan, 0);

  return {
    totalCount,
    totalEstAmountWan: totalEstWan,
    funnel: entries.map(e => ({
      ...e,
      countPct: totalCount > 0 ? e.count / totalCount : null,
      estAmountPct: totalEstWan > 0 ? e.estAmountWan / totalEstWan : null,
    })),
    unit: '万元',
  };
}

// ==================== T3. Top N 商机明细 ====================

function topOpportunities(memory, _scope, opts = {}) {
  const topN = Math.max(1, Math.min(50, opts.topN || 15));
  const sortBy = opts.sortBy === 'estAmount' ? 'estAmount' : 'weighted'; // 默认按加权金额
  const records = memory.leadPipeline || [];
  if (records.length === 0) return { empty: true, message: '暂无商机管线数据' };

  const rows = records.map(r => {
    const f = r.fields || {};
    return {
      customerBrand:   FM.str(f, LF.CUSTOMER_BRAND),
      industry:        FM.str(f, LF.INDUSTRY),
      owner:           FM.str(f, LF.OWNER),
      collaborators:   FM.str(f, LF.COLLABORATORS),
      stage:           FM.str(f, LF.STAGE),
      estAmountWan:    FM.num(f, LF.EST_AMOUNT_WAN),
      winRate:         FM.num(f, LF.WIN_RATE),
      weightedWan:     FM.num(f, LF.WEIGHTED_WAN),
      latestProgress:  FM.str(f, LF.LATEST_PROGRESS)?.slice(0, 120),
      competitor:      FM.str(f, LF.COMPETITOR)?.slice(0, 80),
      lossReason:      FM.str(f, LF.LOSS_REASON)?.slice(0, 120),
      estSignDate:     f[LF.EST_SIGN_DATE] ? new Date(Number(f[LF.EST_SIGN_DATE])).toISOString().slice(0, 10) : '',
      updateDate:      f[LF.UPDATE_DATE] ? new Date(Number(f[LF.UPDATE_DATE])).toISOString().slice(0, 10) : '',
    };
  });

  const cmp = sortBy === 'estAmount'
    ? (a, b) => b.estAmountWan - a.estAmountWan
    : (a, b) => b.weightedWan - a.weightedWan;
  rows.sort(cmp);

  // 单独切出"丢单 + 有原因"的样本，方便失败复盘
  const lossSamples = rows
    .filter(r => _classifyStage(r.stage) === 'lost' && r.lossReason)
    .slice(0, 10);

  return {
    sortBy,
    top: rows.slice(0, topN),
    lossSamples,
    unit: '万元',
  };
}

module.exports = {
  overview,
  stageFunnel,
  topOpportunities,
  _classifyStage,
};
