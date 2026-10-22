'use strict';

const tableRegistry = require('./local-cache-tables');

let _activeCache = null;

function _cloneRecord(record) {
  if (!record || typeof record !== 'object') return record;
  return {
    ...record,
    fields: { ...(record.fields || {}) },
  };
}

function _formatCutoff(date = new Date()) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date).replace(/\//g, '-');
}

function buildCache(tableResults, opts = {}) {
  const finishedAtDate = opts.finishedAt ? new Date(opts.finishedAt) : new Date();
  const finishedAt = finishedAtDate.toISOString();
  const tables = {};
  for (const result of tableResults || []) {
    if (!result || !result.def || !result.ok) continue;
    const rows = Array.isArray(result.rows) ? result.rows : [];
    tables[result.def.key] = {
      tableKey: result.def.key,
      tableId: result.def.tableId,
      priority: result.def.priority,
      required: !!result.def.required,
      rowCount: rows.length,
      rows,
      syncedAt: result.finishedAt || finishedAt,
      durationMs: result.durationMs || 0,
    };
  }
  return {
    version: opts.version || finishedAt,
    runId: opts.runId || `local-cache-${Date.now()}`,
    startedAt: opts.startedAt || finishedAt,
    finishedAt,
    cutoffText: _formatCutoff(finishedAtDate),
    tables,
    metadata: opts.metadata && typeof opts.metadata === 'object' ? opts.metadata : {},
    syncErrors: Array.isArray(opts.syncErrors) ? opts.syncErrors : [],
  };
}

function setActiveCache(cache) {
  _activeCache = cache || null;
}

function getActiveCache() {
  return _activeCache;
}

function isReady() {
  return !!(_activeCache && _activeCache.tables && Object.keys(_activeCache.tables).length > 0);
}

function getTableByKey(key) {
  if (!isReady()) return null;
  return _activeCache.tables[key] || null;
}

function getTableById(tableId) {
  const def = tableRegistry.getByTableId(tableId);
  if (!def) return null;
  return getTableByKey(def.key);
}

function getStatus() {
  if (!isReady()) {
    return { ready: false, tableCount: 0 };
  }
  const tables = Object.values(_activeCache.tables);
  return {
    ready: true,
    runId: _activeCache.runId,
    version: _activeCache.version,
    finishedAt: _activeCache.finishedAt,
    cutoffText: _activeCache.cutoffText,
    tableCount: tables.length,
    rows: tables.reduce((sum, table) => sum + (table.rowCount || 0), 0),
    metadata: {
      projectNameMrOptionReady: !!(
        _activeCache.metadata
        && _activeCache.metadata.projectNameMrOptionMap
        && Object.keys(_activeCache.metadata.projectNameMrOptionMap).length > 0
      ),
      projectNameMrOptionCount: _activeCache.metadata && _activeCache.metadata.projectNameMrOptionMap
        ? Object.keys(_activeCache.metadata.projectNameMrOptionMap).length
        : 0,
    },
    tables: tables.map(table => ({
      tableKey: table.tableKey,
      rowCount: table.rowCount,
      syncedAt: table.syncedAt,
    })),
    syncErrors: _activeCache.syncErrors || [],
  };
}

function resetForTest() {
  _activeCache = null;
}

module.exports = {
  buildCache,
  setActiveCache,
  getActiveCache,
  isReady,
  getTableByKey,
  getTableById,
  getStatus,
  resetForTest,
  cloneRecord: _cloneRecord,
};
