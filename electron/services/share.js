// 配置「在线信箱」分享（主进程）：复用腾讯云 COS 桶按用户ID投递配置 JSON。
// 模型：发送 → PUT  <prefix>/<收件人ID>/<时间_uuid>.json
//      收件 → GET Bucket(list-type=2, prefix=<prefix>/<我的ID>/) 列举 + 逐个 GET 下载
//      接收/忽略 → DELETE 该对象
// 凭证：CAM 子账号密钥，放在 electron/services/shareConfig.js（已 gitignore，随安装包打进 electron/**）。
//       缺失则未配置。授权范围务必只给 share/* · omm/* · updates/gxt/* 三个前缀的
//       PutObject/GetObject —— 尤其【不能给 updates/*】：那是自动更新的下载目录，而这把密钥随包
//       分发、asar 可直接解开，给了就等于把更新通道公开。详见 shareConfig.example.js 的说明。
// 零三方 SDK：内置 https + crypto 自算 q-sign 签名（与 scripts/publish-cos.mjs 同法，扩展支持 query 参与签名）。
const https = require('https')
const { createHmac, createHash, randomUUID, randomBytes } = require('crypto')

let cfg = null
try { cfg = require('./shareConfig.js') } catch (e) { cfg = null }   // 运行时可选；不存在=未配置（不影响打包）
// 开发兜底：无 shareConfig.js 时，复用发布用的 COS 环境变量（COS_SECRET_ID/KEY/BUCKET/REGION，见 scripts/publish-cos.mjs），
// 免得开发机再单独放一份密钥。打包给终端用户的机器无这些环境变量，仍走 shareConfig.js。
//
// ⚠️ 这条兜底曾经掩盖过一个发版事故：shareConfig.js 从未建过，开发机靠环境变量一路自测通过，
//    而所有安装包里根本没有凭证 → 用户侧「在线分享 / 发送到小程序」一直不可用，且在开发机上
//    永远复现不出来。所以这里必须显式打日志说明「当前走的是开发凭证，打包版没有」，
//    打包前的 scripts/check-share-config.mjs 也会把缺文件这件事拦成硬错误。
// 另：环境变量是【主账号发布凭证】，权限远大于分享子账号。用它自测会让「策略是否配窄了」
//    这类问题测不出来（本该 403 的写入会成功），故仅限开发机、且 app.isPackaged 时不启用。
let _devFallback = false
if (!(cfg && cfg.secretId && cfg.secretKey && cfg.bucket && cfg.region)) {
  const e = process.env
  let packaged = false
  try { packaged = !!require('electron').app.isPackaged } catch { /* 非 Electron 环境（测试/脚本） */ }
  if (!packaged && e.COS_SECRET_ID && e.COS_SECRET_KEY && e.COS_BUCKET && e.COS_REGION) {
    cfg = { secretId: e.COS_SECRET_ID, secretKey: e.COS_SECRET_KEY, bucket: e.COS_BUCKET, region: e.COS_REGION, prefix: (cfg && cfg.prefix) || 'share' }
    _devFallback = true
    console.warn('[share] 未找到 shareConfig.js，已回退到开发机 COS 环境变量（主账号发布凭证）。\n' +
                 '[share] 注意：打包版不含这些环境变量，此路径在用户机器上不成立；\n' +
                 '[share] 且此凭证权限大于分享子账号，配窄策略后本该 403 的写入在这里会成功。')
  } else if (!cfg) {
    console.warn('[share] 未配置在线分享凭证（缺 electron/services/shareConfig.js）——分享与「发送到小程序」将不可用。')
  }
}

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

// 写入前缀白名单。真正的防线是 CAM 策略（见 shareConfig.example.js），但策略这种「配在别处、
// 看不见、容易被后来者图省事放宽」的东西不该是唯一防线：这里就地挡一道，保证客户端在代码层面
// 就没有能力去写 updates/latest.yml、updates/*.exe 这类对象——哪怕手上的密钥恰好给多了权限。
// 越权即抛错（而不是静默跳过），让问题在开发期就暴露出来。
function assertWritable(key) {
  const k = String(key == null ? '' : key)
  // 先挡穿越与畸形：COS 的 key 是字面字符串（不像文件系统会规范化 ..），今天构造不出这种 key，
  // 但白名单若能被 `updates/gxt/../latest.yml` 绕过就等于没有 —— 前缀判断之前先把它们排除。
  if (!k || k.startsWith('/') || k.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) {
    throw new Error(`拒绝写入畸形路径「${k}」`)
  }
  const allow = [prefixOf() + '/', 'omm/', GXT_PREFIX + '/']
  if (!allow.some((p) => k.startsWith(p))) {
    throw new Error(`拒绝写入越权路径「${k}」：本客户端只允许写 ${allow.join(' / ')}`)
  }
  return k
}
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
// 消息体自 v1.4.6 起以 bundle（分享包 v3：配置多选 + 资源库多选，见 src/shared/lbShare.js）为准；
// items / state 是给旧版本客户端留的兼容字段，由渲染端一并附上（老版 importConfigs 读 items[].lib，
// 因此那份对它完整可用），本层只负责原样转存与回读，不解释内容。
async function send(recipientId, payload) {
  if (!configured()) throw new Error('在线分享未配置（缺少 COS 子账号密钥）')
  const rid = sanitizeId(recipientId)
  if (!rid) throw new Error('对方用户ID无效')
  const arr = await readInbox(rid)
  arr.push({
    id: Date.now().toString(36) + '_' + randomUUID().slice(0, 8),
    from: (payload && payload.from) || '', name: (payload && payload.name) || '分享内容',
    bundle: (payload && payload.bundle) || null,
    items: (payload && payload.items) || null, state: payload && payload.state, ts: Date.now()
  })
  await request('PUT', encPath(assertWritable(inboxKey(rid))), { body: JSON.stringify(arr.slice(-200)) })   // 限 200 条防膨胀
  return { ok: true }
}

// 收件箱：读我的聚合对象，时间倒序返回（每条带 id 供接收/忽略）
async function inbox(myId) {
  if (!configured()) throw new Error('在线分享未配置（缺少 COS 子账号密钥）')
  const mid = sanitizeId(myId)
  if (!mid) return { ok: true, items: [] }
  const arr = await readInbox(mid)
  const items = arr.map((o) => ({ id: o.id, from: o.from || '', name: o.name || '分享内容', bundle: o.bundle || null, items: o.items || null, state: o.state, ts: o.ts || 0 }))
  items.sort((a, b) => (b.ts || 0) - (a.ts || 0))
  return { ok: true, items }
}

// ============ 发送到小程序：把「当前绘制状态」快照 PUT 到 COS updates/gxt/<密钥>.json ============
// 模型：PUT updates/gxt/<key>.json（JSON 快照），返回短密钥供小程序输入。放在发布用的 updates/ 前缀下——
//       该前缀本就可写（发布凭证）且匿名可读（自动更新器要能匿名拉取），故零额外控制台配置；密钥即凭证，
//       小程序云函数据「内置基址 + 密钥」直链拉取。复用 inbox 同一套 COS q-sign 签名（authorization/request）。
// 前缀选 updates/gxt 是为了复用 updates/ 已有的【匿名公读】（小程序要直链拉取），省一条桶策略。
// 但 CAM 的写权限必须精确到 updates/gxt/*，绝不能放宽成 updates/* —— 后者会把自动更新的
// latest.yml 与安装包一并交出去（这把密钥随安装包分发）。详见 shareConfig.example.js。
const GXT_PREFIX = 'updates/gxt'
const KEY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'   // 去掉易混字符 I L O 0 1（用户手输密钥）
function genKey(len = 8) {
  const bytes = randomBytes(len)
  let s = ''
  for (let i = 0; i < len; i++) s += KEY_ALPHABET[bytes[i] % KEY_ALPHABET.length]
  return s
}
async function putSnapshot(payload) {
  if (!configured()) throw new Error('发送到小程序未配置（缺少 COS 凭证：shareConfig.js 或 COS_SECRET_ID 等环境变量）')
  if (!payload || typeof payload !== 'object') throw new Error('快照内容为空')
  const key = genKey(8)
  await request('PUT', encPath(assertWritable(`${GXT_PREFIX}/${key}.json`)), { body: JSON.stringify(payload) })
  return { ok: true, key }
}

// 接收/忽略后从我的信箱移除该条（读改写）
async function remove(myId, msgId) {
  if (!configured()) throw new Error('在线分享未配置')
  const mid = sanitizeId(myId)
  if (!mid || !msgId) return { ok: true }
  const arr = await readInbox(mid)
  await request('PUT', encPath(assertWritable(inboxKey(mid))), { body: JSON.stringify(arr.filter((m) => m.id !== msgId)) })
  return { ok: true }
}

module.exports = () => ({ configured, send, inbox, remove, putSnapshot })
