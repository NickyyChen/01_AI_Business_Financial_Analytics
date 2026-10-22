const assert = require('assert');
const path = require('path');

const config = require('../config');
const PipelineTrace = require('../src/utils/pipeline-trace');
const pipeline = require('../src/agent/pipeline');
const planner = require('../src/agent/planner');
const executor = require('../src/agent/executor');
const memoryManager = require('../src/services/memory-manager');
const permManager = require('../src/permissions/permission-manager');
const financeAccessPolicy = require('../src/permissions/finance-access-policy');
const reflectionStore = require('../src/stores/reflection-store');
const knowhowLibrary = require('../src/utils/knowhow-library');
const llm = require('../src/clients/llm-client');
const answerPrompt = require('../src/agent/answer-prompt');

function emptyMemory() {
  return {
    profile: null,
    meetings: [],
    calendar: [],
    chats: [],
    workItems: [],
    projectStaffing: [],
    projectMaster: [],
    projectMonthly: [],
    projectTeamStaffing: [],
    performanceTargets: [],
    riskControlRules: [],
    riskAlerts: [],
    trends: null,
    employeeProfile: null,
    reviews: [],
    invoices: [],
    actualProject: [],
    actualDept: [],
    pendingPayments: [],
    budgetDept: [],
    budgetProject: [],
    vendorContracts: [],
    talentPool: [],
    deptYoy: [],
    companyYoy: [],
    revenueMom: [],
    customerProjects: [],
    presaleProjects: [],
    signDeliveries: [],
    biddings: [],
    invoiceApply: [],
    budgetWorktime: [],
  };
}

async function main() {
  const restore = {
    answerProvider: config.ANSWER_PROVIDER,
    minimaxKey: config.MINIMAX_API_KEY,
    plan: planner.plan,
    toTableSelection: planner.toTableSelection,
    formatForPrompt: planner.formatForPrompt,
    executeTools: executor.executeTools,
    formatResultsForPrompt: executor.formatResultsForPrompt,
    getUserMemory: memoryManager.getUserMemory,
    formatMemoryForLLM: memoryManager.formatMemoryForLLM,
    resolveScope: permManager.resolveScope,
    formatScopeForPrompt: permManager.formatScopeForPrompt,
    financeCheck: financeAccessPolicy.checkFinanceAccess,
    getRelevantCorrections: reflectionStore.getRelevantCorrections,
    formatCorrections: reflectionStore.formatForPrompt,
    knowhowFormat: knowhowLibrary.formatForPrompt,
    chat: llm.chat,
    buildInput: answerPrompt.buildInput,
  };

  try {
    config.ANSWER_PROVIDER = 'ark';
    config.MINIMAX_API_KEY = '';

    planner.plan = async () => ({
      out_of_scope: false,
      out_of_scope_reason: '',
      tools_needed: ['finance.profitOverview'],
      tables_needed: ['projectMaster'],
      period: 'latest',
      question_decomposition: [],
      reasoning_framework: '',
      subordinate_depth: 1,
      query_scope: { depts: [] },
    });
    planner.toTableSelection = () => new Set(['projectMaster']);
    planner.formatForPrompt = () => '';

    permManager.resolveScope = async () => ({
      dataScope: 'self',
      isGlobal: false,
      visibleModules: ['project', 'finance'],
      depts: [],
    });
    permManager.formatScopeForPrompt = () => '';

    financeAccessPolicy.checkFinanceAccess = () => ({ reject: false });
    reflectionStore.getRelevantCorrections = () => [];
    reflectionStore.formatForPrompt = () => '';
    knowhowLibrary.formatForPrompt = () => '';

    memoryManager.getUserMemory = async () => {
      const memory = emptyMemory();
      Object.defineProperty(memory, '_traceMeta', {
        value: {
          attemptedTables: ['projectMaster'],
          rowCounts: { projectMaster: 5 },
          fetchErrors: [],
          cache: { hit: false, missing: [] },
        },
        enumerable: false,
        configurable: true,
      });
      return memory;
    };
    memoryManager.formatMemoryForLLM = () => '';

    executor.executeTools = async () => ({
      results: {},
      errors: { 'finance.profitOverview': 'mock fail' },
      elapsed: 7,
    });
    executor.formatResultsForPrompt = () => 'mock tool results';

    answerPrompt.buildInput = () => ([
      { content: [{ type: 'text', text: 'system prompt' }] },
      { content: [{ type: 'text', text: 'user prompt' }] },
    ]);
    llm.chat = async () => ({ text: 'mock reply', usage: { total_tokens: 1 } });

    const trace = new PipelineTrace(path.join(__dirname, '../logs/test'));
    const result = await pipeline.handleRequest({
      user_id: 'ou_test_trace',
      userName: 'trace-user',
      message: 'trace memory',
      role: '员工',
      conversationHistory: [],
      context: {},
      _trace: trace,
    });

    assert(result._memoryTrace, 'pipeline 结果中应返回 _memoryTrace');
    assert.deepStrictEqual(result._memoryTrace.attemptedTables, ['projectMaster'], '_memoryTrace 应保留 attemptedTables');
    assert(trace.getBuffer().join('\n').includes('Memory 实际取数'), 'pipeline trace 应写入 Memory 实际取数');
    console.log('pipeline memory trace ok');
  } finally {
    config.ANSWER_PROVIDER = restore.answerProvider;
    config.MINIMAX_API_KEY = restore.minimaxKey;
    planner.plan = restore.plan;
    planner.toTableSelection = restore.toTableSelection;
    planner.formatForPrompt = restore.formatForPrompt;
    executor.executeTools = restore.executeTools;
    executor.formatResultsForPrompt = restore.formatResultsForPrompt;
    memoryManager.getUserMemory = restore.getUserMemory;
    memoryManager.formatMemoryForLLM = restore.formatMemoryForLLM;
    permManager.resolveScope = restore.resolveScope;
    permManager.formatScopeForPrompt = restore.formatScopeForPrompt;
    financeAccessPolicy.checkFinanceAccess = restore.financeCheck;
    reflectionStore.getRelevantCorrections = restore.getRelevantCorrections;
    reflectionStore.formatForPrompt = restore.formatCorrections;
    knowhowLibrary.formatForPrompt = restore.knowhowFormat;
    llm.chat = restore.chat;
    answerPrompt.buildInput = restore.buildInput;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
