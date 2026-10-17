// ipcMain 在 register() 里被【同名局部变量刻意遮蔽】成带授权门禁的包装（见 gatedIpc），
// 所以这里必须换个名字导入 —— 否则 `const ipcMain = gatedIpc(ipcMain)` 会撞上 TDZ。
// 本文件里一律写 ipcMain.handle 即可，拿到的都是包装过的那个。
const { ipcMain: rawIpcMain, dialog, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const createOmm = require('../services/omm')
const createCustomSats = require('../services/customSats')
const createInterference = require('../services/interference')
const createModcod = require('../services/modcod')
const admBoundaries = require('../services/admBoundaries')
// 太阳射电流量 F10.7（日凌的太阳亮温靠它）：单例服务，取数链路与 omm.js 同一口径。
// ★ 只用 snapshot()（同步、只读本机）喂计算；联网刷新一律在算完之后不 await 地捅一下。
const solarFlux = require('../services/solarFlux')
// 卫星模型：modelwb:open 的目标参数清洗（纯函数；服务本体由 main 构造后传进来）
const { sanitizeTarget: sanitizeModelTarget } = require('../services/modelsLogic')
// 导出回执白名单（files:reveal / files:open 只认本会话写过的路径）+ 多文件落盘前的覆盖核对（交互调研 E3 / D5）
const exportedPaths = require('../services/exportedPaths')
// 系统对话框的标题 / 文件类型名按发起窗口的界面语言出字（中文原文 → dt 查表，查不到原样）
const { dt, dtFilters, dtFile, senderLang } = require('../services/dialogText')
// 计算窗 → 主窗口反向通道的参数清洗（交互调研 C3）
const { sanitizeSceneCmd } = require('../services/sceneCmd')

// 写成功的文件登记进回执白名单，并在返回值里补 path（单文件）/ paths（多文件）—— 原有字段一个不动。
// r 不是 ok 的原样返回；p 缺省取 r.filePath
function receipt(r, p) {
  if (!r || r.ok !== true) return r
  const one = p != null ? p : r.filePath
  if (Array.isArray(one)) {
    const list = one.filter((x) => typeof x === 'string' && x)
    exportedPaths.markAll(list)
    if (!('paths' in r)) r.paths = list
    if (!('path' in r) && list.length) r.path = list[0]
  } else if (typeof one === 'string' && one) {
    exportedPaths.markExported(one)
    if (!('path' in r)) r.path = one
  }
  return r
}

// 删用户导入的文件：先进系统回收站（shell.trashItem），进不去（网络盘 / 回收站关了 / 测试里没有 shell）再直接删；文件本就不在算成功。
async function trashOrUnlink(fp) {
  let shell = null
  try { shell = require('electron').shell } catch { shell = null }
  if (shell && typeof shell.trashItem === 'function') {
    try { await shell.trashItem(fp); return true } catch { /* 落到直接删 */ }
  }
  try { fs.unlinkSync(fp); return true } catch (e) { return !!(e && e.code === 'ENOENT') }
}

// tool:open 的上下文载荷清洗：只认身份与站址，现造纯数据并限长（渲染端 Proxy / 超长串 / 非法坐标一律挡在这里）。
//   sat   = { id, name, noradId, geo, slotLon, folder, altKm, inclDeg }（身份与定点经度；不送 satrec）
//   sites = [{ name, lat, lon, role }]，role ∈ 'tx' | 'rx' | 'both' | ''（链路预算按它写发 / 收哪一侧）
//   links = [{ name, nameAuto, nodes, hops, grp?, sl? }]：图上链路（形状见 packages/core/models/mapLinks.mjs 的 chainPayload / linkStrands）——
//           nodes 为 {t:'es', name, lat, lon, diaM?, radome?, pwrW?, altM?} | {t:'sat', key, name, noradId, geo, slotLon, folder, altKm, inclDeg, regen}，
//           hops[i].type ∈ up | down | isl | laser（节点 i → i+1）；坏节点 / 跳数对不上的整条丢掉。
//           Polygon / 航迹节点在主窗已按支路展开成单点载荷：altM = 航迹代表点的实际高度（m），grp = 来源链路 id，sl = 支路名；
//           一条链路至多 512 条支路，故条数上限放到 2000
// 三样都没有就返回 null（不送）。
function sanitizeToolContext(o) {
  if (!o || typeof o !== 'object') return null
  const str = (v, n) => (v == null ? '' : String(v)).slice(0, n)
  const num = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null))
  const out = {}
  const s = o.sat
  if (s && typeof s === 'object' && (s.name || s.noradId || s.id)) {
    const slot = num(s.slotLon)
    out.sat = {
      id: str(s.id, 160), name: str(s.name, 160), noradId: str(s.noradId, 24).replace(/[^\w-]/g, ''),
      geo: !!s.geo, slotLon: slot != null && Math.abs(slot) <= 360 ? slot : null,
      folder: str(s.folder, 160), altKm: num(s.altKm), inclDeg: num(s.inclDeg)
    }
  }
  if (Array.isArray(o.sites)) {
    const sites = []
    for (const x of o.sites.slice(0, 200)) {
      if (!x || typeof x !== 'object') continue
      const lat = num(x.lat), lon = num(x.lon)
      if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 360) continue
      sites.push({ name: str(x.name, 120), lat, lon, role: ['tx', 'rx', 'both'].includes(x.role) ? x.role : '' })
    }
    if (sites.length) out.sites = sites
  }
  if (Array.isArray(o.links)) {
    const HOPS = ['up', 'down', 'isl', 'laser']
    const links = []
    for (const l of o.links.slice(0, 2000)) {
      if (!l || typeof l !== 'object' || !Array.isArray(l.nodes)) continue
      const nodes = []
      let bad = false
      for (const n of l.nodes.slice(0, 32)) {
        if (n && n.t === 'es') {
          const lat = num(n.lat), lon = num(n.lon)
          if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 360) { bad = true; break }
          const e = { t: 'es', name: str(n.name, 120), lat, lon }
          const d = num(n.diaM)
          if (d != null && d > 0 && d <= 1000) e.diaM = d
          if (n.radome === true) e.radome = true
          const w = num(n.pwrW)
          if (w != null && w > 0 && w <= 100000) e.pwrW = w
          const h = num(n.altM)
          if (h != null && h >= -1000 && h <= 30000) e.altM = h   // 航迹代表点的实际高度（m；与航迹钉高同范围）
          nodes.push(e)
        } else if (n && n.t === 'sat') {
          const slot = num(n.slotLon)
          nodes.push({
            t: 'sat', key: str(n.key, 200), name: str(n.name, 160), noradId: str(n.noradId, 24).replace(/[^\w-]/g, ''), geo: !!n.geo,
            slotLon: slot != null && Math.abs(slot) <= 360 ? slot : null, folder: str(n.folder, 160), altKm: num(n.altKm), inclDeg: num(n.inclDeg), regen: !!n.regen
          })
        } else { bad = true; break }
      }
      if (bad || nodes.length < 2) continue
      const hops = (Array.isArray(l.hops) ? l.hops : []).slice(0, nodes.length - 1).map((h) => ({ type: h && HOPS.includes(h.type) ? h.type : '' }))
      if (hops.length !== nodes.length - 1 || hops.some((h) => !h.type)) continue
      const lk = { name: str(l.name, 300), nameAuto: l.nameAuto !== false, nodes, hops }
      const grp = str(l.grp, 80), sl = str(l.sl, 200)
      if (grp) lk.grp = grp
      if (sl) lk.sl = sl
      links.push(lk)
    }
    if (links.length) out.links = links
  }
  return (out.sat || out.sites || out.links) ? out : null
}

// 写盘失败的友好文案：目标文件被其他程序占用（PDF/图片查看器打开着）→ EBUSY/EPERM/EACCES。
const writeErrText = (err) => (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')
  ? '文件可能正被其他程序打开（如 PDF 查看器）'
  : (err && err.message) || String(err))

// 保存框预填的文件名只当【文件名】用：Windows 上 defaultPath 里的 / \ 会被当成路径分隔，
// 「合计 C/N.png」「中星6E C/Ku 频率计划.png」预填出来只剩「N.png」「Ku 频率计划.png」；
// 其余 :*?"<>| 是文件名非法字符（对话框拒收或当成通配符）。一律换成 -。
const safeSaveName = (s, dflt) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim() || dflt

// 注册所有 IPC 处理器。core 为返回引擎实例的函数（延迟解析）。
function register({ core, storage, report, coverage, coverageGrd, coverageGxt, share, openLinkBudget, openSunOutage, confirmCloseSunOutage, grd, confirmCloseLinkBudget, openNgso, confirmCloseNgso, openRegen, confirmCloseRegen, openE2e, confirmCloseE2e, openRain, confirmCloseRain, openCi, openPfd, openSsa, confirmCloseSsa, freqPlan, openFreqPlan, notifyFreqPlan, activation, weather, gfs, updater, perfWin, models, openModel, confirmCloseModel, quitApp, sceneRelay }) {
  // 未激活拦截（主进程硬防线；渲染端菜单/工具栏的拦截只是第一道观感）：
  // 各功能窗口的 open 一律先过这里——渲染端被绕过（devtools 直调 IPC）也开不出窗。
  // （下方九处 *:open 仍显式写着 gate(...)，在新的默认全拦之下已是冗余的第二层，无副作用，
  //   保留是因为它在调用处直白地标出「这条是锁内功能」。）
  const gate = (fn) => (...args) => {
    if (activation && !activation.current().active) return { locked: true }
    return fn(...args)
  }

  // ---- 默认全拦、白名单放行（2026-08-11 授权审计）----
  // 改法的由来：原先只有九个 *:open 套了 gate，于是未激活用户绕开渲染端（控制台直调 IPC、
  // 或改 asar 里的渲染代码）就能调到真正值钱的那批 handler —— report:exportReport 出交付级
  // 报告、link:* 全套链路预算、ci:* 干扰计算、pfd:generate 出 Mask，全是裸的。开窗被拦住了，
  // 但功能压根不需要开窗就能调。
  //
  // 现在反过来：register() 里注册的每一个 handler 默认都在锁内，只有下面 UNGATED 里点名的
  // 才在未激活时可用。失败方向也因此反了 —— 将来新增 handler 忘了归类，是「锁着、测试时立刻
  // 发现」，而不是「敞着、没人发现」。
  //
  // UNGATED 收的是两类：
  //   ① 授权流程自身（不放行就永远激活不了）与外壳（标题栏/版本/设置读写）；
  //   ② 主窗口的浏览面 —— 产品明确决定未激活也保留地球/星座等已加载内容可看
  //      （见 ActivationLock.vue 注释：主窗口刻意不上遮罩），所以星历读取、覆盖图/频率
  //      规划的只读取数、城市与字段定义这些查询要放行，否则未激活时主窗口直接空白。
  // 凡是「产出交付物」的一律不在表里：计算、导出、落盘、导入、对外分享。
  const UNGATED = new Set([
    // ① 授权与外壳
    'activation:status', 'activation:refresh', 'app:version', 'app:deviceId',
    'window:setOverlay', 'window:setTheme', 'font:pdf',
    'store:settings:get', 'store:settings:set',
    // 检查更新：拿不到激活的老版本也得能升到修好的版本
    'updater:state', 'updater:check', 'updater:install',
    // 窗口关闭确认：拦掉会导致功能窗口关不干净（锁定期间窗口仍在，只是被遮罩盖住）
    'linkbudget:confirmClose', 'ngso:confirmClose', 'regen:confirmClose', 'e2e:confirmClose', 'rain:confirmClose', 'ssa:confirmClose', 'suntool:confirmClose',
    'modelwb:confirmClose',
    // 性能指标表窗口的中继（开窗 perfwin:open 仍在锁内；这几条只搬运两窗之间的消息，不产出交付物）
    'perfwin:push', 'perfwin:act', 'perfwin:close', 'perfwin:setTitle', 'perfwin:list', 'perfwin:self',
    // 退出程序（锁定期间也得退得掉）；计算窗 → 主窗口的场景命令中继（同 perfwin:act，只搬运消息）；
    // 导出回执的打开 / 定位（只认本会话已写出的文件，写出那一步本身在锁内）
    'app:quit', 'scene:cmd', 'files:reveal', 'files:open',
    // ② 浏览面（只读查询，不产出交付物）
    'omm:positions', 'omm:csv', 'omm:list',
    'omm:customList', 'omm:customCsv', 'omm:customGroupRecords',
    // 地图取星的两条：customRawVisible 顶替 customCsv 供「自定义卫星」分组取可见组的并集，
    // ephemTable 供点序列星取位。不放行主窗口的星座图就空了一半（与 customCsv 同一条理由）。
    'omm:customRawVisible', 'omm:ephemTable',
    // 叠加星历的对应关系：地图取位要它（导入星历「对应已有卫星」后，那颗星在星历时段内改由导入的表供位）
    'omm:ephemBindings',
    'coverage:index', 'coverage:get',
    'coverageGrd:index', 'coverageGrd:get', 'coverageGrd:raw',
    'coverageGxt:index', 'coverageGxt:get', 'coverageGxt:raw',
    'freqPlan:list', 'freqPlan:get',
    'store:history:list', 'store:config:list', 'store:library:get',
    'env:defs', 'env:field',
    'adm:pack',
    // 太阳射电流量 F10.7：一条只读查询 + 一条后台刷新，都不产出交付物（日凌计算本身仍在锁内）
    'sunoutage:solarFlux', 'sunoutage:solarFluxRefresh',
    'link:cities', 'link:cityGroups', 'link:searchCities', 'link:baseband', 'link:outputDefs',
    // 分享的收件侧：收/删/探视是别人推过来的东西，不算本机产出；发件侧（send/boxSend/
    // gxtSnapshot/boxRevoke）不在表里，未激活不许往外发
    'share:configured', 'share:inbox', 'share:delete', 'share:boxPeek',
    // 卫星 3D 模型的只读浏览面（设计契约 T13）：主窗口 3D 页未激活也能看球面模型图标 / 跟随视图，
    // 所以清单、取件（ensure 会按需下载公开的 NASA 模型）、元数据、绑定表与缓存读数放行。
    // 导入 / 导出 / 改元数据 / 改绑定 / 开工作台全在锁内。models:cancel 走 ipcMain.on，本就不经门禁。
    'models:manifest', 'models:ensure', 'models:thumbnail', 'models:getMeta', 'models:bindings:get', 'models:cacheInfo'
  ])
  // 同名遮蔽 electron 的 ipcMain：本文件下方一百多处 ipcMain.handle 因此自动过门禁，
  // 不必逐条改写、将来新增的也漏不掉。注意只覆盖本文件——services/reportPdf.js 里那个
  // report:print:model 是隐藏打印窗专用（只在已过门禁的导出流程中被拉起），不受此表管辖。
  const ipcMain = {
    handle: (channel, fn) => rawIpcMain.handle(channel, UNGATED.has(channel) ? fn : gate(fn)),
    on: (...a) => rawIpcMain.on(...a),
    removeHandler: (...a) => rawIpcMain.removeHandler(...a)
  }
  const omm = createOmm(core)
  const customSats = createCustomSats(core)
  // 星历导入编排（预览 + 候选匹配）与导出引擎：都只读写 customSats / omm 的数据，不碰窗口
  const ephemImport = require('../services/ephemImport')({ customSats, omm, getCore: core })
  const ephemExport = require('../services/ephemExport')({ customSats, omm, getCore: core })
  const TC = require('../../packages/core/utils/textCodec.js')
  const modcod = createModcod()
  // grd 传进去是给 NGSO 时变的「卫星发射方向图取 GRD 实测图」用的（见 resolveSatPattern）
  const interference = createInterference(omm, customSats, core, grd)

  // 主窗口自定义标题栏：主题切换时把原生窗口控制按钮（Windows 覆盖式）的配色跟到当前主题。
  // 非覆盖式窗口（如各链路预算独立窗口）无 setTitleBarOverlay，静默忽略。
  ipcMain.handle('window:setOverlay', (e, opt) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || typeof win.setTitleBarOverlay !== 'function') return false
    try { win.setTitleBarOverlay(opt); return true } catch { return false }
  })
  // 当前外观（light / dark / studio）：之后新开窗口的底色与主窗三键区初值按它取，见 services/winTheme.js
  ipcMain.handle('window:setTheme', (_e, kind, source) => require('../services/winTheme').setKind(kind, source))
  // ---- 退出 / 场景命令 / 导出回执（交互调研 C1 / C3 / E3）----
  // 退出：主进程逐个关计算窗（各走各的关窗守卫）、全部关完再退出（main.js requestQuit）；立即返回，不等退出走完
  ipcMain.handle('app:quit', () => { if (quitApp) quitApp() })
  // 计算窗 → 主窗口：白名单清洗（未知 cmd / 非法参数 → false），转给主窗口并提到前面；主窗口不在 → false
  ipcMain.handle('scene:cmd', (_e, cmd, payload) => {
    const c = sanitizeSceneCmd(cmd, payload)
    return !!(c && sceneRelay && sceneRelay(c))
  })
  // 在资源管理器中显示 / 用系统默认程序打开：只认本会话写过的文件（exportedPaths），文件已不在 → false
  const exportedTarget = (p) => {
    if (typeof p !== 'string' || !p || !exportedPaths.isExported(p)) return ''
    const q = path.resolve(p)
    try { fs.statSync(q) } catch { return '' }
    return q
  }
  ipcMain.handle('files:reveal', (_e, p) => {
    const q = exportedTarget(p)
    if (!q) return false
    try { require('electron').shell.showItemInFolder(q); return true } catch { return false }
  })
  ipcMain.handle('files:open', async (_e, p) => {
    const q = exportedTarget(p)
    if (!q) return false
    try { return !(await require('electron').shell.openPath(q)) } catch { return false }
  })
  ipcMain.handle('omm:positions', (_e, group, iso) => omm.positions(group, iso))
  ipcMain.handle('omm:csv', (_e, group, opts) => omm.fetchCsv(group, opts))
  // CelesTrak 卫星编目（SATCAT）：与 17 个 GP 组同一个 fetchCsv、同一条四级众包链路，只是 URL /
  // 判据 / 标签不同（见 services/omm.js 的 DATASETS）。不在 UNGATED 里 —— 它只服务空间态势报告
  // 这一个锁内功能，主窗口的浏览面用不到它。
  ipcMain.handle('satcat:csv', (_e, opts) => omm.fetchCsv('satcat', opts))

  // ---- 文件管理：星历导入/导出的六种官方格式 ----
  // 格式选择走【原生对话框的文件类型下拉 + 用户敲的扩展名】：Electron 不回传用户选了哪个 filter，
  // 故一律以最终 filePath 的扩展名为准（选了类型，文件名的扩展名就跟着变，两者天然同步）。
  const eph = require('../../packages/core/utils/ommFormats.js')
  // 只收无歧义的扩展名。'.txt' 不在表里是有意的：TLE/3LE/OMM 都有人存成 .txt，用它猜格式必然猜错一半。
  const EXT2FMT = { csv: 'omm-csv', json: 'omm-json', kvn: 'omm-kvn', xml: 'omm-xml', tle: 'tle', '3le': '3le', e: 'stk-e', oem: 'ccsds-oem-kvn' }
  // 点序列那一侧的同名表：.xml 在两套体系里都合法（OMM/XML 与 OEM/XML），
  // 故按「本次导出想要的是哪一类」分表查，不靠扩展名单独断。
  const ephF = require('../../packages/core/utils/ephemFormats.js')
  const EXT2FMT_EPH = { e: 'stk-e', oem: 'ccsds-oem-kvn', xml: 'ccsds-oem-xml', kvn: 'ccsds-oem-kvn', sp3: 'sp3', eph: 'cs-eph' }
  const isEphemFmt = (f) => ephF.FORMATS.includes(f)
  // gp 记录按 SGP4 采样导出成点序列时的实际口径：渲染端没给 opts 就是 customSats 的缺省
  // （每颗星历元 ±1 天 / 60 s / TEME = 2881 点），随保存结果一并回去，省得两边各写一份缺省值。
  // fromMs / toMs 为 null 表示「按每颗星各自的历元 ±1 天」—— 缺省口径下唯一诚实的写法。
  const ephemSampleMeta = (opts) => {
    const o = opts || {}
    const d = createCustomSats.EPHEM_SAMPLE
    const from = Number(o.fromMs), to = Number(o.toMs)
    const stepS = Math.max(1, Number(o.stepS) || d.stepS)
    const spanMs = Number.isFinite(from) && Number.isFinite(to) ? to - from : 2 * d.spanMs
    return {
      stepS, frame: o.frame || 'TEME', maxSats: d.maxSats,
      fromMs: Number.isFinite(from) ? from : null,
      toMs: Number.isFinite(to) ? to : null,
      spanMs, points: Math.floor(spanMs / (stepS * 1000)) + 1
    }
  }
  // 扩展名认不出（手打了 .txt、或压根没打扩展名）时不硬猜，落回对话框里选中的那个格式 want——
  // 否则「类型选 OMM CSV、文件名手打 a.txt」会静默导出成 3LE，文件打开前一点提示都没有。
  const fmtOfPath = (fp, want) => {
    const ext = String(fp || '').split('.').pop().toLowerCase()
    if (isEphemFmt(want)) return EXT2FMT_EPH[ext] || want
    return EXT2FMT[ext] || (eph.FORMATS.includes(want) ? want : 'omm-csv')
  }
  // 保存对话框的类型下拉：把 preferred 排在首位，它决定默认扩展名与默认选中项
  function saveFilters(preferred) {
    const all = [
      { name: 'OMM CSV', extensions: ['csv'] },
      { name: 'OMM JSON', extensions: ['json'] },
      { name: 'OMM KVN（CCSDS）', extensions: ['kvn'] },
      { name: 'OMM XML（CCSDS）', extensions: ['xml'] },
      { name: 'TLE（两行）', extensions: ['tle'] },
      { name: '3LE（三行）', extensions: ['3le'] },
      { name: 'STK 星历（.e）', extensions: ['e'] },
      { name: 'CCSDS OEM（KVN）', extensions: ['oem'] }
    ]
    const i = all.findIndex((f) => f.extensions[0] === preferred)
    return i > 0 ? [all[i]].concat(all.slice(0, i), all.slice(i + 1)) : all
  }
  // 点序列组的保存下拉：只给点序列三种（它没有平均根数，出不了 OMM/TLE）
  function saveFiltersEphem(preferred) {
    const all = [
      { name: 'STK 星历（.e）', extensions: ['e'] },
      { name: 'CCSDS OEM（KVN）', extensions: ['oem'] },
      { name: 'CCSDS OEM（XML）', extensions: ['xml'] },
      { name: '中国卫通星历（.eph）', extensions: ['eph'] }
    ]
    const i = all.findIndex((f) => f.extensions[0] === preferred)
    return i > 0 ? [all[i]].concat(all.slice(0, i), all.slice(i + 1)) : all
  }
  const openFilters = (lang) => dtFilters([
    { name: '星历文件 (OMM · TLE · STK .e · CCSDS OEM · SP3 · 中国卫通 .eph · GPS 年历)', extensions: ['csv', 'json', 'kvn', 'xml', 'tle', '3le', 'txt', 'e', 'oem', 'sp3', 'sp3c', 'sp3d', 'eph', 'alm', 'al3'] },
    { name: '所有文件', extensions: ['*'] }
  ], lang)

  // ---- 文件管理：OMM 星座组缓存的列举 / 导入替换 / 导出 ----
  ipcMain.handle('omm:list', () => omm.listCsv())
  // 导入并替换某组 OMM：原生选 .csv → 校验 → 覆盖缓存。返回 { ok, key, mtime, count } 或 { canceled }/{ ok:false, error }
  // 两类数据集共用这一条：17 个星座组的内容是【星历】（走六种官方格式的解析与互转），
  // SATCAT 的内容是【编目】—— 它没有根数，喂给 parseEphemeris 必然是「无法识别的星历格式」。
  // 故 satcat 单走一条：判据就是 omm.writeCsvRaw 内部那把尺（validOf → validSatcat），
  // 原文落盘、不转任何格式。
  const isCatalog = (key) => key === 'satcat'
  const CATALOG_LABEL = 'CelesTrak 卫星编目（SATCAT）'
  ipcMain.handle('omm:import', async (e, key) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const cat = isCatalog(key)
    const lang = await senderLang(e)
    const en = lang === 'en'
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: cat
        ? (en ? 'Import Catalog (replace “CelesTrak Satellite Catalog (SATCAT)”)' : `导入编目（替换「${CATALOG_LABEL}」）`)
        : (en ? `Import Ephemeris (replace “${key}”)` : `导入星历（替换「${key}」）`),
      properties: ['openFile'],
      filters: cat ? dtFilters([{ name: '卫星编目 CSV（CelesTrak satcat.csv）', extensions: ['csv'] }, { name: '所有文件', extensions: ['*'] }], lang) : openFilters(lang)
    })
    if (canceled || !filePaths || !filePaths.length) return { canceled: true }
    try {
      // 按字节读再认编码（UTF-8 / UTF-16 / GBK）：国内软件导出的 ANSI 文件按 UTF-8 读会把中文字段读坏
      const text = TC.decodeText(fs.readFileSync(filePaths[0])).text
      if (cat) {
        // writeCsvRaw 自带判据（首行列名 + 行数下限 + 末行 17 列防截断），不合格它会抛
        return omm.writeCsvRaw(key, text)
      }
      const r = eph.parseEphemeris(text)
      if (!r.records.length) return { ok: false, error: '文件中没有可用的星历记录：' + (r.errors[0] || '格式不符') }
      // 逐条 SGP4 校验，与自定义库同一把尺。这一路以前只查表头有没有 MEAN_MOTION 那个词，
      // 于是历元体例不受支持（如 CCSDS 允许的年内天 2026-230T…）或缺平均运动的 OMM 会被原样
      // 写进星座缓存，此后该组传播全是 NaN、地图上什么都不画，还一声不吭。
      const chk = customSats.checkRecords(r.records)
      if (!chk.valid) return { ok: false, error: '无有效卫星（' + (chk.reason || '全部校验失败') + '）' }
      // 星座组的缓存契约是 OMM CSV（omm.js 全链路读它），故 CSV 原样落盘保住字节，
      // 其余五种格式解析后转 CSV 再落盘 —— 导出时可再转回任一格式，值逐字不变。
      const res = r.format === 'omm-csv'
        ? omm.writeCsvRaw(key, text)
        : Object.assign(omm.writeCsvRaw(key, eph.serializeEphemeris(r.records, 'omm-csv')), { convertedFrom: r.format })
      return chk.invalid ? Object.assign({}, res, { invalid: chk.invalid }) : res
    } catch (err) { return { ok: false, error: err.message || String(err) } }
  })
  // 导出某组缓存 OMM 到用户选定路径
  ipcMain.handle('omm:export', async (e, key, format) => {
    const r = omm.readCsvRaw(key)
    if (!r) return { ok: false, error: '该组暂无本地缓存。' }
    const cat = isCatalog(key)
    // 编目只出原文 CSV：那六种是星历格式，对一份没有根数的编目一个都不适用，
    // 给出下拉只会让用户选中 .tle 之后拿到一句「缓存解析失败」
    if (cat) {
      const win2 = BrowserWindow.fromWebContents(e.sender)
      const { canceled: c2, filePath: fp2 } = await dialog.showSaveDialog(win2, {
        defaultPath: 'satcat.csv', filters: dtFilters([{ name: '卫星编目 CSV（CelesTrak satcat.csv）', extensions: ['csv'] }], await senderLang(e))
      })
      if (c2 || !fp2) return { ok: false, canceled: true }
      try {
        fs.writeFileSync(fp2, r.text)
        return receipt({ ok: true, filePath: fp2, format: 'satcat-csv' })
      } catch (err) { return { ok: false, error: writeErrText(err) } }
    }
    const pref = eph.FORMAT_EXT[format] || 'csv'
    const win = BrowserWindow.fromWebContents(e.sender)
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `${key}_OMM.${pref}`, filters: dtFilters(saveFilters(pref), await senderLang(e))
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    const fmt = fmtOfPath(filePath, format)
    try {
      // 缓存本身就是官方 CSV 原文：导 CSV 直接吐原文（逐字节等同官方），其余格式规范重建
      let text = r.text
      if (fmt !== 'omm-csv') {
        const p = eph.parseEphemeris(r.text, 'omm-csv')
        if (!p.records.length) return { ok: false, error: '缓存解析失败，无法转换格式' }
        text = eph.serializeEphemeris(p.records, fmt)
      }
      fs.writeFileSync(filePath, text)
      return receipt({ ok: true, filePath, format: fmt })
    } catch (err) { return { ok: false, error: err.message || String(err) } }
  })

  // ---- 文件管理：自定义卫星星历库（逐条配置：每个导入文件一组，各自导出/删除）----
  ipcMain.handle('omm:customList', () => customSats.list())
  // 3D 地图分组 / 搜索池加载用：全部组扁平化为一份 OMM CSV（{text, fetchedAt} 或 null，绝不联网）
  ipcMain.handle('omm:customCsv', () => customSats.raw())
  // 某个导入组的 OMM 记录原样返回（「发送到小程序」按组打包用；不存在的组给空数组）
  ipcMain.handle('omm:customGroupRecords', (_e, groupId) => customSats.groupRecords(groupId) || [])
  // 删除 / 改名某个导入组
  ipcMain.handle('omm:customRemove', (_e, groupId) => customSats.removeGroup(groupId))
  ipcMain.handle('omm:customRename', (_e, groupId, name) => customSats.renameGroup(groupId, name))
  // 星座栏「导入星历」区块：显隐 / 配色落库（只改这两项）
  ipcMain.handle('omm:customUpdateGroup', (_e, groupId, patch) => customSats.updateGroup(groupId, patch))
  // 地图用的扁平并集：只吐【可见】的 gp 组，另附 NORAD -> 'ci:<组id>' 归属表（按组着色靠它）
  ipcMain.handle('omm:customRawVisible', () => customSats.rawVisible())
  // 某 ephem 组的采样表：typed array 走结构化克隆原样过去，不转普通数组（几 MB 的表转数组会慢一个量级）
  ipcMain.handle('omm:ephemTable', (_e, groupId) => customSats.ephemTable(groupId))
  // 拖放导入：渲染端 FileReader 读好文本再传（不依赖 Electron 版本的 File.path）
  ipcMain.handle('omm:customImportText', (_e, files) => {
    const list = Array.isArray(files) ? files : []
    const acc = { ok: true, groups: 0, sats: 0, replaced: 0, invalid: 0, ephem: 0, errors: [], warnings: [], formats: [], kinds: {} }
    for (const f of list) {
      const base = String((f && f.name) || '星历').replace(/\.[^.]+$/, '')
      const bytes = f && f.bytes ? Buffer.from(f.bytes) : null
      const dec = bytes ? TC.decodeText(bytes) : { text: String((f && f.text) || ''), encoding: '' }
      const r = customSats.importFile(base, dec.text, { bytes, encoding: dec.encoding })
      accImport(acc, base, r)
    }
    return acc
  })
  // 导入结果累加（原生对话框与拖放两条路共用，口径必须一致）
  function accImport(acc, label, r) {
    if (!r || !r.ok) { acc.errors.push(label + '：' + ((r && r.error) || '导入失败')); return }
    acc.groups += 1; acc.sats += r.group.count; acc.replaced += r.replaced ? 1 : 0; acc.invalid += r.invalid || 0
    const kind = r.group.kind || 'gp'
    acc.kinds[kind] = (acc.kinds[kind] || 0) + 1
    if (kind === 'ephem') acc.ephem += r.group.count
    if (r.group.format && acc.formats.indexOf(r.group.format) < 0) acc.formats.push(r.group.format)
    if (r.errors && r.errors.length) acc.errors.push(...r.errors)
    if (r.warnings && r.warnings.length) acc.warnings.push(...r.warnings)
  }
  // 导入星历（可多选）：每个文件 = 一个命名组（同名替换），六种官方格式按内容自动识别。
  ipcMain.handle('omm:customImport', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const lang = await senderLang(e)
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: dt('导入星历（可多选，每文件一组）', lang), properties: ['openFile', 'multiSelections'], filters: openFilters(lang)
    })
    if (canceled || !filePaths || !filePaths.length) return { canceled: true }
    const path = require('path')
    const acc = { ok: true, groups: 0, sats: 0, replaced: 0, invalid: 0, ephem: 0, errors: [], warnings: [], formats: [], kinds: {} }
    for (const fp of filePaths) {
      const base = path.basename(fp).replace(/\.(csv|json|kvn|xml|tle|3le|txt|e|oem|sp3|sp3c|sp3d|eph|alm|al3)$/i, '')
      let bytes
      try { bytes = fs.readFileSync(fp) } catch (err) { acc.errors.push(path.basename(fp) + '：读取失败 ' + (err.message || err)); continue }
      const dec = TC.decodeText(bytes)
      accImport(acc, path.basename(fp), customSats.importFile(base, dec.text, { bytes, encoding: dec.encoding }))
    }
    return acc
  })
  // 导出某个导入组（文件历元）。格式与导入时相同 → 吐原文，逐字节等同官方源文件。
  // 点序列组只给点序列三格式；gp 组导出成点序列格式时按 opts 用 SGP4 采样（缺省历元 ±1 天 / 60 s / TEME）。
  ipcMain.handle('omm:customExportGroup', async (e, groupId, defaultName, format, opts) => {
    const g = (customSats.list().groups || []).find((x) => x.id === groupId)
    if (!g) return { ok: false, error: '该组不存在' }
    const isEph = g.kind === 'ephem'
    const r = await saveEph(e, defaultName || (isEph ? '导入星历' : '导入组'), format,
      (fmt) => customSats.groupText(groupId, fmt, opts), '该组无卫星可导出', isEph)
    // gp 组落成点序列的那一档是现采的：把本次的时窗 / 步长 / 帧一并回给调用方
    if (r.ok && !isEph && isEphemFmt(r.format)) r.sample = ephemSampleMeta(opts)
    return r
  })
  // 导出任意 OMM 记录（自建星座展开记录由渲染进程传入，场景历元）
  ipcMain.handle('omm:exportRecords', async (e, records, defaultName, format, opts) => {
    const r = await saveEph(e, defaultName || '自定义星历', format,
      (fmt) => (isEphemFmt(fmt) ? customSats.recordsEphemText(records, fmt, opts) : customSats.recordsText(records, fmt)),
      '无可导出的星历记录')
    if (r.ok && isEphemFmt(r.format)) r.sample = ephemSampleMeta(opts)
    return r
  })
  // ---- 星历导入：预览（解析 + 逐星「已有卫星」候选）→ 用户选对应关系 → 提交 ----
  ipcMain.handle('omm:importPick', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const lang = await senderLang(e)
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: dt('导入星历（可多选，每文件一组）', lang), properties: ['openFile', 'multiSelections'], filters: openFilters(lang)
    })
    if (canceled || !filePaths || !filePaths.length) return { canceled: true }
    const files = [], failed = []
    for (const fp of filePaths) {
      try { files.push({ name: path.basename(fp), bytes: fs.readFileSync(fp) }) }
      catch (err) { failed.push({ fileName: path.basename(fp), ok: false, error: '读取失败：' + (err.message || err) }) }
    }
    return { previews: ephemImport.preview(files).concat(failed) }
  })
  // 拖放：渲染端读成字节（ArrayBuffer / Uint8Array）传来，编码仍在主进程认
  ipcMain.handle('omm:importPreview', (_e, files) => {
    const list = (Array.isArray(files) ? files : []).map((f) => ({ name: String((f && f.name) || '星历'), bytes: f && f.bytes ? Buffer.from(f.bytes) : null, text: f && f.text }))
    return { previews: ephemImport.preview(list) }
  })
  // list: [{ token, name（组名）, binds:[{ noradId, name }|null], label（日志里的文件名）}]
  ipcMain.handle('omm:importCommit', (_e, list) => {
    const acc = { ok: true, groups: 0, sats: 0, replaced: 0, invalid: 0, ephem: 0, bound: 0, errors: [], warnings: [], formats: [], kinds: {}, groupIds: [] }
    for (const c of (Array.isArray(list) ? list : [])) {
      let r
      try { r = ephemImport.commit(c.token, { name: c.name, binds: c.binds || [] }) } catch (err) { r = { ok: false, error: err.message || String(err) } }
      accImport(acc, c.label || c.name || '星历', r)
      if (r && r.ok && r.group) { acc.groupIds.push(r.group.id); acc.bound += r.group.bound || 0 }
    }
    return acc
  })
  ipcMain.handle('omm:importCancel', (_e, tokens) => { ephemImport.cancel(tokens); return true })
  ipcMain.handle('omm:ephemBindings', () => customSats.bindings())
  ipcMain.handle('omm:ephemRebind', (_e, groupId, key, target) => customSats.rebind(groupId, key, target))
  // 已导入的点序列组改对应关系：读数 + 候选（与导入预览同形，导入对话框的「对应已有卫星」模式用）
  ipcMain.handle('omm:rebindPreview', (_e, groupId) => ephemImport.rebindPreview(groupId))

  // ---- 星历导出：任意一批卫星 → 任一格式（引擎见 services/ephemExport.js）----
  ipcMain.handle('omm:exportPlan', (_e, req) => ephemExport.plan(req || {}))
  const exportJobs = new Map()
  ipcMain.handle('omm:exportEphem', async (e, req) => {
    const r = req || {}
    const op = ephemExport.outputPlan(r)
    const win = BrowserWindow.fromWebContents(e.sender)
    let target
    if (op.perFile) {
      const { canceled, filePaths } = await dialog.showOpenDialog(win, { title: dt('选择导出文件夹（每颗卫星一个文件）', await senderLang(e, r.lang)), properties: ['openDirectory', 'createDirectory'] })
      if (canceled || !filePaths || !filePaths[0]) return { ok: false, canceled: true }
      target = { dir: filePaths[0] }
    } else {
      const ext = op.ext.replace(/^\./, '')
      const label = (eph.FORMAT_LABEL[op.format] || ephF.FORMAT_LABEL[op.format] || op.format)
      const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: safeSaveName(op.defaultName, 'ephemeris') + op.ext, filters: [{ name: dt(label, await senderLang(e, r.lang)), extensions: [ext] }] })
      if (canceled || !filePath) return { ok: false, canceled: true }
      target = { file: /\.[^./\\]+$/.test(path.basename(filePath)) ? filePath : filePath + op.ext }
    }
    const id = String(r.jobId || Date.now())
    const job = { cancelled: false }
    exportJobs.set(id, job)
    try {
      const res = await ephemExport.run(r, target, (p) => { try { if (!e.sender.isDestroyed()) e.sender.send('omm:exportProgress', Object.assign({ id }, p)) } catch { /* 窗口没了 */ } }, () => job.cancelled)
      // 回执：files[].path 逐个登记 → paths；单文件档 path = 选的那个文件，逐星分文件档另带 dir（也登记，可「打开」文件夹）
      if (res && res.ok === true) {
        const list = (Array.isArray(res.files) ? res.files : []).map((f) => f && f.path).filter((p) => typeof p === 'string' && p)
        if (target.dir) { exportedPaths.markExported(target.dir); if (!('dir' in res)) res.dir = target.dir }
        receipt(res, list)
        if (target.file && list.length) res.path = target.file
      }
      return res
    } catch (err) { return { ok: false, error: writeErrText ? writeErrText(err) : (err.message || String(err)) } }
    finally { exportJobs.delete(id) }
  })
  ipcMain.handle('omm:exportCancel', (_e, id) => { const j = exportJobs.get(String(id)); if (j) j.cancelled = true; return !!j })

  // 保存对话框 → 按最终扩展名定格式 → 交给 build(fmt) 出文本。
  // SP3 只解析不写出（ephF.WRITABLE 只有三种），故入口先归一成 stk-e：扩展名、默认文件名、
  // 类型下拉与返回值里的 format 全部以归一后的为准；出口再归一一次，接住用户手打 .sp3 的情况。
  async function saveEph(e, baseName, format, build, emptyMsg, ephemOnly) {
    const want = ephF.writableFormat(format)
    const pref = (ephemOnly ? ephF.FORMAT_EXT[want] : (eph.FORMAT_EXT[want] || ephF.FORMAT_EXT[want]))
    const ext = String(pref || (ephemOnly ? '.e' : 'csv')).replace(/^\./, '')
    const win = BrowserWindow.fromWebContents(e.sender)
    const lang = await senderLang(e)
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `${dt(baseName, lang)}_${ephemOnly ? dt('星历', lang) : 'OMM'}.${ext}`,
      filters: dtFilters(ephemOnly ? saveFiltersEphem(ext) : saveFilters(ext), lang)
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    const fmt = ephF.writableFormat(fmtOfPath(filePath, want))
    let text
    try { text = build(fmt) } catch (err) { return { ok: false, error: err.message || String(err) } }
    if (!text) return { ok: false, error: emptyMsg }
    // 写出编码跟格式走：中国卫通 .eph 是 GBK（源软件是简体中文 ANSI 程序），其余 UTF-8
    const enc = ephF.FORMAT_ENCODING[fmt]
    try { fs.writeFileSync(filePath, enc === 'gbk' ? Buffer.from(TC.encodeText(text, 'gbk')) : text); return receipt({ ok: true, filePath, format: fmt }) }
    catch (err) { return { ok: false, error: err.message || String(err) } }
  }

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
    // 用户导入：原生框选（多选）→ 逐个读原文返回渲染进程解析（gxt/parse.js、kml/parse.js、gxt/json.js）。
    // KML 与 GXT 结构 JSON 是 UTF-8，GXT 是 latin1 定长文本，编码按扩展名分派（读错编码 → 中文名乱码）。
    // opts.any：「导入…」批量入口 —— 过滤器放宽到全部波束地图格式（KMZ / GeoJSON / CSV / Shapefile / MapInfo / 自定义）；
    // opts.bytes：另带原始字节（KMZ / ZIP / Shapefile 是二进制；导入脚本拿到的是字节，自己识别编码）。
    ipcMain.handle('coverageGxt:open', async (e, opts) => {
      const o = (opts && typeof opts === 'object') ? opts : {}
      const win = BrowserWindow.fromWebContents(e.sender)
      const lang = await senderLang(e)
      const filters = o.any
        ? [
            { name: '波束地图 (*.gxt, *.kml, *.kmz, *.json, *.geojson, *.csv, *.zip, *.shp, *.mif)', extensions: ['gxt', 'kml', 'kmz', 'json', 'geojson', 'csv', 'txt', 'zip', 'shp', 'dbf', 'shx', 'prj', 'cpg', 'mif', 'mid'] },
            { name: 'GXT 等值线 (*.gxt)', extensions: ['gxt'] },
            { name: 'KML / KMZ (*.kml, *.kmz)', extensions: ['kml', 'kmz'] },
            { name: 'JSON / GeoJSON (*.json, *.geojson)', extensions: ['json', 'geojson'] },
            { name: '所有文件', extensions: ['*'] }
          ]
        : [
            { name: '覆盖等值线 (*.gxt, *.kml, *.json)', extensions: ['gxt', 'kml', 'json'] },
            { name: 'GXT 等值线 (*.gxt)', extensions: ['gxt'] },
            { name: 'KML (*.kml)', extensions: ['kml'] },
            { name: 'GXT 结构 JSON (*.json)', extensions: ['json'] },
            { name: '所有文件', extensions: ['*'] }
          ]
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: dt(o.any ? '导入波束地图（可多选）' : '导入覆盖等值线（GXT / KML / JSON，可多选）', lang), properties: ['openFile', 'multiSelections'],
        filters: dtFilters(filters, lang)
      })
      if (canceled || !filePaths || !filePaths.length) return { canceled: true }
      const path = require('path')
      const files = filePaths.map((fp) => {
        const ext = path.extname(fp).slice(1).toLowerCase()
        try {
          const buf = fs.readFileSync(fp)
          const out = { base: path.basename(fp), ext, text: buf.toString(ext === 'kml' || ext === 'json' ? 'utf8' : 'latin1') }
          if (o.bytes) out.bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
          return out
        } catch (err) { return { base: path.basename(fp), ext, error: err.message } }
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
    // 解析天线记录（*.gauss.json）改参数后就地回存（文件名不变）；与 save 同在激活门禁内
    ipcMain.handle('coverageGrd:overwrite', (_e, file, text) => coverageGrd.overwrite(file, text))
    ipcMain.handle('coverageGrd:raw', (_e, file) => coverageGrd.raw(file))
    // 删除（交互调研 A1）：导入的 GRD 原件先进系统回收站（误删能从回收站捞回再导入；合成 / 解析天线的原件只此一份），
    // 进不去再直接删；旁边的 .grdbin 是取值缓存，直接删。返回 { ok }（形状不变）
    ipcMain.handle('coverageGrd:remove', async (_e, file) => {
      if (!file || typeof coverageGrd.savedPath !== 'function') return coverageGrd.remove(file)
      const fp = coverageGrd.savedPath(file)          // 非法路径照旧抛错，不吞
      try { fs.unlinkSync(fp + '.grdbin') } catch { /* 尚未生成 / 已不在 */ }
      if (fs.existsSync(fp)) await trashOrUnlink(fp)
      return { ok: true }
    })
    // 方向图原样导出：保存框 + 主进程按字节拷贝，原文一个字节都不进渲染进程（实测件 243 MB）。
    // 合成件（表头有 SYNTHMETA）要先重打包到公共网格，转换器在渲染端（ESM），故只回 { synth:true }
    // 让调用方走文本那条；此时尚未弹保存框，不会出现两次框。
    ipcMain.handle('coverageGrd:exportRaw', async (e, file, defaultName) => {
      let src
      try { src = coverageGrd.exportSrc(file) } catch (err) { return { ok: false, error: err.message || String(err) } }
      // 解析天线记录另带 analytic:true：渲染端按参数现铺 GRD 文本（gaussStk.toGrdText），不走公共网格重打包
      if (src.synth) return src.analytic ? { ok: false, synth: true, analytic: true } : { ok: false, synth: true }
      const win = BrowserWindow.fromWebContents(e.sender)
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        defaultPath: safeSaveName(defaultName, 'pattern.grd'),
        filters: dtFilters([{ name: 'GRASP 网格', extensions: ['grd'] }, { name: '所有文件', extensions: ['*'] }], await senderLang(e))
      })
      if (canceled || !filePath) return { ok: false, canceled: true }
      try { fs.copyFileSync(src.path, filePath); return receipt({ ok: true, filePath }) }
      catch (err) { return { ok: false, error: writeErrText(err) } }
    })
    // 用户导入：原生文件框选 .grd/.pat（支持多选，一次导入多个天线）→ 逐个读文本返回渲染进程解析
    ipcMain.handle('coverageGrd:open', async (e) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      const lang = await senderLang(e)
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: dt('导入方向图文件（GRASP GRD / ACP4 / Eutelsat，可多选）', lang), properties: ['openFile', 'multiSelections'],
        filters: dtFilters([{ name: '方向图 (*.grd, *.pat, *.txt, *.ant, *.pattern)', extensions: ['grd', 'pat', 'txt', 'ant', 'pattern'] }, { name: '所有文件', extensions: ['*'] }], lang)
      })
      if (canceled || !filePaths || !filePaths.length) return { canceled: true }
      const path = require('path')
      const files = filePaths.map((fp) => {
        try { return { base: path.basename(fp), text: fs.readFileSync(fp, 'latin1') } }
        catch (err) { return { base: path.basename(fp), error: err.message } }
      })
      return { canceled: false, files }
    })
    // 链路预算侧导入：同一个文件框，但选完直接在主进程按字节拷进 saveDir，只把文件名回给渲染端。
    // （链路预算只需主进程按文件采样，不解析原文；避免把上百 MB 文本搬过一趟 IPC）
    ipcMain.handle('coverageGrd:import', async (e) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      const lang = await senderLang(e)
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: dt('导入 GRD / PAT 方向图（可多选）', lang), properties: ['openFile', 'multiSelections'],
        filters: dtFilters([{ name: 'GRASP 网格 (*.grd, *.pat)', extensions: ['grd', 'pat'] }, { name: '所有文件', extensions: ['*'] }], lang)
      })
      if (canceled || !filePaths || !filePaths.length) return { canceled: true }
      const path = require('path')
      const files = filePaths.map((fp) => {
        const base = path.basename(fp)
        // 这条路是「不经渲染进程按字节拷贝」，拿不到 ACP4/Eutelsat 的转换器（它在 src/viz/grd/patFormats.js，是 ESM）。
        // 故先嗅一下头，非 GRASP 的当场拒掉并指路，不要拷进去等采样器崩在后面。
        try {
          const head = coverageGrd.sniffHead(fp)
          if (head && head !== 'grasp') {
            return { base, error: `此处仅支持 GRASP 网格，当前文件为 ${head}。` }
          }
          return { base, file: coverageGrd.copyIn(fp).file }
        } catch (err) { return { base, error: err.message } }
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
  // 批量：整表各行一次算完再返回（逐行口径与 link:computeMode 完全一致，只省 IPC 往返）。
  // 每行可带自己的 satParams / opt（不同卫星、不同功放功率），故传的是 [{ sat, link, opt }] 列表。
  ipcMain.handle('link:computeModeBatch', (_e, list) => {
    const arr = Array.isArray(list) ? list : []
    return arr.map((it) => {
      try { return core().computeLinkMode((it && it.sat) || {}, (it && it.link) || {}, (it && it.opt) || {}) }
      catch (err) { return { success: false, message: err.message || String(err) } }
    })
  })
  // 链路表实时预览（「地球站配置」格的 EIRP / G·T / 功放尾标，作业见 src/shared/lbPreview.js）：一块行一次算完。
  // 每项自带 engine（'ngso' 走 NGSO 引擎，其余走 GEO），逐条口径与 link:computeMode / link:computeModeNGSO 完全一致。
  // 与 computeModeBatch 的两点不同，都因为预览是后台活：
  //   ① 每跑满 ~4 ms 让出一次事件循环——别的窗口的 IPC（主窗时钟拍、别的预算窗的「计算」）能在行间插进来；
  //   ② 带取消令牌：渲染端点了「计算」就 link:previewCancel(token)，本块在下一个让出点停手，把算完的部分交回
  //      （没算的留 null，渲染端恢复后重发），主进程随即空出来给「计算」。令牌只在本块在算期间有效，
  //      迟到的取消不落进集合里（否则集合只增不减）。
  const previewActive = new Set(), previewCancelled = new Set()
  ipcMain.on('link:previewCancel', (_e, token) => { if (previewActive.has(token)) previewCancelled.add(token) })
  ipcMain.handle('link:previewBatch', async (_e, list, token) => {
    const arr = Array.isArray(list) ? list : []
    const out = new Array(arr.length).fill(null)
    const tok = token == null ? null : String(token)
    if (tok) previewActive.add(tok)
    try {
      let last = performance.now()
      for (let i = 0; i < arr.length; i++) {
        const it = arr[i] || {}
        try {
          const fn = it.engine === 'ngso' ? core().computeLinkModeNGSO : core().computeLinkMode
          out[i] = fn ? fn(it.sat || {}, it.link || {}, it.opt || {}) : { success: false, message: '引擎未加载' }
        } catch (err) { out[i] = { success: false, message: err.message || String(err) } }
        if (i + 1 < arr.length && performance.now() - last >= 4) {
          await new Promise((r) => setImmediate(r))
          last = performance.now()
          if (tok && previewCancelled.has(tok)) break
        }
      }
    } finally {
      if (tok) { previewActive.delete(tok); previewCancelled.delete(tok) }
    }
    return out
  })
  // 参数扫描（可视化「直角坐标系」的算力层）：整段区间在主进程一次跑完，
  // 一次往返带回全部可绘输出量，前端换纵轴变量无需重算（同 rain:sweep 的思路）
  ipcMain.handle('link:sweep', (_e, spec) => {
    try { return core().sweepLink(spec || {}) }
    catch (err) { return { xs: [], series: {}, ok: 0, fail: 0, message: err.message || String(err) } }
  })
  // 二维参数扫描（设计空间图）：x×y 网格逐格重跑，回全部可绘输出量的场 + 连续可行裕度场。
  // 场是 Float64Array，走结构化克隆原样过来（切勿在两端 JSON 化：那会把定型数组变成
  // {"0":…,"1":…} 的键值对象，体积涨十几倍还得在渲染端再转回来）。
  // 地理场还带「覆盖门 + 方向图联动」（spec.geo）：逐格重采卫星天线增益要读 .grdbin，
  // 而核心层不碰 fs → 在这里把 GRD 取值服务注入进去（一次批量采完整张网格，不逐格往返）
  ipcMain.handle('link:sweep2D', (_e, spec) => {
    const hooks = {
      samplePattern: (pat, points) => (grd
        ? grd.sample({ file: pat.file, sat: pat.sat, cfg: pat.cfg, points })
        : points.map(() => null))
    }
    try { return core().sweepLink2D(spec || {}, hooks) }
    catch (err) { return { xs: [], ys: [], nx: 0, ny: 0, series: {}, feas: new Float64Array(0), ok: 0, fail: 0, masked: 0, message: err.message || String(err) } }
  })
  // SLA 可用度档位扫描：逐档把上下行设计可用度换成该档那一对，钉住当前工作点重算
  //（口径同地理场图，见 core/utils/linkSweep.js 的 scanSlaTiers）
  ipcMain.handle('link:slaScan', (_e, spec) => {
    try { return core().scanSlaTiers(spec || {}) }
    catch (err) { return { pin: null, rows: [], clear: null, message: err.message || String(err) } }
  })
  // 批量版（整表各行一次扫完）：逐条 try/catch 隔离，一条抛错不连累其余（照 link:computeModeBatch 的写法）。
  // ★ 行与行之间让出一次事件循环：每行 9 档 = 9 次引擎重算，同步 map 整表跑完前别的窗口的 IPC 全排着队
  //   （主窗时钟播放、别的链路预算窗的「计算」都卡住）；逐行 setImmediate 后别的请求能在行间插进来。
  ipcMain.handle('link:slaScanBatch', async (_e, list) => {
    const arr = Array.isArray(list) ? list : []
    const out = []
    for (const spec of arr) {
      try { out.push(core().scanSlaTiers(spec || {})) }
      catch (err) { out.push({ pin: null, rows: [], clear: null, message: err.message || String(err) }) }
      if (out.length < arr.length) await new Promise((r) => setImmediate(r))
    }
    return out
  })
  // 可绘输出量清单（扫描器的因变量池，按物理意义分组）
  ipcMain.handle('link:outputDefs', () => core().lbOutputDefs.OUTPUT_GROUPS)
  // ★ 星历点序列的「引用 -> 采样表」就在这一层做：渲染端只传 spec:{type:'ephem',ref:{groupId,key}}
  //   （表几 MB，绝不进配置文件与 IPC 参数），进 core 之前换成 samples。core 不碰文件系统，
  //   拿不到表它会点名报错而不是静默退成 SGP4 —— 那种错一眼看不出来。
  //   非 ephem 的请求体原样返回同一个对象（深走只在真有 ephem 时才复制），gp 那条路开销为零。
  const RE_ = (x) => (customSats && customSats.resolveEphemDeep ? customSats.resolveEphemDeep(x) : x)
  // NGSO 计算方式求解（同四种方式，切 NGSO 引擎，强制 ISL 跳数=0）
  ipcMain.handle('link:computeModeNGSO', (_e, s, l, opt) =>
    core().computeLinkModeNGSO
      ? core().computeLinkModeNGSO(RE_(s || {}), l || {}, opt || {})
      : { success: false, message: 'NGSO 引擎未加载' })
  // 再生式上行计算方式求解（设置余量 / 设置功放；合计 C/N = 上行 C/(N+I)；复用 NGSO 几何）
  ipcMain.handle('link:computeRegenUplink', (_e, s, l, opt) =>
    core().computeRegenUplinkMode
      ? core().computeRegenUplinkMode(RE_(s || {}), l || {}, opt || {})
      : { success: false, message: '再生式引擎未加载' })
  // 再生式下行计算方式求解（给定工作点 G/T / 目标余量；合计 C/N = 下行 C/(N+I)；复用 NGSO 几何）
  ipcMain.handle('link:computeRegenDownlink', (_e, s, l, opt) =>
    core().computeRegenDownlinkMode
      ? core().computeRegenDownlinkMode(RE_(s || {}), l || {}, opt || {})
      : { success: false, message: '再生式引擎未加载' })
  // 再生式星间计算（发射卫星 EIRP / 接收卫星 G/T；合计 C/N = 星间单跳 C/N）
  ipcMain.handle('link:computeRegenIsl', (_e, s, l, opt) =>
    core().computeRegenIslMode
      ? core().computeRegenIslMode(RE_(s || {}), l || {}, opt || {})
      : { success: false, message: '再生式引擎未加载' })
  // 再生式星间激光计算（MathWorks 简化功率链 P_rx=P_tx+OE+G−LP−L_PS；余量=P_rx−P_req）
  ipcMain.handle('link:computeRegenLaser', (_e, p, opt) =>
    core().computeRegenLaserIslMode
      ? core().computeRegenLaserIslMode(p || {}, opt || {})
      : { success: false, message: '再生式引擎未加载' })
  // 端到端链路（多跳 / 混合转发）：一条链一次算完（分段 + 级联 + 汇总）。批量＝渲染端逐行调用。
  ipcMain.handle('link:chainCompute', (_e, chain) =>
    core().computeLinkChain
      ? core().computeLinkChain(RE_(chain || {}))
      : { success: false, message: '端到端链路引擎未加载' });
  // 星间链路(ISL)两星几何求解（双 SGP4 + 地球临边遮挡 → 最差星间距离 + 互视可见度 + 访问窗口）
  ipcMain.handle('link:islGeometry', (_e, opt) =>
    core().solveIslWorstCase
      ? core().solveIslWorstCase(RE_(opt || {}))
      : { feasible: false, reason: '星间几何求解器未加载' })
  // 星间距离时间序列（双 SGP4 逐拍出星间距离/掠地高度/互视）：供「星间链路距离」工具的时间轴
  ipcMain.handle('link:islRangeSeries', (_e, opt) =>
    core().sampleIslRangeSeries
      ? core().sampleIslRangeSeries(RE_(opt || {}))
      : { ok: false, reason: '星间几何求解器未加载' })
  // GSO「指向误差」工具：一个地球站对一颗 GSO 星一天的指向偏离与损耗（utils/geoTrack.js 的 gsoPointingBudget）
  ipcMain.handle('link:pointingBudget', (_e, opt) => (core().gsoPointingBudget ? core().gsoPointingBudget(opt || {}) : null))
  // NGSO 站星几何求解（选星=SGP4/SDP4 单一典型时刻 t* 几何；手动=闭式球面最差 + 轨道根数）
  ipcMain.handle('link:ngsoGeometry', (_e, opt) =>
    core().solveNgsoMutualWorstCase
      ? core().solveNgsoMutualWorstCase(RE_(opt || {}))
      : { feasible: false, reason: 'NGSO 几何求解器未加载' })
  // 批量几何：一次带回整表各链路的几何。同一颗星、同一 t0/时窗下，SGP4 粗扫的传播部分与站址无关，
  // 主进程内各站对共享一份采样（结果与逐条调用逐位一致），顺带把 N 次 IPC 往返压成 1 次。
  ipcMain.handle('link:ngsoGeometryBatch', (_e, opt) =>
    core().solveNgsoMutualWorstCaseBatch
      ? core().solveNgsoMutualWorstCaseBatch(RE_(opt || {}))
      : (((opt && opt.pairs) || []).map(() => ({ feasible: false, reason: 'NGSO 几何求解器未加载' }))))
  // 批量计算方式求解：一组 linkParams 在主进程内连算完再一次返回（候选几何逐个跑引擎时用），
  // 逐条口径与 link:computeModeNGSO 完全相同，只省 IPC 往返
  ipcMain.handle('link:computeModeNGSOBatch', (_e, s, list, opt) => {
    const fn = core().computeLinkModeNGSO
    const arr = Array.isArray(list) ? list : []
    if (!fn) return arr.map(() => ({ success: false, message: 'NGSO 引擎未加载' }))
    const sr = RE_(s || {})
    return arr.map((l) => {
      try { return fn(sr, l || {}, opt || {}) }
      catch (err) { return { success: false, message: err.message || String(err) } }
    })
  })
  // 单站访问窗口（再生式几何：时窗内满足最低仰角及以上的全部过境）
  ipcMain.handle('link:accessWindows', (_e, opt) =>
    core().solveAccessWindows
      ? core().solveAccessWindows(RE_(opt || {}))
      : { feasible: false, reason: '访问窗口求解器未加载', windows: [] })
  // 经纬度 → 降雨率/海拔自动填值（与小程序口径一致）
  ipcMain.handle('link:geoFill', (_e, lat, lon) => core().geoAutoFill(parseFloat(lat), parseFloat(lon)))
  // 默认站址（站址经纬度留空时引擎所用的那一组）的降雨率 / 海拔：留空站址行据此补 R0.01% / 海拔并作灰字占位
  ipcMain.handle('link:defaultSiteGeo', () => (core().defaultSiteGeo ? core().defaultSiteGeo() : null))
  // GRD 天线逐站取值（多波束最大 Parameter）：解析+采样在主进程，渲染端只收发 dB 数字
  ipcMain.handle('link:grdSample', (_e, req) => (grd ? grd.sample(req || {}) : ((req && req.points) || []).map(() => null)))
  // GRD 天线概要（波束数/网格）：链路预算导入方向图后填「N 波束」，顺带预编译 .grdbin
  ipcMain.handle('link:grdMeta', (_e, file) => (grd ? grd.meta(file) : { ok: false, error: 'GRD 服务未加载' }))
  // 干扰分析：逐波束采样（少量站点）与 C/CCI 合成（整张场图，主进程内折成标量再回传）
  ipcMain.handle('link:grdSampleBeams', (_e, req) => (grd ? grd.sampleBeams(req || {}) : { beamIdx: [], values: ((req && req.points) || []).map(() => []) }))
  ipcMain.handle('link:grdSampleXpd', (_e, req) => (grd ? grd.sampleXpd(req || {}) : { ok: false, error: 'GRD 服务未加载', values: ((req && req.points) || []).map(() => null) }))
  ipcMain.handle('link:grdSampleCci', (_e, req) => (grd ? grd.sampleCci(req || {}) : { ok: false, error: 'GRD 服务未加载', cci: ((req && req.points) || []).map(() => null) }))
  // 城市列表（选址用）
  ipcMain.handle('link:cities', () => core().listCities())
  ipcMain.handle('link:cityGroups', () => core().listCitiesGrouped())
  ipcMain.handle('link:searchCities', (_e, kw) => core().searchCities(String(kw == null ? '' : kw), {}))
  // 载波信号选项（调制/FEC/DVB/MODCOD）。MODCOD 表 = 内置表叠上用户在「文件管理 · 调制编码」里的改写
  ipcMain.handle('link:baseband', () => core().basebandOptions(modcod.store()))

  // ---- MODCOD 表（文件管理 · 调制编码）----
  // 编辑页拿到的是合并后的整份清单；存回来的也是整份，主进程只留它与内置表的差异（见 services/modcod.js）
  ipcMain.handle('modcod:list', () => modcod.list())
  ipcMain.handle('modcod:save', (_e, standards) => modcod.save(standards || []))
  ipcMain.handle('modcod:reset', (_e, key) => modcod.reset(String(key == null ? '' : key)))

  // 打开「GEO 链路预算」独立工作台窗口（单例，由 main 注入创建函数）
  ipcMain.handle('linkbudget:open', gate(() => { if (openLinkBudget) openLinkBudget(); return true }))
  // 关窗守卫：渲染进程问过用户「配置存了没」（取消/不保存/保存）并按需存盘后，调这个才真正关闭窗口
  ipcMain.handle('linkbudget:confirmClose', () => { if (confirmCloseLinkBudget) confirmCloseLinkBudget(); return true })

  // 打开「NGSO 链路预算」独立工作台窗口（单例，由 main 注入创建函数）
  ipcMain.handle('ngso:open', gate(() => { if (openNgso) openNgso(); return true }))
  ipcMain.handle('ngso:confirmClose', () => { if (confirmCloseNgso) confirmCloseNgso(); return true })

  // 打开「再生式链路预算」独立工作台窗口（单例，由 main 注入创建函数）
  ipcMain.handle('regen:open', gate(() => { if (openRegen) openRegen(); return true }))
  ipcMain.handle('regen:confirmClose', () => { if (confirmCloseRegen) confirmCloseRegen(); return true })

  // 打开「端到端链路预算」独立工作台窗口（单例，由 main 注入创建函数）
  ipcMain.handle('e2e:open', gate(() => { if (openE2e) openE2e(); return true }))
  ipcMain.handle('e2e:confirmClose', () => { if (confirmCloseE2e) confirmCloseE2e(); return true })

  // ---- 带上下文打开计算窗（主窗口右键 / 卫星信息栏「分析」：选中的星与站带进去）----
  // 已开 = 聚焦后立即送；新开 = 等页面加载完再送（同 freqPlan:open）。载荷只收身份与站址，
  // 在这里现造成纯数据并限长；接收端（各窗 onContext）只追加算例 / 链路行或新建一份配置，不改动现有配置。
  const TOOL_OPENERS = { linkbudget: openLinkBudget, ngso: openNgso, regen: openRegen, e2e: openE2e, suntool: openSunOutage, rain: openRain, ci: openCi }
  ipcMain.handle('tool:open', gate((_e, kind, ctx) => {
    const open = TOOL_OPENERS[kind]
    if (!open) return false
    const win = open()
    const c = sanitizeToolContext(ctx)
    if (win && c) {
      const send = () => { try { win.webContents.send('tool:context', c) } catch { /* 窗口已关 */ } }
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
      else send()
    }
    return true
  }))

  // ---- 雨衰计算（独立窗口 · 通用于各类卫星 · 批量/单算例/曲线计算 + Excel 导出）----
  ipcMain.handle('rain:open', gate(() => { if (openRain) openRain(); return true }))
  // 干扰分析（C/I）独立窗口：只读消费者——读三库与 GRD，不写回任何库
  ipcMain.handle('ci:open', gate(() => { if (openCi) openCi(); return true }))
  ipcMain.handle('pfd:open', gate(() => { if (openPfd) openPfd() }))
  // 空间态势报告（独立窗口）：CelesTrak 卫星编目 SATCAT + 平台既有 GP 星历 → 电子报告 / Word
  ipcMain.handle('ssa:open', gate(() => { if (openSsa) openSsa(); return true }))
  ipcMain.handle('ssa:confirmClose', () => { if (confirmCloseSsa) confirmCloseSsa(); return true })
  // ---- 性能指标表窗口（对地 / 对星 / 气象）：主进程只中继，数据与取值都在主窗口 ----
  if (perfWin) {
    ipcMain.handle('perfwin:open', gate((_e, o) => perfWin.open(o || {})))
    ipcMain.handle('perfwin:push', (_e, id, msg) => perfWin.push(id, msg))
    ipcMain.handle('perfwin:act', (e, msg) => perfWin.act(e.sender, msg))
    ipcMain.handle('perfwin:close', (_e, id) => perfWin.close(id))
    ipcMain.handle('perfwin:setTitle', (_e, id, title) => perfWin.setTitle(id, title))
    ipcMain.handle('perfwin:list', () => perfWin.list())
    ipcMain.handle('perfwin:self', (e) => perfWin.self(e.sender))
  }

  // ---- 转发器频率计划 ----
  ipcMain.handle('freqPlan:open', gate((_e, planId) => {
    if (!openFreqPlan) return false
    const win = openFreqPlan()
    // 带 planId 打开 = 从文件区双击某份计划进来，等页面就绪后再送（新开窗口时 DOM 还没挂载）
    if (win && planId) {
      const send = () => { try { win.webContents.send('freqPlan:openPlan', planId) } catch { /* 窗口已关 */ } }
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
      else send()
    }
    return true
  }))
  if (freqPlan) {
    // 变更广播（交互调研 C4）：存 / 删 / 改名 / 导入 / 随卫星改挂成功后，告诉【发起者以外】的所有窗口哪几份计划变了
    // —— 链路预算按它重新套用频率 / 极化 / 带宽（否则一直沿用打开时读到的那一份）。定向给编辑窗的 planRemoved / planRenamed 照旧。
    const fpChanged = (e, ids, kind) => {
      const list = [...new Set((ids || []).map((x) => String(x == null ? '' : x)).filter(Boolean))]
      if (!list.length) return
      const from = e && e.sender
      for (const w of BrowserWindow.getAllWindows()) {
        try { if (!w.isDestroyed() && w.webContents !== from) w.webContents.send('freqPlan:changed', { ids: list, kind }) } catch { /* 窗口正在关 */ }
      }
    }
    const fpIds = () => { try { return (freqPlan.list() || []).map((x) => x && x.id).filter(Boolean) } catch { return [] } }
    ipcMain.handle('freqPlan:list', () => freqPlan.list())
    ipcMain.handle('freqPlan:get', (_e, id) => freqPlan.get(id))
    ipcMain.handle('freqPlan:save', (e, plan, opts) => {
      const r = freqPlan.save(plan, opts)
      if (r && r.ok) fpChanged(e, [r.id], 'save')
      return r
    })
    // 删/改名后告诉编辑窗（它可能正开着这一份）：不通知它就会被它的自动存盘整份写回来。
    // 删除时计划文件先进系统回收站（services/freqPlan.js remove；交互调研 A1）
    ipcMain.handle('freqPlan:remove', async (e, id) => {
      const r = await freqPlan.remove(id)
      if (r && r.ok) { try { storage.dropVersions('freqplan', [String(id || '')]) } catch { /* 历史版本删不掉不拦删计划 */ } }   // 计划删了，它的历史一并删
      if (r && r.ok && notifyFreqPlan) notifyFreqPlan('freqPlan:planRemoved', String(id || ''))
      if (r && r.ok) fpChanged(e, [id], 'remove')
      return r
    })
    ipcMain.handle('freqPlan:rename', (e, id, name) => {
      const r = freqPlan.rename(id, name)
      if (r && r.ok && notifyFreqPlan) notifyFreqPlan('freqPlan:planRenamed', String(id || ''), r.entry ? r.entry.name : String(name || ''))
      if (r && r.ok) fpChanged(e, [r.id || id], 'rename')
      return r
    })
    ipcMain.handle('freqPlan:reassignSat', (e, folder, patch) => {
      let ids = []
      try { ids = (freqPlan.list() || []).filter((x) => x && x.satFolder === folder).map((x) => x.id) } catch { ids = [] }
      const r = freqPlan.reassignSat(folder, patch)
      if (r && r.ok && r.count) fpChanged(e, ids, 'reassign')
      return r
    })

    // 导出：PNG / PDF / SVG / JSON / XLSX，统一走原生保存框
    ipcMain.handle('freqPlan:export', async (e, kind, payload, defaultName) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      const ext = kind === 'pdf' ? 'pdf' : kind === 'json' ? 'json' : kind === 'svg' ? 'svg'
        : kind === 'xlsx' ? 'xlsx' : 'png'
      const nameMap = { pdf: 'PDF 文档', json: 'JSON 数据', svg: 'SVG 矢量图', png: 'PNG 图片', xlsx: 'Excel 工作簿' }
      const lang = await senderLang(e, kind === 'xlsx' && payload && typeof payload === 'object' ? payload.lang : undefined)
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        title: dt('导出频率计划', lang),
        defaultPath: safeSaveName(defaultName, dt('频率计划', lang)) + '.' + ext,
        filters: [{ name: dt(nameMap[ext], lang), extensions: [ext] }]
      })
      if (canceled || !filePath) return { canceled: true }
      try {
        if (kind === 'xlsx') {
          // payload 是渲染端算好的纯数据模型（版式与口径都在 src/shared/fpXlsxModel.js），
          // 这里只把它刷成工作簿 —— 见 electron/services/freqPlanXlsx.js 文件头
          const { buildFreqPlanWorkbook } = require('../services/freqPlanXlsx')
          fs.writeFileSync(filePath, Buffer.from(await buildFreqPlanWorkbook(payload)))
        } else if (kind === 'json' || kind === 'svg') fs.writeFileSync(filePath, String(payload || ''), 'utf8')
        else {
          // PNG / PDF 都由渲染端生成后以 dataURL 送来（PDF 走 jspdf + svg2pdf，与报表同一条管线）。
          // ★ MIME 与 base64 之间允许夹参数：jsPDF 的 datauristring 就带着 ;filename=xxx.pdf 那一节，
          //   原先那条 [^;]+ 的正则一口咬死「类型后面必须紧跟 base64」，把每一份 PDF 都判成格式不正确。
          const m = /^data:[^,]*;base64,(.+)$/.exec(String(payload || ''))
          if (!m) throw new Error('导出数据格式不正确')
          fs.writeFileSync(filePath, Buffer.from(m[1], 'base64'))
        }
        return receipt({ ok: true, filePath })
      } catch (err) { return { ok: false, error: err.message } }
    })

    // 导入 JSON（整份计划交换）
    ipcMain.handle('freqPlan:importJson', async (e) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: dt('导入频率计划（JSON）', await senderLang(e)), properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'JSON (*.json)', extensions: ['json'] }]
      })
      if (canceled || !filePaths || !filePaths.length) return { canceled: true }
      const plans = []
      const errors = []
      for (const fp of filePaths) {
        try {
          const j = JSON.parse(fs.readFileSync(fp, 'utf8'))
          if (Array.isArray(j)) plans.push(...j)
          else if (j && typeof j === 'object') plans.push(j)
        } catch (err) { errors.push(`${path.basename(fp)}：${err.message}`) }
      }
      const before = new Set(fpIds())
      const r = freqPlan.importMany(plans, { mode: 'merge' })
      if (r && r.ok) fpChanged(e, fpIds().filter((id) => !before.has(id)), 'import')
      return { canceled: false, ...r, errors }
    })
  }

  // ---- 卫星模型工作台（独立窗口）与模型服务 models:*（契约写在 services/models.js 文件头）----
  // 带目标打开（3D 页信息卡「编辑…」/ 侧栏卡片）：已开则 focus 后立即送；新开则等页面就绪再送（同 freqPlan:open）
  ipcMain.handle('modelwb:open', gate((_e, o) => {
    if (!openModel) return false
    const win = openModel()
    const target = sanitizeModelTarget(o)
    if (win && target) {
      const send = () => { try { win.webContents.send('modelwb:target', target) } catch { /* 窗口已关 */ } }
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
      else send()
    }
    return true
  }))
  // 模型工作台关窗守卫：渲染端落定（草稿 / 待存改动）后回执，主进程真关（UNGATED：锁定期间也得关得掉）
  ipcMain.handle('modelwb:confirmClose', () => { if (confirmCloseModel) confirmCloseModel(); return true })
  if (models) {
    // 出参一律过一遍纯数据（服务内部已是纯对象；Buffer 由结构化克隆转成 Uint8Array）
    const winOf = (e) => BrowserWindow.fromWebContents(e.sender)
    const safe = (fn) => async (...a) => {
      try { return await fn(...a) } catch (err) { return { ok: false, error: err.message || String(err) } }
    }
    ipcMain.handle('models:manifest', safe(() => models.manifest()))
    ipcMain.handle('models:ensure', safe((_e, o) => models.ensure(o)))
    ipcMain.handle('models:thumbnail', safe((_e, id) => models.thumbnail(id)))
    // 取消走 send / on：进度条上的「×」是即时动作，不等回执；on 不经 gate（本就是只读浏览面的一部分）
    ipcMain.on('models:cancel', (_e, id) => { try { models.cancel(id) } catch { /* 无 */ } })
    ipcMain.handle('models:remove', safe((_e, id) => models.remove(id)))
    ipcMain.handle('models:cacheInfo', safe(() => models.cacheInfo()))
    ipcMain.handle('models:setCacheCap', safe((_e, b) => models.setCacheCap(b)))
    ipcMain.handle('models:openCacheDir', safe(() => models.openCacheDir()))
    ipcMain.handle('models:refreshManifest', safe(() => models.refreshManifest()))
    // 渲染端读 / 转本机模型文件只限「用户亲手选过（pickFiles）或拖进来（preload 用 webUtils 从真实 File 取路径后
    // models:allowPaths 登记）」那几处目录及其子目录 —— 伴随的 .mtl / 贴图 / .bin 都在里面。渲染端随手给的任意路径不放行
    //（加固：页面万一被注入脚本，也不能借 readFile / importCad 读任意位置的图片、模型文件）
    const modelRoots = new Set()
    const normFsPath = (p) => { const r = path.resolve(String(p)); return process.platform === 'win32' ? r.toLowerCase() : r }
    const allowModelDirOf = (p) => { if (typeof p === 'string' && p && path.isAbsolute(p)) modelRoots.add(normFsPath(path.dirname(p))) }
    const under = (q, r) => q.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
    // OBJ 的 .mtl 常按「../textures/x.png」引用上一级目录的贴图（导出器把模型与贴图分目录放）：材质库与贴图类扩展名再放宽到
    // 授权根的上一层（及其子目录）；模型文件与其余类型仍只限授权根本身。盘符根（上一层还是自己）不再放宽
    const SIDECAR_EXT = new Set(['.mtl', '.png', '.jpg', '.jpeg', '.webp', '.tga', '.bmp', '.gif', '.tif', '.tiff', '.dds', '.ktx2'])
    const modelPathAllowed = (p) => {
      if (typeof p !== 'string' || !p || !path.isAbsolute(p)) return false
      const q = normFsPath(p)
      for (const r of modelRoots) if (under(q, r)) return true
      if (!SIDECAR_EXT.has(path.extname(q).toLowerCase())) return false
      for (const r of modelRoots) { const up = path.dirname(r); if (up !== r && under(q, up)) return true }
      return false
    }
    const NOT_ALLOWED = { ok: false, error: '路径未授权' }
    ipcMain.handle('models:pickFiles', safe(async (e) => {
      const r = await models.pickFiles(winOf(e))
      for (const f of Array.isArray(r) ? r : []) allowModelDirOf(f && f.path)
      return r
    }))
    ipcMain.handle('models:allowPaths', safe((_e, ps) => { for (const p of Array.isArray(ps) ? ps.slice(0, 1000) : []) allowModelDirOf(p); return true }))
    ipcMain.handle('models:readFile', safe((_e, p) => (modelPathAllowed(p) ? models.readFile(p) : NOT_ALLOWED)))
    ipcMain.handle('models:importGlb', safe((_e, o) => (o && !o.bytes && o.path != null && !modelPathAllowed(o.path) ? NOT_ALLOWED : models.importGlb(o))))
    ipcMain.handle('models:importCad', safe((_e, o) => (o && modelPathAllowed(o.path) ? models.importCad(o) : NOT_ALLOWED)))
    ipcMain.handle('models:saveImported', safe((_e, o) => models.saveImported(o)))
    ipcMain.handle('models:stkLocate', safe(() => models.stkLocate()))
    ipcMain.handle('models:scanStk', safe((_e, o) => models.scanStk(o)))
    ipcMain.handle('models:pickStkDir', safe((e) => models.pickStkDir(winOf(e))))
    ipcMain.handle('models:importStk', safe((_e, o) => models.importStk(o)))
    ipcMain.handle('models:saveMeta', safe((_e, o) => models.saveMeta(o)))
    ipcMain.handle('models:getMeta', safe((_e, id) => models.getMeta(id)))
    // 导出 glb：服务回 { ok, path }（已有 path 字段）；登记回执白名单
    ipcMain.handle('models:export', safe(async (e, o) => { const r = await models.exportModel(o, winOf(e)); return receipt(r, r && r.path) }))
    ipcMain.handle('models:saveThumb', safe((_e, o) => models.saveThumb(o)))
    ipcMain.handle('models:bindings:get', safe(() => models.bindingsGet()))
    ipcMain.handle('models:bindings:set', safe((_e, o) => models.bindingsSet(o)))
    // 二期：本体遮挡掩模存取（D18，userData/models/masks/<sig>.bin）与分析页表格导出（xlsx 三线表 / csv）。三条都在锁内
    ipcMain.handle('models:saveMask', safe((_e, o) => models.saveMask(o)))
    ipcMain.handle('models:getMask', safe((_e, sig) => models.getMask(sig)))
    ipcMain.handle('models:exportTable', safe(async (e, o) => receipt(await models.exportTable(o, winOf(e)))))
  }
  ipcMain.handle('ci:asi', (_e, req) => interference.asi(req))
  ipcMain.handle('ci:xpi', (_e, req) => interference.xpi(req))
  ipcMain.handle('ci:xpiTerm', (_e, req) => interference.xpiTerm(req))
  ipcMain.handle('ci:cciPoint', (_e, req) => interference.cciPoint(req))
  // C/CCI 复用方案：方向图概要（存活波束 + 波束合成色号）· 取值点表 · 场图作业（进度 ci:cciProgress、结果 ci:cciDone）
  ipcMain.handle('ci:cciInfo', (_e, req) => interference.cciInfo(req))
  ipcMain.handle('ci:cciPoints', (_e, req) => interference.cciPoints(req))
  // C/CCI 目标波束：逐波束足迹（波束图点选用）；目标波束作业走 ci:cciStart（mode:'target'），进度 / 结果同上
  ipcMain.handle('ci:cciBeams', (_e, req) => interference.cciBeams(req))
  ipcMain.handle('ci:cciStart', (e, req) => interference.cciStart(e.sender, req))
  ipcMain.handle('ci:cciCancel', () => interference.cciCancel())
  ipcMain.handle('ci:ngsoEstimate', (_e, req) => interference.ngsoEstimate(req))
  // NGSO 扫描是长任务：这里只启动，进度经 ci:ngsoProgress、结果经 ci:ngsoDone 推回发起窗口
  ipcMain.handle('ci:ngsoStart', (e, req) => interference.ngsoStart(e.sender, req))
  ipcMain.handle('ci:ngsoCancel', () => interference.ngsoCancel())
  // 星历接入：邻星搜索（GEO 按星下点经度排）+ 星座组列表/载入（NGSO 选真实星座）
  ipcMain.handle('ci:groups', () => interference.groups())
  ipcMain.handle('ci:loadGroup', (_e, g, online, satIds, sats) => interference.loadGroup(g, online, satIds, sats))
  ipcMain.handle('ci:geoNeighbors', (_e, req) => interference.geoNeighbors(req))
  ipcMain.handle('rain:confirmClose', () => { if (confirmCloseRain) confirmCloseRain(); return true })
  // 单算例（详情面板/兜底）
  ipcMain.handle('rain:compute', (_e, p) => {
    try { return core().calculateRainAttenuation(p || {}) }
    catch (err) { return { error: true, message: err.message || String(err) } }
  })
  // 批量（一次 IPC 算完整表，避免逐行往返）
  ipcMain.handle('rain:computeBatch', (_e, cases) => {
    try { return (Array.isArray(cases) ? cases : []).map((c) => core().calculateRainAttenuation(c || {})) }
    catch (err) { return { error: true, message: err.message || String(err) } }
  })
  // 多站总可用度：逐站可用度（表内直接给 / 由可承受衰减反解）→ 纯概率论聚合（Poisson–binomial 尾概率）+ 切换可加项
  ipcMain.handle('rain:solveMultiSite', (_e, cases, opt) => {
    try { return core().solveMultiSite(Array.isArray(cases) ? cases : [], opt || {}) }
    catch (err) { return { error: true, message: err.message || String(err) } }
  })
  // 曲线扫描（雨衰 vs 可用度/频率/降雨率），供交互式坐标系绘制
  ipcMain.handle('rain:sweep', (_e, p, axis, range) => {
    try { return core().sweepRainAttenuation(p || {}, axis, range || {}) }
    catch (err) { return { axis, points: [], error: true, message: err.message || String(err) } }
  })
  // 批量结果 Excel 导出（批量结果 sheet + 每算例详情 sheet）
  ipcMain.handle('rain:exportExcel', async (e, payload) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const lang = await senderLang(e, payload && payload.lang)
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: safeSaveName(payload && payload.defaultName, dtFile('雨衰计算结果.xlsx', lang)),
      filters: [{ name: dt('Excel 工作簿', lang), extensions: ['xlsx'] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    try {
      const buf = await report.buildRainAttenuationExcel(Object.assign({}, payload || {}, { lang }))
      fs.writeFileSync(filePath, Buffer.from(buf))
      return receipt({ ok: true, filePath })
    } catch (err) {
      const busy = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')
      return { ok: false, error: busy ? '文件可能正被其他程序打开（如 Excel）' : (err.message || String(err)) }
    }
  })

  // ---- 可见性分析 · 时段过境导出 Excel（三线表模板版式：摘要 / 过境明细 / 逐星汇总）----
  // 模型在渲染端 ConstellationMap3D.vue exportAccessExcel 组装（相对分钟 + 时窗起点），版式见 report.buildVisAccessExcel
  ipcMain.handle('vis:exportAccessExcel', async (e, payload) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const lang = await senderLang(e, payload && payload.lang)
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: safeSaveName(payload && payload.defaultName, dt('过境窗口', lang)) + '.xlsx',
      filters: [{ name: dt('Excel 工作簿', lang), extensions: ['xlsx'] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    try {
      const buf = await report.buildVisAccessExcel(Object.assign({}, payload || {}, { lang }))
      fs.writeFileSync(filePath, Buffer.from(buf))
      return receipt({ ok: true, filePath })
    } catch (err) {
      const busy = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')
      return { ok: false, error: busy ? '文件可能正被其他程序打开（如 Excel）' : (err.message || String(err)) }
    }
  })

  // ---- 通用表格 ⇄ Excel（性能指标表 / 对星性能表 / 标记批量表格 …）----
  // 主进程只做「模型 → 工作簿」与「工作簿 → 格子值」，列匹配与业务口径在渲染端 src/shared/gridXlsx.js。
  ipcMain.handle('grid:exportXlsx', async (e, payload) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const lang = await senderLang(e, payload && payload.lang)
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: dt((payload && payload.title) || '导出 Excel', lang),
      defaultPath: safeSaveName(payload && payload.defaultName, dtFile('表格.xlsx', lang)),
      filters: [{ name: dt('Excel 工作簿', lang), extensions: ['xlsx'] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    try {
      const { buildGridWorkbook } = require('../services/gridXlsx')
      fs.writeFileSync(filePath, Buffer.from(await buildGridWorkbook(payload || {})))
      return receipt({ ok: true, filePath })
    } catch (err) {
      const busy = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')
      return { ok: false, error: busy ? '文件可能正被其他程序打开（如 Excel）' : (err.message || String(err)) }
    }
  })
  ipcMain.handle('grid:importXlsx', async (e, opt) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const lang = await senderLang(e, opt && opt.lang)
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: dt((opt && opt.title) || '导入 Excel', lang),
      properties: ['openFile'],
      filters: [{ name: dt('Excel 工作簿', lang), extensions: ['xlsx', 'xlsm'] }]
    })
    if (canceled || !filePaths || !filePaths.length) return { ok: false, canceled: true }
    try {
      const { readGridWorkbook } = require('../services/gridXlsx')
      const r = await readGridWorkbook(filePaths[0])
      return { ok: true, filePath: filePaths[0], sheets: r.sheets }
    } catch (err) {
      return { ok: false, error: err.message || String(err) }
    }
  })

  // ---- 环境场图层（主窗口「环境场」视图）----
  // 全精度 ITU 数据只在主进程（启动时注入内核），故整张等经纬栅格在这里生成后一次性回传；
  // 逐点走 IPC 做整张图要百万次往返，不可行。Float32Array 走结构化克隆，无需序列化成数组。
  ipcMain.handle('env:defs', () => {
    try { return core().envFieldDefs() }
    catch (err) { return { error: true, message: err.message || String(err) } }
  })
  ipcMain.handle('env:field', (_e, key, opt) => {
    try { return core().sampleEnvField(key, opt || {}) }
    catch (err) { return { error: true, message: err.message || String(err) } }
  })

  // ---- 实时/预报环境场（主窗口「实时气象」视图）----
  // 与上面的 ITU 环境场同构：整张栅格在主进程生成后一次性回传（Float32Array 走结构化克隆）。
  // 三处不同：数据来自实时气象源而非随包分发的地图、多一个时间维、衰减场依赖卫星几何。
  //
  // ★ 两个 provider 各司其职，不是二选一：
  //     gfs      栅格源。**场**只走这条 —— 一次 HTTP 拿一整块 0.25° 网格，请求数 = 帧数。
  //     weather  和风，按点。只做**站点实况** —— 0.25° 格值是 28 km 一片的平均，
  //              地球站站址要的是那一个点此刻的实测，两者并列显示，差多少本身就是信息。
  // ★ 全部不进 UNGATED：既产出交付物又要联网取数，未激活一律拦下。
  const gOk = () => { if (!gfs) throw new Error('气象栅格服务未装配'); return gfs }
  const wOk = () => { if (!weather) throw new Error('站点实况服务未装配'); return weather }
  ipcMain.handle('weather:providers', () => {
    const out = { field: { id: 'gfs', label: 'NCEP GFS 0.25°', ok: false, message: '' },
      point: { id: 'qweather', label: '和风天气', ok: false, message: '' } }
    try { const c = gOk().configured(); out.field.ok = !!c.ok; out.field.message = c.message || c.note || '' }
    catch (e) { out.field.message = e.message }
    try { const c = wOk().configured(); out.point.ok = !!c.ok; out.point.message = c.message || '' }
    catch (e) { out.point.message = e.message }
    return out
  })
  ipcMain.handle('weather:test', async (_e, which) => {
    try { return which === 'point' ? await wOk().test() : await gOk().test() }
    catch (e) { return { ok: false, message: e.message } }
  })
  ipcMain.handle('weather:defs', () => { try { return core().liveFieldDefs() } catch (e) { return { error: true, message: e.message } } })
  ipcMain.handle('weather:estimate', (_e, o) => { try { return gOk().estimate(o || {}) } catch (e) { return { error: e.message } } })
  ipcMain.handle('weather:meta', () => { try { return gOk().meta() } catch (e) { return null } })
  ipcMain.handle('weather:usage', () => { try { return gOk().usage() } catch (e) { return null } })
  ipcMain.handle('weather:clearCache', () => { try { return gOk().clearCache() } catch (e) { return { ok: false, message: e.message } } })
  // 取数：一帧一次 HTTP，几秒~几十秒。进度按帧回推，界面才有得显示（否则只能干等）。
  ipcMain.handle('weather:load', async (e, o) => {
    try {
      const send = (done, total) => { try { e.sender.send('weather:progress', { done, total }) } catch { /* 窗口已关 */ } }
      return await gOk().loadCube(o || {}, send)
    } catch (err) { return { error: err.message || String(err) } }
  })
  // 逐帧取栅格：拖时间轴时每帧一次，故不能把整个立方体过 IPC —— 立方体留在主进程。
  ipcMain.handle('weather:field', (_e, o) => {
    try {
      const cube = gOk().getCube()
      if (!cube) return { error: '尚未取气象数据' }
      return core().sampleLiveField(cube, o || {})
    } catch (err) { return { error: err.message || String(err) } }
  })
  // 多站读数：一次给一批站点，值取**时间轴当前时刻**的那一帧。
  // ★ 不经过出图栅格：那张栅格为了跑得动是降过采样的（衰减场压到 4 万点，中国区约 0.26°），
  //   在它上面采样等于二次插值。这里直接在立方体原生格上取值再逐点跑引擎 —— 站址的读数就是站址的。
  // ★ 一批点一次 IPC：时间轴一动全表刷新，逐点发 IPC 会把主进程打满。实测 6 站 < 1 ms。
  ipcMain.handle('weather:points', (_e, o) => {
    try {
      const cube = gOk().getCube()
      if (!cube) return { error: '尚未取气象数据' }
      return core().sampleLivePoints(cube, o || {})
    } catch (err) { return { error: err.message || String(err) } }
  })
  // 一批站点的**和风按点值**（观测或逐小时预报）+ 逐站瞬时衰减。气象指标表的「和风」列组走这条。
  // ★ 与上面的 weather:points 是两个**数据源**，别混：那条是 NCEP GFS 0.25° 格点场在站址的插值，
  //   这条是和风按点产品（本小时＝实况观测，未来＝逐小时预报，没有历史）。
  // ★ allowFetch：只有用户点按钮那一次为 true（一站一次 HTTP，按站计费）。时间轴联动一律 false ——
  //   逐小时接口一次回一整条时间轴，取过之后再拖时间轴只是查数组，不该也不会再发请求。
  ipcMain.handle('weather:obs', async (_e, o) => {
    try {
      const p = o || {}
      const pts = Array.isArray(p.pts) ? p.pts : []
      if (!pts.length) return { rows: [] }
      const r = await wOk().points(pts, { tMs: p.tMs, allowFetch: p.allowFetch !== false, horizonMs: p.horizonMs })
      const C = core()
      const satLon = Number(p.satLon)
      // 目标星两种给法：satPos（任意轨道的星下点 + 高度，走 WGS-84 通用几何）优先于 satLon（GEO 闭式）
      const satPos = C.instantAtten.normSatPos(p.satPos)
      for (const row of r.rows) {
        if (!row.ok || (!satPos && !Number.isFinite(satLon))) continue
        const alt = C.elevation && C.elevation.queryElevation ? C.elevation.queryElevation(row.lat, row.lon) : null
        const a = C.computeInstantAtten({
          lat: row.lat, lon: row.lon, altKm: alt && alt.success ? Math.max(0, alt.altitude || 0) / 1000 : 0,
          satLon: satPos ? undefined : satLon, satPos: satPos || undefined,
          freq: Number(p.freq) || 12.5, pol: p.pol || 'C', met: row,
          pathModel: p.pathModel || 'uniform',
          // 和风按点产品没有柱云水（只给云量），实测档在这条路上退回统计档
          cloudMode: p.cloudMode === 'measured' ? 'p840' : (p.cloudMode || 'p840'),
          diameter: 1, efficiency: 60
        })
        if (!a.error) { row.elev = a.elevation; row.gasDb = a.gasDb; row.rainDb = a.rainDb; row.cloudDb = a.cloudDb; row.totalDb = a.totalDb }
        else row.message = a.message || a.error
      }
      return r
    } catch (err) { return { error: err.message || String(err) } }
  })
  // ---- 日凌预报：轨道源与逐日轨迹的跨 IPC 缓存（容量 2 的 LRU，键 = 轨道 spec 串）----
  // 渲染端按 8 行一块分批算，块与块之间是两次 IPC；轨迹与地球站无关，一颗星一季只该采样一次，
  // 故缓存必须活在 handler 外面。容量 2 = 手上这颗星 + 刚切走的那颗，够用且不占内存。
  const SO_LRU = []
  function soCtxFor(orbit) {
    if (!orbit) return undefined
    const key = JSON.stringify(orbit)
    const i = SO_LRU.findIndex((x) => x.key === key)
    if (i >= 0) { const hit = SO_LRU.splice(i, 1)[0]; SO_LRU.unshift(hit); return hit.ctx }
    let src = null
    try { src = core().orbitSource(orbit) }
    catch { return { satTrack: new Map() } }        // 建不出来就让引擎自己去建、自己报错
    const ctx = { satTrack: new Map(), orbitSource: src }
    SO_LRU.unshift({ key, ctx })
    if (SO_LRU.length > 2) SO_LRU.length = 2
    return ctx
  }
  // ★ 将来「外部星历导入」接进来的唯一落点：配置里超过 4 KB 的星历只存引用 { type, ref:{groupId,satId} }，
  //   由主进程按引用去自定义卫星库取正文——星历正文不过 IPC。本期不会出现 ref，故直接报「不在库中」。
  function resolveOrbitSpec(orbit) {
    if (!orbit || typeof orbit !== 'object') return null
    if (!orbit.ref) return orbit
    return { error: true, message: '星历不在库中' }
  }
  function resolveOrbitParams(p) {
    if (!p || !p.orbit) return p
    const spec = resolveOrbitSpec(p.orbit)
    if (spec && spec.error) throw new Error(spec.message)
    return Object.assign({}, p, { orbit: spec })
  }

  // ---- 太阳亮温要的 F10.7：按该季分点日从本机已有的 SWPC 数据里取，永不等网络 ----
  // 渲染端不传 f107（界面上也没有这个输入），一律在这里按 year × season 填。分点日走引擎导出的
  // equinoxDateOf —— 别在这里抄第二份分点公式。调用方显式给了 f107 / solarTemp 就不动它。
  function withF107(p, season) {
    if (!p || p.f107 > 0 || p.solarTemp > 0) return p
    const y = parseInt(p.year, 10)
    if (!(y >= 1900 && y <= 2200)) return p
    try {
      const m = solarFlux.f107For(core().equinoxDateOf(y, season))
      if (!m || !(m.f107 > 0)) return p
      return Object.assign({}, p, {
        f107: m.f107,
        f107Meta: { source: m.source, at: m.at, fetchedAt: m.fetchedAt, low: m.low, high: m.high }
      })
    } catch (e) { return p }   // 取不到就让引擎走缺省 120，绝不因为取数失败而算不出来
  }
  // 批量入口逐季各算各的：春分与秋分相隔半年，F10.7 能差几十 sfu，一份入参填不了两季。
  // 每季仍走引擎的 calculateSunOutageSeasons（seasons 的口径归引擎管，这里不复制一份）。
  function sunSeasons(p, ctx) {
    const want = (p && Array.isArray(p.seasons) && p.seasons.length) ? p.seasons : ['vernal', 'autumnal']
    const out = { vernal: null, autumnal: null }
    for (const s of ['vernal', 'autumnal']) {
      if (!want.includes(s)) continue
      out[s] = core().calculateSunOutageSeasons(Object.assign({}, withF107(p, s), { seasons: [s] }), ctx)[s]
    }
    return out
  }
  // 算完顺手在后台刷一次 SWPC（一天一次的闸门由服务自己管）；不 await —— 计算永不等网络
  const bumpSolarFlux = () => { try { solarFlux.refresh().catch(() => {}) } catch (e) { /* 刷不动不影响计算 */ } }

  // ---- 日凌预报（独立窗口 + 计算 + Excel/Word/ICS 导出）----
  ipcMain.handle('suntool:open', gate(() => { if (openSunOutage) openSunOutage(); return true }))
  ipcMain.handle('suntool:confirmClose', () => { if (confirmCloseSunOutage) confirmCloseSunOutage(); return true })
  ipcMain.handle('sunoutage:compute', (_e, p) => {
    try {
      const q = resolveOrbitParams(p || {})
      const r = core().calculateSunOutage(withF107(q, q.season === 'vernal' ? 'vernal' : 'autumnal'), soCtxFor(p && p.orbit))
      bumpSolarFlux()
      return r
    } catch (err) { return { error: true, message: err.message || String(err) } }
  })
  // F10.7 数据的读数（顶栏那一行）：status() 是同步只读，顺手在后台刷一次
  ipcMain.handle('sunoutage:solarFlux', () => { const s = solarFlux.status(); bumpSolarFlux(); return s })
  // 点读数 = 硬刷一遍全链路（绕过一天一次的闸门），刷完回新的 status
  ipcMain.handle('sunoutage:solarFluxRefresh', async () => {
    try { await solarFlux.refresh({ force: true }) } catch (e) { /* 失败照样回 status，读数如实显示旧数据 */ }
    return solarFlux.status()
  })
  // 整表批量（站表整页 / SLA 弹窗与报告）：一次 IPC 全算完，站与站之间 setImmediate 让出，
  // 别的窗口的 IPC 与档位扫描不必排在整批后面（同 link:slaScanBatch 的做法）。
  // 每项可带 seasons（缺省两季；SLA 那条链路不传 → 行为不变），未选的季回 null。
  // 星历档的轨道源与逐日轨迹表按轨道 spec 串缓存（容量 2 的 LRU，跨 IPC 复用）——
  // 渲染端按 8 行一块分批发过来，每块都重新采样一遍轨迹的话，缓存就白建了。
  ipcMain.handle('sunoutage:computeBatch', async (_e, list) => {
    const arr = Array.isArray(list) ? list : []
    const out = []
    for (const p of arr) {
      let one
      try {
        one = sunSeasons(resolveOrbitParams(p || {}), soCtxFor(p && p.orbit))
      } catch (err) {
        const e1 = { error: true, message: err.message || String(err) }
        const want = (p && Array.isArray(p.seasons) && p.seasons.length) ? p.seasons : ['vernal', 'autumnal']
        one = { vernal: want.includes('vernal') ? e1 : null, autumnal: want.includes('autumnal') ? e1 : null }
      }
      out.push(one)
      if (out.length < arr.length) await new Promise((r) => setImmediate(r))
    }
    bumpSolarFlux()
    return out
  })
  // ---- 星侧太阳侵入（模型工作台「分析」页；二期 §6.8 / DESIGN2 D10–D13；进门禁）----
  // 太阳落进星上接收天线方向图 → 噪温升 ΔT 与等效 G/T 损失 ΔG/T = 10·lg(1 + ΔT/T_sys)。物理全在日凌核
  // satSunIntrusionSeries（太阳方向含卫星处视差 → 地球遮挡按日面弓形面积比 → 偏轴角 → sunNoiseTemp），这里只做：
  //   ① F10.7 按样本所在 UT 日经 solarFlux.f107For 现取（与 withF107 同一个数据源，永不等网络；调用方给了 f107 / solarTemp 就不动）；
  //   ② GRD 实测方向图的方向取值（grdPatternSource）：挂点的天线键 folder|name 由 preload 从 3D 页卫星树（localStorage，主进程读不到）
  //      解析成 {file, cfg} 附在 pattern.ant 上；方向图口径 = 3D 页该天线的存活波束 / 增益偏置 / 旋转 Rot，极化恒取两分量功率和
  //      （太阳是非极化源，天线收到的是 G_co + G_x 那一份）；整体电平按网格内功率积分核一遍（grdPowerFrac）；
  //   ③ 预筛 sep > θd/2 + 6θB 直接 0（高斯 / 口径档；日凌核内部另有一道 6θB + θd 的跳算，二者之间的值 < 1e−40 K）；
  //   ④ 按「同一 UT 日内 ≤ 256 拍」分块算，连续占用主线程 ≥ 30 ms 就让出一次事件循环；可取消（同窗同 jobKey 的新请求顶掉旧的，
  //      sunoutage:satIntrusionCancel 显式取消，窗口关了也停）。
  // 入参（纯数据）：
  //   samples   Float64Array[N×10]：tMs, 卫星 ECEF xyz（km）, 视轴 ECEF xyz, up ECEF xyz（标准 ECEF，z 为极轴）。
  //             up 为零或与视轴平行时按 coverage.basisFromAxes 的退化口径补（x = ẑ × z，极区退 x̂ × z，y = z × x；计入 counts.upDefault）
  //   freqGHz   挂点天线的接收（上行）频率 —— T_b 对频率敏感，C / Ku 能差 2–3 倍
  //   pattern   {kind:'gauss', thetaB3dB（°，3 dB 全宽）} | {kind:'diameter', diameterM}（→ 70λ/D）|
  //             {kind:'grd', key:'folder|name', ant?:{found, file, cfg}（preload 附）| file?（直接给导入 GRD 的相对路径，与 link:grdSample 的
  //              file 同口径；不带 '|' 的 key 也按文件认）, cfg?:{gainOffset, keptSets, yaw}（file 档用）, beamIndex?（原始 set 序号，0 基）,
  //              pol?（'RSS' 缺省 | 'P1' | 'P2'）, peakDbi?（给了就把方向图整体平移到这个峰值，不再做功率核对）, thetaB3dB?（网格外回退的高斯主瓣）}
  //   sysTempK  星上接收系统噪温（挂点 sysTempK，D10 缺省 500 K）；solarModel 'norp'（缺省）| 'legacy'；f107?；solarTemp?
  //   jobKey?   同一窗口里同键的请求互相顶替（缺省 'default'）；要并发算几路就各给各的键
  // 出参：{ok:true, n, dT:Float32Array(K), gtLossDb:Float32Array(dB), offAxisDeg:Float32Array(°), visibleFrac:Float32Array,
  //        worst:{i, tMs, dT, gtLossDb, offAxisDeg, visibleFrac}（dT 最大的第一拍）, counts:{gain, gauss, none, blocked, prescreened, upDefault},
  //        f107:[{date, f107, source}], sysTempK, solarModel, thetaB3dB|null,
  //        grd:{file, beams, peakDbi, offsetDb, level:'file'|'power'|'peak', powerFrac, fallbackThetaB3dB}|null, ms}
  //       | {ok:false, error, code?}（code：'canceled' | 'grd-unresolved' | 'grd-missing' | 'grd-bad'）
  const grdSampler = require('../../packages/core/utils/grdSampler.js')
  const SAT_SUN_MAX_N = 1200000            // 单次上限（IPC 包 ≈ 96 MB）；preload 按 26 万拍一段自动分段，渲染端不必管
  const SAT_SUN_T_MIN = Date.UTC(1900, 0, 1), SAT_SUN_T_MAX = Date.UTC(2200, 0, 1)
  const SAT_SUN_CHUNK = 256                // 一块的拍数：GRD 档一块 ≈ 256 × 24 次取值 ≈ 5–9 ms（时间片按块查，块小停顿才短）
  const SAT_SUN_SLICE_MS = 30              // 连续占用主线程超过这么久就让出一次（别的窗口的 IPC 与档位扫描不必排在一整年后面）
  const SAT_SUN_CODES = new Set(['canceled', 'grd-unresolved', 'grd-missing', 'grd-bad'])
  const DAY_MS = 86400000
  const R2D = 180 / Math.PI, D2R = Math.PI / 180
  const isoDay = (d0) => new Date(d0).toISOString().slice(0, 10)
  const codeErr = (code, msg) => Object.assign(new Error(msg), { code })
  const toF64 = (v) => {
    if (v instanceof Float64Array) return v
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return Float64Array.from(v)
    if (Array.isArray(v)) return Float64Array.from(v, Number)
    return null
  }
  // 时间片：due() 查是否到点；step() 到点就让出一次；两处都在让出后查取消（取消 = 抛 code:'canceled'）。
  // 让出用两层 setImmediate：从 IPC 回调里第一次排的 immediate 在同一轮 check 阶段就跑回来了，定时器与下一批 IPC 轮不上；
  // 在 check 阶段里再排一层才真正隔开一轮事件循环（实测第一片从 ~60 ms 降到 ~30 ms）
  const nextTurn = () => new Promise((r) => setImmediate(() => setImmediate(r)))
  function sliceClock(job) {
    let last = Date.now()
    const yieldNow = async () => {
      await nextTurn()
      last = Date.now()
      if (job && job.canceled) throw codeErr('canceled', '已取消。')
    }
    return {
      due: () => Date.now() - last >= SAT_SUN_SLICE_MS,
      yieldNow,
      async step() { if (Date.now() - last >= SAT_SUN_SLICE_MS) await yieldNow(); else if (job && job.canceled) throw codeErr('canceled', '已取消。') }
    }
  }

  // ── GRD 方向图 ──
  // 取值只经 grdSampler 的公开函数（loadBin / makeSampleCtx / sampleMaxCtx / peakDb），与 grd.sample、link:grdSample 同一条代码路径、同一口径
  // （复场双三次、0.01 dB、存活波束取最大包络），只是上下文每次调用建一次而不是每个点建一次。.grdbin 由 grd.precompile 按需生成，
  // 文件位置经 coverageGrd.exportSrc 解析（两个服务同一个 coverage-grd-imported 目录，main.js 构造时给的）。
  //   天线放在地心、视轴沿 ECEF +X：卫星取 {lon:0, lat:0, alt:−A}（赤道上 N = A，geodeticToEcef 的 (A − A) 恰为 0），
  //   cfg 取 azel 档 boreAz = boreEl = 0 → 天线基底 x = ECEF +Y、y = ECEF +Z、z = ECEF +X，再按 yaw（3D 页「旋转 Rot」）绕视轴转 ——
  //   与 coverage.basisFromAxes 在「姿态 + 挂点」档对挂点系施加 Rot 的转法逐字相同。天线系方向 d = (a, b, c)（z = 视轴、y = up、x = y × z，
  //   与日凌核 gain 档同一套轴）于是对应「无穷远点」经度 atan2(a, c)、纬度 atan2(b, √(a² + c²))、高度 1e15 km ——
  //   sampleBeamAt 由它还原出的方向与 d 相差 ≤ N·e²/H ≈ 4e−14 rad，高度 > 0 的空间目标也不走地平线闸。
  const GRD_A = 6378.137                   // = grdSampler.js 的 A（WGS-84 长半轴）
  const GRD_FAR_KM = 1e15
  const GRD_HOLD_MS = 120000               // 载入的 .grdbin 在这里留两分钟（连着改参数重算不必重读几十 MB）
  // 功率核对的两道门：网格内 (1/4π)∫G dΩ 落在 [0.2, 1.1] 才信文件电平是 dBi（方向性 / 增益）。
  //   > 1.1：比全空间方向性积分还大（留 0.4 dB 给求积误差），文件存的必是 EIRP 或带发射功率的电平；
  //   < 0.2：网格里连主瓣的能量都不到两成 —— 峰值归一（0 dB）或相对电平件（1/D₀ 量级）；
  //   两种都按「网格内功率 = 4π」重定标，即网格外不再有能量时的方向性（真值的上界，ΔT 只会偏大）。
  const GRD_POWER_LO = 0.2, GRD_POWER_HI = 1.1
  let grdHeld = null, grdHeldTimer = null
  function grdLoad(file) {
    if (!grd || typeof grd.precompile !== 'function' || !coverageGrd || typeof coverageGrd.exportSrc !== 'function') throw codeErr('grd-bad', 'GRD 服务未加载')
    let src
    try { src = coverageGrd.exportSrc(file) } catch (e) {
      throw codeErr(e && e.code === 'ENOENT' ? 'grd-missing' : 'grd-bad', e && e.code === 'ENOENT' ? `方向图文件 ${file} 不在了。` : `无法读取方向图：${(e && e.message) || e}`)
    }
    const pc = grd.precompile(file)
    if (!pc || !pc.ok) throw codeErr('grd-bad', `无法读取方向图：${(pc && pc.error) || '解析失败'}`)
    const bin = src.path + '.grdbin'
    let st
    try { st = fs.statSync(bin) } catch (e) { throw codeErr('grd-bad', `无法读取方向图：${(e && e.message) || e}`) }
    if (!(grdHeld && grdHeld.bin === bin && grdHeld.mtimeMs === st.mtimeMs)) {
      grdHeld = null                         // 先放掉旧的再读新的（大件别两份同时占着）
      const buf = fs.readFileSync(bin)
      grdHeld = { bin, file, mtimeMs: st.mtimeMs, buf, loaded: grdSampler.loadBin(buf), power: null }
    }
    clearTimeout(grdHeldTimer)
    grdHeldTimer = setTimeout(() => { grdHeld = null }, GRD_HOLD_MS)
    if (grdHeldTimer.unref) grdHeldTimer.unref()
    return grdHeld
  }
  // 网格节点 → 立体角密度 dΩ / (dX·dY)（uv 无量纲、其余网格按弧度）。只算视轴前半球（c > 0）—— 采样器也只取这半球
  // （grdSampler.invGridDir 在 c ≤ 0 返回 null）；θφ 网格（igrid 7）的负 θ 节点若镜像 (φ + 180°, −θ) 也在网格里就是同一方向，跳过。
  const inRangeMod360 = (x, a, b) => { const x2 = x + 360 * Math.ceil((a - x) / 360 - 1e-9); return x2 <= b + 1e-9 }
  function gridJac(igrid, X, Y, g) {
    if (igrid === 1) { const w2 = 1 - X * X - Y * Y; return w2 > 0 ? 1 / Math.sqrt(w2) : 0 }
    const a = X * D2R, b = Y * D2R
    switch (igrid) {
      case 4: case 9: return Math.cos(a) * Math.cos(b) > 0 ? Math.abs(Math.cos(b)) : 0      // d = [∓sa·ce, se, ca·ce]
      case 6: case 10: return Math.cos(a) * Math.cos(b) > 0 ? Math.abs(Math.cos(a)) : 0     // d = [∓sa, ca·se, ca·ce]
      case 5: { const th = Math.hypot(a, b); return th < Math.PI / 2 ? (th > 1e-12 ? Math.sin(th) / th : 1) : 0 }   // 方位等距极坐标
      case 7: {                                                                              // X = φ、Y = θ
        if (!(Math.cos(b) > 0)) return 0
        if (b < 0 && -Y >= Math.min(g.YS, g.YE) - 1e-9 && -Y <= Math.max(g.YS, g.YE) + 1e-9 && inRangeMod360(X + 180, Math.min(g.XS, g.XE), Math.max(g.XS, g.XE))) return 0
        return Math.abs(Math.sin(b))
      }
      default: return 0
    }
  }
  // 每个波束网格内的功率积分 (1/4π)·∫|E₁|² dΩ、(1/4π)·∫|E₂|² dΩ（梯形求积；按文件缓存，与极化 / 增益偏置无关）
  async function grdBeamPower(held, clock) {
    if (held.power) return held.power
    const L = held.loaded, out = []
    for (const bm of L.beams) {
      const g = bm.grid, NX = g.NX, NY = g.NY
      const dX = (g.XE - g.XS) / (NX - 1), dY = (g.YE - g.YS) / (NY - 1)
      const cell = Math.abs(dX * dY) * (L.igrid === 1 ? 1 : D2R * D2R) / (4 * Math.PI)
      const jx = new Float64Array(NX)
      let s1 = 0, s2 = 0
      for (let r = 0; r < NY; r++) {
        const Y = g.YS + r * dY, wy = r === 0 || r === NY - 1 ? 0.5 : 1
        for (let c = 0; c < NX; c++) jx[c] = gridJac(L.igrid, g.XS + c * dX, Y, g) * (c === 0 || c === NX - 1 ? 0.5 : 1)
        let a1 = 0, a2 = 0
        for (let c = 0, i = r * NX; c < NX; c++, i++) {
          const w = jx[c]
          if (!(w > 0)) continue
          a1 += w * (bm.c1re[i] * bm.c1re[i] + bm.c1im[i] * bm.c1im[i])
          a2 += w * (bm.c2re[i] * bm.c2re[i] + bm.c2im[i] * bm.c2im[i])
        }
        s1 += wy * a1; s2 += wy * a2
        if (clock.due()) await clock.yieldNow()
      }
      out.push([s1 * cell, s2 * cell])
    }
    held.power = out
    return out
  }
  // pattern → 方向取值源。key 的解析：preload 附的 ant 优先；否则 file；否则不带 '|' 的 key 按文件认（直接调用 / 单测）
  async function grdPatternSource(p0, clock) {
    const key = typeof p0.key === 'string' ? p0.key : ''
    const ant = p0.ant && typeof p0.ant === 'object' ? p0.ant : null
    let file = '', c0 = {}
    if (ant) {
      if (!ant.found) throw codeErr('grd-unresolved', `GRD 天线 ${key || '（空）'} 不在卫星树中。`)
      if (!ant.file) throw codeErr('grd-unresolved', `GRD 天线 ${key} 没有方向图文件。`)
      file = String(ant.file); c0 = ant.cfg && typeof ant.cfg === 'object' ? ant.cfg : {}
    } else if (typeof p0.file === 'string' && p0.file) {
      file = p0.file; c0 = p0.cfg && typeof p0.cfg === 'object' ? p0.cfg : {}
    } else if (key && !key.includes('|')) {
      file = key; c0 = p0.cfg && typeof p0.cfg === 'object' ? p0.cfg : {}
    } else if (key) throw codeErr('grd-unresolved', `GRD 天线 ${key} 解析不出方向图文件。`)
    else throw codeErr('grd-unresolved', '缺少方向图文件。')
    const held = grdLoad(file)
    const L = held.loaded
    const pol = p0.pol === 'P1' || p0.pol === 'P2' ? p0.pol : 'RSS'
    const cfg = { boreType: 'azel', boreAz: 0, boreEl: 0, yaw: Number(c0.yaw) || 0, pathLoss: 'none', pol, gainOffset: Number(c0.gainOffset) || 0 }
    if (Array.isArray(c0.keptSets)) cfg.keptSets = c0.keptSets.filter(Number.isInteger)
    const bi = Number.isInteger(p0.beamIndex) ? p0.beamIndex : null
    if (bi !== null) {
      if (bi < 0 || bi >= L.beams.length) throw codeErr('grd-bad', `方向图仅有 ${L.beams.length} 个波束，波束序号 ${bi + 1} 越界。`)
      cfg.keptSets = [bi]
    }
    const peak = grdSampler.peakDb(L, cfg)
    if (!Number.isFinite(peak)) throw codeErr('grd-bad', '方向图中无法取得峰值。')
    const ctx = grdSampler.makeSampleCtx(L, { lon: 0, lat: 0, alt: -GRD_A }, cfg)
    if (!ctx || !ctx.beams.length) throw codeErr('grd-bad', '方向图没有可用的波束。')
    // 电平：显式 peakDbi > 功率核对 > 文件原值
    const pw = await grdBeamPower(held, clock)
    let powerFrac = 0
    for (const i of ctx.beamIdx) {
      const p = pw[i]
      const v = (pol === 'P1' ? p[0] : pol === 'P2' ? p[1] : p[0] + p[1]) * Math.pow(10, cfg.gainOffset / 10)
      if (v > powerFrac) powerFrac = v
    }
    let level = 'file', offsetDb = 0
    if (Number.isFinite(p0.peakDbi)) { level = 'peak'; offsetDb = p0.peakDbi - peak }
    else if (powerFrac > 0 && (powerFrac > GRD_POWER_HI || powerFrac < GRD_POWER_LO)) { level = 'power'; offsetDb = -10 * Math.log10(powerFrac) }
    const peakEff = peak + offsetDb
    // 网格外（太阳没被遮挡时多半在网格外，摸底 §1.4 坑 4）回退高斯主瓣：θB 给了用给的，否则取与峰值增益等效的理想高斯束
    // （∫G dΩ = 4π ⇒ G₀ = 16·ln2 / θB²，θB 弧度）——真实天线效率 < 1，等效束只会更宽一点，远处照样 ≈ 0
    const fallbackThetaB3dB = Number(p0.thetaB3dB) > 0 ? Number(p0.thetaB3dB)
      : (peakEff > 0 ? Math.sqrt(16 * Math.LN2 / Math.pow(10, peakEff / 10)) * R2D : 0)
    return {
      file, beams: ctx.beamIdx.length, peakDbi: peak, offsetDb, level, powerFrac, fallbackThetaB3dB,
      // d：天线系单位矢量 → dBi；网格外 / 视轴背面 → null（日凌核随即整拍退回高斯主瓣）
      gainAt(d) {
        const a = d[0], b = d[1], c = d[2]
        const v = grdSampler.sampleMaxCtx(ctx, Math.atan2(a, c) * R2D, Math.atan2(b, Math.hypot(a, c)) * R2D, GRD_FAR_KM)
        return v == null || !Number.isFinite(v) ? null : v + offsetDb
      }
    }
  }

  async function satIntrusion(req, job) {
    const t0 = Date.now()
    const clock = sliceClock(job)
    const o = req && typeof req === 'object' ? req : {}
    let S = toF64(o.samples)
    if (!S || !S.length || S.length % 10) return { ok: false, error: '样本须为 N×10 的数组' }
    const n = S.length / 10
    if (n > SAT_SUN_MAX_N) return { ok: false, error: `样本数超过 ${SAT_SUN_MAX_N}。` }
    let upDefault = 0
    for (let i = 0; i < n; i++) {
      if ((i & 4095) === 4095 && clock.due()) await clock.yieldNow()
      const k = i * 10
      for (let j = 0; j < 10; j++) if (!Number.isFinite(S[k + j])) return { ok: false, error: `第 ${i + 1} 个样本含非数值` }
      if (S[k] < SAT_SUN_T_MIN || S[k] > SAT_SUN_T_MAX) return { ok: false, error: `第 ${i + 1} 个样本的时刻越界` }
      if (!(Math.hypot(S[k + 1], S[k + 2], S[k + 3]) > 6000)) return { ok: false, error: `第 ${i + 1} 个样本的卫星位置不在地球外` }
      const bl = Math.hypot(S[k + 4], S[k + 5], S[k + 6])
      if (!(bl > 0)) return { ok: false, error: `第 ${i + 1} 个样本的视轴为零向量` }
      // up 去掉视轴分量后退化（零 / 与视轴平行）：日凌核 gain 档会把天线 x/y 轴塌成零、整拍按视轴上的峰值取 —— 这里按 basisFromAxes 的退化口径补
      const zx = S[k + 4] / bl, zy = S[k + 5] / bl, zz = S[k + 6] / bl
      const ux = S[k + 7], uy = S[k + 8], uz = S[k + 9], ud = ux * zx + uy * zy + uz * zz
      if (!(Math.hypot(ux - ud * zx, uy - ud * zy, uz - ud * zz) > 1e-9 * Math.hypot(ux, uy, uz))) {
        if (S === o.samples) S = Float64Array.from(S)          // 调用方的数组不改
        let xx = -zy, xy = zx, xz = 0                             // x = ẑ × z
        let xl = Math.hypot(xx, xy)
        if (!(xl > 1e-9)) { xx = 0; xy = -zz; xz = zy; xl = Math.hypot(xy, xz) }   // 极区：x = x̂ × z
        xx /= xl; xy /= xl; xz /= xl
        S[k + 7] = zy * xz - zz * xy; S[k + 8] = zz * xx - zx * xz; S[k + 9] = zx * xy - zy * xx   // up = y = z × x
        upDefault++
      }
    }
    const freqGHz = Number(o.freqGHz)
    if (!(freqGHz > 0)) return { ok: false, error: '缺少接收频率' }
    const sysTempK = Number(o.sysTempK) > 0 ? Number(o.sysTempK) : 500
    const solarModel = o.solarModel === 'legacy' ? 'legacy' : 'norp'
    const solarTemp = Number(o.solarTemp) > 0 ? Number(o.solarTemp) : undefined
    const fixedF107 = Number(o.f107) > 0 ? Number(o.f107) : null
    const p0 = o.pattern && typeof o.pattern === 'object' ? o.pattern : {}
    let pat = null, thetaB = null, gsrc = null
    if (p0.kind === 'grd') {
      gsrc = await grdPatternSource(p0, clock)
      pat = { kind: 'gain', gainAt: gsrc.gainAt, fallbackThetaB3dBDeg: gsrc.fallbackThetaB3dB }
    } else if (p0.kind === 'diameter') {
      const D = Number(p0.diameterM)
      if (!(D > 0)) return { ok: false, error: '缺少天线口径' }
      pat = { kind: 'diameter', diameterM: D }
      thetaB = 20.98547 / (freqGHz * D)            // 与日凌核 sunNoiseTemp / outageModel 同式（70λ/D）
    } else {
      thetaB = Number(p0.thetaB3dB !== undefined ? p0.thetaB3dB : p0.thetaB3dBDeg)
      if (!(thetaB > 0)) return { ok: false, error: '缺少 3 dB 波束宽' }
      pat = { kind: 'gauss', thetaB3dBDeg: thetaB }
    }
    const C = core()
    // 块：同一 UT 日内每 ≤ SAT_SUN_CHUNK 拍一块（F10.7 按日取；拍与拍之间互不相干，怎么切结果都逐位相同）
    const blocks = []
    for (let i = 0; i < n;) {
      const d0 = Math.floor(S[i * 10] / DAY_MS) * DAY_MS
      let j = i + 1
      while (j < n && j - i < SAT_SUN_CHUNK && Math.floor(S[j * 10] / DAY_MS) * DAY_MS === d0) j++
      blocks.push({ a: i, b: j, d0 })
      i = j
    }
    const fDay = new Map()
    const f107Of = (d0) => {
      if (solarTemp) return undefined
      if (fixedF107) return fixedF107
      if (!fDay.has(d0)) {
        let m = null
        try { m = solarFlux.f107For(isoDay(d0)) } catch (e) { m = null }
        fDay.set(d0, m && m.f107 > 0 ? m : null)
      }
      const m = fDay.get(d0)
      return m ? m.f107 : undefined               // 取不到 → 日凌核缺省 120，绝不因取数失败而算不出来
    }
    const dT = new Float64Array(n), gl = new Float64Array(n), off = new Float64Array(n), vis = new Float32Array(n)
    const counts = { gain: 0, gauss: 0, none: 0, blocked: 0, prescreened: 0, upDefault }
    const base = { freqGHz, sysTempK, solarModel, solarTemp }
    for (const r of blocks) {
      const res = C.satSunIntrusionSeries({ ...base, f107: f107Of(r.d0), samples: S.subarray(r.a * 10, r.b * 10), pattern: pat })
      dT.set(res.dT, r.a); gl.set(res.gtLossDb, r.a); off.set(res.offAxisDeg, r.a); vis.set(res.visibleFrac, r.a)
      for (const k of ['gain', 'gauss', 'none', 'blocked']) counts[k] += res.counts[k] || 0
      await clock.step()
    }
    if (!gsrc) {
      // ③ 预筛：日面最近边缘离视轴超过 6θB（主瓣 −108 dB 以外）的拍直接记 0
      for (let i = 0; i < n; i++) {
        if (vis[i] > 0 && off[i] > C.sunDiamDegAt(S[i * 10]) / 2 + 6 * thetaB) { counts.prescreened++; dT[i] = 0; gl[i] = 0 }
        if ((i & 4095) === 4095 && clock.due()) await clock.yieldNow()
      }
    }
    let wi = -1
    for (let i = 0; i < n; i++) if (wi < 0 || dT[i] > dT[wi]) wi = i
    const f107 = solarTemp ? []
      : fixedF107 ? [{ date: null, f107: fixedF107, source: 'manual' }]
        : [...fDay].map(([d0, m]) => ({ date: isoDay(d0), f107: m ? m.f107 : 120, source: m ? m.source : 'default' }))
    return {
      ok: true, n,
      dT: Float32Array.from(dT), gtLossDb: Float32Array.from(gl), offAxisDeg: Float32Array.from(off), visibleFrac: vis,
      worst: wi < 0 ? null : { i: wi, tMs: S[wi * 10], dT: dT[wi], gtLossDb: gl[wi], offAxisDeg: off[wi], visibleFrac: vis[wi] },
      counts, f107, sysTempK, solarModel, solarTemp: solarTemp || null, thetaB3dB: thetaB,
      grd: gsrc ? { file: gsrc.file, beams: gsrc.beams, peakDbi: gsrc.peakDbi, offsetDb: gsrc.offsetDb, level: gsrc.level, powerFrac: gsrc.powerFrac, fallbackThetaB3dB: gsrc.fallbackThetaB3dB } : null,
      ms: Date.now() - t0
    }
  }
  // 在算的任务：键 = 发起窗口 + jobKey。同键新请求到了就把旧的标成取消（旧的在下一个时间片退出，回 code:'canceled'）
  const satSunJobs = new Map()
  const satSunJobKey = (e, k) => `${(e && e.sender && e.sender.id) || 0}|${typeof k === 'string' && k ? k.slice(0, 64) : 'default'}`
  ipcMain.handle('sunoutage:satIntrusion', async (e, req) => {
    const key = satSunJobKey(e, req && req.jobKey)
    const prev = satSunJobs.get(key)
    if (prev) prev.canceled = true
    const job = { canceled: false }
    satSunJobs.set(key, job)
    const wc = e && e.sender
    const onGone = () => { job.canceled = true }
    if (wc && typeof wc.once === 'function') wc.once('destroyed', onGone)
    try {
      const r = await satIntrusion(req, job)
      if (r && r.ok) bumpSolarFlux()
      return r
    } catch (err) {
      const code = err && SAT_SUN_CODES.has(err.code) ? err.code : undefined
      return code ? { ok: false, error: err.message, code, ...(code === 'canceled' ? { canceled: true } : {}) } : { ok: false, error: (err && err.message) || String(err) }
    } finally {
      if (satSunJobs.get(key) === job) satSunJobs.delete(key)
      if (wc && typeof wc.removeListener === 'function') wc.removeListener('destroyed', onGone)
    }
  })
  // 显式取消：jobKey 缺省 'default'。→ 有没有这么一个在算的任务
  ipcMain.handle('sunoutage:satIntrusionCancel', (e, k) => {
    const j = satSunJobs.get(satSunJobKey(e, k))
    if (j) j.canceled = true
    return !!j
  })
  // 模板版 Excel：整本只有两张表（地球站参数 / 逐日日凌窗口），版式见 report.buildSunOutageExcel
  ipcMain.handle('sunoutage:exportExcel', async (e, payload) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const lang = await senderLang(e, payload && payload.lang)
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: safeSaveName(payload && payload.defaultName, dtFile('日凌预报.xlsx', lang)),
      filters: [{ name: dt('Excel 工作簿', lang), extensions: ['xlsx'] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    try {
      const buf = await report.buildSunOutageExcel(Object.assign({}, payload || {}, { lang }))
      fs.writeFileSync(filePath, Buffer.from(buf))
      return receipt({ ok: true, filePath })
    } catch (err) {
      const busy = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')
      return { ok: false, error: busy ? '文件可能正被其他程序打开（如 Excel）' : (err.message || String(err)) }
    }
  })
  // Word 报告：payload = { result, station:{name,lat,lon}, satellite:{name,lon}, tz:'bjt'|'utc' }
  ipcMain.handle('sunoutage:exportWord', async (e, payload) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const lang = await senderLang(e, payload && payload.lang)
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: safeSaveName(payload && payload.defaultName, dtFile('日凌预报报告.docx', lang)),
      filters: [{ name: dt('Word 文档', lang), extensions: ['docx'] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    try {
      const buf = await report.buildSunOutageWord(Object.assign({}, payload || {}, { lang }))
      fs.writeFileSync(filePath, Buffer.from(buf))
      return receipt({ ok: true, filePath })
    } catch (err) {
      const busy = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')
      return { ok: false, error: busy ? '文件可能正被其他程序打开（如 Word）' : (err.message || String(err)) }
    }
  })
  // ICS 日历（多站 × 多季一份）：事件时刻恒用 UTC（导入方自动换算本地时区）；
  // SUMMARY 里的峰值用渲染端按显示时区平移好的串 —— 主进程不再按经度推时区。
  ipcMain.handle('sunoutage:exportIcs', async (e, payload) => {
    const lang = await senderLang(e, payload && payload.lang)
    const en = lang === 'en'
    const p = Object.assign({}, payload || {}, { lang })
    const satName = (p.sat && (p.sat.name || p.sat.slotText)) || (en ? 'Satellite' : '卫星')
    const events = report.sunOutageIcsEvents(p)
    if (!events.length) return { ok: false, error: '无日凌事件可导出' }
    const ics = core().buildIcs({ name: `${en ? 'Sun Outage Forecast' : '日凌预报'} ${satName} ${p.year != null ? p.year : ''}`.trim(), events })
    const win = BrowserWindow.fromWebContents(e.sender)
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: safeSaveName(p.defaultName || `${en ? 'Sun Outage Forecast' : '日凌预报'}_${satName}_${p.year != null ? p.year : ''}.ics`, dtFile('日凌预报.ics', lang)),
      filters: [{ name: dt('iCalendar 日历', lang), extensions: ['ics'] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    try {
      fs.writeFileSync(filePath, ics, 'utf8')
      return receipt({ ok: true, filePath, count: events.length })
    } catch (err) {
      return { ok: false, error: writeErrText(err) }
    }
  })
  // ---- 本地存储 ----
  ipcMain.handle('store:history:list', () => storage.listHistory())
  ipcMain.handle('store:history:add', (_e, r) => storage.addHistory(r))
  ipcMain.handle('store:history:delete', (_e, id) => storage.deleteHistory(id))
  ipcMain.handle('store:history:clear', () => storage.clearHistory())
  // 配置库按工作台命名空间分家（geo/ngso/regen/e2e/rain），ns 由渲染端逐窗传常量；见 storage.cfgFile
  ipcMain.handle('store:config:list', (_e, ns) => storage.listConfigs(ns))
  ipcMain.handle('store:config:listAll', () => storage.listAllConfigs())
  ipcMain.handle('store:config:save', (_e, { ns, cfg }) => storage.saveConfig(ns, cfg))
  ipcMain.handle('store:config:delete', (_e, { ns, id }) => storage.deleteConfig(ns, id))
  ipcMain.handle('store:config:reorder', (_e, { ns, ids }) => storage.reorderConfigs(ns, ids))
  ipcMain.handle('store:config:move', (_e, { ns, id, parentId, anchorId, position }) => storage.moveItem(ns, id, parentId, anchorId, position))
  ipcMain.handle('store:config:deleteFolder', (_e, { ns, id }) => storage.deleteFolder(ns, id))
  // 自动保存（链路预算四窗）：只更新、不新建（已删的配置不会被迟到的写盘复活），见 storage.updateConfigState
  ipcMain.handle('store:config:updateState', (_e, { ns, id, state, name, nameAuto }) => storage.updateConfigState(ns, id, { state, name, nameAuto }))
  // 配置的历史版本：清单不带 state，还原时按 id 取整份
  ipcMain.handle('store:versions:list', (_e, { ns, id }) => storage.listVersions(ns, id))
  ipcMain.handle('store:versions:get', (_e, { ns, id, verId }) => storage.getVersion(ns, id, verId))
  ipcMain.handle('store:versions:add', (_e, { ns, id, version }) => storage.addVersion(ns, id, version))
  ipcMain.handle('store:settings:get', () => storage.getSettings())
  // ---- 只许渲染端写它自己的偏好项（2026-08-11 授权审计）----
  // 原先是 (_e, s) => storage.setSettings(s)：无任何键名过滤，而 setSettings 是浅合并，
  // 于是 settings.json 里【每一个】键都成了渲染端可写的，包括授权状态自己。控制台一行即可：
  //   setSettings({ deviceId:'<别人的设备ID>', mgrIdSeal:null })  → 重启后落进 activation.js
  //       deviceId() 的第 3 分支（无封印 → 认领并补盖）→ 完整继承对方授权。而对方的设备ID
  //       就摆在「关于」框里、还支持一键复制（那本是给客户报给管理员开通用的）。
  //   setSettings({ mgrLicFloor:null })    → 重放下限归零 → 撤销前存下的旧激活书可以救活
  //   setSettings({ mgrClockAnchor:null }) → 时钟高水位清零 → 配合系统时钟回拨给过期件续命
  // 机器封印（DPAPI）防的是「把 settings.json 从别的机器拷过来」，防不了「从合法入口把
  // stored 改成别人的、同时把封印清掉」—— 那三个键就是这么被绕过去的。
  //
  // 白名单只收渲染端确实在写的几项：Settings.vue 的 amapKey/units/noiseRatioMode/mapPov
  // （src/pages/Settings.vue 的 form），加 miniBindings（src/shared/miniBindings.js）。
  // mapPov = 地图视角 { id, overrides(争议区分组键), layers }。★ 它只能存在这里，不许再进
  // ConstellationMap3D 的 viewPrefs 快照 —— 两处都存的话老存档会把视角带回去、跟设置打架。
  // 授权相关的键（deviceId / mgrIdSeal / activationLic / mgrLicFloor / mgrClockAnchor /
  // mgrFirstSeen）一律只由主进程的 activation.js 自己维护，渲染端永远碰不到。
  // 新增用户偏好项时记得往这张表里加一条 —— 漏加的现象是「设置存不住」，测试时一眼可见。
  const SETTINGS_WRITABLE = new Set(['amapKey', 'units', 'noiseRatioMode', 'miniBindings', 'miniSelfLabel', 'mapPov'])
  ipcMain.handle('store:settings:set', (_e, s) => {
    const patch = {}
    const rejected = []
    for (const k of Object.keys(s && typeof s === 'object' ? s : {})) {
      if (SETTINGS_WRITABLE.has(k)) patch[k] = s[k]
      else rejected.push(k)
    }
    // 静默丢弃会让「设置存不住」这类真 bug 无从查起，故留一行日志；但绝不因此报错，
    // 免得攻击者能靠返回值试探出保护键名单（也免得正常升级路径上多一个失败分支）。
    if (rejected.length) console.warn('[ipc] store:settings:set 拒绝了不可由渲染端写入的键：', rejected.join(', '))
    return storage.setSettings(patch)
  })
  // 行政边界包（resources/adm，逐国懒加载）：只读查询
  ipcMain.handle('adm:pack', (_e, lvl, iso) => admBoundaries.pack(lvl, iso))
  ipcMain.handle('store:library:get', (_e, ns) => storage.getLibrary(ns))
  ipcMain.handle('store:library:save', (_e, { ns, data }) => storage.saveLibrary(ns, data))

  // ---- 通用二进制导出（原生保存对话框 → 写盘）：覆盖图 PNG / 矢量 PDF 等 ----
  // payload: { defaultName, data:ArrayBuffer|Uint8Array, filters:[{name,extensions}] }
  ipcMain.handle('file:save', async (e, payload) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: safeSaveName(payload.defaultName, 'export.bin'),
      filters: dtFilters(payload.filters || [{ name: '所有文件', extensions: ['*'] }], await senderLang(e, payload.lang))
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    try {
      // data 收三种：字节（Uint8Array/Buffer）、字符串、字符串分片数组。
      // 分片是给大文本用的——渲染端不必先拼成一个几百 MB 的整串、更不必逐字符转字节数组
      //（Uint8Array.from(text, fn) 会把整份文本物化成逐字符的 JSArray，上百 MB 的文本必崩）。
      // encoding 只对字符串生效，缺省 utf8；方向图管线全程「latin1 字节串」，那边显式传 latin1。
      const enc = payload.encoding || 'utf8'
      const chunk = (d) => (typeof d === 'string' ? Buffer.from(d, enc) : Buffer.from(d))
      // 只有【整个数组都是字符串】才当文本分片；数字数组仍按字节走老路（Buffer.from([...])）
      if (Array.isArray(payload.data) && payload.data.every((p) => typeof p === 'string')) {
        const fd = fs.openSync(filePath, 'w')
        try {
          for (const part of payload.data) {
            const b = chunk(part)
            // writeSync 不保证一次写完（同 fs.writeFileSync 内部的写法），按返回的字节数续写
            for (let off = 0; off < b.length;) off += fs.writeSync(fd, b, off, b.length - off)
          }
        } finally { fs.closeSync(fd) }
      } else {
        fs.writeFileSync(filePath, chunk(payload.data))
      }
      return receipt({ ok: true, filePath })
    } catch (err) {
      return { ok: false, error: writeErrText(err) }   // 占用/权限 → 友好错误，不抛出
    }
  })

  // ---- PFD Mask 生成（ITU-R S.1503）：参数 → 引擎 → XSD 校验 → XML ----
  // 计算在 worker_threads 里跑（services/pfdMaskWorker.js）：默认 60×60×23 网格约 1.1 s、120 点 / 2° 一档十几秒，
  // 全是同步长调用。从前直接在这里算，期间主进程事件循环被占死——所有窗口的 IPC、菜单、拖动一起卡住。
  // 进度经 pfd:progress 推回发起窗口，pfd:cancel 中止（直接结束 worker）；一个窗口同时只算一份，新的一份顶掉旧的。
  // XML 留在主进程：回给渲染端的只有统计与文件清单（文件名 / 字节数），导出时 pfd:files 按所选「文件划分」取一次
  // 字节，照旧走 file:saveMany 落盘（复用其覆盖核对与占用 / 权限的友好报错）——不再每算一次就把三种划分的整份 XML
  // 克隆过 IPC（细步长下单份就几十 MB）。
  // 入参两种形态都收（见 pfdMaskWorker.generate）：单 job（旧）直接是一份 params；多 job 为
  // { satName, ntcId, specVersion, jobs, operatingParams?, runId? }。runId 原样带回进度与结果，渲染端凭它认这一轮。
  // 用到才 require（同从前的引擎）：这个模块万一载入出错，只坏 PFD 这几条，不连累 register() 里排在后面的全部 handler
  const pfdWorker = () => require('../services/pfdMaskWorker')
  const pfdRuns = new Map()     // webContents.id → 进行中的 { promise, cancel }
  const pfdKept = new Map()     // webContents.id → { token, files, opFiles }（含 XML 字节；下一轮开算 / 切配置 / 关窗时丢）
  const pfdHooked = new Set()   // 已挂过 destroyed 清理的窗口
  let pfdSeq = 0
  const pfdDrop = (id) => {
    const run = pfdRuns.get(id)
    if (run) { pfdRuns.delete(id); run.cancel() }
    pfdKept.delete(id)
  }
  ipcMain.handle('pfd:generate', async (e, req) => {
    const sender = e.sender, id = sender.id
    pfdDrop(id)
    if (!pfdHooked.has(id)) {
      pfdHooked.add(id)
      sender.once('destroyed', () => { pfdDrop(id); pfdHooked.delete(id) })
    }
    const runId = req && req.runId != null ? String(req.runId) : ''
    const t0 = Date.now()
    let run
    try {
      run = pfdWorker().start(req, {
        onProgress: (done, total) => {
          try { if (!sender.isDestroyed()) sender.send('pfd:progress', { id: runId, done, total }) } catch { /* 窗口没了 */ }
        }
      })
    } catch (err) { return { ok: false, error: (err && err.message) || String(err), runId } }
    pfdRuns.set(id, run)
    try {
      const r = await run.promise
      // 结果到手的这一拍里被取消 / 被新一轮顶掉：按取消算，不落缓存
      if (pfdRuns.get(id) !== run) return { ok: false, canceled: true, error: '已取消', runId }
      pfdRuns.delete(id)
      if (!r || !r.ok) return Object.assign({ ok: false }, r, { runId })
      const token = `${Date.now().toString(36)}.${++pfdSeq}`
      pfdKept.set(id, { token, files: r.files || {}, opFiles: r.opFiles || [] })
      return Object.assign(pfdWorker().slim(r), { token, runId, elapsedMs: Date.now() - t0 })
    } catch (err) {
      if (pfdRuns.get(id) === run) pfdRuns.delete(id)
      if (err && err.canceled) return { ok: false, canceled: true, error: '已取消', runId }
      return { ok: false, error: (err && err.message) || String(err), runId }
    }
  })
  // 中止进行中的计算（「取消」按钮）；opt.discard 再丢掉本窗口缓存的结果（切配置时）。
  // 取消按钮不丢缓存：结果恰在点下的那一拍已回到窗口时，丢了它窗口里那份就取不出字节了（计算中本就没有缓存——新一轮开算先丢旧的）
  ipcMain.handle('pfd:cancel', (e, opt) => {
    const id = e.sender.id, run = pfdRuns.get(id)
    if (run) { pfdRuns.delete(id); run.cancel() }
    if (opt && opt.discard) pfdKept.delete(id)
    return !!run
  })
  // 导出时取所选文件划分的 XML 字节：{ token, mode } → { ok, files: [{ filename, data }], opFiles: [{ filename, data }] }
  ipcMain.handle('pfd:files', (e, q) => {
    const k = pfdKept.get(e.sender.id)
    if (!k || !q || q.token !== k.token) return { ok: false, error: '计算结果已失效' }
    const list = k.files[q.mode] || k.files['per-mask'] || []
    const pick = (f) => ({ filename: f.filename, data: f.data })
    return { ok: true, files: list.map(pick), opFiles: k.opFiles.map(pick) }
  })

  // ---- 视频导出（H.264 MP4 / 图片序列）：开会话、按位置流式写、收尾（见 services/videoFile.js）。全部在授权锁内 ----
  require('../services/videoFile').registerVideoIpc(ipcMain, { dialog, BrowserWindow, shell: require('electron').shell, safeSaveName, writeErrText })

  // ---- 批量落盘到一个目录：mask 分文件导出 + §E3 的参数存档一起出；可编程波束地图的多文件输出 ----
  // payload: { dirLabel?, files:[{filename, text} | {filename, data:Uint8Array}] }（text 按 UTF-8 写；data 原样写字节）
  ipcMain.handle('file:saveMany', async (e, payload) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: dt(payload.dirLabel || '选择输出目录', await senderLang(e, payload.lang)),
      properties: ['openDirectory', 'createDirectory']
    })
    if (canceled || !filePaths || !filePaths[0]) return { ok: false, canceled: true }
    const dir = filePaths[0]
    const written = []
    try {
      // 先把全部目标路径定下来（非法路径在一个字节都没写之前就报）
      const jobs = []
      for (const f of (payload.files || [])) {
        // 放行至多三层子目录（PFD 出包要 Masks/ 这一层；可编程波束地图的脚本可按卫星 / 波束分目录），其余非法字符照旧替换。
        // 白名单式而非黑名单式：分段清洗 + 段数上限 + 显式拒绝 ..，避免路径穿越。
        const rel = String(f.filename).split('/').filter(Boolean)
          .map((s) => s.replace(/[\\:*?"<>|]/g, '_'))
        if (!rel.length || rel.length > 4 || rel.some((s) => s === '..' || s === '.')) {
          throw new RangeError(`非法输出路径：${f.filename}`)
        }
        jobs.push({ p: path.join(dir, ...rel), text: f.text, data: f.data })
      }
      // 覆盖核对（交互调研 D5）：选目录不像保存框会问覆盖 —— 已有同名文件就先列出来问一次，取消则一个都不写
      const clash = exportedPaths.pendingOverwrites(jobs.map((j) => j.p), null)
      if (clash.length && !(await exportedPaths.confirmOverwrites(dialog, win, clash, payload.lang))) return { ok: false, canceled: true }
      for (const j of jobs) {
        fs.mkdirSync(path.dirname(j.p), { recursive: true })
        if (j.data != null) fs.writeFileSync(j.p, Buffer.from(j.data))
        else fs.writeFileSync(j.p, j.text == null ? '' : String(j.text), 'utf8')
        written.push(j.p)
      }
      exportedPaths.markExported(dir)
      return receipt({ ok: true, dir, written }, written)
    } catch (err) {
      exportedPaths.markAll(written)
      const busy = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')
      return {
        ok: false, dir, written,
        error: busy ? '目标文件可能正被其他程序打开' : (err.message || String(err))
      }
    }
  })

  // ---- 协调区 Polygon 导入（原生框选 .gxt / .kml，多选）→ 逐个读原文返回渲染进程解析 ----
  // KML 含中文名/描述按 UTF-8 读；GXT 为 ASCII/latin1（sat_name 可能含 latin1 高位字符）按 latin1 读。
  ipcMain.handle('poly:open', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const lang = await senderLang(e)
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: dt('导入 Polygon（GXT / KML，可多选）', lang), properties: ['openFile', 'multiSelections'],
      filters: dtFilters([
        { name: 'Polygon (*.gxt, *.kml)', extensions: ['gxt', 'kml'] },
        { name: 'GXT 等值线 (*.gxt)', extensions: ['gxt'] },
        { name: 'KML (*.kml)', extensions: ['kml'] },
        { name: '所有文件', extensions: ['*'] }
      ], lang)
    })
    if (canceled || !filePaths || !filePaths.length) return { canceled: true }
    const path = require('path')
    const files = filePaths.map((fp) => {
      const ext = path.extname(fp).slice(1).toLowerCase()
      try { return { base: path.basename(fp), ext, text: fs.readFileSync(fp, ext === 'kml' ? 'utf8' : 'latin1') } }
      catch (err) { return { base: path.basename(fp), ext, error: err.message } }
    })
    return { canceled: false, files }
  })

  // ---- 读取系统字体（供矢量 PDF 嵌入；jsPDF 仅支持单面 TTF，不支持 TTC，且按用到的字形子集化，体积可忽略）----
  // latin：Times New Roman 三面（常规/粗/斜），西文与数字用——与软件界面同字体；
  // cjk  ：候选里首个存在的单面中文 TTF，中文字形用（TNR 无汉字，PDF 的字体是按「字体资源」而非按字形回落的，
  //        故必须分两套注册，由导出端逐条文本按有无汉字选面）。
  // 任一项缺失即为 null：latin 缺则退到 PDF 内建 times（基础 14 字体，观感等同），cjk 缺则中文可能缺字。
  ipcMain.handle('font:pdf', () => {
    if (process.platform !== 'win32') return { ok: false }
    const path = require('path')
    const dir = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts')
    const b64 = (f) => {
      try { const p = path.join(dir, f); return fs.existsSync(p) ? fs.readFileSync(p).toString('base64') : null }
      catch { return null }
    }
    let cjk = null, cjkName = null
    for (const f of ['simhei.ttf', 'simkai.ttf', 'simfang.ttf', 'Deng.ttf', 'msyh.ttf', 'simsunb.ttf']) {
      const d = b64(f)
      if (d) { cjk = d; cjkName = f; break }
    }
    return { ok: true, cjk, cjkName, latin: b64('times.ttf'), latinBold: b64('timesbd.ttf'), latinItalic: b64('timesi.ttf') }
  })

  // ---- 报告导出（原生保存对话框 → 写盘）----
  ipcMain.handle('report:export', async (e, payload) => {
    const fmt = payload.format === 'excel' ? 'excel' : 'word'
    const ext = fmt === 'excel' ? 'xlsx' : 'docx'
    const win = BrowserWindow.fromWebContents(e.sender)
    const lang = await senderLang(e, payload.lang)
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `${dt('链路预算报告', lang)}.${ext}`,
      filters: [{ name: dt(fmt === 'excel' ? 'Excel 工作簿' : 'Word 文档', lang), extensions: [ext] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    // 与本文件其余导出口同一口径：目标文件被 Word/Excel 打开时 writeFileSync 抛 EBUSY/EPERM，
    // 不接住就变成 invoke 的 rejection —— 调用端没 catch 就是「点了导出，没文件也没提示」。
    try {
      const buf = fmt === 'excel' ? await report.buildExcel(payload) : await report.buildWord(payload)
      fs.writeFileSync(filePath, Buffer.from(buf))
      return receipt({ ok: true, filePath })
    } catch (err) {
      const busy = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')
      return { ok: false, error: busy ? '文件可能正被其他程序打开（如 Word / Excel）' : (err.message || String(err)) }
    }
  })

  // ---- 交付级链路预算报告（.xlsx / .pdf，同名同目录）----
  // 模型由渲染进程按 src/shared/lbReport.js 组装（元信息 / 逐链路结果 / 输入清单 / 图件）；
  // 瀑布段在此按需补齐（与屏幕「详细预算」同一个 buildWaterfallSegments，且只走一次 IPC）；
  // 随后补 summary，两种文件共吃同一份模型：Excel 走 exceljs，PDF 走隐藏窗 + printToPDF。
  ipcMain.handle('report:exportReport', async (e, payload) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const model = (payload && payload.model) || {}
    // 两种模型走同一个通道：kind:'sla' 是独立的《服务等级指标（SLA）》报告——不出 PDF、
    // 不补瀑布段、不走 enrichReportModel（那几步都是链路预算报告才要的）。
    const isSla = model.kind === 'sla'
    // kind:'cap' 是独立的《容量汇总》报告——口径同 SLA 版：只出 Excel / Word，模型在渲染端已排好（src/shared/lbCapReport.js）
    const isCap = model.kind === 'cap'
    // kind:'ssa' 是《空间态势报告》——同样是独立报告：只出 Word，模型在渲染端就已算全
    // （见 src/shared/ssaReport.js），这里一个数都不补。
    const isSsa = model.kind === 'ssa'
    const ORDER = ['xlsx', 'docx', 'pdf']
    const formats = ORDER.filter((f) => ((payload && payload.formats) || ['xlsx']).indexOf(f) > -1)
    if (!formats.length) return { ok: false, error: '未选择任何输出格式' }
    if (isSla && formats.indexOf('pdf') > -1) return { ok: false, error: 'SLA 报告不出 PDF' }
    if (isSla && !model.hasSla) return { ok: false, error: '没有任何链路勾选了 SLA 条款' }
    if (isCap && formats.indexOf('pdf') > -1) return { ok: false, error: '容量报告不出 PDF' }
    if (isCap && !model.hasCap) return { ok: false, error: '没有列入容量汇总的链路' }
    if (isSsa && (formats.length !== 1 || formats[0] !== 'docx')) return { ok: false, error: '空间态势报告只出 Word' }
    const EXT = { xlsx: { name: 'Excel 工作簿', extensions: ['xlsx'] }, docx: { name: 'Word 文档', extensions: ['docx'] }, pdf: { name: 'PDF 文档', extensions: ['pdf'] } }
    // 报告语言 = 平台语言（model.lang）；对话框跟它走，模型没带再读发起窗口
    const dlgLang = await senderLang(e, model.lang)
    const dlgEn = dlgLang === 'en'
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: dt(isSsa ? '保存空间态势报告' : isSla ? '保存 SLA 报告' : isCap ? '保存容量报告' : '保存报告', dlgLang) + (formats.length > 1
        ? (dlgEn ? ' (also writes ' + formats.map((f) => '.' + f).join(' / ') + ' with the same name)' : '（同名生成 ' + formats.map((f) => '.' + f).join(' / ') + '）')
        : ''),
      defaultPath: safeSaveName(payload && payload.defaultName, dt(isSsa ? '空间态势报告' : isSla ? '服务等级指标' : isCap ? '容量汇总' : '链路预算报告', dlgLang)) + '.' + formats[0],
      filters: dtFilters(formats.map((f) => EXT[f]), dlgLang)
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    const stem = filePath.replace(/\.(xlsx|docx|pdf)$/i, '')
    // 覆盖核对（交互调研 D5）：保存框只替它确认过的那一个文件问过覆盖，同 stem 的另几种格式它问不到 ——
    // 已存在的先列出来问一次（报告语言 = 平台语言），取消则一个都不写
    const clash = exportedPaths.pendingOverwrites(formats.map((f) => stem + '.' + f), filePath)
    if (clash.length && !(await exportedPaths.confirmOverwrites(dialog, win, clash, model.lang === 'en' ? 'en' : 'zh'))) return { ok: false, canceled: true }
    try {
      const lang = model.lang === 'en' ? 'en' : 'zh'
      const orbitType = (model.scheme && model.scheme.orbitType) || 'GEO'
      if (isSsa) {
        const buf = await require('../services/reportSsaDocx').buildSsaDocx(model)
        fs.writeFileSync(stem + '.docx', Buffer.from(buf))
        return receipt({ ok: true, files: [stem + '.docx'], filePath: stem + '.docx' }, [stem + '.docx'])
      }
      if (isSla) {
        const files = []
        if (formats.indexOf('xlsx') > -1) {
          const buf = await require('../services/reportSla').buildSlaWorkbook(model)
          fs.writeFileSync(stem + '.xlsx', Buffer.from(buf))
          files.push(stem + '.xlsx')
        }
        if (formats.indexOf('docx') > -1) {
          const buf = await require('../services/reportSlaDocx').buildSlaDocx(model)
          fs.writeFileSync(stem + '.docx', Buffer.from(buf))
          files.push(stem + '.docx')
        }
        return receipt({ ok: true, files, filePath: files[0] }, files)
      }
      if (isCap) {
        const files = []
        if (formats.indexOf('xlsx') > -1) {
          const buf = await require('../services/reportCap').buildCapWorkbook(model)
          fs.writeFileSync(stem + '.xlsx', Buffer.from(buf))
          files.push(stem + '.xlsx')
        }
        if (formats.indexOf('docx') > -1) {
          const buf = await require('../services/reportCapDocx').buildCapDocx(model)
          fs.writeFileSync(stem + '.docx', Buffer.from(buf))
          files.push(stem + '.docx')
        }
        return receipt({ ok: true, files, filePath: files[0] }, files)
      }
      for (const l of (model.links || [])) {
        if (l && l.data && !(l.segments && l.segments.length)) {
          // adaptUnits＝导出那一刻屏幕上的「单位」档（出厂锁定），详表与屏幕上的详细预算同档
          try { l.segments = core().buildWaterfallSegments({ results: l.data, lang, orbitType, adaptUnits: model.adaptUnits === true, txLocation: String(l.txName || ''), rxLocation: String(l.rxName || '') }) }
          catch (err) { l.segments = [] }
        }
      }
      report.enrichReportModel(model)
      const files = []
      if (formats.indexOf('xlsx') > -1) {
        const buf = await report.buildReportWorkbook(model)
        fs.writeFileSync(stem + '.xlsx', Buffer.from(buf))
        files.push(stem + '.xlsx')
      }
      if (formats.indexOf('docx') > -1) {
        const buf = await require('../services/reportDocx').buildReportDocx(model)
        fs.writeFileSync(stem + '.docx', Buffer.from(buf))
        files.push(stem + '.docx')
      }
      if (formats.indexOf('pdf') > -1) {
        const buf = await require('../services/reportPdf').buildReportPdf(model)
        fs.writeFileSync(stem + '.pdf', Buffer.from(buf))
        files.push(stem + '.pdf')
      }
      return receipt({ ok: true, files, filePath: files[0] }, files)
    } catch (err) {
      const busy = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')
      return { ok: false, error: busy ? '文件可能正被其他程序打开（如 Excel / PDF 阅读器）' : (err.message || String(err)) }
    }
  })
  // ---- 应用版本（帮助 → 关于 对话框显示）----
  ipcMain.handle('app:version', () => require('electron').app.getVersion())

  // ---- 自动更新（帮助 → 检查更新）：state 读快照；check 立即检查并等到检查结束；install 立即重启安装。
  //      三条都在 UNGATED 里：更新入口不能锁在激活之后 ----
  if (updater) {
    ipcMain.handle('updater:state', () => updater.getState())
    ipcMain.handle('updater:check', () => updater.checkNow())
    ipcMain.handle('updater:install', () => updater.installNow())
  }

  // ---- 设备 ID（按本机 MAC 派生的稳定短码，作为「用户 ID」用于配置分享与激活管理）----
  // 实现收敛到 activation 服务（心跳/激活书都用同一份 ID，含管理员身份映射表 ADMIN_IDS）。
  ipcMain.handle('app:deviceId', () => (activation ? activation.deviceId() : ''))

  // ---- 激活状态（终端设备侧）：status 纯本地读缓存验签；refresh 为用户「特定动作」触发的
  //      立即心跳（上报最后在线 + 拉最新激活书），状态变化经 activation:changed 广播各窗口 ----
  if (activation) {
    ipcMain.handle('activation:status', () => activation.current())
    ipcMain.handle('activation:refresh', async () => {
      try { return await activation.refreshNow() } catch (e) { return activation.current() }
    })
  }

  // ---- 配置文件导入（线下分享：选 .lbcfg/.json 读回文本）----
  ipcMain.handle('linkbudget:openConfig', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: dtFilters([{ name: '链路预算配置', extensions: ['lbcfg', 'json'] }], await senderLang(e))
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
    // 发送到小程序：上传当前绘制状态快照到 COS gxt/<key>.json，返回 { ok, key }
    ipcMain.handle('share:gxtSnapshot', async (_e, payload) => {
      try { return await share.putSnapshot(payload) } catch (err) { return { ok: false, error: err.message || String(err) } }
    })
    // 绑定投递：往小程序端的 12 位认证码信箱直投（见 share.js「绑定投递」段）
    ipcMain.handle('share:boxSend', async (_e, ch, o) => {
      try { return await share.boxSend(ch, o) } catch (err) { return { ok: false, error: err.message || String(err) } }
    })
    ipcMain.handle('share:boxPeek', async (_e, ch, pid) => {
      try { return await share.boxPeek(ch, pid) } catch (err) { return { ok: false, error: err.message || String(err) } }
    })
    ipcMain.handle('share:boxRevoke', async (_e, ch, pid, mid) => {
      try { return await share.boxRevoke(ch, pid, mid) } catch (err) { return { ok: false, error: err.message || String(err) } }
    })
  }
}

module.exports = { register }
