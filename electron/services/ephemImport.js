// 星历导入编排（主进程）：读字节 → 识别编码 → 预览（解析 + 逐星给出「已有卫星」候选）→ 提交（建组 + 对应关系）。
//
// 【为什么要预览】点序列星历导入后可以「新建卫星」，也可以「对应已有卫星」——外部星历挂到一颗已有的星
//   （编目星 / 自定义库里的星 / 早先导入的点序列星）身上，该星在星历时段内改由它取位（见 orbitPos 的叠加星历）。
//   这一步必须让人看着选：自动挂错一颗星，全平台的几何就静默错了。故先解析给出读数与候选，用户确认后才落库。
//
// 【候选怎么找】按几何，不按名字：取星历时段内一个参考时刻（此刻钳到时段内），把本机各星历缓存（active 全量
//   编目 + 各命名组，含随包快照）与自定义库的平均根数用 SGP4 推到该刻，与导入星历在 TEME 里比距离；另把别的
//   导入点序列星在同一刻比一遍。名字只作佐证（文件名「6C」与「ZHONGXING-6C」共享记号）。
//   实测（中星 6C 的卫通 .eph 对 CelesTrak 编目）：本星 5 km，次近的同轨位邻星 272 km。
//
// 【编码】一律按字节读进来再识别（textCodec.decodeText）：卫通 .eph 是 GBK，按 UTF-8 读会把表头帧名读成乱码。

'use strict'

const path = require('path')
const TC = require('../../packages/core/utils/textCodec.js')
const EI = require('../../packages/core/utils/ephemInterp.js')
const OP = require('../../packages/core/utils/orbitPos.js')

const MU = 398600.4418
// 中文星座族名 → 编目英文写法（名字佐证用）
const CN_FAMILY = [
  [/中星/g, ' ZHONGXING CHINASAT '], [/亚太/g, ' APSTAR '], [/天链/g, ' TIANLIAN '], [/天通/g, ' TIANTONG '],
  [/北斗/g, ' BEIDOU '], [/风云/g, ' FENGYUN '], [/实践/g, ' SHIJIAN SJ '], [/亚洲/g, ' ASIASAT '], [/鑫诺/g, ' SINOSAT ']
]
function tokens(s) {
  let x = String(s || '').toUpperCase()
  for (const [re, en] of CN_FAMILY) x = x.replace(re, en)
  const out = new Set()
  for (const m of x.match(/[A-Z0-9]+|[一-鿿]+/g) || []) {
    if (m.length < 2) continue
    if (/^\d{6,}$/.test(m)) continue            // 日期 / 流水号不算记号
    out.add(m)
  }
  return out
}
const shares = (a, b) => { for (const t of a) if (b.has(t)) return true; return false }

module.exports = function createEphemImport({ customSats, omm, getCore }) {
  // 编目索引：active 打底，各命名组覆盖（常用名），自定义库 gp 组再覆盖（与搜索池同一优先级）
  function catalogIndex() {
    const map = new Map()
    let rows = []
    try { rows = omm.listCsv().filter((r) => !r.kind) } catch { rows = [] }
    const keys = ['active'].concat(rows.map((r) => r.key).filter((k) => k !== 'active'))
    for (const key of keys) {
      let raw = null
      try { raw = omm.readCsvRaw(key) } catch { raw = null }
      if (!raw || !raw.text) continue
      for (const rec of customSats._parseOMMCsv(raw.text)) map.set(OP.normId(rec.noradId), { rec, src: key })
    }
    try {
      for (const g of customSats.list().groups) {
        if (g.kind === 'ephem') continue
        for (const rec of (customSats.groupRecords(g.id) || [])) map.set(OP.normId(rec.noradId), { rec, src: 'ci:' + g.id, groupName: g.name })
      }
    } catch { /* 自定义库读不出来：只用编目 */ }
    return map
  }

  // 一颗导入星的候选：[{ noradId, name, kind:'catalog'|'custom'|'ephem', src, groupName, distKm, tRef, nameHit }]（按距离升序，至多 6 个）。
  // 比较时刻逐候选取：编目星取它自己的根数历元（钳进星历时段）——SGP4 在历元附近最准，导入星历又常跨机动，
  // 统一取「此刻」会把机动前的老根数与机动后的新轨道硬比（实测中星 6C：历元处 2.3 km，机动后两天 27 km）。
  function candidatesFor(tab, label, catalog, selfGroupId) {
    const core = getCore && getCore()
    const sgp4 = core && core.sgp4
    if (!tab || !sgp4) return { list: [], suggest: null }
    const clampT = (ms) => Math.min(Math.max(ms, tab.t0), tab.t1)
    const mid = EI.evalTable(tab, clampT(Date.now()))
    if (!mid) return { list: [], suggest: null }
    const r = Math.hypot(mid.x, mid.y, mid.z), v2 = mid.vx * mid.vx + mid.vy * mid.vy + mid.vz * mid.vz
    const a = 1 / (2 / r - v2 / MU)
    const nRev = a > 0 ? 86400 / (2 * Math.PI) * Math.sqrt(MU / (a * a * a)) : NaN
    const tok = tokens(label)
    const out = []
    for (const [id, c] of catalog) {
      const mm = Number(c.rec.meanMotion)
      // 平均运动粗筛（±5%）：GEO 星历只和 GEO 编目比，LEO 只和同高度的比，省掉九成 SGP4
      if (Number.isFinite(nRev) && Number.isFinite(mm) && Math.abs(mm - nRev) > Math.max(0.05 * nRev, 0.02)) continue
      const ep = Date.parse(/[zZ]$/.test(c.rec.epoch) ? c.rec.epoch : c.rec.epoch + 'Z')
      const tRef = clampT(Number.isFinite(ep) ? ep : Date.now())
      const st = EI.evalTable(tab, tRef)
      if (!st) continue
      let s
      try { s = sgp4.omm2satrec(c.rec) } catch { continue }
      if (!s || s.error) continue
      let pv
      try { pv = sgp4.propagate(s, new Date(tRef)) } catch { continue }
      if (!pv || !pv.position || !Number.isFinite(pv.position.x)) continue
      const d = Math.hypot(pv.position.x - st.x, pv.position.y - st.y, pv.position.z - st.z)
      if (!Number.isFinite(d)) continue
      out.push({ noradId: id, name: c.rec.name, kind: c.src.indexOf('ci:') === 0 ? 'custom' : 'catalog', src: c.src, groupName: c.groupName || '', distKm: d, tRef })
    }
    // 别的导入点序列星（没对应到别处的那些）：两段时段重叠处的中点插值比距离
    try {
      for (const g of customSats.list().groups) {
        if (g.kind !== 'ephem' || g.id === selfGroupId) continue
        for (const s of (g.sats || [])) {
          if (s.bind) continue
          const lo = Math.max(s.t0, tab.t0), hi = Math.min(s.t1, tab.t1)
          if (!(hi >= lo)) continue
          const tRef = (lo + hi) / 2
          const t2 = customSats.ephemLookup(g.id, s.key)
          const e = t2 && EI.evalTable(t2, tRef), st = EI.evalTable(tab, tRef)
          if (!e || !st) continue
          out.push({ noradId: OP.normId(s.noradId), name: s.name, kind: 'ephem', src: 'i:' + g.id, groupName: g.name, key: s.key, distKm: Math.hypot(e.x - st.x, e.y - st.y, e.z - st.z), tRef })
        }
      }
    } catch { /* 读不出别的组：只比编目 */ }
    out.sort((x, y) => x.distKm - y.distKm)
    const list = out.slice(0, 6)
    for (const c of list) c.nameHit = shares(tok, tokens(c.name))
    // 建议项：足够近（GEO 84 km / LEO 50 km 量级）且与次近者拉得开（3 倍）或名字也对得上
    let suggest = null
    const best = list[0]
    if (best && best.distKm <= Math.max(50, 0.002 * r) && (list.length < 2 || list[1].distKm > 3 * best.distKm || best.nameHit)) suggest = best.noradId
    return { list, suggest }
  }

  // files: [{ name（文件名）, bytes（Buffer / Uint8Array）, path? }]
  function preview(files) {
    const list = Array.isArray(files) ? files : []
    let catalog = null
    const previews = []
    for (const f of list) {
      const fileName = String((f && f.name) || '星历')
      const base = fileName.replace(/\.(csv|json|kvn|xml|tle|3le|txt|e|oem|sp3|sp3c|sp3d|alm|al3|eph)$/i, '')
      let dec
      try { dec = TC.decodeText(f && f.bytes != null ? f.bytes : String((f && f.text) || '')) }
      catch (err) { previews.push({ fileName, ok: false, error: '读取失败：' + ((err && err.message) || err) }); continue }
      let pv
      try { pv = customSats.previewFile(base, dec.text, { bytes: f && f.bytes != null ? f.bytes : null, encoding: dec.encoding }) }
      catch (err) { previews.push({ fileName, ok: false, error: '解析失败：' + ((err && err.message) || err) }); continue }
      pv.fileName = fileName
      pv.ok = !(pv.errors && pv.errors.length && !(pv.sats && pv.sats.length))
      if (pv.kind === 'ephem' && pv.sats && pv.sats.length) {
        if (!catalog) catalog = catalogIndex()
        const tabs = customSats.previewTables(pv.token) || []
        // 同名的点序列组提交时会被这次导入整组替换（新星沿用旧星号）：它的星不能当候选，否则同一份文件重导入时
        // 建议项就是「将被替换的旧副本」（距离 0），缺省提交即对应到自己
        let replaced = null
        try { replaced = customSats.list().groups.find((g) => g.kind === 'ephem' && g.name === pv.name) || null } catch { replaced = null }
        pv.sats.forEach((s, i) => {
          const c = candidatesFor(tabs[i], s.name + ' ' + base, catalog, replaced ? replaced.id : null)
          s.candidates = c.list
          s.suggest = c.suggest
        })
      }
      previews.push(pv)
    }
    return previews
  }
  // 已导入的点序列组改对应关系：给出与导入预览同形的读数 + 候选（token = 'r:<组 id>'，提交走 customSats.rebind）
  function rebindPreview(groupId) {
    const g = customSats.list().groups.find((x) => x.id === groupId)
    if (!g || g.kind !== 'ephem') return { fileName: '', ok: false, error: '星历组不存在' }
    const catalog = catalogIndex()
    const sats = (g.sats || []).map((s, i) => {
      const tab = customSats.ephemLookup(g.id, s.key)
      const c = tab ? candidatesFor(tab, s.name + ' ' + g.name, catalog, g.id) : { list: [], suggest: null }
      return {
        idx: i, key: s.key, name: s.name, objectId: s.objectId || '', frame: s.frame, n: s.n, t0: s.t0, t1: s.t1,
        stepS: s.stepS, hasVel: !!(tab && tab.v), interp: s.interp, gaps: [], jumps: 0, valid: !!tab, timeScale: s.timeSystem || 'UTC',
        bind: s.bind || null, candidates: c.list, suggest: c.suggest
      }
    })
    return { token: 'r:' + g.id, groupId: g.id, fileName: g.name, name: g.name, kind: 'ephem', ok: true, format: g.format, formatLabel: g.formatLabel, encoding: g.encoding || '', errors: [], warnings: [], sats }
  }
  // choices: { name, binds:[{ noradId, name }|null] }
  function commit(token, choices) { return customSats.commitPreview(token, choices) }
  function cancel(tokens) { for (const t of (Array.isArray(tokens) ? tokens : [tokens])) customSats.dropPreview(t) }

  return { preview, rebindPreview, commit, cancel, catalogIndex, candidatesFor, _tokens: tokens }
}

module.exports.tokens = tokens
module.exports.baseName = (p) => path.basename(String(p || ''))
