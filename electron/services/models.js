'use strict'
// 卫星 3D 模型服务（主进程）：清单合并 · 下载队列 · 缓存 / LRU · 导入 · STK 本机扫描 · 元数据 · 绑定表 · 导出落盘 · models:// 协议。
//
// 决策逻辑在 modelsLogic.js（纯函数，单测钉死）；格式转换在 modelsImport.js（+ occtWorker.js）；
// 数据契约（ModelMeta / Manifest / Bindings 的校验与归一）在 packages/core/models/*.mjs（ESM，懒加载）。
// 本文件只做 I/O 与编排。顶层不 require('electron')：electron 的能力（net、dialog、shell）由 main.js 注入，
// 于是整份服务能在裸 node 里跑单测（packages/core/test/modelsService.test.mjs）。
//
// ─────────────────────────────── IPC 契约（window.api.models，设计契约 §4）───────────────────────────────
//  方法              通道                    门禁      入参 → 出参
//  open(o)           modelwb:open            gate      {tab?, modelId?, satKey?} → true；已开则 focus 并发 modelwb:target，未开则 did-finish-load 后发
//  onTarget(cb)      modelwb:target          —         返回取消函数
//  manifest()        models:manifest         UNGATED   → { models:[{...meta, local:{lod0?,lod1?,lod2?:'ready'|'partial', thumb?:'ready', builtin?:['lod2']}}], prefs, cache:{bytes, cap} }
//  ensure(o)         models:ensure           UNGATED   {id, lod} → {state:'ready', url, lod} | {state:'downloading', received, total, lod, fallback?:{lod,url}}
//                                                       | {state:'error', message} | {state:'missing'} | {state:'param'}
//  thumbnail(id)     models:thumbnail        UNGATED   = ensure({id, lod:'thumb'})：本机 / 随包缩略图直接给 models://thumbs/…，远端的按需下到 models://blobs/<sha>.webp
//  cancel(id)        models:cancel (send)    UNGATED   取消该模型的下载；也接受导入令牌（取消 CAD 导入）
//  remove(id)        models:remove           gate      → {ok, removed}（远端条目删缓存；本机导入删文件 + meta）
//  cacheInfo()       models:cacheInfo        UNGATED   → {bytes, cap, count}
//  setCacheCap(b)    models:setCacheCap      gate      → cacheInfo
//  openCacheDir()    models:openCacheDir     gate      → true
//  refreshManifest() models:refreshManifest  gate      → 同 manifest()
//  pickFiles()       models:pickFiles        gate      原生对话框 → [{path, name, ext, bytes}]
//  readFile(path)    models:readFile         gate      → {bytes: Uint8Array, name, dir} | {ok:false, error, code?:'stk'}（STK 的东西不给读，见 readFile）
//  importGlb(o)      models:importGlb        gate      {path} | {bytes, name} → {ok:true, id, meta, existed?} | {ok:false, error}
//  importCad(o)      models:importCad        gate      {path, token?} → 进度经 models:changed {type:'import', token, phase:'start'|'queued'|'load'|'read'|'simplify'|'build'|'write'|'done'|'error'|'canceled'}
//                                                       → {ok:true, id, meta, ms, tris, …} | {ok:false, error, canceled?}（CAD 同时只跑 1 个，其余排队）
//  saveImported(o)   models:saveImported     gate      {glb: Uint8Array, meta} → {ok:true, id, meta} | {ok:false, error, code?:'stk'}
//                                                       装配件（meta.id = asm:<12hex>，DESIGN3 E4）：id 原样保留、来源恒为 user / 可分发、kind 按装配领域；
//                                                       同 id 再存顶替旧文件（沿用旧缩略图），广播 manifest + meta。另有错误码：
//                                                       'bad-asm'（meta.spec 不是装配文档）、'not-redistributable'（引用了查不到 / 不可分发的库模型，整件拒收、不落盘）、
//                                                       'dup'（字节与库里另一条目相同，不抢它的文件）
//                                                       saveMeta 对 asm: 只收 title / titleZh / tags / aliases（其余只能随 glb 一起经 saveImported 变）
//  scanStk(o)        models:scanStk          gate      {dir?} → {dir, exists, truncated?, items:[{file, rel, category, bytes, nodes, attachPoints, articulations, solarPanelGroups, hasGmdf, error?}]}
//  pickStkDir()      models:pickStkDir       gate      → {dir} | {canceled:true}
//  importStk(o)      models:importStk        gate      {dir, files:[rel]} → {imported:[{id, file}], errors:[{file, message}]}
//  saveMeta(o)       models:saveMeta         gate      {id, meta} → {ok, errors?}（本机模型改原件；远端 / 内置写覆盖层 overrides/<id>.satsim.json）
//  getMeta(id)       models:getMeta          UNGATED   → 完整 ModelMeta（合并覆盖层）| null
//  exportModel(o)    models:export           gate      {id, glb, gmdf?, satsimJson?, suggestedName} → {ok:true, path} | {ok:false, code:'not-redistributable'|'canceled'|'missing'|'bad-glb', error?}
//  saveThumb(o)      models:saveThumb        gate      {id, webp: Uint8Array} → {ok, sha256}
//  bindingsGet()     models:bindings:get     UNGATED   → {schema, prefs, bindings, corrupt?}
//  bindingsSet(o)    models:bindings:set     gate      {satKey, binding|null} | {prefs} → {ok, code?, errors?}
//  saveMask(o)       models:saveMask         gate      {sig, bytes: Uint8Array(.bin)} | {sig, blocked: Uint8Array, clearance: Float32Array}
//                                                       → {ok:true, sig, bytes} | {ok:false, code:'bad-sig'|'bad-mask'|'write', error?}（二期 D18，格式 = mask.mjs encodeMask）
//  getMask(sig)      models:getMask          gate      → Uint8Array（.bin 原样，渲染端 decodeMask）| null（签名非法 / 没有 / 坏文件拒读）
//  exportTable(o)    models:exportTable      gate      {sheets:[{name, cols:[{key, label, unit?, num?, fix?, align?}], rows:[{key: 值} | [值]], note?}], defaultName?, title?, style?:'report'|'plain'}
//                                                       表也可列式给：{name, cols, n, columns:[数组 | Float64Array | {join: U+001F 连起来的串}]}（preload 给 > 2000 行的表自动打包）
//                                                       → 另存 xlsx（gridXlsx 的三线表 / 朴素两档，缺省 report；合计 > 5000 行改走同版式的流式写，边写边让出事件循环）
//                                                       | {format:'csv', text} 或 {format:'csv', sheets:[一张]} → 另存 .csv（含非 ASCII 时带 BOM，Excel 才认 UTF-8）
//                                                       → {ok:true, filePath} | {ok:false, canceled?, error?}
//  onChanged(cb)     models:changed          —         广播 {type:'manifest'|'download'|'import'|'meta'|'bindings'|'cache', …}；返回取消函数
//                                                       download 事件：{id, lod, sha, phase, received, total, url?, message?}，phase ∈
//                                                       downloading | verifying | ready | waiting（退避）| error | canceled | queued（给小件让道，稍后续传）
//  所有出参是纯数据；Buffer 到渲染端是 Uint8Array。失败一律回 {ok:false, …}，不抛（被 gate 挡时是 {locked:true}）。
//
// ─────────────────────────────── 目录 ───────────────────────────────
//  <userData>/models/            SATSIM_MODELS_DIR 覆盖
//     blobs/<sha256>.glb|.webp   远端下载缓存（LRU，上限默认 2 GiB，只它计入）；下载中为 <名>.part
//     user/<sha256>.glb + .satsim.json   本机导入（用户 glb / CAD / STK / 渲染端转好的 OBJ·STL·FBX / 参数化另存）
//     thumbs/<sha256>.webp       本机生成的缩略图
//     overrides/<id 转义>.satsim.json    远端 / 内置模型的本机改写层
//     masks/<sig>.bin            本体遮挡掩模（D18：头 16 B 'SMSK'·ver·w·h + Uint8 blocked + Float32 clearance，325 816 B）；
//                                绑定里没人引用、又超过 MASK_KEEP 张时按修改时间从旧往新清
//     state.json                {cap, etag, lastRefresh, entries:{<sha>.<ext>:{lastUsed}}}
//     manifest.remote.json       远端 manifest（校验过的那份）
//  <userData>/models.bindings.json · <userData>/models.log（与 models/ 同级）
//  <resources>/models/           SATSIM_MODELS_BUNDLE_DIR 覆盖：manifest.json、builtin/<sha>.glb、thumbs/<sha>.webp
//  SATSIM_MODELS_OFFLINE=1       彻底不联网（单测 / 离线验收）
//
// ─────────────────────────────── 远端 ───────────────────────────────
//  cdnBase 钉死（packages/core/models/manifest.mjs 的 CDN_BASE），远端 manifest 里写什么地址都不认。
//  启动 30 s 后刷一次、之后每 24 h；ETag / If-None-Match；失败静默只写日志。
//  下载：Electron net（跟系统代理）→ 退回 Node https；并发 2、30 s 无数据即超时、失败退避重试 3 次；
//  Range 续传 .part；整文件 sha256 对上才原子 rename 成正式文件。排队按优先级（lod2 < thumb < lod1 < lod0），
//  两条道全被大件占着时让一个大件让道给小件（.part 留着续传），见 modelsLogic.pickPreempt。
//
// ─────────────────────────────── 授权（设计契约 §0.1 四道闸）───────────────────────────────
//  STK 的东西一律 stk-local / redistributable=false，不论从哪条路进来：从 STK 导入、普通导入（路径 / 拖放字节）、
//  渲染端转一手再 saveImported（拒收）、经 readFile 读进渲染端（拒读）。判据见 stkVerdict：JSON 块（署名 / AGI 扩展无 extras.satsim / 自声明）、
//  来源路径（STK 安装树）、字节（等于本机 STK 目录里某个文件）。已入库的件在建目录时按新判据补收紧。
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const { pathToFileURL } = require('url')
const L = require('./modelsLogic')
const imp = require('./modelsImport')
const { createFileLogger } = require('./fileLog')
const { writeJsonAtomic, readJsonSafe } = require('./jsonStore')

// 与 manifest.mjs 的 CDN_BASE 同值；ESM 还没加载完（或加载失败）时的兜底。单测对账两者一致。
const CDN_BASE_PINNED = 'https://update-1385987144.cos.ap-beijing.myqcloud.com/updates/models/'
const CONCURRENCY = 2
const IDLE_TIMEOUT_MS = 30 * 1000
const REFRESH_FIRST_MS = 30 * 1000
const REFRESH_EVERY_MS = 24 * 60 * 60 * 1000
const PROGRESS_MIN_MS = 200
const ERROR_HOLD_MS = 60 * 1000                 // 下载失败后 60 s 内再 ensure 直接回错误，不重复打网络
const STREAM_ABOVE = 4 * 1024 * 1024           // 协议响应大于 4 MB 走流
const MAX_BLOB_BYTES = 1024 * 1024 * 1024      // 单个远端文件上限（ISS lod0 约 91 MB，1 GiB 远够）
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024
const MAX_READ_BYTES = 1024 * 1024 * 1024      // models:readFile 单文件上限
const MAX_THUMB_BYTES = 8 * 1024 * 1024
const STALE_PART_MS = 7 * 24 * 60 * 60 * 1000   // 没有任务认领、7 天没动过的 .part 清掉
// CAD 导入同时只跑 1 个 worker：每个 worker 自带 7.6 MB wasm + 几百 MB 网格化堆，一次拖进 8 个大装配体
// 若同时起 8 个，主进程内存峰值成倍涨；排队的照样能被 cancel(token) 取消
const CAD_CONCURRENCY = 1
// STK 目录遍历上限：用户可能在 pickStkDir 里选了 C:\ 这种大目录。遍历走异步 I/O（不堵主进程），
// 访问的目录数 / 深度 / 文件数封顶，超了就停并在结果里标 truncated
const STK_WALK = { maxDepth: 8, maxDirs: 2000, maxFiles: 5000 }
const STK_INDEX_TTL_MS = 10 * 60 * 1000          // 本机 STK 文件清单（按大小比对字节用）缓存 10 分钟
// 掩模（D18）：每张 325 816 B。masks/ 目录超过 MASK_KEEP 张时，绑定里没人引用的按修改时间从旧往新清（512 张 ≈ 160 MB）；
// 刚写的（MASK_GRACE_MS 内）不清：工作台是先存 .bin、再写绑定（对日扫描一次存 12 张），中间这段时间它们还没人引用
const MASK_KEEP = 512
const MASK_GRACE_MS = 10 * 60 * 1000
const MASK_SIG_RE = /^[0-9a-f]{16,128}$/          // 与 schema.mjs 的 MASK_SIG_RE 同一条（单测对账）：签名直接拼文件名，只收小写十六进制
const MODEL_EXTS = ['glb', 'gltf', 'obj', 'stl', 'fbx', 'step', 'stp', 'iges', 'igs', 'brep']
// models:readFile 放行的扩展名：模型本身 + OBJ 的 .mtl / glTF 的 .bin + 贴图。别的一律不给读
// （这条通道是给渲染端解析 OBJ/STL/FBX 用的，不是通用文件读取器）。
const READ_EXTS = new Set([...MODEL_EXTS, 'mtl', 'bin', 'png', 'jpg', 'jpeg', 'webp', 'tga', 'bmp', 'gif', 'tif', 'tiff', 'dds', 'ktx2'])
// saveMeta 允许渲染端改的字段。id / source / files 永远以主进程记录为准：
// source.redistributable 是授权闸的依据，渲染端不许把 STK 模型改成「可再分发」。
const EDITABLE = ['title', 'titleZh', 'kind', 'group', 'fidelity', 'spec', 'units', 'frame', 'geometry', 'parts', 'massProps',
  'attachPoints', 'articulations', 'solarPanelGroups', 'noObscurationNodes', 'tags', 'aliases', 'nodeNameMap']
// 装配件（asm:）的 saveMeta 只收这几项：spec / frame / geometry / parts / massProps / 挂点 / 关节 / 太阳翼组都由装配文档生成、
// 与 glb 同步，只能经 saveImported 随 glb 一起变——杜绝「spec 新、glb 旧」（P3 契约 §2.6-5）
const ASM_META_EDITABLE = ['title', 'titleZh', 'tags', 'aliases']
// 装配件 id（与 assembly.mjs ASM_ID_RE、schema.mjs ID_RULES 的 asm 同式；单测对账）
const ASM_ID_RE = /^asm:[0-9a-f]{12}$/
// 导入件带着我们自己导出过的 extras.satsim 时直接采用的字段（任务书 §4.3：带 massProps 就用）
const ADOPT_FROM_EXTRAS = ['titleZh', 'kind', 'group', 'units', 'frame', 'parts', 'massProps', 'attachPoints', 'articulations',
  'solarPanelGroups', 'noObscurationNodes', 'tags', 'aliases', 'nodeNameMap']

const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const errText = (e) => (e && e.message) || String(e)
const toU8 = (v) => {
  if (!v) return null
  if (v instanceof Uint8Array) return v
  if (v instanceof ArrayBuffer) return new Uint8Array(v)
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  return null
}
const extOf = (p) => { const m = /\.([A-Za-z0-9]+)$/.exec(String(p || '')); return m ? m[1].toLowerCase() : '' }

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')))
  })
}
// 先写满 .tmp 再 rename：崩溃至多丢本次，不会留下半截 glb 被当成完整件
function writeFileAtomic(file, bytes) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, bytes)
  fs.renameSync(tmp, file)
}
const statOr = (f) => { try { return fs.statSync(f) } catch { return null } }
// 读文件头 n 字节为文本（STEP 单位实体在 DATA 段靠前，不必整份读）
function readHead(file, n) {
  const fd = fs.openSync(file, 'r')
  try { const b = Buffer.alloc(n); const k = fs.readSync(fd, b, 0, n, 0); return b.subarray(0, k).toString('latin1') } finally { fs.closeSync(fd) }
}
const isFile = (f) => { const s = statOr(f); return !!(s && s.isFile()) }
const rmQuiet = (f) => { try { fs.unlinkSync(f); return true } catch { return false } }

// 异步递归列出 dir 下的 .glb（STK 扫描 / 本机 STK 字节比对共用）。
// 走 fs.promises：用户选了 C:\ 也只是慢慢列，不会把主进程（= 所有窗口的 IPC）卡住几十秒；
// 访问目录数、深度、文件数三项封顶，任一到顶就停，truncated=true。符号链接 / 目录联接不跟（防环）。
async function walkGlbFiles(dir, lim = STK_WALK) {
  const maxDepth = lim.maxDepth ?? STK_WALK.maxDepth, maxDirs = lim.maxDirs ?? STK_WALK.maxDirs, maxFiles = lim.maxFiles ?? STK_WALK.maxFiles
  const files = []
  let dirs = 0
  let truncated = false
  const stack = [{ p: dir, depth: 0 }]
  while (stack.length) {
    const { p, depth } = stack.pop()
    if (dirs >= maxDirs) { truncated = true; break }
    dirs++
    let ents
    try { ents = await fsp.readdir(p, { withFileTypes: true }) } catch { continue }
    const sub = []
    for (const e of ents) {
      if (e.isDirectory()) {
        if (depth + 1 > maxDepth) { truncated = true; continue }
        sub.push({ p: path.join(p, e.name), depth: depth + 1 })
      } else if (e.isFile() && /\.glb$/i.test(e.name)) {
        if (files.length >= maxFiles) { truncated = true; break }
        files.push(path.join(p, e.name))
      }
    }
    if (files.length >= maxFiles && truncated) break
    // 倒序压栈 = 按目录项原顺序深度优先（列表顺序与旧的同步实现一致，结果最后还会按 rel 排序）
    for (let i = sub.length - 1; i >= 0; i--) stack.push(sub[i])
  }
  return { files, truncated, dirs }
}

function createModels(opts = {}) {
  const appRoot = opts.appRoot || path.join(__dirname, '..', '..')
  const modelsDir = process.env.SATSIM_MODELS_DIR || path.join(opts.userDataDir || path.join(appRoot, '.userdata'), 'models')
  const bundleDir = process.env.SATSIM_MODELS_BUNDLE_DIR || opts.bundleDir || path.join(appRoot, 'resources', 'models')
  const baseDir = path.dirname(modelsDir)
  const bindingsFile = path.join(baseDir, 'models.bindings.json')
  const coreDir = opts.coreModelsDir || path.join(appRoot, 'packages', 'core', 'models')
  const E = opts.electron || {}
  const log = opts.log || createFileLogger(path.join(baseDir, 'models.log'))
  const offline = () => process.env.SATSIM_MODELS_OFFLINE === '1'
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  // 以下两项只给单测：退避时间缩放（别让重试把单测拖成 10 s）、缓存上限的下限（小夹具才测得到淘汰）
  const retryScale = Number.isFinite(opts.retryScale) && opts.retryScale >= 0 ? opts.retryScale : 1
  const minCap = Number.isFinite(opts.minCacheCap) && opts.minCacheCap >= 0 ? opts.minCacheCap : L.CAP_MIN
  // 只给单测：把「默认 STK 目录」指到临时目录（别让单测去碰本机真 STK 安装）
  const stkDefaultOverride = typeof opts.stkDefaultDir === 'string' && opts.stkDefaultDir ? opts.stkDefaultDir : null
  const stkWalkLimits = opts.stkWalk && typeof opts.stkWalk === 'object' ? { ...STK_WALK, ...opts.stkWalk } : STK_WALK
  // 只给单测：掩模目录的留存张数与保护期（真实 512 张 × 325 KB，单测造不起）
  const maskKeep = Number.isInteger(opts.maskKeep) && opts.maskKeep >= 0 ? opts.maskKeep : MASK_KEEP
  const maskGraceMs = Number.isFinite(opts.maskGraceMs) && opts.maskGraceMs >= 0 ? opts.maskGraceMs : MASK_GRACE_MS
  // 只给单测：表格导出从多少行起改走流式写（缺省 TABLE_STREAM_ROWS；小夹具才测得到流式那条路）
  const tableStreamRows = Number.isInteger(opts.tableStreamRows) && opts.tableStreamRows >= 0 ? opts.tableStreamRows : TABLE_STREAM_ROWS
  const dir = {
    blobs: path.join(modelsDir, 'blobs'),
    user: path.join(modelsDir, 'user'),
    thumbs: path.join(modelsDir, 'thumbs'),
    overrides: path.join(modelsDir, 'overrides'),
    masks: path.join(modelsDir, 'masks'),
    state: path.join(modelsDir, 'state.json'),
    remote: path.join(modelsDir, 'manifest.remote.json')
  }
  const mk = (d) => { fs.mkdirSync(d, { recursive: true }); return d }

  /* ─────────────── packages/core/models/*.mjs（ESM）懒加载 ─────────────── */
  const _mods = {}
  const loadMod = (name) => {
    if (_mods[name]) return _mods[name]
    const p = import(pathToFileURL(path.join(coreDir, name + '.mjs')).href)
    _mods[name] = p
    p.then((m) => { _mods[name + ':v'] = m }, (e) => { delete _mods[name]; log.error(`[models] 加载 ${name}.mjs 失败：${errText(e)}`) })
    return p
  }
  let _core = null
  const core = () => _core || (_core = Promise.all(['manifest', 'glb', 'agi', 'schema', 'units', 'bodyFrame'].map(loadMod))
    .then(([M, G, A, S, U, B]) => ({ M, G, A, S, U, B }))
    .catch((e) => { _core = null; throw e }))
  core().catch(() => {})   // 先捅一下：协议 handler 首个请求到来时多半已加载好
  const cdnBase = () => {
    // opts.cdnBase 只给单测（本机回环服务器）用；main.js 从不传。远端 manifest 里的地址一概不认
    if (opts.cdnBase) return opts.cdnBase
    const M = _mods['manifest:v']
    return (M && typeof M.CDN_BASE === 'string' && M.CDN_BASE) || CDN_BASE_PINNED
  }

  /* ─────────────── 事件 ─────────────── */
  const listeners = new Set()
  const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
  const emit = (ev) => { for (const fn of listeners) { try { fn(ev) } catch { /* 监听方自己的事 */ } } }

  /* ─────────────── state.json（LRU 账本 / 上限 / ETag） ─────────────── */
  let _state = null
  let _stateTimer = null
  const state = () => {
    if (!_state) _state = L.normalizeState(readJsonSafe(dir.state, null).value, minCap)
    return _state
  }
  const setState = (s) => {
    _state = s
    // 防抖落盘：ensure 在 3D 页可能一秒调几十次，每次都写 state.json 纯属磨盘
    clearTimeout(_stateTimer)
    _stateTimer = setTimeout(flushState, 1000)
    if (_stateTimer.unref) _stateTimer.unref()
  }
  function flushState() {
    clearTimeout(_stateTimer); _stateTimer = null
    if (!_state) return
    try { mk(modelsDir); writeJsonAtomic(dir.state, _state, 0) } catch (e) { log.warn(`[models] 写 state.json 失败：${errText(e)}`) }
  }

  /* ─────────────── 目录（内置 < 远端 < 本机）与覆盖层 ─────────────── */
  // 目录缓存。构建里有 await（补收紧 STK 件要读 glb 头），所以：进行中的构建共享一个 promise；
  // 构建期间被 invalidate 过的结果不进缓存（代数不符），下一个调用方重新构建
  let _cat = null
  let _catP = null
  let _catGen = 0
  const invalidate = () => { _cat = null; _catP = null; _catGen++ }
  function catalog() {
    if (_cat) return Promise.resolve(_cat)
    if (_catP) return _catP
    const gen = _catGen
    const p = buildCatalog().then(
      (c) => { if (gen === _catGen) _cat = c; if (_catP === p) _catP = null; return c },
      (e) => { if (_catP === p) _catP = null; throw e })
    _catP = p
    return p
  }

  function readMetaFile(f) {
    const r = readJsonSafe(f, null)
    return r.value && typeof r.value === 'object' && !Array.isArray(r.value) ? r.value : null
  }
  function overrideFile(id) { return path.join(dir.overrides, L.idToFileStem(id) + '.satsim.json') }

  async function buildCatalog() {
    const { M, S } = await core()
    // 内置 / 远端各过一遍 validateManifest：坏条目丢弃并记日志，整份只在结构不对时不用（内置永远保底）
    const vm = (m, opts, label) => {
      if (!m) return []
      const v = M.validateManifest(m, opts)
      if (v.errors && v.errors.length) log.warn(`[models] ${label} manifest：${v.errors.slice(0, 5).join('；')}${v.errors.length > 5 ? ` 等 ${v.errors.length} 条` : ''}`)
      return v.ok ? v.models : []
    }
    const builtin = vm(readJsonSafe(path.join(bundleDir, 'manifest.json'), null).value, { builtin: true }, '内置')
    const remote = vm(readJsonSafe(dir.remote, null).value, { remote: true }, '远端')
    // 本机导入：user/*.satsim.json 逐个读、过 normalizeMeta
    const userFiles = new Map()   // id → { meta 文件, glb 文件, sha, meta, shadowed:[{metaFile, glbFile}] }
    let names = []
    try { names = fs.readdirSync(dir.user) } catch { /* 还没导入过 */ }
    for (const n of names) {
      if (!/^[0-9a-f]{64}\.satsim\.json$/.test(n)) continue
      const metaFile = path.join(dir.user, n)
      const raw = readMetaFile(metaFile)
      if (!raw || typeof raw.id !== 'string') continue
      let meta = S.normalizeMeta(raw)
      const sha = n.slice(0, 64)
      const glbFile = path.join(dir.user, sha + '.glb')
      // 授权口径只许收紧：判据是后来加严的（2026-09-23 补了「AGI 扩展 + 无 extras.satsim」与本机 STK
      // 字节比对），之前按旧判据入库成 user 的 STK 件要在这里补收紧。结论按 sha 缓存（内容寻址，永不变）
      if (meta.source.kind !== 'stk-local') {
        const reason = await stkVerdictForFile(sha, glbFile)
        if (reason) {
          meta = S.normalizeMeta({ ...meta, source: stkSource(), updatedAt: new Date(now()).toISOString() })
          try { writeJsonAtomic(metaFile, meta, 2) } catch { /* 写不进也照样按 STK 用 */ }
          log.info(`[models] ${meta.id} 判为 STK 本机件（${reason}）：改为不可再分发`)
        }
      }
      const cur = { metaFile, glbFile, sha, meta, shadowed: [] }
      const prev = userFiles.get(meta.id)
      if (!prev) { userFiles.set(meta.id, cur); continue }
      // 同一 id 两份文件（参数化另存同一 spec 两次、字节不同）：留新的，旧的记作 shadowed，
      // remove 时一起删 —— mergeManifests 与 userFiles 必须指向同一份，否则清单与删除对不上
      const newer = String(meta.updatedAt || '') > String(prev.meta.updatedAt || '') ? cur : prev
      const older = newer === cur ? prev : cur
      newer.shadowed = [...prev.shadowed, ...cur.shadowed, { metaFile: older.metaFile, glbFile: older.glbFile }]
      userFiles.set(meta.id, newer)
    }
    const userMetas = [...userFiles.values()].map((u) => u.meta)
    // 同 id：本机 > 远端 > 内置。上层盖住内置条目后，mergeManifests 仍把随包那几档记在 builtinFiles 里
    //（远端重建过、sha 变了，内置那份也能先顶着显示——契约 §3.3）
    const merged = M.mergeManifests({ builtin, remote, user: userMetas })
    const builtinLods = new Map()
    for (const e of merged) {
      const byLod = {}
      for (const l of L.LODS) { const f = e.builtinFiles && e.builtinFiles[l]; if (f && L.SHA_RE.test(String(f.sha256 || ''))) byLod[l] = f.sha256 }
      if (Object.keys(byLod).length) builtinLods.set(e.id, byLod)
    }
    const list = []
    const byId = new Map()
    const baseById = new Map()   // 远端 / 内置条目未盖覆盖层的底版（saveMeta 算差量用）
    for (const m0 of merged) {
      let m = m0
      if (!userFiles.has(m.id)) {
        baseById.set(m.id, m0)
        const ov = readMetaFile(overrideFile(m.id))
        if (ov) m = applyOverride(m, ov)
      }
      list.push(m); byId.set(m.id, m)
    }
    // 装配件的授权随引用件传递（只许收紧）：入库那一刻引用件都可分发，之后引用件被补判为 STK 本机件 / 从目录里没了 →
    // 装配件本身跟着改成不可分发（kind 仍是 user，满足 asm 前缀的来源约束）并回写，四道闸（云端 / 分享包 / 报告附件 / 导出）一次都收紧
    for (const [id, u] of userFiles) {
      if (!ASM_ID_RE.test(id)) continue
      const m = byId.get(id)
      if (!m || !m.source || m.source.redistributable === false) continue
      const bad = S.asmModelRefs(m.spec).find((rid) => { const r = byId.get(rid); return !r || !S.isRedistributable(r) })
      if (bad === undefined) continue
      const next = S.normalizeMeta({ ...u.meta, source: { kind: 'user', url: '', credit: '', license: '含不可分发件', redistributable: false }, updatedAt: new Date(now()).toISOString() })
      try { writeJsonAtomic(u.metaFile, next, 2) } catch { /* 写不进也照样按不可分发用 */ }
      u.meta = next
      const nm = { ...m, source: next.source, updatedAt: next.updatedAt }
      const i = list.indexOf(m)
      if (i >= 0) list[i] = nm
      byId.set(id, nm)
      log.info(`[models] 装配件 ${id} 引用的 ${JSON.stringify(bad)} 不可再分发：装配件改为不可分发`)
    }
    const stkShas = new Set()
    for (const [id, u] of userFiles) { const m = byId.get(id); if (m && m.source && m.source.kind === 'stk-local') stkShas.add(u.sha) }
    return { list, byId, baseById, userFiles, builtinLods, stkShas }
  }
  function applyOverride(m, ov) {
    const out = { ...m }
    for (const k of EDITABLE) if (ov[k] !== undefined) out[k] = ov[k]
    // 缩略图是本机重拍的：只许覆盖 files.thumb 一格
    if (ov.files && ov.files.thumb && L.SHA_RE.test(String(ov.files.thumb.sha256 || ''))) out.files = { ...(m.files || {}), thumb: ov.files.thumb }
    if (typeof ov.updatedAt === 'string') out.updatedAt = ov.updatedAt
    return out
  }

  /* ─────────────── 本机就绪状态与 URL ─────────────── */
  // 某档从哪来（已就绪才返回）：本机导入 → user/；随包 → builtin/；远端缓存 → blobs/
  function lodSource(cat, m, lod) {
    const u = cat.userFiles.get(m.id)
    const f = m.files && m.files[lod]
    if (u) {
      if (f && L.SHA_RE.test(String(f.sha256 || '')) && isFile(path.join(dir.user, f.sha256 + '.glb'))) return { host: 'user', sha: f.sha256 }
      return null
    }
    const b = cat.builtinLods.get(m.id)
    const hasB = !!(b && b[lod] && isFile(path.join(bundleDir, 'builtin', b[lod] + '.glb')))
    const cur = f && L.SHA_RE.test(String(f.sha256 || '')) ? f.sha256 : null
    if (hasB && b[lod] === cur) return { host: 'builtin', sha: cur }
    if (cur && isFile(path.join(dir.blobs, cur + '.glb'))) return { host: 'blobs', sha: cur }
    // 远端重建过、sha 变了且新版还没下：随包那份仍可顶着用（契约 §3.3「内置文件仍可作为 lod2 来源」）
    if (hasB) return { host: 'builtin', sha: b[lod] }
    return null
  }
  // 缩略图从哪来：本机重拍 / 随包 → thumbs 主机（协议里先本机后内置）；远端下载的 → blobs 主机
  function thumbSource(m) {
    const t = m && m.files && m.files.thumb
    if (!t || !L.SHA_RE.test(String(t.sha256 || ''))) return null
    if (isFile(path.join(dir.thumbs, t.sha256 + '.webp')) || isFile(path.join(bundleDir, 'thumbs', t.sha256 + '.webp'))) return { host: 'thumbs', sha: t.sha256 }
    if (isFile(path.join(dir.blobs, t.sha256 + '.webp'))) return { host: 'blobs', sha: t.sha256 }
    return null
  }
  function localStatus(cat, m) {
    const st = {}
    for (const l of L.LODS) {
      if (lodSource(cat, m, l)) st[l] = 'ready'
      else {
        const f = m.files && m.files[l]
        if (f && L.SHA_RE.test(String(f.sha256 || '')) && isFile(path.join(dir.blobs, f.sha256 + '.glb.part'))) st[l] = 'partial'
      }
    }
    if (thumbSource(m)) st.thumb = 'ready'
    // 随包带了哪几档（含 'thumb'）：mergeManifests 从内置层带上来的，远端盖住内置条目后仍在
    if (Array.isArray(m.builtin) && m.builtin.length) st.builtin = m.builtin.slice()
    return st
  }

  /* ─────────────── manifest / cacheInfo ─────────────── */
  async function manifest() {
    const cat = await catalog()
    const models = cat.list.map((m) => ({ ...plain(m), local: localStatus(cat, m) }))
    const info = cacheInfo()
    return { models, prefs: (await bindingsGet()).prefs, cache: { bytes: info.bytes, cap: info.cap } }
  }
  function blobEntries() {
    let names = []
    try { names = fs.readdirSync(dir.blobs) } catch { return [] }
    const out = []
    for (const n of names) {
      if (!L.PROTOCOL_PATH_RE.test(n)) continue
      const s = statOr(path.join(dir.blobs, n))
      if (s && s.isFile()) out.push({ key: n, bytes: s.size, mtime: s.mtimeMs })
    }
    return out
  }
  function cacheInfo() {
    const e = blobEntries()
    let bytes = 0
    for (const x of e) bytes += x.bytes
    return { bytes, cap: state().cap, count: e.length }
  }
  function setCacheCap(b) {
    setState({ ...state(), cap: L.clampCap(b, minCap) })
    flushState()
    evict()
    const info = cacheInfo()
    emit({ type: 'cache', ...info })
    return info
  }

  /* ─────────────── LRU 淘汰 ─────────────── */
  const lastEnsure = new Map()   // blob key → 最近一次 ensure 的时刻（= 正在显示）
  function evict() {
    const t = now()
    const st = state()
    const busy = new Set()
    for (const j of jobs.values()) if (!['ready', 'error', 'canceled'].includes(j.st.phase)) busy.add(j.key)
    const entries = blobEntries().map((e) => ({ key: e.key, bytes: e.bytes, lastUsed: (st.entries[e.key] && st.entries[e.key].lastUsed) || e.mtime || 0, lastEnsure: lastEnsure.get(e.key) }))
    const { evict: out, total, after } = L.pickEvictions(entries, { cap: st.cap, now: t, busy })
    for (const k of out) { try { fs.unlinkSync(path.join(dir.blobs, k)) } catch { /* 被占用：下次再说 */ } }
    if (out.length) {
      setState(L.dropState(state(), out))
      log.info(`[models] 缓存超上限（${total} > ${st.cap}）：淘汰 ${out.length} 个，剩 ${after} 字节`)
      invalidate()
    }
    // 孤儿 .part：没有任务认领、7 天没动过
    let names = []
    try { names = fs.readdirSync(dir.blobs) } catch { /* 无 */ }
    for (const n of names) {
      if (!n.endsWith('.part') || jobs.has(n.slice(0, -5))) continue
      const s = statOr(path.join(dir.blobs, n))
      if (s && t - s.mtimeMs > STALE_PART_MS) { try { fs.unlinkSync(path.join(dir.blobs, n)) } catch { /* 无 */ } }
    }
    return out
  }

  /* ─────────────── 网络：Electron net 优先，退回 Node http(s) ─────────────── */
  // 流式 GET。handlers：{ onResponse(status, headers), onData(buf), onEnd(), onError(err) }；返回 abort()。
  // ★ 30 s 是「无数据」超时而不是总时长：91 MB 的 lod0 在慢网上几分钟是正常的，只要字节在走就不掐。
  function streamGet(url, headers, h) {
    let done = false
    let timer = null
    let abortReq = () => {}
    const fin = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn && fn(v) }
    const kick = () => {
      clearTimeout(timer)
      timer = setTimeout(() => { try { abortReq() } catch {} ; fin(h.onError, new Error('网络超时（30 s 无数据）')) }, IDLE_TIMEOUT_MS)
    }
    const hooks = {
      response: (s, hd) => { if (!done) { kick(); h.onResponse(s, hd) } },
      data: (c) => { if (!done) { kick(); h.onData(c) } },
      end: () => fin(h.onEnd),
      error: (e) => fin(h.onError, e)
    }
    kick()
    const net = E.net
    if (net && typeof net.request === 'function') {
      const req = net.request({ method: 'GET', url, redirect: 'follow' })
      for (const k of Object.keys(headers)) req.setHeader(k, headers[k])
      req.on('response', (res) => {
        hooks.response(res.statusCode, res.headers)
        res.on('data', (c) => hooks.data(Buffer.from(c)))
        res.on('end', hooks.end)
        res.on('error', hooks.error)
      })
      req.on('error', hooks.error)
      abortReq = () => req.abort()
      try { req.end() } catch (e) { hooks.error(e) }
    } else {
      const go = (u, hops) => {
        const lib = u.startsWith('https:') ? require('https') : require('http')
        const req = lib.get(u, { headers }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 3) {
            res.resume()
            return go(new URL(res.headers.location, u).href, hops + 1)
          }
          hooks.response(res.statusCode, res.headers)
          res.on('data', hooks.data)
          res.on('end', hooks.end)
          res.on('error', hooks.error)
        })
        req.on('error', hooks.error)
        abortReq = () => req.destroy()
      }
      go(url, 0)
    }
    return () => { try { abortReq() } catch {} ; fin(h.onError, Object.assign(new Error('已取消'), { canceled: true })) }
  }
  // 小文件整取（manifest）：→ { status, headers, body }
  function getSmall(url, headers) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0, status = 0, hd = {}
      const abort = streamGet(url, headers, {
        onResponse: (s, h) => { status = s; hd = h },
        onData: (c) => { size += c.length; if (size > MAX_MANIFEST_BYTES) abort(); else chunks.push(c) },
        onEnd: () => resolve({ status, headers: hd, body: Buffer.concat(chunks) }),
        onError: reject
      })
    })
  }

  /* ─────────────── 下载队列 ─────────────── */
  const jobs = new Map()          // blob key（<sha>.glb）→ job
  const failedAt = new Map()      // blob key → { at, message }
  let active = 0
  let jobSeq = 0                  // 新任务排本档队尾
  let frontSeq = 0                // 已在排队的被再次 ensure：挪到本档队首（负数，越新越靠前）
  let startSeq = 0                // 开工顺序（让道时挑最后开工的；不用时钟，同一毫秒开工的两件也分得出先后）

  function jobEmit(j, force) {
    if (!j.throttle(now(), force)) return
    const url = j.st.phase === 'ready' ? L.modelsUrl('blobs', j.sha, j.ext) : undefined
    for (const [id, lod] of j.owners) {
      const ev = { type: 'download', id, lod, sha: j.sha, phase: j.st.phase, received: j.st.received, total: j.st.total || j.bytes }
      if (url) ev.url = url
      if (j.st.message && j.st.phase !== 'ready') ev.message = j.st.message
      emit(ev)
    }
  }
  function jobSet(j, ev) {
    const next = L.dlReduce(j.st, ev)
    if (next === j.st) return
    const phaseChanged = next.phase !== j.st.phase
    j.st = next
    jobEmit(j, phaseChanged)
  }
  function enqueue(m, lod) {
    const f = m.files[lod]
    const ext = lod === 'thumb' ? 'webp' : 'glb'
    const key = f.sha256 + '.' + ext
    let j = jobs.get(key)
    if (j && ['ready', 'error', 'canceled'].includes(j.st.phase)) { jobs.delete(key); j = null }
    const prio = L.dlPriority(lod)
    if (!j) {
      j = {
        key, sha: f.sha256, ext, bytes: Number(f.bytes) || 0,
        url: cdnBase() + 'blobs/' + key,
        dest: path.join(dir.blobs, key), part: path.join(dir.blobs, key + '.part'),
        owners: new Map(), st: L.dlInitial(), abort: null, retryTimer: null, throttle: L.makeThrottle(PROGRESS_MIN_MS),
        prio, seq: ++jobSeq, running: false, preempting: false, startedAt: 0
      }
      jobs.set(key, j)
      log.info(`[models] 排队下载 ${m.id} ${lod} ${key}（${j.bytes} 字节）`)
    } else {
      // 同一个文件被更急的档要了（lod1 的 blob 恰好也是别的条目的 lod2）→ 提档；还在排队 → 挪到本档队首
      if (prio < j.prio) j.prio = prio
      if (j.st.phase === 'queued') j.seq = --frontSeq
    }
    j.owners.set(m.id, lod)
    pump()
    return j
  }
  function pump() {
    for (;;) {
      const queued = []
      for (const q of jobs.values()) if (q.st.phase === 'queued' && !q.running) queued.push(q)
      const next = L.pickNextJob(queued)
      if (!next) return
      if (active < CONCURRENCY) { runJob(next); continue }
      // 两条道都占着：小件在等、道上全是大件 → 让最后开工的大件让道（见 modelsLogic.pickPreempt）
      const running = []
      for (const q of jobs.values()) if (q.running) running.push({ job: q, prio: q.prio, phase: q.st.phase, startedAt: q.startedAt, preempting: q.preempting })
      const v = L.pickPreempt(running, next)
      if (v) preempt(v.job)
      return
    }
  }
  // 让道：掐断连接，.part 留着。相位在 runJob 收到中断时才改回 queued（见 runJob 的 catch）——
  // 若恰在这一刻已经下完（fetchToPart 已 resolve），就照常校验落盘，不算让道
  function preempt(j) {
    if (!j.abort || j.preempting) return
    j.preempting = true
    log.info(`[models] ${j.key} 给小件让道（已收 ${j.st.received} 字节，稍后续传）`)
    try { j.abort() } catch { /* 已结束 */ }
  }
  async function runJob(j) {
    active++
    j.running = true
    j.startedAt = ++startSeq
    jobSet(j, { type: 'start' })
    try {
      mk(dir.blobs)
      await fetchToPart(j)
      if (j.st.phase === 'canceled') return
      jobSet(j, { type: 'done' })
      const got = await sha256File(j.part)
      if (got !== j.sha) {
        try { fs.unlinkSync(j.part) } catch {}
        throw Object.assign(new Error('sha256 不符'), { retriable: true })
      }
      fs.renameSync(j.part, j.dest)
      setState(L.touchState(state(), j.key, now()))
      jobSet(j, { type: 'verified' })
      failedAt.delete(j.key)
      log.info(`[models] 下载完成 ${j.key}`)
      invalidate()
      evict()
      emit({ type: 'cache', ...cacheInfo() })
    } catch (e) {
      if (j.st.phase === 'canceled') {
        log.info(`[models] 已取消 ${j.key}（保留 .part 续传）`)
      } else if (j.preempting && e && e.canceled) {
        jobSet(j, { type: 'preempt' })   // → queued：不算失败、不耗重试次数；轮到时 Range 续传
      } else if (e && e.canceled) {
        log.info(`[models] 已取消 ${j.key}（保留 .part 续传）`)
      } else {
        jobSet(j, { type: 'fail', message: errText(e), retriable: e && e.retriable === false ? false : undefined })
        log.warn(`[models] 下载失败 ${j.key}：${errText(e)}（第 ${j.st.attempt} 次，${j.st.phase}）`)
        if (j.st.phase === 'waiting') {
          j.retryTimer = setTimeout(() => { jobSet(j, { type: 'retry' }); pump() }, L.retryDelay(j.st.attempt) * retryScale)
          if (j.retryTimer.unref) j.retryTimer.unref()
        } else if (j.st.phase === 'error') {
          failedAt.set(j.key, { at: now(), message: j.st.message })
        }
      }
    } finally {
      active--
      j.running = false
      j.preempting = false
      j.abort = null
      pump()
    }
  }
  // 拉到 .part：已有 .part 就带 Range 续传；服务端不认 Range（回 200）就从头写
  function fetchToPart(j) {
    return new Promise((resolve, reject) => {
      let start = 0
      const ps = statOr(j.part)
      if (ps && ps.isFile()) start = ps.size
      if (j.bytes && start > j.bytes) { try { fs.unlinkSync(j.part) } catch {} ; start = 0 }
      if (j.bytes && start === j.bytes) return resolve()   // 上次其实已下完，只差校验
      const headers = { 'User-Agent': 'satsim-desktop' }
      if (start > 0) headers.Range = `bytes=${start}-`
      let ws = null
      let received = start
      let total = j.bytes
      let failed = false
      const bail = (e) => {
        if (failed) return
        failed = true
        try { abort() } catch {}
        if (ws) ws.destroy()
        reject(e)
      }
      const abort = streamGet(j.url, headers, {
        onResponse: (status, hd) => {
          if (status === 206) {
            const cr = L.parseContentRange(L.hdr(hd, 'content-range'))
            if (!cr || cr.start !== start) return bail(new Error('续传区间不符'))
            if (cr.total) total = cr.total
            ws = fs.createWriteStream(j.part, { flags: 'a' })
          } else if (status === 200) {
            received = 0
            const cl = Number(L.hdr(hd, 'content-length'))
            if (Number.isFinite(cl) && cl > 0) total = cl
            ws = fs.createWriteStream(j.part, { flags: 'w' })
          } else if (status === 416) {
            try { fs.unlinkSync(j.part) } catch {}
            return bail(new Error('续传区间无效'))
          } else {
            return bail(Object.assign(new Error(`HTTP ${status}`), { retriable: status >= 500 || status === 429 || status === 408 ? true : false }))
          }
          if (j.bytes && total && total !== j.bytes) return bail(Object.assign(new Error(`文件大小不符（${total} ≠ ${j.bytes}）`), { retriable: false }))
          if (total > MAX_BLOB_BYTES) return bail(Object.assign(new Error('文件过大'), { retriable: false }))
          ws.on('error', bail)
          jobSet(j, { type: 'progress', received, total })
        },
        onData: (c) => {
          if (failed || !ws) return
          received += c.length
          if ((j.bytes && received > j.bytes) || received > MAX_BLOB_BYTES) return bail(new Error('收到的字节超出声明大小'))
          ws.write(c)
          jobSet(j, { type: 'progress', received, total })
        },
        onEnd: () => {
          if (failed) return
          if (!ws) return reject(new Error('无响应体'))
          ws.end(() => {
            if (total && received !== total) return reject(new Error(`连接提前断开（${received}/${total}）`))
            resolve()
          })
        },
        onError: (e) => bail(e)
      })
      j.abort = abort
    })
  }

  /* ─────────────── ensure / cancel ─────────────── */
  async function ensure(o) {
    const id = String((o && o.id) || '')
    const lod = o && typeof o.lod === 'string' ? o.lod : 'lod2'
    // 缩略图先于 param 判：参数化「保存到库」的 param:<specHash> 有 saveThumb 存下的缩略图，
    // 库画廊一律经 thumbnail(id) 取（参数化模板如 param:default-sat 没有条目 → missing，渲染端现场出图）
    if (lod === 'thumb') {
      const cat = await catalog()
      return ensureThumb(cat.byId.get(id), cat.userFiles.has(id))
    }
    // param: 模板与 ent: 实体模板都是渲染端运行时现生成（buildParamModel / buildAssembly），没有文件
    if (/^(param|ent):/.test(id)) return { state: 'param' }
    const cat = await catalog()
    const m = cat.byId.get(id)
    const isUser = cat.userFiles.has(id)
    const plan = L.planEnsure({ id, lod, meta: m, ready: (l) => !!lodSource(cat, m, l), downloadable: !isUser && !offline() })
    const t = now()
    const urlOf = (l) => { const s = lodSource(cat, m, l); return s ? L.modelsUrl(s.host, s.sha, 'glb') : null }
    const mark = (l) => {
      const f = m.files[l]
      if (!f) return
      const key = f.sha256 + '.glb'
      lastEnsure.set(key, t)
      const s = lodSource(cat, m, l)
      if (s && s.host === 'blobs') setState(L.touchState(state(), key, t))
    }
    if (plan.kind === 'param') return { state: 'param' }
    if (plan.kind === 'missing') return { state: 'missing' }
    if (plan.kind === 'ready') { mark(plan.lod); return { state: 'ready', url: urlOf(plan.lod), lod: plan.lod } }
    // download
    const key = m.files[plan.lod].sha256 + '.glb'
    const fb = plan.fallback ? { lod: plan.fallback, url: urlOf(plan.fallback) } : undefined
    if (fb) mark(plan.fallback)
    const f = failedAt.get(key)
    const j0 = jobs.get(key)
    const running = j0 && !['ready', 'error', 'canceled'].includes(j0.st.phase)
    if (f && t - f.at < ERROR_HOLD_MS && !running) return fb ? { state: 'error', message: f.message, fallback: fb } : { state: 'error', message: f.message }
    lastEnsure.set(key, t)
    const j = enqueue(m, plan.lod)
    if (j.st.phase === 'error') return { state: 'error', message: j.st.message }
    const r = { state: 'downloading', received: j.st.received, total: j.st.total || j.bytes, lod: plan.lod }
    if (fb) r.fallback = fb
    return r
  }

  // 缩略图（契约 T13 的 models:thumbnail）：本机 / 随包有就直接给；远端条目按需下 blobs/<sha>.webp
  function ensureThumb(m, isUser) {
    const t = m && m.files && m.files.thumb
    if (!t || !L.SHA_RE.test(String(t.sha256 || ''))) return { state: 'missing' }
    const key = t.sha256 + '.webp'
    const s = thumbSource(m)
    if (s) {
      // 远端缩略图在 blobs 里跟模型一起吃 LRU：画廊正显示着的要记账，否则它只在下载那一刻记过一次
      // lastUsed，缓存一满最先被删，<img> 重载时就 404
      if (s.host === 'blobs') { const t0 = now(); lastEnsure.set(key, t0); setState(L.touchState(state(), key, t0)) }
      return { state: 'ready', url: L.modelsUrl(s.host, s.sha, 'webp'), lod: 'thumb' }
    }
    if (isUser || offline()) return { state: 'missing' }
    const f = failedAt.get(key)
    if (f && now() - f.at < ERROR_HOLD_MS && !(jobs.get(key) && !['ready', 'error', 'canceled'].includes(jobs.get(key).st.phase))) return { state: 'error', message: f.message }
    lastEnsure.set(key, now())
    const j = enqueue(m, 'thumb')
    return { state: 'downloading', received: j.st.received, total: j.st.total || j.bytes, lod: 'thumb' }
  }
  const thumbnail = (id) => ensure({ id, lod: 'thumb' })

  const imports = new Map()   // 导入令牌 → { cancel }
  function cancel(id) {
    const sid = String(id || '')
    const im = imports.get(sid)
    if (im) { im.cancel(); return true }
    let hit = false
    for (const j of jobs.values()) {
      if (!j.owners.has(sid)) continue
      hit = true
      j.owners.delete(sid)
      emit({ type: 'download', id: sid, sha: j.sha, phase: 'canceled', received: j.st.received, total: j.st.total || j.bytes })
      if (j.owners.size) continue   // 别的模型还要这个文件（同一 blob 被两个条目引用）
      clearTimeout(j.retryTimer)
      jobSet(j, { type: 'cancel' })
      if (j.abort) j.abort()
      jobs.delete(j.key)
    }
    pump()
    return hit
  }

  /* ─────────────── 远端 manifest 刷新 ─────────────── */
  let _refreshTimers = []
  let _refreshing = null
  async function refreshManifest() {
    if (offline()) return manifest()
    if (_refreshing) { await _refreshing.catch(() => {}); return manifest() }
    _refreshing = (async () => {
      const { M } = await core()
      const st = state()
      const headers = { 'User-Agent': 'satsim-desktop', 'Cache-Control': 'no-cache' }
      if (st.etag && isFile(dir.remote)) headers['If-None-Match'] = st.etag
      const url = cdnBase() + 'manifest.json'
      const r = await getSmall(url, headers)
      if (r.status === 304) { setState({ ...state(), lastRefresh: now() }); log.info('[models] 远端 manifest 未变（304）'); return }
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
      let json
      try { json = JSON.parse(r.body.toString('utf8')) } catch { throw new Error('远端 manifest 不是 JSON') }
      const v = M.validateManifest(json, { remote: true })
      if (!v.ok && !(v.models && v.models.length)) throw new Error(`远端 manifest 不合格：${(v.errors || []).slice(0, 3).join('；')}`)
      if (v.errors && v.errors.length) log.warn(`[models] 远端 manifest 丢弃 ${v.errors.length} 处不合格：${v.errors.slice(0, 3).join('；')}`)
      if (v.warnings && v.warnings.length) log.info(`[models] 远端 manifest 提示 ${v.warnings.length} 条：${v.warnings.slice(0, 5).join('；')}`)
      mk(modelsDir)
      // 落盘的是校验后的那份：坏条目已丢；cdnBase 这类客户端不认的字段也不留（地址钉死在 CDN_BASE）
      const { cdnBase: _ignored, ...kept } = json
      writeJsonAtomic(dir.remote, { ...kept, models: v.models }, 0)
      const etag = L.hdr(r.headers, 'etag')
      setState({ ...state(), etag: typeof etag === 'string' ? etag : null, lastRefresh: now() })
      flushState()
      invalidate()
      log.info(`[models] 远端 manifest 已更新：${v.models.length} 条（buildId ${json.buildId || '?'}）`)
      emit({ type: 'manifest' })
    })()
    try { await _refreshing } catch (e) { log.warn(`[models] 刷新远端 manifest 失败：${errText(e)}`) } finally { _refreshing = null }
    return manifest()
  }
  function start() {
    stopTimers()
    const t1 = setTimeout(() => { refreshManifest().catch(() => {}) }, REFRESH_FIRST_MS)
    const t2 = setInterval(() => { refreshManifest().catch(() => {}) }, REFRESH_EVERY_MS)
    if (t1.unref) t1.unref()
    if (t2.unref) t2.unref()
    _refreshTimers = [t1, t2]
  }
  function stopTimers() { for (const t of _refreshTimers) { clearTimeout(t); clearInterval(t) } _refreshTimers = [] }
  function stop() {
    stopTimers()
    for (const j of jobs.values()) { clearTimeout(j.retryTimer); if (j.abort) j.abort() }
    for (const im of imports.values()) im.cancel()
    flushState()
  }

  /* ─────────────── 元数据构造（导入件） ─────────────── */
  // 从 glb 的 JSON 块推出一份初始 ModelMeta（不解网格）。几何的精算（面积、体积、闭合、质心）
  // 在渲染端 Worker 里做完再 saveMeta 回来；这里只给得出的：包围盒、三角形数、单位猜测、AGI。
  async function metaFromGltf(json, { id, title, kind, fidelity, source, files, units, nodeNameMap, gmdf, sourceFormat }) {
    const { G, A, S, U, B } = await core()
    const bbox = G.gltfBoundsApprox(json)
    const ex = json && json.extras && json.extras.satsim
    const u = units || guessUnits(U, bbox, sourceFormat || 'glb', {
      satsimUnits: ex && typeof ex === 'object' ? ex.units : undefined,
      generator: json && json.asset && typeof json.asset.generator === 'string' ? json.asset.generator : undefined
    })
    const k = Number(u.scaleToMeters) > 0 ? Number(u.scaleToMeters) : 1
    // 本体轴缺省按类别与来源（轴映射终案 ②、DESIGN3 E5，bodyFrame.defaultImportQ）：文件自带 extras.satsim.frame 的 q（我们导出件的标定）优先；
    // 飞机 / 船 / 车 / 地球站（STK Air / Sea / Land 目录件等）→ +Y 天顶；带 extras.satsim.frame、STK 本机件、参数化件、用了 AGI 扩展
    // （或带 .gmdf 旁车）→ STK 映射；其余（普通 glb / glTF / CAD / 渲染端转好的 OBJ·STL·FBX）→ +Y 天顶（Q_YUP_ZENITH）。
    // 必须在读挂点位姿之前定下来：挂点的本体系位姿按这个 q 换算。定下的 q 另记成 frame.importQ（工作台「出厂映射」回到它）。
    const exFrame = ex && typeof ex === 'object' && ex.frame && typeof ex.frame === 'object' && !Array.isArray(ex.frame) ? ex.frame : null
    // 文件自带的 q：取法与 defaultImportQ 逐条相同（q_model2body 优先、其次简写 q；四个有限数），再过同一道模长门（0.9–1.1）
    const isQ4 = (v) => Array.isArray(v) && v.length === 4 && v.every(Number.isFinite)
    const exQ = exFrame ? (isQ4(exFrame.q_model2body) ? exFrame.q_model2body : (isQ4(exFrame.q) ? exFrame.q : null)) : null
    const exQn = exQ ? Math.hypot(exQ[0], exQ[1], exQ[2], exQ[3]) : 0
    const exT = exFrame ? (Array.isArray(exFrame.t_model2body) ? exFrame.t_model2body : exFrame.t) : null
    // 类别取最终落进 meta 的那个：extras.satsim.kind 会被下面 ADOPT_FROM_EXTRAS 采用，就按它判
    const kindEff = ex && typeof ex === 'object' && typeof ex.kind === 'string' && ex.kind ? ex.kind : kind
    const q = B.defaultImportQ({ sourceKind: source && source.kind, hasAgi: !!gmdf || L.usesAgiExtensions(json), satsimFrame: exFrame, kind: kindEff })
    const exQc = exQ && exQn > 0.9 && exQn < 1.1 ? B.quatCanonical(exQ) : null
    const frame = {
      q_model2body: q,
      t_model2body: Array.isArray(exT) && exT.length === 3 && exT.every(Number.isFinite) ? exT.slice() : [0, 0, 0],
      // 「核过」只认文件自带、且真被采用了的 q（它是导出前在工作台里标定过的）；模长不对被 defaultImportQ 换成缺省映射的、缺省映射本身，一律未核
      verified: !!(exFrame && exFrame.verified === true && exQc && exQc.every((v, i) => v === q[i])),
      // 入库时的出厂映射（schema.normalizeMeta 放行；工作台 factoryFrameQ ① 优先取它）
      importQ: q.slice()
    }
    const partial = { id, title, kind, fidelity, source, files, units: u, frame }
    if (bbox) {
      const min = bbox.min.map((v) => v * k), max = bbox.max.map((v) => v * k)
      const c = [0, 1, 2].map((i) => (min[i] + max[i]) / 2)
      const r = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2
      partial.geometry = { bboxM: { min, max }, boundingRadiusM: r, tris: L.countTris(json), centroidM: c }
    } else partial.geometry = { tris: L.countTris(json) }
    // AGI 扩展（STK 模型的挂点 / 关节 / 太阳翼组；我们自己导出的 glb 也写了这套）。
    // 有 .gmdf 旁车就按 STK 口径以旁车为准（mergeAgi 缺省 mode:'stk'）。挂点补上本体系位姿：位置 = 节点原点，
    // 视轴 = 节点局部 +Y，上向 = 节点局部 +X（agi.mjs「挂点节点的轴向口径」，2026-09-23 按本机 STK 12 核定），按上面定下的 frame 换到本体系
    try {
      const agi = readAgi(A, json, gmdf)
      if (agi.attachPoints.length) partial.attachPoints = A.attachPointPoses(json, agi.attachPoints, { q_model2body: frame.q_model2body, t_model2body: frame.t_model2body, scaleToMeters: k })
      for (const key of ['articulations', 'solarPanelGroups', 'noObscurationNodes']) if (agi[key].length) partial[key] = agi[key]
      if (agi.errors && agi.errors.length) log.warn(`[models] ${id} 的 AGI 扩展：${agi.errors.slice(0, 3).join('；')}`)
    } catch (e) { log.warn(`[models] 读 AGI 扩展失败：${errText(e)}`) }
    if (nodeNameMap && Object.keys(nodeNameMap).length) partial.nodeNameMap = nodeNameMap
    // 本工具导出过的 glb 带 extras.satsim：工程属性直接采用（id / source / files 不采用——以本次入库为准）
    if (ex && typeof ex === 'object' && !Array.isArray(ex)) {
      for (const key of ADOPT_FROM_EXTRAS) if (ex[key] !== undefined && ex[key] !== null) partial[key] = plain(ex[key])
      if (typeof ex.title === 'string' && ex.title) partial.title = ex.title
      // frame 已在上面按 defaultImportQ 从 extras.satsim.frame 取过（认 q_model2body 与简写 q 两种写法）；原样采用会让简写 q 丢掉
      partial.frame = frame
    }
    const meta = S.normalizeMeta(S.defaultMeta(partial))
    meta.updatedAt = new Date(now()).toISOString()
    return meta
  }
  // 单位推断（units.mjs）：sizeVerified 一律 false —— 只有「有出处」的才许为 true（STEP 头 / 用户给出处的已知尺寸）
  function guessUnits(U, bbox, sourceFormat, headerHints) {
    try {
      const span = bbox ? Math.max(bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]) : undefined
      const g = U.guessUnits({ bboxSpanModelUnits: span, sourceFormat, headerHints: headerHints || {} })
      if (g && Number(g.scaleToMeters) > 0) return { scaleToMeters: Number(g.scaleToMeters), unitGuess: g.unitGuess || 'unknown', sizeVerified: false }
    } catch (e) { log.warn(`[models] 单位推断失败：${errText(e)}`) }
    return { scaleToMeters: 1, unitGuess: 'unknown', sizeVerified: false }
  }
  // AGI：内嵌扩展 +（可选）.gmdf 旁车 → 统一形状 {attachPoints, articulations, solarPanelGroups, noObscurationNodes, errors}
  function readAgi(A, json, gmdf) {
    const e = A.readAgiFromGltfJson(json)
    return gmdf ? A.mergeAgi(e, A.readGmdf(gmdf)) : e
  }

  // 入库：user/<sha>.glb + <sha>.satsim.json（内容寻址）。同一份字节再导一次 → 沿用已有的 meta
  // （用户可能已经标定过单位 / 轴 / 挂点），除非这次是 STK 导入而已有的不是 stk-local —— 授权口径
  // 只许收紧不许放宽，所以 STK 身份覆盖上去。
  // id：给了就用它（装配件 asm:<id> 终身不变，不按内容寻址），否则 `${idPrefix}:<sha 前 12 位>`。
  // quiet：不广播 manifest（调用方随后还要改写 meta，自己广播一次）。
  async function storeImported({ glb, json, idPrefix, id: idGiven, quiet, title, kind, fidelity, source, units, nodeNameMap, extra, gmdf, sourceFormat }) {
    const { S, G } = await core()
    const sha = sha256(glb)
    const id = typeof idGiven === 'string' && idGiven ? idGiven : `${idPrefix}:${sha.slice(0, 12)}`
    // 本进程入库的件已按现行判据判过（importGlb / saveImported 走 stkVerdict；CAD 是 occt 现生成的），
    // 结论直接记进缓存，建目录时的补判就不必再读一遍 glb 头
    if (!stkVerdictCache.has(sha)) stkVerdictCache.set(sha, source.kind === 'stk-local' ? 'import' : null)
    mk(dir.user)
    const glbFile = path.join(dir.user, sha + '.glb')
    const metaFile = path.join(dir.user, sha + '.satsim.json')
    // 「已存在」只认主文件在：readJsonSafe 在主文件缺失时会退到 .bak，而删过的模型可能留着 .bak
    //（writeJsonAtomic 每写一次就备份一份）—— 把它当「已存在」就会回 existed:true 却不写主文件，
    // 模型从此在目录里看不见。主文件不在 = 新导入，顺手清掉残留的 .bak / .tmp
    const existing = isFile(metaFile) ? readMetaFile(metaFile) : null
    if (!existing) { rmQuiet(metaFile + '.bak'); rmQuiet(metaFile + '.tmp') }
    if (existing && typeof existing.id === 'string') {
      const cur = S.normalizeMeta(existing)
      const tighten = source.kind === 'stk-local' && !(cur.source && cur.source.kind === 'stk-local')
      if (!tighten) {
        if (!isFile(glbFile)) writeFileAtomic(glbFile, glb)
        return { id: cur.id, meta: cur, existed: true }
      }
      const next = S.normalizeMeta({ ...cur, id, source, updatedAt: new Date(now()).toISOString() })
      writeJsonAtomic(metaFile, next, 2)
      invalidate()
      emit({ type: 'manifest' })
      log.info(`[models] ${cur.id} 按 STK 身份改为 ${id}（授权收紧）`)
      return { id, meta: next, existed: true }
    }
    if (!isFile(glbFile)) writeFileAtomic(glbFile, glb)
    const tris = L.countTris(json)
    let meta = await metaFromGltf(json, { id, title, kind, fidelity, source, files: { lod0: { sha256: sha, bytes: glb.length, tris } }, units, nodeNameMap, gmdf, sourceFormat })
    if (extra) meta = S.normalizeMeta({ ...meta, ...extra, frame: keepImportQ(extra.frame, meta.frame), id, source, files: meta.files })
    const v = S.validateMeta(meta, { nodeNames: G.gltfNodeNames(json) })
    if (!v.ok) log.warn(`[models] ${id} 元数据校验：${(v.errors || []).slice(0, 5).join('；')}`)
    writeJsonAtomic(metaFile, meta, 2)
    invalidate()
    if (!quiet) emit({ type: 'manifest' })
    log.info(`[models] 入库 ${id}（${title}，${glb.length} 字节，${tris} 三角形）`)
    return { id, meta, existed: false }
  }
  const userSource = () => ({ kind: 'user', url: '', credit: '', license: '', redistributable: true })
  const stkSource = () => ({ kind: 'stk-local', url: '', credit: 'AGI', license: 'AGI SLA', redistributable: false })
  // extra（渲染端送来的 meta 字段）整份盖 frame 时，保住 metaFromGltf 按这份 glb 定下的 importQ：入库时的「出厂映射」只认主进程判的
  function keepImportQ(fx, f0) {
    if (!fx || typeof fx !== 'object' || Array.isArray(fx)) return f0
    const out = { ...fx }
    if (f0 && Array.isArray(f0.importQ)) out.importQ = f0.importQ.slice()
    else delete out.importQ
    return out
  }

  /* ─────────────── 导入 ─────────────── */
  async function importGlb(o) {
    try {
      const { G } = await core()
      let bytes = null
      let name = ''
      let gltf = false
      let srcJson = null   // .gltf 的原 JSON（打包前）：授权判据两份都看
      const filePath = o && typeof o.path === 'string' && o.path ? o.path : null
      if (filePath) {
        const ext = extOf(filePath)
        if (ext !== 'glb' && ext !== 'gltf') return { ok: false, error: '只支持 .glb / .gltf' }
        name = path.basename(filePath)
        if (ext === 'gltf') { const g = await imp.gltfToGlb({ path: filePath }, { G: glbAdapter(G), log }); bytes = g.glb; srcJson = g.json; gltf = true }
        else bytes = await fsp.readFile(filePath)
      } else if (o && toU8(o.bytes)) {
        name = String(o.name || 'model.glb')
        bytes = toU8(o.bytes)
        if (extOf(name) === 'gltf' || (!L.isGlb(bytes) && bytes[0] === 0x7b)) { const g = await imp.gltfToGlb({ bytes, name }, { G: glbAdapter(G), log }); bytes = g.glb; srcJson = g.json; gltf = true }
      } else return { ok: false, error: '缺少文件' }
      if (!L.isGlb(bytes)) return { ok: false, error: '不是 glb 文件' }
      const p = G.parseGlb(bytes)
      if (!p.ok) return { ok: false, error: p.error }
      const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      // 授权闸：JSON 块（署名 / AGI 扩展 / 自声明）、来源路径（STK 安装树 / 用过的 STK 目录）、
      // 字节（与本机 STK 某个文件逐字节相同）三类判据任一命中，就按 STK 本机件入库
      const stk = await stkVerdict({ json: p.json, jsonAlt: srcJson, filePath, sha: sha256(buf), size: buf.length })
      const title = name.replace(/\.(glb|gltf)$/i, '')
      const r = await storeImported({
        glb: buf, json: p.json,
        idPrefix: stk ? 'stk' : 'user', title, kind: 'spacecraft', fidelity: 'outreach',
        source: stk ? stkSource() : userSource()
      })
      if (stk) log.info(`[models] ${name} 判为 STK 本机件（${stk}）：不可再分发`)
      emit({ type: 'import', phase: 'done', id: r.id, name })
      return { ok: true, id: r.id, meta: plain(r.meta), existed: r.existed, packed: gltf }
    } catch (e) {
      log.warn(`[models] 导入 glb 失败：${errText(e)}`)
      return { ok: false, error: errText(e) }
    }
  }

  // CAD worker 排队（CAD_CONCURRENCY 条道）。acquire 返回 { ready, cancel }：ready 在拿到道时 resolve，
  // 排队中被 cancel 则以 canceled 错误 reject（从队里摘掉，不起 worker）
  let cadRunning = 0
  const cadWaiters = []
  function cadAcquire() {
    let cancel = () => {}
    const ready = new Promise((resolve, reject) => {
      if (cadRunning < CAD_CONCURRENCY) { cadRunning++; resolve(); return }
      const w = { go: () => { cadRunning++; resolve() } }
      cadWaiters.push(w)
      cancel = () => {
        const i = cadWaiters.indexOf(w)
        if (i >= 0) { cadWaiters.splice(i, 1); reject(Object.assign(new Error('已取消'), { canceled: true })) }
      }
    })
    return { ready, cancel: () => cancel() }
  }
  function cadRelease() {
    cadRunning = Math.max(0, cadRunning - 1)
    const w = cadWaiters.shift()
    if (w) w.go()
  }

  let _impSeq = 0
  async function importCad(o) {
    const file = o && typeof o.path === 'string' ? o.path : ''
    const kind = L.cadKind(file)
    if (!kind) return { ok: false, error: '只支持 STEP / IGES / BREP' }
    if (!isFile(file)) return { ok: false, error: '文件不存在' }
    const token = o && typeof o.token === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(o.token) ? o.token : `imp-${now()}-${++_impSeq}`
    const name = path.basename(file)
    emit({ type: 'import', token, name, phase: 'start' })
    const fail = (e) => {
      imports.delete(token)
      emit({ type: 'import', token, name, phase: e && e.canceled ? 'canceled' : 'error', message: errText(e) })
      if (!(e && e.canceled)) log.warn(`[models] CAD 导入失败 ${name}：${errText(e)}`)
      return { ok: false, error: errText(e), canceled: !!(e && e.canceled) }
    }
    // 排队：前面有 CAD 在跑就先广播 queued；排队期间 cancel(token) 直接出队
    const waiting = cadRunning >= CAD_CONCURRENCY
    const slot = cadAcquire()
    let job = null
    let canceled = false
    imports.set(token, { cancel: () => { canceled = true; slot.cancel(); if (job) job.cancel() } })
    if (waiting) emit({ type: 'import', token, name, phase: 'queued' })
    try { await slot.ready } catch (e) { return fail(e) }
    let r
    const t0 = now()   // 耗时从拿到道算起：排队等待不算进「导入耗时」
    try {
      if (canceled) throw Object.assign(new Error('已取消'), { canceled: true })
      job = imp.runCadWorker({ file, kind, name: name.replace(/\.[^.]+$/, ''), onPhase: (phase) => emit({ type: 'import', token, name, phase }) })
      r = await job.promise
    } catch (e) {
      return fail(e)
    } finally {
      cadRelease()
    }
    imports.delete(token)
    try {
      const { G, U } = await core()
      const p = G.parseGlb(r.glb)
      if (!p.ok) throw new Error(p.error)
      // STEP / IGES：occt 已按文件头单位换成米（T7），尺寸出处就是文件头 → sizeVerified；
      // BREP 没有单位（OCCT 按原数值出），只能按包围盒量级猜
      let units
      if (kind === 'brep') units = guessUnits(U, r.bbox, 'brep', { convertedToMeters: false })
      else {
        let stepUnit = null
        if (kind === 'step') { try { stepUnit = U.stepLengthUnit(readHead(file, 2 * 1024 * 1024)) } catch { /* 只作说明 */ } }
        units = { scaleToMeters: 1, unitGuess: 'm', sizeVerified: true, sizeSource: kind === 'iges' ? 'IGES 文件头' : `STEP 文件头${stepUnit ? `（${stepUnit}）` : ''}` }
      }
      const st = await storeImported({
        glb: Buffer.from(r.glb.buffer, r.glb.byteOffset, r.glb.byteLength), json: p.json,
        idPrefix: 'user', title: name.replace(/\.[^.]+$/, ''), kind: 'spacecraft', fidelity: 'cad',
        source: userSource(), units, nodeNameMap: r.nodeNameMap, sourceFormat: kind
      })
      const ms = now() - t0
      log.info(`[models] CAD 导入 ${name}：${ms} ms，${r.tris} 三角形${r.simplified ? `（抽稀自 ${r.trisBefore}）` : ''}，${r.nodes} 节点`)
      emit({ type: 'import', token, name, phase: 'done', id: st.id, ms, tris: r.tris })
      return { ok: true, id: st.id, meta: plain(st.meta), ms, tris: r.tris, trisBefore: r.trisBefore, simplified: r.simplified, nodes: r.nodes, existed: st.existed }
    } catch (e) {
      emit({ type: 'import', token, name, phase: 'error', message: errText(e) })
      log.warn(`[models] CAD 入库失败 ${name}：${errText(e)}`)
      return { ok: false, error: errText(e) }
    }
  }

  // 渲染端把 OBJ / STL / FBX 转好的 glb（或参数化「保存到库」的 glb）送回来入库。
  // 来源只收 user / param 两种：nasa / builtin / stk-local 是主进程自己才能给的身份。
  async function saveImported(o) {
    try {
      const { G, S } = await core()
      const glb = toU8(o && o.glb)
      if (!glb || !L.isGlb(glb)) return { ok: false, error: '不是 glb 数据' }
      const p = G.parseGlb(glb)
      if (!p.ok) return { ok: false, error: p.error }
      const buf = Buffer.from(glb.buffer, glb.byteOffset, glb.byteLength)
      // 这条路只收 user / param 身份，STK 的东西（判据同 importGlb）一律不收
      const stk = await stkVerdict({ json: p.json, sha: sha256(buf), size: buf.length })
      if (stk) { log.info(`[models] saveImported 拒收 STK 件（${stk}）`); return { ok: false, code: 'stk', error: 'STK 模型不可由此导入。' } }
      const m = o && o.meta && typeof o.meta === 'object' ? plain(o.meta) : {}
      // 装配件（DESIGN3 E4）：id 由渲染端新建文档时生成、终身不变，同 id 再存 = 顶替
      if (typeof m.id === 'string' && ASM_ID_RE.test(m.id)) return await saveAssembly(buf, p.json, m)
      const isParam = m.source && m.source.kind === 'param'
      const source = isParam
        ? { kind: 'param', url: '', credit: '', license: '', redistributable: true }
        : userSource()
      const extra = {}
      for (const k of EDITABLE) if (m[k] !== undefined) extra[k] = m[k]
      // 装配文档只配 asm: id（schema.validateMeta 同口径）：param: 带着它会被 buildParamModel 当整星 spec 静默生成成一个点，
      // user: 带着它没有用处（glb 就是成品）。这里摘掉，不让它落盘
      if (S.isAssemblySpec(extra.spec)) { delete extra.spec; log.info('[models] saveImported：非 asm: 条目带的装配文档已丢弃') }
      const r = await storeImported({
        glb: buf, json: p.json,
        idPrefix: isParam ? 'param' : 'user',
        title: typeof m.title === 'string' && m.title ? m.title : '模型',
        kind: typeof m.kind === 'string' ? m.kind : 'spacecraft',
        fidelity: typeof m.fidelity === 'string' ? m.fidelity : (isParam ? 'parametric' : 'outreach'),
        source, units: m.units, extra
      })
      // 参数化另存：契约 §3.5 的 id 是 param:<specHash 前 12 位>。渲染端给得出合法的就用它
      if (isParam && typeof m.id === 'string' && /^param:[0-9a-f]{12}$/.test(m.id) && r.id !== m.id && !r.existed) {
        const cat = await catalog()
        const u = cat.userFiles.get(r.id)
        if (u) {
          let next = S.normalizeMeta({ ...r.meta, id: m.id })
          // 同一 spec 早先存过（glb 字节不同，比如 extras.satsim 里的 updatedAt 变了）：新的顶替旧的。
          // 不删的话 user/ 下两份 meta 同 id，清单取一份、删除删另一份，删完模型还在清单里。
          // 旧条目重拍过的缩略图沿用（新存的这份还没来得及 saveThumb）
          const old = cat.userFiles.get(m.id)
          if (old && old.sha !== u.sha) {
            const ot = old.meta && old.meta.files && old.meta.files.thumb
            if (ot && !(next.files && next.files.thumb)) next = S.normalizeMeta({ ...next, files: { ...next.files, thumb: ot } })
            for (const x of [old, ...old.shadowed]) removeUserFiles(x)
            log.info(`[models] ${m.id} 重新保存：顶替旧文件 ${old.sha.slice(0, 12)}…`)
          }
          writeJsonAtomic(u.metaFile, next, 2)
          invalidate()
          emit({ type: 'manifest' })
          return { ok: true, id: m.id, meta: plain(next) }
        }
      }
      emit({ type: 'import', phase: 'done', id: r.id })
      return { ok: true, id: r.id, meta: plain(r.meta), existed: r.existed }
    } catch (e) {
      log.warn(`[models] 保存导入件失败：${errText(e)}`)
      return { ok: false, error: errText(e) }
    }
  }

  // 装配件入库（saveImported 的 asm 分支，DESIGN3 E4；P3 契约 §2.6-4）。
  // 同一 id 的保存串行（装配页自动保存与「另存」可能前后脚到）：并发时两边都拿同一份旧目录，各写一份新文件、各删旧文件，
  // 结果同 id 两份 meta（目录靠 shadowed 兜得住，但下次删除前一直占盘）。按 id 排队，别的 id 不受影响。
  const asmChain = new Map()
  function saveAssembly(buf, json, m) {
    const prev = asmChain.get(m.id) || Promise.resolve()
    const run = prev.then(() => saveAssemblyNow(buf, json, m))
    const tail = run.then(() => {}, () => {})
    asmChain.set(m.id, tail)
    tail.then(() => { if (asmChain.get(m.id) === tail) asmChain.delete(m.id) })
    return run
  }
  async function saveAssemblyNow(buf, json, m) {
    const { S } = await core()
    if (!S.isAssemblySpec(m.spec)) return { ok: false, code: 'bad-asm', error: '装配件缺装配文档。' }
    const cat = await catalog()
    // 授权闸（E4）：装配文档引用的库模型（schema.asmModelRefs，失败即关）必须都在目录里、且可再分发；一个不行整件拒收，
    // 什么都不落盘。先扫原始文档（任何键名、嵌套里的模型 id 都算；授权结论优先于文档合法性），规整之后再扫一遍
    const refGate = (spec) => {
      for (const rid of S.asmModelRefs(spec)) {
        const ref = cat.byId.get(rid)
        if (!ref || !S.isRedistributable(ref)) {
          log.info(`[models] 拒收装配件 ${m.id}：引用的 ${JSON.stringify(rid)} ${ref ? '不可再分发' : '不在目录里'}`)
          return { ok: false, code: 'not-redistributable', error: '含不可分发的模型。' }
        }
      }
      return null
    }
    const g0 = refGate(m.spec)
    if (g0) return g0
    // 主进程不信任渲染端的装配文档：用同一份 assembly.mjs 复核（纯 ESM、不依赖 three）。未知组件类型（含 P4 登记之前的
    // 'model'）、领域非法、父子成环、参数非法……一律整件拒收；落盘存规整后的文档（未知键丢掉，别名键带不进库）
    let Asm
    try { Asm = await loadMod('assembly') } catch (e) { return { ok: false, code: 'bad-asm', error: errText(e) } }
    const va = Asm.validateAssembly(m.spec)
    if (!va.ok) {
      log.info(`[models] 拒收装配件 ${m.id}：${[...va.missing, ...va.errors].slice(0, 3).join('；')}`)
      return { ok: false, code: 'bad-asm', error: '装配文档非法。' }
    }
    const spec = Asm.normalizeAssembly(m.spec)
    const g1 = refGate(spec)
    if (g1) return g1
    m = { ...m, spec }
    const sha = sha256(buf)
    const metaFile = path.join(dir.user, sha + '.satsim.json')
    // 同一份字节已作为别的条目入库：不抢它的文件（extras.satsim 里带 id 与时间戳，正常保存不会撞；撞了说明是别的条目的原件）
    const holder = isFile(metaFile) ? readMetaFile(metaFile) : null
    if (holder && typeof holder.id === 'string' && holder.id !== m.id) {
      log.warn(`[models] 装配件 ${m.id} 的 glb 与 ${holder.id} 字节相同：不入库`)
      return { ok: false, code: 'dup', error: '与库中另一模型的文件相同。' }
    }
    const old = cat.userFiles.get(m.id) || null
    const source = userSource()
    const kind = (S.ASM_DOMAIN_KINDS && S.ASM_DOMAIN_KINDS[m.spec.domain]) || 'spacecraft'
    const extra = {}
    for (const k of EDITABLE) if (m[k] !== undefined) extra[k] = m[k]
    // 类别 / 分组 / 精度由装配领域定，渲染端给的不认
    extra.kind = kind; extra.group = kind; extra.fidelity = 'parametric'
    const title = typeof m.title === 'string' && m.title.trim() ? m.title : '装配件'
    const r = await storeImported({ glb: buf, json, idPrefix: 'user', id: m.id, quiet: true, title, kind, fidelity: 'parametric', source, units: m.units, extra })
    // 不论新存还是字节已在（existed 时 storeImported 原样返回旧 meta）：按本次入参重写这份 sha 的 meta
    let next = S.normalizeMeta({
      ...r.meta, ...extra, frame: keepImportQ(extra.frame, r.meta.frame),
      id: m.id, source, files: r.meta.files, updatedAt: new Date(now()).toISOString()
    })
    // 新存的这份还没有缩略图（渲染端随后 saveThumb）：先沿用旧的，库卡片不闪空
    const ot = old && old.meta && old.meta.files && old.meta.files.thumb
    if (ot && !(next.files && next.files.thumb)) next = S.normalizeMeta({ ...next, files: { ...next.files, thumb: ot } })
    const v = S.validateMeta(next, { nodeNames: (await core()).G.gltfNodeNames(json) })
    if (!v.ok) {
      // 与 saveMeta「校验不过就拒」同口径：不写这份 meta；本次新写下的 glb / meta 撤掉（字节已在的旧件原样不动）
      log.warn(`[models] 拒收装配件 ${m.id}：元数据校验 ${(v.errors || []).slice(0, 5).join('；')}`)
      if (!r.existed) removeUserFiles({ glbFile: path.join(dir.user, sha + '.glb'), metaFile })
      invalidate()
      return { ok: false, code: 'bad-asm', error: '装配件元数据非法。' }
    }
    writeJsonAtomic(metaFile, next, 2)
    // 顶替：同 id 的旧文件（连同早先被顶替、仍留在盘上的 shadowed）一并删掉；本次这份（字节没变时就是旧文件本身）留着
    let replaced = 0
    if (old) for (const x of [old, ...old.shadowed]) if (x.metaFile !== metaFile) replaced += removeUserFiles(x) > 0 ? 1 : 0
    invalidate()
    emit({ type: 'manifest' })
    emit({ type: 'meta', id: m.id })
    log.info(`[models] 装配件 ${m.id} 入库（${buf.length} 字节${replaced ? `，顶替旧文件 ${replaced} 份` : ''}${r.existed ? '，字节未变' : ''}）`)
    return { ok: true, id: m.id, meta: plain(next) }
  }

  /* ─────────────── STK 本机目录（只读） ─────────────── */
  const defaultStkDir = () => stkDefaultOverride || path.join(process.env.ProgramFiles || 'C:\\Program Files', 'AGI', 'STK 12', 'STKData', 'VO', 'Models')
  // 字节判据要列的 STK 目录：默认安装位置 + 用户经「从 STK 导入」真导入过东西的目录（state.json 里记着，跨重启）。
  // ★ 这些目录只用于逐字节比对，不做路径前缀判据：用户可能在 pickStkDir 里选的是 C:\ 这种大目录，
  //   拿它当前缀会把整盘的 glb 都判成 STK 的；字节比对则零误判（逐字节相同 = 就是那个文件）。
  //   路径前缀只认默认目录与 STK 安装树的固定形状（modelsLogic.isStkPath）
  const knownStkDirs = () => [defaultStkDir(), ...(state().stkDirs || [])]
  function noteStkDir(d) {
    const next = L.rememberStkDir(state(), d)
    if (next === state()) return
    setState(next)
    // 新认了一个 STK 目录：本机 STK 清单要重列；之前判「不是 STK」的结论可能过时（字节恰好在新目录里），
    // 清掉重判，目录也重建一次（buildCatalog 的补收紧会用上新清单）
    _stkIndex = null
    for (const [k, v] of stkVerdictCache) if (!v) stkVerdictCache.delete(k)
    invalidate()
  }

  // 本机 STK 文件清单 [{path, size, mtimeMs}]（授权闸的字节判据用）：只 stat 不读内容，10 分钟缓存。
  // 比对时先按大小筛、同大小的才算 sha（按 路径|大小|mtime 缓存）—— 23 个文件、一百多 MB 的 STK 模型目录，
  // 绝大多数导入件一个都不用算
  let _stkIndex = null
  let _stkIndexP = null
  const stkShaByFile = new Map()
  function stkIndex() {
    if (_stkIndex && now() - _stkIndex.at < STK_INDEX_TTL_MS) return Promise.resolve(_stkIndex.files)
    if (_stkIndexP) return _stkIndexP
    _stkIndexP = (async () => {
      const files = []
      const seen = new Set()
      for (const d of knownStkDirs()) {
        const st = statOr(d)
        if (!st || !st.isDirectory()) continue
        const w = await walkGlbFiles(d, stkWalkLimits)
        for (const f of w.files) {
          const key = L.normWinPath(f)
          if (seen.has(key)) continue
          seen.add(key)
          const s = await fsp.stat(f).catch(() => null)
          if (s && s.isFile()) files.push({ path: f, size: s.size, mtimeMs: s.mtimeMs })
        }
      }
      _stkIndex = { at: now(), files }
      return files
    })().finally(() => { _stkIndexP = null })
    return _stkIndexP
  }
  async function localStkHas(sha, size) {
    if (!sha || !(size > 0)) return false
    let files = []
    try { files = await stkIndex() } catch { return false }
    for (const f of files) {
      if (f.size !== size) continue
      const k = `${f.path}|${f.size}|${f.mtimeMs}`
      let s = stkShaByFile.get(k)
      if (!s) { try { s = await sha256File(f.path) } catch { continue } stkShaByFile.set(k, s) }
      if (s === sha) return true
    }
    return false
  }
  // 三类判据合一（任一命中返回判据名，都不中返回 null）：JSON 块（modelsLogic.stkReason）→ 来源路径 → 字节。
  // jsonAlt：.gltf 打包前的原 JSON（打包会重排，但署名 / extras 都保留，两份都看更稳）
  async function stkVerdict({ json, jsonAlt, filePath, sha, size }) {
    const r = L.stkReason(json) || (jsonAlt ? L.stkReason(jsonAlt) : null)
    if (r) return r
    if (filePath && L.isStkPath(filePath, [defaultStkDir()])) return 'path'
    if (sha && (await localStkHas(sha, size))) return 'bytes'
    return null
  }
  // 已入库的本机件补判（buildCatalog 用）：user/<sha>.glb 内容寻址，同一 sha 的结论永不变，按 sha 缓存
  const stkVerdictCache = new Map()
  async function stkVerdictForFile(sha, glbFile) {
    if (stkVerdictCache.has(sha)) return stkVerdictCache.get(sha)
    let reason = null
    try {
      const h = await readGlbJsonFromFile(glbFile)
      if (h.ok) reason = L.stkReason(h.json)
      if (!reason) { const s = statOr(glbFile); if (s && (await localStkHas(sha, s.size))) reason = 'bytes' }
    } catch { /* 读不了：本轮不判，下次再说 */ return null }
    stkVerdictCache.set(sha, reason)
    return reason
  }

  // 只读头与 JSON 块：先 20 字节知道 JSON 块多长，再读那么多（不碰 BIN 块，几十 MB 的网格不进内存）
  async function readGlbJsonFromFile(file) {
    const { G } = await core()
    const fd = await fsp.open(file, 'r')
    try {
      let need = 20
      for (let i = 0; i < 3; i++) {
        const buf = Buffer.alloc(need)
        const { bytesRead } = await fd.read(buf, 0, need, 0)
        const r = G.readGlbHeaderJson(buf.subarray(0, bytesRead))
        if (r.ok || !r.needBytes || r.needBytes <= need || bytesRead < need) return r
        need = r.needBytes
      }
      return { ok: false, error: '读不出 JSON 块' }
    } finally { await fd.close() }
  }
  function readGmdf(glbFile) {
    const g = glbFile.replace(/\.glb$/i, '.gmdf')
    if (!isFile(g)) return { has: false, json: null }
    try { return { has: true, json: JSON.parse(fs.readFileSync(g, 'utf8').replace(/^\uFEFF/, '')) } } catch { return { has: true, json: null } }
  }
  async function agiCounts(json, gmdf) {
    try {
      const { A } = await core()
      const c = A.agiCounts(readAgi(A, json, gmdf))
      return { nodes: Array.isArray(json.nodes) ? json.nodes.length : 0, attachPoints: c.attachPoints, articulations: c.articulations, solarPanelGroups: c.solarPanelGroups }
    } catch { return L.countAgiRaw(json, gmdf) }   // agi.mjs 出岔子时的纯计数兜底
  }
  async function scanStk(o) {
    const d = o && typeof o.dir === 'string' && o.dir ? o.dir : defaultStkDir()
    const st = await fsp.stat(d).catch(() => null)
    if (!st || !st.isDirectory()) return { dir: d, exists: false, items: [] }
    const { files, truncated } = await walkGlbFiles(d, stkWalkLimits)
    const items = []
    for (const f of files) {
      const rel = path.relative(d, f).split(path.sep).join('/')
      const category = rel.indexOf('/') >= 0 ? rel.split('/')[0] : ''
      const s = await fsp.stat(f).catch(() => null)
      const item = { file: path.basename(f), rel, category, bytes: s ? s.size : 0, nodes: 0, attachPoints: 0, articulations: 0, solarPanelGroups: 0, hasGmdf: false }
      try {
        const h = await readGlbJsonFromFile(f)
        if (!h.ok) { item.error = h.error || '不是 glb'; items.push(item); continue }
        const g = readGmdf(f)
        item.hasGmdf = g.has
        Object.assign(item, await agiCounts(h.json, g.json))
      } catch (e) { item.error = errText(e) }
      items.push(item)
    }
    items.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    if (truncated) log.info(`[models] 扫描 ${d} 到上限即停（目录 ${stkWalkLimits.maxDirs} / 深度 ${stkWalkLimits.maxDepth} / 文件 ${stkWalkLimits.maxFiles}）`)
    return truncated ? { dir: d, exists: true, items, truncated: true } : { dir: d, exists: true, items }
  }
  async function importStk(o) {
    const d = o && typeof o.dir === 'string' && o.dir ? o.dir : defaultStkDir()
    const rels = Array.isArray(o && o.files) ? o.files : []
    const base = path.resolve(d)
    const imported = [], errors = []
    const { G } = await core()
    for (const rel0 of rels) {
      const rel = L.safeRel(rel0)
      if (!rel) { errors.push({ file: String(rel0), message: '路径不合法' }); continue }
      const abs = path.resolve(base, rel)
      if (!L.isInside(base, abs, path)) { errors.push({ file: rel, message: '路径不合法' }); continue }
      try {
        const bytes = await fsp.readFile(abs)
        const p = G.parseGlb(bytes)
        if (!p.ok) { errors.push({ file: rel, message: p.error }); continue }
        const g = readGmdf(abs)
        const category = rel.indexOf('/') >= 0 ? rel.split('/')[0] : ''
        // .gmdf 旁车在就以它为准（STK 同口径，见 metaFromGltf → readAgi）
        const r = await storeImported({
          glb: bytes, json: p.json, idPrefix: 'stk', title: path.basename(rel).replace(/\.glb$/i, ''),
          kind: L.stkKind(category, rel), fidelity: 'outreach', source: stkSource(), gmdf: g.json || undefined
        })
        imported.push({ id: r.id, file: rel })
      } catch (e) { errors.push({ file: rel, message: errText(e) }) }
    }
    if (imported.length) {
      noteStkDir(d)
      emit({ type: 'import', phase: 'done', ids: imported.map((x) => x.id) })
    }
    return { imported, errors }
  }

  /* ─────────────── 元数据读写 ─────────────── */
  async function getMeta(id) {
    const cat = await catalog()
    const sid = String(id || '')
    const u = cat.userFiles.get(sid)
    if (u) {
      const { S } = await core()
      const raw = readMetaFile(u.metaFile)
      if (!raw) return null
      // 授权以目录为准（建目录时的补收紧回写失败，文件里还是放宽前那份也不认）
      const c = cat.byId.get(sid)
      return plain(S.normalizeMeta(c && c.source ? { ...raw, source: c.source } : raw))
    }
    const m = cat.byId.get(sid)
    return m ? plain(m) : null
  }
  async function saveMeta(o) {
    const id = String((o && o.id) || '')
    const incoming = o && o.meta && typeof o.meta === 'object' ? plain(o.meta) : null
    if (!incoming) return { ok: false, errors: ['缺少元数据'] }
    const { S } = await core()
    const cat = await catalog()
    const u = cat.userFiles.get(id)
    const cur = u ? readMetaFile(u.metaFile) : cat.byId.get(id)
    if (!cur) return { ok: false, errors: ['模型不存在'] }
    const patch = {}
    for (const k of (ASM_ID_RE.test(id) ? ASM_META_EDITABLE : EDITABLE)) if (incoming[k] !== undefined) patch[k] = incoming[k]
    // frame.importQ 是入库时主进程定的「出厂映射」：渲染端改本体轴只动 q / t / verified，importQ 以原件为准（缺了不补、给了不认）
    if (patch.frame !== undefined) patch.frame = keepImportQ(patch.frame, cur.frame)
    const stamp = new Date(now()).toISOString()
    const catSrc = u && cat.byId.get(id) ? cat.byId.get(id).source : null   // 授权以目录为准（只许收紧）
    const next = S.normalizeMeta({ ...cur, ...patch, id: cur.id, source: catSrc || cur.source, files: cur.files, updatedAt: stamp })
    const v = S.validateMeta(next)
    if (!v.ok) return { ok: false, errors: v.errors || [] }
    if (u) writeJsonAtomic(u.metaFile, next, 2)
    else {
      // 远端 / 内置：覆盖层只记「用户真改过、且与底版不同」的字段 —— 远端重建后，没改过的字段
      // （titleZh / geometry / tags / aliases 等，autoMatch 靠后两项）跟着新底版走，改过的照样盖上去。
      // ★ 不能把 normalizeMeta 补全后的整份存进去：那等于给底版拍了张快照，远端再怎么更新都被旧值永久盖住。
      //   也不能只按「本次入参带了哪些键」记：渲染端常把 getMeta 拿到的整份改一格再送回来，那样照样全钉死。
      //   所以逐键与底版（归一后）比：相同 = 没改（或改回了原值）→ 从覆盖层摘掉；不同才记。
      mk(dir.overrides)
      const prev = readMetaFile(overrideFile(id)) || {}
      const base = S.normalizeMeta(cat.baseById.get(id) || cur)
      const ov = { id }
      for (const k of EDITABLE) if (prev[k] !== undefined) ov[k] = prev[k]
      for (const k of Object.keys(patch)) {
        if (L.sameJson(next[k], base[k])) delete ov[k]
        else ov[k] = next[k]
      }
      if (prev.files && prev.files.thumb) ov.files = { thumb: prev.files.thumb }
      const keys = Object.keys(ov).filter((k) => k !== 'id')
      if (keys.length) writeJsonAtomic(overrideFile(id), { ...ov, updatedAt: stamp }, 2)
      else { rmQuiet(overrideFile(id)); rmQuiet(overrideFile(id) + '.bak'); rmQuiet(overrideFile(id) + '.tmp') }
    }
    invalidate()
    emit({ type: 'meta', id })
    return { ok: true }
  }
  async function saveThumb(o) {
    const id = String((o && o.id) || '')
    const webp = toU8(o && o.webp)
    if (!webp || !L.isWebp(webp) || webp.length > MAX_THUMB_BYTES) return { ok: false, error: '不是 WebP 图片' }
    const cat = await catalog()
    const u = cat.userFiles.get(id)
    if (!u && !cat.byId.has(id)) return { ok: false, error: '模型不存在' }
    const sha = sha256(webp)
    mk(dir.thumbs)
    const f = path.join(dir.thumbs, sha + '.webp')
    if (!isFile(f)) writeFileAtomic(f, Buffer.from(webp.buffer, webp.byteOffset, webp.byteLength))
    const thumb = { sha256: sha, bytes: webp.length }
    if (u) {
      const cur = readMetaFile(u.metaFile)
      if (!cur) return { ok: false, error: '模型不存在' }
      const prevT = cur.files && cur.files.thumb && typeof cur.files.thumb.sha256 === 'string' ? cur.files.thumb.sha256 : ''
      writeJsonAtomic(u.metaFile, { ...cur, files: { ...(cur.files || {}), thumb }, updatedAt: new Date(now()).toISOString() }, 2)
      // 换下来的旧缩略图没有别的条目引用就删：装配件每次自动入库都重拍一张，不清会在 thumbs/ 里越积越多
      if (prevT && prevT !== sha && L.SHA_RE.test(prevT) && !cat.list.some((x) => x.id !== id && x.files && x.files.thumb && x.files.thumb.sha256 === prevT)) {
        rmQuiet(path.join(dir.thumbs, prevT + '.webp'))
      }
    } else {
      mk(dir.overrides)
      const prev = readMetaFile(overrideFile(id)) || { id }
      writeJsonAtomic(overrideFile(id), { ...prev, files: { thumb }, updatedAt: new Date(now()).toISOString() }, 2)
    }
    invalidate()
    emit({ type: 'meta', id })
    return { ok: true, sha256: sha }
  }

  /* ─────────────── 删除 ─────────────── */
  // 本机件的一整组文件：glb + meta，连同 writeJsonAtomic 留下的 .bak 与写一半的 .tmp。
  // ★ .bak 必须一起删：readJsonSafe 在主文件缺失时会退到 .bak，留着它，同一份字节再导入时会被
  //   当成「已存在」（见 storeImported）。返回删掉的主文件个数（glb / meta）
  function removeUserFiles(x) {
    let n = 0
    if (rmQuiet(x.glbFile)) n++
    if (rmQuiet(x.metaFile)) n++
    rmQuiet(x.metaFile + '.bak'); rmQuiet(x.metaFile + '.tmp'); rmQuiet(x.glbFile + '.tmp')
    return n
  }
  async function remove(id) {
    const sid = String(id || '')
    const cat = await catalog()
    const m = cat.byId.get(sid)
    if (!m) return { ok: false, removed: 0 }
    cancel(sid)
    let removed = 0
    const rm = (f) => { if (rmQuiet(f)) removed++ }
    const u = cat.userFiles.get(sid)
    if (u) {
      removed += removeUserFiles(u)
      // 同 id 被顶替下来的旧文件（见 buildCatalog 的 shadowed）一并清掉，否则删完它又冒出来
      for (const x of u.shadowed) removeUserFiles(x)
      // 缩略图：没有别的条目引用它才删
      const t = m.files && m.files.thumb && m.files.thumb.sha256
      if (t && !cat.list.some((x) => x.id !== sid && x.files && x.files.thumb && x.files.thumb.sha256 === t)) rm(path.join(dir.thumbs, t + '.webp'))
    } else {
      const keys = []
      for (const l of L.LODS) {
        const f = m.files && m.files[l]
        if (!f || !L.SHA_RE.test(String(f.sha256 || ''))) continue
        // 另一个条目也引用同一个 blob（多文件条目共用 lod2 之类）就留着
        if (cat.list.some((x) => x.id !== sid && L.LODS.some((k) => x.files && x.files[k] && x.files[k].sha256 === f.sha256))) continue
        rm(path.join(dir.blobs, f.sha256 + '.glb')); rm(path.join(dir.blobs, f.sha256 + '.glb.part'))
        keys.push(f.sha256 + '.glb')
      }
      if (keys.length) setState(L.dropState(state(), keys))
    }
    invalidate()
    emit({ type: 'manifest' })
    emit({ type: 'cache', ...cacheInfo() })
    return { ok: true, removed }
  }

  /* ─────────────── 导出（四道闸之一：导出 glb） ─────────────── */
  async function exportModel(o, win) {
    const id = String((o && o.id) || '')
    const { G, S } = await core()
    const meta = await getMeta(id)
    if (!meta) return { ok: false, code: 'missing' }
    // ★ 授权闸：redistributable=false（STK 本机模型）一律不许导出成独立文件（AGI SLA §2(k)/§2.3(d)）。
    //   以主进程记录的 meta 为准；再对送来的字节做兜底（与导入同一套判据）：AGI 署名 / 有 AGI 扩展却没有
    //   extras.satsim / extras.satsim 自声明不可再分发 / 字节恰好等于已入库的 STK 件或本机 STK 目录里的某个文件
    //   —— 防渲染端换个 id 把 STK 模型带出去。
    if (!S.isRedistributable(meta)) return { ok: false, code: 'not-redistributable' }
    const cat = await catalog()
    // 装配件兜底：引用件（失败即关的 asmModelRefs）查不到或不可分发 → 同样不许导出（建目录时的收紧没赶上 / 回写失败也挡得住）
    if (ASM_ID_RE.test(id) && S.asmModelRefs(meta.spec).some((rid) => { const r = cat.byId.get(rid); return !r || !S.isRedistributable(r) })) return { ok: false, code: 'not-redistributable' }
    const glb = toU8(o && o.glb)
    if (!glb || !L.isGlb(glb)) return { ok: false, code: 'bad-glb' }
    const p = G.parseGlb(glb)
    if (!p.ok) return { ok: false, code: 'bad-glb', error: p.error }
    const h = sha256(glb)
    if (cat.stkShas.has(h) || (await stkVerdict({ json: p.json, sha: h, size: glb.length }))) return { ok: false, code: 'not-redistributable' }
    if (!E.dialog) return { ok: false, code: 'canceled' }
    const suggested = String((o && o.suggestedName) || meta.title || 'model').replace(/[\\/:*?"<>|]+/g, '_').replace(/\.glb$/i, '') + '.glb'
    const dlgOpts = { title: '导出模型', defaultPath: suggested, filters: [{ name: 'glTF 二进制 (*.glb)', extensions: ['glb'] }] }
    const r = win ? await E.dialog.showSaveDialog(win, dlgOpts) : await E.dialog.showSaveDialog(dlgOpts)
    if (!r || r.canceled || !r.filePath) return { ok: false, code: 'canceled' }
    try {
      fs.writeFileSync(r.filePath, glb)
      const stem = r.filePath.replace(/\.glb$/i, '')
      if (o.gmdf && typeof o.gmdf === 'object') fs.writeFileSync(stem + '.gmdf', JSON.stringify(plain(o.gmdf), null, 2))
      if (o.satsimJson && typeof o.satsimJson === 'object') fs.writeFileSync(stem + '.satsim.json', JSON.stringify(plain(o.satsimJson), null, 2))
    } catch (e) { return { ok: false, code: 'write', error: errText(e) } }
    log.info(`[models] 导出 ${id} → ${r.filePath}`)
    return { ok: true, path: r.filePath }
  }

  /* ─────────────── 绑定表（userData/models.bindings.json） ─────────────── */
  // 读：文件不存在 → 空表；读到的一律过 validateBindings 清洗（坏条目丢弃）。
  // 损坏（主文件与 .bak 都解析不出）→ 空表 + corrupt:true，界面照常显示默认，但写入会被拒（见 bindingsSet）
  async function bindingsGet() {
    const { S } = await core()
    const r = readJsonSafe(bindingsFile, null)
    const v = S.validateBindings(r.value && typeof r.value === 'object' ? r.value : { schema: 1 })
    const out = plain(v.bindings)
    if (r.corrupt) out.corrupt = true
    return out
  }
  async function bindingsSet(o) {
    const { S } = await core()
    // 读-改-写，读到损坏就放弃这次写（storage.mutate 同一口径：宁可不更新，不能拿空表覆盖整份绑定）
    const r = readJsonSafe(bindingsFile, null)
    if (r.corrupt) { log.warn('[models] models.bindings.json 与 .bak 均无法解析，本次写入已放弃'); return { ok: false, code: 'corrupt' } }
    const base = r.value == null ? { schema: 1 } : r.value
    const cur0 = S.validateBindings(base)
    if (!cur0.ok) { log.warn(`[models] models.bindings.json 结构不对（${cur0.errors.join('；')}），本次写入已放弃`); return { ok: false, code: 'corrupt', errors: cur0.errors } }
    const cur = cur0.bindings
    const p = plain(o) || {}
    if (p.prefs && typeof p.prefs === 'object' && !Array.isArray(p.prefs)) cur.prefs = { ...cur.prefs, ...p.prefs }
    const key = typeof p.satKey === 'string' ? p.satKey : null
    if (key !== null) {
      if (!S.isValidSatKey(key)) return { ok: false, code: 'bad-key' }
      if (p.binding == null) delete cur.bindings[key]
      else if (typeof p.binding === 'object' && !Array.isArray(p.binding)) cur.bindings[key] = p.binding
      else return { ok: false, code: 'bad-binding' }
    }
    const v = S.validateBindings(cur)
    if (!v.ok) return { ok: false, code: 'invalid', errors: v.errors }
    // 本次写的这一条被清洗丢掉了 = 入参不合法，不落盘（别让「点了没反应」变成「点了把别的也洗了」）
    // 这一条被清洗改动过（比如非法模型 id 被悄悄改成 auto）也算不合法 —— 用户点的是 A，存进去的却是 auto
    if (key !== null && p.binding != null && (!v.bindings.bindings[key] || v.errors.some((e) => e.includes(JSON.stringify(key))))) return { ok: false, code: 'invalid', errors: v.errors }
    try { writeJsonAtomic(bindingsFile, v.bindings, 2) } catch (e) { return { ok: false, code: 'write', error: errText(e) } }
    emit({ type: 'bindings', satKey: key || undefined })
    return v.errors.length ? { ok: true, warnings: v.errors } : { ok: true }
  }

  /* ─────────────── 本体遮挡掩模（D18：masks/<sig>.bin） ─────────────── */
  // 工作台「分析」页算完（bodyMaskPool → mask.mjs encodeMask）经 models:saveMask 落盘，挂点上只存签名 maskSig
  // （对日扫描另存 12 张，签名记在 maskSun.sigs）；读端经 models:getMask(sig) 取回原样字节、渲染端 decodeMask。
  // 掩模不塞进绑定表（每挂点 ~430 KB base64 会把 models.bindings.json 撑爆），也不跨星共享之外做任何事：同签名 = 同一张。
  // 签名直接拼文件名，所以只收 MASK_SIG_RE（与 schema.mjs 同一条）。
  // 校验写前、读后各一遍：头 16 B 与总长（decodeMask）+ 内容不变式（blocked ∈ {0,1}；clearance 非 NaN、≥ 0；遮挡格的
  // clearance 有限 —— mask.mjs buildMask 与 bodyMask.worker 都这么填）。被截断 / 被别的程序改过的文件读出来是 null
  // （「坏文件拒读」），读端按「没有掩模」处理，工作台重算一次即覆盖。
  const maskFile = (sig) => path.join(dir.masks, sig + '.bin')
  function maskBytesOk(K, u8) {
    const m = K.decodeMask(u8)
    if (!m) return false
    const b = m.blocked, c = m.clearance
    for (let i = 0; i < b.length; i++) {
      const v = c[i]
      if (b[i] > 1 || !(v >= 0)) return false        // !(v >= 0) 同时挡住 NaN 与负数
      if (b[i] === 1 && v === Infinity) return false
    }
    return true
  }
  async function saveMask(o) {
    const sig = o && typeof o.sig === 'string' ? o.sig : ''
    if (!MASK_SIG_RE.test(sig)) return { ok: false, code: 'bad-sig' }
    const K = await loadMod('mask')
    let bytes = toU8(o.bytes)
    if (!bytes && o.blocked && o.clearance) {
      // {blocked, clearance} 两个数组：这里按 D18 编码（与渲染端 encodeMask 同一个函数）
      const blocked = toU8(o.blocked) || (Array.isArray(o.blocked) && o.blocked.every((v) => v === 0 || v === 1) ? Uint8Array.from(o.blocked) : null)
      const clearance = o.clearance instanceof Float32Array ? o.clearance
        : (ArrayBuffer.isView(o.clearance) || Array.isArray(o.clearance) ? Float32Array.from(o.clearance) : null)
      if (blocked && clearance && blocked.length === K.MASK_N && clearance.length === K.MASK_N) bytes = K.encodeMask({ blocked, clearance })
    }
    if (!bytes || !maskBytesOk(K, bytes)) return { ok: false, code: 'bad-mask' }
    try {
      mk(dir.masks)
      writeFileAtomic(maskFile(sig), Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    } catch (e) {
      log.warn(`[models] 写掩模 ${sig}.bin 失败：${errText(e)}`)
      return { ok: false, code: 'write', error: errText(e) }
    }
    try { pruneMasks(sig) } catch (e) { log.warn(`[models] 清理掩模失败：${errText(e)}`) }
    return { ok: true, sig, bytes: bytes.length }
  }
  async function getMask(sig) {
    const s = typeof sig === 'string' ? sig : ''
    if (!MASK_SIG_RE.test(s)) return null
    let buf
    try { buf = await fsp.readFile(maskFile(s)) } catch { return null }
    const K = await loadMod('mask')
    if (buf.length !== K.MASK_BYTES || !maskBytesOk(K, buf)) {
      log.warn(`[models] 掩模 ${s}.bin 已损坏（${buf.length} 字节），拒读`)
      return null
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  }
  // 绑定里还在引用的签名（maskSig + maskSun.sigs）。读原始文件、不过 validateBindings：清洗口径变了也不该误删；
  // 绑定表读不出（主文件与 .bak 都坏）→ null = 一张都不清，宁可多占盘
  function liveMaskSigs() {
    const r = readJsonSafe(bindingsFile, null)
    if (r.corrupt) return null
    const out = new Set()
    const bs = r.value && r.value.bindings && typeof r.value.bindings === 'object' ? r.value.bindings : {}
    for (const b of Object.values(bs)) {
      for (const m of (b && Array.isArray(b.mounts) ? b.mounts : [])) {
        if (!m || typeof m !== 'object') continue
        if (typeof m.maskSig === 'string') out.add(m.maskSig)
        const ss = m.maskSun && Array.isArray(m.maskSun.sigs) ? m.maskSun.sigs : []
        for (const s of ss) if (typeof s === 'string') out.add(s)
      }
    }
    return out
  }
  // 超过 maskKeep 张：没人引用、且过了保护期的按修改时间从旧往新删，删到不超为止。返回删掉的张数
  function pruneMasks(fresh) {
    let names
    try { names = fs.readdirSync(dir.masks) } catch { return 0 }
    const bins = names.filter((n) => /\.bin$/.test(n) && MASK_SIG_RE.test(n.slice(0, -4)))
    if (bins.length <= maskKeep) return 0
    const live = liveMaskSigs()
    if (!live) return 0
    const t = now()
    const cand = []
    for (const n of bins) {
      const sig = n.slice(0, -4)
      if (sig === fresh || live.has(sig)) continue
      const st = statOr(path.join(dir.masks, n))
      if (!st || t - st.mtimeMs < maskGraceMs) continue
      cand.push({ n, m: st.mtimeMs })
    }
    cand.sort((a, b) => a.m - b.m || (a.n < b.n ? -1 : 1))
    let over = bins.length - maskKeep
    let removed = 0
    for (const c of cand) {
      if (over <= 0) break
      if (rmQuiet(path.join(dir.masks, c.n))) { removed++; over-- }
    }
    if (removed) log.info(`[models] 清理掩模 ${removed} 张（没人引用、超过 ${maskKeep} 张）`)
    return removed
  }

  /* ─────────────── 表格导出（分析页：万向节 / 星侧太阳侵入 / 功率时间序列、掩模 CSV） ─────────────── */
  // 表格版式走 gridXlsx（与性能指标表、链路预算报告同一套三线表 / 朴素两档），这里只把 {cols, rows} 摊成它的 {header, cols, rows}；
  // 列头 = 标签 + 括号单位（与 src/shared/gridXlsx.js colLabel 同款）。CSV 两种入参：现成文本（maskToCsv）或一张表。
  // 大表（合计 > tableStreamRows 行，分析页一年 60 s 一拍就是 52 万行）改走 writeTableXlsxStream：同一版式逐行流式落盘、
  // 每千行让出一次事件循环 —— 整本 exceljs 对象 + 全表自适应列宽在主进程里一口气做，52 万行要堵 30 s、占 3 GB。
  async function exportTable(o, win) {
    const p = await inflateJoined(o && typeof o === 'object' ? o : {})
    const csv = p.format === 'csv'
    let payload
    try { payload = csv ? tableCsvText(p) : tableSpec(p) } catch (e) { return { ok: false, error: errText(e) } }
    if (!E.dialog) return { ok: false, canceled: true }
    const ext = csv ? 'csv' : 'xlsx'
    const stem = String(p.defaultName || '表格').replace(/[\\/:*?"<>|]+/g, '_').replace(/\.(xlsx|csv)$/i, '').trim() || '表格'
    const dlgOpts = {
      title: typeof p.title === 'string' && p.title ? p.title : '导出',
      defaultPath: `${stem}.${ext}`,
      filters: [csv ? { name: 'CSV 文本', extensions: ['csv'] } : { name: 'Excel 工作簿', extensions: ['xlsx'] }]
    }
    const r = win ? await E.dialog.showSaveDialog(win, dlgOpts) : await E.dialog.showSaveDialog(dlgOpts)
    if (!r || r.canceled || !r.filePath) return { ok: false, canceled: true }
    try {
      if (csv) fs.writeFileSync(r.filePath, payload)
      else if (payload.sheets.reduce((s, sh) => s + sh.src.n, 0) > tableStreamRows) await writeTableXlsxStream(payload, r.filePath)
      else fs.writeFileSync(r.filePath, Buffer.from(await require('./gridXlsx').buildGridWorkbook(gridModelOf(payload))))
    } catch (e) {
      const busy = e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES')
      return { ok: false, error: busy ? `文件可能正被其他程序打开（如 ${csv ? '记事本 / Excel' : 'Excel'}），请关闭后重试` : errText(e) }
    }
    log.info(`[models] 导出表格 → ${r.filePath}`)
    return { ok: true, filePath: r.filePath }
  }

  /* ─────────────── 原生对话框 / 读文件 / 打开目录 ─────────────── */
  async function pickFiles(win) {
    if (!E.dialog) return []
    const opt = {
      title: '导入 3D 模型', properties: ['openFile', 'multiSelections'],
      filters: [{ name: '3D 模型', extensions: MODEL_EXTS }, { name: '所有文件', extensions: ['*'] }]
    }
    const r = win ? await E.dialog.showOpenDialog(win, opt) : await E.dialog.showOpenDialog(opt)
    if (!r || r.canceled || !Array.isArray(r.filePaths)) return []
    return r.filePaths.map((p) => { const s = statOr(p); return { path: p, name: path.basename(p), ext: extOf(p), bytes: s ? s.size : 0 } })
  }
  async function pickStkDir(win) {
    if (!E.dialog) return { canceled: true }
    const opt = { title: '选择 STK 模型目录', properties: ['openDirectory'], defaultPath: statOr(defaultStkDir()) ? defaultStkDir() : undefined }
    const r = win ? await E.dialog.showOpenDialog(win, opt) : await E.dialog.showOpenDialog(opt)
    if (!r || r.canceled || !r.filePaths || !r.filePaths[0]) return { canceled: true }
    return { dir: r.filePaths[0] }
  }
  // 授权闸也管这条通道：它是给渲染端解析 OBJ / STL / FBX（+ .mtl / 贴图）用的。若放 STK 的东西进去，
  // 渲染端 three 解析、再导出一遍（extras.satsim 由渲染端重写成「用户件」）、经 saveImported 送回来，
  // 就把 STK 模型洗成了可再分发的用户件。所以 STK 安装树里的文件一律不给读；glb / gltf 再过一遍
  // 与导入同一套判据（署名 / AGI 扩展 / 字节）
  async function readFile(p) {
    const f = String(p || '')
    if (!f || !path.isAbsolute(f)) return { ok: false, error: '路径不合法' }
    const ext = extOf(f)
    if (!READ_EXTS.has(ext)) return { ok: false, error: '不支持的文件类型' }
    const s = await fsp.stat(f).catch(() => null)
    if (!s || !s.isFile()) return { ok: false, error: '文件不存在' }
    if (s.size > MAX_READ_BYTES) return { ok: false, error: '文件过大' }
    const refused = { ok: false, code: 'stk', error: 'STK 模型不可由此导入。' }
    if (L.isStkPath(f, [defaultStkDir()])) return refused
    try {
      const bytes = await fsp.readFile(f)
      if (ext === 'glb' || ext === 'gltf') {
        let json = null
        if (ext === 'glb') { if (L.isGlb(bytes)) { const { G } = await core(); const r = G.parseGlb(bytes); if (r.ok) json = r.json } }
        else { try { json = JSON.parse(bytes.toString('utf8').replace(/^﻿/, '')) } catch { /* 不是 JSON：交给渲染端报错 */ } }
        const stk = await stkVerdict({ json, sha: sha256(bytes), size: bytes.length })
        if (stk) { log.info(`[models] readFile 拒读 STK 件（${stk}）：${path.basename(f)}`); return refused }
      }
      return { bytes, name: path.basename(f), dir: path.dirname(f) }
    } catch (e) { return { ok: false, error: errText(e) } }
  }
  async function openCacheDir() {
    mk(modelsDir)
    if (E.shell && typeof E.shell.openPath === 'function') await E.shell.openPath(modelsDir)
    return true
  }

  /* ─────────────── models:// 协议 ─────────────── */
  // 返回标准 Response（Electron protocol.handle 与 Node 20+ 都有全局 Response）。非法 400、缺件 404，绝不抛。
  async function handleProtocol(req) {
    const cors = { 'access-control-allow-origin': '*' }
    try {
      const M = _mods['manifest:v']
      const re = M && M.PROTOCOL_PATH_RE instanceof RegExp ? M.PROTOCOL_PATH_RE : L.PROTOCOL_PATH_RE
      const r = L.resolveProtocolUrl(req && req.url, { user: modelsDir, bundle: bundleDir }, { join: path.join, pathRe: re })
      if (r.status !== 200) return new Response(r.reason, { status: 400, headers: cors })
      for (const f of r.files) {
        const s = await fsp.stat(f).catch(() => null)
        if (!s || !s.isFile()) continue
        const headers = { ...cors, 'content-type': r.contentType, 'cache-control': r.cacheControl, 'content-length': String(s.size) }
        if (s.size > STREAM_ABOVE) {
          // 大件（ISS lod0 约 91 MB）流式回：整块 readFile 会在主进程里一次占住同等大小的内存
          const { Readable } = require('stream')
          return new Response(Readable.toWeb(fs.createReadStream(f)), { status: 200, headers })
        }
        return new Response(await fsp.readFile(f), { status: 200, headers })
      }
      return new Response('not found', { status: 404, headers: cors })
    } catch (e) {
      return new Response('err', { status: 500, headers: cors })
    }
  }

  return {
    modelsDir, bundleDir, bindingsFile, onChange, start, stop,
    manifest, ensure, thumbnail, cancel, remove, cacheInfo, setCacheCap, openCacheDir, refreshManifest,
    pickFiles, readFile, importGlb, importCad, saveImported, scanStk, pickStkDir, importStk,
    saveMeta, getMeta, exportModel, saveThumb, bindingsGet, bindingsSet, handleProtocol,
    saveMask, getMask, exportTable,
    defaultStkDir,
    // 以下仅供单测
    _flush: flushState, _state: () => state(), _evict: evict, _jobs: jobs, _core: core, _pruneMasks: pruneMasks, _maskFile: maskFile
  }
}

/* ─────────────── 表格模型（exportTable 的纯函数部分，单测直接调） ─────────────── */
const TABLE_MAX_SHEETS = 32
const TABLE_MAX_ROWS = 1048575                  // Excel 单表行数上限减表头一行
const TABLE_MAX_COLS = 1024
const TABLE_MAX_CSV = 64 * 1024 * 1024
const TABLE_STREAM_ROWS = 5000                  // 合计超过这么多行改走流式写（整本对象 + 全表自适应在 5000 行约 0.15 s，再往上线性涨）
const ALIGNS = new Set(['left', 'center', 'right'])
function tableCols(sh, i) {
  const list = Array.isArray(sh && sh.cols) ? sh.cols : []
  if (!list.length) throw new Error(`第 ${i + 1} 张表没有列`)
  if (list.length > TABLE_MAX_COLS) throw new Error(`第 ${i + 1} 张表列数超过 ${TABLE_MAX_COLS}`)
  return list.map((c, k) => {
    const x = c && typeof c === 'object' ? c : {}
    const key = typeof x.key === 'string' || Number.isFinite(x.key) ? String(x.key) : String(k)
    const fix = Number.isInteger(x.fix) && x.fix >= 0 && x.fix <= 12 ? x.fix : undefined
    return {
      key,
      label: x.label == null ? key : String(x.label),
      unit: x.unit == null || x.unit === '' ? '' : String(x.unit),
      num: !!x.num, fix, align: ALIGNS.has(x.align) ? x.align : undefined
    }
  })
}
// 格子值口径与 src/shared/gridXlsx.js sheetModel 一致：空 → null；数字只收有限值；数字列的数字串转成数；其余转成串
function tableCell(v, c) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (c.num) { const n = Number(String(v).replace(/[, ]/g, '')); if (Number.isFinite(n)) return n }
  return String(v)
}
// 一张表的行数与「第 r 行第 k 列的原值」。两种入参：
//   行式 rows:[{key: 值} | [值] | typed array]；
//   列式 n + columns:[每列一个数组 / typed array / {join}，与 cols 同序]（preload 给大表打的包：几十万个行对象过结构化克隆要在主进程里
//   反序列化半秒；数字列一个 Float64Array、文字列 {join: 以 U+001F 连起来的一个长串} 都只是一次拷贝）。
//   {join} 在 exportTable 里先按时间片拆回数组（inflateJoined）；直接调 tableSpec 的（单测 / CSV）这里同步拆。
const isArrLike = (x) => Array.isArray(x) || (ArrayBuffer.isView(x) && !(x instanceof DataView))
const TABLE_JOIN_SEP = '\u001f'
const isJoined = (c) => !!c && typeof c === 'object' && !isArrLike(c) && typeof c.join === 'string'
async function splitJoinedAsync(text, pause) {
  const out = []
  let at = 0, k = 0, t0 = Date.now()
  for (;;) {
    const j = text.indexOf(TABLE_JOIN_SEP, at)
    if (j < 0) { out.push(text.slice(at)); return out }
    out.push(text.slice(at, j))
    at = j + 1
    if ((++k & 8191) === 0 && Date.now() - t0 > 15) { await pause(); t0 = Date.now() }
  }
}
/** 列式表里的 {join} 列按时间片拆回字符串数组（返回新对象，不改入参） */
async function inflateJoined(p) {
  const sheets = Array.isArray(p && p.sheets) ? p.sheets : null
  if (!sheets || !sheets.some((sh) => sh && Array.isArray(sh.columns) && sh.columns.some(isJoined))) return p
  const pause = () => new Promise((r) => setImmediate(() => setImmediate(r)))   // 两层：真正隔开一轮事件循环（同 register.js 的 nextTurn）
  const out = []
  for (const sh of sheets) {
    if (!(sh && Array.isArray(sh.columns) && sh.columns.some(isJoined))) { out.push(sh); continue }
    const columns = []
    for (const c of sh.columns) columns.push(isJoined(c) ? await splitJoinedAsync(c.join, pause) : c)
    out.push({ ...sh, columns })
  }
  return { ...p, sheets: out }
}
function tableSource(sh, cols, i) {
  if (Array.isArray(sh.columns)) {
    const n = sh.n
    if (!Number.isInteger(n) || n < 0) throw new Error(`第 ${i + 1} 张表的行数不对`)
    const data = cols.map((_, k) => { const c = sh.columns[k]; return isJoined(c) ? c.join.split(TABLE_JOIN_SEP) : c })
    if (data.some((a) => a != null && !(isArrLike(a) && a.length >= n))) throw new Error(`第 ${i + 1} 张表的列数据长度不对`)
    return { n, at: (r, k) => { const a = data[k]; return a ? a[r] : null } }
  }
  const rows = Array.isArray(sh.rows) ? sh.rows : []
  return {
    n: rows.length,
    at: (r, k) => { const x = rows[r]; return isArrLike(x) ? x[k] : (x && typeof x === 'object' ? x[cols[k].key] : null) }
  }
}
/** 入参校验 + 归一（不摊行）：{style, title, sheets:[{name, note, cols, header, src:{n, at(r, k)}}]}。坏入参抛中文错误 */
function tableSpec(p) {
  const sheets = Array.isArray(p && p.sheets) ? p.sheets.filter((s) => s && typeof s === 'object') : []
  if (!sheets.length) throw new Error('没有可导出的数据')
  if (sheets.length > TABLE_MAX_SHEETS) throw new Error(`工作表超过 ${TABLE_MAX_SHEETS} 张`)
  return {
    style: p.style === 'plain' ? 'plain' : 'report',
    title: typeof p.title === 'string' ? p.title : undefined,
    sheets: sheets.map((sh, i) => {
      const cols = tableCols(sh, i)
      const src = tableSource(sh, cols, i)
      if (src.n > TABLE_MAX_ROWS) throw new Error(`第 ${i + 1} 张表超过 Excel 行数上限`)
      return {
        name: sh.name == null || sh.name === '' ? `Sheet${i + 1}` : String(sh.name),
        note: typeof sh.note === 'string' ? sh.note : '',
        cols,
        header: cols.map((c) => c.label + (c.unit ? ` (${c.unit})` : '')),
        src
      }
    })
  }
}
const rowCells = (sh, r) => sh.cols.map((c, k) => tableCell(sh.src.at(r, k), c))
/** tableSpec → gridXlsx.buildGridWorkbook 的模型（行摊开） */
function gridModelOf(spec) {
  return {
    style: spec.style,
    title: spec.title,
    sheets: spec.sheets.map((sh) => ({
      name: sh.name, note: sh.note, header: sh.header,
      cols: sh.cols.map((c) => ({ num: c.num, fix: c.fix, align: c.align })),
      rows: Array.from({ length: sh.src.n }, (_, r) => rowCells(sh, r))
    }))
  }
}
/** {sheets:[{name, cols, rows | n + columns, note?}], style?, title?} → gridXlsx.buildGridWorkbook 的模型（style 缺省 'report' 三线表） */
function tableGridModel(p) { return gridModelOf(tableSpec(p)) }
/** CSV：{text} 原样（maskToCsv 那种）或第一张表按 RFC 4180 转义（CRLF 行尾）；含非 ASCII 时前置 BOM（Excel 才按 UTF-8 打开）。→ Buffer */
function tableCsvText(p) {
  let text
  if (typeof (p && p.text) === 'string') text = p.text
  else {
    const sh = tableSpec({ sheets: Array.isArray(p && p.sheets) ? p.sheets.slice(0, 1) : [] }).sheets[0]
    const esc = (v, c) => {
      if (v == null) return ''
      const s = typeof v === 'number' ? (c && c.fix !== undefined ? v.toFixed(c.fix) : String(v)) : String(v)
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
    }
    const lines = [sh.header.map((h) => esc(h)).join(',')]
    let len = lines[0].length
    for (let r = 0; r < sh.src.n; r++) {
      const line = rowCells(sh, r).map((v, k) => esc(v, sh.cols[k])).join(',')
      len += line.length + 2
      if (len > TABLE_MAX_CSV) throw new Error('文本过大')
      lines.push(line)
    }
    text = lines.join('\r\n') + '\r\n'
  }
  if (!text) throw new Error('没有可导出的数据')
  if (text.length > TABLE_MAX_CSV) throw new Error('文本过大')
  // eslint-disable-next-line no-control-regex
  const bom = /[^\x00-\x7f]/.test(text) && text.charCodeAt(0) !== 0xfeff ? '﻿' : ''
  return Buffer.from(bom + text, 'utf8')
}

// ── 大表流式写 xlsx ──
// 版式与 gridXlsx.buildGridWorkbook 逐项同款（两档：report 三线表 / plain 朴素表；首行表头 + 纯数据、冻结首行、说明另开一张表；
// 报告档中西文字体归位 fixCellFont + 主题字体换 TNR / 宋体）—— 改那边的版式记得改这边的 tableHeadCell / tableDataCell。
// 差别只在「怎么写」：exceljs 的流式 WorkbookWriter 逐行 commit 落盘（内存不随行数涨），每 500 行让出一次事件循环；
// 列宽与表头行高不能等全表写完再量，改由「表头 + 抽样行（前 1000 行 + 均匀抽 1000 行 + 末行）」照同款版式写进一本小工作簿、
// 跑 reportAutofit.autofitSheet 量出来 —— 分析页的时间序列各行同构，抽样量的与全表量的一致。
// 先写到同目录的 .part 临时文件，写完再改名覆盖目标（半截文件不会顶掉用户原来的那份）。
const T_INK = 'FF17181A', T_HEAD_FILL = 'FFEDEFF2'
const T_MED = { style: 'medium', color: { argb: 'FF3A3F45' } }
const T_HAIR = { style: 'hair', color: { argb: 'FFB9BEC5' } }
const T_R_MED = { style: 'medium', color: { argb: 'FF000000' } }
const T_R_THIN = { style: 'thin', color: { argb: 'FF000000' } }
const tNumFmt = (fix) => (fix == null || !(fix >= 0) ? null : (fix === 0 ? '0' : '0.' + '0'.repeat(fix)))
function tableHeadCell(cell, label, c, rpt, F) {
  cell.value = label == null ? '' : String(label)
  if (rpt) {
    cell.font = { name: F.HEI, size: F.size, color: { argb: 'FF000000' } }
    cell.alignment = { vertical: 'middle', horizontal: c.num ? 'right' : (c.align || 'center'), wrapText: true }
    cell.border = { top: T_R_MED, bottom: T_R_THIN }
  } else {
    cell.font = { name: F.FNT, size: 10, bold: true, color: { argb: T_INK } }
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: false }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: T_HEAD_FILL } }
    cell.border = { top: T_MED, bottom: T_MED, left: T_HAIR, right: T_HAIR }
  }
}
function tableDataCell(cell, v, c, rpt, F) {
  cell.value = v === '' || v === undefined || v === null ? null : v
  if (rpt) {
    cell.font = { name: c.num ? F.FNT : F.SONG, size: F.size, color: { argb: 'FF000000' } }
    cell.alignment = { vertical: 'middle', horizontal: c.num ? 'right' : (c.align || 'center') }
  } else {
    cell.font = { name: F.FNT, size: 10, color: { argb: T_INK } }
    cell.alignment = { vertical: 'middle', horizontal: c.num ? 'right' : (c.align || 'left') }
    cell.border = { left: T_HAIR, right: T_HAIR, bottom: T_HAIR }
  }
  if (c.num) { const f = tNumFmt(c.fix); if (f) cell.numFmt = f }
}
const lastRowBorder = (cell, rpt) => { cell.border = Object.assign({}, cell.border, { bottom: rpt ? T_R_MED : T_MED }) }
function sampleRowIdx(n) {
  if (n <= 2001) return Array.from({ length: n }, (_, i) => i)
  const out = []
  for (let i = 0; i < 1000; i++) out.push(i)
  const step = (n - 1000) / 1000
  for (let k = 0; k < 1000; k++) out.push(1000 + Math.floor(k * step))
  out.push(n - 1)
  return out
}
async function writeTableXlsxStream(spec, filePath, opt = {}) {
  const ExcelJS = require('exceljs')
  const { autofitSheet } = require('./reportAutofit')
  const X = require('./xlsxFont')
  const { safeSheetName } = require('./gridXlsx')
  const { TPL: RSTY } = require('./reportStyle')
  const F = { FNT: X.FNT, SONG: X.SONG, HEI: X.HEI, size: RSTY.size.table }
  const rpt = spec.style === 'report'
  const every = Number.isInteger(opt.yieldEvery) && opt.yieldEvery > 0 ? opt.yieldEvery : 500
  const pause = () => new Promise((r) => setImmediate(() => setImmediate(r)))   // 两层：真正隔开一轮事件循环（同 register.js 的 nextTurn）
  // 探针：量列宽 / 表头行高；报告档顺带借它拿换好主题字体的 theme1.xml
  const probe = new ExcelJS.Workbook()
  const usedP = new Set()
  const fit = []
  for (const sh of spec.sheets) {
    const ws = probe.addWorksheet(safeSheetName(sh.name, usedP))
    const hr = ws.getRow(1)
    sh.header.forEach((h, k) => tableHeadCell(hr.getCell(k + 1), h, sh.cols[k], rpt, F))
    hr.height = rpt ? 22 : 17
    sampleRowIdx(sh.src.n).forEach((r, j) => {
      const row = ws.getRow(j + 2)
      rowCells(sh, r).forEach((v, k) => tableDataCell(row.getCell(k + 1), v, sh.cols[k], rpt, F))
      if (rpt) row.height = 16
    })
    await pause()
    autofitSheet(ws)
    fit.push({ widths: sh.cols.map((_, k) => ws.getColumn(k + 1).width), headHeight: hr.height })
    await pause()
  }
  const notes = spec.sheets.filter((s) => s.note)
  const noteCell = (cell, text, head) => {
    cell.value = text
    cell.font = { name: rpt ? (head ? F.HEI : F.SONG) : F.FNT, size: rpt ? F.size : 10, bold: head && !rpt, color: { argb: rpt ? 'FF000000' : T_INK } }
  }
  let noteWidths = null
  if (notes.length) {
    const ws = probe.addWorksheet(safeSheetName('说明', usedP))
    notes.forEach((s, i) => { const row = ws.getRow(i + 1); noteCell(row.getCell(1), String(s.name || ''), true); noteCell(row.getCell(2), String(s.note), false) })
    autofitSheet(ws)
    noteWidths = [ws.getColumn(1).width, ws.getColumn(2).width]
  }
  let theme = null
  if (rpt) { X.applyBookFont(probe); theme = probe._themes && probe._themes.theme1 }
  await pause()

  const tmp = `${filePath}.part-${process.pid}-${Date.now().toString(36)}`
  // 流式 writer 在构造函数里就把写死的 theme1.xml（Calibri / Cambria）塞进 zip —— 报告档用子类换成与 applyBookFont 同一份
  const Writer = ExcelJS.stream.xlsx.WorkbookWriter
  const Themed = typeof theme === 'string' && theme
    ? class extends Writer { addThemes() { this.zip.append(theme, { name: 'xl/theme/theme1.xml' }); return Promise.resolve() } }
    : Writer
  const wb = new Themed({ filename: tmp, useStyles: true, useSharedStrings: false })
  wb.creator = '卫星仿真平台'
  wb.created = new Date()
  try {
    const used = new Set()
    for (let si = 0; si < spec.sheets.length; si++) {
      const sh = spec.sheets[si], n = sh.src.n
      const ws = wb.addWorksheet(safeSheetName(sh.name, used), { views: [{ state: 'frozen', ySplit: 1 }] })
      fit[si].widths.forEach((w, k) => { if (w > 0) ws.getColumn(k + 1).width = w })
      if (!rpt && sh.cols.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sh.cols.length } }
      const hr = ws.getRow(1)
      sh.header.forEach((h, k) => {
        const cell = hr.getCell(k + 1)
        tableHeadCell(cell, h, sh.cols[k], rpt, F)
        if (!n) lastRowBorder(cell, rpt)
        if (rpt && cell.value != null) X.fixCellFont(cell)
      })
      hr.height = fit[si].headHeight || (rpt ? 22 : 17)
      hr.commit()
      for (let r = 0; r < n; r++) {
        const row = ws.getRow(r + 2)
        const cells = rowCells(sh, r)
        for (let k = 0; k < cells.length; k++) {
          const cell = row.getCell(k + 1)
          tableDataCell(cell, cells[k], sh.cols[k], rpt, F)
          if (r === n - 1) lastRowBorder(cell, rpt)
          // 归位只动字符串格：空格 applyBookFont 同样跳过；数字格 tableDataCell 已写成西文字体（= fixCellFont 的结果）
          if (rpt && typeof cell.value === 'string') X.fixCellFont(cell)
        }
        if (rpt) row.height = 16
        row.commit()
        if ((r + 1) % every === 0) await pause()
      }
      ws.commit()
    }
    if (notes.length) {
      const ws = wb.addWorksheet(safeSheetName('说明', used))
      if (noteWidths) noteWidths.forEach((w, k) => { if (w > 0) ws.getColumn(k + 1).width = w })
      notes.forEach((s, i) => {
        const row = ws.getRow(i + 1)
        noteCell(row.getCell(1), String(s.name || ''), true)
        noteCell(row.getCell(2), String(s.note), false)
        if (rpt) { X.fixCellFont(row.getCell(1)); X.fixCellFont(row.getCell(2)) }
        row.commit()
      })
      ws.commit()
    }
    await wb.commit()
    fs.renameSync(tmp, filePath)
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* 删不掉就留着，下次同名也不会撞（带时间戳） */ }
    throw e
  }
}

// glb.mjs 的 parseGlb / patchGlbJson 回的是 {ok, …} 包装；modelsImport.gltfToGlb 要的是「拿 JSON / 出字节」的直口径
function glbAdapter(G) {
  return {
    parseGlb: (u8) => { const r = G.parseGlb(u8); if (!r.ok) throw new Error(r.error); return r },
    patchGlbJson: (u8, json) => { const r = G.patchGlbJson(u8, () => json); if (!r.ok) throw new Error(r.error); return r.glb }
  }
}

module.exports = createModels
module.exports.createModels = createModels
module.exports.CDN_BASE_PINNED = CDN_BASE_PINNED
module.exports.MASK_SIG_RE = MASK_SIG_RE
module.exports.tableGridModel = tableGridModel
module.exports.tableCsvText = tableCsvText
module.exports.tableSpec = tableSpec
module.exports.writeTableXlsxStream = writeTableXlsxStream
module.exports.walkGlbFiles = walkGlbFiles
