'use strict';

jest.mock('../src/utils/logger', () => ({
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
}));

jest.mock('../src/clients/minimax-client', () => ({
  chat: jest.fn(),
}));

jest.mock('../src/clients/llm-client', () => ({
  chat: jest.fn(),
}));

const config = require('../config');
const minimaxClient = require('../src/clients/minimax-client');
const llmClient = require('../src/clients/llm-client');
const resolver = require('../src/agent/clarification-resolver');

function resolution(overrides = {}) {
  return {
    action: 'continue',
    confidence: 0.91,
    effectiveMessage: '继续查询',
    clarificationQuestion: '',
    reply: '',
    targetProjects: [],
    depts: [],
    period: '',
    metric: '',
    scopeSource: 'pending_clarification',
    reason: 'test',
    ...overrides,
  };
}

describe('clarification resolver', () => {
  const originalConfig = {
    enabled: config.CLARIFICATION_LLM_RESOLVER_ENABLED,
    provider: config.PLAN_PROVIDER,
    key: config.MINIMAX_API_KEY,
  };

  const pending = {
    type: 'entity_resolution',
    originalMessage: '人资部1~5月的盈亏数据',
    clarificationQuestion: '当前数据中没有一级部门「人资部」。我查到可能相关的项目/成本池「人力资源部管理」，你想按哪个查？',
    missingSlots: ['target_entity'],
    candidates: [{ type: 'project', label: '人力资源部管理', value: '人力资源部管理' }],
    entityHints: [{ type: 'project', name: '人力资源部管理', dept: '社区运营中心' }],
    baseQueryState: {
      dept: '',
      period: '2026年1-5月',
      metric: 'profit',
      resultSetType: 'finance.projectMetrics',
      targetProjects: [],
    },
    createdAt: 1000,
    expiresAt: 100000,
  };

  beforeEach(() => {
    config.CLARIFICATION_LLM_RESOLVER_ENABLED = true;
    config.PLAN_PROVIDER = 'minimax';
    config.MINIMAX_API_KEY = 'test-key';
    minimaxClient.chat.mockReset();
    llmClient.chat.mockReset();
  });

  afterEach(() => {
    config.CLARIFICATION_LLM_RESOLVER_ENABLED = originalConfig.enabled;
    config.PLAN_PROVIDER = originalConfig.provider;
    config.MINIMAX_API_KEY = originalConfig.key;
  });

  test('自然确认候选项目时解析为 explicit_project lockedScope', async () => {
    minimaxClient.chat.mockResolvedValue({
      text: JSON.stringify(resolution({
        effectiveMessage: '查询人力资源部管理项目2025年1月盈亏数据',
        targetProjects: ['人力资源部管理'],
        period: '2025-01',
        metric: 'profit',
        scopeSource: 'explicit_project',
      })),
    });

    const now = Date.parse('2026-06-08T07:00:00.000Z');
    const out = await resolver.resolveClarification({
      message: '对，就查这个管理项目',
      pendingClarification: { ...pending, expiresAt: now + 60_000 },
      now,
    });

    expect(out.action).toBe('continue');
    expect(out.effectiveMessage).toContain('人力资源部管理');
    expect(out.effectiveMessage).toContain('2026年1-5月');
    expect(out.effectiveMessage).not.toContain('2025年1月');
    expect(out.lockedScope.source).toBe('explicit_project');
    expect(out.lockedScope.period).toBe('2026-01~2026-05');
    expect(out.lockedScope.targetProjects).toEqual(['人力资源部管理']);
    expect(out.intent.shouldRunPlanner).toBe(true);
    expect(JSON.stringify(minimaxClient.chat.mock.calls[0][0])).toContain('对，就查这个管理项目');
  });

  test('用户改说合法部门时用自然语言覆盖候选', async () => {
    minimaxClient.chat.mockResolvedValue({
      text: JSON.stringify(resolution({
        effectiveMessage: '查询社区运营中心2026年1-5月盈亏数据',
        depts: ['社区运营中心'],
        period: '2026年1-5月',
        metric: 'profit',
        scopeSource: 'user_scope',
      })),
    });

    const out = await resolver.resolveClarification({
      message: '不是，我要查社区运营中心',
      pendingClarification: pending,
      now: 2000,
    });

    expect(out.action).toBe('continue');
    expect(out.lockedScope.depts).toEqual(['社区运营中心']);
    expect(out.lockedScope.source).toBe('pending_clarification');
    expect(out.effectiveMessage).toContain('社区运营中心');
  });

  test.each([
    ['看钱没回最多的', 'outstanding', '按未回款金额从高到低看这些项目'],
    ['看盈利能力最差的', 'profit_rate', '按利润率从低到高看这些项目'],
    ['就上个月完整月份', 'profit', '查询2026年1月这些项目的盈亏数据'],
  ])('自然回复“%s”可补齐口径或时间', async (message, metric, effectiveMessage) => {
    minimaxClient.chat.mockResolvedValue({
      text: JSON.stringify(resolution({
        effectiveMessage,
        targetProjects: ['项目A', '项目B'],
        period: message.includes('上个月') ? '2026-01' : '2026年1-5月',
        metric,
        scopeSource: 'pending_clarification',
      })),
    });

    const now = message.includes('上个月')
      ? Date.parse('2026-06-08T07:00:00.000Z')
      : 2000;
    const out = await resolver.resolveClarification({
      message,
      pendingClarification: {
        ...pending,
        type: 'slot_clarification',
        missingSlots: message.includes('上个月') ? ['period'] : ['ranking_metric'],
        expiresAt: now + 60_000,
        baseQueryState: {
          ...pending.baseQueryState,
          targetProjects: ['项目A', '项目B'],
        },
      },
      now,
    });

    expect(out.action).toBe('continue');
    expect(out.lockedScope.metric).toBe(metric);
    expect(out.lockedScope.targetProjects).toEqual(['项目A', '项目B']);
    if (message.includes('上个月')) {
      expect(out.lockedScope.period).toBe('2026-05');
      expect(out.effectiveMessage).toContain('2026年5月');
      expect(out.effectiveMessage).not.toContain('2026年1月');
    }
  });

  test('取消回复会清空 pending 且不执行工具', async () => {
    minimaxClient.chat.mockResolvedValue({
      text: JSON.stringify(resolution({
        action: 'cancel',
        reply: '好的，这次查询我先不继续了。',
      })),
    });

    const out = await resolver.resolveClarification({
      message: '算了不用查了',
      pendingClarification: pending,
      now: 2000,
    });

    expect(out.action).toBe('cancel');
    expect(out.pendingClarification).toBeNull();
    expect(out.reply).toContain('不继续');
    expect(minimaxClient.chat).not.toHaveBeenCalled();
    expect(llmClient.chat).not.toHaveBeenCalled();
  });

  test('LLM 继续追问时，实体候选确认会优先选择真实项目而不是虚拟项目', async () => {
    minimaxClient.chat.mockResolvedValue({
      text: JSON.stringify(resolution({
        action: 'clarify_again',
        clarificationQuestion: '你想查哪个项目？',
      })),
    });

    const now = Date.parse('2026-06-08T07:00:00.000Z');
    const out = await resolver.resolveClarification({
      message: '对，就查这个管理项目',
      pendingClarification: {
        ...pending,
        candidates: [
          { type: 'project', label: '人力资源部管理—虚拟项目', value: '人力资源部管理—虚拟项目', name: '人力资源部管理—虚拟项目' },
          { type: 'project', label: '人力资源部管理', value: '人力资源部管理', name: '人力资源部管理' },
        ],
        expiresAt: now + 60_000,
      },
      now,
    });

    expect(out.action).toBe('continue');
    expect(out.lockedScope.source).toBe('explicit_project');
    expect(out.lockedScope.targetProjects).toEqual(['人力资源部管理']);
    expect(out.lockedScope.period).toBe('2026-01~2026-05');
  });

  test.each([
    ['看钱没回最多的', 'receivable_metric', ['receivable_metric'], 'outstanding', '按未回款金额从高到低'],
    ['按盈利能力', 'slot_clarification', ['ranking_metric'], 'profit_rate', '按利润率从低到高'],
    ['就上个月完整月份', 'slot_clarification', ['period'], 'profit', '2026年5月'],
  ])('LLM 继续追问时也能用候选口径事实校准继续执行: %s', async (message, type, missingSlots, expectedMetric, expectedText) => {
    minimaxClient.chat.mockResolvedValue({
      text: JSON.stringify(resolution({
        action: 'clarify_again',
        clarificationQuestion: '你想按哪个口径看？',
      })),
    });

    const now = Date.parse('2026-06-08T07:00:00.000Z');
    const out = await resolver.resolveClarification({
      message,
      pendingClarification: {
        ...pending,
        type,
        missingSlots,
        clarificationQuestion: missingSlots.includes('period')
          ? '你想看哪个月份？'
          : '你想按哪个口径排序：收入、利润、利润率、回款，还是风险？',
        candidates: missingSlots.includes('ranking_metric')
          ? [{ label: '利润率', value: 'profit_rate' }]
          : ['回款率', '未回款金额', '回款金额', '逾期账龄'],
        expiresAt: now + 60_000,
        baseQueryState: {
          ...pending.baseQueryState,
          targetProjects: ['项目A', '项目B'],
        },
      },
      now,
    });

    expect(out.action).toBe('continue');
    expect(out.effectiveMessage).toContain(expectedText);
    expect(out.lockedScope.metric).toBe(expectedMetric);
    expect(out.lockedScope.targetProjects).toEqual(['项目A', '项目B']);
    if (missingSlots.includes('period')) {
      expect(out.lockedScope.period).toBe('2026-05');
    }
  });

  test('新问题打断 pending 时按新问题重新规划', async () => {
    minimaxClient.chat.mockResolvedValue({
      text: JSON.stringify(resolution({
        action: 'new_query',
        effectiveMessage: '公司亏损TOP10项目',
        scopeSource: 'explicit_new_query',
      })),
    });

    const out = await resolver.resolveClarification({
      message: '公司亏损TOP10项目',
      pendingClarification: pending,
      now: 2000,
    });

    expect(out.action).toBe('new_query');
    expect(out.pendingClarification).toBeNull();
    expect(out.intent.shouldUsePlanningContext).toBe(false);
    expect(out.effectiveMessage).toBe('公司亏损TOP10项目');
  });
});
