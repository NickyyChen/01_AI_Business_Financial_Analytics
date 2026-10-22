/**
 * pipeline-trace.js - Pipeline 全链路追踪日志
 *
 * 为每次请求生成一份可读的追踪报告，覆盖：
 *   - 用户问题
 *   - Plan 阶段：工具/表选择
 *   - Execute 阶段：Memory 实际取数、工具执行结果
 *   - Answer 阶段：完整 prompt 与输出
 */

const fs = require('fs');
const path = require('path');
const toolRegistry = require('../tools/tool-registry');

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

function toolCN(id) {
  const def = toolRegistry.getTool(id);
  return def ? `${def.name}(${id})` : id;
}

function tableCN(key) {
  return TABLE_CN[key] ? `${TABLE_CN[key]}(${key})` : key;
}

function ts() {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function line(ch, len) {
  return ch.repeat(len);
}

class PipelineTrace {
  constructor(logDir) {
    this.logDir = logDir || path.join(__dirname, '../../logs/test');
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    this.buf = [];
    this.caseNo = 0;
  }

  _w(text) {
    this.buf.push(text);
  }

  writeHeader(title) {
    this._w(line('=', 80));
    this._w(`  ${title}`);
    this._w(`  生成时间: ${ts()}`);
    this._w(line('=', 80));
    this._w('');
  }

  startCase(question, userName, role) {
    this.caseNo++;
    this._w('');
    this._w(line('-', 80));
    this._w(`  测试 #${this.caseNo}`);
    this._w(line('-', 80));
    this._w(`  用户: ${userName || '未知'} | 角色: ${role || '员工'}`);
    this._w(`  提问: ${question}`);
    this._w(`  时间: ${ts()}`);
    this._w(line('-', 80));
  }

  logPhase01(elapsed, scope, planResult) {
    this._w('');
    this._w(`  [Phase 0+1] 权限解析 & Plan 规划 (${elapsed}ms)`);

    if (scope) {
      this._w(`  - 权限范围: ${scope.dataScope || '未知'}`);
      this._w(`  - 全局权限: ${scope.isGlobal ? '是' : '否'}`);
      this._w(`  - 可见模块: ${(scope.visibleModules || []).join('、') || '无'}`);
    } else {
      this._w('  - 权限: 解析失败或无权限');
    }

    if (!planResult) {
      this._w('  - Plan: 跳过规划（闲聊/短消息）');
      return;
    }

    if (planResult.out_of_scope) {
      this._w('  - Plan: 超出能力范围');
      this._w(`  - 原因: ${planResult.out_of_scope_reason || '(未说明)'}`);
      return;
    }

    const tools = planResult.tools_needed || [];
    const tables = planResult.tables_needed || [];
    this._w(`  - 工具(${tools.length}): ${tools.length > 0 ? tools.map(toolCN).join('、') : '无'}`);
    this._w(`  - 数据表(${tables.length}): ${tables.length > 0 ? tables.map(tableCN).join('、') : '无'}`);
    this._w(`  - 时间口径: ${typeof planResult.period === 'object' ? JSON.stringify(planResult.period) : (planResult.period || 'latest')}`);
    this._w(`  - 下属深度: ${planResult.subordinate_depth || 1}`);

    if (Array.isArray(planResult.question_decomposition) && planResult.question_decomposition.length > 0) {
      this._w('  - 问题拆解:');
      planResult.question_decomposition.forEach((q, index) => {
        this._w(`    ${index + 1}. ${q}`);
      });
    }

    if (planResult.reasoning_framework) {
      this._w(`  - 推理框架: ${planResult.reasoning_framework}`);
    }
  }

  logPhase2(elapsed, tableKeys, toolExecution, memoryTrace = null) {
    this._w('');
    this._w(`  [Phase 2] 数据加载 & 工具执行 (${elapsed}ms)`);

    if (tableKeys && tableKeys.size > 0) {
      this._w(`  - Planner 选表: ${[...tableKeys].map(tableCN).join('、')}`);
    } else {
      this._w('  - Planner 选表: 使用默认加载');
    }

    if (memoryTrace && Array.isArray(memoryTrace.attemptedTables) && memoryTrace.attemptedTables.length > 0) {
      const cacheHit = !!(memoryTrace.cache && memoryTrace.cache.hit);
      this._w(`  - Memory 实际取数${cacheHit ? ' (cache hit)' : ''}:`);
      for (const key of memoryTrace.attemptedTables) {
        const count = memoryTrace.rowCounts && Object.prototype.hasOwnProperty.call(memoryTrace.rowCounts, key)
          ? memoryTrace.rowCounts[key]
          : '?';
        const err = (memoryTrace.fetchErrors || []).find((item) => item.tableKey === key);
        const tail = err ? `失败: ${err.message}` : `行数=${count}`;
        this._w(`    - ${tableCN(key)} | ${tail}`);
      }
      if (memoryTrace.fetchErrors && memoryTrace.fetchErrors.length > 0) {
        this._w('  - Memory 取数异常:');
        for (const item of memoryTrace.fetchErrors) {
          this._w(`    - ${tableCN(item.tableKey)} @ ${item.stage}: ${item.message}`);
        }
      }
    } else {
      this._w('  - Memory 实际取数: 未记录到详细行数');
    }

    const results = (toolExecution && toolExecution.results) || {};
    const errors = (toolExecution && toolExecution.errors) || {};
    const toolCount = Object.keys(results).length + Object.keys(errors).length;

    if (toolCount === 0) {
      this._w('  - 工具执行: 无工具调用');
      return;
    }

    this._w(`  - 工具执行结果(${toolExecution.elapsed || 0}ms):`);
    for (const [id, result] of Object.entries(results)) {
      const summary = result && result.empty ? '(无数据)' : _summarize(result);
      this._w(`    - OK ${toolCN(id)}: ${summary}`);
    }
    for (const [id, msg] of Object.entries(errors)) {
      this._w(`    - FAIL ${toolCN(id)}: ${msg}`);
    }
    if (Object.keys(errors).length > 0) {
      this._w('    - 注意: 工具失败表示执行异常，不等于“无数据”或“结果为0”');
    }
  }

  logPhase3Prompt(systemPrompt, userMessage, historyCount) {
    this._w('');
    this._w('  [Phase 3] Answer LLM 输入');
    this._w(`  - System Prompt: ${systemPrompt.length} 字`);
    this._w(`  - 用户消息: ${userMessage}`);
    this._w(`  - 对话历史: ${historyCount} 条`);
    this._w('  - System Prompt 完整内容:');
    for (const ln of systemPrompt.split('\n')) {
      this._w(`    ${ln}`);
    }
  }

  logPhase3Output(reply, elapsed, usage) {
    this._w('');
    this._w('  [Phase 3] Answer LLM 输出');
    this._w(`  - 耗时: ${elapsed}ms`);
    this._w(`  - 回复长度: ${reply.length} 字`);
    if (usage) {
      this._w(
        `  - Token: input=${usage.input_tokens || usage.prompt_tokens || '?'} output=${usage.output_tokens || usage.completion_tokens || '?'} total=${usage.total_tokens || '?'}`,
      );
    }
    this._w('  - LLM 完整输出:');
    for (const ln of reply.split('\n')) {
      this._w(`    ${ln}`);
    }
  }

  logSummary(totalElapsed) {
    this._w('');
    this._w(`  总耗时: ${totalElapsed}ms (${(totalElapsed / 1000).toFixed(1)}s)`);
    this._w(line('-', 80));
  }

  logError(error) {
    this._w('');
    this._w(`  错误: ${error.message || error}`);
    if (error.stack) {
      this._w(`  ${error.stack.split('\n').slice(1, 4).join('\n  ')}`);
    }
    this._w(line('-', 80));
  }

  writeFooter(caseCount, passCount, failCount) {
    this._w('');
    this._w(line('=', 80));
    this._w('  测试汇总');
    this._w(`  总计: ${caseCount} | 成功: ${passCount} | 失败: ${failCount}`);
    this._w(`  完成时间: ${ts()}`);
    this._w(line('=', 80));
  }

  flush(filename) {
    const filePath = path.join(this.logDir, filename);
    fs.writeFileSync(filePath, this.buf.join('\n') + '\n', 'utf-8');
    return filePath;
  }

  getBuffer() {
    return this.buf;
  }

  appendToFile(filename) {
    const filePath = path.join(this.logDir, filename);
    fs.appendFileSync(filePath, this.buf.join('\n') + '\n', 'utf-8');
    this.buf = [];
    return filePath;
  }
}

function _summarize(obj) {
  if (typeof obj !== 'object' || obj === null) return String(obj);
  const keys = Object.keys(obj).filter((k) => !k.startsWith('_'));
  if (keys.length <= 4) {
    return keys.map((k) => {
      const v = obj[k];
      if (v == null) return `${k}=null`;
      if (typeof v === 'number') return `${k}=${Math.abs(v) >= 10000 ? `${(v / 10000).toFixed(1)}万` : v.toFixed(2)}`;
      if (typeof v === 'string') return `${k}=${v.length > 20 ? `${v.slice(0, 20)}...` : v}`;
      if (Array.isArray(v)) return `${k}=[${v.length}项]`;
      return `${k}={...}`;
    }).join(', ');
  }
  return `{${keys.length}个字段}`;
}

module.exports = PipelineTrace;
