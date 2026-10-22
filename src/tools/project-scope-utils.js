'use strict';

const PROJECT_SCOPE_SOURCES = new Set([
  'explicit_project',
  'inherited_result_set',
  'pending_clarification',
]);

const DEFAULT_PROJECT_CANDIDATES = [
  '是否交付项目',
  '项目名',
  '项目名称',
  '项目',
  '项目名称（管报）',
  '26年项目名称',
  '定稿项目名称',
  '最终取值项目',
];

const WORKTIME_PROJECT_CANDIDATES = [
  '匹配项目',
  '标准项目名称新',
  '项目名称',
  '是否交付项目',
  '26年项目名称',
  '项目名称（管报）',
];

const INVOICE_PROJECT_CANDIDATES = [
  '项目',
  '项目名称',
  '项目名称（管报）',
  '是否交付项目',
  '26年项目名称',
];

function normalizeProjectScopeName(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, '')
    .replace(/[（(].*?[）)]/g, '')
    .replace(/[－—_]/g, '-')
    .trim()
    .toLowerCase();
}

function shouldApplyProjectScope(scope) {
  return !!(scope
    && Array.isArray(scope._queryProjectNames)
    && scope._queryProjectNames.length > 0
    && PROJECT_SCOPE_SOURCES.has(scope._queryProjectScopeSource));
}

function projectScopeNameSet(scope) {
  return new Set((scope && Array.isArray(scope._queryProjectNames) ? scope._queryProjectNames : [])
    .map(normalizeProjectScopeName)
    .filter(Boolean));
}

function _valueTexts(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value.flatMap(_valueTexts);
  if (typeof value === 'object') {
    return _valueTexts(value.text || value.name || value.value || '');
  }
  return [String(value).trim()].filter(Boolean);
}

function _splitProjectAliases(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const parts = raw.split(/[+＋、,，;；]/).map(item => item.trim()).filter(Boolean);
  return parts.length > 1 ? [raw, ...parts] : [raw];
}

function projectNameCandidatesFromFields(fields, candidates = DEFAULT_PROJECT_CANDIDATES) {
  const out = [];
  for (const key of candidates || []) {
    const values = _valueTexts(fields && fields[key]);
    for (const value of values) out.push(..._splitProjectAliases(value));
  }
  return out.filter(Boolean);
}

function recordMatchesProjectScope(row, scope, candidates = DEFAULT_PROJECT_CANDIDATES) {
  if (!shouldApplyProjectScope(scope)) return true;
  const wanted = projectScopeNameSet(scope);
  if (wanted.size === 0) return true;
  const fields = row && row.fields ? row.fields : (row || {});
  return projectNameCandidatesFromFields(fields, candidates)
    .some(name => wanted.has(normalizeProjectScopeName(name)));
}

function filterRecordsByProjectScope(records, scope, candidates = DEFAULT_PROJECT_CANDIDATES) {
  const rows = Array.isArray(records) ? records : [];
  if (!shouldApplyProjectScope(scope)) return rows;
  return rows.filter(row => recordMatchesProjectScope(row, scope, candidates));
}

function projectScopeGuard(scope, beforeCount, afterCount) {
  return {
    targetProjects: Array.isArray(scope && scope._queryProjectNames) ? scope._queryProjectNames : [],
    scopeSource: scope && scope._queryProjectScopeSource || 'none',
    rangeApplied: shouldApplyProjectScope(scope),
    beforeCount,
    afterCount,
  };
}

module.exports = {
  DEFAULT_PROJECT_CANDIDATES,
  INVOICE_PROJECT_CANDIDATES,
  WORKTIME_PROJECT_CANDIDATES,
  filterRecordsByProjectScope,
  normalizeProjectScopeName,
  projectNameCandidatesFromFields,
  projectScopeGuard,
  projectScopeNameSet,
  recordMatchesProjectScope,
  shouldApplyProjectScope,
};
