'use strict';

jest.mock('../src/utils/logger', () => ({
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
}));

jest.mock('../src/clients/minimax-client', () => ({
  chat: jest.fn(),
}));

const config = require('../config');
const minimaxClient = require('../src/clients/minimax-client');
const { classifyFollowupIntent } = require('../src/agent/followup-intent-classifier');

describe('followup intent classifier', () => {
  beforeEach(() => {
    config.MINIMAX_API_KEY = 'test-key';
    config.FOLLOWUP_INTENT_PROVIDER = 'minimax';
    minimaxClient.chat.mockReset();
  });

  test('MiniMax classifies result-set followup and does not clarify', async () => {
    minimaxClient.chat.mockResolvedValue({
      text: JSON.stringify({
        intentType: 'result_set_reference',
        confidence: 0.94,
        shouldClarify: false,
        shouldPassToPlanner: true,
        isFollowup: true,
        needsSingleEntity: false,
        inheritedContext: { topicKeyword: '华为', period: '2026-Q1', metric: 'actual_receipts' },
        rewriteMessage: '继续按上一轮华为 Q1 实际收款结果集，列出每笔实际收款对应的履约月份，并用表格展示。',
        missingSlots: [],
        reason: '结果集展开',
      }),
    });

    const result = await classifyFollowupIntent({
      message: 'Q1实际收到的款项，其对应履约月份也请用表格列出',
      conversationHistory: [
        { role: 'user', content: '请告知我Q1 带有华为字样的项目，合计履约多少、收款多少' },
        { role: 'assistant', content: '华为项目Q1履约与收款汇总...' },
      ],
      planningContext: [{
        question: '请告知我Q1 带有华为字样的项目，合计履约多少、收款多少',
        queryState: { topicKeyword: '华为', period: '2026-Q1', metric: 'actual_receipts' },
      }],
    });

    expect(result.intentType).toBe('result_set_reference');
    expect(result.shouldClarify).toBe(false);
    expect(result.shouldPassToPlanner).toBe(true);
    expect(result.rewriteMessage).toContain('华为 Q1');
  });

  test('fallback treats metric definition as pass-through, not single-project clarification', async () => {
    minimaxClient.chat.mockRejectedValue(new Error('network'));

    const result = await classifyFollowupIntent({
      message: '这个未回款金额是什么定义',
      conversationHistory: [
        { role: 'user', content: '帮我统计下5月份各项目回款的情况' },
        { role: 'assistant', content: '| 项目 | 未回款金额 | 回款率 |' },
      ],
      planningContext: [{ question: '帮我统计下5月份各项目回款的情况' }],
    });

    expect(result.intentType).toBe('metric_definition');
    expect(result.shouldClarify).toBe(false);
    expect(result.shouldPassToPlanner).toBe(true);
  });

  test('fallback only clarifies truly ambiguous pronoun', async () => {
    minimaxClient.chat.mockRejectedValue(new Error('network'));

    const result = await classifyFollowupIntent({
      message: '那这个呢',
      conversationHistory: [
        { role: 'user', content: '帮我看下项目情况' },
        { role: 'assistant', content: '这里有多个项目...' },
      ],
      planningContext: [],
    });

    expect(result.intentType).toBe('ambiguous_reference');
    expect(result.shouldClarify).toBe(true);
  });
});
