const { _buildDeterministicReceivablesAnswer } = require('../src/agent/pipeline');

describe('receivables deterministic answer', () => {
  test('点名单项目回款情况时优先返回项目级口径，不被全公司权威模板抢答', () => {
    const reply = _buildDeterministicReceivablesAnswer(
      '无限极-UGC内容运营这个项目的回款情况怎么样？请给出回款计划履约额、本年实际到账、未回款和回款率。',
      {
        results: {
          'finance.receivables': {
            _periodLabel: '2026年度（回款计划口径）',
            _sourceTable: 'INVOICE（开票回款计划表）',
            authoritativeAnswer: {
              ytdByDelivery: '【2026年度（回款计划口径） · 全公司】\n| 回款计划履约额 | **757.58 万** |',
            },
            projects: [
              {
                name: '无限极-UGC内容运营',
                revenueDelivered: 81000,
                received: 273217,
                outstanding: -192217,
                collectRate: 337.3,
                ytdMatchedRows: 1,
                ytdReceivedRows: 5,
              },
            ],
          },
        },
      },
      { period: 'ytd' },
    );

    expect(reply).toContain('**无限极-UGC内容运营 回款情况**');
    expect(reply).toContain('| 回款计划履约额 | **8.10 万** |');
    expect(reply).toContain('| 本年实际到账 | **27.32 万** |');
    expect(reply).toContain('| 未回款 | **-19.22 万** |');
    expect(reply).toContain('| 回款率 | **337.3%** |');
    expect(reply).not.toContain('全公司');
    expect(reply).not.toContain('757.58 万');
  });

  test('项目计划命中行数缺失时不臆造 0 条计划记录', () => {
    const reply = _buildDeterministicReceivablesAnswer(
      '无限极-UGC内容运营这个项目2026年1-5月的回款情况怎么样？',
      {
        results: {
          'finance.receivables': {
            _periodLabel: '2026年度（回款计划口径）',
            projects: [
              {
                name: '无限极-UGC内容运营',
                revenueDelivered: 81000,
                received: 273217,
                outstanding: -192217,
                collectRate: 337.3,
                ytdCollectionCount: 5,
              },
            ],
          },
        },
      },
      { period: 'ytd' },
    );

    expect(reply).toContain('本年实际到账命中 5 条实际回款记录');
    expect(reply).not.toContain('回款计划履约额命中 0 条计划记录');
  });
});
