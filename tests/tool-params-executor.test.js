'use strict';

jest.mock('../src/utils/logger', () => ({
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
}));

jest.mock('../src/tools/tool-registry', () => ({
  getTool: jest.fn(),
}));

const config = require('../config');
const toolRegistry = require('../src/tools/tool-registry');
const { executeTools, formatResultsForPrompt } = require('../src/agent/executor');

describe('executor tool params', () => {
  afterEach(() => {
    jest.clearAllMocks();
    config.TOOL_DISPLAY_RESULT_SET_ENABLED = false;
  });

  test('passes tool-specific params as the third handler argument', async () => {
    const handler = jest.fn(() => ({ ok: true }));
    toolRegistry.getTool.mockReturnValue({
      name: '测试工具',
      dataTables: [],
      handler,
    });

    await executeTools(['finance.profitOverview'], { memory: true }, { period: 'ytd' }, {
      toolParams: {
        'finance.profitOverview': { top: 5, sortBy: 'revenue', order: 'desc' },
      },
    });

    expect(handler).toHaveBeenCalledWith(
      { memory: true },
      { period: 'ytd' },
      { top: 5, sortBy: 'revenue', order: 'desc' }
    );
  });

  test('adds receivable default caliber params for global ordinary answers', async () => {
    const handler = jest.fn(() => ({ ok: true }));
    toolRegistry.getTool.mockReturnValue({
      name: '回款情况',
      dataTables: [],
      handler,
    });

    await executeTools(['finance.receivables'], { memory: true }, { period: 'ytd', isGlobal: true }, {});

    expect(handler).toHaveBeenCalledWith(
      { memory: true },
      { period: 'ytd', isGlobal: true },
      {
        businessReceivablesOnlyForGlobal: true,
        receivableRevenueTypeFilter: true,
      }
    );
  });

  test('formats displayResultSet without exposing full outside project list when enabled', () => {
    config.TOOL_DISPLAY_RESULT_SET_ENABLED = true;
    toolRegistry.getTool.mockReturnValue({
      name: '利润总览',
      dataTables: ['projectMaster'],
    });

    const text = formatResultsForPrompt({
      results: {
        'finance.profitOverview': {
          projectCount: 3,
          projects: [{ name: '范围外项目', revenue: 999 }],
          displayProjects: [{ rank: 1, name: 'A项目', revenue: 100 }],
          displayResultSet: {
            type: 'finance.projectMetrics',
            toolId: 'finance.profitOverview',
            sortBy: 'revenue',
            order: 'desc',
            top: 1,
            rows: [{ rank: 1, name: 'A项目', revenue: 100 }],
          },
        },
      },
      errors: {},
    }, { message: '收入最高的项目？' });

    expect(text).toContain('displayResultSet');
    expect(text).toContain('A项目');
    expect(text).not.toContain('范围外项目');
  });

  test('formats person effort detail as actual-only without exposing budget payload', () => {
    toolRegistry.getTool.mockReturnValue({
      name: '人力成本',
      dataTables: ['actualWorktime', 'budgetWorktime'],
    });

    const text = formatResultsForPrompt({
      results: {
        'finance.laborCost': {
          _sourceTable: 'ACTUAL_WORKTIME（实际：26年工时）+ BUDGET_WORKTIME（预算：26年工时）',
          _periodLabel: '2026年1-5月累计',
          _glossary: {
            '预算人头数': '来自 BUDGET_WORKTIME.精力',
          },
          _cohesionHint: '本次预算底表已加载：预算累计 5.00 FTE / 0 个超编项目。',
          _factSheet: [
            '[财务部管理][2026年1-5月累计] 预算累计 5.00 FTE',
          ],
          overrun: {
            topOverrun: ['财务部管理: 实际5.00FTE | 预算3.00FTE | 超编+2.00FTE'],
          },
          budgetLaborCost: 123,
          personEffortDetail: {
            scopeMode: 'multiProject',
            targetProjectCount: 1,
            actualProjectCount: 1,
            actualPeopleCount: 1,
            totalPersonActualRecordCount: 6,
            rowCount: 1,
            omittedRowCount: 0,
            totalActualFTE: 5,
            rows: [
              {
                project: '财务部管理',
                person: '张媛',
                actualFTE: 5,
                monthly: [
                  { monthLabel: '2026年1月', actualFTE: 1 },
                  { monthLabel: '2026年2月', actualFTE: 1 },
                ],
              },
            ],
            rowFacts: [
              '[财务部管理][人员精力] 张媛: 实际累计5.00FTE | 月度 2026年1月=1.00FTE；2026年2月=1.00FTE',
            ],
            dataQualityWarnings: [],
          },
        },
      },
      errors: {},
    }, { message: '我当前可见范围 1-5月人员情况，需要具体人名和精力' });

    expect(text).toContain('ACTUAL_WORKTIME（实际：26年工时）');
    expect(text).toContain('本轮是人员实际精力明细');
    expect(text).toContain('财务部管理 | 张媛 | 5.00');
    expect(text).not.toContain('BUDGET_WORKTIME');
    expect(text).not.toContain('本次预算底表已加载');
    expect(text).not.toContain('预算累计 5.00');
    expect(text).not.toContain('预算3.00FTE');
  });
});
