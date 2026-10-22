'use strict';

const {
  checkClarification,
  restoreFromPending,
  _buildSlotPending,
} = require('../src/agent/clarification-gate');
const config = require('../config');

describe('clarification gate', () => {
  const originalKeywordFallback = config.CLARIFICATION_KEYWORD_FALLBACK_ENABLED;
  const planningContext = [{
    question: '这些项目利润率怎么样',
    period: '2026-04',
    tools: ['finance.profitOverview'],
    queryState: {
      dept: '健康美学行业群',
      period: '2026-04',
      metric: 'profit_rate',
      resultSetType: 'finance.projectMetrics',
      targetProjects: ['无限极-UGC内容运营', '农本方-咨询带教'],
    },
  }];

  afterEach(() => {
    config.CLARIFICATION_KEYWORD_FALLBACK_ENABLED = originalKeywordFallback;
  });

  test('turns unresolved target reference into a generic slot clarification', () => {
    const decision = checkClarification({
      message: '这个呢？',
      planningContext,
      contextResolution: {
        needsClarification: true,
        clarificationSlot: 'target_entity',
        clarificationQuestion: '你说的是哪个项目？',
        lockedScope: { source: 'none', targetProjects: [] },
      },
      now: 1000,
    });

    expect(decision.action).toBe('clarify');
    expect(decision.clarificationQuestion).toBe('你说的是哪个项目？');
    expect(decision.pendingClarification.type).toBe('slot_clarification');
    expect(decision.pendingClarification.missingSlots).toEqual(['target_entity']);
  });

  test('keeps legacy receivable metric clarification behavior', () => {
    const decision = checkClarification({
      message: '那回款最差的是哪个？',
      planningContext,
      contextResolution: {
        lockedScope: {
          source: 'planning_context',
          targetProjects: ['无限极-UGC内容运营', '农本方-咨询带教'],
        },
      },
      now: 1000,
    });

    expect(decision.action).toBe('clarify');
    expect(decision.clarificationQuestion).toContain('回款率');
    expect(decision.pendingClarification.type).toBe('receivable_metric');
  });

  test('does not restore pending answers by keyword when fallback flag is off', () => {
    const pending = checkClarification({
      message: '那回款最差的是哪个？',
      planningContext,
      contextResolution: {
        lockedScope: {
          source: 'planning_context',
          targetProjects: ['无限极-UGC内容运营', '农本方-咨询带教'],
        },
      },
      now: 1000,
    }).pendingClarification;

    const restored = restoreFromPending({
      message: '回款率',
      pendingClarification: pending,
      now: 2000,
    });

    expect(restored).toBeNull();
  });

  test('restores legacy pending slot answer into locked scope when fallback flag is on', () => {
    config.CLARIFICATION_KEYWORD_FALLBACK_ENABLED = true;
    const pending = checkClarification({
      message: '那回款最差的是哪个？',
      planningContext,
      contextResolution: {
        lockedScope: {
          source: 'planning_context',
          targetProjects: ['无限极-UGC内容运营', '农本方-咨询带教'],
        },
      },
      now: 1000,
    }).pendingClarification;

    const restored = restoreFromPending({
      message: '回款率',
      pendingClarification: pending,
      now: 2000,
    });

    expect(restored.restored).toBe(true);
    expect(restored.lockedScope.source).toBe('pending_clarification');
    expect(restored.lockedScope.targetProjects).toEqual(['无限极-UGC内容运营', '农本方-咨询带教']);
    expect(restored.effectiveMessage).toContain('按回款率从低到高');
  });

  test('asks ranking metric when ranking words lack a metric', () => {
    const decision = checkClarification({
      message: '那这几个哪个最好？',
      planningContext,
      contextResolution: {
        lockedScope: {
          source: 'planning_context',
          targetProjects: ['无限极-UGC内容运营', '农本方-咨询带教'],
        },
      },
      now: 1000,
    });

    expect(decision.action).toBe('clarify');
    expect(decision.pendingClarification.missingSlots).toEqual(['ranking_metric']);
    expect(decision.pendingClarification.candidates.map(c => c.label)).toContain('利润率');
  });

  test('restores generic slot clarification answer when fallback flag is on', () => {
    config.CLARIFICATION_KEYWORD_FALLBACK_ENABLED = true;
    const pending = _buildSlotPending({
      message: '那这几个哪个最好？',
      clarificationQuestion: '你想按哪个口径排序？',
      missingSlots: ['ranking_metric'],
      candidates: [{ label: '利润率', value: 'profit_rate' }],
      baseQueryState: {
        dept: '健康美学行业群',
        period: '2026-04',
        targetProjects: ['无限极-UGC内容运营', '农本方-咨询带教'],
      },
      now: 1000,
    });

    const restored = restoreFromPending({
      message: '利润率',
      pendingClarification: pending,
      now: 2000,
    });

    expect(restored.restored).toBe(true);
    expect(restored.effectiveMessage).toContain('按利润率继续分析');
    expect(restored.lockedScope.metric).toBe('profit_rate');
    expect(restored.lockedScope.targetProjects).toEqual(['无限极-UGC内容运营', '农本方-咨询带教']);
  });
});
