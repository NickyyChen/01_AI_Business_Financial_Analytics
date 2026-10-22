/**
 * ecosystem.config.js - PM2 进程守护配置
 *
 * 统一入口：bot.js（含 WebSocket + HTTP + 定时任务）
 *
 * 启动: pm2 start ecosystem.config.js
 * 查看: pm2 list / pm2 logs
 */

module.exports = {
  apps: [
    {
      name: 'feishu-bot',
      script: 'bot.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_restarts: 20,
      restart_delay: 3000,
      min_uptime: '10s',
      max_memory_restart: '1G',
      log_file: './logs/bot-combined.log',
      out_file: './logs/bot-out.log',
      error_file: './logs/bot-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        LOCAL_MEMORY_CACHE_ENABLED: 'true',
        LOCAL_MEMORY_CACHE_BOOTSTRAP_BLOCKING: 'true',
        LOCAL_MEMORY_CACHE_REFRESH_INTERVAL_MS: String(60 * 60 * 1000),
        LOCAL_MEMORY_CACHE_SYNC_TABLE_CONCURRENCY: '2',
        LOCAL_MEMORY_CACHE_REMOTE_FALLBACK: 'false',
        LOCAL_MEMORY_CACHE_ALLOW_P1_DEGRADED: 'false',
        DISABLE_SCHEDULERS: 'false',
        SCHEDULED_PUSH_ENABLED: 'true',
        SCHEDULED_PUSH_SCHEDULE_MODE: 'privateSend',
        SCHEDULED_PUSH_SCHEDULER_TICK_MS: String(30 * 1000),
      },
    },
    {
      name: 'feishu-watchdog',
      script: 'watchdog.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 5000,
      min_uptime: '5s',
      out_file: './logs/watchdog-out.log',
      error_file: './logs/watchdog-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
