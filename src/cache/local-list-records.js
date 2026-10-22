'use strict';

const logger = require('../utils/logger');
const tableRegistry = require('./local-cache-tables');
const store = require('./local-memory-store');
const { filterRecords } = require('./feishu-filter-evaluator');

function listRecords(tableId, opts = {}) {
  const def = tableRegistry.getByTableId(tableId);
  if (!def) return { handled: false, records: [] };
  if (!store.isReady()) {
    return { handled: true, error: 'local memory cache is not ready', records: [] };
  }

  const table = store.getTableByKey(def.key);
  if (!table) {
    return { handled: true, error: `local memory cache missing table ${def.key}`, records: [] };
  }

  const filtered = filterRecords(table.rows, opts.filter);
  if (!filtered.ok) {
    return { handled: true, error: filtered.error, records: [] };
  }

  const records = filtered.records.map(store.cloneRecord);
  logger.debug(`[LocalCache] listRecords table=${def.key} raw=${table.rows.length} matched=${records.length} filter=${opts.filter || '(none)'}`);
  return {
    handled: true,
    records,
    meta: {
      source: 'local_memory',
      tableKey: def.key,
      rawCount: table.rows.length,
      matchedCount: records.length,
      returnedCount: records.length,
      truncated: false,
      cacheVersion: store.getStatus().version,
      cutoffText: store.getStatus().cutoffText,
    },
  };
}

module.exports = {
  listRecords,
};
