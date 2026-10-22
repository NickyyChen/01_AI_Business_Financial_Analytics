/**
 * permission-manager.js - 纯表驱动权限管控（重构版）
 *
 * 三表分工，零推导：
 *
 *  表1：员工主档表 (EMPLOYEE)
 *       WHO — 角色类型、可见范围、可见项目范围、直属上级
 *       代码直读字段，不做 if-else 推导
 *
 *  表2：权限规则表 (PERMISSION_RULE)
 *       WHAT — 每种角色能看哪些表、做哪些动作、敏感级别
 *       PM-001~PM-004，按角色类型查询
 *
 *  表3：高级权限管理表 (PERMISSION_MGMT)
 *       OVERRIDE — 部门级特殊授权（"全部" → isGlobal）
 *
 * 解析结果 (AccessScope):
 *   {
 *     isGlobal: bool,
 *     roleType: string,            // 直读自员工主档
 *     dataScope: string,           // self/team/org/all
 *     visibleTables: string[],     // 权限规则表 → 中文表名
 *     visibleTableKeys: Set,       // TABLE_NAME_MAP 转换后 config key
 *     allowedActions: string[],    // query/explain/assign/approve/export
 *     sensitivityLevel: string,    // L1~L4
 *     allowExport: bool,
 *     allowDrilldown: bool,
 *     answerTopics: string,        // 注入 Prompt 的可回答主题
 *     depts: string[],            // 高级权限管理表授权部门
 *     subordinateNames: string[], // 员工主档 直属上级 反查
 *     visibleProjects: string[],  // 直读自员工主档
 *     // 向后兼容（Skill 层零修改）
 *     role: string,               // = roleType
 *     projectKeys: string[],      // = visibleProjects
 *     managedProjectKeys: [],
 *     directedProjectKeys: [],
 *     visibleModules: string[],   // 从 visibleTableKeys 反推
 *   }
 *
 * 缓存策略：全局缓存 5 分钟。
 */

const config = require('../../config');
const client = require('../clients/feishu-client');
const logger = require('../utils/logger');
const FN = require('./field-normalizer');
const deptNormalizer = require('./dept-normalizer');
const localMemoryStore = require('../cache/local-memory-store');
const FM = require('../utils/field-mapping');

// ==================== 板块-表映射（保留，用于反向推导 visibleModules）====================

const MODULE_TABLE_MAP = {
  finance: [
    'INVOICE', 'ACTUAL_PROJECT', 'ACTUAL_DEPT', 'ACTUAL_WORKTIME', 'BUDGET_WORKTIME',
    'PRESALE_PROJECT',
    'PENDING_PAYMENT', 'BUDGET_DEPT', 'BUDGET_PROJECT',
    'VENDOR_CONTRACT', 'DEPT_YOY', 'COMPANY_YOY', 'REVENUE_MOM', 'ROLLBACK_PROJECT_ACTUAL',
    // 2026-04-17 新接入
    'SIGN_DELIVERY', 'BIDDING_PROJECT',
  ],
  project: [
    'PROJECT_NAME_UNIQUE', 'ACTUAL_WORKTIME', 'REVIEW',
  ],
  team: [
    'WORK_ITEM', 'WORK_SUMMARY', 'CHAT_SNAPSHOT',
    'MEETING_SNAPSHOT', 'CALENDAR_EVENT',
  ],
  hr: [
    'EMPLOYEE', 'EMPLOYEE_PROFILE', 'ROSTER',
    'TALENT_POOL',
  ],
  sku: [
    'PROMOTION_SNAPSHOT', 'PROMOTION_GAP', 'PROMOTION_DASHBOARD',
  ],
  risk: [
    'USER_RISK_ALERT', 'EMPLOYEE_INSIGHT', 'RISK_CONTROL_RULE',
  ],
  trend: [
    'PERSONAL_TREND', 'TEAM_TREND', 'BUSINESS_TREND',
  ],
};

const MODULE_LABELS = {
  finance: '财务经营',
  project: '项目管理',
  team:    '团队协作',
  hr:      '人事档案',
  sku:     'SKU与晋升',
  risk:    '风险预警',
  trend:   '趋势分析',
};

// ==================== 权限规则表「可见表」中文名 → config.TABLES key ====================

const TABLE_NAME_MAP = {
  '员工主档表':         'EMPLOYEE',
  '积分任务表':         'PROMOTION_SNAPSHOT',
  '项目经营主数据表':   'PROJECT_NAME_UNIQUE',
  '项目名称唯一值表':   'PROJECT_NAME_UNIQUE',
  '项目名称（唯一值）': 'PROJECT_NAME_UNIQUE',  // 2026-04-20 新增：PM-002~004 实际在用的带括号写法
  '项目月度经营汇总表': 'ACTUAL_PROJECT',   // 旧表名，保留向后兼容
  '实际项目层':         'ACTUAL_PROJECT',   // 无冒号简写，保留
  '实际：项目层':       'ACTUAL_PROJECT',   // 2026-04-17 新增：XLSX 实际 sheet 名
  '项目人力投入表':     'ACTUAL_WORKTIME',  // 旧表名，保留向后兼容
  '实际26年工时':       'ACTUAL_WORKTIME',  // 无冒号简写，保留
  '实际：26年工时':     'ACTUAL_WORKTIME',  // 2026-04-17 新增：XLSX 实际 sheet 名
  '预算26年工时':       'BUDGET_WORKTIME',  // 无冒号简写，保留
  '预算：26年工时':     'BUDGET_WORKTIME',  // 2026-05-09 新增：预算 FTE 表
  '预算工时表':         'BUDGET_WORKTIME',
  '工作事项汇总表':     'WORK_ITEM',
  '工作总结快照表':     'WORK_SUMMARY',
  '日程事件映射表':     'CALENDAR_EVENT',
  '会议摘要快照表':     'MEETING_SNAPSHOT',
  '群聊摘要快照表':     'CHAT_SNAPSHOT',
  '权限规则表':         'PERMISSION_RULE',
  '全员花名册':         'EMPLOYEE_PROFILE',
  '绩效目标表':         'BUDGET_PROJECT',
  '预算项目层':         'BUDGET_PROJECT',
  '开票回款计划':       'INVOICE',
  '项目层实际表':       'ACTUAL_PROJECT',
  '部门层实际表':       'ACTUAL_DEPT',
  '风险告警表':         'USER_RISK_ALERT',
  '风险控制规则表':     'RISK_CONTROL_RULE',
  '售前项目表':         'PRESALE_PROJECT',
  '个人趋势表':         'PERSONAL_TREND',
  '团队趋势表':         'TEAM_TREND',
  '经营趋势表':         'BUSINESS_TREND',
  'SKU能力点亮表':      'PROMOTION_SNAPSHOT',
  '晋升差距表':         'PROMOTION_GAP',
  '晋升看板表':         'PROMOTION_DASHBOARD',
  '复盘表':             'REVIEW',
  '项目复盘表':         'REVIEW',
  '待认领款表':         'PENDING_PAYMENT',
  '待认领款':           'PENDING_PAYMENT',
  '预算部门层表':       'BUDGET_DEPT',
  '预算项目层表':       'BUDGET_PROJECT',
  '项目名称唯一性表':   'PROJECT_NAME_UNIQUE',
  '项目名称唯一值':     'PROJECT_NAME_UNIQUE',
  '供应商合同管理表':   'VENDOR_CONTRACT',
  '供应商合同管理':     'VENDOR_CONTRACT',
  '活水登记表':         'TALENT_POOL',
  '部门层同比表':       'DEPT_YOY',
  '公司层同比表':       'COMPANY_YOY',
  '履约环比表':         'REVENUE_MOM',
  '部门层同比（回滚）':   'DEPT_YOY',
  '公司层面同比（回滚）': 'COMPANY_YOY',
  '履约收入&利润环比（回滚）': 'REVENUE_MOM',
  '项目层-回滚实际':     'ROLLBACK_PROJECT_ACTUAL',
  // 2026-04-17 新接入
  '签约交付表':         'SIGN_DELIVERY',
  '签约交付':           'SIGN_DELIVERY',
  '招投标表':           'BIDDING_PROJECT',
  '招投标':             'BIDDING_PROJECT',
};

// config key → 所属板块（从 MODULE_TABLE_MAP 反向构建）
const _TABLE_KEY_TO_MODULE = {};
for (const [mod, keys] of Object.entries(MODULE_TABLE_MAP)) {
  for (const k of keys) _TABLE_KEY_TO_MODULE[k] = mod;
}

/**
 * 从 config.TABLES key 集合反推 visibleModules
 * 所有角色默认可见 hr（自己的档案）和 project（自己的项目）
 */
function _deriveVisibleModules(tableKeys) {
  const modules = new Set(['hr', 'project']);
  for (const k of tableKeys) {
    const mod = _TABLE_KEY_TO_MODULE[k];
    if (mod) modules.add(mod);
  }
  return [...modules];
}

/**
 * 根据可见板块列表，输出允许访问的 TABLES key 集合
 */
function getVisibleTableKeys(visibleModules) {
  const keys = new Set();
  for (const mod of visibleModules) {
    const tableKeys = MODULE_TABLE_MAP[mod] || [];
    for (const k of tableKeys) keys.add(k);
  }
  return keys;
}

// ==================== 角色类型默认数据范围（可见范围为空时的 fallback）====================

const _ROLE_DEFAULT_SCOPE = {
  'CEO':    'all',
  '管理者': 'team',
  '组织部': 'org',
  '员工':   'self',
};

const VALID_RESPONSIBLE_PROJECT_STATUS = new Set(['履约中', '已结案', '预计新签']);
const RESPONSIBLE_PROJECT_PERSON_FIELDS = [
  FM.PROJECT_NAME_UNIQUE_FIELDS.DIRECTOR,
  FM.PROJECT_NAME_UNIQUE_FIELDS.MANAGER,
  FM.PROJECT_NAME_UNIQUE_FIELDS.TEST_PURPOSE,
];

// ==================== 缓存 ====================

const CACHE_TTL = 5 * 60 * 1000;

const _cache = {
  permTable: null,     // [{ dept, personNames, testerNames }]  ← 高级权限管理表
  empMaster: null,     // [{ name, openId, roleType, dataScope, visibleProjects:[], superiors:[], depts:[] }]
  permRules: null,     // [{ ruleId, roleType, dataScope, visibleTables:[], allowedActions:[], ... }]
  expireAt: 0,
};

function _cacheHasUsableData() {
  return Array.isArray(_cache.permTable)
    && Array.isArray(_cache.empMaster)
    && Array.isArray(_cache.permRules);
}

function _makeCacheRefreshError(failures) {
  const err = new Error(`PERMISSION_CACHE_REFRESH_FAILED: ${failures.map(f => `${f.name}=${f.message}`).join('; ')}`);
  err.code = 'PERMISSION_CACHE_REFRESH_FAILED';
  err.failures = failures;
  return err;
}

function _canonicalizeDeptName(raw) {
  const value = String(raw || '').trim();
  return deptNormalizer.canonicalizeDeptName(value) || value;
}

function _canonicalizeDeptList(list) {
  const resolved = deptNormalizer.canonicalizeDeptList(Array.isArray(list) ? list : []);
  return [...new Set([...resolved.depts, ...resolved.unresolved])];
}

function _uniqNonEmpty(list) {
  return [...new Set((Array.isArray(list) ? list : [])
    .map(value => String(value || '').trim())
    .filter(Boolean))];
}

function _getProjectNameMrOptionMap() {
  const cache = localMemoryStore.getActiveCache && localMemoryStore.getActiveCache();
  const map = cache && cache.metadata && cache.metadata.projectNameMrOptionMap;
  return map && typeof map === 'object' ? map : {};
}

function _resolveVisibleProjectRange(raw) {
  const out = {
    visibleProjects: [],
    resolved: true,
    unresolvedOptionIds: [],
    source: '',
  };
  if (!raw) return out;

  const lk = FN.normLookup(raw);
  if (lk.kind === 'textChunks') {
    out.visibleProjects = FN.splitMulti(lk.text);
    out.source = 'textChunks';
  } else if (lk.kind === 'optionIds') {
    const optionMap = _getProjectNameMrOptionMap();
    const mapped = [];
    const unresolved = [];
    for (const optionId of lk.optionIds || []) {
      const name = optionMap[optionId];
      if (name) mapped.push(name);
      else unresolved.push(optionId);
    }
    out.visibleProjects = mapped;
    out.unresolvedOptionIds = unresolved;
    out.resolved = unresolved.length === 0;
    out.source = 'optionIds';
  } else if (typeof raw === 'string') {
    out.visibleProjects = FN.splitMulti(raw);
    out.source = 'string';
  }
  out.visibleProjects = _uniqNonEmpty(out.visibleProjects);
  return out;
}

function _personFieldMatches(value, name) {
  if (!value || !name) return false;
  if (typeof value === 'string') return value.includes(name);
  if (Array.isArray(value)) {
    return value.some(item => {
      if (!item) return false;
      if (typeof item === 'string') return item.includes(name);
      return item.name === name || item.en_name === name || item.text === name || item.value === name;
    });
  }
  if (typeof value === 'object') return value.name === name || value.en_name === name || value.text === name || value.value === name;
  return false;
}

function _projectKeyFromFields(fields) {
  return FM.str(fields, FM.PROJECT_NAME_UNIQUE_FIELDS.PROJECT_26)
    || FM.str(fields, FM.PROJECT_NAME_UNIQUE_FIELDS.PROJECT_NAME_MR)
    || '';
}

async function _loadResponsibleProjectKeys(empName) {
  if (!empName || !config.TABLES.PROJECT_NAME_UNIQUE) return [];
  const rows = await client.listRecords(config.TABLES.PROJECT_NAME_UNIQUE, { page_size: 500 });
  const keys = [];
  for (const row of rows || []) {
    const fields = row.fields || {};
    const status = FM.str(fields, FM.PROJECT_NAME_UNIQUE_FIELDS.STATUS);
    if (!VALID_RESPONSIBLE_PROJECT_STATUS.has(status)) continue;
    const hit = RESPONSIBLE_PROJECT_PERSON_FIELDS.some(field => _personFieldMatches(fields[field], empName));
    if (!hit) continue;
    const key = _projectKeyFromFields(fields);
    if (key) keys.push(key);
  }
  return _uniqNonEmpty(keys);
}

async function _ensureCache() {
  if (Date.now() < _cache.expireAt) return;

  const [permRes, masterRes, rulesRes] = await Promise.allSettled([
    _loadPermTable(),
    _loadEmployeeMaster(),
    _loadPermissionRules(),
  ]);

  const failures = [
    ['PERMISSION_MGMT', permRes],
    ['EMPLOYEE', masterRes],
    ['PERMISSION_RULE', rulesRes],
  ]
    .filter(([, res]) => res.status === 'rejected')
    .map(([name, res]) => ({ name, message: res.reason && res.reason.message ? res.reason.message : String(res.reason || 'unknown error') }));

  if (failures.length > 0) {
    const detail = failures.map(f => `${f.name}: ${f.message}`).join(' | ');
    if (_cacheHasUsableData()) {
      _cache.expireAt = Date.now() + Math.min(CACHE_TTL, 60 * 1000);
      logger.warn(`[PermManager] 缓存刷新失败，继续使用上一版权限缓存: ${detail}`);
      return;
    }
    logger.error(`[PermManager] 首次权限缓存刷新失败: ${detail}`);
    throw _makeCacheRefreshError(failures);
  }

  _cache.permTable = permRes.status  === 'fulfilled' ? permRes.value  : [];
  _cache.empMaster = masterRes.status === 'fulfilled' ? masterRes.value : [];
  _cache.permRules = rulesRes.status  === 'fulfilled' ? rulesRes.value  : [];
  _cache.expireAt  = Date.now() + CACHE_TTL;

  logger.info(`[PermManager] 缓存刷新: permRows=${_cache.permTable.length} master=${_cache.empMaster.length} rules=${_cache.permRules.length}`);
}

// ==================== 数据加载 ====================

async function _loadPermTable() {
  if (!config.TABLES.PERMISSION_MGMT) return [];
  const records = await client.listRecords(config.TABLES.PERMISSION_MGMT, { page_size: 200 });
  return records.map(r => {
    const f = r.fields || {};
    // 部门范围字段：主字段"部门范围"（多行文本），兼容旧字段"文本"
    const rawDept = FN.normText(f['部门范围']) || FN.normText(f['文本']) || '';
    const dept = _canonicalizeDeptName(rawDept);
    // 管理者字段（人员类型），兼容历史字段名
    const personNames = FN.normPerson(f['管理者'] || f['负责人'] || f['文本 3'] || f['人员'])
      .map(p => p.name).filter(Boolean);
    // 2026-04-17 测试人员（视同管理者）
    const testerNames = FN.normPerson(f['测试人员'] || f['测试'])
      .map(p => p.name).filter(Boolean);
    return { dept, rawDept, personNames, testerNames };
  }).filter(row => row.dept && (row.personNames.length > 0 || row.testerNames.length > 0));
}

async function _loadEmployeeMaster() {
  if (!config.TABLES.EMPLOYEE) return [];
  const records = await client.listRecords(config.TABLES.EMPLOYEE, { page_size: 500 });
  const result = [];
  let unresolvedProjectLookupRows = 0;
  for (const r of records) {
    const f = r.fields || {};
    const personArr = FN.normPerson(f['姓名 (人员 )'] || f['姓名（人员）'] || f['姓名(人员)']);
    const name   = FN.normText(f['姓名']) || (personArr[0]?.name || '');
    const openId = FN.normText(f['飞书OpenID']) || (personArr[0]?.openId || '');

    // 直属上级：优先读新字段「直属上级姓名」（多行文本，2026-04-20 重构新增）
    // fallback 读查找引用「直属上级」，但加合理性阈值防止脏数据污染 BFS：
    // 若 fallback 返回 > 5 个上级，判定为查找引用配置错误或测试脏数据，丢弃不用。
    const MAX_SUP_FALLBACK = 5;
    let superiors = FN.splitMulti(FN.normText(f['直属上级姓名']));
    if (superiors.length === 0 && f['直属上级']) {
      const lk = FN.normLookup(f['直属上级']);
      if (lk.kind === 'users') {
        if (lk.names.length === 0 || lk.names.length > MAX_SUP_FALLBACK) {
          // 异常（0 个或 > 5 个），不污染 BFS，保持空
        } else {
          superiors = lk.names;
        }
      }
    }

    // 部门：标准部门优先（支持全/半角分号、顿号、逗号分隔多部门），一级部门作 fallback
    const rawDept = FN.normText(f['标准部门']) || FN.normText(f['一级部门']) || '';
    const rawDepts = FN.splitMulti(rawDept);
    const depts = _canonicalizeDeptList(rawDepts);

    // 可见项目范围：字段是查找引用（type=19），可能返回 optionIds/textChunks/users 几种形态
    let visibleProjects = [];
    let visibleProjectRangeResolved = true;
    let visibleProjectRangeSource = '';
    let unresolvedOptionIds = [];
    const vpRaw = f['可见项目范围'];
    if (vpRaw) {
      const resolved = _resolveVisibleProjectRange(vpRaw);
      visibleProjects = resolved.visibleProjects;
      visibleProjectRangeResolved = resolved.resolved;
      visibleProjectRangeSource = resolved.source;
      unresolvedOptionIds = resolved.unresolvedOptionIds;
      if (!visibleProjectRangeResolved) unresolvedProjectLookupRows++;
    }

    if (!name && !openId) continue; // 保留只有 openId 的记录用于反查

    result.push({
      name,
      openId,
      roleType:        FN.normSingleSelect(f['角色类型']),
      dataScope:       FN.normSingleSelect(f['可见范围']),
      visibleProjects,
      visibleProjectRangeResolved,
      visibleProjectRangeSource,
      unresolvedOptionIds,
      superiors,
      depts,
      rawDepts,
    });
  }
  if (unresolvedProjectLookupRows > 0) {
    logger.warn(`[PermManager] ${unresolvedProjectLookupRows} 行员工的「可见项目范围」存在无法映射的 option ID；非全局/非部门负责人经营体检将 fail-closed。`);
  }
  return result;
}

async function _loadPermissionRules() {
  if (!config.TABLES.PERMISSION_RULE) return [];
  const records = await client.listRecords(config.TABLES.PERMISSION_RULE, { page_size: 50 });
  return records.map(r => {
    const f = r.fields || {};
    return {
      ruleId:           FN.normText(f['权限规则ID']),
      roleType:         FN.normSingleSelect(f['角色类型']),
      dataScope:        FN.normSingleSelect(f['数据范围']),
      visibleTables:    FN.normMultiSelect(f['可见表']),        // → string[]
      allowedActions:   FN.normMultiSelect(f['可执行动作']),     // → string[]
      answerTopics:     FN.normText(f['可回答主题']),
      // 以下字段当前未被下游消费，保留读取便于后续接入（不删字段，不影响表）
      visibleViews:     FN.normText(f['可见视图']),
      visibleDashboard: FN.normText(f['可见看板模块']),
      highSensRedirect: FN.normCheckbox(f['高敏是否转人工']),
      // 核心布尔
      allowExport:      FN.normCheckbox(f['允许导出']),
      allowDrilldown:   FN.normCheckbox(f['允许下钻']),
      sensitivityLevel: FN.normSingleSelect(f['敏感级别']),
      enabled:          f['是否启用'] !== false && f['是否启用'] !== 'false',
    };
  }).filter(r => r.roleType && r.enabled);
}

// ==================== 下属查找（BFS，支持多级）====================

/**
 * BFS 查找下属，默认 depth=1（直接下属）
 * @param {string} empName - 起点员工姓名
 * @param {Array} empMaster - 员工主档缓存
 * @param {number} maxDepth - 最大查找层级，1=直接下属，Infinity=全量
 * @returns {Set<string>} 下属姓名集合
 */
function _findSubordinates(empName, empMaster, maxDepth = 1) {
  const result = new Set();
  let queue = [empName];
  let depth = 0;
  while (queue.length > 0 && depth < maxDepth) {
    const nextQueue = [];
    for (const name of queue) {
      for (const emp of empMaster) {
        // superiors 是 string[]（支持多上级），只要其中包含查询者即算下属
        if (Array.isArray(emp.superiors) && emp.superiors.includes(name) && !result.has(emp.name)) {
          result.add(emp.name);
          nextQueue.push(emp.name);
        }
      }
    }
    queue = nextQueue;
    depth++;
  }
  return result;
}

// ==================== 权限解析（纯表驱动，零推导）====================

/**
 * 解析指定员工的访问范围
 * @param {string} empName - 员工姓名
 * @param {object} [opts] - 可选参数
 * @param {number} [opts.maxDepth=1] - 下属查找层级（1=直接下属，用户明确要求时可传更大值）
 * @returns {Promise<AccessScope>}
 */
async function resolveScope(empName, opts = {}) {
  const maxDepth = opts.maxDepth || 1;
  await _ensureCache();

  // 兜底：如果传入的是 openId（ou_ 开头）而不是中文姓名，尝试用 openId 反查员工主档拿到真实姓名
  if (empName && typeof empName === 'string' && empName.startsWith('ou_')) {
    const masterByOpenId = _cache.empMaster.find(e => e.openId === empName);
    if (masterByOpenId && masterByOpenId.name) {
      logger.warn(`[PermManager] resolveScope 入参是 openId（${empName}），已通过员工主档 openId 字段反查到姓名="${masterByOpenId.name}"，建议上游修复。`);
      empName = masterByOpenId.name;
    } else {
      logger.error(`[PermManager] resolveScope 入参是 openId（${empName}），且在员工主档也查不到对应姓名，权限将退化为员工/self。`);
    }
  }

  const depts = new Set();
  const subordinateNames = new Set();
  let isGlobal = false;

  // ── 来源1：高级权限管理表 → isGlobal / 部门级扩展 ──
  for (const row of _cache.permTable) {
    if (!row.personNames.includes(empName)) continue;
    if (row.dept === '全部') {
      isGlobal = true;
      break;
    }
    depts.add(row.dept);
  }

  // ── 来源1.5：测试人员（视同管理者，2026-04-17 需求 2）──
  // 规则：测试人员列命中 → roleType 提升到"管理者"、dataScope='team'、
  //       allowExport/allowDrilldown=true，并把对应部门并入 depts；
  //       但不降级 CEO / 组织部（它们权限更大）。
  let testerOverride = false;
  const testerDepts = [];
  for (const row of _cache.permTable) {
    if (row.testerNames && row.testerNames.includes(empName)) {
      testerOverride = true;
      if (row.dept && row.dept !== '全部') {
        depts.add(row.dept);
        testerDepts.push(row.dept);
      } else if (row.dept === '全部') {
        isGlobal = true;
      }
    }
  }

  // ── 来源2：员工主档表 → 角色/范围/项目/上级（直读）──
  const masterInfo = _cache.empMaster.find(e => e.name === empName);
  let roleType = _normalizeRoleType(masterInfo ? masterInfo.roleType : '');

  if (!isGlobal && roleType === 'CEO') {
    isGlobal = true;
  }

  // testerOverride 生效：把普通员工/未知角色提升到管理者（不降级 CEO / 组织部）
  if (testerOverride && roleType !== 'CEO' && roleType !== '组织部') {
    roleType = '管理者';
  }

  let dataScope = masterInfo?.dataScope || _ROLE_DEFAULT_SCOPE[roleType] || 'self';
  if (testerOverride && roleType === '管理者' && dataScope === 'self') {
    dataScope = 'team';
  }
  // visibleProjects 已在 _loadEmployeeMaster 里按多分隔符拆分好。
  // 注意：员工主档部门只表示组织归属，不再进入经营数据授权部门。
  const visibleProjects = Array.isArray(masterInfo?.visibleProjects) ? masterInfo.visibleProjects : [];
  const homeDepts = Array.isArray(masterInfo?.depts) ? masterInfo.depts : [];
  const visibleProjectRangeResolved = masterInfo ? masterInfo.visibleProjectRangeResolved !== false : true;
  const unresolvedOptionIds = Array.isArray(masterInfo?.unresolvedOptionIds) ? masterInfo.unresolvedOptionIds : [];

  // ── 下属列表：BFS 反查（默认 depth=1 直接下属，用户明确要求时扩展）──
  const foundSubs = _findSubordinates(empName, _cache.empMaster, maxDepth);
  for (const name of foundSubs) {
    subordinateNames.add(name);
  }

  // ── 来源3：权限规则表 → 可见表/动作/敏感级别 ──
  const rule = _findRuleForRole(roleType);

  const visibleTableNames = rule?.visibleTables || [];  // 已是 string[]
  const visibleTableKeys = new Set();
  const unmapped = [];
  for (const cn of visibleTableNames) {
    const key = TABLE_NAME_MAP[cn];
    if (key) visibleTableKeys.add(key);
    else unmapped.push(cn);
  }
  if (unmapped.length > 0) {
    // 表名映射未命中说明 TABLE_NAME_MAP 漏了新表名，业务可能因此被误关，必须打 warning
    logger.warn(`[PermManager] 角色 "${roleType}" 的可见表中 ${unmapped.length} 个中文名未能映射到 config.TABLES key：[${unmapped.join('、')}]。请补齐 TABLE_NAME_MAP。`);
  }
  // 业务语义默认：所有角色可见自己档案、自己项目、实际/预算工时。
  // 人数/超编/人均类经营运算统一按 FTE，预算 FTE 来自 BUDGET_WORKTIME。
  visibleTableKeys.add('EMPLOYEE');
  visibleTableKeys.add('PROJECT_NAME_UNIQUE');
  visibleTableKeys.add('ACTUAL_WORKTIME');
  visibleTableKeys.add('BUDGET_WORKTIME');

  const visibleModules = isGlobal
    ? Object.keys(MODULE_TABLE_MAP)
    : _deriveVisibleModules(visibleTableKeys);

  const allowedActions = (rule?.allowedActions && rule.allowedActions.length > 0)
    ? rule.allowedActions
    : ['query'];

  // 2026-04-29 scope 诊断日志：确认每个用户的 isGlobal/roleType/depts 是否符合预期
  let responsibleProjectKeys = [];
  const shouldUseResponsibleFallback = !isGlobal && visibleProjects.length === 0 && visibleProjectRangeResolved;
  if (shouldUseResponsibleFallback) {
    try {
      responsibleProjectKeys = await _loadResponsibleProjectKeys(empName);
    } catch (error) {
      logger.warn(`[PermManager] ${empName} 负责人项目兜底加载失败: ${error.message}`);
    }
  }
  const projectKeys = _uniqNonEmpty([...visibleProjects, ...responsibleProjectKeys]);
  const permissionIntegrity = {
    visibleProjectRangeResolved,
    unresolvedOptionIds,
    visibleProjectRangeSource: masterInfo?.visibleProjectRangeSource || '',
    responsibleFallbackUsed: responsibleProjectKeys.length > 0,
  };

  logger.info(`[Scope] ${empName}: isGlobal=${isGlobal} roleType=${roleType} authDepts=[${[...depts]}] homeDepts=[${homeDepts}] projectKeys=${projectKeys.length}`);

  // ── 组装 AccessScope ──
  if (isGlobal) {
    return {
      isGlobal: true,
      roleType,
      role: roleType,
      dataScope: 'all',
      visibleTables:       visibleTableNames,
      visibleTableKeys,
      allowedActions,
      sensitivityLevel:    rule?.sensitivityLevel || 'L3',
      allowExport:         rule?.allowExport ?? true,
      allowDrilldown:      rule?.allowDrilldown ?? true,
      answerTopics:        rule?.answerTopics || '',
      depts:               [],
      homeDepts:           [],
      subordinateNames:    [],
      visibleProjects:     [],
      projectKeys:         [],
      responsibleProjectKeys: [],
      permissionIntegrity: { visibleProjectRangeResolved: true, unresolvedOptionIds: [] },
      managedProjectKeys:  [],
      directedProjectKeys: [],
      visibleModules:      Object.keys(MODULE_TABLE_MAP),
    };
  }

  // 一致性告警：role=管理者 但 dataScope=self 且 depts=[]，大概率是员工主档"姓名"字段
  // 没有维护（空值/飞书人员对象格式）导致上游传入 openId 匹配失败。
  if ((roleType === '管理者' || roleType === 'CEO' || roleType === '组织部')
      && dataScope === 'self' && depts.size === 0 && !isGlobal) {
    logger.warn(`[PermManager] 一致性告警：empName="${empName}" 被识别为 ${roleType} 但 dataScope=self 且 depts 为空，可能是员工主档姓名字段缺失，已退化为 self 范围。`);
  }

  return {
    isGlobal:            false,
    roleType,
    role:                roleType,
    dataScope,
    visibleTables:       visibleTableNames,
    visibleTableKeys,
    allowedActions,
    sensitivityLevel:    rule?.sensitivityLevel || 'L2',
    allowExport:         testerOverride ? true : (rule?.allowExport ?? false),
    allowDrilldown:      testerOverride ? true : (rule?.allowDrilldown ?? false),
    answerTopics:        rule?.answerTopics || '',
    depts:               [...depts],
    homeDepts,
    subordinateNames:    [...subordinateNames],
    visibleProjects,
    projectKeys,
    responsibleProjectKeys,
    permissionIntegrity,
    managedProjectKeys:  [],
    directedProjectKeys: [],
    visibleModules,
    testerOverride,         // 调试/追踪：是否因测试人员规则提权
    testerDepts,
  };
}

/**
 * 规范化角色类型：兼容表中各种写法
 */
function _normalizeRoleType(raw) {
  if (!raw) return '员工';
  const s = String(raw).trim();
  const lower = s.toLowerCase();
  if (lower === 'ceo' || lower.includes('ceo') || s.includes('总经理')) return 'CEO';
  if (s === '管理者' || s.includes('管理者')) return '管理者';
  if (s === '组织部' || s.includes('组织部') || s.includes('组织')) return '组织部';
  if (s === '员工' || s.includes('员工')) return '员工';
  return s || '员工';
}

/**
 * 从缓存的权限规则中找到匹配的规则
 */
function _findRuleForRole(roleType) {
  if (!_cache.permRules || _cache.permRules.length === 0) return null;
  const normalized = _normalizeRoleType(roleType);
  return _cache.permRules.find(r => _normalizeRoleType(r.roleType) === normalized) || null;
}

// ==================== 范围判断工具（保持 Skill 兼容）====================

function isInScope(targetName, targetDept, scope) {
  if (scope.isGlobal) return true;
  if (targetName && scope.subordinateNames.includes(targetName)) return true;
  if (targetDept && scope.depts.includes(targetDept)) return true;
  return false;
}

function isProjectInScope(projectKey, projectDept, scope) {
  if (scope.isGlobal) return true;
  if (projectKey && scope.projectKeys.includes(projectKey)) return true;
  if (projectDept && scope.depts.includes(projectDept)) return true;
  return false;
}

// ==================== Prompt 权限描述 ====================

function formatScopeForPrompt(empName, scope) {
  if (scope.isGlobal) {
    return `【数据访问权限】${empName}（角色: ${scope.roleType || 'CEO'}）拥有全局访问权限，可查看所有部门和员工数据。\n  • 可用板块: 全部`;
  }

  const lines = [`【数据访问权限】${empName}（角色: ${scope.roleType || '员工'}，数据范围: ${scope.dataScope || 'self'}）的授权范围：`];

  if (scope.visibleModules && scope.visibleModules.length > 0) {
    const labels = scope.visibleModules.map(m => MODULE_LABELS[m] || m).join('、');
    lines.push(`  • 可用板块: ${labels}`);
  }
  if (scope.visibleTables && scope.visibleTables.length > 0) {
    lines.push(`  • 可见数据表: ${scope.visibleTables.join('、')}`);
  }
  if (scope.answerTopics) {
    lines.push(`  • 可回答主题: ${scope.answerTopics}`);
  }
  if (scope.depts.length) {
    lines.push(`  • 可见部门: ${scope.depts.join('、')}`);
  }
  if (scope.homeDepts && scope.homeDepts.length) {
    lines.push(`  • 归属部门: ${scope.homeDepts.join('、')}（仅作组织归属，不作为经营数据授权）`);
  }
  if (scope.visibleProjects && scope.visibleProjects.length) {
    lines.push(`  • 可见项目: ${scope.visibleProjects.slice(0, 10).join('、')}${scope.visibleProjects.length > 10 ? '等' : ''}`);
  }
  if (scope.responsibleProjectKeys && scope.responsibleProjectKeys.length) {
    lines.push(`  • 负责人项目: ${scope.responsibleProjectKeys.slice(0, 10).join('、')}${scope.responsibleProjectKeys.length > 10 ? '等' : ''}`);
  }
  if (scope.subordinateNames.length) {
    lines.push(`  • 下属: ${scope.subordinateNames.slice(0, 20).join('、')}${scope.subordinateNames.length > 20 ? '等' : ''}`);
  }
  if (!scope.allowExport) lines.push('  • 不允许导出数据');
  if (!scope.allowDrilldown) lines.push('  • 不允许下钻到个人明细');
  if (scope.sensitivityLevel) lines.push(`  • 敏感级别: ${scope.sensitivityLevel}`);

  if (lines.length === 1) lines.push('  • 仅限本人数据');
  lines.push('  ⚠ 请勿输出超出以上范围的其他员工敏感数据。超出可用板块的数据请勿展示。');
  return lines.join('\n');
}

// ==================== 缓存管理 ====================

function invalidateCache() {
  _cache.expireAt = 0;
  logger.info('[PermManager] 缓存已失效，下次请求时重新加载');
}

async function debugList() {
  await _ensureCache();
  return {
    permTable: _cache.permTable,
    empMaster: _cache.empMaster,
    permRules: _cache.permRules,
  };
}

module.exports = {
  resolveScope,
  isInScope,
  isProjectInScope,
  formatScopeForPrompt,
  getVisibleTableKeys,
  MODULE_TABLE_MAP,
  MODULE_LABELS,
  TABLE_NAME_MAP,
  invalidateCache,
  debugList,
};
