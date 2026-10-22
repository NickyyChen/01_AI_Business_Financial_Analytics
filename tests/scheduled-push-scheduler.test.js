'use strict';

jest.mock('../src/utils/logger', () => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
}));

jest.mock('../config', () => ({
  DISABLE_SCHEDULERS: false,
  SCHEDULED_PUSH_ENABLED: true,
  SCHEDULED_PUSH_SCHEDULE_MODE: 'privateSend',
  SCHEDULED_PUSH_SCHEDULER_TICK_MS: 30000,
  QA_TRACE_REPORT_WEEKDAY: 5,
  QA_TRACE_REPORT_HOUR: 17,
  QA_TRACE_REPORT_MINUTE: 0,
}));

jest.mock('../src/services/monthly-healthcheck-runner', () => ({
  startMonthlyHealthcheck: jest.fn(() => ({ jobId: 'monthly-job', batchId: 'monthly-batch' })),
}));

jest.mock('../src/services/weekly-receivables-runner', () => ({
  startWeeklyReceivables: jest.fn(() => ({ jobId: 'weekly-job', batchId: 'weekly-batch' })),
}));

jest.mock('../src/services/qa-trace-weekly-runner', () => ({
  startQaTraceWeeklyReport: jest.fn(() => ({ jobId: 'qa-trace-job', batchId: 'qa-trace-batch' })),
}));

const scheduler = require('../src/services/scheduled-push/scheduler');

describe('scheduled push scheduler', () => {
  afterEach(() => {
    scheduler.stopScheduledPushScheduler();
  });

  test('按上海时间识别月度第三个工作日上午 9:30', () => {
    expect(scheduler._private.thirdBusinessDay(2026, 5)).toBe(5);
    expect(scheduler._private.isMonthlyScheduleMinute(
      scheduler._private.shanghaiParts(new Date('2026-05-05T01:30:00.000Z')),
    )).toBe(true);
    expect(scheduler._private.isMonthlyScheduleMinute(
      scheduler._private.shanghaiParts(new Date('2026-05-05T01:29:00.000Z')),
    )).toBe(false);
    expect(scheduler._private.isMonthlyScheduleMinute(
      scheduler._private.shanghaiParts(new Date('2026-05-04T01:30:00.000Z')),
    )).toBe(false);
  });

  test('按上海时间识别周五下午 5 点', () => {
    expect(scheduler._private.isWeeklyScheduleMinute(
      scheduler._private.shanghaiParts(new Date('2026-05-15T09:00:00.000Z')),
    )).toBe(true);
    expect(scheduler._private.isWeeklyScheduleMinute(
      scheduler._private.shanghaiParts(new Date('2026-05-15T08:59:00.000Z')),
    )).toBe(false);
    expect(scheduler._private.isWeeklyScheduleMinute(
      scheduler._private.shanghaiParts(new Date('2026-05-14T09:00:00.000Z')),
    )).toBe(false);
  });

  test('按配置识别 QA Trace 周报推送时间', () => {
    expect(scheduler._private.isQaTraceWeeklyScheduleMinute(
      scheduler._private.shanghaiParts(new Date('2026-05-15T09:00:00.000Z')),
    )).toBe(true);
    expect(scheduler._private.isQaTraceWeeklyScheduleMinute(
      scheduler._private.shanghaiParts(new Date('2026-05-15T08:59:00.000Z')),
    )).toBe(false);
    expect(scheduler._private.isQaTraceWeeklyScheduleMinute(
      scheduler._private.shanghaiParts(new Date('2026-05-16T10:00:00.000Z')),
    )).toBe(false);
  });

  test('启动入口直接注册 scheduler', () => {
    const status = scheduler.startScheduledPushScheduler({ tickMs: 10000 });
    expect(status).toEqual({ started: true, tickMs: 10000, mode: 'privateSend' });
  });
});
