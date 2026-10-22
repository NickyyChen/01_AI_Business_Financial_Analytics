const config = require('../../config');
const client = require('../clients/feishu-client');
const timeQuery = require('../skills/time-query-skill');
const permManager = require('../permissions/permission-manager');
const logger = require('../utils/logger');
const FM = require('../utils/field-mapping');
const { DELIVERY_ACTIVE_STATUSES } = require('../config/finance-calibers');
const {
  CATALOG_MODULE_REQ,
  selectTablesForQuestion: baseSelectTablesForQuestion,
} = require('./catalog');
const {
  _escapeFilter,
  _mergeByRecordId,
  _listRecordsWithRetry,
  _runWithLimit,
  fetchProfile,
  fetchUserRecords,
  fetchProjectStaffing,
  fetchWorktimeByDepts,
  fetchProjectMasterByPerson,
  fetchProjectsByKeys,
  fetchProjectTeamByKeys,
  fetchUserRiskAlerts,
  fetchAllRecords,
  fetchEmployeeProfile,
  fetchUserReviews,
} = require('./fetchers');
const {
  _getCached,
  _setCache,
  _getCachedSections,
  invalidateUserCache,
} = require('./cache');
const {
  _tagProjectMasterSource,
  _applyManagerCompanyOverlay,
} = require('./post-process');

function createEmptyMemory() {
  return {
    profile: null,
    meetings: [],
    calendar: [],
    chats: [],
    workItems: [],
    projectStaffing: [],
    projectMaster: [],
    projectMonthly: [],
    projectTeamStaffing: [], // 项目团队投入（所有成员）
    performanceTargets: [],
    riskControlRules: [],
    riskAlerts: [], // 当日风险告警快照（来自 USER_RISK_ALERT）
    trends: null, // 时序趋势分析（来自 PERSONAL_TREND / BUSINESS_TREND）
    employeeProfile: null, // 🔵 员工表：技能标签 + AI能力地图
    reviews: [], // 🔵 复盘表：该员工相关的项目复盘
    invoices: [], // 开票回款计划
    actualProject: [], // 实际：项目层（成本明细+风险运算基础）
    actualDept: [], // 实际：部门层
    pendingPayments: [], // 待认领款
    budgetDept: [], // 预算：部门层
    budgetProject: [], // 预算：项目层
    vendorContracts: [], // 供应商合同管理
    talentPool: [], // 活水登记表
    deptYoy: [], // 部门层同比
    companyYoy: [], // 公司层面同比
    revenueMom: [], // 履约收入&利润环比
    rollbackProjectActual: [], // 项目层-回滚实际
    customerProjects: [], // 客户经营分析（项目名称唯一值表按部门过滤）
    presaleProjects: [], // 🟢 售前项目
    signDeliveries: [], // 🟩 签约交付
    biddings: [], // ⭕ 招投标
    invoiceApply: [], // 发票申请 初始化+自动同步
    budgetWorktime: [], // 预算：26年工时（工时预算）
  };
}

function _cloneTableSet(value) {
  if (!value) return new Set();
  if (value instanceof Set) return new Set(value);
  if (Array.isArray(value)) return new Set(value);
  return new Set([value]);
}

function _uniqNonEmpty(list) {
  return [...new Set((Array.isArray(list) ? list : [])
    .map(value => String(value || '').trim())
    .filter(Boolean))];
}

function _countTraceRows(memory, key) {
  switch (key) {
    case 'profile':
      return memory.profile ? 1 : 0;
    case 'employeeProfile':
      return memory.employeeProfile ? 1 : 0;
    case 'meetings':
      return memory.meetings.length;
    case 'calendar':
      return memory.calendar.length;
    case 'workItems':
      return memory.workItems.length;
    case 'projectMaster':
      return memory.projectMaster.length;
    case 'actualProject':
      return memory.actualProject.length;
    case 'actualDept':
      return memory.actualDept.length;
    case 'actualWorktime':
      return Math.max(memory.projectStaffing.length, memory.projectTeamStaffing.length);
    case 'budgetProject':
      return Math.max(memory.performanceTargets.length, memory.budgetProject.length);
    case 'budgetDept':
      return memory.budgetDept.length;
    case 'budgetWorktime':
      return memory.budgetWorktime.length;
    case 'cashflow':
      return memory.invoices.length;
    case 'pendingPayment':
      return memory.pendingPayments.length;
    case 'invoiceApply':
      return memory.invoiceApply.length;
    case 'presale':
      return memory.presaleProjects.length;
    case 'bidding':
      return memory.biddings.length;
    case 'signDelivery':
      return memory.signDeliveries.length;
    case 'deptYoy':
      return memory.deptYoy.length;
    case 'companyYoy':
      return memory.companyYoy.length;
    case 'revenueMom':
      return memory.revenueMom.length;
    case 'rollbackProjectActual':
      return memory.rollbackProjectActual.length;
    case 'riskAlert':
      return memory.riskAlerts.length;
    case 'riskRule':
      return memory.riskControlRules.length;
    case 'reviews':
      return memory.reviews.length;
    case 'vendorContract':
      return memory.vendorContracts.length;
    case 'talentPool':
      return memory.talentPool.length;
    case 'customerAnalysis':
      return memory.customerProjects.length;
    case 'trendPersonal':
    case 'trendTeam':
    case 'trendBusiness':
    case 'trends':
      return memory.trends ? 1 : 0;
    default:
      return 0;
  }
}

function _buildTraceMeta(memory, opts = {}) {
  const plannedTables = Array.isArray(opts.plannedTables) ? opts.plannedTables : [];
  const attemptedTables = [...new Set(['profile', ...(opts.attemptedTables || [])])];
  const rowCounts = {};
  const loadedTables = [];

  for (const key of attemptedTables) {
    const count = _countTraceRows(memory, key);
    rowCounts[key] = count;
    if (count > 0) loadedTables.push(key);
  }

  return {
    plannedTables,
    attemptedTables,
    loadedTables,
    rowCounts,
    fetchErrors: Array.isArray(opts.fetchErrors) ? opts.fetchErrors.slice() : [],
    failedTables: Array.isArray(opts.failedTables) ? opts.failedTables.slice() : [],
    cache: opts.cache || { hit: false, missing: [] },
  };
}

function _attachTraceMeta(memory, meta) {
  Object.defineProperty(memory, '_traceMeta', {
    value: meta,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return memory;
}

function _scopeCacheKey(userName, scope) {
  if (!scope) return userName;
  if (scope.isGlobal) return `${userName}|global`;
  const depts = Array.isArray(scope.depts) ? [...new Set(scope.depts.filter(Boolean).map(String))].sort() : [];
  if (depts.length === 0) return `${userName}|scope=none`;
  return `${userName}|depts=${depts.join(',')}`;
}

async function getUserMemory(userId, opts = {}, deps = {}) {
  const userName = opts.userName || userId;
  const cacheKey = _scopeCacheKey(userName, opts.scope || null);
  const forceRefresh = opts.forceRefresh || false;
  const applyScopeFilter = deps.applyScopeFilter || (() => {});
  const selectTablesForQuestion = deps.selectTablesForQuestion || baseSelectTablesForQuestion;
  const question = opts.question || '';
  const initialNeeded = _cloneTableSet(opts.plannedTables || selectTablesForQuestion(question));

  if (!forceRefresh) {
    const cached = _getCached(cacheKey);
    if (cached) {
      const currentNeeded = new Set(initialNeeded);
      const loadedSections = _getCachedSections(cacheKey) || new Set();
      const missing = [...currentNeeded].filter((key) => !loadedSections.has(key));
      if (missing.length === 0) {
        logger.info(`[Memory] 缓存命中(${cacheKey})，所有所需表已加载，跳过网络请求`);
        const traceMeta = _buildTraceMeta(cached, {
          plannedTables: [...currentNeeded],
          attemptedTables: [...currentNeeded],
          fetchErrors: [],
          cache: { hit: true, missing: [] },
        });
        _attachTraceMeta(cached, traceMeta);
        logger.info(
          `[MemoryTrace] ${userName} cache=hit tables=${traceMeta.attemptedTables.map((key) => `${key}:${traceMeta.rowCounts[key]}`).join(', ') || 'profile:0'}`,
        );
        return cached;
      }
      logger.info(`[Memory] 缓存命中(${cacheKey})，但缺少 [${missing.join(',')}]，增量加载`);
      invalidateUserCache(cacheKey, cacheKey);
    }
  }

  const memory = createEmptyMemory();
  const needed = new Set(initialNeeded);
  const traceErrors = [];
  const failedTables = new Set();
  const recordFetchError = (tableKey, error, stage = tableKey) => {
    const message = error && error.message ? error.message : String(error || 'unknown error');
    if (tableKey) failedTables.add(tableKey);
    traceErrors.push({ tableKey, stage, message });
    return message;
  };
  const logSettledFailure = (tableKey, label, settledResult, stage = tableKey) => {
    if (settledResult && settledResult.status === 'rejected') {
      logger.warn(`[Memory] ${label}加载失败: ${recordFetchError(tableKey, settledResult.reason, stage)}`);
    }
  };
  if (opts.plannedTables) {
    logger.info(`[Memory] 使用 Planner 精准选表: [${[...needed].join(', ')}]`);
  }

  if (needed.has('actualWorktime') && !needed.has('budgetWorktime')) {
    needed.add('budgetWorktime');
    logger.info('[Memory] 自动配对：actualWorktime → 追加 budgetWorktime（预实对比必需）');
  }
  if (needed.has('budgetWorktime') && !needed.has('actualWorktime')) {
    needed.add('actualWorktime');
    logger.info('[Memory] 自动配对：budgetWorktime → 追加 actualWorktime（预实对比必需）');
  }

  let scopeForFilter = opts.scope || null;
  if (!scopeForFilter) {
    try {
      scopeForFilter = await permManager.resolveScope(userName);
    } catch (_error) {
      // ignore
    }
  }
  if (scopeForFilter && scopeForFilter.visibleModules && !scopeForFilter.isGlobal) {
    const visibleModules = new Set(scopeForFilter.visibleModules);
    for (const catalogKey of [...needed]) {
      const requiredModule = CATALOG_MODULE_REQ[catalogKey];
      if (requiredModule && !visibleModules.has(requiredModule)) {
        needed.delete(catalogKey);
      }
    }
    logger.info(`[Memory] 板块过滤后选表: [${[...needed].join(', ')}] (可见板块: ${[...visibleModules].join(',')})`);
  }

  const isGlobalScope = scopeForFilter && scopeForFilter.isGlobal;
  const skip = () => Promise.resolve([]);
  const [profile, meetings, calendar, chats, workItems, staffing, masterByPerson, targets, riskRules, riskAlerts, empProfile, reviews] = await Promise.allSettled([
    fetchProfile(userId, userName),
    needed.has('meetings') ? fetchUserRecords(config.TABLES.MEETING_SNAPSHOT, userId, userName) : skip(),
    needed.has('calendar') ? fetchUserRecords(config.TABLES.CALENDAR_EVENT, userId, userName) : skip(),
    needed.has('meetings') ? fetchUserRecords(config.TABLES.CHAT_SNAPSHOT, userId, userName) : skip(),
    needed.has('workItems') ? fetchUserRecords(config.TABLES.WORK_ITEM, userId, userName) : skip(),
    needed.has('actualWorktime')
      ? (isGlobalScope ? fetchAllRecords(config.TABLES.ACTUAL_WORKTIME) : fetchProjectStaffing(userId, userName))
      : skip(),
    needed.has('projectMaster') ? (isGlobalScope ? fetchAllRecords(config.TABLES.PROJECT_NAME_UNIQUE) : fetchProjectMasterByPerson(userName)) : skip(),
    needed.has('budgetProject') ? fetchAllRecords(config.TABLES.BUDGET_PROJECT) : skip(),
    needed.has('riskRule') ? fetchAllRecords(config.TABLES.RISK_CONTROL_RULE) : skip(),
    needed.has('riskAlert') ? fetchUserRiskAlerts(userId, userName) : skip(),
    needed.has('employeeProfile') ? fetchEmployeeProfile(userName) : skip(),
    needed.has('reviews') ? fetchUserReviews(userName) : skip(),
  ]);

  logSettledFailure('profile', '员工主档', profile);
  logSettledFailure('meetings', '会议记录', meetings);
  logSettledFailure('calendar', '日程事件', calendar);
  logSettledFailure('meetings', '群聊快照', chats, 'chats');
  logSettledFailure('workItems', '工作事项', workItems);
  logSettledFailure('actualWorktime', '实际工时', staffing);
  logSettledFailure('projectMaster', '项目主档', masterByPerson, 'projectMaster.personal');
  logSettledFailure('budgetProject', '预算项目层', targets, 'budgetProject.targets');
  logSettledFailure('riskRule', '风险规则', riskRules);
  logSettledFailure('riskAlert', '风险告警', riskAlerts);
  logSettledFailure('employeeProfile', '员工画像', empProfile);
  logSettledFailure('reviews', '复盘记录', reviews);

  memory.profile = profile.status === 'fulfilled' ? profile.value : null;
  memory.meetings = meetings.status === 'fulfilled' ? meetings.value : [];
  memory.calendar = calendar.status === 'fulfilled' ? calendar.value : [];
  memory.chats = chats.status === 'fulfilled' ? chats.value : [];
  memory.workItems = workItems.status === 'fulfilled' ? workItems.value : [];
  memory.projectStaffing = staffing.status === 'fulfilled' ? staffing.value : [];
  if (isGlobalScope && needed.has('actualWorktime')) {
    logger.info(`[Memory] 全局权限用户，全量加载 ACTUAL_WORKTIME: ${memory.projectStaffing.length} 条`);
  }
  memory.performanceTargets = targets.status === 'fulfilled' ? targets.value : [];
  memory.riskControlRules = riskRules.status === 'fulfilled' ? riskRules.value : [];
  memory.riskAlerts = riskAlerts.status === 'fulfilled' ? riskAlerts.value : [];
  memory.employeeProfile = (empProfile.status === 'fulfilled' && empProfile.value && !Array.isArray(empProfile.value))
    ? empProfile.value
    : null;
  memory.reviews = reviews.status === 'fulfilled' ? reviews.value : [];

  const masterFromPerson = masterByPerson.status === 'fulfilled' ? masterByPerson.value : [];
  let allProjectKeys = [];
  const personalProjectKeys = new Set();

  const isV2 = !!config.MEMORY_PARALLEL_V2;
  const deferredLoads = [];
  let waveBPromise = Promise.resolve();

  const needsProjectData = needed.has('projectMaster') || needed.has('actualProject')
    || needed.has('budgetProject') || needed.has('actualWorktime') || needed.has('cashflow')
    || needed.has('actualDept')
    || needed.has('customerProjects') || needed.has('budgetDept')
    || needed.has('deptYoy') || needed.has('rollbackProjectActual') || needed.has('pendingPayment')
    || needed.has('vendorContract') || needed.has('talentPool') || needed.has('budgetWorktime')
    || needed.has('invoiceApply');

  const VALID_PM_STATUS = new Set(DELIVERY_ACTIVE_STATUSES);
  const _pmStatusField = FM.PROJECT_NAME_UNIQUE_FIELDS.STATUS;
  const _isValidPMStatus = (f) => VALID_PM_STATUS.has(FM.str(f, _pmStatusField));

  if (isGlobalScope) {
    const beforeCount = masterFromPerson.length;
    memory.projectMaster = masterFromPerson.filter(r => _isValidPMStatus(r.fields || {}));
    allProjectKeys = memory.projectMaster
      .map((row) => {
        const fields = row.fields || {};
        return fields['26年项目名称'] || fields['项目名称（管报）'] || '';
      })
      .filter(Boolean);
    if (beforeCount > 0) {
      logger.info(`[Memory] 全局权限用户，全量加载 PROJECT_NAME_UNIQUE: ${memory.projectMaster.length}/${beforeCount} 条（过滤非有效状态 ${beforeCount - memory.projectMaster.length} 条）`);
    }

    if (needed.has('actualProject') || needed.has('projectMaster') || needed.has('cashflow') || needed.has('actualDept') || needed.has('budgetProject')) {
      const needActualProject = needed.has('actualProject');
      waveBPromise = fetchAllRecords(config.TABLES.ACTUAL_PROJECT)
        .then((rows) => {
          memory.projectMonthly = rows;
          if (needActualProject) memory.actualProject = rows;
          logger.info(`[Memory] 全局权限用户，全量加载 ACTUAL_PROJECT: ${rows.length} 条`);
        })
        .catch((error) => logger.warn(`[Memory] ACTUAL_PROJECT 全量加载失败: ${recordFetchError('actualProject', error, 'actualProject.global')}`));
    }
  } else {
    const scopeProjectKeys = _uniqNonEmpty(scopeForFilter && scopeForFilter.projectKeys);
    const responsibleScopeKeys = new Set(_uniqNonEmpty(scopeForFilter && scopeForFilter.responsibleProjectKeys));
    const staffingProjectKeys = [...new Set(
      memory.projectStaffing.map((row) => FM.lookupFirst((row.fields || {})['匹配项目'])).filter(Boolean),
    )];
    const masterPersonProjectKeys = masterFromPerson
      .map((row) => {
        const fields = row.fields || {};
        return fields['26年项目名称'] || fields['项目名称（管报）'] || '';
      })
      .filter(Boolean);

    const worktimeOnlyProjectKeys = new Set(staffingProjectKeys);
    const personRoleProjectKeys = new Set(masterPersonProjectKeys);

    // ACTUAL_WORKTIME 只能证明本人填过工时，不能扩展项目主档/经营数据权限。
    // 因此 staffingProjectKeys 不进入 allProjectKeys，也不参与 projectMaster 的 personal 打标。
    for (const key of masterPersonProjectKeys) {
      if (responsibleScopeKeys.has(key)) personalProjectKeys.add(key);
    }

    // 经营项目权限以 permission-manager.resolveScope 的 projectKeys 为唯一入口。
    // 员工主档可见项目范围非空时，项目主档人员字段不能额外扩权；仅当权限层确认
    // responsibleProjectKeys 兜底时，才会被合并进 scope.projectKeys。
    allProjectKeys = scopeProjectKeys.length > 0
      ? [...scopeProjectKeys]
      : ((!scopeForFilter || !Array.isArray(scopeForFilter.projectKeys)) ? [...personRoleProjectKeys] : []);

    if (needsProjectData && scopeForFilter && scopeForFilter.depts && scopeForFilter.depts.length > 0) {
      try {
        let skippedVirtual = 0;
        for (const dept of scopeForFilter.depts) {
          const deptRecords = await client.listRecords(config.TABLES.PROJECT_NAME_UNIQUE, {
            filter: `CurrentValue.[项目归属部门]="${dept}"`,
            page_size: 500,
          });
          for (const row of deptRecords) {
            const fields = row.fields || {};
            if (!_isValidPMStatus(fields)) { skippedVirtual++; continue; }
            const name = fields['26年项目名称'] || fields['项目名称（管报）'] || '';
            if (name) allProjectKeys.push(name);
            masterFromPerson.push(row);
          }
        }
        allProjectKeys = [...new Set(allProjectKeys)];
        logger.info(
          `[Memory] 部门扩展后 allProjectKeys: ${allProjectKeys.length} 个 (depts: ${scopeForFilter.depts.join(',')}) | 授权项目: ${scopeProjectKeys.length} 个 | 负责人兜底项目: ${responsibleScopeKeys.size} 个 | 角色项目(未直接扩权): ${personRoleProjectKeys.size} 个 | 工时参与项目(不扩权): ${worktimeOnlyProjectKeys.size} 个 | 过滤虚拟项目: ${skippedVirtual} 条`,
        );
      } catch (error) {
        logger.warn(`[Memory] 部门扩展 PROJECT_NAME_UNIQUE 失败: ${recordFetchError('projectMaster', error, 'projectMaster.deptExpand')}`);
      }
    }

    if (allProjectKeys.length > 0) {
      const needActualProject = needed.has('actualProject');
      const waveBLoads = [
        fetchProjectsByKeys(config.TABLES.PROJECT_NAME_UNIQUE, allProjectKeys, '26年项目名称', { fallbackField: '项目名称（管报）' })
          .then((rows) => {
            memory.projectMaster = rows;
          })
          .catch((error) => logger.warn(`[Memory] projectMaster 加载失败: ${recordFetchError('projectMaster', error, 'projectMaster.byKeys')}`)),
        fetchProjectsByKeys(config.TABLES.ACTUAL_PROJECT, allProjectKeys, FM.ACTUAL_PROJECT_FIELDS.PROJECT_NAME)
          .then(async (keyBasedRows) => {
            // 2026-04-29 根治 A：按部门补充加载 ACTUAL_PROJECT，与 actualDept 范围对齐
            const deptField = FM.ACTUAL_PROJECT_FIELDS.DEPT || '一级部门';
            const depts = (scopeForFilter && Array.isArray(scopeForFilter.depts)) ? scopeForFilter.depts : [];
            let merged = keyBasedRows;
            if (depts.length > 0) {
              try {
                const deptConds = depts.map(d => `CurrentValue.[${deptField}]="${String(d).replace(/"/g, '\\"')}"`);
                const filter = deptConds.length === 1 ? deptConds[0] : `OR(${deptConds.join(',')})`;
                const deptBasedRows = await client.listRecords(config.TABLES.ACTUAL_PROJECT, { filter, page_size: 500 });
                merged = _mergeByRecordId(keyBasedRows, deptBasedRows);
                if (deptBasedRows.length > 0) {
                  logger.info(`[Memory] projectMonthly 合并：项目反查 ${keyBasedRows.length} + 部门直查 ${deptBasedRows.length} → 去重后 ${merged.length} 条`);
                }
              } catch (e) {
                logger.warn(`[Memory] ACTUAL_PROJECT 部门补充加载失败: ${e.message}`);
              }
            }
            memory.projectMonthly = merged;
            if (needActualProject) memory.actualProject = merged;
          })
          .catch((error) => logger.warn(`[Memory] projectMonthly 加载失败: ${recordFetchError('actualProject', error, 'actualProject.byKeys')}`)),
        Promise.all([
          fetchProjectTeamByKeys(allProjectKeys),
          (scopeForFilter && scopeForFilter.depts && scopeForFilter.depts.length > 0)
            ? fetchWorktimeByDepts(config.TABLES.ACTUAL_WORKTIME, scopeForFilter.depts)
            : Promise.resolve([]),
        ]).then(([byKey, byDept]) => {
          memory.projectTeamStaffing = _mergeByRecordId(byKey, byDept);
          if (byDept.length > 0) {
            logger.info(`[Memory] projectTeamStaffing 合并：项目反查 ${byKey.length} + 部门直查 ${byDept.length} → 去重后 ${memory.projectTeamStaffing.length} 条`);
          }
        }).catch((error) => logger.warn(`[Memory] projectTeamStaffing 加载失败: ${recordFetchError('actualWorktime', error, 'actualWorktime.teamByKeys')}`)),
      ];
      waveBPromise = Promise.allSettled(waveBLoads).then(() => {
        _tagProjectMasterSource(memory, masterFromPerson, personalProjectKeys);
      });
    } else if (!scopeForFilter && masterFromPerson.length > 0) {
      memory.projectMaster = masterFromPerson;
      for (const row of memory.projectMaster) row._source = 'personal';
      const keys = masterFromPerson
        .map((row) => (row.fields || {})['26年项目名称'])
        .filter(Boolean);
      if (keys.length > 0) {
        const needActualProject = needed.has('actualProject');
        const waveBLoads = [
          fetchProjectsByKeys(config.TABLES.ACTUAL_PROJECT, keys, FM.ACTUAL_PROJECT_FIELDS.PROJECT_NAME)
            .then(async (keyBasedRows) => {
              const deptField = FM.ACTUAL_PROJECT_FIELDS.DEPT || '一级部门';
              const depts = (scopeForFilter && Array.isArray(scopeForFilter.depts)) ? scopeForFilter.depts : [];
              let merged = keyBasedRows;
              if (depts.length > 0) {
                try {
                  const deptConds = depts.map(d => `CurrentValue.[${deptField}]="${String(d).replace(/"/g, '\\"')}"`);
                  const filter = deptConds.length === 1 ? deptConds[0] : `OR(${deptConds.join(',')})`;
                  const deptBasedRows = await client.listRecords(config.TABLES.ACTUAL_PROJECT, { filter, page_size: 500 });
                  merged = _mergeByRecordId(keyBasedRows, deptBasedRows);
                  if (deptBasedRows.length > 0) {
                    logger.info(`[Memory] projectMonthly(personal) 合并：项目反查 ${keyBasedRows.length} + 部门直查 ${deptBasedRows.length} → 去重后 ${merged.length} 条`);
                  }
                } catch (e) {
                  logger.warn(`[Memory] ACTUAL_PROJECT 部门补充加载失败(personal): ${e.message}`);
                }
              }
              memory.projectMonthly = merged;
              if (needActualProject) memory.actualProject = merged;
            })
            .catch((error) => logger.warn(`[Memory] projectMonthly 加载失败: ${recordFetchError('actualProject', error, 'actualProject.personalKeys')}`)),
          Promise.all([
            fetchProjectTeamByKeys(keys),
            (scopeForFilter && scopeForFilter.depts && scopeForFilter.depts.length > 0)
              ? fetchWorktimeByDepts(config.TABLES.ACTUAL_WORKTIME, scopeForFilter.depts)
              : Promise.resolve([]),
          ]).then(([byKey, byDept]) => {
            memory.projectTeamStaffing = _mergeByRecordId(byKey, byDept);
          }).catch((error) => logger.warn(`[Memory] projectTeamStaffing 加载失败: ${recordFetchError('actualWorktime', error, 'actualWorktime.personalKeys')}`)),
        ];
        waveBPromise = Promise.allSettled(waveBLoads);
      }
    }
  }

  if (isV2) {
    deferredLoads.push(waveBPromise);
  } else {
    await waveBPromise;
  }

  if (needsProjectData) {
    const managerOverlayPromise = waveBPromise.then(() => _applyManagerCompanyOverlay(memory, scopeForFilter));
    if (isV2) {
      deferredLoads.push(managerOverlayPromise);
    } else {
      await managerOverlayPromise;
    }
  }

  const financeNeeded = needed.has('cashflow') || needed.has('actualProject') || needed.has('actualDept');
  if (financeNeeded && (allProjectKeys.length > 0 || isGlobalScope)) {
    const fetchFinance = (tableId, projectField = FM.ACTUAL_PROJECT_FIELDS.PROJECT_NAME) => (
      isGlobalScope
        ? fetchAllRecords(tableId)
        : fetchProjectsByKeys(tableId, allProjectKeys, projectField)
    );

    const financeLoads = [];
    if (needed.has('cashflow') && config.TABLES.INVOICE) {
      financeLoads.push(
        fetchFinance(config.TABLES.INVOICE, FM.INVOICE_FIELDS.PROJECT_KEY)
          .then((rows) => {
            memory.invoices = rows;
          })
          .catch((error) => logger.warn(`[Memory] 开票回款加载失败: ${recordFetchError('cashflow', error)}`)),
      );
    }
    if (needed.has('actualDept') && config.TABLES.ACTUAL_DEPT) {
      financeLoads.push(
        fetchAllRecords(config.TABLES.ACTUAL_DEPT)
          .then((rows) => {
            memory.actualDept = rows;
          })
          .catch((error) => logger.warn(`[Memory] 部门层实际加载失败: ${recordFetchError('actualDept', error)}`)),
      );
    }
    if (isV2) {
      deferredLoads.push(...financeLoads);
    } else {
      await Promise.allSettled(financeLoads);
    }
  }

  const extLoads = [];

  if (needed.has('pendingPayment') && config.TABLES.PENDING_PAYMENT) {
    extLoads.push(
      fetchAllRecords(config.TABLES.PENDING_PAYMENT)
        .then((rows) => {
          memory.pendingPayments = rows;
        })
        .catch((error) => logger.warn(`[Memory] 待认领款加载失败: ${recordFetchError('pendingPayment', error)}`)),
    );
  }
  if (needed.has('budgetDept') && config.TABLES.BUDGET_DEPT) {
    extLoads.push(
      fetchAllRecords(config.TABLES.BUDGET_DEPT)
        .then((rows) => {
          memory.budgetDept = rows;
        })
        .catch((error) => logger.warn(`[Memory] 预算部门层加载失败: ${recordFetchError('budgetDept', error)}`)),
    );
  }
  if (needed.has('budgetProject') && config.TABLES.BUDGET_PROJECT) {
    const fetchBudgetProject = (async () => {
      if (isGlobalScope) return fetchAllRecords(config.TABLES.BUDGET_PROJECT);

      const keyBasedRows = allProjectKeys.length > 0
        ? await fetchProjectsByKeys(config.TABLES.BUDGET_PROJECT, allProjectKeys, FM.BUDGET_PROJECT_FIELDS.PROJECT_NAME)
        : [];

      const deptField = FM.BUDGET_PROJECT_FIELDS.DEPT || '一级部门';
      const depts = (scopeForFilter && Array.isArray(scopeForFilter.depts)) ? scopeForFilter.depts : [];
      if (depts.length === 0) return keyBasedRows;

      try {
        const deptConds = depts.map(d => `CurrentValue.[${deptField}]="${String(d).replace(/"/g, '\\"')}"`);
        const filter = deptConds.length === 1 ? deptConds[0] : `OR(${deptConds.join(',')})`;
        const deptBasedRows = await client.listRecords(config.TABLES.BUDGET_PROJECT, { filter, page_size: 500 });
        const merged = _mergeByRecordId(keyBasedRows, deptBasedRows);
        logger.info(`[Memory] budgetProject 合并：项目反查 ${keyBasedRows.length} + 部门直查 ${deptBasedRows.length} → 去重后 ${merged.length} 条`);
        return merged;
      } catch (error) {
        logger.warn(`[Memory] BUDGET_PROJECT 部门补充加载失败: ${recordFetchError('budgetProject', error, 'budgetProject.byDept')}`);
        return keyBasedRows;
      }
    })();
    extLoads.push(
      fetchBudgetProject
        .then((rows) => {
          memory.budgetProject = rows;
        })
        .catch((error) => logger.warn(`[Memory] 预算项目层加载失败: ${recordFetchError('budgetProject', error, 'budgetProject.ext')}`)),
    );
  }
  if (needed.has('budgetWorktime') && config.TABLES.BUDGET_WORKTIME) {
    const loadBudget = async () => {
      if (isGlobalScope) {
        return fetchAllRecords(config.TABLES.BUDGET_WORKTIME);
      }
      const tasks = [];
      if (scopeForFilter && scopeForFilter.depts && scopeForFilter.depts.length > 0) {
        tasks.push(fetchWorktimeByDepts(config.TABLES.BUDGET_WORKTIME, scopeForFilter.depts));
      }
      if (allProjectKeys && allProjectKeys.length > 0) {
        const concurrency = Math.max(1, config.FEISHU_BATCH_CONCURRENCY || 3);
        const batches = [];
        for (let i = 0; i < allProjectKeys.length; i += 5) batches.push(allProjectKeys.slice(i, i + 5));
        const projectTask = _runWithLimit(batches, concurrency, async (batch, index) => {
          const conditions = batch.map((key) => `CurrentValue.[标准项目名称新].contains("${_escapeFilter(key)}")`);
          const filter = conditions.length === 1 ? conditions[0] : `OR(${conditions.join(',')})`;
          try {
            return await _listRecordsWithRetry(config.TABLES.BUDGET_WORKTIME, { filter, page_size: 500 });
          } catch (error) {
            logger.warn(`[Memory] BUDGET_WORKTIME 项目反查失败 (batch ${index}): ${error.message}`);
            return [];
          }
        }).then((parts) => {
          const all = [];
          for (const part of parts) {
            if (Array.isArray(part)) all.push(...part);
          }
          return all;
        });
        tasks.push(projectTask);
      }
      if (tasks.length === 0) return fetchAllRecords(config.TABLES.BUDGET_WORKTIME);
      const parts = await Promise.all(tasks);
      const merged = _mergeByRecordId(parts[0] || [], parts[1] || []);
      logger.info(`[Memory] BUDGET_WORKTIME 合并加载：部门直查 ${(parts[0] || []).length} + 项目反查 ${(parts[1] || []).length} → 去重 ${merged.length} 条`);
      return merged;
    };
    extLoads.push(
      loadBudget()
        .then((rows) => {
          memory.budgetWorktime = rows;
        })
        .catch((error) => logger.warn(`[Memory] 预算工时加载失败: ${recordFetchError('budgetWorktime', error)}`)),
    );
  }
  if (needed.has('invoiceApply') && config.TABLES.INVOICE_APPLY) {
    extLoads.push(
      fetchAllRecords(config.TABLES.INVOICE_APPLY)
        .then((rows) => {
          memory.invoiceApply = rows;
        })
        .catch((error) => logger.warn(`[Memory] 发票申请加载失败: ${recordFetchError('invoiceApply', error)}`)),
    );
  }
  if (needed.has('leadPipeline')) {
    logger.warn('[Memory] leadPipeline 已下线（2026-04-23），改用 presale/bidding 承接；本次跳过加载');
  }
  if (needed.has('vendorContract') && config.TABLES.VENDOR_CONTRACT) {
    const fetchVendor = isGlobalScope
      ? fetchAllRecords(config.TABLES.VENDOR_CONTRACT)
      : (allProjectKeys.length > 0
          ? fetchProjectsByKeys(config.TABLES.VENDOR_CONTRACT, allProjectKeys, FM.VENDOR_CONTRACT_FIELDS.FINAL_PROJECT)
          : Promise.resolve([]));
    extLoads.push(
      fetchVendor
        .then((rows) => {
          memory.vendorContracts = rows;
        })
        .catch((error) => logger.warn(`[Memory] 供应商合同加载失败: ${recordFetchError('vendorContract', error)}`)),
    );
  }
  if (needed.has('talentPool') && config.TABLES.TALENT_POOL) {
    extLoads.push(
      fetchAllRecords(config.TABLES.TALENT_POOL)
        .then((rows) => {
          memory.talentPool = rows;
        })
        .catch((error) => logger.warn(`[Memory] 活水登记表加载失败: ${recordFetchError('talentPool', error)}`)),
    );
  }
  if (needed.has('deptYoy') && config.TABLES.DEPT_YOY) {
    extLoads.push(
      fetchAllRecords(config.TABLES.DEPT_YOY)
        .then((rows) => {
          memory.deptYoy = rows;
        })
        .catch((error) => logger.warn(`[Memory] 部门同比加载失败: ${recordFetchError('deptYoy', error)}`)),
    );
  }
  if (needed.has('companyYoy') && config.TABLES.COMPANY_YOY) {
    extLoads.push(
      fetchAllRecords(config.TABLES.COMPANY_YOY)
        .then((rows) => {
          memory.companyYoy = rows;
        })
        .catch((error) => logger.warn(`[Memory] 公司同比加载失败: ${recordFetchError('companyYoy', error)}`)),
    );
  }
  if (needed.has('revenueMom') && config.TABLES.REVENUE_MOM) {
    extLoads.push(
      fetchAllRecords(config.TABLES.REVENUE_MOM)
        .then((rows) => {
          memory.revenueMom = rows;
        })
        .catch((error) => logger.warn(`[Memory] 环比分析加载失败: ${recordFetchError('revenueMom', error)}`)),
    );
  }
  if (needed.has('rollbackProjectActual') && config.TABLES.ROLLBACK_PROJECT_ACTUAL) {
    extLoads.push(
      fetchAllRecords(config.TABLES.ROLLBACK_PROJECT_ACTUAL)
        .then((rows) => {
          memory.rollbackProjectActual = rows;
        })
        .catch((error) => logger.warn(`[Memory] 回滚项目明细加载失败: ${recordFetchError('rollbackProjectActual', error)}`)),
    );
  }
  if (needed.has('presale') && config.TABLES.PRESALE_PROJECT) {
    const fetchPresale = (async () => {
      if (isGlobalScope) return fetchAllRecords(config.TABLES.PRESALE_PROJECT);

      const deptField = FM.PRESALE_FIELDS.DEPT;
      const scopeDepts = (scopeForFilter && Array.isArray(scopeForFilter.depts) && scopeForFilter.depts.length > 0)
        ? scopeForFilter.depts
        : [];
      const fallbackDept = (memory.profile && (memory.profile['标准部门'] || memory.profile['一级部门'])) || '';
      const depts = scopeDepts.length > 0 ? scopeDepts : (fallbackDept ? [fallbackDept] : []);

      if (depts.length === 0) return [];

      const conditions = depts.map((dept) => `CurrentValue.[${deptField}]="${_escapeFilter(dept)}"`);
      const filter = conditions.length === 1 ? conditions[0] : `OR(${conditions.join(',')})`;
      try {
        const rows = await _listRecordsWithRetry(config.TABLES.PRESALE_PROJECT, { filter, page_size: 500 });
        logger.info(`[Memory] 售前项目按部门加载: depts=[${depts.join(',')}] → ${rows.length} 条`);
        return rows;
      } catch (error) {
        logger.warn(`[Memory] 售前项目 OR 过滤加载失败: ${recordFetchError('presale', error, 'presale.byDept')}`);
        return [];
      }
    })();
    extLoads.push(
      fetchPresale
        .then((rows) => {
          memory.presaleProjects = rows;
        })
        .catch((error) => logger.warn(`[Memory] 售前项目加载失败: ${recordFetchError('presale', error)}`)),
    );
  }
  if (needed.has('signDelivery') && config.TABLES.SIGN_DELIVERY) {
    const signFields = FM.SIGN_DELIVERY_FIELDS;
    const fetchSign = (async () => {
      if (isGlobalScope) return fetchAllRecords(config.TABLES.SIGN_DELIVERY);
      const scopeDepts = (scopeForFilter && Array.isArray(scopeForFilter.depts) && scopeForFilter.depts.length > 0)
        ? scopeForFilter.depts
        : [];
      const fallbackDept = (memory.profile && (memory.profile['标准部门'] || memory.profile['一级部门'])) || '';
      const depts = scopeDepts.length > 0 ? scopeDepts : (fallbackDept ? [fallbackDept] : []);
      if (depts.length === 0) return [];
      const conditions = [];
      for (const dept of depts) {
        const escaped = _escapeFilter(dept);
        conditions.push(`CurrentValue.[${signFields.DEPT}]="${escaped}"`);
        conditions.push(`CurrentValue.[${signFields.PERFORM_DEPT}]="${escaped}"`);
      }
      const filter = conditions.length === 1 ? conditions[0] : `OR(${conditions.join(',')})`;
      try {
        const rows = await _listRecordsWithRetry(config.TABLES.SIGN_DELIVERY, { filter, page_size: 500 });
        logger.info(`[Memory] 签约交付按部门加载: depts=[${depts.join(',')}] → ${rows.length} 条`);
        return rows;
      } catch (error) {
        logger.warn(`[Memory] 签约交付 OR 过滤加载失败: ${recordFetchError('signDelivery', error, 'signDelivery.byDept')}`);
        return [];
      }
    })();
    extLoads.push(
      fetchSign
        .then((rows) => {
          memory.signDeliveries = rows;
        })
        .catch((error) => logger.warn(`[Memory] 签约交付加载失败: ${recordFetchError('signDelivery', error)}`)),
    );
  }
  if (needed.has('bidding') && config.TABLES.BIDDING_PROJECT) {
    const biddingFields = FM.BIDDING_PROJECT_FIELDS;
    const fetchBid = (async () => {
      if (isGlobalScope) return fetchAllRecords(config.TABLES.BIDDING_PROJECT);
      const scopeDepts = (scopeForFilter && Array.isArray(scopeForFilter.depts) && scopeForFilter.depts.length > 0)
        ? scopeForFilter.depts
        : [];
      const fallbackDept = (memory.profile && (memory.profile['标准部门'] || memory.profile['一级部门'])) || '';
      const depts = scopeDepts.length > 0 ? scopeDepts : (fallbackDept ? [fallbackDept] : []);
      if (depts.length === 0) return [];
      const conditions = depts.map((dept) => `CurrentValue.[${biddingFields.DEPT}]="${_escapeFilter(dept)}"`);
      const filter = conditions.length === 1 ? conditions[0] : `OR(${conditions.join(',')})`;
      try {
        const rows = await _listRecordsWithRetry(config.TABLES.BIDDING_PROJECT, { filter, page_size: 500 });
        logger.info(`[Memory] 招投标按部门加载: depts=[${depts.join(',')}] → ${rows.length} 条`);
        return rows;
      } catch (error) {
        logger.warn(`[Memory] 招投标 OR 过滤加载失败: ${recordFetchError('bidding', error, 'bidding.byDept')}`);
        return [];
      }
    })();
    extLoads.push(
      fetchBid
        .then((rows) => {
          memory.biddings = rows;
        })
        .catch((error) => logger.warn(`[Memory] 招投标加载失败: ${recordFetchError('bidding', error)}`)),
    );
  }
  if (needed.has('customerAnalysis') && config.TABLES.PROJECT_NAME_UNIQUE) {
    const deptField = FM.PROJECT_NAME_UNIQUE_FIELDS.DEPT;
    const scopeDepts = (scopeForFilter && Array.isArray(scopeForFilter.depts)) ? scopeForFilter.depts : [];
    let fetchCustomer;
    if (isGlobalScope) {
      fetchCustomer = fetchAllRecords(config.TABLES.PROJECT_NAME_UNIQUE);
    } else if (scopeDepts.length > 0) {
      const deptConds = scopeDepts.map((dept) => `CurrentValue.[${deptField}]="${String(dept).replace(/"/g, '\\"')}"`);
      const filter = deptConds.length === 1 ? deptConds[0] : `OR(${deptConds.join(',')})`;
      fetchCustomer = client.listRecords(config.TABLES.PROJECT_NAME_UNIQUE, { filter, page_size: 500 })
        .catch((error) => {
          logger.warn(`[Memory] 客户经营数据按部门加载失败: ${recordFetchError('customerAnalysis', error, 'customerAnalysis.byDept')}`);
          return [];
        });
    } else {
      const deptName = (memory.profile && (memory.profile['标准部门'] || memory.profile['一级部门'])) || '';
      fetchCustomer = deptName
        ? client.listRecords(config.TABLES.PROJECT_NAME_UNIQUE, {
            filter: `CurrentValue.[${deptField}]="${deptName}"`,
            page_size: 500,
          }).catch((error) => {
            logger.warn(`[Memory] 客户经营数据 profile 兜底加载失败: ${recordFetchError('customerAnalysis', error, 'customerAnalysis.profileFallback')}`);
            return [];
          })
        : Promise.resolve([]);
    }
    extLoads.push(
      fetchCustomer
        .then((rows) => {
          const VALID_STATUS = new Set(['履约中', '已结案', '预计新签']);
          const statusField = FM.PROJECT_NAME_UNIQUE_FIELDS.STATUS;
          const before = rows.length;
          const filtered = rows.filter(r => VALID_STATUS.has(FM.str(r.fields || {}, statusField)));
          memory.customerProjects = filtered;
          logger.info(`[Memory] customerProjects 加载完成: ${filtered.length}/${before} 条（过滤非有效状态 ${before - filtered.length} 条 | scope=${isGlobalScope ? 'global' : scopeDepts.join(',') || 'profile-fallback'}）`);
        })
        .catch((error) => logger.warn(`[Memory] 客户经营数据加载失败: ${recordFetchError('customerAnalysis', error, 'customerAnalysis.final')}`)),
    );
  }

  if (extLoads.length > 0) {
    if (isV2) {
      deferredLoads.push(...extLoads);
    } else {
      await Promise.allSettled(extLoads);
    }
  }

  if (isV2 && deferredLoads.length > 0) {
    const waveStart = Date.now();
    const WAVE_SIZE = 8;
    const COOLDOWN_MS = 200;
    for (let i = 0; i < deferredLoads.length; i += WAVE_SIZE) {
      const wave = deferredLoads.slice(i, i + WAVE_SIZE);
      await Promise.allSettled(wave);
      if (i + WAVE_SIZE < deferredLoads.length) {
        await new Promise(r => setTimeout(r, COOLDOWN_MS));
      }
    }
    logger.info(`[Memory] V2 并行 Wave B+C+D 完成: loads=${deferredLoads.length} waves=${Math.ceil(deferredLoads.length / WAVE_SIZE)} elapsed=${Date.now() - waveStart}ms`);
  }

  if (
    needed.has('trendPersonal')
    || needed.has('trendTeam')
    || needed.has('trendBusiness')
    || needed.has('actualProject')
    || needed.has('budgetProject')
    || needed.has('projectMaster')
  ) {
    try {
      const empId = (memory.profile && (memory.profile['员工ID'] || memory.profile['工号'])) || userId;
      const empName = (memory.profile && memory.profile['姓名']) || userName;
      memory.trends = await timeQuery.fetchAllTrends(empId, empName);
    } catch (error) {
      const trendKeys = [...needed].filter((key) => ['trendPersonal', 'trendTeam', 'trendBusiness'].includes(key));
      if (trendKeys.length > 0) {
        for (const key of trendKeys) {
          recordFetchError(key, error, 'trends');
        }
      } else {
        recordFetchError('trends', error, 'trends');
      }
      logger.warn(`[Memory] 趋势查询失败: ${error.message}`);
    }
  }

  const dynamicProjectKeys = allProjectKeys || [];
  if (opts.scope) {
    applyScopeFilter(memory, opts.scope, userName, dynamicProjectKeys);
  } else {
    try {
      const scope = await permManager.resolveScope(userName);
      applyScopeFilter(memory, scope, userName, dynamicProjectKeys);
    } catch (error) {
      logger.warn(`[Memory] 权限过滤跳过(resolveScope 失败): ${error.message}`);
    }
  }

  const memorySummary = [
    `profile=${!!memory.profile}`,
    `empProfile=${!!memory.employeeProfile}`,
    `meetings=${memory.meetings.length}`,
    `calendar=${memory.calendar.length}`,
    `staffing=${memory.projectStaffing.length}`,
    `master=${memory.projectMaster.length}`,
    `monthly=${memory.projectMonthly.length}`,
    `reviews=${memory.reviews.length}`,
    `invoices=${memory.invoices.length}`,
    `actualProject=${memory.actualProject.length}`,
    `actualDept=${memory.actualDept.length}`,
    `pendingPay=${memory.pendingPayments.length}`,
    `budgetDept=${memory.budgetDept.length}`,
    `budgetProj=${memory.budgetProject.length}`,
    `vendor=${memory.vendorContracts.length}`,
    `talent=${memory.talentPool.length}`,
    `deptYoy=${memory.deptYoy.length}`,
    `rollbackProjectActual=${memory.rollbackProjectActual.length}`,
    `customerProj=${memory.customerProjects.length}`,
    `presale=${memory.presaleProjects.length}`,
    `signDelivery=${memory.signDeliveries.length}`,
    `bidding=${memory.biddings.length}`,
    `trends=${!!memory.trends}`,
  ].join(' ');
  logger.info(`[Memory] 数据汇总(${userName}): ${memorySummary}`);

  const traceMeta = _buildTraceMeta(memory, {
    plannedTables: [...needed],
    attemptedTables: [...needed],
    fetchErrors: traceErrors,
    failedTables: [...failedTables],
    cache: { hit: false, missing: [] },
  });
  _attachTraceMeta(memory, traceMeta);
  logger.info(
    `[MemoryTrace] ${userName} cache=miss tables=${traceMeta.attemptedTables.map((key) => `${key}:${traceMeta.rowCounts[key]}`).join(', ') || 'profile:0'}`,
  );
  if (traceMeta.fetchErrors.length > 0) {
    logger.warn(
      `[MemoryTrace] ${userName} errors=${traceMeta.fetchErrors.map((item) => `${item.tableKey}@${item.stage}:${item.message}`).join(' | ')}`,
    );
  }

  const masterCount = (memory.projectMaster || []).length;
  const teamStaffingCount = (memory.projectTeamStaffing || []).length;
  if (masterCount >= 10 && teamStaffingCount > 0) {
    const density = teamStaffingCount / masterCount;
    if (density < 3) {
      logger.warn(
        `[Memory] ⚠️ staffing 完整性预警(${userName}): projectTeamStaffing=${teamStaffingCount} / projectMaster=${masterCount} = ${density.toFixed(2)} 条/项目，低于经验阈值 3，FTE/人月可能偏低，建议 invalidateCache 后重拉`,
      );
    }
  }

  const successfulSections = [...needed].filter((key) => !failedTables.has(key));
  _setCache(cacheKey, memory, successfulSections);

  return memory;
}

module.exports = {
  createEmptyMemory,
  getUserMemory,
};
