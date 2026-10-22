/**
 * promotion-recommend-engine.js - 晋升推荐引擎
 *
 * 基于 PROMOTION_GAP 数据，自动筛选符合晋升条件的员工，
 * 按部门/团队分组，结合晋升窗口和名额比例输出推荐名单。
 *
 * 依赖：PROMOTION_GAP 数据已由手动/运营流程刷新。
 *
 * 输出：
 *   - 推荐名单（按部门分组）
 *   - 储备梯队（接近但未满足条件）
 *   - 风险提示（名额不足等）
 */

'use strict';

const config = require('../../config');
const client = require('../clients/feishu-client');
const logger = require('../utils/logger');

/**
 * 生成晋升推荐报告
 * @param {object} [opts] - { scope, filterDept }
 * @returns {object} { recommended, pipeline, stats, report }
 */
async function generateRecommendations(opts = {}) {
  const gapTableId = config.TABLES.PROMOTION_GAP;
  if (!gapTableId) {
    throw new Error('PROMOTION_GAP 表未配置');
  }

  const [gapRecords, empRecords] = await Promise.all([
    client.listRecords(gapTableId, { page_size: 500 }),
    client.listRecords(config.TABLES.EMPLOYEE, { page_size: 500 }),
  ]);

  // 建立姓名 → 部门映射
  const nameToDept = {};
  for (const r of empRecords) {
    const f = r.fields || {};
    const name = f['姓名'] || '';
    const dept = f['标准部门'] || f['一级部门'] || '';
    if (name) nameToDept[name] = dept;
  }

  const allGaps = gapRecords.map(r => {
    const f = r.fields || {};
    return {
      name: f['姓名'] || '',
      empId: f['员工ID'] || '',
      currentRank: f['当前职级'] || '',
      targetRank: f['目标职级'] || '',
      status: f['当前状态'] || '',
      attainment: f['综合达成度_pct'] || 0,
      learningGap: f['学习差距_pct'] || 0,
      unmetSku: f['待补SKU'] || '',
      metSku: f['已满足SKU'] || '',
      window: f['晋升窗口'] || '',
      quotaPct: f['推荐名额比例_pct'] || 0,
      needs360: f['需要360评估'] || false,
      needsReview: f['需要人工评审'] || false,
      conclusion: f['综合差距结论'] || '',
      advice: f['努力建议'] || '',
      dept: nameToDept[f['姓名'] || ''] || '',
    };
  });

  // 权限过滤
  let filtered = allGaps;
  if (opts.scope && !opts.scope.isGlobal) {
    const allowed = new Set(opts.scope.subordinateNames || []);
    filtered = allGaps.filter(g => allowed.has(g.name));
  }
  if (opts.filterDept) {
    filtered = filtered.filter(g => g.dept === opts.filterDept);
  }

  // 分类
  const recommended = filtered
    .filter(g => g.status === '可晋升评审')
    .sort((a, b) => b.attainment - a.attainment);

  const pipeline = filtered
    .filter(g => g.status !== '可晋升评审' && g.attainment >= 60)
    .sort((a, b) => b.attainment - a.attainment);

  const needsFocus = filtered
    .filter(g => g.attainment < 60)
    .sort((a, b) => a.attainment - b.attainment);

  // 按部门分组统计
  const deptStats = {};
  for (const g of filtered) {
    const dept = g.dept || '未分配';
    if (!deptStats[dept]) deptStats[dept] = { total: 0, ready: 0, pipeline: 0, dept };
    deptStats[dept].total++;
    if (g.status === '可晋升评审') deptStats[dept].ready++;
    else if (g.attainment >= 60) deptStats[dept].pipeline++;
  }

  // 名额估算（按窗口分组）
  const windowQuota = {};
  for (const g of filtered) {
    if (!g.window) continue;
    if (!windowQuota[g.window]) {
      windowQuota[g.window] = { total: 0, ready: 0, quotaPct: g.quotaPct };
    }
    windowQuota[g.window].total++;
    if (g.status === '可晋升评审') windowQuota[g.window].ready++;
  }

  const stats = {
    totalCandidates: filtered.length,
    readyCount: recommended.length,
    pipelineCount: pipeline.length,
    needsFocusCount: needsFocus.length,
    deptStats: Object.values(deptStats),
    windowQuota,
  };

  const report = formatReport(recommended, pipeline, needsFocus, stats);

  return { recommended, pipeline, needsFocus, stats, report };
}

function formatReport(recommended, pipeline, needsFocus, stats) {
  const lines = [`【晋升推荐报告】\n`];

  // 总览
  lines.push(`📊 **总览**: ${stats.totalCandidates}人纳入评估 | 🟢可推荐${stats.readyCount}人 | 🟡储备${stats.pipelineCount}人 | 🔴需辅导${stats.needsFocusCount}人`);
  lines.push('');

  // 推荐名单
  if (recommended.length > 0) {
    lines.push('✅ **推荐晋升名单**');
    const byDept = _groupByDept(recommended);
    for (const [dept, members] of Object.entries(byDept)) {
      lines.push(`\n  📁 ${dept} (${members.length}人)`);
      for (const m of members) {
        lines.push(`    • ${m.name} | ${m.currentRank} → ${m.targetRank} | 达成度${m.attainment}%${m.needs360 ? ' | 需360评估' : ''}${m.needsReview ? ' | 需人工评审' : ''}`);
      }
    }
    lines.push('');
  } else {
    lines.push('❌ 当前无人满足全部晋升条件。\n');
  }

  // 储备梯队
  if (pipeline.length > 0) {
    lines.push('🟡 **储备梯队（达成度>=60%，接近晋升）**');
    for (const m of pipeline.slice(0, 10)) {
      lines.push(`  • ${m.name} | ${m.currentRank} | 达成度${m.attainment}% | 差: ${m.unmetSku || '学习完成率'}`);
    }
    if (pipeline.length > 10) lines.push(`  ...共${pipeline.length}人`);
    lines.push('');
  }

  // 部门统计
  if (stats.deptStats.length > 0) {
    lines.push('📋 **部门统计**');
    for (const d of stats.deptStats.sort((a, b) => b.ready - a.ready)) {
      lines.push(`  ${d.dept}: 评估${d.total}人 | 可推荐${d.ready}人 | 储备${d.pipeline}人`);
    }
    lines.push('');
  }

  // 名额预估
  for (const [window, q] of Object.entries(stats.windowQuota)) {
    const estimateQuota = Math.round(q.total * (q.quotaPct / 100));
    const isOverQuota = q.ready > estimateQuota && estimateQuota > 0;
    lines.push(`📅 晋升窗口 ${window}: 预计名额${estimateQuota}个 | 符合条件${q.ready}人${isOverQuota ? ' ⚠️ 超额' : ''}`);
  }

  return lines.join('\n');
}

function _groupByDept(items) {
  const groups = {};
  for (const item of items) {
    const dept = item.dept || '未分配';
    if (!groups[dept]) groups[dept] = [];
    groups[dept].push(item);
  }
  return groups;
}

module.exports = { generateRecommendations };
