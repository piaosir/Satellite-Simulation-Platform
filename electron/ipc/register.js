const { ipcMain, dialog, BrowserWindow } = require('electron')
const fs = require('fs')
const createOmm = require('../services/omm')

// NGSO 导出：把平台精确几何（轨道根数 / 最差互视时刻 / 互视窗口）整理成一段瀑布（cols:1），
// 并入详细计算结果表，使 Excel 与结果界面几何口径一致。
function _fmtInstantUTC(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return String(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`
}
function ngsoGeometrySegment(geom, lang) {
  const w = geom.worst || {}, el = geom.elements || {}, win = geom.window || {}
  const en = lang === 'en'
  const n = (v, p = 2) => (v == null || !isFinite(v)) ? '—' : Number(v).toFixed(p)
  const T = en
    ? { title: 'Satellite Geometry (Platform SGP4 · Dual-Station Mutual-Visibility Worst Case)', worstTime: 'Worst Mutual-Visibility Instant', win: 'Mutual-Visibility Window (AOS→LOS)', dur: 'Window Duration', upElev: 'Uplink Elevation', dnElev: 'Downlink Elevation', upSlant: 'Uplink Slant Range', dnSlant: 'Downlink Slant Range', upAz: 'Uplink Azimuth', dnAz: 'Downlink Azimuth', delay: 'One-Way Link Delay', vInert: 'Orbital Velocity (Inertial)', vGround: 'Ground-Relative Velocity', dopUp: 'Max Doppler (Uplink)', dopDn: 'Max Doppler (Downlink)', a: 'Semi-major Axis a', e: 'Eccentricity e', i: 'Inclination i', raan: 'RAAN Ω', argp: 'Arg. of Perigee ω', ma: 'Mean Anomaly M', mm: 'Mean Motion n', period: 'Orbital Period T', peri: 'Perigee Altitude', apo: 'Apogee Altitude', norad: 'Satellite (NORAD)' }
    : { title: '卫星几何（平台 SGP4 · 双站互视最差几何）', worstTime: '最差互视时刻', win: '互视窗口（AOS→LOS）', dur: '互视窗口时长', upElev: '上行仰角', dnElev: '下行仰角', upSlant: '上行斜距', dnSlant: '下行斜距', upAz: '上行方位角', dnAz: '下行方位角', delay: '单程链路时延', vInert: '轨道速度（惯性系）', vGround: '相对地面速度', dopUp: '最大多普勒（上行）', dopDn: '最大多普勒（下行）', a: '半长轴 a', e: '偏心率 e', i: '倾角 i', raan: '升交点赤经 Ω', argp: '近地点幅角 ω', ma: '平近点角 M', mm: '平均运动 n', period: '轨道周期 T', peri: '近地点高度', apo: '远地点高度', norad: '卫星编号 (NORAD)' }
  const row = (label, val, unit, kind) => ({ sign: '', label, up: val, unit: unit || '', kind: kind || 'ref' })
  const contLabel = en ? 'Continuously visible (GEO/static)' : '两站持续可见（静止/GEO）'
  const manualLabel = en ? 'Manual virtual circular orbit (closed-form worst, no ephemeris)' : '手动虚拟圆轨道（闭式最差，无星历/时窗）'
  const manual = !!geom.manual
  const title = manual ? (en ? 'Satellite Geometry (Manual Virtual Circular Orbit · Closed-form Worst Case)' : '卫星几何（手动虚拟圆轨道 · 球形闭式最差）') : T.title
  const rows = [
    row(T.worstTime, manual ? manualLabel : (win.continuous ? contLabel : _fmtInstantUTC(w.timeISO)), '', 'sub'),
    row(T.win, manual ? manualLabel : (win.continuous ? contLabel : `${_fmtInstantUTC(win.aosISO)} → ${_fmtInstantUTC(win.losISO)}`), ''),
    row(T.dur, (manual || win.continuous) ? '—' : n(win.durationMin), 'min'),
    row(T.upElev, n(w.up && w.up.elevDeg), '°'),
    row(T.dnElev, n(w.dn && w.dn.elevDeg), '°'),
    row(T.upSlant, n(w.up && w.up.slantKm), 'km'),
    row(T.dnSlant, n(w.dn && w.dn.slantKm), 'km'),
    row(T.upAz, n(w.up && w.up.azDeg), '°'),
    row(T.dnAz, n(w.dn && w.dn.azDeg), '°'),
    row(T.delay, n(w.oneWayDelayMs, 3), 'ms'),
    row(T.vInert, n(w.speedInertialKmS, 3), 'km/s'),
    row(T.vGround + (geom.dopplerEstimate ? (en ? ' (est.)' : '（估算）') : ''), n(w.speedGroundRelKmS, 3), 'km/s'),
    row(T.dopUp + (geom.dopplerEstimate ? (en ? ' (est., closed-form)' : '（估算·闭式）') : (en ? ' (in-window SGP4)' : '（窗口内 SGP4）')), n(w.maxDopplerUpHz != null ? w.maxDopplerUpHz / 1000 : null, 3), 'kHz'),
    row(T.dopDn + (geom.dopplerEstimate ? (en ? ' (est., closed-form)' : '（估算·闭式）') : (en ? ' (in-window SGP4)' : '（窗口内 SGP4）')), n(w.maxDopplerDnHz != null ? w.maxDopplerDnHz / 1000 : null, 3), 'kHz'),
    row(T.a, n(el.a, 3), 'km', 'sub'),
    row(T.e, n(el.e, 6), ''),
    row(T.i, n(el.iDeg, 4), '°'),
    row(T.raan, n(el.raanDeg, 4), '°'),
    row(T.argp, n(el.argpDeg, 4), '°'),
    row(T.ma, n(el.maDeg, 4), '°'),
    row(T.mm, n(el.meanMotionRevDay, 6), 'rev/day'),
    row(T.period, n(el.periodMin, 3), 'min'),
    row(T.peri, n(el.perigeeAltKm, 1), 'km'),
    row(T.apo, n(el.apogeeAltKm, 1), 'km')
  ]
  if (el.satnum) rows.push(row(T.norad, String(el.satnum), ''))
  return { title, cols: 1, rows }
}

// 注册所有 IPC 处理器。core 为返回引擎实例的函数（延迟解析）。
function register({ core, storage, report, coverage, coverageGrd, coverageGxt, share, openLinkBudget, openSunOutage, grd, confirmCloseLinkBudget, openNgso, confirmCloseNgso }) {
  const omm = createOmm(core)
  ipcMain.handle('omm:load', (_e, group, online) => omm.load(group, online))
  ipcMain.handle('omm:positions', (_e, group, iso) => omm.positions(group, iso))
  ipcMain.handle('omm:csv', (_e, group, opts) => omm.fetchCsv(group, opts))

  // ---- 文件管理：OMM 星座组缓存的列举 / 导入替换 / 导出 ----
  ipcMain.handle('omm:list', () => omm.listCsv())
  // 导入并替换某组 OMM：原生选 .csv → 校验 → 覆盖缓存。返回 { ok, key, mtime, count } 或 { canceled }/{ ok:false, error }
  ipcMain.handle('omm:import', async (e, key) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: `导入 OMM 文件（替换「${key}」）`, properties: ['openFile'],
      filters: [{ name: 'CelesTrak OMM (*.csv)', extensions: ['csv'] }, { name: '所有文件', extensions: ['*'] }]
    })
    if (canceled || !filePaths || !filePaths.length) return { canceled: true }
    try {
      const text = fs.readFileSync(filePaths[0], 'utf8')
      return omm.writeCsvRaw(key, text)
    } catch (err) { return { ok: false, error: err.message || String(err) } }
  })
  // 导出某组缓存 OMM 到用户选定路径
  ipcMain.handle('omm:export', async (e, key) => {
    const r = omm.readCsvRaw(key)
    if (!r) return { ok: false, error: '该组暂无本地缓存，请先联网刷新或导入' }
    const win = BrowserWindow.fromWebContents(e.sender)
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `${key}_OMM.csv`, filters: [{ name: 'CSV 文件', extensions: ['csv'] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    try { fs.writeFileSync(filePath, r.text); return { ok: true, filePath } }
    catch (err) { return { ok: false, error: err.message || String(err) } }
  })

  // ---- 文件管理：用户 GXT 覆盖库（卫星 → 波束 → GXT）----
  if (coverageGxt) {
    ipcMain.handle('coverageGxt:index', () => coverageGxt.index())
    ipcMain.handle('coverageGxt:get', (_e, file) => coverageGxt.get(file))
    ipcMain.handle('coverageGxt:raw', (_e, file) => coverageGxt.raw(file))
    ipcMain.handle('coverageGxt:addSat', (_e, name, lon) => coverageGxt.addSat(name, lon))
    ipcMain.handle('coverageGxt:renameSat', (_e, satId, name) => coverageGxt.renameSat(satId, name))
    ipcMain.handle('coverageGxt:removeSat', (_e, satId) => coverageGxt.removeSat(satId))
    ipcMain.handle('coverageGxt:ensureSat', (_e, name, lon) => coverageGxt.ensureSat(name, lon))
    ipcMain.handle('coverageGxt:hidePreset', (_e, kind, key) => coverageGxt.hidePreset(kind, key))
    ipcMain.handle('coverageGxt:unhidePreset', (_e, kind, key) => coverageGxt.unhidePreset(kind, key))
    ipcMain.handle('coverageGxt:addBeam', (_e, satId, name, type, band) => coverageGxt.addBeam(satId, name, type, band))
    ipcMain.handle('coverageGxt:renameBeam', (_e, satId, beamId, name) => coverageGxt.renameBeam(satId, beamId, name))
    ipcMain.handle('coverageGxt:removeBeam', (_e, satId, beamId) => coverageGxt.removeBeam(satId, beamId))
    ipcMain.handle('coverageGxt:attach', (_e, satId, beamId, payload) => coverageGxt.attach(satId, beamId, payload))
    ipcMain.handle('coverageGxt:importBatch', (_e, items) => coverageGxt.importBatch(items))
    // 用户导入：原生框选 .gxt（多选）→ 逐个读原文返回渲染进程解析（parse.js）
    ipcMain.handle('coverageGxt:open', async (e) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: '导入 GXT 文件（可多选）', properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'GXT 等值线 (*.gxt)', extensions: ['gxt'] }, { name: '所有文件', extensions: ['*'] }]
      })
      if (canceled || !filePaths || !filePaths.length) return { canceled: true }
      const path = require('path')
      const files = filePaths.map((fp) => {
        try { return { base: path.basename(fp), text: fs.readFileSync(fp, 'latin1') } }
        catch (err) { return { base: path.basename(fp), error: err.message } }
      })
      return { canceled: false, files }
    })
  }

  // ---- GEO 卫星覆盖数据 ----
  if (coverage) {
    ipcMain.handle('coverage:index', () => coverage.index())
    ipcMain.handle('coverage:get', (_e, file) => coverage.get(file))
  }
  // ---- GRD 覆盖图（原始场，实时重算）----
  if (coverageGrd) {
    ipcMain.handle('coverageGrd:index', () => coverageGrd.index())
    ipcMain.handle('coverageGrd:get', (_e, file) => coverageGrd.get(file))
    // 导入的原始 GRD 持久化：存盘 / 读回 / 删除（供天线重载与清理）
    ipcMain.handle('coverageGrd:save', (_e, name, text) => coverageGrd.save(name, text))
    ipcMain.handle('coverageGrd:raw', (_e, file) => coverageGrd.raw(file))
    ipcMain.handle('coverageGrd:remove', (_e, file) => coverageGrd.remove(file))
    // 用户导入：原生文件框选 .grd/.pat（支持多选，一次导入多个天线）→ 逐个读文本返回渲染进程解析
    ipcMain.handle('coverageGrd:open', async (e) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: '导入 GRD / PAT 文件（可多选）', properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'GRASP 网格 (*.grd, *.pat)', extensions: ['grd', 'pat'] }, { name: '所有文件', extensions: ['*'] }]
      })
      if (canceled || !filePaths || !filePaths.length) return { canceled: true }
      const path = require('path')
      const files = filePaths.map((fp) => {
        try { return { base: path.basename(fp), text: fs.readFileSync(fp, 'latin1') } }
        catch (err) { return { base: path.basename(fp), error: err.message } }
      })
      return { canceled: false, files }
    })
  }

  // ---- 链路计算 ----
  ipcMain.handle('link:compute', (_e, s, l) => core().calculateLinkBudget(s || {}, l || {}))
  ipcMain.handle('link:computeNGSO', (_e, s, l) =>
    core().calculateLinkBudgetNGSO
      ? core().calculateLinkBudgetNGSO(s || {}, l || {})
      : { success: false, message: 'NGSO 引擎未加载' })
  ipcMain.handle('link:angle', (_e, lat, lon, satLon) => core().calculateSatelliteAngle(lat, lon, satLon))
  // 链路瀑布表分段数据（结果区渲染 / 专业版导出共用同一口径）
  ipcMain.handle('link:waterfall', (_e, ctx) => core().buildWaterfallSegments(ctx || {}))
  // 计算方式求解（在主进程内迭代求解功带平衡 / 反推余量，避免大量 IPC 往返）
  ipcMain.handle('link:computeMode', (_e, s, l, opt) => core().computeLinkMode(s || {}, l || {}, opt || {}))
  // NGSO 计算方式求解（同四种方式，切 NGSO 引擎，强制 ISL 跳数=0）
  ipcMain.handle('link:computeModeNGSO', (_e, s, l, opt) =>
    core().computeLinkModeNGSO
      ? core().computeLinkModeNGSO(s || {}, l || {}, opt || {})
      : { success: false, message: 'NGSO 引擎未加载' })
  // NGSO 站星几何求解（SGP4 双站互视最差几何 + 轨道根数 + 最近最差时刻/互视窗口）
  ipcMain.handle('link:ngsoGeometry', (_e, opt) =>
    core().solveNgsoMutualWorstCase
      ? core().solveNgsoMutualWorstCase(opt || {})
      : { feasible: false, reason: 'NGSO 几何求解器未加载' })
  // 经纬度 → 降雨率/海拔自动填值（与小程序口径一致）
  ipcMain.handle('link:geoFill', (_e, lat, lon) => core().geoAutoFill(parseFloat(lat), parseFloat(lon)))
  // GRD 天线逐站取值（多波束最大 Parameter）：解析+采样在主进程，渲染端只收发 dB 数字
  ipcMain.handle('link:grdSample', (_e, req) => (grd ? grd.sample(req || {}) : ((req && req.points) || []).map(() => null)))
  // 城市列表（选址用）
  ipcMain.handle('link:cities', () => core().listCities())
  ipcMain.handle('link:searchCities', (_e, kw) => core().searchCities(String(kw == null ? '' : kw), {}))
  // 基带选项（调制/FEC/DVB/MODCOD）
  ipcMain.handle('link:baseband', () => core().basebandOptions())

  // 打开「GEO 链路预算」独立工作台窗口（单例，由 main 注入创建函数）
  ipcMain.handle('linkbudget:open', () => { if (openLinkBudget) openLinkBudget(); return true })
  // 关窗守卫：渲染进程问过用户「配置存了没」（取消/不保存/保存）并按需存盘后，调这个才真正关闭窗口
  ipcMain.handle('linkbudget:confirmClose', () => { if (confirmCloseLinkBudget) confirmCloseLinkBudget(); return true })

  // 打开「NGSO 链路预算」独立工作台窗口（单例，由 main 注入创建函数）
  ipcMain.handle('ngso:open', () => { if (openNgso) openNgso(); return true })
  ipcMain.handle('ngso:confirmClose', () => { if (confirmCloseNgso) confirmCloseNgso(); return true })

  // ---- 日凌预报（独立窗口 + 计算 + Word/ICS 导出）----
  ipcMain.handle('suntool:open', () => { if (openSunOutage) openSunOutage(); return true })
  ipcMain.handle('sunoutage:compute', (_e, p) => {
    try { return core().calculateSunOutage(p || {}) }
    catch (err) { return { error: true, message: err.message || String(err) } }
  })
  // Word 报告：payload = { result, station:{name,lat,lon}, satellite:{name,lon}, tz:'bjt'|'utc' }
  ipcMain.handle('sunoutage:exportWord', async (e, payload) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: (payload && payload.defaultName) || '日凌预报报告.docx',
      filters: [{ name: 'Word 文档', extensions: ['docx'] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    try {
      const buf = await report.buildSunOutageWord(payload || {})
      fs.writeFileSync(filePath, Buffer.from(buf))
      return { ok: true, filePath }
    } catch (err) {
      const busy = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')
      return { ok: false, error: busy ? '文件可能正被其他程序打开（如 Word），请关闭后重试' : (err.message || String(err)) }
    }
  })
  // ICS 日历：事件时刻恒用 UTC（导入方自动换算本地时区）；SUMMARY 附北京时峰值便于值班速读。
  ipcMain.handle('sunoutage:exportIcs', async (e, payload) => {
    const { result, station = {}, satellite = {} } = payload || {}
    const days = (result && result.dailyResults) || []
    if (!days.length) return { ok: false, error: '无日凌事件可导出' }
    const satName = satellite.name || `${satellite.lon}°E`
    const stnName = station.name || '地球站'
    const yearStr = String(result.equinoxDate || '').slice(0, 4)
    const events = days.map((d) => ({
      // UID 含 星-站-日期：同一事件重复导入时日历自动更新而非重复
      uid: `so-${satellite.lon}E-${Number(station.lat).toFixed(2)}N-${Number(station.lon).toFixed(2)}E-${d.date}@satsim-platform`,
      date: d.date, start: d.startTimeUTC, end: d.endTimeUTC,
      summary: `日凌 ${satName} @ ${stnName} · 峰值${d.peakTimeBJT}(北京时) · -${d.peakCNdeg}dB`,
      description: [
        `卫星: ${satName}（${satellite.lon}°E）`,
        `地球站: ${stnName}（${station.lat}, ${station.lon}）· 方位 ${result.satAz}° 仰角 ${result.satEl}°`,
        `窗口(UTC): ${d.startTimeUTC} ~ ${d.endTimeUTC}（峰值 ${d.peakTimeUTC}）`,
        `窗口(北京时): ${d.startTimeBJT} ~ ${d.endTimeBJT}（峰值 ${d.peakTimeBJT}）`,
        `时长: ${d.durationStr} · 峰值 C/N 恶化: ${d.peakCNdeg} dB · 强度: ${d.intensity}`,
        `判据: C/N 恶化 ≥ ${result.model ? result.model.degThreshold : '—'} dB · 频率 ${result.frequency} GHz · 口径 ${result.model ? result.model.diameter : '—'} m`,
        `由 卫星仿真平台 生成`
      ].join('\n'),
      location: stnName,
      categories: ['日凌', 'SUN OUTAGE'],
      alarms: [
        { minutesBefore: 1440, description: `明日日凌：${satName} @ ${stnName}` },
        { minutesBefore: 30, description: `30 分钟后日凌开始：${satName} @ ${stnName}` }
      ]
    }))
    const ics = core().buildIcs({ name: `日凌预报 ${satName} @ ${stnName} · ${result.seasonName}${yearStr}`, events })
    const win = BrowserWindow.fromWebContents(e.sender)
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: (payload && payload.defaultName) || `日凌预报_${satName}_${stnName}_${yearStr}${result.seasonName}.ics`,
      filters: [{ name: 'iCalendar 日历', extensions: ['ics'] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    try {
      fs.writeFileSync(filePath, ics, 'utf8')
      return { ok: true, filePath, count: events.length }
    } catch (err) {
      return { ok: false, error: err.message || String(err) }
    }
  })

  // ---- 本地存储 ----
  ipcMain.handle('store:history:list', () => storage.listHistory())
  ipcMain.handle('store:history:add', (_e, r) => storage.addHistory(r))
  ipcMain.handle('store:history:delete', (_e, id) => storage.deleteHistory(id))
  ipcMain.handle('store:history:clear', () => storage.clearHistory())
  ipcMain.handle('store:config:list', () => storage.listConfigs())
  ipcMain.handle('store:config:save', (_e, c) => storage.saveConfig(c))
  ipcMain.handle('store:config:delete', (_e, id) => storage.deleteConfig(id))
  ipcMain.handle('store:config:reorder', (_e, ids) => storage.reorderConfigs(ids))
  ipcMain.handle('store:settings:get', () => storage.getSettings())
  ipcMain.handle('store:settings:set', (_e, s) => storage.setSettings(s))

  // ---- 通用二进制导出（原生保存对话框 → 写盘）：覆盖图 PNG / 矢量 PDF 等 ----
  // payload: { defaultName, data:ArrayBuffer|Uint8Array, filters:[{name,extensions}] }
  ipcMain.handle('file:save', async (e, payload) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: payload.defaultName || 'export.bin',
      filters: payload.filters || [{ name: '所有文件', extensions: ['*'] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    try {
      fs.writeFileSync(filePath, Buffer.from(payload.data))
      return { ok: true, filePath }
    } catch (err) {
      // 目标文件被其他程序占用（PDF/图片查看器打开着）→ EBUSY/EPERM。返回友好错误，不抛出。
      const busy = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')
      return { ok: false, error: busy ? '文件可能正被其他程序打开（如 PDF 查看器），请关闭后重试' : (err.message || String(err)) }
    }
  })

  // ---- 读取系统中文字体（供矢量 PDF 嵌入；jsPDF 仅支持单面 TTF，不支持 TTC）----
  // 按候选顺序返回首个存在的单面 TTF 的 base64；找不到返回 ok:false（PDF 则退化为无中文字体）。
  ipcMain.handle('font:cjk', () => {
    if (process.platform !== 'win32') return { ok: false }
    const path = require('path')
    const dir = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts')
    const cands = ['simhei.ttf', 'simkai.ttf', 'simfang.ttf', 'Deng.ttf', 'msyh.ttf', 'simsunb.ttf']
    for (const f of cands) {
      const p = path.join(dir, f)
      try { if (fs.existsSync(p)) return { ok: true, name: f, base64: fs.readFileSync(p).toString('base64') } } catch { /* try next */ }
    }
    return { ok: false }
  })

  // ---- 报告导出（原生保存对话框 → 写盘）----
  ipcMain.handle('report:export', async (e, payload) => {
    const fmt = payload.format === 'excel' ? 'excel' : 'word'
    const ext = fmt === 'excel' ? 'xlsx' : 'docx'
    const win = BrowserWindow.fromWebContents(e.sender)
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `链路预算报告.${ext}`,
      filters: [{ name: fmt === 'excel' ? 'Excel 工作簿' : 'Word 文档', extensions: [ext] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    const buf = fmt === 'excel' ? await report.buildExcel(payload) : await report.buildWord(payload)
    fs.writeFileSync(filePath, Buffer.from(buf))
    return { ok: true, filePath }
  })

  // ---- 工作台 m×n 链路矩阵 Excel 导出（Phase 5）----
  ipcMain.handle('linkbudget:exportExcel', async (e, payload) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: (payload && payload.defaultName) || 'GEO链路预算结果.xlsx',
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    try {
      // 为每条链路构建七段瀑布（与 UI 瀑布同源 buildWaterfallSegments）→「详细计算结果」分表
      // lang 跟随导出语言选择（中/英），与链路汇总表的中英文口径保持一致
      const exportLang = (payload && payload.lang === 'en') ? 'en' : 'zh'
      const orbitType = (payload && payload.orbitType === 'NGSO') ? 'NGSO' : 'GEO'
      const links = (payload && payload.links) || []
      for (const l of links) {
        if (l && l.data) {
          try { l.segments = core().buildWaterfallSegments({ results: l.data, lang: exportLang, orbitType, txLocation: String(l.txName || ''), rxLocation: String(l.rxName || '') }) }
          catch (e) { l.segments = [] }
          // NGSO：把平台精确几何（轨道根数 / 最差互视时刻 / 互视窗口）作为附加段并入详细表
          if (orbitType === 'NGSO' && l.geom && l.geom.feasible) {
            try { l.segments = (l.segments || []).concat([ngsoGeometrySegment(l.geom, exportLang)]) } catch (e) { /* ignore */ }
          }
        }
      }
      const buf = await report.buildLinkBudgetExcel(payload || {})
      fs.writeFileSync(filePath, Buffer.from(buf))
      return { ok: true, filePath }
    } catch (err) {
      const busy = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')
      return { ok: false, error: busy ? '文件可能正被其他程序打开（如 Excel），请关闭后重试' : (err.message || String(err)) }
    }
  })

  // ---- 应用版本（帮助 → 关于 对话框显示）----
  ipcMain.handle('app:version', () => require('electron').app.getVersion())

  // ---- 设备 ID（按本机 MAC 派生的稳定短码，作为「用户 ID」用于配置分享）----
  // 取所有非内网物理网卡 MAC 排序后 sha256，取前 10 位 hex 大写；落盘 settings 保证跨网卡变化也稳定。
  // 管理员身份硬编码（不开放修改，避免他人冒充）：派生ID → 固定标识。
  // 加 master2/master3：在那台机器上跑一次、看软件左下「我的ID」显示的派生ID，填进此表再发版即可。
  const ADMIN_IDS = {
    '2E314A3754': 'master1',     // 开发者笔记本（MAC 84:9e:56:77:52:9d）
    '731D97DD7B': 'master2'      // 开发者台式机（MAC 50:eb:f6:eb:83:02）
    // '<机器3派生ID>': 'master3'
  }
  ipcMain.handle('app:deviceId', () => {
    const s = storage.getSettings()
    let base = s && s.deviceId
    if (!base) {
      const os = require('os'); const crypto = require('crypto')
      const ifaces = os.networkInterfaces(); const macs = []
      for (const name of Object.keys(ifaces)) for (const i of (ifaces[name] || [])) {
        if (i.mac && i.mac !== '00:00:00:00:00:00' && !i.internal) macs.push(i.mac.toLowerCase())
      }
      macs.sort()
      const seed = macs.join(',') || os.hostname() || String(Date.now())
      base = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 10).toUpperCase()
      storage.setSettings({ deviceId: base })
    }
    return ADMIN_IDS[base] || base
  })

  // ---- 配置文件导入（线下分享：选 .lbcfg/.json 读回文本）----
  ipcMain.handle('linkbudget:openConfig', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: '链路预算配置', extensions: ['lbcfg', 'json'] }]
    })
    if (canceled || !filePaths || !filePaths.length) return { ok: false, canceled: true }
    try { return { ok: true, text: fs.readFileSync(filePaths[0], 'utf8') } }
    catch (err) { return { ok: false, error: err.message || String(err) } }
  })

  // ---- 在线分享信箱（COS）：按用户ID收发配置；未配置密钥时 configured=false ----
  if (share) {
    ipcMain.handle('share:configured', () => share.configured())
    ipcMain.handle('share:send', async (_e, recipientId, payload) => {
      try { return await share.send(recipientId, payload) } catch (err) { return { ok: false, error: err.message || String(err) } }
    })
    ipcMain.handle('share:inbox', async (_e, myId) => {
      try { return await share.inbox(myId) } catch (err) { return { ok: false, error: err.message || String(err) } }
    })
    ipcMain.handle('share:delete', async (_e, myId, id) => {
      try { return await share.remove(myId, id) } catch (err) { return { ok: false, error: err.message || String(err) } }
    })
  }
}

module.exports = { register }
