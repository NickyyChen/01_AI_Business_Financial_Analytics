"""Parse all 41 Excel sheets and generate markdown documentation."""
import pandas as pd
import json
import os

XLSX = os.path.join(os.path.dirname(__file__), '..', 'table', '零一员工-薪酬-项目信息表.xlsx')
OUT = os.path.join(os.path.dirname(__file__), '..', 'docs', '多维表格结构说明.md')

xls = pd.ExcelFile(XLSX)
data = []

for i, name in enumerate(xls.sheet_names):
    try:
        df_head = pd.read_excel(xls, sheet_name=name, nrows=5)
        df_full = pd.read_excel(xls, sheet_name=name)
        total_rows = len(df_full)
        cols = list(df_head.columns)
        samples = []
        for ri in range(min(2, len(df_head))):
            row_data = {}
            for c in cols:
                v = df_head.iloc[ri][c]
                if pd.isna(v):
                    row_data[c] = None
                else:
                    row_data[c] = str(v)[:80]
            samples.append(row_data)
        data.append(dict(idx=i+1, name=name, rows=total_rows, cols=len(cols), columns=cols, samples=samples))
    except Exception as e:
        data.append(dict(idx=i+1, name=name, rows=0, cols=0, columns=[], samples=[], error=str(e)))

xls.close()

TABLE_ID_MAP = {
    '【主数据】员工主档表': ('EMPLOYEE', 'tblhKt8cui0TjHUQ'),
    '【主数据】全员花名册（自动同步原始表）': ('ROSTER', 'tblxImBaOiRnQm1P'),
    '🔵 员工': ('EMPLOYEE_PROFILE', 'tblPO49Aaff2Fzqx'),
    '【主数据】项目人力投入表': ('PROJECT_STAFFING', 'tbl4KU6qU5L03IGE'),
    '【主数据】项目经营主数据表': ('PROJECT_MASTER', 'tblQA7v58f57SKbV'),
    '【运行】管理SKU能力评点亮表': ('(SKU运行表)', 'tblqhSQl0BUoiq7n'),
    '【晋升差距建议表】': ('PROMOTION_GAP', 'tblwcrn8ofUmlKkp'),
    '【晋升管理排序表】': ('PROMOTION_DASHBOARD', 'tbl3FQZKwWWDNVhi'),
    '【晋升刷新频次配置表】': ('PROMOTION_REFRESH_CONFIG', 'tblR3d2193aODsbi'),
    '【规则】晋升规则表': ('(晋升规则表)', 'tblPZ8Yd5LhDuZwR'),
    '【主数据】项目月度经营汇总表': ('PROJECT_MONTHLY', 'tblcvWMpQEU1CHUn'),
    '【主数据】业绩目标表': ('PERFORMANCE_TARGET', 'tblI7izClPNHso2h'),
    '【规则】经营风险调控规则表': ('RISK_CONTROL_RULE', 'tbl0MmaV0cJ5h5uF'),
    '经营风险告警快照表': ('USER_RISK_ALERT', 'tbld4ZmuEQCyGNcx'),
    '个人经营趋势快照': ('PERSONAL_TREND', 'tblhJ8ZhhmwBWm4u'),
    '团队经营趋势快照': ('TEAM_TREND', 'tblEwEe5KIk6Dlxz'),
    '全司经营趋势快照': ('BUSINESS_TREND', 'tblyndDYAXtqji28'),
    '【规则】高级权限管理': ('PERMISSION_MGMT', 'tblki00JNJrCoE9U'),
    '【规则】权限规则表': ('PERMISSION_RULE', 'tblr9pcUkG79lsQh'),
    '🔵 复盘表（API）': ('REVIEW', 'tblp1A14z5rpUN29'),
    '日程事件映射表': ('CALENDAR_EVENT', 'tblszfSrpMceVieC'),
    '群聊摘要快照表': ('CHAT_SNAPSHOT', 'tbl9wuEOoeHgWiCx'),
    '会议摘要快照表': ('MEETING_SNAPSHOT', 'tbl3lsufplDRfJtn'),
    '工作总结快照表': ('WORK_SUMMARY', 'tblzeQKdtBjyxUiO'),
    '工作事项汇总表': ('WORK_ITEM', 'tblsEU4bLmut46LD'),
    '商机管线': ('OPPORTUNITY_PIPELINE', 'tblztxNuZDjRTcv4'),
    '🟢 售前项目': ('(售前项目)', 'tblafsNAQnCANMlV'),
    '回款管理': ('ACCOUNTS_RECEIVABLE', 'tblUnaTamqZq4zFU'),
    '开票、回款计划': ('(开票回款计划)', 'tblMi3eIOiS0pC37'),
    '成本明细': ('COST_DETAIL', 'tblRvdSyyL92UtLm'),
    '实际：部门层': ('(部门层实际)', 'tblzlO1GDuaRkLpT'),
    '实际：项目层': ('(项目层实际)', 'tblSnDXGlKg4nuB9'),
    '项目履约风险': ('PROJECT_RISK', 'tblwesAWd0X5h4OQ'),
    '人力空单与兼项': ('STAFF_UTILIZATION', 'tbltyCJzwOpje5ez'),
    '【龙虾】员工风险洞察': ('EMPLOYEE_INSIGHT', 'tblsX6QZUQJBAlaL'),
    'OAuth Token Store': ('OAUTH_TOKEN', 'tblbRG6NNumPgckV'),
    '项目交付计划': ('DELIVERY_PLAN', 'tblLbxP9OUuEMgAk'),
    '【规则】个人能力雷达规则表': ('(能力雷达规则)', 'tblCZvBGBYJK1Y0g'),
    '【规则】组织团队健康诊断规则表': ('(团队健康诊断规则)', 'tblb0rgWm94rKXzE'),
    '【晋升等级映射配置表】': ('(晋升等级映射)', 'tblQ4mUY6mfVDjrL'),
    '【晋升调薪快照表】': ('PROMOTION_SNAPSHOT', 'tbl7XJfo7iBoo7Ps'),
}

MODULE_MAP = {
    'EMPLOYEE': '人事档案(hr)', 'ROSTER': '人事档案(hr)', 'EMPLOYEE_PROFILE': '人事档案(hr)',
    'PROJECT_MASTER': '项目管理(project)', 'PROJECT_STAFFING': '项目管理(project)', 'REVIEW': '项目管理(project)',
    'PROJECT_MONTHLY': '财务经营(finance)', 'PERFORMANCE_TARGET': '财务经营(finance)',
    'ACCOUNTS_RECEIVABLE': '财务经营(finance)', 'COST_DETAIL': '财务经营(finance)',
    'PROJECT_RISK': '财务经营(finance)', 'OPPORTUNITY_PIPELINE': '财务经营(finance)',
    'STAFF_UTILIZATION': '财务经营(finance)', 'DELIVERY_PLAN': '财务经营(finance)',
    'MEETING_SNAPSHOT': '团队协作(team)', 'CALENDAR_EVENT': '团队协作(team)',
    'WORK_ITEM': '团队协作(team)', 'WORK_SUMMARY': '团队协作(team)', 'CHAT_SNAPSHOT': '团队协作(team)',
    'PROMOTION_SNAPSHOT': 'SKU与晋升(sku)', 'PROMOTION_GAP': 'SKU与晋升(sku)', 'PROMOTION_DASHBOARD': 'SKU与晋升(sku)',
    'USER_RISK_ALERT': '风险预警(risk)', 'EMPLOYEE_INSIGHT': '风险预警(risk)', 'RISK_CONTROL_RULE': '风险预警(risk)',
    'PERSONAL_TREND': '趋势分析(trend)', 'TEAM_TREND': '趋势分析(trend)', 'BUSINESS_TREND': '趋势分析(trend)',
    'PERMISSION_MGMT': '权限管理', 'PERMISSION_RULE': '权限管理', 'OAUTH_TOKEN': '系统',
}

lines = []
lines.append('# 多维表格（Bitable）完整结构说明\n')
lines.append('> 数据来源: `table/零一员工-薪酬-项目信息表.xlsx`（导出于 2026-04-14）')
lines.append('>')
lines.append(f'> 共 **{len(data)} 张表**，涵盖员工主数据、项目经营、财务、团队协作、晋升、风险、权限等板块\n')

lines.append('## 总览\n')
lines.append('| # | 表名 | config key | table_id | 所属板块 | 行数 | 字段数 |')
lines.append('|---|------|-----------|----------|---------|------|-------|')
for t in data:
    m = TABLE_ID_MAP.get(t['name'])
    ck = m[0] if m else '-'
    tid = m[1] if m else '-'
    mod = MODULE_MAP.get(ck, '-')
    lines.append(f"| {t['idx']} | {t['name']} | `{ck}` | `{tid}` | {mod} | {t['rows']} | {t['cols']} |")
lines.append('\n---\n')

for t in data:
    idx = t['idx']
    name = t['name']
    m = TABLE_ID_MAP.get(name)
    ck = m[0] if m else '(未映射)'
    tid = m[1] if m else '?'
    mod = MODULE_MAP.get(ck, '-')

    lines.append(f'## {idx}. {name}\n')
    lines.append(f'- **config key**: `{ck}`')
    lines.append(f'- **table_id**: `{tid}`')
    lines.append(f'- **所属板块**: {mod}')
    lines.append(f'- **数据行数**: {t["rows"]}')
    lines.append(f'- **字段数**: {t["cols"]}\n')

    err = t.get('error')
    if err:
        lines.append(f'> 解析异常: {err}\n')
        lines.append('---\n')
        continue

    if t['columns']:
        lines.append('**字段列表**\n')
        lines.append('| # | 字段名 |')
        lines.append('|---|--------|')
        for ci, c in enumerate(t['columns']):
            lines.append(f'| {ci+1} | {c} |')
        lines.append('')

    if t['samples']:
        lines.append(f"**示例数据**（前 {len(t['samples'])} 行）\n")
        # compact table
        cols_show = t['columns'][:10]
        lines.append('| ' + ' | '.join(cols_show) + ' |')
        lines.append('| ' + ' | '.join(['---'] * len(cols_show)) + ' |')
        for s in t['samples']:
            vals = []
            for c in cols_show:
                v = s.get(c)
                if v is None:
                    vals.append('-')
                else:
                    vals.append(str(v)[:40].replace('|', '/').replace('\n', ' '))
            lines.append('| ' + ' | '.join(vals) + ' |')
        lines.append('')

    lines.append('---\n')

content = '\n'.join(lines)
with open(OUT, 'w', encoding='utf-8') as f:
    f.write(content)

print(f'Done. {len(lines)} lines written to {OUT}')
