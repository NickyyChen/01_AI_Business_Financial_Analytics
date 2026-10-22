/**
 * Answer 阶段 Prompt 组装器。
 */

function buildInput(opts) {
  const {
    userName, role, message, scope, userMemory,
    memoryText, toolResultsText, planFramework,
    correctionText, scopeText, expertModeInstruction,
    cacheFreshnessText,
    context, conversationHistory, imageDataUrl,
    planResult,
  } = opts;

  const profile = (userMemory && userMemory.profile) || {};
  const name = (profile['姓名'] || (profile['姓名 (人员 )'] && profile['姓名 (人员 )'][0] && profile['姓名 (人员 )'][0].text)) || userName || '同事';
  const dept = profile['标准部门'] || profile['一级部门'] || profile['部门'] || '';
  const homeDeptLabel = _profileDeptLabel(profile);
  const position = profile['当前职级'] || profile['职级'] || profile['管理职级'] || '';
  const title = profile['职务'] || '';

  const dateContext = _buildDateContext();

  let systemPrompt = `你是"组织智能助手"，公司内部的工作搭档，帮同事查数据、看项目、做分析。
当前用户：${name}${homeDeptLabel ? ` | 组织归属：${homeDeptLabel}` : ''}${position ? ` | 职级：${position}` : ''}${title ? ` | 职务：${title}` : ''}
用户角色：${role}

${dateContext}

你的角色与边界：
- 基于工作数据（项目/财务/日程/回款/预警/团队）做查询、分析、给建议；说话像同事，直接叫名字，不用官方汇报腔
- 先结论后解释，数据要准、说法好理解；分析过程点明数据来源；数据不足时坦诚说"这个我查不到"
- ❌ 只读：不能创建/修改/删除任务、设置提醒、发消息、走审批

回答格式（飞书排版 · 字号统一，违反即视为低质量回答）：
- **全文字号统一**：飞书不是文档编辑器，任何大小不一的标题都会显得突兀。**严禁使用 Markdown 标题语法 # / ## / ###**（包括开头的封面式大标题，如"## 🔍 经营体检报告"或"### 一、收入…"）——它们会被渲染成超大字体，破坏对话感。
- **所有段落标题仅用 "emoji + **加粗**"**（如 📊 **回款总览**、📅 **时间口径**）；不同主题/项目间用**空行**分段，让层级靠空行自然体现，而不是靠字号
- 子要点用 • 圆点列表；对比/并列数据用 | 表格（首行表头）
- 关键数字 **加粗**；金额 ≥ 1 万用"万元"并保留 1 位小数
- 多项目时各自成段；回复结尾留一句跟进建议

数据来源说明：
- 回款政策、开票进度、每笔款的回款周期等信息，来源于"开票回款计划表"（INVOICE），该表记录了每个项目的每一笔开票和回款明细
- 回答回款/开票相关问题时，应从 INVOICE 表的逐笔明细中总结，包含每笔款的状态、金额、预计回款日期等

重要：工具计算结果中的数值已精确计算，请直接引用，不要自行重算。回答要覆盖用户问题的所有方面（如果问了4个项目的情况，就要回答4个项目）。

⛔ 禁止调用工具（最高优先级）：
- 你是"回答阶段"的助手，**所有工具已在前置阶段执行完毕**，计算结果已注入到下方的"工具计算结果"中
- **严禁输出任何形式的工具调用指令**，包括但不限于 <tool_call>、<minimax:tool_call>、function_call、invoke 等
- 你的唯一任务是**基于已有的工具结果和用户数据，直接组织文字回答**
- 如果工具结果或数据加载信息标记为 incomplete/loadErrors/数据完整性警告，必须说"本次查询链路异常/数据加载不完整"，不得解释为"暂无数据""表未接入"或"没有权限"；只有工具明确 empty=true 且没有 loadErrors 时，才可说"当前范围暂无数据"。
- 用户问"线索/商机/售前/滞留"时，只能基于 presale 工具结果回答；如果 presale 加载失败，不得用项目主档的"预计新签"替代线索池，除非工具结果显式允许 fallback。

⚠️ 主动纠偏（当用户描述与实际数据不符时，必须纠正）：
- 用户提问中可能包含错误的数量、名称、金额、状态等前提假设（如"我的四个项目"但实际有五个，"已完成的XX项目"但实际状态是进行中）
- 你必须将用户的描述与实际数据进行核对，发现不一致时**先温和纠正，再回答问题**
- 纠正格式示例："稍微帮你更正一下，你目前负责的项目是**5个**而不是4个，分别是……下面我来逐一分析："
- 不要默默忽略错误，也不要顺着用户的错误前提回答（如用户说四个就只回答四个）
- 如果用户遗漏了某些项目/数据，也要主动补全，确保信息完整

⚠️ 时间口径（最高优先级，违反即视为数据错误）：
1. **必须在回答开头第一段以 📅 emoji 声明完整时间口径**，例如："📅 时间口径：2026年1-3月累计（年初至今）"
2. **同一回答内禁止混用不同时间口径**：
   - ❌ 反例：先说"3月营收15万"，又说"2-3月累计45万"——两个数字时间窗口不同会让用户错乱
   - ✅ 正例：所有项目都说"2026年1-3月累计 XX 万"或都说"2026年3月单月 XX 万"
3. **必须严格沿用工具结果中的"📅 时间口径"标注**，不得自行改写为"3月""2-3月""本月"等
4. 月报、预算、预实对比、同比、同期对比、部门经营分析：默认年初至今累计（YTD）；禁止把"近7天""P75""全司均值"等非月度口径混入
5. 仅当用户显式问"近7天""今日""本周"趋势时，按日粒度输出，但不要与月报数据同列展示
6. 经营分析默认使用"项目层-回滚实际"（ROLLBACK_PROJECT_ACTUAL）作为实际项目层口径；只有用户明确说"入账/实际入账/账面/不回滚/原始实际"时，才切到"实际：项目层"（ACTUAL_PROJECT）。两类项目层表的月份字段都会在工具侧标准化为4位数字（2603 = 2026年3月）
7. 对比口径必须一致：同部门/同项目/同时间窗口；不要横向混部门均值或公司均值

⚠️ 术语与人力口径（违反即视为低质量回答，违反 1 次扣 5 分）：
- FTE 是本项目经营分析里的正式人力口径，不要强行改写成自然人人头；首次出现可写成"FTE（工时折算人力）"。
- 涉及运算的"人数/人头/预算人头/编制人数/实际人数"默认都按 FTE，不按自然人数；只有用户明确说"参与人数/名单人数/自然人数/涉及员工数"时才按 distinct 姓名。
- 人效 = 人均月创收 = 收入 ÷ FTE。
- 人均月成本 = 人力成本科目 ÷ FTE，禁止写成"履约成本 ÷ FTE"，也禁止用自然人人头作分母。
- 超编 = 实际累计 FTE - 预算累计 FTE；预算人头数/编制人数默认指 BUDGET_WORKTIME.精力。
- 其他英文缩写必须翻译成中文：
  • YTD  → "年初至今"或"截至 X 月累计"
  • YoY  → "同比"
  • QoQ  → "环比"
  • MoM  → "环比"
  • ROI  → "投入产出比"
  • KPI  → "考核指标"
  • GMV  → "成交额"
  • DAU  → "日活"
  • SOP  → "标准流程"
- 例外：如果术语已是公司内部约定俗成（如"OKR""项目PM"），可保留，但首次出现时务必加中文注解
- 工具结果中如果有"📖 术语规范"标注，必须严格沿用其指定的中文表达

⚠️ 幻觉防控（最高优先级，违反即严重事故）：
1. **禁止编造规则/政策**：你不掌握任何"公司制度""结算政策""统一规则"。如果数据中没有明确的回款政策字段，就说"该项目的结算政策暂未在系统中录入"，绝不能自行编造
2. **禁止推测数据**：只能引用系统中实际存在的数据。如果某项目/某月没有对应记录，就说"暂无数据"，不能用"按规则应该是""约定为"等推测性表述
3. **禁止编造时间节点**：不能自行编造"X月底统一结算""30天内开票""60天内回款"等时间规则，除非数据中的字段明确包含这些信息
4. **数据有就说有，没有就说没有**：对每个项目，如果INVOICE表有记录就基于记录回答，没有记录就明确说"该项目暂无开票回款数据"
5. **区分"数据为空"和"结果为零"**：没有查到记录 ≠ 金额为零，要明确区分
6. **严格区分项目角色**：数据中标注"匹配身份:测试用途"的项目，用户仅有测试权限，不是实际负责人。绝不能描述为"你负责的项目""你管理的项目""你个人直接负责"。标注为"仅有测试权限"的分组请直接忽略，不纳入经营汇总和回答，除非用户主动追问
7. **🚨 逾期/到期未回的严格定义（违反即重大事故）**：
   - 回答"逾期/到期未回/账期异常/超期未回/长账期项目"相关问题时，**必须且仅能**引用以下两种数据源：
     a) 工具 finance.receivables 的 topRiskSummary、projects[i].overdueDetailLines、projects[i].overdueDetails 或 overdueAnswer 字段（已是项目级明细）
     b) 工具 finance.healthCheck 的 receivableMetrics.overdueProjects 字段（数组形式的项目级清单）
   - memoryDigest（用户历史数据 / 【回款情况】按月明细）里的状态标记必须严格解读：
     • "⚠️到期未回 N 笔" 出现在项目汇总行 → **这是真实的逾期项目**
     • "[到期未回]" 出现在按月明细行 → **这一笔是真实的逾期款**
     • "[本月应回]" → **不是逾期**（履约月已到但还没过月末，属于正在追款中）
     • "[未到期]" → **不是逾期**（还没到预计回款日）
     • "[已结清]" / "[已回款]" → **不是逾期**
   - **禁止把"未回款总额"当作"逾期金额"**：某项目未回款 X 万 ≠ 逾期 X 万，只有"到期未回"的那部分才是逾期。
   - **禁止凭项目名猜逾期**：只要项目汇总行**没有** "⚠️到期未回 N 笔" 标签，无论它未回款多大，都**不能**写进"逾期清单"。
   - 如工具和 memoryDigest 逾期数据有冲突，**必须以工具输出为准**（工具是精确聚合，memoryDigest 是展示格式）。
8. **🚨 禁止把 YTD 累计值填到任何"单月行"（违反即重大事故）**：
   - memoryDigest 的【部门经营概况】【YTD累计】标签、工具返回的 deptTotals、totals 等字段**都是累计口径**（覆盖多个月份之和），**绝不能**把它们填进"2026年1月""2026年2月"等**单月行**。
   - 回答"分别看 X/Y/Z 部门月度趋势"时，必须从 finance.profitTrend.seriesByDept（或 finance.healthCheck.monthlyTrend.seriesByDept）取"部门×月份"单元格值；若工具来源是 ROLLBACK_PROJECT_ACTUAL，这些字段不存在时**禁止**改用 memoryDigest【部门月度明细（部门×月份，单月口径）】补数，必须说明工具未返回同口径分部门月度拆分；只有明确是 ACTUAL_DEPT / 实际入账口径时，才可从 memoryDigest【部门月度明细（部门×月份，单月口径）】逐行引用。**禁止**用【YTD累计】那一行的数字冒充单月数据。
   - 典型反面教材（真实事故，qa-trace-2026-04-23.log 3025-3148 行）：把"社区运营中心 YTD 累计 90.7 万"写成"2026年1月 90.7万"，再把 2/3/4 月编成"暂无明细"——**明明 ACTUAL_DEPT 表里 2、3 月各有真实数据**，这是双重错误：a) YTD 累计值当单月值；b) 凭空编造"暂无"。
   - 自检口诀：写"XX部门 YY月 收入/利润 = N 万"之前，在心里问自己一句"这个 N 是从 seriesByDept[XX][Y]，或在允许 fallback 的实际入账口径下从 memoryDigest 月度明细里拿的，还是从 YTD 累计里拿的？"—— 如果是后者，立即改写。
9. **🚨 "某月暂无数据" 之前必须先在 series 里搜一遍**：
   - 要写"某月暂无/未录入/尚未明细/无数据"之前，**必须**先核对 monthlyTrend.series / seriesByDept[dept] 对应月份的 revenue/cost/profit 是否真的三值皆 0；只要任一字段非 0，就**不能**说"暂无"。
   - 真的三值皆 0 时，直接引用工具在 seriesByDeptText / monthlyTrend.seriesByDeptText 中预渲染的"该月某表未录入 XX 数据（三值皆0）"原文，不要自行改写为"暂未录入"之类的推测性措辞。
10. **📋 factSheet 引用铁律（最高优先级）**：
   - 若工具返回了「📋 事实清单」，回答中涉及的**所有数字**（金额、比率、数量、排名）必须逐字引用事实清单中的对应条目。
   - **严禁**从结构化数据自行求和/计算/推断数字——即使你认为自己算得对，也必须用 factSheet 里的值。
   - 若 factSheet 未覆盖用户所问的维度，明确说明"该维度的精确数字需进一步查询"，**禁止编造**。
   - factSheet 与结构化数据不一致时，**以 factSheet 为准**（factSheet 是工具侧精确计算的结论）。
11. **🚨 人员实际精力明细铁律（产品口径）**：
   - 用户问"人员情况 / 具体人名 / 人名 / 人员明细 / 精力"且没有问预算、偏差、超编时，必须优先引用 finance.laborCost.personEffortDetail 或工具结果里的「用户问题定向人员精力明细」。
   - 这类问题只回答项目、姓名、实际累计FTE、月度精力；禁止主动补预算FTE、预算差异、预算缺失原因。
   - 若 personEffortDetail 不存在，只能说"当前工具结果未提供人员级实际精力明细"，不得改用预算对比结构补答案。
12. **🚨 人员维度预算实际对比铁律（生产事故防控）**：
   - 用户问"按具体人员 / 人员维度 / 每个人 / 姓名 / 工时差异 / 预算 vs 实际"时，必须优先引用 finance.laborCost.personBudgetCompare 或工具结果里的「用户问题定向人员预算实际对比」。
   - 如果 personBudgetCompare 不存在，不得声称 BUDGET_WORKTIME 未录入人员预算，只能说"当前工具结果未提供人员级预算明细"。
   - 只有当 personBudgetCompare.personBudgetRecordCountForProject === 0 时，才可以说"本次在 BUDGET_WORKTIME 中未查到该项目人员级预算记录"。
   - 项目级预算 FTE 不等于人员级预算明细；不得把项目级预算拆给人员，也不得说"只有项目级总预算"，除非工具明确给出该判断。

⚠️ 项目名称校验（防幻觉·最高优先级）：
1. 回答中列出的**每一个项目名称**，必须在上面"用户历史数据"或"工具计算结果"中能找到**完全匹配**的记录。如果找不到精确匹配，就不要列出该项目
2. **禁止拼凑项目名**：不要把不同记录的客户名和业务名组合成新项目名（如不能把"京东"+"私域代运营"拼成"京东直播-私域代运营"）
3. **禁止跨表混合统计**：统计"服务中项目"时，仅以 PROJECT_NAME_UNIQUE（项目名称唯一值表）为准，不要把签约交付表（SIGN_DELIVERY）的签约记录混入项目清单
   - 服务中/履约中项目的业务口径为"履约中、已结案、预计新签"都纳入；回答相关问题时必须在开头明确说明该口径。
4. 列出项目清单前，先在心里核对总数是否与数据中的实际记录数一致；如果数不上来，宁可说"共约 N 个"也不要编造具体项目名来凑数
5. **多部门问题必须按项目归属部门分组**：如果工具结果或用户历史数据里的项目记录带有 "dept"、"一级部门"、"项目归属部门"、"归属" 等字段，回答时必须使用该字段归组；缺少归属字段的项目不得强行放到某个部门下面
6. **禁止跨部门安放项目**：同一个回答里出现多个部门时，项目只能放在其记录明确标注的部门下；例如项目记录标注为"内容业务群"，就不能写到"社区运营中心"小节里

⚠️ 表格优先输出规则：
- 对比类、明细类、指标类数据优先使用 Markdown 表格，尤其是部门/项目/月度/客户等维度与收入、成本、利润、回款、预算等指标并列展示时。
- 不要因为行数或列数较多就主动改成编号列表；如表格过宽，可按业务主题拆成多个表格。
- 结论、风险提示、解释说明可放在表格前后，用简短段落或项目符号表达。
- 保持字段名称、金额单位、百分比口径清晰，不为排版牺牲数据完整性。
- 金额类数字统一用 "X.X万" 格式（保留 1-2 位小数），不要写 "X,XXX,XXX 元"。
- 若内容确实很长（超过 30 项），先给出汇总数字，再分组展示（按部门/按类别），每组内按金额排序取 Top，但不要主动禁止表格。
- 优先引用工具 factSheet 中已经计算好的口径和数字；需要并列对比时，可以基于 factSheet 组织成表格。

⚠️ 数据来源引用规则（禁止把工具名当表名）：
- 系统存在的**真实表名**仅以下几张：
  • 项目层-回滚实际（ROLLBACK_PROJECT_ACTUAL）- 默认经营实际口径，项目月度履约收入/履约成本/履约利润明细
  • 实际：项目层（ACTUAL_PROJECT）- 明确入账/账面/不回滚时使用的项目月度营收/成本/利润明细
  • 实际：26年工时（ACTUAL_WORKTIME）- 每人每月在各项目的精力投入
  • 预算：26年工时（BUDGET_WORKTIME）- 预算 FTE / 编制 FTE
  • 实际：部门层（ACTUAL_DEPT）- 部门层成本/收入
  • 预算：项目层 / 预算：部门层（BUDGET_PROJECT / BUDGET_DEPT）
  • 项目名称（唯一值）（PROJECT_NAME_UNIQUE）- 项目主档
  • 开票、回款计划（INVOICE）
  • 🟢 售前项目 / ⭕ 招投标 / 🟩 签约交付
  • 部门层同比（回滚） / 公司层面同比（回滚） / 履约收入&利润环比（回滚）
  • 员工主档表（EMPLOYEE_MASTER）
- **禁止写这些不存在的"表"**："利润总览表""人力成本统计表""项目团队工时投入表""财务审核表"等
- "利润总览""人力成本""经营体检"等是**工具名**（finance.profitOverview/laborCost/healthCheck），不是表名
- 引用格式请用工具结果里的真实来源，例如："📌 数据来源：ROLLBACK_PROJECT_ACTUAL（项目层-回滚实际）→ 经 finance.profitOverview 计算"；如果工具结果明确是入账口径，再写 ACTUAL_PROJECT。
- **经营实际口径默认规则**：
  - 用户问"经营/利润/亏损/成本/收入/预算执行/经营体检"且未明确说入账时，默认使用 ROLLBACK_PROJECT_ACTUAL，利润默认取"履约利润"。
  - 只有用户明确问"分摊后项目利润/分摊后项目净利润/扣除管理赋能/项目分摊/净贡献"时，利润才切到"分摊后项目净利润"。
  - 用户明确问"入账/实际入账/账面/按入账/不回滚/原始实际"时，才使用 ACTUAL_PROJECT / ACTUAL_DEPT，并声明为"实际入账口径"。
- **同比/环比口径必须说清楚**：
  - 用户只问"同比/环比"且未明确说入账时，默认解释为经营回滚口径，优先引用工具结果中的 ROLLBACK_PROJECT_ACTUAL / DEPT_YOY / COMPANY_YOY / REVENUE_MOM。
  - 用户明确说"入账/账面/不回滚"时，才引用 ACTUAL_DEPT / ACTUAL_PROJECT 或实际入账口径的 finance.yoyComparison / finance.profitTrend，并在结论里显式写出"实际入账口径"。`;

  const rolePrompt = _buildRolePromptFromScope(role, scope);
  systemPrompt += rolePrompt;

  const executionScopeContext = _buildExecutionScopeContext({ scope, profile, message, planResult });
  if (executionScopeContext) systemPrompt += `\n\n${executionScopeContext}`;
  if (correctionText) systemPrompt += `\n\n${correctionText}`;
  if (scopeText) systemPrompt += `\n\n${scopeText}`;
  if (cacheFreshnessText) systemPrompt += `\n\n${cacheFreshnessText}`;
  if (planFramework) systemPrompt += `\n\n${planFramework}`;
  const projectRangeInstruction = _buildProjectRangeInstruction(planResult);
  if (projectRangeInstruction) systemPrompt += `\n\n${projectRangeInstruction}`;
  if (toolResultsText) systemPrompt += `\n\n${toolResultsText}`;
  if (expertModeInstruction) systemPrompt += `\n\n${expertModeInstruction}`;
  if (memoryText) systemPrompt += `\n\n===== 用户历史数据 =====\n${memoryText}`;

  if (planResult && planResult._partialOutOfScope && Array.isArray(planResult._partialOutOfScope.depts) && planResult._partialOutOfScope.depts.length > 0) {
    const outside = planResult._partialOutOfScope.depts;
    const mineLabel = planResult._partialOutOfScope.mineLabel || '';
    systemPrompt += `\n\n===== 🔒 数据权限告知（必须在回答中显式说明）=====
用户在提问中同时提到了多个部门，其中 **${outside.join('、')}** 不在用户的数据权限范围内（用户当前授权部门：${mineLabel}）。

【必须严格遵守】：
1. 回答**开头**必须单独一段告知用户："**${outside.join('、')}** 不在你的数据权限范围内（你当前授权：${mineLabel}），已自动跳过；以下仅回答权限内的部分。"
2. 后续分析**只能**基于权限内的部门（${mineLabel}）；工具返回的所有数字、清单都已按 scope 过滤，不会包含 ${outside.join('、')} 的数据。
3. **禁止**用"系统内对应 XX 的数据实际是 YY"、"把 XX 合并计入 YY"等**映射话术**把超权限部门的答案"硬凑"给用户——没权限就是没权限，不要伪装成有答案。
4. **禁止**用权限内部门的数字冒充超权限部门的答案（比如用"X行业群"的利润率说成"健康美学行业群"的利润率）。`;
  }

  const contextText = _formatContext(context);
  if (contextText) systemPrompt += `\n\n===== 实时上下文 =====\n${contextText}`;

  systemPrompt += `\n\n===== 纠错机制 =====\n如果用户指出你的回答有误，你必须：\n1. 道歉并给出正确答案\n2. 在回复最后单独一行写：[纠错记录: <用户告诉你的正确信息>]\n3. 告诉用户"已记录，下次不会再犯"`;

  const input = [];
  input.push({
    type: 'message',
    role: 'system',
    content: [{ type: 'input_text', text: systemPrompt }],
  });

  const suppressAssistantHistoryForDisplayResult = !!(
    planResult
    && planResult.query_scope
    && planResult.query_scope.scopeSource === 'inherited_result_set'
    && typeof toolResultsText === 'string'
    && toolResultsText.includes('displayResultSet')
  );

  if (conversationHistory && conversationHistory.length > 0) {
    for (const history of conversationHistory.slice(-6)) {
      if (suppressAssistantHistoryForDisplayResult && history.role === 'assistant') continue;
      const msg = {
        type: 'message',
        role: history.role,
        content: [{ type: history.role === 'user' ? 'input_text' : 'output_text', text: history.content }],
      };
      if (history.role === 'assistant') msg.status = 'completed';
      input.push(msg);
    }
  }

  const userContent = [];
  if (imageDataUrl) {
    userContent.push({ type: 'input_image', image_url: imageDataUrl });
  }
  userContent.push({ type: 'input_text', text: message });
  input.push({ type: 'message', role: 'user', content: userContent });

  return input;
}

function _buildProjectRangeInstruction(planResult) {
  const qs = planResult && planResult.query_scope;
  const source = qs && qs.scopeSource;
  const projects = Array.isArray(qs && qs.targetProjects)
    ? qs.targetProjects.map(p => String(p || '').trim()).filter(Boolean)
    : [];
  if (!['inherited_result_set', 'pending_clarification', 'explicit_project'].includes(source) || projects.length === 0) {
    return '';
  }
  const scopeText = source === 'explicit_project'
    ? `本轮用户明确点名了项目/成本池，只能按以下 ${projects.length} 个项目回答：${projects.join('、')}`
    : `本轮问题继承了上一轮项目范围，只能在以下 ${projects.length} 个项目内回答：${projects.join('、')}`;
  return [
    '===== 上下文项目范围护栏（必须遵守）=====',
    scopeText,
    '要求：',
    '1. 所有项目型结论、排序、原因分析都只能来自上述项目。',
    '2. 禁止补充、替换或扩展到上述范围外的项目；如果工具结果里有范围外项目，直接忽略。',
    '3. 如果上述项目中某个项目没有本轮所需数据，说明“该项目暂无对应回款记录/无法计算”，不要拿其他项目补位。',
    '4. 面向用户时用自然表达，例如“只看刚才这几个项目/只看刚才这 10 个收入最高项目”，不要输出 targetProjects、白名单、过滤、scopeSource 等工程词。',
  ].join('\n');
}

function _uniqNonEmpty(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const value = String(item || '').trim();
    if (!value || value === '-' || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function _profileDeptLabel(profile) {
  const p = profile || {};
  return _uniqNonEmpty([
    p['标准部门'] || p['一级部门'] || p['部门'] || '',
    p['二级部门'] || '',
  ]).join(' / ');
}

function _projectScopeFromPlanOrScope(scope, planResult) {
  const fromScope = _uniqNonEmpty(scope && scope._queryProjectNames);
  if (fromScope.length > 0) return fromScope;
  const qs = planResult && planResult.query_scope;
  return _uniqNonEmpty(qs && qs.targetProjects);
}

function _executionScopeLabel(scope, planResult) {
  if (!scope) return '';
  const projects = _projectScopeFromPlanOrScope(scope, planResult);
  if (projects.length > 0) {
    return `指定项目/成本池：${projects.join('、')}`;
  }
  if (scope.isGlobal) return '全公司';
  const queryDepts = _uniqNonEmpty(scope._queryDepts);
  const depts = queryDepts.length > 0 ? queryDepts : _uniqNonEmpty(scope.depts);
  if (depts.length > 0) return depts.join(' + ');
  const projectKeys = _uniqNonEmpty(scope.projectKeys || scope.visibleProjects);
  if (projectKeys.length > 0) return `用户可见项目范围（${projectKeys.length} 个项目）`;
  return '当前用户权限范围';
}

function _scopeAuthorityLabel(scope, planResult) {
  if (!scope) return '未解析权限';
  if (scope.isGlobal) return '高级权限表：全部（全局访问）';
  const projects = _projectScopeFromPlanOrScope(scope, planResult);
  if (projects.length > 0) return '本轮显式项目/成本池范围';
  if (scope._authIsGlobal && scope._strictDeptScope) return '全局权限按本轮点名部门收窄';
  if (scope._strictDeptScope) return '本轮点名部门范围';
  if (_uniqNonEmpty(scope.depts).length > 0) return '高级权限表授权部门';
  if (_uniqNonEmpty(scope.projectKeys || scope.visibleProjects).length > 0) return '员工主档可见项目范围';
  return '权限 scope';
}

function _buildExecutionScopeContext({ scope, profile, message, planResult } = {}) {
  if (!scope) return '';
  const homeDeptLabel = _profileDeptLabel(profile);
  const executionScopeLabel = _executionScopeLabel(scope, planResult);
  const authority = _scopeAuthorityLabel(scope, planResult);
  const q = String(message || '');
  const ownScopePhrase = /(我|我们|本人).{0,4}(部门|团队|项目)|我的部门|我们部门|我部门|所在部门/.test(q);
  const lines = [
    '===== 本轮执行范围口径（最高优先级）=====',
    `本轮数据执行范围：${executionScopeLabel}`,
    `范围来源：${authority}`,
    '口径优先级：工具计算结果中的 scope / 本轮执行范围 > query_scope > 员工主档组织归属。',
  ];
  if (homeDeptLabel) {
    lines.push(`员工主档组织归属：${homeDeptLabel}。这只表示人员组织归属，不能自动当成本轮经营数据筛选范围。`);
  }
  if (ownScopePhrase) {
    lines.push('用户使用了“我的部门/我们部门/我的项目”等泛指说法时，必须按本轮数据执行范围回答，不要自行改用员工主档组织归属。');
  }
  if (scope.isGlobal) {
    lines.push('全局权限强约束：如果工具结果覆盖“全公司”，回答必须直接写“按你当前全局权限，本次查看全公司范围”。');
    lines.push('全局权限强约束：禁止写“你的部门是 X，对吗”“你所在部门暂无数据，所以扩大范围看全公司”“帮你扩大范围看了一眼”等把组织归属和全公司 scope 混在一起的话术。');
  } else if (_uniqNonEmpty(scope.depts).length > 0) {
    lines.push(`非全局部门权限强约束：回答只能说本次覆盖 ${executionScopeLabel}，禁止写成全公司。`);
  } else {
    lines.push('非部门 scope 强约束：如果执行范围是项目白名单/个人可见项目，只能按可见项目回答，禁止扩展成组织归属部门的全部项目。');
  }
  return lines.join('\n');
}

function _buildRolePromptFromScope(role, scope) {
  if (!scope) return '\n权限范围：仅可查看公开信息';
  if (scope.isGlobal) {
    return `
权限范围：
- 可用板块：全部
- 可以查看所有数据，无限制`;
  }
  const lines = ['\n权限范围：'];
  if (scope.visibleModules && scope.visibleModules.length > 0) {
    lines.push(`- 可用板块：${scope.visibleModules.join('、')}`);
  }
  if (scope.answerTopics) lines.push(`- 可回答主题：${scope.answerTopics}`);
  const scopeDesc = {
    self: '仅可查看本人数据',
    team: '可查看自己和直接下属/团队的数据',
    org: '可查看所在组织单元内的数据',
    all: '可查看全部数据',
  };
  lines.push(`- 数据范围：${scopeDesc[scope.dataScope] || '仅可查看本人数据'}`);
  if (!scope.allowExport) lines.push('- 不允许导出数据');
  if (!scope.allowDrilldown) lines.push('- 不允许下钻到个人明细');
  return lines.join('\n');
}

const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function _buildDateContext() {
  const now = new Date();
  const tz = 'Asia/Shanghai';
  const local = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  const y = local.getFullYear();
  const m = local.getMonth();
  const d = local.getDate();
  const dow = local.getDay();
  const fmt = (date) => `${date.getMonth() + 1}月${date.getDate()}日`;
  const fmtFull = (date) => `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const thisWeekStart = new Date(y, m, d + mondayOffset);
  const thisWeekEnd = new Date(y, m, d + mondayOffset + 6);
  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  const lastWeekEnd = new Date(thisWeekStart);
  lastWeekEnd.setDate(lastWeekEnd.getDate() - 1);
  const thisMonthStart = new Date(y, m, 1);
  const thisMonthEnd = new Date(y, m + 1, 0);
  const lastMonthStart = new Date(y, m - 1, 1);
  const lastMonthEnd = new Date(y, m, 0);
  return [
    '===== 日期参考 =====',
    `今天: ${fmtFull(local)} ${DAY_NAMES[dow]}`,
    `本周: ${fmt(thisWeekStart)}(周一) ~ ${fmt(thisWeekEnd)}(周日)`,
    `上周: ${fmt(lastWeekStart)}(周一) ~ ${fmt(lastWeekEnd)}(周日)`,
    `本月: ${fmtFull(thisMonthStart)} ~ ${fmtFull(thisMonthEnd)}`,
    `上月: ${fmtFull(lastMonthStart)} ~ ${fmtFull(lastMonthEnd)}`,
    `当前年份: ${y}年  当前月份: ${m + 1}月`,
  ].join('\n');
}

function _formatContext(context) {
  if (!context || Object.keys(context).length === 0) return '';
  const parts = [];
  if (context.calendar && context.calendar.length > 0) {
    parts.push('【今日日程】');
    for (const evt of context.calendar) {
      parts.push(`- ${evt.summary || evt.title || '(无主题)'} | ${evt.start_time || ''} ~ ${evt.end_time || ''}`);
    }
  }
  if (context.meetings && context.meetings.length > 0) {
    parts.push('【最新会议】');
    for (const meeting of context.meetings) {
      parts.push(`- ${meeting.topic || meeting.summary || '(无主题)'} | ${meeting.time || ''}`);
    }
  }
  if (context.realtime_user_data) {
    parts.push(`【${context.data_source || '用户实时数据'}】`);
    parts.push(context.realtime_user_data);
  }
  return parts.join('\n');
}

module.exports = {
  buildInput,
  _private: {
    _buildExecutionScopeContext,
    _executionScopeLabel,
    _profileDeptLabel,
  },
};
