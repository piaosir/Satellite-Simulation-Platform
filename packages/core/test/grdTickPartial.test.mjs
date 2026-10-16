// 播放每拍「只重建动了的天线」（src/viz/grd/useGrdCoverage.js recomputeMoved）与整轮重建逐层对拍：
//  同一套操作喂两个 useGrdCoverage —— A 每拍 tickLive 之后再整轮 recompute 一次（场景末态 = 改前每拍整轮重建的结果），
//  B 只 tickLive（走增量）。每拍之后比两边场景里的全部图层（按 id：层序 li + 层数据逐字段序列化，类型化数组按值）与图层选项。
//  ① 一颗关联星在动、一颗固定 GEO 不动：逐拍逐层一致，且 B 真走了增量（动的那根天线 patch、不动的不重建）
//  ② 中途改不动那根天线的设置（线宽）/ 全局显示设置 / 底色签名 / 缩放让步长档变了：B 当拍退回整轮，仍逐层一致
//  ③ 关联星无星历（层撤下）再恢复：层 id 变了 → 退回整轮，逐层一致
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORE = pathToFileURL(path.resolve(HERE, '..') + '/').href
const SRC = pathToFileURL(path.resolve(HERE, '../../../src/viz') + '/').href
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith('@core/')) return next(${JSON.stringify(CORE)} + s.slice(6), c); return next(s, c) }`))

if (!globalThis.localStorage) { const mem = new Map(); globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), clear: () => mem.clear() } }
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => { fn(0); return 0 })
globalThis.cancelAnimationFrame = globalThis.cancelAnimationFrame || (() => {})
globalThis.window = globalThis.window || { api: { coverageGrd: { save: async (nm) => ({ file: nm }) } }, addEventListener() {}, removeEventListener() {} }
const tick0 = () => new Promise((r) => setTimeout(r, 0))

const { useGrdCoverage } = await import(SRC + 'grd/useGrdCoverage.js')
const W = await import(SRC + 'wgs84.js')
const GEO_ALT = W.RS_GEO - W.A

let fails = 0
const ok = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  (' + extra + ')' : ''}`); if (!cond) fails++ }

// 21 × 21 igrid 6 高斯点波束（±5°），同 modelAttPointing ⑧；两个波束（第二个偏开一点）
const synthGrd = (name) => {
  const NX = 21, out = [name, '++++', '1', '2 3 2 6', '0 0', '0 0']   // NSET=2：两行中心偏移在前，之后逐 set 网格
  for (const [dx, dy] of [[0, 0], [1.5, -1]]) {
    out.push('-5 -5 5 5', `${NX} ${NX} 0`)
    for (let r = 0; r < NX; r++) for (let c = 0; c < NX; c++) { const az = -5 + c * 0.5 - dx, el = -5 + r * 0.5 - dy, a = Math.pow(10, (40 - 3 * (az * az + el * el)) / 20); out.push(`${a.toExponential(6)} 0 ${(a * 0.03).toExponential(6)} 0`) }
  }
  return out.join('\n') + '\n'
}

const ser = (L) => JSON.stringify(L, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v))
function mkScene() {
  const st = { layers: new Map(), opts: '', full: 0, patch: 0, rebuilt: [] }
  const sc = {
    vm: { pxPerDeg: 20 },
    viewMetrics() { return this.vm },
    hs: 'h0',
    covLabelStyle() { return this.hs },
    faceLonLat() {},
    updateCoverageField(layers, opts) { st.full++; const m = new Map(); layers.forEach((L, li) => m.set(L.id, { li, s: ser(L) })); st.layers = m; st.opts = JSON.stringify(opts); st.rebuilt = layers.map((L) => L.id) },
    setCoverageField(layers, opts) { this.updateCoverageField(layers, opts) }
  }
  // 与 scene.patchCoverageLayers 同口径：按 id 认旧层、层序沿用旧层的；新 id 接在后面
  sc.patchCoverageLayers = (layers, opts) => {
    st.patch++
    let nextLi = st.layers.size
    for (const L of layers) { const prev = st.layers.get(L.id); st.layers.set(L.id, { li: prev ? prev.li : nextLi++, s: ser(L) }) }
    if (opts && opts.rays) st.opts = JSON.stringify(opts)
    st.rebuilt = layers.map((L) => L.id)
  }
  return { sc, st }
}
const A = mkScene(), B = mkScene()
const live = { lon: 87.5, lat: 0.2, altKm: GEO_ALT - 300, on: true }
async function mk(S) {
  const g = useGrdCoverage(() => S.sc, () => null, () => false, {})
  g.setLivePos((node) => (node.noradId ? (live.on ? { ...live } : null) : null))
  const nL = g.addSatellite({ name: 'LNK', noradId: 99999, lon: live.lon, lat: live.lat, altKm: live.altKm })
  const kL = await g.importSynthGrd(nL.folder, 'A', synthGrd('a'))
  const nG = g.addSatellite({ name: 'GEO-F', lon: 100.5, lat: 0, altKm: GEO_ALT })
  const kG = await g.importSynthGrd(nG.folder, 'B', synthGrd('b'))
  return { g, kL, kG }
}
const a = await mk(A), b = await mk(B)
await tick0()
const same = () => {
  if (A.st.opts !== B.st.opts) return 'opts'
  if (A.st.layers.size !== B.st.layers.size) return 'size ' + A.st.layers.size + '/' + B.st.layers.size
  for (const [id, x] of A.st.layers) { const y = B.st.layers.get(id); if (!y) return 'missing ' + id; if (x.li !== y.li) return 'li ' + id; if (x.s !== y.s) return 'data ' + id }
  return ''
}
const step = async (n, dLon, dLat) => {
  for (let i = 0; i < n; i++) {
    live.lon += dLon; live.lat += dLat
    a.g.tickLive(); a.g.recompute(); b.g.tickLive()
    await tick0()
    const d = same(); if (d) return d
  }
  return ''
}

// ① 动的只有关联星那根
{
  const p0 = B.st.patch, f0 = B.st.full
  const d = await step(30, 0.03, 0.004)
  ok(!d, '① 关联星在动、固定 GEO 不动：30 拍逐层一致', d)
  ok(B.st.patch - p0 >= 30 && B.st.full === f0, '① B 每拍走增量（不整轮）', `增量 ${B.st.patch - p0} 次 · 整轮 ${B.st.full - f0} 次`)
  ok(B.st.rebuilt.length > 0 && B.st.rebuilt.every((id) => id.startsWith(b.kL)), '① 增量只重建动了的那根天线的层', B.st.rebuilt.join(','))
  ok(A.st.layers.size === 4, '① 两根天线各 2 个波束层', String(A.st.layers.size))
}

// ② 各种「拿不准」→ 当拍退回整轮，仍一致
{
  const cases = [
    ['改全局显示设置（线宽）', () => { a.g.s.lineWidth = 2.4; b.g.s.lineWidth = 2.4 }],
    ['改底色（标注套边签名）', () => { A.sc.hs = 'h1'; B.sc.hs = 'h1' }],
    ['缩放让步长档变了', () => { A.sc.vm = { pxPerDeg: 0.05 }; B.sc.vm = { pxPerDeg: 0.05 } }],
    ['不动那根天线的设置被改（不经重绘）', () => { for (const [g, k] of [[a.g, a.kG], [b.g, b.kG]]) g.getPerfContext(k).settings.lineWidth = 3.1 }],
    ['换聚焦天线（叠放次序变）', async () => { for (const [g, k] of [[a.g, a.kL], [b.g, b.kL]]) { const f = k.split('|')[0], nm = k.split('|')[1]; const node = g.sats.value.find((x) => x.folder === f); await g.setActive(node, node.antennas.find((x) => x.name === nm), { face: false }) } }]
  ]
  for (const [tag, fn] of cases) {
    const f0 = B.st.full
    await fn(); await tick0()
    const d = await step(3, 0.02, -0.003)
    ok(!d, `② ${tag}：之后 3 拍逐层一致`, d)
    ok(B.st.full > f0, `② ${tag}：B 至少整轮重建过一次（页面自己重绘或增量判据退回）`, `整轮 ${B.st.full - f0} 次`)
  }
}

// ③ 无星历撤层 → 恢复
{
  live.on = false
  let d = await step(2, 0.01, 0)
  ok(!d && ![...B.st.layers.keys()].some((id) => id.startsWith(b.kL)), '③ 关联星无星历：两边都撤下它的层且一致', d)
  live.on = true
  d = await step(3, 0.01, 0)
  ok(!d && [...B.st.layers.keys()].some((id) => id.startsWith(b.kL)), '③ 星历恢复：两边都画回来且一致', d)
}

assert.ok(true)
if (fails) { console.log(`\n${fails} 项失败`); process.exit(1) } else console.log('\n全部通过')
