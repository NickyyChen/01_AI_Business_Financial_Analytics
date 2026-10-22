'use strict';

const {
  resolveContext,
  applyLockedScopeToPlan,
} = require('../src/agent/context-resolver');

describe('context resolver', () => {
  const projects = [
    '无限极-UGC内容运营',
    '农本方-咨询带教',
    '蔡司C端-私域生态代运营',
    '无限极-社群代运营',
    '美的-私域会员运营',
  ];

  const planningContext = [{
    question: '健康美学收入最高的 5 个项目？',
    period: '2026-04',
    tools: ['finance.profitOverview'],
    queryState: {
      dept: '健康美学行业群',
      period: '2026-04',
      metric: 'revenue',
      resultSetType: 'finance.projectMetrics',
      targetProjects: projects,
    },
    entities: projects.map((name, idx) => ({ type: 'project', name, rank: idx + 1 })),
  }];

  test('这些项目 inherits the previous project result set', () => {
    const resolved = resolveContext({
      message: '这些项目利润率呢？',
      routerIntent: { isFollowup: true },
      planningContext,
    });

    expect(resolved.resolved).toBe(true);
    expect(resolved.lockedScope.source).toBe('planning_context');
    expect(resolved.lockedScope.targetProjects).toEqual(projects);
  });

  test('第一个 resolves to the ranked entity from planningContext.entities', () => {
    const resolved = resolveContext({
      message: '第一个回款呢？',
      routerIntent: { isFollowup: true },
      planningContext,
    });

    expect(resolved.resolved).toBe(true);
    expect(resolved.lockedScope.targetProjects).toEqual(['无限极-UGC内容运营']);
    expect(resolved.lockedScope.targetEntities[0].rank).toBe(1);
  });

  test('整体 range is treated as a new query and does not inherit projects', () => {
    const resolved = resolveContext({
      message: '健康美学整体呢？',
      routerIntent: { isFollowup: true },
      planningContext,
    });

    expect(resolved.lockedScope.source).toBe('explicit_new_query');
    expect(resolved.lockedScope.targetProjects).toEqual([]);
  });

  test('metric definition questions do not inherit the previous project set', () => {
    const resolved = resolveContext({
      message: '这个未回款金额是什么意思？',
      routerIntent: { isFollowup: true },
      planningContext,
    });

    expect(resolved.lockedScope.source).toBe('none');
    expect(resolved.lockedScope.targetProjects).toEqual([]);
  });

  test('continuation inherits receivable detail context only when the last answer invited details', () => {
    const resolved = resolveContext({
      message: '你看呗',
      routerIntent: { isFollowup: true },
      planningContext: [{
        question: '这些项目回款率最低的是哪个',
        tools: ['finance.receivables'],
        queryState: {
          dept: '健康美学行业群',
          period: '2026-04',
          metric: 'receivables',
          resultSetType: 'invoice.receipts',
          targetProjects: ['伊利直播带教', '长隆-私域代运营'],
        },
      }],
      conversationHistory: [
        { role: 'assistant', content: '我可以继续帮你拉一下这 2 个项目的详细开票回款明细。' },
      ],
    });

    expect(resolved.resolved).toBe(true);
    expect(resolved.lockedScope.targetProjects).toEqual(['伊利直播带教', '长隆-私域代运营']);
  });

  test('empty planning context after clearing context does not inherit projects', () => {
    const resolved = resolveContext({
      message: '这些项目呢？',
      routerIntent: { isFollowup: true },
      planningContext: [],
    });

    expect(resolved.resolved).toBe(false);
    expect(resolved.lockedScope.source).toBe('none');
    expect(resolved.lockedScope.targetProjects).toEqual([]);
  });

  test('locked project scope force-corrects planner query_scope', () => {
    const plan = {
      query_scope: {
        depts: [],
        subDepts: [],
        targetProjects: [],
        scopeSource: 'none',
      },
    };
    const resolved = resolveContext({
      message: '这些项目利润率呢？',
      routerIntent: { isFollowup: true },
      planningContext,
    });

    applyLockedScopeToPlan(plan, resolved.lockedScope);

    expect(plan.query_scope.targetProjects).toEqual(projects);
    expect(plan.query_scope.scopeSource).toBe('inherited_result_set');
  });

  test('locked period force-corrects planner period for pending clarification scope', () => {
    const plan = {
      period: '2026-05',
      query_scope: {
        depts: [],
        subDepts: [],
        targetProjects: [],
        scopeSource: 'none',
      },
    };

    applyLockedScopeToPlan(plan, {
      source: 'explicit_project',
      targetProjects: ['人力资源部管理'],
      period: '2026-01~2026-05',
    });

    expect(plan.period).toBe('2026-01~2026-05');
    expect(plan.query_scope.targetProjects).toEqual(['人力资源部管理']);
    expect(plan.query_scope.scopeSource).toBe('explicit_project');
  });

  test('locked project metric restores profitOverview tool when planner omits it', () => {
    const plan = {
      tools_needed: [],
      tables_needed: [],
      tool_params: {},
      query_scope: {
        depts: [],
        subDepts: [],
        targetProjects: [],
        scopeSource: 'none',
      },
    };

    applyLockedScopeToPlan(plan, {
      source: 'pending_clarification',
      targetProjects: ['项目A', '项目B'],
      period: '2026-01~2026-05',
      metric: 'revenue',
    });

    expect(plan.tools_needed).toContain('finance.profitOverview');
    expect(plan.tables_needed).toEqual(expect.arrayContaining(['projectMaster', 'rollbackProjectActual']));
    expect(plan.tool_params['finance.profitOverview']).toMatchObject({
      sortBy: 'revenue',
      order: 'desc',
    });
    expect(plan.query_scope.scopeSource).toBe('pending_clarification');
  });

  test('locked receivable metric restores receivables tool when planner omits it', () => {
    const plan = {
      tools_needed: [],
      tables_needed: [],
      tool_params: {},
      query_scope: {
        depts: [],
        subDepts: [],
        targetProjects: [],
        scopeSource: 'none',
      },
    };

    applyLockedScopeToPlan(plan, {
      source: 'pending_clarification',
      targetProjects: ['项目A', '项目B'],
      period: '2026-01~2026-05',
      metric: 'collectRate',
    });

    expect(plan.tools_needed).toContain('finance.receivables');
    expect(plan.tables_needed).toEqual(expect.arrayContaining(['cashflow', 'projectMaster']));
    expect(plan.tool_params['finance.receivables']).toMatchObject({
      sortBy: 'collectRate',
      order: 'asc',
      metric: 'collectRate',
    });
  });

  test('displayResultSet rows have priority over broader targetProjects and entities', () => {
    const resolved = resolveContext({
      message: '这些项目利润率呢？',
      routerIntent: { isFollowup: true },
      planningContext: [{
        queryState: {
          targetProjects: ['A项目', 'B项目', '范围外项目'],
          displayResultSet: {
            rows: [
              { rank: 1, type: 'project', name: 'A项目' },
              { rank: 2, type: 'project', name: 'B项目' },
            ],
          },
        },
        entities: [
          { rank: 1, type: 'project', name: '范围外项目' },
          { rank: 2, type: 'project', name: 'A项目' },
        ],
      }],
    });

    expect(resolved.lockedScope.targetProjects).toEqual(['A项目', 'B项目']);
  });

  test('rank references prefer displayResultSet order', () => {
    const resolved = resolveContext({
      message: '第一个回款呢？',
      routerIntent: { isFollowup: true },
      planningContext: [{
        queryState: {
          targetProjects: ['A项目', 'B项目', '范围外项目'],
          displayResultSet: {
            toolId: 'finance.profitOverview',
            rows: [
              { rank: 1, type: 'project', name: 'A项目' },
              { rank: 2, type: 'project', name: 'B项目' },
            ],
          },
        },
        entities: [
          { rank: 1, type: 'project', name: '范围外项目' },
        ],
      }],
    });

    expect(resolved.lockedScope.targetProjects).toEqual(['A项目']);
    expect(resolved.lockedScope.targetEntities[0].name).toBe('A项目');
  });
});
