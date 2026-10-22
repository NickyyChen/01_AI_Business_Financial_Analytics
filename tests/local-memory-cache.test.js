jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const config = require('../config');
const tableRegistry = require('../src/cache/local-cache-tables');
const store = require('../src/cache/local-memory-store');
const localListRecords = require('../src/cache/local-list-records');
const { filterRecords } = require('../src/cache/feishu-filter-evaluator');
const syncer = require('../src/cache/local-cache-syncer');
const client = require('../src/clients/feishu-client');
const cacheFreshness = require('../src/services/cache-freshness-service');

const originalConfig = {
  enabled: config.LOCAL_MEMORY_CACHE_ENABLED,
  fallback: config.LOCAL_MEMORY_CACHE_REMOTE_FALLBACK,
  p1Degraded: config.LOCAL_MEMORY_CACHE_ALLOW_P1_DEGRADED,
  concurrency: config.LOCAL_MEMORY_CACHE_SYNC_TABLE_CONCURRENCY,
};

function setCacheFor(defKey, rows, finishedAt = '2026-05-12T01:02:00.000Z') {
  const def = tableRegistry.getByKey(defKey);
  const cache = store.buildCache([
    {
      ok: true,
      def,
      rows,
      rowCount: rows.length,
      checksum: 'test',
      startedAt: finishedAt,
      finishedAt,
      durationMs: 1,
    },
  ], {
    runId: 'test-cache',
    startedAt: finishedAt,
    finishedAt,
  });
  store.setActiveCache(cache);
  return cache;
}

describe('local full memory cache', () => {
  beforeEach(() => {
    store.resetForTest();
    config.LOCAL_MEMORY_CACHE_ENABLED = false;
    config.LOCAL_MEMORY_CACHE_REMOTE_FALLBACK = false;
    config.LOCAL_MEMORY_CACHE_ALLOW_P1_DEGRADED = false;
    config.LOCAL_MEMORY_CACHE_SYNC_TABLE_CONCURRENCY = 2;
  });

  afterEach(() => {
    syncer.stopAutoRefresh();
    store.resetForTest();
    config.LOCAL_MEMORY_CACHE_ENABLED = originalConfig.enabled;
    config.LOCAL_MEMORY_CACHE_REMOTE_FALLBACK = originalConfig.fallback;
    config.LOCAL_MEMORY_CACHE_ALLOW_P1_DEGRADED = originalConfig.p1Degraded;
    config.LOCAL_MEMORY_CACHE_SYNC_TABLE_CONCURRENCY = originalConfig.concurrency;
  });

  test('evaluates supported Feishu filters locally', () => {
    const rows = [
      { record_id: 'r1', fields: { '飞书OpenID': 'ou_1', '姓名': '张三', '标签': ['财务BP'] } },
      { record_id: 'r2', fields: { '飞书OpenID': 'ou_2', '姓名': '李四', '标签': ['交付'] } },
      { record_id: 'r3', fields: { '飞书OpenID': 'ou_3', '姓名': '王五', '标签': ['管理', '财务分析'] } },
    ];

    const result = filterRecords(
      rows,
      'OR(CurrentValue.[飞书OpenID]="ou_2",contains(CurrentValue.[标签],"财务"))'
    );

    expect(result.ok).toBe(true);
    expect(result.records.map(r => r.record_id)).toEqual(['r1', 'r2', 'r3']);
  });

  test('local listRecords returns all matched rows and does not mutate active cache', () => {
    const rows = Array.from({ length: 1200 }, (_, idx) => ({
      record_id: `r${idx + 1}`,
      fields: {
        '飞书OpenID': `ou_${idx + 1}`,
        '姓名': `员工${idx + 1}`,
      },
    }));
    setCacheFor('EMPLOYEE', rows);

    const result = localListRecords.listRecords(config.TABLES.EMPLOYEE, { page_size: 10 });

    expect(result.handled).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.records).toHaveLength(1200);
    expect(result.meta.truncated).toBe(false);

    result.records[0].fields['姓名'] = '被外部修改';
    expect(store.getTableByKey('EMPLOYEE').rows[0].fields['姓名']).toBe('员工1');
  });

  test('feishu-client listRecords uses local cache for configured P0/P1 tables', async () => {
    config.LOCAL_MEMORY_CACHE_ENABLED = true;
    setCacheFor('EMPLOYEE', [
      { record_id: 'r1', fields: { '飞书OpenID': 'ou_1', '姓名': '张三' } },
      { record_id: 'r2', fields: { '飞书OpenID': 'ou_2', '姓名': '李四' } },
    ]);

    const rows = await client.listRecords(config.TABLES.EMPLOYEE, {
      filter: 'CurrentValue.[飞书OpenID]="ou_2"',
      page_size: 1,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].fields['姓名']).toBe('李四');
  });

  test('syncer builds an atomic active cache from all configured table definitions', async () => {
    config.LOCAL_MEMORY_CACHE_ENABLED = true;
    config.LOCAL_MEMORY_CACHE_SYNC_TABLE_CONCURRENCY = 3;

    const status = await syncer.refresh({
      force: true,
      reason: 'unit-test',
      fetchRecords: async (def) => [
        {
          record_id: `${def.key}_1`,
          fields: {
            ...Object.fromEntries((def.requiredFields || []).map(field => [field, `${field}-value`])),
            ...Object.fromEntries((def.requiredAnyFields || []).map(group => [group[0], `${group[0]}-value`])),
          },
        },
      ],
    });

    expect(status.ready).toBe(true);
    expect(status.tableCount).toBe(tableRegistry.getTableDefs().length);
    expect(status.rows).toBe(tableRegistry.getTableDefs().length);
    expect(store.getTableByKey('ACTUAL_PROJECT').rows).toHaveLength(1);
  });

  test('answer freshness prefix is available after cache is ready', () => {
    config.LOCAL_MEMORY_CACHE_ENABLED = true;
    setCacheFor('EMPLOYEE', [
      { record_id: 'r1', fields: { '飞书OpenID': 'ou_1', '姓名': '张三' } },
    ]);

    const reply = cacheFreshness.ensureAnswerPrefix('经营结论正文');

    expect(reply).toContain('数据截止');
    expect(reply).toContain('经营结论正文');
  });
});
