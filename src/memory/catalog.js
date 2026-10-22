// ==================== 召回段 → 所需板块映射（2026-04-20 全面解耦合版） ====================
// TABLE_CATALOG 的每个物理表级 key → 需要哪个 visibleModule 才可见
// 原 composite key（projects/performance/costDetail/budgetCompare/risk/trends/yoyAnalysis/projectRisk/healthCheck）已全部废弃
const CATALOG_MODULE_REQ = {
  // 非财务
  meetings: 'team',
  calendar: 'team',
  workItems: 'team',
  employeeProfile: 'team',
  reviews: 'project',
  customerAnalysis: 'project',
  // 人力
  talentPool: 'hr',
  // 财务 - 项目主档与实际/预算
  projectMaster:  'project',
  actualProject:  'finance',
  actualDept:     'finance',
  actualWorktime: 'finance',
  budgetProject:  'finance',
  budgetDept:     'finance',
  budgetWorktime: 'finance',
  // 财务 - 现金流
  cashflow:       'finance',
  pendingPayment: 'finance',
  invoiceApply:   'finance',
  // 财务 - 销售漏斗（2026-04-23 下线 leadPipeline 旧表）
  presale:        'finance',
  bidding:        'finance',
  signDelivery:   'finance',
  // 财务 - 供应商
  vendorContract: 'finance',
  // 财务 - 同比/环比/趋势
  deptYoy:        'finance',
  companyYoy:     'finance',
  revenueMom:     'finance',
  rollbackProjectActual: 'finance',
  trendPersonal:  'finance',
  trendTeam:      'finance',
  trendBusiness:  'finance',
  // 风险
  riskAlert:      'risk',
  riskRule:       'risk',
};

// ==================== 召回机制：表-关键词映射 ====================
// 每个 key 对应 getUserMemory 里的一块数据，
// keywords 命中任意一个即判定该表与当前问题相关。
const TABLE_CATALOG = {
  meetings:       ['会议', '开会', '妙记', '纪要', '参会', '讨论记录', '会议记录'],
  calendar:       ['日程', '日历', '安排', '计划', '时间', '下周', '这周', '今天', '明天', '后天', '本周'],
  workItems:      ['任务', '待办', 'OKR', 'KR', '工作事项', '目标完成', '关键结果'],

  // --- 项目-主档/成本/工时 ---
  projectMaster:  ['项目', '负责', '参与', '进展', '里程碑', '月报', '进度', '交付', '项目经理', '项目状态', '项目主档', '项目列表'],
  actualProject:  ['项目成本', '项目实际', '项目亏损', '盈亏', '利润率', '项目利润', '亏损项目', '项目收入', '项目毛利', '经营情况', '经营分析', '经营效益'],
  actualDept:     ['部门成本', '部门实际', '部门对比', '哪里超了', '成本超', '部门层', '部门利润', '部门经营',
                   '部门收入', '部门毛利', '收入趋势', '利润趋势', '月度趋势', '月趋势', '趋势', '前3个月', '前几个月', '近3个月', '近半年', '过去6个月', '过去3个月', '近6个月'],
  actualWorktime: ['人力', 'FTE', '人均', '人效', '人均月创收', '人均成本', '人均月成本', '工时', '人员投入', '人员情况', '人员明细', '具体人员', '具体人名', '人名', '姓名', '精力', '精力明细', '超编', '人力投入', '人力成本',
                   '人数', '人头', '实际人数', '实际人头', '参与人数', '涉及员工数', '名单人数'],

  // --- 预算 ---
  budgetProject:  ['项目预算', '预算项目层', '项目目标', '绩效', 'KPI', '考核', '评分', '绩效目标', '项目KPI', '指标', '达成率', '完成率'],
  budgetDept:     ['预算', '预算是多少', '预算金额', '预算总额', '部门预算', '预算部门层', '部门目标', '上半年预算', '1-6月预算', '一到六月预算'],
  budgetWorktime: ['工时预算', '预算工时', '人力预算', '编制预算', '超编', '超额', '超出预算', '编制', '超出编制', '预实对比', '实际 vs 预算', '预算 vs 实际',
                   '预算人数', '预算人头', '编制人数', '编制人头', '预算FTE', '编制FTE'],

  // --- 现金流 ---
  cashflow:       ['现金流', '回款', '应收', '账款', '开票', '收款', '账期', '逾期', '催收', '未回款', '开票回款', '回款计划'],
  pendingPayment: ['认领', '待认领', '到款', '银行到款', '未认领', '认领状态', '到款认领', '流水'],
  invoiceApply:   ['发票申请', '开票申请', '发票号', '红冲', '增值税', '专票', '普票', '税号', '纳税人识别号'],

  // --- 销售漏斗（售前→投标→签约→交付；2026-04-23 下线 leadPipeline 旧表 ---
  presale:        ['售前', '售前项目', '售前方案', '售前漏斗', '售前评级', '赢单率', '赢单', '丢单', '丢标', '管线', '六要素', '跟进',
                   '商机', '商机管线', '商机阶段', '商机负责人', '线索', '预估签约', '赢率', '竞争对手', '丢标原因',
                   '有什么线索', '我的线索', '在进商机', '线索池'],
  bidding:        ['招投标', '投标', '中标', '开标', '废标', '流标', '招标', '竞标', '标书', '报价', '中标率'],
  signDelivery:   ['签约', '合同', '已签', '续签', '续约', '履约', '交付', '签约交付', '合同金额', '签约金额', '合同附件'],

  // --- 供应商 / 活水 ---
  vendorContract: ['供应商', '外包合同', '采购合同', '供应商合同', '采购费用', '外包费', '供应商管理'],
  talentPool:     ['活水', '人员释放', '空单', '兼项', '人力释放', '闲置人员', '可调配', '人员调配', '活水池'],

  // --- 回滚同比/环比 ---
  deptYoy:        ['回滚部门同比', '部门同比回滚', '部门层同比（回滚）', '回滚后部门同比'],
  companyYoy:     ['回滚公司同比', '公司同比回滚', '公司层面同比（回滚）', '回滚后公司同比'],
  revenueMom:     ['回滚环比', '回滚后环比', '履约收入&利润环比（回滚）', '回滚后利润环比'],
  rollbackProjectActual: ['回滚项目', '回滚明细', '项目层回滚', '回滚原因', '回滚影响项目', '分摊后项目净利润'],

  // --- 趋势快照（物理表级） ---
  trendPersonal:  ['个人趋势', '我的趋势', '个人经营趋势', '本人趋势'],
  trendTeam:      ['团队趋势', '下属趋势', '团队经营趋势'],
  trendBusiness:  ['全司趋势', '公司趋势', '全公司趋势', '全司经营趋势'],

  // --- 风险（物理表级） ---
  riskAlert:      ['风险', '告警', '预警', '异常', '超期', '红线', '问题', '红灯', '黄灯', '风险告警', '风险预警'],
  riskRule:       ['风控规则', '风险规则', '规则阈值', '风控阈值', '规则是否启用', '风控开关', '风控'],

  // --- 其他 ---
  reviews:          ['复盘', '总结', '回顾', '经验教训', '问题分析'],
  customerAnalysis: ['客户', '客户经营', '合作客户', '客户分析', '客户合作', '合作了哪些', '合作金额', '合作SKU', '客户维度'],
  employeeProfile:  ['能力', '技能', '擅长', '标签', '人才盘点', '画像'],
};

/**
 * 基于问题内容选择需要加载的数据段。
 * profile 始终加载，其余按关键词命中。
 */
function selectTablesForQuestion(question) {
  const q = String(question || '').toLowerCase();
  const always = new Set(['profile', 'employeeProfile']);
  if (!q) return new Set([...always, ...Object.keys(TABLE_CATALOG)]);

  const needed = new Set(always);
  for (const [tableKey, keywords] of Object.entries(TABLE_CATALOG)) {
    if (keywords.some(keyword => q.includes(String(keyword).toLowerCase()))) {
      needed.add(tableKey);
    }
  }

  // 没命中任何关键词（如"帮我看看"）→ 加载核心三表兜底
  if (needed.size === always.size) {
    needed.add('projectMaster');
    needed.add('actualProject');
    needed.add('budgetProject');
  }

  return needed;
}

module.exports = {
  CATALOG_MODULE_REQ,
  TABLE_CATALOG,
  selectTablesForQuestion,
};
