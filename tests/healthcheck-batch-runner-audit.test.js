'use strict';

jest.mock('../src/utils/logger', () => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
}));

jest.mock('../src/clients/feishu-client', () => ({
  listRecords: jest.fn(),
}));

jest.mock('../src/clients/feishu-card-stream', () => ({
  streamMarkdownToChat: jest.fn(),
}));

const runner = require('../src/services/healthcheck-batch-runner');

describe('healthcheck batch audit', () => {
  const scope = {
    isGlobal: false,
    depts: ['快消零售行业群'],
    projectKeys: [],
    period: 'ytd',
    periodYear: 2026,
    cutoffYm: 2604,
  };

  test('部门扩展项目在公司层面账行里也视为授权内', () => {
    const memory = {
      projectMaster: [
        {
          fields: {
            '26年项目名称': '洽洽食品-私域代运营（企微/会员体系）',
            '项目名称（管报）': '洽洽食品-私域代运营（企微/会员体系）',
            '项目归属部门': '快消零售行业群',
          },
        },
      ],
      projectMonthly: [
        {
          fields: {
            '是否交付项目': '洽洽食品-私域代运营（企微/会员体系）',
            '一级部门': '公司层面',
            '月份': 2604,
            '履约收入': 0,
            '履约成本': 1300,
            '履约利润': -1300,
          },
        },
      ],
      actualProject: [
        {
          fields: {
            '是否交付项目': '洽洽食品-私域代运营（企微/会员体系）',
            '一级部门': '公司层面',
            '月份': 2604,
            '履约收入': 0,
            '履约成本': 1300,
            '履约利润': -1300,
          },
        },
      ],
      budgetProject: [],
      invoices: [],
    };

    const audit = runner._private.auditRecipientResult(
      { name: '测试用户' },
      scope,
      memory,
      { healthCheck: { profitMetrics: { revenue: 0, cost: 1300, profit: -1300 } } },
    );

    expect(audit.ok).toBe(true);
    expect(audit.issues).toEqual([]);
  });

  test('经营指标对数使用 healthCheck 实际采用的 projectMonthly 源表', () => {
    const memory = {
      projectMaster: [
        {
          fields: {
            '26年项目名称': '项目A',
            '项目名称（管报）': '项目A',
            '项目归属部门': '快消零售行业群',
          },
        },
      ],
      projectMonthly: [
        {
          fields: {
            '是否交付项目': '项目A',
            '一级部门': '快消零售行业群',
            '月份': 2604,
            '履约收入': 100000,
            '履约成本': 50000,
            '履约利润': 50000,
          },
        },
      ],
      actualProject: [
        {
          fields: {
            '是否交付项目': '项目A',
            '一级部门': '快消零售行业群',
            '月份': 2604,
            '履约收入': 100000,
            '履约成本': 50000,
            '履约利润': 50000,
          },
        },
        {
          fields: {
            '是否交付项目': '项目A',
            '一级部门': '公司层面',
            '月份': 2604,
            '履约收入': 0,
            '履约成本': 1300,
            '履约利润': -1300,
          },
        },
      ],
      budgetProject: [],
      invoices: [],
    };

    const audit = runner._private.auditRecipientResult(
      { name: '测试用户' },
      scope,
      memory,
      { healthCheck: { profitMetrics: { revenue: 100000, cost: 50000, profit: 50000 } } },
    );

    expect(audit.ok).toBe(true);
    expect(audit.metricSource).toBe('projectMonthly');
    expect(audit.periodMetricSum).toEqual({ revenue: 100000, cost: 50000, profit: 50000 });
  });

  test('全局月度体检回款仅保留部门类型为业务的开票回款记录', () => {
    const memory = {
      invoices: [
        { fields: { 项目: '业务项目A', 一级部门: 'X行业群' } },
        { fields: { 项目: '后台项目', 一级部门: '公司层面' } },
        { fields: { 项目: '预算兜底业务项目', 一级部门: '新业务线' } },
        { fields: { 项目: '无映射项目', 一级部门: '未知部门' } },
      ],
      actualDept: [
        { fields: { 一级部门: 'X行业群', 部门类型: ['业务'] } },
        { fields: { 一级部门: '公司层面', 部门类型: ['后台'] } },
      ],
      budgetDept: [
        { fields: { 一级部门: '新业务线', 部门类型: ['业务'] } },
      ],
    };

    const filtered = runner._private.filterGlobalBusinessReceivableMemory(
      memory,
      { isGlobal: true },
      { businessReceivablesOnlyForGlobal: true },
    );

    expect(filtered.memory.invoices.map(row => row.fields.项目)).toEqual(['业务项目A', '预算兜底业务项目']);
    expect(memory.invoices).toHaveLength(4);
    expect(filtered.meta).toMatchObject({
      enabled: true,
      beforeCount: 4,
      afterCount: 2,
      excludedCount: 2,
      excludedByDeptType: { 后台: 1, 无映射: 1 },
      includedDeptTypes: ['业务'],
    });
  });

  test('非全局或未开启开关时不额外过滤回款记录', () => {
    const memory = {
      invoices: [
        { fields: { 项目: '业务项目A', 一级部门: 'X行业群' } },
        { fields: { 项目: '后台项目', 一级部门: '公司层面' } },
      ],
      actualDept: [
        { fields: { 一级部门: 'X行业群', 部门类型: ['业务'] } },
        { fields: { 一级部门: '公司层面', 部门类型: ['后台'] } },
      ],
    };

    const nonGlobal = runner._private.filterGlobalBusinessReceivableMemory(
      memory,
      { isGlobal: false },
      { businessReceivablesOnlyForGlobal: true },
    );
    const disabled = runner._private.filterGlobalBusinessReceivableMemory(
      memory,
      { isGlobal: true },
      {},
    );

    expect(nonGlobal.memory).toBe(memory);
    expect(nonGlobal.meta).toBeNull();
    expect(disabled.memory).toBe(memory);
    expect(disabled.meta).toBeNull();
  });
});
