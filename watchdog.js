/**
 * watchdog.js - feishu-bot 健康监控
 *
 * 独立 PM2 进程，每 60 秒检查一次 feishu-bot 状态。
 * 崩了：① 自动 pm2 restart  ② 发飞书消息通知管理员
 *
 * 启动:  pm2 start watchdog.js --name feishu-watchdog
 * 停止:  pm2 delete feishu-watchdog
 */

'use strict';

const https  = require('https');
const { execSync } = require('child_process');

// ── 配置 ──────────────────────────────────────────────
try { require('dotenv').config(); } catch (_) {}

const APP_ID    = process.env.FEISHU_APP_ID;
const APP_SECRET= process.env.FEISHU_APP_SECRET;
const RECEIVER  = process.env.INSIGHT_RECEIVER_OPEN_ID; // 接收告警的飞书 OpenID
const PM2_BIN   = process.env.PM2_BIN || 'pm2';
const BOT_NAME  = 'feishu-bot';
const CHECK_INTERVAL_MS = 60 * 1000; // 每分钟检查一次

// ── 状态 ──────────────────────────────────────────────
let _lastRestartCount = null; // 上次记录的重启次数，用于检测新崩溃
let _lastStatus       = null; // 上次检查时的状态
let _alertCooldown    = 0;    // 告警冷却（同一问题不重复刷屏）
let _startupGrace     = 3;    // 启动后前3次检查不告警（约3分钟），只记日志

// ── Feishu HTTP 工具 ───────────────────────────────────

function httpsPost(path, body, token) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(bodyStr) };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const req = https.request({ hostname: 'open.feishu.cn', port: 443, path, method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

async function getTenantToken() {
  const res = await httpsPost('/open-apis/auth/v3/tenant_access_token/internal', { app_id: APP_ID, app_secret: APP_SECRET });
  if (res.code !== 0) throw new Error(`tenant_token failed: ${res.msg}`);
  return res.tenant_access_token;
}

async function sendFeishuAlert(text) {
  if (!RECEIVER) { console.warn('[Watchdog] INSIGHT_RECEIVER_OPEN_ID 未配置，跳过飞书通知'); return; }
  try {
    const token = await getTenantToken();
    await httpsPost('/open-apis/im/v1/messages?receive_id_type=open_id', {
      receive_id: RECEIVER,
      msg_type:   'text',
      content:    JSON.stringify({ text }),
    }, token);
    console.log('[Watchdog] 飞书告警已发送');
  } catch (e) {
    console.error('[Watchdog] 飞书告警发送失败:', e.message);
  }
}

// ── PM2 状态检查 ───────────────────────────────────────

function getBotStatus() {
  try {
    const raw = execSync(`${PM2_BIN} jlist`, { timeout: 8000 }).toString();
    const list = JSON.parse(raw);
    const bot  = list.find(p => p.name === BOT_NAME);
    if (!bot) return null;
    return {
      status:   bot.pm2_env.status,          // 'online' | 'stopped' | 'errored' | 'waiting'
      restarts: bot.pm2_env.restart_time,
      pid:      bot.pid,
    };
  } catch (e) {
    console.error('[Watchdog] pm2 jlist 失败:', e.message);
    return null;
  }
}

function restartBot() {
  try {
    execSync(`${PM2_BIN} restart ${BOT_NAME}`, { timeout: 15000 });
    console.log('[Watchdog] pm2 restart 成功');
    return true;
  } catch (e) {
    console.error('[Watchdog] pm2 restart 失败:', e.message);
    return false;
  }
}

// ── 主检查循环 ─────────────────────────────────────────

async function check() {
  const info = getBotStatus();
  const now  = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  // 找不到进程
  if (!info) {
    console.warn(`[Watchdog] ${now} - ${BOT_NAME} 进程不存在`);
    if (_alertCooldown <= 0) {
      await sendFeishuAlert(`🚨 [Watchdog] ${BOT_NAME} 进程不在 PM2 中！\n时间：${now}\n请检查服务器。`);
      _alertCooldown = 10; // 10 分钟内不重复告警
    }
    _alertCooldown--;
    return;
  }

  const { status, restarts } = info;

  // 启动冷却期：不发告警，只记日志和更新状态
  if (_startupGrace > 0) {
    _startupGrace--;
    _lastRestartCount = restarts;
    _lastStatus = status;
    console.log(`[Watchdog] ${now} - 启动冷却中（${_startupGrace}） | ${status} | 重启次数: ${restarts}`);
    return;
  }

  // 检测真正的崩溃：重启次数增加 且 上次检查时不是 online（经历了 errored/stopped 状态）
  // 手动 pm2 restart 时进程一直是 online→online，不触发告警
  const restartCountChanged = _lastRestartCount !== null && restarts > _lastRestartCount;
  const wasOffline = _lastStatus !== null && _lastStatus !== 'online';
  const crashDetected = restartCountChanged && wasOffline;
  _lastRestartCount = restarts;
  _lastStatus = status;

  if (status !== 'online') {
    // 进程不在线
    console.warn(`[Watchdog] ${now} - 状态异常: ${status} | 重启次数: ${restarts}`);

    // 尝试自动重启
    const restarted = restartBot();

    if (_alertCooldown <= 0) {
      const restartMsg = restarted ? '已自动执行 pm2 restart。' : '自动重启失败，请手动处理。';
      await sendFeishuAlert(
        `🚨 [Watchdog] ${BOT_NAME} 不在线！\n` +
        `状态：${status}\n` +
        `重启次数：${restarts}\n` +
        `时间：${now}\n` +
        restartMsg
      );
      _alertCooldown = 10;
    }
    _alertCooldown--;

  } else if (crashDetected && _alertCooldown <= 0) {
    // 进程在线但刚从 errored/stopped 恢复 → 真正的崩溃重启
    console.warn(`[Watchdog] ${now} - 检测到真实崩溃恢复（重启次数: ${restarts}）`);
    await sendFeishuAlert(
      `⚠️ [Watchdog] ${BOT_NAME} 发生崩溃并已自动重启\n` +
      `当前重启总次数：${restarts}\n` +
      `时间：${now}\n` +
      `当前状态：online（已恢复）`
    );
    _alertCooldown = 5;
    _alertCooldown--;

  } else if (restartCountChanged) {
    // 重启次数变了但上次状态是 online → 手动重启，只记日志不告警
    console.log(`[Watchdog] ${now} - 检测到手动重启（重启次数: ${restarts}），不发告警`);

  } else {
    // 一切正常
    if (_alertCooldown > 0) _alertCooldown--;
    console.log(`[Watchdog] ${now} - ✅ online | 重启次数: ${restarts}`);
  }
}

// ── 启动 ───────────────────────────────────────────────

console.log(`[Watchdog] 启动 | 监控目标: ${BOT_NAME} | 间隔: ${CHECK_INTERVAL_MS / 1000}s`);
check(); // 立即执行一次
setInterval(check, CHECK_INTERVAL_MS);
