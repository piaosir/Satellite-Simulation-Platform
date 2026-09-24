// 卫星 / 天线树 ↔ 星座 双向联动的纯逻辑（无 Vue、无场景，node 可直接测：packages/core/test/treeLink.test.mjs）。
//
// 身份口径（全模块唯一）：
//   · 树节点（folder）只凭 node.noradId 与星座关联，比对一律 String(noradId) —— 存盘里的号有字符串也有数字；
//     绝不按星名、绝不按对象身份（同一颗星在「在场集 / 全量池 / 自定义星座」里是几份不同的对象）。
//     例外：天线树定点同步星没有 noradId，它在星座里的条目用合成号（viz/grd/treeGeo.js），「号 ↔ folder」一律走 nodeLinkId。
//   · 仰角线节点（kind:'elevline'）没有星座身份，也不挂天线：一律不参与联动。
//   · 同一个 NORAD 可以被多个 folder 关联（addSatellite 不按号去重）→ NORAD → folder 是一对多。
import { buildRecord } from './gaussStk.js'

const idOf = (v) => (v == null || v === '' ? '' : String(v))
const NONE = Object.freeze([])

// NORAD → 星座条目 的解析器（带缓存）。解析顺序＝在场真实星 entries → 全量目录 searchPool → 已载入的点序列星历 eph
// （不论图层显隐）→ 自定义星座（含隐藏的座）。
// getSrc() → { entries, pool, eph, ccList, ccEpoch, ccFind(id) }：
//   entries / pool / eph 三份数组都是【整份换新】不原地改（rebuildRenderSet / setSearchPool / 采样表缓存重建），自定义星座的
//   list 也是整份换新，历元变了合成星整批重建 —— 五项任一变了（引用 / 值）整张表作废，否则命中即 O(1)。
// ★ eph：点序列导入组（.e / OEM / SP3）只按导入组各自成集，不进全量池；图层一关它就出了 entries。关联星的身份不该随地图
//   显隐变 —— 隐藏的点序列组照样从这一路解析（与「隐藏的自定义星座照样关联」同口径）。
// ★ 找不到也记（null）：池没就绪时反复问同一颗不再线性扫；池一就绪 pool 引用就变，表随之作废重查。
export function createNoradResolver(getSrc) {
  let s0 = null, s1 = null, s2 = null, s3 = null, s4 = null
  let memo = new Map(), eIdx = null, pIdx = null, xIdx = null
  const index = (arr) => { const m = new Map(); for (const x of arr) { const k = idOf(x && x.noradId); if (k && !m.has(k)) m.set(k, x) } return m }   // 同号取第一份（与 Array.find 同口径）
  function resolve(noradId) {
    const id = idOf(noradId)
    if (!id) return null
    const src = getSrc() || {}
    const entries = src.entries || NONE, pool = src.pool || NONE, eph = src.eph || NONE   // 缺省用同一份空数组：每次新建 [] 会让缓存每问必作废
    if (entries !== s0 || pool !== s1 || src.ccList !== s2 || src.ccEpoch !== s3 || eph !== s4) {
      s0 = entries; s1 = pool; s2 = src.ccList; s3 = src.ccEpoch; s4 = eph
      memo = new Map(); eIdx = null; pIdx = null; xIdx = null
    }
    const hit = memo.get(id)
    if (hit !== undefined) return hit
    if (!eIdx) eIdx = index(entries)
    let e = eIdx.get(id) || null
    if (!e && pool.length) { if (!pIdx) pIdx = index(pool); e = pIdx.get(id) || null }
    if (!e && eph.length) { if (!xIdx) xIdx = index(eph); e = xIdx.get(id) || null }
    if (!e && typeof src.ccFind === 'function') e = src.ccFind(id) || null
    memo.set(id, e)
    return e
  }
  resolve.reset = () => { s0 = s1 = s2 = s3 = s4 = null; memo = new Map(); eIdx = null; pIdx = null; xIdx = null }
  return resolve
}

// 点序列导入组里有哪些【被树节点关联着】、采样表却还没载入的 —— 这些组不论图层显隐都得载表，关联星才解析得到。
// groups：导入组清单（[{ id, kind, sats:[{ noradId }] }]，omm.customList 的 groups）；nodes：树节点；loaded(id) → 该组表是否已在缓存。
// 返回组 id 数组（按清单顺序）。仰角线 / 无号节点不参与；号一律 String 比。
export function ephGroupsToLoad(groups, nodes, loaded) {
  const want = new Set()
  for (const n of nodes || []) { if (!n || n.kind === 'elevline') continue; const k = idOf(n.noradId); if (k) want.add(k) }
  if (!want.size) return []
  const out = []
  for (const g of groups || []) {
    if (!g || g.kind !== 'ephem' || (typeof loaded === 'function' && loaded(g.id))) continue
    if ((g.sats || []).some((s) => s && want.has(idOf(s.noradId)))) out.push(g.id)
  }
  return out
}

// 写给链路预算窗口的实时星位缓存（globe3d/grdLive 的 pos / noEph 两段）。sats：树节点；livePos(node) → {lon,lat,altKm} | null。
//   · 只写随时间动的星（关联星 noradId / 轨道根数星 elements）；固定星的 lon 本就是真值，不写。
//   · 关联星此刻解不出（星历里没有 / 点序列越出时段 / 池还没就绪）→ 不写 pos、记进 noEph：读的一侧据此知道它【仍是实时星、
//     只是此刻没有星位】—— 回填指纹不从 'live' 翻成存盘快照（那一翻会把整列手改值冲掉），也不按存盘旧星位取值。
//     单列一段而不是在 pos 里塞标记：NGSO / 再生式的 satTree 只认 pos，塞进去它会读出 NaN。
export function grdLivePayload(sats, livePos) {
  const pos = {}, noEph = []
  for (const s of sats || []) {
    if (!s || !(s.noradId || s.elements)) continue
    const p = livePos(s)
    if (p && Number.isFinite(p.lon)) pos[s.folder] = { lon: +p.lon.toFixed(4), lat: +(p.lat || 0).toFixed(4), altKm: +(p.altKm || 0).toFixed(1) }
    else if (s.noradId) noEph.push(s.folder)
  }
  return { pos, noEph }
}

// globe3d/grdLive 的写入闸（3D 页 persistGrdLive 逐拍调用）：平时两次写入至少隔 ms；due() 之后的下一次无条件放行 ——
// 关联星的星历源换了（换池 / 隐藏点序列组的采样表载入，见页面 relinkTick），这一拍的解算结果必须落盘。
//   ★ 不放行的后果：启动时池还没建好那一拍写下的 noEph（不在可见集里的关联星那一刻解不出），池 1–2 s 后到齐补的那一拍
//     正好落在节流窗里被吞掉；暂停档（出厂）此后再没有时钟拍，链路预算窗口一直读到「无星历」、EIRP / G/T 整列不取值。
//   pending()：due 还没被一次放行消费掉（调用方据此补写一次：渲染集为空时 refreshPositions 走早退分支、不经过写入点）。
export function createLiveThrottle(ms = 3000) {
  let last = -Infinity, due = false
  return {
    due() { due = true },
    pending() { return due },
    pass(now) {
      if (!due && now - last < ms) return false
      due = false; last = now
      return true
    }
  }
}

// 树 → 星座聚焦的过期判据（页面 focusTreeSat 用）。guard：调用方在自己开始等待【之前】捕获的 { tick, fseq }
// （tick = 用户改选计数 _userSelTick，fseq = 聚焦序号 _focusSeq）。等完（等星历源 / 建天线）再去聚焦时：
// 用户已另选（tick 变了）或树上又点了别的星（fseq 变了）→ 过期，这次聚焦作废 —— 别把较新的选中冲掉、把地球转回去。
// 没给 guard / 缺项 → 不判（即时的聚焦恒放行）。
export function focusStale(guard, tick, fseq) {
  if (!guard) return false
  return (guard.tick != null && guard.tick !== tick) || (guard.fseq != null && guard.fseq !== fseq)
}

// 树节点在星座里的身份串：关联星 = 它的 NORAD；天线树定点同步星 = 合成号（geoIds：folder → 号串，viz/grd/treeGeo.treeGeoIds）；
// 其余（非同步定点星 / 轨道根数星 / 仰角线）没有星座身份，''。下面几处「号 ↔ folder」一律按它比。
export function nodeLinkId(node, geoIds) {
  if (!node || node.kind === 'elevline') return ''
  return idOf(node.noradId) || (geoIds ? idOf(geoIds.get(node.folder)) : '')
}

// 关联到给定 NORAD 集合的 folder 集（一对多、字符串 / 数字混存都认）。norads：可迭代的号（任意类型）。
export function foldersForNorads(nodes, norads, geoIds) {
  const want = new Set()
  for (const n of norads || []) { const k = idOf(n); if (k) want.add(k) }
  const out = new Set()
  if (!want.size) return out
  for (const node of nodes || []) {
    const k = nodeLinkId(node, geoIds)
    if (k && want.has(k)) out.add(node.folder)
  }
  return out
}

// 关联到某个 NORAD 的全部树节点（按树序）
export function linkedNodesOf(nodes, noradId, geoIds) {
  const k = idOf(noradId)
  if (!k) return []
  return (nodes || []).filter((n) => n && nodeLinkId(n, geoIds) === k)
}

// 关联星「在当前星历里找不到」：只在全量目录已就绪时下这个判断 —— 池没好之前找不到是常态（还没载入），不是缺失。
export function linkMissing(node, poolReady, resolve) {
  if (!node || node.kind === 'elevline' || !idOf(node.noradId) || !poolReady) return false
  return !resolve(node.noradId)
}

// 树卫星行「聚焦 / 跟随」两钮的状态（对地 / 对星两棵树共用）：点亮 / 置灰 / 悬停说明。
//   有星座身份的星（关联星 / 天线树定点同步星）：聚焦＝选中并正对（亮＝在聚焦集里）；跟随＝并入聚焦集、设为主选后跟随（亮＝正跟随它）。
//   没有星座身份的星（非同步高度的定点星 / 轨道根数星）星座里没有条目：聚焦只把地球转到它此刻的星下点（恒不亮），跟随置灰。
//   关联星不在当前星历（miss）→ 两钮置灰；平面图（flat）里跟随置灰。正跟随着的那颗不灰（留着退出的口）。
// ctx：{ cur 该行在聚焦集里, miss 关联星缺失, followId 正在跟随的星的 NORAD（'' = 没在跟随）, flat 平面图,
//        linkId 该行的星座身份（nodeLinkId；天线树定点同步星给合成号 —— 它在星座里有条目，与关联星同样可聚焦 / 跟随）}
export function treeNavState(node, { cur = false, miss = false, followId = '', flat = false, linkId } = {}) {
  const id = node && node.kind !== 'elevline' ? (linkId !== undefined ? idOf(linkId) : idOf(node.noradId)) : ''
  const lost = !!id && !!miss
  const following = !!id && idOf(followId) === id
  const missTip = `关联卫星 NORAD ${id} 不在当前星历中`
  return {
    focusOn: !!id && !!cur,
    focusDis: lost,
    focusTip: !id ? '转到该卫星（该星不在星座中）' : lost ? missTip : '聚焦卫星（Ctrl 点＝加入 / 移出聚焦集）',
    followOn: following,
    followDis: !following && (!id || lost || !!flat),
    followTip: following ? '退出跟随（Esc）' : !id ? '跟随卫星（该星不在星座中）' : lost ? missTip : flat ? '跟随卫星（仅 3D 球体）' : '跟随卫星'
  }
}

// 波束合成视图跟随星座主选：主选星关联了 folder、且导航器当前那颗星【不是】关联同一颗 → 给出该切到的 folder；否则 null。
// 当前星若本就关联着同一个 NORAD（同号多 folder 时用户自己挑的那个），不去改它。
export function followFolder(nodes, primaryNorad, curFolder, geoIds) {
  const k = idOf(primaryNorad)
  if (!k) return null
  const cur = curFolder ? (nodes || []).find((n) => n && n.folder === curFolder) : null
  if (cur && nodeLinkId(cur, geoIds) === k) return null
  const hit = linkedNodesOf(nodes, k, geoIds)[0]
  return hit && hit.folder !== curFolder ? hit.folder : null
}

// 波束合成跟随主选的放行闸（宿主 watch(selVer) 每一版都要喂一次，含别的视图、含程序性刷新 —— 否则「上次看到的主选」会过期）：
//   system —— 这一版是程序性刷新（跨会话恢复选中 / 自定义星座重绑 / 向导预览）→ 不放行，只记下主选。启动时 openFor 恢复的
//             「上次的组」就不会被随后才到的恢复选中冲掉（setSat 会 persist，冲一次就再也回不来）。
//   picked —— 这一版是用户显式点名主选（点选 / 设为主选）→ 主选号没变也放行（导航器被手动挪走后，再点一次同一颗星要跟回去）。
//   其余版本只在主选号变了时放行：移出一颗非主选、历元重绑之类不换主选的刷新不再把导航器拽走。
export function createFollowGate() {
  let seen = ''
  return function gate(primaryNorad, { system = false, picked = false } = {}) {
    const k = idOf(primaryNorad)
    const changed = k !== seen
    seen = k
    return !system && (changed || picked)
  }
}

// 波束合成组 groupId 是否在世、且正驱动 key（folder|天线名）这根天线：组还在，且组记下的产物名（_genName）就是它。
// 与 useBeamSynth.generateStk 的 heldByOther / autoSyncPass 同一口径（组只按 _genName 认自己的天线）。
// 组没记 _genName（老数据）→ 只看组在不在。keyOf = grd.keyOf。
export function synthGroupDrives(groups, groupId, key, keyOf) {
  if (!groupId) return false
  const g = (groups || []).find((x) => x && x.id === groupId)
  if (!g) return false
  if (!key || !g._genName || typeof keyOf !== 'function') return true
  return keyOf(g.satFolder, g._genName) === key
}

// 解析天线记录归一个【在世】的波束合成组管（覆盖分析侧只读，改参数回波束合成）。
// owner 指着的组删了（removeGroup 不动已生成的天线）、或记录是从别的工作区带来的（组存 localStorage、天线在盘上）→ owner 是死条子，
// 当作无主：就地可改。alive(groupId, key) 由宿主给（读 bs.groups，调用方的 computed 随之响应）；没给 → 保守按在世。
export function synthOwned(rec, key, alive) {
  if (!rec || !rec.owner || rec.owner.kind !== 'beamsynth') return false
  return typeof alive === 'function' ? !!alive(rec.owner.groupId, key) : true
}

// 解析天线记录里换第 idx 个方向图模型（界面编辑 → 新记录）：身份（id / 名）、星位、归属、窗口、全部波束的视轴与模型引用原样保留，
// 逐波束的已解析量（θ3 / g0 / k / back）由 buildRecord 按新模型重算。next = GaussModelFields 发出的整份模型。
export function recordWithModel(rec, idx, next) {
  const models = (rec.models || []).map((m, i) => (i === idx ? { ...m, ...next, id: m.id, name: m.name } : m))
  return buildRecord({
    sat: rec.sat,
    models,
    beams: (rec.beams || []).map((b) => ({ name: b.name, az: b.az, el: b.el, model: b.model })),
    owner: rec.owner || null,
    win: rec.win
  })
}
