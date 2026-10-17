'use strict'
// 主进程统一的一次 HTTP(S) 往返。share / ommCloud / omm / solarFlux / gfs / weather 共用，别各写一份。
//
// ── 优先 Electron net ─────────────────────────────────────────────────────
// net 走 Chromium 网络栈，单位内网与手机热点上要用到的几样它都有、Node https 一样都没有：
//   · 系统代理 / PAC / WPAD 自动发现（单位内网多数只能经代理出网）；
//   · 代理的 NTLM / Kerberos 集成认证（用当前 Windows 登录身份，不弹框）；
//   · Windows 证书库 —— 单位 TLS 审计网关的根证书只装在这里，Node 自带的 CA 表不认。
//     于是同一台机器上会出现「自动更新能升级（走 net）、激活永远拉不到（走 https）」。
// 无 Electron（验证台 / 单测 / 脚本）或 app 尚未就绪时退回 Node http(s)，判据与出参一致。
//
// ── 一定落地 ──────────────────────────────────────────────────────────────
// 返回的 promise 必然结束（resolve 完整正文，或 reject 一个带 kind 的错误）：
//   · 响应头已到、正文半截连接被关（热点切基站 / 网关掐长连接）：Node 的 IncomingMessage 在没有
//     'error' 监听时根本不发 error、只发 aborted / close，不听就永远等不到 end；net 那边截断在响应
//     对象上发 'error'，没人听就是 uncaughtException。error / aborted / close 三个都听，谁先到谁结束。
//   · 黑洞与慢链路：按【无进展】计时 —— 连接、上传、下载任何一段 idleMs 内没有字节进出才算超时，
//     不按总时长卡：热点 / 单位出口限速下几 MB 的星历要走一两分钟，总时长 30 s 会次次失败。
//     另给 maxMs 总时限兜「一秒一个字节」的慢滴。
//   · HTTP 缓存：net 缺省读写 Chromium 磁盘缓存，COS 对象带 Last-Modified 会被启发式缓存，
//     激活书 / 收件箱 / 云镜像元信息可能吃到旧的。故一律 cache:'no-store'，读请求另带 Cache-Control: no-cache
//     （后者也让单位里做 TLS 审计的缓存代理回源，而不是把它存的旧对象吐回来）。
//
// reject 的 Error 带：
//   kind       'net' 连接层（DNS / 拒连 / TLS / 代理）· 'cut' 响应头已到、正文没收完 · 'timeout' 无进展或超总时限
//              'redirect' 被重定向且 redirect:'error'（门户 / 网关拦截）· 'size' 正文超上限
//   code       底层错误码（ERR_*，即 net::ERR_* 去掉前缀 / ECONNRESET …）；timeout 另带 phase：connect | body | total
//   status / headers   响应头已到时附上
//   transient  值得立刻重试一次的瞬断：切网（ERR_NETWORK_CHANGED）、连接被重置、正文截断、热点 DNS 抖动。
//              超时不算 —— 再等一整轮的代价由调用方自己的重试策略决定。
const http = require('http')
const https = require('https')

// net 不许手设的头：由网络栈自己算（Content-Length）或自己管（Host / 连接复用），setHeader 会直接抛
const RESTRICTED = new Set(['content-length', 'host', 'connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'keep-alive', 'cookie2'])
const TRANSIENT = /^(ERR_NETWORK_CHANGED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_ABORTED|ERR_EMPTY_RESPONSE|ERR_CONTENT_LENGTH_MISMATCH|ERR_INCOMPLETE_CHUNKED_ENCODING|ERR_HTTP2_\w+|ERR_SPDY_\w+|ERR_QUIC_PROTOCOL_ERROR|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_IO_SUSPENDED|ECONNRESET|EPIPE|ECONNABORTED|EAI_AGAIN)$/

// Electron net（主进程、app 已就绪）；裸 node 里 require('electron') 拿到的是可执行文件路径字符串
function electronNet() {
  try {
    const e = require('electron')
    if (e && typeof e === 'object' && e.net && typeof e.net.request === 'function' &&
        e.app && typeof e.app.isReady === 'function' && e.app.isReady()) return e.net
  } catch { /* 非 Electron */ }
  return null
}

// 响应头取值（小写键）。net 的重复头可能给数组，统一取第一个；缺省给空串
function hdr(h, name) {
  const v = h && h[String(name).toLowerCase()]
  if (Array.isArray(v)) return v[0] == null ? '' : String(v[0])
  return v == null ? '' : String(v)
}
function normHeaders(h) {
  const out = {}
  if (h && typeof h === 'object') for (const k of Object.keys(h)) out[k.toLowerCase()] = h[k]
  return out
}
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB')
const sec = (ms) => Math.round(ms / 1000)
function codeOf(e) {
  if (!e) return ''
  if (e.code) return String(e.code)
  const m = /net::(ERR_[A-Z0-9_]+)/.exec(String(e.message || e))
  return m ? m[1] : ''
}
function mkErr(kind, message, extra) {
  const e = new Error(message)
  e.kind = kind
  if (extra) Object.assign(e, extra)
  if (e.transient == null) e.transient = kind === 'cut' || (kind === 'net' && TRANSIENT.test(e.code || ''))
  return e
}
function reqErr(e) {
  const msg = String((e && e.message) || e || '')
  // net 在 redirect:'error' 下的原话是「Attempted to redirect, but redirect policy was 'error'」
  if (/redirect/i.test(msg)) return mkErr('redirect', '被重定向（疑似网络门户或网关拦截）', { cause: e })
  const code = codeOf(e)
  return mkErr('net', `连接失败（${code || msg || '原因未知'}）`, { code, cause: e })
}

/**
 * @param {string} url  http(s) 绝对地址
 * @param {object} [o]
 *   method      缺省 GET
 *   headers     { 名: 值 }；net 下的受限头（Content-Length / Host …）自动略过，由网络栈自己算
 *   body        string | Buffer | null —— 整块交给网络栈（net 不分块，Content-Length 由它算）
 *   idleMs      无进展超时，缺省 30000；0 = 不设
 *   maxMs       总时限，缺省 0 = 不设
 *   maxBytes    正文上限，超了中止（kind 'size'）
 *   redirect    'follow'（缺省）| 'error'（COS 这类从不重定向的源：一重定向就是门户 / 网关在拦）
 *   acceptGzip  只对 Node 路生效：带 Accept-Encoding: gzip（net 自己协商并解压，不用也不该手设）
 *   onHeaders   (status, headers) => void，响应头一到就回调（记服务器时间用）
 *   transport   'auto'（缺省）| 'node'（强制走 Node 路）
 * @returns {Promise<{status:number, headers:object, body:Buffer, via:'net'|'node'}>}
 */
function request(url, o = {}) {
  const method = String(o.method || 'GET').toUpperCase()
  const idleMs = o.idleMs == null ? 30000 : (Number(o.idleMs) || 0)
  const maxMs = Number(o.maxMs) || 0
  const maxBytes = Number(o.maxBytes) || 0
  const body = o.body == null ? null : (Buffer.isBuffer(o.body) ? o.body : Buffer.from(String(o.body), 'utf8'))
  const headers = { ...(o.headers || {}) }
  // 只给读请求缺省带：COS 的 PUT 会把请求里的 Cache-Control 存成对象元数据，写请求不该顺手改它
  if ((method === 'GET' || method === 'HEAD') && !Object.keys(headers).some((k) => k.toLowerCase() === 'cache-control')) headers['Cache-Control'] = 'no-cache'
  const net = o.transport === 'node' ? null : electronNet()
  const via = net ? 'net' : 'node'

  return new Promise((resolve, reject) => {
    let settled = false, idleT = null, maxT = null
    let req = null, res = null, status = 0, resHeaders = {}
    let size = 0, lastUp = 0
    const chunks = []
    const abort = () => { try { if (req) { if (via === 'net') req.abort(); else req.destroy() } } catch { /* 已结束 */ } }
    const finish = (err, val) => {
      if (settled) return
      settled = true
      clearTimeout(idleT); clearTimeout(maxT)
      if (!err) return resolve(val)
      if (res && err.status == null) { err.status = status; err.headers = resHeaders }
      abort()
      reject(err)
    }
    const timeoutErr = () => mkErr('timeout', `${sec(idleMs)} s 无进展`, { phase: res ? 'body' : 'connect' })
    const cut = (e) => finish(mkErr('cut', `连接中断（正文未收完，已收 ${fmtSize(size)}）`, { code: codeOf(e) }))
    // 请求对象上的错误：响应头已到之后的一律是正文被掐断 —— net 的请求对象 end() 后已自毁，
    // 出错时先在它身上同步发 error（实测早于响应对象的 error），不这么归类就会被当成「连不上」
    const onReqError = (e) => (res ? cut(e) : finish(reqErr(e)))

    // net 的无进展计时（Node 路用 socket 自带的 setTimeout，它对读写两个方向都计活动）。
    // 上传阶段没有下行字节：到点时先看上传进度有没有往前走，走了就续期 —— 大 PUT 走慢链路不该被当成黑洞
    const arm = () => {
      if (!idleMs || settled || via !== 'net') return
      clearTimeout(idleT)
      idleT = setTimeout(onIdle, idleMs)
    }
    const onIdle = () => {
      if (settled) return
      if (!res && req && typeof req.getUploadProgress === 'function') {
        try {
          const p = req.getUploadProgress()
          const cur = Number(p && p.current) || 0
          if (p && p.active && cur > lastUp) { lastUp = cur; return arm() }
        } catch { /* 拿不到进度：按超时处理 */ }
      }
      finish(timeoutErr())
    }
    if (maxMs) maxT = setTimeout(() => finish(mkErr('timeout', `超过总时限 ${sec(maxMs)} s`, { phase: 'total' })), maxMs)

    const onResponse = (r) => {
      if (settled) { try { r.resume() } catch { /* 已放弃的响应 */ } return }
      res = r
      status = Number(r.statusCode) || 0
      resHeaders = normHeaders(r.headers)
      if (typeof o.onHeaders === 'function') { try { o.onHeaders(status, resHeaders) } catch { /* 回调出错不影响取数 */ } }
      // Node 不跟随重定向，3xx 原样到这里；net 在 redirect:'error' 下走的是 req 'error'
      if (o.redirect === 'error' && status >= 300 && status < 400 && status !== 304) {
        return finish(mkErr('redirect', '被重定向（疑似网络门户或网关拦截）'))
      }
      arm()
      r.on('data', (c) => {
        if (settled) return
        size += c.length
        if (maxBytes && size > maxBytes) return finish(mkErr('size', `正文超过 ${fmtSize(maxBytes)} 上限`))
        chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
        arm()
      })
      r.on('end', () => finish(null, { status, headers: resHeaders, body: Buffer.concat(chunks), via }))
      r.on('error', cut)
      r.on('aborted', () => cut())
      r.on('close', () => cut())      // 正常结束时 end 先到，这里是空操作；没等到 end 就关 = 截断
    }

    let u
    try { u = new URL(url) } catch { return finish(mkErr('net', `地址无效：${url}`)) }

    if (net) {
      try {
        req = net.request({ method, url: u.href, redirect: o.redirect === 'error' ? 'error' : 'follow', cache: 'no-store' })
      } catch (e) { return finish(mkErr('net', `请求发起失败（${e.message}）`, { code: codeOf(e) })) }
      for (const k of Object.keys(headers)) {
        if (RESTRICTED.has(k.toLowerCase())) continue
        try { req.setHeader(k, String(headers[k])) } catch { /* 网络栈不让设的头：交给它自己 */ }
      }
      req.on('response', onResponse)
      req.on('error', onReqError)
      // ★ 不听 net 请求对象的 'close'：它是 Writable，end() 写完就自动销毁、先于 response 发 close
      //   （实测）。net 这边的失败一律走 'error'，余下的由无进展计时兜底
      arm()
      try { if (body) req.write(body); req.end() } catch (e) { finish(mkErr('net', `请求发起失败（${e.message}）`, { code: codeOf(e) })) }
      return
    }

    const mod = u.protocol === 'http:' ? http : https
    const h = { ...headers }
    if (o.acceptGzip) h['Accept-Encoding'] = 'gzip'
    if (body) h['Content-Length'] = body.length
    try {
      req = mod.request({
        method, protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || undefined,
        path: u.pathname + u.search, headers: h
      }, onResponse)
    } catch (e) { return finish(mkErr('net', `请求发起失败（${e.message}）`, { code: codeOf(e) })) }
    if (idleMs) req.setTimeout(idleMs, () => finish(timeoutErr()))
    req.on('error', onReqError)
    req.on('close', () => { if (!res) finish(mkErr('net', '连接已关闭（未收到响应）')) })
    if (body) req.write(body)
    req.end()
  })
}

module.exports = { request, hdr, electronNet }
