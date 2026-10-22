'use strict';

const store = require('../cache/local-memory-store');
const logger = require('../utils/logger');

const PROJECT_FIELDS = [
  '26年项目名称',
  '项目名称（管报）',
  '是否交付项目',
  '项目名',
  '项目名称',
  '项目',
  '合同名',
];

const DEPT_FIELDS = [
  '一级部门',
  '部门',
  '项目归属部门',
  '管报-一级部门（手工）',
  '收入归属部门',
  '项目归属部门-一级',
];

const TABLE_KEYS = [
  'PROJECT_NAME_UNIQUE',
  'ROLLBACK_PROJECT_ACTUAL',
  'ACTUAL_PROJECT',
  'ACTUAL_DEPT',
  'BUDGET_PROJECT',
  'BUDGET_DEPT',
  'INVOICE',
];

const PENDING_TTL_MS = 10 * 60 * 1000;

let cached = null;

function _text(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(_text).filter(Boolean).join('、');
  if (typeof value === 'object') {
    return String(value.text || value.name || value.value || value.id || '').trim();
  }
  return String(value).trim();
}

function normalizeName(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[（(].*?[）)]/g, '')
    .replace(/[－—_]/g, '-')
    .replace(/[，,。；;：:、/\\|]/g, '')
    .toLowerCase();
}

function _queryVariants(message) {
  const q = normalizeName(message);
  const variants = new Set([q]);
  if (q.includes('人资')) variants.add(q.replace(/人资/g, '人力资源'));
  if (q.includes('hr')) variants.add(q.replace(/hr/g, '人力资源'));
  return [...variants].filter(Boolean);
}

function _queryCoreVariants(message) {
  const variants = _queryVariants(message);
  const suffixNoise = /(盈亏数据?|利润率?|利润|收入|成本|数据|情况|经营|查询|看一下|看下|帮我|请问|的)/g;
  const out = new Set();
  for (const variant of variants) {
    const beforeDate = variant.split(/\d{1,4}(?:年|月|-|~|至|到)/)[0] || variant;
    out.add(beforeDate.replace(suffixNoise, '').replace(/项目$/, ''));
  }
  return [...out].filter(s => s.length >= 2);
}

function _addUnique(map, name, payload = {}) {
  const clean = _text(name);
  const norm = normalizeName(clean);
  if (!clean || !norm) return;
  if (!map.has(norm)) {
    map.set(norm, { name: clean, norm, sources: new Set(), rows: 0, ...payload });
  }
  const entry = map.get(norm);
  if (payload.source) entry.sources.add(payload.source);
  entry.rows += 1;
  if (payload.dept && !entry.dept) entry.dept = payload.dept;
}

function _rows(tableKey) {
  const table = store.getTableByKey(tableKey);
  return table && Array.isArray(table.rows) ? table.rows : [];
}

function buildEntityIndex({ force = false } = {}) {
  const status = store.getStatus();
  const version = status && status.ready ? status.version : 'not-ready';
  if (!force && cached && cached.version === version) return cached;

  const projects = new Map();
  const depts = new Map();

  if (status && status.ready) {
    for (const tableKey of TABLE_KEYS) {
      for (const row of _rows(tableKey)) {
        const f = row && row.fields ? row.fields : {};
        const dept = DEPT_FIELDS.map(field => _text(f[field])).find(Boolean) || '';
        for (const field of PROJECT_FIELDS) {
          _addUnique(projects, f[field], { source: tableKey, dept });
        }
        for (const field of DEPT_FIELDS) {
          _addUnique(depts, f[field], { source: tableKey });
        }
      }
    }
  }

  cached = {
    ready: !!(status && status.ready),
    version,
    projects: [...projects.values()].map(item => ({
      ...item,
      sources: [...item.sources],
    })),
    depts: [...depts.values()].map(item => ({
      ...item,
      sources: [...item.sources],
    })),
    projectNorms: new Set(projects.keys()),
    deptNorms: new Set(depts.keys()),
  };
  return cached;
}

function _scoreProject(normProject, message) {
  if (!normProject || normProject.length < 3) return 0;
  const variants = _queryVariants(message);
  for (const q of variants) {
    if (q.includes(`${normProject}项目`)) return 115;
    if (q.includes(normProject)) return 105;
  }
  const cores = _queryCoreVariants(message);
  for (const core of cores) {
    if (core.length >= 3 && normProject.startsWith(core)) return 78;
    if (core.length >= 3 && normProject.includes(core)) return 70;
  }
  return 0;
}

function findProjectCandidates(message, { limit = 6, minScore = 70 } = {}) {
  const index = buildEntityIndex();
  if (!index.ready) return [];
  return index.projects
    .map(project => ({ ...project, type: 'project', label: project.name, value: project.name, score: _scoreProject(project.norm, message) }))
    .filter(project => project.score >= minScore)
    .sort((a, b) => b.score - a.score || b.name.length - a.name.length)
    .slice(0, limit);
}

function resolveExplicitProject(message) {
  const candidates = findProjectCandidates(message, { limit: 4, minScore: 95 });
  if (candidates.length !== 1) return null;
  return candidates[0];
}

function isKnownDept(dept) {
  const index = buildEntityIndex();
  if (!index.ready) return true;
  return index.deptNorms.has(normalizeName(dept));
}

function _ensureQueryScope(planResult) {
  if (!planResult.query_scope || typeof planResult.query_scope !== 'object') {
    planResult.query_scope = { depts: [], subDepts: [], targetProjects: [], scopeSource: 'none' };
  }
  if (!Array.isArray(planResult.query_scope.depts)) planResult.query_scope.depts = [];
  if (!Array.isArray(planResult.query_scope.subDepts)) planResult.query_scope.subDepts = [];
  if (!Array.isArray(planResult.query_scope.targetProjects)) planResult.query_scope.targetProjects = [];
  if (!planResult.query_scope.scopeSource) planResult.query_scope.scopeSource = 'none';
  return planResult.query_scope;
}

function _buildEntityClarification({ message, invalidDepts, candidates, now = Date.now() }) {
  const labels = candidates.map(item => `${item.type === 'project' ? '项目/成本池' : '部门'}「${item.name}」`);
  const missing = invalidDepts.length ? `当前数据中没有一级部门「${invalidDepts.join('、')}」。` : '当前对象名称不够明确。';
  const hint = labels.length
    ? `我查到可能相关的${labels.join('、')}，你想按哪个查？也可以直接回复其他部门或项目名称。`
    : '你可以直接回复正确的部门或项目名称，我再继续查。';
  return {
    question: `${missing}${hint}`,
    pendingClarification: {
      type: 'entity_resolution',
      originalMessage: String(message || '').trim(),
      clarificationQuestion: `${missing}${hint}`,
      missingSlots: ['target_entity'],
      candidates: candidates.map(item => ({
        type: item.type,
        label: item.name,
        value: item.name,
        name: item.name,
        dept: item.dept || '',
        score: item.score || 0,
      })),
      entityHints: candidates.map(item => ({
        type: item.type,
        name: item.name,
        dept: item.dept || '',
        sources: item.sources || [],
        score: item.score || 0,
      })),
      baseQueryState: {
        targetProjects: [],
        dept: '',
        period: '',
        metric: '',
        resultSetType: '',
        scopeSource: 'pending_clarification',
      },
      createdAt: now,
      expiresAt: now + PENDING_TTL_MS,
    },
  };
}

function applyEntityScopeGuards(planResult, message, opts = {}) {
  if (!planResult || !buildEntityIndex().ready) return planResult;
  const queryScope = _ensureQueryScope(planResult);
  const exactProject = resolveExplicitProject(message);

  if (exactProject) {
    queryScope.targetProjects = [exactProject.name];
    queryScope.scopeSource = 'explicit_project';
    queryScope.depts = [];
    planResult.reasoning_framework = [
      planResult.reasoning_framework,
      `系统实体校验：用户本轮明确命中项目/成本池「${exactProject.name}」，项目优先于部门子串，执行范围按 explicit_project 项目白名单收窄。`,
    ].filter(Boolean).join('\n');
    logger.info(`${opts.logPrefix || '[EntityScope]'} 显式项目命中: ${exactProject.name}`);
    return planResult;
  }

  const beforeDepts = queryScope.depts.map(v => String(v || '').trim()).filter(Boolean);
  if (beforeDepts.length === 0) return planResult;
  const validDepts = beforeDepts.filter(isKnownDept);
  const invalidDepts = beforeDepts.filter(dept => !isKnownDept(dept));
  queryScope.depts = validDepts;
  if (invalidDepts.length === 0) return planResult;

  const candidates = findProjectCandidates(message, { limit: 5, minScore: 65 });
  const clarification = _buildEntityClarification({ message, invalidDepts, candidates });
  planResult._entityClarification = clarification;
  planResult.reasoning_framework = [
    planResult.reasoning_framework,
    `系统实体校验：Planner 输出的部门 [${invalidDepts.join('、')}] 不存在于当前数据实体索引，禁止按该部门过滤执行，需先澄清。`,
  ].filter(Boolean).join('\n');
  logger.info(`${opts.logPrefix || '[EntityScope]'} 部门不存在，触发澄清: invalid=[${invalidDepts.join(',')}] candidates=[${candidates.map(c => c.name).join(',')}]`);
  return planResult;
}

function resetForTest() {
  cached = null;
}

module.exports = {
  normalizeName,
  buildEntityIndex,
  findProjectCandidates,
  resolveExplicitProject,
  isKnownDept,
  applyEntityScopeGuards,
  resetForTest,
};
