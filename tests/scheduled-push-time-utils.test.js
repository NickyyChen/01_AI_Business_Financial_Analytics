'use strict';

const {
  monthContext,
  isInMonth,
  formatYmd,
  thirdBusinessDay,
  isThirdBusinessDay,
  isoWeekKey,
} = require('../src/services/scheduled-push/time-utils');

describe('scheduled push time utils', () => {
  test('第三个工作日只排除周六日', () => {
    expect(formatYmd(thirdBusinessDay(2026, 5))).toBe('2026-05-05');
    expect(formatYmd(thirdBusinessDay(2026, 8))).toBe('2026-08-05');

    expect(isThirdBusinessDay(new Date(2026, 4, 5, 9, 30))).toBe(true);
    expect(isThirdBusinessDay(new Date(2026, 4, 4, 9, 30))).toBe(false);
  });

  test('monthContext 固定到自然月首尾并支持月份筛选', () => {
    const ctx = monthContext('2026-05');

    expect(ctx.label).toBe('2026-05');
    expect(ctx.zhLabel).toBe('2026年5月');
    expect(ctx.ym).toBe(2605);
    expect(isInMonth('2026-05-01', ctx)).toBe(true);
    expect(isInMonth('2026-05-31', ctx)).toBe(true);
    expect(isInMonth('2026-06-01', ctx)).toBe(false);
  });

  test('isoWeekKey 使用 ISO 周格式', () => {
    expect(isoWeekKey(new Date(2026, 4, 15))).toBe('2026-W20');
  });
});
