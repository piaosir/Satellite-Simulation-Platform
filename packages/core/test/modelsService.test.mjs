// 卫星 3D 模型服务自测（electron/services/models.js，裸 node 跑，不联网）。运行：node packages/core/test/modelsService.test.mjs
//
// 用环境变量把服务的三个目录全指到临时目录（SATSIM_MODELS_DIR / SATSIM_MODELS_BUNDLE_DIR / SATSIM_MODELS_OFFLINE），
// 下载相关的用例起一个 127.0.0.1 回环 HTTP 服务器当「云端」（不出本机）。钉死：
// ① 内置 manifest 合并、内置档就绪状态与 ensure 取件（内置文件在远端重建后仍作 lod2 来源）；
// ② importGlb 夹具入库：sha 内容寻址、逐字节原样、同文件再导沿用已有 meta；.gltf 打包后 AGI 块按节点名回填；
// ③ saveMeta：本机件改原件、远端 / 内置写覆盖层；source / files 不许渲染端改（授权闸的依据）；
// ④ bindings 读写、清洗、损坏拒写；
// ⑤ scanStk 对 buildGlb 合成的临时目录（挂点 / 关节 / 太阳翼组计数、.gmdf 优先、类别、坏文件）；importStk 身份与路径白名单；
// ⑥ 导出闸：redistributable=false 拒绝，换 id / 带 AGI 署名 / extras 声明不可分发的字节也拒；
// ⑦ models:// 协议：白名单 400、缺件 404、缩略图内置兜底、> 4 MB 流式、ACAO 头；
// ⑧ 下载：刷新远端 manifest（ETag 304、坏条目丢弃）、并发下载 + sha256 校验 + 原子落盘、Range 续传、取消保留 .part、
//    404 不重试、sha 不符退避后 error、LRU 淘汰（60 s 保护期）；
// ⑨ importCad：STEP 立方体（1 m）入库，单位按文件头、节点名保留；CAD 同时只跑一个 worker，排队中可取消。
// 另：⑤b 授权闸（无署名 AGI 扩展 / STK 安装树路径 / 本机 STK 字节三类判据，普通导入、saveImported、导出兜底都拦；
//     已入库旧件补收紧）；③b 覆盖层只记差量（底版更新后没改过的字段跟新）；删除连 .bak 一起清、重导不被残留 .bak 骗；
//     参数化同 id 再存顶替旧文件；参数化件缩略图；STK 遍历封顶；下载优先级与让道（Range 续传不丢字节）。
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, statSync, readdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import http from 'node:http'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const REPO = join(import.meta.dirname, '../../..')
const FIX = join(import.meta.dirname, 'fixtures/models')
const G = await import(pathToFileURL(join(REPO, 'packages/core/models/glb.mjs')).href)
const S = await import(pathToFileURL(join(REPO, 'packages/core/models/schema.mjs')).href)
const M = await import(pathToFileURL(join(REPO, 'packages/core/models/manifest.mjs')).href)
const createModels = require('../../../electron/services/models.js')

let pass = 0
const ok = (cond, msg) => { assert.ok(cond, msg); pass++ }
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); pass++ }
const sha = (b) => createHash('sha256').update(b).digest('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred, ms = 8000, what = '条件') {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (await pred()) return true; await sleep(10) }
  throw new Error(`等待超时：${what}`)
}
const quietLog = () => { const lines = []; return { lines, info: (...a) => lines.push('I ' + a.join(' ')), warn: (...a) => lines.push('W ' + a.join(' ')), error: (...a) => lines.push('E ' + a.join(' ')) } }

// 合成 glb：每个节点挂同一个三角形；nodeExt 按节点名给扩展；copyright 用来模拟 STK 署名
function makeGltf({ names = ['Body'], nodeExt = {}, rootExt = null, copyright = null, extras = null } = {}) {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const json = {
    asset: { version: '2.0', ...(copyright ? { copyright } : {}) },
    scene: 0,
    scenes: [{ nodes: names.map((_, i) => i) }],
    nodes: names.map((n, i) => ({ name: n, mesh: 0, translation: [i, 0, 0], ...(nodeExt[n] ? { extensions: nodeExt[n] } : {}) })),
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    buffers: [{ byteLength: 36 }]
  }
  const used = new Set(Object.keys(rootExt || {}))
  for (const n of Object.keys(nodeExt)) for (const k of Object.keys(nodeExt[n])) used.add(k)
  if (rootExt) json.extensions = rootExt
  if (used.size) json.extensionsUsed = [...used]
  if (extras) json.extras = extras
  return { json, bin: new Uint8Array(pos.buffer) }
}
const glbOf = (o) => Buffer.from(G.buildGlb(o.json, o.bin))
const AGI_COPY = 'Copyright 2019 Analytical Graphics, Inc.'
const tinyWebp = (seed) => Buffer.concat([Buffer.from('RIFF'), Buffer.from([20, 0, 0, 0]), Buffer.from('WEBPVP8L'), Buffer.from([seed, 1, 2, 3, 4, 5, 6, 7])])
const fixture = (n) => readFileSync(join(FIX, n))

const root = mkdtempSync(join(tmpdir(), 'satsim-models-svc-'))
const envKeep = { d: process.env.SATSIM_MODELS_DIR, b: process.env.SATSIM_MODELS_BUNDLE_DIR, o: process.env.SATSIM_MODELS_OFFLINE }
let server = null
try {
  /* ───────────── 内置包：一条 NASA 条目，随包带 lod2 + 缩略图 ───────────── */
  const bundle = join(root, 'bundle')
  mkdirSync(join(bundle, 'builtin'), { recursive: true })
  mkdirSync(join(bundle, 'thumbs'), { recursive: true })
  const bL0 = fixture('goes.glb'), bL1 = fixture('tdrs-a.glb'), bL2 = fixture('satkit-radio-1.glb'), bThumb = tinyWebp(1)
  writeFileSync(join(bundle, 'builtin', sha(bL2) + '.glb'), bL2)
  writeFileSync(join(bundle, 'thumbs', sha(bThumb) + '.webp'), bThumb)
  const f = (b, tris) => ({ sha256: sha(b), bytes: b.length, tris })
  const builtinEntry = S.defaultMeta({
    id: 'nasa:builtin-sat', title: 'Builtin Sat', kind: 'spacecraft',
    source: { kind: 'nasa', url: 'https://science.nasa.gov/3d-resources/builtin-sat/', credit: 'NASA', redistributable: true },
    files: { lod0: f(bL0, 10), lod1: f(bL1, 5), lod2: f(bL2, 1), thumb: { sha256: sha(bThumb), bytes: bThumb.length } }
  })
  writeFileSync(join(bundle, 'manifest.json'), JSON.stringify({ schema: 2, buildId: 'b1', generatedAt: '2026-09-23T00:00:00Z', builtin: ['lod2', 'thumb'], models: [builtinEntry] }))

  process.env.SATSIM_MODELS_DIR = join(root, 'ud', 'models')
  process.env.SATSIM_MODELS_BUNDLE_DIR = bundle
  process.env.SATSIM_MODELS_OFFLINE = '1'
  // 「本机 STK 安装」：合成目录（绝不碰真 STK 文件）。里面放一个既无署名、也无 AGI 扩展的 glb，
  // 只能靠逐字节比对认出来（授权闸第三类判据）
  const stkDefault = join(root, 'stk-default')
  mkdirSync(join(stkDefault, 'Space'), { recursive: true })
  const bareInStk = glbOf(makeGltf({ names: ['PlainInDefaultStk'] }))
  writeFileSync(join(stkDefault, 'Space', 'bare.glb'), bareInStk)
  const saveTo = { path: null }
  const dialog = { showSaveDialog: async () => (saveTo.path ? { canceled: false, filePath: saveTo.path } : { canceled: true }) }
  const logA = quietLog()
  const A = createModels({ appRoot: REPO, log: logA, electron: { dialog }, stkDefaultDir: stkDefault })
  const evA = []
  A.onChange((e) => evA.push(e))

  /* ① 内置合并与取件 */
  {
    const man = await A.manifest()
    eq(man.models.map((m) => m.id), ['nasa:builtin-sat'], '内置条目进清单')
    const e = man.models[0]
    eq([e.origin, e.local.lod2, e.local.thumb, e.local.builtin, e.local.lod0], ['builtin', 'ready', 'ready', ['lod2', 'thumb'], undefined], '内置 lod2 / 缩略图就绪，lod0 没有')
    eq(man.prefs, { geoDefault: 'param:default-sat', showModels: true }, '绑定表缺省 prefs（GEO 默认 = 默认卫星）')
    eq(man.cache, { bytes: 0, cap: 2 * 1024 ** 3 }, '缓存读数：空、上限 2 GiB')
    eq(await A.ensure({ id: 'nasa:builtin-sat', lod: 'lod2' }), { state: 'ready', url: `models://builtin/${sha(bL2)}.glb`, lod: 'lod2' }, 'ensure lod2 → 内置件')
    eq(await A.ensure({ id: 'nasa:builtin-sat', lod: 'lod0' }), { state: 'ready', url: `models://builtin/${sha(bL2)}.glb`, lod: 'lod2' }, '离线要 lod0：降到已就绪的 lod2')
    eq(await A.ensure({ id: 'param:default-sat', lod: 'lod2' }), { state: 'param' }, 'param: 直出')
    eq(await A.thumbnail('nasa:builtin-sat'), { state: 'ready', url: `models://thumbs/${sha(bThumb)}.webp`, lod: 'thumb' }, '内置缩略图 → thumbs 主机')
    eq(await A.ensure({ id: 'nasa:nope' }), { state: 'missing' }, '没有的条目 → missing')
    eq(A.cacheInfo(), { bytes: 0, cap: 2 * 1024 ** 3, count: 0 }, 'cacheInfo')
  }

  /* ② importGlb */
  const tdrs = fixture('tdrs-a.glb')
  let userId
  {
    const r = await A.importGlb({ path: join(FIX, 'tdrs-a.glb') })
    ok(r.ok, 'importGlb 成功')
    userId = r.id
    eq(r.id, 'user:' + sha(tdrs).slice(0, 12), 'id = user:<sha 前 12 位>')
    const stored = join(process.env.SATSIM_MODELS_DIR, 'user', sha(tdrs) + '.glb')
    ok(existsSync(stored) && readFileSync(stored).equals(tdrs), '按 sha 落盘、逐字节原样')
    ok(existsSync(stored.replace(/\.glb$/, '.satsim.json')), '同名 .satsim.json')
    eq([r.meta.source.kind, r.meta.files.lod0.sha256, r.meta.files.lod0.bytes, r.meta.fidelity], ['user', sha(tdrs), tdrs.length, 'outreach'], 'meta：来源 / 文件 / 保真度')
    ok(r.meta.geometry.tris > 0 && r.meta.geometry.boundingRadiusM > 0, '三角形数与包围球从 JSON 块读出')
    ok(S.validateMeta(r.meta).ok, '入库 meta 过 validateMeta')
    const again = await A.importGlb({ path: join(FIX, 'tdrs-a.glb') })
    eq([again.id, again.existed], [userId, true], '同一份字节再导：同 id、沿用已有 meta')
    const b = await A.importGlb({ bytes: new Uint8Array(fixture('cubesat-1ru.glb')), name: 'cubesat.glb' })
    eq([b.ok, b.id, b.meta.title], [true, 'user:' + sha(fixture('cubesat-1ru.glb')).slice(0, 12), 'cubesat'], '{bytes, name} 形式')
    eq((await A.importGlb({ bytes: new Uint8Array([1, 2, 3]), name: 'x.glb' })).ok, false, '不是 glb → ok:false')
    eq((await A.importGlb({ path: join(FIX, 'README.md') })).ok, false, '扩展名不对 → ok:false')
    const stk = await A.importGlb({ bytes: glbOf(makeGltf({ copyright: AGI_COPY })), name: 'x.glb' })
    eq([stk.id.slice(0, 4), stk.meta.source.kind, stk.meta.source.redistributable, stk.meta.source.license], ['stk:', 'stk-local', false, 'AGI SLA'], '带 AGI 署名的 glb 经普通导入也落成 STK 本机件')
    const e = await A.ensure({ id: userId, lod: 'lod2' })
    eq(e, { state: 'ready', url: `models://user/${sha(tdrs)}.glb`, lod: 'lod0' }, '本机件只有 lod0：ensure 降档取 lod0')
    const man = await A.manifest()
    ok(man.models.some((m) => m.id === userId && m.origin === 'user' && m.local.lod0 === 'ready'), '本机件进清单')

    // .gltf：NodeIO 打包成 glb，AGI 按节点名贴回（gltf-transform 会丢未知扩展）
    const g = makeGltf({
      names: ['Body', 'AP1', 'Wing'],
      nodeExt: { AP1: { AGI_articulations: { isAttachPoint: true } }, Wing: { AGI_articulations: { articulationName: 'SA' }, AGI_stk_metadata: { solarPanelGroupName: 'G' } } },
      rootExt: { AGI_articulations: { articulations: [{ name: 'SA', stages: [{ name: 'Yaw', type: 'zRotate', minimumValue: -90, maximumValue: 90, initialValue: 0 }] }] }, AGI_stk_metadata: { solarPanelGroups: [{ name: 'G', efficiency: 28 }] } }
    })
    g.json.buffers[0].uri = 'data:application/octet-stream;base64,' + Buffer.from(g.bin).toString('base64')
    const gltfFile = join(root, 'sat.gltf')
    writeFileSync(gltfFile, JSON.stringify(g.json))
    const gr = await A.importGlb({ path: gltfFile })
    ok(gr.ok && gr.packed, '.gltf 打包入库')
    const gj = G.parseGlb(readFileSync(join(process.env.SATSIM_MODELS_DIR, 'user', gr.meta.files.lod0.sha256 + '.glb'))).json
    const byName = Object.fromEntries(gj.nodes.map((n) => [n.name, n]))
    eq(byName.AP1.extensions, { AGI_articulations: { isAttachPoint: true } }, '挂点节点扩展贴回')
    eq(byName.Wing.extensions.AGI_stk_metadata, { solarPanelGroupName: 'G' }, '太阳翼组归属贴回')
    eq(gj.extensions.AGI_articulations.articulations[0].name, 'SA', '根级关节定义贴回')
    ok(gj.extensionsUsed.includes('AGI_articulations') && gj.extensionsUsed.includes('AGI_stk_metadata'), 'extensionsUsed 补登记')
    eq([gr.meta.attachPoints.length, gr.meta.articulations[0].nodes, gr.meta.solarPanelGroups[0].nodes], [1, ['Wing'], ['Wing']], 'meta 里的 AGI 与贴回的一致')
    eq([gr.id.slice(0, 4), gr.meta.source.kind], ['stk:', 'stk-local'], '.gltf 带 AGI 扩展、没有 extras.satsim → 同样按 STK 件')
  }

  /* ③ saveMeta / getMeta / 覆盖层 */
  {
    const r = await A.saveMeta({ id: userId, meta: { title: '跟踪与数据中继卫星', source: { kind: 'nasa', redistributable: true }, files: {} } })
    eq(r, { ok: true }, 'saveMeta 本机件')
    const m = await A.getMeta(userId)
    eq([m.title, m.source.kind, m.files.lod0.sha256], ['跟踪与数据中继卫星', 'user', sha(tdrs)], '改了标题；source / files 不许渲染端改')
    const stkIds = (await A.manifest()).models.filter((x) => x.id.startsWith('stk:')).map((x) => x.id)
    await A.saveMeta({ id: stkIds[0], meta: { source: { kind: 'user', redistributable: true, license: '' } } })
    const sm = await A.getMeta(stkIds[0])
    eq([sm.source.kind, sm.source.redistributable, S.isRedistributable(sm)], ['stk-local', false, false], 'STK 件改不成可再分发')
    const b = await A.saveMeta({ id: 'nasa:builtin-sat', meta: { titleZh: '内置卫星', tags: ['geo'] } })
    eq(b, { ok: true }, 'saveMeta 内置件 → 覆盖层')
    ok(readdirSync(join(process.env.SATSIM_MODELS_DIR, 'overrides')).some((n) => n.startsWith('nasa%3Abuiltin-sat')), '覆盖层文件名转义（冒号）')
    const bm = await A.getMeta('nasa:builtin-sat')
    eq([bm.titleZh, bm.tags, bm.files.lod2.sha256], ['内置卫星', ['geo'], sha(bL2)], 'getMeta 合并覆盖层，文件不变')
    eq((await A.manifest()).models.find((x) => x.id === 'nasa:builtin-sat').titleZh, '内置卫星', '清单里也是覆盖后的')
    eq((await A.saveMeta({ id: 'nasa:nope', meta: { title: 'x' } })).ok, false, '不存在的模型 → ok:false')
    eq((await A.saveMeta({ id: userId })).ok, false, '缺 meta → ok:false')
    ok(evA.some((e) => e.type === 'meta' && e.id === userId), '广播 meta 事件')
  }

  /* ④ 绑定表 */
  {
    const bf = join(root, 'ud', 'models.bindings.json')
    eq(await A.bindingsGet(), { schema: 1, prefs: { geoDefault: 'param:default-sat', showModels: true }, bindings: {} }, '缺省空表（GEO 默认 = 默认卫星）')
    eq(await A.bindingsSet({ satKey: 'norad:25544', binding: { model: { id: 'nasa:builtin-sat', iconPx: 40 } } }), { ok: true }, '写一条绑定')
    const b = await A.bindingsGet()
    eq(b.bindings['norad:25544'].model, { id: 'nasa:builtin-sat', iconPx: 40 }, '读回')
    eq(b.bindings['norad:25544'].attitude, { law: 'nadir', params: {} }, '清洗补默认姿态律')
    ok(existsSync(bf), '落在 userData/models.bindings.json（与 models/ 同级）')
    eq(await A.bindingsSet({ prefs: { showModels: false } }), { ok: true }, '写 prefs')
    eq((await A.bindingsGet()).prefs.showModels, false, 'prefs 读回')
    eq((await A.bindingsSet({ satKey: 'bogus', binding: { model: { id: 'auto' } } })).code, 'bad-key', '非法卫星键拒绝')
    eq((await A.bindingsSet({ satKey: 'norad:1', binding: { model: { id: '../../etc' } } })).code, 'invalid', '非法模型 id 拒绝（不悄悄改成 auto）')
    eq((await A.bindingsSet({ satKey: 'norad:1', binding: 5 })).code, 'bad-binding', '绑定不是对象拒绝')
    eq(await A.bindingsSet({ satKey: 'norad:25544', binding: null }), { ok: true }, 'binding:null 删除')
    ok(!(await A.bindingsGet()).bindings['norad:25544'], '删掉了')
    ok(evA.some((e) => e.type === 'bindings'), '广播 bindings 事件')
    writeFileSync(bf, '{ broken')
    writeFileSync(bf + '.bak', 'also broken')
    eq((await A.bindingsSet({ prefs: { showModels: true } })).code, 'corrupt', '主文件与 .bak 都坏 → 拒写')
    eq(readFileSync(bf, 'utf8'), '{ broken', '坏文件原样没被覆盖')
    const c = await A.bindingsGet()
    eq([c.corrupt, c.bindings], [true, {}], '读到损坏：空表 + corrupt 标记')
    rmSync(bf); rmSync(bf + '.bak')
  }

  /* ⑤ STK 扫描与导入（合成目录，绝不用真 STK 文件） */
  const stkDir = join(root, 'stk')
  {
    mkdirSync(join(stkDir, 'Space'), { recursive: true })
    mkdirSync(join(stkDir, 'Air'), { recursive: true })
    const art = { articulations: [{ name: 'SA', stages: [{ name: 'Yaw', type: 'zRotate', minimumValue: -180, maximumValue: 180, initialValue: 0 }] }] }
    const sat = makeGltf({
      names: ['Body', 'AP_A', 'AP_B', 'WingL', 'WingR'], copyright: AGI_COPY,
      nodeExt: {
        AP_A: { AGI_articulations: { isAttachPoint: true } }, AP_B: { AGI_articulations: { isAttachPoint: true } },
        WingL: { AGI_articulations: { articulationName: 'SA' }, AGI_stk_metadata: { solarPanelGroupName: 'G' } },
        WingR: { AGI_articulations: { articulationName: 'SA' }, AGI_stk_metadata: { solarPanelGroupName: 'G' } }
      },
      rootExt: { AGI_articulations: art, AGI_stk_metadata: { solarPanelGroups: [{ name: 'G', efficiency: 30 }] } }
    })
    writeFileSync(join(stkDir, 'Space', 'sat.glb'), glbOf(sat))
    const sat2 = makeGltf({ names: ['Body', 'WingL', 'WingR'], copyright: AGI_COPY, nodeExt: { Body: { AGI_articulations: { isAttachPoint: true } } } })
    writeFileSync(join(stkDir, 'Space', 'sat2.glb'), glbOf(sat2))
    writeFileSync(join(stkDir, 'Space', 'sat2.gmdf'), JSON.stringify({ AGI_articulations: { attachPoints: ['Body', 'WingL', 'WingR'], articulations: [{ name: 'X', modelNodes: ['Body'], stages: [{ name: 'Roll', type: 'xRotate', minimumValue: 0, maximumValue: 1, initialValue: 0 }] }] } }))
    writeFileSync(join(stkDir, 'Air', 'plane.glb'), glbOf(makeGltf({ names: ['Fuselage', 'Tail'] })))
    writeFileSync(join(stkDir, 'top.glb'), glbOf(makeGltf({ names: ['A'] })))
    writeFileSync(join(stkDir, 'Space', 'junk.glb'), 'not a glb at all')
    writeFileSync(join(stkDir, 'Space', 'readme.txt'), 'x')

    eq(await A.scanStk({ dir: join(root, 'no-such-dir') }), { dir: join(root, 'no-such-dir'), exists: false, items: [] }, '目录不存在 → exists:false')
    const sc = await A.scanStk({ dir: stkDir })
    eq(sc.exists, true, '扫描成功')
    const by = Object.fromEntries(sc.items.map((i) => [i.rel, i]))
    eq(Object.keys(by).sort(), ['Air/plane.glb', 'Space/junk.glb', 'Space/sat.glb', 'Space/sat2.glb', 'top.glb'], '递归列出 .glb（不看别的扩展名）')
    const pick = (i) => [i.category, i.nodes, i.attachPoints, i.articulations, i.solarPanelGroups, i.hasGmdf]
    eq(pick(by['Space/sat.glb']), ['Space', 5, 2, 1, 1, false], '内嵌 AGI 计数：节点 5 / 挂点 2 / 关节 1 / 太阳翼组 1')
    eq(pick(by['Space/sat2.glb']), ['Space', 3, 3, 1, 0, true], '.gmdf 在：以旁车为准（STK 口径）')
    eq(pick(by['Air/plane.glb']), ['Air', 2, 0, 0, 0, false], '无 AGI → 全 0，类别 = 子目录名')
    eq(by['top.glb'].category, '', '根目录文件无类别')
    ok(typeof by['Space/junk.glb'].error === 'string', '坏文件带 error，不中断扫描')
    eq(by['Space/sat.glb'].bytes, statSync(join(stkDir, 'Space', 'sat.glb')).size, '大小')

    const im = await A.importStk({ dir: stkDir, files: ['Space/sat.glb', 'Space/sat2.glb', '../evil.glb', 'Space/missing.glb', 'C:/x.glb'] })
    eq(im.imported.map((x) => x.file), ['Space/sat.glb', 'Space/sat2.glb'], '导入两件')
    eq(im.errors.length, 3, '非法路径 / 不存在的逐条报错')
    const m1 = await A.getMeta(im.imported[0].id)
    eq([m1.id.slice(0, 4), m1.source.kind, m1.source.license, m1.source.redistributable, m1.kind], ['stk:', 'stk-local', 'AGI SLA', false, 'spacecraft'], 'STK 身份：stk-local / AGI SLA / 不可再分发')
    eq([m1.attachPoints.length, m1.articulations[0].nodes, m1.solarPanelGroups[0].nodes], [2, ['WingL', 'WingR'], ['WingL', 'WingR']], 'AGI 进 meta（多节点联动）')
    ok(Array.isArray(m1.attachPoints[0].posBody), '挂点补了本体系位姿')
    eq((await A.getMeta(im.imported[1].id)).attachPoints.length, 3, '导入也以 .gmdf 为准')
    eq((await A.scanStk({ dir: stkDir })).items.length, 5, '重扫不受导入影响（只读）')
    ok(A._state().stkDirs.includes(stkDir), '真导入过东西的 STK 目录记进 state.json（字节判据跨重启用）')
    ok(!A._state().stkDirs.includes(join(root, 'no-such-dir')), '只扫描没导入的目录不记')
  }

  /* ⑤b 授权闸：STK 件绕开「从 STK 导入」走普通导入 / saveImported / 导出，一律拦住 */
  const DIR = () => process.env.SATSIM_MODELS_DIR
  {
    // ① 无署名、只登记了 AGI 扩展（本机 STK 12 的 cubesat_1.5u/2u/3u… 10 个 glb 都是这样）
    const noCopy = glbOf(makeGltf({ names: ['Bus', 'AP'], nodeExt: { AP: { AGI_articulations: { isAttachPoint: true } } } }))
    const r1 = await A.importGlb({ bytes: noCopy, name: 'cubesat_3u.glb' })
    eq([r1.ok, r1.id.slice(0, 4), r1.meta.source.kind, r1.meta.source.redistributable, r1.meta.source.license], [true, 'stk:', 'stk-local', false, 'AGI SLA'], '无署名 + AGI 扩展 → 普通导入也落成 STK 本机件')
    eq(await A.exportModel({ id: r1.id, glb: noCopy }), { ok: false, code: 'not-redistributable' }, '导出 → 拒绝')
    eq(await A.exportModel({ id: userId, glb: noCopy }), { ok: false, code: 'not-redistributable' }, '换成用户件的 id 夹带这份字节 → 也拒绝')
    const noCopy2 = glbOf(makeGltf({ names: ['Bus2'], rootExt: { AGI_articulations: { articulations: [] } } }))
    eq(await A.exportModel({ id: userId, glb: noCopy2 }), { ok: false, code: 'not-redistributable' }, '没入过库的无署名 AGI 字节 → 导出兜底也拒')
    eq(await A.saveImported({ glb: noCopy2, meta: { title: 'x' } }), { ok: false, code: 'stk', error: 'STK 模型不可由此导入。' }, 'saveImported 拒收（错误只留状态本身）')
    // ② 本工具导出的件：AGI 扩展 + extras.satsim → 普通用户件、可导出
    const ours = glbOf(makeGltf({ names: ['Bus', 'AP'], nodeExt: { AP: { AGI_articulations: { isAttachPoint: true } } }, extras: { satsim: { schema: 2, source: { kind: 'user', redistributable: true } } } }))
    const r2 = await A.importGlb({ bytes: ours, name: 'mine.glb' })
    eq([r2.id.slice(0, 5), r2.meta.source.kind, r2.meta.attachPoints.length], ['user:', 'user', 1], '带 extras.satsim 的自家导出件 → 用户件（挂点照读）')
    // ③ 路径判据：STK 安装树里的无标记 glb
    const tree = join(root, 'Program Files', 'AGI', 'STK 12', 'STKData', 'VO', 'Models', 'Space')
    mkdirSync(tree, { recursive: true })
    writeFileSync(join(tree, 'bare.glb'), glbOf(makeGltf({ names: ['PlainInTree'] })))
    const r3 = await A.importGlb({ path: join(tree, 'bare.glb') })
    eq([r3.id.slice(0, 4), r3.meta.source.kind], ['stk:', 'stk-local'], '路径在 STK 安装树里 → STK 件（与内容无关）')
    // ④ 字节判据：默认 STK 目录里某个文件的原样字节（拖放进来，没有路径）
    const r4 = await A.importGlb({ bytes: bareInStk, name: 'dragged.glb' })
    eq([r4.id.slice(0, 4), r4.meta.source.kind], ['stk:', 'stk-local'], '字节等于本机 STK 目录里的某个文件 → STK 件')
    // ⑤ 字节判据也覆盖「从 STK 导入」过的非默认目录（Air/plane.glb 既无署名也无 AGI 扩展）
    const r5 = await A.importGlb({ bytes: readFileSync(join(stkDir, 'Air', 'plane.glb')), name: 'plane.glb' })
    eq(r5.meta.source.kind, 'stk-local', '字节等于导入过的 STK 目录里的文件 → STK 件')
    const r6 = await A.importGlb({ bytes: glbOf(makeGltf({ names: ['JustMine'] })), name: 'p.glb' })
    eq([r6.id.slice(0, 5), r6.meta.source.kind, r6.meta.source.redistributable], ['user:', 'user', true], '三类判据都不中 → 普通用户件')
    // readFile：给渲染端解析 OBJ/STL/FBX 的通道，不许把 STK 的东西读出去（渲染端重导出一遍再 saveImported 就洗白了）
    const refused = { ok: false, code: 'stk', error: 'STK 模型不可由此导入。' }
    writeFileSync(join(tree, 'part.obj'), 'v 0 0 0\n')
    eq(await A.readFile(join(tree, 'part.obj')), refused, 'readFile：STK 安装树里的文件一律不给读')
    const outside = join(root, 'elsewhere'); mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'agi.glb'), noCopy)
    eq(await A.readFile(join(outside, 'agi.glb')), refused, 'readFile：别处的无署名 AGI glb 也不给读')
    writeFileSync(join(outside, 'copy.glb'), bareInStk)
    eq(await A.readFile(join(outside, 'copy.glb')), refused, 'readFile：本机 STK 文件的拷贝（字节相同）也不给读')
    writeFileSync(join(outside, 'part.obj'), 'v 0 0 0\n')
    const rf = await A.readFile(join(outside, 'part.obj'))
    eq([rf.name, Buffer.from(rf.bytes).toString(), rf.dir], ['part.obj', 'v 0 0 0\n', outside], 'readFile：普通 OBJ 照读')
    eq((await A.readFile(join(outside, 'x.exe'))).error, '不支持的文件类型', 'readFile：扩展名白名单')
    // ⑥ 补收紧：按旧判据入库成 user 的 STK 件（手写一份模拟），重建目录时收紧成不可再分发，id 不变（绑定表还引用着）
    const leaked = glbOf(makeGltf({ names: ['Leaked', 'AP'], nodeExt: { AP: { AGI_articulations: { isAttachPoint: true } } } }))
    const ls = sha(leaked)
    writeFileSync(join(DIR(), 'user', ls + '.glb'), leaked)
    writeFileSync(join(DIR(), 'user', ls + '.satsim.json'), JSON.stringify(S.defaultMeta({ id: 'user:' + ls.slice(0, 12), title: 'leaked', source: { kind: 'user', redistributable: true }, files: { lod0: { sha256: ls, bytes: leaked.length, tris: 2 } } })))
    const C = createModels({ appRoot: REPO, log: quietLog(), stkDefaultDir: stkDefault })
    const lm = await C.getMeta('user:' + ls.slice(0, 12))
    eq([lm.id, lm.source.kind, lm.source.redistributable, S.isRedistributable(lm)], ['user:' + ls.slice(0, 12), 'stk-local', false, false], '旧件补收紧：id 不变、改为不可再分发')
    eq(JSON.parse(readFileSync(join(DIR(), 'user', ls + '.satsim.json'), 'utf8')).source.kind, 'stk-local', '收紧写回了 meta 文件')
    eq((await C.exportModel({ id: lm.id, glb: tdrs })).code, 'not-redistributable', '收紧后导出闸按 meta 拒')
    C.stop()
  }

  /* ⑥ 导出闸 */
  {
    const stkId = (await A.manifest()).models.find((x) => x.id.startsWith('stk:')).id
    eq(await A.exportModel({ id: stkId, glb: glbOf(makeGltf({})) }), { ok: false, code: 'not-redistributable' }, 'STK 件导出 → 拒绝')
    // 用户件自己的 id，但送来的是 STK 字节 / 带不可分发声明的字节：兜底拒
    eq(await A.exportModel({ id: userId, glb: readFileSync(join(stkDir, 'Space', 'sat.glb')) }), { ok: false, code: 'not-redistributable' }, '换 id 夹带 AGI 署名字节 → 拒绝')
    eq(await A.exportModel({ id: userId, glb: glbOf(makeGltf({ extras: { satsim: { source: { kind: 'stk-local', redistributable: false } } } })) }), { ok: false, code: 'not-redistributable' }, 'extras.satsim 声明不可分发 → 拒绝')
    eq((await A.exportModel({ id: userId, glb: new Uint8Array(8) })).code, 'bad-glb', '不是 glb → bad-glb')
    eq((await A.exportModel({ id: 'nasa:nope', glb: tdrs })).code, 'missing', '不存在的模型 → missing')
    saveTo.path = null
    eq((await A.exportModel({ id: userId, glb: tdrs })).code, 'canceled', '另存框取消')
    saveTo.path = join(root, 'out', 'TDRS 导出.glb')
    mkdirSync(dirname(saveTo.path), { recursive: true })
    const r = await A.exportModel({ id: userId, glb: tdrs, gmdf: { AGI_articulations: { attachPoints: ['a'] } }, satsimJson: { schema: 2 }, suggestedName: 'x' })
    eq(r, { ok: true, path: saveTo.path }, '可再分发的本机件导出成功')
    ok(readFileSync(saveTo.path).equals(tdrs), 'glb 落盘')
    eq(JSON.parse(readFileSync(saveTo.path.replace(/\.glb$/, '.gmdf'), 'utf8')), { AGI_articulations: { attachPoints: ['a'] } }, '同名 .gmdf')
    ok(existsSync(saveTo.path.replace(/\.glb$/, '.satsim.json')), '同名 .satsim.json')
  }

  /* saveImported / saveThumb / remove */
  {
    const conv = glbOf(makeGltf({ names: ['obj_root'] }))
    const r = await A.saveImported({ glb: conv, meta: { title: 'OBJ 转换件', source: { kind: 'nasa' }, fidelity: 'outreach' } })
    eq([r.ok, r.id, r.meta.source.kind, r.meta.title], [true, 'user:' + sha(conv).slice(0, 12), 'user', 'OBJ 转换件'], '渲染端转好的 glb 入库；来源只能是 user')
    eq((await A.saveImported({ glb: glbOf(makeGltf({ copyright: AGI_COPY, names: ['q'] })), meta: {} })).code, 'stk', '带 AGI 署名的不许从这条路进')
    const pg = glbOf(makeGltf({ names: ['bus', 'wing'] }))
    const p = await A.saveImported({ glb: pg, meta: { id: 'param:0123456789ab', title: '默认卫星 改', source: { kind: 'param' }, spec: { template: 'default-sat' } } })
    eq([p.ok, p.id, (await A.getMeta(p.id)).source.kind], [true, 'param:0123456789ab', 'param'], '参数化另存：id 用 specHash')
    eq(await A.ensure({ id: p.id }), { state: 'param' }, '参数化另存件 ensure → param（渲染端按 spec 生成）')
    // 参数化另存件的缩略图：thumbnail 的判断在 param 短路之前
    const pt = await A.saveThumb({ id: p.id, webp: tinyWebp(11) })
    eq(await A.thumbnail(p.id), { state: 'ready', url: `models://thumbs/${pt.sha256}.webp`, lod: 'thumb' }, '参数化另存件经 thumbnail 取到缩略图')
    eq(await A.thumbnail('param:default-sat'), { state: 'missing' }, '模板本身没有条目 → missing（渲染端现场出图）')
    eq((await A.manifest()).models.find((m) => m.id === p.id).local.thumb, 'ready', '清单里也标 ready')

    // 同一 spec 再存一次（glb 字节不同）：新的顶替旧的，user/ 下只留一份同 id 的 meta
    const pg2 = glbOf(makeGltf({ names: ['bus', 'wing'], extras: { satsim: { updatedAt: '2026-09-23T01:00:00Z' } } }))
    const p2 = await A.saveImported({ glb: pg2, meta: { id: 'param:0123456789ab', title: '默认卫星 改', source: { kind: 'param' }, spec: { template: 'default-sat', v: 2 } } })
    eq([p2.ok, p2.id], [true, 'param:0123456789ab'], '再存：同一个 id')
    const userDir = join(DIR(), 'user')
    const metasOf = (id) => readdirSync(userDir).filter((n) => /^[0-9a-f]{64}\.satsim\.json$/.test(n) && JSON.parse(readFileSync(join(userDir, n), 'utf8')).id === id)
    eq(metasOf(p.id).length, 1, '同 id 只留一份 meta')
    ok(!existsSync(join(userDir, sha(pg) + '.glb')) && !existsSync(join(userDir, sha(pg) + '.satsim.json.bak')), '旧 glb / meta / .bak 删干净')
    const pm = await A.getMeta(p.id)
    eq([pm.spec.v, pm.files.lod0.sha256, pm.files.thumb.sha256], [2, sha(pg2), pt.sha256], 'meta 是新的；旧条目重拍的缩略图沿用')
    // 别的版本留下的同 id 旧文件（手写一份更旧的）：清单取新的；remove 连旧的一起删
    const ghost = glbOf(makeGltf({ names: ['ghost'] }))
    writeFileSync(join(userDir, sha(ghost) + '.glb'), ghost)
    writeFileSync(join(userDir, sha(ghost) + '.satsim.json'), JSON.stringify({ ...pm, spec: { template: 'default-sat', v: 1 }, files: { lod0: { sha256: sha(ghost), bytes: ghost.length, tris: 1 } }, updatedAt: '2020-01-01T00:00:00.000Z' }))
    await A.saveMeta({ id: userId, meta: { tags: ['rebuild'] } })   // 触发重建目录
    eq((await A.getMeta(p.id)).spec.v, 2, '同 id 两份：取 updatedAt 新的那份')
    const pr = await A.remove(p.id)
    eq([pr.ok, metasOf(p.id).length], [true, 0], 'remove 连同被顶替的旧文件一起删')
    ok(!(await A.manifest()).models.some((m) => m.id === p.id), '删了就真从清单里没了')

    // 导入 → 写缩略图（writeJsonAtomic 留下 .bak）→ 删除 → 重导：必须重新出现在清单里
    const goes = fixture('goes.glb')
    const gm = join(userDir, sha(goes) + '.satsim.json')
    const g1 = await A.importGlb({ bytes: goes, name: 'goes.glb' })
    await A.saveThumb({ id: g1.id, webp: tinyWebp(33) })
    ok(existsSync(gm + '.bak'), '复现条件：写缩略图留下了 .bak')
    eq((await A.remove(g1.id)).removed, 3, 'remove：glb + meta + 没人再引用的缩略图')
    ok(!existsSync(gm + '.bak'), 'remove 连 .bak 一起删')
    const g2 = await A.importGlb({ bytes: goes, name: 'goes.glb' })
    eq([g2.ok, g2.id, g2.existed], [true, g1.id, false], '重导是新导入（不是 existed）')
    ok((await A.manifest()).models.some((m) => m.id === g2.id) && (await A.getMeta(g2.id)) !== null, '重导后在清单里、getMeta 取得到')
    // 残局：只剩 .bak、主文件没了（别的版本删出来的）→ 也按新导入，主文件写回
    await A.saveThumb({ id: g2.id, webp: tinyWebp(34) })
    rmSync(gm)
    ok(existsSync(gm + '.bak'), '残局：只剩 .bak')
    const g3 = await A.importGlb({ bytes: goes, name: 'goes.glb' })
    eq([g3.existed, existsSync(gm), existsSync(gm + '.bak')], [false, true, false], '只剩 .bak：按新导入写主文件、残留 .bak 清掉')
    ok((await A.manifest()).models.some((m) => m.id === g3.id), '残局重导后在清单里')

    const wp = tinyWebp(9)
    const t = await A.saveThumb({ id: userId, webp: wp })
    eq(t, { ok: true, sha256: sha(wp) }, 'saveThumb')
    eq((await A.getMeta(userId)).files.thumb, { sha256: sha(wp), bytes: wp.length }, 'meta.files.thumb 写上')
    eq((await A.saveThumb({ id: userId, webp: new Uint8Array(20) })).ok, false, '不是 WebP 拒绝')
    const t2 = await A.saveThumb({ id: 'nasa:builtin-sat', webp: tinyWebp(10) })
    eq((await A.getMeta('nasa:builtin-sat')).files.thumb.sha256, t2.sha256, '内置件的缩略图走覆盖层')
    eq((await A.getMeta('nasa:builtin-sat')).titleZh, '内置卫星', '写缩略图不冲掉覆盖层里的其它字段')

    const rr = await A.remove(r.id)
    eq([rr.ok, rr.removed], [true, 2], 'remove 本机件：删 glb + meta')
    ok(!existsSync(join(process.env.SATSIM_MODELS_DIR, 'user', sha(conv) + '.glb')), '文件没了')
    ok(!(await A.manifest()).models.some((m) => m.id === r.id), '清单里没了')
    eq((await A.remove('nasa:nope')).ok, false, '不存在的 → ok:false')
  }

  /* ③b 覆盖层只记差量：远端 / 内置底版更新后，没改过的字段跟着新版走 */
  {
    const keep = { d: process.env.SATSIM_MODELS_DIR, b: process.env.SATSIM_MODELS_BUNDLE_DIR }
    const b2 = join(root, 'bundle-ov')
    mkdirSync(b2, { recursive: true })
    const writeBundle = (titleZh, r, tags) => writeFileSync(join(b2, 'manifest.json'), JSON.stringify({
      schema: 2, buildId: 'ov', generatedAt: '2026-09-23T00:00:00Z',
      models: [S.defaultMeta({
        id: 'nasa:goes', title: 'GOES', titleZh, kind: 'spacecraft', tags,
        source: { kind: 'nasa', url: 'https://science.nasa.gov/3d-resources/goes/', credit: 'NASA', redistributable: true },
        files: { lod0: f(bL0, 10), lod1: f(bL1, 5), lod2: f(bL2, 1) },
        geometry: { bboxM: { min: [-r, -r, -r], max: [r, r, r] }, boundingRadiusM: r * Math.sqrt(3), tris: 1, areaM2: 0, volumeM3: null, closed: false, centroidM: [0, 0, 0] }
      })]
    }))
    writeBundle('旧名', 1, ['weather'])
    process.env.SATSIM_MODELS_BUNDLE_DIR = b2
    process.env.SATSIM_MODELS_DIR = join(root, 'ud-ov', 'models')
    const ovf = join(process.env.SATSIM_MODELS_DIR, 'overrides', 'nasa%3Agoes.satsim.json')
    const ovKeys = () => Object.keys(JSON.parse(readFileSync(ovf, 'utf8'))).sort()
    const C1 = createModels({ appRoot: REPO, log: quietLog(), stkDefaultDir: stkDefault })
    const myFrame = { q_model2body: [0, 0, 0, 1], t_model2body: [0, 0.5, 0], verified: true }
    eq(await C1.saveMeta({ id: 'nasa:goes', meta: { frame: myFrame } }), { ok: true }, '只改本体轴')
    eq(ovKeys(), ['frame', 'id', 'updatedAt'], '覆盖层只记 frame（不是 16 个键的整份快照）')
    // 渲染端常见写法：getMeta 拿整份、改一格、整份送回 —— 其余字段与底版相同，不进覆盖层
    const full = await C1.getMeta('nasa:goes')
    full.tags = ['weather', 'geo']
    eq(await C1.saveMeta({ id: 'nasa:goes', meta: full }), { ok: true }, '整份送回')
    eq(ovKeys(), ['frame', 'id', 'tags', 'updatedAt'], '整份送回也只记与底版不同的 frame / tags')
    C1.stop()
    // 远端重建：titleZh / 包围盒 / tags 都变了
    writeBundle('新名', 5, ['weather', 'noaa'])
    const C2 = createModels({ appRoot: REPO, log: quietLog(), stkDefaultDir: stkDefault })
    const m = await C2.getMeta('nasa:goes')
    eq([m.titleZh, m.geometry.boundingRadiusM, m.frame.t_model2body, m.frame.verified, m.tags], ['新名', 5 * Math.sqrt(3), [0, 0.5, 0], true, ['weather', 'geo']], '没改过的跟新底版；改过的 frame / tags 照样盖上去')
    // 改回底版的值 → 从覆盖层摘掉；全摘光 → 覆盖层文件（连 .bak）删掉
    eq(await C2.saveMeta({ id: 'nasa:goes', meta: { tags: ['weather', 'noaa'] } }), { ok: true }, '改回与底版相同')
    eq(ovKeys(), ['frame', 'id', 'updatedAt'], '改回原值的字段从覆盖层摘掉')
    const baseFrame = S.normalizeMeta(S.defaultMeta({ id: 'nasa:x' })).frame
    await C2.saveMeta({ id: 'nasa:goes', meta: { frame: baseFrame } })
    ok(!existsSync(ovf) && !existsSync(ovf + '.bak'), '覆盖层全摘光 → 文件删掉（不留 .bak 被读回来）')
    const m2 = await C2.getMeta('nasa:goes')
    eq([m2.frame.verified, m2.tags], [false, ['weather', 'noaa']], '回到纯底版')
    C2.stop()
    process.env.SATSIM_MODELS_DIR = keep.d
    process.env.SATSIM_MODELS_BUNDLE_DIR = keep.b
  }

  /* STK 目录遍历：异步、目录数 / 深度 / 文件数封顶 */
  {
    const deep = join(root, 'deep')
    let p = deep
    for (let i = 0; i < 12; i++) { mkdirSync(p, { recursive: true }); writeFileSync(join(p, `m${i}.glb`), glbOf(makeGltf({ names: ['n' + i] }))); p = join(p, 'd' + i) }
    const w0 = await createModels.walkGlbFiles(deep)
    eq([w0.files.length, w0.truncated], [9, true], '缺省深度 8：第 0–8 层共 9 个，更深的截断')
    const w1 = await createModels.walkGlbFiles(deep, { maxDirs: 5, maxDepth: 64 })
    eq([w1.files.length, w1.truncated, w1.dirs], [5, true, 5], '目录数封顶 5')
    const w2 = await createModels.walkGlbFiles(deep, { maxDepth: 64 })
    eq([w2.files.length, w2.truncated], [12, false], '不到上限：全列、不截断')
    const w3 = await createModels.walkGlbFiles(deep, { maxFiles: 3, maxDepth: 64 })
    eq([w3.files.length, w3.truncated], [3, true], '文件数封顶 3')
    const D = createModels({ appRoot: REPO, log: quietLog(), stkDefaultDir: stkDefault, stkWalk: { maxDirs: 3 } })
    const sc = await D.scanStk({ dir: deep })
    eq([sc.exists, sc.items.length, sc.truncated], [true, 3, true], 'scanStk 到上限即停并标 truncated')
    D.stop()
  }

  /* ⑩ 导入件本体轴缺省按来源（轴映射终案 ②，bodyFrame.defaultImportQ）；挂点位姿按同一个 q 换算 */
  const BF = await import(pathToFileURL(join(REPO, 'packages/core/models/bodyFrame.mjs')).href)
  const K = await import(pathToFileURL(join(REPO, 'packages/core/models/mask.mjs')).href)
  const keepDir = process.env.SATSIM_MODELS_DIR
  process.env.SATSIM_MODELS_DIR = join(root, 'ud-p2', 'models')
  const saveTo2 = { path: null }
  const E2 = createModels({ appRoot: REPO, log: quietLog(), stkDefaultDir: stkDefault, maskKeep: 3, maskGraceMs: 0,
    electron: { dialog: { showSaveDialog: async () => (saveTo2.path ? { canceled: false, filePath: saveTo2.path } : { canceled: true }) } } })
  const qOf = (m) => m.frame.q_model2body
  const nearArr = (a, b, tol, msg) => { ok(a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= tol), `${msg}：${JSON.stringify(a)} vs ${JSON.stringify(b)}`) }
  {
    eq([BF.Q_YUP_ZENITH, BF.Q_STK].map((q) => q.slice()), [[-0.5, 0.5, -0.5, 0.5], [0.5, 0.5, 0.5, 0.5]], '两套映射的数（附录 B / STK）')
    const plainGlb = await E2.importGlb({ bytes: glbOf(makeGltf({ names: ['PlainUser'] })), name: 'plain.glb' })
    eq([plainGlb.meta.source.kind, qOf(plainGlb.meta), plainGlb.meta.frame.verified], ['user', BF.Q_YUP_ZENITH.slice(), false], '普通 glb（无 AGI、无 extras.satsim）→ +Y 天顶，未核')
    const apExt = { AP: { AGI_articulations: { isAttachPoint: true } } }
    const withQ = await E2.importGlb({ bytes: glbOf(makeGltf({ names: ['Body', 'AP'], nodeExt: apExt, extras: { satsim: { frame: { q: [0, 0, 0, 1], t: [0, 0.25, 0], verified: true } } } })), name: 'ours.glb' })
    eq([withQ.meta.source.kind, qOf(withQ.meta), withQ.meta.frame.t_model2body, withQ.meta.frame.verified], ['user', [0, 0, 0, 1], [0, 0.25, 0], true], 'extras.satsim.frame 的简写 q / t：原样采用、算核过')
    nearArr(withQ.meta.attachPoints[0].dirBody, [0, 1, 0], 1e-12, '挂点视轴（节点局部 +Y）按文件自带 q（恒等）换到本体系')
    nearArr(withQ.meta.attachPoints[0].posBody, [1, 0.25, 0], 1e-12, '挂点位置按 q + t 换算')
    const noFrame = await E2.importGlb({ bytes: glbOf(makeGltf({ names: ['Body2', 'AP'], nodeExt: apExt, extras: { satsim: { titleZh: '导出件' } } })), name: 'ours2.glb' })
    eq([noFrame.meta.source.kind, qOf(noFrame.meta)], ['user', BF.Q_STK.slice()], '带 AGI 扩展（extras.satsim 没写 frame）→ STK 映射')
    nearArr(noFrame.meta.attachPoints[0].dirBody, [0, 0, 1], 1e-12, 'STK 映射下挂点视轴 glTF +Y → 本体 +Z（天底）')
    const bareFrame = await E2.importGlb({ bytes: glbOf(makeGltf({ names: ['Body3'], extras: { satsim: { frame: { verified: true } } } })), name: 'ours3.glb' })
    eq([qOf(bareFrame.meta), bareFrame.meta.frame.verified], [BF.Q_STK.slice(), false], 'extras.satsim.frame 没给 q → STK 映射、未核')
    // 「核过」只认真被采用的文件 q：模长出门（defaultImportQ 换成缺省映射）的不算核过；模长在门内的按规范化后的值采用、算核过
    const badQ = await E2.importGlb({ bytes: glbOf(makeGltf({ names: ['Body4'], extras: { satsim: { frame: { q: [0, 0, 0, 2], verified: true } } } })), name: 'ours4.glb' })
    eq([qOf(badQ.meta), badQ.meta.frame.verified], [BF.Q_STK.slice(), false], 'extras.satsim.frame 的 q 模长 2 → 退回 STK 映射、未核')
    const nearQ = await E2.importGlb({ bytes: glbOf(makeGltf({ names: ['Body5'], extras: { satsim: { frame: { q: [0, 0, 0, 1.05], verified: true } } } })), name: 'ours5.glb' })
    eq([qOf(nearQ.meta), nearQ.meta.frame.verified], [[0, 0, 0, 1], true], 'q 模长 1.05（门内）→ 规范化后采用、算核过')
    const mixQ = await E2.importGlb({ bytes: glbOf(makeGltf({ names: ['Body6'], extras: { satsim: { frame: { q_model2body: [1, 2, 3], q: [0, 0, 0, 1], verified: true } } } })), name: 'ours6.glb' })
    eq([qOf(mixQ.meta), mixQ.meta.frame.verified], [[0, 0, 0, 1], true], 'q_model2body 不是四元数 → 与 defaultImportQ 同样改取简写 q、算核过')
    const noVer = await E2.importGlb({ bytes: glbOf(makeGltf({ names: ['Body7'], extras: { satsim: { frame: { q: [0, 0, 0, 1] } } } })), name: 'ours7.glb' })
    eq([qOf(noVer.meta), noVer.meta.frame.verified], [[0, 0, 0, 1], false], '文件没说核过 → 采用 q、未核')
    const stkLike = await E2.importGlb({ bytes: glbOf(makeGltf({ names: ['StkBody'], copyright: AGI_COPY })), name: 'stk.glb' })
    eq([stkLike.meta.source.kind, qOf(stkLike.meta)], ['stk-local', BF.Q_STK.slice()], 'STK 本机件 → STK 映射')
    const pUser = await E2.saveImported({ glb: glbOf(makeGltf({ names: ['objconv'] })), meta: { title: 'OBJ' } })
    eq(qOf(pUser.meta), BF.Q_YUP_ZENITH.slice(), '渲染端转好的普通件（没带 frame）→ +Y 天顶')
    const pUserQ = await E2.saveImported({ glb: glbOf(makeGltf({ names: ['objconv2'] })), meta: { title: 'OBJ2', frame: { q_model2body: [0, 0, 0, 1], t_model2body: [0, 0, 0], verified: true } } })
    eq(qOf(pUserQ.meta), [0, 0, 0, 1], '渲染端给了 frame 就用给的')
    const pParam = await E2.saveImported({ glb: glbOf(makeGltf({ names: ['parambus'] })), meta: { title: 'P', source: { kind: 'param' } } })
    eq([pParam.meta.source.kind, qOf(pParam.meta)], ['param', BF.Q_STK.slice()], '参数化件 → STK 映射（paramBus 根矩阵 = 它的逆）')
  }

  /* ⑪ 本体遮挡掩模存取（D18：masks/<sig>.bin；坏文件拒读；没人引用的超量按时间清） */
  {
    eq(createModels.MASK_SIG_RE.source, S.MASK_SIG_RE.source, '签名正则与 schema.mjs 同一条')
    const box = K.boxMask({ min: [-1, -1, 0.5], max: [1, 1, 2] }, [0, 0, 0])
    const bin = K.encodeMask(box)
    const sig = K.maskSignature({ modelSha: 'cd'.repeat(32), lod: 'lod1', mountPos: [0, 0, 0], mountBoresight: [0, 0, 1] })
    const r1 = await E2.saveMask({ sig, bytes: bin })
    eq(r1, { ok: true, sig, bytes: K.MASK_BYTES }, 'saveMask {sig, bytes}')
    const f1 = E2._maskFile(sig)
    eq([f1, statSync(f1).size], [join(process.env.SATSIM_MODELS_DIR, 'masks', sig + '.bin'), K.MASK_BYTES], '落在 models/masks/<sig>.bin、325 816 字节')
    const back = await E2.getMask(sig)
    ok(back instanceof Uint8Array && Buffer.from(back).equals(Buffer.from(bin)), 'getMask 取回逐字节相同')
    const dm = K.decodeMask(back)
    ok(dm.blocked.every((v, i) => v === box.blocked[i]) && dm.clearance.every((v, i) => Object.is(v, box.clearance[i])), 'decodeMask 后逐格相同（含 +Infinity）')
    const sig2 = sig.replace(/^./, sig[0] === 'a' ? 'b' : 'a')
    eq((await E2.saveMask({ sig: sig2, blocked: box.blocked, clearance: box.clearance })).ok, true, 'saveMask {sig, blocked, clearance}（主进程按 D18 编码）')
    ok(readFileSync(E2._maskFile(sig2)).equals(Buffer.from(bin)), '两种入参落盘字节相同')
    eq((await E2.saveMask({ sig: sig2, blocked: Array.from(box.blocked), clearance: Array.from(box.clearance) })).ok, true, '普通数组也收')
    for (const [bad, why] of [['ABCDEF0123456789', '大写'], ['../../x0123456789abcdef', '路径'], ['abc', '太短'], [123, '不是串']]) {
      eq((await E2.saveMask({ sig: bad, bytes: bin })).code, 'bad-sig', `非法签名拒写（${why}）`)
      eq(await E2.getMask(bad), null, `非法签名拒读（${why}）`)
    }
    const tweak = (fn) => { const b = Uint8Array.from(bin); fn(b, new DataView(b.buffer)); return b }
    const H = K.MASK_HEADER_BYTES, CL = H + K.MASK_N
    const cases = [
      [bin.subarray(0, bin.length - 1), '少一个字节'],
      [tweak((b) => { b[0] = 0x58 }), '魔数不对'],
      [tweak((b, dv) => dv.setUint32(4, 2, true)), '版本不对'],
      [tweak((b) => { b[H + 5] = 2 }), 'blocked 出现 2'],
      [tweak((b, dv) => dv.setFloat32(CL + 4 * 7, NaN, true)), 'clearance 是 NaN'],
      [tweak((b, dv) => dv.setFloat32(CL + 4 * 7, -1, true)), 'clearance 为负'],
      [tweak((b, dv) => { const i = box.blocked.indexOf(1); dv.setFloat32(CL + 4 * i, Infinity, true) }), '遮挡格净空为 +∞'],
      [null, '没给字节']
    ]
    for (const [b, why] of cases) eq((await E2.saveMask({ sig, bytes: b })).code, 'bad-mask', `坏掩模拒写（${why}）`)
    ok(readFileSync(f1).equals(Buffer.from(bin)), '拒写不碰已有文件')
    eq(await E2.getMask('0123456789abcdef'), null, '没有这张 → null')
    // 盘上被截断 / 被改坏：拒读（null），重存即恢复
    writeFileSync(f1, bin.subarray(0, 1000))
    eq(await E2.getMask(sig), null, '截断的文件拒读')
    writeFileSync(f1, tweak((b) => { b[H + 100] = 7 }))
    eq(await E2.getMask(sig), null, '内容被改坏的文件拒读')
    await E2.saveMask({ sig, bytes: bin })
    ok((await E2.getMask(sig)) !== null, '重存后又取得到')

    // 清理：留 3 张；绑定里引用的（maskSig / maskSun.sigs）与刚写的不清；其余按修改时间从旧往新删
    const md = join(process.env.SATSIM_MODELS_DIR, 'masks')
    for (const n of readdirSync(md)) rmSync(join(md, n))
    const sigs = Array.from({ length: 6 }, (_, i) => (i + 1).toString(16).padStart(2, '0').repeat(8))
    const t0 = Date.now() / 1000 - 3600
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(md, sigs[i] + '.bin'), bin)
      utimesSync(join(md, sigs[i] + '.bin'), t0 + i * 60, t0 + i * 60)
    }
    eq(await E2.bindingsSet({ satKey: 'norad:40000', binding: { mounts: [
      { id: 'm1', name: '天线 1', posBody: [0, 0, 0], boresightBody: [0, 0, 1], maskSig: sigs[0] },
      { id: 'm2', name: '天线 2', posBody: [0, 0, 0], boresightBody: [0, 0, 1], maskSun: { sigs: [sigs[1], ...Array(11).fill(sigs[1])], axisBody: [0, 1, 0], pointingBody: [0, 0, -1] } }
    ] } }), { ok: true }, '绑定引用两张（maskSig 一张、对日扫描 maskSun.sigs 一张）')
    eq((await E2.saveMask({ sig: sigs[5], bytes: bin })).ok, true, '第 6 张写入触发清理')
    eq(readdirSync(md).filter((n) => n.endsWith('.bin')).sort(), [sigs[0], sigs[1], sigs[5]].map((s) => s + '.bin'), '超量的 3 张没人引用的按从旧往新删；引用的与刚写的留下')
    // 保护期内的不清（工作台先存 .bin 后写绑定）；绑定表读不出时一张都不清
    const E3 = createModels({ appRoot: REPO, log: quietLog(), stkDefaultDir: stkDefault, maskKeep: 1 })
    writeFileSync(join(md, sigs[2] + '.bin'), bin)
    eq(E3._pruneMasks(null), 0, '缺省保护期 10 分钟：刚写的没人引用也不清')
    const bfile = join(dirname(process.env.SATSIM_MODELS_DIR), 'models.bindings.json')
    const keepB = readFileSync(bfile)
    writeFileSync(bfile, '{ broken'); writeFileSync(bfile + '.bak', 'broken')
    eq(E2._pruneMasks(null), 0, '绑定表读不出 → 一张都不清')
    writeFileSync(bfile, keepB); rmSync(bfile + '.bak')
    E3.stop()
  }

  /* ⑫ 表格导出（分析页时间序列 → xlsx 三线表 / csv） */
  {
    const ExcelJS = require('exceljs')
    const sheet = {
      name: '星侧太阳侵入',
      cols: [{ key: 't', label: '时刻' }, { key: 'dT', label: 'ΔT', unit: 'K', num: true, fix: 2 }, { key: 'gl', label: 'ΔG/T', unit: 'dB', num: true, fix: 3 }],
      rows: [{ t: '2026-03-20 12:00:00', dT: 1234.5678, gl: 3.21 }, ['2026-03-20 12:01:00', '17.5', NaN], { t: 'x, "y"', dT: null }]
    }
    const gm = createModels.tableGridModel({ sheets: [sheet] })
    eq(gm.style, 'report', '缺省三线表档')
    eq(gm.sheets[0].header, ['时刻', 'ΔT (K)', 'ΔG/T (dB)'], '列头 = 标签 + 括号单位（与渲染端 colLabel 同款）')
    eq(gm.sheets[0].rows, [['2026-03-20 12:00:00', 1234.5678, 3.21], ['2026-03-20 12:01:00', 17.5, null], ['x, "y"', null, null]], '行可为对象或数组；数字列的数字串转成数；NaN / 空 → 空格')
    eq(gm.sheets[0].cols, [{ num: false, fix: undefined, align: undefined }, { num: true, fix: 2, align: undefined }, { num: true, fix: 3, align: undefined }], '列口径透传')
    let threw = ''
    try { createModels.tableGridModel({ sheets: [] }) } catch (e) { threw = e.message }
    eq(threw, '没有可导出的数据', '没有表 → 报错')
    threw = ''
    try { createModels.tableGridModel({ sheets: [{ name: 'x', cols: [] }] }) } catch (e) { threw = e.message }
    ok(/没有列/.test(threw), '没有列 → 报错')

    saveTo2.path = join(root, 'tbl.xlsx')
    const ex = await E2.exportTable({ defaultName: '星侧太阳侵入', sheets: [sheet] })
    eq(ex, { ok: true, filePath: saveTo2.path }, 'exportTable → xlsx')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(saveTo2.path)
    const ws = wb.worksheets[0]
    const rt = (v) => (v && v.richText ? v.richText.map((x) => x.text).join('') : v)
    eq([ws.name, rt(ws.getCell('A1').value), rt(ws.getCell('B1').value), ws.getCell('B2').value, ws.getCell('B2').numFmt, ws.getCell('C3').value], ['星侧太阳侵入', '时刻', 'ΔT (K)', 1234.5678, '0.00', null], '工作簿读回：表名 / 表头 / 真数值 / 小数位格式 / 空格')
    eq([ws.getCell('B1').border.top.style, ws.getCell('B1').border.bottom.style, ws.getCell('B4').border.bottom.style, ws.getCell('B2').border && ws.getCell('B2').border.left], ['medium', 'thin', 'medium', undefined], '三线表：顶线粗、栏目线细、末行底线粗、无竖线')
    saveTo2.path = null
    eq(await E2.exportTable({ sheets: [sheet] }), { ok: false, canceled: true }, '取消保存框 → canceled')
    eq((await E2.exportTable({ sheets: [] })).error, '没有可导出的数据', '空表不弹框直接报错')

    // CSV：现成文本（maskToCsv）原样；一张表按 RFC 4180；含中文前置 BOM
    saveTo2.path = join(root, 'mask.csv')
    const maskCsv = K.maskToCsv(K.boxMask({ min: [-1, -1, 0.5], max: [1, 1, 2] }, [0, 0, 0]))
    eq((await E2.exportTable({ format: 'csv', text: maskCsv, defaultName: '掩模' })).ok, true, 'CSV 文本导出')
    ok(readFileSync(saveTo2.path, 'utf8') === maskCsv, '纯 ASCII 文本逐字节原样（不加 BOM）')
    saveTo2.path = join(root, 'tbl.csv')
    await E2.exportTable({ format: 'csv', sheets: [sheet] })
    const csv = readFileSync(saveTo2.path, 'utf8')
    eq(csv, '﻿时刻,ΔT (K),ΔG/T (dB)\r\n2026-03-20 12:00:00,1234.57,3.210\r\n2026-03-20 12:01:00,17.50,\r\n"x, ""y""",,\r\n', '一张表转 CSV：CRLF、按小数位、引号转义、含中文带 BOM')
    const dn = []
    const E4 = createModels({ appRoot: REPO, log: quietLog(), stkDefaultDir: stkDefault, electron: { dialog: { showSaveDialog: async (o) => { dn.push(o.defaultPath); return { canceled: true } } } } })
    await E4.exportTable({ defaultName: 'a/b:c.xlsx', sheets: [sheet] })
    await E4.exportTable({ format: 'csv', text: 'a', defaultName: '掩模.csv' })
    eq(dn, ['a_b_c.xlsx', '掩模.csv'], '缺省文件名：非法字符替换、扩展名随格式')
    E4.stop()
  }

  /* ⑫b 大表：列式入参（preload 给大表打的包）与流式写（合计超过 tableStreamRows 行） */
  {
    const ExcelJS = require('exceljs')
    const JSZip = require('jszip')
    const cols = [{ key: 't', label: '时刻' }, { key: 'dT', label: 'ΔT', unit: 'K', num: true, fix: 2 }, { key: 'gl', label: 'ΔG/T', unit: 'dB', num: true, fix: 3 }, { key: 'lab', label: '备注' }]
    const N = 57
    const rowsObj = Array.from({ length: N }, (_, i) => ({ t: `2026-03-20 12:${String(i).padStart(2, '0')}:00`, dT: i === 3 ? NaN : i * 1.25 + 0.004, gl: i === 5 ? null : -i / 7, lab: i % 9 === 0 ? `峰值 A${i} 段` : (i % 4 === 0 ? '中文' : (i % 5 === 0 ? 'x, "y"' : '')) }))
    const colData = [rowsObj.map((r) => r.t), Float64Array.from(rowsObj, (r) => r.dT), Float64Array.from(rowsObj, (r) => (r.gl == null ? NaN : r.gl)), rowsObj.map((r) => r.lab || null)]
    const sheetRows = { name: '时间序列', cols, rows: rowsObj, note: '卫星 A · 挂点 1（UTC）' }
    const sheetCols = { name: '时间序列', cols, n: N, columns: colData, note: '卫星 A · 挂点 1（UTC）' }
    eq(createModels.tableGridModel({ sheets: [sheetCols] }), createModels.tableGridModel({ sheets: [sheetRows] }), '列式入参摊出来与行式逐格相同（NaN / null / 空串 → 空格）')
    const SEP = String.fromCharCode(31)
    const sheetJoin = { ...sheetCols, columns: [{ join: colData[0].join(SEP) }, colData[1], colData[2], { join: colData[3].map((v) => v || '').join(SEP) }] }
    eq(createModels.tableGridModel({ sheets: [sheetJoin] }), createModels.tableGridModel({ sheets: [sheetRows] }), '列式 {join}（串列连成一个长串）同步拆回也逐格相同')
    let threw = ''
    try { createModels.tableSpec({ sheets: [{ name: 'x', cols, n: 10, columns: [[1, 2]] }] }) } catch (e) { threw = e.message }
    ok(/长度不对/.test(threw), '列式：某列比 n 短 → 报错')
    threw = ''
    try { createModels.tableSpec({ sheets: [{ name: 'x', cols, n: -1, columns: [] }] }) } catch (e) { threw = e.message }
    ok(/行数不对/.test(threw), '列式：n 非法 → 报错')

    // 同一张表走两条路（整本 gridXlsx / 流式）→ 读回逐格比：值、数字格式、字体（含中西文拆分的富文本）、边框、对齐、冻结、列宽、说明表、主题字体
    const outA = join(root, 'grid-a.xlsx'), outB = join(root, 'grid-b.xlsx')
    const mkE = (rows, path) => createModels({ appRoot: REPO, log: quietLog(), stkDefaultDir: stkDefault, tableStreamRows: rows, electron: { dialog: { showSaveDialog: async () => ({ canceled: false, filePath: path }) } } })
    for (const style of ['report', 'plain']) {
      const EA = mkE(1e9, outA), EB = mkE(10, outB)
      eq((await EA.exportTable({ style, sheets: [sheetRows] })).ok, true, `${style}：整本那条路写出`)
      eq((await EB.exportTable({ style, sheets: [style === 'report' ? sheetJoin : sheetCols] })).ok, true, `${style}：流式那条路写出（列式入参${style === 'report' ? '，串列 {join} 按时间片拆' : ''}）`)
      EA.stop(); EB.stop()
      const [wa, wb] = [new ExcelJS.Workbook(), new ExcelJS.Workbook()]
      await wa.xlsx.readFile(outA); await wb.xlsx.readFile(outB)
      eq(wb.worksheets.map((w) => w.name), wa.worksheets.map((w) => w.name), `${style}：表名与张数相同（含「说明」）`)
      const diffs = []
      wa.worksheets.forEach((sa, si) => {
        const sb = wb.worksheets[si]
        for (let r = 1; r <= Math.max(sa.rowCount, sb.rowCount); r++) {
          for (let c = 1; c <= 4; c++) {
            const A = sa.getRow(r).getCell(c), B = sb.getRow(r).getCell(c)
            const pick = (x) => JSON.stringify({ v: x.value, f: x.numFmt || null, font: x.font ? { n: x.font.name, s: x.font.size, b: !!x.font.bold } : null, al: x.alignment ? { h: x.alignment.horizontal, w: !!x.alignment.wrapText } : null, bd: x.border ? { t: x.border.top && x.border.top.style, b: x.border.bottom && x.border.bottom.style, l: x.border.left && x.border.left.style } : null, fill: x.fill && x.fill.fgColor ? x.fill.fgColor.argb : null })
            if (pick(A) !== pick(B)) diffs.push(`${sa.name}!${String.fromCharCode(64 + c)}${r}：${pick(A)} ≠ ${pick(B)}`)
          }
        }
      })
      eq(diffs.slice(0, 3), [], `${style}：两条路逐格相同（值 / 格式 / 字体 / 对齐 / 边框 / 底纹，${wa.worksheets[0].rowCount} 行）`)
      const s0a = wa.worksheets[0], s0b = wb.worksheets[0]
      ok([1, 2, 3, 4].every((c) => Math.abs((s0a.getColumn(c).width || 8.43) - (s0b.getColumn(c).width || 8.43)) < 0.01), `${style}：列宽相同（抽样量宽 = 全表量宽）`)
      eq([s0b.views[0] && s0b.views[0].state, s0b.views[0] && s0b.views[0].ySplit], ['frozen', 1], `${style}：冻结首行`)
      eq(!!s0b.autoFilter, style === 'plain', `${style}：筛选器只在朴素档`)
      const theme = await (await JSZip.loadAsync(readFileSync(outB))).file('xl/theme/theme1.xml').async('string')
      eq(theme.includes('<a:latin typeface="Times New Roman"/>') && theme.includes('<a:ea typeface="宋体"/>'), style === 'report', `${style}：流式件的主题字体${style === 'report' ? '换成 TNR / 宋体（与 applyBookFont 同）' : '保持缺省'}`)
    }
    // 取消保存框 / 写不进去：流式那条路也不留半截文件
    const EC = mkE(10, join(root, 'nodir', 'x.xlsx'))
    const bad = await EC.exportTable({ sheets: [sheetCols] })
    ok(bad.ok === false && !existsSync(join(root, 'nodir')), '流式写到不存在的目录 → ok:false、不留临时文件')
    EC.stop()

    // 流式大表：6 万行边写边让出事件循环（整本那条路同量级要堵一两秒）
    const BIG = 60000
    const bigCols = { name: '大表', cols, n: BIG, columns: [Array.from({ length: BIG }, (_, i) => `2026-01-01 ${i}`), Float64Array.from({ length: BIG }, (_, i) => i * 0.37), Float64Array.from({ length: BIG }, (_, i) => Math.sin(i)), Array.from({ length: BIG }, (_, i) => (i % 1000 ? null : '中文 A'))] }
    const outBig = join(root, 'big.xlsx')
    const ED = mkE(5000, outBig)
    let gap = 0, last = performance.now()
    const mon = setInterval(() => { const t = performance.now(); gap = Math.max(gap, t - last); last = t }, 2)
    const t0 = performance.now()
    const rb = await ED.exportTable({ sheets: [bigCols] })
    const ms = performance.now() - t0
    clearInterval(mon)
    ED.stop()
    ok(rb.ok === true && statSync(outBig).size > 500000, `流式写 6 万行（${(statSync(outBig).size / 1048576).toFixed(1)} MB，${ms.toFixed(0)} ms）`)
    ok(gap < 250, `流式写期间事件循环最长停顿 ${gap.toFixed(0)} ms（< 250）`)
    const wbig = new ExcelJS.Workbook()
    await wbig.xlsx.readFile(outBig)
    const sbig = wbig.worksheets[0]
    eq([sbig.rowCount, sbig.getCell(`B${BIG + 1}`).value, sbig.getCell(`B${BIG + 1}`).border.bottom.style, sbig.getCell('B2').border && sbig.getCell('B2').border.bottom], [BIG + 1, (BIG - 1) * 0.37, 'medium', undefined], '6 万行读回：行数、末行值、末行底线粗、中间行无横线')
  }
  E2.stop()
  process.env.SATSIM_MODELS_DIR = keepDir

  /* ⑬ 装配件入库（saveImported 的 asm 分支，DESIGN3 E4 / P3 契约 §2.6）、importQ 贯通、STK 实体类别（E5/E6）、ent: 运行时 */
  {
    const keepD = process.env.SATSIM_MODELS_DIR
    process.env.SATSIM_MODELS_DIR = join(root, 'ud-asm', 'models')
    const logC = quietLog()
    const C = createModels({ appRoot: REPO, log: logC, stkDefaultDir: stkDefault })
    process.env.SATSIM_MODELS_DIR = keepD   // 目录在 createModels 时就定了，马上还原，不影响后面各节
    const evC = []
    C.onChange((e) => evC.push(e))
    const userDirC = join(root, 'ud-asm', 'models', 'user')
    const thumbsC = join(root, 'ud-asm', 'models', 'thumbs')
    const YUP = BF.Q_YUP_ZENITH.slice(), STKQ = BF.Q_STK.slice()
    const ASM = 'asm:0123456789ab'
    const asmSpec = (domain = 'aircraft', extra = {}) => ({ kind: 'assembly', schema: 1, domain, name: '测试件', comps: [{ id: 'base', type: 'prim.box', params: {}, parent: null }], ...extra })
    // 仿 exporter：extras.satsim 里带 id / frame（含 importQ）/ spec / 时间戳，所以每次保存字节都不同
    let stamp = 0
    const asmGlb = (id, q, spec, names = ['base', 'base_box']) => glbOf(makeGltf({ names, extras: { satsim: { id, kind: 'spacecraft', frame: { q_model2body: q, t_model2body: [0, 0, 0], verified: true, importQ: q }, spec, updatedAt: `2026-09-24T00:00:${String(stamp++).padStart(2, '0')}.000Z` } } }))
    const asmMeta = (id, spec, over = {}) => ({ id, title: '测试件', titleZh: '测试件', kind: 'spacecraft', group: 'spacecraft', fidelity: 'outreach',
      source: { kind: 'nasa', redistributable: false }, spec, frame: { q_model2body: YUP, t_model2body: [0, 0, 0], verified: true }, units: { scaleToMeters: 1, unitGuess: 'm', sizeVerified: false },
      tags: ['assembly', spec.domain], aliases: ['测试件'], ...over })
    const filesOfId = (id) => readdirSync(userDirC).filter((n) => /^[0-9a-f]{64}\.satsim\.json$/.test(n) && JSON.parse(readFileSync(join(userDirC, n), 'utf8')).id === id)

    // 首存：id 保持 asm:、来源 user 可分发（渲染端给的 nasa / 不可分发不认）、kind / group 按领域、parametric；广播 manifest + meta
    const g1 = asmGlb(ASM, YUP, asmSpec())
    evC.length = 0
    const s1 = await C.saveImported({ glb: g1, meta: asmMeta(ASM, asmSpec()) })
    eq([s1.ok, s1.id], [true, ASM], 'asm 首存：id 原样')
    eq([s1.meta.source, s1.meta.kind, s1.meta.group, s1.meta.fidelity], [{ kind: 'user', url: '', credit: '', license: '', redistributable: true }, 'aircraft', 'aircraft', 'parametric'], 'asm：来源恒 user / 可分发，kind / group 按领域（渲染端给的 spacecraft 不认）')
    eq([s1.meta.spec.kind, s1.meta.files.lod0.sha256, s1.meta.frame.q_model2body, s1.meta.frame.importQ], ['assembly', sha(g1), YUP, YUP], 'asm：装配文档、lod0、领域 q 与 importQ')
    ok(evC.some((e) => e.type === 'manifest') && evC.some((e) => e.type === 'meta' && e.id === ASM), 'asm：广播 manifest 与 meta（3D 页 refreshModel 靠 meta）')
    ok(!evC.some((e) => e.type === 'import'), 'asm：不发 import 事件（不是导入）')
    eq(filesOfId(ASM).length, 1, 'asm：user/ 下一份 meta')
    ok(S.validateMeta(await C.getMeta(ASM)).ok, `asm：落盘 meta 过校验 ${S.validateMeta(await C.getMeta(ASM)).errors.join('；')}`)
    ok(!readdirSync(userDirC).some((n) => n.endsWith('.satsim.json') && JSON.parse(readFileSync(join(userDirC, n), 'utf8')).id.startsWith('user:')), 'asm：没有经过 user: 中间态落盘')
    const man1 = await C.manifest()
    eq(man1.models.filter((m) => m.id === ASM).map((m) => [m.origin, m.local.lod0]), [['user', 'ready']], 'asm：进清单、lod0 就绪')
    eq(await C.ensure({ id: ASM, lod: 'lod0' }), { state: 'ready', url: `models://user/${sha(g1)}.glb`, lod: 'lod0' }, 'asm：ensure 按普通本机件给 glb')
    // 缩略图，再存：旧 sha 文件删掉、只剩一份、旧缩略图沿用
    const th1 = await C.saveThumb({ id: ASM, webp: tinyWebp(71) })
    const g2 = asmGlb(ASM, YUP, asmSpec('aircraft', { name: '改名' }))
    evC.length = 0
    const s2 = await C.saveImported({ glb: g2, meta: asmMeta(ASM, asmSpec('aircraft', { name: '改名' }), { title: '改名' }) })
    eq([s2.ok, s2.id, s2.meta.title, s2.meta.files.lod0.sha256, s2.meta.files.thumb && s2.meta.files.thumb.sha256], [true, ASM, '改名', sha(g2), th1.sha256], '同 id 再存：新文件、旧缩略图沿用')
    eq(filesOfId(ASM).length, 1, '同 id 再存：user/ 下仍只一份 meta')
    ok(!existsSync(join(userDirC, sha(g1) + '.glb')) && !existsSync(join(userDirC, sha(g1) + '.satsim.json')) && !existsSync(join(userDirC, sha(g1) + '.satsim.json.bak')), '同 id 再存：旧 glb / meta / .bak 删干净')
    eq((await C.manifest()).models.filter((m) => m.id === ASM).length, 1, '清单里只一条')
    ok(evC.some((e) => e.type === 'meta' && e.id === ASM), '再存也广播 meta')
    // 新缩略图换下旧的：旧的没人引用 → 删
    const th2 = await C.saveThumb({ id: ASM, webp: tinyWebp(72) })
    ok(existsSync(join(thumbsC, th2.sha256 + '.webp')) && !existsSync(join(thumbsC, th1.sha256 + '.webp')), 'saveThumb 换下的旧缩略图没人引用 → 删（自动保存不积压）')
    // 同一份字节再存（existed）：meta 按本次入参重写，文件不动
    const s3 = await C.saveImported({ glb: g2, meta: asmMeta(ASM, asmSpec('aircraft', { name: '改名' }), { title: '再改', tags: ['assembly', 'aircraft', 'x'] }) })
    eq([s3.ok, s3.meta.title, s3.meta.files.lod0.sha256, s3.meta.files.thumb.sha256, filesOfId(ASM).length], [true, '再改', sha(g2), th2.sha256, 1], '字节没变再存：meta 重写、缩略图保留、仍一份')
    // 同 id 并发两次保存（自动保存与另存前后脚）：按 id 串行，最后只剩一份
    const g4 = asmGlb(ASM, YUP, asmSpec()), g5 = asmGlb(ASM, YUP, asmSpec())
    const [s4, s5] = await Promise.all([C.saveImported({ glb: g4, meta: asmMeta(ASM, asmSpec()) }), C.saveImported({ glb: g5, meta: asmMeta(ASM, asmSpec()) })])
    eq([s4.ok, s5.ok, filesOfId(ASM).length, (await C.getMeta(ASM)).files.lod0.sha256], [true, true, 1, sha(g5)], '同 id 并发保存：串行、后到的顶替、只剩一份')

    // 卫星领域：kind spacecraft、q 取文件的 STK 映射
    const ASM2 = 'asm:00000000beef'
    const s6 = await C.saveImported({ glb: asmGlb(ASM2, STKQ, asmSpec('spacecraft')), meta: asmMeta(ASM2, asmSpec('spacecraft'), { kind: 'aircraft', frame: { q_model2body: STKQ, t_model2body: [0, 0, 0], verified: true } }) })
    eq([s6.meta.kind, s6.meta.group, s6.meta.frame.q_model2body, s6.meta.frame.importQ], ['spacecraft', 'spacecraft', STKQ, STKQ], '卫星装配件：kind 按领域、q / importQ = STK 映射')
    const s7 = await C.saveImported({ glb: asmGlb('asm:00000000c0de', YUP, asmSpec('ground')), meta: asmMeta('asm:00000000c0de', asmSpec('ground')) })
    eq(s7.meta.kind, 'ground', '地球站装配件：kind = ground')

    // 缺装配文档 / 不是装配文档 → bad-asm，不落盘
    const nFiles = () => readdirSync(userDirC).length
    const n0 = nFiles()
    eq(await C.saveImported({ glb: asmGlb('asm:0000000000aa', YUP, null), meta: asmMeta('asm:0000000000aa', asmSpec(), { spec: undefined }) }), { ok: false, code: 'bad-asm', error: '装配件缺装配文档。' }, 'asm 缺装配文档 → bad-asm')
    eq((await C.saveImported({ glb: asmGlb('asm:0000000000ab', YUP, null), meta: asmMeta('asm:0000000000ab', { kind: 'satellite' }) })).code, 'bad-asm', 'spec 不是装配文档 → bad-asm')
    eq(nFiles(), n0, 'bad-asm 不落盘')

    // 授权闸：引用 STK 本机件 / 查不到的模型 → 整件拒收、不落盘；引用可分发的用户件 → 收
    const stk3 = join(root, 'stk-asm')
    for (const d of ['Air', 'Land', 'Sea', 'Space', 'Missiles']) mkdirSync(join(stk3, d), { recursive: true })
    const stkFile = (rel, names) => writeFileSync(join(stk3, rel), glbOf(makeGltf({ names, copyright: AGI_COPY })))
    stkFile('Air/c-130_hercules.glb', ['C130'])
    stkFile('Land/facility.glb', ['Facility'])
    stkFile('Land/groundvehicle.glb', ['Truck'])
    stkFile('Sea/ship.glb', ['Ship'])
    stkFile('Space/sat.glb', ['Sat'])
    stkFile('Missiles/missile.glb', ['Missile'])
    const imS = await C.importStk({ dir: stk3, files: ['Air/c-130_hercules.glb', 'Land/facility.glb', 'Land/groundvehicle.glb', 'Sea/ship.glb', 'Space/sat.glb', 'Missiles/missile.glb'] })
    eq(imS.errors, [], 'STK 合成目录导入无错')
    const stkMeta = {}
    for (const x of imS.imported) stkMeta[x.file] = await C.getMeta(x.id)
    eq(Object.entries(stkMeta).map(([f, m]) => [f, m.kind]), [['Air/c-130_hercules.glb', 'aircraft'], ['Land/facility.glb', 'ground'], ['Land/groundvehicle.glb', 'vehicle'], ['Sea/ship.glb', 'ship'], ['Space/sat.glb', 'spacecraft'], ['Missiles/missile.glb', 'launcher']], 'STK 类别 → kind：Air 飞机 / Land facility 地球站、其余车辆 / Sea 船 / Space 卫星 / Missiles 运载器')
    eq(Object.entries(stkMeta).map(([f, m]) => [f, m.frame.q_model2body, m.frame.importQ]), [
      ['Air/c-130_hercules.glb', YUP, YUP], ['Land/facility.glb', YUP, YUP], ['Land/groundvehicle.glb', YUP, YUP], ['Sea/ship.glb', YUP, YUP],
      ['Space/sat.glb', STKQ, STKQ], ['Missiles/missile.glb', STKQ, STKQ]
    ], 'STK 实体件（飞机 / 地球站 / 车 / 船）导入缺省 +Y 天顶、卫星 / 运载器 STK 映射；importQ = 导入时的 q')
    const stkId = imS.imported.find((x) => x.file === 'Space/sat.glb').id
    const n1 = nFiles()
    const refSpec = (mid) => ({ ...asmSpec(), comps: [{ id: 'base', type: 'prim.box', params: {}, parent: null }, { id: 'm', type: 'model', params: { modelId: mid }, parent: 'base', attach: { mode: 'free' } }] })
    eq(await C.saveImported({ glb: asmGlb('asm:0000000000ac', YUP, refSpec(stkId)), meta: asmMeta('asm:0000000000ac', refSpec(stkId)) }), { ok: false, code: 'not-redistributable', error: '含不可分发的模型。' }, '引用 STK 本机件 → not-redistributable')
    eq((await C.saveImported({ glb: asmGlb('asm:0000000000ad', YUP, refSpec('user:ffffffffffff')), meta: asmMeta('asm:0000000000ad', refSpec('user:ffffffffffff')) })).code, 'not-redistributable', '引用查不到的模型 → not-redistributable')
    eq(nFiles(), n1, '拒收不落盘')
    ok(!(await C.manifest()).models.some((m) => m.id === 'asm:0000000000ac' || m.id === 'asm:0000000000ad'), '拒收的不进清单')
    const plainU = await C.importGlb({ bytes: glbOf(makeGltf({ names: ['PlainForAsm'] })), name: 'plain.glb' })
    const s8 = await C.saveImported({ glb: asmGlb('asm:0000000000ae', YUP, refSpec(plainU.id)), meta: asmMeta('asm:0000000000ae', refSpec(plainU.id)) })
    eq([s8.ok, s8.code], [false, 'bad-asm'], '引用可分发的用户件过了授权闸，但 model 组件本期未登记 → 主进程 validateAssembly 整件拒收（bad-asm）')
    // 授权闸失败即关：modelId 是数组 / 对象 / 放在别的键名，指向 STK 件 → 一律 not-redistributable；坏文档 → bad-asm；都不落盘
    const nGlb = () => readdirSync(userDirC).filter((n) => n.endsWith('.glb')).length
    const ng0 = nGlb()
    const oddSpec = (params, type = 'model') => ({ ...asmSpec(), comps: [{ id: 'base', type: 'prim.box', params: {}, parent: null }, { id: 'm', type, params, parent: 'base', attach: { mode: 'free' } }] })
    let oi = 0
    const oddSave = (spec) => { const id = 'asm:00000000d' + String(oi++).padStart(3, '0'); return C.saveImported({ glb: asmGlb(id, YUP, spec), meta: asmMeta(id, spec) }) }
    for (const params of [{ modelId: [stkId] }, { modelId: { id: stkId } }, { model: stkId }, { ref: stkId }, { modelID: stkId }, { a: { b: [stkId] } }, { modelId: '' }]) {
      eq((await oddSave(oddSpec(params))).code, 'not-redistributable', '失败即关：' + JSON.stringify(params))
    }
    eq((await oddSave(oddSpec({}))).code, 'not-redistributable', 'type model 却没有 modelId → 哨兵拒收')
    eq((await oddSave(oddSpec({ xM: 0.2 }, 'prim.box'))).ok, true, '对照：合法的普通组件照收')
    eq((await oddSave(oddSpec({}, 'no.such'))).code, 'bad-asm', '未知组件类型 → bad-asm')
    eq((await oddSave({ ...asmSpec(), domain: 'moon' })).code, 'bad-asm', '领域非法 → bad-asm')
    eq((await oddSave({ ...asmSpec(), comps: [{ id: 'base', type: 'prim.box', params: { xM: 0.5, junk: 1 }, parent: null }] })).code, 'bad-asm', '已知组件带未知参数键 → bad-asm')
    eq(nGlb(), ng0 + 1, '拒收的都不落盘（只多了对照那一件的 glb）')
    // 授权随引用件传递（只许收紧）：盘上的装配件引用了当时可分发的用户件 X；之后 X 的字节出现在本机 STK 目录（重启后补判为 STK 件）
    // → 装配件跟着改成不可分发：getMeta / 目录 / exportModel 三处都收紧，另存对话框不弹
    const xBytes = glbOf(makeGltf({ names: ['LicX'] }))
    const x = await C.importGlb({ bytes: xBytes, name: 'licx.glb' })
    const LIC = 'asm:00000000e001'
    const sl = await C.saveImported({ glb: asmGlb(LIC, YUP, asmSpec()), meta: asmMeta(LIC, asmSpec()) })
    ok(sl.ok, 'LIC 首存')
    const licFile = join(userDirC, filesOfId(LIC)[0])
    const licRaw = JSON.parse(readFileSync(licFile, 'utf8'))
    writeFileSync(licFile, JSON.stringify({ ...licRaw, spec: refSpec(x.id) }))   // 模拟早先（P4 model 组件登记后）存下的引用
    const stkLic = join(root, 'stk-lic')
    mkdirSync(join(stkLic, 'Space'), { recursive: true })
    writeFileSync(join(stkLic, 'Space', 'licx.glb'), xBytes)
    let dlgN = 0
    const keepL = process.env.SATSIM_MODELS_DIR
    process.env.SATSIM_MODELS_DIR = join(root, 'ud-asm', 'models')
    const C2 = createModels({ appRoot: REPO, log: quietLog(), stkDefaultDir: stkLic, electron: { dialog: { showSaveDialog: async () => { dlgN++; return { canceled: true } } } } })
    process.env.SATSIM_MODELS_DIR = keepL
    eq((await C2.getMeta(x.id)).source.kind, 'stk-local', '重启后 X 补判为 STK 本机件')
    const licM = await C2.getMeta(LIC)
    eq([licM.source.kind, licM.source.redistributable], ['user', false], '引用件收紧 → 装配件 getMeta 不可分发（kind 仍 user）')
    eq(((await C2.manifest()).models.find((m) => m.id === LIC) || {}).source.redistributable, false, '目录条目同样收紧')
    eq(JSON.parse(readFileSync(licFile, 'utf8')).source.redistributable, false, '收紧回写到盘上')
    eq((await C2.exportModel({ id: LIC, glb: asmGlb(LIC, YUP, asmSpec()) })).code, 'not-redistributable', 'exportModel 拒导')
    eq(dlgN, 0, '另存对话框没弹')
    ok(S.validateMeta(licM).ok, `收紧后的装配件 meta 过校验 ${S.validateMeta(licM).errors.join('；')}`)
    C2.stop()
    // glb 自身是 STK 件（带 AGI 署名）照走 stkVerdict
    eq((await C.saveImported({ glb: glbOf(makeGltf({ names: ['x'], copyright: AGI_COPY })), meta: asmMeta('asm:0000000000af', asmSpec()) })).code, 'stk', 'asm 的 glb 本身是 STK 件 → stk')
    // 字节与另一条目相同：不抢它的文件
    const dupBytes = glbOf(makeGltf({ names: ['DupPlain'] }))
    const du = await C.importGlb({ bytes: dupBytes, name: 'dup.glb' })
    eq(await C.saveImported({ glb: dupBytes, meta: asmMeta('asm:0000000000b0', asmSpec()) }), { ok: false, code: 'dup', error: '与库中另一模型的文件相同。' }, '字节与别的条目相同 → dup')
    eq((await C.getMeta(du.id)).id, du.id, 'dup：原条目不受影响')
    // 非 asm: 条目带装配文档：摘掉不落盘（param: 带着它会被 buildParamModel 静默生成成一个点）
    const nu = await C.saveImported({ glb: glbOf(makeGltf({ names: ['UserWithAsmSpec'] })), meta: { title: 'u', spec: asmSpec() } })
    const np = await C.saveImported({ glb: glbOf(makeGltf({ names: ['ParamWithAsmSpec'] })), meta: { id: 'param:00000000abcd', title: 'p', source: { kind: 'param' }, spec: asmSpec() } })
    eq([nu.ok, (await C.getMeta(nu.id)).spec, np.ok, (await C.getMeta(np.id)).spec], [true, undefined, true, undefined], 'user: / param: 带的装配文档摘掉')
    ok(S.validateMeta(await C.getMeta(np.id)).ok, 'param: 条目摘掉装配文档后过校验')

    // saveMeta 对 asm 只收 title / titleZh / tags / aliases
    const before = await C.getMeta(ASM)
    const sm = await C.saveMeta({ id: ASM, meta: { title: '元数据改名', tags: ['assembly', 'aircraft', 'y'], spec: { kind: 'assembly', domain: 'ship', comps: [] }, frame: { q_model2body: [0, 0, 0, 1], t_model2body: [1, 2, 3], verified: false }, kind: 'ship', parts: [], massProps: null, attachPoints: [], source: { kind: 'nasa' } } })
    eq(sm.ok, true, 'saveMeta asm 成功')
    const after = await C.getMeta(ASM)
    eq([after.title, after.tags], ['元数据改名', ['assembly', 'aircraft', 'y']], 'saveMeta asm：标题 / 标签照改')
    eq([after.spec, after.frame, after.kind, after.parts, after.massProps, after.attachPoints, after.source, after.files.lod0], [before.spec, before.frame, before.kind, before.parts, before.massProps, before.attachPoints, before.source, before.files.lod0], 'saveMeta asm：spec / frame / kind / 部件 / 质量 / 挂点 / 来源 / 文件不动')

    // metaFromGltf 写 importQ；saveImported 合并 extra 后 importQ 仍是主进程判的那份
    const pl = await C.importGlb({ bytes: glbOf(makeGltf({ names: ['PlainIQ'] })), name: 'p.glb' })
    eq([pl.meta.frame.q_model2body, pl.meta.frame.importQ], [YUP, YUP], '普通 glb：importQ = +Y 天顶')
    const ours = await C.importGlb({ bytes: glbOf(makeGltf({ names: ['OursIQ'], extras: { satsim: { frame: { q_model2body: STKQ, verified: true } } } })), name: 'o.glb' })
    eq([ours.meta.frame.q_model2body, ours.meta.frame.importQ], [STKQ, STKQ], '带 extras.satsim.frame q：importQ = 文件 q')
    const oursAir = await C.importGlb({ bytes: glbOf(makeGltf({ names: ['OursAir'], extras: { satsim: { kind: 'aircraft', frame: { verified: false } } } })), name: 'oa.glb' })
    eq([oursAir.meta.kind, oursAir.meta.frame.q_model2body, oursAir.meta.frame.importQ], ['aircraft', YUP, YUP], 'extras.satsim 声明飞机、frame 没给 q → 按类别 +Y 天顶（类别取最终落进 meta 的那个）')
    const sx = await C.saveImported({ glb: glbOf(makeGltf({ names: ['ConvIQ'] })), meta: { title: 'conv', frame: { q_model2body: [0, 0, 0, 1], t_model2body: [0, 0, 0], verified: true, importQ: [0, 0, 1, 0] } } })
    eq([sx.meta.frame.q_model2body, sx.meta.frame.importQ], [[0, 0, 0, 1], YUP], 'saveImported：渲染端给的 frame 采用，importQ 仍是主进程按字节判的那份')
    const sx2 = await C.saveImported({ glb: glbOf(makeGltf({ names: ['ConvIQ2'] })), meta: { title: 'conv2' } })
    eq(sx2.meta.frame.importQ, YUP, 'saveImported 没给 frame：importQ 照带')
    ok(S.validateMeta(await C.getMeta(sx.id)).ok, 'importQ 落盘后过校验')
    // saveMeta：渲染端改本体轴只动 q / t / verified，importQ 以原件为准（给了不认、没给不丢）
    await C.saveMeta({ id: sx.id, meta: { frame: { q_model2body: STKQ, t_model2body: [0, 0, 0.5], verified: true, importQ: [0, 0, 0, 1] } } })
    const sxm = await C.getMeta(sx.id)
    eq([sxm.frame.q_model2body, sxm.frame.t_model2body, sxm.frame.importQ], [STKQ, [0, 0, 0.5], YUP], 'saveMeta 改 frame：q / t 照改、importQ 不认渲染端给的')
    await C.saveMeta({ id: sx.id, meta: { frame: { q_model2body: YUP, t_model2body: [0, 0, 0], verified: false } } })
    eq((await C.getMeta(sx.id)).frame.importQ, YUP, 'saveMeta 的 frame 没带 importQ：原件的不丢')
    await C.saveMeta({ id: 'nasa:builtin-sat', meta: { frame: { q_model2body: STKQ, t_model2body: [0, 0, 0], verified: true, importQ: [0, 0, 0, 1] } } }).catch(() => {})
    ok(!('importQ' in ((await C.getMeta('nasa:builtin-sat')) || { frame: {} }).frame), '内置件（清单里没 importQ）经覆盖层也补不进渲染端给的 importQ')

    // ent: 实体模板运行时生成：ensure 回 param（缩略图照常走 thumbnail → 没有条目 → missing）
    eq(await C.ensure({ id: 'ent:a320neo', lod: 'lod0' }), { state: 'param' }, 'ensure(ent:) → param（渲染端 buildAssembly 现生成）')
    eq(await C.ensure({ id: 'ent:a320neo' }), { state: 'param' }, 'ensure(ent:) 缺省档也 → param')
    eq(await C.thumbnail('ent:a320neo'), { state: 'missing' }, 'thumbnail(ent:) → missing（渲染端现场出图）')

    // 删除装配件：连文件一起删、清单里没了
    const rmA = await C.remove(ASM)
    eq([rmA.ok, filesOfId(ASM).length], [true, 0], 'remove asm：文件删干净')
    ok(!(await C.manifest()).models.some((m) => m.id === ASM), 'remove asm：清单里没了')
    ok(!logC.lines.some((l) => l.startsWith('W ') && /asm:/.test(l) && /元数据校验/.test(l)), `asm 入库全程无元数据校验告警：${logC.lines.filter((l) => l.startsWith('W ')).join(' | ')}`)
    C.stop()
  }

  /* ⑦ models:// 协议 */
  {
    const res = await A.handleProtocol({ url: `models://user/${sha(tdrs)}.glb` })
    eq([res.status, res.headers.get('content-type'), res.headers.get('access-control-allow-origin'), res.headers.get('cache-control')], [200, 'model/gltf-binary', '*', 'public, max-age=31536000, immutable'], '本机件 200 + 类型 + ACAO + immutable')
    ok(Buffer.from(await res.arrayBuffer()).equals(tdrs), '字节一致')
    eq((await A.handleProtocol({ url: `models://thumbs/${sha(bThumb)}.webp` })).status, 200, '缩略图本机没有 → 内置兜底')
    eq((await A.handleProtocol({ url: `models://blobs/${'0'.repeat(64)}.glb` })).status, 404, '缺件 404')
    const bad = await A.handleProtocol({ url: `models://blobs/${'0'.repeat(63)}.glb` })
    eq([bad.status, bad.headers.get('access-control-allow-origin')], [400, '*'], '非法 400（也带 ACAO，渲染端能读到状态）')
    eq((await A.handleProtocol({ url: 'models://evil/x' })).status, 400, '非法 host 400')
    eq((await A.handleProtocol(null)).status, 400, '垃圾请求 400 不抛')
    const big = Buffer.alloc(5 * 1024 * 1024 + 3, 7)
    const bigSha = sha(big)
    mkdirSync(join(process.env.SATSIM_MODELS_DIR, 'blobs'), { recursive: true })
    writeFileSync(join(process.env.SATSIM_MODELS_DIR, 'blobs', bigSha + '.glb'), big)
    const br = await A.handleProtocol({ url: `models://blobs/${bigSha}.glb` })
    ok(br.body && typeof br.body.getReader === 'function', '> 4 MB 走流')
    eq([br.headers.get('content-length'), (await br.arrayBuffer()).byteLength], [String(big.length), big.length], '流式回完整')
    rmSync(join(process.env.SATSIM_MODELS_DIR, 'blobs', bigSha + '.glb'))
  }

  /* ⑨ importCad（worker_threads + occt-import-js） */
  {
    const cube = join(REPO, 'node_modules/occt-import-js/test/testfiles/cube-units/cube-mm.step')
    if (existsSync(cube)) {
      const evs = []
      const off = A.onChange((e) => { if (e.type === 'import') evs.push(e.phase) })
      const r = await A.importCad({ path: cube, token: 'cad-1' })
      off()
      ok(r.ok, 'STEP 导入成功')
      const bb = r.meta.geometry.bboxM
      ok(Math.abs(bb.max[0] - bb.min[0] - 1) < 1e-6, '毫米文件出来是 1 m（linearUnit=meter，OCCT 按文件头换算）')
      eq([r.meta.units.unitGuess, r.meta.units.scaleToMeters, r.meta.units.sizeVerified, r.meta.fidelity], ['m', 1, true, 'cad'], '单位按文件头、可信；保真度 cad')
      ok(/STEP 文件头（mm）/.test(r.meta.units.sizeSource), 'sizeSource 记文件单位')
      eq(r.tris, 12, '立方体 12 个三角形')
      const j = G.parseGlb(readFileSync(join(process.env.SATSIM_MODELS_DIR, 'user', r.meta.files.lod0.sha256 + '.glb'))).json
      ok(j.nodes.some((n) => n.name === 'Cube'), '装配树零件名保留成节点名')
      eq(evs.slice(0, 1).concat(evs.slice(-1)), ['start', 'done'], '进度经 models:changed 广播（start … done）')
      ok(evs.includes('read') && evs.includes('write'), '中间阶段也广播')
      eq((await A.importCad({ path: join(FIX, 'goes.glb') })).ok, false, '不是 CAD 扩展名 → ok:false')
      const bad = join(root, 'bad.step')
      writeFileSync(bad, 'ISO-10303-21;\nthis is not step\n')
      eq((await A.importCad({ path: bad })).ok, false, '坏 STEP → ok:false，不崩')

      // 排队：同时只跑 1 个 worker；排队中的 cancel 直接出队、不起 worker
      const cube2 = join(REPO, 'node_modules/occt-import-js/test/testfiles/cube-units/cube-in.step')
      const q = []
      const off2 = A.onChange((e) => { if (e.type === 'import' && /^q-/.test(e.token || '')) q.push(e.token + ':' + e.phase) })
      const pa = A.importCad({ path: cube, token: 'q-1' })
      const pb = A.importCad({ path: cube2, token: 'q-2' })
      const pc = A.importCad({ path: cube, token: 'q-3' })
      ok(A.cancel('q-3'), '排队中的导入可按令牌取消')
      const [ra, rb, rc] = await Promise.all([pa, pb, pc])
      off2()
      ok(ra.ok && rb.ok, '排队的两件都导入成功')
      eq([rc.ok, rc.canceled], [false, true], '排队中取消 → canceled')
      ok(q.includes('q-2:queued') && q.includes('q-3:queued') && !q.includes('q-1:queued'), '后到的广播 queued，头一个直接开工')
      ok(q.indexOf('q-2:load') > q.indexOf('q-1:write'), '第二件等第一件的 worker 干完才开工（同时只一个）')
      ok(!q.some((x) => /^q-3:(load|read|write)$/.test(x)) && q.includes('q-3:canceled'), '取消的那件从没起 worker')
      ok(rb.ms >= 0 && rb.ms < 60000, '耗时从拿到道算起（不含排队）')
    } else console.log('（跳过 importCad：node_modules/occt-import-js 未安装）')
  }
  A.stop()

  /* ⑧ 下载（回环 HTTP 服务器当云端） */
  {
    const blobs = new Map()   // sha → Buffer
    const reqLog = []
    const slow = new Set()    // 这些 sha 的请求只吐一半就挂住（模拟慢网，测取消 / 让道）
    let manifestJson = null
    server = http.createServer((req, res) => {
      reqLog.push({ url: req.url, range: req.headers.range || null, inm: req.headers['if-none-match'] || null })
      if (req.url === '/models/manifest.json') {
        if (req.headers['if-none-match'] === '"v1"') { res.writeHead(304); return res.end() }
        res.writeHead(200, { 'content-type': 'application/json', etag: '"v1"' })
        return res.end(JSON.stringify(manifestJson))
      }
      const m = /^\/models\/blobs\/([0-9a-f]{64})\.(glb|webp)$/.exec(req.url)
      const body = m && blobs.get(m[1])
      if (!body) { res.writeHead(404); return res.end() }
      let start = 0
      const rg = /^bytes=(\d+)-$/.exec(req.headers.range || '')
      if (rg) start = Number(rg[1])
      const part = body.subarray(start)
      res.writeHead(rg ? 206 : 200, { 'content-length': part.length, ...(rg ? { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` } : {}) })
      if (slow.has(m[1])) { res.write(part.subarray(0, part.length >> 1)); return }   // 故意不 end
      res.end(part)
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${server.address().port}/models/`

    const L0 = fixture('goes.glb'), L1 = fixture('ssl-1300.glb'), L2 = fixture('satkit-wings-3.glb')
    const SLOW = Buffer.alloc(300 * 1024, 3); for (let i = 0; i < SLOW.length; i++) SLOW[i] = (i * 7919) & 255
    const WRONG = Buffer.from('this is what the server really sends')
    const RTHUMB = tinyWebp(42)
    const BIG1 = Buffer.alloc(256 * 1024); for (let i = 0; i < BIG1.length; i++) BIG1[i] = (i * 31 + 7) & 255
    const BIG2 = Buffer.alloc(256 * 1024); for (let i = 0; i < BIG2.length; i++) BIG2[i] = (i * 17 + 3) & 255
    const SMALL = fixture('cubesat-1ru.glb')
    for (const b of [L0, L1, L2, SLOW, WRONG, RTHUMB, BIG1, BIG2, SMALL]) blobs.set(sha(b), b)
    const nasa = (id, files) => S.defaultMeta({ id, title: id, kind: 'spacecraft', source: { kind: 'nasa', url: 'https://science.nasa.gov/3d-resources/x/', credit: 'NASA', redistributable: true }, files })
    const fakeSha = sha(Buffer.from('claimed content'))
    blobs.set(fakeSha, WRONG)   // 服务器按这个 sha 回的却是别的字节 → sha 校验不过
    manifestJson = {
      schema: 2, buildId: 'r1', generatedAt: '2026-09-23T00:00:00Z', cdnBase: 'https://evil.example/',
      models: [
        nasa('nasa:test-sat', { lod0: f(L0, 9), lod1: f(L1, 5), lod2: f(L2, 1), thumb: { sha256: sha(RTHUMB), bytes: RTHUMB.length } }),
        nasa('nasa:slow', { lod0: f(SLOW, 9), lod1: f(L1, 5), lod2: f(L2, 1) }),
        nasa('nasa:gone', { lod0: f(Buffer.from('never uploaded'), 9), lod1: f(L1, 5), lod2: { sha256: sha(Buffer.from('nope2')), bytes: 5 } }),
        nasa('nasa:liar', { lod0: f(L0, 9), lod1: f(L1, 5), lod2: { sha256: fakeSha, bytes: WRONG.length } }),
        nasa('nasa:big1', { lod0: f(BIG1, 9), lod1: f(L1, 5), lod2: f(L2, 1) }),
        nasa('nasa:big2', { lod0: f(BIG2, 9), lod1: f(L1, 5), lod2: f(L2, 1) }),
        nasa('nasa:small', { lod0: f(L0, 9), lod1: f(L1, 5), lod2: f(SMALL, 1) }),
        // 远端把内置条目重建了：lod2 的 sha 变了（内置那份仍可先顶着）
        { ...builtinEntry, files: { ...builtinEntry.files, lod2: f(L2, 1) } },
        // 不可再分发 / 本机来源的条目绝不许从云端进来
        { ...nasa('nasa:secret', { lod0: f(L0, 9), lod1: f(L1, 5), lod2: f(L2, 1) }), source: { kind: 'nasa', url: 'https://x/', credit: '', license: '', redistributable: false } },
        { ...S.defaultMeta({ id: 'stk:0123456789ab', files: { lod0: f(L0, 9) } }) }
      ]
    }
    ok(M.validateManifest(manifestJson, { remote: true }).models.length === 8, '夹具自检：远端 manifest 合格 8 条（2 条该被拒）')

    process.env.SATSIM_MODELS_DIR = join(root, 'ud2', 'models')
    process.env.SATSIM_MODELS_OFFLINE = '0'
    let clock = 1_800_000_000_000
    const logB = quietLog()
    const B = createModels({ appRoot: REPO, log: logB, cdnBase: base, now: () => clock, retryScale: 0.001, minCacheCap: 0, stkDefaultDir: stkDefault })
    const evB = []
    B.onChange((e) => evB.push(e))
    const dl = (id, phase) => evB.some((e) => e.type === 'download' && e.id === id && e.phase === phase)

    const man = await B.refreshManifest()
    eq(man.models.map((m) => m.id).sort(), ['nasa:big1', 'nasa:big2', 'nasa:builtin-sat', 'nasa:gone', 'nasa:liar', 'nasa:slow', 'nasa:small', 'nasa:test-sat'], '远端清单合并：不可分发 / STK 条目被拒')
    eq(man.models.find((m) => m.id === 'nasa:builtin-sat').origin, 'remote', '同 id 远端盖内置')
    ok(existsSync(join(process.env.SATSIM_MODELS_DIR, 'manifest.remote.json')), 'manifest.remote.json 落盘')
    ok(evB.some((e) => e.type === 'manifest'), '广播 manifest 事件')
    await B.refreshManifest()
    eq(reqLog.filter((r) => r.url === '/models/manifest.json').map((r) => r.inm), [null, '"v1"'], '第二次带 If-None-Match（304 不重写）')
    ok(logB.lines.some((l) => /cdnBase 已忽略/.test(l)), '远端带的 cdnBase 不认（校验提示进日志）')
    ok(!('cdnBase' in JSON.parse(readFileSync(join(process.env.SATSIM_MODELS_DIR, 'manifest.remote.json'), 'utf8'))), '落盘的 manifest.remote.json 不留 cdnBase')

    eq(await B.ensure({ id: 'nasa:builtin-sat', lod: 'lod2' }), { state: 'ready', url: `models://builtin/${sha(bL2)}.glb`, lod: 'lod2' }, '远端重建后内置 lod2 仍先顶着')

    // 正常下载：lod2 → 就绪
    const e1 = await B.ensure({ id: 'nasa:test-sat', lod: 'lod2' })
    eq([e1.state, e1.lod, e1.total], ['downloading', 'lod2', L2.length], 'ensure → downloading')
    await waitFor(() => dl('nasa:test-sat', 'ready'), 8000, 'lod2 下载完成')
    ok(reqLog.some((r) => r.url === `/models/blobs/${sha(L2)}.glb`), 'blob 打到钉死的地址（这里是回环），远端的 cdnBase 没被用上')
    const blob2 = join(process.env.SATSIM_MODELS_DIR, 'blobs', sha(L2) + '.glb')
    ok(readFileSync(blob2).equals(L2), 'sha 校验通过、原子落盘')
    ok(!existsSync(blob2 + '.part'), '.part 已改名')
    const readyEv = evB.find((e) => e.type === 'download' && e.id === 'nasa:test-sat' && e.phase === 'ready')
    eq(readyEv.url, `models://blobs/${sha(L2)}.glb`, 'ready 事件带 url')
    eq(await B.ensure({ id: 'nasa:test-sat', lod: 'lod2' }), { state: 'ready', url: `models://blobs/${sha(L2)}.glb`, lod: 'lod2' }, '再 ensure 直接 ready')
    eq(await B.ensure({ id: 'nasa:builtin-sat', lod: 'lod2' }), { state: 'ready', url: `models://blobs/${sha(L2)}.glb`, lod: 'lod2' }, '远端新版 lod2 已在缓存：优先新版，不再用旧内置件')
    const th = await B.thumbnail('nasa:test-sat')
    eq([th.state, th.lod], ['downloading', 'thumb'], '远端缩略图按需下载')
    await waitFor(() => evB.some((e) => e.type === 'download' && e.id === 'nasa:test-sat' && e.lod === 'thumb' && e.phase === 'ready'), 5000, '缩略图下载完成')
    eq(await B.thumbnail('nasa:test-sat'), { state: 'ready', url: `models://blobs/${sha(RTHUMB)}.webp`, lod: 'thumb' }, '下完走 blobs 主机')
    clock += 5_000
    await B.thumbnail('nasa:test-sat')
    eq(B._state().entries[sha(RTHUMB) + '.webp'].lastUsed, clock, '缩略图就绪时也记 lastUsed（画廊正显示着的不先被淘汰）')
    const tr = await B.handleProtocol({ url: `models://blobs/${sha(RTHUMB)}.webp` })
    eq([tr.status, tr.headers.get('content-type')], [200, 'image/webp'], '协议回 webp')
    eq((await B.manifest()).models.find((m) => m.id === 'nasa:test-sat').local.thumb, 'ready', '清单里缩略图就绪')
    const e0 = await B.ensure({ id: 'nasa:test-sat', lod: 'lod0' })
    eq([e0.state, e0.fallback], ['downloading', { lod: 'lod2', url: `models://blobs/${sha(L2)}.glb` }], '要 lod0：边下边用 lod2 顶着')
    await waitFor(() => existsSync(join(process.env.SATSIM_MODELS_DIR, 'blobs', sha(L0) + '.glb')), 8000, 'lod0 下载完成')
    B._flush()
    const st = JSON.parse(readFileSync(join(process.env.SATSIM_MODELS_DIR, 'state.json'), 'utf8'))
    ok(st.entries[sha(L2) + '.glb'].lastUsed === clock, 'state.json 记 lastUsed')
    eq(B.cacheInfo().count, 3, '缓存 3 件（两档 + 缩略图）')

    // 404：不重试，直接 error；60 s 内再 ensure 不再打网络
    await B.ensure({ id: 'nasa:gone', lod: 'lod0' })
    await waitFor(() => dl('nasa:gone', 'error'), 5000, '404 → error')
    const n404 = reqLog.filter((r) => r.url.includes(sha(Buffer.from('never uploaded')))).length
    eq(n404, 1, '404 只请求一次')
    eq((await B.ensure({ id: 'nasa:gone', lod: 'lod0' })).state, 'error', '60 s 内再要直接回错误')
    eq(reqLog.filter((r) => r.url.includes(sha(Buffer.from('never uploaded')))).length, 1, '没有再打网络')

    // sha 不符：退避重试 3 次后 error，坏 .part 不留
    await B.ensure({ id: 'nasa:liar', lod: 'lod2' })
    await waitFor(() => dl('nasa:liar', 'error'), 8000, 'sha 不符 → error')
    eq(reqLog.filter((r) => r.url.includes(fakeSha)).length, 4, 'sha 不符：1 次 + 重试 3 次')
    ok(!existsSync(join(process.env.SATSIM_MODELS_DIR, 'blobs', fakeSha + '.glb')), '坏件不落盘')
    ok(!existsSync(join(process.env.SATSIM_MODELS_DIR, 'blobs', fakeSha + '.glb.part')), '坏 .part 删掉')

    // 取消 → 保留 .part → 再要时 Range 续传
    slow.add(sha(SLOW))
    const partFile = join(process.env.SATSIM_MODELS_DIR, 'blobs', sha(SLOW) + '.glb.part')
    await B.ensure({ id: 'nasa:slow', lod: 'lod0' })
    await waitFor(() => existsSync(partFile) && statSync(partFile).size >= SLOW.length >> 1, 5000, '慢下载吐出一半')
    ok(B.cancel('nasa:slow'), 'cancel 命中')
    await waitFor(() => dl('nasa:slow', 'canceled'), 3000, '取消事件')
    const half = statSync(partFile).size
    eq(half, SLOW.length >> 1, '取消后 .part 保留（已收的一半）')
    slow.delete(sha(SLOW))
    await B.ensure({ id: 'nasa:slow', lod: 'lod0' })
    await waitFor(() => dl('nasa:slow', 'ready'), 8000, '续传完成')
    const last = reqLog.filter((r) => r.url.includes(sha(SLOW))).pop()
    eq(last.range, `bytes=${half}-`, '续传带 Range: bytes=<已收>-')
    ok(readFileSync(join(process.env.SATSIM_MODELS_DIR, 'blobs', sha(SLOW) + '.glb')).equals(SLOW), '续传拼出的整文件 sha 对上')

    // LRU：60 s 内 ensure 过的不淘汰；过了保护期按最久未用淘汰
    const bytesOf = (b) => b.length
    const total = bytesOf(L0) + bytesOf(L2) + bytesOf(SLOW) + bytesOf(RTHUMB)
    eq(B.cacheInfo().bytes, total, '缓存字节数')
    B.setCacheCap(bytesOf(SLOW) + 10)
    eq(B.cacheInfo().count, 4, '全在保护期内：超上限也不删')
    clock += 30_000
    await B.ensure({ id: 'nasa:slow', lod: 'lod0' })        // 刷新 slow 的 lastUsed / 保护期
    clock += 45_000                                          // test-sat 两档已过 60 s 保护期，slow 还在
    B.setCacheCap(bytesOf(SLOW) + 10)
    ok(!existsSync(blob2) && !existsSync(join(process.env.SATSIM_MODELS_DIR, 'blobs', sha(L0) + '.glb')) && !existsSync(join(process.env.SATSIM_MODELS_DIR, 'blobs', sha(RTHUMB) + '.webp')), '过了保护期：最久未用的三件被淘汰')
    ok(existsSync(join(process.env.SATSIM_MODELS_DIR, 'blobs', sha(SLOW) + '.glb')), '最近用过的留下')
    eq(B.cacheInfo(), { bytes: bytesOf(SLOW), cap: bytesOf(SLOW) + 10, count: 1 }, '淘汰后读数')
    ok(evB.some((e) => e.type === 'cache'), '广播 cache 事件')
    eq((await B.manifest()).models.find((m) => m.id === 'nasa:test-sat').local, {}, '清单里 test-sat 回到未下载')
    eq(await B.ensure({ id: 'nasa:builtin-sat', lod: 'lod2' }), { state: 'ready', url: `models://builtin/${sha(bL2)}.glb`, lod: 'lod2' }, '新版被淘汰后又回到内置件顶着')

    // remove 远端件：删缓存
    const rm = await B.remove('nasa:slow')
    eq([rm.ok, existsSync(join(process.env.SATSIM_MODELS_DIR, 'blobs', sha(SLOW) + '.glb'))], [true, false], 'remove 远端件删缓存')

    // 优先级与让道：两条道被两个 lod0 占着时，新来的 lod2 预览不排在它们后面
    slow.add(sha(BIG1)); slow.add(sha(BIG2))
    const part1 = join(process.env.SATSIM_MODELS_DIR, 'blobs', sha(BIG1) + '.glb.part')
    const part2 = join(process.env.SATSIM_MODELS_DIR, 'blobs', sha(BIG2) + '.glb.part')
    await B.ensure({ id: 'nasa:big1', lod: 'lod0' })
    await B.ensure({ id: 'nasa:big2', lod: 'lod0' })
    await waitFor(() => existsSync(part1) && existsSync(part2) && statSync(part1).size >= BIG1.length >> 1 && statSync(part2).size >= BIG2.length >> 1, 5000, '两个大件都在下、各收了一半')
    const half2 = statSync(part2).size
    eq(half2, BIG2.length >> 1, '让道前 big2 收了一半')
    const es = await B.ensure({ id: 'nasa:small', lod: 'lod2' })
    eq(es.state, 'downloading', '小件入队')
    await waitFor(() => dl('nasa:small', 'ready'), 5000, '小件插队下完')
    ok(dl('nasa:big2', 'queued') && !dl('nasa:big1', 'queued'), '最后开工的大件让道（回到排队），先开工的接着下')
    ok(!dl('nasa:big2', 'error') && !dl('nasa:big2', 'canceled'), '让道不算失败、不算取消')
    await waitFor(() => reqLog.filter((r) => r.url.includes(sha(BIG2))).length >= 2, 5000, '让道的大件重新开工')
    eq(reqLog.filter((r) => r.url.includes(sha(BIG2))).pop().range, `bytes=${half2}-`, '按 Range 续传，让道前已收的字节不丢')
    ok(B.cancel('nasa:big1') && B.cancel('nasa:big2'), '收尾：取消两个挂住的大件')
    slow.clear()

    // 离线开关：不联网，未就绪就 missing
    process.env.SATSIM_MODELS_OFFLINE = '1'
    const nReq = reqLog.length
    eq(await B.ensure({ id: 'nasa:test-sat', lod: 'lod1' }), { state: 'missing' }, '离线且无缓存 → missing')
    await B.refreshManifest()
    eq(reqLog.length, nReq, '离线时一个请求都不发')
    B.stop()
  }
} finally {
  if (server) server.close()
  for (const [k, v] of [['SATSIM_MODELS_DIR', envKeep.d], ['SATSIM_MODELS_BUNDLE_DIR', envKeep.b], ['SATSIM_MODELS_OFFLINE', envKeep.o]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
  try { rmSync(root, { recursive: true, force: true }) } catch { /* Windows 偶有句柄晚放 */ }
}

console.log(`modelsService: ${pass} 项通过`)
