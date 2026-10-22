'use strict';

const TZ = 'Asia/Shanghai';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function asDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const text = String(value).trim();
  if (!text) return null;
  const m = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

function monthContext(periodMonth, now = new Date()) {
  let year;
  let month;
  const text = String(periodMonth || '').trim();
  const m = text.match(/^(\d{4})-(\d{1,2})$/);
  if (m) {
    year = Number(m[1]);
    month = Number(m[2]);
  } else {
    year = now.getFullYear();
    month = now.getMonth() + 1;
  }
  if (!year || month < 1 || month > 12) {
    throw new Error(`非法 periodMonth: ${periodMonth}`);
  }
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const end = new Date(year, month, 0, 23, 59, 59, 999);
  const ym = (year % 100) * 100 + month;
  return {
    year,
    month,
    ym,
    label: `${year}-${pad2(month)}`,
    zhLabel: `${year}年${month}月`,
    start,
    end,
    startTs: start.getTime(),
    endTs: end.getTime(),
  };
}

function isInMonth(value, ctx) {
  const d = asDate(value);
  if (!d) return false;
  const ts = d.getTime();
  return ts >= ctx.startTs && ts <= ctx.endTs;
}

function formatYmd(value) {
  const d = asDate(value);
  if (!d) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function isWeekday(date) {
  const day = date.getDay();
  return day !== 0 && day !== 6;
}

function thirdBusinessDay(year, month) {
  let count = 0;
  for (let day = 1; day <= 10; day++) {
    const d = new Date(year, month - 1, day);
    if (!isWeekday(d)) continue;
    count += 1;
    if (count === 3) return d;
  }
  throw new Error(`无法计算第三个工作日: ${year}-${month}`);
}

function isThirdBusinessDay(date = new Date()) {
  const target = thirdBusinessDay(date.getFullYear(), date.getMonth() + 1);
  return date.getFullYear() === target.getFullYear()
    && date.getMonth() === target.getMonth()
    && date.getDate() === target.getDate();
}

function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${pad2(weekNo)}`;
}

function formatMoneyWan(n) {
  return `${(Number(n || 0) / 10000).toFixed(2)}万`;
}

function formatMoneyYuan(n) {
  return Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function nowText(date = new Date()) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date).replace(/\//g, '-');
}

module.exports = {
  TZ,
  asDate,
  monthContext,
  isInMonth,
  formatYmd,
  thirdBusinessDay,
  isThirdBusinessDay,
  isoWeekKey,
  formatMoneyWan,
  formatMoneyYuan,
  nowText,
};
