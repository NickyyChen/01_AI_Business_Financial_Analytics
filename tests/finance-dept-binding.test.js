'use strict';

jest.mock('../src/utils/logger', () => ({
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
}));

const financeTools = require('../src/tools/finance-tools');

function actualProjectRow(dept, project, profit, costCategory, amount) {
  return {
    fields: {
      '月份': 2601,
      '一级部门': dept,
      '是否交付项目': project,
      '履约收入': 0,
      '履约成本': Math.abs(profit),
      '履约利润': profit,
      [costCategory]: amount,
    },
  };
}

function budgetProjectRow(dept, project, revenue, profit) {
  return {
    fields: {
      '月份': 2601,
      '一级部门': dept,
      '是否交付项目': project,
      '履约收入': revenue,
      '履约成本': revenue - profit,
      '履约利润': profit,
    },
  };
}

describe('finance tools dept-project binding', () => {
  test('costBreakdown 按一级部门+项目名聚合，同名项目不会串部门', () => {
    const actualProject = [
      actualProjectRow('部门A', '同名项目', -100, '人力成本', 100),
      actualProjectRow('部门B', '同名项目', -200, '其他成本费用', 200),
      actualProjectRow('部门A', '部门A项目', -50, '差旅费', 50),
    ];

    const result = financeTools.costBreakdown(
      {
        actualProject,
        projectMonthly: actualProject,
        actualDept: [],
      },
      { period: 'ytd', periodYear: 2026, depts: ['部门A', '部门B'], isGlobal: false },
    );

    expect(result.empty).toBeFalsy();
    expect(result.projectCount).toBe(3);

    const sameNameLosses = result.lossProjects
      .filter(item => item.name === '同名项目')
      .map(item => item.dept)
      .sort();
    expect(sameNameLosses).toEqual(['部门A', '部门B']);

    expect(result.lossProjectsByDept['部门A'].map(item => item.name)).toContain('同名项目');
    expect(result.lossProjectsByDept['部门B'].map(item => item.name)).toContain('同名项目');

    const topOther = result.subcategoryTopProjects['其他费用'].topProjects[0];
    expect(topOther).toMatchObject({ dept: '部门B', name: '同名项目', amount: 200 });
    expect(result.subcategoryTopProjects['其他费用'].topProjectsByDept['部门B'][0].name).toBe('同名项目');
  });

  test('budgetComparison 项目层预实按一级部门+项目名聚合，并输出 byProjectByDept', () => {
    const actualProject = [
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
    ];
    const budgetProject = [
      budgetProjectRow('部门A', '同名项目', 200, 30),
      budgetProjectRow('部门B', '同名项目', 600, 80),
    ];

    const result = financeTools.budgetComparison(
      {
        actualDept: [],
        budgetDept: [],
        actualProject,
        budgetProject,
      },
      { period: 'ytd', periodYear: 2026, depts: ['部门A', '部门B'], isGlobal: false },
    );

    expect(result.empty).toBeFalsy();
    const sameNameRows = result.byProject.filter(item => item.name === '同名项目');
    expect(sameNameRows).toHaveLength(2);
    expect(sameNameRows.map(item => item.dept).sort()).toEqual(['部门A', '部门B']);
    expect(result.byProjectByDept['部门A'][0]).toMatchObject({ dept: '部门A', name: '同名项目' });
    expect(result.byProjectByDept['部门B'][0]).toMatchObject({ dept: '部门B', name: '同名项目' });
  });
});
