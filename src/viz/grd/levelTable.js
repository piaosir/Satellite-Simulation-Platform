// 电平表的纯函数（SATSOFT Contour Levels 工具条与 Generate Contour Levels）。
// 抽出来是为了能单测：useGrdCoverage 里的同名方法只负责把结果写进响应式 s.levels。

// 文本 → 数值列表：空格 / 逗号 / 分号 / 换行分隔，非数值项忽略（从别处复制来的一串电平直接粘）。
export function parseLevelValues(txt) {
  const out = []
  for (const t of String(txt == null ? '' : txt).split(/[\s,;]+/)) {
    if (!t) continue
    const v = parseFloat(t)
    if (Number.isFinite(v)) out.push(v)
  }
  return out
}
// 数值列表 → 文本（复制到剪贴板用）
export const levelValuesText = (vals) => vals.join(' ')
// 起始 / 间隔 / 档数 → 数值列表。档数夹到 [1, 64]；间隔可正可负（相对档一般为负）。
// 浮点累加会攒出 −3.0000000000000004 这种尾巴，逐项按 4 位定点收口。
export function levelValues(start, step, count) {
  const n = Math.max(1, Math.min(64, Math.round(+count) || 0))
  const a = +start || 0, d = +step || 0
  const out = []
  for (let i = 0; i < n; i++) out.push(+(a + d * i).toFixed(4))
  return out
}
