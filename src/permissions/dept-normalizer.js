'use strict';

const DEFAULT_KNOWN_DEPTS = [
  'X行业群',
  '健康美学行业群',
  '公域生态行业群',
  '社区运营中心',
  '内容业务群',
  '快消零售行业群',
  '耐消行业群',
  '时尚行业群',
  '品牌连锁行业群',
  'TOC创新业务',
  '财务部',
  '组织部',
  '公司层面',
];

const DEFAULT_ALIASES = {
  X行业群: ['X行业群', 'x行业群', 'X 行业群', 'x 行业群', 'X行业', 'x行业', 'X 行业', 'x 行业', 'X群', 'x群', 'X业务群', 'x业务群'],
  健康美学行业群: ['健康美学行业群', '健康美学行业', '健康美学', '健慷美学', '健康美學', '健康美学群', '健康美学业务群', '美学行业群', '美学业务群'],
  公域生态行业群: ['公域生态行业群', '公域生态行业', '公域生态', '公域生态群', '公域生态业务群', '生态行业群', '生态业务群', '公域行业群', '公域业务群', '生态群', '公域群'],
  社区运营中心: ['社区运营中心', '社区中心', '社区运营', '社区运营部', '社区运营团队'],
  内容业务群: ['内容业务群', '内容中台', '内容业务', '内容业务部', '内容群', '内容业务团队'],
  快消零售行业群: ['快消零售行业群', '快消零售行业', '快消零售', '快消零售业务群', '快消行业群', '快消行业', '快消业务群', '快消', '零售行业群', '零售业务群', '零售群', '消零售行业群'],
  耐消行业群: ['耐消行业群', '耐消行业', '耐消', '耐用消费行业群', '耐用消费行业', '耐用消费', '耐用消费品'],
  时尚行业群: ['时尚行业群', '时尚行业', '时尚', '时尚群', '时尚业务群'],
  品牌连锁行业群: ['品牌连锁行业群', '品牌连锁行业', '品牌连锁', '品牌连锁群', '品牌连锁业务群', '连锁行业群', '连锁业务群', '连锁群'],
  TOC创新业务: ['TOC创新业务', 'TOC创新', 'TOC', 'toc创新业务', 'toc创新', 'toc', '创新业务'],
  财务部: ['财务部', '财务部门'],
  组织部: ['组织部', '组织部门'],
  公司层面: ['公司层面', '公司层'],
};

const DEFAULT_SUB_DEPT_ALIASES = {
  鞋服行业线: {
    parentDept: '时尚行业群',
    aliases: ['鞋服行业线', '鞋服行业', '鞋服'],
  },
};

function normalizeDeptToken(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, '')
    .replace(/[a-z]/g, ch => ch.toUpperCase());
}

function _uniq(list) {
  return [...new Set((Array.isArray(list) ? list : []).map(v => String(v || '').trim()).filter(Boolean))];
}

function _knownDeptsFor(scopeOrKnown) {
  let supplied = [];
  if (Array.isArray(scopeOrKnown)) supplied = scopeOrKnown;
  else if (scopeOrKnown && Array.isArray(scopeOrKnown.depts)) supplied = scopeOrKnown.depts;
  return _uniq([...DEFAULT_KNOWN_DEPTS, ...supplied]);
}

function buildDeptAliasMap(knownDepts, aliases = DEFAULT_ALIASES) {
  const known = _knownDeptsFor(knownDepts);
  const knownSet = new Set(known);
  const pairs = [];

  for (const dept of known) {
    pairs.push([normalizeDeptToken(dept), dept]);
  }

  for (const [canonical, aliasList] of Object.entries(aliases || {})) {
    if (knownSet.size > 0 && !knownSet.has(canonical)) continue;
    for (const alias of aliasList || []) {
      pairs.push([normalizeDeptToken(alias), canonical]);
    }
  }

  const map = new Map();
  for (const [token, canonical] of pairs) {
    if (!token) continue;
    const existing = map.get(token);
    if (!existing) map.set(token, new Set());
    map.get(token).add(canonical);
  }
  return map;
}

function resolveDeptName(input, knownDepts, aliases = DEFAULT_ALIASES) {
  const raw = String(input || '').trim();
  const token = normalizeDeptToken(raw);
  if (!token) return { raw, token, canonical: '', matched: false, ambiguous: false, candidates: [] };

  const aliasMap = buildDeptAliasMap(knownDepts, aliases);
  const candidates = [...(aliasMap.get(token) || [])];
  if (candidates.length === 1) {
    return { raw, token, canonical: candidates[0], matched: true, ambiguous: false, candidates };
  }
  if (candidates.length > 1) {
    return { raw, token, canonical: '', matched: false, ambiguous: true, candidates };
  }
  return { raw, token, canonical: '', matched: false, ambiguous: false, candidates: [] };
}

function canonicalizeDeptName(input, knownDepts, aliases = DEFAULT_ALIASES) {
  const resolved = resolveDeptName(input, knownDepts, aliases);
  return resolved.matched ? resolved.canonical : null;
}

function canonicalizeDeptList(inputList, knownDepts, aliases = DEFAULT_ALIASES) {
  const out = [];
  const unresolved = [];
  const ambiguous = [];

  for (const item of Array.isArray(inputList) ? inputList : []) {
    const raw = String(item || '').trim();
    if (!raw) continue;
    const resolved = resolveDeptName(raw, knownDepts, aliases);
    if (resolved.matched) out.push(resolved.canonical);
    else if (resolved.ambiguous) ambiguous.push({ raw, candidates: resolved.candidates });
    else unresolved.push(raw);
  }

  return {
    depts: _uniq(out),
    unresolved: _uniq(unresolved),
    ambiguous,
  };
}

function extractDeptsFromText(text, knownDepts, aliases = DEFAULT_ALIASES) {
  const q = normalizeDeptToken(text);
  if (!q) return [];

  const aliasMap = buildDeptAliasMap(knownDepts, aliases);
  const matches = [];
  const entries = [...aliasMap.entries()]
    .filter(([token]) => token)
    .sort((a, b) => b[0].length - a[0].length);

  for (const [token, candidates] of entries) {
    let start = 0;
    while (start < q.length) {
      const idx = q.indexOf(token, start);
      if (idx === -1) break;
      matches.push({ start: idx, end: idx + token.length, token, candidates: [...candidates] });
      start = idx + Math.max(token.length, 1);
    }
  }

  const chosen = [];
  matches.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  for (const match of matches) {
    const overlaps = chosen.some(item => match.start < item.end && item.start < match.end);
    if (!overlaps) chosen.push(match);
  }

  const found = [];
  chosen.sort((a, b) => a.start - b.start);
  for (const match of chosen) {
    for (const candidate of match.candidates) found.push(candidate);
  }
  return _uniq(found);
}

function extractSubDeptsFromText(text, subDeptAliases = DEFAULT_SUB_DEPT_ALIASES) {
  const q = normalizeDeptToken(text);
  if (!q) return [];
  const out = [];
  for (const [canonical, def] of Object.entries(subDeptAliases || {})) {
    const aliases = [canonical, ...((def && def.aliases) || [])]
      .map(normalizeDeptToken)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    if (aliases.some(alias => q.includes(alias))) {
      out.push({
        canonical,
        parentDept: def && def.parentDept ? def.parentDept : '',
      });
    }
  }
  const seen = new Set();
  return out.filter(item => {
    const key = `${item.parentDept}::${item.canonical}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function _matchedSubDeptAliasTokens(matches, subDeptAliases = DEFAULT_SUB_DEPT_ALIASES) {
  const wanted = new Set((Array.isArray(matches) ? matches : []).map(item => item && item.canonical).filter(Boolean));
  const tokens = new Set();
  for (const [canonical, def] of Object.entries(subDeptAliases || {})) {
    if (!wanted.has(canonical)) continue;
    for (const alias of [canonical, ...((def && def.aliases) || [])]) {
      const token = normalizeDeptToken(alias);
      if (token) tokens.add(token);
    }
  }
  return tokens;
}

function normalizePlanScope(planResult, scope, question, aliases = DEFAULT_ALIASES) {
  if (!planResult || typeof planResult !== 'object') return planResult;
  const known = _knownDeptsFor(scope);
  const queryScope = planResult.query_scope && typeof planResult.query_scope === 'object'
    ? planResult.query_scope
    : { depts: [] };
  const rawDepts = Array.isArray(queryScope.depts) ? queryScope.depts.map(v => String(v || '').trim()).filter(Boolean) : [];
  const extracted = extractDeptsFromText(question, known, aliases);
  const subDeptMatches = extractSubDeptsFromText(question);
  const subDeptAliasTokens = _matchedSubDeptAliasTokens(subDeptMatches);
  const parentDepts = subDeptMatches.map(item => item.parentDept).filter(Boolean);
  const combined = _uniq([...rawDepts, ...extracted])
    .filter(item => !subDeptAliasTokens.has(normalizeDeptToken(item)));
  const resolved = canonicalizeDeptList(_uniq([...combined, ...parentDepts]), known, aliases);
  const canonical = _uniq([...resolved.depts, ...resolved.unresolved]);

  planResult.query_scope = {
    ...queryScope,
    depts: canonical,
  };
  if (subDeptMatches.length > 0) {
    planResult.query_scope.subDepts = _uniq([...(queryScope.subDepts || []), ...subDeptMatches.map(item => item.canonical)]);
    planResult.query_scope._subDeptParents = Object.fromEntries(subDeptMatches.map(item => [item.canonical, item.parentDept]));
  }
  if (combined.length > 0) {
    planResult.query_scope._rawDepts = combined;
    planResult.query_scope._canonicalized = resolved.depts.length > 0;
  }
  if (resolved.ambiguous.length > 0) {
    planResult.query_scope._ambiguousDepts = resolved.ambiguous;
  }
  return planResult;
}

module.exports = {
  DEFAULT_KNOWN_DEPTS,
  DEFAULT_ALIASES,
  DEFAULT_SUB_DEPT_ALIASES,
  normalizeDeptToken,
  buildDeptAliasMap,
  resolveDeptName,
  canonicalizeDeptName,
  canonicalizeDeptList,
  extractDeptsFromText,
  extractSubDeptsFromText,
  normalizePlanScope,
};
