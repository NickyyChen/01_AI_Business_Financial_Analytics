/**
 * feishu-card-stream.js - 飞书 CardKit 流式卡片封装
 *
 * 通过 CardKit API 实现打字机效果：
 *   1. 创建卡片实体（streaming_mode=true）
 *   2. 发送卡片消息
 *   3. 流式更新 markdown 文本（自动打字机渲染）
 *   4. 结束后关闭流式模式
 *
 * 飞书文档: https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

function uuidv4() {
  return crypto.randomUUID();
}

const ELEMENT_ID = 'streaming_md';

/**
 * 2026-04-23 MiniMax 顽固使用 `##`/`###` markdown 标题导致飞书卡片字号不一。
 * Prompt 硬约束也无法 100% 约束，于是在渲染层做 sanitize：
 * 把行首 `#{1,6}` 标题剥成 `**加粗**`，保证卡片全文字号统一。
 */
function _sanitizeMarkdownHeadings(text) {
  if (!text) return text;
  return text.replace(/^[ \t]*(#{1,6})[ \t]+(.+?)[ \t]*$/gm, (_m, _h, rest) => {
    const trimmed = rest.trim();
    if (!trimmed) return '';
    if (/^\*\*[\s\S]+\*\*$/.test(trimmed)) return trimmed;
    return `**${trimmed}**`;
  });
}

function _buildCardJSON(title = '正在分析中...') {
  return {
    schema: '2.0',
    header: {
      title: { content: title, tag: 'plain_text' },
    },
    config: {
      streaming_mode: true,
      summary: { content: '[生成中...]' },
      streaming_config: {
        print_frequency_ms: { default: 50 },
        print_step: { default: 2 },
        print_strategy: 'fast',
      },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: '',
          element_id: ELEMENT_ID,
        },
      ],
    },
  };
}

/**
 * 创建流式卡片会话
 * @param {object} sdkClient - 飞书 SDK 客户端
 * @param {object} opts - { messageId, openId, chatId, title }
 * @returns {object} StreamSession { cardId, messageId, update, finish }
 */
async function createStreamSession(sdkClient, opts = {}) {
  const { messageId, openId, chatId, title } = opts;
  const finishTitle = opts.finishTitle || '✅ 回复完成';
  const finishTemplate = opts.finishTemplate || 'green';

  // Step 1: 创建卡片实体
  const cardJSON = _buildCardJSON(title);
  let cardId;
  try {
    const createRes = await sdkClient.cardkit.v1.card.create({
      data: {
        type: 'card_json',
        data: JSON.stringify(cardJSON),
      },
    });
    cardId = createRes?.data?.card_id || createRes?.card_id;
    if (!cardId) throw new Error('cardkit.create 未返回 card_id');
    logger.info(`[CardStream] 卡片实体创建成功: ${cardId}`);
  } catch (e) {
    logger.warn(`[CardStream] 创建卡片实体失败: ${e.message}，降级为普通消息`);
    return null;
  }

  // Step 2: 发送卡片消息
  const content = JSON.stringify({ type: 'card', data: { card_id: cardId } });
  let sentMsgId;
  try {
    if (messageId) {
      const res = await sdkClient.im.message.reply({
        path: { message_id: messageId },
        data: { content, msg_type: 'interactive' },
      });
      sentMsgId = res?.data?.message_id;
    } else if (openId) {
      const res = await sdkClient.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: { receive_id: openId, msg_type: 'interactive', content },
      });
      sentMsgId = res?.data?.message_id;
    } else if (chatId) {
      const res = await sdkClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'interactive', content },
      });
      sentMsgId = res?.data?.message_id;
    }
    logger.info(`[CardStream] 流式卡片消息已发送: msg=${sentMsgId}`);
  } catch (e) {
    logger.warn(`[CardStream] 发送流式卡片失败: ${e.message}`);
    return null;
  }

  let seq = 1;
  let fullText = '';
  let lastUpdateTime = 0;
  const MIN_INTERVAL = 100;

  return {
    cardId,
    messageId: sentMsgId,

    /**
     * 追加文本（增量），CardKit 自动计算打字机效果
     */
    async update(chunk) {
      fullText += chunk;
      const now = Date.now();
      if (now - lastUpdateTime < MIN_INTERVAL) return;
      lastUpdateTime = now;

      try {
        await sdkClient.cardkit.v1.cardElement.content({
          path: { card_id: cardId, element_id: ELEMENT_ID },
          data: {
            content: _sanitizeMarkdownHeadings(fullText),
            uuid: uuidv4(),
            sequence: seq++,
          },
        });
      } catch (e) {
        logger.warn(`[CardStream] 流式更新失败: ${e.message}`);
      }
    },

    /**
     * 最终一次性写入完整文本并关闭流式模式，然后替换为静态卡片
     */
    async finish(finalText) {
      if (finalText) fullText = finalText;
      const displayText = _sanitizeMarkdownHeadings(fullText);

      if (displayText && displayText.trim()) {
        try {
          await sdkClient.cardkit.v1.cardElement.content({
            path: { card_id: cardId, element_id: ELEMENT_ID },
            data: {
              content: displayText,
              uuid: uuidv4(),
              sequence: seq++,
            },
          });
        } catch (e) {
          logger.warn(`[CardStream] 最终文本更新失败: ${e.message}`);
        }
      } else {
        logger.warn(`[CardStream] 最终文本为空，跳过 content 更新，写入兜底提示`);
        fullText = '⚠️ 抱歉，本次回复生成异常，请重新提问试试。';
        try {
          await sdkClient.cardkit.v1.cardElement.content({
            path: { card_id: cardId, element_id: ELEMENT_ID },
            data: {
              content: fullText,
              uuid: uuidv4(),
              sequence: seq++,
            },
          });
        } catch (_) { /* best effort */ }
      }

      // 关闭流式模式 + 更新 header（去掉 "正在分析中..."）
      try {
        await sdkClient.cardkit.v1.card.settings({
          path: { card_id: cardId },
          data: {
            settings: JSON.stringify({
              config: {
                streaming_mode: false,
                summary: { content: displayText.slice(0, 80) },
              },
              header: {
                title: { content: finishTitle, tag: 'plain_text' },
                template: finishTemplate,
              },
            }),
            uuid: uuidv4(),
            sequence: seq++,
          },
        });
        logger.info(`[CardStream] 流式模式已关闭 + header 已更新 | 最终文本=${fullText.length}字`);
      } catch (e) {
        logger.warn(`[CardStream] settings 更新失败: ${e.message}，尝试仅关闭流式模式`);
        try {
          await sdkClient.cardkit.v1.card.settings({
            path: { card_id: cardId },
            data: {
              settings: JSON.stringify({ config: { streaming_mode: false } }),
              uuid: uuidv4(),
              sequence: seq++,
            },
          });
          logger.info(`[CardStream] 流式模式已关闭（header 保持不变）| 最终文本=${fullText.length}字`);
        } catch (e2) {
          logger.warn(`[CardStream] 关闭流式模式也失败: ${e2.message}`);
        }
      }
    },

    getFullText() { return fullText; },
  };
}

module.exports = { createStreamSession };
