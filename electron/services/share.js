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

// 最近一次 COS 响应的 Date 头（epoch ms；0=尚未联网成功）。激活模块的时钟锚用。
let _serverDate = 0
const serverDate = () => _serverDate

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
      // 服务器时间（TLS 保真）：无论 2xx 还是 404 都记录——激活模块用它做时钟防篡改的权威锚
      if (res.headers && res.headers.date) {
        const t = Date.parse(res.headers.date)
        if (t) _serverDate = t
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(text)
        else reject(new Error(`COS ${res.statusCode}: ${text.slice(0, 300)}`))
      })
    })
    // 半连接黑洞（网关吞包不回）下 Node https 默认永不超时：请求会无限挂起，
    // 「刷新激活状态」一直转圈、分享收发无响应。30 秒足够宽，超了按网络错处理。
    req.setTimeout(30_000, () => req.destroy(new Error('COS 请求超时')))
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

// ============ 绑定投递：多个平台 ↔ 多个小程序账号，免密钥直投 ============
//
// 小程序侧生成一个 12 位【认证码】(CH) 作为自己的收件地址，人肉带到平台（长按复制 → 文件传输
// 助手 → 粘贴）。平台记下 CH 就能一直往里投；同一个 CH 可被多个平台绑定，同一个平台可绑多个 CH。
//
// 对象布局（全在 updates/gxt/ 下 —— 那是唯一【匿名公读】的前缀，而小程序云函数没有任何 COS
// 凭证、只能匿名 GET，所以信箱只能落在这里。share/* 是私有读，小程序够不着）：
//   updates/gxt/box/<CH>/roster.json         谁绑了这个账号（多平台共享）
//   updates/gxt/box/<CH>/<PID>/index.json    该平台的消息索引
//   updates/gxt/box/<CH>/<PID>/<MID>.json    消息件（信封原样转存，小程序侧的 import* 零改动）
//
// ★ 为什么不学 share/<用户ID>/inbox.json 那个聚合对象：那边装的是配置（20 KB 级），这边要装频率
//   计划（94 波束 HTS 一件几百 KB）。聚合进一个对象必爆，且小程序每次拉取都得把历史全下一遍。
//   拆成「索引 + 分件」后，日常同步只下索引（几 KB），点开哪件才下哪件。
//
// ★★ 按平台分目录，是为了让每个索引【只有一个写者】—— 多平台共写一个索引必然读改写竞态。
//    roster 是唯一的多写者对象，但它只在「这个平台第一次往这个 CH 投递」时才写。真撞上了会丢一条，
//    故每次投递都重新自检「我在不在 roster 里」，不在就补写：最坏情况是某平台的首投晚一轮才被
//    发现，下次投递自愈，不会永久失联。
//
// ★★★ CAM 只给了 PutObject / GetObject，【没有 DeleteObject】—— 那把密钥随安装包分发，给了删
//     权限就等于任何人都能删别人的信箱。所以「撤回」只能把消息件覆写成空对象 + 从索引里摘掉，
//     COS 上的对象本身留着。这不会无限堆积：MID 由 syncId 哈希而来，重发同一份内容【复用同一个
//     对象】，故对象数的上界是「你一共发过多少件不同的东西」，不是「你发了多少次」。
const BOX_PREFIX = `${GXT_PREFIX}/box`
const BOX_IDX_KIND = 'satsim-boxidx'
const BOX_ROSTER_KIND = 'satsim-roster'
const CH_LEN = 12
const BOX_KEEP = 60          // 索引里保留的条数上限（超出的最旧条目摘掉；对象本身按上面第三条留着）

// 认证码归一：去分隔符、大写。字母表与密钥同源（A-Z2-9，去掉易混的 I L O 0 1）。
// 长度 12 而不是密钥那样的 8：密钥是一次性的，猜中只泄露一份内容；认证码是【长期收件地址】，
// 猜中等于长期可读该账号收到的一切，风险等级不同。31^12 ≈ 7.9e17。
function normCh(raw) {
  const s = String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (s.length !== CH_LEN || [...s].some((c) => !KEY_ALPHABET.includes(c))) {
    throw new Error(`认证码格式不正确（应为 ${CH_LEN} 位，字母表 A-Z2-9）`)
  }
  return s
}
const boxDir = (ch) => `${BOX_PREFIX}/${ch}`
const rosterKey = (ch) => `${boxDir(ch)}/roster.json`
const boxIdxKey = (ch, pid) => `${boxDir(ch)}/${pid}/index.json`
const boxMsgKey = (ch, pid, mid) => `${boxDir(ch)}/${pid}/${mid}.json`

// 通用 JSON 读取；对象不存在(404/NoSuchKey)返回 fallback（首次投递时 roster / index 都还不存在）
async function getJson(key, fallback) {
  try {
    const v = JSON.parse(await request('GET', encPath(key)))
    return v && typeof v === 'object' ? v : fallback
  } catch (e) {
    const msg = String((e && e.message) || '')
    if (msg.includes('COS 404') || msg.includes('NoSuchKey')) return fallback
    if (msg.includes('Unexpected token') || msg.includes('JSON')) return fallback   // 半截对象/被覆写成空
    throw e
  }
}

/**
 * 投递一批到某个认证码。
 *
 * ★ 粒度：【一件内容 = 一条消息】，不是「一次发送 = 一条消息」。自动同步要的语义是
 *   「平台改了哪一份，手机上就更新哪一份」，所以幂等键必须挂在内容上（sync = 该件的 srcId /
 *   计划 id），而不是挂在这次发送的动作上。一次勾了 8 行就是 8 条消息，各自独立覆盖。
 * ★★ 但索引【只写一次】：8 条消息各做一次读改写索引会串行 8 个 RTT，且中途失败会留半截。
 *
 * @param {string} ch  小程序端的 12 位认证码
 * @param {object} o   { pid 本机ID, label 本机备注名, app 版本,
 *                       msgs: [{ sync 幂等键, name, payload 信封 }] }
 * @returns {Promise<{ok:true, sent:number, bytes:number, mids:string[]}>}
 */
async function boxSend(ch, o) {
  if (!configured()) throw new Error('发送到小程序未配置（缺少 COS 凭证：shareConfig.js 或 COS_SECRET_ID 等环境变量）')
  const C = normCh(ch)
  const pid = sanitizeId(o && o.pid)
  if (!pid) throw new Error('本机ID无效')
  const msgs = (o && Array.isArray(o.msgs) ? o.msgs : []).filter((m) => m && m.payload && typeof m.payload === 'object')
  if (!msgs.length) throw new Error('内容为空')

  const label = String((o && o.label) || '').slice(0, 40)
  const app = String((o && o.app) || '').slice(0, 20)
  const now = Date.now()

  // 1) roster 自检自愈（见本段 ★★）：不在里面、或备注名/版本变了，就写回
  const roster = await getJson(rosterKey(C), null) || { kind: BOX_ROSTER_KIND, v: 1, ch: C, platforms: [] }
  if (!Array.isArray(roster.platforms)) roster.platforms = []
  const at = roster.platforms.findIndex((p) => p && p.pid === pid)
  const mine = at >= 0 ? roster.platforms[at] : null
  if (!mine || mine.label !== label || mine.app !== app) {
    const next = { pid, label, app, firstAt: (mine && mine.firstAt) || now, lastAt: now }
    if (at >= 0) roster.platforms[at] = next; else roster.platforms.push(next)
    roster.ch = C; roster.updatedAt = now
    await request('PUT', encPath(assertWritable(rosterKey(C))), { body: JSON.stringify(roster) })
  }

  // 2) 先写全部消息件、再改索引。反过来会让小程序拉到一条索引里有、对象却 404 的幽灵消息；
  //    这个顺序下最坏情况只是留几个没人引用的孤儿对象（无害，且下次同 sync 重发会覆盖它们）。
  const rows = []
  let total = 0
  await Promise.all(msgs.map(async (m) => {
    const payload = m.payload
    const body = JSON.stringify(payload)
    const bytes = Buffer.byteLength(body, 'utf8')
    // 幂等键：调用方给（如 'GEO:cfg_a1b2:0'）。没给就退化为内容哈希 —— 内容一字不改地重发仍复用
    // 同一件，改一个字就是新的一件（旧件被弃在 COS 上，不再被索引引用）。
    const sync = String(m.sync || '') || ('sha:' + sha1(body).slice(0, 16))
    const mid = 'm' + sha1(`${pid}|${sync}`).slice(0, 15)
    await request('PUT', encPath(assertWritable(boxMsgKey(C, pid, mid))), { body })
    total += bytes
    rows.push({
      id: mid,
      sync,
      name: String(m.name || payload.name || '仿真平台数据').slice(0, 80),
      kind: String(payload.kind || ''),
      ts: now,
      expiresAt: Number(payload.expiresAt) || 0,
      bytes,
      // 清单用：小程序不下载消息件就能列出这一条里装了什么
      items: Array.isArray(payload.items)
        ? payload.items.map((it) => ({ type: String((it && it.type) || ''), name: String((it && it.name) || ''), mod: String((it && it.mod) || '') }))
        : []
    })
  }))

  // 3) 索引（单写者，读改写无竞态）
  const idx = await getJson(boxIdxKey(C, pid), null) || { kind: BOX_IDX_KIND, v: 1 }
  if (!Array.isArray(idx.msgs)) idx.msgs = []
  for (const row of rows) {
    const hit = idx.msgs.findIndex((m) => m && m.id === row.id)
    if (hit >= 0) idx.msgs[hit] = row; else idx.msgs.push(row)
  }
  idx.msgs.sort((a, b) => (a.ts || 0) - (b.ts || 0))
  if (idx.msgs.length > BOX_KEEP) idx.msgs = idx.msgs.slice(-BOX_KEEP)
  Object.assign(idx, { ch: C, pid, label, app, updatedAt: now })
  await request('PUT', encPath(assertWritable(boxIdxKey(C, pid))), { body: JSON.stringify(idx) })

  return { ok: true, sent: rows.length, bytes: total, mids: rows.map((r) => r.id) }
}

/** 平台回看自己往某个认证码投过什么（设置页的「已投递」列表）。roster 一并返回，供显示「还绑了谁」。 */
async function boxPeek(ch, pid) {
  if (!configured()) throw new Error('发送到小程序未配置（缺少 COS 凭证）')
  const C = normCh(ch)
  const p = sanitizeId(pid)
  const idx = await getJson(boxIdxKey(C, p), null)
  const roster = await getJson(rosterKey(C), null)
  return {
    ok: true,
    msgs: (idx && Array.isArray(idx.msgs) ? idx.msgs : []).slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)),
    platforms: roster && Array.isArray(roster.platforms) ? roster.platforms : []
  }
}

/** 撤回一件：从索引摘掉 + 把消息件覆写成空对象（没有 DeleteObject 权限，见本段 ★★★）。 */
async function boxRevoke(ch, pid, mid) {
  if (!configured()) throw new Error('发送到小程序未配置（缺少 COS 凭证）')
  const C = normCh(ch)
  const p = sanitizeId(pid)
  const m = String(mid || '').replace(/[^A-Za-z0-9]/g, '')
  if (!m) throw new Error('消息ID无效')
  const idx = await getJson(boxIdxKey(C, p), null)
  if (idx && Array.isArray(idx.msgs)) {
    idx.msgs = idx.msgs.filter((x) => x && x.id !== m)
    idx.updatedAt = Date.now()
    await request('PUT', encPath(assertWritable(boxIdxKey(C, p))), { body: JSON.stringify(idx) })
  }
  // 覆写要在摘索引之后：先覆写、后摘索引的话，中间那一瞬小程序会拉到一件空内容的消息。
  try { await request('PUT', encPath(assertWritable(boxMsgKey(C, p, m))), { body: '{}' }) }
  catch (e) { /* 覆写失败无妨：索引里已经没有它了，小程序不会再去拉 */ }
  return { ok: true }
}

// 通用 JSON 写：assertWritable 白名单内的对象 PUT（激活/设备管理复用，见 activation.js）
async function putJson(key, obj) {
  await request('PUT', encPath(assertWritable(key)), { body: JSON.stringify(obj) })
  return true
}

// 严格 JSON 读：只有【确凿的 404/NoSuchKey】返回 null，其余一切失败照抛。
// 与上面 getJson 的区别是不把「解析失败」吞成 fallback —— 酒店/企业门户网络会把任意 GET
// 劫持成 200 + HTML 登录页，宽松版会把它当「对象损坏」落成空值；对激活书（activation.js）
// 这等于把断网的已激活设备误清成未激活。激活书要的语义是「抛错 = 云端不可信 = 维持本地缓存」。
async function getJsonStrict(key) {
  try {
    return JSON.parse(await request('GET', encPath(key)))
  } catch (e) {
    const msg = String((e && e.message) || '')
    if (msg.includes('COS 404') || msg.includes('NoSuchKey')) return null
    throw e
  }
}

module.exports = () => ({ configured, send, inbox, remove, putSnapshot, boxSend, boxPeek, boxRevoke, normCh, CH_LEN, getJson, getJsonStrict, putJson, prefixOf, serverDate })
