/**
 * 验证逾期及账期统一使用“有效预计回款日”：
 *   effectiveExpected = 预计首次回款时间优先；为空才 fallback 到预计回款时间。
 *
 * 运行：node tests/test-receivables-effective-expected.js
 */
'use strict';

const finance = require('../src/tools/finance-tools');
const executor = require('../src/agent/executor');

let pass = 0;
let fail = 0;
const failures = [];

function assert(cond, msg, detail = '') {
  if (cond) {
    pass++;
    console.log('  ✅', msg);
  } else {
    fail++;
    failures.push(detail ? `${msg}: ${detail}` : msg);
    console.log('  ❌', msg, detail ? `| ${detail}` : '');
  }
}

function assertEq(msg, actual, expected) {
  assert(actual === expected, msg, `actual=${actual} expected=${expected}`);
}

function assertClose(msg, actual, expected, tolerance = 1e-9) {
  assert(Math.abs(Number(actual) - Number(expected)) <= tolerance, msg, `actual=${actual} expected=${expected}`);
}

function ts(date) {
  return new Date(`${date}T00:00:00+08:00`).getTime();
}

const memory = {
  invoices: [
    {
      fields: {
        '项目': '仅预计回款时间项目',
        '一级部门': '测试部门',
        '履约月份': '2601',
        '履约收入': 100000,
        '预计回款时间': ts('2026-03-01'),
        '实际回款金额': 0,
        '已履约未回款': 100000,
        '提醒判断【未回款】': '未到回款时间',
      },
    },
    {
      fields: {
        '项目': 'first优先项目',
        '一级部门': '测试部门',
        '履约月份': '2601',
        '履约收入': 80000,
        '预计首次回款时间': ts('2099-01-01'),
        '预计回款时间': ts('2026-03-01'),
        '实际回款金额': 0,
        '已履约未回款': 80000,
        '提醒判断【未回款】': '未到回款时间',
      },
    },
    {
      fields: {
        '项目': '部分回款项目',
        '一级部门': '测试部门',
        '履约月份': '2602',
        '履约收入': 120000,
        '预计首次回款时间': ts('2026-03-01'),
        '实际回款金额': 70000,
        '实际回款时间': '2026/02/15',
        '已履约未回款': 50000,
        '提醒判断【未回款】': '未到回款时间',
      },
    },
    {
      fields: {
        '项目': '无预计回款项目',
        '一级部门': '测试部门',
        '履约月份': '2601',
        '履约收入': 90000,
        '实际回款金额': 0,
        '已履约未回款': 90000,
        '提醒判断【未回款】': '未到回款时间',
      },
    },
    {
      fields: {
        '项目': '无预计但提醒到期项目',
        '一级部门': '测试部门',
        '履约月份': '2601',
        '履约收入': 110000,
        '实际回款金额': 0,
        '已履约未回款': 110000,
        '提醒判断【未回款】': '到期未回款',
      },
    },
    {
      fields: {
        '项目': '结清字段忽略项目',
        '一级部门': '测试部门',
        '履约月份': '2601',
        '履约收入': 50000,
        '预计首次回款时间': ts('2026-03-01'),
        '实际回款金额': 0,
        '已履约未回款': 50000,
        '款项是否结清': '是',
        '提醒判断【未回款】': '未到回款时间',
      },
    },
  ],
};

console.log('\n========== receivables 有效预计回款日离线回归 ==========');

const receivables = finance.receivables(memory, { period: 'ytd', periodYear: 2026, isGlobal: true });
const byName = Object.fromEntries((receivables.projects || []).map(p => [p.name, p]));

const legacyOnly = byName['仅预计回款时间项目'];
assert(!!legacyOnly, '找到仅预计回款时间项目');
assertEq('仅 legacy 字段已过期 -> 识别为 1 笔逾期', legacyOnly.overdueCount, 1);
assertEq('legacy fallback 来源正确', legacyOnly.overdueDetails[0].expectedDateSource, '预计回款时间(fallback)');
assert(legacyOnly.overdueDetailLines[0].includes('预计回款时间(fallback)'), '逾期明细展示 fallback 来源');
assertClose('receivables 常规账期纳入 legacy fallback 行', legacyOnly.avgExpectedCollectionCycle, 1);

const firstWins = byName['first优先项目'];
assert(!!firstWins, '找到 first优先项目');
assertEq('first 未来、legacy 过去 -> 以 first 为准不判逾期', firstWins.overdueCount, 0);
assertEq('first优先项目明细来源为预计首次回款时间', firstWins.details[0].expectedDateSource, '预计首次回款时间');

const partial = byName['部分回款项目'];
assert(!!partial, '找到部分回款项目');
assertEq('部分回款但剩余 outstanding 已过期 -> 识别为逾期', partial.overdueCount, 1);
assertEq('部分回款剩余逾期状态正确', partial.details[0].status, '部分回款，剩余逾期');
assertEq('部分回款剩余逾期金额按 outstanding 计', partial.overdueAmount, 50000);

const noExpected = byName['无预计回款项目'];
assert(!!noExpected, '找到无预计回款项目');
assertEq('无有效预计回款日且提醒未到期 -> 不判逾期', noExpected.overdueCount, 0);

const noExpectedButAlert = byName['无预计但提醒到期项目'];
assert(!!noExpectedButAlert, '找到无预计但提醒到期项目');
assertEq('无有效预计回款日即使提醒到期 -> 不判逾期', noExpectedButAlert.overdueCount, 0);
assertEq('无有效预计回款日即使提醒到期 -> 明细状态非到期未回', noExpectedButAlert.details[0].status, '未到期');

const settledIgnored = byName['结清字段忽略项目'];
assert(!!settledIgnored, '找到结清字段忽略项目');
assertEq('款项是否结清不参与逾期判断，未回款>0且日期已过 -> 判逾期', settledIgnored.overdueCount, 1);
assertEq('款项是否结清不参与逾期判断，逾期金额按未回款计', settledIgnored.overdueAmount, 50000);

console.log('\n========== cycle 有效预计回款日离线回归 ==========');
const cycle = finance.cycle(memory, { period: 'all', isGlobal: true });
const cycleByName = Object.fromEntries((cycle.projects || []).map(p => [p.name, p]));
assertEq('cycle firstExpectedFilledCount', cycle.firstExpectedFilledCount, 3);
assertEq('cycle legacyExpectedFilledCount', cycle.legacyExpectedFilledCount, 2);
assertEq('cycle effectiveExpectedFilledCount', cycle.effectiveExpectedFilledCount, 4);
assertEq('cycle expectedFallbackCount', cycle.expectedFallbackCount, 1);
assertClose('cycle 常规账期纳入 legacy fallback 行', cycleByName['仅预计回款时间项目'].avgExpectedCollectionCycle, 1);
assertEq('cycle 明细来源标记 fallback', cycleByName['仅预计回款时间项目'].details[0].expectedCollectionDateSource, '预计回款时间(fallback)');

console.log('\n========== Answer Prompt 定向逾期答案注入 ==========');
const promptText = executor.formatResultsForPrompt(
  { results: { 'finance.receivables': receivables }, errors: {} },
  { message: '仅预计回款时间项目逾期明细调取一下' },
);
assert(promptText.includes('用户问题定向逾期答案'), '注入用户问题定向逾期答案');
assert(promptText.includes('仅预计回款时间项目 逾期情况'), '定向答案包含目标项目标题');
assert(promptText.includes('预计回款时间(fallback)'), '定向答案保留 fallback 来源');

console.log(`\n结果：PASS=${pass} FAIL=${fail}`);
if (fail > 0) {
  console.log('\n失败项：');
  failures.forEach((f, i) => console.log(`${i + 1}. ${f}`));
  process.exit(1);
}
