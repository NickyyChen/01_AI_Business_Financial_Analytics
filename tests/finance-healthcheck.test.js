'use strict';

const financeTools = require('../src/tools/finance-tools');

describe('finance.healthCheck', () => {
  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-13T12:00:00+08:00'));
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  test('默认经营体检仍走回滚口径，显式 booked 才走入账口径', () => {
    const memory = {
      rollbackProjectActual: [
        {
          fields: {
            '项目名': '项目A',
            '回滚月份': 2604,
            '一级部门': '健康美学行业群',
            '项目状态': '履约中',
            '履约收入': 200000,
            '履约成本': 120000,
            '履约利润': 80000,
          },
        },
      ],
      actualProject: [
        {
          fields: {
            '是否交付项目': '项目A',
            '月份': 2604,
            '一级部门': '健康美学行业群',
            '项目状态': '履约中',
            '履约收入': 100000,
            '履约成本': 90000,
            '履约利润': 10000,
          },
        },
      ],
      projectMonthly: [],
      actualDept: [],
      projectMaster: [
        { fields: { '26年项目名称': '项目A', '项目状态': '履约中' } },
      ],
      performanceTargets: [],
      invoices: [],
    };

    const rollback = financeTools.healthCheck(memory, { period: 'ytd', periodYear: 2026 });
    const booked = financeTools.healthCheck(memory, { period: 'ytd', periodYear: 2026, actualCaliber: 'booked' });

    expect(rollback.actualCaliber).toBe('rollback');
    expect(rollback.profitMetrics.revenue).toBe(200000);
    expect(rollback.profitMetrics.profit).toBe(80000);
    expect(booked.actualCaliber).toBe('booked');
    expect(booked.profitMetrics.revenue).toBe(100000);
    expect(booked.profitMetrics.profit).toBe(10000);
  });

  test('项目权限场景 projectMonthly 为空时使用 actualProject 计算经营总览和本月列', () => {
    const memory = {
      projectMonthly: [],
      actualProject: [
        {
          fields: {
            '是否交付项目': '项目A',
            '月份': 2604,
            '一级部门': '健康美学行业群',
            '项目状态': '履约中',
            '履约收入': 100000,
            '履约成本': 120000,
            '履约利润': -20000,
          },
        },
        {
          fields: {
            '是否交付项目': '公共基金补贴',
            '月份': 2604,
            '一级部门': '调整',
            '项目状态': '非项目',
            '履约收入': -50000,
            '履约成本': -50000,
            '履约利润': 0,
          },
        },
      ],
      projectMaster: [
        { fields: { '26年项目名称': '项目A', '项目状态': '履约中' } },
        { fields: { '26年项目名称': '公共基金补贴', '项目状态': '非项目' } },
      ],
      performanceTargets: [
        { fields: { '是否交付项目': '项目A', '月份': 2604, '履约收入': 200000, '履约利润': 50000 } },
      ],
      invoices: [
        {
          fields: {
            '项目': '项目A',
            '履约月份': 2604,
            '履约收入': 100000,
            '实际回款金额': 40000,
            '实际回款时间': '2026/04/25',
            '已履约未回款': 60000,
            '预计首次回款时间': '2026/04/20',
            '提醒判断【未回款】': '到期未回款',
          },
        },
      ],
    };

    const result = financeTools.healthCheck(memory, { period: 'ytd', periodYear: 2026 });

    expect(result.profitMetrics.revenue).toBe(50000);
    expect(result.profitMetrics.cost).toBe(70000);
    expect(result.profitMetrics.profit).toBe(-20000);
    expect(result.profitMetrics.lossCount).toBe(1);
    expect(result.profitMetrics.currentMonth.revenue).toBe(50000);
    expect(result.profitMetrics.currentMonth.lossCount).toBe(1);
    expect(result.profitMetrics.currentMonth.collectRate).toBeCloseTo(40);
    expect(result.profitMetrics.currentMonth.overdueProjectCount).toBe(1);
    expect(result.monthlyTrend.series[0].revenue).toBe(50000);
    expect(result.riskProjects[0].lossMonthLabel).toBe('1个月（4月）');
  });

  test('经营体检成本结构优先使用部门层，包含市场费用并对冲公共基金', () => {
    const memory = {
      actualProject: [],
      projectMonthly: [],
      projectMaster: [],
      performanceTargets: [],
      invoices: [],
      actualDept: [
        {
          fields: {
            '一级部门': 'X行业群',
            '月份': 2601,
            '履约收入': 100,
            '履约成本': 100,
            '履约利润': 0,
            '人力成本': 30,
            '市场费用': 20,
            '公共基金': 10,
          },
        },
        {
          fields: {
            '一级部门': '调整',
            '月份': 2601,
            '公共基金': -10,
          },
        },
      ],
    };

    const result = financeTools.healthCheck(memory, {
      period: 'ytd',
      periodYear: 2026,
      isGlobal: true,
    });

    expect(result.costStructure.source).toBe('ACTUAL_DEPT');
    expect(result.costStructure.marketFeeAmount).toBe(20);
    expect(result.costStructure.publicFundAmount).toBe(0);
    expect(result.costStructure.rows.map(row => row.label)).toContain('市场费用');
    expect(result.costStructure.rows.map(row => row.label)).not.toContain('公共基金');
  });

  test('项目层成本结构包含市场费用，项目级权限 fallback 时不漏科目', () => {
    const memory = {
      actualProject: [
        {
          fields: {
            '是否交付项目': '项目A',
            '月份': 2604,
            '一级部门': '健康美学行业群',
            '项目状态': '履约中',
            '履约收入': 100000,
            '履约成本': 130000,
            '履约利润': -30000,
            '人力成本': 50000,
            '市场费用': 12000,
          },
        },
      ],
      projectMonthly: [],
      projectMaster: [{ fields: { '26年项目名称': '项目A', '项目状态': '履约中' } }],
      performanceTargets: [],
      invoices: [],
    };

    const cost = financeTools.costBreakdown(memory, {
      period: 'ytd',
      periodYear: 2026,
      projectKeys: ['项目A'],
    });

    expect(cost.availableCategories.map(item => item.label)).toContain('市场费用');
    expect(cost.costStructure).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: '市场费用', amount: 12000 }),
    ]));
  });

  test('回款与逾期累计按经营体检 cutoff 截止到上月', () => {
    const memory = {
      invoices: [
        {
          fields: {
            '项目': '项目A',
            '履约月份': 2604,
            '履约收入': 100000,
            '实际回款金额': 40000,
            '实际回款时间': '2026/04/25',
            '已履约未回款': 60000,
            '预计首次回款时间': '2026/04/20',
            '提醒判断【未回款】': '到期未回款',
          },
        },
        {
          fields: {
            '项目': '项目B',
            '履约月份': 2605,
            '履约收入': 200000,
            '实际回款金额': 0,
            '已履约未回款': 200000,
            '预计首次回款时间': '2026/05/10',
            '提醒判断【未回款】': '到期未回款',
          },
        },
      ],
      actualProject: [],
      projectMonthly: [],
      projectMaster: [],
      performanceTargets: [],
    };

    const scope = { period: 'ytd', periodYear: 2026 };
    const receivables = financeTools.receivables(memory, scope);
    const health = financeTools.healthCheck(memory, scope);

    expect(receivables.breakdown.ytd.totalDelivered).toBe(100000);
    expect(receivables.breakdown.ytd.totalReceived).toBe(40000);
    expect(receivables.breakdown.ytd.collectRate).toBe(40);
    expect(receivables.projects.find(item => item.name === '项目A').overdueAmount).toBe(60000);
    expect(receivables.projects.find(item => item.name === '项目B').overdueAmount).toBe(0);
    expect(health.receivableMetrics.overdueAmount).toBe(60000);
    expect(health.receivableMetrics.overdueCount).toBe(1);
  });

  test('回款计划口径按预计字段优先、实际回款时间空预计兜底，实际到账按收入类型过滤', () => {
    const memory = {
      invoices: [
        {
          fields: {
            '项目': '基础服务费项目',
            '履约月份': 2604,
            '收入类型': '基础服务费',
            '履约收入': 100000,
            '实际回款金额': 10000,
            '实际回款时间': '2026/04/10',
            '已履约未回款': 90000,
          },
        },
        {
          fields: {
            '项目': 'GMV项目',
            '履约月份': 2604,
            '收入类型': 'GMV分成',
            '履约收入': 100000,
            '实际回款金额': 20000,
            '实际回款时间': '2026/04/11',
            '已履约未回款': 80000,
          },
        },
        {
          fields: {
            '项目': '代收项目',
            '履约月份': 2604,
            '收入类型': '代收/代垫款',
            '履约收入': 100000,
            '实际回款金额': 30000,
            '实际回款时间': '2026/04/12',
            '已履约未回款': 70000,
          },
        },
        {
          fields: {
            '项目': '保证金项目',
            '履约月份': 2604,
            '收入类型': '保证金',
            '履约收入': 100000,
            '实际回款金额': 40000,
            '实际回款时间': '2026/04/13',
            '已履约未回款': 60000,
          },
        },
        {
          fields: {
            '项目': '历史基础服务费项目',
            '履约月份': 2512,
            '收入类型': '基础服务费',
            '履约收入': 100000,
            '实际回款金额': 50000,
            '实际回款时间': '2026/04/14',
            '已履约未回款': 50000,
          },
        },
        {
          fields: {
            '项目': '历史代收项目',
            '履约月份': 2512,
            '收入类型': '代收/代垫款',
            '履约收入': 100000,
            '实际回款金额': 60000,
            '实际回款时间': '2026/04/15',
            '已履约未回款': 40000,
          },
        },
        {
          fields: {
            '项目': '历史保证金项目',
            '履约月份': 2512,
            '收入类型': '保证金',
            '履约收入': 100000,
            '实际回款金额': 70000,
            '实际回款时间': '2026/04/16',
            '已履约未回款': 30000,
          },
        },
      ],
    };

    const scope = { period: 'ytd', periodYear: 2026 };
    const legacy = financeTools.receivables(memory, scope);
    const filtered = financeTools.receivables(memory, scope, {
      receivableRevenueTypeFilter: true,
    });

    expect(legacy.breakdown.ytd.totalDelivered).toBe(700000);
    expect(legacy.breakdown.ytd.totalReceived).toBe(280000);
    expect(legacy.breakdown.ytd.totalReceivedByDate).toBe(280000);
    expect(legacy.breakdown.ytd.totalOutstanding).toBe(420000);
    expect(legacy.breakdown.ytd.collectRate).toBe(40);
    expect(filtered.breakdown.ytd.totalDelivered).toBe(700000);
    expect(filtered.breakdown.ytd.totalReceived).toBe(170000);
    expect(filtered.breakdown.ytd.totalReceivedByDate).toBe(170000);
    expect(filtered.breakdown.ytd.totalOutstanding).toBe(530000);
    expect(filtered.breakdown.ytd.collectRate).toBe(24.3);
    expect(filtered.breakdown.ytd.collectionCountByDate).toBe(5);
    expect(filtered._revenueTypeFilter).toEqual({
      enabled: true,
      receiptTypes: ['基础服务费', 'GMV分成', '代收/代垫款'],
    });
  });

  test('回款计划履约额不按履约月份过滤，预计字段优先，实际回款时间仅在预计字段都空时兜底', () => {
    const memory = {
      invoices: [
        {
          fields: {
            '项目': '预计首次命中',
            '履约月份': 2512,
            '履约收入': 100000,
            '实际回款金额': 0,
            '预计首次回款时间': '2026/04/20',
          },
        },
        {
          fields: {
            '项目': '预计回款兜底命中',
            '履约月份': 2512,
            '履约收入': 200000,
            '实际回款金额': 0,
            '预计回款时间': '2026/04/25',
          },
        },
        {
          fields: {
            '项目': '预计都空但四月已到账',
            '履约月份': 2606,
            '履约收入': 300000,
            '实际回款金额': 120000,
            '实际回款时间': '2026/04/18',
          },
        },
        {
          fields: {
            '项目': '预计六月但四月已到账',
            '履约月份': 2606,
            '履约收入': 300000,
            '实际回款金额': 120000,
            '实际回款时间': '2026/04/18',
            '预计首次回款时间': '2026/06/30',
          },
        },
        {
          fields: {
            '项目': '范围外',
            '履约月份': 2604,
            '履约收入': 400000,
            '实际回款金额': 0,
            '预计首次回款时间': '2026/06/10',
          },
        },
      ],
    };

    const receivables = financeTools.receivables(memory, { period: 'ytd', periodYear: 2026 });

    expect(receivables.breakdown.ytd.totalDelivered).toBe(600000);
    expect(receivables.breakdown.ytd.totalReceivedByDate).toBe(240000);
    expect(receivables.breakdown.ytd.totalOutstanding).toBe(360000);
    expect(receivables.breakdown.ytd.collectRate).toBe(40);
    expect(receivables.projects.map(item => item.name)).toContain('预计都空但四月已到账');
    expect(receivables.projects.find(item => item.name === '预计六月但四月已到账').details).toHaveLength(0);
    expect(receivables.projects.find(item => item.name === '范围外').details).toHaveLength(0);
    expect(receivables.authoritativeAnswer.ytdByDelivery).toContain('| 回款计划履约额 | **60.00 万** |');
    expect(receivables.authoritativeAnswer.ytdByDelivery).toContain('| 本年实际到账 | **24.00 万** |');
    expect(receivables.authoritativeAnswer.ytdByDelivery).not.toContain('本年已回款');
  });

  test('项目级未回款按回款计划履约额减本年实际到账，到账不要求命中回款计划行', () => {
    const memory = {
      invoices: [
        {
          fields: {
            '项目': '同一项目',
            '履约月份': 2601,
            '收入类型': '基础服务费',
            '履约收入': 100000,
            '实际回款金额': 0,
            '预计首次回款时间': '2026/01/20',
          },
        },
        {
          fields: {
            '项目': '同一项目',
            '履约月份': 2606,
            '收入类型': '基础服务费',
            '履约收入': 900000,
            '实际回款金额': 80000,
            '实际回款时间': '2026/03/20',
            '预计首次回款时间': '2026/06/20',
          },
        },
        {
          fields: {
            '项目': '另一个项目',
            '履约月份': 2602,
            '收入类型': '基础服务费',
            '履约收入': 50000,
            '实际回款金额': 0,
            '预计回款时间': '2026/02/20',
          },
        },
      ],
    };

    const receivables = financeTools.receivables(
      memory,
      { period: 'ytd', periodYear: 2026 },
      { receivableRevenueTypeFilter: true }
    );
    const sameProject = receivables.projects.find(item => item.name === '同一项目');

    expect(receivables.breakdown.ytd.totalDelivered).toBe(150000);
    expect(receivables.breakdown.ytd.totalReceivedByDate).toBe(80000);
    expect(receivables.breakdown.ytd.totalOutstanding).toBe(70000);
    expect(sameProject.details).toHaveLength(1);
    expect(sameProject.revenueDelivered).toBe(100000);
    expect(sameProject.received).toBe(80000);
    expect(sameProject.outstanding).toBe(20000);
    expect(sameProject.collectRate).toBe(80);
    expect(sameProject.revenueDeliveredYtd).toBe(100000);
    expect(sameProject.receivedYtd).toBe(80000);
    expect(sameProject.outstandingYtd).toBe(20000);
    expect(sameProject.collectRateYtd).toBe(80);
    expect(receivables.byOutstanding[0]).toContain('另一个项目：未回 5.0万');
    expect(receivables.byOutstanding[1]).toContain('同一项目：未回 2.0万（回款率80%）');
  });

  test('全公司回款可按部门类型仅保留业务部门', () => {
    const memory = {
      actualDept: [
        { fields: { 一级部门: 'X行业群', 部门类型: ['业务'] } },
        { fields: { 一级部门: '公司层面', 部门类型: ['后台'] } },
      ],
      budgetDept: [],
      invoices: [
        {
          fields: {
            一级部门: 'X行业群',
            项目: '业务项目',
            履约月份: 2512,
            履约收入: 100000,
            实际回款金额: 50000,
            实际回款时间: '2026/04/18',
            预计首次回款时间: '2026/04/20',
          },
        },
        {
          fields: {
            一级部门: '公司层面',
            项目: '后台项目',
            履约月份: 2512,
            履约收入: 70000,
            实际回款金额: 70000,
            实际回款时间: '2026/04/19',
            预计首次回款时间: '2026/04/20',
          },
        },
      ],
    };

    const receivables = financeTools.receivables(
      memory,
      { period: 'ytd', periodYear: 2026, isGlobal: true },
      { businessReceivablesOnlyForGlobal: true }
    );

    expect(receivables.recordCount).toBe(1);
    expect(receivables.breakdown.ytd.totalDelivered).toBe(100000);
    expect(receivables.breakdown.ytd.totalReceived).toBe(50000);
    expect(receivables.breakdown.ytd.totalOutstanding).toBe(50000);
    expect(receivables.projects.map(item => item.name)).toEqual(['业务项目']);
    expect(receivables._deptTypeFilter).toEqual(expect.objectContaining({
      enabled: true,
      beforeCount: 2,
      afterCount: 1,
      excludedCount: 1,
      includedDeptTypes: ['业务'],
    }));
  });

  test('回款工具在追问继承项目集时只统计目标项目', () => {
    const memory = {
      invoices: [
        {
          fields: {
            '项目': '项目A',
            '履约月份': 2604,
            '履约收入': 100000,
            '实际回款金额': 20000,
            '实际回款时间': '2026/04/20',
            '已履约未回款': 80000,
            '预计首次回款时间': '2026/04/20',
          },
        },
        {
          fields: {
            '项目': '项目B',
            '履约月份': 2604,
            '履约收入': 300000,
            '实际回款金额': 0,
            '已履约未回款': 300000,
            '预计首次回款时间': '2026/04/20',
          },
        },
      ],
    };

    const receivables = financeTools.receivables(memory, {
      period: 'ytd',
      periodYear: 2026,
      _queryProjectNames: ['项目A'],
      _queryProjectScopeSource: 'pending_clarification',
    });

    expect(receivables._scopeGuard).toEqual(expect.objectContaining({
      targetProjects: ['项目A'],
      scopeSource: 'pending_clarification',
      rangeApplied: true,
      beforeCount: 2,
      afterCount: 1,
    }));
    expect(receivables.projectCount).toBe(1);
    expect(receivables.recordCount).toBe(1);
    expect(receivables.projects.map(item => item.name)).toEqual(['项目A']);
    expect(receivables.breakdown.ytd.totalDelivered).toBe(100000);
    expect(receivables.breakdown.ytd.totalReceived).toBe(20000);
    expect(receivables.breakdown.ytd.collectRate).toBe(20);
  });

  test('利润总览在追问继承项目集时只统计目标项目', () => {
    const memory = {
      actualProject: [
        {
          fields: {
            '是否交付项目': '项目A',
            '月份': 2604,
            '一级部门': '健康美学行业群',
            '项目状态': '履约中',
            '履约收入': 100000,
            '履约成本': 80000,
            '履约利润': 20000,
          },
        },
        {
          fields: {
            '是否交付项目': '项目B',
            '月份': 2604,
            '一级部门': '健康美学行业群',
            '项目状态': '履约中',
            '履约收入': 300000,
            '履约成本': 100000,
            '履约利润': 200000,
          },
        },
      ],
      projectMonthly: [],
      projectMaster: [
        { fields: { '26年项目名称': '项目A', '项目状态': '履约中' } },
        { fields: { '26年项目名称': '项目B', '项目状态': '履约中' } },
      ],
      performanceTargets: [],
    };

    const profit = financeTools.profitOverview(memory, {
      period: 'ytd',
      periodYear: 2026,
      _queryProjectNames: ['项目A'],
      _queryProjectScopeSource: 'inherited_result_set',
    });

    expect(profit._scopeGuard).toEqual(expect.objectContaining({
      targetProjects: ['项目A'],
      scopeSource: 'inherited_result_set',
      rangeApplied: true,
      beforeCount: 2,
      afterCount: 1,
    }));
    expect(profit.revenue).toBe(100000);
    expect(profit.profit).toBe(20000);
    expect(profit.projectCount).toBe(1);
    expect(profit.projects.map(item => item.key)).toEqual(['项目A']);
  });
});
