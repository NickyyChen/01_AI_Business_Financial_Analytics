'use strict';

const config = require('../../config');
const localMemoryStore = require('../cache/local-memory-store');

function getFreshnessText() {
  if (!config.LOCAL_MEMORY_CACHE_ENABLED) return '';
  const status = localMemoryStore.getStatus();
  if (!status.ready || !status.cutoffText) return '';
  return `本次使用的 P0/P1 本地缓存数据截止到：${status.cutoffText}（Asia/Shanghai）。`;
}

function getAnswerInstruction() {
  const text = getFreshnessText();
  if (!text) return '';
  return [
    '===== 数据新鲜度（必须在回答开头声明）=====',
    text,
    '回答开头第一段必须合并展示“数据截止到 YYYY-MM-DD HH:mm（Asia/Shanghai）”。',
  ].join('\n');
}

function ensureAnswerPrefix(reply) {
  const status = localMemoryStore.getStatus();
  if (!config.LOCAL_MEMORY_CACHE_ENABLED || !status.ready || !status.cutoffText) {
    return reply;
  }
  const body = String(reply || '');
  if (body.includes(status.cutoffText) || /数据截止到|数据截止/.test(body.slice(0, 160))) {
    return reply;
  }
  return `📅 数据截止：${status.cutoffText}（Asia/Shanghai）\n\n${body}`;
}

module.exports = {
  getFreshnessText,
  getAnswerInstruction,
  ensureAnswerPrefix,
};
