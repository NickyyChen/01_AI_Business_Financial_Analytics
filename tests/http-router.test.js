const { EventEmitter } = require('events');
const { createHttpHandler } = require('../src/app/http/router');

function createRequest({ method = 'GET', url = '/', body, rawBody, error, headers = {} }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;

  process.nextTick(() => {
    if (error) {
      req.emit('error', error);
      return;
    }

    if (rawBody !== undefined) {
      req.emit('data', Buffer.from(rawBody));
    } else if (body !== undefined) {
      req.emit('data', Buffer.from(JSON.stringify(body)));
    }
    req.emit('end');
  });

  return req;
}

function createResponse() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    ended: false,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk = '') {
      this.body += chunk;
      this.ended = true;
    },
  };
}

function buildDeps(overrides = {}) {
  const base = {
    port: 3999,
    config: {
      APP_ID: 'cli_a1b2c3',
      ENCRYPT_KEY: '',
      VERIFICATION_TOKEN: 'verify-token',
    },
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    },
    tokenStore: {
      exchangeCodeForToken: jest.fn(),
    },
    conversationStore: {
      getStats: jest.fn(() => ({ total: 3 })),
    },
    requestAdapter: {
      handleRequest: jest.fn(),
    },
    logReplyContent: jest.fn(),
    pendingAuthRequests: new Map(),
    queryAndSendResult: jest.fn(async () => {}),
  };

  return { ...base, ...overrides };
}

describe('http router', () => {
  test('GET /api/health 返回健康状态和会话统计', async () => {
    const deps = buildDeps();
    const { handleHttpRequest } = createHttpHandler(deps);
    const req = createRequest({ method: 'GET', url: '/api/health' });
    const res = createResponse();

    await handleHttpRequest(req, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      status: 'ok',
      version: '2.0.0',
      conversations: { total: 3 },
    });
  });

  test('POST /api/chat 委托 requestAdapter，并保持返回结构', async () => {
    const deps = buildDeps();
    deps.requestAdapter.handleRequest.mockResolvedValue({
      reply: '链路正常',
      usage: { total_tokens: 12 },
      memory_update: null,
    });
    const { handleHttpRequest } = createHttpHandler(deps);
    const req = createRequest({
      method: 'POST',
      url: '/api/chat',
      body: {
        user_id: 'u_1',
        message: '帮我看一下',
        role: 'CEO',
        context: { source: 'test' },
      },
    });
    const res = createResponse();

    await handleHttpRequest(req, res);

    expect(deps.requestAdapter.handleRequest).toHaveBeenCalledWith({
      user_id: 'u_1',
      userName: 'u_1',
      message: '帮我看一下',
      role: 'CEO',
      context: { source: 'test' },
      conversationHistory: [],
      plannerConversationHistory: [],
      planningContext: [],
    });
    expect(deps.logReplyContent).toHaveBeenCalledWith('API:chat', '链路正常');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      reply: '链路正常',
      usage: { total_tokens: 12 },
      memory_update: null,
    });
  });

  test('GET /api/oauth/callback 成功后触发授权后自动查询', async () => {
    const deps = buildDeps();
    deps.pendingAuthRequests.set('ou_abcdef12', { content: '看我的日历' });
    deps.tokenStore.exchangeCodeForToken.mockResolvedValue({
      success: true,
      openId: 'ou_abcdef12',
      name: '测试用户',
    });
    const { handleHttpRequest } = createHttpHandler(deps);
    const req = createRequest({
      method: 'GET',
      url: '/api/oauth/callback?code=test-code&state=auth_ou_abcdef12_calendar_nonce',
    });
    const res = createResponse();

    await handleHttpRequest(req, res);
    await new Promise((resolve) => setImmediate(resolve));

    expect(deps.tokenStore.exchangeCodeForToken).toHaveBeenCalledWith('test-code', 'ou_abcdef12');
    expect(deps.queryAndSendResult).toHaveBeenCalledWith('ou_abcdef12', 'calendar', '日历');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('授权成功');
    expect(res.body).toContain('测试用户');
  });

  test('POST /api/webhook 在 url_verification 时返回 challenge', async () => {
    const deps = buildDeps();
    const { handleHttpRequest } = createHttpHandler(deps);
    const req = createRequest({
      method: 'POST',
      url: '/api/webhook',
      body: { type: 'url_verification', challenge: 'abc123' },
    });
    const res = createResponse();

    await handleHttpRequest(req, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ challenge: 'abc123' });
  });

  test('admin 接口同时接受新旧管理 token，避免覆盖旧入口', async () => {
    const deps = buildDeps({
      config: {
        APP_ID: 'cli_a1b2c3',
        ENCRYPT_KEY: '',
        VERIFICATION_TOKEN: 'verify-token',
        SCHEDULED_PUSH_ADMIN_TOKEN: 'new-token',
        HEALTHCHECK_BATCH_ADMIN_TOKEN: 'old-token',
      },
    });
    const { handleHttpRequest } = createHttpHandler(deps);
    const req = createRequest({
      method: 'GET',
      url: '/api/admin/scheduled-push/status?id=missing',
      headers: { authorization: 'Bearer old-token' },
    });
    const res = createResponse();

    await handleHttpRequest(req, res);

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'job not found' });
  });
});
