'use strict';

const {
  splitProjects,
  buildProjectAliasMap,
  buildProjectRecipientIndex,
} = require('../src/services/scheduled-push/recipient-index');

describe('scheduled push recipient index', () => {
  test('可见项目范围支持 optionId 并通过项目别名命中 26 年项目名称', () => {
    const projectRows = [
      { fields: { '26年项目名称': '项目A-26', '项目名称（管报）': '项目A-管报' } },
    ];
    const aliasMap = buildProjectAliasMap(projectRows);
    const index = buildProjectRecipientIndex([
      {
        fields: {
          '姓名': '张三',
          '飞书OpenID': 'ou_zhangsan',
          '可见项目范围': ['optProjectA'],
        },
      },
    ], {
      optionMap: { optProjectA: '项目A-管报' },
      aliasMap,
    });

    expect(splitProjects(['optProjectA'], { optProjectA: '项目A-管报' })).toEqual(['项目A-管报']);
    expect(index.findRecipients(['项目A-26'])).toEqual([{ name: '张三', openId: 'ou_zhangsan' }]);
  });

  test('缺少姓名或 OpenID 的员工会被跳过', () => {
    const index = buildProjectRecipientIndex([
      { fields: { '姓名': '无ID', '可见项目范围': '项目A' } },
    ]);

    expect(index.skipped).toEqual([{ name: '无ID', reason: '缺少姓名或飞书OpenID' }]);
    expect(index.findRecipients(['项目A'])).toEqual([]);
  });
});
