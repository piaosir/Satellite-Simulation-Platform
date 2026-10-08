// 卫星标记归并（src/viz/constellation/satMarkMerge.js）：同一颗星在同一视图里只留一枚星下点图标、一颗在轨点。运行：node packages/core/test/satMarkMerge.test.mjs
//
//   ① 原样放行：独一份且没被认领的条目返回同一个对象（与归并前逐字段一致）；没 key 的条目不参与。
//   ② 被聚焦图标层认领：撤图标、标 gapFocus（名字按聚焦图标让位），名字字段原样；没名字的整条不剩。
//   ③ 天线树卫星 + 可见星是同一颗：合成一条 —— 图标归可见星（序号小），名字归排在前面且有名字的那份，2D 名字色另存 labelColor；
//      次序＝首次出现的位置。悬停高亮的可见星名字压过卫星自己的名字。同号的两个天线树节点也并成一条。
//   ④ 只并不加（随机性质测试）：每个 key 至多一条；被认领的 key 不再出图标；归并前有图标请求的 key，归并后要么出图标、要么被认领；
//      有名字的 key 归并后仍有名字。
//   ⑤ 辅助：keysOf / anyOf（只读并，不拷贝）/ withoutClaimed（3D 可见星图标那份）/ claimSig。
//   ⑥ 在轨点 withoutClaimedDots：被认领的只打 noDot（视线斜线等照留）、不改入参、没被认领的同一个对象；随机性质测试同④。
//   ⑦ 接线按源码钉：页面 pushGeom 统一算认领集（3D 剔可见星图标 / 在轨点、2D 交给 redrawSats）、redrawSats 走 mergeLayerSats、
//      对星特效 2D 与 3D 同一份 subs（不再有 subs2d 特例）、身份串与 satIdOf 同口径；3D 场景认 noDot；
//      平面图名字按 gapFocus 让位、改聚焦图标大小重排文字层。
import { readFileSync } from 'node:fs'
import { MARK_RANK, NO_KEYS, keysOf, anyOf, withoutClaimed, withoutClaimedDots, mergeLayerSats, claimSig } from '../../../src/viz/constellation/satMarkMerge.js'

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + msg + (extra ? `  (${extra})` : '')); cond ? pass++ : fail++ }

// 页面 redrawSats 推进卫星层的两种条目（字段与页面 / useVisibility.overlaySpec 一致）
const grd = (key, o = {}) => ({ lon: 110, lat: 0, altKm: 35786, name: 'G-' + key, color: 0x66ddff, nameColor: '#66ddff', iconSize: 10, labelSize: 9, labelBold: false, labelShow: true, iconShow: true, key, rank: MARK_RANK.grd, ...o })
const vis = (key, o = {}) => ({ lon: 110.001, lat: 0.001, altKm: 35786, name: '', color: 0x4caf82, nameColor: '#4caf82', iconSize: 12, labelSize: 10, labelBold: false, labelShow: false, iconShow: true, key, rank: MARK_RANK.vis, ...o })
// 页面 computeVisibilityGeometry 的 setSelectionSet 条目（satPos＝在轨点；orbit＝目标→星视线斜线）
const visItem = (key, o = {}) => ({ satPos: { lat: 0, lon: 110, altKm: 35786, color: '#4caf82' }, orbit: [{ lat: 30, lon: 110, altKm: 0 }, { lat: 0, lon: 110, altKm: 35786 }], raw: true, primary: false, key, ...o })

let seed = 12345
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }

// ① 原样放行
{
  const a = grd('n:1'), b = grd('n:2'), poly = { lon: 1, lat: 2, name: 'P', iconShow: false }
  const out = mergeLayerSats([a, poly, b], NO_KEYS)
  ok(out.length === 3 && out[0] === a && out[1] === poly && out[2] === b, '① 独一份、没被认领：同一个对象原样返回，次序不变；没 key 的条目照放')
  ok(mergeLayerSats([], new Set(['n:1'])).length === 0 && mergeLayerSats(null, null).length === 0, '① 空表 / null 不抛')
  ok(MARK_RANK.focus < MARK_RANK.satcov && MARK_RANK.satcov < MARK_RANK.vis && MARK_RANK.vis < MARK_RANK.grd, '① 优先级：聚焦 > 对星特效 > 可见性 > 天线树卫星自身')
}

// ② 被聚焦图标层认领
{
  const a = grd('n:1', { name: '中星26号', labelBold: true }), b = grd('n:2')
  const out = mergeLayerSats([a, b], new Set(['n:1']))
  const m = out.find((s) => s.key === 'n:1')
  ok(out.length === 2 && m && m.iconShow === false && m.gapFocus === true, '② 认领：卫星层撤掉这颗的图标、名字按聚焦图标让位（gapFocus）')
  ok(m.name === '中星26号' && m.labelShow === true && m.labelBold === true && m.nameColor === '#66ddff' && m.labelColor === 0x66ddff && m.lon === 110, '② 名字字段 / 名字色 / 位置原样')
  ok(a.iconShow === true && !a.gapFocus, '② 不改入参对象（每拍重建，入参留给别处）')
  ok(out.find((s) => s.key === 'n:2') === b, '② 没被认领的那颗原样')
  const noLabel = mergeLayerSats([grd('n:1', { labelShow: false })], new Set(['n:1']))
  ok(noLabel.length === 0, '② 认领且没名字：卫星层这颗什么都不剩（图标由聚焦层画）')
  const iconOff = mergeLayerSats([grd('n:1', { iconShow: false })], new Set(['n:1']))
  ok(iconOff.length === 1 && iconOff[0].iconShow === false && iconOff[0].gapFocus === true, '② 自己图标关着、名字开着、又被聚焦：名字照样让到聚焦图标上方（原先压在聚焦图标正中）')
}

// ③ 天线树卫星 + 可见星是同一颗
{
  const g = grd('n:7', { name: '中星7号' }), v = vis('n:7'), other = vis('n:8')
  const out = mergeLayerSats([g, other, v], NO_KEYS)
  ok(out.length === 2 && out[0].key === 'n:7' && out[1] === other, '③ 合成一条；次序＝首次出现的位置（天线树卫星在前、可见星在后不变）')
  const m = out[0]
  ok(m.iconShow === true && m.iconSize === 12 && m.color === 0x4caf82 && m.lon === 110.001, '③ 图标归可见星（大小 / 颜色 / 位置取它那条）')
  ok(m.name === '中星7号' && m.labelShow === true && m.labelColor === 0x66ddff && m.nameColor === '#66ddff' && m.labelSize === 9, '③ 可见星没出名字：名字归天线树卫星（2D 名字色另存 labelColor，不跟图标色）')
  ok(!m.gapFocus, '③ 没被认领：不标 gapFocus（名字按留下的那枚卫星层图标让位）')
  const hot = vis('n:7', { name: 'ZX-7 110.0°E', labelShow: true, color: 0xffd27a, nameColor: '#efeae0' })
  const h = mergeLayerSats([g, hot], NO_KEYS)[0]
  ok(h.name === 'ZX-7 110.0°E' && h.labelColor === 0xffd27a && h.nameColor === '#efeae0', '③ 悬停高亮的可见星出了名字：名字归它（序号小）')
  const both = mergeLayerSats([g, v], new Set(['n:7']))
  ok(both.length === 1 && both[0].iconShow === false && both[0].gapFocus === true && both[0].name === '中星7号', '③ 两份都被聚焦认领：一条、无图标、名字照留并让位')
  const twin = mergeLayerSats([grd('n:9', { name: '节点A' }), grd('n:9', { name: '节点B' })], NO_KEYS)
  ok(twin.length === 1 && twin[0].name === '节点A', '③ 同号的两个天线树节点并成一条（同序号取先出现的）')
}

// ④ 只并不加（随机性质测试）
{
  let bad = 0
  for (let t = 0; t < 400; t++) {
    const n = 1 + Math.floor(rnd() * 14), list = []
    for (let i = 0; i < n; i++) {
      const key = rnd() < 0.1 ? undefined : 'n:' + Math.floor(rnd() * 6)
      const mk = rnd() < 0.5 ? grd : vis
      list.push(mk(key, { iconShow: rnd() < 0.8, labelShow: rnd() < 0.6, name: rnd() < 0.85 ? 'S' + i : '' }))
    }
    const claimed = new Set(); for (let k = 0; k < 6; k++) if (rnd() < 0.3) claimed.add('n:' + k)
    const out = mergeLayerSats(list, claimed)
    const keyed = out.filter((s) => s.key)
    const uniq = new Set(keyed.map((s) => s.key)).size === keyed.length
    const noClaimedIcon = keyed.every((s) => !(claimed.has(s.key) && s.iconShow !== false))
    const wantIcon = new Set(list.filter((s) => s.key && s.iconShow !== false).map((s) => s.key))
    const iconKept = [...wantIcon].every((k) => claimed.has(k) || keyed.some((s) => s.key === k && s.iconShow !== false))
    const noNewIcon = keyed.every((s) => s.iconShow === false || wantIcon.has(s.key))
    const wantLabel = new Set(list.filter((s) => s.key && s.labelShow !== false && s.name).map((s) => s.key))
    const labelKept = [...wantLabel].every((k) => keyed.some((s) => s.key === k && s.labelShow !== false && s.name))
    const keyless = out.filter((s) => !s.key).length === list.filter((s) => !s.key).length
    if (!(uniq && noClaimedIcon && iconKept && noNewIcon && labelKept && keyless)) bad++
  }
  ok(bad === 0, '④ 400 组随机输入：每颗至多一条、认领的不出图标、要图标的不丢（或交给聚焦层）、不凭空加图标、名字不丢、无 key 条目原样', bad + ' 组违例')
}

// ⑤ 辅助函数
{
  const ks = keysOf([{ key: 'n:1' }, { key: 'n:2' }, {}, null, { key: 'n:1' }])
  ok(ks.size === 2 && ks.has('n:1') && ks.has('n:2'), '⑤ keysOf：去重、跳过无 key / null')
  const a = new Set(['n:1']), b = new Set(['n:2'])
  const u = anyOf(a, null, b, NO_KEYS)
  ok(u.has('n:1') && u.has('n:2') && !u.has('n:3') && u.size > 0, '⑤ anyOf：并集判定')
  ok(anyOf(a, null) === a && anyOf(null, NO_KEYS) === NO_KEYS && anyOf() === NO_KEYS, '⑤ anyOf：只剩一份时直接返回它（不包一层），全空返回 NO_KEYS')
  a.add('n:5')
  ok(u.has('n:5'), '⑤ anyOf 是只读视图、不拷贝（选中集几千个键每拍复制是白花）')
  const subs = [{ lat: 1, lon: 2, key: 'n:1' }, { lat: 3, lon: 4, key: 'n:3' }, { lat: 5, lon: 6 }]
  const left = withoutClaimed(subs, u)
  ok(left.length === 2 && left[0].key === 'n:3' && left[1].key === undefined, '⑤ withoutClaimed：剔掉被认领的、没 key 的照留')
  ok(withoutClaimed(subs, NO_KEYS) === subs && withoutClaimed(null, u).length === 0, '⑤ withoutClaimed：没人认领原样返回；null 给空表')
  ok(claimSig(['n:1', 'n:3', 'n:2'], u) === 'n:1\nn:2\n' && claimSig(['n:1'], NO_KEYS) === '' && claimSig(['n:1'], null) === '', '⑤ claimSig：按 keys 次序列出被认领的那几颗')
}

// ⑥ 在轨点
{
  const a = visItem('n:1'), b = visItem('n:2'), c = visItem(undefined), lineless = visItem('n:3', { orbit: null })
  const items = [a, b, c, lineless]
  const out = withoutClaimedDots(items, new Set(['n:1', 'n:3']))
  ok(out.length === 4, '⑥ 条数不变（同一条里还有视线斜线，不能整条丢）')
  ok(out[0] !== a && out[0].noDot === true && out[0].orbit === a.orbit && out[0].satPos === a.satPos && out[0].raw === true, '⑥ 被认领：浅拷贝 + noDot，视线斜线 / 在轨位置等字段原样')
  ok(!a.noDot, '⑥ 不改入参对象')
  ok(out[1] === b && out[2] === c, '⑥ 没被认领 / 没 key：同一个对象')
  ok(out[3].noDot === true && out[3].orbit === null, '⑥ 关了视线斜线的那条：只剩 noDot（setSelectionSet 什么也不画，与整条丢掉同效）')
  ok(withoutClaimedDots(items, NO_KEYS) === items && withoutClaimedDots(null, new Set(['n:1'])).length === 0, '⑥ 没人认领原样返回；null 给空表')
  const once = withoutClaimedDots([visItem('n:1', { noDot: true })], new Set(['n:1']))
  ok(once[0].noDot === true, '⑥ 已经是 noDot 的不再拷贝')
  const noPos = withoutClaimedDots([{ key: 'n:1', orbit: [] }], new Set(['n:1']))
  ok(!noPos[0].noDot, '⑥ 没有 satPos（本就不出在轨点）：不打标')
  let bad = 0
  for (let t = 0; t < 300; t++) {
    const n = Math.floor(rnd() * 10), list = []
    for (let i = 0; i < n; i++) list.push(visItem(rnd() < 0.15 ? undefined : 'n:' + Math.floor(rnd() * 5), { satPos: rnd() < 0.9 ? { lat: 0, lon: i, altKm: 500 } : null }))
    const claimed = new Set(); for (let k = 0; k < 5; k++) if (rnd() < 0.4) claimed.add('n:' + k)
    const r = withoutClaimedDots(list, claimed)
    const dotOf = (it) => !!(it && it.satPos && !it.noDot)
    const okLen = r.length === list.length
    const noClaimedDot = r.every((it) => !(it.key && claimed.has(it.key) && dotOf(it)))
    const keptOthers = list.every((it, i) => (it.key && claimed.has(it.key)) || (r[i] === it))
    const noNewDot = r.every((it, i) => !dotOf(it) || dotOf(list[i]))
    if (!(okLen && noClaimedDot && keptOthers && noNewDot)) bad++
  }
  ok(bad === 0, '⑥ 300 组随机输入：条数不变、认领的不出在轨点、别的原样、不凭空加点', bad + ' 组违例')
}

// ⑦ 接线按源码钉
{
  const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const page = rd('../../../src/pages/ConstellationMap3D.vue')
  const body = (sig) => { const i = page.indexOf(sig), j = page.indexOf('\n}\n', i); return i >= 0 && j > i ? page.slice(i, j) : '' }
  const pg = body('function pushGeom() {')
  ok(pg.includes('scene.setFocusSatLLA([...withoutClaimed(vg.subs, anyOf(g.subOn ? g.keys : null, sfKeys)), ...(subOn ? sf.subs : [])])'), '⑦ 3D 图标：可见星图标剔掉聚焦层（这份几何带图标时的选中集 + 对星特效）已画的')
  ok(pg.includes('scene.setSelectionSet([...withoutClaimedDots(vg.items, anyOf(g.dotOn ? g.keys : null, sfDotKeys)), ...sf.items])') && pg.includes('const sfDotKeys = dotOn ? keysOf(sf.items) : NO_KEYS') && pg.includes('const subOn = !!focusStyle.subOn, dotOn = !!focusStyle.dotOn'), '⑦ 3D 在轨点：可见星的点让给聚焦层（这份几何带在轨点时）与对星特效（「在轨点」开着时）；按在轨点自己的开关认领')
  ok(pg.includes('flat.setFocusSat(subOn ? [...f.subs, ...sf.subs] : [])') && pg.includes('setSubClaim2D(anyOf(subOn && has2d ? g.keys : null, sfKeys))') && pg.includes('const has2d = g.shards.some((sh) => sh.flat)'), '⑦ 2D：对星特效与 3D 同一份 subs；认领集只认这份几何真打包了平面图的聚焦星')
  ok(!/subs2d/.test(page), '⑦ subs2d 特例已删（源星的重影改由归并处理）')
  const sc = body('function computeSatcovFocusGeometry() {')
  ok(sc.includes('if (id) { seen.add(id); g.item.key = id; if (g.sub) g.sub.key = id }'), '⑦ 对星特效的在轨点条目与图标都带身份串（与 seen 去重同一个 id）')
  const sg = body('function startFocusGeometry() {')
  ok(sg.includes('return { shards, ringBuild: reRing, spin, keys, subOn: p.style.subOn, dotOn: p.style.dotOn }') && sg.includes('const keys = poolKeys') && sg.includes('keys: NO_KEYS, subOn: false, dotOn: false'), '⑦ 聚焦几何带回它画的是哪几颗、带没带图标 / 在轨点（发起时钉住）')
  ok(body('function syncPool(draw, primary) {').includes('poolKeys = new Set(draw.map(satIdOf))'), '⑦ 选中集身份串随选中集换新（syncPool）')
  const rs = body('function redrawSats() {')
  ok(rs.includes('key: grdNodeSatId(node), rank: MARK_RANK.grd') && rs.includes('s.rank = MARK_RANK.vis') && rs.includes('const satsM = mergeLayerSats(sats, _subClaim2D)') && rs.includes('{ lines, dots, labels, sats: satsM, fills }'), '⑦ redrawSats：天线树卫星 / 可见星带身份串与序号，卫星层走 mergeLayerSats')
  ok(rs.indexOf('_layerClaimSig = claimSig(_layerSubKeys, _subClaim2D)') > rs.indexOf('const satsM'), '⑦ redrawSats 记下这次卫星层被认领的签名（setSubClaim2D 据此判断要不要重画）')
  ok(body('function setSubClaim2D(claim) {').includes('if (claimSig(_layerSubKeys, claim) !== _layerClaimSig) redrawSats()'), '⑦ 认领集变了、且卫星层里被认领的那几颗真变了才重画卫星层')
  const gid = body('function grdNodeSatId(node) {')
  ok(gid.includes("if (node.noradId) return 'n:' + node.noradId") && gid.includes("return tge ? satIdOf(tge) : 'f:' + node.folder") && sc.includes("const fid = tge ? satIdOf(tge) : 'f:' + node.folder"), '⑦ 天线树节点身份：关联星按号、虚拟星按星座条目、否则 folder（与对星特效 add 同一套）')
  const vg = body('function computeVisibilityGeometry() {')
  ok(page.includes("const satIdOf = (e) => (e && e.noradId ? 'n:' + e.noradId : (e ? 'm:' + e.name : ''))") && vg.includes('const key = satIdOf(r)') && vg.includes('primary: hot,\n      key\n') && vg.includes('colorHex: icNum, key })'), '⑦ 可见星（3D 在轨点条目 + 星下点图标）身份串＝satIdOf')
  const uv = rd('../../../src/viz/vis/useVisibility.js')
  ok(uv.includes("iconShow: true, key: r.noradId ? 'n:' + r.noradId : 'm:' + r.name })"), '⑦ 可见星（2D 卫星层）身份串与 satIdOf 同式')
  const sj = rd('../../../src/viz/globe3d/scene.js')
  ok(sj.includes('if (cfg.dotOn && !it.noDot && it.satPos && Number.isFinite(it.satPos.lat) && Number.isFinite(it.satPos.lon)) {'), '⑦ 3D 场景 setSelectionSet：noDot 只撤在轨点')
  const fc = rd('../../../src/viz/flatmap/flatCoverage.js')
  ok(fc.includes('const half = s.gapFocus ? focusHalf : (s.iconShow !== false ? (s.iconSize || sizes.satIcon || 30) * mz * SAT_ICON_K * 0.5 : 0)')
    && fc.includes('const focusHalf = focusCfg.subOn ? (Number(focusCfg.subPx) > 0 ? Number(focusCfg.subPx) : 30) * iz * SAT_ICON_K * 0.5 : 0')
    && fc.includes('hex(s.labelColor != null ? s.labelColor : (s.color != null ? s.color : 0xffd27a))'), '⑦ 平面图：让给聚焦层的名字按聚焦图标半高让位（subPx × √scale × K，与 drawFocusIcons 同口径），名字色可与图标色分开')
  ok(fc.includes('if ((focusCfg.subPx !== px0 || focusCfg.subOn !== on0) && satLayer && (satLayer.sats || []).some((q) => q && q.gapFocus)) invalidateText()'), '⑦ 平面图：改聚焦图标大小 / 开关时重排文字快照（名字的让位跟着变）')
}

console.log(`\n${pass} pass, ${fail} fail`)
if (fail) process.exit(1)
