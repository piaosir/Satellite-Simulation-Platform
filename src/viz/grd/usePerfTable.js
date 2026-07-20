// 性能指标表（SATSOFT Performance Table）：独立站点库 + 逐站取值 + 选项（列/过滤/口径/指向误差）。
// 站点库与地图标记解耦（可一键导入标记）；每个天线一张表，且每张表的选项独立保存（optsByAnt）。
// 取值内核见 src/viz/grd/coverage.js：sampleBeamAt（反向采样方向图）、tiltBasis（指向误差扫描）。
import { ref, computed } from 'vue'
import { sampleBeamAt, perturbSpacecraft, dirToAzEl, groundLookAngles, axialRatioDb } from './coverage.js'

let _seq = 1
const newId = () => 'st' + Date.now().toString(36) + (_seq++)
// 中文输入法在全角标点模式下会把「-」输成全角减号「－」(U+FF0D)、句点输成「．」，而数字仍是半角——
// Number() 只认半角，Number('－75')=NaN 会让负数经纬度（西经/南纬）被静默吞掉（症状：正数能填、负数不识别）。
// 故解析前先把全角数字/减号/句点等常见变体归一到半角。
const toHalf = (s) => String(s)
  .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))   // 全角数字 ０-９ → 0-9
  .replace(/[－−–—―﹣]/g, '-')                             // 全角/数学/破折 减号 → -
  .replace(/＋/g, '+')                                                             // 全角 ＋ → +
  .replace(/[．。]/g, '.')                                                     // 全角句点 ．/ 中文句号 。 → .
// 空串/空白必须判 null：Number('')===0，否则 Excel 复制块里的空单元格会把经纬度悄悄写成 0
const num = (v) => { if (v == null) return null; const s = toHalf(v).trim(); if (s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null }

// 全列定义（顺序即列序）。num=右对齐数字列，fix=小数位。默认显示集见 defaultOpts。
const COL_DEFS = [
  { key: 'no', label: 'No.', w: 44, num: true },
  { key: 'satNo', label: 'Sat No', w: 52, num: true },
  { key: 'satName', label: 'Satellite', w: 96 },
  { key: 'antNo', label: 'Ant No', w: 52, num: true },
  { key: 'antName', label: 'Antenna', w: 110 },
  { key: 'beamNo', label: '波束号', w: 56, num: true },
  { key: 'stationNo', label: '站号', w: 48, num: true },
  { key: 'country', label: '国家', w: 76 },
  { key: 'city', label: '城市', w: 88 },
  { key: 'desig', label: '代号', w: 72 },
  { key: 'lon', label: '经度', w: 128, num: true, fix: 2, unit: '°E', tip: '东经为正，负值表示西经' },
  { key: 'lat', label: '纬度', w: 128, num: true, fix: 2, unit: '°N', tip: '北纬为正，负值表示南纬' },
  { key: 'scAz', label: 'S/C Az', w: 64, num: true, fix: 2, unit: '°', tip: '卫星（航天器）天线系下、指向该地面点的方位角（boresight=星下点为 0）' },
  { key: 'scEl', label: 'S/C El', w: 64, num: true, fix: 2, unit: '°', tip: '卫星（航天器）天线系下、指向该地面点的俯仰角（boresight=星下点为 0）' },
  { key: 'gsAz', label: 'G/S Az', w: 64, num: true, fix: 2, unit: '°', tip: '地球站看卫星的方位角（自正北顺时针 0–360°）' },
  { key: 'gsEl', label: 'G/S El', w: 64, num: true, fix: 2, unit: '°', tip: '地球站看卫星的仰角（当地水平面以上；<0 表示卫星在地平线下不可见）' },
  { key: 'u', label: 'u', w: 62, num: true, fix: 4 },                    // 方向余弦，无量纲
  { key: 'v', label: 'v', w: 62, num: true, fix: 4 },                    // 方向余弦，无量纲
  // dir/xpol/slope/ar 的单位从 label 内联改为 unit 字段（单一来源，供表头/复制/选项弹窗统一渲染）
  { key: 'dir', label: 'Dir', w: 74, num: true, fix: 2, unit: 'dB' },
  { key: 'param', label: 'Parameter', w: 84, num: true, fix: 2, unit: 'dB' },   // 单位随口径动态（dB/功率/电压），见组件 perfColUnit
  { key: 'minPt', label: 'Min Pointing', w: 92, num: true, fix: 2, unit: 'dB' },
  { key: 'maxPt', label: 'Max Pointing', w: 92, num: true, fix: 2, unit: 'dB' },
  { key: 'xpol', label: 'Xpol C/I', w: 92, num: true, fix: 2, unit: 'dB' },
  { key: 'slope', label: 'Slope', w: 86, num: true, fix: 2, unit: 'dB/°' },
  { key: 'ar', label: 'AR', w: 70, num: true, fix: 2, unit: 'dB' }   // 由复场相位算；预置烘焙天线无相位 → 显示 —
]

// 列分组（仅供选项弹窗排版）
const COL_GROUPS = [
  { title: '标识', keys: ['satNo', 'satName', 'antNo', 'antName', 'beamNo', 'stationNo'] },
  { title: '站点', keys: ['country', 'city', 'desig', 'lon', 'lat'] },
  { title: '几何', keys: ['scAz', 'scEl', 'gsAz', 'gsEl', 'u', 'v'] },
  { title: '性能', keys: ['dir', 'param', 'minPt', 'maxPt', 'xpol', 'slope', 'ar'] }
]

function defaultOpts() {
  const cols = {}
  for (const c of COL_DEFS) cols[c.key] = false
  // 默认列对标 SATSOFT 只读性能表：No / Beam No / City / Desig / Lon / Lat / Dir / Parameter / Min·Max Pointing
  for (const k of ['no', 'beamNo', 'city', 'desig', 'lon', 'lat', 'gsAz', 'gsEl', 'dir', 'param', 'minPt', 'maxPt']) cols[k] = true
  return {
    cols,
    // 覆盖过滤默认开：结果表只列「覆盖该城市的波束」（方向性≥阈值）。城市仍完整保留在上方输入区，
    // 故一个经纬度不再因多波束而膨胀成大量行——单波束→1 行，重叠区→数行（对标 SATSOFT）。
    filterOn: true, minDir: 50,                  // 过滤：低于最低方向性的记录不显示
    sameAsAnt: true, pol: 'RSS', unit: 'dB', pathLoss: 'none', gainOffset: 0,   // 参数计算口径
    pointAz: 0, pointEl: 0, pointYaw: 0,          // 指向误差：方位/俯仰/偏航各自半幅(°)，完全自定 → Min/Max Pointing（误差区恒按椭圆算）
    beamSel: null                                 // 波束筛选：null=全部波束（默认，等同不筛选）；否则=选中的 bi 数组，仅这些波束进表
  }
}

export function usePerfTable() {
  const stations = ref([])     // 共享站点库 [{ id, country, city, desig, lon, lat }]
  const rows = ref([])         // 当前天线的计算结果（compute 填充）
  const ctxInfo = ref(null)    // { satName, antName, beams }
  const ctxBeams = ref([])     // 当前天线全部波束 [{ bi, name, peakDb }]（compute 填充）——供选项面板「波束筛选」列表
  const beamQuery = ref('')    // 波束筛选搜索词（瞬态，不存盘；开表/切表时清空）
  const query = ref('')        // 表内查询（国家/城市/代号）
  const optsByAnt = ref({})    // 天线 key → 选项（独立保存）
  const hidden = ref({})       // 已手动隐藏的行 id（站#波束）→ true；行为派生数据，仅内存态不存盘
  const cityGroups = ref([])   // 城市组（命名预设列表）：[{ id, name, cities:[{country,city,desig,lon,lat}] }]；全表共享、随页面快照存盘

  // 「记住上次选择」模板：新天线首次打开表时，用它初始化选项（列/过滤/口径/指向误差），而不是每次回到固定默认——减少逐天线重设。
  // beamSel（波束筛选）不入模板：波束因天线而异，继承会张冠李戴，新表恒为「全部波束」。随页面快照持久化。
  let optsTemplate = null
  function cloneOpts(o) { return JSON.parse(JSON.stringify(o)) }
  function newOptsFromTemplate() {
    const base = defaultOpts()
    if (!optsTemplate) return base
    return { ...base, ...cloneOpts(optsTemplate), cols: { ...base.cols, ...(optsTemplate.cols || {}) }, beamSel: null }
  }
  function getOpts(key) {
    if (!key) return defaultOpts()
    if (!optsByAnt.value[key]) optsByAnt.value[key] = newOptsFromTemplate()
    return optsByAnt.value[key]
  }
  // 把某天线当前选项记成模板（供下一个新天线继承）。beamSel 剔除。页面在选项变化时调用。
  function rememberOpts(key) {
    const o = key && optsByAnt.value[key]; if (!o) return
    optsTemplate = cloneOpts({ ...o, beamSel: null })
  }
  // 逃生口：把某天线选项重置为出厂默认（选项弹窗「恢复默认」按钮）。
  function resetOpts(key) {
    if (!key) return
    optsByAnt.value = { ...optsByAnt.value, [key]: defaultOpts() }
  }
  const visibleColumns = (o) => COL_DEFS.filter((c) => o && o.cols && o.cols[c.key])

  // ===== 站点库 CRUD =====
  // 经纬度写入：合法数字→写入；空串→清空(null，该行暂不参与取值)；非数字文本→保留原值（坐标列不存文本）
  function setCoord(s, key, val) {
    const v = num(val)
    if (v != null) s[key] = v
    else if (String(val == null ? '' : val).trim() === '') s[key] = null
  }
  // Excel/链路预算式「增加行」：在 at 处插入一行空站（经纬度留空，填好后才参与取值）。返回新站。
  function addEmptyStation(at) {
    const s = { id: newId(), country: '', city: '', desig: '', lon: null, lat: null }
    const list = [...stations.value]
    const i = (at == null || at < 0 || at > list.length) ? list.length : at
    list.splice(i, 0, s)
    stations.value = list
    return s
  }
  function updateStation(id, patch) {
    const s = stations.value.find((x) => x.id === id); if (!s) return
    if ('lon' in patch) setCoord(s, 'lon', patch.lon)
    if ('lat' in patch) setCoord(s, 'lat', patch.lat)
    for (const k of ['country', 'city', 'desig']) if (k in patch) s[k] = String(patch[k] == null ? '' : patch[k])
    stations.value = [...stations.value]
  }
  function removeStation(id) { stations.value = stations.value.filter((x) => x.id !== id) }

  // ===== 城市名 → 经纬度自动补全（与 GEO 链路预算 StationGrid.applyCityByName 同口径）=====
  // 城市库（约 360 座国内城市）由页面在打开性能表时经 IPC 载入并 setCities 注入；键=城市名（去空白、小写）。
  const cityGeo = new Map()   // 归一名 → { lon, lat }；非响应式，仅供查表
  function setCities(list) {
    cityGeo.clear()
    for (const c of (list || [])) {
      if (!c || c.name == null) continue
      const lon = num(c.lon), lat = num(c.lat)
      if (lon == null || lat == null) continue
      cityGeo.set(String(c.name).trim().toLowerCase(), { lon, lat })
    }
  }
  // 命中即填：站点的城市名精确命中城市库 → 写入其经纬度（覆盖原值，与链路预算一致）。返回是否命中。
  // 仅供「单格编辑城市名」路径调用（见 onEdit）；粘贴/批量导入不触发，避免覆盖随行粘贴的经纬度。
  function applyCityGeo(id) {
    if (!cityGeo.size) return false
    const s = stations.value.find((x) => x.id === id); if (!s) return false
    const name = String(s.city == null ? '' : s.city).trim()
    if (!name) return false
    const hit = cityGeo.get(name.toLowerCase())
    if (!hit) return false
    s.lon = hit.lon; s.lat = hit.lat
    stations.value = [...stations.value]
    return true
  }
  // 城市库晚于用户输入到达时的一次性补扫：城市库（IPC 异步）载入前若已键入城市名，applyCityGeo 因表空而落空，
  // 之后重键同名又不触发（值未变）。故 setCities 后调此补扫，为「经纬度仍空」且城市名命中的行补填。返回补填行数。
  // 只填经纬度为空的行 → 幂等，且不覆盖随行粘贴/导入的经纬度（保持「粘贴不自动补全」不变式）。
  function applyCityGeoAll() {
    if (!cityGeo.size) return 0
    let n = 0
    for (const s of stations.value) {
      if (Number.isFinite(s.lon) && Number.isFinite(s.lat)) continue
      const name = String(s.city == null ? '' : s.city).trim(); if (!name) continue
      const hit = cityGeo.get(name.toLowerCase()); if (!hit) continue
      s.lon = hit.lon; s.lat = hit.lat; n++
    }
    if (n) stations.value = [...stations.value]
    return n
  }

  // ===== 撤销/重做（以站点库为唯一数据源，行是派生的；调用方在每次用户操作前 pushUndo 一次）=====
  const undoStack = [], redoStack = []
  const canUndo = ref(false), canRedo = ref(false)
  const _sync = () => { canUndo.value = undoStack.length > 0; canRedo.value = redoStack.length > 0 }
  const _snap = () => ({ stations: stations.value.map((s) => ({ ...s })), hidden: { ...hidden.value } })
  const _apply = (s) => { stations.value = s.stations.map((x) => ({ ...x })); hidden.value = { ...s.hidden } }
  function pushUndo() { undoStack.push(_snap()); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0; _sync() }
  function dropUndo() { undoStack.pop(); _sync() }   // 操作未实际改动 → 丢弃刚压入的快照（不动 redo）
  function undo() { if (!undoStack.length) return false; redoStack.push(_snap()); _apply(undoStack.pop()); _sync(); return true }
  function redo() { if (!redoStack.length) return false; undoStack.push(_snap()); _apply(redoStack.pop()); _sync(); return true }
  function clearHistory() { undoStack.length = 0; redoStack.length = 0; _sync() }

  // Excel/表格粘贴：每行一站，单元格按 制表符 > 逗号 > 空白 切分；约定【末两列=经度、纬度】，
  // 之前的文本列依次填 国家/城市/代号。末两列非数字的行（表头/无效）自动跳过。返回新增条数。
  function parsePasted(text) {
    const out = []
    for (const line of String(text || '').split(/\r?\n/)) {
      const t = line.trim(); if (!t) continue
      const c = (t.includes('\t') ? t.split('\t') : (t.includes(',') ? t.split(',') : t.split(/\s+/))).map((x) => x.trim())
      if (c.length < 2) continue
      const lon = num(c[c.length - 2]), lat = num(c[c.length - 1])
      if (lon == null || lat == null) continue
      const head = c.slice(0, c.length - 2)
      out.push({ country: head[0] || '', city: head[1] || '', desig: head[2] || '', lon, lat })
    }
    return out
  }
  function addStationsBulk(text) {
    const parsed = parsePasted(text); if (!parsed.length) return 0
    const add = parsed.map((p) => ({ id: newId(), country: p.country, city: p.city, desig: p.desig, lon: p.lon, lat: p.lat }))
    stations.value = [...stations.value, ...add]
    return add.length
  }

  // Excel 式「定位粘贴」：以选中单元格为左上锚点，粘贴块按列向右、按行向下填充，
  // 超出现有站点的行自动新建。startKey 决定起始列，列序固定见 EDIT_COLS。
  // 切列只认制表符（与 Excel 完全一致）——含逗号的单元格值（如 "Washington, DC"）不会被误拆；
  // CSV 逗号格式仍由「粘贴」按钮/追加导入（parsePasted）支持。
  const EDIT_COLS = ['country', 'city', 'desig', 'lon', 'lat']
  function parseGrid(text) {
    return String(text || '').split(/\r?\n/).filter((l) => l.trim() !== '')
      .map((l) => l.split('\t').map((x) => x.trim()))
  }
  function setStationCell(s, key, val) {
    if (key === 'lon' || key === 'lat') setCoord(s, key, val)
    else s[key] = String(val == null ? '' : val)
  }
  function pasteBlock(startId, startKey, text) {
    const grid = parseGrid(text); if (!grid.length) return 0
    const c0 = Math.max(0, EDIT_COLS.indexOf(startKey))
    const list = [...stations.value]
    let idx = startId ? list.findIndex((s) => s.id === startId) : list.length
    if (idx < 0) idx = list.length
    grid.forEach((cells, ri) => {
      let s = list[idx + ri]
      if (!s) { s = { id: newId(), country: '', city: '', desig: '', lon: null, lat: null }; list[idx + ri] = s }
      cells.forEach((val, ci) => { const key = EDIT_COLS[c0 + ci]; if (key) setStationCell(s, key, val) })
    })
    stations.value = list.filter(Boolean)
    return grid.length
  }
  function clearStations() { stations.value = []; hidden.value = {} }
  // 仅隐藏当前行（站×波束），不影响同站其他波束行；id 稳定 → recompute 后仍生效。
  function removeRow(id) { if (id != null) hidden.value = { ...hidden.value, [id]: true } }

  // ===== 城市组（把当前城市列表存成命名预设，随时载入/追加/覆盖，供不同天线的性能表复用）=====
  const gid = () => 'cg' + Date.now().toString(36) + (_seq++)
  const snapCities = () => stations.value.map((s) => ({ country: s.country || '', city: s.city || '', desig: s.desig || '', lon: s.lon, lat: s.lat }))
  const findGroup = (id) => cityGroups.value.find((x) => x.id === id) || null
  // 存当前城市列表为新组。空列表不存（返回 null）；名称去空白，空名给默认名。返回新组 id。
  function addCityGroup(name) {
    if (!stations.value.length) return null
    const nm = String(name == null ? '' : name).trim() || ('城市组 ' + (cityGroups.value.length + 1))
    const g = { id: gid(), name: nm, cities: snapCities() }
    cityGroups.value = [...cityGroups.value, g]
    return g.id
  }
  function renameCityGroup(id, name) {
    const nm = String(name == null ? '' : name).trim(); if (!nm) return false
    const g = findGroup(id); if (!g) return false
    g.name = nm; cityGroups.value = [...cityGroups.value]; return true
  }
  function overwriteCityGroup(id) {
    const g = findGroup(id); if (!g) return false
    g.cities = snapCities(); cityGroups.value = [...cityGroups.value]; return true
  }
  function removeCityGroup(id) { cityGroups.value = cityGroups.value.filter((x) => x.id !== id) }
  // 载入组 = 用该组城市替换当前列表（新建行 id）。调用方负责 pushUndo（一次 Ctrl+Z 可还原）。返回载入的城市数。
  function loadCityGroup(id) {
    const g = findGroup(id); if (!g) return 0
    stations.value = (g.cities || []).map((c) => ({ id: newId(), country: c.country || '', city: c.city || '', desig: c.desig || '', lon: num(c.lon), lat: num(c.lat) }))
    hidden.value = {}
    return stations.value.length
  }
  // 追加组到当前列表：有坐标的行按 ±1e-4 去重（与从标记导入同口径），无坐标的行（仅城市名）一律追加。调用方负责 pushUndo。返回新增数。
  function appendCityGroup(id) {
    const g = findGroup(id); if (!g) return 0
    const exists = (lon, lat) => stations.value.some((s) => Number.isFinite(s.lon) && Number.isFinite(s.lat) && Math.abs(s.lon - lon) < 1e-4 && Math.abs(s.lat - lat) < 1e-4)
    const add = []
    for (const c of (g.cities || [])) {
      const lon = num(c.lon), lat = num(c.lat)
      if (lon != null && lat != null && exists(lon, lat)) continue
      add.push({ id: newId(), country: c.country || '', city: c.city || '', desig: c.desig || '', lon, lat })
    }
    if (add.length) stations.value = [...stations.value, ...add]
    return add.length
  }

  // 从地图标记导入：地球站 name → 城市；点标记 → 仅经纬度。±1e-4 去重。返回新增条数。
  function importFromMarkers(points = [], mkStations = []) {
    const exists = (lon, lat) => stations.value.some((s) => Math.abs(s.lon - lon) < 1e-4 && Math.abs(s.lat - lat) < 1e-4)
    const add = []
    for (const p of mkStations) { const lon = num(p.lon), lat = num(p.lat); if (lon == null || lat == null || exists(lon, lat)) continue; add.push({ id: newId(), country: '', city: (p.name || '').trim() || '地球站', desig: '', lon, lat }) }
    for (const p of points) { const lon = num(p.lon), lat = num(p.lat); if (lon == null || lat == null || exists(lon, lat)) continue; add.push({ id: newId(), country: '', city: '', desig: '', lon, lat }) }
    if (add.length) stations.value = [...stations.value, ...add]
    return add.length
  }

  // 从地图航迹导入：每个航点 → 一座城市，城市名取「航迹名#序号」。±1e-4 去重（重复导入自动跳过）。返回新增条数。
  function importFromTrajectories(trajectories = []) {
    const exists = (lon, lat) => stations.value.some((s) => Math.abs(s.lon - lon) < 1e-4 && Math.abs(s.lat - lat) < 1e-4)
    const add = []
    for (const t of trajectories) {
      const nm = ((t && t.name) || '航迹').trim() || '航迹'
      const pts = (t && t.pts) || []
      pts.forEach((p, j) => {
        const lon = num(p.lon), lat = num(p.lat)
        if (lon == null || lat == null || exists(lon, lat)) return
        add.push({ id: newId(), country: '', city: nm + '#' + (j + 1), desig: '', lon, lat })
      })
    }
    if (add.length) stations.value = [...stations.value, ...add]
    return add.length
  }

  // ===== 逐站取值 =====
  // 指向误差 → 增益波动（物理最准：在误差区上【真实重采样方向图取极值】，非一阶线性化）。
  // 线性化(旧法)在峰值附近梯度→0 会误判 Min≈Max≈base，漏掉「偏指必掉增益」的二阶跌落，且强制对称；
  // 真实搜索：以名义姿态为中心，在【椭圆】误差区边界（半轴 Az×El，周上 N 点）× yaw 端点{−,0,+} 各采一次，
  //   加中心点（捕获峰值落在区内的情形）→ 取实采 dB 相对中心的最小/最大偏移 lo≤0≤hi。
  // 扰动经 perturbSpacecraft 施加于卫星刚体姿态；站点经纬度不动 → 斜距/增益偏置/路损在各采样间恒定，
  //   故 lo/hi 是纯方向图波动，与 rel/增益偏置等常数无关 → Min=baseDb+lo、Max=baseDb+hi（可不对称）。
  // 误差区固定为椭圆（TICRA 默认指向误差区），不再提供形状选项。
  const PT_N = 24       // 椭圆边界采样点数
  function pointMinMax(beam, igrid, basis, lon, lat, opts, baseDb, dAz, dEl, dYaw) {
    if (baseDb == null) return { min: null, max: null }
    if (!(dAz > 0) && !(dEl > 0) && !(dYaw > 0)) return { min: baseDb, max: baseDb }
    const at = (az, el, yaw) => {
      const b = (az || el || yaw) ? perturbSpacecraft(basis, az, el, yaw) : basis
      const r = sampleBeamAt(beam, igrid, b, lon, lat, opts)
      return r ? r.db : null
    }
    const center = at(0, 0, 0)
    if (center == null) return { min: baseDb, max: baseDb }
    let lo = 0, hi = 0
    const acc = (db) => { if (db == null) return; const d = db - center; if (d < lo) lo = d; if (d > hi) hi = d }
    const offs = []   // (Az,El) 椭圆边界偏移（半轴 dAz×dEl）
    for (let i = 0; i < PT_N; i++) { const t = (2 * Math.PI * i) / PT_N; offs.push([dAz * Math.cos(t), dEl * Math.sin(t)]) }
    const yaws = dYaw > 0 ? [0, dYaw, -dYaw] : [0]
    for (const [a, e] of offs) for (const y of yaws) acc(at(a, e, y))
    if (dYaw > 0) { acc(at(0, 0, dYaw)); acc(at(0, 0, -dYaw)) }   // 纯 yaw 端点（dAz=dEl=0 时的极值）
    return { min: baseDb + lo, max: baseDb + hi }
  }

  // 波束真峰值 dB（物理：真峰值在网格点之间，离散最大低估）。在所选极化的功率网格上找离散最大，
  // 再沿行/列各做抛物线顶点细化（可分离二次近似）后转 dB。按 beam×pol 记忆化（峰值与指向无关，
  // = 网格上场的最大值）。供「相对峰值」口径作扣减基准——同时修正旧 bm.peakDb 恒为 RSS 极化的不一致。
  function refinedPeakDb(beam, pol) {
    const k = '_pk_' + pol
    if (beam[k] !== undefined) return beam[k]
    const { P1, P2, grid } = beam, NX = grid.NX, NY = grid.NY, N = NX * NY
    const pw = (i) => { const a = P1[i], b = P2 ? P2[i] : 0
      return pol === 'P1' ? a : pol === 'P2' ? b : pol === 'RSS' ? a + b : pol === 'P1/P2' ? (b > 0 ? a / b : 0) : pol === 'P2/P1' ? (a > 0 ? b / a : 0) : a }
    let mi = 0, mv = -Infinity
    for (let i = 0; i < N; i++) { const v = pw(i); if (v > mv) { mv = v; mi = i } }
    if (!(mv > 0)) { beam[k] = null; return null }
    const r = (mi / NX) | 0, c = mi % NX
    const inc = (fm, f0, fp) => { const den = 2 * f0 - fm - fp; return den > 0 ? (fp - fm) * (fp - fm) / (8 * den) : 0 }   // 抛物线顶点相对 f0 的增量（concave 才有效）
    let peak = mv
    if (c > 0 && c < NX - 1) peak += inc(pw(mi - 1), mv, pw(mi + 1))
    if (r > 0 && r < NY - 1) peak += inc(pw(mi - NX), mv, pw(mi + NX))
    const db = peak > 0 ? 10 * Math.log10(peak) : null
    beam[k] = db
    return db
  }

  function compute(ctx, opts) {
    if (!ctx) { rows.value = []; ctxInfo.value = null; ctxBeams.value = []; return }
    const o = opts || defaultOpts()
    ctxBeams.value = ctx.beams.map((b) => ({ bi: b.bi, seq: b.seq || b.bi + 1, name: b.name, peakDb: b.peakDb }))   // 供选项面板波束筛选列表（含波束名/峰值）；seq=原始波束号（删除波束后不重排）
    const beamAllow = Array.isArray(o.beamSel) ? new Set(o.beamSel) : null                  // null=全部波束（默认，不筛选）；否则仅这些 bi 进表
    const st = ctx.settings, same = o.sameAsAnt, igrid = ctx.igrid, icomp = ctx.icomp, basis = ctx.basis, meta = ctx.meta
    const polD = same ? st.pol : o.pol
    const dirOpts = { pol: polD, gainOffset: 0, pathLoss: 'none' }                                        // 纯方向性
    const parOpts = { pol: polD, gainOffset: same ? st.gainOffset : o.gainOffset, pathLoss: same ? st.pathLoss : o.pathLoss }  // 参数口径
    const rel = same && st.ctype === 'rel'
    const want = (k) => o.cols[k]
    const wantPt = want('minPt') || want('maxPt'), wantGeo = want('scAz') || want('scEl'), wantGS = want('gsAz') || want('gsEl')
    // Parameter 单位换算（仅自定义口径时生效；Same as Antenna 恒为 dB）
    const unitOf = (db) => (same || o.unit === 'dB') ? db : (o.unit === 'power' ? Math.pow(10, db / 10) : Math.pow(10, db / 20))

    const out = []; let no = 1
    stations.value.forEach((s, si) => {
      if (!Number.isFinite(s.lon) || !Number.isFinite(s.lat)) return   // 空行/经纬度未填全：不参与取值（行号 stationNo 仍按输入区行计）
      const geo = wantGeo ? dirToAzEl(meta.satLon, meta.satLat || 0, meta.satAlt, s.lon, s.lat) : null
      const gls = wantGS ? groundLookAngles(meta.satLon, meta.satLat || 0, meta.satAlt, s.lon, s.lat) : null   // 地球站看卫星的方位/仰角
      for (const bm of ctx.beams) {
        if (beamAllow && !beamAllow.has(bm.bi)) continue                                     // 波束筛选：未选中的波束不进表
        const d = sampleBeamAt(bm.beam, igrid, basis, s.lon, s.lat, want('ar') ? { ...dirOpts, wantComp: true } : dirOpts)
        const dir = d ? d.db : null
        if (o.filterOn && (dir == null || dir < o.minDir)) continue                                       // 最低方向性过滤
        const p = (want('param') || wantPt) ? sampleBeamAt(bm.beam, igrid, basis, s.lon, s.lat, parOpts) : null
        let param = p ? p.db : null
        if (param != null && rel) { const pk = refinedPeakDb(bm.beam, polD); if (pk != null) param -= pk }
        // Min/Max Pointing = 一阶梯度法，以 param 为中心对称展开（ΔG 是差分、与 rel/增益偏置等常数无关）。
        // 输入按【全幅误差】解释：实际半幅 = 输入/2（与 SATSOFT 一致，输入 0.06 → 用 ±0.03）。
        const pt = wantPt ? pointMinMax(bm.beam, igrid, basis, s.lon, s.lat, parOpts, param, o.pointAz / 2, o.pointEl / 2, o.pointYaw / 2) : { min: null, max: null }
        // Xpol C/I = 共极化/交叉极化 功率比（dB）
        let xpol = null
        if (want('xpol')) { const a = sampleBeamAt(bm.beam, igrid, basis, s.lon, s.lat, { pol: 'P1', gainOffset: 0, pathLoss: 'none' }); const b = sampleBeamAt(bm.beam, igrid, basis, s.lon, s.lat, { pol: 'P2', gainOffset: 0, pathLoss: 'none' }); xpol = (a && b) ? a.db - b.db : null }
        // Slope = 方向性对指向角的梯度幅值（中心差分，δ=0.1°）
        let slope = null
        if (want('slope') && dir != null) { const dd = 0.1; const ga = sampleBeamAt(bm.beam, igrid, perturbSpacecraft(basis, dd, 0, 0), s.lon, s.lat, dirOpts); const ge = sampleBeamAt(bm.beam, igrid, perturbSpacecraft(basis, 0, dd, 0), s.lon, s.lat, dirOpts); if (ga && ge) slope = Math.hypot(ga.db - dir, ge.db - dir) / dd }
        // AR 轴比：由复场相位算（预置烘焙天线无 comp → null）
        const ar = (want('ar') && d && d.comp) ? axialRatioDb(d.comp, icomp) : null
        out.push({
          id: s.id + '#' + bm.bi, no: no++,
          satNo: ctx.satNo, satName: ctx.satName, antNo: ctx.antNo, antName: ctx.antName,
          beamNo: bm.seq || bm.bi + 1, stationNo: si + 1,   // 波束号=原始 GRD 序号（删除波束后不重排）
          country: s.country, city: s.city, desig: s.desig, lon: s.lon, lat: s.lat,
          scAz: geo ? geo.az : null, scEl: geo ? geo.el : null,
          gsAz: gls ? gls.az : null, gsEl: gls ? gls.el : null, u: d ? d.u : null, v: d ? d.v : null,
          dir, param: param == null ? null : unitOf(param), minPt: pt.min, maxPt: pt.max, xpol, slope, ar,
          inPattern: d != null
        })
      }
    })
    rows.value = out
    ctxInfo.value = { satName: ctx.satName, antName: ctx.antName, beams: ctx.beams.length }
  }

  // 表内查询：国家/城市/代号 模糊（大小写不敏感）；空查询=全部。
  const filteredRows = computed(() => {
    const h = hidden.value
    const base = rows.value.filter((r) => !h[r.id])
    const q = query.value.trim().toLowerCase()
    if (!q) return base
    return base.filter((r) => [r.country, r.city, r.desig].some((v) => String(v || '').toLowerCase().includes(q)))
  })

  // ===== 持久化（站点库 + 各天线选项随页面快照存盘；表为派生数据不存）=====
  function getState() {
    return {
      stations: stations.value.map((s) => ({ country: s.country, city: s.city, desig: s.desig, lon: s.lon, lat: s.lat })),
      optsByAnt: JSON.parse(JSON.stringify(optsByAnt.value)),
      optsTemplate: optsTemplate ? cloneOpts(optsTemplate) : null,
      cityGroups: cityGroups.value.map((g) => ({ name: g.name, cities: (g.cities || []).map((c) => ({ country: c.country, city: c.city, desig: c.desig, lon: c.lon, lat: c.lat })) }))
    }
  }
  function restoreState(st) {
    if (!st) return
    clearHistory()
    if (Array.isArray(st.stations)) stations.value = st.stations.map((s) => ({ id: newId(), country: s.country || '', city: s.city || '', desig: s.desig || '', lon: num(s.lon), lat: num(s.lat) }))
    if (st.optsByAnt && typeof st.optsByAnt === 'object') {
      const m = {}
      for (const k of Object.keys(st.optsByAnt)) m[k] = { ...defaultOpts(), ...st.optsByAnt[k], cols: { ...defaultOpts().cols, ...(st.optsByAnt[k].cols || {}) } }
      optsByAnt.value = m
    }
    optsTemplate = (st.optsTemplate && typeof st.optsTemplate === 'object')
      ? { ...defaultOpts(), ...st.optsTemplate, cols: { ...defaultOpts().cols, ...(st.optsTemplate.cols || {}) }, beamSel: null }
      : null
    cityGroups.value = Array.isArray(st.cityGroups)
      ? st.cityGroups.filter((g) => g && Array.isArray(g.cities)).map((g) => ({
          id: gid(), name: String(g.name || '城市组'),
          cities: g.cities.map((c) => ({ country: c.country || '', city: c.city || '', desig: c.desig || '', lon: num(c.lon), lat: num(c.lat) }))
        }))
      : []
  }

  // ===== 波束筛选（选项面板；默认 beamSel=null 即全部波束 = 不筛选，与旧行为一致）=====
  // 纯序号语法（"1-62"/"1,3,5"/"1-10,20-30"）→ 1-based 序号集合，否则 null（当作波束名文字搜索）
  function parseBeamSeq(q) {
    const set = new Set()
    for (const part of q.split(/[,，\s]+/)) {
      if (!part) continue
      const m = part.match(/^(\d+)\s*[-~]\s*(\d+)$/)
      if (m) { const a = +m[1], b = +m[2]; for (let i = Math.min(a, b); i <= Math.max(a, b); i++) set.add(i) }
      else if (/^\d+$/.test(part)) set.add(+part)
      else return null
    }
    return set.size ? set : null
  }
  // 按搜索词过滤波束：序号语法按 1-based 序号(bi+1)，否则按波束名（大小写不敏感）。空词=全部。
  function filteredBeams() {
    const all = ctxBeams.value
    const q = beamQuery.value.trim()
    if (!q) return all
    const seq = parseBeamSeq(q)
    if (seq) return all.filter((b) => seq.has(b.seq || b.bi + 1))   // 序号语法按原始波束号（与覆盖面板同口径）
    const ql = q.toLowerCase()
    return all.filter((b) => String(b.name).toLowerCase().includes(ql))
  }
  const allBi = () => ctxBeams.value.map((b) => b.bi)
  const beamOn = (o, bi) => !o || o.beamSel == null || o.beamSel.includes(bi)   // beamSel=null 视为全选
  const beamSelCount = (o) => (!o || o.beamSel == null) ? ctxBeams.value.length : o.beamSel.length
  // Excel「(全选)」三态：作用于当前筛选结果——全部已选 / 部分(半选) / 全未选
  const filteredAllOn = (o) => { const f = filteredBeams(); return f.length > 0 && f.every((b) => beamOn(o, b.bi)) }
  const filteredAnyOn = (o) => filteredBeams().some((b) => beamOn(o, b.bi))
  // 规整：选中集 == 全集 → 回退 null（默认/不筛选，存盘更干净）；否则升序数组
  function normSel(arr) {
    const all = allBi(); const s = new Set(arr)
    if (all.length && all.every((i) => s.has(i))) return null
    return [...s].sort((a, b) => a - b)
  }
  const materialize = (o) => (o.beamSel == null ? allBi() : o.beamSel.slice())   // 从 null(全集) 起做增删
  function toggleBeam(o, bi) {
    if (!o) return
    const s = new Set(materialize(o)); s.has(bi) ? s.delete(bi) : s.add(bi)
    o.beamSel = normSel([...s])
  }
  function selectFiltered(o, on) {   // 「(全选)/(全选搜索结果)」：对当前筛选结果批量增删
    if (!o) return
    const ids = filteredBeams().map((b) => b.bi), s = new Set(materialize(o))
    if (on) ids.forEach((i) => s.add(i)); else ids.forEach((i) => s.delete(i))
    o.beamSel = normSel([...s])
  }

  return {
    stations, rows, filteredRows, ctxInfo, query, optsByAnt, canUndo, canRedo,
    colDefs: COL_DEFS, colGroups: COL_GROUPS, getOpts, visibleColumns, rememberOpts, resetOpts,
    addEmptyStation, updateStation, removeStation, removeRow, clearStations, addStationsBulk, pasteBlock, importFromMarkers, importFromTrajectories,
    setCities, applyCityGeo, applyCityGeoAll,
    cityGroups, addCityGroup, renameCityGroup, overwriteCityGroup, removeCityGroup, loadCityGroup, appendCityGroup,
    ctxBeams, beamQuery, filteredBeams, beamOn, beamSelCount, filteredAllOn, filteredAnyOn, toggleBeam, selectFiltered,
    pushUndo, dropUndo, undo, redo, compute, getState, restoreState
  }
}
