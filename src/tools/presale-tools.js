/**
 * presale-tools.js - 售前项目分析工具
 *
 * 数据源：🟢 售前项目表（PRESALE_PROJECT，tblafsNAQnCANMlV），
 * 记录售前管线（商机→方案评审→投标→中标/丢单）。
 *
 * 所有函数签名: (memory, scope) => structuredResult
 */

const FM = require('../utils/field-mapping');
const displayUtils = require('./display-result-set-utils');

const PF = FM.PRESALE_FIELDS;

function _getOwner(f) {
  const v = f[PF.OWNER];
  if (Array.isArray(v)) return v[0]?.name || v[0]?.en_name || '';
  return FM.str(f, PF.OWNER);
}

// 2026-05-08 最终口径（极简版）：只看"售前状态"字段；"是否中标"完全废弃
//   - 含 "赢单" / "中标"      → won
//   - 含 "落选" / "暂停" / "终止" → lost
//   - 其他（进行中/无匹配服务/陪标/空）→ ongoing，不入赢单率分母
// 历史规则把"无匹配服务/陪标"也算 lost，污染赢单率分母；本版按业务确认收口。
//
// 容错说明：飞书表中偶有 stage 值末尾乱码（如"客户终��"），含"终止"判断会漏识别；
// 用前缀白名单兜底，让业务侧已知的 3 类 lost 状态都能正确分类。
function _classify(_isWon, stage) {
  const s = FM.str({ v: stage }, 'v');
  if (s.includes('赢单') || s.includes('中标')) return 'won';
  if (s.includes('落选') || s.includes('暂停') || s.includes('终止')) return 'lost';
  if (s.startsWith('客户终') || s.startsWith('竞标落') || s.startsWith('客户暂')) return 'lost';
  return 'ongoing';
}

function _buildScopeLabel(scope) {
  if (!scope) return '(未知)';
  if (scope.isGlobal) return '全公司';
  const depts = Array.isArray(scope.depts) ? scope.depts.filter(Boolean) : [];
  if (depts.length === 0) return '(未知)';
  return depts.join(' + ');
}

function _scopeCohesionHint(scope, subject) {
  const scopeLabel = _buildScopeLabel(scope);
  if (scope && scope.isGlobal) {
    return `本次${subject}覆盖全公司。回答必须沿用“全公司”scope；如果用户说“我的部门/我们部门”，也不能把员工主档组织归属改写成本轮筛选范围，禁止写“你所在部门暂无，所以扩大范围看全公司”。`;
  }
  if (scopeLabel && scopeLabel !== '(未知)') {
    return `本次${subject}覆盖 ${scopeLabel}。回答时必须沿用这个 scope，禁止写成全公司。`;
  }
  return `本次${subject}覆盖当前用户权限范围。回答时必须沿用该 scope，禁止自行根据员工主档部门改写范围。`;
}

function _loadErrors(memory) {
  const trace = memory && memory._traceMeta;
  const errors = trace && Array.isArray(trace.fetchErrors) ? trace.fetchErrors : [];
  return errors.filter((err) => err && err.tableKey === 'presale');
}

function _emptyPresaleResult(memory, fallbackMessage) {
  const loadErrors = _loadErrors(memory);
  if (loadErrors.length > 0) {
    return {
      empty: true,
      incomplete: true,
      message: '本次售前项目表读取失败，无法判断当前是否有售前数据，请稍后重试或联系管理员查看 Feishu 表状态。',
      loadErrors,
      _sourceTable: 'PRESALE_PROJECT（售前项目表）',
    };
  }
  return {
    empty: true,
    message: fallbackMessage || '当前权限范围内暂无售前数据',
    _sourceTable: 'PRESALE_PROJECT（售前项目表）',
  };
}

function _presaleValue(row, sortBy) {
  if (sortBy === 'winRate') return row.winRate;
  if (sortBy === 'estAmount') return row.estAmount;
  if (sortBy === 'estWinRate') return row.estWinRate;
  if (sortBy === 'wonAmount') return row.wonAmount;
  if (sortBy === 'lostAmount') return row.lostAmount;
  if (sortBy === 'ongoingAmount') return row.ongoingAmount;
  if (sortBy === 'staleDays') return row.staleDays;
  if (sortBy === 'total' || sortBy === 'totalCount') return row.total ?? row.totalCount;
  if (sortBy === 'won') return row.won ?? row.wonCount;
  if (sortBy === 'lost') return row.lost ?? row.lostCount;
  if (sortBy === 'ongoing') return row.ongoing ?? row.ongoingCount;
  return row.estAmount ?? row.wonAmount ?? row.total ?? row.totalCount;
}

function _normalizePresaleSortBy(params, fallback) {
  const raw = String(params && params.sortBy || '').trim();
  if (['winRate', 'estAmount', 'estWinRate', 'wonAmount', 'lostAmount', 'ongoingAmount', 'staleDays', 'total', 'totalCount', 'won', 'lost', 'ongoing'].includes(raw)) return raw;
  return fallback;
}

function _buildPresaleDisplay({ toolId, type, rows, params, scope, sortBy, rowMapper, orderFallback = 'desc' }) {
  if (!displayUtils.shouldBuild(params, scope)) return {};
  const sortOrder = displayUtils.order(params, orderFallback);
  const sorted = displayUtils.sortRows(rows, sortBy, sortOrder, _presaleValue, row => row.name || row.dept || row.owner || row.sku);
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

// ==================== T1. 售前漏斗总览 ====================

function overview(memory, scope, params = {}) {
  const records = memory.presaleProjects || [];
  if (records.length === 0) return {
    ..._emptyPresaleResult(memory, '暂无售前数据（售前项目表无记录或权限过滤后为空；请确认 scope.depts 覆盖售前跟进部门）'),
    totalCount: 0, wonCount: 0, lostCount: 0, ongoingCount: 0,
    winRate: null, totalEstAmount: 0, wonAmount: 0,
    stageDistribution: [], deptStats: [], topOpportunities: [],
  };

  const byStage = {};
  const byDept = {};
  let totalEstAmount = 0;
  let wonCount = 0, lostCount = 0, ongoingCount = 0;
  let wonAmount = 0, ongoingEstAmount = 0;
  const topList = [];

  for (const r of records) {
    const f = r.fields || {};
    const stage = FM.str(f, PF.STAGE) || '未分阶段';
    const dept = FM.str(f, PF.DEPT) || '未分部门';
    const estAmount = FM.num(f, PF.EST_AMOUNT);
    const actualAmount = FM.num(f, PF.ACTUAL_AMOUNT);
    const isWon = FM.str(f, PF.IS_WON);
    const result = _classify(isWon, stage);

    byStage[stage] = byStage[stage] || { count: 0, estAmount: 0 };
    byStage[stage].count++;
    byStage[stage].estAmount += estAmount;

    byDept[dept] = byDept[dept] || { count: 0, won: 0, lost: 0, ongoing: 0, estAmount: 0, wonAmount: 0 };
    byDept[dept].count++;
    byDept[dept].estAmount += estAmount;
    byDept[dept][result]++;
    if (result === 'won') byDept[dept].wonAmount += actualAmount || estAmount;

    if (result === 'won') { wonCount++; wonAmount += actualAmount || estAmount; }
    else if (result === 'lost') lostCount++;
    else { ongoingCount++; ongoingEstAmount += estAmount; }
    totalEstAmount += estAmount;

    topList.push({
      name: FM.str(f, PF.NAME),
      dept,
      owner: _getOwner(f),
      stage,
      estAmount,
      estWinRate: FM.num(f, PF.EST_WIN_RATE),
      result,
      isWon: isWon || '',
    });
  }

  topList.sort((a, b) => b.estAmount - a.estAmount);

  const decisive = wonCount + lostCount; // 已出结果的
  const winRate = decisive > 0 ? (wonCount / decisive) : null;

  const deptStats = Object.entries(byDept).map(([name, d]) => {
    const decisiveD = d.won + d.lost;
    return {
      dept: name,
      totalCount: d.count,
      wonCount: d.won,
      lostCount: d.lost,
      ongoingCount: d.ongoing,
      winRate: decisiveD > 0 ? d.won / decisiveD : null,
      estAmount: d.estAmount,
      wonAmount: d.wonAmount,
    };
  }).sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1));

  // factSheet：预渲染关键数字，防止 LLM 幻觉
  const _fmtW = v => (v / 10000).toFixed(1);
  const scopeLabel = _buildScopeLabel(scope);
  const scopeTag = `[${scopeLabel}]`;
  const factSheet = [
    `${scopeTag} 售前项目总数 ${records.length} 个：赢单 ${wonCount} / 丢单 ${lostCount} / 跟进中 ${ongoingCount}（跟进中/无匹配/陪标/空状态不计入赢单率分母）`,
    `${scopeTag} 赢单率 ${winRate !== null ? (winRate * 100).toFixed(1) + '%' : '暂无（无已决项目）'}（公式：赢单数 ÷ (赢单数+丢单数)）`,
    `${scopeTag} 全部项目预估金额合计 ${_fmtW(totalEstAmount)}万，其中：赢单 ${_fmtW(wonAmount)}万 / 跟进中 ${_fmtW(ongoingEstAmount)}万`,
  ];
  for (const d of deptStats.slice(0, 10)) {
    const wr = d.winRate !== null ? (d.winRate * 100).toFixed(1) + '%' : '—';
    factSheet.push(`${d.dept}：共${d.totalCount}个（赢${d.wonCount}/丢${d.lostCount}/跟进${d.ongoingCount}）赢单率 ${wr} | 预估 ${_fmtW(d.estAmount)}万`);
  }
  const q = String((scope && scope.question) || '');
  const useDept = /部门|行业群|团队|赢单率/.test(q) || ['winRate', 'wonAmount', 'totalCount'].includes(String(params && params.sortBy || ''));
  const displayPayload = useDept
    ? _buildPresaleDisplay({
        toolId: 'presale.overview',
        type: 'presale.depts',
        rows: deptStats,
        params,
        scope,
        sortBy: _normalizePresaleSortBy(params, /赢单率|转化率/.test(q) ? 'winRate' : 'estAmount'),
        rowMapper: row => ({
          type: 'dept',
          name: row.dept,
          totalCount: row.totalCount,
          wonCount: row.wonCount,
          lostCount: row.lostCount,
          ongoingCount: row.ongoingCount,
          winRate: row.winRate,
          estAmount: row.estAmount,
          wonAmount: row.wonAmount,
        }),
      })
    : _buildPresaleDisplay({
        toolId: 'presale.overview',
        type: 'presale.opportunities',
        rows: topList,
        params,
        scope,
        sortBy: _normalizePresaleSortBy(params, 'estAmount'),
        rowMapper: row => ({ type: 'project', name: row.name, dept: row.dept, owner: row.owner, stage: row.stage, estAmount: row.estAmount, estWinRate: row.estWinRate, result: row.result }),
      });

  return {
    totalCount: records.length,
    wonCount,
    lostCount,
    ongoingCount,
    winRate,
    totalEstAmount,
    ongoingEstAmount,
    wonAmount,
    stageDistribution: Object.entries(byStage).map(([k, v]) => ({ stage: k, count: v.count, estAmount: v.estAmount })),
    deptStats,
    topOpportunities: topList.slice(0, 15),
    ...displayPayload,
    factSheet,
    _classifyRule: '丢单口径（2026-05-08）：只看"售前状态"字段；含赢单/中标→won，含落选/暂停/终止→lost，其余（进行中/无匹配服务/陪标/空）→ongoing 不入分母。topOpportunities 中 result="ongoing" 的才是在跟项目。',
    _periodLabel: '当前状态快照（基于本轮 Memory 加载；Memory 最长 5 分钟用户级缓存，与回款 INVOICE 取数口径相同）',
    _sourceTable: 'PRESALE_PROJECT（售前项目表）',
    _scopeLabel: scopeLabel,
    _cohesionHint: _scopeCohesionHint(scope, '售前数据'),
    _factSheet: factSheet,
  };
}

// ==================== T2. 赢/丢单分析 ====================

function winLossAnalysis(memory, scope, params = {}) {
  const records = memory.presaleProjects || [];
  if (records.length === 0) {
    // 返回完整结构骨架，避免 Answer LLM 拿到 undefined 字段；同时保留 empty 标记
    return {
      ..._emptyPresaleResult(memory, '暂无售前数据（权限过滤后 presaleProjects=0）。若问题属于"历史商机/赢单率"类，请检查 scope.depts 是否覆盖了售前跟进部门。'),
      totalCount: 0, wonCount: 0, lostCount: 0, ongoingCount: 0,
      overallWinRate: null, wonAmount: 0, lostAmount: 0,
      byOwner: [], byDept: [], skuStats: [], wonSamples: [], lostSamples: [],
    };
  }

  const won = [], lost = [];
  const bySku = {};
  const byOwner = {};  // 2026-04-23 新增：按负责人切片，回答"每个负责人的转化率/赢单率"
  const byDept  = {};  // 同步按部门切片（覆盖跟进中的项目，和 overview.deptStats 互补）
  for (const r of records) {
    const f = r.fields || {};
    const stage = FM.str(f, PF.STAGE);
    const isWon = FM.str(f, PF.IS_WON);
    const result = _classify(isWon, stage);

    const owner = _getOwner(f) || '(未指定负责人)';
    const dept  = FM.str(f, PF.DEPT) || '(未分部门)';
    const estAmt = FM.num(f, PF.EST_AMOUNT);
    const actAmt = FM.num(f, PF.ACTUAL_AMOUNT);
    const amount = actAmt || estAmt;

    // byOwner / byDept 统计所有项目（含在跟），赢单率用 won/(won+lost)
    byOwner[owner] = byOwner[owner] || { total: 0, won: 0, lost: 0, ongoing: 0, wonAmount: 0, lostAmount: 0, ongoingAmount: 0 };
    byOwner[owner].total++;
    byOwner[owner][result]++;
    if (result === 'won')        byOwner[owner].wonAmount     += amount;
    else if (result === 'lost')  byOwner[owner].lostAmount    += estAmt;
    else                         byOwner[owner].ongoingAmount += estAmt;

    byDept[dept] = byDept[dept] || { total: 0, won: 0, lost: 0, ongoing: 0, wonAmount: 0 };
    byDept[dept].total++;
    byDept[dept][result]++;
    if (result === 'won') byDept[dept].wonAmount += amount;

    if (result === 'ongoing') continue;

    const entry = {
      name: FM.str(f, PF.NAME),
      dept,
      owner,
      stage,
      isWon,
      amount,
      customerEval: FM.str(f, PF.CUSTOMER_EVAL),
      expertiseEval: FM.str(f, PF.EXPERTISE_EVAL),
      priceEval: FM.str(f, PF.PRICE_EVAL),
      sixSummary: FM.str(f, PF.SIX_SUMMARY),
      competitor: FM.str(f, PF.SIX_COMPETITOR),
    };
    if (result === 'won') won.push(entry);
    else lost.push(entry);

    const sku = FM.str(f, PF.REL_SKU) || '未分SKU';
    bySku[sku] = bySku[sku] || { won: 0, lost: 0, wonAmount: 0 };
    bySku[sku][result]++;
    if (result === 'won') bySku[sku].wonAmount += amount;
  }

  const skuStats = Object.entries(bySku).map(([sku, d]) => ({
    sku,
    won: d.won,
    lost: d.lost,
    winRate: (d.won + d.lost) > 0 ? d.won / (d.won + d.lost) : null,
    wonAmount: d.wonAmount,
  })).sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1));

  // 按负责人：按"赢单数"降序，方便 Answer LLM 直接挑 Top 讲
  const ownerStats = Object.entries(byOwner).map(([owner, d]) => {
    const decisive = d.won + d.lost;
    return {
      owner,
      total: d.total,
      won: d.won,
      lost: d.lost,
      ongoing: d.ongoing,
      winRate: decisive > 0 ? d.won / decisive : null,
      wonAmount: d.wonAmount,
      lostAmount: d.lostAmount,
      ongoingAmount: d.ongoingAmount,
    };
  }).sort((a, b) => (b.won - a.won) || (b.total - a.total));

  const deptStats = Object.entries(byDept).map(([dept, d]) => {
    const decisive = d.won + d.lost;
    return {
      dept,
      total: d.total,
      won: d.won,
      lost: d.lost,
      ongoing: d.ongoing,
      winRate: decisive > 0 ? d.won / decisive : null,
      wonAmount: d.wonAmount,
    };
  }).sort((a, b) => b.total - a.total);

  const totalWon = won.length, totalLost = lost.length;
  const overallWinRate = (totalWon + totalLost) > 0 ? totalWon / (totalWon + totalLost) : null;
  const scopeLabel = _buildScopeLabel(scope);
  const scopeTag = `[${scopeLabel}]`;
  const q = String((scope && scope.question) || '');
  const dimension = /sku|SKU/.test(q) || String(params && params.metric || '').toLowerCase() === 'sku'
    ? 'sku'
    : /部门|行业群|团队/.test(q) || String(params && params.metric || '').toLowerCase() === 'dept'
      ? 'dept'
      : 'owner';
  const displayPayload = _buildPresaleDisplay({
    toolId: 'presale.winLoss',
    type: dimension === 'sku' ? 'presale.skus' : dimension === 'dept' ? 'presale.depts' : 'presale.owners',
    rows: dimension === 'sku' ? skuStats : dimension === 'dept' ? deptStats : ownerStats,
    params,
    scope,
    sortBy: _normalizePresaleSortBy(params, /赢单率|转化率/.test(q) ? 'winRate' : 'won'),
    rowMapper: row => ({
      type: dimension === 'dept' ? 'dept' : dimension === 'sku' ? 'sku' : 'person',
      name: row.owner || row.dept || row.sku,
      total: row.total,
      won: row.won,
      lost: row.lost,
      ongoing: row.ongoing,
      winRate: row.winRate,
      wonAmount: row.wonAmount,
      lostAmount: row.lostAmount,
      ongoingAmount: row.ongoingAmount,
    }),
  });

  return {
    wonCount: totalWon,
    lostCount: totalLost,
    ongoingCount: records.length - totalWon - totalLost,
    totalCount: records.length,
    overallWinRate, // 0~1 小数，Answer LLM 乘 100 展示为百分比
    wonAmount: won.reduce((s, e) => s + e.amount, 0),
    lostAmount: lost.reduce((s, e) => s + e.amount, 0),
    // ↓ 三个切片：负责人 / 部门 / SKU
    byOwner: ownerStats,         // 按赢单数降序，覆盖所有出现过的负责人
    byDept:  deptStats,          // 按总量降序
    skuStats: skuStats.slice(0, 15),
    ...displayPayload,
    // 明细样本
    wonSamples:  won.sort((a, b) => b.amount - a.amount).slice(0, 10),
    lostSamples: lost.sort((a, b) => b.amount - a.amount).slice(0, 10),
    _meta: {
      classifyRule: '只看"售前状态"字段：含赢单/中标→won；含落选/暂停/终止→lost；其余（含无匹配/陪标）→ongoing 不入分母。',
    },
    _periodLabel: '当前状态快照（基于本轮 Memory 加载；Memory 最长 5 分钟用户级缓存）',
    _sourceTable: 'PRESALE_PROJECT（售前项目表）',
    _scopeLabel: scopeLabel,
    _cohesionHint: _scopeCohesionHint(scope, '赢丢单分析'),
    _factSheet: (() => {
      const _w = v => (v / 10000).toFixed(1);
      const lines = [
        `${scopeTag}[当前快照] 总商机 ${records.length} | 赢单 ${totalWon} | 丢单 ${totalLost} | 跟进中 ${records.length - totalWon - totalLost}`,
        `${scopeTag}[当前快照] 整体赢单率 ${overallWinRate !== null ? (overallWinRate * 100).toFixed(1) + '%' : '—'}（分母仅含赢+丢，跟进中/无匹配/陪标不计入）`,
        `${scopeTag}[当前快照] 赢单金额 ${_w(won.reduce((s, e) => s + e.amount, 0))}万 | 丢单金额 ${_w(lost.reduce((s, e) => s + e.amount, 0))}万`,
      ];
      ownerStats.slice(0, 8).forEach(o => {
        const wr = o.winRate !== null ? (o.winRate * 100).toFixed(0) + '%' : '—';
        lines.push(`[负责人=${o.owner}] 总${o.total} | 赢${o.won} | 丢${o.lost} | 跟${o.ongoing} | 赢单率 ${wr} | 赢单金额 ${_w(o.wonAmount)}万`);
      });
      return lines;
    })(),
  };
}

// ==================== T3. 跟进中大单 ====================

function pendingList(memory, scope, opts = {}) {
  const topN = Math.max(1, Math.min(50, opts.topN || opts.top || 10));
  const records = memory.presaleProjects || [];
  if (records.length === 0) return _emptyPresaleResult(memory, '当前权限范围内暂无跟进中售前线索');

  // Fix #2: 先 filter+map 得到全量 allOngoing，再 slice 取 top，避免 count 被截断
  const allOngoing = records
    .filter(r => {
      const f = r.fields || {};
      return _classify(FM.str(f, PF.IS_WON), FM.str(f, PF.STAGE)) === 'ongoing';
    })
    .map(r => {
      const f = r.fields || {};
      // 滞留时长：优先 售前录入时间，其次 创建时间
      const recordTime = f[PF.RECORD_TIME];
      const createdTime = f[PF.CREATED];
      const refTs = (Array.isArray(recordTime) ? recordTime[0] : recordTime)
        || (Array.isArray(createdTime) ? createdTime[0] : createdTime);
      const staleDays = (typeof refTs === 'number' && refTs > 0)
        ? Math.max(0, Math.floor((Date.now() - refTs) / 86400000))
        : null;
      return {
        name: FM.str(f, PF.NAME),
        dept: FM.str(f, PF.DEPT),
        owner: _getOwner(f),
        stage: FM.str(f, PF.STAGE),
        estAmount: FM.num(f, PF.EST_AMOUNT),
        estWinRate: FM.num(f, PF.EST_WIN_RATE),
        estSignDate: FM.str(f, PF.EST_SIGN_DATE),
        rating: FM.str(f, PF.RATING),
        bidDeadline: FM.str(f, PF.BID_DEADLINE),
        budget: FM.str(f, PF.SIX_BUDGET)?.slice(0, 60),
        decisionFlow: FM.str(f, PF.SIX_DECISION)?.slice(0, 60),
        staleDays,                            // 2026-05-08 新增：滞留天数（now - 录入/创建时间）
      };
    })
    .sort((a, b) => b.estAmount - a.estAmount);

  const top = allOngoing.slice(0, topN);

  // factSheet：预渲染滞留时间长 / 金额高 的前 8 条
  const _w = v => (v / 10000).toFixed(1);
  const scopeLabel = _buildScopeLabel(scope);
  const scopeTag = `[${scopeLabel}]`;
  const factSheet = [
    `${scopeTag}[当前快照] 跟进中线索共 ${allOngoing.length} 条 | 预估金额合计 ${_w(allOngoing.reduce((s, e) => s + e.estAmount, 0))}万`,
  ];
  top.slice(0, 8).forEach(t => {
    factSheet.push(`[${t.dept || '?'}] ${t.name} | 负责人=${t.owner || '?'} | 状态=${t.stage} | 预估 ${_w(t.estAmount)}万 | 滞留 ${t.staleDays !== null ? t.staleDays + '天' : '—'}`);
  });

  const displayPayload = _buildPresaleDisplay({
    toolId: 'presale.pending',
    type: 'presale.pendingOpportunities',
    rows: allOngoing,
    params: opts,
    scope,
    sortBy: _normalizePresaleSortBy(opts, /滞留|多久|流转/.test(String((scope && scope.question) || '')) ? 'staleDays' : 'estAmount'),
    rowMapper: row => ({
      type: 'project',
      name: row.name,
      dept: row.dept,
      owner: row.owner,
      stage: row.stage,
      estAmount: row.estAmount,
      estWinRate: row.estWinRate,
      estSignDate: row.estSignDate,
      rating: row.rating,
      staleDays: row.staleDays,
    }),
  });

  return {
    ongoingCount: allOngoing.length,
    totalPipelineAmount: allOngoing.reduce((s, e) => s + e.estAmount, 0),
    top,
    ...displayPayload,
    _periodLabel: '当前状态快照（基于本轮 Memory 加载；滞留天数 = 当前时间 - 售前录入时间/创建时间）',
    _sourceTable: 'PRESALE_PROJECT（售前项目表）',
    _scopeLabel: scopeLabel,
    _cohesionHint: _scopeCohesionHint(scope, '跟进中线索'),
    _factSheet: factSheet,
  };
}

module.exports = {
  overview,
  winLossAnalysis,
  pendingList,
};
