// 配置「在线信箱」分享（主进程）：复用腾讯云 COS 桶按用户ID投递配置 JSON。
// 模型：发送 → PUT  <prefix>/<收件人ID>/<时间_uuid>.json
//      收件 → GET Bucket(list-type=2, prefix=<prefix>/<我的ID>/) 列举 + 逐个 GET 下载
//      接收/忽略 → DELETE 该对象
// 凭证：CAM 子账号密钥（仅授权 <prefix>/* 的 PutObject/GetObject/DeleteObject/GetBucket），
//       放在 electron/services/shareConfig.js（已 gitignore，随安装包打进 electron/**）。缺失则未配置。
// 零三方 SDK：内置 https + crypto 自算 q-sign 签名（与 scripts/publish-cos.mjs 同法，扩展支持 query 参与签名）。
const https = require('https')
const { createHmac, createHash, randomUUID } = require('crypto')

let cfg = null
try { cfg = require('./shareConfig.js') } catch (e) { cfg = null }   // 运行时可选；不存在=未配置（不影响打包）

const sha1 = (s) => createHash('sha1').update(s).digest('hex')
const hmac = (key, s) => createHmac('sha1', key).update(s).digest('hex')

function configured() { return !!(cfg && cfg.secretId && cfg.secretKey && cfg.bucket && cfg.region) }
const host = () => `${cfg.bucket}.cos.${cfg.region}.myqcloud.com`
const prefixOf = () => (cfg && cfg.prefix ? String(cfg.prefix).replace(/^\/+|\/+$/g, '') : 'share')
const sanitizeId = (id) => String(id == null ? '' : id).trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)

// q-sign：对 method + pathname（+ 列举时的 query 参数）签名；不签 header（q-header-list 空，与 publish 一致）。
function authorization(method, pathname, params) {
  const now = Math.floor(Date.now() / 1000) - 60
  const exp = now + 3600
  const keyTime = `${now};${exp}`
  const signKey = hmac(cfg.secretKey, keyTime)
  const keys = Object.keys(params || {}).sort()
  const paramList = keys.map((k) => k.toLowerCase()).join(';')
  const paramStr = keys.map((k) => `${encodeURIComponent(k.toLowerCase())}=${encodeURIComponent(params[k] == null ? '' : String(params[k]))}`).join('&')
  const httpString = `${method.toLowerCase()}\n${pathname}\n${paramStr}\n\n`
  const stringToSign = `sha1\n${keyTime}\n${sha1(httpString)}\n`
  const signature = hmac(signKey, stringToSign)
  return [
    'q-sign-algorithm=sha1', `q-ak=${cfg.secretId}`,
    `q-sign-time=${keyTime}`, `q-key-time=${keyTime}`,
    'q-header-list=', `q-url-param-list=${paramList}`, `q-signature=${signature}`
  ].join('&')
}

const encPath = (key) => '/' + key.split('/').map(encodeURIComponent).join('/')
const decodeXml = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")

function request(method, pathname, { params, body } = {}) {
  return new Promise((resolve, reject) => {
    const auth = authorization(method, pathname, params)
    let path = pathname
    if (params && Object.keys(params).length) {
      path += '?' + Object.keys(params).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&')
    }
    const opts = { method, host: host(), path, headers: { Authorization: auth } }
    if (body != null) { opts.headers['Content-Type'] = 'application/json'; opts.headers['Content-Length'] = Buffer.byteLength(body) }
    const req = https.request(opts, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(text)
        else reject(new Error(`COS ${res.statusCode}: ${text.slice(0, 300)}`))
      })
    })
    req.on('error', reject)
    if (body != null) req.write(body)
    req.end()
  })
}

// 收件箱模型：每个用户一个【聚合对象】 <prefix>/<用户ID>/inbox.json（一个 JSON 数组）。
// 收发只用 GetObject / PutObject（不需要 GetBucket 列举、不需要 DeleteObject）——CAM 权限最简单、最不易配错。
const inboxKey = (id) => `${prefixOf()}/${sanitizeId(id)}/inbox.json`

// 读回信箱数组；对象不存在(404/NoSuchKey)视为空数组
async function readInbox(id) {
  try {
    const t = await request('GET', encPath(inboxKey(id)))
    const arr = JSON.parse(t)
    return Array.isArray(arr) ? arr : []
  } catch (e) {
    const msg = String((e && e.message) || '')
    if (msg.includes('COS 404') || msg.includes('NoSuchKey')) return []
    throw e
  }
}

// 发送：读对方信箱 → 追加一条 → 写回（读改写；管理员仅 3 人、并发极少，竞态可忽略）
async function send(recipientId, payload) {
  if (!configured()) throw new Error('在线分享未配置（缺少 COS 子账号密钥）')
  const rid = sanitizeId(recipientId)
  if (!rid) throw new Error('对方用户ID无效')
  const arr = await readInbox(rid)
  arr.push({
    id: Date.now().toString(36) + '_' + randomUUID().slice(0, 8),
    from: (payload && payload.from) || '', name: (payload && payload.name) || '分享配置',
    items: (payload && payload.items) || null, state: payload && payload.state, ts: Date.now()
  })
  await request('PUT', encPath(inboxKey(rid)), { body: JSON.stringify(arr.slice(-200)) })   // 限 200 条防膨胀
  return { ok: true }
}

// 收件箱：读我的聚合对象，时间倒序返回（每条带 id 供接收/忽略）
async function inbox(myId) {
  if (!configured()) throw new Error('在线分享未配置（缺少 COS 子账号密钥）')
  const mid = sanitizeId(myId)
  if (!mid) return { ok: true, items: [] }
  const arr = await readInbox(mid)
  const items = arr.map((o) => ({ id: o.id, from: o.from || '', name: o.name || '分享配置', items: o.items || null, state: o.state, ts: o.ts || 0 }))
  items.sort((a, b) => (b.ts || 0) - (a.ts || 0))
  return { ok: true, items }
}

// 接收/忽略后从我的信箱移除该条（读改写）
async function remove(myId, msgId) {
  if (!configured()) throw new Error('在线分享未配置')
  const mid = sanitizeId(myId)
  if (!mid || !msgId) return { ok: true }
  const arr = await readInbox(mid)
  await request('PUT', encPath(inboxKey(mid)), { body: JSON.stringify(arr.filter((m) => m.id !== msgId)) })
  return { ok: true }
}

module.exports = () => ({ configured, send, inbox, remove })
