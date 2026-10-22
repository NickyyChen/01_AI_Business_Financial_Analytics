/**
 * reflection-store.js - 纠错记忆持久化
 *
 * 当用户纠正 bot 的答案时，把正确信息存下来。
 * 下次同类问题，自动注入 system prompt，避免反复犯同样的错误。
 *
 * 存储架构（双层）：
 *   - 本地 corrections.json：内存快速读取层，启动时加载
 *   - Bitable AI_CORRECTION 表：持久化层，跨部署/跨服务器共享
 *     字段：用户ID, 纠错内容, 关键词, 原始问题, 创建时间
 *
 * 写入时双写（本地 + Bitable），启动时从 Bitable 全量同步到本地。
 * 如果 AI_CORRECTION 表未配置，行为和之前完全一样（纯本地 JSON）。
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const STORE_PATH = path.join(__dirname, '..', '..', 'data', 'corrections.json');
const MAX_PER_USER = 100; // 每用户最多保留 100 条修正

// 延迟加载，避免循环依赖（config → logger → ... → reflection-store → config）
let _config = null;
let _client = null;
function _ensureDeps() {
  if (!_config) _config = require('../../config');
  if (!_client) _client = require('../clients/feishu-client');
}

// ── 内存存储 ──────────────────────────────────────────
// { [userId]: [{ id, content, keywords, createdAt, rawInput? }] }
let _store = {};

// ── 启动时加载（本地 + Bitable）─────────────────────────
function _load() {
  // 先加载本地文件（快速恢复）
  try {
    if (fs.existsSync(STORE_PATH)) {
      _store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
      const total = Object.values(_store).reduce((s, a) => s + a.length, 0);
      logger.info(`[Reflection] 本地加载 ${total} 条修正记录`);
    }
  } catch (e) {
    logger.warn(`[Reflection] 本地加载失败，从空白开始: ${e.message}`);
    _store = {};
  }

  // 异步从 Bitable 同步（合并到本地，不阻塞启动）
  _syncFromBitable().catch(e => {
    logger.warn(`[Reflection] Bitable 同步跳过: ${e.message}`);
  });
}

/**
 * 从 Bitable AI_CORRECTION 表全量读取，合并到内存（去重）
 */
async function _syncFromBitable() {
  _ensureDeps();
  const tableId = _config.TABLES.AI_CORRECTION;
  if (!tableId) return; // 未配置，跳过

  try {
    const records = await _client.listRecords(tableId, { page_size: 500 });
    if (records.length === 0) return;

    let merged = 0;
    for (const r of records) {
      const f = r.fields || {};
      const userId = f['用户ID'];
      const content = f['纠错内容'];
      if (!userId || !content) continue;

      if (!_store[userId]) _store[userId] = [];

      // 用 content 去重（同一条纠错不重复加入）
      const exists = _store[userId].some(c => c.content === content);
      if (exists) continue;

      const keywordsRaw = f['关键词'] || '';
      _store[userId].push({
        id:        r.record_id || Date.now().toString(36),
        content,
        keywords:  typeof keywordsRaw === 'string' ? keywordsRaw.split(',').filter(Boolean) : [],
        createdAt: f['创建时间'] ? new Date(f['创建时间']).toISOString() : new Date().toISOString(),
      });
      merged++;
    }

    if (merged > 0) {
      _saveLocal(); // 同步完合并后落盘
      logger.info(`[Reflection] Bitable 同步完成，新增 ${merged} 条`);
    } else {
      logger.info(`[Reflection] Bitable 同步完成，无新增`);
    }
  } catch (e) {
    logger.warn(`[Reflection] Bitable 同步失败: ${e.message}`);
  }
}

// ── 持久化 ────────────────────────────────────────────
function _saveLocal() {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(_store, null, 2), 'utf-8');
  } catch (e) {
    logger.warn(`[Reflection] 本地保存失败: ${e.message}`);
  }
}

/**
 * 异步写入 Bitable（不阻塞主流程）
 */
async function _saveToBitable(userId, content, keywords, rawInput) {
  _ensureDeps();
  const tableId = _config.TABLES.AI_CORRECTION;
  if (!tableId) return;

  try {
    await _client.createRecord(tableId, {
      '用户ID':   userId,
      '纠错内容': content,
      '关键词':   keywords.join(','),
      '原始问题': (rawInput || '').slice(0, 500),
      '创建时间': Date.now(),
    });
    logger.info(`[Reflection] Bitable 写入成功: ${userId}`);
  } catch (e) {
    logger.warn(`[Reflection] Bitable 写入失败: ${e.message}`);
  }
}

// 兼容旧接口名
function _save() { _saveLocal(); }

// ── 从文本提取关键词（用于后续召回匹配）────────────────
function _extractKeywords(text) {
  // 去停用词，取 2-4 字的有意义词组
  const stopWords = new Set(['不对', '错误', '应该', '是的', '不是', '这里', '那里', '你说', '我说', '其实', '实际上', '正确']);
  const words = [];

  // 提取中文词（2-8字）
  const matches = text.match(/[\u4e00-\u9fa5]{2,8}/g) || [];
  for (const w of matches) {
    if (!stopWords.has(w)) words.push(w);
  }

  // 提取英文大写缩写（KPI / OKR 等）
  const abbrs = text.match(/[A-Z]{2,6}/g) || [];
  words.push(...abbrs);

  // 去重，最多保留 10 个
  return [...new Set(words)].slice(0, 10);
}

// ── 公开 API ──────────────────────────────────────────

/**
 * 保存一条纠错记录
 * @param {string} userId   - 用户 openId 或姓名
 * @param {string} content  - 正确信息的描述（由 LLM 提取后传入）
 * @param {string} rawInput - 用户原始纠错消息（用于关键词提取）
 */
function addCorrection(userId, content, rawInput = '') {
  if (!userId || !content) return;

  if (!_store[userId]) _store[userId] = [];

  const keywords = _extractKeywords(rawInput || content);
  const record = {
    id:        Date.now().toString(36),
    content,
    keywords,
    createdAt: new Date().toISOString(),
  };

  _store[userId].unshift(record); // 最新的放最前面

  // 超出上限时截断
  if (_store[userId].length > MAX_PER_USER) {
    _store[userId] = _store[userId].slice(0, MAX_PER_USER);
  }

  _saveLocal(); // 本地落盘
  _saveToBitable(userId, content, keywords, rawInput).catch(() => {}); // 异步写 Bitable
  logger.info(`[Reflection] 已记录修正 user=${userId} keywords=${keywords.join(',')} content=${content.slice(0, 60)}`);
}

/**
 * 获取与当前问题相关的修正记录
 * 先精确匹配关键词，再按时间降序取最近的
 *
 * @param {string} userId
 * @param {string} question - 当前用户问题（用于相关性匹配）
 * @param {number} limit    - 最多返回条数（默认 5）
 */
function getRelevantCorrections(userId, question = '', limit = 5) {
  const all = _store[userId] || [];
  if (all.length === 0) return [];

  const qKeywords = _extractKeywords(question);
  if (qKeywords.length === 0) return []; // 问题太短/无有效关键词时不注入

  // 按关键词重叠度打分
  const scored = all.map(rec => {
    const overlap = rec.keywords.filter(k => qKeywords.some(q => q.includes(k) || k.includes(q))).length;
    return { rec, score: overlap };
  });

  // 2026-04-17 修复：纠错记录必须通过关键词相关性校验才注入，
  // 否则会把无关的历史结算/回款约定等记录污染当前问答（如"2-4月结算约定"串扰利润分析）。
  // 不再做"无匹配兜底返回最近 2 条"。
  const relevant = scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.rec);

  return relevant;
}

/**
 * 格式化为 prompt 注入文本
 */
function formatForPrompt(corrections) {
  if (!corrections || corrections.length === 0) return '';

  const lines = [
    '===== 历史纠错记录（优先采信以下内容）=====',
    '以下是用户之前纠正过的信息，如果本次问题与之相关，必须采用正确口径：',
  ];
  for (const c of corrections) {
    const date = c.createdAt ? c.createdAt.slice(0, 10) : '';
    lines.push(`- [${date}] ${c.content}`);
  }
  return lines.join('\n');
}

/**
 * 获取用户所有修正（用于调试/管理）
 */
function getAllCorrections(userId) {
  return _store[userId] || [];
}

/**
 * 删除某条修正（用于误纠错的撤销）
 */
function removeCorrection(userId, id) {
  if (!_store[userId]) return;
  _store[userId] = _store[userId].filter(c => c.id !== id);
  _save();
}

// ── 模块加载时初始化 ───────────────────────────────────
_load();

module.exports = {
  addCorrection,
  getRelevantCorrections,
  formatForPrompt,
  getAllCorrections,
  removeCorrection,
};
