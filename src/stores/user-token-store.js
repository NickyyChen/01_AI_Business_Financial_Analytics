/**
 * user-token-store.js - 按用户维度的 Token 存储与管理
 *
 * 以 open_id 为 key，存储每个用户的 user_access_token / refresh_token
 * 支持自动刷新过期 token
 *
 * 双存储架构：
 * - 本地 JSON 文件: 内存缓存 + 快速读取
 * - 飞书多维表格: Vercel OAuth 回调写入，本地定期同步
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const logger = require('../utils/logger');

const STORE_PATH = path.join(__dirname, '..', '..', 'data', 'user-tokens-store.json');

// 内存缓存
let _store = null;

// Bitable 同步节流：最短 30 秒查一次
const _lastBitableCheck = new Map(); // openId → timestamp
const BITABLE_CHECK_INTERVAL = 30000;

// ==================== 文件读写 ====================

function loadStore() {
  if (_store) return _store;
  try {
    if (fs.existsSync(STORE_PATH)) {
      _store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
    } else {
      _store = {};
    }
  } catch (e) {
    logger.warn(`[TokenStore] 读取文件失败: ${e.message}`);
    _store = {};
  }
  return _store;
}

function saveStore() {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(_store, null, 2));
  } catch (e) {
    logger.error(`[TokenStore] 保存文件失败: ${e.message}`);
  }
}

// ==================== Token CRUD ====================

/**
 * 获取用户的 token 数据（原始，不做刷新）
 * @param {string} openId
 * @returns {object|null}
 */
function getRawToken(openId) {
  const store = loadStore();
  return store[openId] || null;
}

/**
 * 存储用户 token
 * @param {string} openId
 * @param {object} tokenData - { access_token, refresh_token, expires_in, refresh_expires_in, name, ... }
 */
function saveToken(openId, tokenData) {
  const store = loadStore();
  store[openId] = {
    open_id: openId,
    name: tokenData.name || '',
    user_access_token: tokenData.access_token || tokenData.user_access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: tokenData.expires_at || (Date.now() + (tokenData.expires_in || 7200) * 1000),
    refresh_expires_at: tokenData.refresh_expires_at || (Date.now() + (tokenData.refresh_expires_in || 2592000) * 1000),
    scopes: tokenData.scope || '',
    updated_at: new Date().toISOString(),
  };
  _store = store;
  saveStore();
  logger.info(`[TokenStore] 已保存用户 token: ${openId} (${store[openId].name || 'unknown'})`);
}

/**
 * 删除用户 token
 */
function removeToken(openId) {
  const store = loadStore();
  delete store[openId];
  _store = store;
  saveStore();
}

/**
 * 检查用户是否已有有效的 access_token（不含刷新逻辑）
 */
function hasValidToken(openId) {
  const data = getRawToken(openId);
  if (!data || !data.user_access_token) return false;
  // 提前 5 分钟判定过期
  return Date.now() < (data.expires_at - 300000);
}

/**
 * 检查用户是否有可刷新的 token（access 过期但 refresh 未过期）
 */
function hasRefreshableToken(openId) {
  const data = getRawToken(openId);
  if (!data || !data.refresh_token) return false;
  return Date.now() < (data.refresh_expires_at - 300000);
}

// ==================== Token 刷新 ====================

const MAX_REFRESH_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * 刷新指定用户的 token（带重试）
 * @param {string} openId
 * @returns {string|null} 新的 user_access_token，失败返回 null
 */
async function refreshUserToken(openId) {
  const data = getRawToken(openId);
  if (!data || !data.refresh_token) {
    logger.warn(`[TokenStore] 无法刷新: ${openId} 无 refresh_token`);
    return null;
  }

  if (Date.now() >= (data.refresh_expires_at - 300000)) {
    logger.warn(`[TokenStore] ${openId} 的 refresh_token 已过期`);
    removeToken(openId);
    return null;
  }

  for (let attempt = 1; attempt <= MAX_REFRESH_RETRIES; attempt++) {
    try {
      const appTokenRes = await httpPost('/open-apis/auth/v3/app_access_token/internal', {
        app_id: config.APP_ID,
        app_secret: config.APP_SECRET,
      });
      if (appTokenRes.code !== 0) {
        logger.error(`[TokenStore] 获取 app_token 失败: ${appTokenRes.msg}`);
        if (attempt < MAX_REFRESH_RETRIES) { await sleep(RETRY_DELAY_MS * attempt); continue; }
        return null;
      }

      const refreshRes = await httpPost('/open-apis/authen/v1/oidc/refresh_access_token', {
        grant_type: 'refresh_token',
        refresh_token: data.refresh_token,
      }, appTokenRes.app_access_token);

      if (refreshRes.code !== 0) {
        logger.warn(`[TokenStore] 刷新失败: code=${refreshRes.code} msg=${refreshRes.msg}`);
        if (refreshRes.code === 20004 || refreshRes.code === 20003) {
          removeToken(openId);
        }
        return null;
      }

      const newData = refreshRes.data;
      saveToken(openId, {
        access_token: newData.access_token,
        refresh_token: newData.refresh_token,
        expires_in: newData.expires_in,
        refresh_expires_in: newData.refresh_expires_in,
        name: data.name,
        scope: newData.scope || data.scopes,
      });

      logger.info(`[TokenStore] 刷新成功: ${openId}`);
      return newData.access_token;
    } catch (e) {
      logger.warn(`[TokenStore] 刷新异常 (attempt ${attempt}/${MAX_REFRESH_RETRIES}): ${e.message}`);
      if (attempt < MAX_REFRESH_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      } else {
        logger.error(`[TokenStore] 刷新最终失败: ${openId} - ${e.message}`);
        return null;
      }
    }
  }
  return null;
}

/**
 * 获取用户的有效 access_token（自动刷新 + 多维表格云端同步）
 * @param {string} openId
 * @returns {string|null}
 */
async function getUserAccessToken(openId) {
  // 1. 本地已有有效 token
  if (hasValidToken(openId)) {
    return getRawToken(openId).user_access_token;
  }

  // 2. 尝试本地刷新
  if (hasRefreshableToken(openId)) {
    const refreshed = await refreshUserToken(openId);
    if (refreshed) return refreshed;
  }

  // 3. 从多维表格同步（Vercel 回调写入的 token）
  const cloudToken = await syncFromBitable(openId);
  if (cloudToken) return cloudToken;

  // 4. 无 token
  return null;
}

// ==================== 多维表格云端同步 ====================

/**
 * 从飞书多维表格读取 token（Vercel OAuth 回调写入）
 * 带节流控制，同一用户最短 30 秒查一次
 */
async function syncFromBitable(openId) {
  const tableId = config.TABLES.OAUTH_TOKEN;
  if (!tableId) return null;

  const lastCheck = _lastBitableCheck.get(openId) || 0;
  if (Date.now() - lastCheck < BITABLE_CHECK_INTERVAL) return null;
  _lastBitableCheck.set(openId, Date.now());

  try {
    const appTokenRes = await httpPost('/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: config.APP_ID, app_secret: config.APP_SECRET,
    });
    if (!appTokenRes.tenant_access_token) return null;
    const tenantToken = appTokenRes.tenant_access_token;

    const searchUrl = `/open-apis/bitable/v1/apps/${config.BITABLE_APP_TOKEN}/tables/${tableId}/records/search`;
    const searchRes = await httpPostWithToken(searchUrl, {
      filter: {
        conjunction: 'and',
        conditions: [{ field_name: 'open_id', operator: 'is', value: [openId] }],
      },
      page_size: 1,
    }, tenantToken);

    if (searchRes.code !== 0 || !searchRes.data?.items?.length) return null;

    const fields = searchRes.data.items[0].fields;
    const expiresAt = Number(fields.expires_at) || 0;
    const refreshExpiresAt = Number(fields.refresh_expires_at) || 0;

    // token 已过期且无法刷新
    if (Date.now() >= refreshExpiresAt - 300000) return null;

    // 保存到本地缓存
    saveToken(openId, {
      access_token: fields.user_access_token,
      refresh_token: fields.refresh_token,
      name: fields.name || '',
      scope: fields.scopes || '',
      expires_at: expiresAt,
      refresh_expires_at: refreshExpiresAt,
    });

    logger.info(`[TokenStore] 从多维表格同步 token 成功: ${openId} (${fields.name || 'unknown'})`);

    // 如果 access_token 还有效直接返回
    if (Date.now() < expiresAt - 300000) {
      return fields.user_access_token;
    }

    // 否则尝试用同步过来的 refresh_token 刷新
    return await refreshUserToken(openId);
  } catch (e) {
    logger.warn(`[TokenStore] 多维表格同步失败: ${e.message}`);
    return null;
  }
}

function httpPostWithToken(apiPath, body, token) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': `Bearer ${token}`,
    };
    const bodyStr = JSON.stringify(body);
    headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request({
      hostname: 'open.feishu.cn', port: 443, path: apiPath, method: 'POST', headers,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve(JSON.parse(raw)); } catch { resolve({ _raw: raw }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('请求超时')); });
    req.write(bodyStr);
    req.end();
  });
}

// ==================== OAuth Code Exchange ====================

/**
 * 用授权码换取 user_access_token 并存储
 * @param {string} code - OAuth 授权码
 * @returns {object} { openId, name, success }
 */
async function exchangeCodeForToken(code, stateOpenId) {
  try {
    // 获取 app_access_token
    const appTokenRes = await httpPost('/open-apis/auth/v3/app_access_token/internal', {
      app_id: config.APP_ID,
      app_secret: config.APP_SECRET,
    });
    if (appTokenRes.code !== 0) {
      throw new Error(`获取 app_token 失败: ${appTokenRes.msg}`);
    }

    // 用 code 换 user_access_token
    const tokenRes = await httpPost('/open-apis/authen/v1/oidc/access_token', {
      grant_type: 'authorization_code',
      code: code,
    }, appTokenRes.app_access_token);

    if (tokenRes.code !== 0) {
      throw new Error(`换取 token 失败: code=${tokenRes.code} msg=${tokenRes.msg || tokenRes.message}`);
    }

    const data = tokenRes.data;
    const accessToken = data.access_token;

    // OIDC 接口不返回 open_id/name，需要调 userinfo 获取
    let openId = stateOpenId || null;
    let userName = '';

    try {
      const userInfoRes = await httpGetWithToken('/open-apis/authen/v1/user_info', accessToken);
      if (userInfoRes.code === 0 && userInfoRes.data) {
        openId = userInfoRes.data.open_id || openId;
        userName = userInfoRes.data.name || '';
        logger.info(`[TokenStore] userinfo: ${userName} (${openId})`);
      }
    } catch (e) {
      logger.warn(`[TokenStore] 获取 userinfo 失败: ${e.message}`);
    }

    if (!openId) {
      throw new Error('无法获取用户 open_id');
    }

    // 存储 token
    saveToken(openId, {
      access_token: accessToken,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
      refresh_expires_in: data.refresh_expires_in,
      name: userName,
      scope: data.scope,
    });

    logger.info(`[TokenStore] OAuth 授权成功: ${data.name} (${openId})`);
    return { openId, name: data.name, success: true };
  } catch (e) {
    logger.error(`[TokenStore] OAuth 换码失败: ${e.message}`);
    return { openId: null, name: null, success: false, error: e.message };
  }
}

// ==================== HTTP 工具 ====================

function httpPost(apiPath, body, token) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const bodyStr = JSON.stringify(body);
    headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request({
      hostname: 'open.feishu.cn',
      port: 443,
      path: apiPath,
      method: 'POST',
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve(JSON.parse(raw)); } catch { resolve({ _raw: raw }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('请求超时')); });
    req.write(bodyStr);
    req.end();
  });
}

function httpGetWithToken(apiPath, token) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'open.feishu.cn',
      port: 443,
      path: apiPath,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve(JSON.parse(raw)); } catch { resolve({ _raw: raw }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('请求超时')); });
    req.end();
  });
}

// ==================== 导出 ====================

module.exports = {
  getRawToken,
  saveToken,
  removeToken,
  hasValidToken,
  hasRefreshableToken,
  getUserAccessToken,
  refreshUserToken,
  exchangeCodeForToken,
  httpGetWithToken,
};
