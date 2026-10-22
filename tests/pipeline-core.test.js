'use strict';

const { runPipelineCore } = require('../src/agent/pipeline-core');

describe('pipeline core', () => {
  test('returns clarification status before planning when gate asks a question', async () => {
    const result = await runPipelineCore({
      user_id: 'u1',
      message: '这个呢？',
      planningContext: [],
    }, {
      resolveContext: jest.fn(() => ({
        needsClarification: true,
        lockedScope: { source: 'none', targetProjects: [] },
      })),
      checkClarification: jest.fn(() => ({
        action: 'clarify',
        clarificationQuestion: '你说的是哪个项目？',
        pendingClarification: { type: 'slot_clarification' },
      })),
      plan: jest.fn(),
    });

    expect(result.status).toBe('clarification');
    expect(result.reply).toBe('你说的是哪个项目？');
    expect(result.pendingClarification.type).toBe('slot_clarification');
  });

  test('ready_for_answer keeps lockedScope consistent through plan and execution inputs', async () => {
    const lockedScope = {
      source: 'planning_context',
      targetProjects: ['无限极-UGC内容运营', '农本方-咨询带教'],
      targetEntities: [],
      depts: ['健康美学行业群'],
      period: '2026-04',
      metric: 'profit_rate',
      resultSetType: 'finance.projectMetrics',
      sourceTools: ['finance.profitOverview'],
      confidence: 0.9,
      reason: 'test',
    };
    const plan = jest.fn(() => ({
      tools_needed: ['finance.profitOverview'],
      tables_needed: ['actualProject'],
      tool_params: {
        'finance.profitOverview': { top: 2, sortBy: 'profitRate', order: 'desc' },
      },
      query_scope: {
        depts: [],
        subDepts: [],
        targetProjects: [],
        scopeSource: 'none',
      },
    }));
    const buildEffectiveScope = jest.fn((planResult, scope) => ({
      ...scope,
      _queryProjectNames: planResult.query_scope.targetProjects,
      _queryProjectScopeSource: planResult.query_scope.scopeSource,
    }));
    const executeTools = jest.fn(() => ({
      results: { 'finance.profitOverview': { ok: true } },
      errors: {},
      elapsed: 1,
    }));

    const result = await runPipelineCore({
      user_id: 'u1',
      userName: '测试用户',
      message: '这些项目利润率呢？',
      scope: { isGlobal: false, depts: ['健康美学行业群'] },
    }, {
      routeIntent: jest.fn(() => ({ route: 'plan', isFollowup: true, shouldUsePlanningContext: true })),
      resolveContext: jest.fn(() => ({ resolved: true, lockedScope })),
      checkClarification: jest.fn(() => ({ action: 'continue' })),
      resolveScope: jest.fn((_name, _opts) => ({ isGlobal: false, depts: ['健康美学行业群'] })),
      plan,
      buildEffectiveScope,
      selectTables: jest.fn(() => new Set(['actualProject'])),
      loadMemory: jest.fn(() => ({ _traceMeta: { tables: ['actualProject'] } })),
      loadCorrections: jest.fn(() => []),
      executeTools,
    });

    expect(result.status).toBe('ready_for_answer');
    expect(plan.mock.calls[0][1].lockedScope).toBe(lockedScope);
    expect(result.planResult.query_scope.targetProjects).toEqual(lockedScope.targetProjects);
    expect(result.planResult.query_scope.scopeSource).toBe('inherited_result_set');
    expect(result.planResult.tool_params['finance.profitOverview']).toEqual({ top: 2, sortBy: 'profitRate', order: 'desc' });
    expect(result.effectiveScope._queryProjectNames).toEqual(lockedScope.targetProjects);
    expect(executeTools.mock.calls[0][2].question).toBe('这些项目利润率呢？');
    expect(executeTools.mock.calls[0][3].toolParams['finance.profitOverview']).toEqual({ top: 2, sortBy: 'profitRate', order: 'desc' });
  });
});
