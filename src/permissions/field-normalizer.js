/**
 * field-normalizer.js - 飞书多维表字段值类型化归一层
 *
 * 设计目标：消除 permission-manager 里"万能 _s()"造成的字段类型二义性。
 * 针对每种飞书字段类型（多行文本 / 单选 / 多选 / 人员 / 查找引用 / 日期 / 复选框）
 * 各自提供显式的归一函数，返回稳定的 JS 类型。
 *
 * 字段类型参考：
 *   1 多行文本      → string
 *   2 数字         → number
 *   3 单选         → string
 *   4 多选         → string[]
 *   5 日期         → number (ms)
 *   7 复选框        → boolean
 *   11 人员        → { name, openId, userId, email }[]
 *   19 查找引用    → 根据被关联字段类型不同，可能是 string[] / text-chunk[] / {users:[]}
 *   20 公式        → 视具体公式返回类型
 *
 * 设计约束：
 *   - 所有函数对 null / undefined / 空值 返回一个"空但类型正确"的值（''/0/[]/false）
 *   - 所有函数纯函数、无副作用（告警由调用方根据 warnings 数组决定是否打印）
 */

/** 内部：安全地拿单个文本片段 */
function _pickText(item) {
  if (item === null || item === undefined) return '';
  if (typeof item === 'string') return item;
  if (typeof item === 'number' || typeof item === 'boolean') return String(item);
  if (typeof item === 'object') {
    if (typeof item.text === 'string') return item.text;
    if (typeof item.name === 'string') return item.name;
    if (typeof item.en_name === 'string') return item.en_name;
  }
  return '';
}

/**
 * 归一"多行文本"字段（type=1）
 * 飞书返回可能是 string，也可能是 [{text:'...', type:'text'}, ...] 片段数组
 * @returns {string}
 */
function normText(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(_pickText).filter(Boolean).join('');
  if (typeof v === 'object') return _pickText(v);
  return String(v);
}

/**
 * 归一"单选"字段（type=3）
 * 返回值通常是字符串，偶见 {text:'xxx'} 对象
 * @returns {string}
 */
function normSingleSelect(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v.text) return String(v.text);
  return String(v);
}

/**
 * 归一"多选"字段（type=4）
 * 返回值是字符串数组
 * @returns {string[]}
 */
function normMultiSelect(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(_pickText).filter(Boolean);
  if (typeof v === 'string') {
    // 兼容历史：有些字段被人工改成文本时用逗号/顿号分隔
    return v.split(/[,，、]/).map(s => s.trim()).filter(Boolean);
  }
  return [];
}

/**
 * 归一"人员"字段（type=11）
 * 返回值是 [{id, name, en_name, email, user_id, ...}]
 * @returns {Array<{name:string, openId:string, userId:string, email:string}>}
 */
function normPerson(v) {
  if (!v) return [];
  if (!Array.isArray(v)) return [];
  return v.map(p => ({
    name:   String(p?.name || p?.en_name || ''),
    openId: String(p?.id || p?.open_id || ''),
    userId: String(p?.userId || p?.user_id || ''),
    email:  String(p?.email || ''),
  })).filter(p => p.name || p.openId);
}

/**
 * 归一"查找引用"字段（type=19）
 * 查找引用根据被关联字段类型不同会返回不同结构：
 *   - 若被关联字段是"人员" → { users:[{id,name,...}] }
 *   - 若被关联字段是"单选/多选" → [ "opt_xxx", "opt_yyy" ]  （option ID 数组）
 *   - 若被关联字段是"多行文本" → [ {text:"...", type:"text"}, ... ]
 *   - 若被关联字段是另一个查找引用（级联）→ 更复杂
 *
 * @returns {{
 *   kind: 'users' | 'optionIds' | 'textChunks' | 'empty' | 'unknown',
 *   names: string[],      // kind=users 时提取的人名
 *   optionIds: string[],  // kind=optionIds 时的原始 option ID（不是中文名！需再查 option 表映射）
 *   text: string,         // kind=textChunks 时的合并纯文本
 *   raw: any,             // 原值
 * }}
 */
function normLookup(v) {
  const out = { kind: 'empty', names: [], optionIds: [], text: '', raw: v };
  if (!v) return out;

  // kind=users：{users:[{name:..},...]}
  if (v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.users)) {
    out.kind = 'users';
    out.names = v.users.map(u => u?.name || u?.en_name || '').filter(Boolean);
    return out;
  }

  if (Array.isArray(v)) {
    if (v.length === 0) return out;
    const first = v[0];

    // kind=optionIds：["opt_xxx","opt_yyy"]
    if (typeof first === 'string') {
      const allOpt = v.every(i => typeof i === 'string' && /^opt[A-Za-z0-9]+/.test(i));
      if (allOpt) {
        out.kind = 'optionIds';
        out.optionIds = [...v];
        return out;
      }
      // 退化：纯文本数组，直接拼接（例如查找引用到文本字段的片段）
      out.kind = 'textChunks';
      out.text = v.join('');
      return out;
    }

    // kind=textChunks：[{text:'xxx',type:'text'},...]
    if (typeof first === 'object' && first && 'text' in first) {
      out.kind = 'textChunks';
      out.text = v.map(i => i?.text || '').join('');
      return out;
    }

    // kind=users 变体：[{name:'xxx',id:'ou_...'}]
    if (typeof first === 'object' && first && 'name' in first) {
      out.kind = 'users';
      out.names = v.map(i => i?.name || '').filter(Boolean);
      return out;
    }
  }

  out.kind = 'unknown';
  return out;
}

/**
 * 归一"复选框"字段（type=7）
 * @returns {boolean}
 */
function normCheckbox(v) {
  if (v === true) return true;
  if (v === 'true' || v === 1 || v === '1') return true;
  return false;
}

/**
 * 归一"日期"字段（type=5）
 * 飞书返回毫秒时间戳（number）
 * @returns {number|null}  毫秒时间戳；空值返回 null
 */
function normDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 归一"数字"字段（type=2）
 * @returns {number}
 */
function normNumber(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 文本列表拆分（业务语义：半/全角逗号、顿号、分号都算分隔符，并兼容空白）
 * @returns {string[]}
 */
function splitMulti(str) {
  if (!str) return [];
  return String(str).split(/[,，、；;]+/).map(s => s.trim()).filter(Boolean);
}

module.exports = {
  normText,
  normSingleSelect,
  normMultiSelect,
  normPerson,
  normLookup,
  normCheckbox,
  normDate,
  normNumber,
  splitMulti,
};
