// 跟随卫星的自动降档（modelLayer updateFollow；2026-10-20 用户：「跟随卫星一段时间模型会错误消失」）：
//  ① 性能样本只认 scene 给的干净帧间隔 smp：dt 再慢、smp = 0（这段间隔里有时钟拍掐过出帧）不降档 ——
//     原先拿 dt 量，播放时一拍一出帧，dt ≈ 整拍耗时，几秒内 lod0 → lod1 → lod2 → 撤模型
//  ② 降档原位换：降档那一刻旧档照挂着，新档挂好才换下；取不到更粗的一档（没下载、离线）就一直留着旧档
//  ③ 到 lod2 为止：再慢也不撤主星模型（原「lod2 仍跟不上 → 只画标记」已删）
//  ④ 源码钉：scene.holdFrames 记脏 → loop 报 smpSec（脏则 0）给叠加层；出帧闸在采样之前
// 模型来源打桩：models.ensure / getMeta + fetch 回一个三角形 glb，三档大小不同（外包盒认是哪一档挂着）
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORE = pathToFileURL(path.resolve(HERE, '..') + '/').href
const SRC = pathToFileURL(path.resolve(HERE, '../../../src') + '/').href
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith('@core/')) return next(${JSON.stringify(CORE)} + s.slice(6), c); return next(s, c) }`))

const THREE = await import('three')
const ML = await import(SRC + 'viz/globe3d/modelLayer.js')
const { llaToVec } = await import(SRC + 'viz/globe3d/focusLanes.js')

let n = 0
const t = async (name, fn) => { try { await fn() } catch (e) { console.error('FAIL ' + name); throw e } n++ }
const src = (p) => readFileSync(path.resolve(HERE, '../../../src', p), 'utf8').replace(/\r\n/g, '\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 一个三角形的 glb：顶点 (−s,−s,0) (s,−s,0) (0,s,0) —— 外包盒 max.x = s
function glb(s) {
  const pos = new Float32Array([-s, -s, 0, s, -s, 0, 0, s, 0])
  const json = JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: pos.byteLength }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-s, -s, 0], max: [s, s, 0] }]
  })
  const jb = Buffer.from(json.padEnd(Math.ceil(json.length / 4) * 4, ' '), 'utf8')
  const bb = Buffer.from(pos.buffer)
  const out = Buffer.alloc(12 + 8 + jb.length + 8 + bb.length)
  let o = 0
  out.writeUInt32LE(0x46546c67, o); out.writeUInt32LE(2, o + 4); out.writeUInt32LE(out.length, o + 8); o += 12
  out.writeUInt32LE(jb.length, o); out.writeUInt32LE(0x4e4f534a, o + 4); jb.copy(out, o + 8); o += 8 + jb.length
  out.writeUInt32LE(bb.length, o); out.writeUInt32LE(0x004e4942, o + 4); bb.copy(out, o + 8)
  return new Uint8Array(out)
}
const SIZE = { lod0: 4, lod1: 3, lod2: 2 }
const avail = new Set(['lod0', 'lod1', 'lod2'])
globalThis.fetch = async (url) => {
  const lod = String(url).split('://')[1].split('/')[0]
  const b = glb(SIZE[lod])
  return { ok: true, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }
}
const mkApi = (id) => ({
  models: {
    ensure: async ({ lod }) => (avail.has(lod) ? { state: 'ready', url: 'stub://' + lod + '/' + id, lod } : { state: 'downloading' }),
    getMeta: async () => ({ id, frame: { q_model2body: [0, 0, 0, 1], t_model2body: [0, 0, 0] }, units: { scaleToMeters: 1 },
      files: { lod0: { tris: 1 }, lod1: { tris: 1 }, lod2: { tris: 1 } } }),
    onChanged: () => () => {}
  }
})

const a = llaToVec(10, 100, 800)
const state = (modelId) => ({ key: 'S', modelId, anchor: [a.x, a.y, a.z], qL2S: [0, 0, 0, 1], velL: [1, 0, 0], eclipse: 1, altKm: 800, others: [], near: null })
const cam = new THREE.PerspectiveCamera(42, 1600 / 900, 0.01, 120)
const boxX = (L) => { const b = L.stats().followBox; return b ? +b.max[0].toFixed(3) : null }
async function until(L, pred, msg) {
  const t0 = Date.now()
  while (!pred(L.stats())) { assert.ok(Date.now() - t0 < 10000, msg + '（10 s 内没等到）'); await sleep(30) }
}
// 一个采样窗 = 17 × 0.06 s = 1.02 s（16 个只有 0.96 s，不满一窗）；平均 60 ms 远超 60 fps 上限的 1.5 / 2.5 倍
const feed = (L, windows, dt, smp) => { for (let i = 0; i < windows * 17; i++) L.overlay.update(dt, cam, 1600, 900, smp) }

await t('① dt 再慢、smp = 0（间隔里有时钟拍）不降档；同样慢的干净样本第 4 窗降一档（前 3 窗是进入跟随的迟滞）', async () => {
  const L = ML.createModelLayer({ api: mkApi('m1') })
  L.follow(state('m1'))
  await until(L, (s) => s.lod === 'lod0', '进入跟随先挂 lod2 再换 lod0')
  assert.equal(boxX(L), SIZE.lod0)
  feed(L, 12, 0.06, 0)
  assert.equal(L.stats().lodDowngradedFrom, null, '脏样本不许降档')
  assert.equal(L.stats().lodTarget, 'lod0')
  feed(L, 12, 0.06, undefined)
  assert.equal(L.stats().lodDowngradedFrom, null, '没给 smp（loop 之外的补画）也不算样本')
  feed(L, 3, 0.06, 0.06)
  assert.equal(L.stats().lodDowngradedFrom, null, '迟滞 3 窗')
  feed(L, 1, 0.06, 0.06)
  assert.equal(L.stats().lodDowngradedFrom, 'lod0', '第 4 窗降档')
  L.dispose()
})

await t('② 降档原位换：降档那一刻旧档照挂；新档挂好才换下；取不到更粗的一档就一直留着旧档', async () => {
  avail.add('lod2')
  const L = ML.createModelLayer({ api: mkApi('m2') })
  L.follow(state('m2'))
  await until(L, (s) => s.lod === 'lod0', '进入跟随')
  feed(L, 4, 0.06, 0.06)
  assert.equal(L.stats().lodDowngradedFrom, 'lod0')
  assert.equal(L.stats().lod, 'lod0', '降档那一刻旧档还挂着')
  assert.equal(boxX(L), SIZE.lod0)
  assert.equal(L.stats().modelVisible, true)
  await until(L, (s) => s.lod === 'lod1', '新档挂好')
  assert.equal(boxX(L), SIZE.lod1)
  // lod2 这时取不到（还在下载、没有可用档）：再降一档 —— 旧的 lod1 必须留着
  avail.delete('lod2')
  feed(L, 4, 0.06, 0.06)
  assert.equal(L.stats().lodDowngradedFrom, 'lod1')
  await sleep(800)
  const s = L.stats()
  assert.equal(s.lodTarget, 'lod2')
  assert.equal(s.lod, 'lod1', '取不到 lod2：留着 lod1')
  assert.equal(boxX(L), SIZE.lod1)
  assert.equal(s.modelVisible, true)
  L.dispose()
})

await t('③ 到 lod2 为止：平均帧时远超上限 2.5 倍、持续十几秒，主星模型照挂照显', async () => {
  avail.add('lod2')
  const L = ML.createModelLayer({ api: mkApi('m3') })
  L.follow(state('m3'))
  await until(L, (s) => s.lod === 'lod0', '进入跟随')
  feed(L, 4, 0.06, 0.06)
  await until(L, (s) => s.lod === 'lod1', 'lod0 → lod1')
  feed(L, 4, 0.06, 0.06)
  await until(L, (s) => s.lod === 'lod2', 'lod1 → lod2')
  feed(L, 15, 0.09, 0.09)   // 90 ms ＞ 2.5 / 60
  const s = L.stats()
  assert.equal(s.lod, 'lod2')
  assert.equal(s.lodDowngradedFrom, 'lod1', '到 lod2 不再往下')
  assert.equal(s.modelVisible, true, '主星模型不许撤')
  assert.equal(boxX(L), SIZE.lod2)
  assert.ok(!('modelOff' in s), '撤模型那一档已删')
  L.dispose()
})

await t('④ 源码钉：holdFrames 记脏 → loop 采样（出帧闸之后、脏则 0）→ overlay.update 第五参；模型层只认 smp', () => {
  const sc = src('viz/globe3d/scene.js')
  assert.match(sc, /function holdFrames\(on\) \{ if \(on\) loopTaint = 2;/)
  const iHold = sc.indexOf('    if (frameHold) return\n')
  const iSmp = sc.indexOf('    const smpSec = loopTaint > 0 ? 0 : dtSec\n    if (loopTaint > 0) loopTaint--\n    lastLoopT = tNow\n')
  assert.ok(iHold > 0 && iSmp > iHold, '出帧闸在采样之前（掐着的那几帧不重置脏标记）')
  assert.match(sc, /if \(overlay\) overlay\.update\(dtSec, camera, curW, curH, smpSec\)\n    renderFrame\(\)/)
  const ml = src('viz/globe3d/modelLayer.js')
  assert.doesNotMatch(ml, /\bmodelOff\b/)
  assert.match(ml, /if \(smp > 0 && smp < 0\.099 && !hidden && fslot && fslot\.inst && !fslot\.swapping\) \{\n      perf\.acc \+= smp; perf\.n\+\+/)
  assert.match(ml, /if \(fstate\) updateFollow\(dt, camera, w, h, smp\)/)
})

console.log(`followAutoLod: ${n} 项通过`)
process.exit(0)   // loader 的模板引用归零后 60 s 才释放（setTimeout）：不等它
