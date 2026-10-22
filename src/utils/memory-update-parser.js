/**
 * 从模型回复中提取待办和工作总结，保持旧链路兼容返回结构。
 */

function extractMemoryUpdate(text) {
  if (!text) return null;

  const todoMatch = text.match(/【待办[事项]*】[：:]\s*([\s\S]*?)(?=\n\n|【|$)/);
  const summaryMatch = text.match(/【[工作]*总结】[：:]\s*([\s\S]*?)(?=\n\n|【|$)/);

  if (!todoMatch && !summaryMatch) return null;

  const update = { todos: [], summary: null };

  if (todoMatch) {
    const todoLines = todoMatch[1].trim().split('\n').filter(line => line.trim());
    update.todos = todoLines.map(line => ({
      title: line.replace(/^[-•\d.]+\s*/, '').trim(),
      type: '待办',
      status: '待处理',
      source: 'OrgAgent',
    }));
  }

  if (summaryMatch) {
    update.summary = {
      period: new Date().toISOString().slice(0, 10),
      content: summaryMatch[1].trim(),
    };
  }

  return update;
}

module.exports = { extractMemoryUpdate };
