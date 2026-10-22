'use strict';

const crypto = require('crypto');
const config = require('../../config');
const logger = require('../utils/logger');
const tableRegistry = require('./local-cache-tables');
const store = require('./local-memory-store');

let _refreshTimer = null;
let _runningPromise = null;

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function _runWithLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

function _checksumRows(rows) {
  const hash = crypto.createHash('sha1');
  for (const row of rows || []) {
    hash.update(row.record_id || row.id || '');
    hash.update('\n');
  }
  return hash.digest('hex');
}

function _extractFieldOptions(field) {
  const property = (field && field.property) || {};
  const rawOptions = property.options || property.options_list || property.option || [];
  if (!Array.isArray(rawOptions)) return [];
  return rawOptions
    .map(option => {
      if (!option || typeof option !== 'object') return null;
      const id = option.id || option.option_id || option.value || option.key || '';
      const name = option.name || option.text || option.label || option.value || '';
      if (!id || !name || id === name) return null;
      return { id: String(id), name: String(name).trim() };
    })
    .filter(item => item && item.id && item.name);
}

async function _fetchProjectNameMrOptionMetadata(opts = {}) {
  const client = opts.client || require('../clients/feishu-client');
  const tableId = config.TABLES.PROJECT_NAME_UNIQUE;
  if (!tableId) return { projectNameMrOptionMap: {}, projectNameMrOptionCount: 0 };

  const fields = [];
  let pageToken = '';
  do {
    let url = `/open-apis/bitable/v1/apps/${config.BITABLE_APP_TOKEN}/tables/${tableId}/fields?page_size=100`;
    if (pageToken) url += `&page_token=${pageToken}`;
    const res = await client.get(url);
    if (res.code !== 0) {
      throw new Error(`读取项目主档字段元数据失败: code=${res.code} msg=${res.msg}`);
    }
    fields.push(...((res.data && res.data.items) || []));
    pageToken = res.data && res.data.has_more ? res.data.page_token : '';
  } while (pageToken);

  const target = fields.find(field => field.field_name === '项目名称（管报）');
  if (!target) {
    throw new Error('项目主档字段元数据缺少「项目名称（管报）」字段');
  }

  const options = _extractFieldOptions(target);
  if (options.length === 0) {
    throw new Error('项目主档「项目名称（管报）」字段 options 为空，无法解析员工主档可见项目范围');
  }

  const projectNameMrOptionMap = {};
  for (const option of options) {
    projectNameMrOptionMap[option.id] = option.name;
  }
  return {
    projectNameMrOptionMap,
    projectNameMrOptionCount: Object.keys(projectNameMrOptionMap).length,
    projectNameMrFieldId: target.field_id || '',
    projectNameMrFieldName: target.field_name || '项目名称（管报）',
    projectNameMrSyncedAt: new Date().toISOString(),
  };
}

function _validateTable(def, rows) {
  if (!Array.isArray(rows)) {
    throw new Error(`${def.key} 同步结果不是数组`);
  }
  if (rows.length === 0 && !def.allowEmpty) {
    throw new Error(`${def.key} 行数为 0`);
  }
  const fields = def.requiredFields || [];
  for (const field of fields) {
    const exists = rows.some(row => Object.prototype.hasOwnProperty.call((row && row.fields) || {}, field));
    if (!exists) {
      throw new Error(`${def.key} 缺少关键字段: ${field}`);
    }
  }
  for (const group of def.requiredAnyFields || []) {
    const candidates = Array.isArray(group) ? group.filter(Boolean) : [];
    if (candidates.length === 0) continue;
    const exists = candidates.some(field => rows.some(row => Object.prototype.hasOwnProperty.call((row && row.fields) || {}, field)));
    if (!exists) {
      throw new Error(`${def.key} 缺少关键字段组: ${candidates.join(' / ')}`);
    }
  }
}

async function _fetchTable(def, opts = {}) {
  const client = opts.client || require('../clients/feishu-client');
  const fetchRecords = opts.fetchRecords || ((tableDef) => client.listRecordsRemote(tableDef.tableId, { page_size: 500 }));
  const started = Date.now();
  const startedAt = new Date().toISOString();
  try {
    const rows = await fetchRecords(def);
    _validateTable(def, rows);
    const finishedAt = new Date().toISOString();
    return {
      ok: true,
      def,
      rows,
      rowCount: rows.length,
      checksum: _checksumRows(rows),
      startedAt,
      finishedAt,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      def,
      rows: [],
      error: error && error.message ? error.message : String(error),
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    };
  }
}

function _shouldFailOnResult(result) {
  if (!result || result.ok) return false;
  if (result.def.required) return true;
  return false;
}

async function refresh(opts = {}) {
  if (_runningPromise && !opts.force) {
    logger.info('[LocalCache] 上一轮全量同步仍在运行，复用当前任务');
    return _runningPromise;
  }

  _runningPromise = (async () => {
    const startedAt = new Date().toISOString();
    const runId = `local-cache-${Date.now()}`;
    const defs = tableRegistry.getTableDefs();
    const concurrency = Math.max(1, Number(config.LOCAL_MEMORY_CACHE_SYNC_TABLE_CONCURRENCY) || 2);
    logger.info(`[LocalCache] 开始全量同步: runId=${runId} tables=${defs.length} concurrency=${concurrency} reason=${opts.reason || 'manual'}`);

    const results = await _runWithLimit(defs, concurrency, async (def) => {
      const result = await _fetchTable(def, opts);
      if (result.ok) {
        logger.info(`[LocalCache] ${def.key} 同步成功 rows=${result.rowCount} duration=${result.durationMs}ms`);
      } else {
        logger.warn(`[LocalCache] ${def.key} 同步失败: ${result.error}`);
      }
      if (opts.tableCooldownMs) await _sleep(opts.tableCooldownMs);
      return result;
    });

    const failed = results.filter(_shouldFailOnResult);
    const p1Failed = failed.filter(item => item.def.priority === 'P1');
    const hardFailed = failed.filter(item => item.def.priority === 'P0')
      .concat(config.LOCAL_MEMORY_CACHE_ALLOW_P1_DEGRADED ? [] : p1Failed);

    if (hardFailed.length > 0) {
      const message = hardFailed.map(item => `${item.def.key}: ${item.error}`).join(' | ');
      throw new Error(`本地全量缓存同步失败，服务不启动: ${message}`);
    }

    let metadata = {};
    try {
      metadata = await _fetchProjectNameMrOptionMetadata(opts);
      logger.info(`[LocalCache] 字段元数据同步成功: 项目名称（管报） options=${metadata.projectNameMrOptionCount || 0}`);
    } catch (error) {
      throw new Error(`本地全量缓存字段元数据同步失败，服务不启动: ${error.message}`);
    }

    const finishedAt = new Date().toISOString();
    const cache = store.buildCache(results.filter(result => result.ok), {
      runId,
      startedAt,
      finishedAt,
      metadata,
      syncErrors: results.filter(result => !result.ok).map(result => ({
        tableKey: result.def.key,
        priority: result.def.priority,
        required: result.def.required,
        error: result.error,
      })),
    });
    store.setActiveCache(cache);
    const status = store.getStatus();
    logger.info(`[LocalCache] 全量同步完成并原子替换 activeCache: runId=${runId} tables=${status.tableCount} rows=${status.rows} cutoff=${status.cutoffText}`);
    return status;
  })();

  try {
    return await _runningPromise;
  } finally {
    _runningPromise = null;
  }
}

async function bootstrap(opts = {}) {
  if (!config.LOCAL_MEMORY_CACHE_ENABLED) {
    logger.info('[LocalCache] 未启用，跳过启动全量同步');
    return { skipped: true };
  }
  return refresh({ ...opts, reason: opts.reason || 'bootstrap', force: true });
}

function startAutoRefresh() {
  if (!config.LOCAL_MEMORY_CACHE_ENABLED) return;
  if (_refreshTimer) return;
  const interval = Math.max(60 * 1000, Number(config.LOCAL_MEMORY_CACHE_REFRESH_INTERVAL_MS) || 60 * 60 * 1000);
  _refreshTimer = setInterval(() => {
    refresh({ reason: 'interval' }).catch(error => {
      logger.error(`[LocalCache] 后台刷新失败，保留旧 activeCache: ${error.message}`);
    });
  }, interval);
  logger.info(`[LocalCache] 后台刷新已启动，间隔 ${Math.round(interval / 60000)} 分钟`);
}

function stopAutoRefresh() {
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
}

module.exports = {
  bootstrap,
  refresh,
  startAutoRefresh,
  stopAutoRefresh,
  _private: {
    _validateTable,
    _checksumRows,
    _fetchTable,
    _extractFieldOptions,
    _fetchProjectNameMrOptionMetadata,
  },
};
