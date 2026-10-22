'use strict';

const {
  resolveToolParams,
  applyToolParamsToPlan,
} = require('../src/agent/tool-param-resolver');

describe('tool param resolver', () => {
  test('infers top and revenue sorting for profit overview', () => {
    const plan = {
      tools_needed: ['finance.profitOverview'],
      query_scope: { targetProjects: [], scopeSource: 'none' },
    };

    const params = resolveToolParams({
      message: '健康美学收入最高的 5 个项目？',
      planResult: plan,
      enableRuleFallback: true,
    });

    expect(params['finance.profitOverview']).toEqual({
      top: 5,
      sortBy: 'revenue',
      order: 'desc',
    });
  });

  test('infers loss Top3 as profit ascending', () => {
    const plan = {
      tools_needed: ['finance.profitOverview'],
      query_scope: { targetProjects: [], scopeSource: 'none' },
    };

    const params = resolveToolParams({
      message: 'X行业群亏损 Top3 项目',
      planResult: plan,
      enableRuleFallback: true,
    });

    expect(params['finance.profitOverview']).toEqual({
      top: 3,
      sortBy: 'profit',
      order: 'asc',
    });
  });

  test('inherits targetProjects length as top for scoped followups', () => {
    const plan = {
      tools_needed: ['finance.receivables'],
      query_scope: {
        targetProjects: ['A项目', 'B项目', 'C项目'],
        scopeSource: 'inherited_result_set',
      },
    };

    const params = resolveToolParams({
      message: '这些项目回款率呢？',
      planResult: plan,
      enableRuleFallback: true,
    });

    expect(params['finance.receivables']).toMatchObject({
      top: 3,
      sortBy: 'collectRate',
      order: 'asc',
      metric: 'collectRate',
    });
  });

  test('infers outstanding desc for high-to-low unpaid receivable wording', () => {
    const plan = {
      tools_needed: ['finance.receivables'],
      query_scope: {
        targetProjects: ['A项目', 'B项目'],
        scopeSource: 'pending_clarification',
      },
    };

    const params = resolveToolParams({
      message: '用户补充口径：按未回款金额从高到低；仅限这些项目：A项目、B项目',
      planResult: plan,
      enableRuleFallback: true,
    });

    expect(params['finance.receivables']).toMatchObject({
      top: 2,
      sortBy: 'outstanding',
      order: 'desc',
      metric: 'outstanding',
    });
  });

  test('explicit natural metric wording overrides planner wrong receivable order but keeps planner top', () => {
    const plan = {
      tools_needed: ['finance.receivables'],
      query_scope: {
        targetProjects: ['A项目', 'B项目', 'C项目'],
        scopeSource: 'pending_clarification',
      },
      tool_params: {
        'finance.receivables': { top: 1, sortBy: 'collectRate', order: 'desc' },
      },
    };

    const params = resolveToolParams({
      message: '用户补充口径：按回款率从低到高；仅限这些项目：A项目、B项目、C项目',
      planResult: plan,
      enableRuleFallback: true,
    });

    expect(params['finance.receivables']).toMatchObject({
      top: 1,
      sortBy: 'collectRate',
      order: 'asc',
      metric: 'collectRate',
    });
  });

  test('uses explicit_project targetProjects length as top for scoped followups', () => {
    const plan = {
      tools_needed: ['finance.profitOverview'],
      query_scope: {
        targetProjects: ['人力资源部管理'],
        scopeSource: 'explicit_project',
      },
    };

    const params = resolveToolParams({
      message: '这个项目盈亏情况',
      planResult: plan,
      enableRuleFallback: true,
    });

    expect(params['finance.profitOverview']).toMatchObject({
      top: 1,
    });
  });

  test('keeps planner explicit valid fields and drops params for unplanned tools', () => {
    const plan = {
      tools_needed: ['finance.receivables'],
      tool_params: {
        'finance.receivables': { top: '1', sortBy: 'outstanding', order: 'desc' },
        'finance.profitOverview': { top: 5, sortBy: 'revenue', order: 'desc' },
      },
    };

    applyToolParamsToPlan(plan, {
      message: '那未回款最高的是哪个？',
      enableRuleFallback: true,
    });

    expect(plan.tool_params).toEqual({
      'finance.receivables': {
        top: 1,
        sortBy: 'outstanding',
        order: 'desc',
        metric: 'outstanding',
      },
    });
  });

  test('explicit TOP number from user overrides planner wrong top', () => {
    const plan = {
      tools_needed: ['finance.profitOverview'],
      tool_params: {
        'finance.profitOverview': { top: 5, sortBy: 'profit', order: 'asc' },
      },
      query_scope: {
        targetProjects: [],
        scopeSource: 'explicit_new_query',
      },
    };

    const params = resolveToolParams({
      message: '公司亏损TOP10项目',
      planResult: plan,
      enableRuleFallback: true,
    });

    expect(params['finance.profitOverview']).toMatchObject({
      top: 10,
      sortBy: 'profit',
      order: 'asc',
    });
  });

  test('infers params for cost, labor and health tools', () => {
    const params = resolveToolParams({
      message: '健康美学外包费用最高 Top3 项目，以及人力投入最多的前5个项目，逾期风险最高的2个项目',
      planResult: {
        tools_needed: ['finance.costBreakdown', 'finance.laborCost', 'finance.healthCheck'],
        query_scope: { targetProjects: [], scopeSource: 'none' },
      },
      enableRuleFallback: true,
    });

    expect(params['finance.costBreakdown']).toMatchObject({
      top: 3,
      sortBy: 'amount',
      order: 'desc',
      metric: '外包费用',
    });
    expect(params['finance.laborCost']).toMatchObject({
      sortBy: 'manpowerMonths',
      order: 'desc',
    });
    expect(params['finance.healthCheck']).toMatchObject({
      sortBy: 'overdueAmount',
      order: 'desc',
    });
  });

  test('infers params for customer, presale and sign delivery tools', () => {
    const params = resolveToolParams({
      message: 'Top5 客户合作金额、售前跟进中大单 Top5、签约金额最高的3个部门',
      planResult: {
        tools_needed: ['customer.analysis', 'presale.pending', 'signDelivery.overview'],
        query_scope: { targetProjects: [], scopeSource: 'none' },
      },
      enableRuleFallback: true,
    });

    expect(params['customer.analysis']).toMatchObject({
      top: 5,
      sortBy: 'totalAmount',
      order: 'desc',
    });
    expect(params['presale.pending']).toMatchObject({
      top: 5,
      sortBy: 'estAmount',
      order: 'desc',
    });
    expect(params['signDelivery.overview']).toMatchObject({
      top: 5,
      sortBy: 'contractAmount',
      order: 'desc',
    });
  });

  test('infers dimension metric for presale win-loss and renewal customers', () => {
    const params = resolveToolParams({
      message: '每个负责人的赢单率 Top3，以及续签率最高的客户 Top3',
      planResult: {
        tools_needed: ['presale.winLoss', 'signDelivery.renewal'],
        query_scope: { targetProjects: [], scopeSource: 'none' },
      },
      enableRuleFallback: true,
    });

    expect(params['presale.winLoss']).toMatchObject({
      top: 3,
      sortBy: 'winRate',
      order: 'desc',
      metric: 'owner',
    });
    expect(params['signDelivery.renewal']).toMatchObject({
      top: 3,
      sortBy: 'renewalRate',
      order: 'desc',
    });
  });
});
