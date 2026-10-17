// 选中集（聚焦集）按身份认星的纯逻辑：3D 页 selectSat / startFollow / 换池 / 渲染集重建共用
// （node 可直接测：packages/core/test/selIdentity.test.mjs）。
//
// 身份串由调用方给（idOf，3D 页传它的 satIdOf：有 NORAD 用 'n:<号>'，没有的退用 'm:<名字>'）——本模块不另存一份口径。
// 同一颗星在页面里是几份不同的对象：内置组、全量池、导入组、搜索结果各建各的；组重载 / 换池（本机缓存版 → 联网版）
// 又整批换新。页面上按对象比的地方（点云那一拍的 pv 快照、聚焦几何池、跟随邻星剔除、上一聚焦）要求「选中集里那一份 =
// 图上那一份」；判重则一律按身份 —— Ctrl 点一颗已聚焦的星是移出，不是再并进一份同号副本（副本让轨迹 / 覆盖圈画两层、
// 每拍多推一遍 SGP4）。

/** 同一颗星（同一对象，或身份串相同）。任一方为空 → false */
export function sameSat(a, b, idOf) {
  if (!a || !b) return false
  return a === b || idOf(a) === idOf(b)
}

/** e 在 list 里的下标：先认对象、再认身份；没有返回 -1 */
export function indexOfSat(list, e, idOf) {
  if (!e || !list || !list.length) return -1
  const i = list.indexOf(e)
  if (i >= 0) return i
  const id = idOf(e)
  for (let k = 0; k < list.length; k++) if (idOf(list[k]) === id) return k
  return -1
}

/** list 里与 e 同一颗星的那一份（对象优先）；没有返回 null */
export function findSat(list, e, idOf) {
  const i = indexOfSat(list, e, idOf)
  return i >= 0 ? list[i] : null
}

/**
 * 选中集按 to(e) 换对象：只换对象，不改选了哪几颗。to 返回假值＝原样留着；换完撞号的（原先就是同号两份）只留第一份。
 * 主选 / 跟随目标跟着换成同号的那一份（主选落空时取最后一颗，与移出主选同口径；跟随目标不在集里就原样留着）。
 * 返回 { list, primary, follow, changed }；没有任何变化时 changed=false，list 仍是入参那个数组。
 */
export function remapSel(list, primary, follow, to, idOf) {
  const src = list || []
  let changed = false
  const out = [], seen = new Set()
  for (const e of src) {
    const m = (to && to(e)) || e
    const k = idOf(m)
    if (seen.has(k)) { changed = true; continue }
    seen.add(k)
    if (m !== e) changed = true
    out.push(m)
  }
  if (!changed) return { list: src, primary, follow, changed: false }
  const pick = (x) => (x ? findSat(out, x, idOf) : null)
  return {
    list: out,
    primary: pick(primary) || out[out.length - 1] || null,
    follow: follow ? (pick(follow) || follow) : follow,
    changed: true
  }
}
