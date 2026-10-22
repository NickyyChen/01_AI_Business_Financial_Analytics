/**
 * conversation-store.js - 多轮对话上下文管理
 *
 * 按 openId 维度缓存近期对话历史，传递给 LLM 实现连续对话
 * 内存存储，进程重启后清空（对话历史不需要持久化）
 *
 * 低频落库：session 结束时（clearHistory / 30分钟超时），
 * 将用户消息摘要异步写入 Bitable CHAT_SNAPSHOT，
 * 供 employee-insight-analyzer 读取分析素材。
 */

const config = require('../../config');
const client = require('../clients/feishu-client');
const logger = require('../utils/logger');

// openId → { messages: [{role, content, contentFull, timestamp, meta}], lastActive, userName, pendingClarification }
const _conversations = new Map();

// 配置
const MAX_HISTORY = 3;          // 每用户最多保留的历史轮次（一问一答算2条）
const EXPIRE_MS = 30 * 60000;   // 30分钟无活动则清除上下文
const MAX_USERS = 500;          // 最多缓存用户数

/**
 * 获取用户的对话历史
 * @param {string} openId
 * @returns {Array} [{role: 'user'|'assistant', content: string}]
 */
function getHistory(openId) {
  const conv = _conversations.get(openId);
  if (!conv) return [];

  // 检查是否过期
  if (Date.now() - conv.lastActive > EXPIRE_MS) {
    _conversations.delete(openId);
    return [];
  }

  return conv.messages.map(m => ({
    role: m.role,
    content: m.content,
  }));
}

/**
 * 获取 Planner 专用的完整近 3 轮历史。
 *
 * 普通 Answer 仍使用 getHistory() 的截断版，避免把旧回复里的大量数字再次喂给 Answer。
 * Planner 则需要看到完整追问上下文，尤其是上一轮澄清问题和用户短回复。
 *
 * @param {string} openId
 * @returns {Array} [{role: 'user'|'assistant', content: string}]
 */
function getFullHistory(openId) {
  const conv = _conversations.get(openId);
  if (!conv) return [];

  if (Date.now() - conv.lastActive > EXPIRE_MS) {
    _conversations.delete(openId);
    return [];
  }

  return conv.messages.map(m => ({
    role: m.role,
    content: m.contentFull || m.content,
  }));
}

/**
 * 添加用户消息到历史
 * @param {string} openId
 * @param {string} content - 用户消息
 */
function addUserMessage(openId, content, meta = {}) {
  ensureConversation(openId);
  const conv = _conversations.get(openId);
  conv.messages.push({ role: 'user', content, contentFull: content, timestamp: Date.now(), meta: meta || {} });
  conv.lastActive = Date.now();
  trimHistory(conv);
}

/**
 * 添加助手回复到历史
 * @param {string} openId
 * @param {string} content - 助手回复
 */
function addAssistantMessage(openId, content, meta = {}) {
  ensureConversation(openId);
  const conv = _conversations.get(openId);
  // 截断过长的回复（避免占用过多上下文）
  const trimmed = content.length > 1500 ? content.slice(0, 1500) + '...(已截断)' : content;
  conv.messages.push({ role: 'assistant', content: trimmed, contentFull: content, timestamp: Date.now(), meta: meta || {} });
  conv.lastActive = Date.now();
  trimHistory(conv);
}

/**
 * 获取最近的轻量 Plan 记忆上下文。
 * 只返回助手消息 meta.planningContext，不把完整回复塞进 Planner。
 *
 * @param {string} openId
 * @returns {Array<object>}
 */
function getPlanningContext(openId) {
  const conv = _conversations.get(openId);
  if (!conv) return [];
  if (Date.now() - conv.lastActive > EXPIRE_MS) {
    _conversations.delete(openId);
    return [];
  }
  return conv.messages
    .filter(m => m.role === 'assistant' && m.meta && m.meta.planningContext)
    .map(m => m.meta.planningContext)
    .slice(-3);
}

function setPendingClarification(openId, state) {
  if (!openId || !state) return;
  ensureConversation(openId);
  const conv = _conversations.get(openId);
  conv.pendingClarification = state;
  conv.lastActive = Date.now();
}

function getPendingClarification(openId) {
  const conv = _conversations.get(openId);
  if (!conv) return null;
  if (Date.now() - conv.lastActive > EXPIRE_MS) {
    _conversations.delete(openId);
    return null;
  }
  const pending = conv.pendingClarification || null;
  if (pending && pending.expiresAt && Number(pending.expiresAt) < Date.now()) {
    delete conv.pendingClarification;
    return null;
  }
  return pending;
}

function clearPendingClarification(openId) {
  const conv = _conversations.get(openId);
  if (conv && conv.pendingClarification) {
    delete conv.pendingClarification;
    conv.lastActive = Date.now();
  }
}

/**
 * 记录该 openId 对应的员工姓名（由 bot.js 在 resolveUser 后设置）
 * 用于 flush 时写入 CHAT_SNAPSHOT 的员工ID/姓名字段
 * @param {string} openId
 * @param {string} name
 */
function setUserName(openId, name) {
  const conv = _conversations.get(openId);
  if (conv && name) conv.userName = name;
}

/**
 * 清除用户对话历史（清除前异步落库）
 * @param {string} openId
 */
function clearHistory(openId) {
  _flushToBitable(openId).catch(() => {}); // 异步，不阻塞
  _conversations.delete(openId);
}

/**
 * 获取格式化的历史文本（供 prompt 使用）
 * @param {string} openId
 * @returns {string}
 */
function formatHistoryForPrompt(openId) {
  const history = getHistory(openId);
  if (history.length === 0) return '';

  const lines = ['===== 对话历史 ====='];
  for (const msg of history) {
    const label = msg.role === 'user' ? '用户' : '助手';
    lines.push(`[${label}] ${msg.content}`);
  }
  return lines.join('\n');
}

/**
 * 将对话历史转为 LLM input 格式
 * @param {string} openId
 * @returns {Array} [{role, content: [{type, text}]}]
 */
function toInputMessages(openId) {
  const history = getHistory(openId);
  return history.map(msg => ({
    role: msg.role,
    content: [{ type: msg.role === 'user' ? 'input_text' : 'output_text', text: msg.content }],
  }));
}

// ==================== 内部方法 ====================

function ensureConversation(openId) {
  if (!_conversations.has(openId)) {
    // 清理过期会话 + 容量控制
    if (_conversations.size >= MAX_USERS) {
      cleanExpired();
    }
    _conversations.set(openId, { messages: [], lastActive: Date.now() });
  }
}

function trimHistory(conv) {
  // 保留最近 MAX_HISTORY * 2 条消息（一问一答）
  const maxMessages = MAX_HISTORY * 2;
  if (conv.messages.length > maxMessages) {
    conv.messages = conv.messages.slice(-maxMessages);
  }
}

function cleanExpired() {
  const now = Date.now();
  for (const [id, conv] of _conversations) {
    if (now - conv.lastActive > EXPIRE_MS) {
      _flushToBitable(id).catch(() => {}); // 超时前落库
      _conversations.delete(id);
    }
  }
  // 如果还超容量，删最旧的
  if (_conversations.size >= MAX_USERS) {
    const sorted = [..._conversations.entries()].sort((a, b) => a[1].lastActive - b[1].lastActive);
    const toRemove = sorted.slice(0, Math.floor(MAX_USERS * 0.3));
    for (const [id] of toRemove) {
      _flushToBitable(id).catch(() => {});
      _conversations.delete(id);
    }
  }
}

// ==================== 落库（内部方法）====================

const MIN_TURNS_TO_FLUSH = 2; // 少于 2 轮不落库（内容无意义）

/**
 * 将本次 session 的用户消息摘要写入 CHAT_SNAPSHOT
 * 异步、低频：只在 session 结束时触发，不写每条消息
 */
async function _flushToBitable(openId) {
  const conv = _conversations.get(openId);
  if (!conv) return;

  const userMessages = conv.messages.filter(m => m.role === 'user');
  if (userMessages.length < MIN_TURNS_TO_FLUSH) return; // 对话太短，跳过

  const name = conv.userName || openId;
  const startTime = conv.messages[0].timestamp;
  const endTime   = conv.messages[conv.messages.length - 1].timestamp;
  const dateStr   = new Date(startTime).toLocaleDateString('zh-CN');
  const turns     = userMessages.length;

  // 拼接用户消息作为摘要（不含助手回复，只保留用户意图）
  const msgLines = userMessages.map(m => m.content.slice(0, 120)).join('\n');
  const summary  = `[${dateStr} ${turns}轮对话]\n${msgLines}`.slice(0, 800);

  const fields = {
    '员工ID':   name,
    '姓名':     name,
    '群名称':   '经营助手对话记录',
    '群ID':     '',
    '摘要周期': '单次会话',
    '摘要内容': summary,
    '关键信息': msgLines.slice(0, 2000),
    '提及项目': '',
    '消息数量': turns,
    '数据来源': 'Agent收集',
    '采集时间': endTime,
  };

  try {
    await client.createRecord(config.TABLES.CHAT_SNAPSHOT, fields);
    logger.info(`[ConvStore] 对话落库: ${name} ${turns}轮`);
  } catch (e) {
    logger.warn(`[ConvStore] 落库失败 (${name}): ${e.message}`);
  }
}

/**
 * 获取统计信息
 */
function getStats() {
  return {
    activeUsers: _conversations.size,
    totalMessages: [..._conversations.values()].reduce((sum, c) => sum + c.messages.length, 0),
  };
}

module.exports = {
  getHistory,
  getFullHistory,
  addUserMessage,
  addAssistantMessage,
  getPlanningContext,
  setPendingClarification,
  getPendingClarification,
  clearPendingClarification,
  clearHistory,
  setUserName,
  formatHistoryForPrompt,
  toInputMessages,
  getStats,
};
