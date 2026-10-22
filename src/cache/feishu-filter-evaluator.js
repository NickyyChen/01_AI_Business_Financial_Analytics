'use strict';

function _splitTopLevel(input) {
  const parts = [];
  let buf = '';
  let depth = 0;
  let inQuote = false;
  let escaped = false;
  for (const ch of String(input || '')) {
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      buf += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inQuote = !inQuote;
      buf += ch;
      continue;
    }
    if (!inQuote && ch === '(') depth++;
    if (!inQuote && ch === ')') depth--;
    if (!inQuote && depth === 0 && ch === ',') {
      parts.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

function _unescapeQuoted(value) {
  return String(value || '').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function parseFilter(filter) {
  const src = String(filter || '').trim();
  if (!src) return { ok: true, ast: { type: 'all' } };

  const fn = src.match(/^(AND|OR)\(([\s\S]*)\)$/i);
  if (fn) {
    const op = fn[1].toUpperCase();
    const children = _splitTopLevel(fn[2]).map(parseFilter);
    const failed = children.find(child => !child.ok);
    if (failed) return failed;
    return { ok: true, ast: { type: op, children: children.map(child => child.ast) } };
  }

  const eq = src.match(/^CurrentValue\.\[([^\]]+)\]\s*=\s*"((?:\\.|[^"\\])*)"$/);
  if (eq) {
    return { ok: true, ast: { type: 'eq', field: eq[1], value: _unescapeQuoted(eq[2]) } };
  }

  const contains = src.match(/^CurrentValue\.\[([^\]]+)\]\.contains\("((?:\\.|[^"\\])*)"\)$/);
  if (contains) {
    return { ok: true, ast: { type: 'contains', field: contains[1], value: _unescapeQuoted(contains[2]) } };
  }

  const containsFn = src.match(/^contains\(CurrentValue\.\[([^\]]+)\]\s*,\s*"((?:\\.|[^"\\])*)"\)$/i);
  if (containsFn) {
    return { ok: true, ast: { type: 'contains', field: containsFn[1], value: _unescapeQuoted(containsFn[2]) } };
  }

  return { ok: false, error: `unsupported filter: ${src}` };
}

function _flattenFieldValue(value, out = []) {
  if (value == null) return out;
  if (Array.isArray(value)) {
    for (const item of value) _flattenFieldValue(item, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const key of ['text', 'name', 'en_name', 'value', 'open_id', 'id']) {
      if (value[key] != null && value[key] !== '') out.push(String(value[key]));
    }
    return out;
  }
  out.push(String(value));
  return out;
}

function _valuesFor(record, field) {
  const fields = (record && record.fields) || {};
  return _flattenFieldValue(fields[field], []);
}

function _matchesAst(record, ast) {
  if (!ast || ast.type === 'all') return true;
  if (ast.type === 'AND') return ast.children.every(child => _matchesAst(record, child));
  if (ast.type === 'OR') return ast.children.some(child => _matchesAst(record, child));
  if (ast.type === 'eq') {
    const values = _valuesFor(record, ast.field);
    return values.some(value => value === ast.value);
  }
  if (ast.type === 'contains') {
    const values = _valuesFor(record, ast.field);
    return values.some(value => value.includes(ast.value));
  }
  return false;
}

function filterRecords(records, filter) {
  const parsed = parseFilter(filter);
  if (!parsed.ok) return { ok: false, error: parsed.error, records: [] };
  const list = Array.isArray(records) ? records : [];
  return {
    ok: true,
    records: list.filter(record => _matchesAst(record, parsed.ast)),
  };
}

module.exports = {
  parseFilter,
  filterRecords,
  _splitTopLevel,
};
