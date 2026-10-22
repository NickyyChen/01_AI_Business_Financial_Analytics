'use strict';

const config = require('../../config');
const client = require('../clients/feishu-client');
const logger = require('../utils/logger');
const gapTableSetup = require('./promotion-gap-table-setup');
const dashboardTableSetup = require('./promotion-dashboard-table-setup');
const refreshConfigSetup = require('./promotion-refresh-config-setup');

let _tableId = null;
let _dashboardTableId = null;
let _isRunning = false;

const TABLE_IDS = {
  employeeMain: config.TABLES.EMPLOYEE,
  employeeProfile: config.TABLES.EMPLOYEE_PROFILE,
  promotionRule: 'tblPZ8Yd5LhDuZwR',
  skuRun: 'tblqhSQl0BUoiq7n',
};

const SKU_LEVEL_RANK = {
  '暂无': 0,
  '蜻蜓点水': 1,
  '登堂入室': 2,
  '驾轻就熟': 3,
  '返璞归真': 4,
};

const REQUIRED_SKILL_LEVEL_TO_RUN_LEVEL = {
  '初级': '蜻蜓点水',
  '中级': '登堂入室',
  '高级': '驾轻就熟',
};
const PROMOTION_EVAL_LEVEL_RANK = {
  '': 0,
  '初级': 1,
  '中级': 2,
  '高级': 3,
};
const RUN_LEVEL_TO_PROMOTION_EVAL_LEVEL = {
  '蜻蜓点水': '初级',
  '登堂入室': '初级',
  '驾轻就熟': '中级',
  '返璞归真': '高级',
};

const RULE_SKU_NAME_MAP = {
  '私域运营': ['公众号-官号运营', '企业微信-2C运营-拉新与潜客', '企业微信-2C运营-留存与老客', '企业微信-2C运营-公私域联动'],
  '数据分析': ['数据分析能力'],
  '项目管理': ['专业交付能力'],
  '团队管理': ['团队带教', '梯队复制'],
  '招聘面试': ['领导与带教'],
  '组织管理': ['团队带教', '梯队复制'],
  '经营分析': ['利润管理', '数据分析能力'],
};

async function getTableId() {
  if (_tableId) {
    return _tableId;
  }
  _tableId = await gapTableSetup.ensureTable();
  return _tableId;
}

async function getDashboardTableId() {
  if (_dashboardTableId) {
    return _dashboardTableId;
  }
  _dashboardTableId = await dashboardTableSetup.ensureTable();
  return _dashboardTableId;
}

async function loadAllData() {
  const [employees, profiles, rules, skuRows] = await Promise.all([
    client.listRecords(TABLE_IDS.employeeMain, { page_size: 500 }),
    client.listRecords(TABLE_IDS.employeeProfile, { page_size: 500 }),
    client.listRecords(TABLE_IDS.promotionRule, { page_size: 200 }),
    client.listRecords(TABLE_IDS.skuRun, { page_size: 500 }),
  ]);

  return { employees, profiles, rules, skuRows };
}

function textValue(value) {
  if (value == null) {
    return '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (!item) {
        return '';
      }
      if (typeof item === 'string') {
        return item;
      }
      if (item.text) {
        return item.text;
      }
      if (item.name) {
        return item.name;
      }
      if (item.id) {
        return item.id;
      }
      return String(item);
    }).join('').replace(/,+/g, '、').trim();
  }
  if (value.users && Array.isArray(value.users)) {
    return value.users.map((item) => item.name || item.enName || item.id || '').filter(Boolean).join('、');
  }
  if (value.text) {
    return value.text;
  }
  return String(value).trim();
}

function numValue(value) {
  const text = textValue(value).replace(/%/g, '').replace(/,/g, '').trim();
  if (!text) {
    return 0;
  }
  const num = Number(text);
  return Number.isFinite(num) ? num : 0;
}

function normalizePercent(value) {
  const raw = numValue(value);
  if (raw <= 1) {
    return raw * 100;
  }
  return raw;
}

function splitList(text) {
  return String(text || '')
    .split(/[；;、,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildProfileMap(records) {
  const byName = new Map();
  const byOpenId = new Map();
  for (const record of records) {
    const fields = record.fields || {};
    const name = textValue(fields['姓名']);
    const openId = textValue(fields['飞书OpenID']);
    if (name && !byName.has(name)) {
      byName.set(name, record);
    }
    if (openId && !byOpenId.has(openId)) {
      byOpenId.set(openId, record);
    }
  }
  return { byName, byOpenId };
}

function buildRuleMap(records) {
  const map = new Map();
  for (const record of records) {
    const fields = record.fields || {};
    if (!fields['是否启用']) {
      continue;
    }
    const currentRank = textValue(fields['当前职级']);
    if (currentRank) {
      map.set(currentRank, record);
    }
  }
  return map;
}

function buildSkuMap(records) {
  const map = new Map();
  for (const record of records) {
    const fields = record.fields || {};
    const openId = textValue(fields['openid']);
    const label = textValue(fields['SKU标签']);
    if (!openId || !label) {
      continue;
    }
    const key = `${openId}::${label}`;
    map.set(key, record);
  }
  return map;
}

function parseRequiredSku(rawText) {
  return splitList(rawText).map((item) => {
    const match = item.match(/(.+?)(初级|中级|高级)$/);
    if (!match) {
      return {
        raw: item,
        displayName: item,
        requiredLevelLabel: '',
        requiredRunLevel: '',
      };
    }
    const displayName = match[1].trim();
    const requiredLevelLabel = match[2];
    return {
      raw: item,
      displayName,
      requiredLevelLabel,
      requiredRunLevel: REQUIRED_SKILL_LEVEL_TO_RUN_LEVEL[requiredLevelLabel] || '',
    };
  });
}

function getCandidateLabels(displayName) {
  return RULE_SKU_NAME_MAP[displayName] || [displayName];
}

function evaluateSkuRequirement(openId, skuMap, requirement) {
  const candidateLabels = getCandidateLabels(requirement.displayName);
  const candidates = candidateLabels
    .map((label) => ({ label, record: skuMap.get(`${openId}::${label}`) }))
    .filter((item) => item.record);

  if (!candidates.length) {
    return {
      met: false,
      actualLabel: candidateLabels[0],
      actualLevel: '暂无',
      note: `${requirement.displayName} 尚未点亮`,
    };
  }

  let best = candidates[0];
  for (const item of candidates.slice(1)) {
    const itemLevel = textValue(item.record.fields && item.record.fields['等级']);
    const bestLevel = textValue(best.record.fields && best.record.fields['等级']);
    if ((SKU_LEVEL_RANK[itemLevel] || 0) > (SKU_LEVEL_RANK[bestLevel] || 0)) {
      best = item;
    }
  }

  const actualLevel = textValue(best.record.fields && best.record.fields['等级']);
  const promotionEvalLevel =
    textValue(best.record.fields && best.record.fields['晋升评估等级']) ||
    RUN_LEVEL_TO_PROMOTION_EVAL_LEVEL[actualLevel] ||
    '';
  const met = (PROMOTION_EVAL_LEVEL_RANK[promotionEvalLevel] || 0) >= (PROMOTION_EVAL_LEVEL_RANK[requirement.requiredLevelLabel] || 0);
  return {
    met,
    actualLabel: best.label,
    actualLevel,
    promotionEvalLevel,
    note: met
      ? `${requirement.displayName} 已达到 ${promotionEvalLevel || actualLevel}`
      : `${requirement.displayName} 当前为 ${promotionEvalLevel || actualLevel}，目标需达到 ${requirement.requiredLevelLabel || requirement.requiredRunLevel}`,
  };
}

function buildAdvice({ learningGap, unmetRequirements, employeeFields, skuEvidence }) {
  const advices = [];

  if (learningGap > 0) {
    advices.push(`补齐学习任务完成率，当前还差 ${learningGap}% ，建议先清空必修任务，再补一次主题输出或复盘沉淀。`);
  }
  if (unmetRequirements.length > 0) {
    advices.push(`围绕 ${unmetRequirements.map((item) => item.raw).join('、')} 补齐证据，优先补已经接近达标的 SKU。`);
  }

  const abilityLevel = textValue(employeeFields['能力等级']);
  if (!abilityLevel || abilityLevel === '无匹配类别') {
    advices.push('员工画像中的能力等级仍不完整，建议先补齐画像评估，否则晋升材料会缺少基础能力背书。');
  }

  if (skuEvidence.length > 0) {
    advices.push(`可优先复用现有强证据：${skuEvidence.slice(0, 2).join('；')}。`);
  }

  if (!advices.length) {
    advices.push('当前硬门槛已满足，建议集中准备人工评审材料、360 反馈与高质量案例复盘。');
  }

  return advices.join('\n');
}

function buildMaterialSuggestion(ruleFields) {
  const suggestions = [
    '准备《职级晋升申报表》中的综合自评、能力自评和举证内容。',
    '准备 1-2 个高质量项目案例，突出结果、方法和复盘。',
  ];
  if (ruleFields['是否人工评审']) {
    suggestions.push('本级别需要人工评审，建议同步整理述职材料和推荐理由。');
  }
  if (ruleFields['是否需要360评估']) {
    suggestions.push('本级别需纳入 360 评价，建议提前补齐跨部门协作和管理反馈证据。');
  }
  return suggestions.join('\n');
}

function buildPolicyReminder(ruleFields) {
  const ratio = normalizePercent(ruleFields['推荐名额比例']);
  const reminders = [
    `推荐窗口为 ${textValue(ruleFields['晋升窗口'])}。`,
    `推荐名额比例约为 ${Math.round(ratio)}%。`,
    '制度要求逐级晋升，推荐后还有公示与特殊自荐环节。',
  ];
  if (ruleFields['是否人工评审']) {
    reminders.push('达标后仍需通过评审，不是自动晋升。');
  }
  return reminders.join(' ');
}

function calculateAttainment({ learningGap, requiredLearning, unmetCount, totalRequirements }) {
  const learningScore = requiredLearning > 0 ? Math.max(0, 1 - learningGap / requiredLearning) : 1;
  const skuScore = totalRequirements > 0 ? Math.max(0, 1 - unmetCount / totalRequirements) : 1;
  return Number((((learningScore + skuScore) / 2) * 100).toFixed(1));
}

function buildConclusion({ learningGap, unmetRequirements, targetRank }) {
  const blockers = [];
  if (learningGap > 0) {
    blockers.push(`学习完成率差 ${learningGap}%`);
  }
  if (unmetRequirements.length > 0) {
    blockers.push(`SKU 待补 ${unmetRequirements.length} 项`);
  }
  if (!blockers.length) {
    return `已满足升至 ${targetRank} 的硬性门槛，可进入人工评审与材料准备阶段。`;
  }
  return `距离升至 ${targetRank} 仍有关键差距：${blockers.join('，')}。`;
}

async function buildGapRows() {
  const { employees, profiles, rules, skuRows } = await loadAllData();
  const profileMap = buildProfileMap(profiles);
  const ruleMap = buildRuleMap(rules);
  const skuMap = buildSkuMap(skuRows);

  const rows = [];

  for (const employee of employees) {
    const employeeFields = employee.fields || {};
    const status = textValue(employeeFields['在岗状态']);
    if (status && status !== '在职' && status !== '试用') {
      continue;
    }

    const name = textValue(employeeFields['姓名']);
    const openId = textValue(employeeFields['飞书OpenID']);
    const employeeId = textValue(employeeFields['员工ID']);
    const currentRank = textValue(employeeFields['当前职级']);
    if (!name || !openId || !currentRank) {
      continue;
    }

    const ruleRecord = ruleMap.get(currentRank);
    if (!ruleRecord) {
      continue;
    }
    const ruleFields = ruleRecord.fields || {};
    const profileRecord = profileMap.byOpenId.get(openId) || profileMap.byName.get(name);
    const profileFields = profileRecord ? (profileRecord.fields || {}) : {};

    const currentLearning = normalizePercent(employeeFields['学习任务完成率']);
    const requiredLearning = normalizePercent(ruleFields['学习完成率门槛']);
    const learningGap = Math.max(requiredLearning - currentLearning, 0);

    const requirements = parseRequiredSku(ruleFields['必须点亮SKU']);
    const evaluations = requirements.map((requirement) => ({
      requirement,
      result: evaluateSkuRequirement(openId, skuMap, requirement),
    }));

    const metSku = evaluations
      .filter((item) => item.result.met)
      .map((item) => `${item.requirement.raw}(${item.result.actualLevel})`);
    const unmetSku = evaluations
      .filter((item) => !item.result.met)
      .map((item) => item.requirement.raw);

    const skuGapNotes = evaluations
      .filter((item) => !item.result.met)
      .map((item) => item.result.note);

    const skuEvidence = evaluations
      .filter((item) => item.result.met)
      .map((item) => item.result.note);

    const targetRank = textValue(ruleFields['目标职级']);
    const attainment = calculateAttainment({
      learningGap,
      requiredLearning,
      unmetCount: unmetSku.length,
      totalRequirements: requirements.length,
    });
    const conclusion = buildConclusion({
      learningGap: Number(learningGap.toFixed(1)),
      unmetRequirements: unmetSku,
      targetRank,
    });
    const advice = buildAdvice({
      learningGap: Number(learningGap.toFixed(1)),
      unmetRequirements: requirements.filter((item) => unmetSku.includes(item.raw)),
      employeeFields: profileFields,
      skuEvidence,
    });

    rows.push({
      key: `${openId}::${currentRank}`,
      fields: {
        差距ID: `GAP-${employeeId || openId}-${currentRank}`,
        员工ID: employeeId,
        飞书OpenID: openId,
        姓名: name,
        当前职级: currentRank,
        目标职级: targetRank,
        当前状态: unmetSku.length === 0 && learningGap === 0 ? '可晋升评审' : '待补差距',
        晋升窗口: textValue(ruleFields['晋升窗口']),
        推荐名额比例_pct: Number(normalizePercent(ruleFields['推荐名额比例']).toFixed(1)),
        需要360评估: Boolean(ruleFields['是否需要360评估']),
        需要人工评审: Boolean(ruleFields['是否人工评审']),
        当前学习完成率_pct: Number(currentLearning.toFixed(1)),
        学习门槛_pct: Number(requiredLearning.toFixed(1)),
        学习差距_pct: Number(learningGap.toFixed(1)),
        综合达成度_pct: attainment,
        必做任务: textValue(ruleFields['必须完成任务']),
        必须点亮SKU: textValue(ruleFields['必须点亮SKU']),
        已满足SKU: metSku.join('；'),
        待补SKU: unmetSku.join('；'),
        SKU差距说明: skuGapNotes.join('；'),
        证据摘要: skuEvidence.join('；'),
        申报材料建议: buildMaterialSuggestion(ruleFields),
        制度提醒: buildPolicyReminder(ruleFields),
        综合差距结论: conclusion,
        努力建议: advice,
        规则版本: textValue(ruleFields['版本号']),
        更新时间: Date.now(),
      },
    });
  }

  return rows;
}

async function listExistingRows(tableId) {
  const rows = await client.listRecords(tableId, { page_size: 500 });
  const map = new Map();
  for (const row of rows) {
    const fields = row.fields || {};
    const key = `${textValue(fields['飞书OpenID'])}::${textValue(fields['当前职级'])}`;
    if (key !== '::') {
      map.set(key, row);
    }
  }
  return map;
}

async function syncRows(tableId, rows) {
  const existing = await listExistingRows(tableId);
  const seenKeys = new Set();

  for (const row of rows) {
    seenKeys.add(row.key);
    const old = existing.get(row.key);
    if (old) {
      await client.updateRecord(tableId, old.record_id, row.fields);
    } else {
      await client.createRecord(tableId, row.fields);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  for (const [key, old] of existing.entries()) {
    if (!seenKeys.has(key)) {
      await client.deleteRecord(tableId, old.record_id);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function buildDashboardRows(gapRows) {
  const sortedByNear = [...gapRows].sort((a, b) => {
    const diff = (b.fields['综合达成度_pct'] || 0) - (a.fields['综合达成度_pct'] || 0);
    if (diff !== 0) {
      return diff;
    }
    return (a.fields['学习差距_pct'] || 0) - (b.fields['学习差距_pct'] || 0);
  });
  const sortedByGap = [...gapRows].sort((a, b) => {
    const diff = (a.fields['综合达成度_pct'] || 0) - (b.fields['综合达成度_pct'] || 0);
    if (diff !== 0) {
      return diff;
    }
    return (b.fields['学习差距_pct'] || 0) - (a.fields['学习差距_pct'] || 0);
  });

  const nearRank = new Map(sortedByNear.map((item, index) => [item.key, index + 1]));
  const gapRank = new Map(sortedByGap.map((item, index) => [item.key, index + 1]));

  return gapRows.map((item) => {
    const unmetSkuCount = splitList(item.fields['待补SKU']).length;
    return {
      key: item.key,
      fields: {
        排序ID: `DASH-${item.fields['员工ID'] || item.fields['飞书OpenID']}`,
        员工ID: item.fields['员工ID'],
        飞书OpenID: item.fields['飞书OpenID'],
        姓名: item.fields['姓名'],
        当前职级: item.fields['当前职级'],
        目标职级: item.fields['目标职级'],
        综合达成度_pct: item.fields['综合达成度_pct'],
        接近晋升排名: nearRank.get(item.key),
        差距最大排名: gapRank.get(item.key),
        待补SKU数量: unmetSkuCount,
        学习差距_pct: item.fields['学习差距_pct'],
        当前状态: item.fields['当前状态'],
        管理视图结论:
          nearRank.get(item.key) <= 5
            ? '优先关注：最接近晋升'
            : gapRank.get(item.key) <= 5
              ? '重点辅导：差距最大'
              : '常规跟进',
        更新时间: Date.now(),
      },
    };
  });
}

async function runFullSync() {
  if (_isRunning) {
    logger.info('[PromotionGap] 上一次刷新尚未完成，跳过本次');
    return;
  }
  _isRunning = true;

  try {
    const tableId = await getTableId();
    const dashboardTableId = await getDashboardTableId();
    await refreshConfigSetup.ensureTable();
    const rows = await buildGapRows();
    await syncRows(tableId, rows);
    const dashboardRows = buildDashboardRows(rows);
    await syncRows(dashboardTableId, dashboardRows);
    logger.info(`[PromotionGap] 刷新完成，共写入 ${rows.length} 条晋升差距记录`);
  } catch (error) {
    logger.error(`[PromotionGap] 刷新失败: ${error.message}`);
  } finally {
    _isRunning = false;
  }
}

module.exports = {
  runFullSync,
};
