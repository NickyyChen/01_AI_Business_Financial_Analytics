/**
 * llm-client.js - 豆包大模型 API 客户端
 *
 * 使用火山引擎 Ark Responses API
 * 仅使用 Node.js 内置模块
 */

const https = require('https');
const config = require('../../config');
const logger = require('../utils/logger');

const ARK_HOST = 'ark.cn-beijing.volces.com';
const ARK_PATH = '/api/v3/responses';
const ARK_API_KEY = config.ARK_API_KEY;
const ARK_MODEL = config.ARK_MODEL;

/**
 * 调用豆包大模型
 * @param {Array} input - Responses API 格式的 input 数组
 * @param {object} [opts] - 可选参数 { temperature, max_output_tokens, instructions, textFormat }
 * @returns {object} { text, usage, raw }
 */
async function chat(input, opts = {}) {
  const model = opts.model || ARK_MODEL;
  const body = {
    model,
    input,
  };

  if (opts.instructions) {
    body.instructions = opts.instructions;
  }
  if (opts.temperature !== undefined) {
    body.temperature = opts.temperature;
  }
  if (opts.max_output_tokens) {
    body.max_output_tokens = opts.max_output_tokens;
  }
  if (opts.textFormat) {
    body.text = { format: opts.textFormat };
  }
  // 火山豆包 seed-2.0 系列支持 thinking 程度可调：minimal/low/medium/high
  // 不传表示走模型默认；A/B 测试时用 minimal/low 压缩延迟
  if (opts.thinking) {
    body.thinking = { type: opts.thinking };
  }

  // Langfuse generation：opts.parent 是 trace 或 span 时才埋点（否则 no-op）
  const generation = opts.parent
    ? opts.parent.generation({
        name: opts.generationName || 'ark-chat',
        model,
        modelParameters: {
          temperature: opts.temperature,
          max_output_tokens: opts.max_output_tokens,
          thinking: opts.thinking || undefined,
          stream: false,
        },
        input,
      })
    : null;

  const startTime = Date.now();
  logger.info(`[LLM] 非流式请求: model=${model}${opts.thinking ? ' thinking=' + opts.thinking : ''} inputMsgs=${Array.isArray(input) ? input.length : 1}`);

  let raw;
  try {
    raw = await doRequestWithRetry(body);
  } catch (e) {
    if (generation) {
      try { generation.end({ level: 'ERROR', statusMessage: e.message }); } catch (_) {}
    }
    throw e;
  }

  const elapsed = Date.now() - startTime;
  logger.info(`[LLM] 非流式响应(${model}): ${elapsed}ms`);

  // 从 Responses API 返回中提取文本
  let text = '';
  if (raw.output) {
    // output 可能是数组
    const outputs = Array.isArray(raw.output) ? raw.output : [raw.output];
    for (const item of outputs) {
      if (item.type === 'message' && item.content) {
        for (const c of item.content) {
          if (c.type === 'output_text') {
            text += c.text;
          }
        }
      }
    }
  }

  // 兜底：如果上面没提取到，尝试 choices 格式（兼容 chat completions）
  if (!text && raw.choices) {
    text = raw.choices[0]?.message?.content || '';
  }

  const usage = raw.usage || null;
  if (generation) {
    try {
      generation.end({
        output: text,
        usage: _mapUsageForLangfuse(usage),
      });
    } catch (_) {}
  }

  return {
    text,
    usage,
    raw,
  };
}

/**
 * 把 Ark/OpenAI 风格的 usage 转换成 Langfuse 认识的字段
 * Ark 有时用 input_tokens/output_tokens/total_tokens，有时用 prompt_tokens/completion_tokens
 */
function _mapUsageForLangfuse(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const input  = usage.input_tokens  ?? usage.prompt_tokens     ?? usage.promptTokens;
  const output = usage.output_tokens ?? usage.completion_tokens ?? usage.completionTokens;
  const total  = usage.total_tokens  ?? usage.totalTokens
    ?? ((input != null && output != null) ? input + output : undefined);
  return { input, output, total, unit: 'TOKENS' };
}

/**
 * 简易调用：单轮对话
 * @param {string} systemPrompt - 系统提示词
 * @param {string} userMessage - 用户消息
 * @param {object} [opts] - 可选参数
 * @returns {string} 回复文本
 */
async function ask(systemPrompt, userMessage, opts = {}) {
  const input = [];

  if (systemPrompt) {
    input.push({ role: 'system', content: [{ type: 'input_text', text: systemPrompt }] });
  }
  input.push({ role: 'user', content: [{ type: 'input_text', text: userMessage }] });

  const result = await chat(input, opts);
  return result.text;
}

/**
 * 带指数退避重试的请求（最多3次，针对 5xx / 429 / 网络超时）
 */
async function doRequestWithRetry(body, maxRetries = 3) {
  const RETRYABLE = (msg) =>
    /502|503|504|429|超时|timeout|ECONNRESET|ETIMEDOUT/i.test(msg);

  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await doRequest(body);
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries && RETRYABLE(e.message)) {
        const delay = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
        logger.warn(`[LLM] 第 ${attempt} 次请求失败 (${e.message})，${delay / 1000}s 后重试...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        break;
      }
    }
  }
  throw lastErr;
}

/**
 * 底层 HTTPS 请求
 */
function doRequest(body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const opts = {
      hostname: ARK_HOST,
      port: 443,
      path: ARK_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ARK_API_KEY}`,
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };

    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          const json = JSON.parse(raw);
          if (json.error) {
            reject(new Error(`Ark API error: ${json.error.message || JSON.stringify(json.error)}`));
          } else {
            resolve(json);
          }
        } catch {
          reject(new Error(`Ark API 返回非JSON: status=${res.statusCode} body=${raw.slice(0, 500)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Ark API 请求超时(120s)')); });
    req.write(bodyStr);
    req.end();
  });
}

/**
 * 流式调用豆包大模型（SSE）
 *
 * 火山引擎 Responses API 流式事件格式：
 *   event: response.output_text.delta
 *   data: {"type":"response.output_text.delta","delta":"文本片段",...}
 *
 *   event: response.output_text.done
 *   data: {"type":"response.output_text.done","text":"完整文本",...}
 *
 *   event: response.completed
 *   data: {"type":"response.completed","response":{...,"usage":{...}}}
 *
 * @param {Array} input - Responses API 格式的 input 数组
 * @param {object} [opts] - { temperature, max_output_tokens, instructions, onChunk }
 * @param {function} opts.onChunk - 每收到一块文本时回调 (text: string) => void
 * @returns {object} { text, usage }
 */
async function chatStream(input, opts = {}) {
  const model = opts.model || ARK_MODEL;
  const body = {
    model,
    input,
    stream: true,
  };

  if (opts.instructions) body.instructions = opts.instructions;
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.max_output_tokens) body.max_output_tokens = opts.max_output_tokens;
  if (opts.textFormat) body.text = { format: opts.textFormat };
  if (opts.thinking) body.thinking = { type: opts.thinking };

  // Langfuse generation
  const generation = opts.parent
    ? opts.parent.generation({
        name: opts.generationName || 'ark-chat-stream',
        model,
        modelParameters: {
          temperature: opts.temperature,
          max_output_tokens: opts.max_output_tokens,
          thinking: opts.thinking || undefined,
          stream: true,
        },
        input,
      })
    : null;

  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const reqOpts = {
      hostname: ARK_HOST,
      port: 443,
      path: ARK_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ARK_API_KEY}`,
        'Content-Length': Buffer.byteLength(bodyStr),
        'Accept': 'text/event-stream',
      },
    };

    let fullText = '';
    let usage = null;
    let chunkCount = 0;
    let firstChunkTime = 0;

    const req = https.request(reqOpts, (res) => {
      if (res.statusCode !== 200) {
        const errChunks = [];
        res.on('data', (c) => errChunks.push(c));
        res.on('end', () => {
          const errBody = Buffer.concat(errChunks).toString().slice(0, 500);
          const err = new Error(`Ark Stream HTTP ${res.statusCode}: ${errBody}`);
          if (generation) {
            try { generation.end({ level: 'ERROR', statusMessage: err.message }); } catch (_) {}
          }
          reject(err);
        });
        return;
      }

      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;

          try {
            const json = JSON.parse(data);

            // --- Responses API 流式格式 ---
            if (json.type === 'response.output_text.delta' && json.delta) {
              if (chunkCount === 0) firstChunkTime = Date.now();
              chunkCount++;
              fullText += json.delta;
              if (opts.onChunk) opts.onChunk(json.delta);
              continue;
            }

            if (json.type === 'response.completed') {
              const resp = json.response || json;
              usage = resp.usage || null;
              continue;
            }

            // --- 兼容 Chat Completions 流式格式（回退） ---
            if (json.choices) {
              const delta = json.choices[0]?.delta;
              if (delta && delta.content) {
                if (chunkCount === 0) firstChunkTime = Date.now();
                chunkCount++;
                fullText += delta.content;
                if (opts.onChunk) opts.onChunk(delta.content);
              }
              if (json.usage) usage = json.usage;
              continue;
            }

            // --- 兼容 Responses API 非流式结构（极端回退） ---
            if (json.output) {
              const outputs = Array.isArray(json.output) ? json.output : [json.output];
              for (const item of outputs) {
                if (item.type === 'message' && item.content) {
                  for (const c of item.content) {
                    if (c.type === 'output_text' && c.text) {
                      fullText += c.text;
                      if (opts.onChunk) opts.onChunk(c.text);
                    }
                  }
                }
              }
              if (json.usage) usage = json.usage;
            }
          } catch (e) {
            logger.debug(`[LLM:Stream] SSE JSON 解析跳过: ${e.message} | raw=${data.slice(0, 100)}`);
          }
        }
      });

      res.on('end', () => {
        const elapsed = Date.now() - startTime;
        const ttft = firstChunkTime ? firstChunkTime - startTime : -1;
        logger.info(`[LLM:Stream] 完成: ${fullText.length}字 | ${chunkCount}chunks | TTFT=${ttft}ms | 总耗时=${elapsed}ms`);
        if (generation) {
          try {
            generation.end({
              output: fullText,
              usage: _mapUsageForLangfuse(usage),
              metadata: { ttftMs: ttft, chunkCount },
            });
          } catch (_) {}
        }
        resolve({ text: fullText, usage });
      });
    });

    req.on('error', (e) => {
      logger.error(`[LLM:Stream] 网络错误: ${e.message}`);
      if (generation) {
        try { generation.end({ level: 'ERROR', statusMessage: e.message }); } catch (_) {}
      }
      reject(e);
    });
    req.setTimeout(180000, () => {
      req.destroy();
      const err = new Error('Ark Stream 请求超时(180s)');
      if (generation) {
        try { generation.end({ level: 'ERROR', statusMessage: err.message }); } catch (_) {}
      }
      reject(err);
    });
    req.write(bodyStr);
    req.end();
  });
}

module.exports = { chat, ask, chatStream };
