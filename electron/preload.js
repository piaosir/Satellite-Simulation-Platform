const { contextBridge, ipcRenderer } = require('electron')

// ── 星侧太阳侵入的渲染端半截（api.sunOutage.satIntrusion）──
// ① GRD 树天线键 folder|name → {found, file, cfg}：卫星树与各天线设置由 3D 页持久化在 localStorage('globe3d/settings').grd
//    （同源各窗共享，主进程读不到），口径同 src/model/satSources.grdTreeSats 与 useGrdCoverage.getState —— 只有已存盘的导入天线带 file。
//    cfg 只带取值吃的三项：增益偏置 gainOffset、存活波束 keptSets（原始 set 序号）、旋转 Rot（yaw）。
// ② 分段：一次最多 SAT_SUN_SEG 拍（60 s 步长约半年），逐段 invoke 再拼回 —— 拍与拍互不相干，拼接结果与一次算完逐位相同；
//    段间看代号：同 jobKey 的新请求（或 cancelSatIntrusion）一来就停，回 {ok:false, canceled:true}。
const SAT_SUN_SEG = 262144
const satSunGen = new Map()
function grdAntOf(key) {
  let g = null
  try { g = JSON.parse((typeof localStorage !== 'undefined' && localStorage.getItem('globe3d/settings')) || 'null') } catch { g = null }
  g = g && typeof g === 'object' ? g.grd : null
  for (const s of (g && Array.isArray(g.sats) ? g.sats : [])) {
    for (const a of (s && Array.isArray(s.antennas) ? s.antennas : [])) {
      if (!a || `${s.folder}|${a.name}` !== key) continue
      if (!a.imported || !a.file) return { found: true, file: null }
      const c = g.cfgs && typeof g.cfgs === 'object' ? g.cfgs[key] : null
      const cfg = {}
      if (c && typeof c === 'object') {
        if (Number.isFinite(c.gainOffset)) cfg.gainOffset = c.gainOffset
        if (Number.isFinite(c.yaw)) cfg.yaw = c.yaw
        if (Array.isArray(c.keptSets)) cfg.keptSets = c.keptSets.filter(Number.isInteger)
      }
      return { found: true, file: String(a.file), cfg }
    }
  }
  return { found: false }
}
function mergeSatSun(parts, n) {
  if (parts.length === 1) return parts[0]
  const cat = (k) => { const out = new Float32Array(n); let at = 0; for (const r of parts) { out.set(r[k], at); at += r.n } return out }
  const counts = {}, f107 = [], seen = new Set()
  let worst = null, at = 0, ms = 0
  for (const r of parts) {
    const w = r.worst
    if (w && (!worst || w.dT > worst.dT)) worst = Object.assign({}, w, { i: w.i + at })
    for (const k of Object.keys(r.counts || {})) counts[k] = (counts[k] || 0) + (Number(r.counts[k]) || 0)
    for (const f of r.f107 || []) { const d = f.date == null ? '' : f.date; if (!seen.has(d)) { seen.add(d); f107.push(f) } }
    ms += Number(r.ms) || 0
    at += r.n
  }
  return Object.assign({}, parts[0], { n, dT: cat('dT'), gtLossDb: cat('gtLossDb'), offAxisDeg: cat('offAxisDeg'), visibleFrac: cat('visibleFrac'), worst, counts, f107, ms })
}
async function satIntrusion(o) {
  const p = o || {}
  const jobKey = typeof p.jobKey === 'string' && p.jobKey ? p.jobKey : 'default'
  const gen = (satSunGen.get(jobKey) || 0) + 1
  satSunGen.set(jobKey, gen)
  let s = p.samples
  if (Array.isArray(s)) s = Float64Array.from(s)
  const pattern = p.pattern ? JSON.parse(JSON.stringify(p.pattern)) : undefined
  if (pattern && pattern.kind === 'grd' && !pattern.ant && !pattern.file && typeof pattern.key === 'string' && pattern.key.includes('|')) pattern.ant = grdAntOf(pattern.key)
  const base = { freqGHz: p.freqGHz, sysTempK: p.sysTempK, solarModel: p.solarModel, f107: p.f107, solarTemp: p.solarTemp, pattern, jobKey }
  const onProgress = typeof p.onProgress === 'function' ? p.onProgress : null
  const tell = (d, n) => { if (onProgress) { try { onProgress(d, n) } catch { /* 回调出错不影响计算 */ } } }
  const n = ArrayBuffer.isView(s) && !(s instanceof DataView) && s.length % 10 === 0 ? s.length / 10 : 0
  if (n <= SAT_SUN_SEG) {
    // 样本是别的大缓冲区的一截视图时先拷出来（结构化克隆按整块 ArrayBuffer 走）
    const samples = ArrayBuffer.isView(s) && (s.byteOffset || s.byteLength !== s.buffer.byteLength) ? s.slice() : s
    const r = await ipcRenderer.invoke('sunoutage:satIntrusion', Object.assign({}, base, { samples }))
    if (r && r.ok) tell(n, n)
    return r
  }
  const parts = []
  for (let a = 0; a < n; a += SAT_SUN_SEG) {
    if (satSunGen.get(jobKey) !== gen) return { ok: false, canceled: true, code: 'canceled', error: '已取消。' }
    const b = Math.min(n, a + SAT_SUN_SEG)
    const r = await ipcRenderer.invoke('sunoutage:satIntrusion', Object.assign({}, base, { samples: s.slice(a * 10, b * 10) }))
    if (!r || r.ok !== true) return r
    parts.push(r)
    tell(b, n)
  }
  return mergeSatSun(parts, n)
}

// ── 表格导出的线上形状（api.models.exportTable）──
// 小表照旧 JSON 深拷（Vue Proxy 过不了结构化克隆；typed array 行摊成普通数组）。大表（> TABLE_PACK_ROWS 行）按列打包：
// {n, columns:[每列一个]} —— 全是数（或空）的列用 Float64Array（空 = NaN），全是串（或空）的列 {join: 以 U+001F 连起来的长串}，
// 其余列普通数组（串 / 数 / null）。主进程 models.tableSource 都认，取格口径（tableCell：空 → null、非有限数 → null、数字列的数字串转数）不变。
const TABLE_PACK_ROWS = 2000
const TABLE_JOIN_SEP = '\u001f'
const jsonPlain = (x) => JSON.parse(JSON.stringify(x, (_k, v) => (ArrayBuffer.isView(v) && !(v instanceof DataView) ? Array.from(v) : v)))
function tableWire(o) {
  if (!o || typeof o !== 'object') return o
  const sheets = Array.isArray(o.sheets) ? o.sheets : null
  const big = (sh) => sh && typeof sh === 'object' && Array.isArray(sh.rows) && sh.rows.length > TABLE_PACK_ROWS
  if (!sheets || !sheets.some(big)) return jsonPlain(o)
  const out = jsonPlain(Object.assign({}, o, { sheets: [] }))
  out.sheets = sheets.map((sh) => {
    if (!big(sh)) return jsonPlain(sh)
    const { rows, ...rest } = sh
    const head = jsonPlain(rest)
    const cols = Array.isArray(head.cols) ? head.cols : []
    const n = rows.length
    head.n = n
    head.columns = cols.map((c, k) => {
      const key = c && (typeof c.key === 'string' || Number.isFinite(c.key)) ? String(c.key) : String(k)
      const get = (r) => { const x = rows[r]; return Array.isArray(x) || (ArrayBuffer.isView(x) && !(x instanceof DataView)) ? x[k] : (x && typeof x === 'object' ? x[key] : null) }
      const f = new Float64Array(n)
      let r = 0
      for (; r < n; r++) {
        const v = get(r)
        if (v == null || v === '') f[r] = NaN
        else if (typeof v === 'number') f[r] = v === 0 ? 0 : v          // −0 抹成 0（与 JSON 一致）
        else break
      }
      if (r === n) return f
      const a = new Array(n)
      let allStr = true
      for (let i = 0; i < n; i++) {
        const v = get(i)
        a[i] = v == null ? null : (typeof v === 'number' ? (Number.isFinite(v) ? (v === 0 ? 0 : v) : null) : (typeof v === 'string' ? v : String(v)))
        if (allStr && a[i] !== null && (typeof a[i] !== 'string' || a[i].includes(TABLE_JOIN_SEP))) allStr = false
      }
      // 全是串（或空）的列连成一个长串：几十万个小串逐个反序列化要在主进程里占几十 ms，一个长串只是一次拷贝（空 = ''，与 null 同为空格）
      return allStr ? { join: a.map((v) => (v === null ? '' : v)).join(TABLE_JOIN_SEP) } : a
    })
    return head
  })
  return out
}

// 安全桥：渲染进程通过 window.api.* 调用主进程能力，不直接暴露 Node。
contextBridge.exposeInMainWorld('api', {
  computeLink: (s, l) => ipcRenderer.invoke('link:compute', s, l),
  computeLinkNGSO: (s, l) => ipcRenderer.invoke('link:computeNGSO', s, l),
  satelliteAngle: (lat, lon, satLon) => ipcRenderer.invoke('link:angle', lat, lon, satLon),
  linkBudget: {
    open: () => ipcRenderer.invoke('linkbudget:open'),
    compute: (s, l) => ipcRenderer.invoke('link:compute', s, l),
    computeMode: (s, l, opt) => ipcRenderer.invoke('link:computeMode', s, l, opt),
    // 批量版：[{ sat, link, opt }] → 各行结果数组（口径同单条，只把 N 次往返压成 1 次）
    computeModeBatch: (list) => ipcRenderer.invoke('link:computeModeBatch', list),
    // 链路表实时预览（「地球站配置」格的 EIRP / G·T / 功放尾标）：一块行一次算完，每项按 engine 分派 GEO / NGSO 引擎，
    // 逐条口径同单条；主进程行间让出事件循环。令牌给「计算」优先用——点了「计算」就把在算那块取消掉
    previewBatch: (list, token) => ipcRenderer.invoke('link:previewBatch', list, token),
    previewCancel: (token) => ipcRenderer.send('link:previewCancel', token),
    // 参数扫描（可视化直角坐标系）：一次 IPC 跑完整段区间，回全部可绘输出量
    sweep: (spec) => ipcRenderer.invoke('link:sweep', spec),
    // 二维参数扫描（设计空间图）：x×y 网格一次跑完，回各输出量的场与可行裕度场
    sweep2D: (spec) => ipcRenderer.invoke('link:sweep2D', spec),
    // SLA 可用度档位扫描（单条 / 整表批量）：逐档钉住当前工作点重算，回各档的余量与占用
    slaScan: (spec) => ipcRenderer.invoke('link:slaScan', spec),
    slaScanBatch: (list) => ipcRenderer.invoke('link:slaScanBatch', list),
    outputDefs: () => ipcRenderer.invoke('link:outputDefs'),
    // NGSO：计算方式求解（切 NGSO 引擎、强制 ISL=0）+ 站星互视最差几何求解
    computeModeNGSO: (s, l, opt) => ipcRenderer.invoke('link:computeModeNGSO', s, l, opt),
    // 批量版（整表几何一次求 / 一组候选一次算）：口径与单条完全一致，只把 N 次往返压成 1 次
    computeModeNGSOBatch: (s, list, opt) => ipcRenderer.invoke('link:computeModeNGSOBatch', s, list, opt),
    // 再生式上行：计算方式求解（合计 C/N = 上行 C/(N+I)）+ 复用 NGSO 站星几何
    computeRegenUplink: (s, l, opt) => ipcRenderer.invoke('link:computeRegenUplink', s, l, opt),
    // 再生式下行：计算方式求解（合计 C/N = 下行 C/(N+I)；工作点 = 收信站 G/T）+ 复用 NGSO 站星几何
    computeRegenDownlink: (s, l, opt) => ipcRenderer.invoke('link:computeRegenDownlink', s, l, opt),
    // 再生式星间：计算（合计 C/N = 星间单跳 C/N；发射卫星 EIRP + 接收卫星 G/T）+ 两星几何求解
    computeRegenIsl: (s, l, opt) => ipcRenderer.invoke('link:computeRegenIsl', s, l, opt),
    // 再生式星间激光：第一性原理光学预算（P_rx 链 + 光子/bit 灵敏度）；几何复用 islGeometry（传光频算相干多普勒）
    computeRegenLaser: (p, opt) => ipcRenderer.invoke('link:computeRegenLaser', p, opt),
    // 端到端链路（多跳 / 混合转发）：整条链一次算完（分段 + 段内级联 + 端到端汇总）
    chainCompute: (chain) => ipcRenderer.invoke('link:chainCompute', chain),
    islGeometry: (opt) => ipcRenderer.invoke('link:islGeometry', opt),
    // 星间距离时间序列（时间轴上逐拍的星间距离/掠地高度/互视）：手动几何下「星间链路距离」工具用
    islRangeSeries: (opt) => ipcRenderer.invoke('link:islRangeSeries', opt),
    ngsoGeometry: (opt) => ipcRenderer.invoke('link:ngsoGeometry', opt),
    ngsoGeometryBatch: (opt) => ipcRenderer.invoke('link:ngsoGeometryBatch', opt),
    accessWindows: (opt) => ipcRenderer.invoke('link:accessWindows', opt),
    geoFill: (lat, lon) => ipcRenderer.invoke('link:geoFill', lat, lon),
    grdSample: (req) => ipcRenderer.invoke('link:grdSample', req),
    // 干扰分析用：逐波束值（少量站点）/ C/CCI 合成（整张场图，主进程内折成标量）
    grdSampleBeams: (req) => ipcRenderer.invoke('link:grdSampleBeams', req),
    grdSampleXpd: (req) => ipcRenderer.invoke('link:grdSampleXpd', req),
    grdSampleCci: (req) => ipcRenderer.invoke('link:grdSampleCci', req),
    // 导入方向图后取其波束数（并预编译 .grdbin）
    grdMeta: (file) => ipcRenderer.invoke('link:grdMeta', file),
    cities: () => ipcRenderer.invoke('link:cities'),
    // 分层城市库（中国按省份 / 国际按国家）：性能指标表与气象指标表的「典型城市」选点
    cityGroups: () => ipcRenderer.invoke('link:cityGroups'),
    searchCities: (kw) => ipcRenderer.invoke('link:searchCities', kw),
    baseband: () => ipcRenderer.invoke('link:baseband'),
    waterfall: (ctx) => ipcRenderer.invoke('link:waterfall', ctx),
    openConfig: () => ipcRenderer.invoke('linkbudget:openConfig'),
    // 关窗守卫：主进程拦截原生关闭动作后转发此事件；渲染进程问完用户再调 confirmClose() 才真正关闭
    onCloseRequested: (cb) => ipcRenderer.on('linkbudget:closeRequested', cb),
    confirmClose: () => ipcRenderer.invoke('linkbudget:confirmClose')
  },
  // NGSO 链路预算独立窗口的开窗/关窗守卫（计算/几何/导出/城市等能力复用上面的 linkBudget.*）
  ngso: {
    open: () => ipcRenderer.invoke('ngso:open'),
    onCloseRequested: (cb) => ipcRenderer.on('ngso:closeRequested', cb),
    confirmClose: () => ipcRenderer.invoke('ngso:confirmClose')
  },
  // 再生式链路预算独立窗口的开窗/关窗守卫（计算复用 linkBudget.computeRegenUplink / 几何复用 ngsoGeometry）
  regen: {
    open: () => ipcRenderer.invoke('regen:open'),
    onCloseRequested: (cb) => ipcRenderer.on('regen:closeRequested', cb),
    confirmClose: () => ipcRenderer.invoke('regen:confirmClose')
  },
  // 端到端链路预算独立窗口的开窗/关窗守卫（计算走 linkBudget.chainCompute，几何全部手填）
  e2e: {
    open: () => ipcRenderer.invoke('e2e:open'),
    onCloseRequested: (cb) => ipcRenderer.on('e2e:closeRequested', cb),
    confirmClose: () => ipcRenderer.invoke('e2e:confirmClose')
  },
  sunOutage: {
    open: () => ipcRenderer.invoke('suntool:open'),
    compute: (p) => ipcRenderer.invoke('sunoutage:compute', p),
    // 整表批量：[{lat,lon,satLon|orbit,diameter,customFreq,sysTemp,criterion,degThreshold,year,seasons}]
    //   → [{vernal, autumnal}]，未选的季为 null（不传 seasons 即两季，SLA 那条链路行为不变）
    computeBatch: (list) => ipcRenderer.invoke('sunoutage:computeBatch', list),
    exportExcel: (payload) => ipcRenderer.invoke('sunoutage:exportExcel', payload),
    exportWord: (payload) => ipcRenderer.invoke('sunoutage:exportWord', payload),
    exportIcs: (payload) => ipcRenderer.invoke('sunoutage:exportIcs', payload),
    // 太阳射电流量 F10.7 的数据时间与来源（顶栏读数）；refresh 为用户点读数时硬刷一遍全链路。
    // 计算本身不用这两条 —— F10.7 由主进程在算的时候按分点日现取，永不等网络。
    solarFlux: () => ipcRenderer.invoke('sunoutage:solarFlux'),
    solarFluxRefresh: () => ipcRenderer.invoke('sunoutage:solarFluxRefresh'),
    // 星侧太阳侵入（模型工作台「分析」页；契约见 register.js 的 sunoutage:satIntrusion）：
    //   {samples: Float64Array[N×10](t, 卫星 ECEF km, 视轴, up), freqGHz, pattern:{kind:'gauss', thetaB3dB}|{kind:'diameter', diameterM}|
    //    {kind:'grd', key:'folder|name'（挂点 antennaRef.id，这里就地解析成 GRD 文件与天线设置）| file, beamIndex?, pol?, peakDbi?, thetaB3dB?},
    //    sysTempK, solarModel?, f107?, solarTemp?, jobKey?, onProgress?(已算拍数, 总拍数)}
    //   → {ok, dT, gtLossDb, offAxisDeg, visibleFrac（Float32Array）, worst, counts, f107, grd, …} | {ok:false, error, code?}
    //   超过 262 144 拍自动分段（渲染端 200 万拍上限照收）；同窗同 jobKey（缺省 'default'）的新请求顶掉旧的 → 旧的回 {ok:false, canceled:true}
    satIntrusion: (o) => satIntrusion(o),
    // 取消在算的星侧太阳侵入（jobKey 缺省 'default'）→ 主进程有没有这么一个在算的任务
    cancelSatIntrusion: (jobKey) => {
      const k = typeof jobKey === 'string' && jobKey ? jobKey : 'default'
      satSunGen.set(k, (satSunGen.get(k) || 0) + 1)
      return ipcRenderer.invoke('sunoutage:satIntrusionCancel', k)
    },
    // 城市库（转发链路预算那条通道，与 rainAttenuation 同法）
    cities: () => ipcRenderer.invoke('link:cities'),
    searchCities: (kw) => ipcRenderer.invoke('link:searchCities', kw),
    cityGroups: () => ipcRenderer.invoke('link:cityGroups'),
    onCloseRequested: (cb) => ipcRenderer.on('suntool:closeRequested', cb),
    confirmClose: () => ipcRenderer.invoke('suntool:confirmClose')
  },
  // 干扰分析（C/I）独立窗口：C/ASI 邻星 · C/XPI 交叉极化 · C/CCI 同频复用 · NGSO 时变 CDF。
  // 纯只读——读三库（store.getLibrary）与 GRD（linkBudget.grd*），不写回任何库。
  // 站址联动 / 城市选址复用链路预算的 link:* 通道；出图走通用 exportFile。
  interference: {
    open: () => ipcRenderer.invoke('ci:open'),
    asi: (req) => ipcRenderer.invoke('ci:asi', req),
    xpi: (req) => ipcRenderer.invoke('ci:xpi', req),
    xpiTerm: (req) => ipcRenderer.invoke('ci:xpiTerm', req),
    cciPoint: (req) => ipcRenderer.invoke('ci:cciPoint', req),
    // NGSO 时变扫描：start 只负责启动，进度/结果经下面两个订阅推回（长任务不阻塞窗口）
    ngsoEstimate: (req) => ipcRenderer.invoke('ci:ngsoEstimate', req),
    ngsoStart: (req) => ipcRenderer.invoke('ci:ngsoStart', req),
    ngsoCancel: () => ipcRenderer.invoke('ci:ngsoCancel'),
    onNgsoProgress: (cb) => ipcRenderer.on('ci:ngsoProgress', (_e, p) => cb(p)),
    onNgsoDone: (cb) => ipcRenderer.on('ci:ngsoDone', (_e, p) => cb(p)),
    // 星历接入：复用平台既有星座数据，邻星轨位与 NGSO 星座都不必手抄
    groups: () => ipcRenderer.invoke('ci:groups'),
    // satIds 仅「我的卫星组」（sg:）需要、sats 仅「自定义星座」（cc:）需要：这两类都存在渲染端
    // localStorage，主进程看不到，成员 NORAD / 逐颗六根数一律由调用方带上
    loadGroup: (g, online, satIds, sats) => ipcRenderer.invoke('ci:loadGroup', g, online, satIds, sats),
    geoNeighbors: (req) => ipcRenderer.invoke('ci:geoNeighbors', req)
  },
  // 雨衰计算独立窗口（通用于各类卫星）：批量/单算例/曲线计算 + Excel 导出；
  // 经纬度自动填(降雨率/海拔)与城市选址复用链路预算的 link:* 通道；PNG 导出走通用 exportFile。
  rainAttenuation: {
    open: () => ipcRenderer.invoke('rain:open'),
    compute: (p) => ipcRenderer.invoke('rain:compute', p),
    computeBatch: (cases) => ipcRenderer.invoke('rain:computeBatch', cases),
    solveMultiSite: (cases, opt) => ipcRenderer.invoke('rain:solveMultiSite', cases, opt),
    sweep: (p, axis, range) => ipcRenderer.invoke('rain:sweep', p, axis, range),
    exportExcel: (payload) => ipcRenderer.invoke('rain:exportExcel', payload),
    geoFill: (lat, lon) => ipcRenderer.invoke('link:geoFill', lat, lon),
    cities: () => ipcRenderer.invoke('link:cities'),
    searchCities: (kw) => ipcRenderer.invoke('link:searchCities', kw),
    onCloseRequested: (cb) => ipcRenderer.on('rain:closeRequested', cb),
    confirmClose: () => ipcRenderer.invoke('rain:confirmClose')
  },
  // 性能指标表窗口（对地 / 对星 / 气象）：一根天线一窗、可多开。主进程只中继：
  //   主窗口侧 open / push / close / setTitle / list + onAct / onClosed；弹窗侧 self / act + onMsg。
  perfWin: {
    open: (o) => ipcRenderer.invoke('perfwin:open', o),
    push: (id, msg) => ipcRenderer.invoke('perfwin:push', id, msg),
    close: (id) => ipcRenderer.invoke('perfwin:close', id),
    setTitle: (id, title) => ipcRenderer.invoke('perfwin:setTitle', id, title),
    list: () => ipcRenderer.invoke('perfwin:list'),
    onAct: (cb) => ipcRenderer.on('perfwin:act', (_e, m) => cb(m)),
    onClosed: (cb) => ipcRenderer.on('perfwin:closed', (_e, m) => cb(m)),
    self: () => ipcRenderer.invoke('perfwin:self'),
    act: (msg) => ipcRenderer.invoke('perfwin:act', msg),
    onMsg: (cb) => ipcRenderer.on('perfwin:msg', (_e, m) => cb(m))
  },
  // 环境场图层（主窗口「环境场」视图）：ITU 环境数据整张等经纬栅格一次取回（Float32Array 直传）
  env: {
    defs: () => ipcRenderer.invoke('env:defs'),
    field: (key, opt) => ipcRenderer.invoke('env:field', key, opt)
  },
  // 实时/预报环境场（主窗口「实时气象」视图）。两个数据源各司其职，**口径不同别混**：
  //   场与站点模式值（estimate/load/field/points）走 NCEP GFS 栅格 —— 一次请求一整块 0.25° 网格，
  //     跟时间轴走，免费；
  //   obs 走和风，是**观测**，只有"现在"这一个时刻，且一站一次请求（按站计费），故只在用户点按钮时发。
  // 立方体留在主进程，渲染端只按帧取栅格（时钟换帧时每帧一次 IPC）。
  weather: {
    providers: () => ipcRenderer.invoke('weather:providers'),
    test: (which) => ipcRenderer.invoke('weather:test', which),
    defs: () => ipcRenderer.invoke('weather:defs'),
    estimate: (o) => ipcRenderer.invoke('weather:estimate', o),
    load: (o) => ipcRenderer.invoke('weather:load', o),
    meta: () => ipcRenderer.invoke('weather:meta'),
    field: (o) => ipcRenderer.invoke('weather:field', o),
    points: (o) => ipcRenderer.invoke('weather:points', o),   // 多站**模式**值，跟时间轴，免费
    obs: (o) => ipcRenderer.invoke('weather:obs', o),         // 多站**和风按点值**（本小时=观测 / 未来=逐小时预报；allowFetch=false 时只查缓存）
    usage: () => ipcRenderer.invoke('weather:usage'),
    clearCache: () => ipcRenderer.invoke('weather:clearCache'),
    onProgress: (cb) => ipcRenderer.on('weather:progress', (_e, p) => cb(p))
  },
  app: {
    deviceId: () => ipcRenderer.invoke('app:deviceId'),
    version: () => ipcRenderer.invoke('app:version')
  },
  // 自动更新（帮助 → 检查更新）：state 读主进程快照；check 立即检查（返回检查结束后的快照，
  // 下载进度经 onChanged 推送）；install 立即重启安装（仅已下载时有效）
  updater: {
    state: () => ipcRenderer.invoke('updater:state'),
    check: () => ipcRenderer.invoke('updater:check'),
    install: () => ipcRenderer.invoke('updater:install'),
    onChanged: (cb) => ipcRenderer.on('updater:changed', (_e, st) => cb(st))
  },
  // 激活状态（终端设备侧）：status 读本地缓存（快，不碰网络）；refresh 立即心跳 + 拉最新激活书；
  // onChanged 订阅主进程定时心跳发现的状态变化（管理端激活/撤销最迟一跳自动生效）
  activation: {
    status: () => ipcRenderer.invoke('activation:status'),
    refresh: () => ipcRenderer.invoke('activation:refresh'),
    onChanged: (cb) => ipcRenderer.on('activation:changed', (_e, st) => cb(st))
  },
  // 主窗口自定义标题栏：把原生窗口控制按钮（Windows 覆盖式）的配色更新为当前主题色
  win: {
    setOverlay: (opt) => ipcRenderer.invoke('window:setOverlay', opt)
  },
  share: {
    configured: () => ipcRenderer.invoke('share:configured'),
    send: (recipientId, payload) => ipcRenderer.invoke('share:send', recipientId, payload),
    inbox: (myId) => ipcRenderer.invoke('share:inbox', myId),
    remove: (myId, id) => ipcRenderer.invoke('share:delete', myId, id),
    // 发送到小程序：把当前绘制状态快照上传 COS，返回可在小程序输入的短密钥
    gxtSnapshot: (payload) => ipcRenderer.invoke('share:gxtSnapshot', payload),
    // 同一条通道的通名（putSnapshot 本就与内容语义无关，只是 PUT 一份 JSON）：
    // 覆盖快照 kind='gxt-snapshot'、链路配置/频率计划 kind='satsim-pack'（见 shared/miniPack.js）。
    // 主进程处理器不必改，故这里只是别名；老名保留，3D 页那条路一个字不动。
    putPack: (payload) => ipcRenderer.invoke('share:gxtSnapshot', payload),
    // 绑定投递（免密钥）：往小程序端的认证码信箱直投。密钥模式照旧并存 —— 绑定给常用的人，
    // 密钥给客户/临时协作。o = { pid, label, app, sync, name, payload }
    boxSend: (ch, o) => ipcRenderer.invoke('share:boxSend', ch, o),
    boxPeek: (ch, pid) => ipcRenderer.invoke('share:boxPeek', ch, pid),
    boxRevoke: (ch, pid, mid) => ipcRenderer.invoke('share:boxRevoke', ch, pid, mid)
  },
  store: {
    listHistory: () => ipcRenderer.invoke('store:history:list'),
    addHistory: (r) => ipcRenderer.invoke('store:history:add', r),
    deleteHistory: (id) => ipcRenderer.invoke('store:history:delete', id),
    clearHistory: () => ipcRenderer.invoke('store:history:clear'),
    // 配置库：首参一律是工作台命名空间 ns（geo/ngso/regen/e2e/rain），各窗只读写自己那份
    listConfigs: (ns) => ipcRenderer.invoke('store:config:list', ns),
    listAllConfigs: () => ipcRenderer.invoke('store:config:listAll'),
    saveConfig: (ns, cfg) => ipcRenderer.invoke('store:config:save', { ns, cfg }),
    deleteConfig: (ns, id) => ipcRenderer.invoke('store:config:delete', { ns, id }),
    reorderConfigs: (ns, ids) => ipcRenderer.invoke('store:config:reorder', { ns, ids }),
    // 展开 payload 而不是嵌一层：它常常是渲染端的响应式对象，展开后进 IPC 的是纯数据（结构化克隆过不了 Proxy）
    moveItem: (ns, payload) => ipcRenderer.invoke('store:config:move', { ns, ...payload }),
    deleteFolder: (ns, id) => ipcRenderer.invoke('store:config:deleteFolder', { ns, id }),
    getSettings: () => ipcRenderer.invoke('store:settings:get'),
    setSettings: (s) => ipcRenderer.invoke('store:settings:set', s),
    // 链路预算全局资源库（地球站/卫星/载波），按体制命名空间 geo/ngso/regen 整读整写
    getLibrary: (ns) => ipcRenderer.invoke('store:library:get', ns),
    saveLibrary: (ns, data) => ipcRenderer.invoke('store:library:save', { ns, data })
  },
  report: {
    export: (payload) => ipcRenderer.invoke('report:export', payload),
    // 交付级链路预算报告：一次调用出 .xlsx / .pdf（同名同目录），模型见 src/shared/lbReport.js
    exportReport: (payload) => ipcRenderer.invoke('report:exportReport', payload)
  },
  // 报告打印页（src/report.html，隐藏窗口）专用：取模型 + 回告排版完成
  reportPrint: {
    model: () => ipcRenderer.invoke('report:print:model'),
    ready: () => ipcRenderer.send('report:print:ready')
  },
  // MODCOD 表（文件管理 · 调制编码）：整份清单进出，主进程只落「与内置表的差异」
  modcod: {
    list: () => ipcRenderer.invoke('modcod:list'),
    save: (standards) => ipcRenderer.invoke('modcod:save', standards),
    reset: (key) => ipcRenderer.invoke('modcod:reset', key)
  },
  // 通用表格 ⇄ Excel：模型进、工作簿出；导入回 { sheets:[{ name, rows }] }，列匹配在渲染端
  gridXlsx: {
    export: (payload) => ipcRenderer.invoke('grid:exportXlsx', payload),
    import: (opt) => ipcRenderer.invoke('grid:importXlsx', opt)
  },
  // 时段过境（可见性分析）导出 Excel：三线表模板版式（摘要 / 过境明细 / 逐星汇总），模型在渲染端组装
  visAccess: { exportExcel: (payload) => ipcRenderer.invoke('vis:exportAccessExcel', payload) },
  // 覆盖图导出：保存二进制（PNG/PDF）到用户选定路径 / 读取系统字体（PDF 嵌入用：TNR 西文 + 中文面）
  exportFile: (payload) => ipcRenderer.invoke('file:save', payload),
  // PFD Mask 生成（ITU-R S.1503）：参数进、XML 文本与统计出；落盘走 exportFile / exportFiles
  pfdMask: { open: () => ipcRenderer.invoke('pfd:open') },
  pfdGenerate: (params) => ipcRenderer.invoke('pfd:generate', params),
  // 批量落盘到一个目录（mask 分文件 + 参数存档）
  exportFiles: (payload) => ipcRenderer.invoke('file:saveMany', payload),
  pdfFonts: () => ipcRenderer.invoke('font:pdf'),
  adm: {
    // 行政边界包（resources/adm）：lvl=1|2、iso=ISO3；没有该国的包返回 null
    pack: (lvl, iso) => ipcRenderer.invoke('adm:pack', lvl, iso)
  },
  omm: {
    load: (group, online) => ipcRenderer.invoke('omm:load', group, online),
    positions: (group, iso) => ipcRenderer.invoke('omm:positions', group, iso),
    csv: (group, opts) => ipcRenderer.invoke('omm:csv', group, opts),
    list: () => ipcRenderer.invoke('omm:list'),
    import: (key) => ipcRenderer.invoke('omm:import', key),
    export: (key, format) => ipcRenderer.invoke('omm:export', key, format),
    // 自定义卫星库（导入 OMM CSV / TLE，合并去重后持久化为一份 OMM CSV，贯通 3D 分组与搜索池）
    customList: () => ipcRenderer.invoke('omm:customList'),
    customCsv: () => ipcRenderer.invoke('omm:customCsv'),
    customGroupRecords: (groupId) => ipcRenderer.invoke('omm:customGroupRecords', groupId),
    customImport: () => ipcRenderer.invoke('omm:customImport'),
    // 拖放导入：渲染端 FileReader 读成文本再传（[{name,text}]），不依赖 Electron 版本的 File.path
    customImportText: (files) => ipcRenderer.invoke('omm:customImportText', files),
    customRemove: (groupId) => ipcRenderer.invoke('omm:customRemove', groupId),
    customRename: (groupId, name) => ipcRenderer.invoke('omm:customRename', groupId, name),
    // 星座栏「导入星历」区块：显隐 / 配色落库
    customUpdateGroup: (groupId, patch) => ipcRenderer.invoke('omm:customUpdateGroup', groupId, patch),
    // 地图用：只吐可见 gp 组的并集 + NORAD→组 归属表
    customRawVisible: () => ipcRenderer.invoke('omm:customRawVisible'),
    // 某点序列组的采样表（typed array 走结构化克隆）
    ephemTable: (groupId) => ipcRenderer.invoke('omm:ephemTable', groupId),
    customExportGroup: (groupId, defaultName, format, opts) => ipcRenderer.invoke('omm:customExportGroup', groupId, defaultName, format, opts),
    exportRecords: (records, defaultName, format, opts) => ipcRenderer.invoke('omm:exportRecords', records, defaultName, format, opts),
    // 星历取数链路的操作明细（主进程广播）→ 底部「日志」窗格；{ text, level }
    onLog: (cb) => ipcRenderer.on('omm:log', (_e, p) => cb(p))
  },
  // CelesTrak 卫星编目（SATCAT）：与 omm.csv 同一条四级众包链路的第二种数据集，
  // 返回 { text, fetchedAt, source } 或 null（cacheOnly 且本机什么都没有时）。
  satcat: {
    csv: (opts) => ipcRenderer.invoke('satcat:csv', opts)
  },
  // 空间态势报告（独立窗口）：开窗 + 关窗守卫（与 rainAttenuation 同套）
  ssa: {
    open: () => ipcRenderer.invoke('ssa:open'),
    onCloseRequested: (cb) => ipcRenderer.on('ssa:closeRequested', cb),
    confirmClose: () => ipcRenderer.invoke('ssa:confirmClose')
  },
  // 转发器频率计划：挂在卫星下、与 GRD 天线平级的一类「文件」。
  // 主进程只负责存取与原生对话框，模型/校验/容量/出图全在渲染端 src/shared/freqPlan*.js。
  freqPlan: {
    open: (planId) => ipcRenderer.invoke('freqPlan:open', planId),
    list: () => ipcRenderer.invoke('freqPlan:list'),
    get: (id) => ipcRenderer.invoke('freqPlan:get', id),
    // opts.updateOnly：只更新索引里已有的计划，不许新建（编辑窗的自动存盘用）
    save: (plan, opts) => ipcRenderer.invoke('freqPlan:save', plan, opts),
    remove: (id) => ipcRenderer.invoke('freqPlan:remove', id),
    rename: (id, name) => ipcRenderer.invoke('freqPlan:rename', id, name),
    reassignSat: (folder, patch) => ipcRenderer.invoke('freqPlan:reassignSat', folder, patch),
    exportFile: (kind, payload, defaultName) => ipcRenderer.invoke('freqPlan:export', kind, payload, defaultName),
    importJson: () => ipcRenderer.invoke('freqPlan:importJson'),
    onOpenPlan: (cb) => ipcRenderer.on('freqPlan:openPlan', (_e, id) => cb(id)),
    // 文件区删/改名的广播（编辑窗手里那份可能就是它）
    onPlanRemoved: (cb) => ipcRenderer.on('freqPlan:planRemoved', (_e, id) => cb(id)),
    onPlanRenamed: (cb) => ipcRenderer.on('freqPlan:planRenamed', (_e, id, name) => cb(id, name))
  },
  coverage: {
    index: () => ipcRenderer.invoke('coverage:index'),
    get: (file) => ipcRenderer.invoke('coverage:get', file)
  },
  coverageGrd: {
    index: () => ipcRenderer.invoke('coverageGrd:index'),
    get: (file) => ipcRenderer.invoke('coverageGrd:get', file),
    open: () => ipcRenderer.invoke('coverageGrd:open'),
    // 链路预算侧导入：主进程直接拷贝文件，只回 { base, file }（不搬文本）
    import: () => ipcRenderer.invoke('coverageGrd:import'),
    save: (name, text) => ipcRenderer.invoke('coverageGrd:save', name, text),
    // 解析天线记录（*.gauss.json）就地改写：只许已存在的 .gauss.json，文件名不变
    overwrite: (file, text) => ipcRenderer.invoke('coverageGrd:overwrite', file, text),
    raw: (file) => ipcRenderer.invoke('coverageGrd:raw', file),
    // 原样导出：保存框 + 主进程按字节拷贝（原文不进渲染进程）。合成件回 { synth:true }，需渲染端重打包
    exportRaw: (file, defaultName) => ipcRenderer.invoke('coverageGrd:exportRaw', file, defaultName),
    remove: (file) => ipcRenderer.invoke('coverageGrd:remove', file)
  },
  coverageGxt: {
    index: () => ipcRenderer.invoke('coverageGxt:index'),
    get: (file) => ipcRenderer.invoke('coverageGxt:get', file),
    raw: (file) => ipcRenderer.invoke('coverageGxt:raw', file),
    open: () => ipcRenderer.invoke('coverageGxt:open'),
    addSat: (name, lon) => ipcRenderer.invoke('coverageGxt:addSat', name, lon),
    renameSat: (satId, name) => ipcRenderer.invoke('coverageGxt:renameSat', satId, name),
    removeSat: (satId) => ipcRenderer.invoke('coverageGxt:removeSat', satId),
    ensureSat: (name, lon) => ipcRenderer.invoke('coverageGxt:ensureSat', name, lon),
    hidePreset: (kind, key) => ipcRenderer.invoke('coverageGxt:hidePreset', kind, key),
    unhidePreset: (kind, key) => ipcRenderer.invoke('coverageGxt:unhidePreset', kind, key),
    addBeam: (satId, name, type, band) => ipcRenderer.invoke('coverageGxt:addBeam', satId, name, type, band),
    renameBeam: (satId, beamId, name) => ipcRenderer.invoke('coverageGxt:renameBeam', satId, beamId, name),
    removeBeam: (satId, beamId) => ipcRenderer.invoke('coverageGxt:removeBeam', satId, beamId),
    attach: (satId, beamId, payload) => ipcRenderer.invoke('coverageGxt:attach', satId, beamId, payload),
    importBatch: (items) => ipcRenderer.invoke('coverageGxt:importBatch', items)
  },
  // 协调区 Polygon：原生框选 .gxt / .kml → 读原文交渲染进程解析导入
  poly: {
    open: () => ipcRenderer.invoke('poly:open')
  },
  // 卫星 3D 模型（契约见 electron/services/models.js 文件头）。
  // 入参出门前现造纯数据（Vue Proxy 过不了结构化克隆）；typed array 原样走。
  // 订阅一律返回取消函数：3D 页 / 侧栏 / 工作台会反复挂载卸载，不取消就一路漏监听。
  models: {
    open: (o) => ipcRenderer.invoke('modelwb:open', o ? JSON.parse(JSON.stringify(o)) : undefined),
    onTarget: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('modelwb:target', h); return () => ipcRenderer.removeListener('modelwb:target', h) },
    manifest: () => ipcRenderer.invoke('models:manifest'),
    ensure: (o) => ipcRenderer.invoke('models:ensure', o ? { id: o.id, lod: o.lod } : o),
    thumbnail: (id) => ipcRenderer.invoke('models:thumbnail', id),
    cancel: (id) => ipcRenderer.send('models:cancel', id),
    remove: (id) => ipcRenderer.invoke('models:remove', id),
    cacheInfo: () => ipcRenderer.invoke('models:cacheInfo'),
    setCacheCap: (bytes) => ipcRenderer.invoke('models:setCacheCap', bytes),
    openCacheDir: () => ipcRenderer.invoke('models:openCacheDir'),
    refreshManifest: () => ipcRenderer.invoke('models:refreshManifest'),
    pickFiles: () => ipcRenderer.invoke('models:pickFiles'),
    readFile: (path) => ipcRenderer.invoke('models:readFile', path),
    importGlb: (o) => ipcRenderer.invoke('models:importGlb', o && o.bytes ? { bytes: o.bytes, name: o.name } : { path: o && o.path }),
    importCad: (o) => ipcRenderer.invoke('models:importCad', { path: o && o.path, token: o && o.token }),
    saveImported: (o) => ipcRenderer.invoke('models:saveImported', { glb: o && o.glb, meta: o && o.meta ? JSON.parse(JSON.stringify(o.meta)) : null }),
    scanStk: (o) => ipcRenderer.invoke('models:scanStk', { dir: o && o.dir }),
    pickStkDir: () => ipcRenderer.invoke('models:pickStkDir'),
    importStk: (o) => ipcRenderer.invoke('models:importStk', { dir: o && o.dir, files: o && o.files ? [...o.files] : [] }),
    saveMeta: (o) => ipcRenderer.invoke('models:saveMeta', { id: o && o.id, meta: o && o.meta ? JSON.parse(JSON.stringify(o.meta)) : null }),
    getMeta: (id) => ipcRenderer.invoke('models:getMeta', id),
    exportModel: (o) => ipcRenderer.invoke('models:export', {
      id: o && o.id, glb: o && o.glb, suggestedName: o && o.suggestedName,
      gmdf: o && o.gmdf ? JSON.parse(JSON.stringify(o.gmdf)) : undefined,
      satsimJson: o && o.satsimJson ? JSON.parse(JSON.stringify(o.satsimJson)) : undefined
    }),
    saveThumb: (o) => ipcRenderer.invoke('models:saveThumb', { id: o && o.id, webp: o && o.webp }),
    bindingsGet: () => ipcRenderer.invoke('models:bindings:get'),
    bindingsSet: (o) => ipcRenderer.invoke('models:bindings:set', o ? JSON.parse(JSON.stringify(o)) : o),
    // 本体遮挡掩模（D18）：{sig, bytes: Uint8Array(encodeMask)} | {sig, blocked: Uint8Array, clearance: Float32Array} → {ok, sig, bytes}；
    // getMask(sig) → Uint8Array（.bin 原样，decodeMask 解）| null
    saveMask: (o) => ipcRenderer.invoke('models:saveMask', o ? { sig: o.sig, bytes: o.bytes, blocked: o.blocked, clearance: o.clearance } : o),
    getMask: (sig) => ipcRenderer.invoke('models:getMask', typeof sig === 'string' ? sig : String(sig || '')),
    // 表格导出：{sheets:[{name, cols:[{key, label, unit?, num?, fix?, align?}], rows, note?}], defaultName, title?, style?:'report'|'plain'} → xlsx；
    // {format:'csv', text | sheets, defaultName} → csv。→ {ok, filePath} | {ok:false, canceled?, error?}
    // 行可以是 typed array（时间序列直接切片）：JSON 会把它写成 {"0":…} 对象，先摊成普通数组；NaN / ±∞ → null（空格）。
    // 超过 2000 行的表按列打包（tableWire），主进程反序列化不必逐个造几十万个行对象；写出来的格子与逐行传逐位相同
    exportTable: (o) => ipcRenderer.invoke('models:exportTable', tableWire(o)),
    onChanged: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('models:changed', h); return () => ipcRenderer.removeListener('models:changed', h) }
  },
  platform: process.platform
})
