// 通信层验证台（2026-10-16 通信审查修复轮）：netFetch / share.request / ommCloud 回传 / 星历与 F10.7 的云镜像落盘闸。
//
// 全程只连本机回环上的假 COS（node:http），三道闸保证碰不到真桶：
//   ① 拦掉真 electron/services/shareConfig.js —— 解析到它的 require 一律换成本文件里的假凭证（带 endpoint 指向回环）；
//   ② 清掉 COS_* / SATSIM_OMM_COS_* 环境变量（share.js 的开发兜底会读它们）；
//   ③ https.request / https.get 换成直接抛错，http.request 只放行 127.0.0.1。
// 裸 node 下没有 Electron net，netFetch 走 Node 路；net 路由 Electron 实机另验。
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import Module, { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
const require = createRequire(import.meta.url)

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { if (cond) { pass++; console.log('  ✓ ' + msg) } else { fail++; console.error('  ✗ ' + msg + (extra ? '  ← ' + extra : '')) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// 「一定落地」的判据：等不到就算挂起（不靠测试框架的总超时）
const settleWithin = (p, ms) => Promise.race([
  p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })),
  sleep(ms).then(() => ({ hung: true }))
])

// ---------------- 闸 ②③：环境变量与出网 ----------------
for (const k of ['COS_SECRET_ID', 'COS_SECRET_KEY', 'COS_BUCKET', 'COS_REGION', 'SATSIM_OMM_COS_ID', 'SATSIM_OMM_COS_KEY', 'SATSIM_OMM_COS_BUCKET', 'SATSIM_OMM_COS_REGION']) delete process.env[k]
delete process.env.SATSIM_SWPC_OFFLINE
const noNet = () => { throw new Error('单测不许出网（https）') }
https.request = noNet
https.get = noNet
const realHttpRequest = http.request
http.request = function (opts, ...rest) {
  const h = typeof opts === 'string' || opts instanceof URL ? new URL(opts).hostname : (opts.hostname || opts.host)
  if (h !== '127.0.0.1') throw new Error('单测只许连本机回环：' + h)
  return realHttpRequest.call(this, opts, ...rest)
}

// ---------------- 假 COS ----------------
const store = new Map()          // key → { body:Buffer, lm:ms, type }
const seen = []                  // 每个请求一条：{ method, key, signStart, signEnd }
const behave = new Map()         // key → (req, res, rec, cos, nth) => boolean（true = 已处理）
let serverSkewMs = 0             // 假 COS 的钟比本机快多少
const sockets = new Set()
const nth = (key) => seen.filter((r) => r.key === key).length
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  const key = decodeURIComponent(u.pathname.replace(/^\//, ''))
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const auth = String(req.headers.authorization || '')
    const m = /q-sign-time=(\d+);(\d+)/.exec(auth)
    const rec = { method: req.method, key, signStart: m ? Number(m[1]) * 1000 : 0, signEnd: m ? Number(m[2]) * 1000 : 0, body: Buffer.concat(chunks), headers: req.headers }
    seen.push(rec)
    const nowS = Date.now() + serverSkewMs
    const cos = { 'x-cos-request-id': 'TEST' + seen.length, server: 'tencent-cos', date: new Date(nowS).toUTCString() }
    const fn = behave.get(key)
    if (fn && fn(req, res, rec, cos, nth(key))) return
    const xmlErr = (status, code, msg) => {
      const body = `<?xml version='1.0' encoding='utf-8' ?><Error><Code>${code}</Code><Message>${msg}</Message></Error>`
      res.writeHead(status, { ...cos, 'content-type': 'application/xml', 'content-length': Buffer.byteLength(body) })
      res.end(req.method === 'HEAD' ? undefined : body)
    }
    // 签名时间窗：与 COS 同一判法（窗口整个在服务器时间之前 = 过期；起点在服务器时间之后 = 时钟偏差过大）
    if (m) {
      if (nowS > rec.signEnd + 1000) return xmlErr(403, 'AccessDenied', 'Request has expired')
      if (nowS < rec.signStart - 1000) return xmlErr(403, 'RequestTimeTooSkewed', 'The difference between the request time and the server\'s time is too large.')
    }
    if (req.method === 'PUT') {
      store.set(key, { body: rec.body, lm: nowS, type: String(req.headers['content-type'] || '') })
      res.writeHead(200, { ...cos, etag: '"x"', 'content-length': 0 })
      return res.end()
    }
    const o = store.get(key)
    if (!o) return xmlErr(404, 'NoSuchKey', 'The specified key does not exist.')
    res.writeHead(200, { ...cos, 'content-type': o.type || 'application/octet-stream', 'content-length': o.body.length, 'last-modified': new Date(o.lm).toUTCString() })
    res.end(req.method === 'HEAD' ? undefined : o.body)
  })
})
server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`

// ---------------- 闸 ①：假凭证顶替真 shareConfig.js ----------------
const FAKE_CFG = path.join(os.tmpdir(), `satsim-fake-shareConfig-${process.pid}.js`)
const fakeCfg = { secretId: 'AKIDtestonly', secretKey: 'test-secret-not-real', bucket: 'test-0000000000', region: 'ap-test', prefix: 'share', endpoint: BASE }
require.cache[FAKE_CFG] = { id: FAKE_CFG, filename: FAKE_CFG, loaded: true, exports: fakeCfg, children: [], paths: [] }
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (/(^|[\\/])shareConfig(\.js)?$/.test(String(request))) return FAKE_CFG
  return origResolve.call(this, request, ...rest)
}

const netFetch = require(path.join(ROOT, 'electron/services/netFetch.js'))
const share = require(path.join(ROOT, 'electron/services/share.js'))()
const ommCloud = require(path.join(ROOT, 'electron/services/ommCloud.js'))
ok(share.configured(), '前置：share.js 拿到的是假凭证（endpoint 指向本机回环）')

// ======================= ① netFetch：一定落地 =======================
console.log('netFetch（Node 路）')
{
  // 正文半截断开：响应头已到、Content-Length 5000、只给 100 字节就掐连接
  behave.set('nf/trunc', (req, res) => { res.writeHead(200, { 'content-length': 5000 }); res.write(Buffer.alloc(100, 65)); setTimeout(() => res.socket.destroy(), 30); return true })
  let r = await settleWithin(netFetch.request(`${BASE}/nf/trunc`, { idleMs: 5000 }), 3000)
  ok(!r.hung && !r.ok && r.e.kind === 'cut' && r.e.transient === true && r.e.status === 200, '正文半截断开 → 立刻落地为 cut（带 status、可重试）', JSON.stringify(r.e && { kind: r.e.kind, st: r.e.status, msg: r.e.message }))

  // 响应头之后不再有字节：按无进展超时落地（phase=body）
  behave.set('nf/stall-body', (req, res) => { res.writeHead(200, { 'content-length': 5000 }); res.write('x'); return true })
  r = await settleWithin(netFetch.request(`${BASE}/nf/stall-body`, { idleMs: 300 }), 3000)
  ok(!r.hung && !r.ok && r.e.kind === 'timeout' && r.e.phase === 'body', '正文停滞 300 ms → timeout(body)', JSON.stringify(r.e && { kind: r.e.kind, phase: r.e.phase }))

  // 黑洞：连响应头都不给
  behave.set('nf/stall-head', () => true)
  r = await settleWithin(netFetch.request(`${BASE}/nf/stall-head`, { idleMs: 300 }), 3000)
  ok(!r.hung && !r.ok && r.e.kind === 'timeout' && r.e.phase === 'connect' && !r.e.transient, '无响应 300 ms → timeout(connect)，不算瞬断')

  // 慢滴：一直有进展但总时长超限
  behave.set('nf/drip', (req, res) => { res.writeHead(200); const t = setInterval(() => { try { res.write('.') } catch { clearInterval(t) } }, 50); res.on('close', () => clearInterval(t)); return true })
  r = await settleWithin(netFetch.request(`${BASE}/nf/drip`, { idleMs: 300, maxMs: 700 }), 3000)
  ok(!r.hung && !r.ok && r.e.kind === 'timeout' && r.e.phase === 'total', '慢滴（每 50 ms 一字节）→ 总时限 700 ms 落地')

  // 有进展就不算超时：每 100 ms 一块、共 1 s，idle 300 ms 也能收完
  behave.set('nf/slow-ok', (req, res) => { res.writeHead(200); let n = 0; const t = setInterval(() => { res.write('ab'); if (++n === 10) { clearInterval(t); res.end() } }, 100); return true })
  r = await settleWithin(netFetch.request(`${BASE}/nf/slow-ok`, { idleMs: 300 }), 4000)
  ok(r.ok && r.v.body.toString() === 'ab'.repeat(10), '慢链路持续有进展（1 s，idle 300 ms）→ 完整收下')

  behave.set('nf/big', (req, res) => { res.writeHead(200); res.end(Buffer.alloc(10240, 66)); return true })
  r = await settleWithin(netFetch.request(`${BASE}/nf/big`, { maxBytes: 1024 }), 3000)
  ok(!r.ok && r.e.kind === 'size', '正文超上限 → size')

  behave.set('nf/redir', (req, res) => { res.writeHead(302, { location: 'http://portal.example/login' }); res.end(); return true })
  r = await settleWithin(netFetch.request(`${BASE}/nf/redir`, { redirect: 'error' }), 3000)
  ok(!r.ok && r.e.kind === 'redirect', "redirect:'error' 下被 302 → redirect（门户 / 网关拦截）")

  r = await settleWithin(netFetch.request(`${BASE}/nf/never-registered`), 3000)
  ok(r.ok && r.v.status === 404 && r.v.via === 'node' && /no-cache/.test(String(seen[seen.length - 1].headers['cache-control'])), '缺省带 Cache-Control: no-cache；裸 node 走 Node 路')

  r = await settleWithin(netFetch.request('https://example.com/x'), 2000)
  ok(!r.ok && r.e.kind === 'net', '（自检）https 出网被单测闸挡住，落成 net 错误而不是挂起')
}

// ======================= ② share.request =======================
console.log('share.request')
{
  // 正文半截断连：两次都截断 → 重发一次后如实失败，绝不挂起
  behave.set('share/trunc/inbox.json', (req, res) => { res.writeHead(200, { 'content-length': 5000 }); res.write('[{"id":"'); setTimeout(() => res.socket.destroy(), 30); return true })
  let r = await settleWithin(share.inbox('trunc'), 5000)
  ok(!r.hung, '★ 正文半截断连：promise 落地（原实现在这里永久挂起）')
  ok(!r.ok && r.e.kind === 'cut' && /连接中断/.test(r.e.message), '★ 落地为「连接中断（正文未收完）」', r.e && r.e.message)
  ok(nth('share/trunc/inbox.json') === 2, '截断算瞬断：隔 0.8 s 重发一次', String(nth('share/trunc/inbox.json')))

  // 第一次连接被重置、第二次正常：瞬断重发后成功
  behave.set('share/reset/inbox.json', (req, res, rec, cos, n) => { if (n === 1) { req.socket.destroy(); return true } return false })
  r = await settleWithin(share.inbox('reset'), 5000)
  ok(r.ok && Array.isArray(r.v.items) && r.v.items.length === 0, '连接被重置一次 → 重发后正常（对象不存在 → 空信箱）')

  behave.set('share/busy/inbox.json', (req, res, rec, cos, n) => {
    if (n > 1) return false
    const b = '<Error><Code>SlowDown</Code><Message>busy</Message></Error>'
    res.writeHead(503, { ...cos, 'content-length': Buffer.byteLength(b) }); res.end(b); return true
  })
  r = await settleWithin(share.inbox('busy'), 5000)
  ok(r.ok && nth('share/busy/inbox.json') === 2, '5xx 重发一次')

  // ★ 403 时钟偏差：假 COS 比本机快 2 h（= 本机钟慢 2 h）→ 签名窗口整个过期 → 按 Date 头重签重发
  serverSkewMs = 2 * 3600e3
  store.set('share/skew/inbox.json', { body: Buffer.from('[{"id":"m1","from":"x","name":"n","ts":1}]'), lm: Date.now(), type: 'application/json' })
  r = await settleWithin(share.inbox('skew'), 5000)
  const sk = seen.filter((x) => x.key === 'share/skew/inbox.json')
  ok(r.ok && r.v.items.length === 1, '★ 403 AccessDenied「Request has expired」→ 按服务器时间重签后取到', JSON.stringify(r.e && r.e.message))
  ok(sk.length === 2 && Math.abs(sk[1].signStart + 60e3 - (Date.now() + serverSkewMs)) < 5000, '★ 第二次的 q-sign-time 起点 ≈ 服务器时间 − 60 s')
  ok(Math.abs(share.clockOffset() - serverSkewMs) < 3000, `偏移记在进程内（${Math.round(share.clockOffset() / 1000)} s）`)
  const before = seen.length
  r = await settleWithin(share.inbox('skew'), 5000)
  ok(r.ok && seen.length === before + 1, '之后的请求直接按纠偏后的时间签，不再先吃一次 403')
  ok(Math.abs(share.serverNow() - (Date.now() + serverSkewMs)) < 3000, 'serverNow 跟着 COS 的 Date 头走（激活模块的时钟参照）')

  // 反方向：假 COS 比本机慢 2 h（本机钟快）→ 签名起点在服务器时间之后 → RequestTimeTooSkewed
  serverSkewMs = -2 * 3600e3
  r = await settleWithin(share.inbox('skew'), 5000)
  ok(r.ok && Math.abs(share.clockOffset() - serverSkewMs) < 3000, '★ 403 RequestTimeTooSkewed 同样纠偏重签')
  serverSkewMs = 0
  r = await settleWithin(share.inbox('skew'), 5000)
  ok(r.ok && Math.abs(share.clockOffset()) < 3000, '钟回正后再撞一次 403 → 偏移回零')

  // 本机钟其实没偏（差 < 30 s）的 403：不重签（重签也没用），原样报
  behave.set('share/denied/inbox.json', (req, res, rec, cos) => {
    const b = '<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>'
    res.writeHead(403, { ...cos, 'content-length': Buffer.byteLength(b) }); res.end(b); return true
  })
  r = await settleWithin(share.inbox('denied'), 5000)
  ok(!r.ok && r.e.status === 403 && r.e.cosCode === 'AccessDenied' && nth('share/denied/inbox.json') === 1, '钟没偏的 403：不重签、不重发，带 status / cosCode 报出')

  // ★ 网关代答：伪造的 404 不能被当成「对象不存在」
  behave.set('share/fake404/inbox.json', (req, res) => { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<html><body>Blocked by policy</body></html>'); return true })
  r = await settleWithin(share.inbox('fake404'), 5000)
  ok(!r.ok && r.e.kind === 'intercept', '★ 网关回的 404 网页 → 判为拦截，不当空信箱（否则下一步 PUT 会整份覆盖对方信箱）')
  behave.set('share/plain404/inbox.json', (req, res) => { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not Found'); return true })
  r = await settleWithin(share.inbox('plain404'), 5000)
  ok(!r.ok && r.e.status === 404 && r.e.cosCode === '', '非 COS 的纯文本 404 也不算「对象不存在」')
  r = await settleWithin(share.getJsonStrict('share/mgr/lic/NOPE.json'), 5000)
  ok(r.ok && r.v === null, 'COS 自己回的 NoSuchKey → getJsonStrict 返回 null（激活书确实没有）')
  behave.set('share/mgr/lic/FAKE.json', (req, res) => { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<!DOCTYPE html><html>deny</html>'); return true })
  r = await settleWithin(share.getJsonStrict('share/mgr/lic/FAKE.json'), 5000)
  ok(!r.ok, '★ 网关伪造的 404 → getJsonStrict 抛错（激活模块据此维持本地授权，不清缓存）')

  // ★ 门户劫持成 200 + 网页：读写都不算成功
  behave.set('share/portal/inbox.json', (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><title>WiFi 登录</title></html>'); return true })
  const putsBefore = seen.filter((x) => x.method === 'PUT').length
  r = await settleWithin(share.send('portal', { from: 'T', name: 'cfg' }), 5000)
  ok(!r.ok && r.e.kind === 'intercept' && seen.filter((x) => x.method === 'PUT').length === putsBefore, '★ 门户 200 网页：读信箱即失败、没有发出 PUT')
  behave.set('share/portal2/inbox.json', (req, res) => {
    if (req.method === 'GET') return false
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<html>blocked</html>'); return true
  })
  r = await settleWithin(share.send('portal2', { from: 'T', name: 'cfg' }), 5000)
  ok(!r.ok && r.e.kind === 'intercept', '★ PUT 被网关回 200 网页 → 不报成功')

  // 正常收发（假 COS 往返）
  r = await settleWithin(share.send('alice', { from: 'T', name: '配置 A' }), 5000)
  const box = JSON.parse(store.get('share/alice/inbox.json').body.toString())
  ok(r.ok && box.length === 1 && box[0].name === '配置 A', '正常发送：PUT 落到假 COS')
  const putRec = seen.filter((x) => x.method === 'PUT' && x.key === 'share/alice/inbox.json').pop()
  ok(putRec && !putRec.headers['cache-control'] && putRec.headers['content-type'] === 'application/json', 'PUT 不带 Cache-Control（COS 会把它存成对象元数据）')
}

// ======================= ③ boxSend：单批上限与如实计数 =======================
console.log('boxSend')
{
  const CH = 'ABCDEFGHJKMN', PID = 'TESTPID'
  const mk = (i) => ({ sync: 'cfg:' + i, name: '件' + i, payload: { kind: 'satsim-pack', v: 1, name: '件' + i, items: [{ type: 'lb-config', name: '件' + i }] } })
  const n0 = seen.length
  let r = await settleWithin(share.boxSend(CH, { pid: PID, label: 'L', app: 'T', msgs: Array.from({ length: 61 }, (_, i) => mk(i)) }), 5000)
  ok(!r.ok && /单批最多 60 件/.test(r.e.message) && seen.length === n0, '单批 61 件 → 直接拒收，一个请求都不发')

  // 索引里已有 58 件更早的 → 本批 5 件：如实报 sent=5、evicted=3
  const old = Array.from({ length: 58 }, (_, i) => ({ id: 'mold' + i, sync: 'old:' + i, name: 'o' + i, kind: 'satsim-pack', ts: 1000 + i, expiresAt: 0, bytes: 1, items: [] }))
  store.set(`updates/gxt/box/${CH}/${PID}/index.json`, { body: Buffer.from(JSON.stringify({ kind: 'satsim-boxidx', v: 1, msgs: old })), lm: Date.now(), type: 'application/json' })
  r = await settleWithin(share.boxSend(CH, { pid: PID, label: 'L', app: 'T', msgs: [0, 1, 2, 3, 4].map(mk) }), 5000)
  const idx = JSON.parse(store.get(`updates/gxt/box/${CH}/${PID}/index.json`).body.toString())
  ok(r.ok && r.v.sent === 5 && r.v.evicted === 3, `已满的索引：sent=5、evicted=3（实得 sent=${r.v && r.v.sent}、evicted=${r.v && r.v.evicted}）`)
  ok(idx.msgs.length === 60 && !idx.msgs.some((m) => m.id === 'mold0' || m.id === 'mold2') && idx.msgs.some((m) => m.id === 'mold3'), '索引保留 60 件：摘掉的正是最早的 3 件')
}

// ======================= ④ ommCloud 回传：时钟纠偏 =======================
console.log('ommCloud')
{
  serverSkewMs = 2 * 3600e3
  const csv = 'OBJECT_NAME,MEAN_MOTION\nX,1.0\n'
  const okUp = await settleWithin(ommCloud.maybeUpload('geo', csv, 'GEO'), 8000)
  const puts = seen.filter((x) => x.method === 'PUT' && x.key === 'omm/csv_geo.csv.gz')
  ok(okUp.ok && okUp.v === true, '★ 回传撞 403（本机钟慢 2 h）→ 重签后成功', JSON.stringify(okUp))
  ok(puts.length === 2 && Math.abs(puts[1].signStart + 60e3 - (Date.now() + serverSkewMs)) < 5000, '回传第二次按服务器时间签名')
  const o = store.get('omm/csv_geo.csv.gz')
  ok(o && zlib.gunzipSync(o.body).toString() === csv && o.type === 'application/gzip', '桶里落的是 gzip 原件（PUT 体整块、长度由栈算）')
  serverSkewMs = 0
  // 下载走 no-cache：HEAD / GET 都带 Cache-Control: no-cache
  const d = await settleWithin(ommCloud.download('geo', { label: 'GEO' }), 5000)
  const lastGets = seen.filter((x) => x.key === 'omm/csv_geo.csv.gz' && x.method !== 'PUT').slice(-2)
  ok(d.ok && d.v && d.v.text === csv, '云镜像下载回来与上传一致')
  ok(lastGets.length === 2 && lastGets.every((x) => /no-cache/.test(String(x.headers['cache-control']))), 'HEAD 与 GET 都带 Cache-Control: no-cache')
}

// ======================= ⑤ 星历强刷：云镜像不新于本地就不落盘 =======================
console.log('omm.js 强制刷新与云镜像')
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'commnet-omm-'))
  process.env.SATSIM_DATA_DIR = TMP
  process.env.SATSIM_OMM_BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'commnet-bundle-'))   // 空：只有用户缓存
  const createOmm = require(path.join(ROOT, 'electron/services/omm.js'))
  const omm = createOmm(() => ({}))
  const HEAD = 'OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY\n'
  const cf = path.join(TMP, 'omm', 'csv_geo.csv')
  fs.mkdirSync(path.dirname(cf), { recursive: true })
  fs.writeFileSync(cf, HEAD + 'LOCAL-0,2020-001A,2026-10-16T00:00:00,1.0027,0.0001\n')
  const tLocal = new Date(Date.now() - 3600e3)
  fs.utimesSync(cf, tLocal, tLocal)
  // 云上那份是三天前的
  store.set('omm/csv_geo.csv.gz', { body: zlib.gzipSync(HEAD + 'CLOUD-0,2020-001A,2026-10-13T00:00:00,1.0027,0.0001\n'), lm: Date.now() - 3 * 86400e3, type: 'application/gzip' })
  let r = await settleWithin(omm.fetchCsv('geo', { force: true }), 15000)
  ok(r.ok && r.v.source === 'cache' && /LOCAL-0/.test(r.v.text), '★ 强刷：直连不通、云镜像比本地旧 → 保留本地，不拿旧的盖新的', JSON.stringify(r.v && r.v.source))
  ok(/LOCAL-0/.test(fs.readFileSync(cf, 'utf8')) && Math.abs(fs.statSync(cf).mtimeMs - tLocal.getTime()) < 2000, '★ 本地缓存的正文与 mtime 都没被动')
  // 云上那份更新 → 照常换
  store.set('omm/csv_geo.csv.gz', { body: zlib.gzipSync(HEAD + 'CLOUD-1,2020-001A,2026-10-16T00:00:00,1.0027,0.0001\n'), lm: Date.now() - 60e3, type: 'application/gzip' })
  r = await settleWithin(omm.fetchCsv('geo', { force: true }), 15000)
  ok(r.ok && r.v.source === 'cloud' && /CLOUD-1/.test(fs.readFileSync(cf, 'utf8')), '云镜像确实更新 → 强刷照常换成云上那份')
}

// ======================= ⑥ F10.7：正文先过解析才算直连成功 =======================
console.log('solarFlux.js')
{
  const FIX = path.join(HERE, 'fixtures/swpc')
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'commnet-swpc-'))
  process.env.SATSIM_DATA_DIR = TMP
  process.env.SATSIM_SWPC_BUNDLE_DIR = FIX
  const svc = require(path.join(ROOT, 'electron/services/solarFlux.js'))
  const FILES = { daily30: '10cm-flux-30-day.json', forecast45: '45-day-forecast.txt', monthly: 'observed-solar-cycle-indices.json', predicted: 'predicted-solar-cycle.json' }
  const mode = { daily30: 'html', forecast45: 'html', monthly: 'html', predicted: 'html' }
  for (const k of Object.keys(FILES)) {
    svc.SOURCES[k].url = `${BASE}/swpc/${k}`
    behave.set('swpc/' + k, (req, res) => {
      if (mode[k] === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head><title>Portal</title></head><body>login</body></html>') }
      else { res.writeHead(200); res.end(fs.readFileSync(path.join(FIX, FILES[k]))) }
      return true
    })
  }
  const outFile = path.join(TMP, 'space-weather', 'solar-flux.json')
  const swPuts = () => seen.filter((x) => x.method === 'PUT' && x.key === 'omm/csv_solarflux.csv.gz').length
  svc._reset()
  const bundledAt = svc.snapshot().fetchedAt
  let r = await settleWithin(svc.refresh({ force: true }), 15000)
  ok(r.ok && r.v.ok === false && r.v.source === 'bundled', '★ 四个产品都回 200 + 网页 → 不算直连成功，继续用内置快照', JSON.stringify(r.v))
  ok(!fs.existsSync(outFile) && swPuts() === 0, '★ 不落盘、不回传云镜像')

  // 云上有一份比本机旧的 → 强刷不拿它盖本机
  const old = JSON.parse(fs.readFileSync(path.join(FIX, 'solar-flux.json'), 'utf8'))
  old.fetchedAt = new Date(Date.parse(bundledAt) - 30 * 86400e3).toISOString()
  store.set('omm/csv_solarflux.csv.gz', { body: zlib.gzipSync(JSON.stringify(old)), lm: Date.parse(old.fetchedAt), type: 'application/gzip' })
  r = await settleWithin(svc.refresh({ force: true }), 15000)
  ok(r.ok && r.v.source === 'bundled' && svc.status().fetchedAt === bundledAt && !fs.existsSync(outFile), '★ 强刷：云镜像比本机旧 → 保留本机，不落盘', JSON.stringify(r.v))

  // 两个产品正常、两个是网页 → 只认解得出条目的两份，照常落盘并回传
  mode.daily30 = 'ok'; mode.monthly = 'ok'
  r = await settleWithin(svc.refresh({ force: true }), 15000)
  ok(r.ok && r.v.ok === true && r.v.source === 'network' && fs.existsSync(outFile), '有产品解得出条目 → 直连成功、落盘')
  const saved = JSON.parse(fs.readFileSync(outFile, 'utf8'))
  const P = saved.products
  ok(P.daily30.at === saved.fetchedAt && P.monthly.at === saved.fetchedAt &&
     (!P.predicted || P.predicted.at !== saved.fetchedAt) && (!P.forecast45 || P.forecast45.at !== saved.fetchedAt),
  '只有真取到的产品带本轮时刻；网页那两份沿用旧数据（或本来就没有）')
  // 回传不 await：等桶里那份变成本轮数据（上一段把回传的时钟偏移留在 +2 h，这里会先吃一次 403 再重签，PUT 计数是 2）
  const cloudAt = () => { const o = store.get('omm/csv_solarflux.csv.gz'); try { return JSON.parse(zlib.gunzipSync(o.body)).fetchedAt } catch { return null } }
  for (let i = 0; i < 60 && cloudAt() !== saved.fetchedAt; i++) await sleep(50)
  ok(cloudAt() === saved.fetchedAt && swPuts() >= 1, '有效数据才回传云镜像（桶里那份即本轮合并结果）')
}

// ---------------- 收尾 ----------------
for (const s of sockets) s.destroy()
server.close()
http.request = realHttpRequest
Module._resolveFilename = origResolve
delete require.cache[FAKE_CFG]
console.log(`\n${fail ? '✗' : '✓'} 通过 ${pass}，失败 ${fail}`)
process.exit(fail ? 1 : 0)
