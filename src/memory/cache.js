const logger = require('../utils/logger');

const MEMORY_CACHE_TTL = 5 * 60 * 1000; // 5 分钟
const _memoryCache = new Map(); // userId → { data, expireAt }
const MAX_CACHE_USERS = 200;

function _getCached(userId) {
  const entry = _memoryCache.get(userId);
  if (!entry) return null;
  if (Date.now() > entry.expireAt) {
    _memoryCache.delete(userId);
    return null;
  }
  return entry.data;
}

function _setCache(userId, data, loadedSections) {
  if (_memoryCache.size >= MAX_CACHE_USERS) {
    const entries = [..._memoryCache.entries()].sort((a, b) => a[1].expireAt - b[1].expireAt);
    const toRemove = entries.slice(0, Math.floor(MAX_CACHE_USERS * 0.3));
    for (const [key] of toRemove) _memoryCache.delete(key);
  }
  _memoryCache.set(userId, {
    data,
    loadedSections: new Set(loadedSections || []),
    expireAt: Date.now() + MEMORY_CACHE_TTL,
  });
}

function _getCachedSections(userId) {
  const entry = _memoryCache.get(userId);
  if (!entry || Date.now() > entry.expireAt) return null;
  return entry.loadedSections || new Set();
}

function invalidateUserCache(userId, userName) {
  _memoryCache.delete(userId);
  for (const key of [..._memoryCache.keys()]) {
    if (String(key).startsWith(`${userId}|`)) _memoryCache.delete(key);
  }
  if (userName && userName !== userId) _memoryCache.delete(userName);
  if (userName && userName !== userId) {
    for (const key of [..._memoryCache.keys()]) {
      if (String(key).startsWith(`${userName}|`)) _memoryCache.delete(key);
    }
  }
}

function invalidateAllCache() {
  _memoryCache.clear();
  logger.info('[Memory] 全部缓存已清除');
}

module.exports = {
  _getCached,
  _setCache,
  _getCachedSections,
  invalidateUserCache,
  invalidateAllCache,
};
