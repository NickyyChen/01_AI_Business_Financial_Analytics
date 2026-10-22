/**
 * 非流式兼容入口：统一转到 pipeline，并保持旧 HTTP/授权链路返回结构。
 */

const pipeline = require('./pipeline');
const memoryManager = require('../services/memory-manager');
const logger = require('../utils/logger');
const { extractMemoryUpdate } = require('../utils/memory-update-parser');

async function _persistLegacySummary(userId, memoryUpdate) {
  if (!userId || !memoryUpdate || !memoryUpdate.summary) return;
  await memoryManager.writeWorkSummary(userId, memoryUpdate.summary);
}

async function handleRequest(payload) {
  const result = await pipeline.handleRequest(payload);
  const memoryUpdate = extractMemoryUpdate(result.reply || '');

  _persistLegacySummary(payload.user_id, memoryUpdate).catch((error) => {
    logger.warn(`[RequestAdapter] 工作总结写入失败: ${error.message}`);
  });

  const response = {
    reply: result.reply,
    usage: result.usage || null,
    memory_update: memoryUpdate,
  };

  if (result.error) {
    response.error = result.error;
  }

  return response;
}

module.exports = { handleRequest };
