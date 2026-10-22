'use strict';

const config = require('../../config');

const TABLE_DEFS = [
  // P0: identity / permission / finance core
  { key: 'EMPLOYEE', priority: 'P0', required: true, allowEmpty: false, requiredFields: ['飞书OpenID', '姓名'] },
  { key: 'PERMISSION_RULE', priority: 'P0', required: true, allowEmpty: false, requiredFields: ['角色类型', '可见表'] },
  { key: 'PERMISSION_MGMT', priority: 'P0', required: true, allowEmpty: false, requiredFields: ['部门范围'] },
  { key: 'RISK_CONTROL_RULE', priority: 'P0', required: true, allowEmpty: false, requiredFields: ['规则名称'] },
  { key: 'PROJECT_NAME_UNIQUE', priority: 'P0', required: true, allowEmpty: false, requiredFields: ['26年项目名称', '项目归属部门'] },
  { key: 'ACTUAL_PROJECT', priority: 'P0', required: true, allowEmpty: false, requiredFields: ['是否交付项目', '月份', '履约成本', '履约利润'], requiredAnyFields: [['履约收入', '履约收入（回滚）']] },
  { key: 'ACTUAL_DEPT', priority: 'P0', required: true, allowEmpty: false, requiredFields: ['一级部门', '月份', '履约收入', '履约成本', '履约利润'] },
  { key: 'BUDGET_PROJECT', priority: 'P0', required: true, allowEmpty: false, requiredFields: ['是否交付项目', '月份', '履约收入', '履约成本', '履约利润'] },
  { key: 'BUDGET_DEPT', priority: 'P0', required: true, allowEmpty: false, requiredFields: ['一级部门', '月份', '履约收入'] },
  { key: 'INVOICE', priority: 'P0', required: true, allowEmpty: false, requiredFields: ['项目', '履约月份', '已履约未回款'] },
  { key: 'PENDING_PAYMENT', priority: 'P0', required: true, allowEmpty: false, requiredFields: ['认领状态', '银行到款金额'] },
  { key: 'INVOICE_APPLY', priority: 'P0', required: true, allowEmpty: false, requiredFields: ['申请编号', '项目名称', '开票金额（含税）'] },

  // P1: finance extensions
  { key: 'ACTUAL_WORKTIME', priority: 'P1', required: true, allowEmpty: false, requiredFields: ['姓名', '匹配项目', '精力'] },
  { key: 'BUDGET_WORKTIME', priority: 'P1', required: true, allowEmpty: false, requiredFields: ['匹配项目', '精力'] },
  { key: 'PRESALE_PROJECT', priority: 'P1', required: true, allowEmpty: false, requiredFields: ['售前状态'] },
  { key: 'SIGN_DELIVERY', priority: 'P1', required: true, allowEmpty: false, requiredFields: ['合同金额'] },
  { key: 'BIDDING_PROJECT', priority: 'P1', required: true, allowEmpty: false, requiredFields: ['投标结果'] },
  { key: 'VENDOR_CONTRACT', priority: 'P1', required: true, allowEmpty: false, requiredFields: ['供应商名称'] },
  { key: 'TALENT_POOL', priority: 'P1', required: true, allowEmpty: false, requiredFields: ['姓名'] },
  { key: 'DEPT_YOY', priority: 'P1', required: true, allowEmpty: false, requiredFields: ['一级部门'] },
  { key: 'COMPANY_YOY', priority: 'P1', required: true, allowEmpty: false, requiredFields: ['月份'] },
  { key: 'REVENUE_MOM', priority: 'P1', required: true, allowEmpty: false, requiredFields: ['一级部门', '项目'] },
  { key: 'ROLLBACK_PROJECT_ACTUAL', priority: 'P1', required: true, allowEmpty: false, requiredFields: [] },
  // Identity aux tables: read-only in the request path; keep startup robust, but do not block finance service.
  { key: 'EMPLOYEE_PROFILE', priority: 'P1', required: false, allowEmpty: true, requiredFields: [] },
  { key: 'ROSTER', priority: 'P1', required: false, allowEmpty: true, requiredFields: [] },
];

function _withTableId(def) {
  return {
    ...def,
    tableId: config.TABLES[def.key] || '',
  };
}

function getTableDefs() {
  return TABLE_DEFS.map(_withTableId).filter(def => !!def.tableId);
}

function getRequiredTableDefs() {
  return getTableDefs().filter(def => def.required);
}

function getByTableId(tableId) {
  if (!tableId) return null;
  return getTableDefs().find(def => def.tableId === tableId) || null;
}

function getByKey(key) {
  if (!key) return null;
  return getTableDefs().find(def => def.key === key) || null;
}

function isCachedTableId(tableId) {
  return !!getByTableId(tableId);
}

module.exports = {
  TABLE_DEFS,
  getTableDefs,
  getRequiredTableDefs,
  getByTableId,
  getByKey,
  isCachedTableId,
};
