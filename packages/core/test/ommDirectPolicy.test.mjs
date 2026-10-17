// CelesTrak 直连纪律验证台（2026-10-17）：omm.js 的「非 200 立即停 / 未更新 403 / 连接层退避重试 /
// 全局非 200 计数闸 / 并发闸」，以及 solarFlux.js（SWPC）同口径收紧。
//
// 政策原文（celestrak.org usage-policy.php 2026-05-22 版、NORAD/documentation/gp-data-formats.php）：
// 收到任何非 200 立即停止；2026-03-26 起每个更新周期只给一次，同周期重复请求回 403
// 「GP data has not updated since your last successful download of GROUP=…」；HTTP 错误（301 / 403 / 404）
// 2 h 满 50 次，出口 IP 进防火墙 —— 同一单位出口下所有同事共用这一个额度。改前一轮 17 组 + SATCAT
// 最多约 90 个 403（主端点 3 次 + sup-gp 2 次，且 403 照样复位熔断），几位同事各开一次软件就能把整个出口封掉。
//
// 网络全打桩，不碰真站点：netFetch.request 换成按 URL 脚本化的应答（记账 + 量并发），
// ommCloud.download / maybeUpload 换成桩，https / http 出网一律抛错（双保险）。
// 退避走全局 setTimeout：≥ 500 ms 的计时记下时长后立即放行（本进程里只有退避用得到这么长的计时）。
import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'
import os from 'os'
import http from 'http'
import https from 'https'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
const OMM_PATH = path.join(ROOT, 'electron/services/omm.js')

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { if (cond) { pass++; console.log('  ✓ ' + msg) } else { fail++; console.error('  ✗ ' + msg + (extra !== undefined ? '  ← ' + extra : '')) } }
const eq = (a, b, msg) => ok(a === b, msg, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`)

// ---------------- 双保险：真出网一律抛错 ----------------
const noNet = () => { throw new Error('单测不许出网') }
const realNet = { hr: https.request, hg: https.get, r: http.request, g: http.get }
https.request = noNet; https.get = noNet; http.request = noNet; http.get = noNet

// ---------------- 退避计时：记下时长、立即放行 ----------------
const realSetTimeout = globalThis.setTimeout
const sleeps = []
globalThis.setTimeout = (fn, ms, ...a) => {
  if (ms >= 500) { sleeps.push(ms); return realSetTimeout(fn, 0, ...a) }
  return realSetTimeout(fn, ms, ...a)
}

// ---------------- 桩：netFetch / ommCloud / ommLog（omm.js 都是按模块对象取属性调用，换属性即生效）----------------
const netFetch = require(path.join(ROOT, 'electron/services/netFetch.js'))
const ommCloud = require(path.join(ROOT, 'electron/services/ommCloud.js'))
const ommLog = require(path.join(ROOT, 'electron/services/ommLog.js'))

const calls = []                       // 每次直连一条 URL
let answer = () => ({ status: 200, body: '' })
let inFlight = 0, maxInFlight = 0
netFetch.request = async (url) => {
  const u = String(url)
  if (!/^https:\/\/(celestrak\.org|services\.swpc\.noaa\.gov)\//.test(u)) throw new Error('桩外地址：' + u)
  calls.push(u)
  inFlight++
  if (inFlight > maxInFlight) maxInFlight = inFlight
  try {
    await new Promise((r) => realSetTimeout(r, 3))   // 让并发请求真的叠在一起
    const a = answer(u)
    if (a.error) throw Object.assign(new Error(a.error.message), a.error)
    return { status: a.status, headers: {}, body: Buffer.from(a.body || '', 'utf8'), via: 'node' }
  } finally { inFlight-- }
}
const cloudCalls = [], uploads = []
let cloudAnswer = () => null
ommCloud.download = async (key, opts) => { cloudCalls.push({ key, opts }); return cloudAnswer(key, opts) }
ommCloud.maybeUpload = async (key) => { uploads.push(key); return false }
const logs = []
ommLog.emit = (text, level = 'info') => { logs.push({ text, level }); if (process.env.DEBUG_OMM) console.log(`    [${level}] ${text}`) }

function reset(fn) {
  calls.length = 0; sleeps.length = 0; logs.length = 0; cloudCalls.length = 0; uploads.length = 0
  inFlight = 0; maxInFlight = 0
  answer = fn
  cloudAnswer = () => null
}
const gpCalls = () => calls.filter((u) => u.includes('/gp.php?')).length
const supCalls = () => calls.filter((u) => u.includes('/sup-gp.php?')).length
const queryOf = (u) => (/[?&]((?:GROUP|NAME|FILE)=[^&]+)/.exec(u) || [])[1] || u

// 应答
const R = {
  ok: (text) => ({ status: 200, body: text }),
  status: (s, body = '') => ({ status: s, body }),
  // 仓库根 starlink.csv 那份实样的格式（正文中间带换行）
  notUpdated: (q) => ({ status: 403, body: `GP data has not updated since your last successful\ndownload of ${q} at 2026-10-16 23:13:22 UTC.\nData is updated once every 2 hours.\n` }),
  timeout: () => ({ error: { kind: 'timeout', message: '30 s 无进展', phase: 'connect', transient: false } }),
  reset: () => ({ error: { kind: 'net', message: '连接失败（ECONNRESET）', code: 'ECONNRESET', transient: true } })
}

// ---------------- 夹具 ----------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ommpolicy-'))
const mkdir = (p) => { fs.mkdirSync(p, { recursive: true }); return p }
const EMPTY_BUNDLE = mkdir(path.join(TMP, 'empty-bundle'))
const CSV_HEAD = 'OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,CLASSIFICATION_TYPE,NORAD_CAT_ID,ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT'
const csvOf = (tag, n = 2) => {
  const rows = []
  for (let i = 0; i < n; i++) rows.push(`${tag}-${i},2020-00${i + 1}A,2026-10-16T00:00:00,1.0027,0.0001,0.05,90,90,0,0,U,${40000 + i},999,100,0,0,0`)
  return CSV_HEAD + '\n' + rows.join('\n') + '\n'
}
const SC_HEAD = 'OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER,LAUNCH_DATE,LAUNCH_SITE,DECAY_DATE,PERIOD,INCLINATION,APOGEE,PERIGEE,RCS,DATA_STATUS_CODE,ORBIT_CENTER,ORBIT_TYPE'
const scOf = (n) => {
  const rows = []
  for (let i = 0; i < n; i++) rows.push(`OBJECT ${i},2026-${String(100 + (i % 800)).padStart(3, '0')}A,${40000 + i},PAY,+,PRC,2026-09-13,TYMSC,,96.19,65.10,938,214,20.4200,,EA,ORB`)
  return SC_HEAD + '\n' + rows.join('\n') + '\n'
}
// 三天前（取整秒，mtime 往返不丢精度）：不吃「当日缓存」那道闸
const OLD = Math.floor((Date.now() - 3 * 86400e3) / 1000) * 1000
function writeCache(dataDir, key, text, t = OLD) {
  const f = path.join(mkdir(path.join(dataDir, 'omm')), `csv_${key}.csv`)
  fs.writeFileSync(f, text)
  fs.utimesSync(f, new Date(t), new Date(t))
  return f
}
const attempts = (dataDir) => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'omm', 'celestrak-attempt.json'), 'utf8')) } catch { return {} } }
// 每个场景一个新实例 + 一份干净的数据目录（熔断 / 计数闸 / 并发闸都是实例内的运行态）
let seq = 0
function makeOmm() {
  const dataDir = mkdir(path.join(TMP, 'data-' + (++seq)))
  process.env.SATSIM_DATA_DIR = dataDir
  process.env.SATSIM_OMM_BUNDLE_DIR = EMPTY_BUNDLE
  delete require.cache[require.resolve(OMM_PATH)]
  return { omm: require(OMM_PATH)(() => ({})), dataDir }
}
const GP_KEYS = ['starlink', 'oneweb', 'kuiper', 'gps', 'beidou', 'galileo', 'qianfan', 'guowang', 'geo', 'glonass', 'o3b', 'iridium', 'globalstar', 'stations', 'planet', 'spire']

// ===================== ① 有 HTTP 响应的非 200：该组恰 1 次请求，不转 sup-gp =====================
console.log('① 非 200 → 该组只发 1 次、不转补充端点')
{
  const { omm, dataDir } = makeOmm()
  writeCache(dataDir, 'starlink', csvOf('CACHED-SL'))
  reset((u) => (u.includes('/sup-gp.php') ? R.ok(csvOf('SUP-SL')) : R.status(404, 'Not Found')))
  const r = await omm.fetchCsv('starlink')
  eq(gpCalls(), 1, '404：主端点恰 1 次')
  eq(supCalls(), 0, '404：不转补充端点（sup-gp 那边明明有数据也不去要）')
  eq(sleeps.length, 0, '404：不退避、不重试')
  eq(r && r.source, 'cache', '404：转云镜像未果 → 回落本地缓存，source=cache')
  eq(cloudCalls.length, 1, '404：照常转查云镜像')
  ok(!!attempts(dataDir).starlink, '404：本组记账为今天已试过直连')
  ok(logs.some((l) => l.level === 'warn' && l.text.includes('主端点返回 HTTP 404 · Not Found，停止该组直连')), '404：日志写明状态码与正文首行')
  // 单个 404 只记一次数，不封全站：别的组照常直连
  reset(() => R.ok(csvOf('NET-OW')))
  const r2 = await omm.fetchCsv('oneweb')
  eq(calls.length, 1, '下一组照常直连（单个 404 不封全站）')
  eq(r2 && r2.source, 'network', '下一组直连成功，source=network')
}
// 站点级拒绝（非「未更新」的 403）：一次即封本次运行，且把 CelesTrak 写明的原因交给人看
{
  const { omm, dataDir } = makeOmm()
  writeCache(dataDir, 'starlink', csvOf('CACHED-SL'))
  writeCache(dataDir, 'oneweb', csvOf('CACHED-OW'))
  reset(() => R.status(403, 'Access denied: excessive requests from 203.0.113.7\nSee https://celestrak.org/usage-policy.php\n'))
  const r = await omm.fetchCsv('starlink')
  eq(gpCalls(), 1, '403（拒绝）：主端点恰 1 次')
  eq(supCalls(), 0, '403（拒绝）：不转补充端点')
  eq(r && r.source, 'cache', '403（拒绝）：回落本地缓存')
  ok(logs.some((l) => l.level === 'warn' && l.text.includes('返回 HTTP 403 · Access denied: excessive requests from 203.0.113.7') && l.text.includes('本次运行停止直连')),
    '403（拒绝）：一次即停本次运行全部直连，日志带上拒绝原因')
  const a = attempts(dataDir)
  ok(['starlink', 'geo', 'active', 'satcat'].every((k) => a[k]), '封站时全部分组 + SATCAT 一并记账今天已试过')
  reset(() => R.ok(csvOf('NET-OW')))
  const r2 = await omm.fetchCsv('oneweb', { force: true })
  eq(calls.length, 0, '封站后别的组（强刷也算）不再直连')
  eq(r2 && r2.source, 'cache', '封站后别的组回落本地缓存')
}
// 5xx：「Queries need to stop immediately to allow system recovery」—— 一次即封；网页正文不摘
{
  const { omm, dataDir } = makeOmm()
  writeCache(dataDir, 'gps', csvOf('CACHED-GPS'))
  writeCache(dataDir, 'geo', csvOf('CACHED-GEO'))
  reset(() => R.status(503, '<html><body>Service Unavailable</body></html>'))
  await omm.fetchCsv('gps')
  eq(calls.length, 1, '503：恰 1 次（gps 有补充端点也不转）')
  ok(logs.some((l) => /CelesTrak 返回 HTTP 503 —— 本次运行停止直连/.test(l.text)), '503：一次即封本次运行（网页正文不进日志）')
  reset(() => R.ok(csvOf('NET-GEO')))
  await omm.fetchCsv('geo')
  eq(calls.length, 0, '503 之后下一组不再直连')
}

// ===================== ② 「未更新」403 + 有本地缓存 → 用本地、source 如实、不报警告 =====================
console.log('② 未更新 403')
{
  const { omm, dataDir } = makeOmm()
  const cf = writeCache(dataDir, 'starlink', csvOf('CACHED-SL'))
  reset((u) => (u.includes('/sup-gp.php') ? R.ok(csvOf('SUP-SL')) : R.notUpdated(queryOf(u))))
  const r = await omm.fetchCsv('starlink')
  eq(gpCalls(), 1, '未更新：主端点恰 1 次')
  eq(supCalls(), 0, '未更新：不转补充端点')
  eq(r && r.source, 'cache', '未更新：采用本地缓存，source=cache')
  ok(r && /CACHED-SL-0/.test(r.text), '未更新：正文即本地缓存那份')
  eq(r && r.fetchedAt, new Date(OLD).toISOString(), '未更新：fetchedAt 仍是缓存自身的落盘时间')
  eq(fs.statSync(cf).mtimeMs, OLD, '未更新：缓存文件没被动（mtime 不改成此刻）')
  eq(logs.filter((l) => l.level !== 'info').map((l) => l.text).join(' | '), '', '未更新：不报警告')
  ok(logs.some((l) => l.text.includes('主端点答复 HTTP 403 · 数据未更新（本出口 IP 上次成功下载于 ')), '未更新：日志写明「数据未更新」与上次成功下载时刻')
  ok(logs.some((l) => l.text.includes('CelesTrak 答复数据未更新，沿用本地历史缓存')), '未更新：日志写明沿用本地缓存')
  // 仍查一次云镜像（以本地缓存时间为闸，不比本地新就不下载）：同一出口下别的机器刚取过时，云上就是那一份
  eq(cloudCalls.length, 1, '未更新：仍查一次云镜像')
  eq(cloudCalls[0] && cloudCalls[0].opts.newerThan, new Date(OLD).toISOString(), '未更新：云镜像闸 = 本地缓存时间')
}
{
  const { omm, dataDir } = makeOmm()
  writeCache(dataDir, 'starlink', csvOf('CACHED-SL'))
  reset((u) => R.notUpdated(queryOf(u)))
  cloudAnswer = () => ({ text: csvOf('CLOUD-SL'), fetchedAt: new Date(Date.now() - 600e3).toISOString() })
  const r = await omm.fetchCsv('starlink')
  eq(r && r.source, 'cloud', '未更新 + 云镜像有同事刚传的新件 → 换成云上那份（source=cloud）')
  eq(calls.length, 1, '…且对 CelesTrak 只发了 1 次')
}

// ===================== ③ 连接层失败（超时）→ 仍按原规则重试，带退避；熔断照旧 =====================
console.log('③ 超时 / 连接失败')
{
  const { omm } = makeOmm()   // 无本地缓存、无内置快照：必须硬试到底
  reset(() => R.timeout())
  let err = null
  try { await omm.fetchCsv('starlink') } catch (e) { err = e }
  eq(gpCalls(), 3, '超时（无本地兜底）：主端点照原规则 3 次')
  eq(supCalls(), 2, '超时（无本地兜底）：补充端点照原规则 2 次')
  eq(sleeps.join(','), '1000,2000,4000,4000', '每次重试前按序退避（主端点 1 s → 2 s，转补充端点 4 s → 4 s）')
  ok(err && /均不可达/.test(err.message), '四路都没有 → 照旧抛错')
}
{
  const { omm, dataDir } = makeOmm()
  writeCache(dataDir, 'starlink', csvOf('CACHED-SL'))
  writeCache(dataDir, 'oneweb', csvOf('CACHED-OW'))
  reset(() => R.timeout())
  const r = await omm.fetchCsv('starlink')
  eq(gpCalls(), 3, '超时（有本地兜底）：主端点 3 次')
  eq(supCalls(), 0, '超时（有本地兜底）：熔断已开 → 不再转补充端点（原规则）')
  eq(sleeps.join(','), '1000,2000', '超时（有本地兜底）：两次退避')
  ok(logs.some((l) => l.text.includes('连续 3 次连接层失败')), '熔断照旧在第 3 次连接层失败时打开')
  eq(r && r.source, 'cache', '超时：回落本地缓存')
  reset(() => R.ok(csvOf('NET-OW')))
  await omm.fetchCsv('oneweb')
  eq(calls.length, 0, '熔断后下一组不再直连')
  const r3 = await omm.fetchCsv('oneweb', { force: true })
  eq(calls.length, 1, '强刷照旧清熔断、重新直连')
  eq(r3 && r3.source, 'network', '强刷直连成功，source=network')
}
{
  const { omm, dataDir } = makeOmm()
  let n = 0
  reset(() => (++n === 1 ? R.reset() : R.ok(csvOf('NET-SL'))))
  const r = await omm.fetchCsv('starlink')
  eq(calls.length, 2, '连接被重置一次 → 退避后再试成功（共 2 次）')
  eq(sleeps.join(','), '1000', '…中间退避 1 s')
  eq(r && r.source, 'network', '…source=network')
  ok(/NET-SL-0/.test(fs.readFileSync(path.join(dataDir, 'omm', 'csv_starlink.csv'), 'utf8')), '…已写入本地缓存')
  eq(uploads.join(','), 'starlink', '…直连成功才回传云镜像')
}
// 200 但内容无效（门户 / 网关页）：同一端点不再要（CelesTrak 已记下本周期这一次），补充端点照常试一次
{
  const { omm, dataDir } = makeOmm()
  writeCache(dataDir, 'starlink', csvOf('CACHED-SL'))
  reset((u) => (u.includes('/sup-gp.php') ? R.ok(csvOf('SUP-SL')) : R.ok('<html><body>portal</body></html>')))
  const r = await omm.fetchCsv('starlink')
  eq(gpCalls(), 1, '200 但无效：主端点不再重要')
  eq(supCalls(), 1, '200 但无效：转补充端点一次')
  eq(sleeps.length, 0, '200 但无效：不退避')
  eq(r && r.source, 'network', '补充端点拿到有效数据 → source=network')
}

// ===================== ④ 全局非 200 计数闸 =====================
console.log('④ 本次运行非 200 计数满 5 → 全部停直连')
{
  const { omm, dataDir } = makeOmm()
  const G = ['gps', 'beidou', 'galileo', 'qianfan', 'guowang', 'geo', 'glonass', 'starlink']
  for (const k of G) writeCache(dataDir, k, csvOf('C-' + k))
  reset((u) => R.notUpdated(queryOf(u)))
  const per = [], srcs = []
  for (const k of G) {
    const before = calls.length
    const r = await omm.fetchCsv(k)
    per.push(calls.length - before)
    srcs.push(r && r.source)
  }
  eq(per.join(','), '1,1,1,1,1,0,0,0', '逐组：前 5 组各恰 1 次，满 5 之后各组 0 次')
  eq(supCalls(), 0, '全程没有一次 sup-gp')
  ok(srcs.every((s) => s === 'cache'), '各组都回落本地缓存', srcs.join(','))
  ok(logs.some((l) => l.level === 'warn' && l.text.includes('本次运行已累计 5 次非 200 响应 —— 本次运行停止直连')), '满 5 次时报一次警告')
  ok(logs.some((l) => l.text.includes('本次运行 CelesTrak 已返回 5 次非 200 响应，跳过直连，直接查云镜像')), '之后各组日志写明跳过原因')
  eq(Object.keys(attempts(dataDir)).length, 18, '封站时 17 组 + SATCAT 全部记账今天已试过（下次启动也不自动再连）')
  // 强刷不破例：计数闸只有重启软件才清
  let before = calls.length
  const rf = await omm.fetchCsv('starlink', { force: true })
  eq(calls.length - before, 0, '强刷也不破例')
  eq(rf && rf.source, 'cache', '强刷：回落本地缓存')
  // SATCAT 走同一个闸（无本地兜底也不破例）
  before = calls.length
  let err = null
  try { await omm.fetchCsv('satcat') } catch (e) { err = e }
  eq(calls.length - before, 0, 'SATCAT 同受本次运行的计数闸（无本地兜底也不直连）')
  ok(!!err, 'SATCAT 无本地兜底、云镜像也无 → 照旧抛错')
}
{
  // 渲染端「全部卫星」一次并发要 16 组：没有并发闸的话 16 个 403 同时落地，计数闸形同虚设
  const { omm, dataDir } = makeOmm()
  for (const k of GP_KEYS) writeCache(dataDir, k, csvOf('C-' + k))
  reset((u) => R.notUpdated(queryOf(u)))
  const rs = await Promise.all(GP_KEYS.map((k) => omm.fetchCsv(k)))
  ok(calls.length >= 5 && calls.length <= 6, `16 组并发：发出的请求封顶 5 + (2 − 1) = 6（实得 ${calls.length}）`)
  ok(maxInFlight <= 2, `16 组并发：同时在飞 ≤ 2（实得 ${maxInFlight}）`)
  eq(supCalls(), 0, '16 组并发：没有一次 sup-gp')
  ok(rs.every((r) => r && r.source === 'cache'), '16 组并发：各组都回落本地缓存')
}

// ===================== ⑤ SATCAT 同一纪律 =====================
console.log('⑤ SATCAT')
{
  const { omm, dataDir } = makeOmm()
  writeCache(dataDir, 'satcat', scOf(50001))
  reset(() => R.status(404, 'Not Found'))
  const r = await omm.fetchCsv('satcat')
  eq(calls.length, 1, 'SATCAT 404：恰 1 次')
  ok(calls[0] && calls[0].endsWith('/pub/satcat.csv'), 'SATCAT：请求的是 pub/satcat.csv')
  eq(sleeps.length, 0, 'SATCAT 404：不重试')
  eq(r && r.source, 'cache', 'SATCAT 404：回落本地缓存')
}
{
  const { omm } = makeOmm()
  reset(() => R.timeout())
  try { await omm.fetchCsv('satcat') } catch { /* 无本地兜底：抛错是对的 */ }
  eq(calls.length, 3, 'SATCAT 超时：照原规则 3 次（无补充端点）')
  eq(sleeps.join(','), '1000,2000', 'SATCAT 超时：两次退避')
}

// ===================== ⑥ solarFlux.js（SWPC）同口径收紧 =====================
console.log('⑥ solarFlux.js（SWPC）')
{
  process.env.SATSIM_DATA_DIR = mkdir(path.join(TMP, 'swpc'))
  process.env.SATSIM_SWPC_BUNDLE_DIR = path.join(HERE, 'fixtures/swpc')
  delete process.env.SATSIM_SWPC_OFFLINE
  const svc = require(path.join(ROOT, 'electron/services/solarFlux.js'))
  const fixOf = (u) => fs.readFileSync(path.join(HERE, 'fixtures/swpc', path.basename(new URL(u).pathname)), 'utf8')

  svc._reset()
  reset(() => R.status(404, 'Not Found'))
  let r = await svc.refresh({ force: true })
  eq(calls.length, 4, 'SWPC 404：四个产品各恰 1 次')
  eq(sleeps.length, 0, 'SWPC 404：不重试')
  ok(r && r.ok === false && r.source === 'bundled', 'SWPC 404：继续用内置快照', JSON.stringify(r))

  svc._reset()
  reset(() => R.status(503))
  r = await svc.refresh({ force: true })
  eq(calls.length, 1, 'SWPC 503：第一个产品即停，本轮只发 1 次')
  ok(logs.some((l) => l.text.includes('本轮其余 3 个产品不再请求')), 'SWPC 503：日志写明其余产品不再请求')

  svc._reset()
  let first = true
  reset((u) => (u.includes('10cm-flux') && first ? ((first = false), R.timeout()) : R.ok(fixOf(u))))
  r = await svc.refresh({ force: true })
  eq(calls.length, 5, 'SWPC 超时：只有连接层失败的那个产品再试一次（4 + 1）')
  eq(sleeps.join(','), '1000', 'SWPC 超时：再试前退避 1 s')
  ok(r && r.ok === true && r.source === 'network', 'SWPC 超时后再试成功 → 直连落盘', JSON.stringify(r))

  svc._reset()
  reset(() => R.ok('<html><body>portal</body></html>'))
  r = await svc.refresh({ force: true })
  eq(calls.length, 4, 'SWPC 200 但是网页：各产品不重试（4 次）')
  svc._reset()
}

// ---------------- 收尾 ----------------
globalThis.setTimeout = realSetTimeout
https.request = realNet.hr; https.get = realNet.hg; http.request = realNet.r; http.get = realNet.g
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 临时目录清不掉不影响结论 */ }
console.log(`\n${fail ? '✗' : '✓'} 通过 ${pass}，失败 ${fail}`)
process.exit(fail ? 1 : 0)
