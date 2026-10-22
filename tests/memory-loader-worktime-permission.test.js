'use strict';

jest.mock('../src/utils/logger', () => ({
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
}));

jest.mock('../src/permissions/permission-manager', () => ({
  resolveScope: jest.fn(async () => ({
    isGlobal: false,
    roleType: '管理者',
    dataScope: 'team',
    visibleModules: ['finance', 'project', 'team'],
    depts: ['视频号业务线'],
    projectKeys: [],
    subordinateNames: [],
  })),
}));

const mockFetchers = {
  _escapeFilter: (s) => String(s || ''),
  _mergeByRecordId: (a = [], b = []) => {
    const map = new Map();
    for (const row of [...a, ...b]) {
      const id = row.record_id || JSON.stringify(row.fields || row);
      if (!map.has(id)) map.set(id, row);
    }
    return [...map.values()];
  },
  _listRecordsWithRetry: jest.fn(async () => []),
  _runWithLimit: jest.fn(async (items, _limit, fn) => Promise.all(items.map((item, idx) => fn(item, idx)))),
  fetchProfile: jest.fn(async () => ({ '姓名': '任美嘉', '标准部门': '视频号业务线' })),
  fetchUserRecords: jest.fn(async () => []),
  fetchProjectStaffing: jest.fn(async () => [
    {
      record_id: 'recvgV64YcmqX0',
      fields: {
        '姓名': '任美嘉',
        '匹配项目': ['市场渠道费用'],
        '管报-一级部门（手工）': '内容业务群',
        '一级部门': '健康美学行业群',
        '月份-转换': 2512,
        '精力': 0.1,
      },
    },
  ]),
  fetchWorktimeByDepts: jest.fn(async () => [
    {
      record_id: 'dept_worktime_video',
      fields: {
        '姓名': '视频号成员',
        '匹配项目': ['视频号业务线项目B'],
        '管报-一级部门（手工）': '视频号业务线',
        '一级部门': '视频号业务线',
      },
    },
  ]),
  fetchProjectMasterByPerson: jest.fn(async () => [
    {
      record_id: 'pm_role_project',
      _matchFields: ['项目经理'],
      fields: {
        '26年项目名称': '角色授权项目A',
        '项目名称（管报）': '角色授权项目A',
        '项目归属部门': '内容业务群',
        '项目状态': '履约中',
        '项目经理': '任美嘉',
      },
    },
  ]),
  fetchProjectsByKeys: jest.fn(async (tableId, keys) => {
    const config = require('../config');
    if (tableId === config.TABLES.PROJECT_NAME_UNIQUE) {
      return keys.map((key) => ({
        record_id: `master_${key}`,
        fields: {
          '26年项目名称': key,
          '项目名称（管报）': key,
          '项目归属部门': key === '视频号业务线项目B' ? '视频号业务线' : '内容业务群',
          '项目状态': '履约中',
        },
      }));
    }
    if (tableId === config.TABLES.ACTUAL_PROJECT) {
      return keys.map((key) => ({
        record_id: `actual_${key}`,
        fields: {
          '是否交付项目': key,
          '一级部门': key === '视频号业务线项目B' ? '视频号业务线' : '内容业务群',
          '月份': 2601,
          '履约收入': 100,
          '履约利润': 10,
        },
      }));
    }
    if (tableId === config.TABLES.BUDGET_PROJECT) {
      return keys.map((key) => ({
        record_id: `budget_${key}`,
        fields: {
          '是否交付项目': key,
          '一级部门': key === '视频号业务线项目B' ? '视频号业务线' : '内容业务群',
          '月份': 2601,
          '预算收入': 100,
          '预算利润': 10,
        },
      }));
    }
    return [];
  }),
  fetchProjectTeamByKeys: jest.fn(async (keys) => keys.map((key) => ({
    record_id: `team_${key}`,
    fields: {
      '姓名': `成员_${key}`,
      '匹配项目': [key],
      '管报-一级部门（手工）': key === '视频号业务线项目B' ? '视频号业务线' : '内容业务群',
      '一级部门': key === '视频号业务线项目B' ? '视频号业务线' : '内容业务群',
    },
  }))),
  fetchUserRiskAlerts: jest.fn(async () => []),
  fetchAllRecords: jest.fn(async () => []),
  fetchEmployeeProfile: jest.fn(async () => null),
  fetchUserReviews: jest.fn(async () => []),
};

jest.mock('../src/memory/fetchers', () => mockFetchers);

const mockClient = {
  listRecords: jest.fn(async (tableId, query = {}) => {
    const config = require('../config');
    const filter = query.filter || '';
    if (tableId === config.TABLES.PROJECT_NAME_UNIQUE && filter.includes('项目归属部门') && filter.includes('视频号业务线')) {
      return [
        {
          record_id: 'pm_dept_video',
          fields: {
            '26年项目名称': '视频号业务线项目B',
            '项目名称（管报）': '视频号业务线项目B',
            '项目归属部门': '视频号业务线',
            '项目状态': '履约中',
          },
        },
      ];
    }
    if (tableId === config.TABLES.PROJECT_NAME_UNIQUE && filter.includes('公司层面')) {
      return [];
    }
    if (tableId === config.TABLES.ACTUAL_PROJECT && filter.includes('视频号业务线')) {
      return [
        {
          record_id: 'actual_dept_video',
          fields: {
            '是否交付项目': '视频号业务线项目B',
            '一级部门': '视频号业务线',
            '月份': 2601,
            '履约收入': 200,
            '履约利润': 20,
          },
        },
      ];
    }
    if (tableId === config.TABLES.BUDGET_PROJECT && filter.includes('视频号业务线')) {
      return [
        {
          record_id: 'budget_dept_video',
          fields: {
            '是否交付项目': '视频号业务线项目B',
            '一级部门': '视频号业务线',
            '月份': 2601,
            '预算收入': 200,
            '预算利润': 20,
          },
        },
      ];
    }
    return [];
  }),
};

jest.mock('../src/clients/feishu-client', () => mockClient);

const config = require('../config');
const { getUserMemory } = require('../src/memory/loader');

function flattenProjectKeyArgs() {
  return mockFetchers.fetchProjectsByKeys.mock.calls.flatMap((call) => call[1] || []);
}

describe('memory loader worktime-only projects do not grant project data access', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('本人 ACTUAL_WORKTIME 项目不进入主档/经营反查 key，授权项目和部门项目保持可见', async () => {
    const applyScopeFilter = jest.fn((memory, _scope, userName, dynamicProjectKeys) => {
      memory._testUserName = userName;
      memory._testDynamicProjectKeys = dynamicProjectKeys;
    });

    const memory = await getUserMemory('ou_test_renmeijia', {
      userName: '任美嘉',
      forceRefresh: true,
      plannedTables: ['projectMaster', 'actualProject', 'actualWorktime', 'budgetProject', 'budgetWorktime'],
      scope: {
        isGlobal: false,
        roleType: '管理者',
        dataScope: 'team',
        visibleModules: ['finance', 'project', 'team'],
        depts: ['视频号业务线'],
        projectKeys: ['角色授权项目A'],
        responsibleProjectKeys: ['角色授权项目A'],
        subordinateNames: [],
      },
    }, { applyScopeFilter });

    expect(memory.projectStaffing).toHaveLength(1);
    expect(memory.projectStaffing[0].record_id).toBe('recvgV64YcmqX0');

    const allFetchKeys = flattenProjectKeyArgs();
    expect(allFetchKeys).not.toContain('市场渠道费用');
    expect(allFetchKeys).toContain('角色授权项目A');
    expect(allFetchKeys).toContain('视频号业务线项目B');

    expect(mockFetchers.fetchProjectTeamByKeys).toHaveBeenCalled();
    const teamKeys = mockFetchers.fetchProjectTeamByKeys.mock.calls.flatMap((call) => call[0] || []);
    expect(teamKeys).not.toContain('市场渠道费用');
    expect(teamKeys).toContain('角色授权项目A');
    expect(teamKeys).toContain('视频号业务线项目B');

    expect(applyScopeFilter).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      '任美嘉',
      expect.not.arrayContaining(['市场渠道费用']),
    );
    expect(memory._testDynamicProjectKeys).toEqual(expect.arrayContaining(['角色授权项目A', '视频号业务线项目B']));
    expect(memory._testDynamicProjectKeys).not.toContain('市场渠道费用');

    expect(mockFetchers.fetchProjectsByKeys).toHaveBeenCalledWith(
      config.TABLES.PROJECT_NAME_UNIQUE,
      expect.arrayContaining(['角色授权项目A', '视频号业务线项目B']),
      '26年项目名称',
      { fallbackField: '项目名称（管报）' },
    );
  });
});
