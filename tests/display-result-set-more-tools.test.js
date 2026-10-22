'use strict';

jest.mock('../src/utils/logger', () => ({
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
}));

const config = require('../config');
const financeTools = require('../src/tools/finance-tools');
const customerTools = require('../src/tools/customer-tools');
const presaleTools = require('../src/tools/presale-tools');
const signDeliveryTools = require('../src/tools/sign-delivery-tools');

describe('display result set tools - extended', () => {
  const prevDisplayFlag = config.TOOL_DISPLAY_RESULT_SET_ENABLED;

  beforeEach(() => {
    config.TOOL_DISPLAY_RESULT_SET_ENABLED = true;
  });

  afterEach(() => {
    config.TOOL_DISPLAY_RESULT_SET_ENABLED = prevDisplayFlag;
  });

  test('finance.costBreakdown returns category-ranked projects', () => {
    const memory = {
      actualProject: [
        { fields: { 是否交付项目: 'A项目', 月份: 2601, 一级部门: '健康美学行业群', 项目状态: '履约中', 履约收入: 100000, 履约成本: 70000, 履约利润: 30000, 外包费用: 50000, 人力成本: 20000 } },
        { fields: { 是否交付项目: 'B项目', 月份: 2601, 一级部门: '健康美学行业群', 项目状态: '履约中', 履约收入: 80000, 履约成本: 90000, 履约利润: -10000, 外包费用: 70000, 人力成本: 20000 } },
      ],
      performanceTargets: [],
      projectMaster: [],
    };

    const result = financeTools.costBreakdown(memory, { period: 'historical', question: '外包费用最高 Top1 项目' }, {
      top: 1,
      sortBy: 'amount',
      order: 'desc',
      metric: '外包费用',
    });

    expect(result.displayResultSet.toolId).toBe('finance.costBreakdown');
    expect(result.displayResultSet.rows.map(row => row.name)).toEqual(['B项目']);
    expect(result.displayResultSet.metric).toBe('外包费用');
  });

  test('finance.laborCost returns manpower-ranked projects', () => {
    const memory = {
      projectStaffing: [
        { fields: { 一级部门: '健康美学行业群', '月份-转换': 2601, 姓名: '张三', 标准项目名称新: 'A项目', 精力: 0.5, 是否计算人效: '是' } },
        { fields: { 一级部门: '健康美学行业群', '月份-转换': 2601, 姓名: '李四', 标准项目名称新: 'B项目', 精力: 0.8, 是否计算人效: '是' } },
        { fields: { 一级部门: '健康美学行业群', '月份-转换': 2601, 姓名: '王五', 标准项目名称新: 'B项目', 精力: 0.4, 是否计算人效: '是' } },
      ],
      actualProject: [
        { fields: { 是否交付项目: 'A项目', 月份: 2601, 一级部门: '健康美学行业群', 项目状态: '履约中', 履约收入: 100000, 履约成本: 70000, 履约利润: 30000, 人力成本: 20000 } },
        { fields: { 是否交付项目: 'B项目', 月份: 2601, 一级部门: '健康美学行业群', 项目状态: '履约中', 履约收入: 80000, 履约成本: 90000, 履约利润: -10000, 人力成本: 40000 } },
      ],
      budgetWorktime: [],
      budgetProject: [],
      projectMaster: [],
    };

    const result = financeTools.laborCost(memory, { period: 'historical', question: '人力投入最多 Top1 项目' }, {
      top: 1,
      sortBy: 'manpowerMonths',
      order: 'desc',
    });

    expect(result.displayResultSet.toolId).toBe('finance.laborCost');
    expect(result.displayResultSet.rows.map(row => row.name)).toEqual(['B项目']);
  });

  test('display result set applies inherited row scope before truncation', () => {
    const memory = {
      projectStaffing: [
        { fields: { 一级部门: '健康美学行业群', '月份-转换': 2601, 姓名: '张三', 标准项目名称新: 'A项目', 精力: 0.5, 是否计算人效: '是' } },
        { fields: { 一级部门: '健康美学行业群', '月份-转换': 2601, 姓名: '李四', 标准项目名称新: 'B项目', 精力: 0.8, 是否计算人效: '是' } },
        { fields: { 一级部门: '健康美学行业群', '月份-转换': 2601, 姓名: '王五', 标准项目名称新: '范围外项目', 精力: 2.4, 是否计算人效: '是' } },
      ],
      actualProject: [
        { fields: { 是否交付项目: 'A项目', 月份: 2601, 一级部门: '健康美学行业群', 项目状态: '履约中', 履约收入: 100000, 履约成本: 70000, 履约利润: 30000, 人力成本: 20000 } },
        { fields: { 是否交付项目: 'B项目', 月份: 2601, 一级部门: '健康美学行业群', 项目状态: '履约中', 履约收入: 80000, 履约成本: 90000, 履约利润: -10000, 人力成本: 40000 } },
        { fields: { 是否交付项目: '范围外项目', 月份: 2601, 一级部门: '健康美学行业群', 项目状态: '履约中', 履约收入: 300000, 履约成本: 90000, 履约利润: 210000, 人力成本: 40000 } },
      ],
      budgetWorktime: [],
      budgetProject: [],
      projectMaster: [],
    };

    const result = financeTools.laborCost(memory, {
      period: 'historical',
      question: '这些项目人效呢？',
      _queryProjectNames: ['A项目', 'B项目'],
      _queryProjectScopeSource: 'inherited_result_set',
    }, {
      top: 2,
      sortBy: 'perCapitaRevenue',
      order: 'desc',
    });

    expect(result.displayResultSet.rows.map(row => row.name)).toEqual(['A项目', 'B项目']);
    expect(result.displayResultSet.rows.map(row => row.name)).not.toContain('范围外项目');
  });

  test('finance.healthCheck returns overdue risk display result set', () => {
    const memory = {
      actualProject: [
        { fields: { 是否交付项目: 'A项目', 月份: 2601, 一级部门: '健康美学行业群', 项目状态: '履约中', 履约收入: 100000, 履约成本: 70000, 履约利润: 30000 } },
        { fields: { 是否交付项目: 'B项目', 月份: 2601, 一级部门: '健康美学行业群', 项目状态: '履约中', 履约收入: 80000, 履约成本: 90000, 履约利润: -10000 } },
      ],
      invoices: [
        { fields: { 项目: 'A项目', 履约月份: 2601, 履约收入: 100000, 实际回款金额: 100000, 已履约未回款: 0, 预计首次回款时间: '2026-01-01' } },
        { fields: { 项目: 'B项目', 履约月份: 2601, 履约收入: 100000, 实际回款金额: 0, 已履约未回款: 100000, 预计首次回款时间: '2026-01-01' } },
      ],
      projectStaffing: [],
      performanceTargets: [],
      projectMaster: [],
    };

    const result = financeTools.healthCheck(memory, { period: 'historical', question: '逾期风险最高 Top1 项目' }, {
      top: 1,
      sortBy: 'overdueAmount',
      order: 'desc',
    });

    expect(result.displayResultSet.toolId).toBe('finance.healthCheck');
    expect(result.displayResultSet.rows.map(row => row.name)).toEqual(['B项目']);
  });

  test('customer.analysis returns top customer display result set', () => {
    const memory = {
      customerProjects: [
        { fields: { 客户: '客户A', 合同金额: 100000, '26年项目名称': 'A项目', 项目状态: '履约中', 项目归属部门: '健康美学行业群', sku: 'S1' } },
        { fields: { 客户: '客户B', 合同金额: 300000, '26年项目名称': 'B项目', 项目状态: '履约中', 项目归属部门: '健康美学行业群', sku: 'S2' } },
      ],
    };

    const result = customerTools.customerAnalysis(memory, { question: 'Top1 客户合作金额', depts: ['健康美学行业群'] }, {
      top: 1,
      sortBy: 'totalAmount',
      order: 'desc',
    });

    expect(result.displayResultSet.toolId).toBe('customer.analysis');
    expect(result.displayResultSet.rows.map(row => row.name)).toEqual(['客户B']);
  });

  test('presale tools return display result sets', () => {
    const memory = {
      presaleProjects: [
        { fields: { '售前项目名称：客户+需求+期数': '大单A', 售前负责人: '甲', 售前跟进部门: '健康美学行业群', 售前状态: '跟进中', 预估签约金额: 300000, 预估赢单概率: 0.5, 售前录入时间: Date.now() - 10 * 86400000 } },
        { fields: { '售前项目名称：客户+需求+期数': '大单B', 售前负责人: '乙', 售前跟进部门: '健康美学行业群', 售前状态: '跟进中', 预估签约金额: 600000, 预估赢单概率: 0.3, 售前录入时间: Date.now() - 20 * 86400000 } },
        { fields: { '售前项目名称：客户+需求+期数': '赢单C', 售前负责人: '甲', 售前跟进部门: '健康美学行业群', 售前状态: '赢单', 预估签约金额: 200000, 签约金额: 200000 } },
        { fields: { '售前项目名称：客户+需求+期数': '丢单D', 售前负责人: '乙', 售前跟进部门: '健康美学行业群', 售前状态: '客户终止', 预估签约金额: 100000 } },
      ],
    };

    const pending = presaleTools.pendingList(memory, { question: '跟进中大单 Top1' }, {
      top: 1,
      sortBy: 'estAmount',
      order: 'desc',
    });
    const winLoss = presaleTools.winLossAnalysis(memory, { question: '每个负责人的赢单率 Top1' }, {
      top: 1,
      sortBy: 'winRate',
      order: 'desc',
      metric: 'owner',
    });

    expect(pending.displayResultSet.rows.map(row => row.name)).toEqual(['大单B']);
    expect(winLoss.displayResultSet.toolId).toBe('presale.winLoss');
    expect(winLoss.displayResultSet.rows).toHaveLength(1);
  });

  test('sign delivery tools return display result sets', () => {
    const past = Date.UTC(2026, 0, 1);
    const memory = {
      signDeliveries: [
        { fields: { 签约项目名称: '签约A', 签约部门: '健康美学行业群', 签约负责人: '甲', 签约时间: past, 合同金额: 100000, 履约金额: 90000, 回款金额: 80000, 是否续签: '续签', 'N:1关联：客户': '客户A', 合同结束日期: past, 实际履约结束时间: past } },
        { fields: { 签约项目名称: '签约B', 签约部门: '快消零售行业群', 签约负责人: '乙', 签约时间: past, 合同金额: 300000, 履约金额: 100000, 回款金额: 0, 是否续签: '新签', 'N:1关联：客户': '客户B', 合同结束日期: past } },
      ],
    };

    const overview = signDeliveryTools.overview(memory, { question: '签约金额最高 Top1 部门' }, {
      top: 1,
      sortBy: 'contractAmount',
      order: 'desc',
    });
    const renewal = signDeliveryTools.renewalAnalysis(memory, { question: '续签率最高 Top1 客户' }, {
      top: 1,
      sortBy: 'renewalRate',
      order: 'desc',
    });
    const risk = signDeliveryTools.deliveryRisk(memory, { question: '交付风险最高 Top1 项目' }, {
      top: 1,
      sortBy: 'amount',
      order: 'desc',
    });

    expect(overview.displayResultSet.rows.map(row => row.name)).toEqual(['快消零售行业群']);
    expect(renewal.displayResultSet.rows.map(row => row.name)).toEqual(['客户A']);
    expect(risk.displayResultSet.rows.map(row => row.name)).toEqual(['签约B']);
  });
});
