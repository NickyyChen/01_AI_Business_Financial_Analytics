const crypto = require('crypto');
const localMemoryStore = require('../../cache/local-memory-store');
const healthcheckBatchRunner = require('../../services/healthcheck-batch-runner');
const monthlyHealthcheckRunner = require('../../services/monthly-healthcheck-runner');
const weeklyReceivablesRunner = require('../../services/weekly-receivables-runner');
const qaTraceWeeklyRunner = require('../../services/qa-trace-weekly-runner');
const { buildPlanningContext } = require('../../agent/planning-context-builder');
const { extractMemoryUpdate } = require('../../utils/memory-update-parser');

function createHttpHandler({
  port,
  config,
  logger,
  tokenStore,
  conversationStore,
  requestAdapter,
  pipeline,
  logReplyContent,
  pendingAuthRequests,
  queryAndSendResult,
}) {
  const webhookProcessedEvents = new Map();
  const WEBHOOK_EVENT_TTL = 300000;

  function parseBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch (_err) {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  function sendJSON(res, statusCode, data) {
    const body = JSON.stringify(data);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end(body);
  }

  function isLocalRequest(req) {
    const addr = req.socket && req.socket.remoteAddress;
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  }

  function isAdminAuthorized(req) {
    const configuredTokens = [
      config.SCHEDULED_PUSH_ADMIN_TOKEN,
      process.env.SCHEDULED_PUSH_ADMIN_TOKEN,
      config.HEALTHCHECK_BATCH_ADMIN_TOKEN,
      process.env.HEALTHCHECK_BATCH_ADMIN_TOKEN,
    ].filter(Boolean);
    if (configuredTokens.length === 0) return isLocalRequest(req);
    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
    const headerToken = req.headers['x-admin-token'] || '';
    return configuredTokens.includes(bearer) || configuredTokens.includes(headerToken);
  }

  function decryptFeishuPayload(encryptedStr) {
    if (!config.ENCRYPT_KEY) return null;
    const key = crypto.createHash('sha256').update(config.ENCRYPT_KEY).digest();
    const encBuf = Buffer.from(encryptedStr, 'base64');
    const iv = encBuf.slice(0, 16);
    const data = encBuf.slice(16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(data, undefined, 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  }

  function cleanWebhookCache() {
    const now = Date.now();
    for (const [eventId, timestamp] of webhookProcessedEvents) {
      if (now - timestamp > WEBHOOK_EVENT_TTL) {
        webhookProcessedEvents.delete(eventId);
      }
    }
  }

  function renderOAuthSuccessPage(result, intentLabel) {
    const appId = config.APP_ID;
    const feishuDeepLink = `https://applink.feishu.cn/client/bot_chat?app_id=${appId}`;
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>授权成功</title>
<style>body{display:flex;justify-content:center;align-items:center;height:100vh;margin:0;font-family:sans-serif;background:#f0f4f8;}
.card{background:#fff;border-radius:16px;padding:48px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.08);max-width:400px;}
.icon{font-size:56px;margin-bottom:16px;} h2{color:#2b7a0b;} p{color:#666;font-size:15px;}
.btn{display:inline-block;margin-top:20px;padding:12px 32px;background:#3370ff;color:#fff;border-radius:8px;text-decoration:none;}
</style></head><body><div class="card"><div class="icon">✅</div><h2>授权成功</h2>
<p><b>${result.name || '用户'}</b> 的${intentLabel}权限已获取</p>
<a class="btn" href="${feishuDeepLink}">返回飞书对话</a></div>
<script>setTimeout(()=>location.href="${feishuDeepLink}",3000)</script></body></html>`;
  }

  function renderOAuthFailurePage(error) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>授权失败</title></head>
<body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif">
<div style="text-align:center"><h2 style="color:#d83b01">❌ 授权失败</h2><p>${error || '未知错误'}</p></div></body></html>`;
  }

  async function handleWebhookRoute(req, res) {
    let body;
    try {
      body = await parseBody(req);
    } catch (_err) {
      sendJSON(res, 400, { error: 'Invalid request body' });
      return;
    }

    if (body.encrypt && config.ENCRYPT_KEY) {
      try {
        body = decryptFeishuPayload(body.encrypt);
      } catch (_err) {
        sendJSON(res, 400, { error: 'Decrypt failed' });
        return;
      }
    }

    if (body.type === 'url_verification') {
      sendJSON(res, 200, { challenge: body.challenge });
      return;
    }

    if (body.schema === '2.0' && body.header) {
      const eventId = body.header.event_id;
      if (config.VERIFICATION_TOKEN && body.header.token !== config.VERIFICATION_TOKEN) {
        sendJSON(res, 403, { error: 'Invalid token' });
        return;
      }
      if (webhookProcessedEvents.has(eventId)) {
        sendJSON(res, 200, { ok: true });
        return;
      }
      webhookProcessedEvents.set(eventId, Date.now());
      cleanWebhookCache();
      sendJSON(res, 200, { ok: true });
      return;
    }

    sendJSON(res, 200, { ok: true });
  }

  async function handleOAuthCallback(url, res) {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state') || '';
    if (!code) {
      sendJSON(res, 400, { error: '缺少授权码 code' });
      return;
    }

    let stateOpenId = null;
    let intentType = 'general';
    const stateMatch = state.match(/^auth_(ou_[a-f0-9]+)_([a-z]+)_/);
    if (stateMatch) {
      stateOpenId = stateMatch[1];
      intentType = stateMatch[2] || 'general';
    } else {
      const oldMatch = state.match(/^auth_(ou_[a-f0-9]+)_/);
      if (oldMatch) stateOpenId = oldMatch[1];
    }

    try {
      const result = await tokenStore.exchangeCodeForToken(code, stateOpenId);
      const intentLabel = intentType === 'calendar'
        ? '日历'
        : intentType === 'minutes'
          ? '妙记'
          : '数据';

      if (result.success) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderOAuthSuccessPage(result, intentLabel));

        if (result.openId && pendingAuthRequests.has(result.openId)) {
          queryAndSendResult(result.openId, intentType, intentLabel).catch((error) => {
            logger.error(`[OAuth] 授权后自动查询失败: ${error.message}`);
          });
        }
      } else {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderOAuthFailurePage(result.error));
      }
    } catch (error) {
      sendJSON(res, 500, { error: error.message });
    }
  }

  async function handleHttpRequest(req, res) {
    const url = new URL(req.url, `http://localhost:${port}`);
    const path = url.pathname;
    const method = req.method;

    if (method === 'OPTIONS') {
      sendJSON(res, 200, { ok: true });
      return;
    }

    if (path === '/' && method === 'GET' && url.searchParams.has('code')) {
      await handleOAuthCallback(url, res);
      return;
    }

    if (path === '/' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body><h1>OrgAgent</h1><p>Running (unified)</p></body></html>');
      return;
    }

    if (path === '/api/health' && method === 'GET') {
      sendJSON(res, 200, {
        status: 'ok',
        time: new Date().toISOString(),
        version: '2.0.0',
        localMemoryCache: localMemoryStore.getStatus(),
        conversations: conversationStore.getStats(),
      });
      return;
    }

    if (path === '/api/admin/healthcheck-batch/group-review' && method === 'POST') {
      if (!isAdminAuthorized(req)) {
        sendJSON(res, 403, { error: 'Forbidden' });
        return;
      }
      try {
        const body = await parseBody(req);
        const job = healthcheckBatchRunner.startGroupReview({
          batchId: body.batchId,
          limit: body.limit,
          offset: body.offset,
          delayMs: body.delayMs,
          stopOnFailure: body.stopOnFailure,
        });
        sendJSON(res, 202, {
          ok: true,
          message: '经营体检群验收任务已在当前财务 Agent 进程内启动',
          jobId: job.jobId,
          batchId: job.batchId,
          statusUrl: `/api/admin/healthcheck-batch/status?id=${encodeURIComponent(job.jobId)}`,
        });
      } catch (error) {
        sendJSON(res, 500, { error: error.message });
      }
      return;
    }

    if (path === '/api/admin/healthcheck-batch/status' && method === 'GET') {
      if (!isAdminAuthorized(req)) {
        sendJSON(res, 403, { error: 'Forbidden' });
        return;
      }
      const job = healthcheckBatchRunner.getJob(url.searchParams.get('id'));
      if (!job) {
        sendJSON(res, 404, { error: 'job not found' });
        return;
      }
      sendJSON(res, 200, { ok: true, job });
      return;
    }

    if (path === '/api/admin/scheduled-push/monthly-healthcheck/run' && method === 'POST') {
      if (!isAdminAuthorized(req)) {
        sendJSON(res, 403, { error: 'Forbidden' });
        return;
      }
      if (!config.SCHEDULED_PUSH_ENABLED) {
        sendJSON(res, 409, { error: 'SCHEDULED_PUSH_ENABLED=false' });
        return;
      }
      try {
        const body = await parseBody(req);
        const job = monthlyHealthcheckRunner.startMonthlyHealthcheck({
          batchId: body.batchId,
          mode: body.mode,
          periodMonth: body.periodMonth,
          limit: body.limit,
          offset: body.offset,
          delayMs: body.delayMs,
          stopOnFailure: body.stopOnFailure,
          confirmProd: body.confirmProd,
          force: body.force,
        });
        sendJSON(res, 202, {
          ok: true,
          message: '月度经营体检任务已在当前财务 Agent 进程内启动',
          jobId: job.jobId,
          batchId: job.batchId,
          statusUrl: `/api/admin/scheduled-push/status?id=${encodeURIComponent(job.jobId)}`,
        });
      } catch (error) {
        sendJSON(res, 500, { error: error.message });
      }
      return;
    }

    if (path === '/api/admin/scheduled-push/weekly-receivables/run' && method === 'POST') {
      if (!isAdminAuthorized(req)) {
        sendJSON(res, 403, { error: 'Forbidden' });
        return;
      }
      if (!config.SCHEDULED_PUSH_ENABLED) {
        sendJSON(res, 409, { error: 'SCHEDULED_PUSH_ENABLED=false' });
        return;
      }
      try {
        const body = await parseBody(req);
        const job = weeklyReceivablesRunner.startWeeklyReceivables({
          batchId: body.batchId,
          mode: body.mode,
          periodMonth: body.periodMonth,
          limit: body.limit,
          offset: body.offset,
          delayMs: body.delayMs,
          stopOnFailure: body.stopOnFailure,
          confirmProd: body.confirmProd,
          force: body.force,
        });
        sendJSON(res, 202, {
          ok: true,
          message: '周度回款情况任务已在当前财务 Agent 进程内启动',
          jobId: job.jobId,
          batchId: job.batchId,
          statusUrl: `/api/admin/scheduled-push/status?id=${encodeURIComponent(job.jobId)}`,
        });
      } catch (error) {
        sendJSON(res, 500, { error: error.message });
      }
      return;
    }

    if (path === '/api/admin/scheduled-push/qa-trace-weekly/run' && method === 'POST') {
      if (!isAdminAuthorized(req)) {
        sendJSON(res, 403, { error: 'Forbidden' });
        return;
      }
      if (!config.SCHEDULED_PUSH_ENABLED) {
        sendJSON(res, 409, { error: 'SCHEDULED_PUSH_ENABLED=false' });
        return;
      }
      try {
        const body = await parseBody(req);
        const job = qaTraceWeeklyRunner.startQaTraceWeeklyReport({
          batchId: body.batchId,
          mode: body.mode,
          limit: body.limit,
          offset: body.offset,
          detailLimit: body.detailLimit,
          stopOnFailure: body.stopOnFailure,
          confirmProd: body.confirmProd,
          force: body.force,
        });
        sendJSON(res, 202, {
          ok: true,
          message: 'QA Trace 周报任务已在当前财务 Agent 进程内启动',
          jobId: job.jobId,
          batchId: job.batchId,
          statusUrl: `/api/admin/scheduled-push/status?id=${encodeURIComponent(job.jobId)}`,
        });
      } catch (error) {
        sendJSON(res, 500, { error: error.message });
      }
      return;
    }

    if (path === '/api/admin/scheduled-push/status' && method === 'GET') {
      if (!isAdminAuthorized(req)) {
        sendJSON(res, 403, { error: 'Forbidden' });
        return;
      }
      const id = url.searchParams.get('id');
      const job = monthlyHealthcheckRunner.getJob(id) || weeklyReceivablesRunner.getJob(id) || qaTraceWeeklyRunner.getJob(id);
      if (!job) {
        sendJSON(res, 404, { error: 'job not found' });
        return;
      }
      sendJSON(res, 200, { ok: true, job });
      return;
    }

    if (path === '/api/webhook' && method === 'POST') {
      await handleWebhookRoute(req, res);
      return;
    }

    if (path === '/api/oauth/callback' && method === 'GET') {
      await handleOAuthCallback(url, res);
      return;
    }

    if (path === '/api/chat' && method === 'POST') {
      try {
        const body = await parseBody(req);
        if (!body.user_id || !body.message) {
          sendJSON(res, 400, { error: '缺少必填字段: user_id, message' });
          return;
        }

        const result = await requestAdapter.handleRequest({
          user_id: body.user_id,
          userName: body.userName || body.user_name || body.user_id,
          message: body.message,
          role: body.role || '员工',
          context: body.context || {},
          conversationHistory: Array.isArray(body.conversationHistory) ? body.conversationHistory : [],
          plannerConversationHistory: Array.isArray(body.plannerConversationHistory)
            ? body.plannerConversationHistory
            : (Array.isArray(body.conversationHistory) ? body.conversationHistory : []),
          planningContext: Array.isArray(body.planningContext) ? body.planningContext : [],
        });
        logReplyContent('API:chat', result.reply);
        sendJSON(res, 200, result);
      } catch (error) {
        sendJSON(res, 500, { error: error.message });
      }
      return;
    }

    if (path === '/api/debug/long-connection-chat' && method === 'POST') {
      if (!isAdminAuthorized(req)) {
        sendJSON(res, 403, { error: 'Forbidden' });
        return;
      }
      if (!pipeline || typeof pipeline.handleRequestStream !== 'function') {
        sendJSON(res, 500, { error: 'pipeline.handleRequestStream not available' });
        return;
      }

      try {
        const body = await parseBody(req);
        if (!body.user_id || !body.message) {
          sendJSON(res, 400, { error: '缺少必填字段: user_id, message' });
          return;
        }

        const sessionId = body.session_id || body.open_id || body.user_id;
        const userName = body.userName || body.user_name || body.user_id;
        const role = body.role || '员工';
        if (body.reset) {
          conversationStore.clearHistory(sessionId);
        }
        conversationStore.addUserMessage(sessionId, body.message);
        conversationStore.setUserName(sessionId, userName);

        let chunkCount = 0;
        const result = await pipeline.handleRequestStream(
          {
            user_id: body.user_id,
            userName,
            message: body.message,
            role,
            context: body.context || {},
            conversationHistory: conversationStore.getHistory(sessionId),
            plannerConversationHistory: typeof conversationStore.getFullHistory === 'function'
              ? conversationStore.getFullHistory(sessionId)
              : conversationStore.getHistory(sessionId),
            planningContext: typeof conversationStore.getPlanningContext === 'function'
              ? conversationStore.getPlanningContext(sessionId)
              : [],
            pendingClarification: typeof conversationStore.getPendingClarification === 'function'
              ? conversationStore.getPendingClarification(sessionId)
              : null,
            imageDataUrl: body.imageDataUrl || null,
          },
          () => { chunkCount += 1; },
        );

        const planningContext = buildPlanningContext({
          message: body.message,
          planResult: result && result._planResult,
          toolResults: result && result.toolResults,
          reply: result && result.reply,
          userName,
          role,
        });
        conversationStore.addAssistantMessage(
          sessionId,
          result.reply || '',
          planningContext ? { planningContext } : {},
        );
        if (result && result._pendingClarification && typeof conversationStore.setPendingClarification === 'function') {
          conversationStore.setPendingClarification(sessionId, result._pendingClarification);
        } else if (typeof conversationStore.clearPendingClarification === 'function') {
          conversationStore.clearPendingClarification(sessionId);
        }

        const response = {
          reply: result.reply,
          usage: result.usage || null,
          memory_update: extractMemoryUpdate(result.reply || ''),
          _planResult: result._planResult || null,
          _memoryTrace: result._memoryTrace || null,
          toolResults: result.toolResults || null,
          _debug: {
            mode: 'long-connection-sim',
            sessionId,
            historyLength: conversationStore.getHistory(sessionId).length,
            planningContextLength: typeof conversationStore.getPlanningContext === 'function'
              ? conversationStore.getPlanningContext(sessionId).length
              : 0,
            pendingClarification: typeof conversationStore.getPendingClarification === 'function'
              ? conversationStore.getPendingClarification(sessionId)
              : null,
            chunkCount,
          },
        };
        if (result.error) response.error = result.error;
        logReplyContent('API:debug-long-connection-chat', result.reply);
        sendJSON(res, 200, response);
      } catch (error) {
        sendJSON(res, 500, { error: error.message });
      }
      return;
    }

    sendJSON(res, 404, { error: `未知路由: ${method} ${path}` });
  }

  return {
    handleHttpRequest,
  };
}

module.exports = {
  createHttpHandler,
};
