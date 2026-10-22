/**
 * Vercel Serverless Function — OAuth 回调
 *
 * 飞书授权完成后重定向到此端点，自动完成：
 * 1. 用授权码兑换 user_access_token
 * 2. 获取用户信息（open_id / name）
 * 3. 将 token 写入飞书多维表格（供本地 Bot 读取）
 * 4. 通过 Bot 给用户发消息通知授权成功
 * 5. 返回"授权成功"页面并自动跳转回飞书
 */

const https = require('https');

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const BITABLE_APP_TOKEN = process.env.BITABLE_APP_TOKEN;
const OAUTH_TOKEN_TABLE_ID = process.env.OAUTH_TOKEN_TABLE_ID;

function feishuRequest(method, apiPath, body, token) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const bodyStr = body ? JSON.stringify(body) : null;
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request({
      hostname: 'open.feishu.cn', port: 443, path: apiPath, method, headers,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve(JSON.parse(raw)); } catch { resolve({ _raw: raw }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('请求超时')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function getTenantToken() {
  const res = await feishuRequest('POST', '/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: APP_ID, app_secret: APP_SECRET,
  });
  if (!res.tenant_access_token) throw new Error(`获取 tenant_token 失败: ${JSON.stringify(res)}`);
  return res.tenant_access_token;
}

async function getAppAccessToken() {
  const res = await feishuRequest('POST', '/open-apis/auth/v3/app_access_token/internal', {
    app_id: APP_ID, app_secret: APP_SECRET,
  });
  if (res.code !== 0) throw new Error(`获取 app_token 失败: ${res.msg}`);
  return res.app_access_token;
}

async function exchangeCode(code, appToken) {
  const res = await feishuRequest('POST', '/open-apis/authen/v1/oidc/access_token', {
    grant_type: 'authorization_code', code,
  }, appToken);
  if (res.code !== 0) throw new Error(`换取 token 失败: code=${res.code} msg=${res.msg}`);
  return res.data;
}

async function getUserInfo(accessToken) {
  const res = await feishuRequest('GET', '/open-apis/authen/v1/user_info', null, accessToken);
  if (res.code === 0 && res.data) return res.data;
  return null;
}

async function writeTokenToBitable(tenantToken, tokenData) {
  const url = `/open-apis/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${OAUTH_TOKEN_TABLE_ID}/records/search`;
  const searchRes = await feishuRequest('POST', url, {
    filter: {
      conjunction: 'and',
      conditions: [{ field_name: 'open_id', operator: 'is', value: [tokenData.open_id] }],
    },
    page_size: 1,
  }, tenantToken);

  const fields = {
    open_id: tokenData.open_id,
    name: tokenData.name || '',
    user_access_token: tokenData.user_access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: tokenData.expires_at,
    refresh_expires_at: tokenData.refresh_expires_at,
    scopes: tokenData.scopes || '',
    updated_at: new Date().toISOString(),
  };

  if (searchRes.code === 0 && searchRes.data?.items?.length > 0) {
    const recordId = searchRes.data.items[0].record_id;
    const updateUrl = `/open-apis/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${OAUTH_TOKEN_TABLE_ID}/records/${recordId}`;
    await feishuRequest('PUT', updateUrl, { fields }, tenantToken);
  } else {
    const createUrl = `/open-apis/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${OAUTH_TOKEN_TABLE_ID}/records`;
    await feishuRequest('POST', createUrl, { fields }, tenantToken);
  }
}

async function notifyUser(tenantToken, openId, userName) {
  const content = JSON.stringify({
    text: `✅ ${userName || ''}，您的授权已完成！现在可以直接发送问题查看日历和妙记数据了。`,
  });
  await feishuRequest('POST', '/open-apis/im/v1/messages?receive_id_type=open_id', {
    receive_id: openId,
    msg_type: 'text',
    content,
  }, tenantToken);
}

function successHtml(userName) {
  const feishuDeepLink = `https://applink.feishu.cn/client/bot_chat?app_id=${APP_ID}`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>授权成功</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{display:flex;justify-content:center;align-items:center;min-height:100vh;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  background:linear-gradient(135deg,#667eea 0%,#764ba2 100%)}
.card{background:#fff;border-radius:20px;padding:48px 40px;text-align:center;
  box-shadow:0 20px 60px rgba(0,0,0,0.15);max-width:420px;width:90%}
.icon{font-size:64px;margin-bottom:20px;animation:pop .5s ease}
@keyframes pop{0%{transform:scale(0)}50%{transform:scale(1.2)}100%{transform:scale(1)}}
h2{color:#1a1a2e;font-size:24px;margin-bottom:8px}
p{color:#666;font-size:15px;line-height:1.6;margin-bottom:24px}
.name{color:#3370ff;font-weight:600}
.btn{display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#3370ff,#2b5cce);
  color:#fff;border-radius:12px;text-decoration:none;font-size:16px;font-weight:500;
  transition:transform .2s,box-shadow .2s}
.btn:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(51,112,255,0.3)}
.hint{margin-top:20px;color:#999;font-size:13px}
</style></head>
<body><div class="card">
  <div class="icon">✅</div>
  <h2>授权成功</h2>
  <p><span class="name">${userName || '用户'}</span> 的权限已获取<br>系统已自动保存授权信息</p>
  <a class="btn" href="${feishuDeepLink}">返回飞书对话</a>
  <p class="hint">3 秒后自动跳转 ...</p>
</div>
<script>setTimeout(()=>location.href="${feishuDeepLink}",3000)</script>
</body></html>`;
}

function errorHtml(message) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>授权失败</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{display:flex;justify-content:center;align-items:center;min-height:100vh;
  font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f5f5f5}
.card{background:#fff;border-radius:16px;padding:48px;text-align:center;
  box-shadow:0 4px 24px rgba(0,0,0,0.08);max-width:400px}
h2{color:#d83b01;margin-bottom:12px} p{color:#666;font-size:14px}
</style></head>
<body><div class="card"><h2>❌ 授权失败</h2><p>${message}</p></div></body></html>`;
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET' && !req.query.code) {
    res.status(200).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>OAuth</title></head>
<body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif">
<p>飞书 OAuth 回调端点</p></body></html>`);
    return;
  }

  const { code, state } = req.query;
  if (!code) {
    res.status(400).send(errorHtml('缺少授权码'));
    return;
  }

  let stateOpenId = null;
  if (state) {
    const m = state.match(/^auth_(ou_[a-f0-9]+)_/);
    if (m) stateOpenId = m[1];
  }

  try {
    const [appToken, tenantToken] = await Promise.all([
      getAppAccessToken(),
      getTenantToken(),
    ]);

    const tokenData = await exchangeCode(code, appToken);

    let openId = stateOpenId;
    let userName = '';
    try {
      const userInfo = await getUserInfo(tokenData.access_token);
      if (userInfo) {
        openId = userInfo.open_id || openId;
        userName = userInfo.name || '';
      }
    } catch (_) {}

    if (!openId) {
      res.status(400).send(errorHtml('无法获取用户身份'));
      return;
    }

    const record = {
      open_id: openId,
      name: userName,
      user_access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: Date.now() + (tokenData.expires_in || 7200) * 1000,
      refresh_expires_at: Date.now() + (tokenData.refresh_expires_in || 2592000) * 1000,
      scopes: tokenData.scope || '',
    };

    await writeTokenToBitable(tenantToken, record);

    notifyUser(tenantToken, openId, userName).catch(() => {});

    res.status(200).send(successHtml(userName));
  } catch (e) {
    console.error('[OAuth Error]', e);
    res.status(500).send(errorHtml(e.message || '服务器内部错误'));
  }
};
