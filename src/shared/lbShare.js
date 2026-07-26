// 链路预算「分享包」v3：编解码 + 依赖闭包 + 并库计划。GEO / NGSO / 再生式三窗共用。
//
// 包格式（分享码 = SHARE_PREFIX + URL-safe base64(JSON)；base64 走 TextEncoder 字节，中文安全）：
//   { app:'satlink', kind:'lbcfg', v:3, mod, from, ts,
//     configs:[{ name, path:[文件夹名…], state }],          // 可为空数组 = 只分享资源库
//     lib:{ es:[条目], carrier:[条目], sat:[条目] } }        // 显式勾选 ∪ 被勾选配置引用的闭包
//
// 与 v2 的三处结构性差异，都是为了修 v2 的实际缺陷：
//   ① lib 提到包级 —— v2 的 lib 挂在 items[] 里，却被 normItems 无声抹掉（只留 {name,state}），
//      于是线下分享码/文件从来没带过库条目：v1.4.2 之后场景只存引用，对端拿到的 stationId/
//      basebandId/satId 是发送方机器的 id，解析不到就静默回退到他自己库里的第一份配置——
//      而 id 是 es1/bb1/sat1 这种顺序号，两台机器又都从同一套默认库起步，经常「碰巧命中」，
//      于是不报任何错、算出一组看着合理其实是别人参数的数。
//   ② mod（体制标记）—— v2 无此字段，NGSO 的包粘进 GEO 窗口会被存进 configs.json 再被体制过滤
//      挡掉，用户看到「导入成功」但列表里什么都没多。
//   ③ configs 可为空 —— 允许「只分享资源库」。
// 读侧兼容 v2（items[]，含 items[].lib）与 v1（裸 {name,state}），老码永远导得进来。
//
// 「本机资源指针」的处理（sanitize）：卫星条目里的方向图匹配（GEO/NGSO 的 grd.satFolder）与
// 轨道取星来源（再生式的 ngsoSat.folder）指向的是【发送方机器上】的 GRD 天线树节点，原样带过去
// 只会挂到对端另一颗星上。故打包时一律剥掉，并把 ngsoSat.mode 从 'tree' 降为 'manual'
// （orbit/name/noradId 是自包含数据，照带不误）——对端拿到的是「有轨道、无方向图」这个自洽状态。
// 各体制剥哪些字段由调用方的 spec.sanitize 声明，见下方 fingerprint 一节。
import { stableStringify } from './configDirty.js'

export const SHARE_PREFIX = 'LBCFG1.'
export const LIB_KINDS = ['es', 'carrier', 'sat']
export const KIND_LABEL = { es: '地球站', carrier: '载波', sat: '卫星' }
export const MOD_LABEL = { GEO: 'GEO 静止轨道', NGSO: 'NGSO 非静止轨道', REGEN: '再生式（星上处理）' }

// —— base64（浏览器 btoa/atob；Node 下跑测试时退到 Buffer）——
const _btoa = (s) => (typeof btoa === 'function' ? btoa(s) : globalThis.Buffer.from(s, 'binary').toString('base64'))
const _atob = (s) => (typeof atob === 'function' ? atob(s) : globalThis.Buffer.from(s, 'base64').toString('binary'))
function bytesToB64(str) {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return _btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function b64ToStr(b64) {
  let s = b64.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  const bin = _atob(s)
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const asArr = (x) => (Array.isArray(x) ? x : [])
export function emptyLib() { return { es: [], carrier: [], sat: [] } }

// —— 条目规整 ——
// 除 id/name/nameAuto/form 外的顶层键（grd / ngsoSat 等「随条目走的扩展属性」）一律原样带上：
// 各体制往条目上挂什么由它自己决定，本模块不枚举。深拷贝顺带把 Vue 响应式 Proxy 摘掉
//（否则经 IPC 结构化克隆会报 An object could not be cloned）。
const BASE_KEYS = new Set(['id', 'name', 'nameAuto', 'form'])
function normEntry(e) {
  if (!e || typeof e !== 'object' || !e.form) return null
  const o = { id: String(e.id == null ? '' : e.id), name: String(e.name == null ? '' : e.name), nameAuto: e.nameAuto === true, form: clone(e.form) }
  for (const k of Object.keys(e)) if (!BASE_KEYS.has(k) && e[k] !== undefined) o[k] = clone(e[k])
  return o
}
function normLib(lib) {
  const out = emptyLib()
  if (!lib || typeof lib !== 'object') return out
  for (const k of LIB_KINDS) out[k] = asArr(lib[k]).map(normEntry).filter(Boolean)
  return out
}
function normConfig(c) {
  if (!c || typeof c !== 'object' || !c.state || typeof c.state !== 'object') return null
  return {
    name: String(c.name || '配置'),
    path: asArr(c.path).map((s) => String(s == null ? '' : s).trim()).filter(Boolean),
    state: clone(c.state)
  }
}
const libCount = (lib) => LIB_KINDS.reduce((n, k) => n + lib[k].length, 0)

// —— 规范化为 v3（v2 items[] / v1 裸 state 一并升级）。非法内容抛错。——
export function normalizeBundle(o) {
  if (!o || typeof o !== 'object') throw new Error('无效的分享内容')
  let configs = null
  let lib = emptyLib()
  if (Array.isArray(o.configs)) {                       // v3
    configs = o.configs.map(normConfig).filter(Boolean)
    lib = normLib(o.lib)
  } else if (Array.isArray(o.items)) {                  // v2：lib 挂在每个 item 上，按 id 首见为准并成一份
    configs = o.items.map((it) => normConfig({ name: it && it.name, path: it && it.path, state: it && it.state })).filter(Boolean)
    for (const it of o.items) {
      const l = normLib(it && it.lib)
      for (const k of LIB_KINDS) for (const e of l[k]) if (!lib[k].some((x) => x.id === e.id)) lib[k].push(e)
    }
  } else if (o.state && typeof o.state === 'object') {  // v1：单条裸配置
    configs = [normConfig({ name: o.name || '导入配置', state: o.state })].filter(Boolean)
  }
  if (!configs) throw new Error('无效的分享内容')
  if (!configs.length && !libCount(lib)) throw new Error('分享内容为空（既没有配置，也没有资源库条目）')
  return {
    app: 'satlink', kind: 'lbcfg', v: 3,
    mod: String(o.mod || ''), from: String(o.from || ''), ts: Number(o.ts) || 0,
    configs, lib
  }
}

export function makeBundle({ mod, from, configs, lib } = {}) {
  return normalizeBundle({ mod, from, ts: Date.now(), configs: asArr(configs), lib: lib || emptyLib() })
}

export function encodeShare(bundle) { return SHARE_PREFIX + bytesToB64(JSON.stringify(normalizeBundle(bundle))) }
export function bundleFileText(bundle) { return JSON.stringify(normalizeBundle(bundle), null, 2) }

// 从 base64url 正文起点截出连续的一段码：中间的空白（邮件/聊天窗口的自动折行）跳过不计，
// 遇到第一个非 base64url 的可见字符即止——分享码常常是夹在一句话中间发过来的（「看下这个：LBCFG1.xxx 谢了」），
// 把后面那句话也喂进 atob 只会报「格式不对」。
function takeB64Run(s) {
  let out = ''
  for (const ch of s) {
    if (/\s/.test(ch)) continue
    if (/[A-Za-z0-9\-_=]/.test(ch)) out += ch
    else break
  }
  return out
}
// 分享码 / 纯 JSON 文本 → v3 包。非法抛错。
export function decodeShare(input) {
  const raw = String(input == null ? '' : input).trim()
  if (!raw) throw new Error('内容为空')
  let o
  if (raw[0] === '{') {
    o = JSON.parse(raw)
  } else {
    const at = raw.indexOf(SHARE_PREFIX)
    const body = takeB64Run(at >= 0 ? raw.slice(at + SHARE_PREFIX.length) : raw)
    try { o = JSON.parse(b64ToStr(body)) }
    catch (e) { throw new Error('分享码格式不对（应是一整段以 ' + SHARE_PREFIX + ' 开头的文本）') }
  }
  return normalizeBundle(o)
}

// 一句话摘要（收件箱行 / 导入预览抬头共用）
export function describeBundle(bundle) {
  const b = normalizeBundle(bundle)
  const n = b.configs.length, m = libCount(b.lib)
  const parts = []
  if (n) parts.push(`${n} 个配置`)
  if (m) parts.push(`${m} 条库条目`)
  return { nConfig: n, nLib: m, mod: b.mod, from: b.from, ts: b.ts, text: parts.join(' · ') || '空包' }
}

// —— 兼容旧版客户端的在线信箱 payload（v2 items[]，lib 挂每条上）——
// 只在包内有配置时给；老版本的 importConfigs 读 it.lib，因此这份 items 对它是完整可用的。
export function legacyItemsOf(bundle) {
  const b = normalizeBundle(bundle)
  if (!b.configs.length) return null
  return b.configs.map((c) => ({ name: c.name, state: c.state, lib: b.lib }))
}

// ============================ 依赖闭包 ============================
// refs 里的空串 = 「用库里第一份」（链路表未选时的存值）；未知 id 先按名字兜底再落第一份——
// 与引擎侧 resolveEs / resolveBaseband / resolveSat 的解析顺序完全一致，保证「打包进去的那一条，
// 正是对端会算的那一条」。libs[kind] 传本机的库数组。
export function resolveRefId(arr, id) {
  const list = asArr(arr)
  if (!list.length) return ''
  const key = id == null ? '' : String(id)
  let hit = key ? list.find((c) => c.id === key) : null
  if (!hit && key) hit = list.find((c) => c.name === key)
  return (hit || list[0]).id
}
export function resolveRefs(refs, libs) {
  const out = { es: new Set(), carrier: new Set(), sat: new Set() }
  for (const k of LIB_KINDS) {
    const arr = (libs && libs[k]) || []
    if (!arr.length) continue
    for (const raw of asArr(refs && refs[k])) out[k].add(resolveRefId(arr, raw))
  }
  return out
}

// 若干场景 state 的引用并集（refsOf 由各体制提供：GEO/NGSO 读 rows[]，再生式读 tx/rx/isl/laser）
export function lockedRefsOf(states, refsOf, libs) {
  const merged = { es: [], carrier: [], sat: [] }
  for (const st of asArr(states)) {
    if (!st) continue
    const r = refsOf(st) || {}
    for (const k of LIB_KINDS) for (const v of asArr(r[k])) merged[k].push(v)
  }
  return resolveRefs(merged, libs)
}

// ============================ 指纹 ============================
// spec = { arr, label, keys, pack, sanitize, makeNew }
//   keys     参与内容指纹的扩展键（GEO 卫星 ['grd']、NGSO ['ngsoSat','grd']、再生式 ['ngsoSat']）
//   pack     本机条目 → 可序列化条目（各体制的 serializeLibrary 同款口径）
//   sanitize 剥掉「本机资源指针」（见文件头）。声明了它 ⇒ 并库时启用宽松匹配。
const packOf = (spec, c) => (spec && spec.pack ? spec.pack(c) : c)
function fpKeys(spec, e) {
  const o = { form: (e && e.form) || null }
  for (const k of (spec && spec.keys) || []) o[k] = (e && e[k] !== undefined) ? e[k] : null
  return o
}
export function strictFp(spec, c) { return stableStringify(fpKeys(spec, packOf(spec, c))) }
// 宽松指纹 = 「把本机资源指针也剥掉之后」的严格指纹。
// 之所以需要它：打包时卫星的方向图匹配被清空，而对端本机同一颗星往往【已经】配好了方向图，
// 严格比对会判成两颗星、凭空多出一条「中星6D 2」。用 strictFp(sanitize(本机条目)) 去比，
// 允许差异恰好只有「被我们主动剥掉的那几项」，不多不少——同参数同轨道即认定同一颗星。
export function looseFp(spec, c) {
  const e = packOf(spec, c)
  return stableStringify(fpKeys(spec, spec && spec.sanitize ? spec.sanitize(e) : e))
}
// 打包用：本机条目 → 净化过的可序列化条目
export function packEntry(spec, c) {
  const e = normEntry(packOf(spec, c))
  if (!e) return null
  return spec && spec.sanitize ? normEntry(spec.sanitize(e)) : e
}
export function packLib(specs, ids) {
  const out = emptyLib()
  for (const k of LIB_KINDS) {
    const spec = specs && specs[k]
    if (!spec || !spec.arr) continue
    const set = (ids && ids[k]) || new Set()
    out[k] = spec.arr.filter((c) => set.has(c.id)).map((c) => packEntry(spec, c)).filter(Boolean)
  }
  return out
}

// ============================ 导入计划 ============================
function uniqueName(base, taken) {
  const nm = base || '未命名'
  if (!taken.has(nm)) return nm
  let i = 2
  while (taken.has(nm + ' ' + i)) i++
  return nm + ' ' + i
}
const findFolder = (items, parentId, name) =>
  asArr(items).find((it) => it && it.type === 'folder' && (it.parentId || null) === (parentId || null) && it.name === name) || null

/**
 * 导入前的「包内清单」：逐条判定落点（复用 / 新增 / 重名加序号），并算出要新建哪些文件夹。
 * 纯函数，不改动任何东西——预览与实际落盘走同一份计划，所见即所得。
 * @param bundle 任意版本的包
 * @param ctx { mod, lib:{kind:spec}, getConfigs }
 */
export function planImport(bundle, ctx) {
  const b = normalizeBundle(bundle)
  const plan = {
    bundle: b, reject: '', mod: b.mod, from: b.from, ts: b.ts,
    lib: [], configs: [], folders: [],
    counts: { libNew: 0, libReuse: 0, config: b.configs.length, folderNew: 0 }
  }
  // 体制判定：v3 直接读 mod；v1/v2 老包无此字段，退而从配置的 state.orbitType 认——
  // NGSO/再生式的场景自带 orbitType，GEO 是历史默认体制（无该字段），故 GEO 的老包认不出体制、
  // 一律放行（与 loadConfigs 的白名单口径一致），认得出的老包照样拦。
  const stMod = (b.configs.find((c) => c.state && c.state.orbitType) || { state: {} }).state.orbitType || ''
  plan.mod = b.mod || stMod
  if (plan.mod && ctx.mod && plan.mod !== ctx.mod) {
    plan.reject = `这是「${MOD_LABEL[plan.mod] || plan.mod}」体制的分享包，请在对应的链路预算窗口导入。`
    return plan
  }

  // —— 库条目：内容指纹去重 → 宽松指纹（仅对声明了 sanitize 的库）→ 新增（重名加序号）——
  for (const kind of LIB_KINDS) {
    const spec = ctx.lib && ctx.lib[kind]
    if (!spec || !spec.arr) continue
    const taken = new Set(spec.arr.map((c) => c.name))
    const pending = []          // 本批已计划新增的（同一包里出现两条一样的，也只建一条）
    for (const e of b.lib[kind]) {
      const fp = strictFp(spec, e)
      const exact = spec.arr.find((c) => strictFp(spec, c) === fp)
      const batch = pending.find((p) => p.fp === fp)
      const loose = exact || batch ? null : spec.arr.find((c) => looseFp(spec, c) === fp)
      const row = { kind, kindLabel: spec.label || KIND_LABEL[kind], srcId: e.id, srcName: e.name || '（未命名）', entry: e, fp }
      if (exact) { row.action = 'reuse'; row.targetId = exact.id; row.finalName = exact.name; plan.counts.libReuse++ }
      else if (batch) { row.action = 'reuse'; row.batchFp = fp; row.finalName = batch.finalName; plan.counts.libReuse++ }
      else if (loose) { row.action = 'reuse-loose'; row.targetId = loose.id; row.finalName = loose.name; plan.counts.libReuse++ }
      else {
        row.action = 'new'
        row.finalName = uniqueName(e.name, taken)
        row.renamed = row.finalName !== (e.name || '')
        taken.add(row.finalName)
        pending.push({ fp, finalName: row.finalName })
        plan.counts.libNew++
      }
      plan.lib.push(row)
    }
  }

  // —— 文件夹：按名字逐层 find-or-create（对端的 id 没有意义，只能按名字对齐）——
  const items = (ctx.getConfigs && ctx.getConfigs()) || []
  const folders = new Map()                       // key(路径 join) → { key, parentKey, name, id }
  const keyOf = (path) => path.join('\u0000')
  function ensurePath(path) {
    let parentKey = '', parentId = null, broken = false
    for (let i = 0; i < path.length; i++) {
      const key = keyOf(path.slice(0, i + 1))
      let rec = folders.get(key)
      if (!rec) {
        const hit = broken ? null : findFolder(items, parentId, path[i])
        rec = { key, parentKey, name: path[i], id: hit ? hit.id : null }
        folders.set(key, rec)
        if (!rec.id) plan.counts.folderNew++
      }
      if (!rec.id) broken = true
      parentId = rec.id
      parentKey = key
    }
    return path.length ? keyOf(path) : ''
  }
  // 同一文件夹内的配置重名 → 加序号（本机已有的 + 本批已计划的一并算）
  const namesByFolder = new Map()
  function namesIn(fkey, folderId) {
    if (!namesByFolder.has(fkey)) {
      const s = new Set()
      if (fkey === '' || folderId) for (const it of items) {
        if (!it || it.type === 'folder') continue
        if ((it.parentId || null) === (folderId || null)) s.add(it.name)
      }
      namesByFolder.set(fkey, s)
    }
    return namesByFolder.get(fkey)
  }
  for (const c of b.configs) {
    const fkey = ensurePath(c.path)
    const rec = fkey ? folders.get(fkey) : null
    const taken = namesIn(fkey, rec ? rec.id : null)
    const finalName = uniqueName(c.name, taken)
    taken.add(finalName)
    plan.configs.push({
      srcName: c.name, finalName, renamed: finalName !== c.name,
      path: c.path, pathText: c.path.length ? c.path.join(' / ') : '（根目录）',
      folderKey: fkey, folderNew: !!(rec && !rec.id), config: c
    })
  }
  plan.folders = [...folders.values()]
  return plan
}

/**
 * 按计划把库条目并进本机库（就地 push 进 spec.arr），返回 旧id→本机id 映射。
 * 同 adoptEntries 的口径：并进来的名字一律钉成自定义（除非对方明确标了「自动」）——不替别人的库改名。
 */
export function adoptLib(plan, ctx) {
  const idMap = { es: {}, carrier: {}, sat: {} }
  const byFp = { es: {}, carrier: {}, sat: {} }
  for (const row of plan.lib) {
    const spec = ctx.lib && ctx.lib[row.kind]
    if (!spec || !spec.arr) continue
    if (row.action === 'reuse' || row.action === 'reuse-loose') {
      idMap[row.kind][row.srcId] = row.targetId != null ? row.targetId : byFp[row.kind][row.batchFp]
      continue
    }
    const c = spec.makeNew()
    c.name = row.finalName
    c.nameAuto = row.entry.nameAuto === true
    c.form = { ...c.form, ...clone(row.entry.form) }
    for (const k of spec.keys || []) if (row.entry[k] !== undefined) c[k] = clone(row.entry[k])
    spec.arr.push(c)
    idMap[row.kind][row.srcId] = c.id
    byFp[row.kind][row.fp] = c.id
  }
  return idMap
}

// 配置树里某一项的文件夹路径（根 → 叶的名字数组）。打包时用。
export function pathOf(item, items) {
  const byId = new Map(asArr(items).map((it) => [it.id, it]))
  const out = []
  let p = item && item.parentId
  const guard = new Set()
  while (p != null && byId.has(p) && !guard.has(p)) {
    guard.add(p)
    const f = byId.get(p)
    if (f.type !== 'folder') break
    out.unshift(f.name)
    p = f.parentId
  }
  return out
}
