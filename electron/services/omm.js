// 轨道服务（主进程）：加载 TLE → SGP4 传播 → 返回经纬高。
// 离线优先：优先用缓存/内置样例；联网仅在显式刷新且可达时尝试 CelesTrak。
const https = require('https')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const ommCloud = require('./ommCloud')   // 众包云镜像（腾讯云 COS）：屏蔽 celestrak 的网络靠它兜底
const log = require('./ommLog')          // 取数链路的操作明细 → 主进程 console + 底部「日志」窗格
const { fmtBytes, fmtSec, fmtTime } = log

// 内置样例 TLE（保证完全离线也能渲染星座）：ISS、两颗 Starlink、一颗 GEO。
const SAMPLE = `ISS (ZARYA)
1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9000
2 25544  51.6400 100.0000 0006703  90.0000 270.0000 15.50000000000000
STARLINK-1007
1 44713U 19074A   24001.50000000  .00002182  00000-0  16717-3 0  9001
2 44713  53.0540 200.0000 0001423  90.0000 270.0000 15.06000000000000
STARLINK-1130
1 44937U 20001A   24001.50000000  .00001500  00000-0  12000-3 0  9002
2 44937  53.0530 280.0000 0001500  80.0000 280.0000 15.06000000000000
DEMO-GEO
1 40000U 14001A   24001.50000000  .00000000  00000-0  00000-0 0  9003
2 40000   0.0300  95.0000 0002000  90.0000 270.0000  1.00270000000000`

const CELESTRAK = (group) =>
  `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=tle`

// 与小程序 tleStore 完全一致的分组 -> CelesTrak GP 查询映射（OMM CSV）。
const GROUP_QUERY = {
  starlink: 'GROUP=starlink', oneweb: 'GROUP=oneweb', kuiper: 'GROUP=kuiper',
  gps: 'GROUP=gps-ops', beidou: 'GROUP=beidou', galileo: 'GROUP=galileo',
  qianfan: 'GROUP=qianfan', guowang: 'NAME=HULIANWANG', geo: 'GROUP=geo',
  glonass: 'GROUP=glo-ops', o3b: 'NAME=O3B', iridium: 'GROUP=iridium-NEXT',
  globalstar: 'GROUP=globalstar', stations: 'GROUP=stations', planet: 'GROUP=planet',
  spire: 'GROUP=spire', active: 'GROUP=active'
}
const SUP_FILE = { starlink: 'starlink', oneweb: 'oneweb', kuiper: 'kuiper', planet: 'planet', iridium: 'iridium', gps: 'gps' }
const csvUrl = (k) => `https://celestrak.org/NORAD/elements/gp.php?${GROUP_QUERY[k]}&FORMAT=csv`
const supCsvUrl = (k) => `https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=${SUP_FILE[k]}&FORMAT=csv`

// 日志用中文分组名（与 src/pages/ConstellationMap3D.vue 的 GROUPS 标签逐字一致，改一处要同步）
const GROUP_LABEL = {
  starlink: 'Starlink', oneweb: 'OneWeb', kuiper: 'Kuiper', gps: 'GPS', beidou: '北斗', galileo: 'Galileo',
  qianfan: '千帆星座', guowang: '中国星网', geo: 'GEO', glonass: 'GLONASS', o3b: 'O3b', iridium: '铱星',
  globalstar: 'Globalstar', stations: '空间站', planet: 'Planet', spire: 'Spire', active: '全部在轨'
}
const GL = (k) => GROUP_LABEL[k] || k
// 数据来源在日志里的统一叫法（offlineBest 的 source）
const SRC_NAME = { cache: '本地历史缓存', bundled: '随安装包内置的星历快照' }

module.exports = function createOmm(getCore) {
  const groups = {} // group -> [{ name, satrec }]

  function cacheDir() {
    const base = process.env.SATSIM_DATA_DIR ||
      path.join(require('electron').app.getPath('userData'), 'data')
    const d = path.join(base, 'omm')
    fs.mkdirSync(d, { recursive: true })
    return d
  }
  const cacheFile = (g) => path.join(cacheDir(), `${g}.tle`)

  function parse(group, text) {
    const sgp4 = getCore().sgp4
    if (!sgp4) return 0
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length)
    const list = []
    for (let i = 0; i + 2 < lines.length + 1; i += 3) {
      const name = lines[i]
      const l1 = lines[i + 1]
      const l2 = lines[i + 2]
      if (!l1 || !l2 || l1[0] !== '1' || l2[0] !== '2') continue
      try {
        const satrec = sgp4.twoline2satrec(l1, l2)
        list.push({ name: (name || '').trim(), satrec })
      } catch { /* skip malformed */ }
    }
    groups[group] = list
    return list.length
  }

  function fetchText(group) {
    return new Promise((resolve) => {
      const req = https.get(CELESTRAK(group), { timeout: 8000 }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null) }
        let buf = ''
        res.on('data', (c) => (buf += c))
        res.on('end', () => resolve(buf))
      })
      req.on('error', () => resolve(null))
      req.on('timeout', () => { req.destroy(); resolve(null) })
    })
  }

  // 加载分组：online=true 时尝试联网→写缓存，失败回退缓存，再回退样例。
  async function load(group = 'sample', online = false) {
    if (group === 'sample') return { group, count: parse('sample', SAMPLE), source: 'sample' }
    let text = null
    let source = 'cache'
    if (online) {
      text = await fetchText(group)
      if (text) { try { fs.writeFileSync(cacheFile(group), text) } catch {} ; source = 'network' }
    }
    if (!text) { try { text = fs.readFileSync(cacheFile(group), 'utf8') } catch {} }
    if (!text) { source = 'sample'; text = SAMPLE; group = 'sample' }
    return { group, count: parse(group, text), source }
  }

  // 返回 { text, why, kind }：text 为正文（失败时 null），why 为失败原因短语，直接进日志给用户看
  // （HTTP 403「数据未更新」是 CelesTrak 对重复请求的常规响应，单独措辞，避免被误读为故障）。
  // kind 区分失败层级，供熔断判据用：'net'=连接层失败（超时/连不上，站点根本不可达）、
  // 'http'=有 HTTP 响应但非 200（说明网络是通的，只是被限流/无更新）、''=成功。
  function httpGetText(url) {
    return new Promise((resolve) => {
      const fail = (why, kind) => resolve({ text: null, why, kind: kind || 'net' })
      const httpWhy = (code) => (code === 403 ? 'HTTP 403 · 该数据自上次下载后未更新或被限流' : `HTTP ${code}`)
      let net = null
      try { net = require('electron').net } catch {}
      // 优先用 Electron net：走 Chromium 网络栈，遵循系统代理/VPN —— 国内访问 celestrak 的关键。
      if (net && typeof net.request === 'function') {
        let buf = '', done = false
        const req = net.request(url)
        req.setHeader('User-Agent', 'satsim-desktop')
        req.on('response', (res) => {
          if (res.statusCode !== 200) {
            done = true
            res.on('data', () => {}); res.on('end', () => fail(httpWhy(res.statusCode), 'http')); return
          }
          res.on('data', (c) => (buf += c))
          res.on('end', () => { done = true; resolve({ text: buf, why: '', kind: '' }) })
        })
        req.on('error', (e) => { done = true; fail('连接失败 · ' + (e.message || e)) })
        setTimeout(() => { if (!done) { try { req.abort() } catch {} ; fail('连接超时 30s') } }, 30000)
        try { req.end() } catch (e) { done = true; fail('请求发起失败 · ' + e.message) }
        return
      }
      // 回退：Node https（仅用于无 Electron 的测试环境，不走系统代理）。
      const req = https.get(url, { timeout: 30000, headers: { 'User-Agent': 'satsim-desktop' } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return fail(httpWhy(res.statusCode), 'http') }
        let buf = ''
        res.on('data', (c) => (buf += c))
        res.on('end', () => resolve({ text: buf, why: '', kind: '' }))
      })
      req.on('error', (e) => fail('连接失败 · ' + (e.message || e)))
      req.on('timeout', () => { req.destroy(); fail('连接超时 30s') })
    })
  }

  const csvCacheFile = (k) => path.join(cacheDir(), `csv_${k}.csv`)

  const valid = (t) => t && /MEAN_MOTION/i.test(t)
  const isToday = (d) => { const n = new Date(), t = new Date(d); return n.getFullYear() === t.getFullYear() && n.getMonth() === t.getMonth() && n.getDate() === t.getDate() }

  // 缓存文件的写入时间 = 该份数据真正从官网下载落盘的时刻 → 作为“OMM 下载时间”回传（离线复用旧缓存时即旧时间）。
  const cacheMtime = (cf) => { try { return fs.statSync(cf).mtime.toISOString() } catch { return null } }

  // ---- 内置 OMM 兜底快照（resources/omm，随安装包分发，见 scripts/fetch-omm-snapshot.mjs）----
  // 无网设备也能看到星座；有更新（今日缓存 / 联网 / 更新的用户缓存）一律优先，见 offlineBest。
  // 打包后位于 app.asar 内，Electron 已给 fs 打补丁可直接读；测试环境用 SATSIM_OMM_BUNDLE_DIR 覆盖目录。
  function bundledDir() {
    if (process.env.SATSIM_OMM_BUNDLE_DIR) return process.env.SATSIM_OMM_BUNDLE_DIR
    try { return path.join(require('electron').app.getAppPath(), 'resources', 'omm') } catch { return null }
  }
  let _manifest   // 惰性读一次；undefined=未读、null=无
  function bundledManifest() {
    if (_manifest !== undefined) return _manifest
    _manifest = null
    const d = bundledDir()
    if (d) { try { _manifest = JSON.parse(fs.readFileSync(path.join(d, 'manifest.json'), 'utf8')) } catch {} }
    return _manifest
  }
  // 读内置快照某组 → { text, time, count } 或 null。优先 .csv.gz（gzip），兼容明文 .csv。time=该组快照生成时间。
  function readBundled(key) {
    const d = bundledDir()
    if (!d) return null
    const man = bundledManifest()
    const g = man && man.groups && man.groups[key]
    const time = (g && g.generatedAt) || (man && man.generatedAt) || null
    try { const gz = path.join(d, `csv_${key}.csv.gz`); if (fs.existsSync(gz)) { const t = zlib.gunzipSync(fs.readFileSync(gz)).toString('utf8'); if (valid(t)) return { text: t, time, count: (g && g.count) || csvCount(t) } } } catch {}
    try { const t = fs.readFileSync(path.join(d, `csv_${key}.csv`), 'utf8'); if (valid(t)) return { text: t, time, count: csvCount(t) } } catch {}
    return null
  }
  // 离线兜底：在「用户缓存」与「内置快照」间取更新的一版（有更新用更新）。返回 { text, fetchedAt, source } 或 null。
  function offlineBest(key) {
    const cf = csvCacheFile(key)
    let cache = null
    try { const c = fs.readFileSync(cf, 'utf8'); if (valid(c)) cache = { text: c, fetchedAt: cacheMtime(cf), source: 'cache' } } catch {}
    const b = readBundled(key)
    const bundled = b ? { text: b.text, fetchedAt: b.time, source: 'bundled' } : null
    if (cache && bundled) {
      const ct = Date.parse(cache.fetchedAt || 0) || 0
      const bt = Date.parse(bundled.fetchedAt || 0) || 0
      return bt > ct ? bundled : cache   // 内置快照比用户缓存新则用内置，否则用用户缓存
    }
    return cache || bundled || null
  }
  // 本机是否已有可回落的数据（用户缓存 / 内置快照）——只做存在性探测，不读正文
  // （active 组明文约 5MB，判据用不着解压整份，别在直连成功的路径上白读盘）。
  function hasBundled(key) {
    const d = bundledDir(); if (!d) return false
    try { if (fs.existsSync(path.join(d, `csv_${key}.csv.gz`))) return true } catch {}
    try { return fs.existsSync(path.join(d, `csv_${key}.csv`)) } catch { return false }
  }
  function hasLocal(key) {
    try { if (fs.statSync(csvCacheFile(key)).size > 0) return true } catch {}
    return hasBundled(key)
  }

  // ---- 「今天已试过直连」记账 + 会话级熔断：CelesTrak 被墙时不再每次启动重付超时 ----
  // 病灶：能让缓存 mtime 变成「今天」（从而命中一天一次的缓存闸门）的只有两条路——直连成功、或云镜像那份
  // 恰好是今天上传的。而云镜像只有直连得通的用户才刷得动，直连被墙的机器一旦碰上「当天没人刷新镜像」，
  // fetchCsv 的失败/回落路径【不写盘也不留痕】，于是每次启动都把 17 组 × 3~5 次 30s 超时重付一遍，
  // 拿回来的还是同一份旧数据 —— 表现就是「反复加载且慢」。
  // 对策：另记一份「今天已完整试过直连」的标记。命中时【只跳过 CelesTrak 两级】，云镜像照常查
  // （一次 HEAD，国内毫秒级）——既不重付超时，也不牺牲「别人下午把镜像刷新了本机也能拿到」。
  const attemptFile = () => path.join(cacheDir(), 'celestrak-attempt.json')
  let _attempts   // { group: ISO }；惰性读一次，之后内存为准、写穿到盘
  function attempts() {
    if (_attempts) return _attempts
    _attempts = {}
    try { const o = JSON.parse(fs.readFileSync(attemptFile(), 'utf8')); if (o && typeof o === 'object') _attempts = o } catch {}
    return _attempts
  }
  const triedToday = (key) => { const t = attempts()[key]; return !!t && isToday(t) }
  function markTried(keys) {
    const a = attempts(), now = new Date().toISOString()
    for (const k of [].concat(keys)) a[k] = now
    try { fs.writeFileSync(attemptFile(), JSON.stringify(a)) } catch { /* 记不上账只是退化回原行为，不影响取数 */ }
  }

  // 会话级熔断：连续 BREAK_AT 次「连接层」失败（超时 / 连不上 = 站点根本不可达）→ 本次运行剩余分组
  // 直接跳到云镜像，不再逐组重试。HTTP 有响应（含 403 限流）说明网络是通的 → 立即复位。
  // 熔断触发时把全部分组一并记账：这就是「今天直连不通」的证据，下次启动直接走云镜像，不必再花一轮探测。
  // 仅内存态 + 当日记账，重启软件的次日会重新探测（网络环境可能已变）。
  const BREAK_AT = 3
  let _netFails = 0, _breakerOpen = false
  function noteNet(kind) {
    if (kind !== 'net') { _netFails = 0; _breakerOpen = false; return }   // 只要有 HTTP 响应就说明通
    if (++_netFails < BREAK_AT || _breakerOpen) return
    _breakerOpen = true
    markTried(Object.keys(GROUP_QUERY))
    log.emit(`星历：CelesTrak 连续 ${_netFails} 次连接层失败，判定本机当前网络不可达 —— 本次运行剩余分组直接走云镜像，今日不再重试直连（重启软件的次日会重新探测）`, 'warn')
  }

  // 取某组 OMM CSV：返回 { text, fetchedAt }。fetchedAt 恒为缓存文件 mtime（= 该数据实际从 CelesTrak 下载落盘的时间），
  // 而非“此刻”——这样复用今日/旧缓存时显示的也是真实下载时间。本地有“今天”的缓存 → 直接用（一天一次）；
  // 否则联网（主端点重试3次→补充端点重试2次）→ 命中落盘 + 众包回传云镜像；
  // 直连全失败 → 云镜像（腾讯云 COS，别人今天传上去的那份；国内不被墙）→ 本地缓存 / 内置快照（离线优先）。
  async function fetchCsvOnce(key, opts = {}) {
    if (!GROUP_QUERY[key]) throw new Error('unknown group: ' + key)
    const cf = csvCacheFile(key)
    const tag = `星历「${GL(key)}」：`   // 日志前缀，全链路统一，便于按星座检索
    if (opts.force) { _netFails = 0; _breakerOpen = false }   // 用户显式刷新：清熔断、绕过所有闸门，硬走一遍全链路
    // 一天一次：缓存文件是今天写的就直接用，不再联网
    try {
      const st = opts.force ? null : fs.statSync(cf)
      if (st && isToday(st.mtime)) {
        const c = fs.readFileSync(cf, 'utf8')
        if (valid(c)) {
          log.emit(`${tag}命中当日本地缓存 —— ${csvCount(c)} 颗 · ${fmtBytes(c.length)} · 数据时间 ${fmtTime(st.mtime)}`)
          return { text: c, fetchedAt: st.mtime.toISOString() }
        }
      }
    } catch {}
    // 仅取缓存（启动即时渲染用）：不联网，取「用户缓存 / 内置快照」更新的一版；都无 → null 交调用方后台联网。
    if (opts.cacheOnly) {
      const best = offlineBest(key)
      if (best) {
        log.emit(`${tag}先以${SRC_NAME[best.source]}即时渲染（${csvCount(best.text)} 颗 · 数据时间 ${fmtTime(best.fetchedAt)}），随后后台联网刷新`)
        return { text: best.text, fetchedAt: best.fetchedAt }
      }
      return null
    }

    const t0 = Date.now()
    // 本机有没有可回落的数据（只探文件存在，不读正文）：没有就必须硬试到底，否则首启即离线的用户永远拿不到星历。
    const local = hasLocal(key)
    // 跳过 CelesTrak 直连的两种情形（都【只跳直连】，云镜像与本地回落照常）：
    //   ① 熔断：本次运行已判定 CelesTrak 连接层不可达；② 今天已完整试过一轮直连（当时没拿到更新数据）。
    const skipDirect = !opts.force && local && (_breakerOpen || triedToday(key))
    // 熔断中断重试的前提也是「有本地兜底」——无兜底时哪怕已判定不可达也要把 3 次机会用完。
    const bail = () => _breakerOpen && local && !opts.force
    let text = null, why = ''
    if (skipDirect) {
      log.emit(`${tag}${_breakerOpen ? '本次运行已判定 CelesTrak 不可达' : '今天已完整试过 CelesTrak 直连'}，跳过直连，直接查云镜像`)
    } else {
      log.emit(`${tag}本地无当日数据，开始连接 CelesTrak 主端点（gp.php · ${GROUP_QUERY[key]}）`)
      let tries = 0
      for (let i = 0; i < 3 && !valid(text) && !bail(); i++) { tries++; const r = await httpGetText(csvUrl(key)); text = r.text; why = r.why; noteNet(r.kind) }
      if (!valid(text)) log.emit(`${tag}CelesTrak 主端点 ${tries} 次尝试均失败（${why || '返回内容非有效 OMM'}）`, 'warn')
      // 补充端点同样在 celestrak.org：熔断已开（=根本连不上）时再试 2×30s 是纯浪费，直接跳过
      if (!valid(text) && !bail() && SUP_FILE[key]) {
        let supTries = 0
        log.emit(`${tag}转 CelesTrak 补充星历端点（sup-gp.php · FILE=${SUP_FILE[key]}，与主端点限流独立）`)
        for (let i = 0; i < 2 && !valid(text) && !bail(); i++) { supTries++; const r = await httpGetText(supCsvUrl(key)); text = r.text; why = r.why; noteNet(r.kind) }
        if (!valid(text)) log.emit(`${tag}CelesTrak 补充端点 ${supTries} 次尝试均失败（${why || '返回内容非有效 OMM'}）`, 'warn')
      }
      markTried(key)   // 无论结果：本组今天已完整试过直连 —— 下次启动不再重付这段超时（次日自动过期）
    }
    if (valid(text)) {
      try { fs.writeFileSync(cf, text) } catch (e) { log.emit(`${tag}缓存写入失败（${e.message}），本次数据仅在内存中`, 'warn') }
      log.emit(`${tag}CelesTrak 直连获取成功 —— ${csvCount(text)} 颗 · ${fmtBytes(text.length)} · 耗时 ${fmtSec(Date.now() - t0)}，已写入本地缓存`)
      // 众包：本机拿到了新数据 → best-effort 回传云镜像（云端那份还够新则自动跳过），供屏蔽 celestrak 的用户兜底。
      // 不 await：上传慢/失败都不该拖住星座渲染。
      ommCloud.maybeUpload(key, text, GL(key)).catch(() => {})
      return { text, fetchedAt: cacheMtime(cf) || new Date().toISOString() }
    }
    // 直连失败/被跳过 → 云镜像兜底。先算本地最优，把它的时间交给云端做闸门：云端不比本地新就不下载（省流量，也不用旧盖新）。
    const best = offlineBest(key)
    const cloud = await ommCloud.download(key, { newerThan: opts.force ? null : (best && best.fetchedAt), label: GL(key) })
    if (cloud) {
      // 落盘缓存，并把 mtime 改成云端那份的上传时间：既让「今日缓存」判据成立（当天不再反复联网），
      // 界面显示的「OMM 下载时间」也如实反映数据自身的时间，而不是本机取回的此刻。
      let cached = true
      try { fs.writeFileSync(cf, cloud.text); const t = new Date(cloud.fetchedAt); fs.utimesSync(cf, t, t) } catch { cached = false }
      log.emit(`${tag}改用云镜像数据 —— ${csvCount(cloud.text)} 颗 · 数据时间 ${fmtTime(cloud.fetchedAt)} · 全程耗时 ${fmtSec(Date.now() - t0)}${cached ? '，已写入本地缓存' : ''}`)
      return { text: cloud.text, fetchedAt: cloud.fetchedAt }
    }
    // 云镜像也拿不到 → 静默回落本地：用户缓存 / 内置快照，取更新的一版（无网设备靠内置快照兜底）。
    if (best) {
      log.emit(`${tag}联网与云镜像均不可用，回落${SRC_NAME[best.source]} —— ${csvCount(best.text)} 颗 · 数据时间 ${fmtTime(best.fetchedAt)}（星历越旧，轨道位置误差越大）`, 'warn')
      return { text: best.text, fetchedAt: best.fetchedAt }
    }
    log.emit(`${tag}获取失败 —— CelesTrak、云镜像、本地缓存、内置快照四路均不可用`, 'error')
    throw new Error('celestrak.org 与云镜像均不可达，且无本地缓存与内置快照')
  }

  // ---- 并发去重：同一分组的同一种请求在飞行中时，后来者直接搭车，不再各跑一遍完整瀑布 ----
  // 启动时渲染进程的 loadGroup()（当前分组）与 ensureSearchPool()→loadUniverse()（全部 17 组）几乎同时发起，
  // 默认组 geo 会被并发要两次；切「全部卫星」/「其他」时又各来一轮。没有这层，同一组就会并行跑两遍
  // 3~5 次 30s 超时 + 两次云镜像 HEAD/GET + 两次写同一个缓存文件。
  const _inflight = new Map()
  function fetchCsv(key, opts = {}) {
    const k = `${key}|${opts.cacheOnly ? 'c' : 'n'}${opts.force ? 'f' : ''}`   // cacheOnly 是另一种语义（不联网），不与联网请求合并
    const hit = _inflight.get(k)
    if (hit) return hit
    const p = fetchCsvOnce(key, opts).finally(() => { _inflight.delete(k) })
    _inflight.set(k, p)
    return p
  }

  // ---- 文件管理：各星座组 OMM(CSV) 缓存的列举 / 导入替换 / 读出导出 ----
  // CSV 数据行数（OMM CSV 首行为表头）：粗略卫星数。
  const csvCount = (t) => { if (!t) return 0; const n = t.split(/\r?\n/).filter((l) => l.trim().length).length; return Math.max(0, n - 1) }
  // 列出全部内置组及其可用性（source: 'cache' 用户缓存 / 'bundled' 内置快照 / 'none' 无）。
  // 无用户缓存时回落到内置快照的统计，让文件管理如实显示「内置」可用、可导出（离线设备也能看到有数据）。
  function listCsv() {
    return Object.keys(GROUP_QUERY).map((key) => {
      const cf = csvCacheFile(key)
      let exists = false, mtime = null, count = 0, source = 'none'
      try { const st = fs.statSync(cf); exists = true; source = 'cache'; mtime = st.mtime.toISOString(); count = csvCount(fs.readFileSync(cf, 'utf8')) } catch {}
      if (!exists) {
        const b = readBundled(key)
        if (b) { source = 'bundled'; count = b.count || 0; mtime = b.time || null }
      }
      return { key, file: `csv_${key}.csv`, exists, source, mtime, count }
    })
  }
  // 读出某组 CSV 原文（导出用）：优先用户缓存，无则回落内置快照；都无返回 null。
  function readCsvRaw(key) {
    if (!GROUP_QUERY[key]) throw new Error('unknown group: ' + key)
    try { return { text: fs.readFileSync(csvCacheFile(key), 'utf8'), file: `csv_${key}.csv` } } catch {}
    const b = readBundled(key)
    if (b) return { text: b.text, file: `csv_${key}.csv`, bundled: true }
    return null
  }
  // 导入并替换某组 OMM CSV：校验为 CelesTrak OMM（含 MEAN_MOTION 表头），写入缓存覆盖，使该星座改用用户文件渲染。
  function writeCsvRaw(key, text) {
    if (!GROUP_QUERY[key]) throw new Error('unknown group: ' + key)
    if (!valid(text)) throw new Error('不是有效的 OMM CSV（缺 MEAN_MOTION 列）——请用 CelesTrak「FORMAT=csv」导出的文件')
    const cf = csvCacheFile(key)
    fs.writeFileSync(cf, String(text))
    const st = fs.statSync(cf)
    return { ok: true, key, mtime: st.mtime.toISOString(), count: csvCount(String(text)) }
  }

  function positions(group, iso) {
    const sgp4 = getCore().sgp4
    const list = groups[group]
    if (!sgp4 || !list) return []
    const date = iso ? new Date(iso) : new Date()
    const gmst = sgp4.gstime(date)
    const out = []
    for (const s of list) {
      try {
        const pv = sgp4.propagate(s.satrec, date)
        if (!pv || !pv.position) continue
        const gd = sgp4.eciToGeodetic(pv.position, gmst)
        out.push({
          name: s.name,
          lon: sgp4.degreesLong(gd.longitude),
          lat: sgp4.degreesLat(gd.latitude),
          altKm: gd.height
        })
      } catch { /* skip */ }
    }
    return out
  }

  return { load, positions, fetchCsv, listCsv, readCsvRaw, writeCsvRaw }
}
