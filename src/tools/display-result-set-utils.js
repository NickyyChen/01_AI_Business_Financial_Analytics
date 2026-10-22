'use strict';

const config = require('../../config');

function top(params, fallback = null) {
  const raw = params && (params.top != null ? params.top : params.topN);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 50);
}

function order(params, fallback = 'desc') {
  const raw = String(params && params.order || '').toLowerCase();
  if (raw === 'asc' || raw === 'desc') return raw;
  return fallback === 'asc' ? 'asc' : 'desc';
}

function shouldBuild(params, scope) {
  if (!config.TOOL_DISPLAY_RESULT_SET_ENABLED) return false;
  const p = params && typeof params === 'object' ? params : {};
  const hasParam = p.top != null || p.topN != null || p.sortBy || p.order || p.metric;
  const inheritedRange = Array.isArray(scope && scope._queryProjectNames)
    && scope._queryProjectNames.length > 0
    && ['inherited_result_set', 'pending_clarification', 'explicit_project'].includes(scope && scope._queryProjectScopeSource);
  return !!(hasParam || inheritedRange);
}

function sortRows(rows, sortBy, sortOrder, valueGetter, labelGetter = null) {
  const dir = sortOrder === 'asc' ? 1 : -1;
  return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
    const av = Number(valueGetter(a, sortBy));
    const bv = Number(valueGetter(b, sortBy));
    const aOk = Number.isFinite(av);
    const bOk = Number.isFinite(bv);
    if (!aOk && !bOk) {
      const al = labelGetter ? labelGetter(a) : (a.name || a.key || a.dept || a.customer || a.owner || '');
      const bl = labelGetter ? labelGetter(b) : (b.name || b.key || b.dept || b.customer || b.owner || '');
      return String(al).localeCompare(String(bl));
    }
    if (!aOk) return 1;
    if (!bOk) return -1;
    if (av === bv) return 0;
    return (av - bv) * dir;
  });
}

function _scopeNames(scope) {
  if (!Array.isArray(scope && scope._queryProjectNames)) return [];
  return scope._queryProjectNames.map(name => String(name || '').trim()).filter(Boolean);
}

function _rowNameCandidates(row) {
  if (!row || typeof row !== 'object') return [];
  return [
    row.name,
    row.key,
    row.project,
    row.projectName,
    row.dept,
    row.customer,
    row.owner,
    row.sku,
    row.month,
  ].map(v => String(v || '').trim()).filter(Boolean);
}

function filterRowsByScope(rows, scope) {
  const names = _scopeNames(scope);
  if (names.length === 0) return Array.isArray(rows) ? rows : [];
  const wanted = new Set(names);
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const candidates = _rowNameCandidates(row);
    return candidates.some(name => wanted.has(name));
  });
}

function build({ toolId, type, rows, params, scope, sortBy, sortOrder, rowMapper, topFallback = null, metric = '' }) {
  if (!shouldBuild(params, scope)) return {};
  const n = top(params, topFallback);
  const scopedRows = filterRowsByScope(rows, scope);
  const picked = n ? scopedRows.slice(0, n) : scopedRows;
  const mapped = picked
    .map((row, idx) => ({ rank: idx + 1, ...rowMapper(row, idx) }))
    .filter(row => row && row.name);
  if (mapped.length === 0) return {};
  return {
    displayProjects: mapped,
    displayResultSet: {
      type,
      toolId,
      sortBy,
      order: sortOrder,
      ...(metric ? { metric } : {}),
      top: n || mapped.length,
      rows: mapped,
    },
  };
}

module.exports = {
  build,
  filterRowsByScope,
  order,
  shouldBuild,
  sortRows,
  top,
};
