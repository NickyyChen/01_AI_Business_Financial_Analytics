/**
 * minimax-client.js - MiniMax M2 系列 OpenAI 兼容客户端
 *
 * 生产集成策略：
 *   - 接口与 llm-client.chat 对齐：chat(input, opts) → { text, usage, raw }
 *   - 输入走 Ark Responses API 风格的 input 数组，内部转成 OpenAI chat/completions messages
 *   - MiniMax M2 系列无法关闭 interleaved thinking，通过 reasoning_split=true 把思考剥到 reasoning_details
 *   - response_format 兼容：调用方传 json_schema 时降级为 json_object（MiniMax 未完整支持 strict schema）
 *   - 网络不稳（socket hang up / 429 / 5xx）走指数退避重试；永久错误（余额不足/鉴权失败）快速失败
 *
 * 2026-04-22 新增：用于 Planner 切 MiniMax，Answer 仍走 Ark。
 */

const https = require('https');
const config = require('../../config');
const logger = require('../utils/logger');

const MINIMAX_HOST = config.MINIMAX_HOST || 'api.minimaxi.com';
const MINIMAX_PATH = '/v1/chat/completions';
const MINIMAX_API_KEY = config.MINIMAX_API_KEY;
const MINIMAX_MODEL = config.MINIMAX_MODEL || 'MiniMax-M2.7-highspeed';
const MINIMAX_TIMEOUT_MS = config.MINIMAX_TIMEOUT_MS || 180000;

/**
 * Ark input 数组 → OpenAI messages
 */
function _arkInputToMessages(input, opts) {
  const messages = [];
  if (opts && opts.instructions) {
    messages.push({ role: 'system', content: String(opts.instructions) });
  }
  for (const item of input || []) {
    const role = item.role || 'user';
    let content = '';
    if (typeof item.content === 'string') {
      content = item.content;
    } else if (Array.isArray(item.content)) {
      content = item.content.map(p => p && p.text ? p.text : '').join('');
    }
    messages.push({ role, content });
  }
  return messages;
}

function _normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const input_tokens = u.prompt_tokens ?? u.input_tokens ?? null;
  const output_tokens = u.completion_tokens ?? u.output_tokens ?? null;
  const total_tokens = u.total_tokens ?? (input_tokens != null && output_tokens != null ? input_tokens + output_tokens : null);
  return { input_tokens, output_tokens, total_tokens, ...u };
}

function _postJson(body, timeoutMs = MINIMAX_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const reqOpts = {
      hostname: MINIMAX_HOST,
      port: 443,
      path: MINIMAX_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MINIMAX_API_KEY}`,
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    const req = https.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode} @ MiniMax: ${raw.slice(0, 500)}`));
        }
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error(`Non-JSON response from MiniMax: ${raw.slice(0, 500)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`MiniMax 请求超时(${timeoutMs}ms)`));
    });
    req.write(bodyStr);
    req.end();
  });
}

async function _requestWithRetry(body, maxRetries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await _postJson(body);
    } catch (e) {
      lastErr = e;
      const msg = e.message || '';
      const permanent = /insufficient[_\s]?balance|TPD rate limit|HTTP 401|HTTP 403|invalid.{0,20}api[_-]?key/i.test(msg);
      if (permanent) {
        logger.warn(`[MiniMax] 永久错误，不重试: ${msg.slice(0, 140)}`);
        break;
      }
      const retriable = /HTTP 5\d\d|HTTP 429|timeout|ETIMEDOUT|ECONNRESET|socket hang up|ENOTFOUND|EPIPE|engine.{0,20}overload/i.test(msg);
      if (attempt < maxRetries && retriable) {
        const isOverload = /engine.{0,20}overload|HTTP 429/i.test(msg);
        const delay = isOverload ? [3000, 8000, 15000][attempt - 1] : 1000 * Math.pow(2, attempt - 1);
        logger.warn(`[MiniMax] attempt ${attempt}/${maxRetries} failed: ${msg.slice(0, 100)} → 等待 ${delay}ms 后重试`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

/**
 * 对齐 llm-client.chat 的接口
 * @param {Array} input - Ark Responses 风格
 * @param {object} opts - { model, temperature, max_output_tokens, textFormat, instructions, parent, generationName }
 * @returns {Promise<{text, usage, raw}>}
 */
async function chat(input, opts = {}) {
  if (!MINIMAX_API_KEY) {
    throw new Error('[MiniMax] 未配置 MINIMAX_API_KEY');
  }

  const model = opts.model || MINIMAX_MODEL;
  const messages = _arkInputToMessages(input, opts);

  // Plan 阶段 reasoning 消耗大，必须给够 max_tokens，否则 content 会被 reasoning 吃光返回空
  let maxTokens = opts.max_output_tokens || 4096;
  if (maxTokens < 4096) maxTokens = 4096;

  const body = {
    model,
    messages,
    temperature: (opts.temperature != null) ? opts.temperature : 0.3,
    max_tokens: maxTokens,
    reasoning_split: true, // 把 thinking 剥到 reasoning_details，content 保持洁净
  };

  if (body.temperature <= 0) body.temperature = 0.01;
  if (body.temperature > 1) body.temperature = 1;

  // response_format 透传：json_schema strict 降级为 json_object（MiniMax 未完整支持 strict schema）
  if (opts.textFormat && opts.textFormat.type) {
    if (opts.textFormat.type === 'json_schema' || opts.textFormat.type === 'json_object') {
      body.response_format = { type: 'json_object' };
    }
  }

  const generation = opts.parent
    ? opts.parent.generation({
        name: opts.generationName || 'minimax-chat',
        model,
        modelParameters: {
          temperature: body.temperature,
          max_output_tokens: maxTokens,
          reasoning_split: true,
          stream: false,
        },
        input,
      })
    : null;

  const startTime = Date.now();
  logger.info(`[MiniMax] 非流式请求: model=${model} inputMsgs=${messages.length}`);

  let raw;
  try {
    raw = await _requestWithRetry(body);
  } catch (e) {
    if (generation) {
      try { generation.end({ level: 'ERROR', statusMessage: e.message }); } catch (_) {}
    }
    throw e;
  }

  const elapsed = Date.now() - startTime;
  logger.info(`[MiniMax] 非流式响应(${model}): ${elapsed}ms`);

  let text = '';
  let finishReason = '';
  if (raw.choices && raw.choices[0]) {
    text = (raw.choices[0].message && raw.choices[0].message.content) || '';
    finishReason = raw.choices[0].finish_reason || '';
  }
  if (finishReason === 'length') {
    logger.warn(`[MiniMax] ⚠️ 输出被 max_tokens 截断（finish_reason=length）model=${model} maxTokens=${maxTokens} outputChars=${text.length}`);
  }
  // 防御性剥离 <think>（reasoning_split=true 生效时不应出现）
  if (text) {
    text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  }

  const usage = _normalizeUsage(raw.usage);
  if (generation) {
    try {
      generation.end({
        output: text,
        usage: usage ? { input: usage.input_tokens, output: usage.output_tokens, total: usage.total_tokens, unit: 'TOKENS' } : undefined,
      });
    } catch (_) {}
  }

  return { text, usage, raw, finishReason };
}

module.exports = { chat };
