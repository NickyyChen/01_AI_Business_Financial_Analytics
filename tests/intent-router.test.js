'use strict';

jest.mock('../src/utils/logger', () => ({
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
}));

jest.mock('../src/clients/minimax-client', () => ({
  chat: jest.fn(),
}));

const config = require('../config');
const minimaxClient = require('../src/clients/minimax-client');
const { routeIntent } = require('../src/agent/intent-router');

describe('intent router', () => {
  beforeEach(() => {
    config.MINIMAX_API_KEY = '';
    config.INTENT_ROUTER_PROVIDER = 'minimax';
    minimaxClient.chat.mockReset();
  });

  test('fallback routes project-set followup to Planner without rewriting', async () => {
    const result = await routeIntent({
      message: '这些项目利润率怎么样',
      planningContext: [{
        question: '健康美学收入最高的几个项目是哪几个',
        queryState: {
          dept: '健康美学行业群',
          period: '2026-04',
          resultSetType: 'finance.projectMetrics',
          targetProjects: ['无限极-UGC内容运营', '农本方-咨询带教'],
        },
      }],
      conversationHistory: [{ role: 'assistant', content: '前 10 项目如下...' }],
    });

    expect(result.route).toBe('plan');
    expect(result.intentType).toBe('result_set_reference');
    expect(result.shouldRunPlanner).toBe(true);
    expect(result.shouldUsePlanningContext).toBe(true);
    expect(result.rewriteMessage).toBeUndefined();
  });

  test('fallback routes pending clarification slot answer to Planner', async () => {
    const result = await routeIntent({
      message: '回款率',
      pendingClarification: {
        type: 'receivable_metric',
        candidates: ['回款率', '未回款金额', '回款金额', '逾期账龄'],
        baseQueryState: {
          targetProjects: ['伊利直播带教', '长隆-私域代运营'],
        },
      },
    });

    expect(result.route).toBe('plan');
    expect(result.intentType).toBe('clarification_slot_answer');
    expect(result.shouldRunPlanner).toBe(true);
  });

  test('fallback clarifies ambiguous receivable worst metric with previous project set', async () => {
    const result = await routeIntent({
      message: '那回款最差的是哪个',
      planningContext: [{
        queryState: {
          targetProjects: ['伊利直播带教', '长隆-私域代运营'],
        },
      }],
    });

    expect(result.route).toBe('clarify');
    expect(result.shouldClarify).toBe(true);
    expect(result.clarificationQuestion).toContain('回款率');
  });

  test('MiniMax route does not expose rewriteMessage even when model invents one', async () => {
    config.MINIMAX_API_KEY = 'test-key';
    minimaxClient.chat.mockResolvedValue({
      text: JSON.stringify({
        route: 'plan',
        intentType: 'result_set_reference',
        confidence: 0.94,
        isFollowup: true,
        shouldUsePlanningContext: true,
        rewriteMessage: '不应该透传的改写',
        reason: '追问上一轮项目集',
      }),
    });

    const result = await routeIntent({
      message: '这些项目利润率怎么样',
      planningContext: [{ queryState: { targetProjects: ['A项目'] } }],
    });

    expect(result.route).toBe('plan');
    expect(result.rewriteMessage).toBeUndefined();
  });

  test('normalizes over-eager clarification to plan when metric and project set are present', async () => {
    config.MINIMAX_API_KEY = 'test-key';
    minimaxClient.chat.mockResolvedValue({
      text: JSON.stringify({
        route: 'clarify',
        intentType: 'ambiguous_reference',
        confidence: 0.92,
        isFollowup: true,
        shouldUsePlanningContext: true,
        clarificationQuestion: '你说的是哪些项目？',
        reason: '模型误判缺少项目',
      }),
    });

    const result = await routeIntent({
      message: '这些项目利润率怎么样',
      planningContext: [{
        queryState: {
          targetProjects: ['无限极-UGC内容运营', '农本方-咨询带教'],
        },
      }],
    });

    expect(result.route).toBe('plan');
    expect(result.intentType).toBe('result_set_reference');
    expect(result.shouldRunPlanner).toBe(true);
  });

  test('normalizes ambiguous receivable worst metric to clarification even if model says plan', async () => {
    config.MINIMAX_API_KEY = 'test-key';
    minimaxClient.chat.mockResolvedValue({
      text: JSON.stringify({
        route: 'plan',
        intentType: 'result_set_reference',
        confidence: 0.9,
        isFollowup: true,
        shouldUsePlanningContext: true,
        reason: '模型想直接规划',
      }),
    });

    const result = await routeIntent({
      message: '那回款最差的是哪个',
      planningContext: [{
        queryState: {
          targetProjects: ['无限极-UGC内容运营', '农本方-咨询带教'],
        },
      }],
    });

    expect(result.route).toBe('clarify');
    expect(result.shouldClarify).toBe(true);
    expect(result.clarificationQuestion).toContain('未回款金额');
  });

  test('normalizes generic receivable clarification text to explicit candidate options', async () => {
    config.MINIMAX_API_KEY = 'test-key';
    minimaxClient.chat.mockResolvedValue({
      text: JSON.stringify({
        route: 'clarify',
        intentType: 'ambiguous_reference',
        confidence: 0.9,
        isFollowup: true,
        shouldUsePlanningContext: true,
        clarificationQuestion: '您想了解回款最差的项目，请问是按哪个维度排序？',
        reason: '模型给了泛化澄清',
      }),
    });

    const result = await routeIntent({
      message: '那回款最差的是哪个',
      planningContext: [{
        queryState: {
          targetProjects: ['无限极-UGC内容运营', '农本方-咨询带教'],
        },
      }],
    });

    expect(result.route).toBe('clarify');
    expect(result.clarificationQuestion).toContain('回款率');
    expect(result.clarificationQuestion).toContain('未回款金额');
    expect(result.clarificationQuestion).toContain('逾期账龄');
  });

  test('routes receivable risk highest followup to Planner instead of clarification', async () => {
    const result = await routeIntent({
      message: '那这几个华为项目里哪个回款风险最高？',
      planningContext: [{
        queryState: {
          targetProjects: ['华为产品线-社群代运营', '华为坤灵-社群代运营'],
        },
      }],
      conversationHistory: [{ role: 'assistant', content: '华为项目明细如下...' }],
    });

    expect(result.route).toBe('plan');
    expect(result.shouldRunPlanner).toBe(true);
    expect(result.shouldClarify).toBe(false);
    expect(result.shouldUsePlanningContext).toBe(true);
  });
});
