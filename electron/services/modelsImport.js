'use strict'
// 模型导入的格式分派（主进程 + occt worker 共用，不 require('electron')）。
//
//   · .glb           不经这里：models.js 原样入库（内容寻址，逐字节不动）。
//   · .gltf          gltfToGlb()：@gltf-transform/core 的 NodeIO 读（含外部 .bin / 贴图）→ 打包成 glb。
//                    ★ NodeIO 会把它不认识的扩展丢掉（AGI_articulations / AGI_stk_metadata 全在其列，
//                      见 deps 报告 §4）。所以先从原 JSON 按节点名把 AGI 块原样摘下来，写完再贴回去，
//                      贴回用 packages/core/models/glb.mjs 的 patchGlbJson（逐字节回环有单测）。
//   · STEP/IGES/BREP importCad()：起一个 worker_threads（occtWorker.js）跑 occt-import-js 网格化，
//                    worker 里顺手把结果建成 gltf-transform Document 写成 glb 再传回来 ——
//                    大装配网格化几十秒、建文档与写盘也是秒级，全放 worker，主进程（= 所有窗口的
//                    IPC 泵）一刻不堵。occtToGlb() 就是 worker 里跑的那段，放在本文件里是为了
//                    单测能在主线程直接调它。
//   · OBJ/STL/FBX    在渲染端用 three 的加载器解析（主进程不装 three，见 deps 报告 §0），转好的 glb
//                    经 models:saveImported 送回来入库，不经这里。
//
// 只用 @gltf-transform/core（+ extensions 读 .gltf 时用）；不碰 functions（会牵出 sharp 20 MB）。
// 抽稀直接调 meshoptimizer 的 MeshoptSimplifier（ESM-only → await import）。
// ★ @gltf-transform/* 也只能 await import，不能 require：它的 CJS 构建（dist/index.cjs）会 require 依赖
//   property-graph，而 property-graph 4.x 只有 ESM。Node 22（跑单测的系统 Node）能 require(esm) 所以看不出来，
//   Electron 31 的 Node 20.18 直接抛 ERR_REQUIRE_ESM —— 2026-09-23 在 Electron 实机冒烟里踩到。
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const L = require('./modelsLogic')

// packages/core/models/*.mjs 是 ESM（设计契约 T1）：CJS 里只能 await import(file URL)。
// 本文件在 worker 里也跑，所以按 __dirname 定位（开发 = 仓库、打包 = app.asar，两边相对位置一样）。
const CORE_MODELS_DIR = path.join(__dirname, '..', '..', 'packages', 'core', 'models')
const _esm = {}
const gltfCore = () => import('@gltf-transform/core')
const gltfExt = () => import('@gltf-transform/extensions')
const importCore = (name, dir = CORE_MODELS_DIR) => {
  const url = pathToFileURL(path.join(dir, name + '.mjs')).href
  return _esm[url] || (_esm[url] = import(url).catch((e) => { delete _esm[url]; throw e }))
}

// occt 网格化参数（设计契约 T7）：linearUnit 是【输出】单位，OCCT 自己按 STEP/IGES 文件头换算过来，
// 所以一律要米；BREP 没有单位概念（OCCT 按原数值出），由调用方按包围盒另猜。
const OCCT_PARAMS = { linearUnit: 'meter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.0005, angularDeflection: 0.35 }
const SIMPLIFY_ABOVE = 2000000     // 超过 200 万三角形才抽稀
const SIMPLIFY_TARGET = 1000000    // 抽到 100 万
const SMALL_GROUP = 2000           // 小于这么多三角形的组不抽（螺钉、垫片抽了就没了，省下的面数也可忽略）

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8)

/* ======================= occt 结果 → 颜色分组 ======================= */

// 一个 occt 网格按 b-rep 面的颜色拆成若干组（一组 = glTF 的一个 primitive + 一个材质）。
// 面没自己的颜色就用网格色；网格也没有就给中性灰。brep_faces 的 first/last 是【三角形】下标（含尾）。
function colorGroups(m) {
  const idx = m.index
  const triCount = Math.floor(idx.length / 3)
  const meshColor = Array.isArray(m.color) && m.color.length >= 3 ? m.color.slice(0, 3).map(clamp01) : null
  const byKey = new Map()
  const covered = new Uint8Array(triCount)
  const add = (color, first, last) => {
    const key = color ? color.map((v) => v.toFixed(4)).join(',') : '-'
    let g = byKey.get(key)
    if (!g) { g = { color, ranges: [], tris: 0 }; byKey.set(key, g) }
    const a = Math.max(0, first | 0), b = Math.min(triCount - 1, last | 0)
    if (b < a) return
    g.ranges.push([a, b]); g.tris += b - a + 1
    covered.fill(1, a, b + 1)
  }
  const faces = Array.isArray(m.brep_faces) ? m.brep_faces : []
  for (const f of faces) {
    const fc = Array.isArray(f && f.color) && f.color.length >= 3 ? f.color.slice(0, 3).map(clamp01) : meshColor
    add(fc, f.first, f.last)
  }
  // 面表没盖住的三角形（空面表 / 面表残缺）归到网格色那一组，一个都不丢
  let run = -1
  for (let t = 0; t <= triCount; t++) {
    const hole = t < triCount && !covered[t]
    if (hole && run < 0) run = t
    if (!hole && run >= 0) { add(meshColor, run, t - 1); run = -1 }
  }
  const out = []
  for (const g of byKey.values()) {
    const index = new Uint32Array(g.tris * 3)
    let o = 0
    for (const [a, b] of g.ranges) { index.set(idx.subarray(a * 3, (b + 1) * 3), o); o += (b - a + 1) * 3 }
    out.push({ color: g.color, index })
  }
  return out
}

// 抽稀：总三角形数超过 SIMPLIFY_ABOVE 时，按比例把大组抽到总数约 SIMPLIFY_TARGET。
// ★ 按颜色组各抽各的（组间共享顶点表，抽完再按网格压缩顶点），否则材质分组会被抽乱。
// ★ 不加 LockBorder：occt 每个 b-rep 面自带一圈独立顶点（面与面之间不焊接），锁边界等于整张网格
//   动不了；代价是面缝处可能出现细缝，对 CAD 预览可以接受。
async function simplifyGroups(meshes, simplifier) {
  let total = 0, big = 0
  for (const m of meshes) for (const g of m.groups) { const t = g.index.length / 3; total += t; if (t >= SMALL_GROUP) big += t }
  if (total <= SIMPLIFY_ABOVE || !big) return { simplified: false, before: total, after: total }
  const small = total - big
  const ratio = Math.max(0.01, Math.min(1, (SIMPLIFY_TARGET - small) / big))
  let after = 0
  for (const m of meshes) {
    for (const g of m.groups) {
      const n = g.index.length
      if (n / 3 < SMALL_GROUP) { after += n / 3; continue }
      const target = Math.max(3, Math.floor((n * ratio) / 3) * 3)
      const [idx] = simplifier.simplify(g.index, m.position, 3, target, 0.02, [])
      g.index = idx
      after += idx.length / 3
    }
    compactMesh(m)
  }
  return { simplified: true, before: total, after }
}

// 抽稀后顶点表里有大量没人引用的点：按引用重排，位置 / 法向一起压缩
function compactMesh(m) {
  const n = m.position.length / 3
  const remap = new Int32Array(n).fill(-1)
  let k = 0
  for (const g of m.groups) for (let i = 0; i < g.index.length; i++) { const v = g.index[i]; if (remap[v] < 0) remap[v] = k++ }
  if (k === n) return
  const pos = new Float32Array(k * 3)
  const nrm = m.normal ? new Float32Array(k * 3) : null
  for (let v = 0; v < n; v++) {
    const r = remap[v]
    if (r < 0) continue
    pos[r * 3] = m.position[v * 3]; pos[r * 3 + 1] = m.position[v * 3 + 1]; pos[r * 3 + 2] = m.position[v * 3 + 2]
    if (nrm) { nrm[r * 3] = m.normal[v * 3]; nrm[r * 3 + 1] = m.normal[v * 3 + 1]; nrm[r * 3 + 2] = m.normal[v * 3 + 2] }
  }
  for (const g of m.groups) for (let i = 0; i < g.index.length; i++) g.index[i] = remap[g.index[i]]
  m.position = pos
  m.normal = nrm
}

/* ======================= occt 结果 → glTF 文档 → glb ======================= */

// result：occt-import-js 的返回（worker 里已把 position/normal/index 转成定型数组）
// opts：{ name（文件基名，根节点无名时用）, simplifier?（MeshoptSimplifier，已 ready）, onPhase?,
//         uniqueNodeNames?（缺省取 ir.mjs 的同名函数——与渲染端导入器同一套唯一化口径）, coreDir? }
// → { glb: Uint8Array, tris, trisBefore, simplified, nodes, meshes, nodeNameMap, bbox }
async function occtToGlb(result, opts = {}) {
  const { Document, NodeIO, Logger } = await gltfCore()
  const phase = typeof opts.onPhase === 'function' ? opts.onPhase : () => {}
  const src = Array.isArray(result && result.meshes) ? result.meshes : []
  const meshes = src.map((m) => {
    const position = m.position instanceof Float32Array ? m.position : new Float32Array(m.position || [])
    const normal = m.normal ? (m.normal instanceof Float32Array ? m.normal : new Float32Array(m.normal)) : null
    const index = m.index instanceof Uint32Array ? m.index : Uint32Array.from(m.index || [])
    const mm = { name: typeof m.name === 'string' ? m.name : '', color: m.color, brep_faces: m.brep_faces, position, normal: normal && normal.length === position.length ? normal : null, index }
    mm.groups = colorGroups(mm)
    return mm
  })

  let simp = { simplified: false, before: 0, after: 0 }
  for (const m of meshes) for (const g of m.groups) simp.before += g.index.length / 3
  simp.after = simp.before
  if (simp.before > SIMPLIFY_ABOVE && opts.simplifier) {
    phase('simplify')
    simp = await simplifyGroups(meshes, opts.simplifier)
  }

  phase('build')
  const doc = new Document().setLogger(new Logger(Logger.Verbosity.ERROR))
  doc.getRoot().getAsset().generator = 'satsim-models (occt-import-js)'
  const buffer = doc.createBuffer()
  const materials = new Map()
  const matFor = (color) => {
    const key = color ? color.map((v) => v.toFixed(4)).join(',') : '-'
    let mat = materials.get(key)
    if (!mat) {
      const c = color || [0.8, 0.8, 0.8]
      mat = doc.createMaterial(color ? `cad_${materials.size + 1}` : 'cad_default')
        // CAD 颜色是 sRGB 显示色，glTF 的 baseColorFactor 是线性值
        .setBaseColorFactor([srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]), 1])
        .setMetallicFactor(0).setRoughnessFactor(0.6)
        // occt 的面朝向跟着 b-rep 走，偶有反面；双面画保险，不影响任何计算
        .setDoubleSided(true)
      materials.set(key, mat)
    }
    return mat
  }
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  const gMeshes = meshes.map((m, i) => {
    const p = m.position
    for (let v = 0; v < p.length; v += 3) {
      for (let a = 0; a < 3; a++) { const x = p[v + a]; if (x < min[a]) min[a] = x; if (x > max[a]) max[a] = x }
    }
    const vcount = p.length / 3
    const mesh = doc.createMesh(m.name || `mesh_${i + 1}`)
    if (!vcount) return mesh
    const pos = doc.createAccessor().setType('VEC3').setArray(p).setBuffer(buffer)
    const nrm = m.normal ? doc.createAccessor().setType('VEC3').setArray(m.normal).setBuffer(buffer) : null
    for (const g of m.groups) {
      if (!g.index.length) continue
      const arr = vcount < 65536 ? Uint16Array.from(g.index) : g.index
      const idx = doc.createAccessor().setType('SCALAR').setArray(arr).setBuffer(buffer)
      const prim = doc.createPrimitive().setAttribute('POSITION', pos).setIndices(idx).setMaterial(matFor(g.color))
      if (nrm) prim.setAttribute('NORMAL', nrm)
      mesh.addPrimitive(prim)
    }
    return mesh
  })

  // 装配树 → 节点树。只有一个网格、没有子节点的装配节点直接挂网格（节点名 = 零件名，一一对应）；
  // 多网格节点给每个网格建一个子节点，名字取网格名（occt 里就是零件名：nut / bolt / rod …）。
  // 名字统一在这里唯一化（重名 _2、空名 node_N），原名映射进 nodeNameMap —— .gmdf 与部件表按
  // 节点名引用，名字不唯一就对不上（设计契约 §3.2 / 任务书 §9）。
  const flat = []   // { raw, parent, mesh }
  const rootName = (result && result.root && result.root.name) || opts.name || 'model'
  const walk = (n, parent, depth) => {
    if (!n || depth > 64) return
    const kids = Array.isArray(n.children) ? n.children : []
    const ms = (Array.isArray(n.meshes) ? n.meshes : []).filter((k) => Number.isInteger(k) && gMeshes[k])
    const self = flat.length
    const direct = ms.length === 1 && !kids.length
    flat.push({ raw: depth === 0 ? rootName : (n.name || ''), parent, mesh: direct ? ms[0] : -1 })
    if (!direct) for (const k of ms) flat.push({ raw: meshes[k].name || n.name || '', parent: self, mesh: k })
    for (const c of kids) walk(c, self, depth + 1)
  }
  walk(result && result.root ? result.root : { name: rootName, meshes: gMeshes.map((_, i) => i), children: [] }, -1, 0)
  const uniq = typeof opts.uniqueNodeNames === 'function' ? opts.uniqueNodeNames : (await importCore('ir', opts.coreDir)).uniqueNodeNames
  const { names, map } = uniq(flat.map((f) => f.raw))
  const scene = doc.createScene(names[0] || 'scene')
  doc.getRoot().setDefaultScene(scene)
  const gNodes = flat.map((f, i) => {
    const node = doc.createNode(names[i])
    if (f.mesh >= 0) node.setMesh(gMeshes[f.mesh])
    return node
  })
  flat.forEach((f, i) => { if (f.parent >= 0) gNodes[f.parent].addChild(gNodes[i]); else scene.addChild(gNodes[i]) })

  phase('write')
  const glb = await new NodeIO().setLogger(new Logger(Logger.Verbosity.ERROR)).writeBinary(doc)
  return {
    glb,
    tris: simp.after,
    trisBefore: simp.before,
    simplified: simp.simplified,
    nodes: flat.length,
    meshes: meshes.length,
    nodeNameMap: map,
    bbox: Number.isFinite(min[0]) ? { min, max } : null
  }
}

/* ======================= 主进程侧：起 worker 跑 CAD ======================= */

// file：CAD 文件路径；kind：'step'|'iges'|'brep'
// onPhase(phase)：'load' | 'read' | 'simplify' | 'build' | 'write'；返回 { promise, cancel }
function runCadWorker({ file, kind, name, onPhase }) {
  const { Worker } = require('worker_threads')
  let worker = null
  let done = false
  let cancelFn = () => {}
  const promise = new Promise((resolve, reject) => {
    // ★ worker 脚本按磁盘路径起（asar 内实测可起，见 deps 报告 §5），不用 eval 串：
    //   打包后堆栈里能看到文件名，日志可读
    // stdout/stderr 不直通父进程：occt 会往 stdout 打「Total number of loaded entities」一类的话，
    // 打包后没人看得见、开发时又刷屏。收最后几行，失败时拼进错误信息（写进 models.log）
    worker = new Worker(path.join(__dirname, 'occtWorker.js'), { stdout: true, stderr: true })
    const tail = []
    const keep = (c) => { for (const l of String(c).split(/\r?\n/)) if (l.trim()) { tail.push(l.trim()); if (tail.length > 12) tail.shift() } }
    worker.stdout.on('data', keep)
    worker.stderr.on('data', keep)
    const finish = (fn, v) => {
      if (done) return
      done = true
      try { worker.terminate() } catch {}
      if (v instanceof Error && !v.canceled && tail.length) v.message += `（${tail.slice(-3).join(' / ')}）`
      fn(v)
    }
    cancelFn = () => { const e = new Error('已取消'); e.canceled = true; finish(reject, e) }
    worker.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'phase') { try { onPhase && onPhase(msg.phase) } catch {} ; return }
      if (msg.type === 'done') return finish(resolve, { ...msg.out, glb: new Uint8Array(msg.out.glb) })
      if (msg.type === 'error') return finish(reject, new Error(msg.message || 'CAD 导入失败'))
    })
    worker.on('error', (e) => finish(reject, e))
    worker.on('exit', (code) => { if (!done) finish(reject, new Error(`CAD 进程退出（${code}）`)) })
    // 只传路径、由 worker 自己读：百 MB 级的装配体不必先在主线程读一遍再拷过去
    worker.postMessage({ kind, name, params: OCCT_PARAMS, file })
  })
  return { promise, cancel: () => cancelFn() }
}

/* ======================= .gltf → glb（NodeIO 打包 + AGI 回填） ======================= */

// src：{ path } 或 { bytes, name }（后者只能解析内嵌 data: URI 的资源）
// G：packages/core/models/glb.mjs（parseGlb / patchGlbJson）
// → { glb: Uint8Array, json（原 .gltf JSON）, agiMissing: [节点名…] }
async function gltfToGlb(src, { G, log } = {}) {
  const [{ NodeIO, Logger }, { ALL_EXTENSIONS }] = await Promise.all([gltfCore(), gltfExt()])
  const text = src.path ? fs.readFileSync(src.path, 'utf8') : Buffer.from(src.bytes).toString('utf8')
  const json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  const used = Array.isArray(json.extensionsUsed) ? json.extensionsUsed : []
  // 只报错误：「Missing optional extension AGI_*」这类警告我们已经自己兜住了（摘下 / 贴回），别刷进主进程控制台
  const io = new NodeIO().setLogger(new Logger(Logger.Verbosity.ERROR)).registerExtensions(ALL_EXTENSIONS)
  const deps = {}
  // 编解码器按需装：Draco 的 wasm 初始化要几百毫秒，绝大多数 .gltf 用不上
  if (used.indexOf('KHR_draco_mesh_compression') >= 0) {
    const draco3d = require('draco3dgltf')
    deps['draco3d.decoder'] = await draco3d.createDecoderModule()
    deps['draco3d.encoder'] = await draco3d.createEncoderModule()
  }
  if (used.indexOf('EXT_meshopt_compression') >= 0) {
    const { MeshoptDecoder, MeshoptEncoder } = await import('meshoptimizer')
    await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready])
    deps['meshopt.decoder'] = MeshoptDecoder
    deps['meshopt.encoder'] = MeshoptEncoder
  }
  if (Object.keys(deps).length) io.registerDependencies(deps)
  const doc = src.path ? await io.read(src.path) : await io.readJSON({ json, resources: {} })
  let glb = await io.writeBinary(doc)
  const raw = L.extractAgiRaw(json)
  let agiMissing = []
  if (raw) {
    const cur = G.parseGlb(glb).json
    const r = L.applyAgiRaw(cur, raw)
    agiMissing = r.missing
    glb = G.patchGlbJson(glb, r.json)
    if (agiMissing.length && log) log.warn(`[models] .gltf 打包后 AGI 扩展有 ${agiMissing.length} 个节点对不上：${agiMissing.slice(0, 8).join('、')}`)
  }
  return { glb: new Uint8Array(glb.buffer, glb.byteOffset, glb.byteLength), json, agiMissing }
}

module.exports = { CORE_MODELS_DIR, importCore, OCCT_PARAMS, SIMPLIFY_ABOVE, SIMPLIFY_TARGET, colorGroups, simplifyGroups, occtToGlb, runCadWorker, gltfToGlb, srgbToLinear }
