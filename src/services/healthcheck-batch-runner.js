'use strict';

const fs = require('fs');
const path = require('path');
const lark = require('@larksuiteoapi/node-sdk');
const config = require('../../config');
const client = require('../clients/feishu-client');
const cardStream = require('../clients/feishu-card-stream');
const localMemoryStore = require('../cache/local-memory-store');
const localCacheSyncer = require('../cache/local-cache-syncer');
const memoryManager = require('./memory-manager');
const permissionManager = require('../permissions/permission-manager');
const deptNormalizer = require('../permissions/dept-normalizer');
const financeTools = require('../tools/finance-tools');
const FM = require('../utils/field-mapping');
const logger = require('../utils/logger');
const { renderHealthcheckMarkdown } = require('./healthcheck-template-renderer');

const TARGET_VIEW_NAME = 'Grid View --项目经理及总监';
const TARGET_CHAT_NAME = '组织 Agent 沟通';
const QUESTION = '帮我做一次本季度经营体检';
const PLANNED_TABLES = new Set([
  'profile',
  'employeeProfile',
  'projectMaster',
  'rollbackProjectActual',
  'actualProject',
  'actualDept',
  'actualWorktime',
  'budgetWorktime',
  'budgetProject',
  'budgetDept',
  'cashflow',
  'trendTeam',
  'riskAlert',
]);

const sdkClient = new lark.Client({
  appId: config.APP_ID,
  appSecret: config.APP_SECRET,
});

const jobs = new Map();
let runningJobId = null;

function ensureLogDir() {
  const dir = path.resolve(__dirname, '..', '..', 'logs', 'batch-healthcheck');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function appendJsonl(batchId, row) {
  const file = path.join(ensureLogDir(), `${batchId}.jsonl`);
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
  return file;
}

function maskOpenId(openId) {
  if (!openId || openId.length < 12) return openId || '';
  return `${openId.slice(0, 6)}...${openId.slice(-6)}`;
}

function maskChatId(chatId) {
  if (!chatId || chatId.length < 12) return chatId || '';
  return `${chatId.slice(0, 5)}...${chatId.slice(-6)}`;
}

function asText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    return value.map(item => asText(item && (item.text || item.name || item.value || item))).filter(Boolean).join('、');
  }
  if (typeof value === 'object') return String(value.text || value.name || value.value || '').trim();
  return String(value).trim();
}

function rowYm(value) {
  const { year, month } = FM.parseMonth4(value);
  if (!year || !month) return 0;
  return (year % 100) * 100 + month;
}

const ROLLBACK_PROJECT_FIELDS = {
  project: ['是否交付项目', '项目名', '项目名称', '项目名称（管报）', '项目'],
  dept: ['一级部门', '部门', '所属部门'],
  month: ['回滚月份', '月份', '年月'],
  revenue: ['履约收入', '回滚履约收入'],
  cost: ['履约成本', '回滚履约成本'],
  profit: ['履约利润', '回滚履约利润'],
};

function firstField(fields, names) {
  const list = Array.isArray(names) ? names : [names];
  for (const name of list) {
    if (fields && fields[name] != null && fields[name] !== '') return fields[name];
  }
  return null;
}

function fieldText(fields, names) {
  return asText(firstField(fields, names));
}

function fieldNum(fields, names) {
  const raw = firstField(fields, names);
  if (raw == null || raw === '') return 0;
  const n = Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function defaultCutoffYm(now = new Date()) {
  const yy = now.getFullYear() % 100;
  const mm = now.getMonth() + 1;
  return mm === 1 ? ((yy - 1) * 100 + 12) : (yy * 100 + (mm - 1));
}

function isAuditRowInScopePeriod(fields, monthField, scope) {
  const ym = rowYm(fields[monthField]);
  if (!ym) return false;
  const period = scope && scope.period;
  if (typeof period === 'object' && period.year && period.month) {
    return ym === ((period.year % 100) * 100 + period.month);
  }
  const cutoffYm = Number(scope && scope.cutoffYm) || defaultCutoffYm();
  if (ym > cutoffYm) return false;
  const year = Number((scope && scope.periodYear) || new Date().getFullYear());
  return Math.floor(ym / 100) === (year % 100);
}

function buildAuditAllowedProjects(scope, memory) {
  const allowed = new Set((scope && scope.projectKeys || []).filter(Boolean));
  const add = (value) => {
    const text = asText(value);
    if (text) allowed.add(text);
  };

  // memory 已经走过实际链路的权限过滤。这里把过滤后项目主档里的项目键纳入审计，
  // 与 memory-manager 的“部门负责人/测试人员 → 部门项目扩展”口径对齐。
  for (const row of (memory && memory.projectMaster) || []) {
    const fields = row.fields || {};
    add(fields[FM.PROJECT_NAME_UNIQUE_FIELDS.PROJECT_26]);
    add(fields[FM.PROJECT_NAME_UNIQUE_FIELDS.PROJECT_NAME_MR]);
  }

  // 兼容项目主档缺行但部门直查已命中项目层/预算层的情况：只把“行部门已授权”的
  // 项目补进集合，用于放行同一项目在公司层面/跨部门账行上的记录。
  const allowedDepts = new Set((scope && scope.depts || []).filter(Boolean));
  const addDeptScopedProject = (rows, projectField, deptField) => {
    for (const row of rows || []) {
      const fields = row.fields || {};
      if (!allowedDepts.has(FM.str(fields, deptField))) continue;
      add(fields[projectField]);
    }
  };
  const addDeptScopedProjectGeneric = (rows, projectFields, deptFields) => {
    for (const row of rows || []) {
      const fields = row.fields || {};
      if (!allowedDepts.has(fieldText(fields, deptFields))) continue;
      add(firstField(fields, projectFields));
    }
  };
  addDeptScopedProject(memory && memory.projectMonthly, FM.ACTUAL_PROJECT_FIELDS.PROJECT_NAME, FM.ACTUAL_PROJECT_FIELDS.DEPT);
  addDeptScopedProject(memory && memory.actualProject, FM.ACTUAL_PROJECT_FIELDS.PROJECT_NAME, FM.ACTUAL_PROJECT_FIELDS.DEPT);
  addDeptScopedProject(memory && memory.budgetProject, FM.BUDGET_PROJECT_FIELDS.PROJECT_NAME, FM.BUDGET_PROJECT_FIELDS.DEPT);
  addDeptScopedProjectGeneric(memory && memory.rollbackProjectActual, ROLLBACK_PROJECT_FIELDS.project, ROLLBACK_PROJECT_FIELDS.dept);

  return allowed;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '');
}

function isGroupChat(chat) {
  if (!chat) return false;
  if (chat.chat_mode === 'p2p') return false;
  if (chat.chat_mode === 'group') return true;
  return String(chat.chat_id || '').startsWith('oc_');
}

async function ensureActualCacheReady() {
  if (!config.LOCAL_MEMORY_CACHE_ENABLED) {
    throw new Error('LOCAL_MEMORY_CACHE_ENABLED 未开启，不能执行实际链路全量缓存批量推送');
  }
  if (config.LOCAL_MEMORY_CACHE_REMOTE_FALLBACK) {
    throw new Error('LOCAL_MEMORY_CACHE_REMOTE_FALLBACK 已开启，验收期不允许核心表远端回退');
  }
  if (!localMemoryStore.isReady()) {
    logger.warn('[HealthcheckBatch] activeCache 未就绪，尝试在当前进程内 bootstrap');
    await localCacheSyncer.bootstrap({ reason: 'healthcheck-batch-group-review' });
  }
  const status = localMemoryStore.getStatus();
  if (!status.ready) throw new Error('activeCache 仍未就绪，停止批量推送');
  if (!status.metadata || !status.metadata.projectNameMrOptionReady) {
    throw new Error('activeCache 缺少项目名称（管报）options 元数据，停止批量推送');
  }
  if (Array.isArray(status.syncErrors) && status.syncErrors.some(item => item.priority === 'P0' || item.required)) {
    throw new Error(`activeCache 存在核心表同步错误: ${status.syncErrors.map(e => `${e.tableKey}:${e.error}`).join('；')}`);
  }
  return status;
}

async function listBotChats() {
  const chats = [];
  let pageToken = '';
  do {
    let url = '/open-apis/im/v1/chats?page_size=50';
    if (pageToken) url += `&page_token=${pageToken}`;
    const res = await client.get(url);
    if (res.code !== 0) {
      throw new Error(`列出机器人所在群失败: code=${res.code} msg=${res.msg}`);
    }
    chats.push(...((res.data && res.data.items) || []));
    pageToken = res.data && res.data.has_more ? res.data.page_token : '';
    if (pageToken) await sleep(200);
  } while (pageToken);
  return chats;
}

async function resolveTargetChat() {
  const groups = (await listBotChats()).filter(isGroupChat);
  const target = normalizeName(TARGET_CHAT_NAME);
  const matches = groups.filter(chat => normalizeName(chat.name || chat.description || '') === target);
  if (matches.length !== 1) {
    const candidates = groups
      .map(chat => `${chat.name || chat.description || '(无名群)'}(${chat.chat_id})`)
      .join('；');
    const matched = matches
      .map(chat => `${chat.name || chat.description || '(无名群)'}(${chat.chat_id})`)
      .join('；') || '无';
    throw new Error(`无法唯一确定目标群「${TARGET_CHAT_NAME}」。精确匹配结果: ${matched}。机器人所在群: ${candidates}`);
  }
  const chatName = matches[0].name || matches[0].description || matches[0].chat_id;
  if (normalizeName(chatName).includes(normalizeName('组织部-Agent'))) {
    throw new Error(`命中禁止群「${chatName}」，停止推送`);
  }
  return { chatId: matches[0].chat_id, chatName };
}

async function findTargetViewId() {
  const tableId = config.TABLES.EMPLOYEE;
  const base = `/open-apis/bitable/v1/apps/${config.BITABLE_APP_TOKEN}/tables/${tableId}`;
  const res = await client.get(`${base}/views?page_size=100`);
  if (res.code !== 0) {
    throw new Error(`读取视图失败: code=${res.code} msg=${res.msg}`);
  }
  const view = ((res.data && res.data.items) || []).find(item => item.view_name === TARGET_VIEW_NAME);
  if (!view) {
    const names = ((res.data && res.data.items) || []).map(item => item.view_name).join('、');
    throw new Error(`找不到视图「${TARGET_VIEW_NAME}」，当前视图: ${names}`);
  }
  return view.view_id;
}

async function listRecipientsFromView() {
  const tableId = config.TABLES.EMPLOYEE;
  const viewId = await findTargetViewId();
  const base = `/open-apis/bitable/v1/apps/${config.BITABLE_APP_TOKEN}/tables/${tableId}/records`;
  const all = [];
  let pageToken = '';

  do {
    const qs = new URLSearchParams({ page_size: '500', view_id: viewId });
    if (pageToken) qs.set('page_token', pageToken);
    const res = await client.get(`${base}?${qs.toString()}`);
    if (res.code !== 0) {
      throw new Error(`读取员工视图记录失败: code=${res.code} msg=${res.msg}`);
    }
    all.push(...((res.data && res.data.items) || []));
    pageToken = res.data && res.data.has_more ? res.data.page_token : '';
  } while (pageToken);

  const recipients = [];
  const skipped = [];
  const seen = new Set();
  for (const record of all) {
    const fields = record.fields || {};
    const name = asText(fields['姓名']);
    const openId = asText(fields['飞书OpenID']);
    if (!name || !openId) {
      skipped.push({ name: name || '(无姓名)', reason: '缺少姓名或飞书OpenID' });
      continue;
    }
    if (seen.has(openId)) {
      skipped.push({ name, reason: '重复 OpenID' });
      continue;
    }
    seen.add(openId);
    recipients.push({ name, openId });
  }

  return { viewId, recipients, skipped };
}

function assertMemoryComplete(memory) {
  const trace = memory && memory._traceMeta ? memory._traceMeta : null;
  const errors = trace && Array.isArray(trace.fetchErrors) ? trace.fetchErrors : [];
  if (errors.length === 0) return;
  const coreKeys = new Set(['projectMaster', 'rollbackProjectActual', 'actualProject', 'actualDept', 'budgetProject', 'budgetDept', 'cashflow']);
  const coreErrors = errors.filter(error => coreKeys.has(error.tableKey || error.table || error.source));
  if (coreErrors.length === 0) return;
  const summary = coreErrors
    .slice(0, 5)
    .map(error => `${error.tableKey || error.table || error.source || 'unknown'}: ${error.message || error.error || String(error)}`)
    .join('；');
  throw new Error(`核心数据加载不完整，停止推送: ${summary}`);
}

function assertComplete(results) {
  const incomplete = Object.entries(results)
    .filter(([, value]) => value && value.incomplete)
    .map(([key, value]) => `${key}: ${value.message || 'incomplete'}`);
  if (incomplete.length > 0) {
    throw new Error(`工具结果不完整，停止推送: ${incomplete.join('；')}`);
  }
  if (results.healthCheck && results.healthCheck.empty) {
    throw new Error(`healthCheck 为空，停止推送: ${results.healthCheck.message || ''}`);
  }
}

function auditRecipientResult(recipient, scope, memory, results) {
  const allowedProjects = buildAuditAllowedProjects(scope, memory);
  const allowedDepts = new Set((scope.depts || []).filter(Boolean));
  const allowedDeptTokens = new Set((scope.depts || []).filter(Boolean).map(dept => deptNormalizer.normalizeDeptToken(dept)));
  const isGlobal = !!scope.isGlobal;
  const issues = [];
  const isDeptAllowed = (dept) => {
    const raw = asText(dept);
    if (!raw) return false;
    return allowedDepts.has(raw) || allowedDeptTokens.has(deptNormalizer.normalizeDeptToken(raw));
  };

  const checkProjectRows = (label, rows, projectField, deptField) => {
    if (isGlobal) return;
    for (const row of rows || []) {
      const fields = row.fields || {};
      const project = Array.isArray(projectField) ? fieldText(fields, projectField) : FM.str(fields, projectField);
      const dept = Array.isArray(deptField) ? fieldText(fields, deptField) : FM.str(fields, deptField);
      if (isDeptAllowed(dept) || allowedProjects.has(project)) continue;
      issues.push(`${label} 出现授权外项目: ${project || '(空项目)'} / ${dept || '(空部门)'}`);
      if (issues.length >= 10) return;
    }
  };

  checkProjectRows('actualProject', memory.actualProject, FM.ACTUAL_PROJECT_FIELDS.PROJECT_NAME, FM.ACTUAL_PROJECT_FIELDS.DEPT);
  checkProjectRows('rollbackProjectActual', memory.rollbackProjectActual, ROLLBACK_PROJECT_FIELDS.project, ROLLBACK_PROJECT_FIELDS.dept);
  checkProjectRows('budgetProject', memory.budgetProject, FM.BUDGET_PROJECT_FIELDS.PROJECT_NAME, FM.BUDGET_PROJECT_FIELDS.DEPT);
  checkProjectRows('cashflow', memory.invoices, FM.INVOICE_FIELDS.PROJECT_KEY, FM.INVOICE_FIELDS.DEPT);

  const useRollbackMetrics = results.healthCheck
    && results.healthCheck.actualCaliber === 'rollback'
    && memory.rollbackProjectActual
    && memory.rollbackProjectActual.length > 0;
  const metricRows = useRollbackMetrics
    ? memory.rollbackProjectActual
    : ((memory.projectMonthly && memory.projectMonthly.length > 0) ? memory.projectMonthly : (memory.actualProject || []));
  const metricMonthField = useRollbackMetrics ? ROLLBACK_PROJECT_FIELDS.month : FM.ACTUAL_PROJECT_FIELDS.MONTH;
  const periodMetricRows = metricRows.filter(row => {
    const fields = row.fields || {};
    if (useRollbackMetrics) {
      const ym = rowYm(firstField(fields, ROLLBACK_PROJECT_FIELDS.month));
      if (!ym) return false;
      const cutoffYm = Number(scope && scope.cutoffYm) || defaultCutoffYm();
      if (ym > cutoffYm) return false;
      const year = Number((scope && scope.periodYear) || new Date().getFullYear());
      return Math.floor(ym / 100) === (year % 100);
    }
    return isAuditRowInScopePeriod(fields, metricMonthField, scope);
  });
  const metricSum = metricRows.reduce((acc, row) => {
    const fields = row.fields || {};
    acc.revenue += useRollbackMetrics ? fieldNum(fields, ROLLBACK_PROJECT_FIELDS.revenue) : FM.num(fields, FM.ACTUAL_PROJECT_FIELDS.REVENUE);
    acc.cost += useRollbackMetrics ? fieldNum(fields, ROLLBACK_PROJECT_FIELDS.cost) : FM.num(fields, FM.ACTUAL_PROJECT_FIELDS.COST);
    acc.profit += useRollbackMetrics ? fieldNum(fields, ROLLBACK_PROJECT_FIELDS.profit) : FM.num(fields, FM.ACTUAL_PROJECT_FIELDS.PROFIT);
    return acc;
  }, { revenue: 0, cost: 0, profit: 0 });
  const periodMetricSum = periodMetricRows.reduce((acc, row) => {
    const fields = row.fields || {};
    acc.revenue += useRollbackMetrics ? fieldNum(fields, ROLLBACK_PROJECT_FIELDS.revenue) : FM.num(fields, FM.ACTUAL_PROJECT_FIELDS.REVENUE);
    acc.cost += useRollbackMetrics ? fieldNum(fields, ROLLBACK_PROJECT_FIELDS.cost) : FM.num(fields, FM.ACTUAL_PROJECT_FIELDS.COST);
    acc.profit += useRollbackMetrics ? fieldNum(fields, ROLLBACK_PROJECT_FIELDS.profit) : FM.num(fields, FM.ACTUAL_PROJECT_FIELDS.PROFIT);
    return acc;
  }, { revenue: 0, cost: 0, profit: 0 });
  const metrics = (results.healthCheck && results.healthCheck.profitMetrics) || {};
  const metricDiff = {
    revenue: Math.round(Number(metrics.revenue || 0) - periodMetricSum.revenue),
    cost: Math.round(Number(metrics.cost || 0) - periodMetricSum.cost),
    profit: Math.round(Number(metrics.profit || 0) - periodMetricSum.profit),
  };
  for (const [key, value] of Object.entries(metricDiff)) {
    if (Math.abs(value) > 1) issues.push(`healthCheck ${key} 与当前期间 ${useRollbackMetrics ? 'rollbackProjectActual' : (memory.projectMonthly && memory.projectMonthly.length > 0 ? 'projectMonthly' : 'actualProject')} 聚合不一致: diff=${value}`);
  }
  const ok = issues.length === 0;
  return {
    ok,
    issues,
    checkedAt: new Date().toISOString(),
    actualProjectRows: memory.actualProject ? memory.actualProject.length : 0,
    rollbackProjectActualRows: memory.rollbackProjectActual ? memory.rollbackProjectActual.length : 0,
    metricSource: useRollbackMetrics ? 'rollbackProjectActual' : (memory.projectMonthly && memory.projectMonthly.length > 0 ? 'projectMonthly' : 'actualProject'),
    metricRows: metricRows.length,
    periodMetricRows: periodMetricRows.length,
    allowedProjectCount: allowedProjects.size,
    allowedDeptCount: allowedDepts.size,
    metricSum: {
      revenue: Math.round(metricSum.revenue),
      cost: Math.round(metricSum.cost),
      profit: Math.round(metricSum.profit),
    },
    periodMetricSum: {
      revenue: Math.round(periodMetricSum.revenue),
      cost: Math.round(periodMetricSum.cost),
      profit: Math.round(periodMetricSum.profit),
    },
    healthCheckMetrics: {
      revenue: Math.round(Number(metrics.revenue || 0)),
      cost: Math.round(Number(metrics.cost || 0)),
      profit: Math.round(Number(metrics.profit || 0)),
    },
    metricDiff,
    note: `经营体检指标与当前 memory 聚合对数完成: ${recipient.name}`,
  };
}

function assertScopePushable(recipient, scope) {
  if (!scope || scope.isGlobal) return;
  const integrity = scope.permissionIntegrity || {};
  if (integrity.visibleProjectRangeResolved === false) {
    throw new Error(`可见项目范围存在无法解析的 option ID: ${(integrity.unresolvedOptionIds || []).join(',')}`);
  }
  const depts = Array.isArray(scope.depts) ? scope.depts.filter(Boolean) : [];
  const projects = Array.isArray(scope.projectKeys) ? scope.projectKeys.filter(Boolean) : [];
  if (depts.length === 0 && projects.length === 0) {
    throw new Error(`${recipient.name} 非全局/非部门负责人且授权项目为空，停止推送`);
  }
}

function deptTypeText(value) {
  return asText(value)
    .split(/[、,，/]/)
    .map(item => item.trim())
    .filter(Boolean)
    .join('、');
}

function isBusinessDeptType(value) {
  const text = deptTypeText(value);
  const parts = text.split('、').filter(Boolean);
  return parts.length === 1 && parts[0] === '业务';
}

function buildDeptTypeIndex(memory) {
  const map = new Map();
  const conflicts = [];
  const addRows = (rows, fields, source, overwrite = false) => {
    for (const row of rows || []) {
      const rowFields = row.fields || {};
      const dept = asText(rowFields[fields.DEPT]);
      const type = deptTypeText(rowFields[fields.DEPT_TYPE]);
      if (!dept || !type) continue;
      const existing = map.get(dept);
      if (existing && existing.type !== type) {
        conflicts.push({ dept, existingType: existing.type, type, existingSource: existing.source, source });
        if (!overwrite) continue;
      }
      if (!existing || overwrite) map.set(dept, { type, source });
    }
  };

  addRows(memory && memory.actualDept, FM.ACTUAL_DEPT_FIELDS, 'ACTUAL_DEPT', true);
  addRows(memory && memory.budgetDept, FM.BUDGET_DEPT_FIELDS, 'BUDGET_DEPT', false);
  return { map, conflicts };
}

function filterGlobalBusinessReceivableMemory(memory, scope, opts = {}) {
  if (!opts.businessReceivablesOnlyForGlobal || !scope || !scope.isGlobal) {
    return { memory, meta: null };
  }

  const invoices = Array.isArray(memory && memory.invoices) ? memory.invoices : [];
  const { map: deptTypeByDept, conflicts } = buildDeptTypeIndex(memory || {});
  const kept = [];
  const excludedByDeptType = {};
  const excludedByDept = {};

  for (const row of invoices) {
    const fields = row.fields || {};
    const dept = asText(fields[FM.INVOICE_FIELDS.DEPT]);
    const mapped = deptTypeByDept.get(dept);
    const deptType = mapped ? mapped.type : '无映射';
    if (isBusinessDeptType(deptType)) {
      kept.push(row);
      continue;
    }
    excludedByDeptType[deptType] = (excludedByDeptType[deptType] || 0) + 1;
    excludedByDept[dept || '(空部门)'] = (excludedByDept[dept || '(空部门)'] || 0) + 1;
  }

  const meta = {
    enabled: true,
    policy: 'global-business-dept-type-only',
    sourceTables: ['ACTUAL_DEPT', 'BUDGET_DEPT'],
    includedDeptTypes: ['业务'],
    beforeCount: invoices.length,
    afterCount: kept.length,
    excludedCount: invoices.length - kept.length,
    excludedByDeptType,
    excludedByDept,
    deptTypeConflictCount: conflicts.length,
    deptTypeConflicts: conflicts.slice(0, 10),
  };

  return {
    memory: {
      ...memory,
      invoices: kept,
      _receivableDeptTypeFilter: meta,
    },
    meta,
  };
}

function buildBookedActualSupplement(memory, execScope) {
  const bookedScope = {
    ...execScope,
    actualCaliber: 'booked',
  };
  const healthCheck = financeTools.healthCheck(memory, bookedScope);
  const profitOverview = financeTools.profitOverview(memory, bookedScope);
  const projectProfitByName = {};
  for (const project of (profitOverview.projects || [])) {
    const name = project.key || project.name;
    if (!name) continue;
    projectProfitByName[name] = {
      revenue: project.revenue,
      cost: project.cost,
      profit: project.profit,
      profitRate: project.profitRate ?? project.rate,
    };
  }
  return {
    actualCaliber: 'booked',
    scope: bookedScope,
    healthCheck,
    profitOverview,
    projectProfitByName,
  };
}

async function buildHealthcheckForRecipient(recipient, opts = {}) {
  const scope = await permissionManager.resolveScope(recipient.name, { maxDepth: 99 });
  assertScopePushable(recipient, scope);
  const memory = await memoryManager.getUserMemory(recipient.openId, {
    userName: recipient.name,
    question: QUESTION,
    plannedTables: PLANNED_TABLES,
    scope,
    forceRefresh: true,
  });
  assertMemoryComplete(memory);

  const execScope = {
    ...scope,
    empName: recipient.name,
    role: scope.roleType || scope.role || '员工',
    question: QUESTION,
    period: 'ytd',
    periodYear: new Date().getFullYear(),
  };
  const receivableFilter = filterGlobalBusinessReceivableMemory(memory, execScope, opts);
  const reportMemory = receivableFilter.memory;
  const results = {
    healthCheck: financeTools.healthCheck(reportMemory, execScope),
    profitTrend: financeTools.profitTrend(reportMemory, execScope),
    receivables: financeTools.receivables(reportMemory, execScope, {
      receivableRevenueTypeFilter: opts.receivableRevenueTypeFilter === true,
    }),
    costBreakdown: financeTools.costBreakdown(reportMemory, execScope),
    budgetComparison: financeTools.budgetComparison(reportMemory, execScope),
  };
  if (receivableFilter.meta) {
    results.healthCheck._receivableDeptTypeFilter = receivableFilter.meta;
    results.receivables._deptTypeFilter = receivableFilter.meta;
  }
  results.bookedActual = buildBookedActualSupplement(reportMemory, execScope);
  assertComplete(results);

  const auditResult = auditRecipientResult(recipient, execScope, reportMemory, results);
  if (!auditResult.ok) {
    throw new Error(`权限审计失败: ${auditResult.issues.join('；')}`);
  }

  const generatedAt = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const markdown = renderHealthcheckMarkdown({
    recipientName: recipient.name,
    scope: execScope,
    results,
    generatedAt,
    question: QUESTION,
  });

  return {
    scope: execScope,
    memory: reportMemory,
    memoryTrace: memory._traceMeta || null,
    results,
    markdown,
    generatedAt,
    auditResult,
    receivableDeptTypeFilter: receivableFilter.meta,
  };
}

async function sendCardkitMarkdown(chatId, markdown, title) {
  const session = await cardStream.createStreamSession(sdkClient, {
    chatId,
    title,
    finishTitle: title,
    finishTemplate: 'blue',
  });
  if (!session) {
    throw new Error('CardKit 长连接同款卡片创建或发送失败，停止推送。');
  }
  await session.finish(markdown);
  return session;
}

function buildBaseLog(recipient, opts, built, cacheStatus, startedAt) {
  return {
    batchId: opts.batchId,
    mode: 'group_review',
    recipientName: recipient.name,
    openIdMasked: maskOpenId(recipient.openId),
    question: QUESTION,
    cacheMode: 'actual_active_cache',
    cacheRunId: cacheStatus.runId,
    cacheCutoff: cacheStatus.cutoffText,
    cacheRows: cacheStatus.rows,
    remoteFallbackUsed: !!config.LOCAL_MEMORY_CACHE_REMOTE_FALLBACK,
    scope: {
      roleType: built.scope.roleType,
      dataScope: built.scope.dataScope,
      depts: built.scope.depts || [],
      homeDepts: built.scope.homeDepts || [],
      projectKeys: built.scope.projectKeys || [],
      responsibleProjectKeys: built.scope.responsibleProjectKeys || [],
      testerOverride: !!built.scope.testerOverride,
      permissionIntegrity: built.scope.permissionIntegrity || null,
    },
    rowCounts: built.memoryTrace && built.memoryTrace.rowCounts ? built.memoryTrace.rowCounts : null,
    fetchErrors: built.memoryTrace && Array.isArray(built.memoryTrace.fetchErrors)
      ? built.memoryTrace.fetchErrors
      : [],
    auditResult: built.auditResult,
    markdownLength: built.markdown.length,
    generatedAt: built.generatedAt,
    startedAt,
  };
}

async function runGroupReview(job, opts = {}) {
  const cacheStatus = await ensureActualCacheReady();
  const targetChat = await resolveTargetChat();
  const { recipients, skipped, viewId } = await listRecipientsFromView();
  const offset = Math.max(0, Number(opts.offset) || 0);
  const limit = Math.max(0, Number(opts.limit) || 0);
  const delayMs = Math.max(0, Number(opts.delayMs) || 2500);
  const stopOnFailure = opts.stopOnFailure !== false;
  const sliced = recipients.slice(offset, limit ? offset + limit : undefined);
  if (sliced.length === 0) {
    throw new Error(`群验收目标名单为空：offset=${offset} limit=${limit}`);
  }

  const summary = {
    jobId: job.jobId,
    batchId: job.batchId,
    targetViewName: TARGET_VIEW_NAME,
    viewId,
    chatName: targetChat.chatName,
    chatIdMasked: maskChatId(targetChat.chatId),
    cacheMode: 'actual_active_cache',
    cacheRunId: cacheStatus.runId,
    cacheCutoff: cacheStatus.cutoffText,
    totalCandidates: recipients.length,
    skippedRecipients: skipped,
    selectedCount: sliced.length,
    offset,
    limit,
    success: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    logFile: path.join(ensureLogDir(), `${job.batchId}.jsonl`),
    results: [],
  };
  job.summary = summary;
  appendJsonl(job.batchId, { type: 'start', ...summary });

  for (let idx = 0; idx < sliced.length; idx++) {
    const recipient = sliced[idx];
    const sequence = offset + idx + 1;
    const startedAt = new Date().toISOString();
    job.current = { sequence, name: recipient.name, startedAt };
    try {
      const built = await buildHealthcheckForRecipient(recipient);
      const baseLog = buildBaseLog(recipient, { batchId: job.batchId }, built, cacheStatus, startedAt);
      const title = `经营体检报告 - ${recipient.name} (${sequence}/${recipients.length})`;
      const session = await sendCardkitMarkdown(targetChat.chatId, built.markdown, title);
      const row = {
        ...baseLog,
        delivery: 'group_review',
        chatName: targetChat.chatName,
        chatIdMasked: maskChatId(targetChat.chatId),
        sequence,
        status: 'success',
        transport: 'cardkit_stream',
        send: {
          code: 0,
          msg: 'success',
          messageId: session.messageId,
          cardId: session.cardId,
        },
        finishedAt: new Date().toISOString(),
      };
      appendJsonl(job.batchId, row);
      summary.success++;
      summary.results.push({
        name: recipient.name,
        status: 'success',
        messageId: session.messageId,
        auditOk: built.auditResult.ok,
      });
      logger.info(`[HealthcheckBatch] ${recipient.name} 推送并对数完成 (${sequence}/${recipients.length})`);
    } catch (error) {
      const row = {
        batchId: job.batchId,
        mode: 'group_review',
        delivery: 'group_review',
        chatName: targetChat.chatName,
        chatIdMasked: maskChatId(targetChat.chatId),
        sequence,
        recipientName: recipient.name,
        openIdMasked: maskOpenId(recipient.openId),
        status: 'failed',
        error: error && error.message ? error.message : String(error),
        startedAt,
        finishedAt: new Date().toISOString(),
      };
      appendJsonl(job.batchId, row);
      summary.failed++;
      summary.results.push({ name: recipient.name, status: 'failed', error: row.error });
      logger.error(`[HealthcheckBatch] ${recipient.name} 失败: ${row.error}`);
      if (stopOnFailure) {
        throw new Error(`群验收在 ${recipient.name} 处停止: ${row.error}`);
      }
    }

    job.summary = summary;
    if (idx < sliced.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  summary.finishedAt = new Date().toISOString();
  appendJsonl(job.batchId, { type: 'summary', ...summary });
  job.summary = summary;
  return summary;
}

function startGroupReview(opts = {}) {
  if (runningJobId) {
    const running = jobs.get(runningJobId);
    if (running && running.status === 'running') {
      throw new Error(`已有经营体检群验收任务运行中: ${runningJobId}`);
    }
  }
  const jobId = `healthcheck-group-${Date.now()}`;
  const batchId = opts.batchId || `healthcheck-actual-cache-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const job = {
    jobId,
    batchId,
    status: 'running',
    createdAt: new Date().toISOString(),
    summary: null,
    current: null,
    error: null,
  };
  jobs.set(jobId, job);
  runningJobId = jobId;
  runGroupReview(job, opts)
    .then(summary => {
      job.status = summary.failed > 0 ? 'completed_with_failures' : 'completed';
      job.finishedAt = new Date().toISOString();
    })
    .catch(error => {
      job.status = 'failed';
      job.error = error && error.message ? error.message : String(error);
      job.finishedAt = new Date().toISOString();
      appendJsonl(batchId, { type: 'fatal', jobId, batchId, error: job.error, finishedAt: job.finishedAt });
      logger.error(`[HealthcheckBatch] 任务失败: ${job.error}`);
    })
    .finally(() => {
      if (runningJobId === jobId) runningJobId = null;
    });
  return job;
}

function getJob(jobId) {
  if (!jobId) return null;
  return jobs.get(jobId) || null;
}

module.exports = {
  startGroupReview,
  getJob,
  _private: {
    ensureActualCacheReady,
    listRecipientsFromView,
    buildHealthcheckForRecipient,
    buildBookedActualSupplement,
    filterGlobalBusinessReceivableMemory,
    auditRecipientResult,
    buildAuditAllowedProjects,
  },
};
