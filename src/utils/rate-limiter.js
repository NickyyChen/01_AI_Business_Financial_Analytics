/**
 * rate-limiter.js - 全局 API 并发控制器
 *
 * 用于限制对飞书 Bitable 等外部 API 的瞬时并发请求数，
 * 防止因并行加载大量表而触发 99991400 / 1254607 限流。
 *
 * 所有需要走飞书 API 的调用均通过 globalLimiter.run(fn) 排队执行。
 */

const config = require('../../config');
const logger = require('./logger');

class Semaphore {
  /**
   * @param {number} maxConcurrent - 最大同时运行数
   */
  constructor(maxConcurrent) {
    this.max = maxConcurrent;
    this.current = 0;
    this.queue = [];
    this._totalQueued = 0;
  }

  _acquire() {
    if (this.current < this.max) {
      this.current++;
      return Promise.resolve();
    }
    this._totalQueued++;
    return new Promise(resolve => this.queue.push(resolve));
  }

  _release() {
    this.current--;
    if (this.queue.length > 0) {
      this.current++;
      this._totalQueued--;
      const next = this.queue.shift();
      next();
    }
  }

  /**
   * 在并发限制下运行异步函数
   * @param {Function} fn - async () => T
   * @returns {Promise<T>}
   */
  async run(fn) {
    await this._acquire();
    try {
      return await fn();
    } finally {
      this._release();
    }
  }

  /** 当前并发数 */
  get running() { return this.current; }

  /** 排队等待数 */
  get waiting() { return this.queue.length; }
}

const MAX_CONCURRENT = Number(config.FEISHU_GLOBAL_CONCURRENCY) || 15;

const globalLimiter = new Semaphore(MAX_CONCURRENT);

let _lastLogTime = 0;
const _LOG_INTERVAL = 5000;

/**
 * 在全局并发限制下执行飞书 API 调用
 * @param {Function} fn - async () => T
 * @returns {Promise<T>}
 */
async function throttledCall(fn) {
  const waiting = globalLimiter.waiting;
  if (waiting > 0) {
    const now = Date.now();
    if (now - _lastLogTime > _LOG_INTERVAL) {
      _lastLogTime = now;
      logger.info(`[RateLimiter] 排队中: running=${globalLimiter.running}/${MAX_CONCURRENT} waiting=${waiting}`);
    }
  }
  return globalLimiter.run(fn);
}

module.exports = {
  Semaphore,
  globalLimiter,
  throttledCall,
  MAX_CONCURRENT,
};
