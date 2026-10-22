/**
 * test-completion-profitrate.js
 *
 * 验证 P1-1 修复：analytics.completion 的 summary.profitRate
 *   - 改为直接由 totalProfit/totalRevenue 计算，不再依赖 metrics['利润率']
 *   - 超过 ±500% 视为数据异常，clamp 为 null 并打 warn
 *
 * 运行: node tests/test-completion-profitrate.js
 */

require('dotenv').config();

let passed = 0;
let failed = 0;

function assert(condition, desc) {
  if (condition) {
    console.log(`  ✅ ${desc}`);
    passed++;
  } else {
    console.error(`  ❌ ${desc}`);
    failed++;
  }
}

const analytics = require('../src/tools/analytics-tools');

// ==================== 构造 fixture ====================

function makeMonthly(projectName, month, revenue, cost, profit) {
  return {
    record_id: `m_${projectName}_${month}`,
    fields: {
      '是否交付项目': projectName,
      '月份': month,
      '履约收入': revenue,
      '履约成本': cost,
      '履约利润': profit,
    },
  };
}

// ==================== Test 1: 正常利润率计算 ====================
console.log('\n🧪 Test 1: 正常场景 — CEO 全局 YTD 利润率');
{
  // 模拟 YTD 聚合：10 个项目，总收入 1673 万、总利润 19.75 万 → 利润率 ≈ 1.18%
  const projectMonthly = [];
  for (let i = 1; i <= 10; i++) {
    // 每个项目 3 个月 YTD 数据，每月均摊
    for (const month of [2601, 2602, 2603]) {
      projectMonthly.push(makeMonthly(`项目${i}`, month, 557666, 552083, 2083));
      // 3 个月 × 10 项目 = 30 条
      // 每条 revenue=557666 → total = 557666×30 ÷ 3 ≈ 1673 万 / 项目聚合
    }
  }

  const memory = {
    projectMonthly,
    performanceTargets: [],
    projectMaster: [],
    profile: null,
    projectStaffing: [],
  };
  const scope = { period: 'ytd', periodYear: 2026 };
  const result = analytics.completion(memory, scope);

  console.log(`   summary: rev=${result.summary.totalRevenue}, profit=${result.summary.totalProfit}, rate=${result.summary.profitRate}`);
  assert(result.summary.totalRevenue > 0, 'totalRevenue > 0');
  assert(result.summary.totalProfit > 0, 'totalProfit > 0');
  assert(result.summary.profitRate != null, 'profitRate 非 null');
  assert(result.summary.profitRate > 0 && result.summary.profitRate < 5,
    `profitRate 合理 (${result.summary.profitRate?.toFixed(2)}% ∈ (0,5)%)`);
  // 直算验证: profitRate === totalProfit/totalRevenue * 100
  const expected = (result.summary.totalProfit / result.summary.totalRevenue) * 100;
  assert(Math.abs(result.summary.profitRate - expected) < 0.001,
    `profitRate === totalProfit/totalRevenue*100 (${result.summary.profitRate} vs ${expected})`);
}

// ==================== Test 2: 异常值 clamp (利润率 > 500%) ====================
console.log('\n🧪 Test 2: 异常值防御 — 利润率超过 500% 应 clamp 为 null');
{
  // 构造极端数据：总收入 100，总利润 10000 → 10000% 利润率
  const projectMonthly = [
    makeMonthly('异常项目', 2603, 100, 0, 10000),
  ];

  const memory = {
    projectMonthly,
    performanceTargets: [],
    projectMaster: [],
    profile: null,
    projectStaffing: [],
  };
  const scope = { period: 'ytd', periodYear: 2026 };
  const result = analytics.completion(memory, scope);

  console.log(`   异常输入: rev=100, profit=10000 → profitRate=${result.summary.profitRate}`);
  assert(result.summary.profitRate === null, 'profitRate clamp 为 null (异常数据不直接输出)');
  // totalRevenue/totalProfit 仍保留原值，便于上层排查
  assert(result.summary.totalRevenue === 100, 'totalRevenue 保留原值 100');
  assert(result.summary.totalProfit === 10000, 'totalProfit 保留原值 10000');
}

// ==================== Test 3: 0 收入防 NaN ====================
console.log('\n🧪 Test 3: 边界场景 — 收入为 0');
{
  const memory = {
    projectMonthly: [makeMonthly('零收入', 2603, 0, 0, 0)],
    performanceTargets: [],
    projectMaster: [],
    profile: null,
    projectStaffing: [],
  };
  const result = analytics.completion(memory, { period: 'ytd', periodYear: 2026 });

  assert(result.summary.profitRate === null, '收入 0 时 profitRate === null');
  assert(!Number.isNaN(result.summary.profitRate), '非 NaN');
}

// ==================== Test 4: 合理负利润率 ====================
console.log('\n🧪 Test 4: 负利润率 (亏损场景)');
{
  const memory = {
    projectMonthly: [makeMonthly('亏损项目', 2603, 1000, 1500, -500)],
    performanceTargets: [],
    projectMaster: [],
    profile: null,
    projectStaffing: [],
  };
  const result = analytics.completion(memory, { period: 'ytd', periodYear: 2026 });

  console.log(`   亏损场景: rev=1000, profit=-500, rate=${result.summary.profitRate}`);
  assert(result.summary.profitRate === -50, '利润率 === -50% (亏损)');
  assert(result.summary.profitRate != null, '合理负值不被 clamp');
}

// ==================== Test 5: profitRate 与 metrics['利润率'] 解耦 ====================
console.log('\n🧪 Test 5: summary.profitRate 源码不再读 metrics["利润率"]');
{
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.resolve(__dirname, '../src/tools/analytics-tools.js'), 'utf8');

  // 找到 return 块内的 summary.profitRate 赋值
  const summaryMatch = src.match(/summary:\s*\{[\s\S]*?profitRate[^\n]+/);
  assert(summaryMatch, 'summary 块包含 profitRate 字段');
  // 新代码应读 summaryProfitRate，不再读 metrics['利润率']
  assert(!summaryMatch[0].includes("metrics['利润率']"), 'summary.profitRate 不再读 metrics["利润率"]');
  assert(summaryMatch[0].includes('summaryProfitRate'), 'summary.profitRate 使用局部变量 summaryProfitRate');
}

// ==================== 汇总 ====================
console.log('\n==================== 结果汇总 ====================');
console.log(`✅ 通过: ${passed}`);
console.log(`❌ 失败: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
