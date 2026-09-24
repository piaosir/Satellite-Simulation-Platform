'use strict'
// 卫星 3D 模型服务的纯决策层（electron/services/models.js 的「脑子」，不碰 electron、不碰网络）。
//
// 为什么单抽一个 CJS 纯模块（与 updaterPending.js 同一个理由）：models.js 里下载、缓存淘汰、
// 协议路径这几件事全在主进程静默运行，出错没有界面反馈；把「怎么判」从「怎么做 I/O」里拆出来，
// 才能在裸 node 里把每一格决策钉死（packages/core/test/modelsLogic.test.mjs）。
// 保持 CJS：主进程的服务都是运行时从磁盘 require 的 CommonJS（Electron 31 = Node 20.18 不能
// require(esm)），纯逻辑与它同构最省事；packages/core/models/*.mjs 那批是渲染端/脚本共用的 ESM，
// 两边重叠的只有「路径白名单正则」一条，单测里逐字对账。
//
// 这里的每个函数都只吃普通数据、吐普通数据；时间一律由调用方传 now，别在这里取 Date.now()。

const LODS = ['lod0', 'lod1', 'lod2']            // 精度由高到低：lod0 原精度，lod2 最粗（库卡片/球面图标用）
const SHA_RE = /^[0-9a-f]{64}$/
// models:// 协议的路径段白名单：只有「64 位小写十六进制 sha256 + 三种扩展名」一种形状。
// 与 packages/core/models/manifest.mjs 的 PROTOCOL_PATH_RE 必须逐字相同（单测对账）——
// 协议 handler 在 manifest.mjs 还没懒加载完之前也得能判，所以这里留一份同形副本。
const PROTOCOL_PATH_RE = /^[0-9a-f]{64}\.(glb|webp|png)$/
const PROTOCOL_HOSTS = ['blobs', 'user', 'builtin', 'thumbs']
const CONTENT_TYPES = { glb: 'model/gltf-binary', webp: 'image/webp', png: 'image/png' }

const GiB = 1024 * 1024 * 1024
const MiB = 1024 * 1024
const DEFAULT_CACHE_CAP = 2 * GiB
const CAP_MIN = 256 * MiB
const CAP_MAX = 1024 * GiB
const PROTECT_MS = 60 * 1000                        // 最近 60 s ensure 过的 = 正在显示，淘汰时跳过
const MAX_RETRIES = 3                               // 下载失败后最多再试 3 次
const RETRY_BASE_MS = 1500
const MAX_STK_DIRS = 8                              // state.json 里记住的「用户选过的 STK 目录」条数上限

/* ================================ 协议 ================================ */

// models://<host>/<sha>.<ext> → 候选文件（按顺序找第一个存在的）。非法一律 { status:400 }，绝不抛。
// dirs = { user: <userData>/models, bundle: <resources>/models }；join 传 path.join（缺省按 / 拼，单测用）
// ★ 主机名转小写：standard 协议下 Chromium 自己会转，但 Node 的 URL 对非特殊协议不转，
//   单测与主进程两边走同一个函数，得自己兜一次。路径段不转——sha 本来就只收小写。
function resolveProtocolUrl(url, dirs, { join, pathRe = PROTOCOL_PATH_RE } = {}) {
  let u
  try { u = new URL(String(url)) } catch { return { status: 400, reason: 'bad url' } }
  if (u.protocol !== 'models:') return { status: 400, reason: 'bad scheme' }
  const host = String(u.hostname || '').toLowerCase()
  if (PROTOCOL_HOSTS.indexOf(host) < 0) return { status: 400, reason: 'bad host' }
  const seg = u.pathname.replace(/^\/+/, '').split('/')
  if (seg.length !== 1 || !pathRe.test(seg[0])) return { status: 400, reason: 'bad path' }
  const name = seg[0]
  const ext = name.slice(name.lastIndexOf('.') + 1)
  const j = typeof join === 'function' ? join : (...p) => p.join('/')
  let files
  if (host === 'blobs') files = [j(dirs.user, 'blobs', name)]
  else if (host === 'user') files = [j(dirs.user, 'user', name)]
  else if (host === 'builtin') files = [j(dirs.bundle, 'builtin', name)]
  else files = [j(dirs.user, 'thumbs', name), j(dirs.bundle, 'thumbs', name)]
  return {
    status: 200, host, name, ext, files,
    contentType: CONTENT_TYPES[ext] || 'application/octet-stream',
    // 内容寻址（文件名就是内容哈希）→ 永不变，让 Chromium 放心缓存；缩略图 host 同样是 sha，
    // 但它先查 userData 再查内置，重新生成后换了 sha 也换了名，一样可以 immutable——
    // 契约只给 blobs/user/builtin 写了 immutable，thumbs 保守起见 no-cache
    cacheControl: host === 'thumbs' ? 'no-cache' : 'public, max-age=31536000, immutable'
  }
}
const modelsUrl = (host, sha, ext) => `models://${host}/${sha}.${ext}`

/* ============================ LRU 缓存淘汰 ============================ */

// entries: [{ key, bytes, lastUsed, lastEnsure }]（只含 blobs/ 下的远端缓存；内置与本机导入不进来）
// busy: 正在下载 / 刚下完还没 ensure 的 key 集合（不许淘汰）
// 返回 { evict: [key…]（最久未用在前）, total, after }
function pickEvictions(entries, { cap, now, protectMs = PROTECT_MS, busy } = {}) {
  const list = (entries || []).filter((e) => e && typeof e.key === 'string' && Number.isFinite(e.bytes) && e.bytes >= 0)
  let total = 0
  for (const e of list) total += e.bytes
  const evict = []
  if (!(cap >= 0) || total <= cap) return { evict, total, after: total }
  const bz = busy instanceof Set ? busy : new Set(busy || [])
  const cand = list
    .filter((e) => !bz.has(e.key) && !(Number.isFinite(e.lastEnsure) && now - e.lastEnsure < protectMs))
    // lastUsed 缺失当 0：从没被 ensure 记过账的（旧版残留 / 状态文件丢了）最先走
    .sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0) || (b.bytes - a.bytes) || (a.key < b.key ? -1 : 1))
  let after = total
  for (const e of cand) {
    if (after <= cap) break
    evict.push(e.key)
    after -= e.bytes
  }
  return { evict, total, after }
}

// min 只给单测放宽（256 MiB 的下限让小夹具测不到淘汰）；产品里一律用缺省
const clampCap = (b, min = CAP_MIN) => {
  const n = Number(b)
  if (!Number.isFinite(n)) return DEFAULT_CACHE_CAP
  return Math.min(CAP_MAX, Math.max(min, Math.round(n)))
}

// state.json 的归一：读出来的东西一律当不可信数据过一遍（手改 / 半截写 / 旧版本）
function normalizeState(raw, minCap = CAP_MIN) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const entries = {}
  const src = r.entries && typeof r.entries === 'object' ? r.entries : {}
  for (const k of Object.keys(src)) {
    if (!PROTOCOL_PATH_RE.test(k)) continue
    const v = src[k]
    const lu = v && Number(v.lastUsed)
    entries[k] = { lastUsed: Number.isFinite(lu) && lu > 0 ? lu : 0 }
  }
  return {
    schema: 1,
    cap: r.cap == null ? DEFAULT_CACHE_CAP : clampCap(r.cap, minCap),
    etag: typeof r.etag === 'string' && r.etag.length < 512 ? r.etag : null,
    lastRefresh: Number.isFinite(Number(r.lastRefresh)) ? Number(r.lastRefresh) : 0,
    entries,
    // 用户经「从 STK 导入」真导入过东西的 STK 目录（授权闸的字节判据要跨重启记得：装在非默认位置的 STK，
    // 下次用户拿「导入文件」从那里选 glb，也得逐字节认出来）。只做字节比对，不做路径前缀判据
    stkDirs: Array.isArray(r.stkDirs)
      ? [...new Set(r.stkDirs.filter((d) => typeof d === 'string' && d && d.length < 1024))].slice(0, MAX_STK_DIRS)
      : []
  }
}
// 记一个 STK 目录（最近的在前，去重按不分大小写的 Windows 口径，封顶 MAX_STK_DIRS）
function rememberStkDir(state, dir) {
  const d = String(dir || '')
  if (!d || d.length >= 1024) return state
  const key = normWinPath(d)
  const cur = Array.isArray(state.stkDirs) ? state.stkDirs : []
  if (cur.length && normWinPath(cur[0]) === key) return state
  return { ...state, stkDirs: [d, ...cur.filter((x) => normWinPath(x) !== key)].slice(0, MAX_STK_DIRS) }
}
function touchState(state, key, now) {
  if (!PROTOCOL_PATH_RE.test(key)) return state
  return { ...state, entries: { ...state.entries, [key]: { lastUsed: now } } }
}
function dropState(state, keys) {
  const entries = { ...state.entries }
  for (const k of keys) delete entries[k]
  return { ...state, entries }
}

/* ============================ 下载状态机 ============================ */

// 一个下载任务的相位：queued → downloading → verifying → ready
//                         ↘ waiting（失败退避中）→ queued …（至多 MAX_RETRIES 次）→ error
//                         ↘ queued（preempt：给小件让道，.part 留着，轮到时 Range 续传；不算失败、不耗重试次数）
//                    任何非终态 + cancel → canceled
// 非法迁移原样返回同一个对象（与 updaterState.reduce 同口径：调用方用 === 判「没变」）。
const DL_TERMINAL = new Set(['ready', 'error', 'canceled'])
function dlInitial() { return { phase: 'queued', received: 0, total: 0, attempt: 0, message: '' } }
function dlReduce(s, ev) {
  if (!s || !ev) return s
  const t = ev.type
  if (t === 'cancel') return DL_TERMINAL.has(s.phase) ? s : { ...s, phase: 'canceled' }
  switch (s.phase) {
    case 'queued':
      if (t === 'start') return { ...s, phase: 'downloading', message: '' }
      return s
    case 'downloading':
      if (t === 'progress') {
        const received = Number(ev.received) || 0
        const total = Number(ev.total) || s.total
        if (received === s.received && total === s.total) return s
        return { ...s, received, total }
      }
      if (t === 'done') return { ...s, phase: 'verifying' }
      if (t === 'fail') return failed(s, ev)
      if (t === 'preempt') return { ...s, phase: 'queued' }
      return s
    case 'verifying':
      if (t === 'verified') return { ...s, phase: 'ready', received: s.total || s.received }
      if (t === 'fail') return failed(s, ev)
      return s
    case 'waiting':
      if (t === 'retry') return { ...s, phase: 'queued' }
      return s
    default:
      return s
  }
}
function failed(s, ev) {
  const message = String((ev && ev.message) || '下载失败')
  // retriable=false：sha256 不符两次、服务端 404 这类「再试也一样」的，直接进 error
  if (ev && ev.retriable === false) return { ...s, phase: 'error', message }
  if (s.attempt >= MAX_RETRIES) return { ...s, phase: 'error', message }
  return { ...s, phase: 'waiting', attempt: s.attempt + 1, message }
}
// 第 n 次重试前等多久（n 从 1 起）：1.5 s、3 s、6 s；超出次数返回 null
function retryDelay(n) {
  if (!(n >= 1) || n > MAX_RETRIES) return null
  return RETRY_BASE_MS * Math.pow(2, n - 1)
}

/* ============================ 下载排队优先级 ============================ */
// 为什么要优先级：队列只有 2 条道，lod0 动辄几十 MB（ISS 约 91 MB）。严格先进先出时，用户先点了两个
// 「下载完整模型」、再在画廊里点第三张卡片，那张卡片的 lod2 预览（契约 §7「选中→先拉 lod2 预览」）要等
// 两个 lod0 下完才开始 —— 几分钟没反应。所以：
//   · 数字小的先走：lod2（预览 / 球面图标，用户正看着）< thumb（画廊缩略图，几十 KB）< lod1 < lod0；
//   · 同档内按 seq 小的先走（新任务排队尾；已在排队的再被 ensure 一次 = 用户还在等它，挪到本档队首）；
//   · 「小件道」：两条道全被大件（lod1/lod0）占着、又有小件在等时，让最后开工的那个大件让道
//     （掐断连接、.part 留着，轮到它时 Range 续传，丢不了已下的字节）。一次只让一个 —— 两条道里始终
//     留一条给小件就够了，小件几百毫秒一个，排在这一条道上依次过。
const DL_PRIORITY = { lod2: 0, thumb: 1, lod1: 2, lod0: 3 }
const SMALL_PRIORITY_MAX = 1
const dlPriority = (lod) => (Object.prototype.hasOwnProperty.call(DL_PRIORITY, lod) ? DL_PRIORITY[lod] : DL_PRIORITY.lod0)
// queued：[{ prio, seq }] → 下一个该开工的（没有返回 null）
function pickNextJob(queued) {
  let best = null
  for (const j of queued || []) {
    if (!j) continue
    if (!best || j.prio < best.prio || (j.prio === best.prio && j.seq < best.seq)) best = j
  }
  return best
}
// 道满时要不要、让谁让道。active：占着道的任务 [{ prio, phase, startedAt, preempting }]；next：pickNextJob 的结果。
// 只在「next 是小件、道上一个小件都没有、没有正在校验马上腾道的、也没有已在让道途中的」时才挑：
// 大件里档最低（lod0 先于 lod1）、同档最后开工的那个 —— 它已下的最少、打断的代价最小。
function pickPreempt(active, next) {
  if (!next || !(next.prio <= SMALL_PRIORITY_MAX)) return null
  const list = (active || []).filter(Boolean)
  if (list.some((j) => j.preempting || j.phase !== 'downloading' || j.prio <= SMALL_PRIORITY_MAX)) return null
  let v = null
  for (const j of list) {
    if (!v || j.prio > v.prio || (j.prio === v.prio && (j.startedAt || 0) > (v.startedAt || 0))) v = j
  }
  return v
}

/* ============================ ensure 选档 ============================ */

// 从 want 出发的找档顺序：先 want，再往粗（lod 号大）走，再往细走。
// 例：want=lod1 → [lod1, lod2, lod0]；want=lod0 → [lod0, lod1, lod2]；want=lod2 → [lod2, lod1, lod0]
function lodOrder(want) {
  const w = LODS.indexOf(want) >= 0 ? LODS.indexOf(want) : LODS.length - 1
  const out = [LODS[w]]
  for (let i = w + 1; i < LODS.length; i++) out.push(LODS[i])
  for (let i = w - 1; i >= 0; i--) out.push(LODS[i])
  return out
}

// 决定 ensure 该做什么（不做 I/O）。
//   id: 模型 id；lod: 请求档（缺省 lod2）；meta: 合并后的条目（含 files）；
//   ready: (lod) => boolean —— 该档在本机（内置 / 缓存 / 本机导入）是否已就绪；
//   downloadable: 该模型的文件能否联网下载（远端条目 true；本机导入 / 离线 false）
// 返回：
//   { kind:'param' }                         参数化模板：渲染端按 spec 现场生成，不走文件
//   { kind:'missing' }                       没有这个模型 / 没有任何档可用
//   { kind:'ready', lod }                    直接用
//   { kind:'download', lod, fallback? }      要下 lod；fallback 是已就绪的另一档，可先顶着显示
// 口径：请求档在 files 里就要它（没就绪就下，同时把已就绪的最近一档作 fallback 递回去先显示）；
// 请求档不在 files 里（比如本机导入只有 lod0、内置只带 lod2）= 「缺档」，按 lodOrder 找第一个有的。
function planEnsure({ id, lod, meta, ready, downloadable }) {
  const sid = String(id || '')
  if (/^param:/.test(sid)) return { kind: 'param' }
  if (!meta || !meta.files) return { kind: 'missing' }
  const isReady = typeof ready === 'function' ? ready : () => false
  const has = (l) => !!(meta.files[l] && SHA_RE.test(String(meta.files[l].sha256 || '')))
  const order = lodOrder(lod).filter(has)
  if (!order.length) return { kind: 'missing' }
  const target = order[0]
  if (isReady(target)) return { kind: 'ready', lod: target }
  const fb = order.find((l) => l !== target && isReady(l))
  if (!downloadable) return fb ? { kind: 'ready', lod: fb } : { kind: 'missing' }
  return fb ? { kind: 'download', lod: target, fallback: fb } : { kind: 'download', lod: target }
}

/* ============================ glb JSON 读取辅助 ============================ */
// 下面几个只读 glTF 的 JSON 块（不解网格）：STK 扫描要在几十个文件上秒出表，导入时也要在
// 不解 Draco / meshopt 的前提下拿到三角形数与包围盒去猜单位。所有字段一律当不可信数据取，
// 缺了、类型不对就跳过，绝不 eval、绝不抛。

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const arr = (v) => (Array.isArray(v) ? v : [])

// 只看 12 字节头：magic 'glTF' + version 2。完整拆包 / 只读 JSON 块用 glb.mjs（parseGlb / readGlbHeaderJson）
function isGlb(b) {
  if (!b || b.length < 12) return false
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return dv.getUint32(0, true) === 0x46546c67 && dv.getUint32(4, true) === 2
}
const isWebp = (b) => !!b && b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
  b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50

// 三角形数（按节点实例计：同一 mesh 被两个节点引用算两份，与画面上看到的一致）
function countTris(json) {
  const acc = arr(json && json.accessors)
  const meshes = arr(json && json.meshes)
  const perMesh = meshes.map((m) => {
    let t = 0
    for (const p of arr(m && m.primitives)) {
      const mode = p && p.mode == null ? 4 : p && p.mode
      const ia = p && Number.isInteger(p.indices) ? acc[p.indices] : null
      const pa = p && p.attributes && Number.isInteger(p.attributes.POSITION) ? acc[p.attributes.POSITION] : null
      const n = num(ia && ia.count) != null ? ia.count : num(pa && pa.count)
      if (n == null) continue
      if (mode === 4) t += Math.floor(n / 3)
      else if (mode === 5 || mode === 6) t += Math.max(0, n - 2)
    }
    return t
  })
  let tris = 0
  let referenced = false
  for (const nd of arr(json && json.nodes)) {
    if (nd && Number.isInteger(nd.mesh) && perMesh[nd.mesh] != null) { tris += perMesh[nd.mesh]; referenced = true }
  }
  if (!referenced) for (const t of perMesh) tris += t   // 没有节点引用（非法但见过）：按网格本身算
  return tris
}

/* ============================ AGI 扩展原样搬运 ============================ */
// gltf-transform 读写会丢掉它不认识的扩展（AGI_* 全在其列）。.gltf → glb 打包前按「节点名」把
// AGI 块原样摘下来，写完再按节点名贴回去 —— 原样搬（不经语义层），stage 里将来新加的字段也不丢。
const AGI_EXT = ['AGI_articulations', 'AGI_stk_metadata']
const clone = (v) => JSON.parse(JSON.stringify(v))

function extractAgiRaw(json) {
  const root = {}
  const ext = json && json.extensions
  for (const k of AGI_EXT) if (ext && ext[k] && typeof ext[k] === 'object') root[k] = clone(ext[k])
  const nodes = {}
  arr(json && json.nodes).forEach((n) => {
    if (!n || !n.extensions || typeof n.name !== 'string' || !n.name) return
    const e = {}
    for (const k of AGI_EXT) if (n.extensions[k] && typeof n.extensions[k] === 'object') e[k] = clone(n.extensions[k])
    if (Object.keys(e).length) {
      // 同名节点（本不该有，gmdf 规范要求唯一）：后到的并进先到的，不丢
      nodes[n.name] = nodes[n.name] ? { ...nodes[n.name], ...e } : e
    }
  })
  const empty = !Object.keys(root).length && !Object.keys(nodes).length
  return empty ? null : { root, nodes }
}
// 贴回：返回新 JSON 与没对上的节点名（写日志用）
function applyAgiRaw(json, raw) {
  if (!raw) return { json, missing: [] }
  const out = clone(json)
  const used = new Set(arr(out.extensionsUsed))
  if (Object.keys(raw.root || {}).length) {
    out.extensions = { ...(out.extensions || {}) }
    for (const k of Object.keys(raw.root)) { out.extensions[k] = clone(raw.root[k]); used.add(k) }
  }
  const byName = new Map()
  arr(out.nodes).forEach((n, i) => { if (n && typeof n.name === 'string' && !byName.has(n.name)) byName.set(n.name, i) })
  const missing = []
  for (const name of Object.keys(raw.nodes || {})) {
    const i = byName.get(name)
    if (i == null) { missing.push(name); continue }
    const n = out.nodes[i]
    n.extensions = { ...(n.extensions || {}) }
    for (const k of Object.keys(raw.nodes[name])) { n.extensions[k] = clone(raw.nodes[name][k]); used.add(k) }
  }
  if (used.size) out.extensionsUsed = [...used]
  return { json: out, missing }
}

// 纯计数（STK 扫描表的兜底口径；有 agi.mjs 时以它为准）：挂点 = 节点级 isAttachPoint；
// 关节 = 根级 articulations 条数；太阳翼组 = 根级 solarPanelGroups 条数
function countAgiRaw(json, gmdf) {
  let attachPoints = 0
  for (const n of arr(json && json.nodes)) {
    const a = n && n.extensions && n.extensions.AGI_articulations
    if (a && a.isAttachPoint === true) attachPoints++
  }
  const rootA = json && json.extensions && json.extensions.AGI_articulations
  const rootS = json && json.extensions && json.extensions.AGI_stk_metadata
  let articulations = arr(rootA && rootA.articulations).length
  let solarPanelGroups = arr(rootS && rootS.solarPanelGroups).length
  // .gmdf 旁车优先（STK 同口径：旁车在就以旁车为准）
  if (gmdf && typeof gmdf === 'object') {
    const ga = gmdf.AGI_articulations, gs = gmdf.AGI_stk_metadata
    if (ga && Array.isArray(ga.attachPoints)) attachPoints = ga.attachPoints.length
    if (ga && Array.isArray(ga.articulations)) articulations = ga.articulations.length
    if (gs && Array.isArray(gs.solarPanelGroups)) solarPanelGroups = gs.solarPanelGroups.length
  }
  return { nodes: arr(json && json.nodes).length, attachPoints, articulations, solarPanelGroups }
}

// 是不是 AGI/STK 的东西（只看 glb 的 JSON 块）。用途是授权闸 —— 用户若绕开「从 STK 导入」、
// 直接拿「导入文件」选 STK 目录里的 glb（或拖进来、或经渲染端转一手再 saveImported），也得落成
// stk-local / redistributable=false，否则「不可导出、不可上云」四道闸就被一个普通导入按钮绕过去了。
// 返回命中的判据名（写日志用）或 null：
//   'copyright'        asset.copyright 署名 AGI / Analytical Graphics / Ansys；
//   'satsim-declared'  带 extras.satsim 且自己声明不可再分发（stk-local / redistributable:false / stk: id）；
//   'agi-ext'          用了 AGI_* 扩展、又没有 extras.satsim。
// ★ 只看署名不够：本机 STK 12 的 23 个 glb 里有 10 个（cubesat_1.5u/2u/3u/3u_four_panel/3u_radial_panel/6u、
//   c-130、f16、lunar_boulder、lunar_module）没有 copyright 字段，但 23 个全都在 extensionsUsed 里登记了
//   AGI_articulations。本工具自己导出的 glb 一律带 extras.satsim（exporter.js 的 afterParse），所以
//   「有 AGI 扩展、没有 extras.satsim」= 出自 STK 或 AGI 的工具链。代价：别人用 AGI 的 Blender 插件自制、
//   带 AGI 扩展的 glb 也会被当成 STK 件（能用、不能导出）—— 授权口径宁可错拦、不可错放。
const AGI_EXT_RE = /^AGI_/
function usesAgiExtensions(json) {
  if (!json || typeof json !== 'object') return false
  for (const k of arr(json.extensionsUsed)) if (typeof k === 'string' && AGI_EXT_RE.test(k)) return true
  if (json.extensions && typeof json.extensions === 'object' && Object.keys(json.extensions).some((k) => AGI_EXT_RE.test(k))) return true
  // extensionsUsed 漏登记、只在节点上挂了扩展的（手搓 / 第三方改过的文件）也算
  for (const n of arr(json.nodes)) {
    if (n && n.extensions && typeof n.extensions === 'object' && Object.keys(n.extensions).some((k) => AGI_EXT_RE.test(k))) return true
  }
  return false
}
function stkReason(json) {
  if (!json || typeof json !== 'object') return null
  const c = json.asset && typeof json.asset.copyright === 'string' ? json.asset.copyright : ''
  if (/analytical\s+graphics|\bAGI\b|ansys/i.test(c)) return 'copyright'
  const ex = json.extras && json.extras.satsim
  if (ex && typeof ex === 'object' && !Array.isArray(ex)) {
    const s = ex.source
    if (s && typeof s === 'object' && (s.redistributable === false || s.kind === 'stk-local')) return 'satsim-declared'
    if (typeof ex.id === 'string' && /^stk:/.test(ex.id)) return 'satsim-declared'
    return null   // 本工具导出过的件：AGI 扩展是我们自己的 exporter 按用户标定写进去的
  }
  return usesAgiExtensions(json) ? 'agi-ext' : null
}
const looksLikeStk = (json) => stkReason(json) !== null

// 路径判据：落在 STK 安装树里的文件一律算 STK 的（与字节无关）。
//   · 路径段里有 \STKData\ 或 \AGI\STK…\（默认装在 C:\Program Files\AGI\STK 12\STKData\VO\Models）；
//   · 或位于 dirs（默认目录 + 用户扫描 / 导入过的 STK 目录）之下。
// Windows 口径：不分大小写、正反斜杠同义；前缀比较补分隔符，免得「STK 12」吃掉「STK 12x」。
function normWinPath(p) {
  return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}
function isStkPath(p, dirs = []) {
  const s = normWinPath(p)
  if (!s) return false
  if (/\\stkdata\\/.test(s + '\\') || /\\agi\\stk[^\\]*\\/.test(s + '\\')) return true
  for (const d of dirs || []) {
    const b = normWinPath(d)
    if (b && s.startsWith(b + '\\')) return true
  }
  return false
}
// abs 是否在 base 之下（严格在内，不含 base 本身）。p 传 path 模块（单测用 path.win32 / path.posix）。
// 用 relative 判而不是 startsWith(base + sep)：base 是盘符根（C:\）时自带结尾分隔符，拼出来是 C:\\，
// 所有文件都会被判成「在外面」。
function isInside(base, abs, p) {
  const rel = p.relative(p.resolve(base), p.resolve(abs))
  return !!rel && rel !== '..' && !rel.startsWith('..' + p.sep) && !p.isAbsolute(rel)
}

/* ============================ 其它小工具 ============================ */

// 覆盖层文件名：模型 id 里有 ':'（Windows 文件名非法）与 '~'，按百分号转义成安全文件名
function idToFileStem(id) {
  return String(id || '').replace(/[^A-Za-z0-9._~-]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
}

// STK 导入的相对路径：必须是 dir 之下的 .glb，不许绝对路径、不许 ..、不许盘符 / UNC
function safeRel(rel) {
  const s = String(rel || '').replace(/\\/g, '/')
  if (!s || s.length > 1024) return null
  if (/^[a-zA-Z]:/.test(s) || s.startsWith('/')) return null
  const parts = s.split('/')
  if (parts.some((p) => p === '..' || p === '.' || p === '')) return null
  if (!/\.glb$/i.test(s)) return null
  return parts.join('/')
}

function cadKind(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''))
  const e = m ? m[1].toLowerCase() : ''
  if (e === 'step' || e === 'stp') return 'step'
  if (e === 'iges' || e === 'igs') return 'iges'
  if (e === 'brep' || e === 'brp') return 'brep'
  return null
}

// STK 目录类别 → ModelMeta.kind（STK 的 Models 下按载具分目录：Space / Air / Land / Missiles / Sea）。
// 本机 STK 12 实测：Air/{aircraft, c-130_hercules, fighter_f16}、Land/{facility, groundvehicle, lunar_boulder, lunar_module}、
// Missiles/missile、Sea/ship、Space/*。Land 目录里地面站（facility）与车辆混放，按类别目录之后的路径（子目录 / 文件名，小写）
// 含 facility 判地球站 'ground'，其余按车辆 'vehicle'（DESIGN3 E5/E6：这四类导入缺省 +Y 天顶，见 bodyFrame.ENTITY_KINDS）。
// rel 缺省时 Land 一律按车辆。
function stkKind(category, rel) {
  const c = String(category || '').toLowerCase()
  if (c === 'space') return 'spacecraft'
  if (c === 'air') return 'aircraft'
  if (c === 'sea') return 'ship'
  if (c === 'missiles') return 'launcher'
  if (c === 'facility' || c === 'facilities') return 'ground'
  if (c === 'land') {
    const segs = String(rel || '').toLowerCase().split(/[\\/]+/).filter(Boolean)
    // rel 以类别目录开头（importStk 传的是相对 Models 的路径）：只看它之后的段，免得类别名本身参与判断
    const tail = segs.length > 1 && segs[0] === c ? segs.slice(1) : segs
    return tail.some((s) => s.includes('facility')) ? 'ground' : 'vehicle'
  }
  return 'other'
}

// modelwb:open 的目标：只收三个短字符串字段，出 IPC 前现造纯数据
function sanitizeTarget(o) {
  if (!o || typeof o !== 'object') return null
  const s = (v, n) => (typeof v === 'string' && v.length <= n ? v : undefined)
  const t = { tab: s(o.tab, 32), modelId: s(o.modelId, 200), satKey: s(o.satKey, 200) }
  for (const k of Object.keys(t)) if (t[k] === undefined) delete t[k]
  return Object.keys(t).length ? t : null
}

// 响应头取值：Electron net 的头是数组，Node https 是字符串（同 ommCloud.hdr）
const hdr = (h, name) => { const v = h ? h[name] : undefined; return Array.isArray(v) ? v[0] : v }
// Content-Range: bytes 100-199/1000 → { start, end, total }
function parseContentRange(v) {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(v || '').trim())
  if (!m) return null
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? null : Number(m[3]) }
}

// 进度广播节流：同一任务两次广播至少隔 minMs；终态（force）不节流
function makeThrottle(minMs) {
  let last = -Infinity
  return (now, force) => {
    if (force || now - last >= minMs) { last = now; return true }
    return false
  }
}

// 覆盖层差量比较：两份 JSON 数据是否相同（键序无关；只用于纯数据）
function sameJson(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b)
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => sameJson(v, b[i]))
  const ka = Object.keys(a).filter((k) => a[k] !== undefined), kb = Object.keys(b).filter((k) => b[k] !== undefined)
  if (ka.length !== kb.length) return false
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameJson(a[k], b[k]))
}

module.exports = {
  LODS, SHA_RE, PROTOCOL_PATH_RE, PROTOCOL_HOSTS, CONTENT_TYPES, GiB, MiB,
  DEFAULT_CACHE_CAP, CAP_MIN, CAP_MAX, PROTECT_MS, MAX_RETRIES, MAX_STK_DIRS,
  resolveProtocolUrl, modelsUrl,
  pickEvictions, clampCap, normalizeState, touchState, dropState, rememberStkDir,
  dlInitial, dlReduce, retryDelay,
  DL_PRIORITY, SMALL_PRIORITY_MAX, dlPriority, pickNextJob, pickPreempt,
  lodOrder, planEnsure,
  isGlb, isWebp, countTris,
  extractAgiRaw, applyAgiRaw, countAgiRaw, usesAgiExtensions, stkReason, looksLikeStk, isStkPath, normWinPath, isInside,
  idToFileStem, safeRel, cadKind, stkKind, sanitizeTarget, sameJson,
  hdr, parseContentRange, makeThrottle
}
