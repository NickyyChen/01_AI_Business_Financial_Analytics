/**
 * feishu-client.js - 飞书 API 客户端工具库
 * 提供：Token 管理、通用 HTTP 请求、多维表格 CRUD、员工映射加载
 * 仅使用 Node.js 内置模块，无第三方依赖
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const config = require('../../config');
const logger = require('../utils/logger');
const localListRecords = require('../cache/local-list-records');
const localCacheTables = require('../cache/local-cache-tables');

// ==================== Token 管理 ====================

let _tenantToken = null;
let _tokenExpireAt = 0;

/**
 * 获取 tenant_access_token，自动缓存与刷新
 */
async function getTenantToken() {
  if (_tenantToken && Date.now() < _tokenExpireAt) {
    return _tenantToken;
  }
  logger.info('[Token] 正在获取 tenant_access_token ...');
  const res = await post(
    '/open-apis/auth/v3/tenant_access_token/internal',
    { app_id: config.APP_ID, app_secret: config.APP_SECRET },
    false // 不带 auth header
  );
  if (res.code !== 0) {
    throw new Error(`获取 token 失败: code=${res.code} msg=${res.msg}`);
  }
  _tenantToken = res.tenant_access_token;
  // 提前 5 分钟过期
  _tokenExpireAt = Date.now() + (res.expire - 300) * 1000;
  logger.info('[Token] 获取成功，有效期', res.expire, '秒');
  return _tenantToken;
}

// ==================== 用户 Token 管理 ====================

const USER_TOKEN_PATH = path.join(__dirname, '..', '..', 'data', 'user-tokens.json');

/**
 * 获取 user_access_token，自动检查过期并刷新
 * 如果 token 文件不存在或刷新失败，返回 null
 */
async function getUserToken() {
  try {
    if (!fs.existsSync(USER_TOKEN_PATH)) {
      logger.info('[UserToken] user-tokens.json 不存在，跳过用户 Token');
      return null;
    }
    const raw = fs.readFileSync(USER_TOKEN_PATH, 'utf-8');
    const tokenData = JSON.parse(raw);

    // 检查 token 是否过期（提前 5 分钟）
    if (tokenData.user_access_token && tokenData.expires_at && Date.now() < tokenData.expires_at - 300000) {
      return tokenData.user_access_token;
    }

    logger.info('[UserToken] user_access_token 已过期，尝试刷新 ...');

    // 检查 refresh_token 是否过期
    if (tokenData.refresh_expires_at && Date.now() >= tokenData.refresh_expires_at) {
      logger.warn('[UserToken] refresh_token 也已过期，无法刷新');
      return null;
    }

    // 使用 refresh_token 刷新
    const refreshRes = await post(
      '/open-apis/authen/v1/oidc/refresh_access_token',
      {
        grant_type: 'refresh_token',
        refresh_token: tokenData.refresh_token,
      },
      true // 需要 tenant token 认证
    );

    if (refreshRes.code !== 0) {
      logger.warn(`[UserToken] 刷新失败: code=${refreshRes.code} msg=${refreshRes.msg}`);
      return null;
    }

    const newData = {
      user_access_token: refreshRes.data.access_token,
      refresh_token: refreshRes.data.refresh_token,
      expires_at: Date.now() + (refreshRes.data.expires_in - 300) * 1000,
      refresh_expires_at: Date.now() + (refreshRes.data.refresh_expires_in - 300) * 1000,
      updated_at: new Date().toISOString(),
    };
    fs.writeFileSync(USER_TOKEN_PATH, JSON.stringify(newData, null, 2));
    logger.info('[UserToken] 刷新成功，已更新 user-tokens.json');
    return newData.user_access_token;
  } catch (e) {
    logger.warn(`[UserToken] 获取用户 Token 失败: ${e.message}`);
    return null;
  }
}

/**
 * 使用 user_access_token 发送 GET 请求
 * @param {string} apiPath - API 路径
 * @returns {object} 响应 JSON
 */
async function getWithUserToken(apiPath) {
  const userToken = await getUserToken();
  if (!userToken) {
    throw new Error('无法获取 user_access_token');
  }
  return requestWithToken('GET', apiPath, null, userToken);
}

/**
 * 使用指定 token 发送请求（内部方法）
 */
function requestWithToken(method, apiPath, body, token) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': `Bearer ${token}`,
    };
    const bodyStr = body ? JSON.stringify(body) : null;
    if (bodyStr) {
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const opts = {
      hostname: 'open.feishu.cn',
      port: 443,
      path: apiPath,
      method,
      headers,
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve({ _raw: raw, _status: res.statusCode });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('请求超时')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ==================== HTTP 请求封装 ====================

/**
 * 通用 HTTPS 请求
 */
function request(method, path, body, useAuth) {
  return new Promise(async (resolve, reject) => {
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (useAuth !== false) {
      const token = await getTenantToken();
      headers['Authorization'] = `Bearer ${token}`;
    }
    const bodyStr = body ? JSON.stringify(body) : null;
    if (bodyStr) {
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const opts = {
      hostname: 'open.feishu.cn',
      port: 443,
      path,
      method,
      headers,
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve({ _raw: raw, _status: res.statusCode });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('请求超时')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function get(path, useAuth) {
  return request('GET', path, null, useAuth);
}

async function post(path, body, useAuth) {
  return request('POST', path, body, useAuth);
}

// ==================== 多维表格 CRUD ====================

const { throttledCall } = require('../utils/rate-limiter');

const BITABLE_BASE = `/open-apis/bitable/v1/apps/${config.BITABLE_APP_TOKEN}`;

/**
 * 读取多维表格记录（自动分页，受全局并发限制）
 * @param {string} tableId
 * @param {object} [opts] - 可选 filter, page_size 等
 * @returns {Array} 所有记录
 */
async function listRecordsRemote(tableId, opts = {}) {
  const pageSize = opts.page_size || 100;
  let pageToken = '';
  const all = [];
  do {
    let url = `${BITABLE_BASE}/tables/${tableId}/records?page_size=${pageSize}`;
    if (pageToken) url += `&page_token=${pageToken}`;
    if (opts.filter) url += `&filter=${encodeURIComponent(opts.filter)}`;
    const res = await throttledCall(() => get(url));
    if (res.code !== 0) {
      throw new Error(`读取记录失败 table=${tableId}: code=${res.code} msg=${res.msg}`);
    }
    if (res.data && res.data.items) {
      all.push(...res.data.items);
    }
    pageToken = res.data && res.data.page_token ? res.data.page_token : '';
  } while (pageToken);
  return all;
}

/**
 * 读取多维表格记录。
 *
 * 生产开启 LOCAL_MEMORY_CACHE_ENABLED 后，P0/P1 财务与权限表优先从启动全量内存镜像读取；
 * 同步器内部会显式调用 listRecordsRemote，避免自举时递归读缓存。
 */
async function listRecords(tableId, opts = {}) {
  if (opts && (opts.source === 'remote' || opts._source === 'remote')) {
    return listRecordsRemote(tableId, opts);
  }

  if (config.LOCAL_MEMORY_CACHE_ENABLED && localCacheTables.isCachedTableId(tableId)) {
    const local = localListRecords.listRecords(tableId, opts);
    if (local.handled && !local.error) {
      return local.records;
    }
    if (local.handled && local.error) {
      if (config.LOCAL_MEMORY_CACHE_REMOTE_FALLBACK) {
        logger.warn(`[LocalCache] 本地读取失败，降级远端读取 table=${tableId}: ${local.error}`);
        return listRecordsRemote(tableId, opts);
      }
      throw new Error(`本地缓存读取失败 table=${tableId}: ${local.error}`);
    }
  }

  return listRecordsRemote(tableId, opts);
}

/**
 * 批量创建记录（单次最多 500 条）
 */
async function batchCreateRecords(tableId, records) {
  if (!records.length) return [];
  const results = [];
  // 飞书限制每次最多 500 条
  for (let i = 0; i < records.length; i += 500) {
    const batch = records.slice(i, i + 500);
    const url = `${BITABLE_BASE}/tables/${tableId}/records/batch_create`;
    const res = await post(url, { records: batch.map((r) => ({ fields: r })) });
    if (res.code !== 0) {
      logger.error(`[Bitable] 批量写入失败: code=${res.code} msg=${res.msg}`);
      // 降级为逐条写入
      for (const rec of batch) {
        try {
          const single = await createRecord(tableId, rec);
          results.push(single);
        } catch (e) {
          logger.error(`[Bitable] 单条写入失败:`, e.message);
        }
      }
    } else {
      const items = (res.data && res.data.records) || [];
      results.push(...items);
      logger.info(`[Bitable] 批量写入成功 ${items.length} 条`);
    }
  }
  return results;
}

/**
 * 创建单条记录
 */
async function createRecord(tableId, fields) {
  const url = `${BITABLE_BASE}/tables/${tableId}/records`;
  const res = await post(url, { fields });
  if (res.code !== 0) {
    throw new Error(`创建记录失败: code=${res.code} msg=${res.msg}`);
  }
  return res.data && res.data.record;
}

/**
 * 更新 Bitable 表中的一条记录
 * @param {string} tableId - 表 ID
 * @param {string} recordId - 记录 ID
 * @param {object} fields - 更新字段
 */
async function updateRecord(tableId, recordId, fields) {
  const url = `${BITABLE_BASE}/tables/${tableId}/records/${recordId}`;
  const token = await getTenantToken();
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify({ fields });
    const req = https.request({
      hostname: 'open.feishu.cn',
      port: 443,
      path: url,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          const json = JSON.parse(raw);
          if (json.code !== 0) {
            reject(new Error(`更新记录失败: code=${json.code} msg=${json.msg}`));
          } else {
            resolve(json.data && json.data.record);
          }
        } catch { reject(new Error('响应解析失败')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('请求超时')); });
    req.write(bodyStr);
    req.end();
  });
}

/**
 * 删除多维表格中的一条记录
 */
async function deleteRecord(tableId, recordId) {
  const url = `${BITABLE_BASE}/tables/${tableId}/records/${recordId}`;
  const token = await getTenantToken();
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'open.feishu.cn',
      port: 443,
      path: url,
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          const json = JSON.parse(raw);
          if (json.code !== 0) {
            reject(new Error(`删除记录失败: code=${json.code} msg=${json.msg}`));
          } else {
            resolve(true);
          }
        } catch { reject(new Error('响应解析失败')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('请求超时')); });
    req.end();
  });
}

// ==================== 员工映射 ====================

/**
 * 加载员工主档表，构建 飞书OpenID -> {员工ID, 姓名} 映射
 */
async function loadEmployeeMap() {
  logger.info('[员工映射] 正在加载员工主档表 ...');
  const records = await listRecords(config.TABLES.EMPLOYEE);
  const map = {};
  for (const r of records) {
    const f = r.fields || {};
    const openId = f['飞书OpenID'];
    if (openId) {
      map[openId] = {
        employeeId: f['员工ID'] || '',
        name: f['姓名'] || '',
      };
    }
  }
  logger.info(`[员工映射] 已加载 ${Object.keys(map).length} 条员工记录`);
  return map;
}

// ==================== 消息发送 ====================

/**
 * 回复飞书消息
 * @param {string} messageId - 原消息 ID (om_xxx)
 * @param {string} text - 回复文本
 */
async function replyMessage(messageId, text) {
  const url = `/open-apis/im/v1/messages/${messageId}/reply`;
  const body = {
    content: JSON.stringify({ text }),
    msg_type: 'text',
  };
  const res = await post(url, body);
  if (res.code !== 0) {
    logger.error(`[消息回复] 失败: code=${res.code} msg=${res.msg}`);
  }
  return res;
}

/**
 * 主动发送消息到聊天
 * @param {string} receiveIdType - 'open_id' | 'chat_id' | 'user_id'
 * @param {string} receiveId - 接收方 ID
 * @param {string} text - 消息文本
 */
async function sendMessage(receiveIdType, receiveId, text) {
  const url = `/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`;
  const body = {
    receive_id: receiveId,
    content: JSON.stringify({ text }),
    msg_type: 'text',
  };
  const res = await post(url, body);
  if (res.code !== 0) {
    logger.error(`[消息发送] 失败: code=${res.code} msg=${res.msg}`);
  }
  return res;
}

/**
 * 主动发送 Markdown 卡片消息到用户
 * @param {string} openId - 接收方 open_id
 * @param {object} opts - { title, markdown, template }
 */
async function sendMarkdownCardToUser(openId, opts = {}) {
  const title = opts.title || '经营体检报告';
  const markdown = opts.markdown || '';
  const template = opts.template || 'blue';
  const url = '/open-apis/im/v1/messages?receive_id_type=open_id';
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template,
    },
    elements: [
      { tag: 'markdown', content: markdown },
    ],
  };
  const body = {
    receive_id: openId,
    content: JSON.stringify(card),
    msg_type: 'interactive',
  };
  const res = await post(url, body);
  if (res.code !== 0) {
    logger.error(`[Markdown卡片发送] 失败: code=${res.code} msg=${res.msg}`);
  }
  return res;
}

/**
 * 发送富文本卡片消息（interactive）
 * @param {string} messageId - 原消息 ID
 * @param {object} card - 卡片 JSON
 */
async function replyCard(messageId, card) {
  const url = `/open-apis/im/v1/messages/${messageId}/reply`;
  const body = {
    content: JSON.stringify(card),
    msg_type: 'interactive',
  };
  return post(url, body);
}

// ==================== 消息资源下载 ====================

/**
 * 下载消息中的图片，返回 base64 data URL
 * 使用接口: GET /open-apis/im/v1/messages/:message_id/resources/:file_key?type=image
 * @param {string} messageId - 消息 ID
 * @param {string} fileKey - 图片的 image_key
 * @returns {string} base64 data URL (data:image/png;base64,...)
 */
function downloadMessageImage(messageId, fileKey) {
  return new Promise(async (resolve, reject) => {
    try {
      const token = await getTenantToken();
      const apiPath = `/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=image`;
      const opts = {
        hostname: 'open.feishu.cn',
        port: 443,
        path: apiPath,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      };
      const req = https.request(opts, (res) => {
        if (res.statusCode !== 200) {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString();
            reject(new Error(`下载图片失败: status=${res.statusCode} body=${body.slice(0, 300)}`));
          });
          return;
        }
        const contentType = res.headers['content-type'] || 'image/png';
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const base64 = buffer.toString('base64');
          resolve(`data:${contentType};base64,${base64}`);
        });
      });
      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('下载图片超时')); });
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ==================== 导出 ====================

module.exports = {
  getTenantToken,
  getUserToken,
  get,
  getWithUserToken,
  post,
  request,
  listRecords,
  listRecordsRemote,
  batchCreateRecords,
  createRecord,
  updateRecord,
  deleteRecord,
  loadEmployeeMap,
  replyMessage,
  sendMessage,
  sendMarkdownCardToUser,
  replyCard,
  downloadMessageImage,
};
