/**
 * tool-registry.js - 工具注册表
 *
 * 中央工具目录：注册所有可用工具，按权限过滤可见工具，
 * 生成 Planner LLM 的工具目录文本。
 *
 * 工具接口标准：
 *   handler(memory, scope) => { ... } 结构化数据
 *   - memory: memory-manager.getUserMemory() 返回值
 *   - scope: permission-manager.resolveScope() 返回值
 *   - 返回值: 结构化对象（不含格式化文本）
 */

const financeTools = require('./finance-tools');
const financeComparisonTools = require('./finance-comparison-tools');
const riskTools = require('./risk-tools');
const analyticsTools = require('./analytics-tools');
const talentTools = require('./talent-tools');
const teamTools = require('./team-tools');
const customerTools = require('./customer-tools');
const presaleTools = require('./presale-tools');
const signDeliveryTools = require('./sign-delivery-tools');
const biddingTools = require('./bidding-tools');
// 2026-04-23 下线：商机管线（LEAD_PIPELINE）是旧表，销售漏斗分析统一走
// presale / bidding / signDelivery 三张新表。lead-pipeline-tools 文件保留代码
// （后续若需要反向导入或数据清洗可复用），但不再从 tool-registry 注册。
// const leadPipelineTools = require('./lead-pipeline-tools');

const knowhowLibrary = require('../utils/knowhow-library');

const TOOLS = {
  // ===== Finance Tools =====
  'finance.profitOverview': {
    name: '利润总览',
    description: '【专长】项目维度利润率计算与亏损识别（单周期累计口径）。默认经营实际端使用 ROLLBACK_PROJECT_ACTUAL（实际回滚口径、履约利润）；用户明确提"入账/账面/不回滚"才切 ACTUAL_PROJECT；明确提"分摊后"才看分摊后项目净利润。【选我】问"利润率/亏损项目/哪些项目亏钱/项目利润排名/经营情况总览"。【不要选我】问"**月度趋势/过去N个月/环比/收入利润变化**"→选 finance.profitTrend（带精确月度时序）；问"超支/成本拆解"→选 finance.costBreakdown。',
    requiredModule: 'finance',
    dataTables: ['projectMaster', 'rollbackProjectActual', 'actualProject', 'budgetProject'],
    handler: financeTools.profitOverview,
  },
  'finance.profitTrend': {
    name: '利润月度趋势',
    description: '【专长】按月精确聚合的收入/成本/利润时序 + 环比 + 每月 TOP 盈利/亏损项目。默认经营实际端使用 ROLLBACK_PROJECT_ACTUAL；用户明确提"入账/账面/不回滚"才切 ACTUAL_DEPT/ACTUAL_PROJECT。**任何"过去N个月/近半年/最近/趋势/逐月/环比/月度变化"类问题必选本工具**，绝对不要让 Answer LLM 从 memoryText 里手算月度数字（会有累加误差）。【选我】问"**过去3/6个月收入/利润趋势、月度变化、环比、每个月多少、逐月对比、部门收入趋势**"等。【不要选我】只问"累计/总共/本季度总共"→选 finance.profitOverview。',
    requiredModule: 'finance',
    dataTables: ['projectMaster', 'rollbackProjectActual', 'actualDept', 'actualProject'],
    handler: financeTools.profitTrend,
  },
  'finance.yoyComparison': {
    name: '普通同比分析',
    description: '【专长】基于 ACTUAL_DEPT/ACTUAL_PROJECT 的实际入账口径同比，明确区别于默认经营回滚同比表。【选我】仅在用户明确问"入账同比/账面同比/不回滚同比/普通入账口径同比"时使用。可返回单月同比、季度同比或 YTD 同比，并补充项目贡献拆解。',
    requiredModule: 'finance',
    dataTables: ['actualDept', 'actualProject'],
    handler: financeComparisonTools.yoyComparison,
  },
  'finance.rollbackDeptYoy': {
    name: '回滚部门同比',
    description: '【专长】读取 DEPT_YOY（部门层同比（回滚））的预计算结果，回答"回滚后部门同比"问题。【选我】问"回滚后部门同比/部门层同比（回滚）/回滚口径部门同比"。',
    requiredModule: 'finance',
    dataTables: ['deptYoy'],
    handler: financeComparisonTools.rollbackDeptYoy,
  },
  'finance.rollbackCompanyYoy': {
    name: '回滚公司同比',
    description: '【专长】读取 COMPANY_YOY（公司层面同比（回滚））的预计算结果，回答"回滚后公司同比"问题。【选我】问"回滚后公司同比/公司层面同比（回滚）/回滚口径公司同比"。',
    requiredModule: 'finance',
    dataTables: ['companyYoy'],
    handler: financeComparisonTools.rollbackCompanyYoy,
  },
  'finance.rollbackRevenueMom': {
    name: '回滚环比分析',
    description: '【专长】读取 REVENUE_MOM（履约收入&利润环比（回滚））并解释回滚后上月到本月的收入/利润变化。【选我】问"回滚后环比/回滚利润环比/履约收入&利润环比（回滚）"。',
    requiredModule: 'finance',
    dataTables: ['revenueMom'],
    handler: financeComparisonTools.rollbackRevenueMom,
  },
  'finance.rollbackProjectDrilldown': {
    name: '回滚项目下钻',
    description: '【专长】读取 项目层-回滚实际，并按"项目名 + 月份 + 一级部门"联 ACTUAL_PROJECT，下钻回滚影响最大的项目。【选我】问"回滚原因/哪些项目导致回滚/项目层回滚实际/分摊后项目净利润/回滚影响项目"。',
    requiredModule: 'finance',
    dataTables: ['rollbackProjectActual', 'actualProject'],
    handler: financeComparisonTools.rollbackProjectDrilldown,
  },
  'finance.rollbackHealthCheck': {
    name: '回滚经营体检',
    description: '【专长】读取 ROLLBACK_PROJECT_ACTUAL（项目层-回滚实际）并按部门/项目汇总回滚实际口径的收入、成本、利润、利润率、亏损项目与贡献项目。默认利润字段是履约利润；用户明确提"分摊后项目利润/扣除管理赋能"才使用分摊后项目净利润。【选我】问"回滚口径经营体检/回滚口径经营情况/回滚实际口径/ROLLBACK_PROJECT_ACTUAL.字段/回滚经营分析"。',
    requiredModule: 'finance',
    dataTables: ['rollbackProjectActual'],
    handler: financeComparisonTools.rollbackHealthCheck,
  },
  'finance.receivables': {
    name: '回款明细',
    description: '【专长】各项目回款进度、到期未回款、逾期笔数；本年度默认使用回款计划口径：回款计划履约额=预计首次回款时间/预计回款时间命中本年截至月的履约收入；仅当两个预计回款字段都为空时，才用实际回款时间命中本年截至月兜底。本年实际到账=实际回款时间命中本年截至月的实际回款金额，未回款=二者差额，回款率=实际到账/计划履约额。用户问"今年有回款/今年到账/今年实际收到"时可引用 projectsWithYtdReceipt 明细。【选我】问"回款/应收/逾期/催收/未回款/哪些项目有回款/哪些项目没回款"。【不要选我】问"**到款认领/银行流水**"→选 finance.pendingPaymentAnalysis；问"**开票节点/账期**"→选 finance.cycle。',
    requiredModule: 'finance',
    dataTables: ['cashflow', 'actualDept', 'budgetDept'],
    handler: financeTools.receivables,
  },
  'finance.cycle': {
    name: '结算周期',
    description: '【专长】开票/回款节点、账期、交付模式识别。【选我】问"开票周期/回款周期/账期/结算节点"。【不要选我】问"回款金额/未回款"→选 finance.receivables；问"到款认领"→选 finance.pendingPaymentAnalysis。',
    requiredModule: 'finance',
    dataTables: ['cashflow'],
    handler: financeTools.cycle,
  },
  'finance.costBreakdown': {
    name: '成本归因',
    description: '【专长】成本科目维度拆解（人力/外包/差旅/其他）及占比分析。【选我】问"成本花在哪/成本主要是什么/成本结构/部门成本拆解/超支原因"。【不要选我】问"人力成本前N项目/人力投入Top项目/FTE排名"→选 finance.laborCost；问"预算 vs 实际"→选 finance.budgetComparison（预实对比）；问"差多少/完成率"→选 finance.deviation。',
    requiredModule: 'finance',
    dataTables: ['rollbackProjectActual', 'actualProject', 'actualDept'],
    handler: financeTools.costBreakdown,
  },
  'finance.healthCheck': {
    name: '经营体检',
    description: '【专长】**综合健康评分**（满分 100）+ 多维度经营诊断一体化输出。【选我】问"**经营体检/健康度/全面体检/一季度/年度/季度经营结案/经营总览/收入+成本+利润+回款总览**"等要求"**一次性看全貌**"的综合问题，以及"**经营怎么样/今年做得怎么样**"这种开放问题。【不要选我】问"单一维度（仅利润/仅回款/仅预算）"→选对应单工具。**注**：一题内同时涉及 3+ 个财务指标时本工具是首选，不要拆成 profitOverview+receivables+budgetComparison 这种组合。',
    requiredModule: 'finance',
    dataTables: ['projectMaster', 'rollbackProjectActual', 'actualProject', 'actualDept', 'budgetProject', 'cashflow'],
    handler: financeTools.healthCheck,
  },
  'finance.laborCost': {
    name: '人力成本',
    description: '【专长】FTE 投入、人员情况/具体人名/实际精力明细、预算/实际 FTE 对比、超编、人效（人均月创收=收入/FTE）、人均月成本（人力成本/FTE）、参与人数辅助展示、按项目的人力投入 Top 排名。【选我】问"人力/FTE/人数/人头/人员情况/人员明细/具体人名/精力/预算人头/编制人数/人员投入/超编/人均创收/人效/人均成本/工时投入"，以及"人力成本前N项目/人力成本Top10项目/人力投入排名"；回答项目排名时必须引用 topProjectsByManpower，回答人员实际精力必须引用 personEffortDetail。【不要选我】问"成本科目拆解/人力外包差旅占比"→选 finance.costBreakdown；问"人员调配"→选 talent.capability。',
    requiredModule: 'finance',
    dataTables: ['actualWorktime', 'budgetWorktime', 'projectMaster', 'rollbackProjectActual', 'actualProject'],
    handler: financeTools.laborCost,
  },
  'finance.deviation': {
    name: '履约偏差',
    description: '【专长】**单指标差额/差率**计算（实际-目标/目标），输出一个数字或排行榜。【选我】问"差了多少/差多少钱/偏差多少/进度怎么样/履约偏差"，问句里通常有"**差**"字。【不要选我】问"预算执行情况/预实对比（二维表）"→选 finance.budgetComparison；问"目标完成率/达成率（百分比）"→优先选 analytics.completion。',
    requiredModule: 'finance',
    dataTables: ['rollbackProjectActual', 'actualProject', 'budgetProject'],
    handler: financeTools.deviation,
  },
  'finance.budgetComparison': {
    name: '预实对比',
    description: '【专长】**多维度（部门×项目）预实对比表**输出（整张对照表，而非单数字）。预算表唯一；默认实际端使用 ROLLBACK_PROJECT_ACTUAL 聚合，用户明确提"入账/账面/不回滚"才切 ACTUAL_DEPT/ACTUAL_PROJECT。【选我】问"预算执行情况/预算完成情况/所有部门预实/预实对比表/各项目预算 vs 实际"，问句里通常有"**预算**"字且要求"横向对比/执行/偏差/完成率"。【不要选我】问"预算是多少/1-6月预算金额/部门预算总额"→选 finance.budgetQuery；问"单项目差多少钱"→选 finance.deviation（差额）；问"完成率百分比"→选 analytics.completion。',
    requiredModule: 'finance',
    dataTables: ['budgetDept', 'budgetProject', 'rollbackProjectActual', 'actualDept', 'actualProject'],
    handler: financeTools.budgetComparison,
  },
  'finance.budgetQuery': {
    name: '预算金额查询',
    description: '【专长】**预算-only 金额查询**，按部门×月份汇总 BUDGET_DEPT 已录预算。【选我】问"预算是多少/1-6月预算/上半年预算/公司层面预算/部门预算金额/预算总额"，只要用户要预算金额本身、不问实际/偏差/完成率，就必须选我。【不要选我】问"预算执行/预实对比/偏差/完成率"→选 finance.budgetComparison。',
    requiredModule: 'finance',
    dataTables: ['budgetDept'],
    handler: financeTools.budgetQuery,
  },
  'finance.pendingPaymentAnalysis': {
    name: '到款认领分析',
    description: '【专长】**银行到款**的认领状态追踪（银行流水/未认领/按项目归属）。【选我】问"**到款认领/未认领/银行到款/银行流水/待认领款/流水里还有多少**"，问句里通常有"**认领/流水/到款**"字。【不要选我】问"客户/项目回款情况"→选 finance.receivables（应收侧）。',
    requiredModule: 'finance',
    dataTables: ['pendingPayment'],
    handler: financeTools.pendingPaymentAnalysis,
  },
  'finance.invoiceApplyAnalysis': {
    name: '发票申请分析',
    description: '【专长】发票申请、发票号、红冲、开票金额、回款金额、账期与账期分类的结构化汇总。【选我】问"发票申请/开票申请/发票号/红冲/税号/增值税/专票/普票/账期"。【不要选我】问"应收回款/逾期催收"→选 finance.receivables；问"银行到款认领"→选 finance.pendingPaymentAnalysis。',
    requiredModule: 'finance',
    dataTables: ['invoiceApply'],
    handler: financeTools.invoiceApplyAnalysis,
  },

  // ===== Risk Tools =====
  'risk.alerts': {
    name: '今日风险告警',
    description: '【专长】**当日已触发**的红/黄灯预警清单（单事件查询）。【选我】问"**有没有触发预警/红黄灯/今日告警/哪些项目触发风险/是不是亮了**"，问句里通常有"**触发/预警/红灯/黄灯**"字。【不要选我】问"**全面排查/整体体检风险**"→选 risk.checkup（多维度逐项检查）。',
    requiredModule: 'risk',
    dataTables: ['riskAlert'],
    handler: riskTools.alerts,
  },
  'risk.checkup': {
    name: '风险全面排查',
    description: '【专长】**逐项检查所有风控规则**，输出"达标/触发/缺失"全量清单（综合体检）。【选我】问"**全面排查/整体合规检查/风控规则逐项检查/风险全面体检**"，问句里通常带"**全面/整体/逐项**"。【不要选我】问"今日有没有告警（单次事件）"→选 risk.alerts。',
    requiredModule: 'risk',
    dataTables: ['riskAlert', 'riskRule', 'projectMaster', 'actualProject', 'budgetProject'],
    handler: riskTools.checkup,
  },

  // ===== Analytics Tools =====
  'analytics.completion': {
    name: '完成率分析',
    description: '【专长】**百分比形式**的目标完成率/达标率计算（如"达成了 85%"）。默认实际端使用 ROLLBACK_PROJECT_ACTUAL；用户明确提"入账/账面/不回滚"才切 ACTUAL_PROJECT。【选我】问"**完成率/达成率/达标率**是多少/目标完成情况"，问句里通常有"**率**"字。【不要选我】问"差多少钱"→选 finance.deviation（差额）；问"整体预实对比"→选 finance.budgetComparison。**注**：问"完成率"时也建议**同时搭配** finance.deviation 一起选，给用户差额+率双重视角。',
    requiredModule: 'finance',
    dataTables: ['rollbackProjectActual', 'actualProject', 'budgetProject'],
    handler: analyticsTools.completion,
  },

  // ===== Talent Tools =====
  'talent.capability': {
    name: '能力画像',
    description: '【专长】员工技能标签与"**谁会做 XX**"人才搜索。【选我】问"**谁会做 XX/挑人给 XX 项目/推荐谁/有谁具备 XX 能力/人才盘点/技能匹配**"，问句里通常有"**谁/挑/推荐/会做**"字。【不要选我】问"晋升/调薪"→选 talent.promotion；问"团队进展"→选 team.overview。',
    requiredModule: 'team',
    dataTables: [],
    handler: talentTools.capability,
  },
  'talent.promotion': {
    name: '晋升评估',
    description: '晋升/调薪评估、差距分析、团队晋升排名。适用于问晋升、调薪、涨薪、绩效评估。',
    requiredModule: 'team',
    dataTables: [],
    handler: talentTools.promotion,
  },

  // ===== Team Tools =====
  'team.overview': {
    name: '团队概况',
    description: '团队成员工作进展汇总、项目进度。适用于问团队情况、下属工作、团队日报/周报。',
    requiredModule: 'team',
    dataTables: [],
    handler: teamTools.overview,
  },

  // ===== Customer Tools =====
  'customer.analysis': {
    name: '客户经营分析',
    description: '【专长】**以客户为维度**聚合的经营分析（合作金额、SKU、合作项目、Top 客户）。【选我】问"**合作了哪些客户/客户合作金额/客户 SKU/Top N 客户/客户维度分析/行业维度客户**"，问句里通常有"**客户/行业/Top/合作**"字。【不要选我】问"签约金额（项目维度）"→选 signDelivery.overview；问"续签率"→选 signDelivery.renewal。**注**：问"Top N 客户 + 其他维度"时本工具是首选，**配合** signDelivery.renewal 或 finance.profitOverview 做维度叠加。',
    requiredModule: 'project',
    dataTables: ['customerAnalysis'],
    handler: customerTools.customerAnalysis,
  },

  // ===== 商机管线 Tools（已于 2026-04-23 下线） =====
  // 说明：LEAD_PIPELINE 是旧表，销售漏斗由 presale/bidding/signDelivery 三张
  // 新表承接。问"商机/线索/赢单率"统一路由：
  //   - 线索池/跟进中大单 → presale.pending（售前状态=进行中）
  //   - 赢单率/按负责人转化 → presale.winLoss
  //   - 中标率/中标明细/丢标原因（已投标流程）→ bidding.*

  // ===== 🟢 Presale Tools =====
  'presale.overview': {
    name: '售前管线总览',
    description: '【专长】售前漏斗**宏观统计**（各阶段项目数、部门赢单率排名、管线总量）。**注意**：历史售前 412 行，赢单状态含"赢单（自动流转签约）"，丢单状态含"竞标落选/客户终止/客户暂停/无匹配服务/陪标"，都已正确归类。【选我】问"售前管线/售前漏斗情况/售前项目有多少/售前整体情况/部门赢单率对比"。【不要选我】问"**每个负责人的赢单率/按负责人转化**"→选 presale.winLoss（有 byOwner 切片）；问"**跟进中的大单/Top N**"→选 presale.pending。',
    requiredModule: 'finance',
    dataTables: ['presale'],
    handler: presaleTools.overview,
  },
  'presale.winLoss': {
    name: '赢丢单分析',
    description: '【专长】**赢单率/丢单原因/按负责人·部门·SKU 的转化率**深度分析。已覆盖飞书【售前项目表】真实状态（赢单/竞标落选/客户终止/客户暂停/无匹配服务/陪标/未中标），输出含 byOwner（每个负责人的总数·赢·丢·跟·赢单率·赢单金额）、byDept、skuStats、wonSamples/lostSamples。**用户问"历史商机/售前转化率/按负责人/谁的赢单率高/为什么丢"都必须选我。**【选我】问"**赢单率/赢率/转化率/按负责人/每个负责人/哪个 SKU 赢率高/丢单原因/为什么丢/竞对赢了我们/历史赢单情况**"。【不要选我】问"只要总量不要率"→选 presale.overview；问"跟进中大单清单"→选 presale.pending。',
    requiredModule: 'finance',
    dataTables: ['presale'],
    handler: presaleTools.winLossAnalysis,
  },
  'presale.pending': {
    name: '跟进中大单',
    description: '【专长】**跟进中/待跟进线索**（未赢未丢）的项目明细清单，含负责人、阶段、预估金额和 staleDays 滞留天数。【选我】问"**待跟进线索/线索滞留多久/多久没有流转/跟进中的大单/Top 10 大单/重点项目有哪些/在进项目/待赢单清单**"，问句里通常有"**待跟进/滞留/没有流转/跟进中/在进/Top/重点/线索清单**"字。【不要选我】问"售前总量/管线规模"→选 presale.overview；问"赢单率"→选 presale.winLoss。',
    requiredModule: 'finance',
    dataTables: ['presale'],
    handler: presaleTools.pendingList,
  },

  // ===== 🟩 SignDelivery Tools =====
  'signDelivery.overview': {
    name: '签约交付总览',
    description: '【专长】签约交付**宏观汇总**（合同总额、履约总额、回款总额、部门/月份分布）。【选我】问"**签约量/累计签约金额/履约进度/已回款多少/签约情况总览/合同金额汇总**"，问句里通常有"**累计/总/金额是多少**"字。【不要选我】问"**哪些客户续签/续签率/客户留存**"→选 signDelivery.renewal（续约专题）；问"**逾期交付/交付延期/履约风险**"→选 signDelivery.deliveryRisk。',
    requiredModule: 'finance',
    dataTables: ['signDelivery'],
    handler: signDeliveryTools.overview,
  },
  'signDelivery.renewal': {
    name: '续约分析',
    description: '【专长】**客户续签维度**的深度分析（哪些客户续签/没续、续签金额、留存率）。【选我】问"**续签/续约/客户留存/留存率/哪些客户续签/哪些没续/老客户续签情况**"，问句里通常有"**续**"字。【不要选我】问"签约总金额/合同总览"→选 signDelivery.overview。**注**：问"老客户续签金额"时，本工具是主工具，别误选 overview。',
    requiredModule: 'finance',
    dataTables: ['signDelivery'],
    handler: signDeliveryTools.renewalAnalysis,
  },
  'signDelivery.deliveryRisk': {
    name: '交付风险',
    description: '【专长】**交付阶段的风险盘点**（逾期交付、履约不足、回款滞后）。【选我】问"**逾期交付/交付延期/履约风险/交付风险/回款滞后/履约偏差（交付侧）**"，问句里通常有"**逾期/延期/滞后/风险**"字。【不要选我】问"签约总情况"→选 signDelivery.overview；问"续签"→选 signDelivery.renewal。',
    requiredModule: 'finance',
    dataTables: ['signDelivery'],
    handler: signDeliveryTools.deliveryRisk,
  },

  // ===== ⭕ Bidding Tools =====
  'bidding.overview': {
    name: '招投标总览',
    description: '【专长】招投标**宏观统计**（中标率、投标数量、按行业/部门聚合）。【选我】问"**中标率/投标数量/招投标情况/投标成功率/招投标总览**"，问句里通常有"**率/数量/总览**"字。【不要选我】问"**哪些项目中标/中标清单/中标金额明细**"→选 bidding.wonList（明细）；问"**未中标/为什么没中标/丢标原因/废标**"→选 bidding.failure（失败专题）。',
    requiredModule: 'finance',
    dataTables: ['bidding'],
    handler: biddingTools.overview,
  },
  'bidding.failure': {
    name: '投标失败原因',
    description: '【专长】**未中标/废标**项目的原因深度分析。【选我】问"**未中标/没中标/废标/流标/为什么丢这个标/投标失败原因**"，问句里通常有"**未中/没中/废/失败**"字。【不要选我】问"**售前阶段丢单（还没到投标）**"→选 presale.winLoss；问"中标情况"→选 bidding.overview 或 bidding.wonList。**注**：问"丢标"时优先选本工具（招投标专题），不要误选 presale.winLoss。',
    requiredModule: 'finance',
    dataTables: ['bidding'],
    handler: biddingTools.failureAnalysis,
  },
  // ===== Strategy Tools =====
  'strategy.methodologyAdvisor': {
    name: '经营分析专家顾问',
    description: '【专长】当用户问"怎么解决/如何提升/为什么会这样/帮我分析/给建议/做诊断/体检+改善"等策略咨询型问题时，返回来自公司经营会的可落地方法论。【选我】问题含"怎么办/如何改善/怎么提升/分析原因/给策略/帮我诊断/怎么解决/建议/做个体检并给改善方案"，尤其是"数据异常 + 怎么办"的复合型问题必选。【配合数据工具使用】与 finance.* 等数据工具联合调用——数据工具提供数字，本工具提供行动路径。【不要选我】纯数据查询（"今年利润多少/回款情况如何"等无"如何/怎么/建议/策略/改善"的问题）。',
    requiredModule: null,
    dataTables: [],
    handler: () => {
      const content = knowhowLibrary.getFullContextForExpertMode();
      return { type: 'methodology', content, _sourceTable: '经营会议纪要方法论库（非Bitable）' };
    },
  },

  'bidding.wonList': {
    name: '中标明细',
    description: '【专长】**中标项目的 Top N 明细清单**（按中标金额排序），含客户/行业/负责人。【选我】问"**哪些项目中标/中标清单/中标明细/中了几单/中标 Top 10/中标金额明细/中了哪些**"，问句里通常有"**哪些/几单/清单/Top**"字。【不要选我】问"中标率/中标数量"→选 bidding.overview（宏观统计）；问"未中标"→选 bidding.failure。',
    requiredModule: 'finance',
    dataTables: ['bidding'],
    handler: biddingTools.wonList,
  },
};

/**
 * 根据权限 scope 过滤可用工具，返回工具 ID 列表
 */
function getAvailableTools(scope) {
  if (!scope) return [];
  const vms = scope.isGlobal
    ? null
    : new Set(scope.visibleModules || []);

  return Object.entries(TOOLS)
    .filter(([, def]) => {
      if (!def.requiredModule) return true;
      if (!vms) return true;
      return vms.has(def.requiredModule);
    })
    .map(([id]) => id);
}

/**
 * 生成 Planner LLM 可见的工具目录文本（已按权限过滤）
 */
function buildCatalogForPlanner(scope) {
  const available = getAvailableTools(scope);
  if (available.length === 0) return '（无可用工具）';

  return available.map(id => {
    const def = TOOLS[id];
    return `- ${id}: ${def.description}`;
  }).join('\n');
}

/**
 * 生成全量工具目录文本（不做权限过滤，用于并行模式下 Planner 先行规划）
 */
function buildFullCatalog() {
  const ids = Object.keys(TOOLS);
  if (ids.length === 0) return '（无可用工具）';
  return ids.map(id => `- ${id}: ${TOOLS[id].description}`).join('\n');
}

/**
 * 收集所有待调用工具的 dataTables，合并为 Set
 */
function collectDataTables(toolIds) {
  const tables = new Set();
  for (const id of toolIds) {
    const def = TOOLS[id];
    if (def && def.dataTables) {
      for (const t of def.dataTables) tables.add(t);
    }
  }
  return tables;
}

/**
 * 获取工具定义
 */
function getTool(id) {
  return TOOLS[id] || null;
}

/**
 * 列出所有工具 ID
 */
function listTools() {
  return Object.keys(TOOLS);
}

/**
 * 关键词 → 工具映射（仅用于 Planner 失败时的兜底选择）
 * 命中任意关键词即把工具加入候选。关键词贴合工具 description 中的中文术语。
 */
const TOOL_KEYWORDS = {
  'finance.profitOverview':       ['经营', '利润', '利润率', '亏损', '项目利润', '项目经营', '收入', '盈亏'],
  'finance.profitTrend':          ['趋势', '月度趋势', '过去3个月', '过去6个月', '近半年', '近几个月', '最近3个月', '最近几个月', '逐月', '月度变化', '环比', '月环比', '比上月', '比上个月', '比上季度', '环比趋势', '收入趋势', '利润趋势'],
  'finance.yoyComparison':        ['入账同比', '账面同比', '不回滚同比', '实际入账同比', '普通入账口径同比'],
  'finance.rollbackDeptYoy':      ['同比', '去年同期', '回滚后部门同比', '部门同比回滚', '部门层同比（回滚）', '回滚口径部门同比'],
  'finance.rollbackCompanyYoy':   ['公司同比', '全司同比', '回滚后公司同比', '公司同比回滚', '公司层面同比（回滚）', '回滚口径公司同比'],
  'finance.rollbackRevenueMom':   ['回滚后环比', '回滚环比', '回滚利润环比', '履约收入&利润环比（回滚）'],
  'finance.rollbackProjectDrilldown': ['回滚原因', '回滚项目', '项目层回滚', '回滚影响项目', '分摊后项目净利润'],
  'finance.rollbackHealthCheck':  ['回滚口径经营体检', '回滚口径经营情况', '回滚经营体检', '回滚经营情况', '回滚实际口径', 'ROLLBACK_PROJECT_ACTUAL'],
  'finance.receivables':          ['回款', '应收', '逾期', '催收', '未回款', '回款计划', '有回款', '到账', '实际回款', '实际到账'],
  'finance.cycle':                ['开票周期', '回款周期', '结算周期', '账期', '账期分类'],
  'finance.costBreakdown':        ['成本明细', '超支', '成本结构', '部门成本', '成本科目', '成本拆解', '外包', '差旅'],
  'finance.healthCheck':          ['体检', '健康度', '经营体检', '全面分析', '经营怎么样', '经营如何'],
  'finance.laborCost':            ['人力', '人力成本', 'FTE', '人均', '人均成本', '人均月成本', '人均创收', '人均月创收', '人效', '工时', '人数', '人头', '实际人数', '预算人数', '预算人头', '编制人数', '参与人数', '人员投入', '人员情况', '人员明细', '具体人员', '具体人名', '人名', '姓名', '精力', '精力明细', '超编', '人力成本前', '人力成本Top', '人力投入排名'],
  'finance.deviation':            ['偏差', '履约偏差', '完成vs目标', '达成率'],
  'finance.budgetComparison':     ['预实', '预实对比', '预算偏差', '预算执行', '预算完成', '完成率'],
  'finance.budgetQuery':          ['预算是多少', '1-6月预算', '一到六月预算', '上半年预算', '部门预算', '预算总额', '预算金额'],
  'finance.pendingPaymentAnalysis': ['到款认领', '未认领', '银行到款', '流水', '待认领款'],
  'finance.invoiceApplyAnalysis': ['发票申请', '开票申请', '发票号', '红冲', '增值税', '专票', '普票', '税号', '纳税人识别号', '账期'],
  'risk.alerts':                  ['告警', '预警', '红灯', '黄灯', '风险告警', '风险预警'],
  'risk.checkup':                 ['排查', '风险排查', '合规检查', '逐项检查', '风控规则', '风险规则'],
  'analytics.completion':         ['完成率', '达标率', '达成率'],
  'talent.capability':            ['能力', '技能', '擅长', '谁会', '标签', '画像', '人才盘点'],
  'talent.promotion':             ['晋升', '调薪', '涨薪', '绩效评估'],
  'team.overview':                ['团队', '下属', '团队日报', '团队周报', '团队情况'],
  'customer.analysis':            ['客户经营', '客户合作', 'SKU', '客户分析', '合作客户', '客户维度', '合作金额'],
  // 2026-04-23 下线：lead.* 工具移除（LEAD_PIPELINE 旧表废弃）
  // 原 leadPipeline 相关关键词全部映射到 presale.* / bidding.*
  'presale.overview':             ['售前', '管线', '漏斗', '售前项目', '售前漏斗', '预估签约', '售前总量', '售前规模', '商机管线', '销售漏斗', '各阶段分布', '阶段分布', '售前前置漏斗'],
  'presale.winLoss':              ['赢单率', '赢率', '转化率', '商机转化', '售前转化', '按负责人', '每个负责人', '负责人转化', '谁赢的多', '谁赢单', '历史赢单', '历史转化', '丢单', '投标失败', '丢单原因', '为什么丢', '赢单金额', '赢单/丢单', '加权金额', '商机负责人'],
  'presale.pending':              ['跟进中', '大单', '待赢单', '待跟进', '滞留', '没有流转', '未流转', '卡住多久', '重点项目', '线索', '线索池', '我的线索', '有什么线索', '有哪些线索', '手上的线索', '手上的商机', '我的商机', '商机有哪些', '商机清单', '商机明细', 'Top 商机', '重点商机', '加权金额最大', '在进商机', '在进项目'],
  'signDelivery.overview':        ['签约', '合同金额', '签约金额', '履约', '合同'],
  'signDelivery.renewal':         ['续约', '续签', '客户留存', '留存率'],
  'signDelivery.deliveryRisk':    ['交付风险', '逾期交付', '交付延期', '履约偏差', '回款滞后'],
  'bidding.overview':             ['招投标', '中标率', '投标', '中标统计'],
  'bidding.failure':              ['投标失败', '丢标原因', '废标', '流标', '为什么没中标'],
  'bidding.wonList':              ['中标', '中标清单', '中标明细', '中标金额'],
  'strategy.methodologyAdvisor':  ['怎么办', '怎么解决', '如何改善', '如何提升', '给建议', '给策略', '帮我诊断', '有什么方法', '改善方案', '怎么处理'],
};

/**
 * 按关键词选工具（仅在 Planner 失败时兜底）
 * @param {string} question - 用户问题
 * @param {object} scope - 权限 scope，用于二次过滤（可选）
 * @returns {string[]} 命中的工具 ID 列表
 */
function keywordSelectTools(question, scope) {
  if (!question || typeof question !== 'string') return [];
  const q = question.toLowerCase();
  const hits = new Set();
  for (const [toolId, kws] of Object.entries(TOOL_KEYWORDS)) {
    for (const kw of kws) {
      if (q.includes(kw.toLowerCase())) {
        hits.add(toolId);
        break;
      }
    }
  }
  const hasRollbackIntent = ['回滚', '回滚后', '回滚口径'].some((kw) => q.includes(kw));
  const hasBookedActualIntent = ['入账', '实际入账', '入账口径', '账面', '不回滚', '原始实际'].some((kw) => q.includes(kw));
  if (hasBookedActualIntent) {
    hits.delete('finance.rollbackHealthCheck');
    hits.delete('finance.rollbackDeptYoy');
    hits.delete('finance.rollbackCompanyYoy');
    hits.delete('finance.rollbackRevenueMom');
    hits.delete('finance.rollbackProjectDrilldown');
  } else {
    hits.delete('finance.yoyComparison');
    hits.delete('finance.rollbackHealthCheck');
    if (!hasRollbackIntent) {
      hits.delete('finance.rollbackProjectDrilldown');
    }
  }
  // scope 过滤
  if (scope) {
    const allowed = new Set(getAvailableTools(scope));
    return [...hits].filter(id => allowed.has(id));
  }
  return [...hits];
}

module.exports = {
  TOOLS,
  getAvailableTools,
  buildCatalogForPlanner,
  buildFullCatalog,
  collectDataTables,
  getTool,
  listTools,
  keywordSelectTools,
  TOOL_KEYWORDS,
};
