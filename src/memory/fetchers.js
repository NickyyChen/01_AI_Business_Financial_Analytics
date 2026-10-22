const config = require('../../config');
const client = require('../clients/feishu-client');
const logger = require('../utils/logger');
const FM = require('../utils/field-mapping');

function _escapeFilter(val) {
  return String(val || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function _mergeByRecordId(a, b) {
  const map = new Map();
  for (const row of [...(a || []), ...(b || [])]) {
    if (!row) continue;
    const key = row.record_id || row.id || JSON.stringify(row.fields || row);
    if (!map.has(key)) map.set(key, row);
  }
  return [...map.values()];
}

async function _listRecordsWithRetry(tableId, query, opts = {}) {
  const { retries = 3, backoffMs = 800 } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await client.listRecords(tableId, query);
    } catch (e) {
      lastErr = e;
      const msg = e && e.message ? e.message : '';
      const isRateLimit = /99991400|frequency limit|rate limit|too many/i.test(msg);
      const isTransient = isRateLimit || /1254607|Data not ready|ETIMEDOUT|ECONNRESET|socket hang up/i.test(msg);
      if (attempt < retries && isTransient) {
        const base = isRateLimit ? backoffMs * (2 ** attempt) : backoffMs;
        const jitter = base * (0.7 + Math.random() * 0.6);
        const wait = Math.round(jitter);
        logger.warn(`[Memory] listRecords 瞬时错误，${wait}ms 后重试 (attempt ${attempt + 1}/${retries}, table=${tableId}): ${msg}`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function _runWithLimit(items, limit, fn) {
  if (!items || items.length === 0) return [];
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        out[i] = { __error: e };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

async function fetchProfile(userId, userName) {
  const names = new Set([userId]);
  if (userName && userName !== userId) names.add(userName);

  const conditions = [];
  for (const n of names) {
    const e = _escapeFilter(n);
    conditions.push(`CurrentValue.[员工ID]="${e}"`, `CurrentValue.[飞书OpenID]="${e}"`, `CurrentValue.[姓名]="${e}"`);
  }
  const filter = `OR(${conditions.join(',')})`;
  const records = await client.listRecords(config.TABLES.EMPLOYEE, { filter });
  if (records.length > 0) {
    return records[0].fields;
  }

  const rosterConditions = [];
  for (const n of names) {
    const e = _escapeFilter(n);
    rosterConditions.push(`CurrentValue.[工号]="${e}"`, `CurrentValue.[姓名]="${e}"`);
  }
  const rosterFilter = `OR(${rosterConditions.join(',')})`;
  const roster = await client.listRecords(config.TABLES.ROSTER, { filter: rosterFilter });
  if (roster.length > 0) {
    logger.info(`[Memory] 花名册找到 "${userName}" 的档案`);
    return roster[0].fields;
  }

  logger.info(`[Memory] 员工表和花名册均未找到 "${userName}"`);
  return null;
}

async function fetchUserRecords(tableId, userId, userName) {
  const name = userName || userId;
  const e = _escapeFilter(name);
  const filter = `OR(CurrentValue.[员工ID]="${e}",CurrentValue.[姓名]="${e}")`;
  const records = await client.listRecords(tableId, { filter });
  if (records.length > 0) return records;

  const allRecords = await client.listRecords(tableId, { page_size: 200 });
  if (allRecords.length === 0) return [];

  const IDENTITY_FIELDS = ['员工ID', '姓名', '飞书OpenID', '工号'];
  const filtered = allRecords.filter(r => {
    const f = r.fields || {};
    return IDENTITY_FIELDS.some(field => {
      const val = f[field];
      if (!val) return false;
      if (typeof val === 'string') return val === name;
      if (Array.isArray(val)) return val.some(p => (p.name || p.en_name || p) === name);
      return false;
    });
  });

  if (filtered.length > 0) {
    logger.info(`[Memory] 表内存精确过滤到 ${filtered.length} 条 "${name}" 相关记录`);
    return filtered;
  }

  logger.info(`[Memory] 按 "${name}" 在表中未找到任何相关记录`);
  return [];
}

async function fetchProjectStaffing(userId, userName) {
  const name = userName || userId;
  const e = _escapeFilter(name);
  const filter = `CurrentValue.[姓名]="${e}"`;
  try {
    const records = await client.listRecords(config.TABLES.ACTUAL_WORKTIME, { filter, page_size: 500 });
    logger.info(`[Memory] ACTUAL_WORKTIME 精确匹配 ${records.length} 条 "${name}"`);
    return records;
  } catch (err) {
    logger.warn(`[Memory] ACTUAL_WORKTIME 查询失败: ${err.message}`);
    return [];
  }
}

async function fetchWorktimeByDepts(tableId, depts) {
  if (!tableId || !Array.isArray(depts) || depts.length === 0) return [];
  const BATCH = 10;
  const chunks = [];
  for (let i = 0; i < depts.length; i += BATCH) chunks.push(depts.slice(i, i + BATCH));

  const concurrency = Math.max(1, config.FEISHU_BATCH_CONCURRENCY || 3);
  const batchResults = await _runWithLimit(chunks, concurrency, async (deptBatch, idx) => {
    const conds = [];
    for (const d of deptBatch) {
      const e = _escapeFilter(d);
      conds.push(`CurrentValue.[管报-一级部门（手工）]="${e}"`);
      conds.push(`CurrentValue.[一级部门]="${e}"`);
    }
    const filter = conds.length === 1 ? conds[0] : `OR(${conds.join(',')})`;
    try {
      return await _listRecordsWithRetry(tableId, { filter, page_size: 500 });
    } catch (e) {
      logger.warn(`[Memory] 工时按部门直查失败 (table=${tableId}, batch ${idx}): ${e.message}`);
      return [];
    }
  });

  const seen = new Set();
  const all = [];
  for (const batch of batchResults) {
    if (!batch || batch.__error || !Array.isArray(batch)) continue;
    for (const r of batch) {
      const id = r.record_id || r.id;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      all.push(r);
    }
  }
  logger.info(`[Memory] 工时按部门直查: table=${tableId} depts=[${depts.join(',')}] → ${all.length} 条`);
  return all;
}

const MASTER_RESPONSIBLE_FIELDS = [
  '项目总监',
  '项目经理',
  '测试用途',
];

const VALID_PROJECT_STATUS = new Set(['履约中', '已结案', '预计新签']);

function _isValidProjectStatus(fields) {
  const status = FM.str(fields, FM.PROJECT_NAME_UNIQUE_FIELDS.STATUS);
  return VALID_PROJECT_STATUS.has(status);
}

async function fetchProjectMasterByPerson(userName) {
  if (!userName) return [];
  try {
    const allRecords = await client.listRecords(config.TABLES.PROJECT_NAME_UNIQUE, { page_size: 200 });
    const matched = [];
    let skippedVirtual = 0;
    for (const r of allRecords) {
      const f = r.fields || {};
      if (!_isValidProjectStatus(f)) { skippedVirtual++; continue; }
      const hitFields = [];
      for (const key of MASTER_RESPONSIBLE_FIELDS) {
        const val = f[key];
        if (!val) continue;
        const hit = (typeof val === 'string' && val.includes(userName))
          || (Array.isArray(val) && val.some(p => p && (p.name === userName || p.en_name === userName)));
        if (hit) hitFields.push(key);
      }
      if (hitFields.length > 0) {
        r._matchFields = hitFields;
        matched.push(r);
      }
    }

    if (skippedVirtual > 0) {
      logger.info(`[Memory] PROJECT_NAME_UNIQUE 状态过滤: 跳过 ${skippedVirtual} 条非有效状态(虚拟)项目`);
    }
    if (matched.length > 0) {
      logger.info(`[Memory] PROJECT_NAME_UNIQUE 人员字段匹配到 ${matched.length} 个 "${userName}" 的项目`);
    }
    return matched;
  } catch (e) {
    logger.warn(`[Memory] PROJECT_NAME_UNIQUE 人员字段查询失败: ${e.message}`);
    return [];
  }
}

async function fetchProjectsByKeys(tableId, projectKeys, projectField = '26年项目名称', opts = {}) {
  const { fallbackField = null } = opts || {};
  const concurrency = Math.max(1, config.FEISHU_BATCH_CONCURRENCY || 3);

  const batches = [];
  for (let i = 0; i < projectKeys.length; i += 20) {
    batches.push(projectKeys.slice(i, i + 20));
  }

  const mainResults = await _runWithLimit(batches, concurrency, async (batch, idx) => {
    const conditions = batch.map(k => `CurrentValue.[${projectField}]="${_escapeFilter(k)}"`);
    const filter = conditions.length === 1 ? conditions[0] : `OR(${conditions.join(',')})`;
    try {
      return await _listRecordsWithRetry(tableId, { filter, page_size: 100 });
    } catch (e) {
      logger.warn(`[Memory] 表查询失败 (table=${tableId} field=${projectField} batch=${idx * 20}): ${e.message}`);
      return [];
    }
  });

  const allResults = [];
  const hitKeys = new Set();
  for (const batchRecords of mainResults) {
    if (!batchRecords || batchRecords.__error || !Array.isArray(batchRecords)) continue;
    allResults.push(...batchRecords);
    for (const r of batchRecords) {
      const v = (r.fields || {})[projectField];
      if (v != null && v !== '') hitKeys.add(String(v));
    }
  }

  if (fallbackField) {
    const missedKeys = projectKeys.filter(k => k && !hitKeys.has(String(k)));
    if (missedKeys.length > 0) {
      const fallbackBatches = [];
      for (let i = 0; i < missedKeys.length; i += 20) {
        fallbackBatches.push(missedKeys.slice(i, i + 20));
      }
      const fallbackResults = await _runWithLimit(fallbackBatches, concurrency, async (batch, idx) => {
        const conditions = batch.map(k => `CurrentValue.[${fallbackField}]="${_escapeFilter(k)}"`);
        const filter = conditions.length === 1 ? conditions[0] : `OR(${conditions.join(',')})`;
        try {
          return await _listRecordsWithRetry(tableId, { filter, page_size: 100 });
        } catch (e) {
          logger.warn(`[Memory] 回退查询失败 (table=${tableId} fallback=${fallbackField} batch=${idx * 20}): ${e.message}`);
          return [];
        }
      });
      let fallbackHits = 0;
      for (const batchRecords of fallbackResults) {
        if (!batchRecords || batchRecords.__error || !Array.isArray(batchRecords)) continue;
        allResults.push(...batchRecords);
        fallbackHits += batchRecords.length;
      }
      logger.info(`[Memory] fetchProjectsByKeys fallback: table=${tableId} fallback=${fallbackField} missed=${missedKeys.length} hit=${fallbackHits}`);
    }
  }

  logger.info(`[Memory] fetchProjectsByKeys: table=${tableId} field=${projectField} keys=${projectKeys.length} results=${allResults.length} concurrency=${concurrency}`);
  return allResults;
}

async function fetchProjectTeamByKeys(projectKeys) {
  if (!projectKeys || projectKeys.length === 0) return [];
  if (!config.TABLES.ACTUAL_WORKTIME) return [];

  const concurrency = Math.max(1, config.FEISHU_BATCH_CONCURRENCY || 3);
  const batches = [];
  for (let i = 0; i < projectKeys.length; i += 5) {
    batches.push(projectKeys.slice(i, i + 5));
  }

  const batchResults = await _runWithLimit(batches, concurrency, async (batch, idx) => {
    const conditions = batch.map(k => `CurrentValue.[标准项目名称新].contains("${_escapeFilter(k)}")`);
    const filter = conditions.length === 1 ? conditions[0] : `OR(${conditions.join(',')})`;
    try {
      return await _listRecordsWithRetry(config.TABLES.ACTUAL_WORKTIME, { filter, page_size: 500 });
    } catch (e) {
      logger.warn(`[Memory] 项目团队查询失败 (batch ${idx * 5}): ${e.message}`);
      return [];
    }
  });

  const allResults = [];
  for (const batchRecords of batchResults) {
    if (!batchRecords || batchRecords.__error || !Array.isArray(batchRecords)) continue;
    allResults.push(...batchRecords);
  }

  const keySet = new Set(projectKeys);
  const filtered = allResults.filter(r => {
    const projMatch = FM.lookupFirst((r.fields || {})['匹配项目']);
    return keySet.has(projMatch);
  });
  logger.info(`[Memory] 项目团队投入原始数据: ${filtered.length} 条 (from ${allResults.length} raw) concurrency=${concurrency}`);
  return filtered;
}

async function fetchUserRiskAlerts(userId, userName) {
  if (!config.TABLES.USER_RISK_ALERT) return [];
  const name = userName || userId;
  const today = new Date().toISOString().slice(0, 10);
  const eu = _escapeFilter(userId);
  const en = _escapeFilter(name);
  const filter = `AND(OR(CurrentValue.[员工ID]="${eu}",CurrentValue.[员工ID]="${en}",CurrentValue.[员工姓名]="${en}"),CurrentValue.[扫描日期]="${today}")`;
  try {
    const records = await client.listRecords(config.TABLES.USER_RISK_ALERT, { filter, page_size: 50 });
    if (records.length > 0) {
      logger.info(`[Memory] 风险告警快照: ${name} 今日 ${records.length} 条`);
    }
    return records;
  } catch (e) {
    logger.warn(`[Memory] 读取风险告警快照失败: ${e.message}`);
    return [];
  }
}

async function fetchAllRecords(tableId) {
  try {
    return await _listRecordsWithRetry(tableId, { page_size: 500 });
  } catch (e) {
    logger.warn(`[Memory] 全表加载失败 (${tableId}): ${e.message}`);
    return [];
  }
}

async function fetchEmployeeProfile(userName) {
  if (!config.TABLES.EMPLOYEE_PROFILE || !userName) return null;
  try {
    const e = _escapeFilter(userName);
    const filter = `OR(CurrentValue.[姓名]="${e}",CurrentValue.[工号]="${e}")`;
    const records = await client.listRecords(config.TABLES.EMPLOYEE_PROFILE, { filter, page_size: 3 });
    if (!records.length) return null;
    return records[0].fields || null;
  } catch (e) {
    logger.warn(`[Memory] EMPLOYEE_PROFILE 查询失败: ${e.message}`);
    return null;
  }
}

async function fetchUserReviews(userName) {
  if (!config.TABLES.REVIEW || !userName) return [];
  try {
    const all = await client.listRecords(config.TABLES.REVIEW, { page_size: 100 });
    const matched = all.filter(r => {
      const f = r.fields || {};
      const persons = f['来源人员'];
      if (!persons) return false;
      if (Array.isArray(persons)) return persons.some(p => (p.name || p.en_name || '') === userName);
      return String(persons).includes(userName);
    });
    return matched
      .sort((a, b) => Number((b.fields || {})['创建时间'] || 0) - Number((a.fields || {})['创建时间'] || 0))
      .slice(0, 5);
  } catch (e) {
    logger.warn(`[Memory] REVIEW 查询失败: ${e.message}`);
    return [];
  }
}

module.exports = {
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
};
