// 本平台自造的 NORAD 号段总表（单一真值源）。主进程 CJS 镜像：packages/core/utils/synthNorad.js —— 表与函数逐字相同，
// packages/core/test/synthNorad.test.mjs 钉住；改这里必须同改那边。
//
// 合成号是「不在任何官方编目里的星」的身份标签（3D 页 satIdOf = 'n:<NORAD>'，卫星组成员 / 选中集 / 着色都按它认），
// 两颗不同的星绝不能同号。固定段 [lo, hi) 左闭右开、两两不相交：
//   catalog   0 – 800000          真实编目（Alpha-5 上限 339999，2026-10 编到 10 万出头）；hi = schema.mjs 的 SATKEY_NORAD_MAX
//   ephem     800000 – 900000     导入的星历点序列星（主进程 customSats 发号：每组一段，号 = 段首 + 组内序号）
//   gpsAlm    990000 – 1000000    GPS 年历里查不到 NORAD 的 PRN（990000 + PRN，主进程 customSats）
//   treeGeo   1700000 – 1790000   天线树虚拟星（按 folder 散列，src/viz/grd/treeGeo.js）
//   preview   1800000 – 1900000   星座向导实时预览（固定从 1800000 起，提交后换号）
// custom（自定义星座，渲染端 useCustomConstellations 发号）不是一段连续区间：从 900000 起往上，整段避开上面的固定段
// （落在其中的只有 gpsAlm / treeGeo / preview）取最低的空闲段，删掉的星座让出来的段照样复用。
// 800000 起全是合成号：卫星组核对（3D 页 satGrpSweep 的 probe）对 ≥ 800000 一律不参与。
export const SYNTH_NORAD = Object.freeze({
  catalog: Object.freeze({ lo: 0, hi: 800000 }),
  ephem: Object.freeze({ lo: 800000, hi: 900000, step: 10000, fine: 1000 }),   // 先整段 10000 对齐；整段排满了按 1000 填段尾
  gpsAlm: Object.freeze({ lo: 990000, hi: 1000000 }),
  treeGeo: Object.freeze({ lo: 1700000, hi: 1790000 }),
  preview: Object.freeze({ lo: 1800000, hi: 1900000 }),
  custom: Object.freeze({ lo: 900000, hi: Number.MAX_SAFE_INTEGER, step: 10000 })   // 发号窗口，不是固定段
})
export const SYNTH_FIXED = Object.freeze(['catalog', 'ephem', 'gpsAlm', 'treeGeo', 'preview'])

// 固定段的 [lo, hi) 列表（自定义星座发号时整段避开）
export function fixedRanges() {
  return SYNTH_FIXED.map((k) => [SYNTH_NORAD[k].lo, SYNTH_NORAD[k].hi])
}

// count 颗星占几个号：step 的整数倍，至少一个 step（一万颗以上的星座连占几段）
export function blockSpan(count, step) {
  return Math.max(1, Math.ceil((Number(count) || 0) / step)) * step
}

// 在 seg（[lo, hi)，起点按 step 对齐，step 缺省取 seg.step）里找最低的起点 b：[b, b + size) 不越出 seg、
// 与 taken 里每一段 [a, z) 都不相交。撞上就跳到所撞各段段尾之后的下一个对齐位。找不到返回 null。
export function lowestFree(seg, size, taken, step) {
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
