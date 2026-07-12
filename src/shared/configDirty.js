// 配置「未保存」检测的公共工具（GEO / NGSO / 再生式 三个链路预算模块共用）。
//
// 背景：三个模块都用「指纹（fingerprint）」判断当前工作区是否相对已存配置有改动——
// 相等则「干净」、不同则弹「有未保存的修改，是否保存？」。原实现直接 JSON.stringify 一组字段
// 作指纹，存在两类误报（没改参数也提示保存）：
//   1) JSON.stringify 对「键顺序」「数字格式（12 vs 12.0 vs 浮点尾噪）」「null/undefined」敏感，
//      任何表层差异都会被判成改动；
//   2) 恢复上次会话时基线取「原始已存 c.state」，而工作区经 applyState 规整过（补默认字段、
//      裁掉已删字段、类型归一），二者天然不等——旧版本存的配置一打开就被判为「已改」。
//
// 对策（对齐业界成熟做法：Hibernate 脏检查用「载入后规整过的快照」作基线；表单脏检测用
// deep-equal / 规范化序列化而非裸字符串比较）：
//   · stableStringify —— 规范化序列化：递归按键名排序 + 数值按有效数字规整 + null/undefined 归一，
//     消除表层差异；
//   · 基线一律经同一条 applyState→serializeState 管线捕获（见各模块 onMounted 恢复分支），
//     使基线与实时指纹同源可比。

// 规整单值：
//   · null / undefined → null（消除「缺键 vs 显式 null」差异）
//   · 有限数字 → 取 12 位有效数字（抹掉浮点重算的尾部噪声，且不受量级影响；-0 归一为 0）
//   · 非有限数字（NaN / Infinity）→ null
//   · 其余（字符串 / 布尔）原样保留——表单值多为字符串，不做数字强转，避免把用户的真实改动
//     （如把 "5" 改成 "5.0"）误当成「无改动」而漏提示
function canon(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? Number(v.toPrecision(12)) : null
  if (Array.isArray(v)) return v.map(canon)
  if (typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = canon(v[k])
    return out
  }
  return v
}

// 规范化 JSON 序列化：语义相等的两份状态得到逐字节相同的字符串，可直接用 === 比较。
export function stableStringify(value) {
  return JSON.stringify(canon(value))
}
