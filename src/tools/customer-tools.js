/**
 * customer-tools.js - 客户经营分析工具
 *
 * 从「项目名称（唯一值）」表读取数据，以客户为维度聚合：
 *   - 合作总金额
 *   - 合作 SKU 列表
 *   - 合作项目名称 + 状态
 *
 * 函数签名: (memory, scope) => structuredResult
 */

const FM = require('../utils/field-mapping');
const { isDeliveryActiveStatus, DELIVERY_ACTIVE_STATUSES } = require('../config/finance-calibers');
const displayUtils = require('./display-result-set-utils');

function _projectName(fields, F) {
  return FM.str(fields, F.PROJECT_26) || FM.str(fields, F.PROJECT_NAME_MR) || FM.str(fields, F.CONTRACT_NAME);
}

function _isVirtualServiceProject(fields, F) {
  const type = FM.str(fields, F.PROJECT_TYPE);
  const name = _projectName(fields, F);
  return /虚拟|管理|商务|组织支撑|未分配精力|售前费用|公共基金|挂账|AI产品赋能|AI Agent运营平台|残疾人项目/.test(type)
    || /管理|商务|组织支撑|未分配精力|售前费用|公共基金|挂账|AI产品赋能|AI Agent运营平台|残疾人项目/.test(name);
}

function _customerLoadErrors(memory) {
  const trace = memory && memory._traceMeta;
  const errors = trace && Array.isArray(trace.fetchErrors) ? trace.fetchErrors : [];
  return errors.filter((err) => err && err.tableKey === 'customerAnalysis');
}

function _customerSortBy(params, serviceQuestion) {
  const raw = String(params && params.sortBy || '').trim();
  if (['totalAmount', 'projectCount', 'activeCount', 'amount'].includes(raw)) return raw;
  if (serviceQuestion) return 'projectCount';
  return 'totalAmount';
}

function _customerValue(row, sortBy) {
  if (sortBy === 'projectCount') return row.projectCount;
  if (sortBy === 'activeCount') return row.activeCount;
  if (sortBy === 'amount') return row.amount;
  return row.totalAmount;
}

function _buildCustomerDisplay({ customers, serviceCustomers, serviceQuestion, params, scope }) {
  if (!displayUtils.shouldBuild(params, scope)) return {};
  const useService = serviceQuestion || String(params && params.metric || '').includes('service');
  const sortBy = _customerSortBy(params, useService);
  const sortOrder = displayUtils.order(params, 'desc');
  const source = useService ? serviceCustomers : customers;
  const rows = displayUtils.sortRows(source, sortBy, sortOrder, _customerValue, row => row.name || row.customer);
  return displayUtils.build({
    toolId: 'customer.analysis',
    type: useService ? 'customer.serviceCustomers' : 'customer.customers',
    rows,
    params,
    scope,
    sortBy,
    sortOrder,
    rowMapper: row => ({
      type: 'customer',
      name: row.name || row.customer,
      totalAmount: row.totalAmount ?? row.amount,
      projectCount: row.projectCount,
      activeCount: row.activeCount,
      skus: row.skus,
      projects: Array.isArray(row.projects)
        ? row.projects.map(p => (typeof p === 'string' ? p : p.name)).filter(Boolean).slice(0, 12)
        : [],
    }),
  });
}

function customerAnalysis(memory, scope, params = {}) {
  const records = memory.customerProjects || [];
  if (records.length === 0) {
    const loadErrors = _customerLoadErrors(memory);
    if (loadErrors.length > 0) {
      return {
        empty: true,
        incomplete: true,
        message: '本次客户经营数据读取失败，无法判断当前是否有服务中项目或客户经营数据。',
        loadErrors,
        _sourceTable: 'PROJECT_NAME_UNIQUE（项目名称唯一值表）按「项目归属部门」过滤',
      };
    }
    return { empty: true, message: '暂无客户经营数据（项目名称唯一值表无匹配记录）' };
  }

  const F = FM.PROJECT_NAME_UNIQUE_FIELDS;
  const customerMap = {};
  let totalAmount = 0;
  let skippedNoCustomer = 0;
  const skippedProjectSamples = []; // 2026-04-21 P2：让 LLM 知道"因客户字段为空被跳过"的项目样本
  const serviceProjects = [];
  const virtualServiceProjects = [];
  const serviceCustomerMap = {};

  for (const rec of records) {
    const f = rec.fields || {};
    const projName = _projectName(f, F);
    const status = FM.str(f, F.STATUS) || '未知';
    const dept = FM.str(f, F.DEPT) || '(未分部门)';
    const amount = FM.num(f, F.CONTRACT_AMOUNT);
    const customer = FM.str(f, F.CUSTOMER);
    const serviceCustomer = customer || (projName ? projName.split('-')[0] : '');

    if (isDeliveryActiveStatus(status) && projName) {
      const serviceItem = {
        name: projName,
        customer: serviceCustomer || '(客户未填)',
        dept,
        status,
        sku: FM.str(f, F.SKU),
        amount,
        projectType: FM.str(f, F.PROJECT_TYPE),
      };
      if (_isVirtualServiceProject(f, F)) {
        virtualServiceProjects.push(serviceItem);
      } else {
        serviceProjects.push(serviceItem);
        if (!serviceCustomerMap[serviceItem.customer]) {
          serviceCustomerMap[serviceItem.customer] = { customer: serviceItem.customer, projects: [], amount: 0, skus: new Set() };
        }
        serviceCustomerMap[serviceItem.customer].projects.push(serviceItem.name);
        serviceCustomerMap[serviceItem.customer].amount += amount;
        if (serviceItem.sku) serviceItem.sku.split(',').forEach(s => serviceCustomerMap[serviceItem.customer].skus.add(s.trim()));
      }
    }

    if (!customer) {
      skippedNoCustomer++;
      if (skippedProjectSamples.length < 8) {
        const name = projName || '(未命名)';
        skippedProjectSamples.push(name);
      }
      continue;
    }

    if (!customerMap[customer]) {
      customerMap[customer] = {
        totalAmount: 0,
        skus: new Set(),
        projects: [],
        statusCount: { 履约中: 0, 已结案: 0, 商务: 0, 预计新签: 0, other: 0 },
      };
    }

    const entry = customerMap[customer];
    entry.totalAmount += amount;
    totalAmount += amount;

    const sku = FM.str(f, F.SKU);
    if (sku) {
      sku.split(',').forEach(s => entry.skus.add(s.trim()));
    }

    if (projName) {
      entry.projects.push({ name: projName, status, amount });
    }

    if (entry.statusCount[status] !== undefined) {
      entry.statusCount[status]++;
    } else {
      entry.statusCount.other++;
    }
  }

  const customers = Object.entries(customerMap)
    .map(([name, data]) => ({
      name,
      totalAmount: data.totalAmount,
      skus: [...data.skus],
      projectCount: data.projects.length,
      projects: data.projects,
      statusCount: data.statusCount,
      activeCount: DELIVERY_ACTIVE_STATUSES.reduce((sum, s) => sum + (data.statusCount[s] || 0), 0),
    }))
    .sort((a, b) => b.totalAmount - a.totalAmount);

  const allSkus = [...new Set(customers.flatMap(c => c.skus))];
  const serviceCustomers = Object.values(serviceCustomerMap)
    .map(c => ({
      customer: c.customer,
      projectCount: c.projects.length,
      projects: c.projects,
      amount: c.amount,
      skus: [...c.skus].filter(Boolean),
    }))
    .sort((a, b) => b.projectCount - a.projectCount || b.amount - a.amount);

  // 2026-04-21 P2：scope 口径标签（让 LLM 在回答中主动声明"本次统计覆盖部门"）
  const scopeDepts = (scope && Array.isArray(scope.depts)) ? scope.depts : [];
  const scopeLabel = (scope && scope.isGlobal)
    ? '全公司'
    : (scopeDepts.length > 0 ? scopeDepts.join(' + ') : '(未知)');
  const serviceQuestion = /服务中|履约中|在服务/.test(String((scope && scope.question) || ''));

  // 2026-04-21 P2：透明提示 —— 防止 LLM 把"1 家客户"当绝对事实
  const hintLines = [];
  hintLines.push(`【scope 口径】本次客户统计覆盖部门：${scopeLabel}。回答用户时必须主动说明"以上数据覆盖 ${scopeLabel}"，避免用户误以为是全公司数据。`);
  if (skippedNoCustomer > 0) {
    const pct = Math.round((skippedNoCustomer / records.length) * 100);
    hintLines.push(`【数据完整度】共扫描 ${records.length} 个项目，其中 ${skippedNoCustomer} 个（${pct}%）因「客户」字段在飞书多维表中为空被跳过，未纳入客户去重统计（例如：${skippedProjectSamples.slice(0, 3).join('、')}${skippedProjectSamples.length > 3 ? ' 等' : ''}）。回答用户"客户数/合作金额"时必须声明"另有 ${skippedNoCustomer} 个项目因客户字段未填不纳入统计"，不要断言"只有 ${customers.length} 家客户"。`);
  }

  // factSheet：全量客户紧凑摘要，绕过 _jsonToText 的数组截断限制
  const factSheet = [
    `客户总数 ${customers.length} 家（覆盖 ${scopeLabel}），合同金额合计 ${(totalAmount / 10000).toFixed(1)}万，涉及 ${allSkus.length} 类 SKU`,
  ];
  if (skippedNoCustomer > 0) {
    factSheet.push(`另有 ${skippedNoCustomer} 个项目因客户字段未填不纳入统计`);
  }
  for (const c of customers) {
    const skuStr = c.skus.length > 0 ? c.skus.join('、') : '(未标注)';
    const amt = (c.totalAmount / 10000).toFixed(1);
    const activeLabel = c.activeCount > 0
      ? `履约口径${DELIVERY_ACTIVE_STATUSES.map(s => `${s}${c.statusCount[s] || 0}个`).join('、')}`
      : '无在途';
    factSheet.push(`${c.name}：合同金额${amt}万 | SKU: ${skuStr} | 项目${c.projectCount}个(${activeLabel})`);
  }

  const serviceFactSheet = [
    `[${scopeLabel}] 服务中客户 ${serviceCustomers.length} 家；服务中交付项目 ${serviceProjects.length} 个；另有虚拟/内部项目 ${virtualServiceProjects.length} 个已单独剔除；服务中/履约中口径=${DELIVERY_ACTIVE_STATUSES.join('、')}`,
    `服务中客户清单：${serviceCustomers.map((c, idx) => `${idx + 1}. ${c.customer}（${c.projectCount}个项目：${c.projects.join('、')}）`).join('；')}`,
    `服务中项目清单：${serviceProjects.map((p, idx) => `${idx + 1}. ${p.name}（客户=${p.customer}，部门=${p.dept}${p.sku ? `，SKU=${p.sku}` : ''}）`).join('；')}`,
  ];
  if (virtualServiceProjects.length > 0) {
    serviceFactSheet.push(`虚拟/内部项目不计入服务中项目数：${virtualServiceProjects.map(p => `${p.name}（${p.dept}）`).join('、')}`);
  }

  if (serviceQuestion) {
    hintLines.push(`【服务中口径强约束】用户问服务中客户/项目时，只能引用 serviceCustomers/serviceProjects 与 serviceFactSheet；服务中/履约中=${DELIVERY_ACTIVE_STATUSES.join('、')}，虚拟/内部项目必须单独说明且不计入项目数。回答开头必须说明该口径。`);
  }
  hintLines.push('【回答格式约束】factSheet/serviceFactSheet 已包含完整清单，回答时必须基于这些文本。飞书消息支持宽表和完整长清单；用户要明细/清单时不要主动截断为 Top 8，也不要因列数较多禁止 markdown 表格。');
  const displayPayload = _buildCustomerDisplay({
    customers,
    serviceCustomers,
    serviceQuestion,
    params,
    scope,
  });

  return {
    totalCustomers: customers.length,
    totalProjects: records.length,
    totalAmount,
    skippedNoCustomer,
    skippedProjectSamples,
    skuCategories: allSkus.length,
    topCustomers: customers.slice(0, 20),
    allCustomers: customers,
    ...displayPayload,
    serviceCustomerCount: serviceCustomers.length,
    serviceProjectCount: serviceProjects.length,
    serviceCustomers,
    serviceProjects,
    virtualServiceProjects,
    serviceFactSheet,
    factSheet,
    _factSheet: serviceQuestion ? serviceFactSheet : factSheet,
    _scopeLabel: scopeLabel,
    _sourceTable: 'PROJECT_NAME_UNIQUE（项目名称唯一值表）按「项目归属部门」过滤',
    _cohesionHint: hintLines.length > 0 ? hintLines.join('\n    ') : undefined,
  };
}

module.exports = { customerAnalysis };
