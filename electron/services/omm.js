// 星历服务（主进程）：各星座组 OMM CSV 的四级取数链路（当日缓存 → CelesTrak 直连 → 云镜像 → 用户缓存 /
// 内置快照）+ 主进程内按组建 satrec（satrecs / positions，给干扰分析等服务用）。
// 离线优先：缓存先出、联网在后；直连走 netFetch（优先 Electron net：系统代理 / 单位审计网关 / 热点慢链路）。
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const netFetch = require('./netFetch')
const ommCloud = require('./ommCloud')   // 众包云镜像（腾讯云 COS）：屏蔽 celestrak 的网络靠它兜底
const log = require('./ommLog')          // 取数链路的操作明细 → 主进程 console + 底部「日志」窗格
// OMM CSV 解析：与渲染端 viz/constellation/tle.js 的 parseOMMCsv 同源同结果，勿另写一份
const { parseOMMCsv } = require('./customSats')
// SATCAT 编目 CSV 的有效性判据：与 scripts/fetch-omm-snapshot.mjs、ommCacheFirst 测试共用同一份实现
const { validSatcat } = require('../../packages/core/utils/satcatValid.js')
const { fmtBytes, fmtSec, fmtTime } = log

// 直连 CelesTrak：无进展 30 s 判断开；总时限 3 min 兜慢滴（热点 / 单位出口限速下 active 组约 5 MB 要走一两分钟）
const DIRECT_IDLE_MS = 30000
const DIRECT_MAX_MS = 3 * 60_000

// ---- 直连纪律（CelesTrak usage-policy.php 2026-05-22 版 + gp-data-formats.php，2026-10-17 核）----
// 原文要点：收到任何非 200 立即停止查询；403 / 404 重复请求结果不会变；2026-03-26 起每个更新周期
// （GP 约 2 h）只给一次，同周期重复请求回 403「GP data has not updated since your last successful
// download of GROUP=…」；HTTP 错误（301 / 403 / 404）2 h 内满 50 次，出口 IP 进防火墙、须人工复核才放出 ——
// 封的是出口 IP，同一单位出口下所有同事共用这 50 次。故：
//   · 有 HTTP 响应的非 200 → 叫停该组全部直连（不再试主端点、不转补充端点），交云镜像 / 本地；
//   · 本次运行累计 HTTP_LOCK_AT 次非 200，或碰到站点级拒绝（非「未更新」的 403 / 429 / 5xx）→ 本次运行全部停直连；
//   · 只有连接层失败（超时 / 连不上 / 正文被掐断）才重试，按 NET_BACKOFF_MS 退避；
//   · 同时在飞至多 DIRECT_CONCURRENCY 个：渲染端「全部卫星」一次并发要 16 组、SSA 强刷再加 SATCAT，
//     不排队的话非 200 成排同时落地，全局计数拦不住已经发出去的那一批。
const HTTP_LOCK_AT = 5
const NET_BACKOFF_MS = [1000, 2000, 4000]   // 第 n 次退避取第 n 项，超出取末项
const DIRECT_CONCURRENCY = 2
// 同周期重复请求的 403 正文（仓库根被 gitignore 的 starlink.csv 即一份实样，中间带换行）
const NOT_UPDATED_RE = /\bnot\s+(?:been\s+)?updated\s+since\s+your\s+last\b/i
const LAST_DL_RE = /\bat\s+(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)\s*UTC\b/i
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

// 非 GP 数据集：走与星历分组【同一条】四级链路（当日缓存 → CelesTrak 直连 → 云镜像 → 本地缓存/内置快照）、
// 同一个日志窗格、同一套当日记账与熔断，只有 URL / 判据 / 标签不同。
// SATCAT 是全量编目不是星历：没有 MEAN_MOTION 列（判据另给），也没有补充端点（sup-gp.php 只发星历）——
// 故 SUP_FILE 不给它加条目，fetchCsvOnce 里那段补充端点靠 `SUP_FILE[key]` 为 undefined 天然跳过。
// badWhy = 导入替换时的报错文案（星历那句「缺 MEAN_MOTION 列」对编目文件是错的）。
const DATASETS = {
  satcat: {
    url: 'https://celestrak.org/pub/satcat.csv',
    label: 'SATCAT 卫星编目',
    valid: validSatcat,
    badWhy: '不是有效的 SATCAT 编目 CSV（表头缺 NORAD_CAT_ID / OPS_STATUS_CODE 等列，或行数不足）'
  }
}
// 本服务认得的键 = GP 分组 ∪ 数据集（三处「未知键」守卫共用）。
// satrecs() 那处守卫【不】改：编目里没有根数，SATCAT 本就不该进 SGP4。
const known = (k) => !!GROUP_QUERY[k] || !!DATASETS[k]
const csvUrl = (k) => (DATASETS[k] ? DATASETS[k].url : `https://celestrak.org/NORAD/elements/gp.php?${GROUP_QUERY[k]}&FORMAT=csv`)
const supCsvUrl = (k) => `https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=${SUP_FILE[k]}&FORMAT=csv`
// 直连日志里的端点名：GP 打 gp.php + 查询串，数据集打自己的路径（satcat 即 pub/satcat.csv）
const epName = (k) => (DATASETS[k] ? DATASETS[k].url.replace(/^https?:\/\/[^/]+\//, '') : `gp.php · ${GROUP_QUERY[k]}`)

// 日志用中文分组名（与 src/pages/ConstellationMap3D.vue 的 GROUPS 标签逐字一致，改一处要同步）
const GROUP_LABEL = {
  starlink: 'Starlink', oneweb: 'OneWeb', kuiper: 'Kuiper', gps: 'GPS', beidou: '北斗', galileo: 'Galileo',
  qianfan: '千帆星座', guowang: '中国星网', geo: 'GEO', glonass: 'GLONASS', o3b: 'O3b', iridium: '铱星',
  globalstar: 'Globalstar', stations: '空间站', planet: 'Planet', spire: 'Spire', active: '全部在轨'
}
const GL = (k) => GROUP_LABEL[k] || (DATASETS[k] && DATASETS[k].label) || k
// 数据来源在日志里的统一叫法（offlineBest 的 source）
const SRC_NAME = { cache: '本地历史缓存', bundled: '随安装包内置的星历快照' }

module.exports = function createOmm(getCore) {
  const groups = {} // group -> [{ name, satrec }]（satrecs() 填，positions() / peek() 读）

  function cacheDir() {
    const base = process.env.SATSIM_DATA_DIR ||
      path.join(require('electron').app.getPath('userData'), 'data')
    const d = path.join(base, 'omm')
    fs.mkdirSync(d, { recursive: true })
    return d
  }

  // 返回 { text, why, kind, status, notUpdated }：text 为正文（失败时 null），why 为失败原因短语，直接进日志给用户看。
  // kind 区分失败层级，供熔断与直连纪律用：'net'=连接层失败（超时/连不上/正文被掐断，站点实际不可用）、
  // 'http'=有 HTTP 响应但非 200（网络是通的，CelesTrak 拒了这一次）、''=200。status：HTTP 状态码，连接层失败为 0。
  // notUpdated：403 且正文是「自上次成功下载以来未更新」—— 同周期重复请求的常规答复，不是故障，单独措辞。
  // 其余非 200 摘正文首行进 why（CelesTrak 的 403 正文写明拒绝原因，政策要求交给人看）；网页不摘。
  // 非 200 也要等正文收完（或被掐断 / 超时）才落地 —— 兜底计时一直盖到正文结束，见 netFetch。
  async function httpGetText(url) {
    const httpWhy = (code, body) => {
      const s = body ? body.toString('utf8', 0, 2048) : ''
      const line = /^\s*</.test(s) ? '' : (s.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '')
      return `HTTP ${code}${line ? ' · ' + (line.length > 120 ? line.slice(0, 120) + '…' : line) : ''}`
    }
    try {
      const r = await netFetch.request(url, { headers: { 'User-Agent': 'satsim-desktop' }, idleMs: DIRECT_IDLE_MS, maxMs: DIRECT_MAX_MS })
      if (r.status !== 200) {
        const body = r.status === 403 && r.body ? r.body.toString('utf8', 0, 4096) : ''
        if (NOT_UPDATED_RE.test(body)) {
          const m = LAST_DL_RE.exec(body), t = m ? Date.parse(m[1].replace(' ', 'T') + 'Z') : NaN
          return { text: null, why: `HTTP 403 · 数据未更新${Number.isFinite(t) ? `（本出口 IP 上次成功下载于 ${fmtTime(t)}）` : ''}`, kind: 'http', status: 403, notUpdated: true }
        }
        return { text: null, why: httpWhy(r.status, r.body), kind: 'http', status: r.status, notUpdated: false }
      }
      return { text: r.body.toString('utf8'), why: '', kind: '', status: 200, notUpdated: false }
    } catch (e) {
      // 响应头已到（非 200）后才断的，网络照样算通；200 的正文被掐断（防火墙中途重置）按连接层失败计
      const http = !!(e.status && e.status !== 200)
      const why = e.kind === 'timeout' ? `连接超时 · ${e.message}` : e.kind === 'cut' ? e.message : `连接失败 · ${e.code || e.message}`
      return { text: null, why: http ? `HTTP ${e.status}（${why}）` : why, kind: http ? 'http' : 'net', status: http ? e.status : 0, notUpdated: false }
    }
  }

  const csvCacheFile = (k) => path.join(cacheDir(), `csv_${k}.csv`)

  const valid = (t) => t && /MEAN_MOTION/i.test(t)
  // 判据按键分派：GP 分组一律走上面那条正则（逐位不变），DATASETS 各带各的（SATCAT 见 satcatValid.js）
  const validOf = (k) => (DATASETS[k] ? DATASETS[k].valid : valid)
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
    try { const gz = path.join(d, `csv_${key}.csv.gz`); if (fs.existsSync(gz)) { const t = zlib.gunzipSync(fs.readFileSync(gz)).toString('utf8'); if (validOf(key)(t)) return { text: t, time, count: (g && g.count) || csvCount(t) } } } catch {}
    try { const t = fs.readFileSync(path.join(d, `csv_${key}.csv`), 'utf8'); if (validOf(key)(t)) return { text: t, time, count: csvCount(t) } } catch {}
    return null
  }
  // 离线兜底：在「用户缓存」与「内置快照」间取更新的一版（有更新用更新）。返回 { text, fetchedAt, source } 或 null。
  // ★先比时间戳、只读赢的那一份正文：两份都读出来只为比一个时间太贵 —— active 组明文约 5MB，
  // 而「缓存优先即时出图」那条路（cacheOnly）要一口气过 17 组，白读 + 白解压一遍能把纯读盘的这一档
  // 也拖成秒级，而这一档存在的全部意义就是别让用户等。赢家读出来是坏的（截断/非 OMM）才回头读另一份。
  function offlineBest(key) {
    const cf = csvCacheFile(key)
    const readCache = () => { try { const c = fs.readFileSync(cf, 'utf8'); if (validOf(key)(c)) return { text: c, fetchedAt: cacheMtime(cf), source: 'cache' } } catch {} ; return null }
    const readBun = () => { const b = readBundled(key); return b ? { text: b.text, fetchedAt: b.time, source: 'bundled' } : null }
    // ★ 时间戳一律走 msOf：不能写 Date.parse(x || 0) —— 缺时间时那是 Date.parse("0")，V8 把它
    //   解析成 2000-01-01（946656000000）而不是 NaN，于是「没有缓存」被当成「缓存是 2000 年的」，
    //   下面按 0 判空的分支全部失效（现结果碰巧不受影响，因为两侧同一套兜底，但这是颗雷）。
    const msOf = (v) => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : 0 }
    const ct = msOf(cacheMtime(cf))   // 用户缓存落盘时间（无缓存 → 0）
    const man = bundledManifest()
    const bg = man && man.groups && man.groups[key]
    const bTime = (bg && bg.generatedAt) || (man && man.generatedAt) || null
    const bt = hasBundled(key) ? msOf(bTime) : 0   // 内置快照生成时间（无该组 / 无 manifest → 0）
    if (ct && bt) return bt > ct ? (readBun() || readCache()) : (readCache() || readBun())
    if (bt && !ct) return readBun() || readCache()
    return readCache() || readBun()   // 只有缓存、或两边时间都读不出来：按原口径依次试
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
    markTried(Object.keys(GROUP_QUERY).concat(Object.keys(DATASETS)))   // 同一个 celestrak.org：数据集一并记账
    log.emit(`星历：CelesTrak 连续 ${_netFails} 次连接层失败，判定本机当前网络不可达 —— 本次运行剩余分组直接走云镜像，今日不再重试直连（重启软件的次日会重新探测）`, 'warn')
  }

  // 非 200 计数闸（直连纪律见文件头）：本次运行累计 HTTP_LOCK_AT 次非 200（「未更新」的 403 也算 ——
  // CelesTrak 的防火墙只数状态码、不看正文），或一次站点级拒绝 → 本次运行全部分组停直连，并把全部分组记账为
  // 今天已试过（下次启动也不自动再连）。与熔断是两回事：熔断管「连不上」，用户强刷可清；这里管「连上了但被拒」，
  // 强刷【不】清 —— SSA 窗口一次强刷就是 18 组并发，清了又是成排的 403。重启软件才重新计数。
  let _httpErrs = 0, _httpLock = false
  function noteHttp(r) {
    _httpErrs++
    const hard = (r.status === 403 && !r.notUpdated) || r.status === 429 || r.status >= 500
    if (_httpLock || (!hard && _httpErrs < HTTP_LOCK_AT)) return
    _httpLock = true
    markTried(Object.keys(GROUP_QUERY).concat(Object.keys(DATASETS)))
    log.emit(`星历：CelesTrak ${hard ? `返回 ${r.why}` : `本次运行已累计 ${_httpErrs} 次非 200 响应`} —— 本次运行停止直连，剩余分组直接走云镜像，今日不再自动直连`, 'warn')
  }
  // 跳过 / 中断直连时日志里的原因（三道闸各一句）
  const skipWhy = () => (_httpLock ? `本次运行 CelesTrak 已返回 ${_httpErrs} 次非 200 响应`
    : _breakerOpen ? '本次运行已判定 CelesTrak 不可达' : '今天已完整试过 CelesTrak 直连')

  // 并发闸：同时在飞的直连至多 DIRECT_CONCURRENCY 个，每次应答都在这里记账（熔断 + 非 200 计数）。
  // 拿到名额后先复查叫停条件 —— 排队期间计数闸 / 熔断可能已落，落了就不再发（返回 null）。
  // ★先记账、后交名额：反过来的话，下一个等待者在这一次的非 200 计上之前就已复查放行，阈值会多漏一个。
  // 名额由出队方直接转交给下一个等待者，_active 不变。
  let _active = 0
  const _waiters = []
  async function directGet(url, stopped) {
    if (_active < DIRECT_CONCURRENCY) _active++
    else await new Promise((r) => _waiters.push(r))
    try {
      if (stopped()) return null
      const r = await httpGetText(url)
      noteNet(r.kind)
      if (r.kind === 'http') noteHttp(r)
      return r
    } finally {
      const next = _waiters.shift()
      if (next) next(); else _active--
    }
  }

  // 取某组 OMM CSV：返回 { text, fetchedAt, source }。fetchedAt 恒为缓存文件 mtime（= 该数据实际从 CelesTrak 下载落盘的时间），
  // 而非“此刻”——这样复用今日/旧缓存时显示的也是真实下载时间。本地有“今天”的缓存 → 直接用（一天一次）；
  // 否则联网（主端点至多 3 次→补充端点至多 2 次；只有连接层失败才重试，非 200 即停该组直连，见文件头直连纪律）
  // → 命中落盘 + 众包回传云镜像；
  // 直连全失败 → 云镜像（腾讯云 COS，别人今天传上去的那份；国内不被墙）→ 本地缓存 / 内置快照（离线优先）。
  // source 标明这一份到底是从哪条腿拿到的：'today' 当日缓存 / 'network' 直连 / 'cloud' 云镜像 /
  // 'cache' 用户缓存 / 'bundled' 内置快照 —— 调用方（如空间态势窗口的数据时间读数）要如实显示来源。
  async function fetchCsvOnce(key, opts = {}) {
    if (!known(key)) throw new Error('unknown group: ' + key)
    const cf = csvCacheFile(key)
    const tag = `星历「${GL(key)}」：`   // 日志前缀，全链路统一，便于按星座检索
    // 量词随数据集分档：GP 组数的是卫星（颗），SATCAT 数的是空间目标（条）—— 编目里碎片与
    // 火箭体占大半，一律说「颗」是错的。其余措辞不分档（同一条链路，按前缀检索得到同一组行）。
    const unit = DATASETS[key] ? ' 条' : ' 颗'
    if (opts.force) { _netFails = 0; _breakerOpen = false }   // 用户显式刷新：清熔断、绕过所有闸门，硬走一遍全链路（非 200 计数闸除外）
    // 一天一次：缓存文件是今天写的就直接用，不再联网
    try {
      const st = opts.force ? null : fs.statSync(cf)
      if (st && isToday(st.mtime)) {
        const c = fs.readFileSync(cf, 'utf8')
        if (validOf(key)(c)) {
          log.emit(`${tag}命中当日本地缓存 —— ${csvCount(c)}${unit} · ${fmtBytes(c.length)} · 数据时间 ${fmtTime(st.mtime)}`)
          return { text: c, fetchedAt: st.mtime.toISOString(), source: 'today' }
        }
      }
    } catch {}
    // 仅取缓存（启动即时渲染用）：不联网，取「用户缓存 / 内置快照」更新的一版；都无 → null 交调用方后台联网。
    if (opts.cacheOnly) {
      const best = offlineBest(key)
      if (best) {
        log.emit(`${tag}先以${SRC_NAME[best.source]}即时渲染（${csvCount(best.text)}${unit} · 数据时间 ${fmtTime(best.fetchedAt)}），随后后台联网刷新`)
        return { text: best.text, fetchedAt: best.fetchedAt, source: best.source }
      }
      return null
    }

    const t0 = Date.now()
    // 本机有没有可回落的数据（只探文件存在，不读正文）：没有就必须硬试到底，否则首启即离线的用户永远拿不到星历。
    const local = hasLocal(key)
    // 跳过 CelesTrak 直连的三种情形（都【只跳直连】，云镜像与本地回落照常）：
    //   ① 非 200 计数闸：本次运行已被 CelesTrak 拒够了 —— 无本地兜底、强刷也不破例（再连只会多攒一次错误）；
    //   ② 熔断：本次运行已判定 CelesTrak 连接层不可达；③ 今天已完整试过一轮直连（当时没拿到更新数据）。
    const skipDirect = _httpLock || (!opts.force && local && (_breakerOpen || triedToday(key)))
    // 中断重试：计数闸一落即停；熔断的前提是「有本地兜底」——无兜底时哪怕已判定不可达也要把机会用完。
    const bail = () => _httpLock || (_breakerOpen && local && !opts.force)
    let text = null, why = '', halt = null   // halt：叫停本组直连的那次非 200 响应
    if (skipDirect) {
      log.emit(`${tag}${skipWhy()}，跳过直连，直接查云镜像`)
    } else {
      log.emit(`${tag}本地无当日数据，开始连接 CelesTrak 主端点（${epName(key)}）`)
      // 一个端点至多 max 次，返回实际发出的请求数。只有连接层失败才退避再试（主端点与补充端点共用一条退避序列）；
      // 非 200 → 叫停本组全部直连；200 但内容无效 → 不再要这一端点（CelesTrak 已记下本周期这一次下载，再要只换来 403）。
      let backoffs = 0, lastNet = false
      const tryEndpoint = async (url, max) => {
        let n = 0
        while (n < max && !halt && !bail()) {
          if (lastNet) { await sleep(NET_BACKOFF_MS[Math.min(backoffs++, NET_BACKOFF_MS.length - 1)]); if (bail()) break }
          const r = await directGet(url, bail)   // 熔断与非 200 计数已在闸里记过账
          if (!r) break
          n++
          text = r.text; why = r.why; lastNet = r.kind === 'net'
          if (r.kind === 'http') halt = r; else if (!lastNet) break
        }
        return n
      }
      // 端点没拿到有效数据时的那一行：被叫停 / 没发出去（排队或退避期间闸落了）/ 试满了
      const failLog = (ep, n) => {
        if (validOf(key)(text)) return
        if (halt) log.emit(`${tag}CelesTrak ${ep}${halt.notUpdated ? '答复' : '返回'} ${halt.why}，停止该组直连`, halt.notUpdated ? 'info' : 'warn')
        else if (!n) log.emit(`${tag}${skipWhy()}，停止直连`)
        else log.emit(`${tag}CelesTrak ${ep} ${n} 次尝试均失败（${why || '返回内容非有效 OMM'}）`, 'warn')
      }
      failLog('主端点', await tryEndpoint(csvUrl(key), 3))
      // 补充端点同样在 celestrak.org：熔断已开（=根本连不上）时再试 2×30s 是纯浪费；主端点回了非 200 也不转（非 200 即停）
      if (!validOf(key)(text) && !halt && !bail() && SUP_FILE[key]) {
        log.emit(`${tag}转 CelesTrak 补充星历端点（sup-gp.php · FILE=${SUP_FILE[key]}，与主端点限流独立）`)
        failLog('补充端点', await tryEndpoint(supCsvUrl(key), 2))
      }
      markTried(key)   // 无论结果：本组今天已完整试过直连 —— 下次启动不再重付这段超时（次日自动过期）
    }
    if (validOf(key)(text)) {
      try { fs.writeFileSync(cf, text) } catch (e) { log.emit(`${tag}缓存写入失败（${e.message}），本次数据仅在内存中`, 'warn') }
      log.emit(`${tag}CelesTrak 直连获取成功 —— ${csvCount(text)}${unit} · ${fmtBytes(text.length)} · 耗时 ${fmtSec(Date.now() - t0)}，已写入本地缓存`)
      // 众包：本机拿到了新数据 → best-effort 回传云镜像（云端那份还够新则自动跳过），供屏蔽 celestrak 的用户兜底。
      // 不 await：上传慢/失败都不该拖住星座渲染。
      ommCloud.maybeUpload(key, text, GL(key), validOf(key)).catch(() => {})
      return { text, fetchedAt: cacheMtime(cf) || new Date().toISOString(), source: 'network' }
    }
    // 直连失败/被跳过 → 云镜像兜底。先算本地最优，把它的时间交给云端做闸门：云端不比本地新就不下载（省流量，也不用旧盖新）。
    const best = offlineBest(key)
    const cloud = await ommCloud.download(key, { newerThan: opts.force ? null : (best && best.fetchedAt), label: GL(key), valid: validOf(key) })
    if (cloud) {
      // 强制刷新时上面不设闸（照样把云端那份取回来），落盘前补比一次：云端不比本地最优新，就保留本地 ——
      // 否则一次强刷就把今早直连拿到的新星历换成云上几天前的旧件，mtime 还被改成那份旧时间
      const msOf = (v) => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : 0 }
      if (best && msOf(cloud.fetchedAt) <= msOf(best.fetchedAt)) {
        log.emit(`${tag}云镜像版本 ${fmtTime(cloud.fetchedAt)} 不新于本地 ${fmtTime(best.fetchedAt)}，保留${SRC_NAME[best.source]} —— ${csvCount(best.text)}${unit}`)
        return { text: best.text, fetchedAt: best.fetchedAt, source: best.source }
      }
      // 落盘缓存，并把 mtime 改成云端那份的上传时间：既让「今日缓存」判据成立（当天不再反复联网），
      // 界面显示的「OMM 下载时间」也如实反映数据自身的时间，而不是本机取回的此刻。
      let cached = true
      try { fs.writeFileSync(cf, cloud.text); const t = new Date(cloud.fetchedAt); fs.utimesSync(cf, t, t) } catch { cached = false }
      log.emit(`${tag}改用云镜像数据 —— ${csvCount(cloud.text)}${unit} · 数据时间 ${fmtTime(cloud.fetchedAt)} · 全程耗时 ${fmtSec(Date.now() - t0)}${cached ? '，已写入本地缓存' : ''}`)
      return { text: cloud.text, fetchedAt: cloud.fetchedAt, source: 'cloud' }
    }
    // 云镜像也拿不到 → 静默回落本地：用户缓存 / 内置快照，取更新的一版（无网设备靠内置快照兜底）。
    if (best) {
      // CelesTrak 答复「自本出口上次成功下载以来未更新」：本周期再要也是这句，不是故障 —— 有用户缓存就不报警告
      if (halt && halt.notUpdated) log.emit(`${tag}CelesTrak 答复数据未更新，沿用${SRC_NAME[best.source]} —— ${csvCount(best.text)}${unit} · 数据时间 ${fmtTime(best.fetchedAt)}`, best.source === 'cache' ? 'info' : 'warn')
      else log.emit(`${tag}联网与云镜像均不可用，回落${SRC_NAME[best.source]} —— ${csvCount(best.text)}${unit} · 数据时间 ${fmtTime(best.fetchedAt)}（星历越旧，轨道位置误差越大）`, 'warn')
      return { text: best.text, fetchedAt: best.fetchedAt, source: best.source }
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
    const probe = (key) => {
      const cf = csvCacheFile(key)
      let exists = false, mtime = null, count = 0, source = 'none'
      try { const st = fs.statSync(cf); exists = true; source = 'cache'; mtime = st.mtime.toISOString(); count = csvCount(fs.readFileSync(cf, 'utf8')) } catch {}
      if (!exists) {
        const b = readBundled(key)
        if (b) { source = 'bundled'; count = b.count || 0; mtime = b.time || null }
      }
      return { exists, source, mtime, count }
    }
    const rows = Object.keys(GROUP_QUERY).map((key) => ({ key, file: `csv_${key}.csv`, ...probe(key) }))
    // 非星历数据集（SATCAT）：缓存/内置那套口径完全一样，只是它不是星座组 —— 排在末尾并带 kind，
    // 让文件管理能把它从星座表里拆出来单独成节（GP 行不带 kind，判据就是有没有这个字段）。
    // count 与 GP 同口径：CSV 数据行数（satcat 即编目条目数，含碎片与火箭体）。
    for (const key of Object.keys(DATASETS)) rows.push({ key, kind: key, file: `csv_${key}.csv`, ...probe(key) })
    return rows
  }
  // 读出某组 CSV 原文（导出用）：优先用户缓存，无则回落内置快照；都无返回 null。
  function readCsvRaw(key) {
    if (!known(key)) throw new Error('unknown group: ' + key)
    try { return { text: fs.readFileSync(csvCacheFile(key), 'utf8'), file: `csv_${key}.csv` } } catch {}
    const b = readBundled(key)
    if (b) return { text: b.text, file: `csv_${key}.csv`, bundled: true }
    return null
  }
  // 导入并替换某组 OMM CSV：按该键自己的判据校验（GP 组＝含 MEAN_MOTION 表头，SATCAT 见 satcatValid.js），
  // 写入缓存覆盖，使该星座（或该数据集）改用用户文件。
  function writeCsvRaw(key, text) {
    if (!known(key)) throw new Error('unknown group: ' + key)
    if (!validOf(key)(text)) throw new Error((DATASETS[key] && DATASETS[key].badWhy) || '不是有效的 OMM CSV（缺 MEAN_MOTION 列）')
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

  // 已载入某组的原始 [{name, satrec}]。给主进程内的其他服务用（干扰分析要拿 satrec 做
  // 逐时刻传播），不经 IPC——satrec 是带函数与内部状态的对象，序列化不过去也不该过去。
  function peek(group) { return groups[group] || null }

  /**
   * 按组取 satrec（主进程内用）。
   *
   * 整个 app 的星座数据走的是 csvCacheFile(group)（CelesTrak OMM CSV）—— 渲染端 viz/constellation/tle.js
   * 调 omm:csv 拿 CSV 后在渲染端自己建 satrec，主进程的 groups[] 不会顺带被填上。
   * （早年那条读 <group>.tle、取不到就把组名改写成 'sample' 的 3LE 老路径 —— 干扰分析首版就栽在它上面 ——
   * 2026-10 已整条删除：无调用方，且组名直接拼路径可穿越写 *.tle。）
   *
   * 本函数走与 app 其余部分同一条数据源：fetchCsv(cacheOnly) → 用户缓存 / 内置快照择新者
   * （offlineBest），无网也能用；拿不到再按需联网。解析后填进 groups[group]，
   * 使 peek() 与 positions() 一并可用。
   *
   * @returns {Promise<{ok:boolean, count:number, source?:string, fetchedAt?:string, error?:string}>}
   */
  async function satrecs(group, opts = {}) {
    const sgp4 = getCore().sgp4
    if (!sgp4) return { ok: false, count: 0, error: 'SGP4 引擎未就绪' }
    if (!GROUP_QUERY[group]) return { ok: false, count: 0, error: '未知星座组：' + group }
    if (!opts.force && groups[group] && groups[group].length) {
      return { ok: true, count: groups[group].length, source: 'memory' }
    }
    let res = null
    try { res = await fetchCsv(group, { cacheOnly: true }) } catch (e) { res = null }
    if (!res && (opts.online || opts.force)) {
      try { res = await fetchCsv(group, { force: !!opts.force }) } catch (e) { res = null }
    }
    const text = res && (typeof res === 'string' ? res : res.text)
    if (!text) {
      return { ok: false, count: 0, error: `本地无「${GL(group)}」星历缓存，也无内置快照。` }
    }
    const recs = parseOMMCsv(text)
    const list = []
    for (const r of recs) {
      try { list.push({ name: r.name, satrec: sgp4.omm2satrec(r) }) } catch (e) { /* 坏记录跳过 */ }
    }
    if (!list.length) return { ok: false, count: 0, error: '星历解析后为空' }
    groups[group] = list
    return { ok: true, count: list.length, source: (res && res.source) || 'cache', fetchedAt: (res && res.fetchedAt) || null }
  }

  return { positions, fetchCsv, listCsv, readCsvRaw, writeCsvRaw, peek, satrecs, hasLocal }
}
