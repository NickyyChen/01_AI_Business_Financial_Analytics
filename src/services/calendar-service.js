/**
 * calendar-service.js - 实时日历查询服务
 *
 * 用 user_access_token 按需拉取指定用户的日历事件
 * 不写入 Bitable，直接返回格式化结果给 Agent
 */

const tokenStore = require('../stores/user-token-store');
const logger = require('../utils/logger');

const API_DELAY_MS = 80;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ==================== 日历 API ====================

/**
 * 获取用户主日历 ID
 */
async function getPrimaryCalendarId(userToken) {
  let pageToken = '';
  const calendars = [];

  do {
    let url = '/open-apis/calendar/v4/calendars?page_size=50';
    if (pageToken) url += `&page_token=${pageToken}`;
    const res = await tokenStore.httpGetWithToken(url, userToken);
    if (res.code !== 0) {
      throw new Error(`获取日历列表失败: code=${res.code} msg=${res.msg}`);
    }
    const items = (res.data && res.data.calendar_list) || [];
    calendars.push(...items);
    pageToken = (res.data && res.data.page_token) || '';
    if (!(res.data && res.data.has_more)) break;
  } while (pageToken);

  // 查找主日历
  let primary = calendars.find(c => c.type === 'primary');
  if (!primary) primary = calendars.find(c => c.role === 'owner');
  if (!primary && calendars.length > 0) primary = calendars[0];

  return primary ? primary.calendar_id : null;
}

/**
 * 获取指定日历的事件列表
 */
async function fetchEvents(userToken, calendarId, daysBack) {
  const now = new Date();
  const start = new Date(now.getTime() - daysBack * 24 * 3600 * 1000);
  const startSec = Math.floor(start.getTime() / 1000);
  const endSec = Math.floor(now.getTime() / 1000);

  const events = [];
  let pageToken = '';

  do {
    let url = `/open-apis/calendar/v4/calendars/${calendarId}/events?start_time=${startSec}&end_time=${endSec}&page_size=50`;
    if (pageToken) url += `&page_token=${pageToken}`;

    const res = await tokenStore.httpGetWithToken(url, userToken);
    if (res.code !== 0) {
      logger.error(`[CalendarService] 获取事件失败: code=${res.code} msg=${res.msg}`);
      break;
    }
    const items = (res.data && res.data.items) || [];
    events.push(...items);
    pageToken = (res.data && res.data.page_token) || '';
    if (!(res.data && res.data.has_more)) break;
    await sleep(API_DELAY_MS);
  } while (pageToken);

  // 过滤已取消的
  return events.filter(e => {
    const s = (e.status || '').toLowerCase();
    return s !== 'cancelled' && s !== 'cancel';
  });
}

/**
 * 获取事件参与人
 */
async function getAttendees(userToken, calendarId, eventId) {
  try {
    const res = await tokenStore.httpGetWithToken(
      `/open-apis/calendar/v4/calendars/${calendarId}/events/${eventId}/attendees?page_size=50`,
      userToken
    );
    if (res.code === 0 && res.data && res.data.items) {
      return res.data.items;
    }
    return [];
  } catch {
    return [];
  }
}

// ==================== 格式化 ====================

function parseEventTime(timeObj) {
  if (!timeObj) return null;
  if (timeObj.timestamp) return parseInt(timeObj.timestamp) * 1000;
  if (timeObj.date) return Date.parse(timeObj.date + 'T00:00:00+08:00');
  return null;
}

function inferEventType(event) {
  const summary = (event.summary || '').toLowerCase();
  if (event.meeting_settings || summary.includes('会议') || summary.includes('meeting')) return '会议';
  if (summary.includes('出差') || summary.includes('外出') || summary.includes('拜访')) return '外出';
  if (summary.includes('请假') || summary.includes('休假') || summary.includes('年假')) return '请假';
  if (summary.includes('面试') || summary.includes('interview')) return '面试';
  if (summary.includes('培训') || summary.includes('分享')) return '培训';
  return '其他';
}

/**
 * 将事件列表格式化为 LLM 可读文本
 */
function formatEventsForLLM(events, attendeesMap) {
  if (!events.length) return '暂无近期日程。';

  const lines = [`【日程事件】共 ${events.length} 条\n`];

  for (const evt of events.slice(0, 15)) {
    const startMs = parseEventTime(evt.start_time);
    const endMs = parseEventTime(evt.end_time);
    const startStr = startMs ? new Date(startMs).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';
    const endStr = endMs ? new Date(endMs).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';
    const duration = (startMs && endMs) ? Math.round((endMs - startMs) / 60000) : 0;
    const type = inferEventType(evt);
    const allDay = !!(evt.start_time && evt.start_time.date && !evt.start_time.timestamp);

    let line = `- ${evt.summary || '(无主题)'}`;
    if (allDay) {
      line += ` | 全天 | ${startStr.split(' ')[0] || ''}`;
    } else {
      line += ` | ${startStr} ~ ${endStr} | ${duration}分钟`;
    }
    line += ` | 类型:${type}`;

    // 参与人
    const attendees = attendeesMap[evt.event_id] || [];
    if (attendees.length > 0) {
      const names = attendees.map(a => a.display_name || '').filter(Boolean).slice(0, 5);
      if (names.length > 0) {
        line += ` | 参与人:${names.join(',')}`;
        if (attendees.length > 5) line += `等${attendees.length}人`;
      }
    }

    // 描述
    if (evt.description && evt.description.length > 0) {
      const desc = evt.description.replace(/<[^>]+>/g, '').trim().slice(0, 100);
      if (desc) line += `\n  描述: ${desc}`;
    }

    lines.push(line);
  }

  if (events.length > 15) {
    lines.push(`\n... 还有 ${events.length - 15} 条日程未列出`);
  }

  return lines.join('\n');
}

// ==================== 主入口 ====================

/**
 * 实时查询用户日历并返回格式化文本
 * @param {string} openId - 用户 open_id
 * @param {number} [daysBack=7] - 查询天数
 * @returns {object} { success, text, eventCount } 或 { success: false, needAuth: true }
 */
async function queryUserCalendar(openId, daysBack = 7) {
  // 1. 获取用户 token
  const userToken = await tokenStore.getUserAccessToken(openId);
  if (!userToken) {
    return { success: false, needAuth: true, text: '' };
  }

  try {
    // 2. 获取主日历
    const calendarId = await getPrimaryCalendarId(userToken);
    if (!calendarId) {
      return { success: false, needAuth: false, text: '未找到您的日历，请确认日历权限已开启。' };
    }

    // 3. 获取事件
    const events = await fetchEvents(userToken, calendarId, daysBack);
    logger.info(`[CalendarService] ${openId} 日历查询: ${events.length} 条事件 (${daysBack}天)`);

    // 4. 获取参与人（前 15 条）
    const attendeesMap = {};
    for (const evt of events.slice(0, 15)) {
      const calId = evt.organizer_calendar_id || calendarId;
      attendeesMap[evt.event_id] = await getAttendees(userToken, calId, evt.event_id);
      await sleep(API_DELAY_MS);
    }

    // 5. 格式化
    const text = formatEventsForLLM(events, attendeesMap);
    return { success: true, text, eventCount: events.length };
  } catch (e) {
    logger.error(`[CalendarService] 查询失败: ${e.message}`);
    // token 可能失效
    if (e.message.includes('token') || e.message.includes('99991668') || e.message.includes('99991663')) {
      return { success: false, needAuth: true, text: '' };
    }
    return { success: false, needAuth: false, text: `日历查询出错：${e.message}` };
  }
}

module.exports = {
  queryUserCalendar,
  formatEventsForLLM,
};
