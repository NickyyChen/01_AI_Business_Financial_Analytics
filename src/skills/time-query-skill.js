/**
 * time-query-skill.js - 时序趋势查询技能
 *
 * 从 PERSONAL_TREND / BUSINESS_TREND 历史快照读取数据，
 * 支持 5 种查询，结果注入 memory.trends 供 LLM 使用：
 *
 *   queryWeekDelta(empId)   → 本周 vs 上周 各指标变化
 *   queryMonthDelta(empId)  → 本月 vs 上月 各指标变化
 *   queryRank(empId)        → 全司利润率/完成率百分位排名
 *   queryAnomaly(empId)     → 连续偏离均值检测
 *   queryDirection(empId,n) → 近 n 天趋势方向 up/flat/down
 *
 * 所有查询失败返回 null，不抛异常。
 */

const config = require('../../config');
const client = require('../clients/feishu-client');
const logger = require('../utils/logger');

// ==================== 工具函数 ====================

function dateStr(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * 从 PERSONAL_TREND 读取指定员工的历史记录（最近 N 条）
 */
async function fetchPersonalHistory(empId, empName, days = 60) {
  if (!config.TABLES.PERSONAL_TREND) return [];
  const since = daysAgo(days);
  const filter = `OR(CurrentValue.[员工ID]="${empId}",CurrentValue.[员工姓名]="${empName}")`;
  try {
    const records = await client.listRecords(config.TABLES.PERSONAL_TREND, { filter, page_size: 100 });
    // 解析日期并过滤近 N 天
    return records
      .map(r => {
        const f = r.fields || {};
        const d = f['快照日期'];
        const ds = typeof d === 'number' ? dateStr(d) : String(d || '').slice(0, 10);
        return { date: ds, ...extractFields(f) };
      })
      .filter(r => r.date >= since)
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch (e) {
    logger.warn(`[TimeQuery] 读取个人历史失败 (${empId}): ${e.message}`);
    return [];
  }
}

function extractFields(f) {
  return {
    profitRate:     Number(f['利润率_pct'] || 0),
    completionRate: Number(f['收入完成率_pct'] || 0),
    revenue:        Number(f['履约收入_万元'] || 0),
    workItems:      Number(f['工作事项数'] || 0),
    meetingMins:    Number(f['会议时长_分钟'] || 0),
    chatCount:      Number(f['对话次数'] || 0),
    anomalyRisk:    f['异动风险'] || '无',
    turnoverRisk:   f['离职风险'] || '无',
  };
}

/**
 * 读取最近 N 天全司快照
 */
async function fetchBusinessHistory(days = 60) {
  if (!config.TABLES.BUSINESS_TREND) return [];
  const since = daysAgo(days);
  try {
    const records = await client.listRecords(config.TABLES.BUSINESS_TREND, { page_size: 100 });
    return records
      .map(r => {
        const f = r.fields || {};
        const d = f['快照日期'];
        const ds = typeof d === 'number' ? dateStr(d) : String(d || '').slice(0, 10);
        return {
          date:           ds,
          profitRateP50:  Number(f['利润率P50'] || 0),
          profitRateP75:  Number(f['利润率P75'] || 0),
          avgProfitRate:  Number(f['全司均值利润率'] || 0),
          avgCompletion:  Number(f['全司均值完成率'] || 0),
          highRiskCount:  Number(f['高风险人数'] || 0),
          totalCount:     Number(f['分析员工总数'] || 0),
        };
      })
      .filter(r => r.date >= since)
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch (e) {
    logger.warn(`[TimeQuery] 读取全司历史失败: ${e.message}`);
    return [];
  }
}

// ==================== 5 种查询 ====================

/**
 * 1. 周环比：取本周均值 vs 上周均值
 */
async function queryWeekDelta(empId, empName) {
  const history = await fetchPersonalHistory(empId, empName, 21);
  if (history.length < 2) return null;

  const today = new Date().toISOString().slice(0, 10);
  const thisWeekStart = daysAgo(7);
  const lastWeekStart = daysAgo(14);

  const thisWeek = history.filter(r => r.date >= thisWeekStart && r.date <= today);
  const lastWeek = history.filter(r => r.date >= lastWeekStart && r.date < thisWeekStart);
  if (!thisWeek.length || !lastWeek.length) return null;

  const metrics = ['profitRate', 'completionRate', 'revenue', 'workItems', 'meetingMins'];
  const delta = {};
  for (const m of metrics) {
    const cur = avg(thisWeek.map(r => r[m]));
    const prev = avg(lastWeek.map(r => r[m]));
    const diff = cur - prev;
    const pct = prev !== 0 ? Math.round(diff / prev * 100) : null;
    delta[m] = { cur: Math.round(cur * 100) / 100, prev: Math.round(prev * 100) / 100, diff: Math.round(diff * 100) / 100, pct };
  }
  return { period: '周', delta };
}

/**
 * 2. 月环比：取本月均值 vs 上月均值
 */
async function queryMonthDelta(empId, empName) {
  const history = await fetchPersonalHistory(empId, empName, 62);
  if (history.length < 2) return null;

  const now = new Date();
  const thisMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthStr = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}`;

  const thisMonth = history.filter(r => r.date.startsWith(thisMonthStr));
  const prevMonth = history.filter(r => r.date.startsWith(lastMonthStr));
  if (!thisMonth.length || !prevMonth.length) return null;

  const metrics = ['profitRate', 'completionRate', 'revenue', 'workItems'];
  const delta = {};
  for (const m of metrics) {
    const cur = avg(thisMonth.map(r => r[m]));
    const prev = avg(prevMonth.map(r => r[m]));
    const diff = cur - prev;
    const pct = prev !== 0 ? Math.round(diff / prev * 100) : null;
    delta[m] = { cur: Math.round(cur * 100) / 100, prev: Math.round(prev * 100) / 100, diff: Math.round(diff * 100) / 100, pct };
  }
  return { period: '月', delta };
}

/**
 * 3. 全司排名：用最新全司快照做分位定位
 */
async function queryRank(empId, empName) {
  const [personal, business] = await Promise.all([
    fetchPersonalHistory(empId, empName, 3),
    fetchBusinessHistory(7),
  ]);
  if (!personal.length || !business.length) return null;

  const latest = personal[personal.length - 1];
  const biz = business[business.length - 1];

  function calcPercentile(value, p50, p75) {
    if (value >= p75) return '>P75';
    if (value >= p50) return 'P50~P75';
    return '<P50';
  }

  return {
    profitRate: {
      value: latest.profitRate,
      rank: calcPercentile(latest.profitRate, biz.profitRateP50, biz.profitRateP75),
      avgAll: biz.avgProfitRate,
    },
    completionRate: {
      value: latest.completionRate,
      avgAll: biz.avgCompletion,
    },
  };
}

/**
 * 4. 异常检测：连续 N 天偏离全司均值 20% 以上
 */
async function queryAnomaly(empId, empName, thresholdPct = 20, minDays = 3) {
  const [personal, business] = await Promise.all([
    fetchPersonalHistory(empId, empName, 30),
    fetchBusinessHistory(30),
  ]);
  if (personal.length < minDays || !business.length) return null;

  const bizMap = {};
  for (const b of business) bizMap[b.date] = b;

  const anomalies = [];
  let streak = 0;
  let streakMetric = null;

  for (const p of personal.slice(-14)) {
    const biz = bizMap[p.date];
    if (!biz || !biz.avgProfitRate) continue;
    const devPct = biz.avgProfitRate !== 0
      ? Math.abs((p.profitRate - biz.avgProfitRate) / biz.avgProfitRate * 100)
      : 0;
    if (devPct >= thresholdPct) {
      streak++;
      streakMetric = { date: p.date, value: p.profitRate, avgAll: biz.avgProfitRate, devPct: Math.round(devPct) };
    } else {
      streak = 0;
    }
    if (streak >= minDays) {
      anomalies.push({ ...streakMetric, streakDays: streak });
    }
  }

  return anomalies.length > 0 ? anomalies : null;
}

/**
 * 5. 趋势方向：近 n 天指标线性回归方向
 */
async function queryDirection(empId, empName, n = 7) {
  const history = await fetchPersonalHistory(empId, empName, n + 5);
  const recent = history.slice(-n);
  if (recent.length < 3) return null;

  function direction(arr) {
    const vals = arr.map(r => r);
    const mid = Math.floor(vals.length / 2);
    const firstHalf = avg(vals.slice(0, mid));
    const secondHalf = avg(vals.slice(mid));
    const diff = secondHalf - firstHalf;
    if (Math.abs(diff) < 1) return 'flat';
    return diff > 0 ? 'up' : 'down';
  }

  return {
    days: n,
    profitRate:     direction(recent.map(r => r.profitRate)),
    completionRate: direction(recent.map(r => r.completionRate)),
    workItems:      direction(recent.map(r => r.workItems)),
  };
}

// ==================== 聚合入口 ====================

/**
 * 一次性拉取员工所有时序趋势（并行，失败静默）
 * @returns {object} trends 对象，注入 memory.trends
 */
async function fetchAllTrends(empId, empName) {
  const [week, month, rank, anomaly, direction] = await Promise.allSettled([
    queryWeekDelta(empId, empName),
    queryMonthDelta(empId, empName),
    queryRank(empId, empName),
    queryAnomaly(empId, empName),
    queryDirection(empId, empName, 7),
  ]);

  return {
    weekDelta:  week.status === 'fulfilled' ? week.value : null,
    monthDelta: month.status === 'fulfilled' ? month.value : null,
    rank:       rank.status === 'fulfilled' ? rank.value : null,
    anomaly:    anomaly.status === 'fulfilled' ? anomaly.value : null,
    direction:  direction.status === 'fulfilled' ? direction.value : null,
  };
}

/**
 * 将 trends 格式化为 LLM 可读文本
 */
function formatTrendsForLLM(trends) {
  if (!trends) return '';
  const parts = ['【近期趋势分析】'];

  const METRIC_LABELS = {
    profitRate:     '利润率(%)',
    completionRate: '收入完成率(%)',
    revenue:        '履约收入(万)',
    workItems:      '工作事项数',
    meetingMins:    '会议时长(分钟)',
  };

  const DIR_LABEL = { up: '↑上升', flat: '→持平', down: '↓下降' };

  // 周环比
  if (trends.weekDelta) {
    parts.push('◆ 周环比（本周 vs 上周均值）');
    const { delta } = trends.weekDelta;
    for (const [key, label] of Object.entries(METRIC_LABELS)) {
      const d = delta[key];
      if (!d) continue;
      const arrow = d.diff > 0 ? '▲' : d.diff < 0 ? '▼' : '—';
      const pctStr = d.pct != null ? ` (${d.pct > 0 ? '+' : ''}${d.pct}%)` : '';
      parts.push(`  ${label}: ${d.cur} vs ${d.prev} ${arrow}${Math.abs(d.diff)}${pctStr}`);
    }
  }

  // 月环比
  if (trends.monthDelta) {
    parts.push('◆ 月环比（本月 vs 上月均值）');
    const { delta } = trends.monthDelta;
    for (const [key, label] of Object.entries(METRIC_LABELS)) {
      const d = delta[key];
      if (!d) continue;
      const arrow = d.diff > 0 ? '▲' : d.diff < 0 ? '▼' : '—';
      const pctStr = d.pct != null ? ` (${d.pct > 0 ? '+' : ''}${d.pct}%)` : '';
      parts.push(`  ${label}: ${d.cur} vs ${d.prev} ${arrow}${Math.abs(d.diff)}${pctStr}`);
    }
  }

  // 全司排名
  if (trends.rank) {
    parts.push('◆ 全司排名');
    const r = trends.rank;
    if (r.profitRate) {
      parts.push(`  利润率: ${r.profitRate.value}% | 分位区间: ${r.profitRate.rank} | 全司均值: ${r.profitRate.avgAll}%`);
    }
    if (r.completionRate) {
      parts.push(`  收入完成率: ${r.completionRate.value}% | 全司均值: ${r.completionRate.avgAll}%`);
    }
  }

  // 异常检测
  if (trends.anomaly && trends.anomaly.length > 0) {
    parts.push('◆ 异常检测');
    for (const a of trends.anomaly) {
      parts.push(`  ⚠ 利润率连续 ${a.streakDays} 天偏离全司均值 ${a.devPct}%（${a.date} 实际${a.value}% vs 均值${a.avgAll}%）`);
    }
  }

  // 趋势方向
  if (trends.direction) {
    parts.push(`◆ 近 ${trends.direction.days} 天趋势`);
    const d = trends.direction;
    parts.push(`  利润率: ${DIR_LABEL[d.profitRate] || d.profitRate}  完成率: ${DIR_LABEL[d.completionRate] || d.completionRate}  工作事项: ${DIR_LABEL[d.workItems] || d.workItems}`);
  }

  return parts.length > 1 ? parts.join('\n') : '';
}

module.exports = {
  fetchAllTrends,
  formatTrendsForLLM,
  queryWeekDelta,
  queryMonthDelta,
  queryRank,
  queryAnomaly,
  queryDirection,
};
