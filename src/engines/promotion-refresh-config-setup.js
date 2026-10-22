'use strict';

const config = require('../../config');
const client = require('../clients/feishu-client');

const TABLE_NAME = '【晋升刷新频次配置表】';

const FIELDS = [
  { field_name: '配置项', type: 1 },
  { field_name: '刷新对象', type: 1 },
  { field_name: '推荐频次', type: 1 },
  { field_name: '触发条件', type: 1 },
  { field_name: '频次说明', type: 1 },
  { field_name: '是否启用', type: 7 },
  { field_name: '更新时间', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm', auto_fill: false } },
];

const DEFAULT_ROWS = [
  {
    配置项: 'promotion-gap-daily',
    刷新对象: '晋升差距建议表',
    推荐频次: '每日 06:00',
    触发条件: '常规刷新',
    频次说明: '员工职级、积分、学习完成率、SKU 点亮状态都属于日级别可变数据，建议每日清晨全量刷新一次，保证管理者白天查看到的是最新状态。',
    是否启用: true,
  },
  {
    配置项: 'promotion-gap-window-boost',
    刷新对象: '晋升差距建议表',
    推荐频次: '晋升窗口期每日 2 次（06:00 / 18:00）',
    触发条件: '当月命中晋升窗口 3-4 月或 9-10 月',
    频次说明: '晋升窗口内动作更密集，晚间补一次可覆盖当日补证、学习达标与积分变动，减少窗口期判断滞后。',
    是否启用: true,
  },
  {
    配置项: 'promotion-gap-sku-event',
    刷新对象: '晋升差距建议表',
    推荐频次: 'SKU 运行表重算后立即补跑',
    触发条件: '运行 SKU 点亮脚本执行完成',
    频次说明: '晋升差距高度依赖 SKU 点亮结果。只要 SKU 运行表重算完成，就应立刻同步一次，避免规则表和运行表状态错位。',
    是否启用: true,
  },
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

async function listRecords(tableId) {
  return client.listRecords(tableId, { page_size: 200 });
}

async function upsertDefaults(tableId) {
  const records = await listRecords(tableId);
  const byKey = new Map();
  for (const record of records) {
    const key = record && record.fields ? record.fields['配置项'] : '';
    if (key) {
      byKey.set(key, record);
    }
  }

  for (const row of DEFAULT_ROWS) {
    const fields = { ...row, 更新时间: Date.now() };
    const existing = byKey.get(row['配置项']);
    if (existing) {
      await client.updateRecord(tableId, existing.record_id, fields);
    } else {
      await client.createRecord(tableId, fields);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function ensureTable() {
  if (process.env.PROMOTION_REFRESH_CONFIG_TABLE_ID) {
    return process.env.PROMOTION_REFRESH_CONFIG_TABLE_ID;
  }

  const tables = await listTables();
  const existing = tables.find((item) => item.name === TABLE_NAME);
  const tableId = existing ? existing.table_id : await createTable(TABLE_NAME);
  await ensureFields(tableId);
  await upsertDefaults(tableId);
  return tableId;
}

module.exports = { ensureTable, TABLE_NAME };
