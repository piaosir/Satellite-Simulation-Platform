// NASA 3D 语料离线管线的共用件：scripts/nasa3d/ 下的 catalog / fetch / corpus-report 共用，
// 后续 build / sheets / publish 也从这里取，不各抄一份。
//
//   · 路径常量        仓库根、.models-src/、原件目录、include-list.json、COS 镜像前缀
//   · parseArgs       只认声明过的 --参数，未知参数直接报错（防止 --group 拼错被静默吞掉）
//   · createNet       undici 的 fetch + 代理：--proxy 显式 > 环境变量 HTTPS_PROXY / HTTP_PROXY（NO_PROXY 生效）> 直连；
//                     --no-proxy 强制直连。Node 自带 fetch / https 都不认环境变量里的代理，故引 undici（devDependency）。
//   · withRetry       指数退避（带抖动、认 Retry-After），4xx 永久错误不重试
//   · downloadWithResume  Range 续传（.part + If-Range），按 Content-Length / Content-Range 校验长度，
//                     sha256 旁车先写、再改名落盘、再置只读 —— 任何一步被打断，重跑都能接上
//   · sha256File / 旁车读写
//   · parseGlbHeader  纯函数：GLB 头 + JSON 块（+ BIN 块头），不解网格
//   · summarizeGltf   从 glTF JSON 统计扩展 / 计数 / 三角形 / 包围盒（口径见函数头注释）
//   · 终端表格 / Markdown 表格（中文按两列宽对齐）
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import undici from 'undici'

const { fetch: undiciFetch, Agent, ProxyAgent, EnvHttpProxyAgent } = undici

// ─────────────────────────────── 路径与常量 ───────────────────────────────

export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(HERE, '..', '..')
export const SRC_ROOT = path.join(REPO_ROOT, '.models-src')          // 原件与语料报告（.gitignore）
export const NASA_DIR = path.join(SRC_ROOT, 'nasa')                   // 原件：<slug>/<原文件名>.glb，只读
export const BUILD_ROOT = path.join(REPO_ROOT, 'build', 'models')     // build 阶段输出（.gitignore）
export const INCLUDE_LIST_FILE = path.join(HERE, 'include-list.json')
export const CATALOG_FILE = path.join(SRC_ROOT, 'catalog.json')
export const FAILURES_FILE = path.join(SRC_ROOT, 'fetch-failures.json')

export const USER_AGENT = 'satsim-desktop/1.4 (model corpus)'
export const NASA_API = 'https://science.nasa.gov/wp-json/wp/v2/'
export const NASA_ORG_3D = 6482                                        // science-org：3D Resources
// COS 镜像（云端原件）：updates/models/src/nasa/<slug>/<原文件名>。现有密钥只放行 updates/*，models/* 必 403。
export const COS_NASA_SRC_BASE = 'https://update-1385987144.cos.ap-beijing.myqcloud.com/updates/models/src/nasa/'

export const MiB = 1024 * 1024

// ─────────────────────────────── 参数解析 ───────────────────────────────

/**
 * 解析 --key=value / --key value / --flag。spec: { 名字: 'bool' | 'string' | 'number' | 'int' | 'list' }。
 * 名字按原样（带连字符）声明，结果键转驼峰（--max-mb → maxMb，--no-proxy → noProxy）。
 * 「--no-xxx」不做取反魔法，它就是一个独立的布尔参数。未声明的参数抛错。
 */
export function parseArgs(argv, spec) {
  const out = { _: [] }
  const camel = (k) => k.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { out._.push(a); continue }
    const eq = a.indexOf('=')
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2)
    const type = spec[key]
    if (!type) throw new Error(`未知参数 --${key}（可用：${Object.keys(spec).map((k) => '--' + k).join(' ')}）`)
    let val
    if (type === 'bool') {
      if (eq > 0) {
        const v = a.slice(eq + 1).toLowerCase()
        if (!['1', '0', 'true', 'false', 'yes', 'no'].includes(v)) throw new Error(`--${key} 只接受 true / false`)
        val = ['1', 'true', 'yes'].includes(v)
      } else val = true
    } else {
      if (eq > 0) val = a.slice(eq + 1)
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) val = argv[++i]
      else throw new Error(`--${key} 需要一个值`)
      if (type === 'number' || type === 'int') {
        const n = Number(val)
        if (!Number.isFinite(n) || (type === 'int' && !Number.isInteger(n))) throw new Error(`--${key} 需要${type === 'int' ? '整数' : '数字'}，收到「${val}」`)
        val = n
      } else if (type === 'list') {
        val = val.split(',').map((s) => s.trim()).filter(Boolean)
      }
    }
    out[camel(key)] = val
  }
  return out
}

// ─────────────────────────────── 网络 ───────────────────────────────

const redactProxy = (u) => { try { const x = new URL(u); if (x.password) x.password = '***'; if (x.username) x.username = '***'; return x.toString().replace(/\/$/, '') } catch { return String(u) } }

/**
 * 建一个带代理判定的 fetch。返回 { fetch, via, close }。
 *   proxy    显式代理 URL（--proxy），优先级最高
 *   noProxy  true 时强制直连（--no-proxy），忽略环境变量
 * 否则看环境变量 HTTPS_PROXY / HTTP_PROXY（大小写均可），用 undici 的 EnvHttpProxyAgent（NO_PROXY 生效）。
 * 超时：连接 30 s、等响应头 30 s、响应体两块之间静默 60 s。
 */
export function createNet({ proxy, noProxy, headersTimeout = 30000, bodyTimeout = 60000 } = {}) {
  const base = { headersTimeout, bodyTimeout, connect: { timeout: 30000 } }
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
  let dispatcher, via
  if (noProxy) { dispatcher = new Agent(base); via = '直连（--no-proxy）' }
  else if (proxy) {
    try { new URL(proxy) } catch { throw new Error(`--proxy 不是合法 URL：${proxy}`) }
    dispatcher = new ProxyAgent({ ...base, uri: proxy }); via = `代理 ${redactProxy(proxy)}（--proxy）`
  } else if (envProxy) { dispatcher = new EnvHttpProxyAgent(base); via = `代理 ${redactProxy(envProxy)}（环境变量）` }
  else { dispatcher = new Agent(base); via = '直连' }
  return {
    via,
    fetch: (url, init = {}) => undiciFetch(url, { redirect: 'follow', ...init, dispatcher, headers: { 'user-agent': USER_AGENT, ...(init.headers || {}) } }),
    close: () => dispatcher.close().catch(() => {})
  }
}

/** HTTP 错误对象：带 status；4xx（除 408 / 425 / 429）视为永久错误，不重试。 */
export function httpError(status, msg, res) {
  const e = new Error(msg || `HTTP ${status}`)
  e.status = status
  e.permanent = status >= 400 && status < 500 && ![408, 425, 429].includes(status)
  const ra = res && res.headers && res.headers.get('retry-after')
  if (ra) {
    const s = Number(ra)
    e.retryAfterMs = Number.isFinite(s) ? s * 1000 : Math.max(0, Date.parse(ra) - Date.now())
  }
  return e
}

export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) return reject(abortError())
  const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve() }, ms)
  const onAbort = () => { clearTimeout(t); reject(abortError()) }
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
})

function abortError() { const e = new Error('已中断'); e.name = 'AbortError'; e.permanent = true; e.aborted = true; return e }

/**
 * 指数退避重试：第 i 次失败后等 base·2^(i−1)（上限 maxMs，±25 % 抖动；有 Retry-After 取较大者）。
 * e.permanent 为真（4xx、用户中断）立即抛出。每个错误对象带 attempts（已尝试次数）。
 */
export async function withRetry(fn, { tries = 5, baseMs = 2000, maxMs = 60000, signal, onRetry } = {}) {
  let last
  for (let i = 1; i <= tries; i++) {
    try { return await fn(i) } catch (e) {
      last = e
      e.attempts = i
      if (signal && signal.aborted) { e.permanent = true; e.aborted = true }
      if (e.permanent || i === tries) throw e
      let wait = Math.min(maxMs, baseMs * 2 ** (i - 1)) * (0.75 + Math.random() * 0.5)
      if (e.retryAfterMs) wait = Math.max(wait, Math.min(e.retryAfterMs, 5 * 60000))
      if (onRetry) onRetry(e, i, wait)
      await sleep(wait, signal)
    }
  }
  throw last
}

/** 取 JSON（带重试）。返回 { data, headers }。 */
export async function fetchJson(net, url, { tries = 5, signal, onRetry } = {}) {
  return withRetry(async () => {
    const res = await net.fetch(url, { headers: { accept: 'application/json' }, signal })
    if (!res.ok) { await res.body?.cancel().catch(() => {}); throw httpError(res.status, `HTTP ${res.status}：${url}`, res) }
    const text = await res.text()
    try { return { data: JSON.parse(text), headers: res.headers } } catch { throw new Error(`返回的不是 JSON：${url}（${text.slice(0, 80)}…）`) }
  }, { tries, signal, onRetry })
}

// ─────────────────────────────── URL ───────────────────────────────

const safeDecode = (s) => { try { return decodeURIComponent(s) } catch { return s } }

/**
 * 规范直链：去掉查询串（?emrc=… 是 CDN 缓存戳，每次页面生成都会变）与片段、路径各段百分号解码。
 * 结果与 include-list.json 的 url 同一写法（空格、括号原样），用于比对与存档；发请求前必须 encodeUrl。
 */
export function canonicalUrl(raw) {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)([^?#]*)/i.exec(String(raw).trim())
  if (!m) return String(raw).trim()
  return m[1] + m[2].split('/').map(safeDecode).join('/')
}

/**
 * 发请求用的 URL：路径逐段先解码再 encodeURI（空格 → %20、中文 → UTF-8 百分号），
 * 段内的 ? 与 # 另行转义（encodeURI 不管这两个），已编码过的不会被二次编码。查询串原样保留。
 */
export function encodeUrl(raw) {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)([^?#]*)(\?[^#]*)?/i.exec(String(raw).trim())
  if (!m) throw new Error(`无法解析的 URL：${raw}`)
  const p = m[2].split('/').map((seg) => encodeURI(safeDecode(seg)).replace(/[?#]/g, (c) => encodeURIComponent(c))).join('/')
  return m[1] + p + (m[3] || '')
}

/** 直链最后一段 → 本机文件名（解码；Windows 非法字符换成 _；去掉结尾的点与空格）。 */
export function fileNameFromUrl(raw) {
  const seg = canonicalUrl(raw).split('/').pop() || 'model.glb'
  return seg.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '') || 'model.glb'
}

/** 直链的目录段（…/model/<目录>/<文件>）规范成 slug 写法：小写、去括号、其余非字母数字换连字符。 */
export function urlFolderSlug(url) {
  const m = /\/model\/([^/]+)\/[^/]+$/i.exec(canonicalUrl(url))
  return m ? m[1].toLowerCase().replace(/[()]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : null
}

/**
 * 跨条目共用的直链。NASA 页面有编辑错误：rosetta / europa-orbiter / mars-2020-perseverance-rover-2 的下载链接
 * 指向 IBEX 的文件，aqua-a 的第二个文件是 Aquarius (A) 的 —— 照单全收会把 IBEX 当成 Rosetta 存进语料。
 * entries: [{ slug, glbs: [{ url }] }] → Map<规范直链, { owner, users }>，只收被 ≥ 2 个条目引用的直链；
 * owner = 直链目录段与 slug 对得上的那个条目，一个都对不上时为 null（只算共用，不判谁借谁）。
 */
export function sharedGlbUrls(entries) {
  const users = new Map()
  for (const e of entries) for (const g of e.glbs || []) {
    const u = canonicalUrl(g.url)
    if (!users.has(u)) users.set(u, [])
    if (!users.get(u).includes(e.slug)) users.get(u).push(e.slug)
  }
  const out = new Map()
  for (const [u, s] of users) {
    if (s.length < 2) continue
    const f = urlFolderSlug(u)
    out.set(u, { owner: s.find((x) => x === f) || null, users: s })
  }
  return out
}

/** 该条目的这个直链是「借用」别的条目的文件时返回属主 slug，否则 null。 */
export function borrowedOwner(shared, slug, url) {
  const x = shared.get(canonicalUrl(url))
  return x && x.owner && x.owner !== slug ? x.owner : null
}

/** 标题比较用的归一：WordPress 会把「 - 」排印成「 – 」、引号换成弯引号，这类差异不算改标题。 */
export const normTitle = (t) => String(t || '').replace(/[‐-―−]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[\s ]+/g, ' ').trim()

/** slug 只能是单个安全的路径段（防 ../ 之类把文件写出 .models-src）。 */
export function assertSafeSlug(slug) {
  if (typeof slug !== 'string' || !slug || slug === '.' || slug === '..' || /[/\\:*?"<>|\u0000-\u001f]/.test(slug)) {
    throw new Error(`不安全的 slug：${JSON.stringify(slug)}`)
  }
  return slug
}

export const slugDir = (slug) => path.join(NASA_DIR, assertSafeSlug(slug))

// ─────────────────────────────── 文件 ───────────────────────────────

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

/** 先写临时文件再改名，写到一半被打断不会留下半截 JSON。 */
export async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  await fsp.rename(tmp, file)
}

export async function statSize(file) {
  try { return (await fsp.stat(file)).size } catch { return -1 }
}

/** 删只读文件（Windows 上只读属性会让 unlink 报 EPERM）。 */
export async function forceRemove(file) {
  try { await fsp.chmod(file, 0o666) } catch { /* 不存在 */ }
  await fsp.rm(file, { force: true })
}

export async function sha256File(file) {
  const h = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(file, { highWaterMark: MiB }), async function (src) { for await (const c of src) h.update(c) })
  return h.digest('hex')
}

/** sha256 旁车：「<64 位十六进制>  <文件名>\n」（与 sha256sum 输出同格式，可直接 sha256sum -c）。 */
export async function writeSidecar(glbPath, hex) {
  await fsp.writeFile(glbPath + '.sha256', `${hex}  ${path.basename(glbPath)}\n`, 'utf8')
}

export function readSidecar(glbPath) {
  try {
    const m = /^([0-9a-f]{64})\b/i.exec(fs.readFileSync(glbPath + '.sha256', 'utf8').trim())
    return m ? m[1].toLowerCase() : null
  } catch { return null }
}

/**
 * 已落盘原件的完整性：{ state: 'missing' | 'nosidecar' | 'mismatch' | 'ok', sha256?, bytes? }。
 * 'ok' 要求 .sha256 旁车存在且与文件实算的 sha256 一致（整文件重算，不信文件大小）。
 */
export async function verifyExisting(glbPath) {
  const size = await statSize(glbPath)
  if (size < 0) return { state: 'missing' }
  const side = readSidecar(glbPath)
  if (!side) return { state: 'nosidecar', bytes: size }
  const hex = await sha256File(glbPath)
  return hex === side ? { state: 'ok', sha256: hex, bytes: size } : { state: 'mismatch', sha256: hex, expected: side, bytes: size }
}

// ─────────────────────────────── 下载（Range 续传） ───────────────────────────────

function parseContentRange(v) {
  // "bytes 100-199/1234" | "bytes 100-199/*" | "bytes */1234"
  const m = /^bytes\s+(?:(\d+)-(\d+)|\*)\/(\d+|\*)$/i.exec(String(v || '').trim())
  if (!m) return null
  return { start: m[1] != null ? Number(m[1]) : null, end: m[2] != null ? Number(m[2]) : null, total: m[3] === '*' ? null : Number(m[3]) }
}

/**
 * 断点续传下载到 dest。
 *   · 数据先写 dest.part，续传元信息（url / ETag / Last-Modified / 总长）写 dest.part.json；
 *     续传带 Range + If-Range（强 ETag 优先，否则 Last-Modified）—— 服务器上文件变了会回 200 整份，自动从头写。
 *   · 长度校验只认服务器：206 取 Content-Range 的总长，200 取 Content-Length；不认目录页的近似体积。
 *     没有长度头时照收，但返回 lengthVerified=false 由调用方报出来。
 *   · 收齐后：算 sha256 → 写旁车 → .part 改名为 dest → chmod 0o444。旁车先于改名，
 *     所以「有 dest 没旁车」只可能是人为动过，调用方按损坏处理。
 *   · 416：已有长度 ≥ 服务器长度。相等说明上次收齐但没来得及改名，直接收尾；否则清空重下。
 * opts: { net, signal, maxBytes, tries=5, onProgress(got, total), onRetry(err, attempt, waitMs), onResponse({ total, resumedFrom }) }
 * 返回 { bytes, total, lengthVerified, sha256, resumedFrom, etag, lastModified, attempts, httpStatus }
 * 失败抛错：e.status / e.permanent / e.attempts；超出 maxBytes 时 e.code = 'TOO_LARGE'、e.total。
 */
export async function downloadWithResume(url, dest, opts = {}) {
  const { net, signal, maxBytes, tries = 5, onProgress, onRetry, onResponse } = opts
  if (!net) throw new Error('downloadWithResume 需要 opts.net（createNet() 的返回值）')
  const part = dest + '.part'
  const stateFile = part + '.json'
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  const reqUrl = encodeUrl(url)
  let attempts = 0

  const finalize = async (info) => {
    const hex = await sha256File(part)
    await writeSidecar(dest, hex)
    await forceRemove(dest)
    await fsp.rename(part, dest)
    await fsp.rm(stateFile, { force: true })
    try { await fsp.chmod(dest, 0o444) } catch { /* 只读属性设不上不影响数据 */ }
    return { ...info, bytes: await statSize(dest), sha256: hex, attempts }
  }

  return withRetry(async (attempt) => {
    attempts = attempt
    let have = Math.max(0, await statSize(part))
    const state = readJson(stateFile)
    if (have > 0 && state && state.url && state.url !== canonicalUrl(url)) { await fsp.rm(part, { force: true }); have = 0 }
    const headers = { 'accept-encoding': 'identity' }
    if (have > 0) {
      headers.range = `bytes=${have}-`
      const validator = state && state.etag && !/^W\//.test(state.etag) ? state.etag : (state && state.lastModified)
      if (validator) headers['if-range'] = validator
    }
    const res = await net.fetch(reqUrl, { headers, signal })
    const etag = res.headers.get('etag')
    const lastModified = res.headers.get('last-modified')

    if (res.status === 416) {
      await res.body?.cancel().catch(() => {})
      const cr = parseContentRange(res.headers.get('content-range'))
      const known = cr && cr.total != null ? cr.total : (state && state.total)
      if (known != null && have === known) return finalize({ total: known, lengthVerified: true, resumedFrom: have, etag, lastModified, httpStatus: 416 })
      await fsp.rm(part, { force: true })
      const e = new Error(`续传区间无效（已有 ${have} 字节，服务器 ${known ?? '未知'} 字节），已清空重下`)
      throw e
    }
    if (res.status !== 200 && res.status !== 206) {
      await res.body?.cancel().catch(() => {})
      throw httpError(res.status, `HTTP ${res.status}`, res)
    }
    const enc = (res.headers.get('content-encoding') || '').toLowerCase()
    if (enc && enc !== 'identity') {
      await res.body?.cancel().catch(() => {})
      throw new Error(`服务器返回了压缩编码 ${enc}，无法按字节校验`)
    }

    let total, flags, resumedFrom = 0
    if (res.status === 206) {
      const cr = parseContentRange(res.headers.get('content-range'))
      if (!cr || cr.start !== have) {
        await res.body?.cancel().catch(() => {})
        await fsp.rm(part, { force: true })
        throw new Error(`续传起点不符（请求 ${have}，服务器回 ${res.headers.get('content-range')}），已清空重下`)
      }
      total = cr.total
      if (total == null) { const cl = Number(res.headers.get('content-length')); if (Number.isFinite(cl)) total = have + cl }
      flags = 'a'; resumedFrom = have
    } else {
      const cl = res.headers.get('content-length')
      total = cl != null && cl !== '' && Number.isFinite(Number(cl)) ? Number(cl) : null
      flags = 'w'; have = 0
    }
    if (maxBytes && total != null && total > maxBytes) {
      await res.body?.cancel().catch(() => {})
      const e = new Error(`超出 --max-mb 上限（${fmtBytes(total)}）`)
      e.code = 'TOO_LARGE'; e.total = total; e.permanent = true
      throw e
    }
    if (onResponse) onResponse({ total, resumedFrom })
    await writeJsonAtomic(stateFile, { url: canonicalUrl(url), etag, lastModified, total, updatedAt: new Date().toISOString() })

    let got = have
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        got += chunk.length
        if (maxBytes && got > maxBytes) return cb(Object.assign(new Error(`超出 --max-mb 上限（已收 ${fmtBytes(got)}）`), { code: 'TOO_LARGE', total: got, permanent: true }))
        if (onProgress) onProgress(got, total)
        cb(null, chunk)
      }
    })
    if (!res.body) throw new Error('响应没有正文')
    try {
      await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(part, { flags }), { signal })
    } catch (e) {
      if (e && e.code === 'TOO_LARGE') { await fsp.rm(part, { force: true }); await fsp.rm(stateFile, { force: true }) }
      throw e
    }

    const size = await statSize(part)
    if (total != null && size !== total) {
      if (size > total) await fsp.rm(part, { force: true })
      throw new Error(`长度不符：收到 ${size} 字节，服务器声明 ${total} 字节`)
    }
    return finalize({ total, lengthVerified: total != null, resumedFrom, etag, lastModified, httpStatus: res.status })
  }, { tries, signal, onRetry })
}

// ─────────────────────────────── GLB 头 ───────────────────────────────

const GLB_MAGIC = 0x46546c67   // 'glTF'
const CHUNK_JSON = 0x4e4f534a  // 'JSON'
const CHUNK_BIN = 0x004e4942   // 'BIN\0'

/**
 * 纯函数：解析 GLB 的 12 字节文件头 + JSON 块，并定位 BIN 块。不解网格、不碰 Draco。
 * 入参可以是整份文件，也可以只到 BIN 块头为止（readGlbHeaderFile 就只读这么多）。
 * 返回 { version, length, json, jsonLength, binOffset, binLength, truncated }；
 *   binOffset / binLength：BIN 块数据在文件中的偏移与长度（没有 BIN 块时 null / 0）；
 *   truncated：入参比文件头声明的总长短（只读了头时必然为 true，不算错）。
 * 格式不对抛错（中文说明）。
 */
export function parseGlbHeader(input) {
  const u8 = input instanceof Uint8Array ? input : (input instanceof ArrayBuffer ? new Uint8Array(input) : null)
  if (!u8) throw new TypeError('parseGlbHeader 需要 Uint8Array / Buffer / ArrayBuffer')
  if (u8.byteLength < 20) throw new Error(`GLB 头不足 20 字节（${u8.byteLength}）`)
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error('不是 GLB：magic 不是 glTF')
  const version = dv.getUint32(4, true)
  if (version !== 2) throw new Error(`GLB 版本 ${version}，只支持 2`)
  const length = dv.getUint32(8, true)
  const jsonLength = dv.getUint32(12, true)
  if (dv.getUint32(16, true) !== CHUNK_JSON) throw new Error('第一个块不是 JSON 块')
  if (20 + jsonLength > length) throw new Error(`JSON 块（${jsonLength} 字节）越过文件声明总长 ${length}`)
  if (20 + jsonLength > u8.byteLength) throw new Error(`JSON 块被截断（需要 ${20 + jsonLength} 字节，只有 ${u8.byteLength}）`)
  let json
  try { json = JSON.parse(new TextDecoder('utf-8').decode(u8.subarray(20, 20 + jsonLength))) } catch (e) { throw new Error(`JSON 块解析失败：${e.message}`) }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('JSON 块不是对象')
  let binOffset = null
  let binLength = 0
  const off = 20 + jsonLength
  if (off + 8 <= length && off + 8 <= u8.byteLength) {
    const len = dv.getUint32(off, true)
    if (dv.getUint32(off + 4, true) === CHUNK_BIN) {
      if (off + 8 + len > length) throw new Error(`BIN 块（${len} 字节）越过文件声明总长 ${length}`)
      binOffset = off + 8
      binLength = len
    }
  }
  return { version, length, json, jsonLength, binOffset, binLength, truncated: u8.byteLength < length }
}

/** 从文件只读 GLB 头 + JSON 块 + BIN 块头（大文件也只读几百 KB）。另返回 fileSize 与 lengthMatches（头声明总长 = 实际文件长）。 */
export async function readGlbHeaderFile(file) {
  const fh = await fsp.open(file, 'r')
  try {
    const { size } = await fh.stat()
    const head = Buffer.alloc(20)
    const { bytesRead } = await fh.read(head, 0, 20, 0)
    if (bytesRead < 20) throw new Error(`文件不足 20 字节（${size}）`)
    const jsonLength = head.readUInt32LE(12)
    const want = Math.min(size, 20 + jsonLength + 8)
    const buf = Buffer.alloc(want)
    await fh.read(buf, 0, want, 0)
    const h = parseGlbHeader(buf)
    return { ...h, fileSize: size, lengthMatches: h.length === size }
  } finally {
    await fh.close()
  }
}

// ─────────────────────────────── glTF 统计 ───────────────────────────────

const NORM_DIV = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535, 5125: 4294967295 }
const deq = (acc, v) => {
  if (!acc.normalized) return v
  const d = NORM_DIV[acc.componentType]
  if (!d) return v
  return acc.componentType === 5120 || acc.componentType === 5122 ? Math.max(v / d, -1) : v / d
}

// 4×4 列主序（与 glTF 的 node.matrix 同序）
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
function mul(a, b) {
  const o = new Array(16)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
  }
  return o
}
function trs(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix.map(Number)
  const [tx, ty, tz] = Array.isArray(node.translation) ? node.translation : [0, 0, 0]
  const [qx, qy, qz, qw] = Array.isArray(node.rotation) ? node.rotation : [0, 0, 0, 1]
  const [sx, sy, sz] = Array.isArray(node.scale) ? node.scale : [1, 1, 1]
  const xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz
  return [
    (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    tx, ty, tz, 1
  ]
}
const hasRotation = (m) => Math.abs(m[1]) > 1e-9 || Math.abs(m[2]) > 1e-9 || Math.abs(m[4]) > 1e-9 || Math.abs(m[6]) > 1e-9 || Math.abs(m[8]) > 1e-9 || Math.abs(m[9]) > 1e-9

function primTriangles(json, prim) {
  const mode = prim.mode ?? 4
  const acc = json.accessors || []
  const idx = prim.indices != null ? acc[prim.indices] : null
  const pos = prim.attributes && prim.attributes.POSITION != null ? acc[prim.attributes.POSITION] : null
  const n = idx ? idx.count : (pos ? pos.count : 0)
  if (!Number.isFinite(n)) return 0
  if (mode === 4) return Math.floor(n / 3)
  if (mode === 5 || mode === 6) return Math.max(0, n - 2)
  return 0 // 点 / 线图元不计三角形
}

function imageFormat(img) {
  if (img.mimeType) return img.mimeType
  const u = String(img.uri || '')
  const dm = /^data:([^;,]+)/i.exec(u)
  if (dm) return dm[1]
  const ext = (/\.([a-z0-9]+)(?:$|[?#])/i.exec(u) || [])[1]
  return ext ? 'ext:' + ext.toLowerCase() : 'unknown'
}

/**
 * glTF JSON → 统计摘要（纯函数，不解网格）。
 *
 * 三角形口径：逐图元取 indices 访问器的 count（无索引取 POSITION 的 count）；TRIANGLES 取 ⌊n/3⌋，
 *   STRIP / FAN 取 n−2，点 / 线记 0。Draco 图元的 indices / POSITION 访问器照样在 JSON 里带 count（规范要求），
 *   所以不用解压也数得出。triangles 按网格去重（几何量），trianglesInstanced 按场景里节点引用次数（渲染量）。
 * 包围盒口径（近似）：取每个图元 POSITION 访问器的 min / max（局部轴对齐盒；normalized 量化坐标按分量类型反量化），
 *   8 个角点乘节点世界矩阵（父子 matrix / TRS 逐级相乘）后取外包盒。节点带旋转时这是保守上界（最坏偏大 √3 倍），
 *   bboxApprox 为真；蒙皮、变形目标、动画姿态一律不计。场景取 json.scene（缺省第 0 个；都没有就取所有根节点）。
 * span = 外包盒三边中最长的一边（模型单位，NASA 原件单位不可信，见 §2.1）。
 */
export function summarizeGltf(json) {
  const arr = (k) => (Array.isArray(json[k]) ? json[k] : [])
  const nodes = arr('nodes'), meshes = arr('meshes'), accessors = arr('accessors')
  const used = Array.isArray(json.extensionsUsed) ? json.extensionsUsed.slice() : []
  const required = Array.isArray(json.extensionsRequired) ? json.extensionsRequired.slice() : []
  const asset = json.asset || {}

  let primitives = 0, dracoPrims = 0, vertices = 0
  const meshTris = meshes.map((m) => {
    let t = 0
    for (const p of (Array.isArray(m.primitives) ? m.primitives : [])) {
      primitives++
      t += primTriangles(json, p)
      if (p.extensions && p.extensions.KHR_draco_mesh_compression) dracoPrims++
      const pos = p.attributes && p.attributes.POSITION != null ? accessors[p.attributes.POSITION] : null
      if (pos && Number.isFinite(pos.count)) vertices += pos.count
    }
    return t
  })
  const triangles = meshTris.reduce((s, x) => s + x, 0)

  const imageFormats = {}
  for (const img of arr('images')) { const f = imageFormat(img); imageFormats[f] = (imageFormats[f] || 0) + 1 }
  let externalUris = 0
  for (const b of arr('buffers')) if (b.uri && !/^data:/i.test(b.uri)) externalUris++
  for (const img of arr('images')) if (img.uri && !/^data:/i.test(img.uri)) externalUris++

  // 场景遍历：世界矩阵 + 外包盒 + 按实例计三角形
  const sceneIdx = Number.isInteger(json.scene) ? json.scene : 0
  const scene = arr('scenes')[sceneIdx]
  let roots = scene && Array.isArray(scene.nodes) ? scene.nodes : null
  if (!roots) {
    const child = new Set()
    for (const n of nodes) for (const c of (n.children || [])) child.add(c)
    roots = nodes.map((_, i) => i).filter((i) => !child.has(i))
  }
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  let rotated = false, trianglesInstanced = 0, bboxMissing = 0, meshInstances = 0
  const visiting = new Set()
  const walk = (i, parent, depth) => {
    const n = nodes[i]
    if (!n || visiting.has(i) || depth > 256) return
    visiting.add(i)
    const m = mul(parent, trs(n))
    if (hasRotation(m)) rotated = true
    if (Number.isInteger(n.mesh) && meshes[n.mesh]) {
      meshInstances++
      trianglesInstanced += meshTris[n.mesh]
      for (const p of (meshes[n.mesh].primitives || [])) {
        const acc = p.attributes && p.attributes.POSITION != null ? accessors[p.attributes.POSITION] : null
        if (!acc || !Array.isArray(acc.min) || !Array.isArray(acc.max) || acc.min.length < 3) { bboxMissing++; continue }
        const lo = acc.min.slice(0, 3).map((v) => deq(acc, v)), hi = acc.max.slice(0, 3).map((v) => deq(acc, v))
        for (let k = 0; k < 8; k++) {
          const x = k & 1 ? hi[0] : lo[0], y = k & 2 ? hi[1] : lo[1], z = k & 4 ? hi[2] : lo[2]
          const w = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]
          for (let a = 0; a < 3; a++) { if (w[a] < min[a]) min[a] = w[a]; if (w[a] > max[a]) max[a] = w[a] }
        }
      }
    }
    for (const c of (Array.isArray(n.children) ? n.children : [])) walk(c, m, depth + 1)
    visiting.delete(i)
  }
  for (const r of roots) walk(r, IDENT, 0)
  const ok = min.every(Number.isFinite) && max.every(Number.isFinite)
  const size = ok ? [0, 1, 2].map((a) => max[a] - min[a]) : null
  const bbox = ok ? { min, max, size, span: Math.max(...size) } : null

  const has = (x) => used.includes(x)
  return {
    generator: asset.generator || null,
    copyright: asset.copyright || null,
    gltfVersion: asset.version || null,
    extensionsUsed: used,
    extensionsRequired: required,
    draco: { used: has('KHR_draco_mesh_compression'), required: required.includes('KHR_draco_mesh_compression'), primitives: dracoPrims },
    meshopt: has('EXT_meshopt_compression') || has('KHR_meshopt_compression'),
    quantized: has('KHR_mesh_quantization'),
    textureExt: used.filter((x) => /^(KHR_texture_basisu|EXT_texture_webp|EXT_texture_avif|KHR_texture_transform)$/.test(x)),
    specGloss: has('KHR_materials_pbrSpecularGlossiness'),
    counts: {
      scenes: arr('scenes').length, nodes: nodes.length, meshes: meshes.length, primitives, meshInstances,
      materials: arr('materials').length, textures: arr('textures').length, images: arr('images').length,
      samplers: arr('samplers').length, accessors: accessors.length, animations: arr('animations').length,
      skins: arr('skins').length, cameras: arr('cameras').length,
      lights: json.extensions && json.extensions.KHR_lights_punctual && Array.isArray(json.extensions.KHR_lights_punctual.lights) ? json.extensions.KHR_lights_punctual.lights.length : 0
    },
    imageFormats,
    externalUris,
    triangles,
    trianglesInstanced,
    vertices,
    bbox,
    bboxApprox: rotated,
    bboxMissing,
    rootNames: roots.slice(0, 6).map((i) => (nodes[i] && nodes[i].name) || `#${i}`)
  }
}

// ─────────────────────────────── 清单与格式化 ───────────────────────────────

/** 读 include-list.json 并做最小结构校验。 */
export function loadIncludeList(file = INCLUDE_LIST_FILE) {
  const j = readJson(file)
  if (!j || !Array.isArray(j.entries) || !j.groups) throw new Error(`include-list.json 读不出或结构不对：${file}`)
  const seen = new Set()
  for (const e of j.entries) {
    assertSafeSlug(e.slug)
    if (seen.has(e.slug)) throw new Error(`include-list.json 里 slug 重复：${e.slug}`)
    seen.add(e.slug)
    if (!Array.isArray(e.glbs)) throw new Error(`include-list.json 条目缺 glbs：${e.slug}`)
  }
  const include = j.groups.include || []
  const optional = j.groups.optional || []
  const all = [...new Set(j.entries.map((e) => e.group))]
  const excluded = all.filter((g) => !include.includes(g) && !optional.includes(g))
  return { ...j, include, optional, excluded, allGroups: [...include, ...optional, ...excluded] }
}

/** 字节 → 「10.56 MB」。1024 进位（与 NASA 目录页的体积文字同口径）。 */
export function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n < 1024) return `${n} B`
  if (n < MiB) return `${(n / 1024).toFixed(2)} KB`
  if (n < 1024 * MiB) return `${(n / MiB).toFixed(2)} MB`
  return `${(n / 1024 / MiB).toFixed(2)} GB`
}

/** 体积文字「10.56 MB」→ 字节（1024 进位，四舍五入到整字节）。 */
export function sizeTextToBytes(num, unit) {
  const k = { B: 1, BYTES: 1, KB: 1024, MB: MiB, GB: 1024 * MiB }[String(unit).toUpperCase()]
  const v = Number(num)
  return k && Number.isFinite(v) ? Math.round(v * k) : null
}

export const fmtInt = (n) => (n == null || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString('en-US'))
export const fmtSec = (ms) => (ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`)

/** 终端显示宽度：CJK / 全角记 2 列。 */
export function strWidth(s) {
  let w = 0
  for (const ch of String(s)) {
    const c = ch.codePointAt(0)
    w += (c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd))) ? 2 : 1
  }
  return w
}

/** 终端表格。aligns：每列 'l' | 'r'（缺省：首列左对齐，其余右对齐）。 */
export function formatTable(headers, rows, aligns) {
  const cols = headers.length
  const al = aligns || headers.map((_, i) => (i === 0 ? 'l' : 'r'))
  const cells = [headers, ...rows].map((r) => r.map((c) => (c == null ? '' : String(c))))
  const w = Array.from({ length: cols }, (_, i) => Math.max(...cells.map((r) => strWidth(r[i] || ''))))
  const pad = (s, i) => { const d = w[i] - strWidth(s); return al[i] === 'r' ? ' '.repeat(d) + s : s + ' '.repeat(d) }
  const line = (r) => r.map((c, i) => pad(c || '', i)).join('  ').trimEnd()
  const sep = w.map((x) => '-'.repeat(x)).join('  ')
  return [line(cells[0]), sep, ...cells.slice(1).map(line)].join('\n')
}

/** Markdown 表格（竖线转义）。 */
export function mdTable(headers, rows, aligns) {
  const al = aligns || headers.map((_, i) => (i === 0 ? 'l' : 'r'))
  const esc = (c) => (c == null ? '' : String(c)).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  return [
    '| ' + headers.map(esc).join(' | ') + ' |',
    '|' + al.map((a) => (a === 'r' ? '---:' : ':---')).join('|') + '|',
    ...rows.map((r) => '| ' + r.map(esc).join(' | ') + ' |')
  ].join('\n')
}

// ─────────────────────────────── HTML ───────────────────────────────

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„', hellip: '…', copy: '©', reg: '®', trade: '™', deg: '°', times: '×',
  middot: '·', bull: '•', prime: '′', Prime: '″', laquo: '«', raquo: '»', shy: '­', eacute: 'é', egrave: 'è',
  aacute: 'á', agrave: 'à', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', ouml: 'ö', uuml: 'ü', auml: 'ä',
  ccedil: 'ç', szlig: 'ß', micro: 'µ', plusmn: '±', frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³'
}

/** HTML 实体解码（数字实体全支持，命名实体取常用表；认不得的原样保留）。 */
export function decodeEntities(s) {
  return String(s == null ? '' : s).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, g) => {
    if (g[0] === '#') {
      const cp = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10)
      try { return Number.isFinite(cp) && cp > 0 ? String.fromCodePoint(cp) : m } catch { return m }
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, g) ? NAMED_ENTITIES[g] : m
  })
}

/** 去标签 + 解码 + 合并空白。 */
export function htmlToText(s) {
  return decodeEntities(String(s == null ? '' : s).replace(/<[^>]*>/g, ' ')).replace(/[\s ]+/g, ' ').trim()
}
