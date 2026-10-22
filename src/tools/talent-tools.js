/**
 * talent-tools.js - 人才/晋升工具
 *
 * 从 capability-skill / promotion-skill 提取。
 * capability: 纯计算（从已加载的 employeeProfile 中提取标签）
 * promotion: 纯计算（从已加载的 promotionGap/promotionDashboard 中提取排名、差距）
 *
 * 注意: 晋升综合评估（需要 LLM）由 Answer LLM 直接完成，不走 tool。
 */

const SKILL_FIELDS = [
  '微信生态场域', '业务策略能力', '数据分析能力', '内容生产能力',
  '运营方法论', '专业交付能力', '客户沟通能力', '商业化能力',
  '学习与创新', '领导与带教', '工具与技术能力',
  '视频号-官店直播', '视频号-创始人IP', '公众号-官号运营', '公众号-小绿书',
  '企业微信-2C运营-拉新与潜客', '企业微信-2C运营-留存与老客',
  '小程序-用户与会员运营', '小程序-内容与社区',
  '投放-流量投放',
];

function _extractTags(fields) {
  const tags = [];
  for (const key of SKILL_FIELDS) {
    const val = fields[key];
    if (!val) continue;
    const items = Array.isArray(val) ? val : [val];
    for (const item of items) {
      const text = item.text || item.name || String(item);
      if (text && text !== '无') tags.push({ field: key, tag: text });
    }
  }
  return tags;
}

// ==================== D1. 能力画像 ====================

function capability(memory, scope) {
  const ep = memory.employeeProfile;
  if (!ep) {
    return { empty: true, message: '暂无员工能力数据' };
  }

  const tags = _extractTags(ep);
  const level = ep['能力等级'];
  const levelText = Array.isArray(level)
    ? level.map(v => v.text || v).join('、')
    : (level || '');

  const self = {
    name: ep['姓名'] || (memory.profile && memory.profile['姓名']) || '',
    level: levelText,
    role: ep['角色与定位'] ? String(ep['角色与定位']).slice(0, 150) : '',
    tagsByField: _groupTags(tags),
    projects: ep['做过的项目'] ? String(ep['做过的项目']).slice(0, 200) : '',
    aiPortrait: ep['AI画像内容'] ? String(ep['AI画像内容']).slice(0, 500) : '',
  };

  return {
    selfProfile: self,
    totalProfiles: 1,
    profiles: [{ name: self.name, dept: ep['标准部门'] || ep['一级部门'] || '', level: levelText, tags }],
  };
}

function _groupTags(tags) {
  const byField = {};
  for (const t of tags) {
    if (!byField[t.field]) byField[t.field] = [];
    byField[t.field].push(t.tag);
  }
  return byField;
}

// ==================== D2. 晋升评估 ====================

function promotion(memory, scope) {
  const gapRecords = memory.promotionGap || [];
  const dashRecords = memory.promotionDashboard || [];

  if (gapRecords.length === 0 && dashRecords.length === 0) {
    return { empty: true, message: '晋升相关数据暂未配置或暂无记录' };
  }

  const empName = scope && scope.empName;
  const isGlobal = scope && scope.isGlobal;
  const subordinateNames = (scope && scope.subordinateNames) || [];
  const allowedNames = new Set([empName, ...subordinateNames]);

  const gapList = gapRecords
    .map(r => r.fields || {})
    .filter(f => {
      if (isGlobal) return true;
      return allowedNames.has(f['姓名']);
    })
    .sort((a, b) => (b['综合达成度_pct'] || 0) - (a['综合达成度_pct'] || 0));

  const selfGap = gapList.find(f => f['姓名'] === empName) || null;

  const readyCount = gapList.filter(f => f['当前状态'] === '可晋升评审').length;
  const nearReadyCount = gapList.filter(f => {
    return f['当前状态'] !== '可晋升评审' && (f['综合达成度_pct'] || 0) >= 70;
  }).length;
  const gapCount = gapList.filter(f => {
    return f['当前状态'] !== '可晋升评审' && (f['综合达成度_pct'] || 0) < 70;
  }).length;

  const ranking = (dashRecords.length > 0 ? dashRecords : gapRecords)
    .map(r => r.fields || {})
    .filter(f => {
      if (isGlobal) return true;
      return allowedNames.has(f['姓名']);
    })
    .sort((a, b) => (b['综合达成度_pct'] || 0) - (a['综合达成度_pct'] || 0))
    .slice(0, 15)
    .map((f, idx) => ({
      rank: idx + 1,
      name: f['姓名'] || '',
      currentLevel: f['当前职级'] || '',
      targetLevel: f['目标职级'] || '',
      attainment: f['综合达成度_pct'] || 0,
      status: f['当前状态'] || '',
      pendingSKU: f['待补SKU数量'] || 0,
      isSelf: f['姓名'] === empName,
    }));

  return {
    selfGap: selfGap ? {
      name: selfGap['姓名'],
      currentLevel: selfGap['当前职级'] || '',
      targetLevel: selfGap['目标职级'] || '',
      attainment: selfGap['综合达成度_pct'] || 0,
      status: selfGap['当前状态'] || '',
      learningCompletion: selfGap['当前学习完成率_pct'] || 0,
      learningThreshold: selfGap['学习门槛_pct'] || 0,
      learningGap: selfGap['学习差距_pct'] || 0,
      satisfiedSKU: selfGap['已满足SKU'] || '',
      pendingSKU: selfGap['待补SKU'] || '',
      skuGapNote: selfGap['SKU差距说明'] || '',
      conclusion: selfGap['综合差距结论'] || '',
      advice: selfGap['努力建议'] || '',
      promotionWindow: selfGap['晋升窗口'] || '',
      quotaRatio: selfGap['推荐名额比例_pct'] || null,
      reminder: selfGap['制度提醒'] || '',
    } : null,
    teamSummary: {
      total: gapList.length,
      readyCount,
      nearReadyCount,
      gapCount,
    },
    ranking,
  };
}

module.exports = { capability, promotion };
