'use strict';

const deptNormalizer = require('./dept-normalizer');

const FINANCE_TOOL_PREFIXES = [
  'finance.',
  'analytics.',
  'customer.',
  'presale.',
  'signDelivery.',
  'bidding.',
];

const FINANCE_WORDS = [
  '经营', '收入', '成本', '利润', '毛利', '预算', '完成率', '达成率',
  '回款', '应收', '逾期', '开票', '发票', '账期', '履约', '签约',
  '售前', '招投标', '中标', '客户', '项目', '人效', '工时', '到款',
  '认领', '银行流水', '待认领',
];

const WRITE_WORDS = ['修改', '改成', '改为', '设置', '新增', '删除', '创建', '审批', '发消息', '提醒'];
const EXPORT_WORDS = ['导出', '下载', '发我表格', '生成Excel', '生成 excel'];
const SENSITIVE_WORDS = ['薪酬', '工资', '薪资', '奖金', '调薪', '身份证', '手机号', '个人隐私'];
const EXTERNAL_WORDS = ['竞品', '竞争对手', '外部公司'];
const PENDING_PAYMENT_WORDS = ['到款认领', '待认领', '银行流水', '银行到款', '未认领'];

const COMPANY_SCOPE_WORDS = [
  '全公司', '公司整体', '公司全部', '全部项目', '全量项目', '所有项目',
  '各部门', '所有部门', '全局', '整体毛利率', '公司毛利率',
];

const TEAM_SCOPE_WORDS = [
  '我们部门', '本部门', '部门经营', '部门收入', '部门利润', '部门成本',
  '部门预算', '部门人效', '团队项目', '我管理的团队',
];

const KNOWN_DEPTS = deptNormalizer.DEFAULT_KNOWN_DEPTS;

function hasAny(text, words) {
  return words.some(w => text.includes(w));
}

function normalizeList(v) {
  return Array.isArray(v) ? v.filter(Boolean).map(String) : [];
}

function isFinanceQuestion(message, planResult) {
  const text = String(message || '');
  const tools = normalizeList(planResult && planResult.tools_needed);
  return hasAny(text, FINANCE_WORDS) || tools.some(id => FINANCE_TOOL_PREFIXES.some(p => id.startsWith(p)));
}

function isConceptOnlyQuestion(message) {
  const text = String(message || '').trim();
  if (!/(定义|口径|是什么意思|什么意思|怎么算|计算逻辑|区别|差异)/.test(text)) return false;
  return !/(多少|几个|几笔|排名|最高|最低|最差|统计|列出|明细|清单|哪个|哪几个|怎么样|情况|趋势|分析|为什么|原因|风险)/.test(text);
}

function askedDepartments(message, planResult, scope) {
  const out = new Set();
  const text = String(message || '');
  const known = scope && Array.isArray(scope.depts) && scope.depts.length > 0
    ? scope.depts
    : KNOWN_DEPTS;
  const planned = planResult && planResult.query_scope && Array.isArray(planResult.query_scope.depts)
    ? planResult.query_scope.depts
    : [];
  for (const d of planned) {
    if (!d) continue;
    out.add(deptNormalizer.canonicalizeDeptName(d, known) || String(d));
  }
  for (const d of deptNormalizer.extractDeptsFromText(text, known)) {
    if (d) out.add(d);
  }
  if (text.includes('财务部门')) out.add('财务部');
  return [...out];
}

function isFinanceSpecial(scope) {
  if (!scope) return false;
  if (scope.isGlobal) return true;
  const role = String(scope.roleType || '');
  if (/CEO|CFO|组织部|财务/.test(role)) return true;
  return normalizeList(scope.depts).some(d => /财务|组织部/.test(d));
}

function reply(userName, reason, detail) {
  const name = userName || '同事';
  return `${name}，这个问题${reason}，${detail}`;
}

function rejectResult(type, text) {
  return { reject: true, type, reply: text };
}

function checkFinanceAccess({ message, planResult, scope, userName }) {
  const text = String(message || '');
  const name = userName || (scope && scope.empName) || '';

  if (hasAny(text, WRITE_WORDS)) {
    return rejectResult('write', reply(name, '不可修改', '我只能做只读查询和分析，不能创建、修改、删除飞书表或业务数据。'));
  }

  if (hasAny(text, EXPORT_WORDS)) {
    return rejectResult('export', reply(name, '不可导出', '当前会话不支持导出数据；如确有需要，请走公司正式审批或由有权限人员在飞书中操作。'));
  }

  if (hasAny(text, SENSITIVE_WORDS)) {
    return rejectResult('sensitive', reply(name, '涉及敏感信息且权限不足', '薪酬、调薪、个人隐私等信息不在当前数据权限范围内，我不能查询或披露。'));
  }

  if (hasAny(text, EXTERNAL_WORDS)) {
    return rejectResult('external', reply(name, '不在当前数据权限范围内', '我只能基于公司内部已授权的飞书业务数据回答，不能查询或编造外部竞品公司的财务数据。'));
  }

  if (isConceptOnlyQuestion(text)) return { reject: false };

  if (!isFinanceQuestion(text, planResult)) return { reject: false };
  if (!scope) return rejectResult('no_scope', reply(name, '权限不足', '系统暂时无法确认你的真实飞书权限，因此不能继续查询财务数据。'));

  if (hasAny(text, PENDING_PAYMENT_WORDS) && !isFinanceSpecial(scope)) {
    return rejectResult('pending_payment', reply(name, '权限不足', '银行到款、待认领款和流水认领属于财务专项数据，不在当前数据权限范围内。'));
  }

  const isGlobal = !!scope.isGlobal;
  const dataScope = String(scope.dataScope || 'self');
  const canonicalScope = deptNormalizer.canonicalizeDeptList(normalizeList(scope.depts));
  const depts = [...new Set([...canonicalScope.depts, ...canonicalScope.unresolved])];
  const deptSet = new Set(depts);
  const asked = askedDepartments(text, planResult, scope);
  const outside = asked.filter(d => !deptSet.has(d));

  if (!isGlobal && outside.length > 0) {
    const allowed = depts.length > 0 ? depts.join('、') : '暂无授权部门';
    return rejectResult('dept_scope', reply(name, '权限不足', `你问到的 ${outside.join('、')} 不在当前数据权限范围内。你当前可见范围是：${allowed}。`));
  }

  if (!isGlobal && hasAny(text, COMPANY_SCOPE_WORDS)) {
    const allowed = depts.length > 0 ? depts.join('、') : '个人/项目范围';
    return rejectResult('company_scope', reply(name, '权限不足', `公司级、全公司、全部项目或各部门汇总不在当前数据权限范围内。你当前可见范围是：${allowed}。`));
  }

  if (dataScope === 'self' && hasAny(text, TEAM_SCOPE_WORDS)) {
    return rejectResult('self_scope', reply(name, '权限不足', '你的真实飞书权限是个人范围，部门级或团队级经营数据不在当前数据权限范围内。'));
  }

  return { reject: false };
}

module.exports = {
  checkFinanceAccess,
  _private: {
    isFinanceQuestion,
    isConceptOnlyQuestion,
    askedDepartments,
    isFinanceSpecial,
  },
};
