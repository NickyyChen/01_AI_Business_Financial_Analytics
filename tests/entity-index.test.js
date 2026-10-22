'use strict';

jest.mock('../src/utils/logger', () => ({
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
}));

const store = require('../src/cache/local-memory-store');
const entityIndex = require('../src/agent/entity-index');

function setCache(rowsByKey) {
  const tableResults = Object.entries(rowsByKey).map(([key, rows]) => ({
    ok: true,
    def: { key, tableId: key, priority: 'P0', required: true },
    rows,
    startedAt: '2026-06-08T00:00:00.000Z',
    finishedAt: '2026-06-08T00:00:00.000Z',
    durationMs: 1,
  }));
  store.setActiveCache(store.buildCache(tableResults, {
    runId: 'entity-index-test',
    version: 'entity-index-test',
    startedAt: '2026-06-08T00:00:00.000Z',
    finishedAt: '2026-06-08T00:00:00.000Z',
  }));
  entityIndex.resetForTest();
}

describe('entity index scope guards', () => {
  beforeEach(() => {
    setCache({
      PROJECT_NAME_UNIQUE: [
        { record_id: 'p1', fields: { '26年项目名称': '人力资源部管理', '项目归属部门': '社区运营中心' } },
      ],
      ROLLBACK_PROJECT_ACTUAL: [
        { record_id: 'r1', fields: { '项目名称（管报）': '人力资源部管理', '一级部门': '社区运营中心', '月份': '2601', '履约成本': 63000, '履约利润': -63000 } },
      ],
      ACTUAL_DEPT: [
        { record_id: 'd1', fields: { '一级部门': '社区运营中心', '月份': '2601', '履约收入': 1000 } },
      ],
    });
  });

  afterEach(() => {
    store.resetForTest();
    entityIndex.resetForTest();
  });

  test('用户文本唯一命中项目时项目优先于部门子串', () => {
    const plan = {
      reasoning_framework: 'Planner 将人力资源部当成部门',
      query_scope: {
        depts: ['人力资源部'],
        subDepts: [],
        targetProjects: [],
        scopeSource: 'none',
      },
    };

    entityIndex.applyEntityScopeGuards(plan, '人力资源部管理项目1~5月的盈亏数据');

    expect(plan.query_scope.depts).toEqual([]);
    expect(plan.query_scope.targetProjects).toEqual(['人力资源部管理']);
    expect(plan.query_scope.scopeSource).toBe('explicit_project');
    expect(plan._entityClarification).toBeUndefined();
  });

  test('Planner 输出不存在部门时不进入严格部门过滤并触发澄清', () => {
    const plan = {
      reasoning_framework: 'Planner 将人资部当成部门',
      query_scope: {
        depts: ['人资部'],
        subDepts: [],
        targetProjects: [],
        scopeSource: 'none',
      },
    };

    entityIndex.applyEntityScopeGuards(plan, '人资部1~5月的盈亏数据');

    expect(plan.query_scope.depts).toEqual([]);
    expect(plan._entityClarification).toBeTruthy();
    expect(plan._entityClarification.question).toContain('没有一级部门');
    expect(plan._entityClarification.pendingClarification.type).toBe('entity_resolution');
    expect(plan._entityClarification.pendingClarification.candidates.map(c => c.name)).toContain('人力资源部管理');
  });
});
