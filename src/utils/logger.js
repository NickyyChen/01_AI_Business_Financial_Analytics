/**
 * logger.js - 统一日志模块
 *
 * 同时输出到控制台和文件：
 *   logs/runtime/bot-combined.log — 全部日志（info + warn + error）
 *   logs/runtime/bot-error.log   — 仅 warn + error
 *
 * 文件按天轮转：每天 0 点检查日期变化，自动切换到新文件（旧文件加日期后缀保留）。
 *
 * 用环境变量 LOG_LEVEL 控制最低输出级别（默认 info）
 *   LOG_LEVEL=debug  输出所有日志（含 debug 调试信息）
 *   LOG_LEVEL=info   输出 info / warn / error（默认，生产环境推荐）
 *   LOG_LEVEL=warn   只输出 warn / error（最安静）
 *   LOG_LEVEL=error  只输出 error
 */

'use strict';

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

const _raw = (process.env.LOG_LEVEL || 'info').toLowerCase().trim();
const MIN_LEVEL = LEVELS[_raw] ?? LEVELS.info;

// ==================== 文件输出 ====================

const LOG_DIR = path.join(__dirname, '..', '..', 'logs', 'runtime');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const COMBINED_PATH = path.join(LOG_DIR, 'bot-combined.log');
const ERROR_PATH = path.join(LOG_DIR, 'bot-error.log');

let _combinedStream = fs.createWriteStream(COMBINED_PATH, { flags: 'a' });
let _errorStream = fs.createWriteStream(ERROR_PATH, { flags: 'a' });
let _currentDate = new Date().toISOString().slice(0, 10);

function _rotateLogs() {
  const today = new Date().toISOString().slice(0, 10);
  if (today === _currentDate) return;

  // 关闭旧流
  _combinedStream.end();
  _errorStream.end();

  // 旧文件加日期后缀
  const suffix = _currentDate;
  try {
    if (fs.existsSync(COMBINED_PATH)) fs.renameSync(COMBINED_PATH, `${COMBINED_PATH}.${suffix}`);
    if (fs.existsSync(ERROR_PATH)) fs.renameSync(ERROR_PATH, `${ERROR_PATH}.${suffix}`);
  } catch (_) { /* rename 失败不影响新日志 */ }

  // 创建新流
  _combinedStream = fs.createWriteStream(COMBINED_PATH, { flags: 'a' });
  _errorStream = fs.createWriteStream(ERROR_PATH, { flags: 'a' });
  _currentDate = today;
}

// 每分钟检查一次是否需要轮转
setInterval(_rotateLogs, 60 * 1000).unref();

// ==================== 格式化 ====================

function _fmt(level, args) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const parts = args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object' && a !== null) {
      try { return JSON.stringify(a); } catch { return String(a); }
    }
    return String(a);
  });
  return `[${ts}] [${level.padEnd(5)}] ${parts.join(' ')}`;
}

// ==================== 输出函数 ====================

function debug(...args) {
  if (MIN_LEVEL <= LEVELS.debug) {
    const line = _fmt('DEBUG', args) + '\n';
    process.stdout.write(line);
    _combinedStream.write(line);
  }
}

function info(...args) {
  if (MIN_LEVEL <= LEVELS.info) {
    const line = _fmt('INFO', args) + '\n';
    process.stdout.write(line);
    _combinedStream.write(line);
  }
}

function warn(...args) {
  if (MIN_LEVEL <= LEVELS.warn) {
    const line = _fmt('WARN', args) + '\n';
    process.stderr.write(line);
    _combinedStream.write(line);
    _errorStream.write(line);
  }
}

function error(...args) {
  if (MIN_LEVEL <= LEVELS.error) {
    const line = _fmt('ERROR', args) + '\n';
    process.stderr.write(line);
    _combinedStream.write(line);
    _errorStream.write(line);
  }
}

module.exports = { debug, info, warn, error };
