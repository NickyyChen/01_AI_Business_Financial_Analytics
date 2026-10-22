/**
 * minutes-service.js - 会议纪要/妙记查询服务
 *
 * 飞书妙记 API 没有列表接口（需要先知道 minute_token），
 * 因此本服务通过两个途径获取会议数据：
 *   1. Bitable MEETING_SNAPSHOT 表（定时同步/历史数据）
 *   2. 日历事件中的会议记录（通过 calendar API 推导）
 *
 * 如果知道具体的 minute_token，也支持调用妙记 API 获取详情
 */

const tokenStore = require('../stores/user-token-store');
const config = require('../../config');
const client = require('../clients/feishu-client');
const logger = require('../utils/logger');

const API_DELAY_MS = 100;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ==================== 从 Bitable 获取会议记录 ====================

/**
 * 从 MEETING_SNAPSHOT 表查询用户的会议记录
 */
async function fetchMeetingsFromBitable(userId) {
  try {
    const filter = `OR(CurrentValue.[员工ID]="${userId}",CurrentValue.[姓名]="${userId}")`;
    const records = await client.listRecords(config.TABLES.MEETING_SNAPSHOT, { filter });
    if (records.length > 0) return records;

    // 回退：加载全部
    return await client.listRecords(config.TABLES.MEETING_SNAPSHOT, { page_size: 50 });
  } catch (e) {
    logger.warn(`[MinutesService] Bitable 查询失败: ${e.message}`);
    return [];
  }
}

// ==================== 妙记详情 API（需要 minute_token）====================

/**
 * 获取单条妙记的元数据
 */
async function fetchMinuteDetail(userToken, minuteToken) {
  try {
    const res = await tokenStore.httpGetWithToken(
      `/open-apis/minutes/v1/minutes/${minuteToken}`,
      userToken
    );
    if (res.code === 0 && res.data) {
      return res.data.minute || res.data;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 获取妙记的 AI 产物（摘要、待办、章节）
 */
async function fetchMinuteArtifacts(userToken, minuteToken) {
  try {
    const res = await tokenStore.httpGetWithToken(
      `/open-apis/minutes/v1/minutes/${minuteToken}/artifacts`,
      userToken
    );
    if (res.code === 0 && res.data) {
      return res.data;
    }
    return null;
  } catch {
    return null;
  }
}

// ==================== 格式化 ====================

/**
 * 格式化 Bitable 会议记录为 LLM 可读文本
 */
function formatMeetingsForLLM(records) {
  if (!records.length) return '暂无会议纪要/妙记记录。';

  const lines = [`【会议纪要/妙记】共 ${records.length} 条\n`];

  for (const r of records.slice(0, 15)) {
    const f = r.fields || {};
    const time = f['会议时间'] ? new Date(f['会议时间']).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';
    const duration = f['会议时长（分钟）'] || 0;

    let line = `- ${f['会议主题'] || '(无主题)'}`;
    if (time) line += ` | ${time}`;
    if (duration) line += ` | ${duration}分钟`;
    if (f['参与人']) line += ` | 参与人:${f['参与人']}`;

    if (f['AI摘要'] && f['AI摘要'] !== '(待获取)') {
      line += `\n  摘要: ${String(f['AI摘要']).slice(0, 300)}`;
    }
    if (f['关键决策']) {
      line += `\n  决策: ${String(f['关键决策']).slice(0, 200)}`;
    }
    if (f['待办事项']) {
      line += `\n  待办: ${String(f['待办事项']).slice(0, 200)}`;
    }

    lines.push(line);
  }

  if (records.length > 15) {
    lines.push(`\n... 还有 ${records.length - 15} 条未列出`);
  }

  return lines.join('\n');
}

// ==================== 主入口 ====================

/**
 * 查询用户的会议纪要/妙记
 * @param {string} openId - 用户 open_id
 * @param {number} [daysBack=30] - 查询天数
 * @returns {object} { success, text, minutesCount }
 */
async function queryUserMinutes(openId, daysBack = 30) {
  // 1. 先从 Bitable 获取已有的会议记录
  // 需要先解析用户名（用于 Bitable 查询）
  let userName = openId;
  const tokenData = tokenStore.getRawToken(openId);
  if (tokenData && tokenData.name) {
    userName = tokenData.name;
  }

  const records = await fetchMeetingsFromBitable(userName);

  // 2. 按时间过滤
  const cutoff = Date.now() - daysBack * 24 * 3600 * 1000;
  const filtered = records.filter(r => {
    const f = r.fields || {};
    const time = f['会议时间'];
    if (!time) return true; // 无时间的保留
    return time >= cutoff;
  });

  logger.info(`[MinutesService] ${userName} 会议查询: ${filtered.length}/${records.length} 条 (${daysBack}天)`);

  if (filtered.length === 0) {
    // 检查是否有 user_token，提示可能需要先同步
    const userToken = await tokenStore.getUserAccessToken(openId);
    if (!userToken) {
      return { success: false, needAuth: true, text: '' };
    }
    return { success: true, text: '暂无近期会议纪要记录。定时同步会自动采集新数据。', minutesCount: 0 };
  }

  // 3. 格式化
  const text = formatMeetingsForLLM(filtered);
  return { success: true, text, minutesCount: filtered.length };
}

module.exports = {
  queryUserMinutes,
  fetchMinuteDetail,
  fetchMinuteArtifacts,
  formatMeetingsForLLM,
};
