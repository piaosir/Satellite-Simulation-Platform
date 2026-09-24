// 模型库 manifest v2：校验、三层合并、URL 规则（任务书 §5.8；设计契约 §3.3、§4.1）。
//
// 为什么 URL 规则也放这里：主进程的 models:// 协议、下载器、离线发布脚本、渲染端缩略图都要拼同一套地址；
// 路径白名单正则只能有一条（PROTOCOL_PATH_RE），协议处理器和拼地址的人各写一份，迟早出现「拼得出、放不行」。
//
// 安全口径（DESIGN §9-6）：
//   · CDN_BASE 钉死为本桶域名，远端 manifest 里就算带 cdnBase 字段也不读；
//   · 远端条目逐条过 validateMeta，另拒 redistributable=false、拒 stk-local / user 来源、拒非 http(s) 的 source.url
//     （防 javascript: 之类进界面的链接）；非 http(s) 的 units.sizeSource 清掉并把 sizeVerified 置 false（条目留下）；
//     坏条目丢弃并记错，整份只在 schema 不对时拒绝——一条坏数据不该让整个云端库失效；
//   · 界面渲染出处链接前一律再过 isHttpUrl（本机层没经过远端闸）；
//   · 输出一律经 slimMeta 重建（白名单字段），远端多塞的键进不来。
//
// 导出：
//   CDN_BASE, MANIFEST_URL, PROTOCOL_SCHEME, PROTOCOL_HOSTS, PROTOCOL_PATH_RE, MAX_MANIFEST_MODELS
//   blobUrl(sha, ext), nasaSrcUrl(slug, file), manifestVersionUrl(buildId)
//   localUrl(host, sha, ext), parseLocalUrl(url), isAllowedProtocolPath(host, seg), isHttpUrl(u)
//   validateManifest(m, {remote, builtin}) → {ok, errors, warnings, models, buildId, generatedAt}
//   mergeManifests({builtin, remote, user}) → models[]（每条带 origin；覆盖了内置条目的还带 builtin / builtinFiles）

import { validateMeta, slimMeta, parseModelId, isRedistributable, SCHEMA_VERSION, SHA256_RE, LOD_KEYS } from './schema.mjs'

export const CDN_BASE = 'https://update-1385987144.cos.ap-beijing.myqcloud.com/updates/models/'
export const MANIFEST_URL = CDN_BASE + 'manifest.json'
export const PROTOCOL_SCHEME = 'models'
export const PROTOCOL_HOSTS = Object.freeze(['blobs', 'user', 'builtin', 'thumbs'])
/** models:// 协议的路径段白名单（只一段，不含前导 /）。主进程协议处理器必须用这一条。 */
export const PROTOCOL_PATH_RE = /^[0-9a-f]{64}\.(glb|webp|png)$/
// manifest 条目上限：NASA 全库 ~250 条，留到 5000 足够三期社区库；超过视为异常整份拒绝
export const MAX_MANIFEST_MODELS = 5000

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isStr = (v) => typeof v === 'string'
const EXTS = ['glb', 'webp', 'png']
const BUILD_ID_RE = /^[A-Za-z0-9._-]{1,64}$/

/** 云端 blob 地址：<CDN_BASE>blobs/<sha256>.<ext>。sha / ext 不合法返回 null（不拼出可疑地址）。 */
export function blobUrl(sha, ext) {
  if (!isStr(sha) || !SHA256_RE.test(sha) || !EXTS.includes(ext)) return null
  return `${CDN_BASE}blobs/${sha}.${ext}`
}

/** NASA 原件镜像：<CDN_BASE>src/nasa/<slug>/<原文件名>（文件名按 URI 组件编码，NASA 文件名常带空格）。 */
export function nasaSrcUrl(slug, fileName) {
  if (!isStr(slug) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || !isStr(fileName) || !fileName || /[\\/]/.test(fileName) || fileName === '.' || fileName === '..') return null
  return `${CDN_BASE}src/nasa/${slug}/${encodeURIComponent(fileName)}`
}

/** 每次构建的不可变快照：<CDN_BASE>manifest.<buildId>.json。 */
export function manifestVersionUrl(buildId) {
  return isStr(buildId) && BUILD_ID_RE.test(buildId) ? `${CDN_BASE}manifest.${buildId}.json` : null
}

/** 本机地址 models://<host>/<sha>.<ext>；host 不在白名单或文件名不合规返回 null。 */
export function localUrl(host, sha, ext) {
  const seg = `${sha}.${ext}`
  return isAllowedProtocolPath(host, seg) ? `${PROTOCOL_SCHEME}://${host}/${seg}` : null
}

/** host + 路径段是否放行（协议处理器用）。 */
export function isAllowedProtocolPath(host, seg) {
  return PROTOCOL_HOSTS.includes(host) && isStr(seg) && PROTOCOL_PATH_RE.test(seg)
}

/**
 * 解析 models:// 地址 → {host, file, sha, ext}；不合规返回 null。
 * 只认「一个 host + 一段路径」，查询串 / 片段忽略；host 按 Chromium 标准 scheme 的行为转小写，路径大小写敏感
 * （sha 必须小写，大写直接拒——文件落盘就是小写，放大写进来只会 404 或绕过缓存键）。
 */
export function parseLocalUrl(url) {
  if (!isStr(url)) return null
  const m = /^models:\/\/([A-Za-z]+)\/([^/?#]+)(?:[?#].*)?$/.exec(url)
  if (!m) return null
  const host = m[1].toLowerCase()
  const file = m[2]
  if (!isAllowedProtocolPath(host, file)) return null
  const dot = file.indexOf('.')
  return { host, file, sha: file.slice(0, dot), ext: file.slice(dot + 1) }
}

/**
 * 是否 http(s) 绝对地址（无空白）。界面上凡是把 source.url / units.sizeSource 渲染成链接的地方都要先过它：
 * 本机条目（用户自己的 .satsim.json）没经过远端闸，sizeSource 也允许是纯文字出处（书名、页码），不一定是地址。
 */
export function isHttpUrl(u) {
  return isStr(u) && u.length <= 2048 && /^https?:\/\/[^\s]+$/i.test(u)
}
const httpOk = (u) => u === '' || isHttpUrl(u)

/**
 * 校验 manifest。
 * @param {object} m
 * @param {{remote?:boolean, builtin?:boolean}} [opts]
 *   remote：云端来的——拒不可分发 / STK / 本机导入条目、拒非 http(s) 链接；
 *   builtin：随包内置——条目的 builtin 档位表必须指向 files 里有的档。
 * @returns {{ok:boolean, errors:string[], warnings:string[], models:object[], buildId:string|null, generatedAt:string|null}}
 *   ok=false 只在整份结构不对（非对象 / schema≠2 / models 非数组 / 条目数超上限）；此时 models 为空。
 */
export function validateManifest(m, opts = {}) {
  const o = isObj(opts) ? opts : {}
  const fail = (msg) => ({ ok: false, errors: [msg], warnings: [], models: [], buildId: null, generatedAt: null })
  if (!isObj(m)) return fail('manifest 不是对象')
  if (m.schema !== SCHEMA_VERSION) return fail(`manifest schema 须为 ${SCHEMA_VERSION}（得到 ${JSON.stringify(m.schema)}）`)
  if (!Array.isArray(m.models)) return fail('manifest.models 不是数组')
  if (m.models.length > MAX_MANIFEST_MODELS) return fail(`manifest 条目 ${m.models.length} 超过上限 ${MAX_MANIFEST_MODELS}`)
  const errors = [], warnings = []
  const buildId = isStr(m.buildId) && BUILD_ID_RE.test(m.buildId) ? m.buildId : null
  if (!buildId) warnings.push('manifest.buildId 缺失或不合规')
  const generatedAt = isStr(m.generatedAt) && Number.isFinite(Date.parse(m.generatedAt)) ? m.generatedAt : null
  if (m.generatedAt !== undefined && !generatedAt) warnings.push('manifest.generatedAt 不是合法时间')
  if (m.cdnBase !== undefined) warnings.push('manifest.cdnBase 已忽略（客户端地址钉死）')
  // 顶层 builtin：内置 manifest 可以统一声明「每条都带了哪些档」，条目自己的 builtin 优先
  const topBuiltin = Array.isArray(m.builtin) ? m.builtin : null

  const seen = new Set()
  const models = []
  m.models.forEach((e, i) => {
    const tag = `models[${i}]${isObj(e) && isStr(e.id) ? `（${e.id}）` : ''}`
    const v = validateMeta(e, { slim: true })
    if (!v.ok) { errors.push(`${tag}：${v.errors.join('；')}，已丢弃`); return }
    if (seen.has(e.id)) { errors.push(`${tag}：id 重复，已丢弃`); return }
    if (o.remote) {
      const pid = parseModelId(e.id)
      if (!isRedistributable(e)) { errors.push(`${tag}：不可分发的条目不许出现在云端，已丢弃`); return }
      if (['stk-local', 'user'].includes(e.source.kind) || (pid && ['stk', 'user'].includes(pid.prefix))) { errors.push(`${tag}：本机来源不许出现在云端，已丢弃`); return }
      if (!httpOk(e.source.url || '')) { errors.push(`${tag}：source.url 须为 http(s) 地址，已丢弃`); return }
    }
    seen.add(e.id)
    let src = e
    // 远端条目的尺寸出处也是界面上可能渲染成链接的字段（契约 §7 的署名 / 出处显示），与 source.url 同一道闸。
    // 不整条丢：出处坏了模型照样能用，只是尺寸不再算「已核定」——清掉出处、sizeVerified 置 false（validateMeta 要求核定必带出处）
    if (o.remote && isObj(e.units) && e.units.sizeSource !== undefined && e.units.sizeSource !== null && !isHttpUrl(e.units.sizeSource)) {
      errors.push(`${tag}：units.sizeSource 须为 http(s) 地址，已清除并按未核定尺寸收录`)
      const units = { ...e.units, sizeVerified: false }
      delete units.sizeSource
      src = { ...e, units }
    }
    const slim = slimMeta(o.builtin && !Array.isArray(src.builtin) && topBuiltin ? { ...src, builtin: topBuiltin } : src)
    if (o.builtin) {
      const tiers = Array.isArray(slim.builtin) ? slim.builtin : []
      const ok = tiers.filter((k) => (k === 'thumb' ? slim.files.thumb : slim.files[k]))
      if (ok.length !== tiers.length) warnings.push(`${tag}：builtin 档位 ${tiers.filter((k) => !ok.includes(k)).join('、')} 在 files 里没有，已忽略`)
      if (ok.length) slim.builtin = ok
      else delete slim.builtin
    } else delete slim.builtin
    if (v.warnings.length) warnings.push(...v.warnings.map((w) => `${tag}：${w}`))
    models.push(slim)
  })
  return { ok: true, errors, warnings, models, buildId, generatedAt }
}

const listOf = (x) => (Array.isArray(x) ? x : (isObj(x) && Array.isArray(x.models) ? x.models : []))
const clone = (v) => JSON.parse(JSON.stringify(v))

/**
 * 三层合并：同 id 本机 > 远端 > 内置。输入可以是 manifest 对象或条目数组（应已各自过 validateManifest / validateMeta）。
 * 输出每条 = 深拷贝 + 以下附加字段：
 *   origin        'builtin' | 'remote' | 'user'：生效的是哪一层
 *   builtin       随包带了哪些档（来自内置层；上层覆盖后仍保留——契约：内置文件仍可作为 lod2 来源）
 *   builtinFiles  { [档]: {sha256, bytes, tris?} }：随包文件本身的 sha（远端更新后可能与 files 里的不同，老版本也能先顶上）
 *   overridesId   本机层覆盖云端 / 内置条目时为 true（「本机覆盖层」：改的是标定 / 挂点等元数据）
 * 本机覆盖云端条目时，id / source / files / schema 取下层——本机改写只能动元数据，改不了文件与授权
 * （否则一份本机 JSON 就能把 redistributable 翻成 true 或把 files 指到别的 blob）。
 * 顺序：按首次出现的位置（内置 → 远端新增 → 本机新增），同 id 覆盖不改位置。
 */
export function mergeManifests({ builtin = null, remote = null, user = null } = {}) {
  const map = new Map()
  const valid = (e) => isObj(e) && parseModelId(e.id)
  for (const e of listOf(builtin)) {
    if (!valid(e) || map.has(e.id)) continue
    const out = clone(e)
    out.origin = 'builtin'
    const tiers = Array.isArray(e.builtin) ? e.builtin.filter((k) => LOD_KEYS.includes(k) || k === 'thumb') : []
    if (tiers.length && isObj(e.files)) {
      out.builtin = tiers
      out.builtinFiles = {}
      for (const k of tiers) if (isObj(e.files[k])) out.builtinFiles[k] = clone(e.files[k])
    }
    map.set(e.id, out)
  }
  const carryBuiltin = (dst, lower) => {
    if (lower && lower.builtin) { dst.builtin = lower.builtin.slice(); dst.builtinFiles = clone(lower.builtinFiles || {}) } else { delete dst.builtin; delete dst.builtinFiles }
  }
  for (const e of listOf(remote)) {
    if (!valid(e)) continue
    const lower = map.get(e.id)
    if (lower && lower.origin !== 'builtin') continue // 远端自身重复 id：先到先得
    const out = clone(e)
    out.origin = 'remote'
    carryBuiltin(out, lower)
    map.set(e.id, out)
  }
  for (const e of listOf(user)) {
    if (!valid(e)) continue
    const lower = map.get(e.id)
    if (lower && lower.origin === 'user') continue
    const out = clone(e)
    out.origin = 'user'
    if (lower) {
      out.schema = lower.schema
      out.source = clone(lower.source)
      out.files = clone(lower.files || {})
      out.overridesId = true
      carryBuiltin(out, lower)
    } else { delete out.builtin; delete out.builtinFiles }
    map.set(e.id, out)
  }
  return [...map.values()]
}
