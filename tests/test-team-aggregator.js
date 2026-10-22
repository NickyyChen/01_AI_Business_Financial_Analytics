/**
 * test-team-aggregator.js
 *
 * 验证 P1-2 修复：
 *   team-aggregator 从已废弃的 PROJECT_STAFFING 切换到 ACTUAL_WORKTIME，
 *   并使用 FM.lookupFirst(匹配项目) 提取项目名。
 *
 * 运行: node tests/test-team-aggregator.js
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

// ==================== Test 1: 源码静态检查 ====================
console.log('\n🧪 Test 1: team-aggregator.js 源码静态检查');
{
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.resolve(__dirname, '../src/services/team-aggregator.js'), 'utf8');

  assert(!src.includes('config.TABLES.PROJECT_STAFFING'), '不再调用 config.TABLES.PROJECT_STAFFING 旧表常量');
  assert(src.includes('ACTUAL_WORKTIME'), '改为引用 ACTUAL_WORKTIME');
  assert(src.includes('FM.lookupFirst'), '使用 FM.lookupFirst 从 lookup 数组取项目名');
  assert(src.includes('PROJECT_MATCH'), '使用 FM.ACTUAL_WORKTIME_FIELDS.PROJECT_MATCH');
  assert(!src.match(/['"]项目唯一值['"]/), '不再硬编码 "项目唯一值" 旧字段');
}

// ==================== Test 2: 行为测试 - mock ACTUAL_WORKTIME 数据 ====================
console.log('\n🧪 Test 2: 行为测试 — 从新表结构提取项目列表');
{
  // 只测试字段提取逻辑（不跑完整 getTeamDailySummary，避免拉起整个 API mock）
  const FM = require('../src/utils/field-mapping');

  // 模拟 ACTUAL_WORKTIME 新表的一条记录（匹配项目字段是 lookup 数组）
  const mockStaffingRecords = [
    { record_id: 's1', fields: {
      [FM.ACTUAL_WORKTIME_FIELDS.NAME]: '张三',
      [FM.ACTUAL_WORKTIME_FIELDS.PROJECT_MATCH]: ['开泰银行CEP-游戏化营销开发'],
      [FM.ACTUAL_WORKTIME_FIELDS.FTE]: 0.5,
    }},
    { record_id: 's2', fields: {
      [FM.ACTUAL_WORKTIME_FIELDS.NAME]: '张三',
      [FM.ACTUAL_WORKTIME_FIELDS.PROJECT_MATCH]: [{ text: '博时基金-数字化转型' }],
      [FM.ACTUAL_WORKTIME_FIELDS.FTE]: 0.3,
    }},
    { record_id: 's3', fields: {
      [FM.ACTUAL_WORKTIME_FIELDS.NAME]: '张三',
      [FM.ACTUAL_WORKTIME_FIELDS.PROJECT_MATCH]: [],  // 边界
      [FM.ACTUAL_WORKTIME_FIELDS.FTE]: 0.2,
    }},
  ];

  const projects = [...new Set(
    mockStaffingRecords
      .map(r => FM.lookupFirst((r.fields || {})[FM.ACTUAL_WORKTIME_FIELDS.PROJECT_MATCH]))
      .filter(Boolean)
  )];

  console.log(`   提取的项目: ${JSON.stringify(projects)}`);
  assert(projects.length === 2, `项目数 === 2 (实际 ${projects.length})`);
  assert(projects.includes('开泰银行CEP-游戏化营销开发'), '包含字符串数组项目');
  assert(projects.includes('博时基金-数字化转型'), '包含 {text:...} 数组项目');
}

// ==================== Test 3: 兼容性 - ACTUAL_WORKTIME 未配置时 ====================
console.log('\n🧪 Test 3: 兼容性 — ACTUAL_WORKTIME 未配置时不报错');
{
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.resolve(__dirname, '../src/services/team-aggregator.js'), 'utf8');

  // 应该存在守卫：config.TABLES.ACTUAL_WORKTIME ? ... : []
  assert(src.includes('config.TABLES.ACTUAL_WORKTIME'), '使用条件守卫 config.TABLES.ACTUAL_WORKTIME');
  assert(/ACTUAL_WORKTIME[\s\S]{0,200}:\s*\[\]/.test(src), '未配置时回退为空数组');
}

// ==================== 汇总 ====================
console.log('\n==================== 结果汇总 ====================');
console.log(`✅ 通过: ${passed}`);
console.log(`❌ 失败: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
