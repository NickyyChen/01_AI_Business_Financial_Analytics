/**
 * knowhow-library.js - 经营策略知识库
 *
 * 从真实经营会会议纪要中提炼的「问题模式 → 解决策略」映射。
 * 注入 LLM 系统提示词，让 AI 在分析经营问题时给出真正可落地的建议，
 * 而非泛泛而谈的通用话术。
 *
 * 数据来源：
 *   - 健康美学经营会（双周会）2026-04-13
 *   - 零售部门4月月会 2026-04-14
 *   - 公域生态行业群3月经营分析会 2026-04-16
 *   - 2026年6月3日-9日 5月经营会新增记录
 *
 * 维护方式：
 *   每次经营会后，将新的解决策略追加到对应分类下。
 *   策略条目越具体越好——带真实案例的策略比抽象原则有效 10 倍。
 */

// ==================== 策略知识库 ====================

const KNOWHOW_CATEGORIES = [
  {
    id: 'cost_overrun',
    pattern: '人力成本过高 / 费率超标',
    trigger: '人力成本费率超过55%，或人力成本占比远高于行业参考线',
    keywords: ['人力成本', '费率', '成本过高', '成本超标'],
    strategies: [
      '与客户采购友好深入沟通，了解其他服务商报价作参照，争取调整报价',
      '评估用低成本人员（实习生/助理）替代交付，降低单人成本',
      '分析是"报价低"还是"投入多"——报价低要谈价，投入多要提效',
      '若客户拒绝调价且持续亏损，评估终止合作的止损方案',
    ],
    case: '无限极UGC人力费率72%（参考线50-55%）：与采购沟通了解同行报价，尝试低成本人员交付或提升效率',
  },
  {
    id: 'persistent_loss',
    pattern: '项目持续亏损',
    trigger: '项目连续2个月以上利润率为负，或全年净利率低于-20%',
    keywords: ['亏损', '利润率', '盈亏', '净利'],
    strategies: [
      '制定具体盈利方案（非泛泛的"降本"）并与交付负责人确认可行性',
      '拆解成本结构找到最大出血点——是外协、人力还是管理费摊',
      '与客户协商提价，拿不到提价就压缩外协成本',
      '挖掘产品潜力提高单场/单客产出，而非只砍成本',
      '设定止损线——明确"如果X月仍亏损Y万就终止/调整"',
    ],
    case: '农夫山泉Y25全年净利率-69%：与客户协商提价或压缩外协成本，不提价则考虑终止',
  },
  {
    id: 'renewal_risk',
    pattern: '续约/续签风险',
    trigger: '项目即将到期且续签未确认，或客户提出缩量/降价',
    keywords: ['续约', '续签', '到期', '缩量', '降价谈判'],
    strategies: [
      '两人配合谈判（一人唱红脸一人唱白脸），避免单人谈崩',
      '提前准备续约资料，梳理服务价值亮点和客户认可的成果',
      '与客户沟通调整价格和验收标准，双方各退一步',
      '先模拟客户可能提出的问题，做沟通预演',
      '项目总监至少月度介入客户回顾会，对续约和升单单独讨论',
      '同时服务公域和私域的客户，续约前必须单独拉账分析公/私域盈利，分别制定续约策略（不能用整体利润掩盖单侧亏损）',
    ],
    case: '无限极矩阵客户认为人力不够：两人配合谈判，沟通调整价格与验收标准',
  },
  {
    id: 'revenue_gap',
    pattern: '履约收入缺口 / 签约不足',
    trigger: '月度/季度履约额明显低于目标，或全年存在大额签约缺口',
    keywords: ['收入缺口', '签约不足', '目标差距', '签约缺口', '履约缺口'],
    strategies: [
      '盘点全部商机管线，按"已投标/意向/待投入"分级制定跟进计划',
      '挖掘存量客户的升单/增购机会（比新签更快见效）',
      '评估在谈商机的保守预估金额，设定最低目标线',
      '对履约缺口大的月份提前调配资源，避免人力闲置',
    ],
    case: '健康美学全年缺口415万：盘点14个商机（保守631万），区分已投标/意向/待投入分级跟进',
  },
  {
    id: 'collection_overdue',
    pattern: '回款逾期 / 现金流风险',
    trigger: '有项目回款逾期超60天，或PO未到手已垫资',
    keywords: ['回款', '逾期', '未回款', '现金流', '垫资', '欠款'],
    strategies: [
      '先诊断逾期原因：验收卡点？客户资金问题？开票延误？内部流程慢？',
      '验收卡点 → 推动验收材料交付，加速客户签收',
      '客户资金问题 → 联系客户财务确认付款排期，必要时法务介入',
      '内部流程慢 → 提前准备验收资料，推动合同审批和开票流程',
      'PO未到手 → 与财务同步风险，预估最差情形（金额缩减/延期），明确时间线',
      '新合同卡在客户侧合规流程（如供应商评分表、资质审核）时，主动补齐材料推动客户内部流程，别被动等',
    ],
    case: '农务项目一期回款延迟：合同未走完影响开票，需提前准备验收资料并推动内部流程',
  },
  {
    id: 'team_efficiency',
    pattern: '人效低下 / 人力闲置',
    trigger: '人均创收低于2万，或成熟项目人力未释放',
    keywords: ['人效', '人力闲置', '人均创收', '效率低'],
    strategies: [
      '成熟项目（服务2年以上）要求释放人均30%以上精力，与AI提效结合',
      '项目间主动做人力活水调配，别等人闲了才动',
      '根据项目履约交付情况提前预估人力需求，而非事后补救',
      '降低客服/销售成本可用灵活用工，但要筛选梯队备选、准备替换方案',
    ],
    case: '味全/蒙牛山姆等成熟项目：释放人均30%精力用于新项目或AI提效，Q2量化考核',
  },
  {
    id: 'outsource_opaque',
    pattern: '外包费用不透明 / 超支',
    trigger: '外包费用责任人不清，或外包占比异常偏高',
    keywords: ['外包', '外协', '外包费用', '外协成本'],
    strategies: [
      '明确外包费用的责任人——谁签的单谁负责',
      '拆解外包费用构成（设计/内容/达人/投放等），找到最大头',
      '设定外包占项目收入的比例上限，超出需审批',
      '评估是否可以用内部团队替代部分外包（尤其是高频重复任务）',
    ],
    case: '农本方外包费用不清：要求明确责任人和构成，控制在一定比例以内',
  },
  {
    id: 'price_reduction',
    pattern: '客户压价 / 合同单价下调',
    trigger: '新合同单价较旧合同下降超过10%，或客户要求浮动费用占比增加',
    keywords: ['压价', '单价下调', '降价', '浮动费用'],
    strategies: [
      '寻找升单机会点弥补差额——新增服务模块、新渠道运营',
      '用AI产研/工具侧创造新价值，让客户看到提效收益',
      '评估浮动费用的风险敞口——最差情况下利润率是否可控',
      '对接外部工具（如微伴等）实现功能补充，降低人力依赖',
    ],
    case: '山姆新合同单价从30万降至24万：寻找升单机会，回归AI产研工具创造新价值',
  },
  {
    id: 'team_turnover',
    pattern: '团队人员变动 / 关键岗位空缺',
    trigger: '核心人员离职/调走/产假，或新人接手不了解业务',
    keywords: ['离职', '人员变动', '关键岗位', '产假', '调岗'],
    strategies: [
      '写排雷方案——列出受影响的交付项和交接清单',
      '尽快完成新人的BD流程/业务知识培训，缩短适应期',
      '物色具备相关经验的候选人（内部活水或外部招聘），储备人力不能临时抱佛脚',
      '关键岗位提前做备份计划——谁能顶？需要多久上手？',
      '利用实习生渠道（学校分享/招聘会）补充特定岗位',
    ],
    case: '沃尔玛两人调走，新人不了解BD流程：写排雷方案，加速新人培训，多输出内容提高方案质量',
  },
  {
    id: 'cost_structure_optimization',
    pattern: '费用产出比失衡 / 无效支出',
    trigger: '某类费用占比远超价值产出，如复盘材料费用占比过高',
    keywords: ['费用产出比', '无效支出', '费用占比', '费用优化'],
    strategies: [
      '控制低产出类目的数量（如减少复盘数量），把预算转向高产出方向',
      '考虑转换输出形式降本——KOS视频/公众号长文/小红书UGC通常比深度报告便宜',
      '提前预估Q2各项费用，主动做方向调整而非被动超支',
      '帮客户算清楚费用优化后的ROI，用数据说服而非空谈',
    ],
    case: '蒙牛行销复盘材料费用90万+：控制复盘数量，转换输出形式（KOS视频/小红书UGC）降本',
  },
  {
    id: 'long_settlement_cycle',
    pattern: '结算周期过长 / 开票回款节奏慢',
    trigger: '从履约到回款周期超过3个月，或开票节点长期未到达',
    keywords: ['结算', '开票', '账期', '回款周期', '回款节点', '开票节点'],
    strategies: [
      '与客户协商缩短付款账期（注意：具体账期以各项目合同约定为准，不同项目可能不同）',
      '对连续交付项目，推动按季度集中开票而非年底一次性开票，分散回款压力',
      '评估是否存在验收卡点导致开票延迟——验收材料不齐？客户审批慢？内部流程卡？',
      '提前准备验收资料，推动客户签收，缩短从交付到开票的周转时间',
      '将结算周期纳入合同谈判条款，新签合同明确开票节点和付款周期',
    ],
    case: '某项目连续3个月交付后集中开票，回款周期达4个月：推动按月交付按季开票，回款周期缩短至2个月',
  },
  {
    id: 'reporting_integrity',
    pattern: '履约报账口径偏差 / 管理会计真实性',
    trigger: '项目报账出现"费用与收入重复计入"，或入账方式与实际付出不一致导致盈亏失真',
    keywords: ['报账', '口径', '管理会计', '重复计算', '入账', '履约报账', '真实利润'],
    strategies: [
      '按管理会计原则记账；入账方式与实际付出不一致时必须在备注里写清真实情况',
      '履约报账前核对口径，避免"费用和收入重复计入"造成虚假亏损或虚假盈利',
      '月度回溯外包费用按月入账情况，一次性支出单独标注，避免被误判为经常性亏损',
      '月度盈亏出现反常波动时，优先排查报账口径问题，再看业务实质',
    ],
    case: '雅培项目1月盈利1万、2-3月亏损，经排查是项目经理在报履约时"费用和收入重复计入"导致虚假亏损；调整口径后实际可赚取服务费',
  },
  {
    id: 'nonstandard_session_billing',
    pattern: '非标场次单独结算 / 大客户专题活动计费',
    trigger: '大客户临时新增的专题直播/活动若套用标准服务费提成规则会亏损，或非标场次被裹在标准服务费里扭曲月度盈亏',
    keywords: ['非标场次', '大厂直播', '专题活动', '单独结算', '服务费', '提成', '取高'],
    strategies: [
      '标准直播业务明确结算规则（如"成交提成或时长×N取高"），小场次按标准执行',
      '大客户非标场次（专题直播、品牌大厂活动）不套标准提成，按月度服务费 + 活动提成分离结算',
      '结算规则订立前，用预估GMV反推"按标准规则是否会亏损"，提前设保护条款',
      '当月有非标场次时，把非标场次的成本/收入单独挂账，避免扭曲月度服务成本费率',
    ],
    case: '3月服务商直播按"成交8%或时长×3取高"正常结算，外包5.8万；4/1大厂直播收入36,000元若按8%提成会亏损，改为月度服务费 + 提成单独处理，增收2万多确保当月不亏',
  },
  {
    id: 'service_scope_control',
    pattern: '新业务承接决策 / 业务边界控制',
    trigger: '客户要求拓展新业务模块（尤其投放类），或客户只告知结果不愿给细节的业务线',
    keywords: ['投放', '新业务', '承接', '业务边界', '拉齐节奏', 'ROI', '承接决策'],
    strategies: [
      '优先复制已验证的纯模式（如纯视频号直播 + 少量小店），降低在新项目上踩坑成本',
      '客户只告知ROI结果但不提供细节的业务（典型如投放），谨慎承接，先与客户拉齐投放节奏和口径',
      '以可控高毛利模块（达人种草 / 带货 / 视频号直播）为主，不主动承接投放等高风险强竞争业务',
      '承接前评估"收益 vs 风险敞口"——客户认可成果但我方不掌握细节 = 承担结果风险',
    ],
    case: '雅培项目主打达人种草 + 带货 + 视频号直播 + 少量小店，不承接投放业务；客户阶段性告知投放ROI但不给细节，决定先拉齐节奏再议',
  },
  {
    id: 'customer_sku_portfolio_focus',
    pattern: '客户与SKU组合优先级 / 好客户画像',
    trigger: '收入依赖头部客户、签约主要来自老客户续约、SKU单一，或大客户/大金额项目利润和回款质量不佳',
    keywords: ['好客户', '客户结构', 'SKU', '头部项目', '老客户依赖', '大单拓展', '低利客户', '升单'],
    strategies: [
      '好客户不是合同金额大，而是同时满足：履约稳定、SKU可复用、净利率不低于部门目标、回款周期可控、老客户能升单、不可控成本低',
      'Top客户按"加码、维持、调整、退出"四类管理；高利客户升单要绑定回款节点和交付边界，低利客户必须改报价/范围',
      '签约进度看似超前时，拆开看老客户续约、新项目签约、大单能力和SKU能力，避免被签约总额掩盖结构问题',
      'KOL/KOC/达人/种草按达人、激励、渠道成本上限和效果证明决定是否扩大规模，不能一刀切砍掉',
      '视频号/直播/短视频低价代运营暂停扩张，优先转专项、培训、投流或要求客户补预算',
    ],
    case: '2026年5月公司整体校准提出客户/SKU分层：高利项目可续签/升单但绑定回款节点和交付边界；零售事业群签约金额大于时间进度但主要依赖老客户续约，新项目和会员运营SKU不足，需把大单拓展和SKU能力单独治理',
  },
  {
    id: 'platform_channel_leverage',
    pattern: '平台合作 / 达人投流渠道杠杆',
    trigger: '团队要开新客、拓展公域/投流/达人业务，或客户需求涉及平台资源、KOS/达人、小红书/抖音/视频号等新渠道',
    keywords: ['投流', '平台合作', '达人', 'KOS', 'KOC', '小红书', '抖音', '视频号', '渠道杠杆', '官方平台', '垂类业务'],
    strategies: [
      '投流是深技能业务，若公司业务量级不足以稳定养投手，可先找外部服务商合作，保留客户关系和方案整合权',
      '新渠道试错要分类各选一个目标客户快速尝试，验证开户、资质、投放素材、达人建联、成交转化，再决定是否放大',
      '利用平台官方、内部同事关系和客户名单做定向建联，不要只等平台推荐客户清单',
      '达人合作要聚焦垂类、头部达人和可共创货盘，形成渠道专供或行业解决方案',
      '内容线案例要产品化，整理项目背景、故事线、投放人群、预算、时间线和调优方案，再定向发给目标客户收集反馈',
    ],
    case: '公域5月经营会要求将雅培案例整理成PR和销售材料，用AI结合项目内容在CM系统匹配目标客户，同时对接小红书官方平台确认入驻资质；各业务负责人季度交流提出投流可借外部服务商补投手能力',
  },
  {
    id: 'project_exit_redline',
    pattern: '亏损/低利项目去留 / 报价边界',
    trigger: '项目净利率低于部门目标、连续亏损、已履约未回款高，或客户/项目只能贡献规模但不能贡献利润与现金',
    keywords: ['低利项目', '项目去留', '报价边界', '利润红线', '停止交付', '冻结投入', '缩范围', '涨价', '退出'],
    strategies: [
      '每个亏损或低利项目先回答"继续做的前提是什么"：收入、利润、回款、战略价值四项至少要满足两项，答不出就不默认续做',
      '停止按旧报价新增交付，必须给出涨价、降本、缩范围、冻结新增投入或停止合作的明确动作',
      '续约/升单前强制出项目净利率和回款率红线，不能让大客户/大金额掩盖低利或现金风险',
      '非核心、内部、冲减项要单列清账和判断，不进入常规高利润/低利润排名',
      '经营会只讨论处置动作，不重复讲背景；决议必须有Owner、DDL和验收口径',
    ],
    case: '2026年5月公司整体校准将农夫山泉、雅培视频号、无限极、京东纯佣、美的、天猫优品、安德玛、山姆等低利或亏损项目列入去留判断：停、留、涨价、降本、冻结新增投入必须明确',
  },
  {
    id: 'annual_forecast_calibration',
    pattern: '年度目标缺口 / 滚动预测校准',
    trigger: '年度/月度目标进度落后，后续预测与历史惯性差距大，或部门预测偏差连续较高',
    keywords: ['年度目标', '目标缺口', '滚动预测', '预测偏差', '时间进度', '补缺', '月度预测', '目标倒推'],
    strategies: [
      '同时看历史惯性、滚动保守、滚动基准和目标倒推四种场景，避免只拿乐观预测证明目标能完成',
      '年度缺口要拆到客户/项目来源、预计签约节点、预计履约月份、利润率和回款节点，不能只报补缺总额',
      '预测准确率要分月管理：下月预测尽量接近95%以上准确，下下月保持85%-90%准确，偏差大的部门单独复盘',
      '目标倒推要求下半年月均显著抬升时，必须同步满足新增大客户、高复用SKU和低利项目退出',
      '月结未定稿时，用"已定稿月份 + 当月滚动 + 未来预算/预测"口径，并明确标注数据状态',
    ],
    case: '2026年5月公司整体校准显示，按1-5月历史惯性年化收入和利润大概率无法达成年目标；各业务负责人季度交流也指出不同部门预测偏差差异大，需要每月校准下月和下下月预测准确度',
  },
  {
    id: 'business_caliber_operating_literacy',
    pattern: '项目经营口径 / PM经营意识',
    trigger: 'PM不清楚收入构成、成本归属、奖金与回款关系，或因代垫/平进平出/工时/外包计提导致报表虚高虚低',
    keywords: ['经营意识', '收入构成', '成本结构', '工时', '代垫', '平进平出', '公共基金', '奖金', '计提', '成本归属'],
    strategies: [
      'PM必须理解项目怎么赚钱：固定服务费、CPS、增购、工具采买、代垫/平进平出分别如何影响规模、公共基金、税费和毛利',
      '代垫和平进平出费用一般不算收入；若为了规模纳入收入，要同步测算公共基金、税费和分摊对毛利的侵蚀',
      '工时、灵活用工、外包团队、渠道费、客户餐、出差、场地分摊等成本要当月归属，当月确认',
      '拿捏不准的费用及时同步财务计提，避免到结算才发现预算超支或利润虚高',
      '项目奖金要和利润、回款、售前参与、增购推进、跨项目支持等经营贡献挂钩，不能只按忙碌程度分配',
    ],
    case: '零售事业群6月月会系统梳理项目经营要素：收入类型包括固定服务费、CPS、增购和工具采买，成本端要求工时、灵活用工、外包和各类费用准确归属，项目奖金也提高利润权重并依据回款逐月发放',
  },
];

// ==================== 格式化输出 ====================

/**
 * 将知识库格式化为注入系统提示词的文本
 * 智能匹配：只注入与用户问题最相关的分类（最多3个），大幅节省 token
 *
 * @param {string|null} question - 用户原始问题，用于判断是否相关
 * @param {Set<string>|null} plannedTables - planner 选出的表集合
 * @returns {string} 提示词文本，空串表示不注入
 */
function formatForPrompt(question, plannedTables) {
  if (!shouldInject(question, plannedTables)) return '';

  const MAX_CATEGORIES = 3;
  const relevant = _selectRelevant(question, MAX_CATEGORIES);

  if (relevant.length === 0) return '';

  const lines = [
    '===== 经营策略参考（来自经营会实操经验，仅在给建议时参考）=====',
    '注意：以下策略是建议方向，不是公司制度或规则。回答数据类问题时严格基于系统数据，不要将策略建议混淆为公司规则。',
    '',
  ];

  for (const cat of relevant) {
    lines.push(`【${cat.pattern}】`);
    lines.push(`  触发: ${cat.trigger}`);
    for (const s of cat.strategies) {
      lines.push(`  • ${s}`);
    }
    lines.push(`  案例: ${cat.case}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 按关键词相关度选出最匹配的分类
 */
function _selectRelevant(question, maxCount) {
  if (!question) return KNOWHOW_CATEGORIES.slice(0, maxCount);

  const scored = KNOWHOW_CATEGORIES.map(cat => {
    let score = 0;
    for (const kw of (cat.keywords || [])) {
      if (question.includes(kw)) score += 2;
    }
    if (question.includes(cat.pattern.split('/')[0].trim())) score += 1;
    return { cat, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.filter(s => s.score > 0).slice(0, maxCount).map(s => s.cat);
}

/**
 * 判断是否需要注入知识库
 * 只在经营/财务相关场景注入，避免回答"今天有什么会"时也带一大段
 */
function shouldInject(question, plannedTables) {
  if (plannedTables) {
    const financeKeys = ['projects', 'performance', 'cashflow', 'risk'];
    for (const key of financeKeys) {
      if (plannedTables.has(key)) return true;
    }
  }

  if (question) {
    const FINANCE_PATTERNS = /经营|利润|亏损|成本|回款|逾期|预警|风险|人效|人力|续约|续签|履约|偏差|盈亏|体检|健康度|项目分析|怎么解决|怎么办|建议|策略|方案|开票周期|回款周期|结算周期|开票节点|回款节点|年度目标|目标缺口|滚动预测|预测偏差|低利项目|项目去留|报价边界|客户结构|SKU|待认领|经营意识|收入构成|成本结构/;
    if (FINANCE_PATTERNS.test(question)) return true;
  }

  return false;
}

/**
 * 根据具体的指标异常，返回最相关的策略条目（用于代码模板路径）
 * @param {object} indicators - { lossProjects, overdueAR, highCostRate, revenueGap, lowEfficiency }
 * @returns {Array<{ pattern, strategies, case }>} 匹配到的策略
 */
function matchStrategies(indicators = {}) {
  const matched = [];
  if (indicators.lossProjects > 0) {
    matched.push(KNOWHOW_CATEGORIES.find(c => c.id === 'persistent_loss'));
  }
  if (indicators.overdueAR > 0) {
    matched.push(KNOWHOW_CATEGORIES.find(c => c.id === 'collection_overdue'));
  }
  if (indicators.highCostRate) {
    matched.push(KNOWHOW_CATEGORIES.find(c => c.id === 'cost_overrun'));
  }
  if (indicators.revenueGap) {
    matched.push(KNOWHOW_CATEGORIES.find(c => c.id === 'revenue_gap'));
  }
  if (indicators.lowEfficiency) {
    matched.push(KNOWHOW_CATEGORIES.find(c => c.id === 'team_efficiency'));
  }
  if (indicators.renewalRisk) {
    matched.push(KNOWHOW_CATEGORIES.find(c => c.id === 'renewal_risk'));
  }
  if (indicators.outsourceOpaque) {
    matched.push(KNOWHOW_CATEGORIES.find(c => c.id === 'outsource_opaque'));
  }
  if (indicators.priceReduction) {
    matched.push(KNOWHOW_CATEGORIES.find(c => c.id === 'price_reduction'));
  }
  if (indicators.teamTurnover) {
    matched.push(KNOWHOW_CATEGORIES.find(c => c.id === 'team_turnover'));
  }
  if (indicators.longSettlementCycle) {
    matched.push(KNOWHOW_CATEGORIES.find(c => c.id === 'long_settlement_cycle'));
  }
  if (indicators.lowMarginProjects || indicators.exitRedline) {
    matched.push(KNOWHOW_CATEGORIES.find(c => c.id === 'project_exit_redline'));
  }
  if (indicators.targetGap || indicators.forecastGap) {
    matched.push(KNOWHOW_CATEGORIES.find(c => c.id === 'annual_forecast_calibration'));
  }
  if (indicators.customerConcentration || indicators.skuRisk) {
    matched.push(KNOWHOW_CATEGORIES.find(c => c.id === 'customer_sku_portfolio_focus'));
  }
  if (indicators.caliberIssue || indicators.operatingLiteracy) {
    matched.push(KNOWHOW_CATEGORIES.find(c => c.id === 'business_caliber_operating_literacy'));
  }
  return matched.filter(Boolean);
}

/**
 * 专家模式：全量上下文加载
 * 优先读取 methodology.md，降级兜底为 JS 数组格式化。
 * 供 strategy.methodologyAdvisor 工具调用。
 */
function getFullContextForExpertMode() {
  const fs = require('fs');
  const mdPath = require('path').join(__dirname, '../../docs/knowhow/methodology.md');
  if (fs.existsSync(mdPath)) {
    const raw = fs.readFileSync(mdPath, 'utf-8');
    return `===== 经营策略方法论（来自公司经营会实战经验）=====\n\n${_appendMissingCategories(raw)}`;
  }
  return _formatAllCategories();
}

function _appendMissingCategories(raw) {
  const missing = KNOWHOW_CATEGORIES.filter(cat => !raw.includes(`[${cat.id}]`));
  if (missing.length === 0) return raw;

  const lines = [
    raw.trimEnd(),
    '',
    '---',
    '',
    '## JS 兜底新增策略（methodology.md 未覆盖）',
    '',
  ];
  for (const cat of missing) {
    _pushCategoryLines(lines, cat);
  }
  return lines.join('\n');
}

function _formatAllCategories() {
  const lines = [
    '===== 经营策略方法论（来自公司经营会实战经验）=====',
    '来源补充：2026年6月3日-9日5月经营会新增记录（公司整体校准、各业务负责人季度交流、零售、X行业群、公域、健康美学、耐消）',
    '',
  ];
  for (const cat of KNOWHOW_CATEGORIES) {
    _pushCategoryLines(lines, cat);
  }
  return lines.join('\n');
}

function _pushCategoryLines(lines, cat) {
  lines.push(`## [${cat.id}] ${cat.pattern}`);
  lines.push(`**触发条件**：${cat.trigger}`);
  lines.push('');
  lines.push('### 解决策略');
  for (const s of cat.strategies) lines.push(`- ${s}`);
  lines.push('');
  lines.push(`### 实战案例\n${cat.case}`);
  lines.push('\n---\n');
}

module.exports = {
  KNOWHOW_CATEGORIES,
  formatForPrompt,
  shouldInject,
  matchStrategies,
  getFullContextForExpertMode,
};
