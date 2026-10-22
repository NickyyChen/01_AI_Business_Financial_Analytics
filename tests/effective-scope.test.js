'use strict';

jest.mock('../src/utils/logger', () => ({
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
}));

const {
  _buildEffectiveScopeForExecution,
  _normalizePlanScopeForQuestion,
  _clearProjectScopeForConceptQuestion,
  _applyProjectScopeContextGuards,
  _ensureExplicitScopeMention,
} = require('../src/agent/pipeline');
const deptNormalizer = require('../src/permissions/dept-normalizer');

describe('pipeline effective execution scope', () => {
  test('非全局用户点名多部门时，执行范围收窄到 query_scope.depts 与授权部门的交集', () => {
    const scope = {
      isGlobal: false,
      dataScope: 'team',
      depts: ['X行业群', '公司层面', '社区运营中心', '内容业务群'],
      visibleModules: ['finance', 'project'],
    };
    const plan = {
      query_scope: { depts: ['社区运营中心', '内容业务群'] },
    };

    const effective = _buildEffectiveScopeForExecution(plan, scope);

    expect(effective).not.toBe(scope);
    expect(effective.isGlobal).toBe(false);
    expect(effective.depts).toEqual(['社区运营中心', '内容业务群']);
    expect(effective._authDepts).toEqual(['X行业群', '公司层面', '社区运营中心', '内容业务群']);
    expect(effective._queryDepts).toEqual(['社区运营中心', '内容业务群']);
    expect(effective._scopeWasNarrowed).toBe(true);
    expect(effective._strictDeptScope).toBe(true);
  });

  test('全局用户点名部门时也收窄执行范围，避免 Memory Loader 全量加载', () => {
    const scope = {
      isGlobal: true,
      dataScope: 'all',
      depts: [],
      visibleModules: ['finance', 'project'],
    };
    const plan = {
      query_scope: { depts: ['社区运营中心', '内容业务群'] },
    };

    const effective = _buildEffectiveScopeForExecution(plan, scope);

    expect(effective.isGlobal).toBe(false);
    expect(effective.depts).toEqual(['社区运营中心', '内容业务群']);
    expect(effective._authIsGlobal).toBe(true);
    expect(effective._scopeWasNarrowed).toBe(true);
  });

  test('未点名部门时保留原始 scope', () => {
    const scope = { isGlobal: false, depts: ['内容业务群'] };
    const effective = _buildEffectiveScopeForExecution({ query_scope: { depts: [] } }, scope);
    expect(effective).toBe(scope);
  });

  test('社区中心口语简称会先归一为社区运营中心并收窄执行范围', () => {
    const scope = {
      isGlobal: false,
      dataScope: 'team',
      depts: ['X行业群', '社区运营中心', '快消零售行业群', '内容业务群'],
      visibleModules: ['finance', 'project'],
    };
    const plan = {
      query_scope: { depts: [], subDepts: [], targetProjects: [], scopeSource: 'none' },
    };

    deptNormalizer.normalizePlanScope(plan, scope, '社区中心的盈利情况');
    const effective = _buildEffectiveScopeForExecution(plan, scope);

    expect(plan.query_scope.depts).toEqual(['社区运营中心']);
    expect(effective.depts).toEqual(['社区运营中心']);
    expect(effective._authDepts).toEqual(['X行业群', '社区运营中心', '快消零售行业群', '内容业务群']);
    expect(effective._scopeWasNarrowed).toBe(true);
    expect(effective._strictDeptScope).toBe(true);
  });

  test('继承项目集时未点名部门也会附加项目范围约束', () => {
    const scope = { isGlobal: false, depts: ['健康美学行业群'] };
    const effective = _buildEffectiveScopeForExecution({
      query_scope: {
        depts: [],
        targetProjects: ['伊利直播带教', '长隆-私域代运营'],
        scopeSource: 'pending_clarification',
      },
    }, scope);

    expect(effective).not.toBe(scope);
    expect(effective._queryProjectNames).toEqual(['伊利直播带教', '长隆-私域代运营']);
    expect(effective._queryProjectScopeSource).toBe('pending_clarification');
  });

  test('explicit_project 项目范围会附加到执行 scope', () => {
    const scope = { isGlobal: false, depts: ['社区运营中心'] };
    const effective = _buildEffectiveScopeForExecution({
      query_scope: {
        depts: [],
        targetProjects: ['人力资源部管理'],
        scopeSource: 'explicit_project',
      },
    }, scope);

    expect(effective).not.toBe(scope);
    expect(effective._queryProjectNames).toEqual(['人力资源部管理']);
    expect(effective._queryProjectScopeSource).toBe('explicit_project');
  });

  test('已有 explicit_project 项目范围时不再从问题文本补部门', () => {
    const scope = {
      isGlobal: true,
      depts: [],
      visibleModules: ['finance', 'project'],
    };
    const plan = {
      tools_needed: [],
      tables_needed: ['projectMaster'],
      query_scope: {
        depts: [],
        subDepts: [],
        targetProjects: ['财务部管理', '行政部管理', '人力资源部管理'],
        scopeSource: 'explicit_project',
      },
    };

    _normalizePlanScopeForQuestion(plan, scope, '与财务部、行政部、人资部相关的项目名称', '[Test]');

    expect(plan.query_scope.depts).toEqual([]);
    expect(plan.query_scope.targetProjects).toEqual(['财务部管理', '行政部管理', '人力资源部管理']);
    expect(plan.query_scope.scopeSource).toBe('explicit_project');
  });

  test('lockedScope 可在 Planner 漏填时兜底写入执行项目白名单', () => {
    const scope = { isGlobal: false, depts: ['健康美学行业群'] };
    const effective = _buildEffectiveScopeForExecution({
      query_scope: {
        depts: [],
        subDepts: [],
        targetProjects: [],
        scopeSource: 'none',
      },
    }, scope, {
      source: 'planning_context',
      targetProjects: ['无限极-UGC内容运营', '农本方-咨询带教'],
    });

    expect(effective).not.toBe(scope);
    expect(effective._queryProjectNames).toEqual(['无限极-UGC内容运营', '农本方-咨询带教']);
    expect(effective._queryProjectScopeSource).toBe('inherited_result_set');
  });

  test('概念口径类追问清理项目白名单和工具，避免过度继承', () => {
    const plan = {
      tools_needed: ['finance.receivables'],
      tables_needed: ['cashflow', 'projectMaster'],
      query_scope: {
        depts: [],
        subDepts: [],
        targetProjects: ['安踏-会员社群代运营', '特步儿童-商城代运营'],
        scopeSource: 'inherited_result_set',
      },
    };

    _clearProjectScopeForConceptQuestion(plan, '那待认领金额和实际到账金额有什么区别？', '[Test]');

    expect(plan.tools_needed).toEqual([]);
    expect(plan.tables_needed).toEqual([]);
    expect(plan.query_scope.targetProjects).toEqual([]);
    expect(plan.query_scope.scopeSource).toBe('none');
  });

  test('显式整体问题清理 Planner 错误继承的项目集', () => {
    const plan = {
      reasoning_framework: '按上一轮项目集看回款率',
      query_scope: {
        depts: ['健康美学行业群'],
        subDepts: [],
        targetProjects: ['无限极-UGC内容运营', '农本方-咨询带教'],
        scopeSource: 'inherited_result_set',
      },
    };

    _applyProjectScopeContextGuards(plan, {
      message: '那健康美学整体回款率怎么样',
      planningContext: [{
        queryState: { targetProjects: ['无限极-UGC内容运营', '农本方-咨询带教'] },
      }],
      referenceResolution: {
        hasReference: true,
        intentRoute: { shouldUsePlanningContext: true },
      },
    }, '[Test]');

    expect(plan.query_scope.targetProjects).toEqual([]);
    expect(plan.query_scope.scopeSource).toBe('explicit_new_query');
  });

  test('强项目集指代在 Planner 漏填项目集时从计划上下文兜底补齐', () => {
    const plan = {
      reasoning_framework: '分析回款风险',
      query_scope: {
        depts: [],
        subDepts: [],
        targetProjects: [],
        scopeSource: 'none',
      },
    };

    _applyProjectScopeContextGuards(plan, {
      message: '那这几个华为项目里哪个回款风险最高？',
      planningContext: [{
        queryState: {
          targetProjects: ['华为产品线-社群代运营', '华为坤灵-社群代运营'],
        },
      }],
      referenceResolution: {
        hasReference: true,
        intentRoute: { shouldUsePlanningContext: true },
      },
    }, '[Test]');

    expect(plan.query_scope.targetProjects).toEqual(['华为产品线-社群代运营', '华为坤灵-社群代运营']);
    expect(plan.query_scope.scopeSource).toBe('inherited_result_set');
  });

  test('明确部门回答未回显范围时补充自然口径说明', () => {
    const text = _ensureExplicitScopeMention('经营总览：收入 231.6 万，利润率 12%。', {
      query_scope: {
        depts: ['耐消行业群'],
        subDepts: [],
      },
    });

    expect(text).toContain('耐消行业群');
    expect(text).toContain('经营总览');
  });
});
