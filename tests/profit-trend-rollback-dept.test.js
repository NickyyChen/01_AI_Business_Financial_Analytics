'use strict';

const financeTools = require('../src/tools/finance-tools');
const analyticsTools = require('../src/tools/analytics-tools');
const financeComparisonTools = require('../src/tools/finance-comparison-tools');

describe('finance.profitTrend rollback department monthly breakdown', () => {
  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-03T10:33:00+08:00'));
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  test('builds seriesByDept from ROLLBACK_PROJECT_ACTUAL and ignores conflicting actualDept digest values', () => {
    const memory = {
      rollbackProjectActual: [
        {
          fields: {
            '项目名': '公司层面-1月',
            '回滚月份': 2601,
            '归属一级部门': '公司层面',
            '履约收入': 502000,
            '履约成本': 501894,
            '履约利润': 106,
          },
        },
        {
          fields: {
            '项目名': '公司层面-公共基金补贴',
            '回滚月份': 2602,
            '归属一级部门': '公司层面',
            '履约收入': 495182.41,
            '履约成本': 0,
            '履约利润': 495182.41,
          },
        },
        {
          fields: {
            '项目名': '公司层面-其他税项',
            '回滚月份': 2602,
            '归属一级部门': '公司层面',
            '履约收入': 0,
            '履约成本': -68905.26333333238,
            '履约利润': 68905.26333333238,
          },
        },
        {
          fields: {
            '项目名': '社区运营中心-1月',
            '回滚月份': 2601,
            '归属一级部门': '社区运营中心',
            '履约收入': 300000,
            '履约成本': 240000,
            '履约利润': 60000,
          },
        },
        {
          fields: {
            '项目名': '社区运营中心-2月',
            '回滚月份': 2602,
            '归属一级部门': '社区运营中心',
            '履约收入': 100000,
            '履约成本': 80000,
            '履约利润': 20000,
          },
        },
        {
          fields: {
            '项目名': '内容业务群-1月',
            '回滚月份': 2601,
            '归属一级部门': '内容业务群',
            '履约收入': 200000,
            '履约成本': 150000,
            '履约利润': 50000,
          },
        },
        {
          fields: {
            '项目名': '内容业务群-2月',
            '回滚月份': 2602,
            '归属一级部门': '内容业务群',
            '履约收入': 200000,
            '履约成本': 150000,
            '履约利润': 50000,
          },
        },
      ],
      actualDept: [
        {
          fields: {
            '一级部门': '公司层面',
            '月份': 2602,
            '履约收入': 495182.41,
            '履约成本': -63000,
            '履约利润': 558000,
          },
        },
      ],
      actualProject: [],
      projectMonthly: [],
    };

    const result = financeTools.profitTrend(memory, {
      period: '2026-01~2026-02',
      depts: ['公司层面', '社区运营中心', '内容业务群'],
    });

    expect(result.empty).toBeFalsy();
    expect(result._sourceTable).toContain('ROLLBACK_PROJECT_ACTUAL');
    expect(result._sourceDim).toBe('project');
    expect(result.deptCount).toBe(3);
    expect(Object.keys(result.seriesByDept)).toEqual(['公司层面', '内容业务群', '社区运营中心']);

    const companyFeb = result.seriesByDept['公司层面'].find((row) => row.month === 2602);
    expect(companyFeb).toEqual(expect.objectContaining({
      revenue: 495182,
      cost: -68905,
      profit: 564088,
      profitRate: 113.9,
    }));

    expect(companyFeb.cost).not.toBe(-63000);
    expect(companyFeb.profit).not.toBe(558000);
    expect(result.seriesByDeptText['公司层面'][1]).toContain('成本 -6.9万 / 利润 56.4万');
    expect(result._cohesionHint).toContain('ROLLBACK_PROJECT_ACTUAL 表未录入');
  });

  test('filters explicit project scope before aggregating rollback project trend', () => {
    const memory = {
      rollbackProjectActual: [
        {
          fields: {
            '回滚月份': 2601,
            '是否交付项目': '行政部管理',
            '一级部门': '社区运营中心',
            '项目状态': '管理',
            '人力成本': 59671.33,
          },
        },
        {
          fields: {
            '回滚月份': 2602,
            '是否交付项目': '行政部管理',
            '一级部门': '社区运营中心',
            '项目状态': '管理',
            '人力成本': 48583.38,
          },
        },
        {
          fields: {
            '回滚月份': 2603,
            '是否交付项目': '行政部管理',
            '一级部门': '社区运营中心',
            '项目状态': '管理',
            '人力成本': 51492.89,
          },
        },
        {
          fields: {
            '回滚月份': 2604,
            '是否交付项目': '行政部管理',
            '一级部门': '社区运营中心',
            '项目状态': '管理',
            '人力成本': 49014,
          },
        },
        {
          fields: {
            '回滚月份': 2605,
            '是否交付项目': '行政部管理',
            '一级部门': '社区运营中心',
            '项目状态': '管理',
            '人力成本': 43218.64,
          },
        },
        {
          fields: {
            '回滚月份': 2601,
            '是否交付项目': '其他项目',
            '一级部门': '内容业务群',
            '项目状态': '管理',
            '人力成本': 999999,
          },
        },
      ],
      actualDept: [
        {
          fields: {
            '月份': 2601,
            '一级部门': '内容业务群',
            '履约收入': 0,
            '履约成本': 999999,
            '履约利润': -999999,
          },
        },
      ],
      actualProject: [],
      projectMonthly: [],
    };

    const result = financeTools.profitTrend(memory, {
      isGlobal: true,
      period: '2026-01~2026-05',
      question: '行政部管理的1~5月的成本数据和趋势',
      _queryProjectNames: ['行政部管理'],
      _queryProjectScopeSource: 'explicit_project',
    });

    expect(result.empty).toBeFalsy();
    expect(result._sourceTable).toContain('ROLLBACK_PROJECT_ACTUAL');
    expect(result._sourceDim).toBe('project');
    expect(result._scopeLabel).toBe('项目/成本池：行政部管理');
    expect(result._scopeGuard).toEqual(expect.objectContaining({
      targetProjects: ['行政部管理'],
      scopeSource: 'explicit_project',
      rangeApplied: true,
      beforeCount: 6,
      afterCount: 5,
    }));
    expect(result.monthLabels).toEqual([
      '2026年1月',
      '2026年2月',
      '2026年3月',
      '2026年4月',
      '2026年5月',
    ]);
    expect(result.totals.cost).toBe(251980);
    expect(result.totals.profit).toBe(-251980);
    expect(result.deptCount).toBe(1);
    expect(result.seriesByDept).toBeNull();
    expect(result.factSheet.join('\n')).toContain('项目/成本池：行政部管理合计');
    expect(result.factSheet.join('\n')).not.toContain('内容业务群');
    expect(result.seriesText.join('\n')).not.toContain('100.0万');
  });

  test('filters explicit project scope before calculating rollback cost breakdown', () => {
    const memory = {
      rollbackProjectActual: [
        {
          fields: {
            '回滚月份': 2601,
            '是否交付项目': '行政部管理',
            '一级部门': '社区运营中心',
            '项目状态': '管理',
            '人力成本': 59671.33,
            '人头办公费': 1250,
          },
        },
        {
          fields: {
            '回滚月份': 2602,
            '是否交付项目': '行政部管理',
            '一级部门': '社区运营中心',
            '项目状态': '管理',
            '人力成本': 48583.38,
            '人头办公费': 1250,
          },
        },
        {
          fields: {
            '回滚月份': 2601,
            '是否交付项目': '其他项目',
            '一级部门': '内容业务群',
            '项目状态': '管理',
            '人力成本': 999999,
          },
        },
      ],
      actualProject: [],
      projectMonthly: [],
    };

    const result = financeTools.costBreakdown(memory, {
      isGlobal: true,
      period: '2026-01~2026-02',
      question: '行政部管理的1~2月的成本结构',
      _queryProjectNames: ['行政部管理'],
      _queryProjectScopeSource: 'explicit_project',
    });

    expect(result.empty).toBeFalsy();
    expect(result._scopeLabel).toBe('项目/成本池：行政部管理');
    expect(result._scopeGuard).toEqual(expect.objectContaining({
      targetProjects: ['行政部管理'],
      scopeSource: 'explicit_project',
      rangeApplied: true,
      beforeCount: 3,
      afterCount: 2,
    }));
    expect(result.projectCount).toBe(1);
    expect(Math.round(result.operatingCost)).toBe(110755);
    expect(Math.round(result.totalCost)).toBe(110755);
    expect(result.costStructure.map(item => item.label)).toEqual(['人力成本', '人头办公费']);
    expect(result.subcategoryTopProjects['人力成本'].topProjects).toHaveLength(1);
    expect(result.subcategoryTopProjects['人力成本'].topProjects[0]).toEqual(expect.objectContaining({
      name: '行政部管理',
      dept: '社区运营中心',
    }));
  });

  test('filters explicit project scope inside finance healthCheck and receivable sub-metrics', () => {
    const memory = {
      rollbackProjectActual: [
        { fields: { '回滚月份': 2601, '是否交付项目': '行政部管理', '一级部门': '社区运营中心', '项目状态': '管理', '履约收入': 0, '履约成本': 100000, '履约利润': -100000, '人力成本': 100000 } },
        { fields: { '回滚月份': 2601, '是否交付项目': '其他项目', '一级部门': '内容业务群', '项目状态': '履约中', '履约收入': 900000, '履约成本': 800000, '履约利润': 100000, '人力成本': 800000 } },
      ],
      actualProject: [],
      projectMonthly: [],
      projectMaster: [
        { fields: { '26年项目名称': '行政部管理', '项目状态': '管理' } },
        { fields: { '26年项目名称': '其他项目', '项目状态': '履约中' } },
      ],
      performanceTargets: [],
      invoices: [
        { fields: { '项目': '行政部管理', '履约月份': 2601, '履约收入': 100000, '实际回款金额': 0, '已履约未回款': 50000, '预计首次回款时间': '2026/01/20' } },
        { fields: { '项目': '其他项目', '履约月份': 2601, '履约收入': 900000, '实际回款金额': 0, '已履约未回款': 900000, '预计首次回款时间': '2026/01/20' } },
      ],
    };

    const result = financeTools.healthCheck(memory, {
      isGlobal: true,
      period: 'ytd',
      periodYear: 2026,
      _queryProjectNames: ['行政部管理'],
      _queryProjectScopeSource: 'explicit_project',
    });

    expect(result.empty).toBeFalsy();
    expect(result._scopeLabel).toBe('项目/成本池：行政部管理');
    expect(result._scopeGuard).toEqual(expect.objectContaining({ beforeCount: 2, afterCount: 1 }));
    expect(result.profitMetrics.cost).toBe(100000);
    expect(result.profitMetrics.revenue).toBe(0);
    expect(result.receivableMetrics.overdueAmount).toBe(50000);
    expect(result.receivableMetrics.overdueProjects.join('\n')).toContain('行政部管理');
    expect(result.receivableMetrics.overdueProjects.join('\n')).not.toContain('其他项目');
  });

  test('filters explicit project scope inside budgetComparison project layer', () => {
    const memory = {
      rollbackProjectActual: [
        { fields: { '回滚月份': 2601, '是否交付项目': '行政部管理', '一级部门': '社区运营中心', '项目状态': '管理', '履约收入': 0, '履约成本': 100000, '履约利润': -100000 } },
        { fields: { '回滚月份': 2601, '是否交付项目': '其他项目', '一级部门': '内容业务群', '项目状态': '履约中', '履约收入': 900000, '履约成本': 800000, '履约利润': 100000 } },
      ],
      budgetProject: [
        { fields: { '月份': 2601, '是否交付项目': '行政部管理', '一级部门': '社区运营中心', '履约收入': 0, '履约成本': 90000, '履约利润': -90000 } },
        { fields: { '月份': 2601, '是否交付项目': '其他项目', '一级部门': '内容业务群', '履约收入': 1000000, '履约成本': 700000, '履约利润': 300000 } },
      ],
      actualDept: [
        { fields: { '月份': 2601, '一级部门': '全公司', '履约收入': 9999999, '履约成本': 9999999, '履约利润': 0 } },
      ],
      budgetDept: [
        { fields: { '月份': 2601, '一级部门': '全公司', '履约收入': 9999999, '履约成本': 9999999, '履约利润': 0 } },
      ],
    };

    const result = financeTools.budgetComparison(memory, {
      isGlobal: true,
      period: 'ytd',
      periodYear: 2026,
      _queryProjectNames: ['行政部管理'],
      _queryProjectScopeSource: 'explicit_project',
    });

    expect(result.empty).toBeFalsy();
    expect(result.byDept).toBeNull();
    expect(result.byProject).toHaveLength(1);
    expect(result.byProject[0]).toEqual(expect.objectContaining({
      name: '行政部管理',
      actualProfit: -100000,
      budgetProfit: -90000,
      budgetRevenue: 0,
    }));
    expect(result._scopeGuard).toEqual(expect.objectContaining({ beforeCount: 2, afterCount: 1 }));
  });

  test('filters explicit project scope inside analytics completion', () => {
    const memory = {
      rollbackProjectActual: [
        { fields: { '回滚月份': 2601, '是否交付项目': '行政部管理', '一级部门': '社区运营中心', '项目状态': '管理', '履约收入': 100000, '履约成本': 80000, '履约利润': 20000 } },
        { fields: { '回滚月份': 2601, '是否交付项目': '其他项目', '一级部门': '内容业务群', '项目状态': '履约中', '履约收入': 900000, '履约成本': 800000, '履约利润': 100000 } },
      ],
      performanceTargets: [
        { fields: { '月份': 2601, '是否交付项目': '行政部管理', '履约收入': 200000, '履约利润': 50000 } },
        { fields: { '月份': 2601, '是否交付项目': '其他项目', '履约收入': 1000000, '履约利润': 200000 } },
      ],
      projectMaster: [],
      projectStaffing: [],
      projectTeamStaffing: [],
    };

    const result = analyticsTools.completion(memory, {
      isGlobal: true,
      period: 'ytd',
      periodYear: 2026,
      _queryProjectNames: ['行政部管理'],
      _queryProjectScopeSource: 'explicit_project',
    });

    expect(result.summary.projectCount).toBe(1);
    expect(result.summary.totalRevenue).toBe(100000);
    expect(result.completion.targetRevenue).toBe(200000);
    expect(result._scopeGuard).toEqual(expect.objectContaining({ beforeCount: 2, afterCount: 1 }));
  });

  test('filters explicit project scope inside rollback comparison tools', () => {
    const memory = {
      rollbackProjectActual: [
        { fields: { '回滚月份': 2601, '项目名': '行政部管理', '一级部门': '社区运营中心', '履约收入': 0, '履约成本': 100000, '履约利润': -100000 } },
        { fields: { '回滚月份': 2601, '项目名': '其他项目', '一级部门': '内容业务群', '履约收入': 900000, '履约成本': 800000, '履约利润': 100000 } },
      ],
      actualProject: [
        { fields: { '月份': 2601, '是否交付项目': '行政部管理', '一级部门': '社区运营中心', '履约收入': 0, '履约成本': 90000, '履约利润': -90000 } },
        { fields: { '月份': 2601, '是否交付项目': '其他项目', '一级部门': '内容业务群', '履约收入': 900000, '履约成本': 800000, '履约利润': 100000 } },
      ],
    };
    const scope = {
      isGlobal: true,
      period: '2026-01',
      _queryProjectNames: ['行政部管理'],
      _queryProjectScopeSource: 'explicit_project',
    };

    const health = financeComparisonTools.rollbackHealthCheck(memory, scope);
    expect(health.empty).toBeFalsy();
    expect(health.metrics.cost).toBe(100000);
    expect(health.projectSummary.totalProjects).toBe(1);
    expect(health._scopeGuard).toEqual(expect.objectContaining({ beforeCount: 2, afterCount: 1 }));

    const drilldown = financeComparisonTools.rollbackProjectDrilldown(memory, scope);
    expect(drilldown.empty).toBeFalsy();
    expect(drilldown.items).toHaveLength(1);
    expect(drilldown.items[0].project).toBe('行政部管理');
    expect(drilldown.items[0].actualCost).toBe(90000);
  });

  test('filters explicit project scope inside cycle invoices', () => {
    const memory = {
      invoices: [
        { fields: { '项目': '行政部管理', '履约月份': 2601, '按履约匹配开票时间': '2026/01/31', '实际回款时间': '2026/02/28', '预计首次回款时间': '2026/02/28' } },
        { fields: { '项目': '其他项目', '履约月份': 2601, '按履约匹配开票时间': '2026/01/31', '实际回款时间': '2026/06/30', '预计首次回款时间': '2026/06/30' } },
      ],
    };

    const result = financeTools.cycle(memory, {
      isGlobal: true,
      _queryProjectNames: ['行政部管理'],
      _queryProjectScopeSource: 'explicit_project',
    });

    expect(result.empty).toBeFalsy();
    expect(result.projectCount).toBe(1);
    expect(result.projects[0].name).toBe('行政部管理');
    expect(result._scopeGuard).toEqual(expect.objectContaining({ beforeCount: 2, afterCount: 1 }));
  });
});
