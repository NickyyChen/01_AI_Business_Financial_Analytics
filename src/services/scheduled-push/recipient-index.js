'use strict';

const FN = require('../../permissions/field-normalizer');

function asText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    return value.map(item => asText(item && (item.text || item.name || item.value || item))).filter(Boolean).join('、');
  }
  if (typeof value === 'object') return String(value.text || value.name || value.value || '').trim();
  return String(value).trim();
}

function normalizeProject(value) {
  return String(value || '').trim().replace(/\s+/g, '').toLowerCase();
}

function uniqueProjects(list) {
  return [...new Set((list || []).map(v => String(v || '').trim()).filter(Boolean))];
}

function splitProjects(value, optionMap = {}) {
  if (!value) return [];
  const lk = FN.normLookup(value);
  if (lk.kind === 'optionIds') {
    return uniqueProjects((lk.optionIds || []).map(id => optionMap[id]).filter(Boolean));
  }
  if (lk.kind === 'textChunks') return uniqueProjects(FN.splitMulti(lk.text));
  if (lk.kind === 'users') return [];
  if (Array.isArray(value)) {
    const mapped = [];
    for (const item of value) {
      if (typeof item === 'string' && optionMap[item]) mapped.push(optionMap[item]);
      else mapped.push(...FN.splitMulti(asText(item)));
    }
    return uniqueProjects(mapped);
  }
  return uniqueProjects(FN.splitMulti(asText(value)));
}

function buildProjectAliasMap(projectRows = []) {
  const aliasMap = new Map();
  const addPair = (a, b) => {
    const ka = normalizeProject(a);
    const kb = normalizeProject(b);
    if (!ka || !kb) return;
    if (!aliasMap.has(ka)) aliasMap.set(ka, new Set());
    if (!aliasMap.has(kb)) aliasMap.set(kb, new Set());
    aliasMap.get(ka).add(b);
    aliasMap.get(ka).add(a);
    aliasMap.get(kb).add(a);
    aliasMap.get(kb).add(b);
  };
  for (const row of projectRows || []) {
    const f = row.fields || {};
    const project26 = asText(f['26年项目名称']);
    const projectMr = asText(f['项目名称（管报）']);
    if (project26) addPair(project26, project26);
    if (projectMr) addPair(projectMr, projectMr);
    if (project26 && projectMr) addPair(project26, projectMr);
  }
  return aliasMap;
}

function projectVariants(project, aliasMap = new Map()) {
  const out = new Set();
  for (const raw of uniqueProjects(Array.isArray(project) ? project : [project])) {
    out.add(raw);
    const aliases = aliasMap.get(normalizeProject(raw));
    if (aliases) {
      for (const alias of aliases) out.add(alias);
    }
  }
  return [...out].filter(Boolean);
}

function buildProjectRecipientIndex(employeeRows = [], opts = {}) {
  const optionMap = opts.optionMap || {};
  const aliasMap = opts.aliasMap || new Map();
  const projectToRecipients = new Map();
  const recipientsByName = new Map();
  const skipped = [];

  const addRecipient = (project, recipient) => {
    for (const variant of projectVariants(project, aliasMap)) {
      const key = normalizeProject(variant);
      if (!key) continue;
      if (!projectToRecipients.has(key)) projectToRecipients.set(key, new Map());
      projectToRecipients.get(key).set(recipient.openId, recipient);
    }
  };

  for (const row of employeeRows || []) {
    const f = row.fields || {};
    const person = FN.normPerson(f['姓名 (人员 )'] || f['姓名（人员）'] || f['姓名(人员)']);
    const name = FN.normText(f['姓名']) || (person[0] && person[0].name) || '';
    const openId = FN.normText(f['飞书OpenID']) || (person[0] && person[0].openId) || '';
    if (!name || !openId) {
      skipped.push({ name: name || '(无姓名)', reason: '缺少姓名或飞书OpenID' });
      continue;
    }
    const recipient = { name, openId };
    recipientsByName.set(name, recipient);
    const projects = splitProjects(f['可见项目范围'], optionMap);
    for (const project of projects) addRecipient(project, recipient);
  }

  const findRecipients = (projectValues) => {
    const found = new Map();
    for (const project of projectVariants(projectValues, aliasMap)) {
      const recipients = projectToRecipients.get(normalizeProject(project));
      if (!recipients) continue;
      for (const [openId, recipient] of recipients) found.set(openId, recipient);
    }
    return [...found.values()];
  };

  return {
    projectToRecipients,
    recipientsByName,
    skipped,
    findRecipients,
  };
}

module.exports = {
  asText,
  normalizeProject,
  splitProjects,
  buildProjectAliasMap,
  projectVariants,
  buildProjectRecipientIndex,
};
