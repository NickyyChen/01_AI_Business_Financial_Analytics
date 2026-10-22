/**
 * test-optimization-unit.js
 *
 * 验证 Plan 模型分离 + Phase0/1 并行化改动的结构正确性。
 * 纯本地 mock，不依赖飞书/Ark API。
 *
 * 运行: node tests/test-optimization-unit.js
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

// ==================== Test 1: Config ====================
console.log('\n🧪 Test 1: config.js 新增 ARK_PLAN_MODEL');
{
  const config = require('../config');
  assert(config.ARK_MODEL !== undefined, 'ARK_MODEL 存在');
  assert(config.ARK_PLAN_MODEL !== undefined, 'ARK_PLAN_MODEL 存在');
  assert(config.ARK_PLAN_MODEL !== config.ARK_MODEL, `ARK_PLAN_MODEL(${config.ARK_PLAN_MODEL}) ≠ ARK_MODEL(${config.ARK_MODEL})`);
  assert(config.ARK_PLAN_MODEL.includes('flash') || config.ARK_PLAN_MODEL.includes('lite'),
    `ARK_PLAN_MODEL 是快速模型: ${config.ARK_PLAN_MODEL}`);
}

// ==================== Test 2: LLM Client model override ====================
console.log('\n🧪 Test 2: llm-client.js 支持 opts.model 覆盖');
{
  const llm = require('../src/clients/llm-client');

  // chat 函数签名检查
  assert(typeof llm.chat === 'function', 'llm.chat 是函数');
  assert(typeof llm.ask === 'function', 'llm.ask 是函数');
  assert(typeof llm.chatStream === 'function', 'llm.chatStream 是函数');

  // 读取 chat 函数源码验证 opts.model 支持
  const chatSrc = llm.chat.toString();
  assert(chatSrc.includes('opts.model'), 'chat() 函数读取 opts.model');

  const streamSrc = llm.chatStream.toString();
  assert(streamSrc.includes('opts.model'), 'chatStream() 函数读取 opts.model');
}

// ==================== Test 3: tool-registry.buildFullCatalog ====================
console.log('\n🧪 Test 3: tool-registry.buildFullCatalog');
{
  const toolRegistry = require('../src/tools/tool-registry');

  assert(typeof toolRegistry.buildFullCatalog === 'function', 'buildFullCatalog 方法存在');

  const fullCatalog = toolRegistry.buildFullCatalog();
  assert(typeof fullCatalog === 'string', 'buildFullCatalog 返回字符串');
  assert(fullCatalog.length > 10, `全量目录有内容: ${fullCatalog.length} 字`);
  assert(!fullCatalog.includes('无可用工具'), '全量目录不为空');

  const allTools = toolRegistry.listTools();
  for (const id of allTools) {
    assert(fullCatalog.includes(id), `全量目录包含工具 ${id}`);
  }

  // 对比：scope=null 时 buildCatalogForPlanner 返回空，buildFullCatalog 返回全量
  const scopeNullCatalog = toolRegistry.buildCatalogForPlanner(null);
  assert(scopeNullCatalog === '（无可用工具）', 'buildCatalogForPlanner(null) 返回空');
  assert(fullCatalog.length > scopeNullCatalog.length, 'buildFullCatalog 比 scope=null 有更多内容');
}

// ==================== Test 4: planner.js 使用 plan model + null scope ====================
console.log('\n🧪 Test 4: planner.js 快速跳过逻辑');
{
  const planner = require('../src/agent/planner');

  assert(typeof planner.plan === 'function', 'planner.plan 是函数');
  assert(typeof planner.toTableSelection === 'function', 'toTableSelection 是函数');
  assert(typeof planner.formatForPrompt === 'function', 'formatForPrompt 是函数');

  // 闲聊跳过不触发 LLM
  (async () => {
    const result1 = await planner.plan('你好', { userName: 'test', role: '员工' });
    assert(result1 === null, '闲聊"你好"跳过规划 → null');

    const result2 = await planner.plan('hi', { userName: 'test', role: '员工' });
    assert(result2 === null, '闲聊"hi"跳过规划 → null');

    const result3 = await planner.plan('ok', { userName: 'test', role: '员工' });
    assert(result3 === null, '短消息"ok"跳过规划 → null');

    // toTableSelection 对 null plan 的容错
    assert(planner.toTableSelection(null) === null, 'toTableSelection(null) → null');
    assert(planner.formatForPrompt(null) === '', 'formatForPrompt(null) → 空字符串');

    const selection = planner.toTableSelection({
      tables_needed: ['projects', 'cashflow'],
      tools_needed: [],
    });
    assert(selection instanceof Set, 'toTableSelection 返回 Set');
    assert(selection.has('profile'), 'toTableSelection 总包含 profile');
    assert(selection.has('employeeProfile'), 'toTableSelection 总包含 employeeProfile');
    assert(selection.has('projects'), 'toTableSelection 包含 projects');
    assert(selection.has('cashflow'), 'toTableSelection 包含 cashflow');
  })().then(() => {
    // ==================== Test 5: pipeline.js 并行化结构检查 ====================
    console.log('\n🧪 Test 5: pipeline.js 并行化结构');
    {
      const pipelineSrc = require('fs').readFileSync(
        require('path').join(__dirname, '../src/agent/pipeline.js'), 'utf-8'
      );

      assert(pipelineSrc.includes('Phase0+1 并行启动'), 'handleRequest 包含并行注释');
      assert(pipelineSrc.includes('Promise.all'), 'pipeline 使用 Promise.all 并行');

      const parallelCount = (pipelineSrc.match(/Phase0\+1 并行/g) || []).length;
      assert(parallelCount >= 2, `handleRequest + handleRequestStream 都做了并行化 (${parallelCount} 处)`);

      assert(pipelineSrc.includes('permManager.resolveScope'), 'pipeline 仍调用权限解析');
      assert(pipelineSrc.includes('planner.plan'), 'pipeline 仍调用 planner');

      // 确认 pipeline 中有后置的权限过滤
      assert(pipelineSrc.includes('validToolSet'), 'pipeline 在并行后做工具权限过滤');
    }

    // ==================== 汇总 ====================
    console.log('\n' + '='.repeat(50));
    console.log(`总计: ${passed + failed} 项 | ✅ 通过: ${passed} | ❌ 失败: ${failed}`);
    console.log('='.repeat(50));

    if (failed > 0) {
      process.exit(1);
    } else {
      console.log('\n🎉 所有测试通过！优化改动结构正确。\n');
    }
  });
}
