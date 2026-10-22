'use strict';

const contextResolver = require('./context-resolver');
const clarificationGate = require('./clarification-gate');
const toolParamResolver = require('./tool-param-resolver');

async function _maybeCall(fn, fallback, ...args) {
  if (typeof fn === 'function') return fn(...args);
  return fallback;
}

function _defaultRouterIntent() {
  return {
    route: 'plan',
    intentType: 'business_query',
    confidence: 0,
    isFollowup: false,
    shouldUsePlanningContext: false,
    shouldPassToPlanner: true,
  };
}

/**
 * Answer 前的公共 pipeline skeleton。
 *
 * 生产 pipeline 仍保留现有 handleRequest/handleRequestStream；该 core 用于把
 * route/context/gate/plan/execute 的状态形状固定下来，后续在
 * PIPELINE_CORE_V2_ENABLED 下逐步切换。
 */
async function runPipelineCore(payload = {}, deps = {}) {
  const {
    user_id = '',
    userName = '',
    message = '',
    role = '员工',
    planningContext = [],
    conversationHistory = [],
    pendingClarification = null,
    scope: providedScope = null,
  } = payload;

  const routerIntent = await _maybeCall(
    deps.routeIntent,
    _defaultRouterIntent(),
    { message, planningContext, conversationHistory, pendingClarification, userName: userName || user_id, role }
  );

  let effectiveMessage = (routerIntent && routerIntent.rewriteMessage) || message;
  let lockedScope = null;
  const contextResolution = await _maybeCall(
    deps.resolveContext,
    contextResolver.resolveContext({
      message,
      routerIntent,
      planningContext,
      conversationHistory,
      pendingClarification,
    }),
    { message, routerIntent, planningContext, conversationHistory, pendingClarification }
  );
  lockedScope = contextResolution && contextResolution.lockedScope ? contextResolution.lockedScope : null;

  const gateDecision = await _maybeCall(
    deps.checkClarification,
    clarificationGate.checkClarification({ message, planningContext, contextResolution, pendingClarification }),
    { message, planningContext, contextResolution, pendingClarification }
  );

  if (gateDecision && gateDecision.action === 'clarify') {
    return {
      status: 'clarification',
      reply: gateDecision.clarificationQuestion,
      effectiveMessage,
      lockedScope,
      pendingClarification: gateDecision.pendingClarification || null,
      scope: providedScope,
      effectiveScope: providedScope,
      planResult: null,
      userMemory: null,
      memoryTrace: null,
      corrections: [],
      toolExecution: null,
      executionTables: null,
      toolIds: [],
    };
  }

  if (gateDecision && gateDecision.restored) {
    effectiveMessage = gateDecision.effectiveMessage || effectiveMessage;
    lockedScope = gateDecision.lockedScope || lockedScope;
  }

  const scope = await _maybeCall(
    deps.resolveScope,
    providedScope,
    userName || user_id,
    { maxDepth: 1, role }
  );

  const planResult = await _maybeCall(
    deps.plan,
    null,
    effectiveMessage,
    {
      userName: userName || user_id,
      role,
      planningContext,
      pendingClarification: gateDecision && gateDecision.restored ? null : pendingClarification,
      routerIntent: gateDecision && gateDecision.intent ? gateDecision.intent : routerIntent,
      lockedScope,
      forcePlan: !!(routerIntent && routerIntent.route === 'plan'),
    }
  );

  contextResolver.applyLockedScopeToPlan(planResult, lockedScope);
  const toolParams = await _maybeCall(
    deps.resolveToolParams,
    planResult ? toolParamResolver.resolveToolParams({ message: effectiveMessage, planResult, enableRuleFallback: false }) : {},
    { message: effectiveMessage, planResult, lockedScope }
  );
  if (planResult) planResult.tool_params = toolParams || {};

  const policyReject = await _maybeCall(
    deps.checkPolicy,
    null,
    { message, effectiveMessage, planResult, scope, userName: userName || user_id }
  );
  if (policyReject && policyReject.reject) {
    return {
      status: 'policy_reject',
      reply: policyReject.reply,
      effectiveMessage,
      lockedScope,
      pendingClarification: null,
      scope,
      effectiveScope: scope,
      planResult,
      userMemory: null,
      memoryTrace: null,
      corrections: [],
      toolExecution: null,
      executionTables: null,
      toolIds: [],
    };
  }

  const effectiveScope = await _maybeCall(
    deps.buildEffectiveScope,
    scope,
    planResult,
    scope,
    lockedScope
  );

  const executionTables = await _maybeCall(
    deps.selectTables,
    null,
    planResult,
    { effectiveMessage, effectiveScope }
  );
  const toolIds = await _maybeCall(
    deps.selectTools,
    (planResult && Array.isArray(planResult.tools_needed)) ? planResult.tools_needed : [],
    planResult,
    { effectiveMessage, effectiveScope }
  );

  const userMemory = await _maybeCall(
    deps.loadMemory,
    null,
    user_id,
    { userName: userName || user_id, question: effectiveMessage, plannedTables: executionTables, scope: effectiveScope }
  );
  const memoryTrace = userMemory && userMemory._traceMeta ? userMemory._traceMeta : null;

  const corrections = await _maybeCall(
    deps.loadCorrections,
    [],
    userName || user_id,
    effectiveMessage
  );

  const toolExecution = await _maybeCall(
    deps.executeTools,
    { results: {}, errors: {}, elapsed: 0 },
    toolIds,
    userMemory,
    { ...effectiveScope, empName: userName || user_id, role, question: effectiveMessage, planResult },
    { toolParams: toolParams || {} }
  );

  const failClosed = await _maybeCall(
    deps.checkFailClosed,
    null,
    { message: effectiveMessage, toolExecution, memoryTrace, executionTables, toolIds }
  );
  if (failClosed) {
    return {
      status: 'fail_closed',
      reply: failClosed.reply,
      effectiveMessage,
      lockedScope,
      pendingClarification: null,
      scope,
      effectiveScope,
      planResult,
      userMemory,
      memoryTrace,
      corrections,
      toolExecution,
      executionTables,
      toolIds,
    };
  }

  const deterministic = await _maybeCall(
    deps.buildDeterministicAnswer,
    null,
    effectiveMessage,
    toolExecution
  );
  if (deterministic) {
    return {
      status: 'deterministic_answer',
      reply: deterministic,
      effectiveMessage,
      lockedScope,
      pendingClarification: null,
      scope,
      effectiveScope,
      planResult,
      userMemory,
      memoryTrace,
      corrections,
      toolExecution,
      executionTables,
      toolIds,
    };
  }

  return {
    status: 'ready_for_answer',
    reply: '',
    effectiveMessage,
    lockedScope,
    pendingClarification: null,
    scope,
    effectiveScope,
    planResult,
    userMemory,
    memoryTrace,
    corrections,
    toolExecution,
    executionTables,
    toolIds,
  };
}

module.exports = {
  runPipelineCore,
};
