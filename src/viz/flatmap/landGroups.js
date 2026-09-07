// 导出（compat 回放）时陆地面的分组口径 —— 纯函数、不碰 DOM，Node 里直接测
// （packages/core/test/flatExportCompat.test.mjs）。
//
// 为什么要分组：矢量 PDF 走 svg2pdf，它逐节点 getComputedStyle，10m 底图数千个多边形逐面各成一个 <path>
// 是导出耗时的主因 —— 故按填充色合并成「每色一条 path」再 evenodd 填充。这一步成立的前提是【同一条 path
// 里的面互不重叠】：NE 的 map_units 把陆地切成不相交的单元，有洞、有飞地都是嵌在洞里，evenodd 正好等于并集。
//
// ★ 争议叠加面（resolvedFeatures 给出 over:true 的那些）不许并进去。它按设计【整块落在宿主面之内】
//   （藏南 / 典角 ⊂ 印度面，中国视角下涂成中国色盖住宿主），与宿主面是重叠而非相邻。统一底色下两者同色，
//   进了同一条 path 后重叠处被 evenodd 算成偶数次 → 抠成洞，海色从洞里透出来 —— 就是「导出的 PNG/PDF 上
//   藏南、典角一带是块海色补丁、屏上却没有」（屏上逐面各自 fill(Path2D, 'evenodd')，叠加面只是盖上去）。
//   叠加面之间也可能嵌套（克什米尔那几块），故它们也不按色合并，一面一条 path。全图叠加面只有几十个，
//   多出的这几十个节点对 svg2pdf 无感。
//
// 入参 land = buildBaseGeo 产物 [{ shapes: [{ lo, hi, rings }], fill, over }]，off = 本轮经度环绕偏移，
// [wl, wr] = 视口世界 X 范围（未含 off）—— 三者口径与 drawLand 一致。
// 出参顺序即绘制顺序：groups（基础面，按色合并，首见色在前）→ overs（叠加面，逐面）。
export function groupLandForExport(land, off, wl, wr) {
  const byColor = new Map(), overs = []
  for (const c of land) {
    for (const sh of c.shapes) {
      if (sh.hi + off < wl || sh.lo + off > wr) continue      // 视口裁剪（与实时路径同一判据）
      if (c.over) { overs.push({ fill: c.fill, shape: sh }); continue }
      let a = byColor.get(c.fill)
      if (!a) { a = []; byColor.set(c.fill, a) }
      a.push(sh)
    }
  }
  const groups = []
  for (const [fill, shapes] of byColor) groups.push({ fill, shapes })
  return { groups, overs }
}
