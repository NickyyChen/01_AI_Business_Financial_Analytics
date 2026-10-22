'use strict';

jest.mock('../src/utils/logger', () => ({
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
}));

const memoryManager = require('../src/services/memory-manager');

function row(fields) {
  return { fields };
}

describe('memory scope filter cross-dept protection', () => {
  test('budget dirty row cannot authorize rollback actual rows from another department', () => {
    const memory = {
      projectMaster: [
        row({ '26年项目名称': '健康项目', '项目名称（管报）': '健康项目', '项目归属部门': '健康美学行业群', '项目归属-二级部门': '美妆' }),
        row({ '26年项目名称': '安德玛-视频号代运营', '项目名称（管报）': '安德玛-视频号代运营', '项目归属部门': '时尚行业群', '项目归属-二级部门': '视频号业务线' }),
      ],
      projectMonthly: [],
      projectStaffing: [],
      projectTeamStaffing: [],
      invoices: [],
      actualProject: [],
      actualDept: [],
      budgetDept: [],
      budgetProject: [
        row({ '一级部门': '健康美学行业群', '是否交付项目': '安德玛-视频号代运营', '月份': '2601', '履约利润': 0 }),
      ],
      rollbackProjectActual: [
        row({ '一级部门': '时尚行业群', '项目名': '安德玛-视频号代运营', '履约利润': -100 }),
        row({ '一级部门': '健康美学行业群', '项目名': '健康项目', '履约利润': 100 }),
      ],
    };

    memoryManager._applyScopeFilter(memory, {
      isGlobal: false,
      depts: ['健康美学行业群'],
      _strictDeptScope: true,
    }, '文琦');

    expect(memory.rollbackProjectActual.map(r => r.fields['项目名'])).toEqual(['健康项目']);
    expect(memory.budgetProject.map(r => r.fields['是否交付项目'])).toEqual(['安德玛-视频号代运营']);
  });

  test('sub-dept scope keeps only project master matches', () => {
    const memory = {
      projectMaster: [
        row({ '26年项目名称': '安踏-私域生态代运营', '项目名称（管报）': '安踏-私域生态代运营', '项目归属部门': '时尚行业群', '项目归属-二级部门': '鞋服行业线' }),
        row({ '26年项目名称': '美妆项目', '项目名称（管报）': '美妆项目', '项目归属部门': '时尚行业群', '项目归属-二级部门': '美妆行业线' }),
      ],
      projectMonthly: [],
      projectStaffing: [],
      projectTeamStaffing: [],
      invoices: [],
      actualProject: [
        row({ '一级部门': '时尚行业群', '是否交付项目': '安踏-私域生态代运营' }),
        row({ '一级部门': '时尚行业群', '是否交付项目': '美妆项目' }),
      ],
      actualDept: [],
      budgetDept: [],
      budgetProject: [],
      rollbackProjectActual: [
        row({ '一级部门': '时尚行业群', '项目名': '安踏-私域生态代运营' }),
        row({ '一级部门': '时尚行业群', '项目名': '美妆项目' }),
      ],
    };

    memoryManager._applyScopeFilter(memory, {
      isGlobal: false,
      depts: ['时尚行业群'],
      subDepts: ['鞋服行业线'],
      _strictDeptScope: true,
      _strictSubDeptScope: true,
    }, '文琦');

    expect(memory.projectMaster.map(r => r.fields['26年项目名称'])).toEqual(['安踏-私域生态代运营']);
    expect(memory.actualProject.map(r => r.fields['是否交付项目'])).toEqual(['安踏-私域生态代运营']);
    expect(memory.rollbackProjectActual.map(r => r.fields['项目名'])).toEqual(['安踏-私域生态代运营']);
  });

  test('self scope keeps only the user own budget worktime rows', () => {
    const memory = {
      projectMaster: [],
      projectMonthly: [],
      projectStaffing: [
        row({
          '匹配项目': ['财务部管理'],
          '姓名': '杨茗',
          '一级部门': '社区运营中心',
          '精力': 1,
        }),
      ],
      projectTeamStaffing: [],
      budgetWorktime: [
        row({
          '匹配项目': ['财务部管理'],
          '标准项目名称新': '社区运营中心+财务部管理',
          '姓名': '杨茗',
          '一级部门': '社区运营中心',
          '管报-一级部门（手工）': '社区运营中心',
          '月份-转换': '2605',
          '精力': 1,
        }),
        row({
          '匹配项目': ['财务部管理'],
          '标准项目名称新': '社区运营中心+财务部管理',
          '姓名': '张媛',
          '一级部门': '社区运营中心',
          '管报-一级部门（手工）': '社区运营中心',
          '月份-转换': '2605',
          '精力': 1,
        }),
      ],
      invoices: [],
      actualProject: [],
      actualDept: [],
      budgetDept: [],
      budgetProject: [],
      rollbackProjectActual: [],
    };

    memoryManager._applyScopeFilter(memory, {
      isGlobal: false,
      dataScope: 'self',
      depts: [],
      projectKeys: [],
      subordinateNames: [],
    }, '杨茗');

    expect(memory.projectStaffing.map(r => r.fields['姓名'])).toEqual(['杨茗']);
    expect(memory.budgetWorktime.map(r => r.fields['姓名'])).toEqual(['杨茗']);
    expect(memory.budgetWorktime[0].fields['精力']).toBe(1);
  });
});
