// 太阳射电流量 F10.7（主进程）：按目标日期给出 F10.7，供日凌引擎算太阳亮温。
//
// ★ 第一原则：计算【永不等网络】。sunoutage:compute 只调 snapshot()（同步、只读本机），
//   联网刷新是算完之后不 await 地捅一下，与 omm.js 的「缓存先出、后台联网」同一口径。
//
// 四级链路（与 omm.js 逐级对应，只是 URL / 判据 / 标签不同）：
//   ① 当日缓存闸：<userData>/data/space-weather/solar-flux.json 是今天写的 → 不联网；
//   ② 直连 NOAA SWPC 四个产品（各 20 s 超时、各 2 次）→ 落盘 + 众包回传云镜像；
//   ③ 云镜像（腾讯云 COS，与星历同一个桶的 omm/ 前缀，键 solarflux）；
//   ④ 用户缓存 / 内置快照 resources/space-weather/solar-flux.json（随安装包分发，无网也能算）。
// 「今天已试过直连」单独记一份 swpc-attempt.json（不与 celestrak 那份共用：两边是两个站点，
// 一边不通不代表另一边不通）。日志走 ommLog，前缀「太阳射电流量：」。
//
// 四个产品各自带 at：某一个抓失败只保留旧的那一份，其余照更新（部分刷新，见 solarFluxPick.mergeProducts）。
//
// 解析、合并、按日期取值一律在 packages/core/utils/solarFluxPick.js（纯函数，测试钉得住），
// 本文件只负责 I/O。
//
// 环境变量：SATSIM_SWPC_BUNDLE_DIR 覆盖内置快照目录（同 SATSIM_OMM_BUNDLE_DIR）；
//           SATSIM_SWPC_OFFLINE=1 彻底关掉联网（测试与离线验收用 —— 单测不许摸网络）。
const https = require('https')
const fs = require('fs')
const path = require('path')
const ommCloud = require('./ommCloud')
const log = require('./ommLog')
const { fmtBytes, fmtSec, fmtTime } = log
const pick = require('../../packages/core/utils/solarFluxPick.js')
const { validSolarFlux } = require('../../packages/core/utils/solarFluxValid.js')

const TAG = '太阳射电流量：'
const CLOUD_KEY = 'solarflux'          // 云镜像对象名 omm/csv_solarflux.csv.gz（键任意，CAM 已放行 omm/*）
const CLOUD_LABEL = '太阳射电流量 F10.7'
const TIMEOUT = 20000
const TRIES = 2

// NOAA SWPC 四个产品（附录 B 有格式速记）。label 只进日志。
const SOURCES = {
  daily30:    { url: 'https://services.swpc.noaa.gov/products/10cm-flux-30-day.json',                 label: '30 天观测日值' },
  forecast45: { url: 'https://services.swpc.noaa.gov/text/45-day-forecast.txt',                        label: '45 天预报' },
  monthly:    { url: 'https://services.swpc.noaa.gov/json/solar-cycle/observed-solar-cycle-indices.json', label: '观测月均' },
  predicted:  { url: 'https://services.swpc.noaa.gov/json/solar-cycle/predicted-solar-cycle.json',     label: '太阳周预测月均' }
}
// 数据来源在读数与日志里的统一叫法（与 src/ssa/ssaData.js 的 SRC_LABEL 同一套键）
const SRC_NAME = { network: '直连', cloud: '云镜像', cache: '本地缓存', bundled: '内置快照' }

const isToday = (d) => { const n = new Date(), t = new Date(d); return n.getFullYear() === t.getFullYear() && n.getMonth() === t.getMonth() && n.getDate() === t.getDate() }
const offline = () => process.env.SATSIM_SWPC_OFFLINE === '1'

function dataDir() {
  const base = process.env.SATSIM_DATA_DIR ||
    path.join(require('electron').app.getPath('userData'), 'data')
  return path.join(base, 'space-weather')
}
// ★ 只在真要写盘时才 mkdir：读路径上建目录，会在测试 / 脚本环境里凭空造出一个数据目录。
const dataFile = () => { try { return path.join(dataDir(), 'solar-flux.json') } catch (e) { return null } }
const attemptFile = () => { try { return path.join(dataDir(), 'swpc-attempt.json') } catch (e) { return null } }
function ensureDir() { const d = dataDir(); fs.mkdirSync(d, { recursive: true }); return d }

function bundledDir() {
  if (process.env.SATSIM_SWPC_BUNDLE_DIR) return process.env.SATSIM_SWPC_BUNDLE_DIR
  try { return path.join(require('electron').app.getAppPath(), 'resources', 'space-weather') } catch (e) { return null }
}

/* ============================ 读盘 ============================ */

function readJsonFile(file) {
  if (!file) return null
  try {
    const t = fs.readFileSync(file, 'utf8')
    if (!validSolarFlux(t)) return null
    return JSON.parse(t)
  } catch (e) { return null }
}
function readCache() {
  const f = dataFile()
  const o = readJsonFile(f)
  if (!o) return null
  let mtime = o.fetchedAt || null
  try { mtime = fs.statSync(f).mtime.toISOString() } catch (e) { /* 取不到就用正文里的 */ }
  return { data: o, source: 'cache', fetchedAt: o.fetchedAt || mtime, mtime }
}
function readBundled() {
  const d = bundledDir()
  if (!d) return null
  const o = readJsonFile(path.join(d, 'solar-flux.json'))
  return o ? { data: o, source: 'bundled', fetchedAt: o.fetchedAt || null, mtime: null } : null
}
// 用户缓存与内置快照取更新的一版（与 omm.js offlineBest 同一口径；这份文件只有几 KB，直接都读，
// 不必像星历那边那样先比时间戳再只读赢家）
function offlineBest() {
  const c = readCache(), b = readBundled()
  if (c && b) {
    const tc = Date.parse(c.fetchedAt || '') || 0
    const tb = Date.parse(b.fetchedAt || '') || 0
    return tb > tc ? b : c
  }
  return c || b
}

/* ============================ 记账 ============================ */

let _attempt                 // { at: ISO }；惰性读一次，之后内存为准、写穿到盘
function attempts() {
  if (_attempt) return _attempt
  _attempt = {}
  try { const o = JSON.parse(fs.readFileSync(attemptFile(), 'utf8')); if (o && typeof o === 'object') _attempt = o } catch (e) { /* 无记账＝没试过 */ }
  return _attempt
}
const triedToday = () => { const t = attempts().at; return !!t && isToday(t) }
function markTried() {
  const a = attempts()
  a.at = new Date().toISOString()
  try { ensureDir(); fs.writeFileSync(attemptFile(), JSON.stringify(a)) } catch (e) { /* 记不上账只是退化回原行为 */ }
}

/* ============================ 联网 ============================ */

// 与 omm.js 的 httpGetText 同一条路子：优先 Electron net（走系统代理 / VPN，国内访问的关键），
// 无 Electron 时回退 Node https（脚本与测试环境）。
function httpGetText(url) {
  return new Promise((resolve) => {
    const fail = (why) => resolve({ text: null, why })
    let net = null
    try { net = require('electron').net } catch (e) { /* 非 Electron */ }
    if (net && typeof net.request === 'function') {
      let buf = '', done = false
      const req = net.request(url)
      req.setHeader('User-Agent', 'satsim-desktop')
      req.on('response', (res) => {
        if (res.statusCode !== 200) { done = true; res.on('data', () => {}); res.on('end', () => fail('HTTP ' + res.statusCode)); return }
        res.on('data', (c) => (buf += c))
        res.on('end', () => { done = true; resolve({ text: buf, why: '' }) })
      })
      req.on('error', (e) => { done = true; fail('连接失败 · ' + ((e && e.message) || e)) })
      setTimeout(() => { if (!done) { try { req.abort() } catch (e) {} ; fail('连接超时 ' + (TIMEOUT / 1000) + 's') } }, TIMEOUT)
      try { req.end() } catch (e) { done = true; fail('请求发起失败 · ' + e.message) }
      return
    }
    const req = https.get(url, { timeout: TIMEOUT, headers: { 'User-Agent': 'satsim-desktop' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return fail('HTTP ' + res.statusCode) }
      let buf = ''
      res.on('data', (c) => (buf += c))
      res.on('end', () => resolve({ text: buf, why: '' }))
    })
    req.on('error', (e) => fail('连接失败 · ' + ((e && e.message) || e)))
    req.on('timeout', () => { req.destroy(); fail('连接超时 ' + (TIMEOUT / 1000) + 's') })
  })
}

/* ============================ 服务状态 ============================ */

let _mem = null              // 当前内存中的合并数据 { data, source, fetchedAt }
let _loaded = false
let _refreshing = null       // 飞行中的 refresh（并发去重）
let _refreshingForce = false // 飞行中那一次是不是强制刷新（决定新来的 force 能不能复用它）
let _cycledMs = 0            // 本次运行最近一次跑完整轮取数的时刻（见 doRefresh 的会话闸）

/** 当前可用的合并数据（首次调用读盘），永不联网、同步返回 */
function snapshot() {
  if (!_loaded) { _loaded = true; _mem = offlineBest() }
  return _mem
}

/** 按目标日期取 F10.7（纯规则在 solarFluxPick，这里只把本机数据喂进去） */
function f107For(dateIso, opts) {
  const s = snapshot()
  const out = pick.f107For(s ? s.data : null, dateIso, opts)
  // 数据来自哪条腿（直连 / 云镜像 / 本地缓存 / 内置快照）是读数要显示的，附在 meta 上
  out.dataSource = s ? s.source : null
  return out
}

/** 读数行用：数据整体的时间与来源 + 四个产品各自的抓取时刻 */
function status() {
  const s = snapshot()
  const P = (s && s.data && s.data.products) || {}
  const products = {}
  for (const k of pick.PRODUCTS) products[k] = P[k] ? (P[k].at || null) : null
  return {
    fetchedAt: s ? s.fetchedAt : null,
    source: s ? s.source : null,
    products,
    refreshing: !!_refreshing,
    offline: offline()
  }
}

/**
 * 后台联网刷新（一天一次；force 绕过闸门）。返回 { ok, source, fetchedAt }。
 * 任何一步失败都不抛 —— 失败就是「本机继续用已有的那份」，计算那侧根本不看这个结果。
 */
function refresh(opts) {
  const o = opts || {}
  // 并发去重：飞行中那一次已经「不弱于」这一次，就复用它。
  // ★ force 不能复用飞行中的普通刷新 —— 普通那次可能被当日闸 / 会话闸挡掉直接返回，
  //   复用它等于把 force 吞了。排到它后面再真跑一次强制刷新（不并发，避免两轮同时打 SWPC）。
  if (_refreshing && (!o.force || _refreshingForce)) return _refreshing
  const run = () => doRefresh(o).catch((e) => {
    log.emit(`${TAG}刷新异常（${(e && e.message) || e}）`, 'warn')
    return { ok: false, source: null, fetchedAt: null }
  })
  const prev = _refreshing
  const p = prev ? prev.then(run, run) : run()
  _refreshing = p
  _refreshingForce = !!o.force
  p.finally(() => { if (_refreshing === p) { _refreshing = null; _refreshingForce = false } })
  return p
}

async function doRefresh(o) {
  if (offline()) return { ok: false, source: 'offline', fetchedAt: null }
  const cur = snapshot()
  // ① 当日闸：本机这份就是今天取的（缓存 / 刚直连 / 刚从云镜像拿的）→ 不联网。
  //   内置快照没有落盘时刻（mtime 为 null），故不吃这一闸 —— 无网首启的机器该试还得试。
  if (!o.force && cur && cur.mtime && isToday(cur.mtime)) {
    return { ok: true, source: 'today', fetchedAt: cur.fetchedAt }
  }
  // ② 会话闸：本次运行今天已经完整跑过一轮（直连 + 云镜像都试过了）→ 不再重跑。
  //   没有这一闸，只带内置快照且四路全不通的机器，会【每算一次就重跑一整轮】（每次一个云镜像
  //   HEAD + 四个产品的超时）—— 算一整表站就是几十轮。跨重启仍由 swpc-attempt.json 记账管直连那一段。
  if (!o.force && _cycledMs && isToday(_cycledMs)) {
    return { ok: false, source: cur ? cur.source : null, fetchedAt: cur ? cur.fetchedAt : null }
  }
  _cycledMs = Date.now()
  if (!o.force && triedToday() && cur) {
    log.emit(`${TAG}今天已完整试过 SWPC 直连，跳过直连，直接查云镜像`)
  } else {
    const t0 = Date.now()
    const fresh = {}
    let got = 0
    for (const key of pick.PRODUCTS) {
      const src = SOURCES[key]
      let text = null, why = ''
      for (let i = 0; i < TRIES && !text; i++) { const r = await httpGetText(src.url); text = r.text; why = r.why }
      if (text) { fresh[key] = text; got++ }
      else log.emit(`${TAG}${src.label} ${TRIES} 次尝试均失败（${why || '返回内容为空'}）`, 'warn')
    }
    markTried()
    if (got) {
      const merged = pick.mergeProducts(cur ? cur.data : null, fresh, new Date().toISOString())
      const text = JSON.stringify(merged)
      if (validSolarFlux(text)) {
        let saved = false
        try { ensureDir(); fs.writeFileSync(dataFile(), text); saved = true } catch (e) { log.emit(`${TAG}缓存写入失败（${e.message}），本次数据仅在内存中`, 'warn') }
        _mem = { data: merged, source: 'network', fetchedAt: merged.fetchedAt, mtime: merged.fetchedAt }
        _loaded = true
        const n = (k) => Object.keys((merged.products[k] && merged.products[k].data) || {}).length
        log.emit(`${TAG}SWPC 直连获取成功 —— ${got}/4 个产品（日值 ${n('daily30')} 天 · 预报 ${n('forecast45')} 天 · 观测月均 ${n('monthly')} 月 · 预测 ${n('predicted')} 月）· ${fmtBytes(text.length)} · 耗时 ${fmtSec(Date.now() - t0)}${saved ? '，已写入本地缓存' : ''}`)
        // 众包回传：不 await，上传慢 / 失败都不该拖住任何东西
        ommCloud.maybeUpload(CLOUD_KEY, text, CLOUD_LABEL, validSolarFlux, TAG).catch(() => {})
        return { ok: true, source: 'network', fetchedAt: merged.fetchedAt }
      }
      log.emit(`${TAG}合并后的数据不满足有效性判据，已丢弃本轮结果`, 'warn')
    }
  }
  // ② 云镜像兜底
  const cloud = await ommCloud.download(CLOUD_KEY, {
    newerThan: o.force ? null : (cur && cur.fetchedAt), label: CLOUD_LABEL, valid: validSolarFlux, tag: TAG
  })
  if (cloud) {
    let merged = null
    try { merged = JSON.parse(cloud.text) } catch (e) { merged = null }
    if (merged) {
      try { ensureDir(); fs.writeFileSync(dataFile(), cloud.text); const t = new Date(cloud.fetchedAt); fs.utimesSync(dataFile(), t, t) } catch (e) { /* 写不进就只在内存里 */ }
      _mem = { data: merged, source: 'cloud', fetchedAt: merged.fetchedAt || cloud.fetchedAt, mtime: cloud.fetchedAt }
      _loaded = true
      log.emit(`${TAG}改用云镜像数据 —— 数据时间 ${fmtTime(_mem.fetchedAt)}`)
      return { ok: true, source: 'cloud', fetchedAt: _mem.fetchedAt }
    }
  }
  // ③ 本机回落（已经在 _mem 里了，这里只如实报一句）
  if (cur) {
    log.emit(`${TAG}联网与云镜像均不可用，继续用${SRC_NAME[cur.source] || cur.source} —— 数据时间 ${fmtTime(cur.fetchedAt)}`, 'warn')
    return { ok: false, source: cur.source, fetchedAt: cur.fetchedAt }
  }
  log.emit(`${TAG}获取失败 —— SWPC、云镜像、本地缓存、内置快照四路均不可用，F10.7 按缺省 ${pick.F107_DEFAULT} 计`, 'warn')
  return { ok: false, source: null, fetchedAt: null }
}

/** 测试与脚本用：把内存态清掉，下次 snapshot() 重新读盘 */
function _reset() { _mem = null; _loaded = false; _attempt = undefined; _cycledMs = 0 }

module.exports = { snapshot, f107For, status, refresh, SOURCES, SRC_NAME, _reset }
