// OMM 云镜像（腾讯云 COS）：众包星历的「兜底下载 + 首个拿到新数据的用户回传」。
// 背景：部分网络屏蔽 celestrak.org，但不屏蔽腾讯云 COS。参考小程序（Satellitelinkbudget/utils/tleStore.js）
// 的众包模式，桌面端做同一件事：
//   ① 任一用户直连 CelesTrak 成功 → best-effort 回传到桶（带闸门：云端那份还够新就不传，避免重复覆盖）；
//   ② 直连 CelesTrak 彻底失败的用户 → 从桶里取（公有读，无需任何凭证，国内直连可达）；
//   ③ 桶也拿不到 → 静默放弃（不弹错、不写状态栏），交由 omm.js 回落「用户缓存 / 内置快照」。
// 桶里每组只留最新一份（同名覆盖）：omm/csv_<group>.csv.gz（gzip 存储，starlink 1.6MB → 0.5MB）。
//
// 凭证：只有「上传」需要，下载不需要（桶是公有读）。直接复用在线分享那份 CAM 子账号密钥
// （electron/services/shareConfig.js，已 gitignore、随安装包分发），不再另造第二份密钥文件。
// 前提：该子账号的策略里要把 omm/* 也加上（PutObject/GetObject/HeadObject）——见 shareConfig.example.js。
// 没配到 / 没权限 → PUT 403 → 静默跳过回传，下载兜底照常工作。
// 传输走 netFetch（下载与回传都是）：优先 Electron net —— 单位内网经代理 / 审计网关出网、热点慢链路都靠它。
const netFetch = require('./netFetch')
const zlib = require('zlib')
// 压缩 / 解压走线程池（异步）：17 组全量 level 9 压一次 130–300 ms，同步做会把主进程（= 所有窗口的 IPC）整段冻住。
// 同一个 zlib、同一组参数，产物与同步版逐字节相同
const { promisify } = require('util')
const gzipAsync = promisify(zlib.gzip), gunzipAsync = promisify(zlib.gunzip)
const { createHmac, createHash } = require('crypto')
const log = require('./ommLog')          // 每一步都进日志窗格：查了哪个对象、为何跳过、传没传成功
const { fmtBytes, fmtSec, fmtTime } = log

const DEFAULT_BUCKET = 'update-1385987144'   // 与自动更新同一个桶，OMM 走 omm/ 前缀（权限：公有读私有写）
const DEFAULT_REGION = 'ap-beijing'
const PREFIX = 'omm/'
const objKey = (g) => `${PREFIX}csv_${g}.csv.gz`

const MAX_GZ = 8 * 1024 * 1024          // 下载体积上限：桶被写脏也不至于拖垮客户端（现最大的两件：active 组 gz 约 0.8MB、satcat 约 1.4MB）
const MAX_RAW = 64 * 1024 * 1024        // 解压后上限（zip bomb 防护）
const STALE_HOURS = 6                   // 云端副本超过此时长才允许回传：一天最多几次覆盖，够新就不动
const TIMEOUT = 20000                   // 下载：无进展超时（热点上 1 MB 的件要走几十秒，按总时长卡会次次失败）
const MAX_MS = 3 * 60_000               // 下载：总时限，兜慢滴
const PUT_TIMEOUT = 60000               // 回传：无进展超时（上传进度算进展）

// 与 omm.js / fetch-omm-snapshot.mjs 同一判据：是 CelesTrak OMM CSV 才算数据有效。
// 这是【缺省档】——桶里还躺着非星历的数据集（omm/csv_satcat.csv.gz，编目里没有 MEAN_MOTION 列），
// 那类键由调用方（omm.js 的 validOf(key)）把自己的判据传进 download / maybeUpload。
const valid = (t) => t && /MEAN_MOTION/i.test(t)

// ---- 凭证（仅上传用；缺失即只读模式，下载不受影响）----
let _cfg   // 惰性解析一次
function cfg() {
  if (_cfg) return _cfg
  _cfg = { bucket: DEFAULT_BUCKET, region: DEFAULT_REGION, id: '', key: '' }
  const e = process.env
  // ① 环境变量（开发/测试；自建部署也可整体换成自己的桶）——显式指定的桶/地域优先级最高，下面不许覆盖
  const envBucket = !!e.SATSIM_OMM_COS_BUCKET, envRegion = !!e.SATSIM_OMM_COS_REGION
  if (envBucket) _cfg.bucket = e.SATSIM_OMM_COS_BUCKET
  if (envRegion) _cfg.region = e.SATSIM_OMM_COS_REGION
  if (e.SATSIM_OMM_COS_ID && e.SATSIM_OMM_COS_KEY) { _cfg.id = e.SATSIM_OMM_COS_ID; _cfg.key = e.SATSIM_OMM_COS_KEY }
  // ② 在线分享的子账号密钥（随安装包分发的那份；文件不存在 = 只读模式，只下载不回传）
  if (!_cfg.id) {
    try {
      const s = require('./shareConfig.js')   // 与 share.js 同一写法：运行时可选，不存在也不影响打包
      if (s && s.secretId && s.secretKey) {
        _cfg.id = s.secretId; _cfg.key = s.secretKey
        if (s.bucket && !envBucket) _cfg.bucket = s.bucket
        if (s.region && !envRegion) _cfg.region = s.region
        if (s.endpoint) _cfg.endpoint = s.endpoint     // 只给验证台 / 单测：指到本机回环服务器（真凭证文件里没有这一项）
      }
    } catch { /* 无 shareConfig.js：只读模式 */ }
  }
  // ③ 开发机上的主账号密钥（跑 npm run dev 时顺带也能回传，不影响用户端）
  if (!_cfg.id && e.COS_SECRET_ID && e.COS_SECRET_KEY) { _cfg.id = e.COS_SECRET_ID; _cfg.key = e.COS_SECRET_KEY }
  return _cfg
}

const host = () => `${cfg().bucket}.cos.${cfg().region}.myqcloud.com`
const baseUrl = () => (cfg().endpoint ? String(cfg().endpoint).replace(/\/+$/, '') : `https://${host()}`)
const canUpload = () => !!(cfg().id && cfg().key)

// 本机时钟纠偏（与 share.js 同一口径，同 COS 官方 SDK 的 CorrectClockSkew）：回传撞上时钟类 403
// （RequestTimeTooSkewed / AccessDenied「Request has expired」）时按响应 Date 头算出偏移、重签重发一次
let _clockOffset = 0
const SKEW_MIN_MS = 30_000
const xmlTag = (text, tag) => { const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(String(text || '')); return m ? m[1].trim() : '' }

// COS q-sign 签名（与 scripts/publish-cos.mjs 同一实现）：只签 method + pathname，不签 header。
function authorization(method, pathname) {
  const c = cfg()
  const now = Math.floor((Date.now() + _clockOffset) / 1000) - 60
  const exp = now + 900
  const signTime = `${now};${exp}`
  const signKey = createHmac('sha1', c.key).update(signTime).digest('hex')
  const httpString = `${method.toLowerCase()}\n${pathname}\n\n\n`
  const stringToSign = `sha1\n${signTime}\n${createHash('sha1').update(httpString).digest('hex')}\n`
  const signature = createHmac('sha1', signKey).update(stringToSign).digest('hex')
  return [
    'q-sign-algorithm=sha1', `q-ak=${c.id}`, `q-sign-time=${signTime}`, `q-key-time=${signTime}`,
    'q-header-list=', 'q-url-param-list=', `q-signature=${signature}`
  ].join('&')
}

// GET/HEAD（匿名公读）：按二进制收（gzip），要读响应头拿 Last-Modified。任何失败都落成 status 0，
// 调用方据此回落（netFetch 保证一定落地：截断 / 黑洞 / 超上限都会结束）。
// 不吃缓存：Chromium 磁盘缓存（no-store）与单位缓存代理（Cache-Control: no-cache）都绕开 ——
// 吃到旧的 HEAD，「云端够新就不回传 / 不比本地新就不下载」两道闸全判错。
async function fetchBin(method, key) {
  try {
    const r = await netFetch.request(`${baseUrl()}/${key}`, {
      method, headers: { 'Cache-Control': 'no-cache' },
      idleMs: TIMEOUT, maxMs: MAX_MS, maxBytes: method === 'HEAD' ? 0 : MAX_GZ
    })
    return { status: r.status, headers: r.headers, body: r.body }
  } catch (e) {
    return { status: 0, headers: {}, body: Buffer.alloc(0), why: (e && e.message) || String(e) }
  }
}

const hdr = netFetch.hdr

// 查云端某组的元信息 → { lastModified:ISO, size } ；不存在/不可达 → null
async function head(group) {
  const r = await fetchBin('HEAD', objKey(group))
  if (r.status !== 200) return null
  const lm = hdr(r.headers, 'last-modified')
  const t = lm ? Date.parse(lm) : NaN
  const len = parseInt(hdr(r.headers, 'content-length'), 10)
  return { lastModified: isNaN(t) ? null : new Date(t).toISOString(), size: isNaN(len) ? 0 : len }
}

// 从桶下载某组 → { text, fetchedAt } ；任何环节不成立都返回 null（对用户无感，但每一步都写日志）。
// newerThan：本地已有副本的时间，云端不比它新就不下载（省流量，且不用旧数据覆盖新数据）。
// valid：该键自己的有效性判据（缺省＝OMM 的 MEAN_MOTION 正则）。
// tag：日志前缀（缺省「星历「…」：」）。桶里不只有星历 —— 太阳射电流量那一路走的是自己的
//   前缀「太阳射电流量：」，按前缀检索日志才检得到同一条链路上的全部行。
async function download(group, opts = {}) {
  const tag = opts.tag || `星历「${opts.label || group}」：`
  const isValid = opts.valid || valid
  const t0 = Date.now()
  try {
    log.emit(`${tag}转查云镜像 ${host()}/${objKey(group)}`)
    const meta = await head(group)
    if (!meta) { log.emit(`${tag}云镜像无此分组（对象不存在或 COS 不可达）`, 'warn'); return null }
    if (opts.newerThan && meta.lastModified && Date.parse(meta.lastModified) <= Date.parse(opts.newerThan)) {
      log.emit(`${tag}云镜像版本 ${fmtTime(meta.lastModified)} 不新于本地 ${fmtTime(opts.newerThan)}，跳过下载`)
      return null
    }
    if (meta.size > MAX_GZ) { log.emit(`${tag}云镜像对象 ${fmtBytes(meta.size)} 超出 ${fmtBytes(MAX_GZ)} 上限，已拒绝`, 'warn'); return null }
    const r = await fetchBin('GET', objKey(group))
    if (r.status !== 200 || !r.body.length) { log.emit(`${tag}云镜像下载失败（${r.status ? 'HTTP ' + r.status : (r.why || '连接中断')}）`, 'warn'); return null }
    let text = ''
    try { text = (await gunzipAsync(r.body, { maxOutputLength: MAX_RAW })).toString('utf8') }
    catch { text = r.body.toString('utf8') }   // 兼容万一存成了明文 CSV
    if (!isValid(text)) { log.emit(`${tag}云镜像内容不满足有效性判据，已丢弃`, 'warn'); return null }
    log.emit(`${tag}云镜像下载成功 —— ${fmtBytes(r.body.length)}(gz) 解压 ${fmtBytes(text.length)} · 对象时间 ${fmtTime(meta.lastModified)} · 耗时 ${fmtSec(Date.now() - t0)}`)
    return { text, fetchedAt: meta.lastModified || new Date().toISOString() }
  } catch (e) {
    log.emit(`${tag}云镜像访问异常（${(e && e.message) || e}）`, 'warn')
    return null
  }
}

// 单次 PUT（失败一律落成 { ok:false, status, why }，不抛）。net 下不手设 Content-Length：
// 整块体交给网络栈（不分块），长度由它自己算。时钟类 403 按服务器时间重签重发一次。
async function put(key, buf) {
  for (let skewLeft = 1; ;) {
    let r
    try {
      r = await netFetch.request(`${baseUrl()}/${key}`, {
        method: 'PUT', body: buf, idleMs: PUT_TIMEOUT, redirect: 'error',
        headers: { Authorization: authorization('put', '/' + key), 'Content-Type': 'application/gzip' }
      })
    } catch (e) {
      return { ok: false, status: e.status || 0, why: (e && e.message) || String(e) }
    }
    // 200 也要是 COS 自己回的（带 x-cos-request-id）：单位审计网关 / 门户代答的 200 网页不算传上去了
    const fromCos = !!(hdr(r.headers, 'x-cos-request-id') || /tencent-cos/i.test(hdr(r.headers, 'server')))
    if (r.status === 200) return fromCos ? { ok: true, status: 200 } : { ok: false, status: 200, why: 'HTTP 200 但不是 COS 应答（疑似被网关拦截）' }
    const text = r.body.toString('utf8')
    const code = xmlTag(text, 'Code'), msg = xmlTag(text, 'Message')
    const skew = r.status === 403 && (code === 'RequestTimeTooSkewed' || (code === 'AccessDenied' && /expired|not yet/i.test(msg)))
    if (skew && skewLeft > 0) {
      const t = Date.parse(hdr(r.headers, 'date')) || Date.parse(xmlTag(text, 'ServerTime'))
      if (t && Math.abs(Date.now() + _clockOffset - t) >= SKEW_MIN_MS) {
        skewLeft--
        _clockOffset = t - Date.now()
        const d = Math.round(-_clockOffset / 1000)
        log.emit(`众包回传：签名撞上时钟类 403，已按 COS 服务器时间重签（本机钟 ${d > 0 ? '+' : ''}${d} s）`, 'warn')
        continue
      }
    }
    return { ok: false, status: r.status, code, why: code ? `HTTP ${r.status} ${code}` : `HTTP ${r.status}` }
  }
}

const _uploaded = new Set()   // 本进程内每组只回传一次，避免同一会话重复上传
let _noCredWarned = false     // 「无凭证」「无写权限」只提示一次：17 个分组逐个刷屏没有意义
let _permDenied = false

// 众包回传：把刚从 CelesTrak 拉到的 CSV 传上桶。best-effort —— 无凭证 / 云端够新 / 网络失败一律返回 false
// 且不打断主流程；但每种跳过原因都写进日志，便于现场判断「众包这条腿到底有没有在跑」。
// 第四参 checkValid：该键自己的有效性判据（缺省＝OMM 的 MEAN_MOTION 正则）——别把非星历数据集
// 当成坏数据默默丢掉，也别把坏数据当好的传上去污染别人的兜底。
async function maybeUpload(group, text, label, checkValid, tagOverride) {
  const tag = tagOverride || `星历「${label || group}」：`
  const isValid = checkValid || valid
  try {
    if (_permDenied || _uploaded.has(group) || !isValid(text)) return false
    if (!canUpload()) {
      if (!_noCredWarned) { _noCredWarned = true; log.emit('众包回传：本机未配置云镜像凭证，不参与回传（仅下载，不影响使用）') }
      return false
    }
    const meta = await head(group)
    if (meta && meta.lastModified) {
      const ageH = (Date.now() - Date.parse(meta.lastModified)) / 3600e3
      if (ageH < STALE_HOURS) {
        _uploaded.add(group)   // 云端已够新：本会话不再探测这组
        log.emit(`${tag}云镜像已是 ${ageH.toFixed(1)} 小时前（${fmtTime(meta.lastModified)}）的版本，无需回传`)
        return false
      }
    }
    const t0 = Date.now()
    const gz = await gzipAsync(Buffer.from(text, 'utf8'), { level: 9 })
    const r = await put(objKey(group), gz)
    if (r.ok) {
      _uploaded.add(group)
      log.emit(`${tag}已回传云镜像 —— ${fmtBytes(gz.length)}(gz) · 耗时 ${fmtSec(Date.now() - t0)}，无法直连 CelesTrak 的用户将从此处获取`)
      return true
    }
    if (r.status === 403) {
      _permDenied = true   // 凭证没有该前缀写权限：整个会话不再重试，避免每组一次无谓的上传
      log.emit(`${tag}回传云镜像被拒绝（${r.why}${r.code === 'AccessDenied' ? ` —— 当前凭证无 ${PREFIX} 前缀写权限` : ''}），本会话不再尝试回传`, 'warn')
    } else {
      log.emit(`${tag}回传云镜像失败（${r.why || (r.status ? 'HTTP ' + r.status : '网络不可达')}），不影响本机使用`, 'warn')
    }
    return false
  } catch (e) {
    log.emit(`${tag}回传云镜像异常（${(e && e.message) || e}）`, 'warn')
    return false
  }
}

module.exports = { head, download, maybeUpload, canUpload, objKey, PREFIX, DEFAULT_BUCKET, DEFAULT_REGION }
