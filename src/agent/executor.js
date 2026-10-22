/**
 * executor.js - 工具并行执行器
 *
 * 接收 Planner 输出的 tools_needed，从 memory 中取数据，
 * 并行调用各工具，汇总返回结构化结果。
 *
 * 错误隔离：单个工具失败不影响其他工具。
 */

const toolRegistry = require('../tools/tool-registry');
const logger = require('../utils/logger');
const config = require('../../config');

function _defaultToolParams(toolId, scope) {
  if (toolId !== 'finance.receivables') return {};
  return {
    ...(scope && scope.isGlobal ? { businessReceivablesOnlyForGlobal: true } : {}),
    receivableRevenueTypeFilter: true,
  };
}

/**
 * 并行执行所有选定的工具
 * @param {string[]} toolIds - 工具 ID 列表（来自 planner.tools_needed）
 * @param {object} memory   - memory-manager.getUserMemory() 返回值
 * @param {object} scope    - permission-manager.resolveScope() 返回值
 * @param {object} [opts]   - { parent }  parent 为 Langfuse trace/span，每个工具会在其下创建子 span
 * @returns {object} { results: { toolId: result }, errors: { toolId: errorMsg }, elapsed: ms }
 */
async function executeTools(toolIds, memory, scope, opts = {}) {
  if (!toolIds || toolIds.length === 0) {
    return { results: {}, errors: {}, elapsed: 0 };
  }

  const startTime = Date.now();
  const results = {};
  const errors = {};
  const parent = opts.parent || null;
  const toolParams = opts.toolParams && typeof opts.toolParams === 'object' ? opts.toolParams : {};

  const tasks = toolIds.map(async (id) => {
    const def = toolRegistry.getTool(id);
    if (!def) {
      errors[id] = `工具 "${id}" 未注册`;
      if (parent) {
        try {
          parent.event({
            name: `tool.${id}.not-registered`,
            level: 'WARNING',
            metadata: { toolId: id },
          });
        } catch (_) {}
      }
      return;
    }

    // 每个工具一个 span（失败时降级为 no-op，不影响主流程）
    const span = parent
      ? parent.span({
          name: `tool.${id}`,
          input: {
            toolId: id,
            toolName: def.name,
            dataTables: def.dataTables || [],
            period: scope && scope.period ? scope.period : undefined,
            params: toolParams[id] || {},
          },
          metadata: {
            empName: scope && scope.empName,
            role: scope && scope.role,
          },
        })
      : null;

    try {
      const t0 = Date.now();
      const params = {
        ..._defaultToolParams(id, scope),
        ...(toolParams[id] || {}),
      };
      const result = await Promise.resolve(def.handler(memory, scope, params));
      const dt = Date.now() - t0;
      results[id] = result;
      logger.info(`[Executor] ${id} 完成 (${dt}ms)${Object.keys(params).length ? ` params=${JSON.stringify(params)}` : ''}`);
      if (span) {
        try {
          span.end({
            output: _summarizeToolResult(result),
            metadata: { elapsedMs: dt, empty: !!(result && result.empty), params },
          });
        } catch (_) {}
      }
    } catch (e) {
      errors[id] = e.message;
      logger.warn(`[Executor] ${id} 失败: ${e.message}`);
      if (span) {
        try { span.end({ level: 'ERROR', statusMessage: e.message }); } catch (_) {}
      }
    }
  });

  await Promise.allSettled(tasks);

  const elapsed = Date.now() - startTime;
  logger.info(`[Executor] 全部完成 (${elapsed}ms): 成功=${Object.keys(results).length} 失败=${Object.keys(errors).length}`);

  return { results, errors, elapsed };
}

/**
 * 缩减工具结果以便写入 Langfuse output（避免一次传十几 KB 的嵌套对象）
 * 策略：
 *   - 保留元信息字段（_sourceTable、_periodLabel 等）
 *   - 数组超过 20 项只保留前 20 项 + 省略标记
 *   - 不改变原对象
 */
function _summarizeToolResult(result) {
  if (result == null || typeof result !== 'object') return result;
  if (Array.isArray(result)) {
    return result.length > 20
      ? [...result.slice(0, 20), `...(共${result.length}项, 截断)`]
      : result;
  }
  const out = {};
  for (const [k, v] of Object.entries(result)) {
    if (Array.isArray(v) && v.length > 20) {
      out[k] = [...v.slice(0, 20), `...(共${v.length}项, 截断)`];
    } else {
      out[k] = v;
    }
  }
  return out;
}

function _isReceivablesOverdueDetailQuestion(message) {
  const q = String(message || '');
  return /(逾期|到期未回|超期未回)/.test(q)
    && /(明细|有哪些|哪几笔|清单|调取|拉一下|列一下)/.test(q);
}

function _pickReceivablesProject(message, receivables) {
  const q = String(message || '').replace(/\s+/g, '');
  const projects = Array.isArray(receivables && receivables.projects) ? receivables.projects : [];
  if (!q || projects.length === 0) return null;

  const norm = (s) => String(s || '').replace(/\s+/g, '');
  return projects.find(p => p && p.name && q.includes(norm(p.name)))
    || projects.find(p => p && p.name && norm(p.name).includes('华为产品线') && q.includes('华为产品线'))
    || projects.find(p => {
      if (!p || !p.name) return false;
      const segments = norm(p.name).split(/[-—_｜|]/).filter(Boolean);
      return segments.length > 0 && segments.every(seg => q.includes(seg));
    })
    || projects.find(p => {
      if (!p || !p.name) return false;
      const firstSeg = norm(p.name).split(/[-—_｜|]/).filter(Boolean)[0];
      return firstSeg && firstSeg.length >= 3 && q.includes(firstSeg);
    })
    || null;
}

function _stripReceivablesProjectForPrompt(project) {
  if (!project || typeof project !== 'object') return project;
  const copy = { ...project };
  delete copy.details;
  delete copy.monthCoverage;
  return copy;
}

function _buildReceivablesTargetPromptResult(result, project) {
  if (!result || !project) return result;
  return {
    _sourceTable: result._sourceTable,
    _periodLabel: result._periodLabel,
    _scopeLabel: result._scopeLabel,
    projectCount: result.projectCount,
    recordCount: result.recordCount,
    totalOverdueCount: result.totalOverdueCount,
    totalOverdueAmount: result.totalOverdueAmount,
    projects: [_stripReceivablesProjectForPrompt(project)],
    topRiskSummary: [
      `${project.name}：逾期${((Number(project.overdueAmount || 0)) / 10000).toFixed(1)}万（${project.overdueCount || 0}笔）${project.nextExpectedLabel ? ` | ${project.nextExpectedLabel}` : ''}`,
    ],
    overdueDetailLines: (project.overdueDetailLines || []).map(line => `${project.name}｜${line}`),
    _cohesionHint: `【目标项目逾期明细硬约束】当前用户问的是"${project.name}"的逾期明细。回答必须优先引用上方"用户问题定向逾期答案"或本对象的 overdueDetailLines；明细行数必须等于 ${project.overdueCount || 0}，禁止从 details/monthCoverage/其他项目自行扩展。`,
  };
}

function _hasDisplayResultSet(result) {
  return !!(result
    && result.displayResultSet
    && Array.isArray(result.displayResultSet.rows)
    && result.displayResultSet.rows.length > 0);
}

function _formatDisplayValue(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'number') {
    if (Math.abs(value) >= 10000) return `${(value / 10000).toFixed(1)}万`;
    return Number(value.toFixed(4));
  }
  return String(value);
}

function _buildDisplayFactSheet(displayResultSet) {
  const rows = Array.isArray(displayResultSet && displayResultSet.rows) ? displayResultSet.rows : [];
  if (rows.length === 0) return null;
  const header = `本轮显示结果集共 ${rows.length} 条；sortBy=${displayResultSet.sortBy || ''}；order=${displayResultSet.order || ''}；后续“这些/第一个/第二个”均以此排名为准。`;
  const skip = new Set(['type', 'rank', 'name', 'key', 'project', 'breakdown', 'projects', 'skus', 'reasons', 'line']);
  const facts = rows.slice(0, 30).map((row, idx) => {
    const name = row.name || row.key || row.project || `(第${idx + 1}项)`;
    const fields = Object.entries(row)
      .filter(([key, val]) => !skip.has(key) && val != null && val !== '' && !Array.isArray(val) && typeof val !== 'object')
      .slice(0, 8)
      .map(([key, val]) => `${key}=${_formatDisplayValue(val)}`)
      .filter(Boolean);
    return `${row.rank || idx + 1}. ${name}${fields.length ? ` | ${fields.join(' | ')}` : ''}`;
  });
  return [header, ...facts];
}

function _buildDisplayPromptResult(result) {
  if (!_hasDisplayResultSet(result)) return result;
  const displayResultSet = result.displayResultSet;
  return {
    _sourceTable: result._sourceTable,
    _periodLabel: result._periodLabel,
    _scopeLabel: result._scopeLabel,
    _scopeGuard: result._scopeGuard,
    projectCount: result.projectCount,
    recordCount: result.recordCount,
    displayResultSet,
    displayProjects: Array.isArray(result.displayProjects) ? result.displayProjects : displayResultSet.rows,
    authoritativeAnswer: result.authoritativeAnswer,
    _factSheet: _buildDisplayFactSheet(displayResultSet),
    _cohesionHint: [
      result._cohesionHint,
      `【本轮显示结果集硬约束】displayResultSet.rows 是本轮回答和后续“这些/第一个”等追问的唯一优先结果集；回答项目列表、排名或 TopN 时只能围绕这 ${displayResultSet.rows.length} 条展示，不要从全量 projects 扩展。`,
    ].filter(Boolean).join('\n'),
  };
}

function _buildPersonEffortActualOnlyPromptResult(result) {
  const detail = result && result.personEffortDetail;
  if (!detail) return result;

  const facts = [];
  if (detail.scopeMode === 'singleProject' && detail.targetProject) {
    facts.push(`[${detail.targetProject}][人员精力] 实际人员 ${detail.actualPeopleCount || 0} 人，实际工时记录 ${detail.totalPersonActualRecordCount || 0} 条，实际累计 ${Number(detail.totalActualFTE || 0).toFixed(2)}FTE。`);
  } else {
    facts.push(`[人员精力][多项目] 当前范围项目×姓名实际精力 ${detail.rowCount || 0} 条；已展开 Top ${Math.min(Array.isArray(detail.rowFacts) ? detail.rowFacts.length : 0, 80)} 条，涉及实际人员 ${detail.actualPeopleCount || 0} 人 / 项目 ${detail.actualProjectCount || 0} 个。`);
  }
  for (const warning of detail.dataQualityWarnings || []) {
    facts.push(`⚠️ [人员精力] ${warning}`);
  }
  for (const line of (detail.rowFacts || []).slice(0, 80)) {
    facts.push(line);
  }

  return {
    _sourceTable: 'ACTUAL_WORKTIME（实际：26年工时）',
    _periodLabel: result._periodLabel,
    totalActualFTE: Number(detail.totalActualFTE || 0),
    actualPeopleCount: detail.actualPeopleCount || 0,
    actualProjectCount: detail.actualProjectCount || 0,
    totalPersonActualRecordCount: detail.totalPersonActualRecordCount || 0,
    rowCount: detail.rowCount || 0,
    omittedRowCount: detail.omittedRowCount || 0,
    personEffortDetail: {
      scopeMode: detail.scopeMode,
      targetProject: detail.targetProject,
      targetProjectCount: detail.targetProjectCount,
      actualProjectCount: detail.actualProjectCount,
      actualPeopleCount: detail.actualPeopleCount,
      totalPersonActualRecordCount: detail.totalPersonActualRecordCount,
      rowCount: detail.rowCount,
      omittedRowCount: detail.omittedRowCount,
      totalActualFTE: detail.totalActualFTE,
      rows: Array.isArray(detail.rows) ? detail.rows.slice(0, 80) : [],
      dataQualityWarnings: detail.dataQualityWarnings || [],
    },
    _factSheet: facts,
    _cohesionHint: '本轮用户只问人员实际精力明细；只回答项目、姓名、实际累计FTE和月度精力。不要输出预算FTE、预算精力、预算差异、预算缺失、超编/无超编判断。',
  };
}

/**
 * 将工具执行结果格式化为注入 Answer LLM system prompt 的文本
 * @param {object} executionResult - executeTools() 返回值
 * @param {object} [opts] - { message } 当前用户问题，用于定向注入项目级权威明细
 * @returns {string} 注入 prompt 的文本
 */
function formatResultsForPrompt(executionResult, opts = {}) {
  const { results, errors } = executionResult;
  const message = opts && opts.message ? String(opts.message) : '';
  const parts = [];

  const toolIds = [...Object.keys(results), ...Object.keys(errors)];
  if (toolIds.length === 0) return '';

  parts.push('===== 工具计算结果（以下数据已精确计算，请直接引用，不要自行重新计算）=====');

  for (const [id, result] of Object.entries(results)) {
    const def = toolRegistry.getTool(id);
    const name = def ? def.name : id;
    const isPersonEffortActualOnly = id === 'finance.laborCost'
      && result.personEffortDetail
      && !result.personBudgetCompare;
    parts.push(`\n【${name}】(${id})`);

    // 2026-04-17 标注数据来源（防止 LLM 把工具名误当表名）
    // 优先用工具自报的 _sourceTable，否则用 tool-registry 里声明的 dataTables
    const sourceLabel = isPersonEffortActualOnly
      ? 'ACTUAL_WORKTIME（实际：26年工时）'
      : result._sourceTable
      || (def && def.dataTables && def.dataTables.length > 0
          ? def.dataTables.join(', ')
          : '(未声明)');
    parts.push(`  📌 数据源表：${sourceLabel}（由工具「${name}」计算，勿把工具名当表名引用）`);

    // 2026-04-17 标注时间口径（防止 LLM 在回答中混用"2-3月"和"3月"）
    if (result._periodLabel) {
      parts.push(`  📅 时间口径：${result._periodLabel}（本工具下所有数字均按此口径，回答时必须严格沿用，不得改写为其他月份范围）`);
    }

    if (id === 'finance.laborCost' && result.authoritativeAnswer && result.authoritativeAnswer.text) {
      parts.push(`  🎯 用户问题定向答案（必须优先原样引用）：${result.authoritativeAnswer.text}`);
    }
    if (id === 'finance.laborCost' && result.personEffortDetail) {
      const detail = result.personEffortDetail;
      parts.push(`  🎯 用户问题定向人员精力明细（回答“人员情况/具体人名/精力”且未问预算时必须优先引用）：`);
      if (!result.personBudgetCompare) {
        parts.push(`    🚫 本轮是人员实际精力明细，不是预算/编制/超编问题；答案只允许使用 ACTUAL_WORKTIME 的实际累计FTE和月度精力，禁止输出预算FTE、预算精力、预算差异、预算缺失、超编/无超编等判断。`);
      }
      parts.push(`    范围：${detail.targetProject || `${detail.targetProjectCount || 0}个项目`}；实际人员${detail.actualPeopleCount || 0}人；实际工时记录${detail.totalPersonActualRecordCount || 0}条；实际累计${Number(detail.totalActualFTE || 0).toFixed(2)}FTE`);
      if (Array.isArray(detail.dataQualityWarnings)) {
        for (const warning of detail.dataQualityWarnings.slice(0, 5)) {
          parts.push(`    ⚠️ ${warning}`);
        }
      }
      const rows = Array.isArray(detail.rows) ? detail.rows.slice(0, 80) : [];
      if (rows.length > 0) {
        parts.push(`    项目 | 姓名 | 实际累计FTE | 月度精力`);
        for (const row of rows) {
          const monthly = Array.isArray(row.monthly)
            ? row.monthly
              .filter(cell => Number(cell.actualFTE || 0) > 0)
              .map(cell => `${cell.monthLabel || cell.month}=${Number(cell.actualFTE || 0).toFixed(2)}FTE`)
              .join('；')
            : '';
          parts.push(`    ${row.project} | ${row.person} | ${Number(row.actualFTE || 0).toFixed(2)} | ${monthly || '—'}`);
        }
      }
    }
    if (id === 'finance.laborCost' && result.personBudgetCompare) {
      const cmp = result.personBudgetCompare;
      if (cmp.targetProject) {
        const sign = (cmp.gapProjectFTE || 0) >= 0 ? '+' : '';
        parts.push(`  🎯 用户问题定向人员预算实际对比（回答“按具体人员/人员维度/姓名/工时差异”必须优先引用）：`);
        parts.push(`    项目：${cmp.targetProject}`);
        parts.push(`    项目级：实际${Number(cmp.actualProjectFTE || 0).toFixed(2)}FTE / 预算${Number(cmp.budgetProjectFTE || 0).toFixed(2)}FTE / 差${sign}${Number(cmp.gapProjectFTE || 0).toFixed(2)}FTE`);
        parts.push(`    人员记录：实际${cmp.personActualRecordCountForProject || 0}条 / 预算${cmp.personBudgetRecordCountForProject || 0}条；实际人员${cmp.actualPeopleCount || 0}人 / 预算人员${cmp.budgetPeopleCount || 0}人`);
        if ((cmp.personBudgetRecordCountForProject || 0) === 0) {
          parts.push(`    ⚠️ 本次在 BUDGET_WORKTIME 中未查到该项目人员级预算记录；禁止泛化为“预算表没有人员字段”。`);
        }
        if (Array.isArray(cmp.dataQualityWarnings)) {
          for (const warning of cmp.dataQualityWarnings.slice(0, 5)) {
            parts.push(`    ⚠️ ${warning}`);
          }
        }
        const rows = Array.isArray(cmp.rows) ? cmp.rows.slice(0, 30) : [];
        if (rows.length > 0) {
          parts.push(`    姓名 | 实际FTE | 预算FTE | 差异FTE | 状态`);
          for (const row of rows) {
            const gap = Number(row.gapFTE || 0);
            parts.push(`    ${row.person} | ${Number(row.actualFTE || 0).toFixed(2)} | ${Number(row.budgetFTE || 0).toFixed(2)} | ${gap >= 0 ? '+' : ''}${gap.toFixed(2)} | ${row.status}`);
          }
        }
      } else if (cmp.scopeMode === 'multiProject') {
        parts.push(`  🎯 用户问题定向人员预算实际对比（多项目；回答“具体姓名在哪些项目有预算实际偏差”必须优先引用）：`);
        parts.push(`    范围：${cmp.targetProjectCount || 0}个项目；偏差行${cmp.diffRowCount || 0}条；实际人员${cmp.actualPeopleCount || 0}人 / 预算人员${cmp.budgetPeopleCount || 0}人`);
        parts.push(`    人员记录：实际${cmp.totalPersonActualRecordCount || cmp.personActualRecordCountForProject || 0}条 / 预算${cmp.totalPersonBudgetRecordCount || cmp.personBudgetRecordCountForProject || 0}条`);
        if (Array.isArray(cmp.dataQualityWarnings)) {
          for (const warning of cmp.dataQualityWarnings.slice(0, 5)) {
            parts.push(`    ⚠️ ${warning}`);
          }
        }
        const rows = Array.isArray(cmp.rows) ? cmp.rows.slice(0, 50) : [];
        if (rows.length > 0) {
          parts.push(`    项目 | 姓名 | 实际FTE | 预算FTE | 差异FTE | 状态`);
          for (const row of rows) {
            const gap = Number(row.gapFTE || 0);
            parts.push(`    ${row.project} | ${row.person} | ${Number(row.actualFTE || 0).toFixed(2)} | ${Number(row.budgetFTE || 0).toFixed(2)} | ${gap >= 0 ? '+' : ''}${gap.toFixed(2)} | ${row.status}`);
          }
        }
      } else if (Array.isArray(cmp.dataQualityWarnings) && cmp.dataQualityWarnings.length > 0) {
        parts.push(`  🎯 用户问题定向人员预算实际对比：${cmp.dataQualityWarnings.join('；')}`);
      }
    }
    const targetedOverdueProject = id === 'finance.receivables' && _isReceivablesOverdueDetailQuestion(message)
      ? _pickReceivablesProject(message, result)
      : null;

    if (id === 'finance.receivables' && targetedOverdueProject) {
      const project = targetedOverdueProject;
      const text = project && project.overdueAnswer && project.overdueAnswer.text;
      if (text) {
        parts.push(`  🎯 用户问题定向逾期答案（回答当前问题必须优先原样引用）：\n${String(text).split('\n').map(line => `    ${line}`).join('\n')}`);
      } else if (project && Array.isArray(project.overdueDetailLines) && project.overdueDetailLines.length > 0) {
        parts.push(`  🎯 用户问题定向逾期明细（回答当前问题必须且仅能引用这些行）：`);
        for (const line of project.overdueDetailLines) {
          parts.push(`    ✅ ${line}`);
        }
      }
    }
    if (id === 'finance.receivables' && !targetedOverdueProject && Array.isArray(result.overdueDetailLines) && result.overdueDetailLines.length > 0) {
      parts.push('  🎯 逾期明细白名单（回答“逾期有哪些/逾期明细”时只能引用这些行，禁止从普通未回款明细扩展）：');
      for (const line of result.overdueDetailLines.slice(0, 20)) {
        parts.push(`    ✅ ${line}`);
      }
    }

    const basePromptResult = targetedOverdueProject
      ? _buildReceivablesTargetPromptResult(result, targetedOverdueProject)
      : (config.TOOL_DISPLAY_RESULT_SET_ENABLED && _hasDisplayResultSet(result)
          ? _buildDisplayPromptResult(result)
          : result);
    const promptResult = isPersonEffortActualOnly
      ? _buildPersonEffortActualOnlyPromptResult(result)
      : basePromptResult;

    // 2026-04-17 标注术语映射（防止 LLM 直接吐出 FTE 等英文缩写）
    if (!isPersonEffortActualOnly && promptResult._glossary && typeof promptResult._glossary === 'object') {
      const glossLines = Object.entries(promptResult._glossary)
        .map(([term, desc]) => `    - ${term}：${desc}`)
        .join('\n');
      parts.push(`  📖 术语规范（必须使用以下中文表达，禁止直接吐出 FTE/YTD 等英文缩写）：\n${glossLines}`);
    }

    // 2026-04-20 工具级口径使用提示（强约束回答层区分不同口径的数字，避免语义混淆）
    if (promptResult._cohesionHint && typeof promptResult._cohesionHint === 'string') {
      parts.push(`  ⚠️ 口径使用提示：${promptResult._cohesionHint}`);
    }

    if (result.incomplete || (Array.isArray(result.loadErrors) && result.loadErrors.length > 0)) {
      parts.push('  🚫 数据完整性警告：本工具结果不完整。这表示查询链路或源表加载异常，不代表业务数据为 0，也不能回答“暂无数据”。');
      if (Array.isArray(result.loadErrors) && result.loadErrors.length > 0) {
        for (const err of result.loadErrors.slice(0, 5)) {
          const table = err.tableKey || err.table || id;
          const stage = err.stage ? `/${err.stage}` : '';
          parts.push(`    - ${table}${stage}: ${err.message || err}`);
        }
      }
    }

    // 2026-04-29 factSheet 反幻觉机制：工具预渲染的事实清单，Answer 必须逐字引用
    // 2026-05-08 M1：同时识别 _factSheet（新版工具用此命名，与其他 _xxx 元字段一致）
    const factSheetData = (promptResult._factSheet && Array.isArray(promptResult._factSheet) && promptResult._factSheet.length > 0)
      ? promptResult._factSheet
      : (promptResult.factSheet && Array.isArray(promptResult.factSheet) && promptResult.factSheet.length > 0
          ? promptResult.factSheet
          : null);
    if (factSheetData) {
      parts.push(`  📋 事实清单（回答中的数字必须逐字引用以下内容，严禁自行计算或估算）：`);
      for (const fact of factSheetData) {
        parts.push(`    ✅ ${fact}`);
      }
    }

    if (result.empty) {
      parts.push(`  ${result.message || '无数据'}`);
      parts.push(_jsonToText(result, 1, 3, 30));
      continue;
    }

    // 2026-04-23 修复：maxDepth=2 会把 healthCheck.profitMetrics / receivableMetrics / humanMetrics
    // 这类"二层嵌套数值容器"折叠成 "{N个字段}"，导致 Answer LLM 看不到具体数字、只能从 memoryDigest
    // 瞎猜（N5/N6 严重幻觉的真正根因）。把深度放宽到 3，允许展开到叶子数值层。
    // 2026-04-29 maxArrayItems 10→30，避免大数组（客户列表、项目列表、月度序列）被过度截断
    parts.push(_jsonToText(promptResult, 1, 3, 30));
  }

  if (Object.keys(errors).length > 0) {
    parts.push('\n【工具执行异常】');
    parts.push('  以下是工具执行失败，不代表“无数据”、不代表“结果为0”，也不能被解释成“暂无”。回答时必须明确说明是工具失败或查询链路异常。');
    for (const [id, msg] of Object.entries(errors)) {
      parts.push(`  ${id}: ${msg}`);
    }
  }

  return parts.join('\n');
}

/**
 * 将结构化 JSON 转为人可读的缩进文本（最多展开 2 层，数组最多 10 项）
 */
function _jsonToText(obj, depth = 0, maxDepth = 2, maxArrayItems = 10) {
  const indent = '  '.repeat(depth);

  if (obj == null) return `${indent}(无)`;
  if (typeof obj !== 'object') {
    if (typeof obj === 'number') {
      if (Math.abs(obj) >= 10000) return `${indent}${(obj / 10000).toFixed(1)}万`;
      return `${indent}${Number(obj.toFixed(2))}`;
    }
    return `${indent}${String(obj)}`;
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) return `${indent}(空)`;
    // 字符串/数字数组永远展开（本身是扁平结构，不存在嵌套爆炸风险）
    const isPrimitiveArray = obj.every(x => typeof x !== 'object' || x === null);
    if (!isPrimitiveArray && depth >= maxDepth) return `${indent}[${obj.length}项数据]`;

    const lines = [];
    const shown = obj.slice(0, maxArrayItems);
    for (const item of shown) {
      if (typeof item === 'object' && item !== null) {
        lines.push(_flattenObject(item, depth + 1));
      } else {
        lines.push(`${indent}  - ${item}`);
      }
    }
    if (obj.length > maxArrayItems) {
      lines.push(`${indent}  ...共${obj.length}项，仅展示前${maxArrayItems}项`);
    }
    return lines.join('\n');
  }

  if (depth >= maxDepth) {
    return `${indent}{${Object.keys(obj).length}个字段}`;
  }

  const lines = [];
  for (const [key, val] of Object.entries(obj)) {
    if (key.startsWith('_')) continue;
    if (val == null) continue;

    if (typeof val === 'object' && !Array.isArray(val)) {
      lines.push(`${indent}${key}:`);
      lines.push(_jsonToText(val, depth + 1, maxDepth, maxArrayItems));
    } else if (Array.isArray(val)) {
      lines.push(`${indent}${key}: (${val.length}项)`);
      lines.push(_jsonToText(val, depth + 1, maxDepth, maxArrayItems));
    } else if (typeof val === 'number') {
      const formatted = Math.abs(val) >= 10000
        ? `${(val / 10000).toFixed(1)}万`
        : Number(val.toFixed(2));
      lines.push(`${indent}${key}: ${formatted}`);
    } else {
      lines.push(`${indent}${key}: ${val}`);
    }
  }
  return lines.join('\n');
}

function _flattenObject(obj, depth) {
  const indent = '  '.repeat(depth);
  const parts = [];
  for (const [key, val] of Object.entries(obj)) {
    if (key.startsWith('_')) continue;
    if (val == null) continue;
    if (typeof val === 'object') {
      if (Array.isArray(val)) {
        parts.push(`${key}=[${val.length}项]`);
      } else {
        parts.push(`${key}={...}`);
      }
    } else if (typeof val === 'number') {
      const formatted = Math.abs(val) >= 10000
        ? `${(val / 10000).toFixed(1)}万`
        : Number(val.toFixed(2));
      parts.push(`${key}=${formatted}`);
    } else {
      parts.push(`${key}=${val}`);
    }
  }
  return `${indent}• ${parts.join(' | ')}`;
}

module.exports = { executeTools, formatResultsForPrompt };
