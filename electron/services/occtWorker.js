'use strict'
// worker_threads 里跑 occt-import-js（STEP / IGES / BREP → 三角网格 → glb）。
// 为什么单开线程：occt 的 wasm 有 7.6 MB、网格化是同步长调用（大装配几十秒）、内存峰值高；
// 放主进程等于把所有窗口的 IPC 一起冻住。一次导入一个 worker，干完即 terminate —— wasm 堆
// 只增不减，常驻的话导过一个大件后这几百 MB 就一直占着。
//
// 消息：主 → { kind, name, params, file（CAD 文件路径，worker 自己读） }；
//       回 → { type:'phase', phase } … { type:'done', out } | { type:'error', message }
const { parentPort } = require('worker_threads')
const fs = require('fs')
const { occtToGlb, importCore } = require('./modelsImport')

// ★ 包一层 { m }：Emscripten 的 Module 对象自带 .then，直接 resolve 它会被当成 thenable 无限递归、
//   卡死（deps 报告 §5 验证台踩过；DRACOLoader 自己也是 resolve({ draco })）。
// wasmBinary 自己读：包里的 locateFile 按 __dirname 拼路径，在 asar 里走得通但多一层不确定，
// 直接给字节最稳。
function loadOcct() {
  const factory = require('occt-import-js')
  const wasmBinary = fs.readFileSync(require.resolve('occt-import-js/dist/occt-import-js.wasm'))
  return factory({ wasmBinary }).then((m) => ({ m }))
}

parentPort.once('message', async (msg) => {
  const phase = (p) => parentPort.postMessage({ type: 'phase', phase: p })
  // ir.mjs（节点名唯一化）与 occt 初始化并行：worker 里首次 import ESM 要几百毫秒，别串在网格化后面
  const irP = importCore('ir').catch(() => null)
  try {
    phase('load')
    const { m } = await loadOcct()
    phase('read')
    const bytes = new Uint8Array(fs.readFileSync(msg.file))
    const fn = msg.kind === 'iges' ? m.ReadIgesFile : msg.kind === 'brep' ? m.ReadBrepFile : m.ReadStepFile
    const r = fn(bytes, msg.params || null)
    if (!r || !r.success) throw new Error('CAD 文件解析失败')
    // occt 吐的是普通 JS 数组（百万级三角形就是几千万个装箱数字）：立刻转定型数组、丢掉原数组
    const meshes = (r.meshes || []).map((x) => ({
      name: x.name,
      color: x.color,
      brep_faces: x.brep_faces,
      position: new Float32Array((x.attributes && x.attributes.position && x.attributes.position.array) || []),
      normal: x.attributes && x.attributes.normal && x.attributes.normal.array ? new Float32Array(x.attributes.normal.array) : null,
      index: Uint32Array.from((x.index && x.index.array) || [])
    }))
    const result = { root: r.root, meshes }
    let simplifier = null
    let tris = 0
    for (const x of meshes) tris += x.index.length / 3
    if (tris > 2000000) {
      // meshoptimizer 只有 ESM：CJS 里只能 await import（worker 内实测可用）
      const { MeshoptSimplifier } = await import('meshoptimizer')
      await MeshoptSimplifier.ready
      simplifier = MeshoptSimplifier
    }
    const ir = await irP
    if (!ir) throw new Error('缺少 packages/core/models/ir.mjs')
    const out = await occtToGlb(result, { name: msg.name, simplifier, onPhase: phase, uniqueNodeNames: ir.uniqueNodeNames })
    const glb = out.glb.buffer.slice(out.glb.byteOffset, out.glb.byteOffset + out.glb.byteLength)
    parentPort.postMessage({ type: 'done', out: { ...out, glb } }, [glb])
  } catch (e) {
    parentPort.postMessage({ type: 'error', message: (e && e.message) || String(e) })
  }
})
