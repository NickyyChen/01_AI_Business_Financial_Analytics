'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../../../config');
const logger = require('../../utils/logger');
const monthlyHealthcheckRunner = require('../monthly-healthcheck-runner');
const weeklyReceivablesRunner = require('../weekly-receivables-runner');
const qaTraceWeeklyRunner = require('../qa-trace-weekly-runner');

const TZ = 'Asia/Shanghai';
const MONTHLY_TASK = 'monthly-healthcheck';
const WEEKLY_TASK = 'weekly-receivables';
const QA_TRACE_WEEKLY_TASK = 'qa-trace-weekly';
const DEFAULT_TICK_MS = 30 * 1000;

let timer = null;
const runKeys = new Set();

function pad2(n) {
  return String(n).padStart(2, '0');
}

function shanghaiParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  return {
    year,
    month,
    day,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    ymd: `${year}-${pad2(month)}-${pad2(day)}`,
  };
}

function isWeekday(year, month, day) {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

function thirdBusinessDay(year, month) {
  let count = 0;
  for (let day = 1; day <= 10; day++) {
    if (!isWeekday(year, month, day)) continue;
    count += 1;
    if (count === 3) return day;
  }
  throw new Error(`无法计算第三个工作日: ${year}-${month}`);
}

function isMonthlyScheduleMinute(parts) {
  return parts.hour === 9
    && parts.minute === 30
    && parts.day === thirdBusinessDay(parts.year, parts.month);
}

function isWeeklyScheduleMinute(parts) {
  return parts.weekday === 5 && parts.hour === 17 && parts.minute === 0;
}

function isQaTraceWeeklyScheduleMinute(parts) {
  const weekday = Number(config.QA_TRACE_REPORT_WEEKDAY || 5);
  const hour = Number(config.QA_TRACE_REPORT_HOUR || 17);
  const minute = Number(config.QA_TRACE_REPORT_MINUTE || 0);
  return parts.weekday === weekday && parts.hour === hour && parts.minute === minute;
}

function runKey(task, parts) {
  return `${task}:${parts.ymd}:${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

function lockPath(key) {
  const safe = key.replace(/[^a-zA-Z0-9_.:-]/g, '_');
  return path.resolve(__dirname, '..', '..', '..', 'logs', 'scheduled-push', 'locks', `${safe}.lock`);
}

function acquireLock(key) {
  const file = lockPath(key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const fd = fs.openSync(file, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ key, createdAt: new Date().toISOString() }));
    fs.closeSync(fd);
    return true;
  } catch (error) {
    if (error && error.code === 'EEXIST') return false;
    throw error;
  }
}

function schedulerMode() {
  const mode = String(config.SCHEDULED_PUSH_SCHEDULE_MODE || 'privateSend').trim();
  return mode || 'privateSend';
}

function startTask(task, parts, startFn) {
  const key = runKey(task, parts);
  if (runKeys.has(key)) return false;
  if (!acquireLock(key)) {
    runKeys.add(key);
    logger.warn(`[ScheduledPushScheduler] ${task} ${key} 已有锁文件，跳过重复触发`);
    return false;
  }
  runKeys.add(key);
  const mode = schedulerMode();
  const job = startFn({
    mode,
    confirmProd: mode === 'privateSend',
    force: false,
    batchId: `${task}-${parts.ymd.replace(/-/g, '')}-${pad2(parts.hour)}${pad2(parts.minute)}`,
  });
  logger.info(`[ScheduledPushScheduler] 已触发 ${task}: jobId=${job.jobId} batchId=${job.batchId} mode=${mode}`);
  return true;
}

function tick(now = new Date()) {
  const parts = shanghaiParts(now);
  if (isMonthlyScheduleMinute(parts)) {
    startTask(MONTHLY_TASK, parts, opts => monthlyHealthcheckRunner.startMonthlyHealthcheck(opts));
  }
  if (isWeeklyScheduleMinute(parts)) {
    startTask(WEEKLY_TASK, parts, opts => weeklyReceivablesRunner.startWeeklyReceivables(opts));
  }
  if (isQaTraceWeeklyScheduleMinute(parts)) {
    startTask(QA_TRACE_WEEKLY_TASK, parts, opts => qaTraceWeeklyRunner.startQaTraceWeeklyReport(opts));
  }
}

function startScheduledPushScheduler(opts = {}) {
  if (timer) return { started: true, reused: true };

  const tickMs = Math.max(10 * 1000, Number(opts.tickMs || config.SCHEDULED_PUSH_SCHEDULER_TICK_MS) || DEFAULT_TICK_MS);
  timer = setInterval(() => {
    try {
      tick();
    } catch (error) {
      logger.error(`[ScheduledPushScheduler] tick 失败: ${error.message}`);
    }
  }, tickMs);
  if (timer.unref) timer.unref();
  tick();
  logger.info(`[ScheduledPushScheduler] 已启动: timezone=${TZ} tickMs=${tickMs} mode=${schedulerMode()} monthly=第三个工作日09:30 weekly=周五17:00 qaTraceWeekly=weekday${config.QA_TRACE_REPORT_WEEKDAY || 5} ${pad2(config.QA_TRACE_REPORT_HOUR || 17)}:${pad2(config.QA_TRACE_REPORT_MINUTE || 0)}`);
  return { started: true, tickMs, mode: schedulerMode() };
}

function stopScheduledPushScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  runKeys.clear();
}

module.exports = {
  startScheduledPushScheduler,
  stopScheduledPushScheduler,
  _private: {
    shanghaiParts,
    thirdBusinessDay,
    isMonthlyScheduleMinute,
    isWeeklyScheduleMinute,
    isQaTraceWeeklyScheduleMinute,
    runKey,
    acquireLock,
    tick,
  },
};
