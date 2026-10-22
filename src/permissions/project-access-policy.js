'use strict';

const config = require('../../config');
const client = require('../clients/feishu-client');
const FM = require('../utils/field-mapping');
const logger = require('../utils/logger');

const PROJECT_DATA_TABLES = new Set([
  'projectMaster',
  'actualProject',
  'budgetProject',
  'budgetWorktime',
  'cashflow',
  'pendingPayment',
  'vendorContract',
  'invoiceApply',
  'customerAnalysis',
  'rollbackProjectActual',
]);

const PROJECT_DATA_TOOL_PREFIXES = [
  'finance.',
  'analytics.',
  'customer.',
];

const PROJECT_DATA_WORDS = [
  '项目主档', '经营', '收入', '成本', '利润', '毛利', '预算',
  '回款', '开票', '合同', '供应商', '履约', '亏损', '盈利',
];

let projectCache = {
  expiresAt: 0,
  rows: null,
};

function normalizeList(value) {
  return Array.isArray(value) ? value.filter(Boolean).map(String) : [];
}

function hasAny(text, words) {
  return words.some((word) => text.includes(word));
}

function isProjectDataQuestion(message, planResult) {
  const text = String(message || '');
  const tables = normalizeList(planResult && planResult.tables_needed);
  const tools = normalizeList(planResult && planResult.tools_needed);
  if (tables.some((key) => PROJECT_DATA_TABLES.has(key))) return true;
  if (tools.some((id) => PROJECT_DATA_TOOL_PREFIXES.some((prefix) => id.startsWith(prefix)))) return true;
  return text.includes('项目') && hasAny(text, PROJECT_DATA_WORDS);
}

function valueToTexts(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (item == null) return [];
      if (typeof item === 'string') return [item];
      if (item.text) return [item.text];
      if (item.name) return [item.name];
      return [String(item)];
    });
  }
  return [String(value)];
}

function cleanName(name) {
  return String(name || '')
    .trim()
    .replace(/^\\?["']|\\?["']$/g, '')
    .trim();
}

function projectNames(fields) {
  const PF = FM.PROJECT_NAME_UNIQUE_FIELDS;
  return [
    ...valueToTexts(fields[PF.PROJECT_26]),
    ...valueToTexts(fields[PF.PROJECT_NAME_MR]),
    ...valueToTexts(fields[PF.CONTRACT_NAME]),
  ]
    .map(cleanName)
    .filter((name) => name.length >= 2);
}

async function loadProjectRows() {
  if (projectCache.rows && Date.now() < projectCache.expiresAt) {
    return projectCache.rows;
  }
  if (!config.TABLES.PROJECT_NAME_UNIQUE) return [];
  const rows = await client.listRecords(config.TABLES.PROJECT_NAME_UNIQUE, { page_size: 500 });
  projectCache = {
    rows,
    expiresAt: Date.now() + 5 * 60 * 1000,
  };
  return rows;
}

function findMentionedProjects(message, rows) {
  const text = String(message || '');
  if (!text) return [];

  const candidates = [];
  for (const row of rows || []) {
    const fields = row.fields || {};
    const names = [...new Set(projectNames(fields))];
    const matchedName = names
      .sort((a, b) => b.length - a.length)
      .find((name) => text.includes(name));
    if (matchedName) {
      candidates.push({ row, fields, names, matchedName });
    }
  }

  const seen = new Set();
  return candidates.filter((item) => {
    const id = item.row.record_id || item.names.join('|');
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function isProjectAuthorized(project, scope) {
  if (!scope || scope.isGlobal) return true;
  const allowedDepts = new Set(normalizeList(scope.depts));
  const allowedProjects = new Set([
    ...normalizeList(scope.projectKeys),
    ...normalizeList(scope.visibleProjects),
  ]);
  const PF = FM.PROJECT_NAME_UNIQUE_FIELDS;
  const dept = FM.str(project.fields, PF.DEPT);
  if (dept && allowedDepts.has(dept)) return true;
  return project.names.some((name) => allowedProjects.has(name));
}

function rejectReply(userName, projects, scope) {
  const name = userName || '同事';
  const projectLabel = projects.map((p) => p.matchedName).join('、');
  const allowedDepts = normalizeList(scope && scope.depts);
  const allowedProjects = normalizeList(scope && scope.projectKeys);
  const allowed = allowedDepts.length > 0
    ? `授权部门：${allowedDepts.join('、')}`
    : (allowedProjects.length > 0
        ? `授权项目：${allowedProjects.slice(0, 10).join('、')}${allowedProjects.length > 10 ? '等' : ''}`
        : '暂无授权部门或项目');
  return `${name}，权限不足：项目「${projectLabel}」不在你当前的数据权限范围内，无法查询它的项目主档、收入、成本、利润、预算或回款等经营数据。\n\n`
    + `你当前可见范围是：${allowed}。\n\n`
    + '如需查询该项目，请联系管理员在高级权限表中补充项目或部门授权。';
}

async function checkExplicitProjectAccess({ message, originalMessage, planResult, scope, userName }) {
  if (!scope || scope.isGlobal) return { reject: false };
  const userText = originalMessage || message;
  if (!isProjectDataQuestion(userText, planResult)) return { reject: false };

  let rows;
  try {
    rows = await loadProjectRows();
  } catch (error) {
    logger.warn(`[ProjectAccess] 项目主档读取失败，跳过显式项目权限校验: ${error.message}`);
    return { reject: false };
  }

  const mentioned = findMentionedProjects(userText, rows);
  if (mentioned.length === 0) return { reject: false };

  const outside = mentioned.filter((project) => !isProjectAuthorized(project, scope));
  if (outside.length === 0) return { reject: false, mentioned };

  return {
    reject: true,
    type: 'project_scope',
    projects: outside.map((item) => ({
      name: item.matchedName,
      record_id: item.row.record_id || item.row.id || '',
    })),
    reply: rejectReply(userName, outside, scope),
  };
}

function _clearCache() {
  projectCache = { expiresAt: 0, rows: null };
}

module.exports = {
  checkExplicitProjectAccess,
  _private: {
    isProjectDataQuestion,
    findMentionedProjects,
    isProjectAuthorized,
    _clearCache,
  },
};
