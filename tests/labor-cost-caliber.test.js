'use strict';

jest.mock('../src/utils/logger', () => ({
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
}));

const financeTools = require('../src/tools/finance-tools');
const toolRegistry = require('../src/tools/tool-registry');

describe('finance.laborCost 口径', () => {
  test('纯人力/FTE 工具默认不强依赖 budgetProject', () => {
    const tables = toolRegistry.collectDataTables(['finance.laborCost']);
    expect(tables.has('actualWorktime')).toBe(true);
    expect(tables.has('budgetWorktime')).toBe(true);
    expect(tables.has('projectMaster')).toBe(true);
    expect(tables.has('budgetProject')).toBe(false);
  });

  test('人均月成本=ACTUAL_PROJECT.人力成本/ACTUAL_WORKTIME.精力，并且输出用FTE', () => {
    const memory = {
      projectMonthly: [
        {
          fields: {
            '是否交付项目': '项目A',
            '月份': 2601,
            '一级部门': '测试部',
            '履约收入': 100,
            '履约成本': 100,
            '人力成本': 40,
            '履约利润': 0,
          },
        },
      ],
      projectStaffing: [
        {
          record_id: 'aw1',
          fields: {
            '月份': 2601,
            '匹配项目': '项目A',
            '标准项目名称新': '项目A',
            '管报-一级部门（手工）': '测试部',
            '精力': 2,
            '姓名': '张三',
          },
        },
      ],
      projectMaster: [
        { fields: { '26年项目名称': '项目A', '项目归属部门': '测试部' } },
      ],
      performanceTargets: [
        {
          fields: {
            '是否交付项目': '项目A',
            '月份': 2601,
            '履约收入': 90,
            '履约利润': 10,
            '人力成本': 20,
          },
        },
      ],
      budgetWorktime: [
        {
          record_id: 'bw1',
          fields: {
            '月份': 2601,
            '匹配项目': '项目A',
            '标准项目名称新': '项目A',
            '管报-一级部门（手工）': '测试部',
            '精力': 1,
          },
        },
      ],
      profile: null,
    };

    const result = financeTools.laborCost(memory, {
      period: 'ytd',
      periodYear: 2026,
      depts: ['测试部'],
      question: '测试部人均月成本和预算人头是多少',
    });

    expect(result.empty).toBeFalsy();
    expect(result.company.totalLaborCost).toBe(40);
    expect(result.company.perCapitaCost).toBe(20);
    expect(result.perCapitaCost).toBe(20);
    expect(result.company.totalCost).toBe(100);
    expect(result.company.perCapitaCost).not.toBe(50);
    expect(result.company.budgetLaborCost).toBe(20);
    expect(result.company.budgetPerCapitaCost).toBe(20);
    expect(result.overrun.topOverrun[0]).toContain('实际2.00FTE');
    expect(result.overrun.topOverrun[0]).toContain('预算1.00FTE');
    expect(result.overrun.topOverrun[0]).not.toContain('人月');
    expect(result._glossary['预算人头数']).toContain('预算 FTE');
  });

  test('按具体人员输出预算和实际工时差异，不把预算表误判为未录入人员预算', () => {
    const memory = {
      projectMonthly: [
        {
          fields: {
            '是否交付项目': '项目A',
            '月份': 2601,
            '一级部门': '测试部',
            '履约收入': 100,
            '履约成本': 80,
            '人力成本': 30,
            '履约利润': 20,
          },
        },
      ],
      projectStaffing: [
        {
          record_id: 'aw1',
          fields: {
            '月份': 2601,
            '匹配项目': '项目A',
            '标准项目名称新': '项目A',
            '管报-一级部门（手工）': '测试部',
            '精力': 1,
            '姓名': '张三',
          },
        },
        {
          record_id: 'aw2',
          fields: {
            '月份': 2601,
            '匹配项目': '项目A',
            '标准项目名称新': '项目A',
            '管报-一级部门（手工）': '测试部',
            '精力': 0.5,
            '姓名': '李四',
          },
        },
        {
          record_id: 'aw3',
          fields: {
            '月份': 2601,
            '匹配项目': '项目A',
            '标准项目名称新': '项目A',
            '管报-一级部门（手工）': '测试部',
            '精力': 0.4,
            '姓名': '赵六',
          },
        },
      ],
      projectMaster: [
        { fields: { '26年项目名称': '项目A', '项目归属部门': '测试部' } },
      ],
      budgetWorktime: [
        {
          record_id: 'bw1',
          fields: {
            '月份': 2601,
            '匹配项目': '项目A',
            '标准项目名称新': '项目A',
            '管报-一级部门（手工）': '测试部',
            '精力': 0.8,
            '姓名': '张三',
          },
        },
        {
          record_id: 'bw2',
          fields: {
            '月份': 2601,
            '匹配项目': '项目A',
            '标准项目名称新': '项目A',
            '管报-一级部门（手工）': '测试部',
            '精力': 0.7,
            '姓名': '李四',
          },
        },
        {
          record_id: 'bw3',
          fields: {
            '月份': 2601,
            '匹配项目': '项目A',
            '标准项目名称新': '项目A',
            '管报-一级部门（手工）': '测试部',
            '精力': 0.2,
            '姓名': '王五',
          },
        },
      ],
      profile: null,
    };

    const result = financeTools.laborCost(memory, {
      period: 'ytd',
      periodYear: 2026,
      depts: ['测试部'],
      question: '项目A预算和实际的按具体人员的工时差异对比一下',
    });

    expect(result.empty).toBeFalsy();
    expect(result.personBudgetCompare).toBeTruthy();
    expect(result.personBudgetCompare.targetProject).toBe('项目A');
    expect(result.personBudgetCompare.personBudgetRecordCountForProject).toBe(3);
    expect(result.personBudgetCompare.hasPersonBudgetData).toBe(true);
    expect(result.personBudgetCompare.actualPeopleCount).toBe(3);
    expect(result.personBudgetCompare.budgetPeopleCount).toBe(3);

    const rowsByName = Object.fromEntries(result.personBudgetCompare.rows.map(r => [r.person, r]));
    expect(rowsByName['张三']).toMatchObject({ actualFTE: 1, budgetFTE: 0.8, gapFTE: 0.2, status: 'overrun' });
    expect(rowsByName['李四']).toMatchObject({ actualFTE: 0.5, budgetFTE: 0.7, gapFTE: -0.2, status: 'underrun' });
    expect(rowsByName['赵六']).toMatchObject({ actualFTE: 0.4, budgetFTE: 0, gapFTE: 0.4, status: 'noBudget' });
    expect(rowsByName['王五']).toMatchObject({ actualFTE: 0, budgetFTE: 0.2, gapFTE: -0.2, status: 'budgetOnly' });
    expect(result._factSheet.join('\n')).toContain('[项目A][人员维度] 张三');
    expect(result._cohesionHint).toContain('personBudgetCompare');
  });

  test('多部门未指定单项目时输出项目×姓名预算实际偏差', () => {
    const memory = {
      projectMonthly: [
        { fields: { '是否交付项目': '公司AI项目', '月份': 2605, '一级部门': '公司层面', '履约收入': 100, '履约成本': 80, '人力成本': 30, '履约利润': 20 } },
        { fields: { '是否交付项目': '社群活动项目', '月份': 2605, '一级部门': '社区运营中心', '履约收入': 100, '履约成本': 80, '人力成本': 30, '履约利润': 20 } },
        { fields: { '是否交付项目': '行政支持项目', '月份': 2605, '一级部门': '行政部', '履约收入': 100, '履约成本': 80, '人力成本': 30, '履约利润': 20 } },
      ],
      projectStaffing: [
        {
          record_id: 'aw-c-ai-zhang',
          fields: {
            '月份': 2605,
            '匹配项目': '公司AI项目',
            '标准项目名称新': '公司AI项目',
            '管报-一级部门（手工）': '公司层面',
            '一级部门': '公司层面',
            '精力': 1,
            '姓名': '张三',
          },
        },
        {
          record_id: 'aw-c-ai-li',
          fields: {
            '月份': 2605,
            '匹配项目': '公司AI项目',
            '标准项目名称新': '公司AI项目',
            '管报-一级部门（手工）': '公司层面',
            '一级部门': '公司层面',
            '精力': 0.2,
            '姓名': '李四',
          },
        },
        {
          record_id: 'aw-s-act-wang',
          fields: {
            '月份': 2605,
            '匹配项目': '社群活动项目',
            '标准项目名称新': '社群活动项目',
            '管报-一级部门（手工）': '社区运营中心',
            '一级部门': '社区运营中心',
            '精力': 0.1,
            '姓名': '王五',
          },
        },
        {
          record_id: 'aw-admin',
          fields: {
            '月份': 2605,
            '匹配项目': '行政支持项目',
            '标准项目名称新': '行政支持项目',
            '管报-一级部门（手工）': '行政部',
            '一级部门': '行政部',
            '精力': 9,
            '姓名': '范围外',
          },
        },
      ],
      budgetWorktime: [
        {
          record_id: 'bw-c-ai-zhang',
          fields: {
            '月份': 2605,
            '匹配项目': '公司AI项目',
            '标准项目名称新': '公司AI项目',
            '管报-一级部门（手工）': '公司层面',
            '一级部门': '公司层面',
            '精力': 0.5,
            '姓名': '张三',
          },
        },
        {
          record_id: 'bw-c-ai-zhao',
          fields: {
            '月份': 2605,
            '匹配项目': '公司AI项目',
            '标准项目名称新': '公司AI项目',
            '管报-一级部门（手工）': '公司层面',
            '一级部门': '公司层面',
            '精力': 0.3,
            '姓名': '赵六',
          },
        },
        {
          record_id: 'bw-s-act-wang',
          fields: {
            '月份': 2605,
            '匹配项目': '社群活动项目',
            '标准项目名称新': '社群活动项目',
            '管报-一级部门（手工）': '社区运营中心',
            '一级部门': '社区运营中心',
            '精力': 0.4,
            '姓名': '王五',
          },
        },
        {
          record_id: 'bw-admin',
          fields: {
            '月份': 2605,
            '匹配项目': '行政支持项目',
            '标准项目名称新': '行政支持项目',
            '管报-一级部门（手工）': '行政部',
            '一级部门': '行政部',
            '精力': 1,
            '姓名': '范围外预算',
          },
        },
      ],
      projectMaster: [
        { fields: { '26年项目名称': '公司AI项目', '项目归属部门': '公司层面' } },
        { fields: { '26年项目名称': '社群活动项目', '项目归属部门': '社区运营中心' } },
        { fields: { '26年项目名称': '行政支持项目', '项目归属部门': '行政部' } },
      ],
      profile: null,
    };

    const result = financeTools.laborCost(memory, {
      period: 'ytd',
      periodYear: 2026,
      depts: ['公司层面', '社区运营中心', '内容业务群', '行政部'],
      question: '公司层面 + 社区运营中心 + 内容业务群 1-5月具体姓名在哪些项目的预算和实际精力偏差',
    });

    const cmp = result.personBudgetCompare;
    expect(cmp).toBeTruthy();
    expect(cmp.scopeMode).toBe('multiProject');
    expect(cmp.hasPersonBudgetData).toBe(true);
    expect(cmp.targetProject).toBe('');
    expect(cmp.targetProjectCount).toBe(2);
    expect(cmp.diffRowCount).toBe(4);

    const keys = cmp.rows.map(row => `${row.project}:${row.person}`);
    expect(keys).toEqual(expect.arrayContaining([
      '公司AI项目:张三',
      '公司AI项目:李四',
      '公司AI项目:赵六',
      '社群活动项目:王五',
    ]));
    expect(keys.some(key => key.includes('行政支持项目'))).toBe(false);
    expect(cmp.rowFacts.join('\n')).toContain('[公司AI项目][人员维度] 张三');
    expect(result._factSheet.join('\n')).toContain('[人员维度][多项目]');
    expect(result._factSheet.join('\n')).not.toContain('行政支持项目');
  });

  test('公司层面人员情况按具体人名输出实际精力明细，不误走预算偏差', () => {
    const memory = {
      projectMonthly: [
        { fields: { '是否交付项目': '公司AI项目', '月份': 2605, '一级部门': '公司层面', '履约收入': 100, '履约成本': 80, '人力成本': 30, '履约利润': 20 } },
        { fields: { '是否交付项目': '公司战略项目', '月份': 2605, '一级部门': '公司层面', '履约收入': 100, '履约成本': 80, '人力成本': 30, '履约利润': 20 } },
        { fields: { '是否交付项目': '社区项目', '月份': 2605, '一级部门': '社区运营中心', '履约收入': 100, '履约成本': 80, '人力成本': 30, '履约利润': 20 } },
      ],
      projectStaffing: [
        {
          record_id: 'aw-company-ai-zhang-2601',
          fields: {
            '月份': 2601,
            '匹配项目': '公司AI项目',
            '标准项目名称新': '公司AI项目',
            '管报-一级部门（手工）': '公司层面',
            '一级部门': '公司层面',
            '精力': 1,
            '姓名': '张三',
          },
        },
        {
          record_id: 'aw-company-ai-zhang-2602',
          fields: {
            '月份': 2602,
            '匹配项目': '公司AI项目',
            '标准项目名称新': '公司AI项目',
            '管报-一级部门（手工）': '公司层面',
            '一级部门': '公司层面',
            '精力': 0.5,
            '姓名': '张三',
          },
        },
        {
          record_id: 'aw-company-strategy-li-2601',
          fields: {
            '月份': 2601,
            '匹配项目': '公司战略项目',
            '标准项目名称新': '公司战略项目',
            '管报-一级部门（手工）': '公司层面',
            '一级部门': '公司层面',
            '精力': 0.7,
            '姓名': '李四',
          },
        },
        {
          record_id: 'aw-company-strategy-li-2605',
          fields: {
            '月份': 2605,
            '匹配项目': '公司战略项目',
            '标准项目名称新': '公司战略项目',
            '管报-一级部门（手工）': '公司层面',
            '一级部门': '公司层面',
            '精力': 0.3,
            '姓名': '李四',
          },
        },
        {
          record_id: 'aw-community-wang',
          fields: {
            '月份': 2605,
            '匹配项目': '社区项目',
            '标准项目名称新': '社区项目',
            '管报-一级部门（手工）': '社区运营中心',
            '一级部门': '社区运营中心',
            '精力': 9,
            '姓名': '范围外',
          },
        },
      ],
      budgetWorktime: [
        {
          record_id: 'bw-company-ai-zhang',
          fields: {
            '月份': 2601,
            '匹配项目': '公司AI项目',
            '标准项目名称新': '公司AI项目',
            '管报-一级部门（手工）': '公司层面',
            '一级部门': '公司层面',
            '精力': 0.2,
            '姓名': '张三',
          },
        },
      ],
      projectMaster: [
        { fields: { '26年项目名称': '公司AI项目', '项目归属部门': '公司层面' } },
        { fields: { '26年项目名称': '公司战略项目', '项目归属部门': '公司层面' } },
        { fields: { '26年项目名称': '社区项目', '项目归属部门': '社区运营中心' } },
      ],
      profile: null,
    };

    const result = financeTools.laborCost(memory, {
      period: 'ytd',
      periodYear: 2026,
      depts: ['公司层面'],
      question: '公司层面的人员情况 1-5 月，需要具体人名和精力',
    });

    expect(result.empty).toBeFalsy();
    expect(result.personBudgetCompare).toBeNull();
    expect(result.personEffortDetail).toBeTruthy();
    expect(result.personEffortDetail.scopeMode).toBe('multiProject');
    expect(result.personEffortDetail.targetProjectCount).toBe(2);
    expect(result.personEffortDetail.actualPeopleCount).toBe(2);
    expect(result.personEffortDetail.totalActualFTE).toBe(2.5);

    const rowsByKey = Object.fromEntries(result.personEffortDetail.rows.map(row => [`${row.project}:${row.person}`, row]));
    expect(rowsByKey['公司AI项目:张三']).toMatchObject({ actualFTE: 1.5 });
    expect(rowsByKey['公司战略项目:李四']).toMatchObject({ actualFTE: 1 });
    expect(Object.keys(rowsByKey).some(key => key.includes('社区项目'))).toBe(false);
    expect(rowsByKey['公司AI项目:张三'].monthly.map(cell => `${cell.monthLabel}:${cell.actualFTE}`)).toEqual([
      '2026年1月:1',
      '2026年2月:0.5',
    ]);

    const facts = result._factSheet.join('\n');
    expect(facts).toContain('[人员精力][多项目]');
    expect(facts).toContain('[公司AI项目][人员精力] 张三: 实际累计1.50FTE');
    expect(facts).not.toContain('[社区项目][人员精力]');
    expect(result._cohesionHint).toContain('personEffortDetail');
  });

  test('多部门 1-5月问题预渲染各部门月度事实，避免把合计 FTE 写成单部门', () => {
    const depts = ['公司层面', '社区运营中心', '内容业务群'];
    const fteByDept = {
      公司层面: [10, 10, 13, 15, 15],
      社区运营中心: [24, 19, 19, 20, 18],
      内容业务群: [3, 5, 9, 3, 7],
      行政部: [50, 50, 50, 50, 50],
    };
    const budgetByDept = {
      公司层面: [8, 8, 8, 8, 8],
      社区运营中心: [20, 20, 20, 20, 20],
      内容业务群: [4, 4, 4, 4, 4],
      行政部: [1, 1, 1, 1, 1],
    };

    const worktimeRows = [];
    const budgetRows = [];
    const projectRows = [];
    const projectMaster = [];
    for (const [dept, values] of Object.entries(fteByDept)) {
      const project = `${dept}项目`;
      projectMaster.push({ fields: { '26年项目名称': project, '项目归属部门': dept } });
      values.forEach((fte, index) => {
        const month = 2601 + index;
        worktimeRows.push({
          record_id: `aw-${dept}-${month}`,
          fields: {
            '月份': month,
            '匹配项目': project,
            '标准项目名称新': project,
            '管报-一级部门（手工）': dept,
            '一级部门': dept,
            '精力': fte,
            '姓名': `${dept}${index + 1}`,
          },
        });
        projectRows.push({
          fields: {
            '是否交付项目': project,
            '月份': month,
            '一级部门': dept,
            '履约收入': 1000,
            '履约成本': 500,
            '人力成本': 100,
            '履约利润': 500,
          },
        });
      });
    }
    for (const [dept, values] of Object.entries(budgetByDept)) {
      const project = `${dept}项目`;
      values.forEach((fte, index) => {
        const month = 2601 + index;
        budgetRows.push({
          record_id: `bw-${dept}-${month}`,
          fields: {
            '月份': month,
            '匹配项目': project,
            '标准项目名称新': project,
            '管报-一级部门（手工）': dept,
            '一级部门': dept,
            '精力': fte,
            '姓名': `${dept}预算${index + 1}`,
          },
        });
      });
    }

    const result = financeTools.laborCost({
      projectMonthly: projectRows,
      projectStaffing: worktimeRows,
      budgetWorktime: budgetRows,
      projectMaster,
      profile: null,
    }, {
      period: 'ytd',
      periodYear: 2026,
      depts: [...depts, '行政部'],
      question: '公司层面 + 社区运营中心 + 内容业务群 1-5月人员及人力成本趋势和预实',
    });

    const facts = result._factSheet.join('\n');
    expect(result.requestedDepts).toEqual(depts);
    expect(result.requestedDeptAggregate.totalManpowerMonths).toBe(190);
    expect(facts).toContain('【多部门月度事实】');
    expect(facts).toContain('[公司层面][2026年1-5月累计');
    expect(facts).toContain('[公司层面] 月度FTE明细: 2026年1月=10.00 FTE（1名参与人员）');
    expect(facts).not.toContain('FTE/1人');
    expect(facts).toContain('[社区运营中心][2026年1-5月累计');
    expect(facts).toContain('累计FTE: 100.00 | 月均FTE: 20.00');
    expect(facts).toContain('[内容业务群] 月度FTE明细');
    expect(facts).toContain('2026年5月=7.00 FTE（1名参与人员）');
    expect(facts).toContain('合计累计 FTE: 190.00');
    expect(facts).toContain('禁止把合计 FTE 当作任一单部门 FTE');
    expect(result.overrun.topOverrun.join('\n')).not.toContain('行政部项目');
    expect(result._cohesionHint).toContain('多部门硬约束');
  });
});
