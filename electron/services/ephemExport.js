// 星历导出引擎（主进程）：任意一批卫星（内置星座 / 卫星组 / 导入组 / 自定义星座 / 天线树 / 搜索结果 / 单星）→ 任一格式。
//
// 【导出项】渲染端把要导出的星解析成几种「项」交过来（星历正文不过 IPC，点序列只传引用）：
//   { t:'gp',    rec:{OMM 契约字段[+f]}, src, name, noradId }   平均根数星（编目 / 自定义库 / 自定义星座 / 天线树根数星）
//   { t:'ephem', groupId, key, name, noradId }                  导入的点序列星（表在主进程）
//   { t:'fix',   name, id, r:[x,y,z] }                          天线树里的定点星（地固系 km，恒定）
//   { t:'norad', noradId, name, src }                           只有编号（渲染端没拿到记录时）：在本机星历缓存里查
//
// 【两类格式】
//   平均根数（OMM CSV/JSON/KVN/XML、TLE/3LE）：只有 gp 项写得出；点序列与定点星没有平均根数，跳过并点名。
//     记录尽量用「带全部官方字段」的那条：渲染端给的是契约 13 字段，这里按来源到星历缓存 / 自定义库里找同号
//     同历元的原记录（ELEMENT_SET_NO / REV_AT_EPOCH 等契约外字段都在里面）；整组 CSV 且没剔星时直接吐缓存原文。
//     TLE/3LE 的编号栏只有 Alpha-5（≤ 339999），超出的星跳过（自定义星座的 900000 段写不进去）。
//   点序列（CCSDS OEM KVN/XML、STK .e、中国卫通 .eph）：
//     gp / 定点星在 [起, 止] 上按步长采样（末点补到终止时刻，与卫通 .eph 的体例一致）；
//     点序列星缺省导出原始采样点（时段内的原点，数值逐位等于导入时——存了原帧原值），也可等间隔重采样；
//     凡挂了叠加星历（「对应已有卫星」）的星，取位与平台完全同一口径（新导入的叠加表优先，其后本体），
//     源切换处补一对边界状态并拆段（OEM 分段 / STK SegmentBoundaryTimes / .eph 同刻两行），插值不跨缝。
//   单目标格式（STK .e、.eph）一星一个文件；OEM 可多星一个文件（每星若干段）或一星一个文件。
//
// 【逐字节还原】整组导出、同格式、原始采样、覆盖整个时段、原帧 → 直接写导入时留下的原文字节。
// 【大批量】逐星算、逐星写盘，每 ~30 ms 让一次事件循环（主进程不冻住），进度经回调上报，可中途取消。

'use strict'

const fs = require('fs')
const path = require('path')
const OMM = require('../../packages/core/utils/ommFormats.js')
const EF = require('../../packages/core/utils/ephemFormats.js')
const EI = require('../../packages/core/utils/ephemInterp.js')
const FR = require('../../packages/core/utils/frames.js')
const OP = require('../../packages/core/utils/orbitPos.js')
const TC = require('../../packages/core/utils/textCodec.js')
const NZ = require('../../packages/core/utils/ephemNormalize.js')

const MEAN_FORMATS = OMM.FORMATS
const POINT_FORMATS = EF.WRITABLE
const TLE_MAX_NORAD = 339999
const DEFAULT_INTERP = { method: 'lagrange', samples: 8 }
const MAX_POINTS = 5e6          // 单星采样点上限（20 年 @ 60 s 的量级），防手误把步长填成 0.001 s
const YIELD_MS = 30

const isMean = (f) => MEAN_FORMATS.includes(f)
const isPoint = (f) => POINT_FORMATS.includes(f)
const extOf = (f) => (isMean(f) ? '.' + OMM.FORMAT_EXT[f] : EF.FORMAT_EXT[f])
const singleObject = (f) => EF.SINGLE_OBJECT.includes(f)
const pad2 = (n) => String(n).padStart(2, '0')
const ymd = (ms) => { const d = new Date(ms); return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) }
// Windows 文件名不许的字符一律换成下划线；首尾空白与点去掉
const safeFile = (s) => String(s || 'satellite').replace(/[\\/:*?"<>|\x00-\x1F]+/g, '_').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 120) || 'satellite'
const tick = () => new Promise((r) => setImmediate(r))

module.exports = function createEphemExport({ customSats, omm, getCore }) {
  const sgp4 = () => { const c = getCore && getCore(); return c && c.sgp4 }

  /* ===================== 平均根数：记录补全 ===================== */
  // 同一次导出内缓存各组 CSV 的完整解析（Map<NORAD, 记录>）
  function makeRecordFinder() {
    const groups = new Map()
    const fromCsv = (key) => {
      if (groups.has(key)) return groups.get(key)
      let map = null
      try {
        const raw = omm.readCsvRaw(key)
        if (raw && raw.text) { map = new Map(); for (const r of OMM.parseEphemeris(raw.text, 'omm-csv').records) map.set(OP.normId(r.noradId), r) }
      } catch { map = null }
      groups.set(key, map)
      return map
    }
    let customMap = null
    const fromCustom = (id, gid) => {
      if (gid) { const m = customSats.gpRecordsByNorad([id], gid); return m.get(id) || null }
      if (!customMap) { customMap = new Map(); try { for (const g of customSats.list().groups) if (g.kind !== 'ephem') for (const r of (customSats.groupRecords(g.id) || [])) customMap.set(OP.normId(r.noradId), r) } catch { /* 读不出 */ } }
      return customMap.get(id) || null
    }
    const sameEpoch = (a, b) => {
      const x = Date.parse(/[zZ]$/.test(a) ? a : a + 'Z'), y = Date.parse(/[zZ]$/.test(b) ? b : b + 'Z')
      return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < 1
    }
    // rec：渲染端给的契约字段记录；src：'g:<组>' | 内置组 key | 'ci:<导入组 id>' | 'custom' | 'other' | 'cc…'
    return function find(rec, src) {
      const id = OP.normId(rec && rec.noradId)
      if (!id) return rec
      if (rec && rec.f && rec.f.NORAD_CAT_ID) return rec
      const s = String(src || '')
      let hit = null
      if (s.indexOf('ci:') === 0) hit = fromCustom(id, s.slice(3))
      else if (s === 'custom') hit = fromCustom(id, null)
      else if (s && !/^cc|^tree|^grd/.test(s)) {
        const key = s.indexOf('g:') === 0 ? s.slice(2) : (s === 'other' ? 'active' : s)
        const m = fromCsv(key)
        hit = m && m.get(id)
        if (!hit) { const a = fromCsv('active'); hit = a && a.get(id) }
      }
      // 只认同一份根数（历元一致）：别的组 / 别的时刻抓到的同号记录不是平台此刻用的那份
      if (hit && rec && rec.epoch && hit.epoch && !sameEpoch(hit.epoch, rec.epoch)) hit = null
      return hit || rec
    }
  }
  // 'norad' 项：本机星历缓存里按号查（命名组优先、active 兜底、自定义库最后覆盖）
  function makeNoradResolver() {
    let idx = null
    return function resolve(id, src) {
      const nid = OP.normId(id)
      if (!idx) {
        idx = new Map()
        let rows = []
        try { rows = omm.listCsv().filter((r) => !r.kind) } catch { rows = [] }
        for (const key of ['active'].concat(rows.map((r) => r.key).filter((k) => k !== 'active'))) {
          let raw = null
          try { raw = omm.readCsvRaw(key) } catch { raw = null }
          if (!raw || !raw.text) continue
          for (const r of OMM.parseEphemeris(raw.text, 'omm-csv').records) idx.set(OP.normId(r.noradId), r)
        }
        try { for (const g of customSats.list().groups) if (g.kind !== 'ephem') for (const r of (customSats.groupRecords(g.id) || [])) idx.set(OP.normId(r.noradId), r) } catch { /* 读不出 */ }
      }
      if (src && String(src).indexOf('ci:') === 0) { const m = customSats.gpRecordsByNorad([nid], String(src).slice(3)); if (m.get(nid)) return m.get(nid) }
      return idx.get(nid) || null
    }
  }

  /* ===================== 点序列：采样 ===================== */
  function gridTimes(fromMs, toMs, stepS, includeEnd) {
    const h = stepS * 1000
    const n = Math.floor((toMs - fromMs) / h + 1e-9) + 1
    if (!(n >= 1) || n > MAX_POINTS) throw new Error('采样点数 ' + n + ' 超出范围（检查时段与步长）')
    const out = new Array(n)
    for (let k = 0; k < n; k++) out[k] = Math.round(fromMs + k * h)
    if (includeEnd && out[n - 1] < toMs) out.push(Math.round(toMs))
    return out
  }
  // 取位源：叠加表（新导入的在前）→ 本体（SGP4 / 本体表）。与 orbitPos.positionAt 同一顺序。
  // 表源按【段】区分身份（表内的机动断点也是源切换）：源 = { tab, seg }，同一 (表, 段) 恒为同一个对象。
  function sourcer(base, overlays, baseTab) {
    const ov = overlays || []
    const keys = new Map()
    const segAt = (tab, ms) => {
      if (!tab.sg) return 0
      const q = Math.min(Math.max(ms, tab.t0), tab.t1)
      let i = EI.findIndex(tab, q)
      if (i + 1 < tab.n && q >= tab.t[i + 1]) i++
      return tab.sg[i]
    }
    const keyOf = (tab, seg) => {
      let m = keys.get(tab)
      if (!m) { m = new Map(); keys.set(tab, m) }
      let k = m.get(seg)
      if (!k) {
        const ia = tab.sg ? tab.sgA[seg] : 0, ib = tab.sg ? tab.sgB[seg] : tab.n - 1
        k = { tab, seg, ia, ib, t0: tab.t[ia], t1: tab.t[ib] }
        m.set(seg, k)
      }
      return k
    }
    // 段端点直接取存的那一点：插值器对「下一段首点」（与上一段末点只差 1 ms）会落回上一段的末点
    const pointAt = (tab, i) => ({ p: [tab.p[3 * i], tab.p[3 * i + 1], tab.p[3 * i + 2]], v: tab.v ? [tab.v[3 * i], tab.v[3 * i + 1], tab.v[3 * i + 2]] : null })
    const at = (ms) => {
      for (const tab of ov) if (EI.evalTable(tab, ms)) return keyOf(tab, segAt(tab, ms))
      if (baseTab) return EI.evalTable(baseTab, ms) ? keyOf(baseTab, segAt(baseTab, ms)) : base
      return base
    }
    const state = (src, ms) => {
      if (src && src.tab) {
        // 钳进该段：段界两侧取各自段的端点状态（端点取原点，不经插值）
        if (ms <= src.t0) { const q = pointAt(src.tab, src.ia); if (q.v) return q }
        if (ms >= src.t1) { const q = pointAt(src.tab, src.ib); if (q.v) return q }
        const r = EI.evalTable(src.tab, Math.min(Math.max(ms, src.t0), src.t1))
        return r ? { p: [r.x, r.y, r.z], v: [r.vx, r.vy, r.vz] } : null
      }
      return base.state(ms)
    }
    // 切换时刻：进入一段取它的起点（落在 (上一网格点, 本网格点]），离开一段取它的终点（落在 [上一网格点, 本网格点)）。
    // 端点恰好就在网格点上也要算：星历起止常是整分，网格也是整分——不算的话不补对侧源在这一刻的状态，
    // 导出文件在切换处空一个步长。同刻多出来的行由 normalizeRows 定为段界（后一状态顺延 1 ms）
    const edge = (a, b, t0, t1) => {
      const inEnter = (x) => Number.isFinite(x) && x > t0 && x <= t1
      const inLeave = (x) => Number.isFinite(x) && x >= t0 && x < t1
      if (b && b.tab && inEnter(b.t0)) return b.t0 - (a && a.tab === b.tab && b.t0 - a.t1 <= NZ.NUDGE_MS ? b.t0 - a.t1 : 0)
      if (a && a.tab && inLeave(a.t1)) return a.t1
      return NaN
    }
    return { at, state, edge }
  }
  // times 上逐点取位（TEME）；源切换处补一对边界状态，取不到位置的空档后新起一段
  function sampleComposite(times, S) {
    const rows = []
    let prevSrc = null, prevMs = null, prevOk = false, cutNext = false
    for (const ms of times) {
      const src = S.at(ms)
      const st = S.state(src, ms)
      if (prevOk && st && src !== prevSrc) {
        const e = S.edge(prevSrc, src, prevMs, ms)
        if (Number.isFinite(e)) {
          const a = S.state(prevSrc, e), b = S.state(src, e)
          if (a) rows.push({ ms: e, p: a.p, v: a.v })
          if (b) rows.push({ ms: e, p: b.p, v: b.v, cut: true })
          else cutNext = true
        } else cutNext = true
      }
      if (st) { rows.push({ ms, p: st.p, v: st.v, cut: (cutNext || (!prevOk && rows.length > 0)) && rows.length > 0 }); cutNext = false }
      prevSrc = src; prevOk = !!st; prevMs = ms
    }
    return NZ.normalizeRows(rows, {})
  }
  const satOf = (nz, meta) => (nz && nz.t.length >= 1 ? Object.assign({ frame: 'TEME', timeSystem: 'UTC', t: nz.t, p: nz.p, v: nz.v, spans: nz.spans, meta: {} }, meta) : null)

  // gp 项 → TEME 星（含叠加星历）
  function sampleGp(rec, times) {
    const g = sgp4()
    if (!g) throw new Error('SGP4 引擎未就绪')
    const satrec = g.omm2satrec(rec)
    if (!satrec || satrec.error) return null
    const base = {
      state: (ms) => {
        const pv = g.propagate(satrec, new Date(ms))
        if (!pv || !pv.position || !Number.isFinite(pv.position.x) || (satrec.error && satrec.error !== 0)) return null
        return { p: [pv.position.x, pv.position.y, pv.position.z], v: [pv.velocity.x, pv.velocity.y, pv.velocity.z] }
      }
    }
    const S = sourcer(base, customSats.overlayTables(rec.noradId))
    return satOf(sampleComposite(times, S), { name: rec.name || ('NORAD ' + rec.noradId), objectId: rec.objectId || '', noradId: String(rec.noradId) })
  }
  // 定点星 → 地固系星（位置恒定、速度 0；换帧时补 ω×r）
  function sampleFix(item, times) {
    const r = item.r
    if (!Array.isArray(r) || r.length < 3 || !r.every(Number.isFinite)) return null
    const n = times.length, t = Float64Array.from(times), p = new Float64Array(3 * n), v = new Float64Array(3 * n)
    for (let k = 0; k < n; k++) { p[3 * k] = r[0]; p[3 * k + 1] = r[1]; p[3 * k + 2] = r[2] }
    return { name: item.name || 'GEO', objectId: '', noradId: item.id ? String(item.id) : '', frame: 'FIXED', timeSystem: 'UTC', t, p, v, spans: null, meta: {} }
  }
  // 点序列项：原始采样（窗内原点，原帧原值）或按 times 重采样；挂了叠加星历的一律走合成取位
  function sampleEphem(item, req, times, frame) {
    const tabBase = customSats.ephemLookup(item.groupId, item.key)
    if (!tabBase) return null
    const listed = (customSats.list().groups.find((x) => x.id === item.groupId) || { sats: [] }).sats.find((s) => String(s.key) === String(item.key))
    const noradId = listed ? listed.noradId : item.noradId
    const ov = customSats.overlayTables(noradId)
    const name = item.name || (listed && listed.name) || item.key
    if (req.sampling !== 'grid' && !(ov && ov.length)) {
      const es = customSats.ephemSats(item.groupId, { keys: [item.key], frame: frame || null })
      const s = es && es[0]
      if (!s) return null
      const clipped = clip(s, req.fromMs, req.toMs)
      return clipped ? Object.assign(clipped, { name, noradId }) : null
    }
    // 本体表也是源（它的段与起止都是切换点）；时段外取不到位置 = 空档
    const base = { state: () => null }
    const S = sourcer(base, ov, tabBase)
    const tt = times || defaultTimes(tabBase, req)
    return satOf(sampleComposite(tt, S), { name, objectId: (listed && listed.objectId) || '', noradId, interp: { method: tabBase.method, samples: tabBase.samples } })
  }
  // 点序列星没给时段 / 步长时的缺省网格：它自己的时段 + 它自己的步长
  function defaultTimes(tab, req) {
    const from = Number.isFinite(req.fromMs) ? Math.max(req.fromMs, tab.t0) : tab.t0
    const to = Number.isFinite(req.toMs) ? Math.min(req.toMs, tab.t1) : tab.t1
    const st = Number(req.stepS) > 0 ? Number(req.stepS) : Math.max(1, Math.round(tab.stepMs / 1000))
    return gridTimes(from, to, st, true)
  }
  // 原始采样按 [from, to] 截取（含端点）；段随之截
  function clip(s, fromMs, toMs) {
    const a = Number.isFinite(fromMs) ? fromMs : -Infinity, b = Number.isFinite(toMs) ? toMs : Infinity
    const idx = []
    for (let k = 0; k < s.t.length; k++) if (s.t[k] >= a && s.t[k] <= b) idx.push(k)
    if (!idx.length) return null
    if (idx.length === s.t.length) return Object.assign({}, s)
    const n = idx.length
    const t = new Float64Array(n), p = new Float64Array(3 * n), v = s.v ? new Float64Array(3 * n) : null
    idx.forEach((k, i) => {
      t[i] = s.t[k]
      p[3 * i] = s.p[3 * k]; p[3 * i + 1] = s.p[3 * k + 1]; p[3 * i + 2] = s.p[3 * k + 2]
      if (v) { v[3 * i] = s.v[3 * k]; v[3 * i + 1] = s.v[3 * k + 1]; v[3 * i + 2] = s.v[3 * k + 2] }
    })
    let spans = null
    if (s.spans && s.spans.length > 1) {
      spans = s.spans.map((sp) => [Math.max(sp[0], t[0]), Math.min(sp[1], t[n - 1])]).filter((sp) => sp[1] >= sp[0])
      if (spans.length < 2) spans = null
    }
    return Object.assign({}, s, { t, p, v, spans, partial: true })
  }

  /* ===================== 计划（对话框读数用） ===================== */
  // 渲染端开对话框前问一声：各格式能写几颗、跳过的原因、点序列的缺省时段
  function plan(req) {
    const items = (req && req.items) || []
    const kinds = { gp: 0, ephem: 0, fix: 0, norad: 0 }
    let tleBad = 0
    let t0 = Infinity, t1 = -Infinity
    const groups = new Map()
    for (const it of items) {
      kinds[it.t] = (kinds[it.t] || 0) + 1
      if ((it.t === 'gp' || it.t === 'norad') && Number(OP.normId(it.noradId || (it.rec && it.rec.noradId))) > TLE_MAX_NORAD) tleBad++
      if (it.t === 'ephem') {
        if (!groups.has(it.groupId)) groups.set(it.groupId, customSats.list().groups.find((x) => x.id === it.groupId) || null)
        const g = groups.get(it.groupId)
        const s = g && g.sats.find((x) => String(x.key) === String(it.key))
        if (s) { if (s.t0 < t0) t0 = s.t0; if (s.t1 > t1) t1 = s.t1 }
      }
    }
    const gpN = kinds.gp + kinds.norad
    return {
      total: items.length, kinds, tleBad,
      mean: gpN, tle: Math.max(0, gpN - tleBad), point: items.length,
      ephemSpan: Number.isFinite(t0) ? { t0, t1 } : null,
      exact: exactSourceOf(req) ? true : false
    }
  }
  // 能否整份吐原文：全部项来自同一个点序列组且覆盖整组、同格式、原始采样、时段盖住整组、原帧、不带叠加，
  // 且没要求多星拆成一星一个文件（多星原文是一个文件，顶替不了逐星文件）
  function exactSourceOf(req) {
    const items = (req && req.items) || []
    if (!items.length || items.some((x) => x.t !== 'ephem')) return null
    if (req.perFile && items.length > 1 && !singleObject(EF.writableFormat(req.format))) return null
    const gid = items[0].groupId
    if (items.some((x) => x.groupId !== gid)) return null
    const g = customSats.list().groups.find((x) => x.id === gid)
    if (!g || g.kind !== 'ephem' || !g.hasSource) return null
    if (EF.writableFormat(g.format) !== g.format || g.format !== req.format) return null
    if (req.sampling === 'grid') return null
    if (req.frame && FR.normFrame(req.frame) !== FR.normFrame(g.sats[0] && g.sats[0].frame)) return null
    const keys = new Set(items.map((x) => String(x.key)))
    if (keys.size !== g.sats.length || !g.sats.every((s) => keys.has(String(s.key)))) return null
    if (g.sats.some((s) => customSats.overlayTables(s.noradId))) return null
    if (Number.isFinite(req.fromMs) && req.fromMs > g.t0) return null
    if (Number.isFinite(req.toMs) && req.toMs < g.t1) return null
    return g
  }

  /* ===================== 执行 ===================== */
  // target: { file } 单文件 | { dir } 一星一个文件。返回 { ok, files:[…], written, skipped:[{name,reason}], warnings }
  async function run(req, target, onProgress, isCancelled) {
    const r = req || {}
    const fmt = EF.writableFormat(r.format)
    if (!isMean(fmt) && !isPoint(fmt)) return { ok: false, error: '未知导出格式：' + r.format }
    const items = Array.isArray(r.items) ? r.items : []
    if (!items.length) return { ok: false, error: '没有可导出的卫星' }
    const prog = (done, total, phase) => { try { onProgress && onProgress({ done, total, phase }) } catch { /* 进度只是读数 */ } }
    const cancelled = () => { try { return !!(isCancelled && isCancelled()) } catch { return false } }
    const skipped = [], warnings = [], files = []
    const writeOut = (file, data, encoding) => {
      const buf = Buffer.isBuffer(data) ? data : (encoding === 'gbk' ? Buffer.from(TC.encodeText(data, 'gbk')) : Buffer.from(String(data), 'utf8'))
      fs.writeFileSync(file, buf)
      files.push({ path: file, bytes: buf.length })
    }
    const usedNames = new Set()
    const uniqueFile = (dir, name, ext) => {
      let base = safeFile(name), k = 1, f = path.join(dir, base + ext)
      while (usedNames.has(f.toLowerCase()) || fs.existsSync(f)) { k++; f = path.join(dir, base + ' (' + k + ')' + ext) }
      usedNames.add(f.toLowerCase())
      return f
    }

    /* —— 平均根数 —— */
    if (isMean(fmt)) {
      if (!target || !target.file) return { ok: false, error: '缺少输出文件' }
      // 整个内置组、CSV、没剔星：吐缓存原文（逐字节等同 CelesTrak 原文件）
      if (r.group && r.group.kind === 'builtin' && fmt === 'omm-csv' && !(r.group.hidden && r.group.hidden.length) && r.group.key && r.group.key !== 'all' && r.group.key !== 'other') {
        let raw = null
        try { raw = omm.readCsvRaw(r.group.key) } catch { raw = null }
        if (raw && raw.text) { writeOut(target.file, raw.text); return { ok: true, files, written: items.length, skipped, warnings, format: fmt, exact: true } }
      }
      // 整个导入 gp 组、同格式：吐导入原文 / 规范重建（customSats.groupText 的既有口径）
      if (r.group && r.group.kind === 'import' && r.group.id) {
        const g = customSats.list().groups.find((x) => x.id === r.group.id)
        if (g && g.kind === 'gp' && g.count === items.length && !(r.group.hidden && r.group.hidden.length)) {
          try { const txt = customSats.groupText(g.id, fmt); if (txt) { writeOut(target.file, txt); return { ok: true, files, written: items.length, skipped, warnings, format: fmt, exact: g.format === fmt } } } catch (err) { return { ok: false, error: err.message || String(err) } }
        }
      }
      const find = makeRecordFinder(), byNorad = makeNoradResolver()
      const recs = [], seen = new Set()
      let k = 0
      for (const it of items) {
        k++
        if (it.t === 'ephem') { skipped.push({ name: it.name || it.key, reason: '星历点序列没有平均根数' }); continue }
        if (it.t === 'fix') { skipped.push({ name: it.name, reason: '定点星没有平均根数' }); continue }
        let rec = null
        if (it.t === 'gp' && it.rec) rec = find(it.rec, it.src)
        else if (it.t === 'norad') rec = byNorad(it.noradId, it.src)
        if (!rec) { skipped.push({ name: it.name || ('NORAD ' + it.noradId), reason: '本机星历缓存中没有这颗星' }); continue }
        const id = OP.normId(rec.noradId)
        if ((fmt === 'tle' || fmt === '3le') && Number(id) > TLE_MAX_NORAD) { skipped.push({ name: rec.name, reason: '编号 ' + rec.noradId + ' 超出 TLE 编号栏上限（Alpha-5 ≤ 339999）' }); continue }
        if (seen.has(id)) continue
        seen.add(id)
        recs.push(rec)
        if (k % 500 === 0) { prog(k, items.length, 'resolve'); await tick(); if (cancelled()) return { ok: false, canceled: true } }
      }
      if (!recs.length) return { ok: false, error: '所选卫星没有可写成该格式的', skipped }
      let text
      try { text = OMM.serializeEphemeris(recs, fmt) } catch (err) { return { ok: false, error: err.message || String(err), skipped } }
      writeOut(target.file, text)
      prog(items.length, items.length, 'done')
      return { ok: true, files, written: recs.length, skipped, warnings, format: fmt }
    }

    /* —— 点序列 —— */
    const exact = exactSourceOf(Object.assign({}, r, { format: fmt }))
    if (exact) {
      const src = customSats.ephemSource(exact.id)
      if (src && src.bytes) {
        const file = target.file || uniqueFile(target.dir, singleObject(fmt) && exact.sats.length === 1 ? (exact.sats[0].bind ? exact.sats[0].bind.name : exact.sats[0].name) + '-' + ymd(exact.sats[0].t0) : exact.name, extOf(fmt))
        writeOut(file, src.bytes)
        return { ok: true, files, written: exact.sats.length, skipped, warnings, format: fmt, exact: true }
      }
    }
    const frame = fmt === 'cs-eph' ? 'FIXED' : (FR.normFrame(r.frame) || null)
    const interp = r.interp && r.interp.method ? { method: r.interp.method, samples: Math.round(Number(r.interp.samples) || 0) } : null
    const stepS = Number(r.stepS)
    const needGrid = items.some((x) => x.t !== 'ephem') || r.sampling === 'grid'
    if (needGrid && !(Number.isFinite(r.fromMs) && Number.isFinite(r.toMs) && r.toMs > r.fromMs && stepS > 0)) return { ok: false, error: '导出时段或步长无效' }
    const times = needGrid ? gridTimes(r.fromMs, r.toMs, stepS, r.includeEnd !== false) : null
    const perFile = singleObject(fmt) || !!r.perFile
    if (perFile && !(target && target.dir) && items.length > 1) return { ok: false, error: '多颗卫星须选择输出文件夹' }
    const find = makeRecordFinder(), byNorad = makeNoradResolver()
    const createdMs = Number.isFinite(r.createdMs) ? r.createdMs : Date.now()
    const baseOpts = { createdMs, interp: null, frame }
    // OEM 单文件：边算边写（头 → 每星一块 → 尾）
    let stream = null
    if (!perFile) {
      if (!target || !target.file) return { ok: false, error: '缺少输出文件' }
      const parts = EF.STREAM_PARTS[fmt]
      if (!parts) return { ok: false, error: '该格式不支持多星单文件' }
      stream = { fd: fs.openSync(target.file + '.part', 'w'), parts, bytes: 0, n: 0 }
      const head = parts.head(baseOpts)
      fs.writeSync(stream.fd, head); stream.bytes += Buffer.byteLength(head)
    }
    let last = Date.now(), done = 0
    try {
      for (const it of items) {
        if (cancelled()) { if (stream) { fs.closeSync(stream.fd); try { fs.unlinkSync(target.file + '.part') } catch { /* 没了就算了 */ } stream = null } return { ok: false, canceled: true, files, skipped } }
        let s = null
        try {
          if (it.t === 'gp' || it.t === 'norad') {
            const rec = it.t === 'gp' ? find(it.rec, it.src) : byNorad(it.noradId, it.src)
            if (!rec) { skipped.push({ name: it.name || ('NORAD ' + it.noradId), reason: '本机星历缓存中没有这颗星' }); continue }
            s = sampleGp(rec, times)
            if (!s) { skipped.push({ name: rec.name, reason: 'SGP4 初始化失败或时段内无有效位置' }); continue }
          } else if (it.t === 'fix') {
            s = sampleFix(it, times)
            if (!s) { skipped.push({ name: it.name, reason: '定点位置无效' }); continue }
          } else if (it.t === 'ephem') {
            s = sampleEphem(it, r, r.sampling === 'grid' ? times : null, frame)
            if (!s) { skipped.push({ name: it.name || it.key, reason: '所选时段内没有星历点' }); continue }
          } else { skipped.push({ name: it.name || '?', reason: '未知的导出项' }); continue }
        } catch (err) { skipped.push({ name: it.name || '?', reason: (err && err.message) || String(err) }); continue }
        if (s.t.length < 2 && fmt !== 'cs-eph') { skipped.push({ name: s.name, reason: '时段内不足 2 个星历点' }); continue }
        const opts = Object.assign({}, baseOpts, { interp: interp || s.interp || DEFAULT_INTERP })
        // .eph 同源原值导出：原文里同刻重印的行照印；原表头只在与写出口径一致时复用（子集即原文的逐行子集）——
        // 写出器的数据行恒为 UTC、位置 m、速度 m/s、X Y Z dX dY dZ 六列，北京时 / km 的原表头配上这样的数据行
        // 读回就差 8 h / 差三个量级。口径不一致时表头按原标题重新生成
        if (fmt === 'cs-eph' && s.fmt && s.exact && FR.normFrame(s.frame) === 'FIXED') {
          const f = s.fmt
          if (f.header && f.timeScale === 'UTC' && f.unitPos === 'm' && f.unitVel === 'm/s' && f.colsStd) opts.header = f.header
          else if (f.title) opts.title = f.title
          opts.dupTimes = f.dupTimes
        }
        if (fmt === 'cs-eph' && it.title) opts.title = it.title
        if (stream) {
          const body = stream.parts.body(s, opts)
          fs.writeSync(stream.fd, body); stream.bytes += Buffer.byteLength(body); stream.n++
        } else {
          let text
          try { text = EF.serializeEphemeris([s], fmt, opts) } catch (err) { skipped.push({ name: s.name, reason: err.message || String(err) }); continue }
          const nm = (it.fileName || s.name) + (singleObject(fmt) || items.length > 1 ? '-' + ymd(s.t[0]) : '')
          const file = items.length === 1 && target.file ? target.file : uniqueFile(target.dir, nm, extOf(fmt))
          writeOut(file, text, EF.FORMAT_ENCODING[fmt] || 'utf-8')
        }
        done++
        if (Date.now() - last > YIELD_MS) { prog(done, items.length, 'write'); await tick(); last = Date.now() }
      }
      if (stream) {
        const tail = stream.parts.tail()
        fs.writeSync(stream.fd, tail); stream.bytes += Buffer.byteLength(tail)
        fs.closeSync(stream.fd)
        if (!stream.n) { try { fs.unlinkSync(target.file + '.part') } catch { /* 无 */ } stream = null; return { ok: false, error: '没有可导出的星历点', skipped } }
        try { fs.unlinkSync(target.file) } catch { /* 新文件 */ }
        fs.renameSync(target.file + '.part', target.file)
        files.push({ path: target.file, bytes: stream.bytes })
        stream = null
      }
    } catch (err) {
      if (stream) { try { fs.closeSync(stream.fd) } catch { /* 已关 */ } try { fs.unlinkSync(target.file + '.part') } catch { /* 无 */ } }
      return { ok: false, error: (err && err.message) || String(err), files, skipped }
    }
    prog(items.length, items.length, 'done')
    if (!done) return { ok: false, error: '没有可导出的星历点', skipped }
    return { ok: true, files, written: done, skipped, warnings, format: fmt }
  }

  // 保存对话框要的东西：单文件还是文件夹、缺省文件名、类型下拉
  function outputPlan(req) {
    const fmt = EF.writableFormat(req && req.format)
    const items = (req && req.items) || []
    const perFile = isPoint(fmt) && (singleObject(fmt) || !!(req && req.perFile)) && items.length > 1
    return { format: fmt, ext: extOf(fmt), perFile, defaultName: safeFile((req && req.baseName) || (items[0] && items[0].name) || 'ephemeris') }
  }

  return { run, plan, outputPlan, exactSourceOf, _gridTimes: gridTimes, _clip: clip, MEAN_FORMATS, POINT_FORMATS, TLE_MAX_NORAD }
}

module.exports.MEAN_FORMATS = MEAN_FORMATS
module.exports.POINT_FORMATS = POINT_FORMATS
module.exports.extOf = extOf
