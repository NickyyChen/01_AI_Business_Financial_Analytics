'use strict';

jest.mock('../src/utils/logger', () => ({
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
}));

const config = require('../config');
const financeTools = require('../src/tools/finance-tools');

describe('display result set tools', () => {
  const prevDisplayFlag = config.TOOL_DISPLAY_RESULT_SET_ENABLED;

  afterEach(() => {
    config.TOOL_DISPLAY_RESULT_SET_ENABLED = prevDisplayFlag;
  });

  test('finance.profitOverview returns displayResultSet sorted by requested metric', () => {
    config.TOOL_DISPLAY_RESULT_SET_ENABLED = true;
    const memory = {
      rollbackProjectActual: [
        { fields: { 项目名: 'A项目', 回滚月份: '2601', 一级部门: '健康美学行业群', 项目状态: '进行中', 履约收入: 100000, 履约成本: 70000, 履约利润: 30000 } },
        { fields: { 项目名: 'B项目', 回滚月份: '2601', 一级部门: '健康美学行业群', 项目状态: '进行中', 履约收入: 200000, 履约成本: 150000, 履约利润: 50000 } },
      ],
      performanceTargets: [],
      projectMaster: [],
    };

    const result = financeTools.profitOverview(memory, { period: 'historical' }, {
      top: 1,
      sortBy: 'revenue',
      order: 'desc',
    });

    expect(result.displayResultSet.rows.map(row => row.name)).toEqual(['B项目']);
    expect(result.displayResultSet.sortBy).toBe('revenue');
    expect(result.displayResultSet.top).toBe(1);
    expect(result.projects).toHaveLength(2);
  });

  test('finance.receivables returns sorted and truncated displayResultSet', () => {
    config.TOOL_DISPLAY_RESULT_SET_ENABLED = true;
    const memory = {
      invoices: [
        { fields: { 项目: 'A项目', 履约月份: '2601', 履约收入: 100000, 实际回款金额: 80000, 已履约未回款: 20000, 预计首次回款时间: '2026-02-01', 实际回款时间: '2026-02-10' } },
        { fields: { 项目: 'B项目', 履约月份: '2601', 履约收入: 100000, 实际回款金额: 20000, 已履约未回款: 80000, 预计首次回款时间: '2026-02-01', 实际回款时间: '2026-02-10' } },
        { fields: { 项目: 'C项目', 履约月份: '2601', 履约收入: 100000, 实际回款金额: 50000, 已履约未回款: 50000, 预计首次回款时间: '2026-02-01', 实际回款时间: '2026-02-10' } },
      ],
    };

    const result = financeTools.receivables(memory, { period: 'historical' }, {
      top: 2,
      sortBy: 'collectRate',
      order: 'asc',
      metric: 'collectRate',
    });

    expect(result.displayResultSet.rows.map(row => row.name)).toEqual(['B项目', 'C项目']);
    expect(result.displayResultSet.rows).toHaveLength(2);
    expect(result.displayResultSet.sortBy).toBe('collectRate');
    expect(result.displayResultSet.order).toBe('asc');
    expect(result.projects.map(row => row.name)).toEqual(expect.arrayContaining(['A项目', 'B项目', 'C项目']));
  });

  test('finance.receivables applies inherited project whitelist before display ranking', () => {
    config.TOOL_DISPLAY_RESULT_SET_ENABLED = true;
    const memory = {
      invoices: [
        { fields: { 项目: 'A项目', 履约月份: '2601', 履约收入: 100000, 实际回款金额: 100000, 已履约未回款: 0, 预计首次回款时间: '2026-02-01', 实际回款时间: '2026-02-10' } },
        { fields: { 项目: 'B项目', 履约月份: '2601', 履约收入: 100000, 实际回款金额: 0, 已履约未回款: 100000, 预计首次回款时间: '2026-02-01' } },
        { fields: { 项目: '范围外项目', 履约月份: '2601', 履约收入: 100000, 实际回款金额: 0, 已履约未回款: 100000, 预计首次回款时间: '2026-02-01' } },
      ],
    };

    const result = financeTools.receivables(memory, {
      period: 'historical',
      _queryProjectNames: ['A项目', 'B项目'],
      _queryProjectScopeSource: 'inherited_result_set',
    }, {
      top: 2,
      sortBy: 'outstanding',
      order: 'desc',
    });

    expect(result.displayResultSet.rows.map(row => row.name)).toEqual(['B项目', 'A项目']);
    expect(result.displayResultSet.rows.map(row => row.name)).not.toContain('范围外项目');
    expect(result._scopeGuard.rangeApplied).toBe(true);
  });

  test('finance.receivables ytd display ranking uses project-level actual receipts', () => {
    config.TOOL_DISPLAY_RESULT_SET_ENABLED = true;
    const memory = {
      invoices: [
        { fields: { 项目: '同一项目', 履约收入: 100000, 实际回款金额: 0, 预计首次回款时间: '2026-02-01', 收入类型: '基础服务费' } },
        { fields: { 项目: '同一项目', 履约收入: 900000, 实际回款金额: 80000, 实际回款时间: '2026-03-20', 预计首次回款时间: '2026-06-01', 收入类型: '基础服务费' } },
        { fields: { 项目: '另一个项目', 履约收入: 50000, 实际回款金额: 0, 预计回款时间: '2026-02-01', 收入类型: '基础服务费' } },
      ],
    };

    const result = financeTools.receivables(memory, { period: 'ytd', periodYear: 2026 }, {
      top: 2,
      sortBy: 'outstanding',
      order: 'desc',
      receivableRevenueTypeFilter: true,
    });

    expect(result.displayResultSet.rows.map(row => row.name)).toEqual(['另一个项目', '同一项目']);
    expect(result.displayResultSet.rows[1]).toEqual(expect.objectContaining({
      name: '同一项目',
      revenueDelivered: 100000,
      received: 80000,
      outstanding: 20000,
      collectRate: 80,
    }));
  });
});
