/**
 * langfuse-client.js - Langfuse v5 客户端 + v3 兼容适配层
 *
 * 设计原则：
 *   1. 未配置 (public/secret 为空) 或 LANGFUSE_DISABLED=true → 返回 no-op 对象
 *      业务代码一律写 `const trace = lf.trace(...)` / `trace.span(...)`，
 *      不需要任何 if 判断。
 *   2. 失败静默：Langfuse 上报失败不能影响主流程（网络/鉴权错都吞掉）
 *   3. 进程退出前必须调用 shutdown() / flushAsync()，否则最后一批 event 会丢
 *
 * 接入方式（v5）：
 *   - 底层走 @langfuse/tracing + @langfuse/otel，基于 OpenTelemetry
 *   - 对外仍然暴露 v3 风格 API（trace / span / generation / event / update / end）
 *     这样业务代码（pipeline.js / planner.js / executor.js / llm-client.js）
 *     无需跟着 SDK 升级而改动
 *
 * 用法：
 *   const lf = require('./langfuse-client');
 *   const trace = lf.trace({ name: 'xxx', userId: 'yyy', input: '...' });
 *   const span = trace.span({ name: 'phase1' });
 *   span.end({ output: {...} });
 *   const gen = trace.generation({ name: 'answer-llm', model: 'm', input: [...] });
 *   gen.end({ output: text, usage: {...} });
 *   trace.update({ output: finalText });
 *   await lf.flushAsync();  // 进程退出前
 */

const config = require('../../config');
const logger = require('./logger');

// ==================== no-op 实现（Langfuse 未启用时）====================

const NOOP_OBSERVATION = {
  end: () => {},
  update: () => {},
  span: () => NOOP_OBSERVATION,
  generation: () => NOOP_OBSERVATION,
  event: () => NOOP_OBSERVATION,
  score: () => {},
  get id() { return null; },
  get traceId() { return null; },
};

const NOOP_TRACE = {
  span: () => NOOP_OBSERVATION,
  generation: () => NOOP_OBSERVATION,
  event: () => NOOP_OBSERVATION,
  update: () => {},
  score: () => {},
  end: () => {},
  get id() { return null; },
};

// ==================== 启用判断 ====================

function _shouldEnable() {
  const disabled = String(config.LANGFUSE_DISABLED || '').toLowerCase();
  if (disabled === 'true' || disabled === '1') return false;
  if (!config.LANGFUSE_PUBLIC_KEY || !config.LANGFUSE_SECRET_KEY) return false;
  if (!config.LANGFUSE_BASE_URL) return false;
  return true;
}

// ==================== v5 底层单例（NodeTracerProvider + LangfuseSpanProcessor）====================

let _provider = null;
let _processor = null;
let _tracing = null;     // @langfuse/tracing 模块引用
let _enabled = false;
let _initError = null;

// 追踪所有"创建了但还没 end"的 root span，flushAsync/shutdown 兜底结束。
// 关键：v3 里 trace 对象不需要 end；v5 里每个 OTel span 必须 end 才会被 processor 导出。
const _activeRoots = new Set();

function _getInstance() {
  if (_provider || _initError) return _provider;
  if (!_shouldEnable()) return null;

  try {
    const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
    const { LangfuseSpanProcessor } = require('@langfuse/otel');
    _tracing = require('@langfuse/tracing');

    _processor = new LangfuseSpanProcessor({
      publicKey:     config.LANGFUSE_PUBLIC_KEY,
      secretKey:     config.LANGFUSE_SECRET_KEY,
      baseUrl:       config.LANGFUSE_BASE_URL,
      flushAt:       config.LANGFUSE_FLUSH_AT,
      flushInterval: Math.max(1, Math.floor((config.LANGFUSE_FLUSH_INTERVAL || 10000) / 1000)), // v5 用秒
      environment:   config.LANGFUSE_ENVIRONMENT || process.env.LANGFUSE_TRACING_ENVIRONMENT || 'local-dev',
      release:       process.env.APP_RELEASE || undefined,
    });

    _provider = new NodeTracerProvider({ spanProcessors: [_processor] });
    _provider.register();

    _enabled = true;
    logger.info(`[Langfuse] 已启用 | v5/OTel | baseUrl=${config.LANGFUSE_BASE_URL} flushAt=${config.LANGFUSE_FLUSH_AT} flushInterval=${config.LANGFUSE_FLUSH_INTERVAL}ms`);
    return _provider;
  } catch (e) {
    _initError = e;
    logger.warn(`[Langfuse] 初始化失败，已降级为 no-op: ${e.message}`);
    return null;
  }
}

// ==================== v3 兼容包装器 ====================

/**
 * 安全地把任意对象转成 OTel attribute 能接受的形式（primitive 或 string）
 * OTel attribute 不接受嵌套对象，必须 stringify
 */
function _safeStringify(v) {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * 把 v3 风格的 usage 转成 v5 的 usageDetails
 * v3: { input, output, total, unit } 或 { prompt_tokens, completion_tokens, total_tokens }
 * v5: usageDetails: { [k]: number } — 字段要是纯数字
 */
function _mapUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const input  = usage.input  ?? usage.prompt_tokens     ?? usage.promptTokens;
  const output = usage.output ?? usage.completion_tokens ?? usage.completionTokens;
  const total  = usage.total  ?? usage.total_tokens      ?? usage.totalTokens
    ?? ((typeof input === 'number' && typeof output === 'number') ? input + output : undefined);
  const out = {};
  if (typeof input  === 'number') out.input  = input;
  if (typeof output === 'number') out.output = output;
  if (typeof total  === 'number') out.total  = total;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 把 v3 end/update 的参数转成 v5 span.update 的参数
 */
function _toV5Attrs(params, isGeneration = false) {
  if (!params) return {};
  const { output, metadata, level, statusMessage, input, model, modelParameters, usage, version, environment } = params;
  const out = {};
  if (output !== undefined) out.output = output;
  if (input !== undefined)  out.input  = input;
  if (metadata && typeof metadata === 'object') out.metadata = metadata;
  if (level) out.level = level;
  if (statusMessage) out.statusMessage = statusMessage;
  if (version) out.version = version;
  if (environment) out.environment = environment;
  if (isGeneration) {
    if (model) out.model = model;
    if (modelParameters) {
      // OTel attribute 要求 primitive，这里只保留值为 string/number/boolean 的键
      const mp = {};
      for (const [k, v] of Object.entries(modelParameters)) {
        if (v === undefined || v === null) continue;
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') mp[k] = v;
        else mp[k] = String(v);
      }
      out.modelParameters = mp;
    }
    const u = _mapUsage(usage);
    if (u) out.usageDetails = u;
  }
  return out;
}

/**
 * ObsWrapper：包装 v5 的 LangfuseSpan / LangfuseGeneration / LangfuseTool 等，
 * 暴露 v3 风格的 .span() / .generation() / .event() / .update() / .end() API。
 */
class ObsWrapper {
  constructor(obs, kind = 'span') {
    this._obs = obs;
    this._kind = kind; // 'span' | 'generation' | 'tool' | 'event' | 'root'
    this._ended = false;
  }
  get id()      { try { return this._obs.id; }      catch { return null; } }
  get traceId() { try { return this._obs.traceId; } catch { return null; } }

  span(params = {}) {
    try {
      const { name, input, metadata, level } = params;
      const child = this._obs.startObservation(String(name || 'span'), {
        input, metadata, level,
      });
      return new ObsWrapper(child, 'span');
    } catch (e) {
      logger.debug(`[Langfuse] span() 降级: ${e.message}`);
      return NOOP_OBSERVATION;
    }
  }

  generation(params = {}) {
    try {
      const { name, model, modelParameters, input, metadata } = params;
      const mp = {};
      if (modelParameters) {
        for (const [k, v] of Object.entries(modelParameters)) {
          if (v === undefined || v === null) continue;
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') mp[k] = v;
          else mp[k] = String(v);
        }
      }
      const gen = this._obs.startObservation(
        String(name || 'generation'),
        { model, modelParameters: mp, input, metadata },
        { asType: 'generation' },
      );
      return new ObsWrapper(gen, 'generation');
    } catch (e) {
      logger.debug(`[Langfuse] generation() 降级: ${e.message}`);
      return NOOP_OBSERVATION;
    }
  }

  event(params = {}) {
    try {
      const { name, level, metadata, input, output } = params;
      // v5 event 自动结束
      this._obs.startObservation(
        String(name || 'event'),
        { level, metadata, input, output },
        { asType: 'event' },
      );
    } catch (e) {
      logger.debug(`[Langfuse] event() 降级: ${e.message}`);
    }
    return NOOP_OBSERVATION;
  }

  update(params = {}) {
    try {
      this._obs.update(_toV5Attrs(params, this._kind === 'generation'));
    } catch (e) {
      logger.debug(`[Langfuse] update() 降级: ${e.message}`);
    }
  }

  end(params) {
    if (this._ended) return;
    this._ended = true;
    try {
      if (params) {
        this._obs.update(_toV5Attrs(params, this._kind === 'generation'));
      }
      this._obs.end();
    } catch (e) {
      logger.debug(`[Langfuse] end() 降级: ${e.message}`);
    }
  }

  score() { /* v3 score API，v5 需用 @langfuse/client 单独发，暂不实现 */ }
}

/**
 * TraceWrapper：根 observation 的包装器。
 * v3 里 trace 是独立对象；v5 里没有独立 trace，根 span 即 trace。
 * 这个 wrapper 把两种心智模型桥接起来。
 */
class TraceWrapper extends ObsWrapper {
  constructor(rootSpan, meta) {
    super(rootSpan, 'root');
    this._meta = meta || {};
    _activeRoots.add(this);
  }

  // v3 里 trace.id 是 trace id；v5 里 obs.id 是 span id，obs.traceId 才是 trace id。
  // 这里覆盖 id 返回 traceId，保持 v3 语义。
  get id() { try { return this._obs.traceId; } catch { return null; } }

  // 覆盖 end：从活跃集合里移除，防止 flush/shutdown 时重复 end
  end(params) {
    if (this._ended) return;
    _activeRoots.delete(this);
    super.end(params);
  }

  /**
   * trace 级别的 update：除了更新 root span 自身的 output/metadata，
   * 还要把 input/output 写到 trace 级别的 attribute（供 UI 顶部 Input/Output 面板显示）。
   */
  update(params = {}) {
    try {
      const v5Attrs = _toV5Attrs(params, false);
      this._obs.update(v5Attrs);

      // trace 级别的 input/output 需要显式写到 trace attribute（OTel 不支持嵌套对象，自己 stringify）
      const otel = this._obs.otelSpan;
      if (otel && typeof otel.setAttribute === 'function') {
        if (params.output !== undefined) {
          const s = _safeStringify(params.output);
          if (s !== undefined) otel.setAttribute('langfuse.trace.output', s);
        }
        if (params.input !== undefined) {
          const s = _safeStringify(params.input);
          if (s !== undefined) otel.setAttribute('langfuse.trace.input', s);
        }
        if (params.metadata && typeof params.metadata === 'object') {
          const s = _safeStringify(params.metadata);
          if (s !== undefined) otel.setAttribute('langfuse.trace.metadata', s);
        }
      }
    } catch (e) {
      logger.debug(`[Langfuse] trace.update() 降级: ${e.message}`);
    }
  }
}

// ==================== 对外 API ====================

/**
 * 创建一个 trace（对应一次用户请求）
 * @param {object} params { name, userId, sessionId, input, metadata, tags }
 * @returns TraceWrapper（真实）或 no-op trace
 */
function trace(params = {}) {
  _getInstance();
  if (!_tracing || !_enabled) return NOOP_TRACE;

  try {
    const { name, userId, sessionId, input, metadata, tags, version } = params;
    const rootSpan = _tracing.startObservation(String(name || 'request'), {
      input,
      metadata,
      version,
    });

    const otel = rootSpan.otelSpan;
    if (otel && typeof otel.setAttribute === 'function') {
      if (userId)    otel.setAttribute('user.id',    String(userId));
      if (sessionId) otel.setAttribute('session.id', String(sessionId));
      if (Array.isArray(tags) && tags.length > 0) {
        otel.setAttribute('langfuse.trace.tags', tags.map(String));
      }
      if (name) otel.setAttribute('langfuse.trace.name', String(name));
      if (input !== undefined) {
        const s = _safeStringify(input);
        if (s !== undefined) otel.setAttribute('langfuse.trace.input', s);
      }
      if (metadata && typeof metadata === 'object') {
        const s = _safeStringify(metadata);
        if (s !== undefined) otel.setAttribute('langfuse.trace.metadata', s);
      }
    }

    return new TraceWrapper(rootSpan, { name, userId, sessionId });
  } catch (e) {
    logger.warn(`[Langfuse] trace() 失败: ${e.message}`);
    return NOOP_TRACE;
  }
}

/**
 * 结束所有还活着的 root span。
 *   v5 要求每个 span 必须 .end() 才会被 processor 导出；
 *   v3 业务代码里从来不 end trace，所以 flush 前必须在兼容层兜底 end。
 */
function _endAllActiveRoots() {
  if (_activeRoots.size === 0) return;
  const roots = Array.from(_activeRoots);
  _activeRoots.clear();
  for (const r of roots) {
    try {
      if (r && !r._ended) {
        r._ended = true;
        r._obs.end();
      }
    } catch (e) {
      logger.debug(`[Langfuse] 自动 end root span 失败: ${e.message}`);
    }
  }
}

/**
 * 立即异步 flush（关键点调用）
 */
async function flushAsync() {
  if (!_processor) return;
  try {
    _endAllActiveRoots();
    await _processor.forceFlush();
  } catch (e) {
    logger.warn(`[Langfuse] flushAsync 失败: ${e.message}`);
  }
}

/**
 * 关闭客户端（进程退出时调用）
 */
async function shutdown() {
  if (!_processor) return;
  try {
    _endAllActiveRoots();
    await _processor.forceFlush();
    await _processor.shutdown();
    logger.info('[Langfuse] 已关闭');
  } catch (e) {
    logger.warn(`[Langfuse] shutdown 失败: ${e.message}`);
  }
}

function isEnabled() { return _enabled; }

// 提前初始化（让启用日志尽早打出来）
_getInstance();

module.exports = {
  trace,
  flushAsync,
  shutdown,
  isEnabled,
};
