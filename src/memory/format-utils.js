function fmtMoneyInline(val) {
  if (val == null || isNaN(val)) return '--';
  const abs = Math.abs(val);
  if (abs >= 10000) return `${(val / 10000).toFixed(1)}万元`;
  return `${Math.round(val)}元`;
}

function fmtMonthLabel(monthVal) {
  const s = String(monthVal || '');
  if (s.length === 4) return `20${s.slice(0, 2)}年${parseInt(s.slice(2), 10)}月`;
  if (s.length === 6) return `${s.slice(0, 4)}年${parseInt(s.slice(4), 10)}月`;
  return s || '未知';
}

function formatPersonField(personArr) {
  if (!personArr || !Array.isArray(personArr)) return '';
  return personArr.map(p => p.name || p.en_name || '').filter(Boolean).join('、');
}

function buildMetadataGuide(loadedSections, tableMetadata) {
  const sectionToTables = {
    profile: ['EMPLOYEE'],
    employeeProfile: ['EMPLOYEE_PROFILE'],
    meetings: ['MEETING_SNAPSHOT'],
    calendar: ['CALENDAR_EVENT'],
    workItems: ['WORK_ITEM'],
    projectMaster: ['PROJECT_NAME_UNIQUE'],
    actualProject: ['ACTUAL_PROJECT'],
    actualDept: ['ACTUAL_DEPT'],
    actualWorktime: ['ACTUAL_WORKTIME'],
    budgetProject: ['BUDGET_PROJECT'],
    budgetDept: ['BUDGET_DEPT'],
    budgetWorktime: ['BUDGET_WORKTIME'],
    cashflow: ['INVOICE'],
    pendingPayment: ['PENDING_PAYMENT'],
    invoiceApply: ['INVOICE_APPLY'],
    presale: ['PRESALE_PROJECT'],
    bidding: ['BIDDING_PROJECT'],
    signDelivery: ['SIGN_DELIVERY'],
    vendorContract: ['VENDOR_CONTRACT'],
    talentPool: ['TALENT_POOL'],
    deptYoy: ['DEPT_YOY'],
    companyYoy: ['COMPANY_YOY'],
    revenueMom: ['REVENUE_MOM'],
    rollbackProjectActual: ['ROLLBACK_PROJECT_ACTUAL'],
    trendPersonal: ['PERSONAL_TREND'],
    trendTeam: ['TEAM_TREND'],
    trendBusiness: ['BUSINESS_TREND'],
    riskAlert: ['USER_RISK_ALERT'],
    riskRule: ['RISK_CONTROL_RULE'],
    reviews: ['REVIEW'],
    customerAnalysis: [],
  };

  const mentioned = new Set();
  for (const section of loadedSections) {
    const tables = sectionToTables[section] || [];
    tables.forEach(t => mentioned.add(t));
  }

  if (mentioned.size === 0) return '';

  const lines = ['===== 数据使用指南（本次加载的表）====='];
  for (const tableKey of mentioned) {
    const meta = tableMetadata[tableKey];
    if (!meta) continue;
    lines.push(`\n▸ ${tableKey}: ${meta.description}`);
    if (meta.traps && meta.traps.length > 0) {
      lines.push('  ⚠️ 注意事项:');
      for (const trap of meta.traps.filter(t => !t.startsWith('//'))) {
        lines.push(`    - ${trap}`);
      }
    }
  }
  return lines.join('\n');
}

module.exports = {
  fmtMoneyInline,
  fmtMonthLabel,
  formatPersonField,
  buildMetadataGuide,
};
