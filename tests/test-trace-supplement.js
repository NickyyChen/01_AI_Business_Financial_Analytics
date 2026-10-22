const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PipelineTrace = require('../src/utils/pipeline-trace');
const qaLogger = require('../src/utils/qa-logger');
const executor = require('../src/agent/executor');

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const toolPrompt = executor.formatResultsForPrompt({
    results: {},
    errors: { 'finance.profitOverview': 'mock boom' },
  });
  assert(toolPrompt.includes('不代表“无数据”'), '工具失败提示必须明确“不等于无数据”');

  const trace = new PipelineTrace(path.join(__dirname, '../logs/test'));
  trace.logPhase2(
    12,
    new Set(['projectMaster', 'actualProject']),
    { results: {}, errors: { 'finance.profitOverview': 'mock boom' }, elapsed: 5 },
    {
      attemptedTables: ['projectMaster', 'actualProject'],
      rowCounts: { projectMaster: 3, actualProject: 0 },
      fetchErrors: [{ tableKey: 'actualProject', stage: 'actualProject.byKeys', message: 'mock fetch error' }],
      cache: { hit: false, missing: [] },
    },
  );
  const traceText = trace.getBuffer().join('\n');
  assert(traceText.includes('Memory 实际取数'), 'phase2 trace 需要输出 Memory 实际取数');
  assert(traceText.includes('mock fetch error'), 'phase2 trace 需要输出取数错误');

  const uniq = `trace-smoke-${Date.now()}`;
  qaLogger.record({
    userName: 'trace-smoke',
    userId: 'ou_trace_smoke',
    role: '员工',
    source: 'unit',
    question: uniq,
    reply: 'ok',
    planResult: {
      tools_needed: ['finance.profitOverview'],
      tables_needed: ['projectMaster', 'actualProject'],
    },
    memoryTrace: {
      attemptedTables: ['projectMaster', 'actualProject'],
      rowCounts: { projectMaster: 3, actualProject: 0 },
      fetchErrors: [{ tableKey: 'actualProject', stage: 'actualProject.byKeys', message: 'mock fetch error' }],
      cache: { hit: false, missing: [] },
    },
    toolResults: {
      results: {},
      errors: { 'finance.profitOverview': 'mock boom' },
    },
    elapsedMs: 42,
  });

  await new Promise((resolve) => setTimeout(resolve, 150));

  const logFile = path.join(__dirname, `../logs/qa-trace-${today()}.log`);
  const jsonlFile = path.join(__dirname, `../logs/qa-trace-${today()}.jsonl`);
  const logText = fs.readFileSync(logFile, 'utf-8');
  const jsonlText = fs.readFileSync(jsonlFile, 'utf-8');

  assert(logText.includes(uniq), 'qa-trace log 需要写入本次问题');
  assert(logText.includes('【Memory 实际取数】'), 'qa-trace log 需要展示 Memory 实际取数');
  assert(logText.includes('mock fetch error'), 'qa-trace log 需要展示 Memory 错误');
  assert(logText.includes('不等于“无数据”'), 'qa-trace log 需要展示工具失败提示');
  assert(jsonlText.includes(uniq), 'qa-trace jsonl 需要写入本次问题');
  assert(jsonlText.includes('"memory_trace"'), 'qa-trace jsonl 需要落 memory_trace');

  console.log('trace supplement ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
