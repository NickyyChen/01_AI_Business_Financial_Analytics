'use strict';

jest.mock('../src/utils/logger', () => ({
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
}));

const pipeline = require('../src/agent/pipeline');

describe('deterministic person effort answer', () => {
  test('renders actual effort rows without budget or overrun wording', () => {
    const reply = pipeline._buildDeterministicPersonEffortAnswer(
      '我当前可见范围 1-5月人员情况，需要具体人名和精力',
      {
        results: {
          'finance.laborCost': {
            _periodLabel: '2026年1-5月累计',
            personEffortDetail: {
              actualPeopleCount: 2,
              actualProjectCount: 1,
              totalPersonActualRecordCount: 4,
              totalActualFTE: 3,
              rowCount: 3,
              omittedRowCount: 1,
              rows: [
                {
                  project: '财务部管理',
                  person: '张媛',
                  actualFTE: 2,
                  monthly: [
                    { monthLabel: '2026年1月', actualFTE: 1 },
                    { monthLabel: '2026年2月', actualFTE: 1 },
                  ],
                },
                {
                  project: '财务部管理',
                  person: '杨茗',
                  actualFTE: 1,
                  monthly: [
                    { monthLabel: '2026年1月', actualFTE: 1 },
                  ],
                },
              ],
            },
          },
        },
      }
    );

    expect(reply).toContain('📌 数据来源：ACTUAL_WORKTIME（实际：26年工时）');
    expect(reply).toContain('| 财务部管理 | 张媛 | 2.00 | 2026年1月=1.00FTE；2026年2月=1.00FTE |');
    expect(reply).toContain('另有 **1** 条未在本轮展开');
    expect(reply).not.toMatch(/预算FTE|预算精力|预算差异|预算缺失|预算累计|BUDGET_WORKTIME|超编|无超编/);
  });

  test('prefers normalized explicit plan period over broad tool label', () => {
    const reply = pipeline._buildDeterministicPersonEffortAnswer(
      '我当前可见范围 1-5月人员情况，需要具体人名和精力',
      {
        results: {
          'finance.laborCost': {
            _periodLabel: '2026年（年初至今累计，本月(6月)数据尚在归集中未纳入）',
            personEffortDetail: {
              actualPeopleCount: 1,
              actualProjectCount: 1,
              totalPersonActualRecordCount: 6,
              totalActualFTE: 5,
              rowCount: 1,
              rows: [
                {
                  project: '财务部管理',
                  person: '杨茗',
                  actualFTE: 5,
                  monthly: [
                    { monthLabel: '2026年1月', actualFTE: 1 },
                    { monthLabel: '2026年2月', actualFTE: 1 },
                    { monthLabel: '2026年3月', actualFTE: 1 },
                    { monthLabel: '2026年4月', actualFTE: 1 },
                    { monthLabel: '2026年5月', actualFTE: 1 },
                  ],
                },
              ],
            },
          },
        },
      },
      { period: '2026-01~2026-05' }
    );

    expect(reply).toContain('📅 时间口径：2026年1-5月累计');
    expect(reply).not.toContain('📅 时间口径：2026年（年初至今累计');
  });
});
