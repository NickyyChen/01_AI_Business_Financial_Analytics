'use strict';

const outOfScopePlan = {
  out_of_scope: true,
  out_of_scope_reason: '定制化账务重算，超出范围',
  tools_needed: [],
  tables_needed: [],
  period: '2026-Q1',
  question_decomposition: ['逐笔匹配收款与履约月份'],
  reasoning_framework: '模型误判为超范围',
  subordinate_depth: 1,
  query_scope: { depts: [] },
};

jest.mock('../src/clients/minimax-client', () => ({
  chat: jest.fn(async () => ({ text: JSON.stringify(outOfScopePlan) })),
}));

jest.mock('../src/clients/llm-client', () => ({
  chat: jest.fn(async () => ({ text: JSON.stringify(outOfScopePlan) })),
}));

jest.mock('../src/utils/logger', () => ({
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
}));

describe('planner receivable attribution repair', () => {
  test('does not mark collection-to-delivery-month attribution as out of scope', async () => {
    const planner = require('../src/agent/planner');

    const plan = await planner.plan('Q1实际收到的款项追溯其对应履约月份也请用表格列出', {
      userName: '万鹏',
      role: '管理者',
    });

    expect(plan.out_of_scope).toBe(false);
    expect(plan.out_of_scope_reason).toBe('');
    expect(plan.tools_needed).toEqual(expect.arrayContaining([
      'finance.receivables',
      'finance.profitOverview',
    ]));
    expect(plan.tables_needed).toEqual(expect.arrayContaining([
      'cashflow',
      'rollbackProjectActual',
      'projectMaster',
    ]));
    expect(plan.tools_needed).not.toContain('finance.pendingPaymentAnalysis');
    expect(plan.reasoning_framework).toContain('不得判定为超范围');
  });
});
