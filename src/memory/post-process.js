const config = require('../../config');
const client = require('../clients/feishu-client');
const logger = require('../utils/logger');

function _tagProjectMasterSource(memory, masterFromPerson, personalProjectKeys) {
  if (!memory.projectMaster || memory.projectMaster.length === 0) {
    memory.projectMaster = (masterFromPerson || []).filter(row => {
      const fields = row.fields || {};
      const key26 = fields['26年项目名称'] || '';
      const keyMr = fields['项目名称（管报）'] || '';
      return personalProjectKeys && (personalProjectKeys.has(key26) || personalProjectKeys.has(keyMr));
    });
  }
  const matchFieldsMap = new Map();
  for (const row of masterFromPerson) {
    if (!row._matchFields) continue;
    const fields = row.fields || {};
    const key = fields['26年项目名称'] || fields['项目名称（管报）'] || '';
    if (key) matchFieldsMap.set(key, row._matchFields);
  }
  for (const row of memory.projectMaster) {
    const fields = row.fields || {};
    const key26 = fields['26年项目名称'] || '';
    const keyMr = fields['项目名称（管报）'] || '';
    const isPersonal = personalProjectKeys.has(key26) || personalProjectKeys.has(keyMr);
    row._source = isPersonal ? 'personal' : 'department';
    if (isPersonal) {
      row._matchFields = matchFieldsMap.get(key26) || matchFieldsMap.get(keyMr) || [];
    }
  }
}

async function _applyManagerCompanyOverlay(memory, scope) {
  if (!scope || scope.isGlobal) return;
  const roleType = scope.roleType;
  if (roleType !== '管理者' && roleType !== '组织部') return;
  if (!Array.isArray(scope.depts) || scope.depts.length === 0) return;
  if (!config.TABLES.PROJECT_NAME_UNIQUE || !config.TABLES.ACTUAL_PROJECT) return;

  const extractKey = (value) => {
    if (value == null) return '';
    if (Array.isArray(value)) {
      const first = value[0];
      if (first == null) return '';
      if (typeof first === 'string') return first;
      return first.text || first.name || '';
    }
    if (typeof value === 'string') {
      const matched = value.match(/^\["(.+)"\]$/);
      return matched ? matched[1] : value;
    }
    return String(value);
  };

  try {
    const companyRows = await client.listRecords(config.TABLES.PROJECT_NAME_UNIQUE, {
      filter: 'CurrentValue.[项目归属部门]="公司层面"',
      page_size: 500,
    });
    const companyKeys = new Set();
    const companyMasterByKey = new Map();
    for (const row of companyRows) {
      const fields = row.fields || {};
      const name = extractKey(fields['26年项目名称']) || extractKey(fields['项目名称（管报）']);
      if (name) {
        companyKeys.add(name);
        if (!companyMasterByKey.has(name)) companyMasterByKey.set(name, row);
      }
    }
    if (companyKeys.size === 0) {
      logger.info('[Memory] 管理者口径 overlay：公司层面项目为空，跳过');
      return;
    }

    const deptConds = scope.depts.map((dept) => `CurrentValue.[一级部门]="${String(dept).replace(/"/g, '\\"')}"`);
    const deptFilter = deptConds.length === 1 ? deptConds[0] : `OR(${deptConds.join(',')})`;
    const deptActualRows = await client.listRecords(config.TABLES.ACTUAL_PROJECT, {
      filter: deptFilter,
      page_size: 500,
    });

    const existingRecIds = new Set((memory.projectMonthly || []).map((row) => row.record_id).filter(Boolean));
    const overlayRows = [];
    const overlayKeys = new Set();
    for (const row of deptActualRows) {
      const fields = row.fields || {};
      const key = extractKey(fields['是否交付项目']);
      if (!key || !companyKeys.has(key)) continue;
      if (row.record_id && existingRecIds.has(row.record_id)) continue;
      overlayRows.push(row);
      overlayKeys.add(key);
    }

    if (overlayRows.length === 0) {
      logger.info(`[Memory] 管理者口径 overlay：scope.depts=[${scope.depts.join(',')}] 本部门账上无公司层面分摊项目，未补齐`);
      return;
    }

    memory.projectMonthly = [...(memory.projectMonthly || []), ...overlayRows];
    if (Array.isArray(memory.actualProject)) {
      memory.actualProject = [...memory.actualProject, ...overlayRows];
    }

    if (Array.isArray(memory.projectMaster)) {
      const existMasterIds = new Set(memory.projectMaster.map((row) => row.record_id).filter(Boolean));
      for (const key of overlayKeys) {
        const masterRow = companyMasterByKey.get(key);
        if (!masterRow) continue;
        if (masterRow.record_id && existMasterIds.has(masterRow.record_id)) continue;
        memory.projectMaster.push({ ...masterRow, _source: 'manager-company-overlay' });
      }
    }

    logger.info(
      `[Memory] 管理者口径 overlay：scope.depts=[${scope.depts.join(',')}]，补齐 ${overlayRows.length} 条公司层面分摊行（涉及 ${overlayKeys.size} 个项目：${[...overlayKeys].slice(0, 5).join('、')}${overlayKeys.size > 5 ? ' 等' : ''}）`,
    );
  } catch (error) {
    logger.warn(`[Memory] 管理者口径 overlay 失败（不影响主流程）：${error.message}`);
  }
}

module.exports = {
  _tagProjectMasterSource,
  _applyManagerCompanyOverlay,
};
