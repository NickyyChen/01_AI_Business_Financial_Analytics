/**
 * reference-resolver.js
 *
 * Resolve lightweight follow-up references before Planner runs. The resolver
 * uses structured planningContext first, then falls back to recent assistant
 * text/table extraction.
 */

const { extractEntitiesFromText } = require('./planning-context-builder');

const CN_NUM = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

function _cnToNumber(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/[第名个\s]/g, '');
  if (/^\d+$/.test(s)) return Number(s);
  if (CN_NUM[s]) return CN_NUM[s];
  if (s.length === 2 && s[0] === '十' && CN_NUM[s[1]]) return 10 + CN_NUM[s[1]];
  if (s.length === 2 && s[1] === '十' && CN_NUM[s[0]]) return CN_NUM[s[0]] * 10;
  if (s.length === 3 && s[1] === '十' && CN_NUM[s[0]] && CN_NUM[s[2]]) {
    return CN_NUM[s[0]] * 10 + CN_NUM[s[2]];
  }
  return null;
}

function _detectRank(message) {
  const q = String(message || '');
  const match = q.match(/第\s*([一二两三四五六七八九十\d]{1,3})\s*(?:名|个|项)?/)
    || q.match(/([一二两三四五六七八九十\d]{1,3})\s*(?:号|个)\s*(?:项目|客户|部门|那个|这个)/);
  return match ? _cnToNumber(match[1]) : null;
}

function _hasReference(message) {
  return /(第\s*[一二两三四五六七八九十\d]{1,3}\s*(名|个|项)?|那个|这个|该项目|该客户|该部门|上面|刚才|前面|上一(?:个|名|项)|它|其)/.test(String(message || ''));
}

function _wantedType(message) {
  const q = String(message || '');
  if (/客户/.test(q)) return 'customer';
  if (/部门|行业群|中心|事业部|团队/.test(q)) return 'dept';
  if (/项目|成本|利润|收入|回款|逾期|预算|人力|FTE|经营|亏损|盈利/.test(q)) return 'project';
  return '';
}

function _flattenPlanningContext(planningContext, typeHint) {
  const contexts = Array.isArray(planningContext) ? planningContext : [];
  const out = [];
  for (let ci = contexts.length - 1; ci >= 0; ci--) {
    const ctx = contexts[ci];
    const entities = Array.isArray(ctx && ctx.entities) ? ctx.entities : [];
    for (const e of entities) {
      if (!e || !e.name) continue;
      if (typeHint && e.type && e.type !== typeHint) continue;
      out.push({ ...e, _contextIndex: ci, _question: ctx.question || '' });
    }
  }
  return out;
}

function _flattenHistory(conversationHistory, message, typeHint) {
  const history = Array.isArray(conversationHistory) ? conversationHistory : [];
  const out = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (!msg || msg.role !== 'assistant') continue;
    const entities = extractEntitiesFromText(msg.content || '', message);
    for (const e of entities) {
      if (typeHint && e.type && e.type !== typeHint) continue;
      out.push({ ...e, _contextIndex: i, _question: '' });
    }
    if (out.length > 0) break;
  }
  return out;
}

function _typeLabel(type) {
  if (type === 'customer') return '客户';
  if (type === 'dept') return '部门';
  return '项目';
}

function _replaceReference(message, entity, rank) {
  const type = entity.type || 'project';
  const label = _typeLabel(type);
  const target = `${label}“${entity.name}”`;
  const patterns = [
    /第\s*[一二两三四五六七八九十\d]{1,3}\s*(?:名|个|项)?\s*(?:那个|这个|该)?\s*(?:项目|客户|部门)?/,
    /(?:那个|这个|该)(?:项目|客户|部门)/,
    /上一(?:个|名|项)(?:项目|客户|部门)?/,
    /它|其/,
  ];
  let resolved = String(message || '');
  for (const re of patterns) {
    if (re.test(resolved)) {
      resolved = resolved.replace(re, target);
      return resolved;
    }
  }
  if (rank) return `${target}：${message}`;
  return `${target}：${message}`;
}

function resolveReference({ message = '', planningContext = [], conversationHistory = [] } = {}) {
  if (!_hasReference(message)) {
    return {
      hasReference: false,
      resolved: false,
      needsClarification: false,
      originalMessage: message,
      resolvedMessage: message,
    };
  }

  const rank = _detectRank(message);
  const typeHint = _wantedType(message);
  const candidates = [
    ..._flattenPlanningContext(planningContext, typeHint),
    ..._flattenHistory(conversationHistory, message, typeHint),
  ];

  let entity = null;
  if (rank) {
    entity = candidates.find(e => Number(e.rank) === rank) || null;
  } else {
    const uniqueNames = [...new Set(candidates.map(e => e.name))];
    if (uniqueNames.length === 1) {
      entity = candidates.find(e => e.name === uniqueNames[0]) || null;
    }
  }

  if (!entity) {
    const label = typeHint ? _typeLabel(typeHint) : '对象';
    return {
      hasReference: true,
      resolved: false,
      needsClarification: true,
      clarification: rank
        ? `我需要确认一下你说的“第${rank}名”具体是哪一个${label}。请把名称发我，我再继续查。`
        : `我需要确认一下你说的“那个”具体是哪一个${label}。请把名称发我，我再继续查。`,
      originalMessage: message,
      resolvedMessage: message,
      rank,
      typeHint,
    };
  }

  const resolvedMessage = _replaceReference(message, entity, rank);
  return {
    hasReference: true,
    resolved: true,
    needsClarification: false,
    originalMessage: message,
    resolvedMessage,
    entity,
    rank,
    typeHint: entity.type || typeHint,
  };
}

module.exports = {
  resolveReference,
  _detectRank,
};
