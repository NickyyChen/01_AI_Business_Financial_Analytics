'use strict';

const config = require('../../config');
const client = require('../clients/feishu-client');

const TABLE_NAME = '【晋升差距建议表】';

const FIELDS = [
  { field_name: '差距ID', type: 1 },
  { field_name: '员工ID', type: 1 },
  { field_name: '飞书OpenID', type: 1 },
  { field_name: '姓名', type: 1 },
  { field_name: '当前职级', type: 1 },
  { field_name: '目标职级', type: 1 },
  { field_name: '当前状态', type: 1 },
  { field_name: '晋升窗口', type: 1 },
  { field_name: '推荐名额比例_pct', type: 2 },
  { field_name: '需要360评估', type: 7 },
  { field_name: '需要人工评审', type: 7 },
  { field_name: '当前学习完成率_pct', type: 2 },
  { field_name: '学习门槛_pct', type: 2 },
  { field_name: '学习差距_pct', type: 2 },
  { field_name: '综合达成度_pct', type: 2 },
  { field_name: '必做任务', type: 1 },
  { field_name: '必须点亮SKU', type: 1 },
  { field_name: '已满足SKU', type: 1 },
  { field_name: '待补SKU', type: 1 },
  { field_name: 'SKU差距说明', type: 1 },
  { field_name: '证据摘要', type: 1 },
  { field_name: '申报材料建议', type: 1 },
  { field_name: '制度提醒', type: 1 },
  { field_name: '综合差距结论', type: 1 },
  { field_name: '努力建议', type: 1 },
  { field_name: '规则版本', type: 1 },
  { field_name: '更新时间', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm', auto_fill: false } },
];

async function listTables() {
  const res = await client.get(`/open-apis/bitable/v1/apps/${config.BITABLE_APP_TOKEN}/tables?page_size=200`);
  if (res.code !== 0) {
    throw new Error(`列举表失败: code=${res.code} msg=${res.msg}`);
  }
  return (res.data && res.data.items) || [];
}

async function listFields(tableId) {
  const res = await client.get(`/open-apis/bitable/v1/apps/${config.BITABLE_APP_TOKEN}/tables/${tableId}/fields?page_size=200`);
  if (res.code !== 0) {
    throw new Error(`列举字段失败: code=${res.code} msg=${res.msg}`);
  }
  return (res.data && res.data.items) || [];
}

async function createTable(name) {
  const res = await client.post(`/open-apis/bitable/v1/apps/${config.BITABLE_APP_TOKEN}/tables`, { table: { name } });
  if (res.code !== 0) {
    throw new Error(`创建表失败: code=${res.code} msg=${res.msg}`);
  }
  return res.data.table_id;
}

async function addField(tableId, fieldDef) {
  const res = await client.post(`/open-apis/bitable/v1/apps/${config.BITABLE_APP_TOKEN}/tables/${tableId}/fields`, fieldDef);
  if (res.code !== 0) {
    throw new Error(`创建字段失败 [${fieldDef.field_name}]: code=${res.code} msg=${res.msg}`);
  }
}

async function ensureFields(tableId) {
  const existing = await listFields(tableId);
  const existingNames = new Set(existing.map((item) => item.field_name));
  for (const field of FIELDS) {
    if (existingNames.has(field.field_name)) {
      continue;
    }
    await addField(tableId, field);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function ensureTable() {
  if (process.env.PROMOTION_GAP_TABLE_ID) {
    return process.env.PROMOTION_GAP_TABLE_ID;
  }

  const tables = await listTables();
  const existing = tables.find((item) => item.name === TABLE_NAME);
  const tableId = existing ? existing.table_id : await createTable(TABLE_NAME);
  await ensureFields(tableId);
  return tableId;
}

module.exports = { ensureTable, TABLE_NAME };
