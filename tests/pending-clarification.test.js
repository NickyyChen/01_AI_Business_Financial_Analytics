'use strict';

const {
  buildPendingClarification,
  buildReceivableMetricClarification,
  restorePendingClarification,
  restoreProjectSetMetricRequest,
  restoreProjectSetProfitMetricRequest,
  restoreContextContinuation,
} = require('../src/agent/pending-clarification');

describe('pending clarification restoration', () => {
  const planningContext = [{
    question: '这些项目利润率怎么样',
    period: '2026-04',
    tools: ['finance.profitOverview'],
    queryState: {
      dept: '健康美学行业群',
      period: '2026-04',
      metric: 'profit_rate',
      resultSetType: 'finance.projectMetrics',
      targetProjects: [
        '无限极-UGC内容运营',
        '农本方-咨询带教',
        '蔡司C端-私域生态代运营',
        '无限极-社群代运营',
      ],
    },
  }];

  test('builds receivable pending clarification with previous project set', () => {
    const pending = buildPendingClarification({
      message: '那回款最差的是哪个',
      clarification: '您说的回款最差是按回款率、未回款金额，还是逾期账龄看？',
      planningContext,
      now: 1000,
    });

    expect(pending.type).toBe('receivable_metric');
    expect(pending.baseQueryState.targetProjects).toHaveLength(4);
    expect(pending.baseQueryState.dept).toBe('健康美学行业群');
  });

  test('builds generic period pending clarification with previous project set', () => {
    const pending = buildPendingClarification({
      message: '那个月',
      clarification: '您想查看哪个月份的亏损数据呢？',
      planningContext,
      now: 1000,
    });

    expect(pending.type).toBe('slot_clarification');
    expect(pending.missingSlots).toEqual(['period']);
    expect(pending.baseQueryState.targetProjects).toHaveLength(4);
  });

  test('receivable metric clarification keeps receivable-specific pending before generic ranking', () => {
    const pending = buildPendingClarification({
      message: '回款最差的是哪个',
      clarification: '请问您想按哪个指标查看回款最差的项目：回款率最低、未回款金额最大、还是账龄最长？',
      planningContext,
      now: 1000,
    });

    expect(pending.type).toBe('receivable_metric');
    expect(pending.candidates).toContain('未回款金额');
  });

  test('opens receivable metric clarification for ambiguous worst followup', () => {
    const built = buildReceivableMetricClarification({
      message: '那回款最差的是哪个',
      planningContext,
      now: 1000,
    });

    expect(built.clarificationQuestion).toContain('回款率');
    expect(built.pendingClarification.type).toBe('receivable_metric');
    expect(built.pendingClarification.baseQueryState.targetProjects).toHaveLength(4);
  });

  test('restores metric slot answer into executable question', () => {
    const pending = buildPendingClarification({
      message: '那回款最差的是哪个',
      clarification: '您说的回款最差是按回款率、未回款金额，还是逾期账龄看？',
      planningContext,
      now: 1000,
    });

    const restored = restorePendingClarification({
      message: '回款率',
      pendingClarification: pending,
      now: 2000,
    });

    expect(restored.effectiveMessage).toContain('按回款率从低到高');
    expect(restored.effectiveMessage).toContain('无限极-UGC内容运营');
    expect(restored.inheritedScope.scopeSource).toBe('pending_clarification');
    expect(restored.inheritedScope.targetProjects).toHaveLength(4);
  });

  test('restores explicit receivable metric question from previous project set', () => {
    const restored = restoreProjectSetMetricRequest({
      message: '那这些项目回款率最低的是哪个',
      planningContext,
    });

    expect(restored.effectiveMessage).toContain('按回款率从低到高');
    expect(restored.effectiveMessage).toContain('农本方-咨询带教');
    expect(restored.inheritedScope.scopeSource).toBe('inherited_result_set');
    expect(restored.inheritedScope.targetProjects).toHaveLength(4);
  });

  test('does not inherit project set for explicit overall dept range', () => {
    const restored = restoreProjectSetMetricRequest({
      message: '那健康美学整体回款率怎么样',
      planningContext,
    });
    const clarification = buildReceivableMetricClarification({
      message: '那健康美学整体回款最差的是哪个',
      planningContext,
    });

    expect(restored).toBeNull();
    expect(clarification).toBeNull();
  });

  test('does not restore metric definition questions as project ranking followups', () => {
    const receivableDefinition = restoreProjectSetMetricRequest({
      message: '这个未回款金额是什么定义',
      planningContext,
    });
    const receivableDifference = restoreProjectSetMetricRequest({
      message: '那待认领金额和实际到账金额有什么区别？',
      planningContext,
    });
    const profitDefinition = restoreProjectSetProfitMetricRequest({
      message: '这些项目收入是什么口径',
      planningContext,
    });

    expect(receivableDefinition).toBeNull();
    expect(receivableDifference).toBeNull();
    expect(profitDefinition).toBeNull();
  });

  test('restores profit metric question from previous project set before classifier', () => {
    const restored = restoreProjectSetProfitMetricRequest({
      message: '这些项目利润率怎么样',
      planningContext,
    });

    expect(restored.effectiveMessage).toContain('分析这些项目的利润率');
    expect(restored.inheritedScope.sourceTools).toEqual(['finance.profitOverview']);
    expect(restored.inheritedScope.scopeSource).toBe('inherited_result_set');
    expect(restored.inheritedScope.targetProjects).toHaveLength(4);
  });

  test('restores receivables reason continuation', () => {
    const restored = restoreContextContinuation({
      message: '你看呗',
      planningContext: [{
        question: '回款率',
        period: '2026-04',
        tools: ['finance.receivables'],
        queryState: {
          dept: '健康美学行业群',
          period: '2026-04',
          metric: 'receivables',
          resultSetType: 'invoice.receipts',
          targetProjects: ['伊利直播带教', '长隆-私域代运营'],
        },
      }],
      conversationHistory: [
        { role: 'assistant', content: '让我拉一下这 2 个项目的详细开票回款记录。' },
      ],
    });

    expect(restored.effectiveMessage).toContain('INVOICE 明细');
    expect(restored.effectiveMessage).toContain('伊利直播带教');
    expect(restored.inheritedScope.scopeSource).toBe('inherited_result_set');
  });
});
