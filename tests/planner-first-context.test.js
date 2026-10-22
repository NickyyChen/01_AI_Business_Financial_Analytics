'use strict';

jest.mock('../src/utils/logger', () => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
}));

jest.mock('../src/clients/minimax-client', () => ({
  chat: jest.fn(),
}));

jest.mock('../src/clients/llm-client', () => ({
  chat: jest.fn(),
  chatStream: jest.fn(),
}));

const config = require('../config');
const minimaxClient = require('../src/clients/minimax-client');
const planner = require('../src/agent/planner');

describe('planner-first context', () => {
  beforeEach(() => {
    config.PLAN_PROVIDER = 'minimax';
    config.MINIMAX_API_KEY = 'test-key';
    minimaxClient.chat.mockReset();
  });

  test('user prompt contains current question, full 3-turn history, full dept catalog and project candidates', async () => {
    minimaxClient.chat.mockResolvedValue({
      text: JSON.stringify({
        action: 'plan',
        effectiveMessage: '行政部管理的1~5月的成本数据和趋势',
        out_of_scope: false,
        out_of_scope_reason: '',
        tools_needed: ['finance.profitTrend', 'finance.costBreakdown'],
        tables_needed: ['projectMaster', 'rollbackProjectActual'],
        period: '2026-01~2026-05',
        question_decomposition: ['查看行政部管理成本趋势'],
        reasoning_framework: '按项目/成本池行政部管理查看 1~5 月成本趋势。',
        subordinate_depth: 1,
        tool_params: {},
        query_scope: {
          depts: [],
          subDepts: [],
          targetProjects: ['行政部管理'],
          scopeSource: 'explicit_project',
        },
        clarification_context: { missing: [], question: '', candidates: [] },
      }),
    });

    const fullAssistantReply = '上一轮完整澄清回复：当前数据中没有一级部门「财务部、行政部、人资部」。请直接回复正确部门或项目名称。'
      + '这段文字用于验证 Planner 历史不走 1500 字截断版。';
    const plan = await planner.plan('行政部管理的1~5月的成本数据和趋势', {
      userName: '测试用户',
      role: '管理者',
      plannerFirst: true,
      plannerConversationHistory: [
        { role: 'user', content: '与财务部、行政部、人资部--相关的-项目名称' },
        { role: 'assistant', content: fullAssistantReply },
        { role: 'user', content: '行政部管理的1~5月的成本数据和趋势' },
      ],
      projectCandidates: [{ name: '行政部管理', dept: '公司层面', score: 120 }],
    });

    expect(minimaxClient.chat).toHaveBeenCalled();
    const prompt = JSON.stringify(minimaxClient.chat.mock.calls[0][0]);
    expect(prompt).toContain('===== 当前用户问题 =====');
    expect(prompt).toContain('行政部管理的1~5月的成本数据和趋势');
    expect(prompt).toContain('===== 最近 3 轮完整对话历史 =====');
    expect(prompt).toContain(fullAssistantReply);
    expect(prompt).toContain('===== 全量一级部门 =====');
    expect(prompt).toContain('健康美学行业群');
    expect(prompt).not.toContain('- 财务部');
    expect(prompt).toContain('===== 项目/成本池候选（非全量） =====');
    expect(prompt).toContain('行政部管理');
    expect(plan.action).toBe('plan');
    expect(plan.query_scope.targetProjects).toEqual(['行政部管理']);
    expect(plan.query_scope.depts).toEqual([]);
  });

  test('short reply can be planned with full history in planner-first mode', async () => {
    minimaxClient.chat.mockResolvedValue({
      text: JSON.stringify({
        action: 'plan',
        effectiveMessage: '行政部管理上个月利润率',
        out_of_scope: false,
        out_of_scope_reason: '',
        tools_needed: ['finance.profitOverview'],
        tables_needed: ['projectMaster', 'rollbackProjectActual'],
        period: 'latest',
        question_decomposition: ['查看行政部管理上个月利润率'],
        reasoning_framework: '结合历史中的行政部管理，查看上个月利润率。',
        subordinate_depth: 1,
        tool_params: {},
        query_scope: {
          depts: [],
          subDepts: [],
          targetProjects: ['行政部管理'],
          scopeSource: 'explicit_project',
        },
        clarification_context: { missing: [], question: '', candidates: [] },
      }),
    });

    const plan = await planner.plan('利润率', {
      plannerFirst: true,
      plannerConversationHistory: [
        { role: 'user', content: '行政部管理的1~5月的成本数据和趋势' },
        { role: 'assistant', content: '行政部管理 1~5 月成本趋势如下...' },
        { role: 'user', content: '上个月' },
      ],
      projectCandidates: [{ name: '行政部管理', dept: '公司层面', score: 120 }],
    });

    expect(plan.action).toBe('plan');
    expect(plan.effectiveMessage).toBe('行政部管理上个月利润率');
    expect(plan.query_scope.targetProjects).toEqual(['行政部管理']);
  });
});
