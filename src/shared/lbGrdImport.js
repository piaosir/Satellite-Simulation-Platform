// 链路预算模块自有的 GRD 方向图库（localStorage 'lb/grdSats'）。
//
// 为什么另起一个键，而不是写进「星座3D」页那棵树（globe3d/settings.grd）：
//   那个键由 3D 页整体快照式保存（saveSettings 直接 setItem(JSON.stringify(snapshot()))），
//   外部窗口写进去的天线，会在用户回主窗口转一圈后被整体覆盖掉——静默丢数据。
//   故本模块自持一份，grdParam.loadSatTree 读取时把两边【合并】：3D 页导入的和本模块导入的都能选。
//
// 归属：一份方向图挂在某个【卫星库条目】名下（folder = 'lb:' + 条目 id），与「一个卫星配置 = 一颗星」
// 的口径一致——从哪个卫星条目里导入的，就是那颗星的天线，不再另起一颗星。
//
// 存的是什么：只存文件名与几何快照（与 3D 页导入天线的记录同构），原始 .grd 由主进程存在
// userData/coverage-grd-imported 下，采样时主进程按 file 读取。渲染端自始至终不碰原文。

const KEY = 'lb/grdSats'
const GEO_ALT = 35786
const api = typeof window !== 'undefined' ? window.api : null

export function localFolderFor(satConfigId) { return 'lb:' + String(satConfigId || '') }
export function isLocalFolder(folder) { return String(folder || '').startsWith('lb:') }

// —— 天线匹配键 = '<folder>|<天线名>' ——
// 键自带来源，故「从天线树选的那颗星」与「本条目导入的方向图」可以同时挂在各路天线上：
// 「导入方向图」是纯添加，不会作废树里已选的匹配（各面板的天线下拉按来源分 optgroup）。
// 按【第一个】'|' 切：天线名来自文件名，可能含 '|'；folder 不会。
export function antKeyOf(folder, name) { return String(folder || '') + '|' + String(name || '') }
export function folderOfKey(key) { const s = String(key || ''); const i = s.indexOf('|'); return i < 0 ? '' : s.slice(0, i) }
export function antNameOfKey(key) { const s = String(key || ''); const i = s.indexOf('|'); return i < 0 ? s : s.slice(i + 1) }

// 读本模块的天线库：{ sats: [{ folder, satName, lon, lat, altKm, antennas:[…] }] }
export function loadLocalGrdSats() {
  let raw = ''
  try { raw = localStorage.getItem(KEY) || '' } catch (e) { raw = '' }
  let st = null
  try { st = JSON.parse(raw || 'null') } catch (e) { st = null }
  const sats = (st && Array.isArray(st.sats) ? st.sats : []).filter((s) => s && s.folder)
  return { sats }
}

function saveLocalGrdSats(state) {
  try { localStorage.setItem(KEY, JSON.stringify({ sats: (state && state.sats) || [] })) } catch (e) { /* 配额/隐私模式：本次不落盘 */ }
}

// 供 grdParam.loadSatTree 合并：把本模块的节点整成与 3D 页同构的形状（antennas 已带 imported/file）。
export function localTreeNodes() {
  return loadLocalGrdSats().sats.map((s) => ({
    folder: s.folder,
    satName: s.satName || s.folder,
    lon: Number(s.lon) || 0,
    lat: Number(s.lat) || 0,
    altKm: Number(s.altKm) || GEO_ALT,
    local: true,                       // ← 标记：本模块导入，取星时不改轨道来源（见 NGSO 面板）
    antennas: (s.antennas || []).filter((a) => a && a.file).map((a) => ({
      name: a.name, file: a.file, beams: Number(a.beams) || 1, imported: true, local: true,
      satLon: Number(a.satLon), satLat: Number(a.satLat), satAlt: Number(a.satAlt)
    }))
  }))
}

/**
 * 天线下拉的可选项分组：「树选星那颗星的天线」与「本条目自己导入的天线」两组并列。
 * 三个链路预算窗口的卫星面板共用——各路天线各选各的，来源互不排斥。
 * @param keys 当前已匹配的天线键：来源若是第三个节点（复制条目带过来的、别的条目导入的），
 *             也把那个节点列进来，否则下拉里只剩一个「未导入」占位项，想改都改不回去。
 * @returns {Array<{folder:string, label:string, ants:Array<{key:string,name:string,beams:number}>}>}
 */
export function antennaGroups(satTree, treeFolder, localFolder, keys) {
  const out = []
  const find = (f) => (f ? (satTree || []).find((s) => s.folder === f) : null)
  const push = (node, label) => {
    if (!node || !(node.antennas || []).length) return
    if (out.some((g) => g.folder === node.folder)) return   // 存量数据里两个 folder 可能撞上，只列一次
    out.push({
      folder: node.folder, label,
      ants: node.antennas.map((a) => ({ key: antKeyOf(node.folder, a.name), name: a.name, beams: Number(a.beams) || 1 }))
    })
  }
  const t = find(treeFolder)
  push(t, t ? (t.satName || t.folder) : '')
  push(find(localFolder), '本条目导入')
  for (const k of (keys || [])) { const n = find(folderOfKey(k)); if (n) push(n, n.satName || n.folder) }
  return out
}

// 已匹配、但本机卫星树里没有那份 GRD（换机器 / 尚未导入）：下拉里补一个占位项，保住这次匹配
// 不被静默清空——库是全局资产，清掉的匹配无从找回；未命中期间取值端自然不回填。
export function staleAntOption(groups, key) {
  if (!key) return null
  if ((groups || []).some((g) => g.ants.some((a) => a.key === key))) return null
  return { key, name: antNameOfKey(key) || key }
}

function nodeOf(state, spec) {
  let n = state.sats.find((s) => s.folder === spec.folder)
  if (!n) { n = { folder: spec.folder, satName: spec.satName || spec.folder, lon: 0, lat: 0, altKm: GEO_ALT, antennas: [] }; state.sats.push(n) }
  // 星名/星位每次导入时与卫星条目对齐（条目改名/改轨位后，树里跟着变）
  if (spec.satName) n.satName = spec.satName
  if (Number.isFinite(Number(spec.lon))) n.lon = Number(spec.lon)
  if (Number.isFinite(Number(spec.lat))) n.lat = Number(spec.lat)
  if (Number.isFinite(Number(spec.altKm))) n.altKm = Number(spec.altKm)
  if (!Array.isArray(n.antennas)) n.antennas = []
  return n
}

// 让本模块的节点跟随卫星库条目：条目改名 / 改轨位后，树里那颗星的显示名与基底位置同步更新。
// 方向是单向的——条目是真值源，节点只是它的影子（故 loadSatTree 那边不会拿节点去回写条目）。
// 节点不存在（尚未导入过方向图）时什么都不做。
export function syncLocalNode(spec) {
  if (!spec || !spec.folder) return false
  const state = loadLocalGrdSats()
  const n = state.sats.find((s) => s.folder === spec.folder)
  if (!n) return false
  let changed = false
  const set = (k, v) => { if (v !== undefined && v !== null && v !== '' && n[k] !== v) { n[k] = v; changed = true } }
  set('satName', spec.satName)
  if (Number.isFinite(Number(spec.lon))) set('lon', Number(spec.lon))
  if (Number.isFinite(Number(spec.lat))) set('lat', Number(spec.lat))
  if (Number.isFinite(Number(spec.altKm))) set('altKm', Number(spec.altKm))
  if (changed) saveLocalGrdSats(state)
  return changed
}

/**
 * 打开文件框导入一到多个 GRD/PAT，挂到指定卫星条目名下。
 * 一个文件 = 一副天线；文件里的多个 set = 该天线的多个波束（SATSOFT 口径，取值时取多波束最大）。
 * @param {object} spec { folder, satName, lon, lat, altKm }
 * @returns {Promise<{canceled:boolean, added:Array<{name,file,beams}>, errors:string[]}>}
 */
export async function importGrdAntennas(spec) {
  const out = { canceled: false, added: [], errors: [] }
  if (!api || !api.coverageGrd || !api.coverageGrd.import) { out.errors.push('需在桌面客户端中运行'); return out }
  if (!spec || !spec.folder) { out.errors.push('未指定卫星条目'); return out }
  const res = await api.coverageGrd.import()
  if (!res || res.canceled) { out.canceled = true; return out }
  const files = res.files || []
  if (!files.length) { out.errors.push('未选择文件'); return out }

  const state = loadLocalGrdSats()
  const node = nodeOf(state, spec)
  for (const f of files) {
    if (!f || f.error || !f.file) { out.errors.push((f && f.base ? f.base : '文件') + '：' + ((f && f.error) || '拷贝失败')); continue }
    // 波束数由主进程解析（同时把 .grdbin 预编译出来，首次采样不用等）
    let beams = 1
    try {
      const m = await api.linkBudget.grdMeta(f.file)
      if (m && m.ok && m.beams > 0) beams = m.beams
      else { out.errors.push((f.base || f.file) + '：解析失败 ' + ((m && m.error) || '未知错误')); try { await api.coverageGrd.remove(f.file) } catch (e) { /* 清理失败无妨 */ } continue }
    } catch (e) {
      out.errors.push((f.base || f.file) + '：解析失败 ' + (e && e.message ? e.message : String(e)))
      try { await api.coverageGrd.remove(f.file) } catch (er) { /* 清理失败无妨 */ }
      continue
    }
    let name = String(f.base || f.file).replace(/\.(grd|pat)$/i, '')
    while (node.antennas.some((a) => a.name === name)) name += '·'   // 重名加后缀（与 3D 页同法）
    const ant = {
      name, file: f.file, beams, imported: true,
      satLon: node.lon, satLat: node.lat, satAlt: node.altKm
    }
    node.antennas.push(ant)
    out.added.push({ name, file: f.file, beams })
  }
  saveLocalGrdSats(state)
  return out
}

// 删除本模块导入的一副天线（连同盘上的原始 GRD）。3D 页导入的天线不归本模块管，直接返回 false。
export async function removeLocalAntenna(folder, name) {
  if (!isLocalFolder(folder)) return false
  const state = loadLocalGrdSats()
  const node = state.sats.find((s) => s.folder === folder)
  if (!node) return false
  const i = (node.antennas || []).findIndex((a) => a.name === name)
  if (i < 0) return false
  const [ant] = node.antennas.splice(i, 1)
  if (!node.antennas.length) state.sats = state.sats.filter((s) => s !== node)   // 空节点不留在树里
  saveLocalGrdSats(state)
  if (ant && ant.file && api && api.coverageGrd) { try { await api.coverageGrd.remove(ant.file) } catch (e) { /* 盘上没有就算了 */ } }
  return true
}
