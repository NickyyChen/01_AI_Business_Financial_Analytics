/**
 * field-mapping.js - 生产表字段映射常量
 *
 * 集中定义从 Demo 表到生产表的字段名映射。
 * 所有业务模块通过此文件获取字段名，换表只改这里。
 *
 * 命名规则：
 *   INVOICE_FIELDS  → 开票、回款计划（替代回款管理）
 *   ACTUAL_PROJECT_FIELDS → 实际：项目层（替代成本明细 + 项目风险运算基础）
 *   ACTUAL_DEPT_FIELDS    → 实际：部门层（部门级成本视角）
 *   PRESALE_FIELDS        → 🟢 售前项目（替代商机管线）
 */

// ==================== 开票、回款计划 ====================
// 原"回款管理"(11行) → 生产"开票回款计划"(319行)
// 粒度从"项目级汇总"变为"项目×月份 逐笔明细"
const INVOICE_FIELDS = {
  PROJECT_KEY:       '项目',            // 项目标识（原表用"项目名称"）
  DEPT:              '一级部门',
  MONTH:             '履约月份',          // 数字格式如 2603
  REVENUE:           '履约收入',
  EXPECTED_DATE:     '预计回款时间',
  FIRST_EXPECTED:    '预计首次回款时间',
  ACTUAL_AMOUNT:     '实际回款金额',
  ACTUAL_DATE:       '实际回款时间',
  OUTSTANDING:       '已履约未回款',       // 未回金额
  PARTIAL:           '部分回款金额',
  FILLER:            '项目回款填写人',
  IS_COLLECTED:      '是否已回款',         // 是/否
  ALERT_STATUS:      '提醒判断【未回款】',  // 本月应回款 / 到期未回款 / 未到回款时间
  REVENUE_TYPE:      '收入类型',           // 基础服务费 等
  INVOICE_MATCH_DATE:'按履约匹配开票时间',
  REVENUE_INVOICE_MATCH: '收入与开票是否匹配',
  IS_SETTLED:        '款项是否结清',
  REMARK:            '【业务】备注说明',
};

// 回款提醒状态枚举
const INVOICE_ALERT = {
  DUE_THIS_MONTH: '本月应回款',
  OVERDUE:        '到期未回款',
  NOT_DUE:        '未到回款时间',
};

// ==================== 实际：项目层 ====================
// 原"成本明细"(9行) → 生产"实际：项目层"(493行)
// 粒度: 项目×月份, 成本拆解为独立科目列
const ACTUAL_PROJECT_FIELDS = {
  PROJECT_NAME:   '是否交付项目',   // 实际存放项目名（字段名历史原因）
  MONTH:          '月份',           // 数字格式如 2603
  DEPT:           '一级部门',
  STATUS:         '项目状态',
  REVENUE:        '履约收入',
  COST:           '履约成本',
  PROFIT:         '履约利润',
  LABOR_COST:     '人力成本',
  MARKET_FEE:     '市场费用',
  TAX:            '入账增值税',
  TRAVEL:         '差旅费',
  OTHER_COST:     '其他成本费用',
  PUBLIC_FUND:    '入账公共基金',
  OFFICE_COST:    '人头办公费',
  CHANNEL_FEE:    '渠道引荐费',
  OUTSOURCE:      '外包费用',
  CLIENT_SHARE:   '客户分成',
  IS_FETCH:       '是否取数',
  DEPT_TYPE:      '部门类型',
};

// 成本科目列表 — 项目层（用于 ACTUAL_PROJECT 遍历）
const COST_CATEGORIES = [
  { field: '人力成本',     label: '人力成本' },
  { field: '市场费用',     label: '市场费用' },
  { field: '外包费用',     label: '外包费用' },
  { field: '入账增值税',   label: '增值税' },
  { field: '入账公共基金', label: '公共基金' },
  { field: '人头办公费',   label: '人头办公费' },
  { field: '差旅费',       label: '差旅费' },
  { field: '渠道引荐费',   label: '渠道引荐费' },
  { field: '客户分成',     label: '客户分成' },
  { field: '其他成本费用', label: '其他费用' },
];

// 成本科目列表 — 部门层（ACTUAL_DEPT 的字段名与项目层不同）
const DEPT_COST_CATEGORIES = [
  { field: '人力成本',     label: '人力成本' },
  { field: '市场费用',     label: '市场费用' },
  { field: '外包费用',     label: '外包费用' },
  { field: '增值税',       label: '增值税' },
  { field: '公共基金',     label: '公共基金' },
  { field: '人头办公费',   label: '人头办公费' },
  { field: '差旅费',       label: '差旅费' },
  { field: '渠道引荐费',   label: '渠道引荐费' },
  { field: '客户分成',     label: '客户分成' },
  { field: '其他成本费用', label: '其他费用' },
];

// ==================== 实际：部门层 ====================
const ACTUAL_DEPT_FIELDS = {
  DEPT:           '一级部门',
  DEPT_TYPE:      '部门类型',
  MONTH:          '月份',
  REVENUE:        '履约收入',
  COST:           '履约成本',
  PROFIT:         '履约利润',
  PROFIT_RATE:    '利润率',
  LABOR_COST:     '人力成本',
  MARKET_FEE:     '市场费用',
  OUTSOURCE:      '外包费用',
  TRAVEL:         '差旅费',
  HEADCOUNT:      '人数',
  EFFICIENCY:     '人效',
  WARN_PROFIT:    '利润率低于-15%，或累计亏损超50万预警',
  WARN_REVENUE:   '较上月营收↓20%',
  WARN_EFFICIENCY:'人效低于2万预警',
  IS_WARN:        '是否预警',
  // 2026-05-08 M4 新增：回滚口径字段（实表已存在 38 列，本次补声明 5 列）
  REVENUE_ROLLBACK: '履约收入-回滚',           // 回滚分摊后的部门履约收入
  COST_ROLLBACK:    '履约成本-回滚',           // 回滚分摊后的部门履约成本
  PROFIT_ROLLBACK:  '履约利润-回滚',           // 回滚分摊后的部门履约利润
  REMAINDER_ROLLBACK: '履约剩余（回滚）',     // 回滚后剩余可用预算
  CASHFLOW_REMAINDER_ROLLBACK: '现金流剩余（回滚）',
};

// ==================== 🟢 售前项目 ====================
// 原"商机管线"(19行) → 生产"售前项目"(405行63列)
// 2026-04-17 按 XLSX 实际列补全（共 63 列，按使用频率保留核心+分析字段）
const PRESALE_FIELDS = {
  NAME:              '售前项目名称：客户+需求+期数',
  OWNER:             '售前负责人',
  DEPT:              '售前跟进部门',
  DEPT_LEADER:       '部门负责人',
  STAGE:             '售前状态',           // 赢单/跟进中/丢标 等
  IS_WON:            '是否中标',
  IS_RENEWAL:        '是否续签',
  RENEWAL_PARENT:    '续签归属的主合同',   // 续签场景下关联到主合同
  EST_SIGN_DATE:     '预估签约时间',
  EST_AMOUNT:        '预估签约金额',
  EST_WIN_RATE:      '预估赢单概率',
  EST_VALUE:         '预估售前价值',
  ACTUAL_SIGN_DATE:  '签约时间',
  ACTUAL_AMOUNT:     '签约金额',
  RATING:            '售前评级',
  CREATED:           '创建时间',
  RECORD_TIME:       '售前录入时间',
  BID_DEADLINE:      '投标截止时间',
  IS_PLANNED_WIN:    '是否计划内成交',
  IS_FINANCE:        '是否金融',
  PRESALE_GROUP:     '售前群',             // 飞书群引用
  // 客情/专业/价格维度评估（文本说明）
  CUSTOMER_EVAL:     '客情维度评估',
  EXPERTISE_EVAL:    '专业维度评估',
  PRICE_EVAL:        '价格维度评估',
  // 关联字段
  REL_CUSTOMER:      'N:1关联：客户',
  REL_CUSTOMER_KP:   'N:M关联：客户KP',
  REL_CHANNEL_KP:    'N:1关联：渠道KP',
  REL_SKU:           'N:M关联：SKU',
  REL_CAPABILITY:    'N:M关联：交付场域和能力',
  REL_COMPETITOR:    'N:M关联：本轮参与的友商',
  REL_WINNER:        'N:M关联：本轮中标方',
  REL_SIGN:          '1:1关联：签约',
  REL_LEAD:          '1:1关联：线索商机',
  // 六要素（MEDDIC-lite：时间/需求/预算/决策流程/竞争对手/联系人）
  SIX_TIME:          '1/6时间表',
  SIX_NEED:          '2/6客户问题&需求',
  SIX_BUDGET:        '3/6客户预算',
  SIX_DECISION:      '4/6决策流程',
  SIX_COMPETITOR:    '5/6竞争对手',
  SIX_CONTACT:       '6/6联系人',
  SIX_SUMMARY:       '自动汇总：六要素信息',
};

// ==================== 待认领款 ====================
// 原"回款管理"(10行) → 新增"待认领款"(1993行)
// 粒度：银行到款流水级，区分已认领/未认领
const PENDING_PAYMENT_FIELDS = {
  SERIAL:            '流水号',
  PAYER:             '收款名称',
  AMOUNT:            '银行到款金额',
  SUMMARY:           '摘要',
  UNCLAIMED:         '未认领金额',
  CLAIMED:           '认领金额',
  STATUS:            '认领状态',          // 已认领 / 未认领 / 部分认领
  REVENUE_TYPE:      '收入类型',
  DELIVERY_MONTH:    '对应履约月份',
  DEPT:              '收入归属部门',
  PROJECT_26:        '26年项目名称',
  PROJECT_25:        '25年项目名称',
  PROJECT_FINAL:     '定稿项目名称',      // 最终确认归属的项目
  POSSIBLE_PROJECT:  '识别可能的项目',
  PAY_DATE:          '到款日期',
  PAY_WEEK:          '到款周',
  PAY_MONTH:         '到款月份',
  INVOICE_NO:        '定稿发票号码',
  RECEIVER:          '收款主体',
  PERMISSION:        '权限',
  GROUP:             '群组',
};

// 认领状态枚举
const CLAIM_STATUS = {
  CLAIMED:   '已认领',
  UNCLAIMED: '未认领',
  PARTIAL:   '部分认领',
};

// ==================== 预算：部门层 ====================
const BUDGET_DEPT_FIELDS = {
  DEPT:              '一级部门',
  MONTH:             '月份',
  REVENUE:           '履约收入',
  COST:              '履约成本',
  PROFIT:            '履约利润',
  PROFIT_RATE:       '利润率',
  CF_REVENUE:        '现金流收入',
  CF_COST:           '现金流成本',
  CF_PROFIT:         '现金流利润',
  CF_PROFIT_RATE:    '现金流利润率',
  ACTUAL_REVENUE:    '履约收入-实际',     // 实际值（用于预实对比）
  BUDGET_GAP:        '预实差异',
  BUDGET_DEV_RATE:   '预实偏差率',
  IS_FORECAST:       '是否未来预测',
  DEPT_TYPE:         '部门类型',
};

// ==================== 预算：项目层 ====================
const BUDGET_PROJECT_FIELDS = {
  PROJECT_NAME:      '是否交付项目',       // 与实际项目层一致，存放项目名
  MONTH:             '月份',
  DEPT:              '一级部门',
  STATUS:            '项目状态',
  REVENUE:           '履约收入',
  COST:              '履约成本',
  PROFIT:            '履约利润',
  LABOR_COST:        '人力成本',
  TAX:               '增值税',
  TRAVEL:            '差旅费',
  OTHER_COST:        '其他成本费用',
  OFFICE_COST:       '人头办公费',
  PUBLIC_FUND:       '入账公共基金',
  OUTSOURCE:         '外包费用',
  CLIENT_SHARE:      '客户分成',
  CHANNEL_FEE:       '渠道引荐费',
  DEPT_TYPE:         '部门类型',
};

// ==================== 项目名称（唯一值） ====================
const PROJECT_NAME_UNIQUE_FIELDS = {
  CONTRACT_NAME:     '合同名',
  PROJECT_TYPE:      '项目类型',
  DEPT:              '项目归属部门',
  PROJECT_NAME_MR:   '项目名称（管报）',
  PROJECT_26:        '26年项目名称',
  PROJECT_25:        '25年项目名称',
  SIGNING_ENTITY:    '我司签约主体',
  STATUS:            '项目状态',
  SYNC_TIMESHEET:    '是否同步工时',
  PAYMENT_NOTIFIER:  '到款通知人',
  DIRECTOR:          '项目总监',
  MANAGER:           '项目经理',
  TEST_PURPOSE:      '测试用途',           // XLSX 人员字段：用于测试人员标记/提权路径
  DEPT_2:            '项目归属-二级部门',
  DEPT_3:            '项目归属-三级部门',
  DEPT_TYPE:         '部门类型',
  DEPT_HEAD:         '部门负责人',
  BP:                'bp',
  CATEGORY:          '大类',
  CUSTOMER:          '客户',
  SKU:               'sku',
  CONTRACT_AMOUNT:   '合同金额',
};

// ==================== 供应商合同管理 ====================
const VENDOR_CONTRACT_FIELDS = {
  APPLICATION_NO:    '申请编号',
  STATUS:            '申请状态',
  INITIATOR:         '发起人',
  INITIATOR_DEPT:    '发起人部门',
  PROJECT_NAME:      '项目名称',
  OUR_ENTITY:        '我方主体',
  VENDOR_NAME:       '供应商名称',
  AMOUNT:            '合同金额',
  CURRENCY:          '合同金额-币种',
  INVOICE_TYPE:      '发票类型',
  TAX_RATE:          '发票税率',
  PAYMENT_TERMS:     '付款条件',
  START_DATE:        '合同开始时间',
  END_DATE:          '合同结束时间',
  PURCHASE_DEPT:     '采购部门',
  PURCHASE_OWNER:    '采购负责人',
  PURCHASE_PURPOSE:  '采购用途',
  PROJECT_26:        '26年项目名称',
  FINAL_PROJECT:     '最终取值项目',
  IS_ENDED:          '是否为结束合作',
};

// ==================== 活水登记表 ====================
const TALENT_POOL_FIELDS = {
  NAME:              '姓名',
  LEVEL:             '职级',
  BASE:              'Base地',
  ROLE:              '岗位',
  SUPERIOR:          '直接上级',
  CURRENT_PROJECT:   '目前负责项目',
  RELEASE_TIME:      '具体释放时间',
  EXPECTED_END:      '预计完成节点',
  CURRENT_STATUS:    '目前状态',
  PROGRESS:          '进展详述',
  RELEASE_EFFORT:    '精力释放程度',
  SUPPORT_TYPE:      '支持形式',
  FINAL_TIME:        '最终完成时间',
  FINAL_STATUS:      '最终状态',
  FOLLOWUP_OWNER:    '跟进责任人',
  CAPABILITY:        '能力层级',
  PERF_HISTORY:      '过往两个季度/月度绩效结果',
  STRENGTH:          '优势简述',
  WEAKNESS:          '不足简述',
  DEV_DIRECTION:     '员工期望发展方向',
};

// ==================== 部门层同比 ====================
// 2026-05-08 M4 字段补全：表里实际有 29 列；常量原本只声明 13 列，缺 26/25 履约成本/利润
//   等关键字段，导致 rollbackDeptYoy 输出无成本/利润维度。本次补全后回滚同比可输出
//   收入/成本/利润全维度。
const DEPT_YOY_FIELDS = {
  DEPT:              '一级部门',
  DEPT_TYPE:         '部门类型',
  MONTH:             '月份',                      // 旧月份字段（很多行为空）
  MONTH_26:          '26年月份',                  // 26 年实际月份标识（如 "2604"）
  MONTH_25:          '25年月份',                  // 25 年对照月份标识（如 "2504"）
  REVENUE_26:        '26年履约收入',
  REVENUE_25:        '25年履约收入.',
  COST_26:           '履约成本',                  // 26 年履约成本（实表无年份后缀）
  COST_25:           '履约成本.',                 // 25 年履约成本（带"."后缀）
  PROFIT_26:         '履约利润',                  // 26 年履约利润
  PROFIT_25:         '履约利润.',                 // 25 年履约利润
  PROFIT_RATE_26:    '履约利润率',                // 26 年利润率
  PROFIT_RATE_25:    '履约利润率.',               // 25 年利润率
  YOY_REVENUE_GAP:   '履约收入同比增长额',
  YOY_REVENUE_RATE:  '履约收入同比增长率',
  YOY_REVENUE_DESC:  '履约收入同比增长说明',
  YOY_PROFIT_GAP:    '履约利润同比增长额',
  YOY_PROFIT_RATE:   '履约利润同比增长率',
  MOM_REVENUE_GAP:   '环比增长额',
  MOM_REVENUE_RATE:  '环比增长率',
  MOM_REVENUE_DESC:  '环比增长说明（说明本年）',
  MOM_REVENUE_GAP_25:'环比增长额.',               // 25 年同期对比的环比
  MOM_REVENUE_RATE_25:'环比增长率.',              // 25 年同期环比率
};

// ==================== 🟩 签约交付 ====================
// 2026-04-17 接入，table_id=tblAw6pgYhgeBgvr，实表 372 行 × 85 列
// 从 85 列中抽取核心 ~35 列（签约基本信息 + 续约 + 履约进度 + 关联），
// 其余场域能力矩阵字段（企业微信/小程序/视频号等）通过 GROUP_CAPABILITY_FIELDS 独立导出。
const SIGN_DELIVERY_FIELDS = {
  // 基础：签约信息
  NAME:              '签约项目名称',
  OWNER:             '签约负责人',
  DEPT:              '签约部门',
  DEPT_LEADER:       '签约部门负责人',
  DEPT_BP:           '签约部门财务BP',
  SIGN_DATE:         '签约时间',
  CONTRACT_AMOUNT:   '合同金额',
  CONTRACT_TYPE:     '合同类型',              // 主合同/补充合同/续签
  CONTRACT_START:    '合同开始日期',
  CONTRACT_END:      '合同结束日期',
  CONTRACT_ATTACHMENT: '合同附件',
  SIGNED_ATTACHMENT: '盖章版合同附件',
  NEEDS_LEGAL:       '需要法务审批',
  // 续约
  IS_RENEWAL:        '是否续签',
  RENEWAL_PARENT:    '续签归属的主合同',
  // 主体/客户
  CUSTOMER_ENTITY:   '客户签约主体',
  OUR_ENTITY:        '我司签约主体',
  TAX_NO:            '纳税人识别号',
  DUP_CUSTOMER:      '判断客户名称是否重复',
  // 履约（交付）
  PERFORMER:         '履约负责人',
  PERFORM_DEPT:      '履约部门',
  PERFORM_DEPT_LEADER: '履约部门负责人',
  PERFORM_DEPT_BP:   '履约部门财务BP',
  PERFORM_START:     '实际履约开始时间',
  PERFORM_END:       '实际履约结束时间',
  PERFORM_AMOUNT:    '履约金额',
  COLLECTED_AMOUNT:  '回款金额',
  PERFORM_GROUP:     '项目履约群',
  // 渠道
  CHANNEL_INFO:      '渠道信息',
  CHANNEL_FEE:       '渠道费用',
  CHANNEL_DESC:      '渠道比例说明',
  // 关联
  REL_CUSTOMER:      'N:1关联：客户',
  REL_CUSTOMER_KP:   'N:M关联：客户KP',
  REL_SKU:           'N:M关联：SKU',
  REL_CAPABILITY:    'N:M关联：交付场域和能力',
  REL_LEAD:          '1:1关联：线索商机',
  REL_PRESALE:       '1:1关联：售前',
  REL_REVIEW:        '🟢 复盘表',
  REL_CHANGE:        '🟢 履约增减项',
  // 元信息
  IS_FINANCE:        '是否金融',
  DATA_VERSION:      '数据版本',
  CREATED:           '创建时间',
  CREATOR:           '创建人',
  APPROVAL_CODE:     '审批实例Code',
  APPROVAL_TRIGGER:  '审批触发人',
  INTERNAL_REFERER:  '内部介绍人',
  OPS_GROUP:         '部门经营群',
  MONTHLY_ENABLED:   '月报是否开启',
  PARTICIPANT_COUNT: '参与员工数',
  PARTICIPANT_LIST:  '🔵项目参与员工',
  CAPABILITY_MAP:    '员工能力地图',
  CAPABILITY_DESC:   '项目人员能力说明',
  // 场域能力（旧版）
  LEGACY_CAPABILITY: '交付场域和能力（旧版）',
};

// ==================== 商机管线（售前前置漏斗） ====================
// 2026-04-23 接入，table_id=tblztxNuZDjRTcv4，实表 14 列
// 粒度：客户品牌 × 商机阶段，位于售前项目之前，属于漏斗最前端
// 字段特性：
//   - 预估签约金额/加权金额 存储单位为"万"（不是元）；口径展示时保留原单位
//   - 赢率(%) 存储为 0~1 的小数（如 0.3 = 30%）
//   - 商机负责人/协作人员/竞争对手/丢标原因 均为自由文本
const LEAD_PIPELINE_FIELDS = {
  CUSTOMER_BRAND:  '客户品牌',
  INDUSTRY:        '品牌行业',
  OWNER:           '商机负责人',
  COLLABORATORS:   '协作人员',
  EST_AMOUNT_WAN:  '预估签约金额(万)',
  STAGE:           '商机阶段',
  WIN_RATE:        '赢率(%)',
  START_DATE:      '开始跟进日期',
  EST_SIGN_DATE:   '预计签约时间',
  LATEST_PROGRESS: '最新进展',
  UPDATE_DATE:     '更新日期',
  COMPETITOR:      '竞争对手',
  LOSS_REASON:     '丢标原因',
  WEIGHTED_WAN:    '加权金额(万)',
};

// ==================== ⭕ 招投标 ====================
// 2026-04-17 接入，table_id=tblsY02GCG9oM4Cn，实表 318 行 × 54 列
const BIDDING_PROJECT_FIELDS = {
  // 基础
  CUSTOMER:          '客户/品牌',
  INDUSTRY:          '行业',
  TYPE:              '类型',              // 投标/议标/竞争性磋商 等
  DEPT:              '项目部门',
  OWNER:             '负责人',
  PROJECT_NAME:      '项目名称',
  SKU:               'SKU',
  MONTH:             '月份',              // 26年4月 形式
  SUBMIT_METHOD:     '投递方式',          // 多选：电子投标/邮件/邮寄
  PROGRESS:          '进度',              // 报名/开标/公示/已中标/已废标 等
  ENROLL_CONFIRM:    '报名/确认',
  FINISH_TIME:       '完成时间',
  DEADLINE:          '截止/开标时间',
  // 结果
  BID_RESULT:        '投标结果',          // 中标/未中标/废标/流标
  RESULT_REASON:     '中标/未中标原因',
  BID_PARTICIPANTS:  '参标单位',
  WINNER:            '中标单位',
  BID_SUBJECT:       '招标主体',
  OUR_SUBJECT:       '投标主体',
  COOP_PERIOD:       '合作期限',
  PRICE_CEIL:        '最高限价',
  BID_AMOUNT:        '报价金额',
  FINAL_AMOUNT:      '金额',              // 中标金额（最终成交）
  // 评分项（多选枚举）
  QUAL1:             '资质1',
  QUAL2:             '资质2',
  CASE1:             '案例1',
  CASE2:             '案例2',
  TEAM1:             '团队1',
  TEAM2:             '团队2',
  TECH_SCORE:        '技术分',
  BUSINESS_SCORE:    '商务分',
  PRICE_SCORE:       '价格分',
  // 附件
  BID_DOC:           '招标书',
  BRIEF:             'Brief',
  QUOTE_TEMPLATE:    '报价模版',
  BID_SUBMIT_DOC:    '投标书',
  PLAN_DOC:          '方案',
  QUOTE_DOC:         '报价文件',
  VENDOR_DOC:        '供应商信息表',
  // 费用/付款
  AMOUNT:            '金额',
  PAYMENT_DEADLINE:  '付款截止时间',
  PAYMENT_FINISHED:  '付款完成时间',
  PAYMENT_PROOF:     '付款凭证',
  REFUND_TIME:       '退回时间',
  DOC_PURCHASE:      '标书购买',
  PAPER_DOC:         '纸质标书',
  BID_AGENT:         '招标代理',
  FEE:               '费用',
  PLATFORM:          '投标平台',
  ADDRESS:           '地址',
  SERIAL:            '单号',
};

// ==================== 实际：26年工时（替代 PROJECT_STAFFING） ====================
const ACTUAL_WORKTIME_FIELDS = {
  ROW_ID:            '序号',
  DEPT:              '一级部门',
  DEPT_2:            '二级部门',
  MONTH_RAW:         '月份',              // 时间戳
  MONTH:             '月份-转换',          // 4位数字如 2601
  NAME:              '姓名',              // 纯文本
  PROJECT_NAME_RAW:  '标准项目名称新',     // 可能含多个以+分隔
  FTE:               '精力',              // 0~1
  DEPT_MR:           '管报-一级部门（手工）', // 管报归属部门
  PROJECT_STATUS:    '项目状态',           // lookup 数组
  PROJECT_MATCH:     '匹配项目',           // lookup 数组（替代旧表"项目唯一值"）
  IS_DUAL:           '是否兼职人员',
  IS_CALC_EFF:       '是否计算人效',
  REF_REVENUE:       '引用履约收入',
  PERSONAL_REVENUE:  '个人收入业绩',
};

// ==================== 工具函数 ====================

/**
 * 安全读取记录字段，返回数值（0 兜底）
 */
function num(fields, key) {
  const v = fields[key];
  if (v == null || v === '') return 0;
  return Number(v) || 0;
}

/**
 * 安全读取记录字段，返回字符串
 */
function str(fields, key) {
  const v = fields[key];
  if (v == null) return '';
  return String(v).trim();
}

/**
 * 从 实际：项目层 记录中提取各科目成本，返回 { label: amount } 对象
 * ⚠️ 非零过滤：只保留 amt !== 0 的科目，用于 costStructure 等"按占比展示"的场景。
 * 若需要"字段存在性检测"（区分"无此字段"与"值为 0"），请改用 extractAllCostCategories。
 */
function extractCostBreakdown(fields) {
  const result = {};
  for (const cat of COST_CATEGORIES) {
    const amt = num(fields, cat.field);
    if (amt !== 0) result[cat.label] = amt;
  }
  return result;
}

/**
 * 从 实际：项目层 记录中提取 COST_CATEGORIES 里**全部**科目（包括 0 值），
 * 返回 { label: amount } 对象。
 *
 * 2026-04-23 新增：为修复"Agent 误把'当前值为 0 的科目'当成'系统没有这个科目'" (Q2)。
 * 调用方若要判断"某科目在当前数据源里是否有录入（非零）"，看 amount !== 0；
 * 若要判断"表里是否有这个字段列"（schema 层），请信任 COST_CATEGORIES 定义本身。
 */
function extractAllCostCategories(fields) {
  const result = {};
  for (const cat of COST_CATEGORIES) {
    result[cat.label] = num(fields, cat.field);
  }
  return result;
}

/**
 * 解析 4 位月份字符串（如 "2603"）为 { year, month }
 * 容错：如果传入 6 位如 "202603"，也能正确解析
 */
function parseMonth4(val) {
  const s = String(val || '').trim();
  if (s.length === 4) return { year: 2000 + Number(s.slice(0, 2)), month: Number(s.slice(2)) };
  if (s.length === 6) return { year: Number(s.slice(0, 4)), month: Number(s.slice(4)) };
  return { year: 0, month: 0 };
}

/**
 * 从 Bitable lookup（type=4）字段提取第一个文本值
 * lookup 字段值为数组如 ["项目A"] 或 [{text:"项目A"}]
 */
function lookupFirst(val) {
  if (!val) return '';
  if (Array.isArray(val)) {
    const first = val[0];
    if (!first) return '';
    if (typeof first === 'string') return first;
    if (first.text) return first.text;
    return String(first);
  }
  return String(val);
}

module.exports = {
  INVOICE_FIELDS,
  INVOICE_ALERT,
  ACTUAL_PROJECT_FIELDS,
  ACTUAL_DEPT_FIELDS,
  COST_CATEGORIES,
  DEPT_COST_CATEGORIES,
  PRESALE_FIELDS,
  LEAD_PIPELINE_FIELDS,
  SIGN_DELIVERY_FIELDS,
  BIDDING_PROJECT_FIELDS,
  PENDING_PAYMENT_FIELDS,
  CLAIM_STATUS,
  BUDGET_DEPT_FIELDS,
  BUDGET_PROJECT_FIELDS,
  PROJECT_NAME_UNIQUE_FIELDS,
  ACTUAL_WORKTIME_FIELDS,
  VENDOR_CONTRACT_FIELDS,
  TALENT_POOL_FIELDS,
  DEPT_YOY_FIELDS,
  num,
  str,
  extractCostBreakdown,
  extractAllCostCategories,
  parseMonth4,
  lookupFirst,
};
