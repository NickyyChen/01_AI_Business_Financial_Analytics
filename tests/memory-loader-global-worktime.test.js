'use strict';

jest.mock('../src/utils/logger', () => ({
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
}));

jest.mock('../src/permissions/permission-manager', () => ({
  resolveScope: jest.fn(async () => ({ isGlobal: true, visibleModules: ['finance'], depts: [] })),
}));

const mockFetchers = {
  _escapeFilter: (s) => String(s || ''),
  _mergeByRecordId: (a = [], b = []) => [...a, ...b],
  _listRecordsWithRetry: jest.fn(async () => []),
  _runWithLimit: jest.fn(async (items, _limit, fn) => Promise.all(items.map((item, idx) => fn(item, idx)))),
  fetchProfile: jest.fn(async () => null),
  fetchUserRecords: jest.fn(async () => []),
  fetchProjectStaffing: jest.fn(async () => [{ record_id: 'personal_should_not_be_used', fields: {} }]),
  fetchWorktimeByDepts: jest.fn(async () => []),
  fetchProjectMasterByPerson: jest.fn(async () => []),
  fetchProjectsByKeys: jest.fn(async () => []),
  fetchProjectTeamByKeys: jest.fn(async () => []),
  fetchUserRiskAlerts: jest.fn(async () => []),
  fetchAllRecords: jest.fn(async (tableId) => {
    const config = require('../config');
    if (tableId === config.TABLES.ACTUAL_WORKTIME) {
      return [{ record_id: 'aw_global', fields: { '月份': 2601, '精力': 1 } }];
    }
    if (tableId === config.TABLES.BUDGET_WORKTIME) {
      return [{ record_id: 'bw_global', fields: { '月份': 2601, '精力': 1 } }];
    }
    return [];
  }),
  fetchEmployeeProfile: jest.fn(async () => null),
  fetchUserReviews: jest.fn(async () => []),
};

jest.mock('../src/memory/fetchers', () => mockFetchers);

const config = require('../config');
const { getUserMemory } = require('../src/memory/loader');

describe('memory loader global worktime', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('全局权限下 actualWorktime 走 fetchAllRecords，不跳过也不按姓名加载', async () => {
    const memory = await getUserMemory('CEO', {
      userName: 'CEO',
      forceRefresh: true,
      plannedTables: ['actualWorktime'],
      scope: { isGlobal: true, visibleModules: ['finance'], depts: [] },
    });

    expect(mockFetchers.fetchProjectStaffing).not.toHaveBeenCalled();
    expect(mockFetchers.fetchAllRecords).toHaveBeenCalledWith(config.TABLES.ACTUAL_WORKTIME);
    expect(mockFetchers.fetchAllRecords).toHaveBeenCalledWith(config.TABLES.BUDGET_WORKTIME);
    expect(memory.projectStaffing).toHaveLength(1);
    expect(memory.projectStaffing[0].record_id).toBe('aw_global');
    expect(memory.budgetWorktime).toHaveLength(1);
  });
});
