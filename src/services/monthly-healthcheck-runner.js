'use strict';

const config = require('../../config');
const logger = require('../utils/logger');
const healthcheckBatchRunner = require('./healthcheck-batch-runner');
const {
  isThirdBusinessDay,
  monthContext,
  isoWeekKey,
  nowText,
} = require('./scheduled-push/time-utils');
const {
  appendJsonl,
  ensureActualCacheReady,
  resolveTargetChat,
  sendCardkitMarkdown,
  maskId,
} = require('./scheduled-push/common');

const TASK = 'monthly-healthcheck';
const jobs = new Map();
let runningJobId = null;

function shouldRunToday(now = new Date()) {
  return isThirdBusinessDay(now);
}

async function runJob(job, opts = {}) {
  const mode = opts.mode || 'dryRun';
  if (mode === 'privateSend' && opts.confirmProd !== true) {
    throw new Error('privateSend 必须显式 confirmProd=true');
  }
  const now = opts.now || new Date();
  const ctx = monthContext(opts.periodMonth, now);
  if (!opts.force && !shouldRunToday(now)) {
    const summary = {
      jobId: job.jobId,
      batchId: job.batchId,
      mode,
      periodMonth: ctx.label,
      status: 'skipped',
      reason: '今天不是本月第三个工作日',
      checkedAt: new Date().toISOString(),
    };
    appendJsonl(TASK, job.batchId, { type: 'summary', ...summary });
    return summary;
  }

  const cacheStatus = await ensureActualCacheReady('monthly-healthcheck');
  const { listRecipientsFromView, buildHealthcheckForRecipient } = healthcheckBatchRunner._private;
  const { recipients, skipped, viewId } = await listRecipientsFromView();
  const offset = Math.max(0, Number(opts.offset) || 0);
  const limit = Math.max(0, Number(opts.limit) || 0);
  const delayMs = Math.max(0, Number(opts.delayMs) || 2500);
  const selected = recipients.slice(offset, limit ? offset + limit : undefined);
  if (selected.length === 0) throw new Error(`月度经营体检目标名单为空：offset=${offset} limit=${limit}`);

  let targetChat = null;
  if (mode === 'groupReview') targetChat = await resolveTargetChat();

  const summary = {
    jobId: job.jobId,
    batchId: job.batchId,
    task: TASK,
    mode,
    periodMonth: ctx.label,
    targetViewName: 'Grid View --项目经理及总监',
    viewId,
    totalCandidates: recipients.length,
    skippedRecipients: skipped,
    selectedCount: selected.length,
    cacheRunId: cacheStatus.runId,
    cacheCutoff: cacheStatus.cutoffText,
    success: 0,
    failed: 0,
    skippedNoRows: 0,
    startedAt: new Date().toISOString(),
    results: [],
  };
  appendJsonl(TASK, job.batchId, { type: 'start', ...summary });

  if (mode === 'groupReview') {
    const intro = [
      `**月度经营体检验收摘要｜${ctx.zhLabel}**`,
      '',
      `生成时间：${nowText(now)}`,
      `名单视图：Grid View --项目经理及总监`,
      `候选人数：${recipients.length}`,
      `本次验收人数：${selected.length}`,
      `缓存批次：${cacheStatus.runId}`,
      '',
      '后续人工确认后，再触发私聊正式发送。',
    ].join('\n');
    const session = await sendCardkitMarkdown(
      { chatId: targetChat.chatId },
      intro,
      `月度经营体检验收摘要 - ${ctx.zhLabel}`,
      'blue',
    );
    appendJsonl(TASK, job.batchId, { type: 'group_summary', messageId: session.messageId, cardId: session.cardId });
  }

  for (let i = 0; i < selected.length; i++) {
    const recipient = selected[i];
    const sequence = offset + i + 1;
    const startedAt = new Date().toISOString();
    try {
      const built = await buildHealthcheckForRecipient(recipient, {
        businessReceivablesOnlyForGlobal: true,
        receivableRevenueTypeFilter: true,
      });
      const title = `月度经营体检 - ${recipient.name} (${sequence}/${recipients.length})`;
      let send = null;
      if (mode === 'groupReview') {
        const session = await sendCardkitMarkdown({ chatId: targetChat.chatId }, built.markdown, `[验收] ${title}`, 'blue');
        send = { messageId: session.messageId, cardId: session.cardId, target: targetChat.chatName };
      } else if (mode === 'privateSend') {
        const session = await sendCardkitMarkdown({ openId: recipient.openId }, built.markdown, title, 'blue');
        send = { messageId: session.messageId, cardId: session.cardId, target: maskId(recipient.openId) };
      }
      const row = {
        type: 'recipient',
        batchId: job.batchId,
        mode,
        periodMonth: ctx.label,
        sequence,
        recipientName: recipient.name,
        openIdMasked: maskId(recipient.openId),
        rowCounts: built.memoryTrace && built.memoryTrace.rowCounts ? built.memoryTrace.rowCounts : null,
        receivableDeptTypeFilter: built.receivableDeptTypeFilter || null,
        auditResult: built.auditResult,
        markdownLength: built.markdown.length,
        status: built.auditResult && built.auditResult.ok ? 'success' : 'failed',
        send,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
      appendJsonl(TASK, job.batchId, row);
      if (row.status === 'success') summary.success++;
      else summary.failed++;
      summary.results.push({ name: recipient.name, status: row.status, auditOk: built.auditResult && built.auditResult.ok });
      logger.info(`[MonthlyHealthcheck] ${recipient.name} 完成 (${sequence}/${recipients.length})`);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      const isNoRows = /为空|暂无|目标名单为空|无有效/.test(message);
      const row = {
        type: 'recipient',
        batchId: job.batchId,
        mode,
        periodMonth: ctx.label,
        sequence,
        recipientName: recipient.name,
        openIdMasked: maskId(recipient.openId),
        status: isNoRows ? 'skipped_no_rows' : 'failed',
        error: message,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
      appendJsonl(TASK, job.batchId, row);
      if (isNoRows) summary.skippedNoRows++;
      else summary.failed++;
      summary.results.push({ name: recipient.name, status: row.status, error: message });
      if (opts.stopOnFailure !== false && !isNoRows) throw new Error(`月度经营体检在 ${recipient.name} 处停止: ${message}`);
    }
    if (i < selected.length - 1 && delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  summary.finishedAt = new Date().toISOString();
  appendJsonl(TASK, job.batchId, { type: 'summary', ...summary });
  return summary;
}

function startMonthlyHealthcheck(opts = {}) {
  if (runningJobId) {
    const running = jobs.get(runningJobId);
    if (running && running.status === 'running') {
      throw new Error(`已有月度经营体检任务运行中: ${runningJobId}`);
    }
  }
  const jobId = `monthly-healthcheck-${Date.now()}`;
  const batchId = opts.batchId || `monthly-healthcheck-${isoWeekKey(new Date())}-${Date.now()}`;
  const job = {
    jobId,
    batchId,
    status: 'running',
    createdAt: new Date().toISOString(),
    summary: null,
    error: null,
  };
  jobs.set(jobId, job);
  runningJobId = jobId;
  runJob(job, opts)
    .then(summary => {
      job.summary = summary;
      job.status = summary.status === 'skipped'
        ? 'skipped'
        : (summary.failed > 0 ? 'completed_with_failures' : 'completed');
      job.finishedAt = new Date().toISOString();
    })
    .catch(error => {
      job.status = 'failed';
      job.error = error && error.message ? error.message : String(error);
      job.finishedAt = new Date().toISOString();
      appendJsonl(TASK, job.batchId, { type: 'fatal', jobId, batchId, error: job.error, finishedAt: job.finishedAt });
      logger.error(`[MonthlyHealthcheck] 任务失败: ${job.error}`);
    })
    .finally(() => {
      if (runningJobId === jobId) runningJobId = null;
    });
  return job;
}

function getJob(jobId) {
  if (!jobId) return null;
  return jobs.get(jobId) || null;
}

module.exports = {
  startMonthlyHealthcheck,
  getJob,
  _private: {
    shouldRunToday,
    runJob,
  },
};
