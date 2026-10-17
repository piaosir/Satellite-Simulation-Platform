// 本平台自造的 NORAD 号段总表 —— 主进程 CJS 镜像。真值源与各段说明：src/shared/synthNorad.js（渲染端 ESM）。
// 表与函数逐字相同，packages/core/test/synthNorad.test.mjs 钉住；改那边必须同改这里。
const SYNTH_NORAD = Object.freeze({
  catalog: Object.freeze({ lo: 0, hi: 800000 }),
  ephem: Object.freeze({ lo: 800000, hi: 900000, step: 10000, fine: 1000 }),   // 先整段 10000 对齐；整段排满了按 1000 填段尾
  gpsAlm: Object.freeze({ lo: 990000, hi: 1000000 }),
  treeGeo: Object.freeze({ lo: 1700000, hi: 1790000 }),
  preview: Object.freeze({ lo: 1800000, hi: 1900000 }),
  custom: Object.freeze({ lo: 900000, hi: Number.MAX_SAFE_INTEGER, step: 10000 })   // 发号窗口，不是固定段
})
const SYNTH_FIXED = Object.freeze(['catalog', 'ephem', 'gpsAlm', 'treeGeo', 'preview'])

// 固定段的 [lo, hi) 列表（自定义星座发号时整段避开）
function fixedRanges() {
  return SYNTH_FIXED.map((k) => [SYNTH_NORAD[k].lo, SYNTH_NORAD[k].hi])
}

// count 颗星占几个号：step 的整数倍，至少一个 step（一万颗以上的星座连占几段）
function blockSpan(count, step) {
  return Math.max(1, Math.ceil((Number(count) || 0) / step)) * step
}

// 在 seg（[lo, hi)，起点按 step 对齐，step 缺省取 seg.step）里找最低的起点 b：[b, b + size) 不越出 seg、
// 与 taken 里每一段 [a, z) 都不相交。撞上就跳到所撞各段段尾之后的下一个对齐位。找不到返回 null。
function lowestFree(seg, size, taken, step) {
  const st = step || seg.step
  let b = seg.lo
  for (;;) {
    if (b + size > seg.hi) return null
    let end = -Infinity
    for (const t of taken) if (b < t[1] && t[0] < b + size && t[1] > end) end = t[1]
    if (end === -Infinity) return b
    b = seg.lo + Math.ceil((end - seg.lo) / st) * st
  }
}

module.exports = { SYNTH_NORAD, SYNTH_FIXED, fixedRanges, blockSpan, lowestFree }
