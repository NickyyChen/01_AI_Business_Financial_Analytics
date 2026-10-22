jest.mock('../src/clients/llm-client', () => ({
  chat: jest.fn(async () => {
    throw new Error('llm should not be called in rollback shortcut test');
  }),
}));

jest.mock('../src/clients/minimax-client', () => ({
  chat: jest.fn(async () => {
    throw new Error('minimax should not be called in rollback shortcut test');
  }),
}));

const planner = require('../src/agent/planner');
const toolRegistry = require('../src/tools/tool-registry');
const financeComparisonTools = require('../src/tools/finance-comparison-tools');
const { TABLE_NAME_MAP, MODULE_TABLE_MAP } = require('../src/permissions/permission-manager');

function row(fields) {
  return { fields };
}

describe('finance comparison routing', () => {
  test('plain yoy keyword fallback routes to rollback yoy by default', () => {
    const tools = toolRegistry.keywordSelectTools('\u4eca\u5e74\u540c\u6bd4\u600e\u4e48\u6837');
    expect(tools).toContain('finance.rollbackDeptYoy');
    expect(tools).not.toContain('finance.yoyComparison');
  });

  test('booked yoy keyword fallback routes to finance.yoyComparison', () => {
    const tools = toolRegistry.keywordSelectTools('\u4eca\u5e74\u5165\u8d26\u540c\u6bd4\u600e\u4e48\u6837');
    expect(tools).toContain('finance.yoyComparison');
    expect(tools).not.toContain('finance.rollbackDeptYoy');
    expect(tools).not.toContain('finance.rollbackCompanyYoy');
  });

  test('rollback yoy planner shortcut routes to rollback tools and drilldown', async () => {
    const plan = await planner.plan(
      '\u8bf7\u5206\u6790\u56de\u6eda\u540e\u90e8\u95e8\u540c\u6bd4\uff0c\u5e76\u8bf4\u660e\u54ea\u4e9b\u9879\u76ee\u5f71\u54cd\u6700\u5927',
      { userName: 'tester', role: '\u7ba1\u7406\u8005' }
    );

    expect(plan).toBeTruthy();
    expect(plan._shortcutIntent).toBe('rollback_analysis');
    expect(plan.tools_needed).toEqual(expect.arrayContaining([
      'finance.rollbackDeptYoy',
      'finance.rollbackProjectDrilldown',
    ]));
    expect(plan.tables_needed).toEqual(expect.arrayContaining([
      'deptYoy',
      'rollbackProjectActual',
      'actualProject',
    ]));
  });
});

describe('finance comparison tools', () => {
  test('yoyComparison uses ACTUAL_DEPT as standard caliber source', () => {
    const memory = {
      actualDept: [
        row({
          '\u4e00\u7ea7\u90e8\u95e8': '\u96f6\u552e\u884c\u4e1a\u7fa4',
          '\u6708\u4efd': '2503',
          '\u5c65\u7ea6\u6536\u5165': 80,
          '\u5c65\u7ea6\u6210\u672c': 50,
          '\u5c65\u7ea6\u5229\u6da6': 30,
        }),
        row({
          '\u4e00\u7ea7\u90e8\u95e8': '\u96f6\u552e\u884c\u4e1a\u7fa4',
          '\u6708\u4efd': '2603',
          '\u5c65\u7ea6\u6536\u5165': 100,
          '\u5c65\u7ea6\u6210\u672c': 60,
          '\u5c65\u7ea6\u5229\u6da6': 40,
        }),
      ],
      actualProject: [
        row({
          '\u662f\u5426\u4ea4\u4ed8\u9879\u76ee': '\u9879\u76eeA',
          '\u4e00\u7ea7\u90e8\u95e8': '\u96f6\u552e\u884c\u4e1a\u7fa4',
          '\u6708\u4efd': '2503',
          '\u5c65\u7ea6\u6536\u5165': 40,
          '\u5c65\u7ea6\u6210\u672c': 25,
          '\u5c65\u7ea6\u5229\u6da6': 15,
        }),
        row({
          '\u662f\u5426\u4ea4\u4ed8\u9879\u76ee': '\u9879\u76eeB',
          '\u4e00\u7ea7\u90e8\u95e8': '\u96f6\u552e\u884c\u4e1a\u7fa4',
          '\u6708\u4efd': '2503',
          '\u5c65\u7ea6\u6536\u5165': 40,
          '\u5c65\u7ea6\u6210\u672c': 25,
          '\u5c65\u7ea6\u5229\u6da6': 15,
        }),
        row({
          '\u662f\u5426\u4ea4\u4ed8\u9879\u76ee': '\u9879\u76eeA',
          '\u4e00\u7ea7\u90e8\u95e8': '\u96f6\u552e\u884c\u4e1a\u7fa4',
          '\u6708\u4efd': '2603',
          '\u5c65\u7ea6\u6536\u5165': 70,
          '\u5c65\u7ea6\u6210\u672c': 45,
          '\u5c65\u7ea6\u5229\u6da6': 25,
        }),
        row({
          '\u662f\u5426\u4ea4\u4ed8\u9879\u76ee': '\u9879\u76eeB',
          '\u4e00\u7ea7\u90e8\u95e8': '\u96f6\u552e\u884c\u4e1a\u7fa4',
          '\u6708\u4efd': '2603',
          '\u5c65\u7ea6\u6536\u5165': 30,
          '\u5c65\u7ea6\u6210\u672c': 15,
          '\u5c65\u7ea6\u5229\u6da6': 15,
        }),
      ],
    };

    const result = financeComparisonTools.yoyComparison(memory, { period: '2026-03' });

    expect(result.current.revenue).toBe(100);
    expect(result.previous.revenue).toBe(80);
    expect(result.delta.revenue).toBe(20);
    expect(result.delta.profit).toBe(10);
    expect(result._sourceTable).toContain('ACTUAL_DEPT');
    expect(result.topProjectLift[0].project).toBe('\u9879\u76eeA');
  });

  test('rollbackCompanyYoy parses month-only labels and aggregates company rows', () => {
    const currentYear = new Date().getFullYear();
    const memory = {
      companyYoy: [
        row({
          '\u6708\u4efd': '3\u6708',
          '26\u5e74\u5c65\u7ea6\u6536\u5165': 200,
          '25\u5e74\u5c65\u7ea6\u6536\u5165.': 150,
          '\u5c65\u7ea6\u5229\u6da6': 80,
          '\u5c65\u7ea6\u5229\u6da6.': 50,
        }),
        row({
          '\u6708\u4efd': '3\u6708',
          '26\u5e74\u5c65\u7ea6\u6536\u5165': 20,
          '25\u5e74\u5c65\u7ea6\u6536\u5165.': 10,
          '\u5c65\u7ea6\u5229\u6da6': 5,
          '\u5c65\u7ea6\u5229\u6da6.': 2,
        }),
      ],
    };

    const result = financeComparisonTools.rollbackCompanyYoy(memory, { period: `${currentYear}-03` });

    expect(result.monthYm).toBe(currentYear * 100 + 3);
    expect(result.current.revenue).toBe(220);
    expect(result.previous.revenue).toBe(160);
    expect(result.delta.revenue).toBe(60);
    expect(result.current.profit).toBe(85);
    expect(result.previous.profit).toBe(52);
    expect(result.delta.profit).toBe(33);
  });

  test('rollbackProjectDrilldown joins by project + month + dept instead of SourceID', () => {
    const memory = {
      rollbackProjectActual: [
        row({
          '\u9879\u76ee\u540d': '\u9879\u76eeA',
          '\u56de\u6eda\u6708\u4efd': '2603',
          '\u4e00\u7ea7\u90e8\u95e8': '\u96f6\u552e\u884c\u4e1a\u7fa4',
          '\u5c65\u7ea6\u6536\u5165': 90,
          '\u5c65\u7ea6\u6210\u672c': 82,
          '\u5c65\u7ea6\u5229\u6da6': 8,
          '\u9879\u76ee\u5206\u644a': 3,
          '\u5206\u644a\u540e\u9879\u76ee\u51c0\u5229\u6da6': 5,
        }),
      ],
      actualProject: [
        row({
          '\u662f\u5426\u4ea4\u4ed8\u9879\u76ee': '\u9879\u76eeA',
          '\u6708\u4efd': '2603',
          '\u4e00\u7ea7\u90e8\u95e8': '\u96f6\u552e\u884c\u4e1a\u7fa4',
          '\u5c65\u7ea6\u6536\u5165': 100,
          '\u5c65\u7ea6\u6210\u672c': 70,
          '\u5c65\u7ea6\u5229\u6da6': 30,
          SourceID: 'actual-source',
        }),
      ],
    };

    const result = financeComparisonTools.rollbackProjectDrilldown(memory, { period: '2026-03' });

    expect(result.joinCoverage.matched).toBe(1);
    expect(result.items[0].joinMatched).toBe(true);
    expect(result.items[0].actualProfit).toBe(30);
    expect(result.items[0].rollbackImpactProfit).toBe(-22);
    expect(result.items[0].profitView).toBe('fulfillment');
    expect(result._sourceTable).toContain('\u9879\u76ee\u540d + \u6708\u4efd + \u4e00\u7ea7\u90e8\u95e8');
  });
});

describe('rollback permissions metadata', () => {
  test('permission map exposes rollback project actual table', () => {
    expect(TABLE_NAME_MAP['\u9879\u76ee\u5c42-\u56de\u6eda\u5b9e\u9645']).toBe('ROLLBACK_PROJECT_ACTUAL');
    expect(MODULE_TABLE_MAP.finance).toContain('ROLLBACK_PROJECT_ACTUAL');
  });
});
