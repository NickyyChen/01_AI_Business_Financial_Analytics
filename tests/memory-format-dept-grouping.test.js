'use strict';

jest.mock('../src/utils/logger', () => ({
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
}));

const memoryManager = require('../src/services/memory-manager');

describe('memory digest dept grouping', () => {
  test('项目财务概况和成本明细按一级部门分组输出', () => {
    const memory = {
      profile: null,
      employeeProfile: null,
      meetings: [],
      calendar: [],
      chats: [],
      workItems: [],
      projectMaster: [],
      projectMonthly: [
        {
          fields: {
            '月份': 2601,
            '一级部门': '部门A',
            '是否交付项目': '同名项目',
            '履约收入': 100,
            '履约成本': 120,
            '履约利润': -20,
          },
        },
        {
          fields: {
            '月份': 2601,
            '一级部门': '部门B',
            '是否交付项目': '同名项目',
            '履约收入': 300,
            '履约成本': 400,
            '履约利润': -100,
          },
        },
      ],
      actualProject: [
        {
          fields: {
            '月份': 2601,
            '一级部门': '部门A',
            '是否交付项目': '同名项目',
            '履约收入': 100,
            '履约成本': 120,
            '履约利润': -20,
            '人力成本': 20,
          },
        },
        {
          fields: {
            '月份': 2601,
            '一级部门': '部门B',
            '是否交付项目': '同名项目',
            '履约收入': 300,
            '履约成本': 400,
            '履约利润': -100,
            '其他成本费用': 100,
          },
        },
      ],
      projectStaffing: [],
      projectTeamStaffing: [],
      performanceTargets: [],
      riskControlRules: [],
      riskAlerts: [],
      trends: null,
      reviews: [],
      invoices: [],
      actualDept: [],
      pendingPayments: [],
      budgetDept: [],
      budgetProject: [],
      vendorContracts: [],
      talentPool: [],
      deptYoy: [],
      companyYoy: [],
      revenueMom: [],
      customerProjects: [],
      presaleProjects: [],
      signDeliveries: [],
      biddings: [],
      invoiceApply: [],
      budgetWorktime: [],
    };

    const text = memoryManager.formatMemoryForLLM(memory);

    expect(text).toContain('【项目财务概况 - 年度汇总（按部门分组）】');
    expect(text).toContain('【项目成本明细（按部门分组）】');
    expect(text).toMatch(/- 部门A[\s\S]*?· 同名项目: 收入100元/);
    expect(text).toMatch(/- 部门B[\s\S]*?· 同名项目: 收入300元/);
  });
});
