/**
 * server.js - 兼容入口（已合并到 bot.js）
 *
 * 保留此文件仅为兼容旧的 PM2 配置和启动脚本。
 * 所有逻辑已迁移至 bot.js，直接转发启动。
 *
 * 推荐直接使用: node bot.js
 */

console.log('[server.js] 已合并至 bot.js，转发启动...');
require('./bot');
