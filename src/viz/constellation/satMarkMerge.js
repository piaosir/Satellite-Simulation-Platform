// 卫星标记归并：同一颗星在同一视图里只留一枚星下点图标、一颗在轨点（名字也只留一个）。
//
// 一颗星可能同时被几处要求画标记，以前各画各的，同一处叠两三枚大小 / 颜色都不同的图标、在轨高度上叠两颗点
// （多选聚焦几颗天线树卫星，2D 上每颗都是一大一小两枚；聚焦星又是可见星，3D 上图标与在轨点都成双）。来源与它们画在哪：
//   ① 聚焦选中集            —— 聚焦层（3D 由聚焦几何 Worker 出点层，2D drawFocusIcons），样式＝「聚焦卫星 · 卫星标记」
//   ② 对星覆盖分析的聚焦特效 —— 同一套样式（它本来就是「不进选中集的聚焦」，见 computeSatcovFocusGeometry）；
//                              在轨点走 setSelectionSet、星下点图标走 setFocusSatLLA / 2D 聚焦图标层
//   ③ 可见性分析的可见星      —— 面板自己的大小 / 颜色（星下点图标：3D setFocusSatLLA、2D 卫星层；在轨点：setSelectionSet 出厂样式）
//   ④ 天线树卫星自身的图标    —— 逐星设置（只在 2D 卫星层画星下点图标；3D 只画名字，没有在轨点）
// 现按身份串归并（ConstellationMap3D 的 satIdOf 口径：'n:<NORAD>'，没号的 'm:<名字>'；天线树里没进星座的节点 'f:<folder>'），
// 上面的序号就是优先级：同一颗星谁的序号小谁画，低的那份撤掉这枚标记，别的照留（名字锚到留下来的那枚图标上方、视线斜线照画）。
// 聚焦两档压过分析与卫星自身：选中态是用户此刻点名要看的，与聚焦的轨迹 / 覆盖圈 / 高亮环同一套样式，2D、3D 一个样子；
// 取消聚焦，各自的标记原样回来。
// ★ 只并不加：哪颗星有图标 / 有在轨点，与归并前完全一样 —— 认领按标记逐类算（「星下点图标」「在轨点」各管各的开关），
//   聚焦那边这一类关着就不认领，低档照画。
// 不在此列：星座点云（底层，聚焦 / 可见星的点本就盖在它上面）、图上链路的端点小点（链路自己的符号，同箭头）。

export const MARK_RANK = Object.freeze({ focus: 1, satcov: 2, vis: 3, grd: 4 })

export const NO_KEYS = new Set()   // 只读：从不往里加

// 带 key 的条目 → 身份串集合
export function keysOf(list) {
  const s = new Set()
  for (const q of (list || [])) if (q && q.key) s.add(q.key)
  return s
}

// 几份身份串集合的并（只读视图，不拷贝 —— 聚焦一整个星座时选中集有几千个键，每拍复制一份是白花）
export function anyOf(...sets) {
  const ss = sets.filter((s) => s && s.size)
  if (ss.length <= 1) return ss[0] || NO_KEYS
  return { size: ss.reduce((n, s) => n + s.size, 0), has: (k) => ss.some((s) => s.has(k)) }
}

// 星下点图标：聚焦图标层之外、自己画图标的那份（3D 的可见星 subs）剔掉已被认领的
export function withoutClaimed(list, claimed) {
  if (!Array.isArray(list)) return []
  if (!claimed || !claimed.size || !list.length) return list
  return list.filter((q) => !(q && q.key && claimed.has(q.key)))
}

// 在轨点：setSelectionSet 的条目（satPos 即在轨点）里被认领的那几颗打 noDot —— 只撤点，同一条里的视线斜线等别的几何照画。
// 不改入参（可见性条目每拍现造，但别处可能还拿着），命中的换一份浅拷贝
export function withoutClaimedDots(items, claimed) {
  if (!Array.isArray(items)) return []
  if (!claimed || !claimed.size || !items.length) return items
  return items.map((it) => (it && it.key && it.satPos && !it.noDot && claimed.has(it.key) ? { ...it, noDot: true } : it))
}

const rankOf = (s) => (Number.isFinite(s.rank) ? s.rank : 99)

// 卫星层（setSatLayer 的 sats）归并。list 按显示次序；带 key 的参与归并（rank 缺省算最低档），没 key 的原样放行。
// claimed：聚焦图标层此刻在画星下点图标的身份串。返回新数组，次序＝各 key 首次出现的位置。
// 合成一条：图标取 rank 最小且 iconShow 的那条 —— 被认领就不画，标 gapFocus（名字按聚焦图标的尺寸让位）；
//           名字取 rank 最小、labelShow 且有字的那条；图标色与名字色可能来自两条，2D 的名字色另存 labelColor。
// 独一份又没被认领的条目原样返回（同一个对象），与归并前逐字段一致。
export function mergeLayerSats(list, claimed) {
  const out = [], groups = new Map()
  for (const s of (list || [])) {
    if (!s) continue
    const k = s.key
    if (k == null || k === '') { out.push(s); continue }
    let g = groups.get(k)
    if (!g) { g = { at: out.length, n: 0, first: s, ic: null, lb: null }; groups.set(k, g); out.push(null) }
    g.n++
    if (s.iconShow !== false && (!g.ic || rankOf(s) < rankOf(g.ic))) g.ic = s
    if (s.labelShow !== false && s.name && (!g.lb || rankOf(s) < rankOf(g.lb))) g.lb = s
  }
  for (const [k, g] of groups) {
    const taken = !!(claimed && claimed.has(k))
    if (g.n === 1 && !taken) { out[g.at] = g.first; continue }
    const ic = taken ? null : g.ic, lb = g.lb
    if (!ic && !lb) continue                    // 图标让给了聚焦层、又没有名字：卫星层这颗不剩东西
    const o = { ...(ic || lb), key: k, iconShow: !!ic }
    if (taken) o.gapFocus = true
    if (lb) Object.assign(o, { name: lb.name, nameColor: lb.nameColor, labelSize: lb.labelSize, labelBold: lb.labelBold, labelShow: true, labelColor: lb.color })
    else o.labelShow = false
    out[g.at] = o
  }
  return out.filter(Boolean)
}

// 认领签名：keys 里被 claimed 认领的那几颗（次序跟 keys）。页面据此判断卫星层要不要重画
export function claimSig(keys, claimed) {
  if (!claimed || !claimed.size) return ''
  let s = ''
  for (const k of (keys || [])) if (claimed.has(k)) s += k + '\n'
  return s
}
