const { _sanitizeAnswerText, _normalizeFteParticipantFormat } = require('../src/agent/pipeline');

describe('answer format sanitizer', () => {
  test('preserves markdown tables wider than four columns', () => {
    const text = [
      '| 部门 | 预算收入 | 预算成本 | 预算利润 | 利润率 |',
      '| --- | ---: | ---: | ---: | ---: |',
      '| 公司层面 | 102.1万 | 37.5万 | 64.6万 | 63.3% |',
    ].join('\n');

    const result = _sanitizeAnswerText(text);

    expect(result).toContain('| 部门 | 预算收入 | 预算成本 | 预算利润 | 利润率 |');
    expect(result).toContain('| 公司层面 | 102.1万 | 37.5万 | 64.6万 | 63.3% |');
    expect(result).not.toContain('1. 部门：');
  });

  test('preserves markdown tables longer than eight data rows', () => {
    const rows = Array.from({ length: 9 }, (_, idx) => `| 项目${idx + 1} | ${idx + 1}.0万 |`);
    const text = [
      '| 项目 | 收入 |',
      '| --- | ---: |',
      ...rows,
    ].join('\n');

    const result = _sanitizeAnswerText(text);

    expect(result).toContain('| 项目9 | 9.0万 |');
    expect(result).not.toContain('9. 项目：项目9');
  });

  test('still sanitizes markdown headings without changing tables', () => {
    const text = [
      '## 预算总览',
      '',
      '| 部门 | 预算收入 |',
      '| --- | ---: |',
      '| 公司层面 | 102.1万 |',
    ].join('\n');

    const result = _sanitizeAnswerText(text);

    expect(result).toContain('**预算总览**');
    expect(result).toContain('| 部门 | 预算收入 |');
  });

  test('normalizes FTE participant shorthand to product wording', () => {
    const text = [
      '| 2026年1月 | 10.20 FTE（12人） | 3.10 FTE（5人） |',
      '3月冲到顶点（48.93 FTE / 55人），之后连续两月回落。',
    ].join('\n');

    const result = _normalizeFteParticipantFormat(text);

    expect(result).toContain('10.20 FTE（12名参与人员）');
    expect(result).toContain('3.10 FTE（5名参与人员）');
    expect(result).toContain('48.93 FTE（55名参与人员）');
    expect(result).not.toContain('FTE（12人）');
    expect(result).not.toContain('FTE / 55人');
  });
});
