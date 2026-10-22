/**
 * qa-logger.js - 问答链路专用日志
 *
 * 输出双格式：
 *   logs/qa-trace-YYYY-MM-DD.log   - 人类易读
 *   logs/qa-trace-YYYY-MM-DD.jsonl - 机器可读
 */

'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function _today() {
  return new Date().toISOString().slice(0, 10);
}

const TABLE_CN = {
  profile:          '员工主档',
  employeeProfile:  '员工画像',
  meetings:         '会议记录',
  calendar:         '日历事件',
  workItems:        '工作事项',
  projectMaster:    '项目主档',
  actualProject:    '项目层实际',
  actualDept:       '部门层实际',
  actualWorktime:   '实际工时',
  budgetProject:    '项目层预算',
  budgetDept:       '部门层预算',
  budgetWorktime:   '预算工时',
  cashflow:         '开票回款',
  pendingPayment:   '待认领款',
  invoiceApply:     '发票申请',
  presale:          '售前项目',
  bidding:          '招投标',
  signDelivery:     '签约交付',
  vendorContract:   '供应商合同',
  talentPool:       '活水登记',
  deptYoy:          '部门同比（回滚）',
  companyYoy:       '公司同比（回滚）',
  revenueMom:       '收入利润环比（回滚）',
  rollbackProjectActual: '项目层回滚实际',
  trendPersonal:    '个人趋势快照',
  trendTeam:        '团队趋势快照',
  trendBusiness:    '全司趋势快照',
  trends:           '趋势聚合',
  riskAlert:        '风险告警',
  riskRule:         '风控规则',
  reviews:          '项目复盘',
  customerAnalysis: '客户经营分析',
  // legacy aliases
  projects:         '项目经营数据表',
  performance:      '绩效/经营目标表',
  risk:             '风险告警+风控规则表',
  costDetail:       '成本明细表(项目+部门)',
  projectRisk:      '经营风险运算表',
  healthCheck:      '经营体检综合表',
  budgetCompare:    '预算表(部门+项目)',
  yoyAnalysis:      '同比环比分析表',
};

function tableCN(key) {
  if (!key) return '';
  return TABLE_CN[key] || key;
}

let _toolRegistry = null;
function toolCN(id) {
  if (!id) return '';
  try {
    if (!_toolRegistry) _toolRegistry = require('../tools/tool-registry');
    const def = _toolRegistry.getTool(id);
    if (def && def.name) return `${def.name}(${id})`;
  } catch (_) {
    // ignore
  }
  return id;
}

let _logStream = null;
let _jsonlStream = null;
let _streamDate = '';

function _ensureStreams() {
  const today = _today();
  if (today === _streamDate && _logStream && _jsonlStream) return;
  try { if (_logStream) _logStream.end(); } catch (_) {}
  try { if (_jsonlStream) _jsonlStream.end(); } catch (_) {}
  _streamDate = today;
  _logStream = fs.createWriteStream(path.join(LOG_DIR, `qa-trace-${today}.log`), { flags: 'a' });
  _jsonlStream = fs.createWriteStream(path.join(LOG_DIR, `qa-trace-${today}.jsonl`), { flags: 'a' });
}

function _formatMemoryLines(memoryTrace) {
  const lines = [];
  if (!memoryTrace || !Array.isArray(memoryTrace.attemptedTables) || memoryTrace.attemptedTables.length === 0) {
    return lines;
  }
  const cacheHit = !!(memoryTrace.cache && memoryTrace.cache.hit);
  lines.push(`【Memory 实际取数】cache=${cacheHit ? 'hit' : 'miss'}`);
  for (const key of memoryTrace.attemptedTables) {
    const count = memoryTrace.rowCounts && Object.prototype.hasOwnProperty.call(memoryTrace.rowCounts, key)
      ? memoryTrace.rowCounts[key]
      : '?';
    const err = (memoryTrace.fetchErrors || []).find((item) => item.tableKey === key);
    if (err) {
      lines.push(`- ${tableCN(key)}(${key}) | ERROR | ${err.message}`);
    } else {
      lines.push(`- ${tableCN(key)}(${key}) | rows=${count}`);
    }
  }
  if (memoryTrace.fetchErrors && memoryTrace.fetchErrors.length > 0) {
    lines.push('【Memory 错误明细】');
    for (const item of memoryTrace.fetchErrors) {
      lines.push(`- ${tableCN(item.tableKey)}(${item.tableKey}) @ ${item.stage}: ${item.message}`);
    }
  }
  return lines;
}

/**
 * 记录一次问答
 * @param {object} entry
 */
function record(entry = {}) {
  try {
    _ensureStreams();
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);

    const plan = entry.planResult || {};
    const memoryTrace = entry.memoryTrace || null;
    const toolResults = entry.toolResults || {};
    const toolResultIds = [
      ...Object.keys(toolResults.results || {}),
      ...Object.keys(toolResults.errors || {}),
    ];
    const toolIds = (plan.tools_needed && plan.tools_needed.length ? plan.tools_needed : toolResultIds) || [];
    const tableKeys =
      (memoryTrace && Array.isArray(memoryTrace.attemptedTables) && memoryTrace.attemptedTables.length
        ? memoryTrace.attemptedTables
        : null)
      || (plan.tables_needed && plan.tables_needed.length ? plan.tables_needed : null)
      || entry.loadedTables
      || [];

    const toolsCN = toolIds.map(toolCN);
    const tablesCN = tableKeys.map(tableCN);
    const toolErrors = Object.entries(toolResults.errors || {});

    const blk = [];
    blk.push('='.repeat(88));
    blk.push(`[${ts}] 用户=${entry.userName || '匿名'} (role=${entry.role || '-'}) id=${entry.userId || '-'} source=${entry.source || '-'} 耗时=${entry.elapsedMs != null ? `${entry.elapsedMs}ms` : '-'}`);
    blk.push('');
    blk.push('【用户提问】');
    blk.push(entry.question || '');
    blk.push('');
    blk.push(`【计划选表】(${tablesCN.length}) ${tablesCN.join('、') || '无'}`);
    blk.push(`【计划工具】(${toolsCN.length}) ${toolsCN.join('、') || '无'}`);
    if (plan.out_of_scope) {
      blk.push(`【超范围】是，原因：${plan.out_of_scope_reason || '-'}`);
    }
    if (plan.period) {
      blk.push(`【时间口径】${plan.period}`);
    }
    if (entry.resolvedReference && entry.resolvedReference.resolvedMessage) {
      blk.push(`【追问改写】${entry.resolvedReference.originalMessage || entry.question || ''} -> ${entry.resolvedReference.resolvedMessage}`);
    }
    if (plan.query_scope && Array.isArray(plan.query_scope.targetProjects) && plan.query_scope.targetProjects.length > 0) {
      blk.push(`【项目范围】source=${plan.query_scope.scopeSource || 'none'} projects=${plan.query_scope.targetProjects.length}`);
    }

    const memoryLines = _formatMemoryLines(memoryTrace);
    if (memoryLines.length > 0) {
      blk.push('');
      blk.push(...memoryLines);
    }

    if (toolErrors.length > 0) {
      blk.push('');
      blk.push('【工具异常】');
      blk.push('以下异常表示工具执行失败，不等于“无数据”或“结果为0”。');
      for (const [id, msg] of toolErrors) {
        blk.push(`- ${toolCN(id)}: ${msg}`);
      }
    }

    if (entry.error) {
      blk.push('');
      blk.push(`【错误】${entry.error}`);
    }

    blk.push('');
    blk.push('【Agent 回答】');
    blk.push(entry.reply || '');
    blk.push('');
    _logStream.write(blk.join('\n') + '\n');

    const jsonEntry = {
      ts,
      user_name: entry.userName || null,
      user_id: entry.userId || null,
      role: entry.role || null,
      source: entry.source || null,
      question: entry.question || '',
      reply: entry.reply || '',
      tables_cn: tablesCN,
      tables_keys: tableKeys,
      tools_cn: toolsCN,
      tools_ids: toolIds,
      out_of_scope: !!plan.out_of_scope,
      out_of_scope_reason: plan.out_of_scope_reason || '',
      period: plan.period || '',
      query_scope: plan.query_scope || null,
      resolved_reference: entry.resolvedReference || null,
      pending_clarification: entry.pendingClarification || null,
      effective_message: entry.resolvedReference && entry.resolvedReference.resolvedMessage
        ? entry.resolvedReference.resolvedMessage
        : entry.question || '',
      elapsed_ms: entry.elapsedMs != null ? entry.elapsedMs : null,
      error: entry.error || null,
      memory_trace: memoryTrace,
      tool_errors: toolErrors.map(([id, msg]) => ({ id, name: toolCN(id), message: msg })),
    };
    _jsonlStream.write(JSON.stringify(jsonEntry) + '\n');
  } catch (e) {
    logger.warn(`[QALogger] 写入失败: ${e.message}`);
  }
}

module.exports = { record, tableCN, toolCN, TABLE_CN };
