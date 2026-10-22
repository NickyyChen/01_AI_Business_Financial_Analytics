/**
 * test-message-handler-smoke.js
 *
 * 目的：验证 Feishu 私聊文本消息进入 message-handler 后，
 * 会命中流式 pipeline 主链路，并完成会话历史写入与流式卡片收尾。
 *
 * 运行: node tests/test-message-handler-smoke.js
 */

const assert = require('assert');
const { createFeishuMessageHandler } = require('../src/app/feishu/message-handler');

async function main() {
  const sent = { replies: [], cardCreates: [], cardUpdates: [], cardSettings: [] };
  const history = [];
  const qaRecords = [];
  let streamCalled = 0;
  let groupChatAdds = 0;

  const handler = createFeishuMessageHandler({
    sdkClient: {
      im: {
        message: {
          reply: async (payload) => {
            sent.replies.push(payload);
            return { data: { message_id: 'reply_msg_1' } };
          },
          create: async () => ({ data: { message_id: 'create_msg_1' } }),
          delete: async () => ({ data: {} }),
          patch: async () => ({ data: {} }),
        },
      },
      cardkit: {
        v1: {
          card: {
            create: async () => {
              sent.cardCreates.push(true);
              return { data: { card_id: 'card_1' } };
            },
            settings: async (payload) => {
              sent.cardSettings.push(payload);
              return { data: {} };
            },
          },
          cardElement: {
            content: async (payload) => {
              sent.cardUpdates.push(payload);
              return { data: {} };
            },
          },
        },
      },
      contact: {
        user: {
          get: async () => ({ data: { user: { name: '测试用户' } } }),
        },
      },
    },
    config: {
      TABLES: { EMPLOYEE: 'tbl_employee' },
      INSIGHT_RECEIVER_OPEN_ID: 'ou_admin',
      REDIRECT_URI: 'https://example.com/oauth',
      OAUTH_SCOPES: 'offline_access',
      APP_ID: 'app_test',
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    pipeline: {
      handleRequestStream: async (_payload, onChunk) => {
        streamCalled++;
        await onChunk('chunk-1');
        await onChunk('chunk-2');
        return {
          reply: 'main-chain smoke ok',
          toolResults: { results: {} },
          _planResult: { ok: true },
          _memoryTrace: {
            attemptedTables: ['projectMaster'],
            rowCounts: { projectMaster: 3 },
            fetchErrors: [],
            cache: { hit: false, missing: [] },
          },
          error: null,
        };
      },
      handleRequest: async () => {
        throw new Error('should not fallback to non-stream pipeline');
      },
    },
    requestAdapter: { handleRequest: async () => ({ reply: 'unused' }) },
    qaLogger: { record(entry) { qaRecords.push(entry); } },
    client: {
      listRecords: async (tableId, opts) => {
        assert.strictEqual(tableId, 'tbl_employee');
        assert.ok(opts.filter.includes('ou_test_user'));
        return [{
          fields: {
            '姓名': '测试用户',
            '角色类型': '员工',
            '标准部门': '测试部门',
            '可见范围': 'self',
            '可见项目范围': '',
          },
        }];
      },
      downloadMessageImage: async () => 'data:image/png;base64,aaa',
    },
    tokenStore: {
      getRawToken() { return null; },
      getUserAccessToken: async () => null,
    },
    calendarService: { queryUserCalendar: async () => ({ success: true, text: '', eventCount: 0 }) },
    minutesService: { queryUserMinutes: async () => ({ success: true, text: '', minutesCount: 0 }) },
    workReportService: { detectReportType: () => null, _isFinanceBusinessQuery: () => false },
    conversationStore: {
      getHistory: (openId) => history.filter(x => x.openId === openId).map(x => ({ role: x.role, content: x.content })),
      addUserMessage: (openId, content) => history.push({ openId, role: 'user', content }),
      addAssistantMessage: (openId, content) => history.push({ openId, role: 'assistant', content }),
      clearHistory() {},
      setUserName() {},
    },
    groupChatCollector: { addMessage() { groupChatAdds++; } },
    logReplyContent() {},
    getBotOpenId: () => 'ou_bot',
  });

  await handler.handleMessage({
    message: {
      message_id: 'om_group_mention_1',
      chat_id: 'oc_group_1',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 x smoke y' }),
      mentions: [{ id: { open_id: 'ou_bot' } }],
    },
    sender: { sender_id: { open_id: 'ou_test_user' } },
    event_id: 'evt_group_1',
  });

  assert.strictEqual(streamCalled, 0, '群聊 @ 消息不应进入流式 pipeline');
  assert.strictEqual(history.length, 0, '群聊消息不应写入会话历史');
  assert.strictEqual(sent.replies.length, 0, '群聊消息不应回复');
  assert.strictEqual(groupChatAdds, 0, '群聊消息不应进入群聊收集器');

  await handler.handleMessage({
    message: {
      message_id: 'om_msg_1',
      chat_id: 'oc_chat_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'x smoke y' }),
    },
    sender: { sender_id: { open_id: 'ou_test_user' } },
    event_id: 'evt_1',
  });

  assert.strictEqual(streamCalled, 1, '应命中流式 pipeline 主链路 1 次');
  assert.strictEqual(history.length, 2, '应写入 2 条会话历史');
  assert.strictEqual(history[0].role, 'user', '第一条历史应为用户消息');
  assert.ok(String(history[0].content).includes('smoke'), '用户消息应保留原始问题');
  assert.strictEqual(history[1].role, 'assistant', '第二条历史应为助手回复');
  assert.strictEqual(history[1].content, 'main-chain smoke ok', '助手回复应写入会话历史');
  assert.strictEqual(qaRecords.length, 1, '应记录 1 条 QA trace');
  assert.deepStrictEqual(qaRecords[0].memoryTrace && qaRecords[0].memoryTrace.attemptedTables, ['projectMaster'], 'memoryTrace 应透传到 qaLogger');
  assert.strictEqual(sent.cardCreates.length, 1, '应创建 1 个流式卡片实体');
  assert.ok(sent.cardUpdates.length >= 1, '应至少更新 1 次卡片内容');
  assert.strictEqual(sent.cardSettings.length, 1, '应完成 1 次流式卡片收尾');

  console.log('message-handler smoke ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
