/**
 * test-production-tables.js
 * 验证生产表替换后各模块的逻辑正确性
 * 使用 mock 数据，不需要实际 Bitable 连接
 *
 * 运行: node tests/test-production-tables.js
 */

const assert = require('assert');
const FM = require('../src/utils/field-mapping');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}: ${e.message}`);
  }
}

// ==================== 1. field-mapping 基础工具 ====================
console.log('\n🧪 field-mapping 基础工具测试');

test('num() 正常数值', () => {
  assert.strictEqual(FM.num({ '金额': 1234 }, '金额'), 1234);
});

test('num() null → 0', () => {
  assert.strictEqual(FM.num({}, '金额'), 0);
});

test('num() 空字符串 → 0', () => {
  assert.strictEqual(FM.num({ '金额': '' }, '金额'), 0);
});

test('num() 字符串数值 → 数值', () => {
  assert.strictEqual(FM.num({ '金额': '5678.9' }, '金额'), 5678.9);
});

test('str() 正常字符串', () => {
  assert.strictEqual(FM.str({ '项目': ' HFP项目 ' }, '项目'), 'HFP项目');
});

test('str() null → 空字符串', () => {
  assert.strictEqual(FM.str({}, '项目'), '');
});

test('extractCostBreakdown 提取成本科目', () => {
  const fields = {
    '人力成本': 10000,
    '外包费用': 5000,
    '差旅费': 0,
    '入账增值税': 1200,
  };
  const result = FM.extractCostBreakdown(fields);
  assert.strictEqual(result['人力成本'], 10000);
  assert.strictEqual(result['外包费用'], 5000);
  assert.strictEqual(result['增值税'], 1200);
  assert.strictEqual(result['差旅费'], undefined); // 0 不输出
});

// ==================== 2. INVOICE_FIELDS 字段常量 ====================
console.log('\n🧪 INVOICE_FIELDS 字段常量测试');

test('开票回款计划字段映射完整', () => {
  assert.strictEqual(FM.INVOICE_FIELDS.PROJECT_KEY, '项目');
  assert.strictEqual(FM.INVOICE_FIELDS.MONTH, '履约月份');
  assert.strictEqual(FM.INVOICE_FIELDS.REVENUE, '履约收入');
  assert.strictEqual(FM.INVOICE_FIELDS.ACTUAL_AMOUNT, '实际回款金额');
  assert.strictEqual(FM.INVOICE_FIELDS.OUTSTANDING, '已履约未回款');
  assert.strictEqual(FM.INVOICE_FIELDS.ALERT_STATUS, '提醒判断【未回款】');
  assert.strictEqual(FM.INVOICE_FIELDS.IS_COLLECTED, '是否已回款');
});

test('INVOICE_ALERT 枚举正确', () => {
  assert.strictEqual(FM.INVOICE_ALERT.OVERDUE, '到期未回款');
  assert.strictEqual(FM.INVOICE_ALERT.DUE_THIS_MONTH, '本月应回款');
  assert.strictEqual(FM.INVOICE_ALERT.NOT_DUE, '未到回款时间');
});

// ==================== 3. ACTUAL_PROJECT_FIELDS 字段常量 ====================
console.log('\n🧪 ACTUAL_PROJECT_FIELDS 字段常量测试');

test('实际项目层字段映射完整', () => {
  assert.strictEqual(FM.ACTUAL_PROJECT_FIELDS.PROJECT_NAME, '是否交付项目');
  assert.strictEqual(FM.ACTUAL_PROJECT_FIELDS.MONTH, '月份');
  assert.strictEqual(FM.ACTUAL_PROJECT_FIELDS.REVENUE, '履约收入');
  assert.strictEqual(FM.ACTUAL_PROJECT_FIELDS.COST, '履约成本');
  assert.strictEqual(FM.ACTUAL_PROJECT_FIELDS.PROFIT, '履约利润');
  assert.strictEqual(FM.ACTUAL_PROJECT_FIELDS.LABOR_COST, '人力成本');
  assert.strictEqual(FM.ACTUAL_PROJECT_FIELDS.OUTSOURCE, '外包费用');
});

test('COST_CATEGORIES 包含所有科目', () => {
  assert.ok(FM.COST_CATEGORIES.length >= 9);
  const labels = FM.COST_CATEGORIES.map(c => c.label);
  assert.ok(labels.includes('人力成本'));
  assert.ok(labels.includes('外包费用'));
  assert.ok(labels.includes('差旅费'));
});

// ==================== 4. config.js 表ID配置 ====================
console.log('\n🧪 config.js 表ID配置测试');

test('config 加载成功', () => {
  const config = require('../config');
  assert.ok(config.TABLES);
});

test('生产表 ID 已配置', () => {
  const config = require('../config');
  assert.strictEqual(config.TABLES.PRESALE_PROJECT, 'tblafsNAQnCANMlV');
  assert.strictEqual(config.TABLES.INVOICE, 'tblMi3eIOiS0pC37');
  assert.strictEqual(config.TABLES.ACTUAL_DEPT, 'tblzlO1GDuaRkLpT');
  assert.strictEqual(config.TABLES.ACTUAL_PROJECT, 'tblSnDXGlKg4nuB9');
});

test('旧 Demo/废弃表 key 已从 config.TABLES 移除', () => {
  const config = require('../config');
  const removed = [
    'OPPORTUNITY_PIPELINE', 'ACCOUNTS_RECEIVABLE', 'COST_DETAIL',
    'PROJECT_RISK', 'STAFF_UTILIZATION',
    'PROJECT_MONTHLY', 'PROJECT_MASTER', 'PROJECT_STAFFING', 'PERFORMANCE_TARGET',
    'DELIVERY_PLAN', 'LEAD_PIPELINE',
  ];
  for (const key of removed) {
    assert.ok(!(key in config.TABLES), `config.TABLES 不应再包含已废弃的 ${key}`);
  }
});

// ==================== 5. 回款聚合逻辑模拟 ====================
console.log('\n🧪 回款聚合逻辑模拟');

test('按项目聚合回款明细', () => {
  const F = FM.INVOICE_FIELDS;
  const mockInvoices = [
    { fields: { [F.PROJECT_KEY]: 'HFP项目', [F.REVENUE]: 10000, [F.ACTUAL_AMOUNT]: 8000, [F.OUTSTANDING]: 2000, [F.ALERT_STATUS]: '到期未回款', [F.MONTH]: '2603' } },
    { fields: { [F.PROJECT_KEY]: 'HFP项目', [F.REVENUE]: 15000, [F.ACTUAL_AMOUNT]: 15000, [F.OUTSTANDING]: 0, [F.ALERT_STATUS]: '未到回款时间', [F.MONTH]: '2604' } },
    { fields: { [F.PROJECT_KEY]: 'ABC项目', [F.REVENUE]: 20000, [F.ACTUAL_AMOUNT]: 0, [F.OUTSTANDING]: 20000, [F.ALERT_STATUS]: '到期未回款', [F.MONTH]: '2603' } },
  ];

  const byProject = {};
  for (const r of mockInvoices) {
    const f = r.fields || {};
    const proj = FM.str(f, F.PROJECT_KEY);
    if (!byProject[proj]) byProject[proj] = { revenue: 0, received: 0, outstanding: 0, overdueCount: 0 };
    const agg = byProject[proj];
    agg.revenue += FM.num(f, F.REVENUE);
    agg.received += FM.num(f, F.ACTUAL_AMOUNT);
    agg.outstanding += FM.num(f, F.OUTSTANDING);
    if (FM.str(f, F.ALERT_STATUS) === FM.INVOICE_ALERT.OVERDUE) agg.overdueCount++;
  }

  assert.strictEqual(Object.keys(byProject).length, 2);
  assert.strictEqual(byProject['HFP项目'].revenue, 25000);
  assert.strictEqual(byProject['HFP项目'].received, 23000);
  assert.strictEqual(byProject['HFP项目'].outstanding, 2000);
  assert.strictEqual(byProject['HFP项目'].overdueCount, 1);
  assert.strictEqual(byProject['ABC项目'].overdueCount, 1);
});

// ==================== 6. 成本科目聚合逻辑模拟 ====================
console.log('\n🧪 成本科目聚合逻辑模拟');

test('按项目聚合成本科目', () => {
  const APF = FM.ACTUAL_PROJECT_FIELDS;
  const mockRecords = [
    { fields: { [APF.PROJECT_NAME]: 'HFP项目', [APF.MONTH]: '2601', [APF.REVENUE]: 50000, [APF.COST]: 40000, [APF.PROFIT]: 10000, '人力成本': 25000, '外包费用': 10000, '差旅费': 5000 } },
    { fields: { [APF.PROJECT_NAME]: 'HFP项目', [APF.MONTH]: '2602', [APF.REVENUE]: 60000, [APF.COST]: 55000, [APF.PROFIT]: 5000, '人力成本': 30000, '外包费用': 15000, '差旅费': 10000 } },
    { fields: { [APF.PROJECT_NAME]: 'LOSS项目', [APF.MONTH]: '2601', [APF.REVENUE]: 10000, [APF.COST]: 15000, [APF.PROFIT]: -5000, '人力成本': 12000, '外包费用': 3000 } },
  ];

  const costByProject = {};
  for (const r of mockRecords) {
    const f = r.fields || {};
    const proj = FM.str(f, APF.PROJECT_NAME);
    if (!costByProject[proj]) costByProject[proj] = { revenue: 0, profit: 0, breakdown: {} };
    const agg = costByProject[proj];
    agg.revenue += FM.num(f, APF.REVENUE);
    agg.profit += FM.num(f, APF.PROFIT);
    const bd = FM.extractCostBreakdown(f);
    for (const [label, amt] of Object.entries(bd)) {
      agg.breakdown[label] = (agg.breakdown[label] || 0) + amt;
    }
  }

  assert.strictEqual(costByProject['HFP项目'].revenue, 110000);
  assert.strictEqual(costByProject['HFP项目'].profit, 15000);
  assert.strictEqual(costByProject['HFP项目'].breakdown['人力成本'], 55000);
  assert.strictEqual(costByProject['HFP项目'].breakdown['外包费用'], 25000);
  assert.strictEqual(costByProject['HFP项目'].breakdown['差旅费'], 15000);
  assert.strictEqual(costByProject['LOSS项目'].profit, -5000);
});

// ==================== 7. 风险运算逻辑模拟 ====================
console.log('\n🧪 风险自动运算逻辑模拟');

test('从项目层数据识别亏损风险项目', () => {
  const APF = FM.ACTUAL_PROJECT_FIELDS;
  const mockRecords = [
    { fields: { [APF.PROJECT_NAME]: '亏损A', [APF.REVENUE]: 10000, [APF.PROFIT]: -3000 } },
    { fields: { [APF.PROJECT_NAME]: '亏损A', [APF.REVENUE]: 10000, [APF.PROFIT]: -2000 } },
    { fields: { [APF.PROJECT_NAME]: '正常B', [APF.REVENUE]: 50000, [APF.PROFIT]: 8000 } },
    { fields: { [APF.PROJECT_NAME]: '微利C', [APF.REVENUE]: 30000, [APF.PROFIT]: 500 } },
  ];

  const projAgg = {};
  for (const r of mockRecords) {
    const f = r.fields || {};
    const proj = FM.str(f, APF.PROJECT_NAME);
    if (!projAgg[proj]) projAgg[proj] = { revenue: 0, profit: 0, lossMonths: 0 };
    const a = projAgg[proj];
    a.revenue += FM.num(f, APF.REVENUE);
    a.profit += FM.num(f, APF.PROFIT);
    if (FM.num(f, APF.PROFIT) < 0) a.lossMonths++;
  }

  const risks = Object.entries(projAgg)
    .filter(([, a]) => a.profit < 0 || (a.revenue > 0 && a.profit / a.revenue < -0.15));

  assert.strictEqual(risks.length, 1);
  assert.strictEqual(risks[0][0], '亏损A');
  assert.strictEqual(risks[0][1].lossMonths, 2);
  assert.strictEqual(risks[0][1].profit, -5000);
});

// ==================== 8. 权限过滤逻辑模拟 ====================
console.log('\n🧪 权限过滤逻辑模拟');

test('invoice scope 过滤使用正确字段', () => {
  const F = FM.INVOICE_FIELDS;
  const allowedKeys = new Set(['HFP项目']);
  const invoices = [
    { fields: { [F.PROJECT_KEY]: 'HFP项目', [F.REVENUE]: 10000 } },
    { fields: { [F.PROJECT_KEY]: 'SECRET项目', [F.REVENUE]: 99999 } },
  ];

  const filtered = invoices.filter(r => {
    const key = FM.str(r.fields || {}, F.PROJECT_KEY);
    return allowedKeys.has(key);
  });

  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(FM.str(filtered[0].fields, F.PROJECT_KEY), 'HFP项目');
});

test('actualProject scope 过滤使用 PROJECT_NAME 字段', () => {
  const APF = FM.ACTUAL_PROJECT_FIELDS;
  const allowedKeys = new Set(['HFP项目']);
  const records = [
    { fields: { [APF.PROJECT_NAME]: 'HFP项目', [APF.REVENUE]: 10000 } },
    { fields: { [APF.PROJECT_NAME]: 'OTHER项目', [APF.REVENUE]: 50000 } },
  ];

  const filtered = records.filter(r => {
    const key = FM.str(r.fields || {}, APF.PROJECT_NAME);
    return allowedKeys.has(key);
  });

  assert.strictEqual(filtered.length, 1);
});

// ==================== 9. 部门层聚合 ====================
console.log('\n🧪 部门层聚合测试');

test('部门层预警字段识别', () => {
  const DF = FM.ACTUAL_DEPT_FIELDS;
  const mockDept = { fields: {
    [DF.DEPT]: 'X行业群',
    [DF.REVENUE]: 100000,
    [DF.PROFIT]: -20000,
    [DF.PROFIT_RATE]: '-20%',
    [DF.IS_WARN]: '是',
    [DF.EFFICIENCY]: 15000,
  }};

  assert.strictEqual(FM.str(mockDept.fields, DF.DEPT), 'X行业群');
  assert.strictEqual(FM.num(mockDept.fields, DF.REVENUE), 100000);
  assert.strictEqual(FM.num(mockDept.fields, DF.PROFIT), -20000);
  assert.ok(FM.str(mockDept.fields, DF.IS_WARN));
});

// ==================== 10. 售前项目字段 ====================
console.log('\n🧪 售前项目字段测试');

test('PRESALE_FIELDS 映射正确', () => {
  assert.strictEqual(FM.PRESALE_FIELDS.NAME, '售前项目名称：客户+需求+期数');
  assert.strictEqual(FM.PRESALE_FIELDS.STAGE, '售前状态');
  assert.strictEqual(FM.PRESALE_FIELDS.EST_AMOUNT, '预估签约金额');
  assert.strictEqual(FM.PRESALE_FIELDS.IS_WON, '是否中标');
});

// ==================== 11. permission-manager 验证 ====================
console.log('\n🧪 permission-manager 配置验证');

test('MODULE_TABLE_MAP 包含新生产表', () => {
  // 直接加载源文件检查导出
  const permSource = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'permissions', 'permission-manager.js'), 'utf8'
  );
  assert.ok(permSource.includes('ACTUAL_PROJECT'));
  assert.ok(permSource.includes('ACTUAL_DEPT'));
  assert.ok(permSource.includes('PRESALE_PROJECT'));
  assert.ok(!permSource.includes("'ACCOUNTS_RECEIVABLE'"));
  assert.ok(!permSource.includes("'COST_DETAIL'"));
});

// ==================== 12. planner 目录验证 ====================
console.log('\n🧪 planner 目录验证');

test('planner 目录描述已更新为生产表', () => {
  const plannerSource = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'agent', 'planner.js'), 'utf8'
  );
  assert.ok(plannerSource.includes('开票、回款计划'));
  assert.ok(plannerSource.includes('实际：项目层'));
  assert.ok(plannerSource.includes('自动同步'));
});

// ==================== 总结 ====================
console.log(`\n${'='.repeat(50)}`);
console.log(`测试完成: ${passed} 通过, ${failed} 失败`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('🎉 所有测试通过！生产表替换验证完毕。');
}
