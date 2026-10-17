// 合成 NORAD 号段总表与三处发号的回归网。运行：node packages/core/test/synthNorad.test.mjs
//
// 2026-10-17：自定义星座的号段原先只增不减（900000 起每座 +10000、删了不回收），累计建到第 10 座就落进 990000–999999，
// 与 GPS 年历查不到 PRN 时的合成号（990000 + PRN）同号；导入星历点序列组同理（800000 起每组 +10000，第 11 组落进 900000，
// 撞自定义星座）。两颗不同的星同号，选中 / 着色 / 身份（3D 页 satIdOf = 'n:<NORAD>'）就串了。
// 现在号段总表在 src/shared/synthNorad.js（主进程镜像 packages/core/utils/synthNorad.js），三处发号都取最低空闲段。
//
// 锁：
//   ① 镜像：渲染端 ESM 与主进程 CJS 的表逐值相同、函数逐字相同
//   ② 固定段两两不相交；各处写着字面值的号段常量 / 判据与总表一致
//   ③ blockSpan / lowestFree 边界
//   ④ 自定义星座建删 12 轮：每次发号 = 独立暴力解的最低空闲段（含复用删掉的段）；各段两两不相交；老存档号段不动；
//      新段不碰点序列 / GPS 年历 / 天线树 / 向导预览段；全部合成星号唯一；落盘往返号段不变
//   ⑤ 号段排到 170 万：跳过天线树与向导预览两段；预览星从 1800000 起、不与已建星座同号
//   ⑥ 改参数：颗数涨出原段且撞车才换号，涨进空地 / 改名改色原号不动；落在年历段的老星座改名改色也不动
//   ⑦ GPS 年历：查不到 PRN 的合成号 = 990000 + PRN、都在专属段，越段的 PRN 跳过；与任何新发的星座段都不重叠
//   ⑧ 点序列组导入 / 删除：号都在 [800000, 900000)，整段优先、排满了填段尾，删掉的号复用，同名重导入沿用原号，
//      旧版发到段外（≥ 900000）的组重导入换回段内
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import * as E from '../../../src/shared/synthNorad.js'
import { SATKEY_NORAD_MAX } from '../models/schema.mjs'
import { TREE_GEO_NORAD_BASE, isTreeGeoId } from '../../../src/viz/grd/treeGeo.js'
import { generateConstellation } from '../../../src/viz/constellation/walker.js'

const require = createRequire(import.meta.url)
const C = require('../utils/synthNorad.js')

// useCustomConstellations 读写 localStorage：node 里垫一个最小实现
const _ls = new Map()
globalThis.localStorage = { getItem: (k) => (_ls.has(k) ? _ls.get(k) : null), setItem: (k, v) => { _ls.set(k, String(v)) }, removeItem: (k) => { _ls.delete(k) } }
const U = await import('../../../src/viz/constellation/useCustomConstellations.js')

// 主进程 customSats 走 SATSIM_DATA_DIR 绕开 Electron userData
const DATA = path.join(os.tmpdir(), 'satsim-synthnorad-test')
fs.rmSync(DATA, { recursive: true, force: true })
process.env.SATSIM_DATA_DIR = DATA
const core = require('../index.js')
const customSats = require('../../../electron/services/customSats.js')(() => core)

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg + (extra !== undefined ? '\n      ' + extra : '')) } }
const section = (t) => console.log('\n— ' + t)
const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')

const S = E.SYNTH_NORAD
const { blockSpan, lowestFree } = E
const FIX = E.fixedRanges()
const hit = (a, b) => a[0] < b[1] && b[0] < a[1]

/* ===== ① 镜像 ===== */
section('① ESM / CJS 镜像')
ok(JSON.stringify(E.SYNTH_NORAD) === JSON.stringify(C.SYNTH_NORAD), '号段表逐值相同', JSON.stringify(C.SYNTH_NORAD))
ok(JSON.stringify(E.SYNTH_FIXED) === JSON.stringify(C.SYNTH_FIXED), '固定段清单相同')
for (const f of ['fixedRanges', 'blockSpan', 'lowestFree']) ok(typeof C[f] === 'function' && String(E[f]) === String(C[f]), f + ' 逐字相同')
ok(Object.keys(E).sort().join() === Object.keys(C).sort().join(), '两边导出同一组名字', Object.keys(E).join() + ' / ' + Object.keys(C).join())

/* ===== ② 固定段与各处号段常量 ===== */
section('② 固定段与各处号段常量')
const FIXK = E.SYNTH_FIXED.map((k) => [k, S[k].lo, S[k].hi])
ok(FIXK.every(([, lo, hi]) => Number.isInteger(lo) && Number.isInteger(hi) && lo < hi), '固定段都是非空整数区间')
let disj = true
for (let i = 0; i < FIXK.length; i++) for (let j = i + 1; j < FIXK.length; j++) if (FIXK[i][1] < FIXK[j][2] && FIXK[j][1] < FIXK[i][2]) disj = false
ok(disj, '固定段两两不相交')
ok(S.catalog.hi === SATKEY_NORAD_MAX && S.ephem.lo === SATKEY_NORAD_MAX, '编目段上界 = 点序列段起点 = schema.SATKEY_NORAD_MAX（800000 起全是合成号）')
ok(FIXK.filter(([k]) => k !== 'catalog').every(([, lo]) => lo >= SATKEY_NORAD_MAX), '合成段都 ≥ 800000（satGrpSweep 的 probe 一律不参与核对）')
ok(U.NORAD_BASE === S.custom.lo && S.custom.lo === S.ephem.hi, '自定义星座发号起点 = NORAD_BASE（useSatGroups 合成星豁免判据）= 点序列段终点')
ok(S.custom.step === 10000 && S.ephem.step === 10000 && S.ephem.fine === 1000, '星座按 10000 占段；点序列整段 10000、填空 1000')
ok(TREE_GEO_NORAD_BASE === S.treeGeo.lo && isTreeGeoId(S.treeGeo.lo) && isTreeGeoId(S.treeGeo.hi - 1) && !isTreeGeoId(S.treeGeo.hi) && !isTreeGeoId(S.treeGeo.lo - 1),
  '天线树号段 = 总表 treeGeo，isTreeGeoId 边界一致')
// 写着字面值的几处：3D 页的点序列段 / 年历段判据，各窗口读自定义星座时缺 noradBase 的回退号段，空间态势的自建星座判据
const PAGE = src('../../../src/pages/ConstellationMap3D.vue')
const m1 = /const EPHEM_NORAD_BASE = (\d+), EPHEM_NORAD_END = (\d+)/.exec(PAGE)
ok(m1 && +m1[1] === S.ephem.lo && +m1[2] === S.ephem.hi, '3D 页点序列段（isEphNorad / probe）= 总表 ephem', m1 && m1[0])
const m2 = /n >= NORAD_BASE && !\(n >= (\d+) && n < (\d+)\)/.exec(PAGE)
ok(m2 && +m2[1] === S.gpsAlm.lo && +m2[2] === S.gpsAlm.hi, '3D 页「对应已有卫星」检索里的年历段 = 总表 gpsAlm', m2 && m2[0])
for (const [file, re] of [
  ['../../../src/ngso/satSearchPool.js', /const NORAD_BASE = (\d+), NORAD_STEP = (\d+)/],
  ['../../../src/ci/useInterference.js', /const CC_NORAD_BASE = (\d+), CC_NORAD_STEP = (\d+)/],
  ['../../../src/model/satSources.js', /NORAD_BASE = (\d+), NORAD_STEP = (\d+)/]
]) {
  const m = re.exec(src(file))
  ok(m && +m[1] === S.custom.lo && +m[2] === S.custom.step, path.basename(file) + '：缺 noradBase 的老条目按序号回退的号段 = 总表 custom', m && m[0])
}
const m3 = /const CUSTOM_NORAD_BASE = (\d+)/.exec(src('../../../src/shared/ssaStats.js'))
ok(m3 && +m3[1] === S.custom.lo, 'ssaStats：自建星座判据 = 总表 custom.lo', m3 && m3[0])

/* ===== ③ blockSpan / lowestFree ===== */
section('③ blockSpan / lowestFree')
ok(blockSpan(0, 10000) === 10000 && blockSpan(1, 10000) === 10000 && blockSpan(10000, 10000) === 10000 && blockSpan(10001, 10000) === 20000 && blockSpan('x', 10000) === 10000,
  'blockSpan：至少一段、按 step 向上取整')
const G = { lo: 0, hi: 100, step: 10 }
ok(lowestFree(G, 10, []) === 0, '空表取段首')
ok(lowestFree(G, 10, [[0, 5]]) === 10, '撞上就跳到所撞段尾之后的对齐位')
ok(lowestFree(G, 10, [[0, 5], [12, 25]]) === 30, '连撞两段跳两次')
ok(lowestFree(G, 20, [[0, 10], [30, 31]]) === 10, '整块放得下就放（[10, 30) 空着）')
ok(lowestFree(G, 10, [[0, 100]]) === null && lowestFree(G, 20, [[0, 85]]) === null && lowestFree(G, 10, [[0, 90], [91, 92]]) === null, '放不下返回 null（不越出 hi）')
ok(lowestFree(S.ephem, 10000, [[800000, 801000]]) === 810000 && lowestFree(S.ephem, 1000, [[800000, 801000]], 1000) === 801000, '点序列：整段对齐找到 810000，按 1000 填空找到 801000')
ok(lowestFree(S.ephem, 1000, [[800000, 900000]], 1000) === null, '点序列段排满返回 null（customSats 据此报号段已满）')
ok(lowestFree(S.custom, 10000, FIX.concat([[900000, 990000]])) === 1000000, '星座：撞上年历段跳到 1000000')
ok(lowestFree(S.custom, 20000, FIX.concat([[900000, 1690000]])) === 1900000, '星座：两段大的跳过天线树与预览段，落到 1900000')

/* ===== ④ 自定义星座：建删 12 轮 ===== */
section('④ 自定义星座：建删 12 轮')
const KEY = 'constellation3d/customConsts'
const P = (T) => ({ name: 'W', pattern: T === 1 ? 'single' : 'plane', T, P: 1, F: 0, incl: 53, shape: 'circ', perigeeKm: 550, apogeeKm: 550, argp: 0, raan0: 0, m0: 0 })
const item = (id, T, noradBase) => ({ id, name: id, params: P(T), color: '#4dabf7', colorByPlane: true, visible: true, ...(noradBase != null ? { noradBase } : {}) })
const cnt = (c) => generateConstellation(c.params).length
const span10k = (n) => Math.max(1, Math.ceil(n / 10000)) * 10000          // 测试自己的口径，不借被测的 blockSpan
const blk = (c) => [c.noradBase, c.noradBase + span10k(cnt(c))]
const byId = (cc, id) => cc.list.value.find((x) => x.id === id)
const newBlocks = []   // 本测试里新发的段（⑦ 拿年历号逐个比）
// 独立暴力解：从 900000 起逐段试，第一段与固定段、现存各星座都不相交的
function oracle(live, n) {
  const s = span10k(n), taken = FIX.concat(live.map(blk))
  for (let b = 900000; ; b += 10000) if (!taken.some((t) => hit([b, b + s], t))) return b
}
// 原始现场：新库连建 10 座，旧版第 10 座落在 990000（与年历合成号同号）
localStorage.removeItem(KEY)
const c10 = U.useCustomConstellations(() => {})
c10.load()
const ten = []
for (let i = 0; i < 10; i++) ten.push(c10.add({ name: 'T' + i, params: P(6) }).noradBase)
ok(ten.join() === [900000, 910000, 920000, 930000, 940000, 950000, 960000, 970000, 980000, 1000000].join(), '新库连建 10 座：第 10 座跳过年历段落到 1000000', ten.join(','))
for (const b of ten) newBlocks.push([b, b + 10000])
// 老存档（旧版只增发号建过 14 座、删剩 4 座）：L2 一万二千颗实占两段
localStorage.setItem(KEY, JSON.stringify({ top: 1020000, items: [item('L0', 6, 900000), item('L1', 24, 930000), item('L2', 12000, 950000), item('L3', 1, 1010000)] }))
const cc = U.useCustomConstellations(() => {})
cc.load()
const legacy = new Map(cc.list.value.map((c) => [c.id, c.noradBase]))
ok([...legacy.values()].join() === '900000,930000,950000,1010000', 'load：老存档号段原样', [...legacy.values()].join())
const st = { oracle: [], disjoint: true, fixed: true, legacy: true, exempt: true, unique: true, inBlock: true }
const deleted = []
let reused = 0, seq = 0
const addOne = (T) => {
  const want = oracle(cc.list.value.slice(), T)
  const c = cc.add({ name: 'N' + (++seq), params: P(T) })
  if (c.noradBase !== want) st.oracle.push('N' + seq + ' 得 ' + c.noradBase + '、应为 ' + want)
  const b = [c.noradBase, c.noradBase + span10k(T)]
  if (deleted.some((d) => hit(b, d))) reused++
  newBlocks.push(b)
  return c
}
function check() {
  const live = cc.list.value
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) if (hit(blk(live[i]), blk(live[j]))) st.disjoint = false
  const seen = new Set()
  for (const c of live) {
    if (legacy.has(c.id)) { if (c.noradBase !== legacy.get(c.id)) st.legacy = false }
    else if (FIX.some((t) => hit(blk(c), t))) st.fixed = false
    if (!(c.noradBase >= U.NORAD_BASE)) st.exempt = false
    const b = blk(c)
    for (const e of cc.satsOf(c.id)) {
      const n = Number(e.noradId)
      if (seen.has(n)) st.unique = false
      seen.add(n)
      if (!(n >= b[0] && n < b[1])) st.inBlock = false
    }
  }
}
const SIZES = [6, 1, 24, 10001, 6, 66, 1, 6, 24, 1, 10001, 6]
for (let r = 0; r < 12; r++) {
  addOne(SIZES[r]); addOne(6)
  // 每轮删一座：第 3 轮删老星座 L1（930000），其余轮按轮次挑一座新建的（确定性）
  const mine = cc.list.value.filter((c) => !legacy.has(c.id))
  const v = r === 2 ? byId(cc, 'L1') : mine[(r * 5) % mine.length]
  deleted.push(blk(v))
  if (legacy.has(v.id)) legacy.delete(v.id)
  cc.remove(v.id)
  check()
}
ok(!st.oracle.length, '每次发号 = 独立暴力解的最低空闲段', st.oracle.slice(0, 3).join('；'))
ok(reused > 0, '删掉的星座让出来的段被复用', 'reused=' + reused)
ok(st.disjoint, '每轮之后各星座段两两不相交')
ok(st.fixed, '新发的段不碰固定段（点序列 / GPS 年历 / 天线树 / 向导预览）')
ok(st.legacy, '老存档星座号段一律不动')
ok(st.exempt, '号段都 ≥ NORAD_BASE（卫星组核对豁免）')
ok(st.unique && st.inBlock, '全部合成星号唯一、落在各自星座段内')
ok(newBlocks.some((b) => b[0] > S.gpsAlm.lo), '发号真跨过了 990000（不是没走到年历段）', newBlocks.map((b) => b[0]).join(','))
ok(newBlocks.filter((b) => b[1] - b[0] === 20000).length === 2, '一万颗以上的星座连占两段')
const blob = JSON.parse(localStorage.getItem(KEY))
const cc2 = U.useCustomConstellations(() => {})
cc2.load()
ok(cc2.list.value.map((c) => c.id + ':' + c.noradBase).join() === cc.list.value.map((c) => c.id + ':' + c.noradBase).join(), '落盘往返号段不变')
ok(blob.top >= 1020000 && blob.top >= Math.max(...cc.list.value.map((c) => blk(c)[1])), 'top 记发过的最高段尾（回退到旧版本仍从全部已用段之上发号）', String(blob.top))

/* ===== ⑤ 排到 170 万：跳过天线树与向导预览 ===== */
section('⑤ 排到 170 万：跳过天线树与向导预览')
const full = []
for (let k = 0; k < 80; k++) { const b = 900000 + k * 10000; if (b !== S.gpsAlm.lo) full.push(item('F' + k, 1, b)) }
localStorage.setItem(KEY, JSON.stringify({ top: 1700000, items: full }))
const cf = U.useCustomConstellations(() => {})
cf.load()
const f1 = cf.add({ name: 'X1', params: P(1) })
ok(f1.noradBase === 1790000, '天线树段之后、预览段之前那一段（1790000）', f1.noradBase)
const f2 = cf.add({ name: 'X2', params: P(10001) })
ok(f2.noradBase === 1900000, '两段大的放不进 1790000 的缝，跳过预览段落到 1900000', f2.noradBase)
const f3 = cf.add({ name: 'X3', params: P(6) })
ok(f3.noradBase === 1920000, '再往后接着发', f3.noradBase)
cf.remove('F0')
const f4 = cf.add({ name: 'X4', params: P(1) })
ok(f4.noradBase === 900000, '删掉 900000 那座 → 下一座复用 900000', f4.noradBase)
for (const c of [f1, f2, f3, f4]) newBlocks.push(blk(c))
ok([f1, f2, f3, f4].every((c) => !FIX.some((t) => hit(blk(c), t))), '新段不碰天线树 / 预览 / 年历段')
cf.setPreview({ name: 'PV', params: P(30), color: '#ff0000' })
const pv = cf.previewEntries().map((e) => Number(e.noradId))
ok(pv.length === 30 && pv[0] === 1800000 && pv.every((n) => n >= S.preview.lo && n < S.preview.hi), '向导预览星从 1800000 起、落在预览段', String(pv[0]))
const usedF = new Set(cf.catalog().map((e) => Number(e.noradId)))
ok(!pv.some((n) => usedF.has(n)), '预览星不与任何已建星座的星同号')
cf.setPreview(null)

/* ===== ⑥ 改参数：涨出原段撞车才换号 ===== */
section('⑥ 改参数：涨出原段撞车才换号')
localStorage.removeItem(KEY)
const cu = U.useCustomConstellations(() => {})
cu.load()
const A = cu.add({ name: 'A', params: P(6) }), B = cu.add({ name: 'B', params: P(6) })
ok(A.noradBase === 900000 && B.noradBase === 910000, '两座相邻：900000 / 910000')
cu.update(A.id, { params: P(10001) })
ok(byId(cu, A.id).noradBase === 920000 && byId(cu, B.id).noradBase === 910000, 'A 涨到两段、涨出去那截撞上 B → A 换到最低的两段空位 920000，B 不动', byId(cu, A.id).noradBase)
ok(cu.satsOf(A.id).length === 10001 && cu.satsOf(A.id).every((e) => +e.noradId >= 920000 && +e.noradId < 940000), 'A 的星号随段走')
cu.update(B.id, { name: 'B2' }); cu.update(B.id, { color: '#ff0000', colorByPlane: false }); cu.update(B.id, { params: P(8) })
ok(byId(cu, B.id).noradBase === 910000, '改名 / 改色 / 颗数涨了但仍在原段：原号不动')
const Cc = cu.add({ name: 'C', params: P(6) })
ok(Cc.noradBase === 900000, 'A 让出来的 900000 被复用')
const D = cu.add({ name: 'D', params: P(6) })
cu.update(D.id, { params: P(10001) })
ok(D.noradBase === 940000 && byId(cu, D.id).noradBase === 940000, '涨进空地（940000–959999 没人占）：原号不动')
cu.update(Cc.id, { params: P(10001) })
ok(byId(cu, Cc.id).noradBase === 960000, 'C 涨到两段撞上 B → 换到 960000（980000 起那两段压着年历段）', byId(cu, Cc.id).noradBase)
const cuL = cu.list.value
let cuDisj = true
for (let i = 0; i < cuL.length; i++) for (let j = i + 1; j < cuL.length; j++) if (hit(blk(cuL[i]), blk(cuL[j]))) cuDisj = false
ok(cuDisj && cuL.every((c) => !FIX.some((t) => hit(blk(c), t))), '改完各段两两不相交、不碰固定段')
for (const c of cuL) newBlocks.push(blk(c))
// 落在年历段的老星座（旧版建到第 10 座）：号段一律不动 —— 卫星组成员按号存着
localStorage.setItem(KEY, JSON.stringify({ top: 1000000, items: [item('G9', 6, 990000)] }))
const cg = U.useCustomConstellations(() => {})
cg.load()
cg.update('G9', { name: 'G9b' }); cg.update('G9', { color: '#00ff00', colorByPlane: false }); cg.toggle('G9'); cg.toggle('G9')
const cg2 = U.useCustomConstellations(() => {})
cg2.load()
ok(byId(cg, 'G9').noradBase === 990000 && byId(cg2, 'G9').noradBase === 990000, '落在年历段的老星座改名 / 改色 / 显隐、落盘往返都不动')
const gNew = cg.add({ name: 'new', params: P(6) })
ok(gNew.noradBase === 900000, '新发的照常取最低空闲段')
// 缺 noradBase 的老条目：按序号补，与 NGSO / 干扰 / 模型工作台 / 星历导出各窗口的回退读法一致
localStorage.setItem(KEY, JSON.stringify({ items: [item('a', 6), item('b', 6)] }))
const cl = U.useCustomConstellations(() => {})
cl.load()
ok(cl.list.value.map((c) => c.noradBase).join() === '900000,910000', '缺 noradBase 的老条目按序号补 900000 / 910000', cl.list.value.map((c) => c.noradBase).join())
ok(U.customConstellationsToOmmRecords('b')[0].noradId === '910000' && cl.satsOf('b')[0].noradId === '910000', '与星历导出同号')

/* ===== ⑦ GPS 年历合成号 ===== */
section('⑦ GPS 年历合成号')
// SEM 年历（真实体例：每颗 14 个数）。轨道数按序号 q 给，PRN 单独给 —— 越段的 PRN 也是一颗根数正常的星
const semText = (prns) => {
  const n = (v) => v.toExponential(14).toUpperCase()
  const L = [prns.length + '  CURRENT.ALM', ' 352 61440']
  prns.forEach((prn, i) => {
    const q = (i % 32) + 1
    L.push('', String(prn), String(40 + q), '0',
      [n(0.004 + q * 1e-4), n((1 + (q % 5) * 0.2) / 180), n(-2.5e-9)].join(' '),
      [n(5153.6 + q * 0.01), n(((q % 6) / 3) - 1), n(((q % 7) / 3.5) - 1)].join(' '),
      [n(((q % 11) / 5.5) - 1), n(0), n(0)].join(' '),
      '0', String(9 + (q % 4)))
  })
  return L.join('\n') + '\n'
}
const PRNS = Array.from({ length: 32 }, (_, i) => i + 1)
const rAlm = customSats.importFile('年历', semText(PRNS.concat([10000, -3])))   // 本机没有 gps 组缓存：全部查不到，落合成号
ok(rAlm.ok && rAlm.group.count === 32, '越段的两颗（PRN 10000 / −3）跳过，其余 32 颗导入', JSON.stringify(rAlm.error || (rAlm.group && rAlm.group.count)))
ok(['10000', '-3'].every((p) => (rAlm.warnings || []).some((w) => w.startsWith('PRN ' + p + '：'))), '跳过的 PRN 带告警', (rAlm.warnings || []).join(' | '))
const gIds = customSats.list().groups.find((g) => g.name === '年历').sats.map((s) => Number(s.noradId)).sort((a, b) => a - b)
ok(gIds.join() === PRNS.map((p) => S.gpsAlm.lo + p).join(), '合成号 = 990000 + PRN', gIds.join(','))
ok(gIds.every((n) => n >= S.gpsAlm.lo && n < S.gpsAlm.hi), '都在年历专属段')
ok(newBlocks.length > 30 && !newBlocks.some((b) => gIds.some((n) => n >= b[0] && n < b[1])), '与本测试里新发的任何星座段都不重叠', newBlocks.length + ' 段')

/* ===== ⑧ 点序列组 ===== */
section('⑧ 点序列组：导入 / 删除')
const MU = 398600.4418
function makeE(R) {
  const n = Math.sqrt(MU / (R * R * R)), ci = Math.cos(0.5), si = Math.sin(0.5)
  const L = ['stk.v.12.0', 'BEGIN Ephemeris', 'ScenarioEpoch 21 Sep 2026 00:00:00.000', 'CoordinateSystem J2000', 'DistanceUnit Kilometers',
    'InterpolationMethod Lagrange', 'InterpolationSamplesM1 5', 'CentralBody Earth', 'EphemerisTimePosVel']
  for (let i = 0; i < 11; i++) {
    const s = i * 60, u = n * s
    L.push([s.toFixed(6), (R * Math.cos(u)).toFixed(9), (R * Math.sin(u) * ci).toFixed(9), (R * Math.sin(u) * si).toFixed(9),
      (-R * n * Math.sin(u)).toFixed(9), (R * n * Math.cos(u) * ci).toFixed(9), (R * n * Math.cos(u) * si).toFixed(9)].join(' '))
  }
  L.push('END Ephemeris', '')
  return L.join('\n')
}
const grp = (name) => customSats.list().groups.find((g) => g.name === name)
const baseOf = (name) => { const g = grp(name); return g ? Number(g.sats[0].noradId) : null }
const imp = (name, R) => { const r = customSats.importFile(name, makeE(R)); if (!r.ok) console.error('    导入失败 ' + name + '：' + r.error); return baseOf(name) }
const first10 = []
for (let i = 1; i <= 10; i++) first10.push(imp('E' + i, 7000 + i * 10))
ok(first10.join() === Array.from({ length: 10 }, (_, i) => 800000 + i * 10000).join(), '前 10 组整段对齐：800000 起每组 10000', first10.join(','))
ok(imp('E11', 7110) === 801000, '整段排满：按 1000 对齐填进 E1 用剩的段尾（801000），不再越过 900000', String(baseOf('E11')))
ok(imp('E12', 7120) === 802000, '接着填 802000', String(baseOf('E12')))
customSats.removeGroup(grp('E3').id)
ok(imp('E13', 7130) === 820000, '删掉的整段先复用（820000）', String(baseOf('E13')))
customSats.removeGroup(grp('E11').id)
ok(imp('E14', 7140) === 801000, '整段都占着：复用删掉的段尾号 801000', String(baseOf('E14')))
ok(imp('E5', 7050) === 840000, '同名重导入沿用原号 840000', String(baseOf('E5')))
// 旧版发号不封顶，第 11 组起落进 900000 以上：改库模拟一个落在 900000 的老组，同名重导入换回段内
const dbf = path.join(DATA, 'omm', 'custom.json')
const db = JSON.parse(fs.readFileSync(dbf, 'utf8'))
const g10 = db.groups.find((g) => g.name === 'E10')
g10.noradBase = 900000; g10.sats[0].noradId = '900000'
fs.writeFileSync(dbf, JSON.stringify(db, null, 1))
ok(baseOf('E10') === 900000, '（模拟）老组的号在 900000')
ok(imp('E10', 7100) === 890000, '重导入：原号出了点序列段 → 换回段内最低空闲整段 890000', String(baseOf('E10')))
const eg = customSats.list().groups.filter((g) => g.kind === 'ephem')
const ext = eg.map((g) => { const b = Number(g.sats[0].noradId); return [b, b + blockSpan(g.sats.length, 1000)] })
let eDisj = true
for (let i = 0; i < ext.length; i++) for (let j = i + 1; j < ext.length; j++) if (hit(ext[i], ext[j])) eDisj = false
ok(eg.length === 12 && ext.every(([b, z]) => b >= S.ephem.lo && z <= S.ephem.hi), '12 组全在 [800000, 900000)', ext.map((x) => x[0]).join(','))
ok(eDisj, '各组实占的号两两不相交')
ok(eg.every((g) => g.sats.every((s, i) => Number(s.noradId) === Number(g.sats[0].noradId) + i)), '组内号 = 段首 + 序号')

fs.rmSync(DATA, { recursive: true, force: true })
console.log(`\nsynthNorad: 通过 ${pass}，失败 ${fail}`)
process.exit(fail ? 1 : 0)
