/**
 * risk-tools.js - 风险预警工具集
 *
 * 从 risk-alert-skill.js 提取的纯计算逻辑。
 * alerts: 解析 USER_RISK_ALERT 快照
 * checkup: 调用 riskEngine.fullCheckup 逐项排查
 */

const riskEngine = require('../engines/risk-engine');

// ==================== B1. 今日风险告警 ====================

function alerts(memory, scope) {
  const records = memory.riskAlerts || [];
  if (records.length === 0) {
    return { empty: true, message: '今日暂无触发预警事件，经营状态正常' };
  }

  const red = [];
  const yellow = [];
  const others = [];
  const byPerson = {};

  for (const r of records) {
    const f = r.fields || {};
    const color = f['预警颜色'] || '';
    const name = f['员工姓名'] || f['员工ID'] || '未知';

    const item = {
      person: name,
      ruleName: f['规则名称'] || '',
      indicatorName: f['指标名称'] || '',
      actualValue: f['实际值'] != null ? Number(f['实际值']) : null,
      threshold: f['阈值'] ?? null,
      operator: f['比较符'] || '',
      unit: f['阈值单位'] || '',
      color,
      action: f['调控动作'] || '',
    };

    if (color === '红') red.push(item);
    else if (color === '黄') yellow.push(item);
    else others.push(item);

    if (!byPerson[name]) byPerson[name] = { red: 0, yellow: 0, other: 0 };
    if (color === '红') byPerson[name].red++;
    else if (color === '黄') byPerson[name].yellow++;
    else byPerson[name].other++;
  }

  const ruleCount = {};
  for (const r of records) {
    const name = (r.fields || {})['规则名称'] || '未知';
    ruleCount[name] = (ruleCount[name] || 0) + 1;
  }
  const topRules = Object.entries(ruleCount).sort((a, b) => b[1] - a[1]);

  // 提取最新扫描日期
  let scanDate = null;
  for (const r of records) {
    const d = (r.fields || {})['扫描日期'];
    if (d && (!scanDate || String(d) > String(scanDate))) scanDate = String(d);
  }

  return {
    scanDate: scanDate || new Date().toISOString().slice(0, 10),
    dataNote: '告警基于每日定时扫描，经营数据为月报口径（可能滞后当月），回款数据为实时维护',
    total: records.length,
    redCount: red.length,
    yellowCount: yellow.length,
    otherCount: others.length,
    personCount: Object.keys(byPerson).length,
    alerts: [...red, ...yellow, ...others],
    byPerson: Object.entries(byPerson).map(([name, counts]) => ({ name, ...counts })),
    topRules: topRules.slice(0, 3).map(([name, count]) => ({ name, count })),
  };
}

// ==================== B2. 风险全面排查 ====================

function checkup(memory, scope) {
  const rules = memory.riskControlRules || [];
  if (rules.length === 0) {
    return { empty: true, message: '风控规则表为空，无法执行排查' };
  }

  const role = (scope && scope.role) || '员工';
  const results = riskEngine.fullCheckup(rules, memory, role);

  const triggered = results.filter(r => r.status === 'triggered');
  const passed = results.filter(r => r.status === 'pass');
  const nodata = results.filter(r => r.status === 'nodata');
  const skipped = results.filter(r => r.status === 'skipped');

  const byIndicator = {};
  for (const r of triggered) {
    const key = r.indicatorName || '未知';
    if (!byIndicator[key]) byIndicator[key] = [];
    byIndicator[key].push(r);
  }
  const topIndicators = Object.entries(byIndicator)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3)
    .map(([name, items]) => ({ name, count: items.length }));

  return {
    checkedCount: results.length - skipped.length,
    triggeredCount: triggered.length,
    passedCount: passed.length,
    nodataCount: nodata.length,
    skippedCount: skipped.length,
    triggered,
    passed,
    nodata,
    topIndicators,
    redTriggeredCount: triggered.filter(r => r.color === '红').length,
    yellowTriggeredCount: triggered.filter(r => r.color === '黄').length,
  };
}

module.exports = { alerts, checkup };
