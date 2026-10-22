'use strict';

const fs = require('fs');
const path = require('path');
const lark = require('@larksuiteoapi/node-sdk');
const config = require('../../../config');
const client = require('../../clients/feishu-client');
const cardStream = require('../../clients/feishu-card-stream');
const localMemoryStore = require('../../cache/local-memory-store');
const localCacheSyncer = require('../../cache/local-cache-syncer');

const TARGET_CHAT_NAME = '组织 Agent 沟通';
const sdkClient = new lark.Client({
  appId: config.APP_ID,
  appSecret: config.APP_SECRET,
});

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '');
}

function maskId(id, head = 6, tail = 6) {
  if (!id || id.length < head + tail + 2) return id || '';
  return `${id.slice(0, head)}...${id.slice(-tail)}`;
}

function ensureLogDir(task) {
  const dir = path.resolve(__dirname, '..', '..', '..', 'logs', 'scheduled-push', task);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function appendJsonl(task, batchId, row) {
  const file = path.join(ensureLogDir(task), `${batchId}.jsonl`);
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
  return file;
}

async function ensureActualCacheReady(reason = 'scheduled-push') {
  if (!config.LOCAL_MEMORY_CACHE_ENABLED) {
    throw new Error('LOCAL_MEMORY_CACHE_ENABLED 未开启，不能执行定时推送实际链路');
  }
  if (config.LOCAL_MEMORY_CACHE_REMOTE_FALLBACK) {
    throw new Error('LOCAL_MEMORY_CACHE_REMOTE_FALLBACK 已开启，验收期不允许核心表远端回退');
  }
  if (!localMemoryStore.isReady()) {
    await localCacheSyncer.bootstrap({ reason });
  }
  const status = localMemoryStore.getStatus();
  if (!status.ready) throw new Error('activeCache 未就绪，停止定时推送');
  const errors = Array.isArray(status.syncErrors) ? status.syncErrors : [];
  const blocking = errors.filter(item => item.priority === 'P0' || item.required);
  if (blocking.length > 0) {
    throw new Error(`activeCache 存在核心表同步错误: ${blocking.map(e => `${e.tableKey}:${e.error}`).join('；')}`);
  }
  return status;
}

function isGroupChat(chat) {
  if (!chat) return false;
  if (chat.chat_mode === 'p2p') return false;
  if (chat.chat_mode === 'group') return true;
  return String(chat.chat_id || '').startsWith('oc_');
}

async function listBotChats() {
  const chats = [];
  let pageToken = '';
  do {
    let url = '/open-apis/im/v1/chats?page_size=50';
    if (pageToken) url += `&page_token=${pageToken}`;
    const res = await client.get(url);
    if (res.code !== 0) {
      throw new Error(`列出机器人所在群失败: code=${res.code} msg=${res.msg}`);
    }
    chats.push(...((res.data && res.data.items) || []));
    pageToken = res.data && res.data.has_more ? res.data.page_token : '';
  } while (pageToken);
  return chats;
}

async function resolveTargetChat(chatName = TARGET_CHAT_NAME) {
  const groups = (await listBotChats()).filter(isGroupChat);
  const target = normalizeName(chatName);
  const matches = groups.filter(chat => normalizeName(chat.name || chat.description || '') === target);
  if (matches.length !== 1) {
    const candidates = groups.map(chat => `${chat.name || chat.description || '(无名群)'}(${chat.chat_id})`).join('；');
    throw new Error(`无法唯一确定目标群「${chatName}」，匹配数=${matches.length}。机器人所在群: ${candidates}`);
  }
  const name = matches[0].name || matches[0].description || matches[0].chat_id;
  if (normalizeName(name).includes(normalizeName('组织部-Agent'))) {
    throw new Error(`命中禁止群「${name}」，停止推送`);
  }
  return { chatId: matches[0].chat_id, chatName: name };
}

async function sendCardkitMarkdown(target, markdown, title, template = 'blue') {
  const opts = {
    title,
    finishTitle: title,
    finishTemplate: template,
  };
  if (target.chatId) opts.chatId = target.chatId;
  if (target.openId) opts.openId = target.openId;
  const session = await cardStream.createStreamSession(sdkClient, opts);
  if (!session) throw new Error('CardKit 卡片创建或发送失败');
  await session.finish(markdown);
  return session;
}

module.exports = {
  TARGET_CHAT_NAME,
  maskId,
  ensureLogDir,
  appendJsonl,
  ensureActualCacheReady,
  resolveTargetChat,
  sendCardkitMarkdown,
};
