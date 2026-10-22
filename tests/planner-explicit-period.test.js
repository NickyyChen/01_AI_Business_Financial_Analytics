'use strict';

jest.mock('../src/utils/logger', () => ({
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
}));

const planner = require('../src/agent/planner');

describe('planner explicit month range normalization', () => {
  const now = new Date('2026-06-02T10:00:00+08:00');

  test('parses Chinese 1-5月 ranges into profitTrend-supported period strings', () => {
    expect(planner._private._explicitMonthRangePeriod(
      '公司层面 + 社区运营中心 + 内容业务群 1-5月经营趋势',
      now
    )).toBe('2026-01~2026-05');

    expect(planner._private._explicitMonthRangePeriod(
      '2026年1月到5月收入趋势',
      now
    )).toBe('2026-01~2026-05');
  });

  test('overrides ytd/latest when a finance trend question has an explicit month range', () => {
    const parsed = {
      tools_needed: ['finance.profitTrend'],
      tables_needed: ['projectMaster', 'rollbackProjectActual'],
      period: 'ytd',
      reasoning_framework: '趋势类问题必选 finance.profitTrend。',
    };

    const normalized = planner._private._normalizeExplicitPeriod(
      '公司层面 + 社区运营中心 + 内容业务群 1-5月经营趋势',
      parsed,
      now
    );

    expect(normalized.period).toBe('2026-01~2026-05');
    expect(normalized.reasoning_framework).toContain('period 已规范为 2026-01~2026-05');
  });

  test('overrides wrong laborCost periods when personnel effort question has an explicit month range', () => {
    const parsed = {
      tools_needed: ['finance.laborCost'],
      tables_needed: ['actualWorktime', 'budgetWorktime', 'projectMaster'],
      period: '2026-Q1',
      reasoning_framework: '人员实际精力明细问题。',
    };

    const normalized = planner._private._normalizeExplicitPeriod(
      '另外问一下公司层面的人员情况 1-5 月，需要具体人名和精力',
      parsed,
      now
    );

    expect(normalized.period).toBe('2026-01~2026-05');
    expect(normalized.reasoning_framework).toContain('period 已规范为 2026-01~2026-05');
  });

  test('overrides wrong self-scope laborCost month when personnel effort question has an explicit month range', () => {
    const parsed = {
      tools_needed: ['finance.laborCost'],
      tables_needed: ['actualWorktime', 'budgetWorktime', 'projectMaster'],
      period: '2026-03',
      reasoning_framework: '人员实际精力明细问题。',
    };

    const normalized = planner._private._normalizeExplicitPeriod(
      '我当前可见范围 1-5月人员情况，需要具体人名和精力',
      parsed,
      now
    );

    expect(normalized.period).toBe('2026-01~2026-05');
  });

  test('does not treat relative duration wording as an explicit calendar month range', () => {
    expect(planner._private._explicitMonthRangePeriod('过去1-5个月经营趋势', now)).toBeNull();
  });

  test('normalizes explicit ranges in my-project business shortcut plans', async () => {
    jest.useFakeTimers().setSystemTime(now);
    try {
      const result = await planner.plan('我负责的项目 1-5月经营趋势', {
        userName: '张良',
        role: '管理者',
      });

      expect(result.period).toBe('2026-01~2026-05');
      expect(result.tools_needed).toContain('finance.profitTrend');
      expect(result.reasoning_framework).toContain('finance.profitTrend');
    } finally {
      jest.useRealTimers();
    }
  });
});
