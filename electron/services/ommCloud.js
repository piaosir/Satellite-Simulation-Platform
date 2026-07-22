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
const https = require('https')
const zlib = require('zlib')
const { createHmac, createHash } = require('crypto')
const log = require('./ommLog')          // 每一步都进日志窗格：查了哪个对象、为何跳过、传没传成功
const { fmtBytes, fmtSec, fmtTime } = log

const DEFAULT_BUCKET = 'update-1385987144'   // 与自动更新同一个桶，OMM 走 omm/ 前缀（权限：公有读私有写）
const DEFAULT_REGION = 'ap-beijing'
const PREFIX = 'omm/'
const objKey = (g) => `${PREFIX}csv_${g}.csv.gz`

const MAX_GZ = 8 * 1024 * 1024          // 下载体积上限：桶被写脏也不至于拖垮客户端（active 组 gz 约 0.8MB）
const MAX_RAW = 64 * 1024 * 1024        // 解压后上限（zip bomb 防护）
const STALE_HOURS = 6                   // 云端副本超过此时长才允许回传：一天最多几次覆盖，够新就不动
const TIMEOUT = 20000

// 与 omm.js / fetch-omm-snapshot.mjs 同一判据：是 CelesTrak OMM CSV 才算数据有效
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
      }
    } catch { /* 无 shareConfig.js：只读模式 */ }
  }
  // ③ 开发机上的主账号密钥（跑 npm run dev 时顺带也能回传，不影响用户端）
  if (!_cfg.id && e.COS_SECRET_ID && e.COS_SECRET_KEY) { _cfg.id = e.COS_SECRET_ID; _cfg.key = e.COS_SECRET_KEY }
  return _cfg
}

const host = () => `${cfg().bucket}.cos.${cfg().region}.myqcloud.com`
const canUpload = () => !!(cfg().id && cfg().key)

// COS q-sign 签名（与 scripts/publish-cos.mjs 同一实现）：只签 method + pathname，不签 header。
function authorization(method, pathname) {
  const c = cfg()
  const now = Math.floor(Date.now() / 1000) - 60
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

// GET/HEAD：优先 Electron net（走 Chromium 网络栈，遵循系统代理），无 Electron 时退 Node https。
// 与 omm.js 的 httpGetText 同思路，但按二进制收（gzip），且要读响应头拿 Last-Modified。
function fetchBin(method, key) {
  const url = `https://${host()}/${key}`
  return new Promise((resolve) => {
    // 兜底定时器：超大对象中止 / 连接被黑洞时，可能既不 end 也不 error —— 保证 promise 一定落地，不悬住调用方。
    let settled = false
    const finish = (status, headers, body) => {
      if (settled) return
      settled = true
      clearTimeout(guard)
      resolve({ status: status || 0, headers: headers || {}, body: body || Buffer.alloc(0) })
    }
    const guard = setTimeout(() => finish(0), TIMEOUT + 2000)
    let net = null
    try { net = require('electron').net } catch {}
    if (net && typeof net.request === 'function') {
      const chunks = []
      let size = 0
      const req = net.request({ method, url })
      req.on('response', (res) => {
        res.on('data', (c) => {
          if (method === 'HEAD') return
          size += c.length
          if (size > MAX_GZ) { try { req.abort() } catch {} ; return finish(0) }
          chunks.push(Buffer.from(c))
        })
        res.on('end', () => finish(res.statusCode, res.headers, Buffer.concat(chunks)))
        res.on('error', () => finish(0))
      })
      req.on('error', () => finish(0))
      setTimeout(() => { if (!settled) { try { req.abort() } catch {} ; finish(0) } }, TIMEOUT)
      try { req.end() } catch { finish(0) }
      return
    }
    const req = https.request({ host: host(), method, path: '/' + key, timeout: TIMEOUT }, (res) => {
      const chunks = []
      let size = 0
      res.on('data', (c) => {
        if (method === 'HEAD') return
        size += c.length
        if (size > MAX_GZ) { req.destroy(); return finish(0) }
        chunks.push(c)
      })
      res.on('end', () => finish(res.statusCode, res.headers, Buffer.concat(chunks)))
      res.on('error', () => finish(0))
    })
    req.on('error', () => finish(0))
    req.on('timeout', () => { req.destroy(); finish(0) })
    req.end()
  })
}

// 响应头取值：Electron net 的头是数组，Node https 是字符串
const hdr = (h, name) => { const v = h && h[name]; return Array.isArray(v) ? v[0] : v }

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
async function download(group, opts = {}) {
  const tag = `星历「${opts.label || group}」：`
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
    if (r.status !== 200 || !r.body.length) { log.emit(`${tag}云镜像下载失败（HTTP ${r.status || '连接中断'}）`, 'warn'); return null }
    let text = ''
    try { text = zlib.gunzipSync(r.body, { maxOutputLength: MAX_RAW }).toString('utf8') }
    catch { text = r.body.toString('utf8') }   // 兼容万一存成了明文 CSV
    if (!valid(text)) { log.emit(`${tag}云镜像内容非有效 OMM CSV，已丢弃`, 'warn'); return null }
    log.emit(`${tag}云镜像下载成功 —— ${fmtBytes(r.body.length)}(gz) 解压 ${fmtBytes(text.length)} · 对象时间 ${fmtTime(meta.lastModified)} · 耗时 ${fmtSec(Date.now() - t0)}`)
    return { text, fetchedAt: meta.lastModified || new Date().toISOString() }
  } catch (e) {
    log.emit(`${tag}云镜像访问异常（${(e && e.message) || e}）`, 'warn')
    return null
  }
}

// 单次 PUT（Node https：与 publish-cos.mjs 同一条验证过的路径，需要 Content-Length，Electron net 不许手设）
function put(key, buf) {
  return new Promise((resolve) => {
    const req = https.request({
      host: host(), method: 'PUT', path: '/' + key, timeout: 60000,
      headers: {
        Authorization: authorization('put', '/' + key),
        'Content-Length': buf.length,
        'Content-Type': 'application/gzip'
      }
    }, (res) => { res.resume(); res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode })) })
    req.on('error', (e) => resolve({ ok: false, status: 0, why: (e && e.message) || String(e) }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, why: '上传超时 60s' }) })
    req.write(buf)
    req.end()
  })
}

const _uploaded = new Set()   // 本进程内每组只回传一次，避免同一会话重复上传
let _noCredWarned = false     // 「无凭证」「无写权限」只提示一次：17 个分组逐个刷屏没有意义
let _permDenied = false

// 众包回传：把刚从 CelesTrak 拉到的 CSV 传上桶。best-effort —— 无凭证 / 云端够新 / 网络失败一律返回 false
// 且不打断主流程；但每种跳过原因都写进日志，便于现场判断「众包这条腿到底有没有在跑」。
async function maybeUpload(group, text, label) {
  const tag = `星历「${label || group}」：`
  try {
    if (_permDenied || _uploaded.has(group) || !valid(text)) return false
    if (!canUpload()) {
      if (!_noCredWarned) { _noCredWarned = true; log.emit('星历回传：本机未配置云镜像凭证，不参与众包回传（仅下载，不影响使用）') }
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
    const gz = zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 9 })
    const r = await put(objKey(group), gz)
    if (r.ok) {
      _uploaded.add(group)
      log.emit(`${tag}已回传云镜像 —— ${fmtBytes(gz.length)}(gz) · 耗时 ${fmtSec(Date.now() - t0)}，无法直连 CelesTrak 的用户将从这里获取`)
      return true
    }
    if (r.status === 403) {
      _permDenied = true   // 凭证没有该前缀写权限：整个会话不再重试，避免每组一次无谓的上传
      log.emit(`${tag}回传云镜像被拒绝（HTTP 403 —— 当前凭证无 ${PREFIX} 前缀写权限），本会话不再尝试回传`, 'warn')
    } else {
      log.emit(`${tag}回传云镜像失败（${r.status ? 'HTTP ' + r.status : r.why || '网络不可达'}），不影响本机使用`, 'warn')
    }
    return false
  } catch (e) {
    log.emit(`${tag}回传云镜像异常（${(e && e.message) || e}）`, 'warn')
    return false
  }
}

module.exports = { head, download, maybeUpload, canUpload, objKey, PREFIX, DEFAULT_BUCKET, DEFAULT_REGION }
