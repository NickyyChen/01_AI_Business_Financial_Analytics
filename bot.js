/**
 * bot.js - 统一入口（WebSocket 长连接 + HTTP 服务）
 *
 * 合并了原 server.js 的 HTTP 路由能力：
 *   - WebSocket: 飞书 SDK 长连接，接收消息/卡片交互
 *   - HTTP: OAuth 回调、健康检查、通用对话 API
 *   - 定时任务: 不自动注册业务定时任务
 *
 * 启动: node bot.js
 * 端口: 3000 (PORT 环境变量可覆盖)
 */

const http = require('http');
const crypto = require('crypto');
const lark = require('@larksuiteoapi/node-sdk');
const logger = require('./src/utils/logger');
const config = require('./config');
const pipeline = require('./src/agent/pipeline');
const requestAdapter = require('./src/agent/request-adapter');
const { createHttpHandler } = require('./src/app/http/router');
const { createFeishuMessageHandler } = require('./src/app/feishu/message-handler');
const qaLogger = require('./src/utils/qa-logger');
const client = require('./src/clients/feishu-client');
const tokenStore = require('./src/stores/user-token-store');
const calendarService = require('./src/services/calendar-service');
const minutesService = require('./src/services/minutes-service');
const workReportService = require('./src/services/work-report-service');
const conversationStore = require('./src/stores/conversation-store');
const lf = require('./src/utils/langfuse-client');
const groupChatCollector = require('./src/services/group-chat-buffer');
const localCacheSyncer = require('./src/cache/local-cache-syncer');
const scheduledPushScheduler = require('./src/services/scheduled-push/scheduler');

const PORT = process.env.PORT || 3000;

// Bot 自身的 open_id，启动时通过 API 获取，用于群聊 @mention 检测
let _botOpenId = null;

// ==================== SDK 客户端 ====================

const sdkClient = new lark.Client({
  appId: config.APP_ID,
  appSecret: config.APP_SECRET,
});

// ==================== 日志辅助 ====================

const MAX_REPLY_LOG_INFO = 500;
function logReplyContent(tag, text) {
  if (!text) return;
  // info 级别记录摘要，debug 级别记录完整回复
  const preview = text.length > MAX_REPLY_LOG_INFO
    ? text.slice(0, MAX_REPLY_LOG_INFO) + `...(共${text.length}字,已截断)`
    : text;
  logger.info(`[${tag}] 回复内容:\n${preview}`);
  if (text.length > MAX_REPLY_LOG_INFO) {
    logger.debug(`[${tag}] 完整回复(${text.length}字):\n${text}`);
  }
}

// ==================== 事件处理 ====================

const eventDispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    await feishuMessageHandler.handleMessage(data);
  },
  // 卡片交互事件也会路由到 EventDispatcher，需要在这里处理
  'card.action.trigger': async (data) => {
    return await handleCardAction(data);
  },
});

// ==================== 卡片交互回调 ====================

/** 卡片交互统一处理函数 */
async function handleCardAction(data) {
  try {
    const action = data.action || {};
    const actionValue = action.value || {};
    const operator = data.operator || {};
    const openId = operator.open_id || data.open_id || '';

    logger.info(`[CardAction] 收到卡片回调: action=${JSON.stringify(actionValue)} openId=${openId}`);

    // 目前卡片只有「前往授权」按钮（multi_url 类型，不触发回调）
    // 如果未来需要其他卡片交互，在此扩展

    return { toast: { type: 'info', content: '请点击按钮完成操作' } };
  } catch (e) {
    logger.error(`[CardAction] 处理失败: ${e.message}`);
    return { toast: { type: 'error', content: '处理失败，请重试' } };
  }
}

const cardActionHandler = new lark.CardActionHandler(
  {},
  async (data) => handleCardAction(data)
);

const feishuMessageHandler = createFeishuMessageHandler({
  sdkClient,
  config,
  logger,
  pipeline,
  requestAdapter,
  qaLogger,
  client,
  tokenStore,
  calendarService,
  minutesService,
  workReportService,
  conversationStore,
  groupChatCollector,
  logReplyContent,
  getBotOpenId: () => _botOpenId,
});

// ==================== HTTP 服务（原 server.js 逻辑）====================

const { handleHttpRequest } = createHttpHandler({
  port: PORT,
  config,
  logger,
  tokenStore,
  conversationStore,
  requestAdapter,
  pipeline,
  logReplyContent,
  pendingAuthRequests: feishuMessageHandler.pendingAuthRequests,
  queryAndSendResult: feishuMessageHandler.queryAndSendResult,
});

// ==================== 启动 ====================

async function main() {
  logger.info('='.repeat(60));
  logger.info('OrgAgent 统一入口 (WebSocket + HTTP)');
  logger.info('='.repeat(60));

  // 预热 tenant_token
  try {
    await client.getTenantToken();
    logger.info('[启动] tenant_token: 就绪');
  } catch (e) {
    logger.warn(`[启动] tenant_token 预热失败: ${e.message}`);
  }

  // 本地全量内存缓存：先完成 P0/P1 财务与权限表镜像，再开放 HTTP / WebSocket。
  if (config.LOCAL_MEMORY_CACHE_ENABLED && config.LOCAL_MEMORY_CACHE_BOOTSTRAP_BLOCKING) {
    logger.info('[启动] 本地全量内存缓存: 开始阻塞初始化');
    const cacheStatus = await localCacheSyncer.bootstrap({ reason: 'startup' });
    logger.info(`[启动] 本地全量内存缓存: 就绪 tables=${cacheStatus.tableCount || 0} rows=${cacheStatus.rows || 0} cutoff=${cacheStatus.cutoffText || ''}`);
  }

  // 获取 bot 自身 open_id（用于群聊 @mention 检测）
  try {
    const botInfo = await client.get('/open-apis/bot/v3/info');
    if (botInfo.code === 0 && botInfo.bot) {
      _botOpenId = botInfo.bot.open_id || '';
      logger.info(`[启动] Bot open_id: ${_botOpenId}`);
    }
  } catch (e) {
    logger.warn(`[启动] 获取 bot info 失败: ${e.message}（群聊 @mention 检测将使用降级逻辑）`);
  }

  // 1. 启动 HTTP 服务
  const httpServer = http.createServer(handleHttpRequest);
  httpServer.listen(PORT, '0.0.0.0', () => {
    logger.info(`[启动] HTTP 服务: http://localhost:${PORT}`);
    logger.info(`  POST /api/webhook  — 飞书 Webhook 兼容`);
    logger.info(`  GET  /             — OAuth 回调`);
    logger.info(`  POST /api/chat     — 通用对话 API`);
    logger.info(`  POST /api/admin/healthcheck-batch/group-review — 经营体检群验收批量任务`);
    logger.info(`  GET  /api/health   — 健康检查`);
  });

  // 2. 启动 WebSocket 长连接
  const wsClient = new lark.WSClient({
    appId: config.APP_ID,
    appSecret: config.APP_SECRET,
    loggerLevel: lark.LoggerLevel.info,
  });
  await wsClient.start({ eventDispatcher, cardActionHandler });
  logger.info('[启动] WebSocket 长连接: 已建立');
  logger.info(`[启动] OAuth 回调地址: ${config.REDIRECT_URI}`);

  // 启动后每小时后台重建 nextCache，成功后原子替换 activeCache；失败时保留旧镜像。
  localCacheSyncer.startAutoRefresh();

  // 3. 业务定时推送：长连接入口启动时直接注册月度/周度定时任务。
  scheduledPushScheduler.startScheduledPushScheduler();
  logger.info('[Startup] Multi-turn conversation enabled (30 min timeout)');
  logger.info('='.repeat(60));
}

// ==================== 进程退出钩子：Langfuse flush ====================
// SIGINT/SIGTERM 时给 Langfuse 最多 3 秒 flush 最后一批 event
let _shuttingDown = false;
async function gracefulShutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  logger.info(`[Shutdown] 收到 ${signal}，flush Langfuse ...`);
  try {
    await Promise.race([
      lf.shutdown(),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
  } catch (e) {
    logger.warn(`[Shutdown] flush 异常: ${e.message}`);
  }
  process.exit(0);
}
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

main().catch(e => {
  logger.error('启动失败:', e.message);
  process.exit(1);
});
