/**
 * test-v1-removed.js
 *
 * 验证 v1 架构死代码已物理移除，且 bot.js / config.js 清理到位。
 *
 * 运行: node tests/test-v1-removed.js
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');

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

const ROOT = path.resolve(__dirname, '..');

// 已删除的源文件
const REMOVED_FILES = [
  'src/skills/skill-dispatcher.js',
  'src/skills/pnl-control-skill.js',
  'src/skills/risk-alert-skill.js',
  'src/skills/completion-rate-skill.js',
  'src/skills/promotion-skill.js',
  'src/skills/team-skill.js',
  'src/skills/capability-skill.js',
  'src/skills/schedule-skill.js',
  'src/skills/trend-skill.js',
  'src/engines/promotion-agent.js',
  'src/engines/promotion-snapshot-engine.js',
  'src/engines/promotion-table-setup.js',
  // v1 测试与脚本
  'tests/test-permission-e2e-full.js',
  'tests/test-receivables-detail.js',
  'tests/test-finance-e2e.js',
  'tests/test-issue-fixes.js',
  'tests/test-phase1-permission.js',
  'scripts/test-request-chain.js',
  'scripts/run-promotion-test.js',
  'scripts/run-5person-batch.js',
  'src/services/org-agent.js',
  'src/utils/query-planner.js',
  'src/utils/prompt-builder.js',
  'src/schedulers/risk-scanner.js',
  'src/schedulers/proactive-alert-scheduler.js',
  'tests/test-proactive-alert.js',
  'tests/test-scheduler-migrate.js',
];

// 仍应存在的活跃模块
const ACTIVE_FILES = [
  'src/skills/time-query-skill.js',
  'src/services/memory-manager.js',
  'src/tools/analytics-tools.js',
  'src/tools/finance-tools.js',
  'src/tools/risk-tools.js',
  'src/tools/talent-tools.js',
  'src/services/team-aggregator.js',
  'src/agent/pipeline.js',
  'src/agent/request-adapter.js',
  'src/agent/answer-prompt.js',
  'src/utils/memory-update-parser.js',
];

// ==================== Test 1: v1 死代码文件已物理删除 ====================
console.log('\n🧪 Test 1: v1 死代码文件已物理删除');
for (const rel of REMOVED_FILES) {
  const abs = path.join(ROOT, rel);
  assert(!fs.existsSync(abs), `${rel} 不存在`);
}

// ==================== Test 2: 活跃模块仍在 ====================
console.log('\n🧪 Test 2: 活跃模块仍保留');
for (const rel of ACTIVE_FILES) {
  const abs = path.join(ROOT, rel);
  assert(fs.existsSync(abs), `${rel} 保留`);
}

// ==================== Test 3: bot.js 清理到位 ====================
console.log('\n🧪 Test 3: bot.js 引用清理到位');
{
  const botSrc = fs.readFileSync(path.join(ROOT, 'bot.js'), 'utf8');
  assert(!botSrc.includes("require('./src/skills/skill-dispatcher')"), 'bot.js 不再 require skill-dispatcher');
  assert(!botSrc.includes("require('./src/engines/promotion-snapshot-engine')"), 'bot.js 不再 require promotion-snapshot-engine');
  assert(!botSrc.includes('skillDispatcher'), 'bot.js 不再使用 skillDispatcher 变量');
  assert(!botSrc.includes('promotionSnapshot'), 'bot.js 不再使用 promotionSnapshot 变量');
  assert(!botSrc.includes('USE_NEW_PIPELINE'), 'bot.js 不再引用 USE_NEW_PIPELINE 灰度开关');
  assert(!botSrc.includes("require('./src/engines/promotion-gap-engine')"), 'bot.js 不再 require promotion-gap-engine 定时刷新');
  assert(!botSrc.includes("require('./src/schedulers/risk-scanner')"), 'bot.js 不再自动注册经营风险扫描定时任务');
  assert(!botSrc.includes("require('./src/schedulers/proactive-alert-scheduler')"), 'bot.js 不再自动注册经营主动提醒定时任务');
  assert(botSrc.includes("require('./src/agent/request-adapter')"), 'bot.js 改为通过 request-adapter 承接兼容入口');
  assert(!botSrc.includes("require('./src/services/org-agent')"), 'bot.js 不再 require org-agent');
  assert(botSrc.includes("require('./src/app/feishu/message-handler')"), 'bot.js 通过 message-handler 装配飞书消息层');
  const handlerSrc = fs.readFileSync(path.join(ROOT, 'src/app/feishu/message-handler.js'), 'utf8');
  assert(handlerSrc.includes('pipeline.handleRequestStream'), 'message-handler 保留 pipeline 流式入口');
  assert(handlerSrc.includes('pipeline.handleRequest('), 'message-handler 保留 pipeline 降级入口');
}

// ==================== Test 4: config.js 已移除 USE_NEW_PIPELINE ====================
console.log('\n🧪 Test 4: config.js 已移除 USE_NEW_PIPELINE');
{
  const cfgSrc = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');
  assert(!cfgSrc.includes('USE_NEW_PIPELINE'), 'config.js 不再包含 USE_NEW_PIPELINE');
}

// ==================== Test 5: 残留引用扫描（src/tests/scripts 不应再出现旧链路 require） ====================
console.log('\n🧪 Test 5: src/tests/scripts 不存在旧链路 require');
{
  function walk(dir, acc) {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) walk(abs, acc);
      else if (name.endsWith('.js')) acc.push(abs);
    }
    return acc;
  }
  const selfFile = path.join(ROOT, 'tests', 'test-v1-removed.js');
  const scanFiles = [path.join(ROOT, 'bot.js')];
  for (const rel of ['src', 'tests', 'scripts']) {
    const abs = path.join(ROOT, rel);
    if (fs.existsSync(abs)) walk(abs, scanFiles);
  }
  const deadModulePatterns = [
    /require\(['"][^'"]*\/skills\/skill-dispatcher['"]\)/,
    /require\(['"][^'"]*\/skills\/pnl-control-skill['"]\)/,
    /require\(['"][^'"]*\/skills\/risk-alert-skill['"]\)/,
    /require\(['"][^'"]*\/skills\/completion-rate-skill['"]\)/,
    /require\(['"][^'"]*\/skills\/promotion-skill['"]\)/,
    /require\(['"][^'"]*\/skills\/team-skill['"]\)/,
    /require\(['"][^'"]*\/skills\/capability-skill['"]\)/,
    /require\(['"][^'"]*\/skills\/schedule-skill['"]\)/,
    /require\(['"][^'"]*\/skills\/trend-skill['"]\)/,
    /require\(['"][^'"]*\/engines\/promotion-agent['"]\)/,
    /require\(['"][^'"]*\/engines\/promotion-snapshot-engine['"]\)/,
    /require\(['"][^'"]*\/engines\/promotion-table-setup['"]\)/,
    /require\(['"][^'"]*\/services\/org-agent['"]\)/,
    /require\(['"][^'"]*\/utils\/query-planner['"]\)/,
    /require\(['"][^'"]*\/utils\/prompt-builder['"]\)/,
  ];
  const hits = [];
  for (const abs of scanFiles) {
    if (abs === selfFile) continue;
    const content = fs.readFileSync(abs, 'utf8');
    for (const pat of deadModulePatterns) {
      if (pat.test(content)) hits.push(`${path.relative(ROOT, abs)} → ${pat}`);
    }
  }
  assert(hits.length === 0, `src/tests/scripts 下无任何旧链路 require (命中: ${hits.join('; ') || '无'})`);
}

// ==================== Test 6: bot.js require 仍可成功加载（语法/依赖健康） ====================
console.log('\n🧪 Test 6: bot.js 依赖链静态可解析');
{
  // 通过解析 require 字符串找出头部依赖，确认都能 require
  const botSrc = fs.readFileSync(path.join(ROOT, 'bot.js'), 'utf8').split('\n').slice(0, 50).join('\n');
  const rel = [...botSrc.matchAll(/require\(['"](\.\/[^'"]+)['"]\)/g)].map(m => m[1]);
  let okCount = 0;
  for (const r of rel) {
    try {
      require.resolve(path.join(ROOT, r));
      okCount++;
    } catch (e) {
      console.error(`  ❌ bot.js 头部 require('${r}') 解析失败: ${e.message}`);
      failed++;
    }
  }
  assert(okCount === rel.length, `bot.js 头部 ${rel.length} 个 require 全部可解析`);
}

// ==================== 汇总 ====================
console.log('\n==================== 结果汇总 ====================');
console.log(`✅ 通过: ${passed}`);
console.log(`❌ 失败: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
