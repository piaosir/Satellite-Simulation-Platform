// Mask 生成工作台 · 四库 + 掩模表 + 计算
//
// 范式严格对齐链路预算工作台（三库全局化 + 单一链路表 + 结果文档化），只有一处刻意偏离：
// 这里是**四库**，多出一个「运行场景库」。它不能折进其它三个，因为：
//   ① 它的内容进 SRS（另一份交付物），不进 mask XML
//   ② 它的字段是二维表（MIN_EXCLUDE[lat][orbId]、MIN_ELEV[lat][az]），塞不进表格单元
//   ③ ITU 2025 起把 examination scenario 升为一等对象
// 硬凑三库会重演「频率极化曾下沉地球站又迁回」那种返工。
//
// ★ 四库的边界就是按「进哪份文件」划的 —— 这是防「mask 参数与 SRS 参数混在一起」的唯一办法：
//     壳层 / 载荷 / 终端  →  进 mask XML
//     运行场景            →  进 SRS（规避角、跟踪、终端密度全在这里，都不进 mask）

import { ref, reactive, computed, watch } from 'vue'
import { CONST_PRESETS } from '../constellation/walker.js'

const STORE_KEY = 'pfd-mask-workbench-v1'

/** 三个生成方向。页签用，也决定掩模表某一行哪些列有效。 */
export const DIRECTIONS = [
  { v: 'down', label: '下行 PFD', elem: 'pfd_mask', needs: ['shell', 'payload', 'scenario'] },
  { v: 'is', label: '星间 EIRP', elem: 'eirp_mask_ss', needs: ['shell', 'payload', 'scenario'] },
  { v: 'up', label: '上行 EIRP', elem: 'eirp_mask_es', needs: ['shell', 'terminal', 'scenario'] }
]

export const REF_BW = [
  { v: 4, label: '4 kHz' },
  { v: 40, label: '40 kHz' },
  { v: 1000, label: '1 MHz' }
]
export const PATTERN_SECTIONS = [
  { v: '1.2', label: 'S.1528 §1.2（LN 型包络）' },
  { v: '1.3', label: 'S.1528 §1.3（LEO / MEO）' }
]
export const LN_VALUES = [
  { v: -15, label: '−15 dB' }, { v: -20, label: '−20 dB' },
  { v: -25, label: '−25 dB' }, { v: -30, label: '−30 dB（原文标注待细化）' }
]
export const BEAM_LAYOUTS = [
  { v: 'hex-ring', label: '六角环（按最小间隔排布）' },
  { v: 'worst-case-uniform', label: '最坏情况（全部按主波束，+10lg N）' },
  { v: 'single', label: '仅主波束（会低估，仅供对照）' }
]
/**
 * 星上发射天线方向图清单（对齐 PMGT 屏3 的 Antenna Gain Pattern 下拉）。
 *
 * ★ 算法在 packages/core/utils/pfdmask/satPatterns.js（CommonJS，渲染端 import 不到），
 *   这里只放 UI 关注点：标签、需要哪些输入字段、是否可转向、证据等级。
 *   两处的 v 值必须一致 —— 由 pfdMask.test.js 的 X 组断言锁住。
 *
 * steerable=false（isoflux/omni）意味着波束焊死朝天底：mask 生成时每个方向的增益由
 * 该方向的【天底角】决定，不能按可动点波束那样一律取峰值。
 */
export const SAT_PATTERNS = [
  { v: 'isoflux', label: '等通量（Isoflux）', steerable: false, evidence: 'R',
    needs: ['peakGainDbi'],
    note: 'S.1503-4 §C2.3.1 为该类天线规定：功率通量密度计算中的斜距恒取卫星高度。常用于 TT&C 与全球波束下行。' },
  { v: 'omni', label: '全向 / 各向同性（Omni）', steerable: false, evidence: 'T',
    needs: ['peakGainDbi'],
    note: '各方向增益相同。Transfinite 把它列在「单一固定波束开/关」这一类天线体制里。' },
  { v: 's1528', label: 'ITU-R S.1528 参考方向图', steerable: true, evidence: 'R',
    needs: ['peakGainDbi', 'psibDeg', 'section', 'Ln'],
    note: '★ S.1528 §1.1 明确：有实测方向图时应当用实测图，本节的参考图是拿不到实测图时的替代品。' },
  { v: 'parabolic', label: '理论抛物面（均匀照射圆口径）', steerable: true, evidence: 'S',
    needs: ['diameterM', 'efficiency', 'nullFloorDb'],
    note: '增益由口径与效率算出（主轴增益变为派生只读）。滚降取均匀照射圆口径的解析式 2J₁(u)/u。' },
  { v: 'two-level', label: '两级带底包络', steerable: true, evidence: 'S',
    needs: ['peakGainDbi', 'beamwidth1Deg', 'gainFloor1Db', 'beamwidth2Deg', 'gainFloor2Db'],
    note: '主瓣外落到第一级底电平，再向外落到第二级。用于厂商只给了「主瓣宽度 + 两级旁瓣包络」的情形。' }
]

/** ★ 默认不给 S.1428：那是受扰方【接收】天线的统计型图，用作发射包络会给出偏松的 mask。 */
export const ES_PATTERNS = [
  { v: 'S.580-6', label: 'ITU-R S.580-6（29 − 25 lgφ）' },
  { v: 'S.465-6', label: 'ITU-R S.465-6（32 − 25 lgφ）' },
  { v: 'M.2101', label: 'ITU-R M.2101 相控阵' }
]
export const EXCLUSION_OBSERVANCE = [
  { v: 'cell-centre', label: '小区中心（cell-centre）' },
  { v: 'cell-wide', label: '小区全域（cell-wide，更保守）' }
]
/** 出包粒度。XSD 的根是 satellite_system，分文件 = 每文件一份完整的 satellite_system。 */
export const EXPORT_MODES = [
  { v: 'per-mask', label: '每份 mask 一个文件（ITU 实际做法）' },
  { v: 'per-kind', label: '每种一个文件（pfd / eirp_es / eirp_ss）' },
  { v: 'single', label: '全部合并为一个（XSD 合法，无真实申报采用）' }
]

let seq = 1
const nid = (p) => `${p}_${Date.now().toString(36)}_${(seq++).toString(36)}`

// ---------------------------------------------------------------------------
// 库条目的默认值
// ---------------------------------------------------------------------------

const newShell = (o) => Object.assign({
  id: nid('sh'), name: '', nameAuto: true, source: 'manual',
  orbId: 0, altKm: 900, inclDeg: 55, eccen: 0,
  raanCount: 6, satsPerPlane: 10, phasingF: 1
}, o || {})

const newPayload = (o) => Object.assign({
  id: nid('pl'), name: '', nameAuto: true,
  patternSource: 's1528', s1528Section: '1.2',
  peakGainDbi: 32, psibDeg: 1, Ln: -25, patternMode: 'LEO', dOverLambda: 22.6, farOutDbi: 0,
  maxEirpDbwPerRefBw: -5, usePowerControl: true, powerControlKappa: 1,
  nco: 50, minAngleDeg: 5, beamLayout: 'hex-ring'
}, o || {})

const newTerminal = (o) => Object.assign({
  id: nid('tm'), name: '', nameAuto: true,
  esType: 'typical', esId: -1,
  patternStandard: 'S.580-6', diameterM: 1.2, efficiency: 0.65,
  maxEirpDbwPerRefBw: 20, arrayElements: 64, scanAnglesDeg: ''
}, o || {})

const newScenario = (o) => Object.assign({
  id: nid('sc'), name: '默认场景', nameAuto: true,
  minElevDeg: 20, alpha0Deg: 15,
  exclusionObservance: 'cell-centre',
  maxCoFreq: 1, maxCoFreqSat: 1,
  esDensityPerKm2: 1e-5, esDistanceKm: 200,
  minDurationSec: null,
  // S.1503-4 新增参数，默认 0
  minAngleAtEsDeg: 0, minAngleAtSatDeg: 0,
  esLatMin: -90, esLatMax: 90
}, o || {})

/**
 * 场景库标量 → §B3.3 的一维/二维表。与引擎侧同名函数保持一致的降维口径：
 * 标量在纬度两端各放一个同值点（读方按纬度线性插值 ⇒ 等价于常量）。
 */
function scenarioToOp(sc, q) {
  const latLo = Number(sc.esLatMin === undefined ? -90 : sc.esLatMin)
  const latHi = Number(sc.esLatMax === undefined ? 90 : sc.esLatMax)
  const flat2 = (v) => [{ lat: latLo, value: v }, { lat: latHi, value: v }]
  const elevAt = (lat) => ({ lat, byAz: [{ az: 0, value: Number(sc.minElevDeg) || 0 }, { az: 360, value: Number(sc.minElevDeg) || 0 }] })
  return {
    paramId: Number(q.paramId || 1),
    lowFreqMhz: Number(q.lowFreqMhz), highFreqMhz: Number(q.highFreqMhz),
    esLatMin: latLo, esLatMax: latHi,
    esDensity: Number(sc.esDensityPerKm2 > 0 ? sc.esDensityPerKm2 : 1e-5),
    esDistanceKm: Number(sc.esDistanceKm >= 0 ? sc.esDistanceKm : 0),
    minAngleAtEsDeg: Number(sc.minAngleAtEsDeg || 0),
    minAngleAtSatDeg: Number(sc.minAngleAtSatDeg || 0),
    maxCoFreqSat: Number(sc.maxCoFreqSat || 1),
    esType: q.esType || 'typical',
    minExclude: [{ orbId: 0, byLat: flat2(Number(sc.alpha0Deg) || 0) }],
    minElev: [elevAt(latLo), elevAt(latHi)],
    maxCoFreq: flat2(Number(sc.maxCoFreq || 1)),
    minDuration: Number(sc.minDurationSec) >= 1 ? flat2(Number(sc.minDurationSec)) : []
  }
}

const newRow = (o) => Object.assign({
  id: nid('row'), on: true, direction: 'down',
  shellId: '', payloadId: '', terminalId: '', scenarioId: '',
  lowFreqGhz: 10.7, highFreqGhz: 12.75, refBwKhz: 40,
  maskId: 1, maskAlpha0Deg: 20,
  nAzElPoints: 60, latStepDeg: 5, sepAngleStepDeg: 2,
  conservativeMarginDb: 1,
  result: null, error: null, busy: false
}, o || {})

// ---------------------------------------------------------------------------
// 自动命名（沿用「没起过名就随参数走，改过一次钉死」的既有约定）
// ---------------------------------------------------------------------------

function autoNameShell(s) {
  const planes = s.raanCount > 0 && s.satsPerPlane > 0 ? ` ${s.raanCount}×${s.satsPerPlane}` : ''
  return `${Math.round(s.altKm)}km/${Number(s.inclDeg).toFixed(1)}°${planes}`
}
function autoNamePayload(p) {
  const pat = p.patternSource === 's1528' ? `S.1528§${p.s1528Section}` : p.patternSource.toUpperCase()
  return `${p.maxEirpDbwPerRefBw}dBW·${p.nco}束·${pat}`
}
function autoNameTerminal(t) {
  return `${t.diameterM}m·${t.maxEirpDbwPerRefBw}dBW·${t.patternStandard}`
}

// ---------------------------------------------------------------------------

export function useMaskWorkbench(opts) {
  const o = opts || {}

  const doc = reactive({
    satName: 'Test Ku',
    ntcId: 1,
    specVersion: 'v4.0.0.0',                 // 出口 XSD 版本（S.1503-2 口径）
    shells: [newShell({ name: autoNameShell(newShell()) })],
    payloads: [newPayload()],
    terminals: [newTerminal()],
    scenarios: [newScenario()],
    rows: []
  })

  // 初始给三行，三个方向各一，mask_id 1/2/3
  function seedRows() {
    if (doc.rows.length) return
    const sh = doc.shells[0].id, pl = doc.payloads[0].id, tm = doc.terminals[0].id, sc = doc.scenarios[0].id
    doc.rows.push(newRow({ direction: 'down', shellId: sh, payloadId: pl, scenarioId: sc, maskId: 1 }))
    doc.rows.push(newRow({ direction: 'is', shellId: sh, payloadId: pl, scenarioId: sc, maskId: 2 }))
    doc.rows.push(newRow({ direction: 'up', shellId: sh, terminalId: tm, scenarioId: sc, maskId: 3 }))
  }

  // ---- 持久化（只存输入，不存结果） --------------------------------------
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null')
    if (saved && typeof saved === 'object') {
      for (const k of ['satName', 'ntcId', 'specVersion']) if (saved[k] !== undefined) doc[k] = saved[k]
      for (const k of ['shells', 'payloads', 'terminals', 'scenarios']) {
        if (Array.isArray(saved[k]) && saved[k].length) doc[k] = saved[k]
      }
      if (Array.isArray(saved.rows)) {
        doc.rows = saved.rows.map((r) => newRow(Object.assign({}, r, { result: null, error: null, busy: false })))
      }
    }
  } catch { /* ignore */ }
  seedRows()

  watch(doc, () => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        satName: doc.satName, ntcId: doc.ntcId, specVersion: doc.specVersion,
        shells: doc.shells, payloads: doc.payloads, terminals: doc.terminals, scenarios: doc.scenarios,
        rows: doc.rows.map((r) => { const q = Object.assign({}, r); delete q.result; delete q.error; delete q.busy; return q })
      }))
    } catch { /* ignore */ }
  }, { deep: true })

  // 自动命名跟随参数
  watch(() => doc.shells.map((s) => [s.nameAuto, s.altKm, s.inclDeg, s.raanCount, s.satsPerPlane].join()), () => {
    for (const s of doc.shells) if (s.nameAuto) s.name = autoNameShell(s)
  }, { immediate: true })
  watch(() => doc.payloads.map((p) => [p.nameAuto, p.maxEirpDbwPerRefBw, p.nco, p.patternSource, p.s1528Section].join()), () => {
    for (const p of doc.payloads) if (p.nameAuto) p.name = autoNamePayload(p)
  }, { immediate: true })
  watch(() => doc.terminals.map((t) => [t.nameAuto, t.diameterM, t.maxEirpDbwPerRefBw, t.patternStandard].join()), () => {
    for (const t of doc.terminals) if (t.nameAuto) t.name = autoNameTerminal(t)
  }, { immediate: true })

  // ---- 库 CRUD ------------------------------------------------------------
  const LIBS = { shells: newShell, payloads: newPayload, terminals: newTerminal, scenarios: newScenario }
  function libAdd(kind) {
    const mk = LIBS[kind]; if (!mk) return null
    const it = mk(); doc[kind].push(it); return it.id
  }
  function libRemove(kind, id) {
    if (doc[kind].length <= 1) { msg.value = '至少保留一条'; return false }
    const i = doc[kind].findIndex((x) => x.id === id)
    if (i < 0) return false
    doc[kind].splice(i, 1)
    // 断开引用，避免行指向已删条目
    const key = { shells: 'shellId', payloads: 'payloadId', terminals: 'terminalId', scenarios: 'scenarioId' }[kind]
    for (const r of doc.rows) if (r[key] === id) r[key] = ''
    return true
  }
  function libDup(kind, id) {
    const src = doc[kind].find((x) => x.id === id); if (!src) return null
    const it = Object.assign({}, src, { id: nid(kind.slice(0, 2)), name: `${src.name} 副本`, nameAuto: false })
    doc[kind].push(it); return it.id
  }

  // ---- 掩模表 -------------------------------------------------------------
  function rowAdd(direction) {
    const d = direction || 'down'
    doc.rows.push(newRow({
      direction: d,
      shellId: doc.shells[0] ? doc.shells[0].id : '',
      payloadId: doc.payloads[0] ? doc.payloads[0].id : '',
      terminalId: doc.terminals[0] ? doc.terminals[0].id : '',
      scenarioId: doc.scenarios[0] ? doc.scenarios[0].id : '',
      maskId: nextFreeMaskId()
    }))
  }
  function rowRemove(id) {
    const i = doc.rows.findIndex((r) => r.id === id)
    if (i >= 0) doc.rows.splice(i, 1)
  }
  /** 交叉配对：选中的壳层 × 载荷/终端 × 方向 → 批量建行。 */
  function rowsFromCross(shellIds, unitIds, direction) {
    const d = direction || 'down'
    const isUp = d === 'up'
    for (const sid of shellIds) {
      for (const uid of unitIds) {
        doc.rows.push(newRow({
          direction: d, shellId: sid,
          payloadId: isUp ? '' : uid, terminalId: isUp ? uid : '',
          scenarioId: doc.scenarios[0] ? doc.scenarios[0].id : '',
          maskId: nextFreeMaskId()
        }))
      }
    }
  }
  /** mask_id 跨三类唯一（XSD xs:unique），分配时直接避开已用号。 */
  function nextFreeMaskId() {
    const used = new Set(doc.rows.map((r) => Number(r.maskId)))
    for (let i = 1; i <= 999; i++) if (!used.has(i)) return i
    return 999
  }
  const dupMaskIds = computed(() => {
    const seen = new Map(), dup = new Set()
    for (const r of doc.rows) {
      if (!r.on) continue
      const k = Number(r.maskId)
      if (seen.has(k)) dup.add(k); else seen.set(k, r.id)
    }
    return dup
  })

  const byId = (arr, id) => arr.find((x) => x.id === id) || null

  // ---- 解引用 → 引擎入参 --------------------------------------------------
  /** ★ 出 IPC 前现造纯数据：Vue 的 Proxy 过不了结构化克隆，invoke 会当场抛且没 catch 时全静默。 */
  function rowToParams(r) {
    const sh = byId(doc.shells, r.shellId)
    const sc = byId(doc.scenarios, r.scenarioId)
    if (!sh) throw new Error('未选壳层')
    if (!sc) throw new Error('未选运行场景')

    const base = {
      satName: String(doc.satName), ntcId: Number(doc.ntcId),
      specVersion: String(doc.specVersion),
      lowFreqGhz: Number(r.lowFreqGhz), highFreqGhz: Number(r.highFreqGhz), refBwKhz: Number(r.refBwKhz),
      satHeightKm: Number(sh.altKm), incDeg: Number(sh.inclDeg),
      minElevDeg: Number(sc.minElevDeg),
      srsAlpha0Deg: Number(sc.alpha0Deg), maskAlpha0Deg: Number(r.maskAlpha0Deg),
      exclusionObservance: String(sc.exclusionObservance),
      nAzElPoints: Number(r.nAzElPoints), latStepDeg: Number(r.latStepDeg),
      sepAngleStepDeg: Number(r.sepAngleStepDeg),
      conservativeMarginDb: Number(r.conservativeMarginDb),
      directions: { down: false, is: false, up: false }
    }

    if (r.direction === 'down' || r.direction === 'is') {
      const pl = byId(doc.payloads, r.payloadId)
      if (!pl) throw new Error('未选载荷')
      base.maxEirpDbwPerRefBw = Number(pl.maxEirpDbwPerRefBw)
      base.usePowerControl = !!pl.usePowerControl
      base.powerControlKappa = Number(pl.powerControlKappa)
      base.nBeams = Number(pl.nco)
      base.minAngleDeg = Number(pl.minAngleDeg)
      base.beamLayout = String(pl.beamLayout)
      base.pattern = pl.s1528Section === '1.2'
        ? { section: '1.2', peakGainDbi: Number(pl.peakGainDbi), psibDeg: Number(pl.psibDeg), Ln: Number(pl.Ln) }
        : {
            section: '1.3', peakGainDbi: Number(pl.peakGainDbi), psibDeg: Number(pl.psibDeg),
            mode: String(pl.patternMode), dOverLambda: Number(pl.dOverLambda), farOutDbi: Number(pl.farOutDbi)
          }
      if (r.direction === 'down') { base.directions.down = true; base.pfdMaskId = Number(r.maskId) }
      else { base.directions.is = true; base.eirpMaskId = Number(r.maskId) }
    } else {
      const tm = byId(doc.terminals, r.terminalId)
      if (!tm) throw new Error('未选终端')
      const lamM = 0.299792458 / ((Number(r.lowFreqGhz) + Number(r.highFreqGhz)) / 2)
      const scan = String(tm.scanAnglesDeg || '').split(/[,，\s]+/).map(Number).filter(Number.isFinite)
      base.directions.up = true
      base.eirpEsMaskId = Number(r.maskId)
      base.esId = tm.esType === 'specific' ? Number(tm.esId) : -1
      base.terminal = {
        kind: String(tm.patternStandard),
        diameterM: Number(tm.diameterM), wavelengthM: lamM, efficiency: Number(tm.efficiency),
        maxEirpDbwPerRefBw: Number(tm.maxEirpDbwPerRefBw),
        arrayElements: Number(tm.arrayElements),
        scanAnglesDeg: scan.length ? scan : [0]
      }
      // 卫星侧参数在 up 行里仅用于纬度轴，给中性默认避免 normalize 报错
      base.nBeams = 1; base.minAngleDeg = 5; base.beamLayout = 'single'
      base.maxEirpDbwPerRefBw = Number(tm.maxEirpDbwPerRefBw)
      base.usePowerControl = false
      base.pattern = { section: '1.2', peakGainDbi: 0, psibDeg: 1, Ln: -25 }
    }
    return JSON.parse(JSON.stringify(base))
  }

  // ---- 计算 ---------------------------------------------------------------
  const busy = ref(false)
  const msg = ref('')
  const lastXml = ref('')
  const lastFiles = ref(null)      // { single:[], 'per-kind':[], 'per-mask':[] }
  const lastRowId = ref('')
  const lastDiscretion = ref([])
  /**
   * 出包粒度。XSD 的根是 satellite_system，一份文件必须恰有一个根，
   * 所以「分文件」= 每个文件都是一份完整的 satellite_system，各装一部分 mask。
   * mask_id 仍按【全局】唯一校验：切分是交付形态的选择，不是放宽约束的借口。
   */
  // 默认 per-mask：81 个真实 ITU 提交包、72 个 mask XML 文件，100% 只含 1 个 mask 元素，
  // 跨 8 个主管部门 2023–2026 无一例外。per-kind 是三种流派里真实申报中零样本的那种。
  const exportMode = ref('per-mask')
  const errors = ref([])          // [{text, rowId?}]
  const lastOpFiles = ref([])     // 运行参数 XML（第四份交付物）
  const warnings = ref([])
  const msgLevel = ref('ok')      // 'ok' | 'warn' | 'error'

  const activeRows = computed(() => doc.rows.filter((r) => r.on))

  /** 返回 [{text, rowId?}]——全部问题一次列出，可点击定位到行，不再只报第一条。 */
  function preflight() {
    const bad = []
    const add = (text, rowId) => bad.push({ text, rowId: rowId || '' })
    const n = String(doc.satName || '').length
    if (n < 1 || n > 20) add(`卫星名 ${n} 字符，XSD 要求 1..20`)
    if (!(Number(doc.ntcId) >= 1)) add('Notice ID 须 ≥ 1')
    if (!activeRows.value.length) add('掩模表里没有启用的行')
    if (dupMaskIds.value.size) add(`mask_id 撞号：${Array.from(dupMaskIds.value).join('、')}（三类共享 1..999 编号空间）`)
    for (const r of activeRows.value) {
      const tag = `mask ${r.maskId}`
      if (r.direction === 'is' && Number(r.refBwKhz) !== 40) {
        add(`${tag}：星间 EIRP 的参考带宽必须是 40 kHz（XSD 的 eirp_mask_ss 无 refbw_khz 属性）`, r.id)
      }
      if (r.direction === 'up' && ![4, 40].includes(Number(r.refBwKhz))) {
        add(`${tag}：上行 EIRP 的参考带宽只能取 4 或 40 kHz（XSD 枚举不含 1000）`, r.id)
      }
      if (!(Number(r.highFreqGhz) > Number(r.lowFreqGhz))) add(`${tag}：最高频率须大于最低频率`, r.id)
      if (!r.shellId) add(`${tag}：未选壳层`, r.id)
      if (!r.scenarioId) add(`${tag}：未选运行场景`, r.id)
      if (r.direction !== 'up' && !r.payloadId) add(`${tag}：未选载荷`, r.id)
      if (r.direction === 'up' && !r.terminalId) add(`${tag}：未选终端`, r.id)
    }
    return bad
  }

  /** 逐行跑引擎，把三种 mask 合并进一份文档。 */
  async function generateAll() {
    const bad = preflight()
    errors.value = bad
    if (bad.length) {
      msg.value = `${bad.length} 处问题需先修正`
      msgLevel.value = 'error'
      return { ok: false, errors: bad }
    }
    busy.value = true; msg.value = '生成中…'; msgLevel.value = 'ok'; lastXml.value = ''; warnings.value = []
    try {
      const payloads = []
      for (const r of activeRows.value) {
        r.error = null; r.busy = true
        try { payloads.push({ rowId: r.id, params: rowToParams(r) }) }
        catch (e) { r.error = e.message; r.busy = false }
      }
      // 运行参数取【第一条启用行绑定的场景】+ 该行频段（§B5.3：每频段只能有一套）
      const r0 = activeRows.value[0]
      const sc0 = r0 ? byId(doc.scenarios, r0.scenarioId) : null
      const tm0 = r0 && r0.direction === 'up' ? byId(doc.terminals, r0.terminalId) : null
      const req = {
        satName: String(doc.satName), ntcId: Number(doc.ntcId), specVersion: String(doc.specVersion),
        jobs: payloads.map((x) => x.params),
        operatingParams: sc0 ? JSON.parse(JSON.stringify(scenarioToOp(sc0, {
          paramId: 1,
          lowFreqMhz: Number(r0.lowFreqGhz) * 1000,
          highFreqMhz: Number(r0.highFreqGhz) * 1000,
          esType: tm0 ? tm0.esType : 'typical'
        }))) : null
      }
      const res = await window.api.pfdGenerate(req)
      for (const r of doc.rows) r.busy = false
      if (!res || !res.ok) {
        msg.value = (res && res.error) || '生成失败'
        if (res && Array.isArray(res.jobErrors)) {
          res.jobErrors.forEach((e, i) => { const t = payloads[i]; const row = t && byId(doc.rows, t.rowId); if (row) row.error = e })
        }
        return { ok: false }
      }
      // ★ 主进程在「部分 job 失败但至少出了一份 mask」时仍返回 ok:true，
      //   若这里无条件写 result/清 error，失败行会被写成 result=null 且 error 被抹掉，
      //   同时报「已生成 N 份 · 通过校验」——用户会以为三份都出来了。必须逐 job 分流。
      res.metas.forEach((m, i) => {
        const t = payloads[i]; const row = t && byId(doc.rows, t.rowId)
        if (!row) return
        if (m) { row.result = m; row.error = null }
        else { row.result = null; row.error = (res.jobErrors && res.jobErrors[i]) || '生成失败' }
      })
      lastXml.value = res.xml
      lastFiles.value = res.files || null
      lastDiscretion.value = res.discretion || []
      lastOpFiles.value = res.opFiles || []
      warnings.value = (res.warnings || []).concat(res.opProblems || [])
      const failed = (res.jobErrors || []).filter(Boolean).length
      const n = res.counts.pfdMasks + res.counts.eirpMaskEs + res.counts.eirpMaskSs
      msg.value = `已生成 ${n} 份 mask`
        + (failed ? ` · ${failed} 份失败（见行内红框）` : ' · 通过 ITU 官方 XSD 校验')
        + ` · ${res.elapsedMs} ms`
      msgLevel.value = failed ? 'error' : 'ok'
      return { ok: true, failed }
    } catch (e) {
      msg.value = (e && e.message) || '生成失败'
      for (const r of doc.rows) r.busy = false
      return { ok: false }
    } finally {
      busy.value = false
    }
  }

  /** 当前粒度下将要落盘的文件清单（生成后即可预览文件名与大小）。 */
  const exportFileList = computed(() => {
    const f = lastFiles.value
    return f && f[exportMode.value] ? f[exportMode.value] : []
  })

  /**
   * 出包。单文件走另存对话框；多文件走选目录后批量写。
   * 参数存档（§E3 的「参数」部分）一并放进同一目录。
   */
  async function saveMasks(withArchive) {
    const list = exportFileList.value
    if (!list.length) { msg.value = '请先生成'; return }
    try {
      if (list.length === 1 && !withArchive) {
        const r = await window.api.exportFile({
          defaultName: list[0].filename,
          data: new TextEncoder().encode(list[0].xml),
          filters: [{ name: 'ITU Mask XML', extensions: ['xml'] }]
        })
        msg.value = r && r.ok ? `已保存：${r.filePath}` : (r && r.canceled ? '已取消' : (r && r.error) || '保存失败')
        return
      }
      // 出包目录结构与真实 ITU 提交件对齐：mask 与运行参数进 Masks/，存档在根
      const files = list.map((f) => ({ filename: `Masks/${f.filename}`, text: f.xml }))
      for (const f of (lastOpFiles.value || [])) files.push({ filename: `Masks/${f.filename}`, text: f.xml })
      if (withArchive) files.push({ filename: archiveName(), text: JSON.stringify(buildArchive(), null, 2) })
      const r = await window.api.exportFiles({ dirLabel: '选择 mask 出包目录', files })
      if (r && r.ok) {
        const nOp = (lastOpFiles.value || []).length
        msg.value = `已写入 ${r.written.length} 个文件到 ${r.dir}`
          + `（mask ${list.length}${nOp ? ` · 运行参数 ${nOp}` : ''}${withArchive ? ' · 参数存档 1' : ''}）`
      } else if (r && r.canceled) msg.value = '已取消'
      else { msg.value = (r && r.error) || '保存失败'; msgLevel.value = 'error' }
    } catch (e) { msg.value = (e && e.message) || '保存失败' }
  }

  const archiveName = () => `${String(doc.satName).replace(/[^\w.-]+/g, '_') || 'mask'}_params.json`

  /** §E3 要求「生成软件、说明、参数」一并提交——这里出参数部分。 */
  function buildArchive() {
    return {
      generatedBy: '卫星仿真平台 · PFD Mask Generator',
      schema: 'ITU masks schema v.4.0.0.0 (Rec. ITU-R S.1503-2)',
      specVersion: doc.specVersion,
      satName: doc.satName, ntcId: doc.ntcId,
      libraries: {
        shells: doc.shells, payloads: doc.payloads,
        terminals: doc.terminals, scenarios: doc.scenarios
      },
      rows: doc.rows.map((r) => { const q = Object.assign({}, r); delete q.result; delete q.busy; delete q.error; return q }),
      discretion: doc.rows.filter((r) => r.result && r.result.discretion).map((r) => ({ maskId: r.maskId, items: r.result.discretion })),
      note: [
        '本文件是 S.1503 §E3 要求的「参数」部分，可完整重放本次生成。',
        '运行场景库的内容（规避角、终端密度、最小仰角二维表等）应进 non_gso_operating_parameters，',
        '而该文件的官方 XML schema 未公开，故此处以结构化 JSON 存档。'
      ]
    }
  }

  /** 单独导出参数存档（不出 mask 时用）。 */
  async function saveArchive() {
    try {
      const r = await window.api.exportFile({
        defaultName: archiveName(),
        data: new TextEncoder().encode(JSON.stringify(buildArchive(), null, 2)),
        filters: [{ name: '参数存档 JSON', extensions: ['json'] }]
      })
      msg.value = r && r.ok ? `参数存档已保存：${r.filePath}` : (r && r.canceled ? '已取消' : (r && r.error) || '保存失败')
    } catch (e) { msg.value = (e && e.message) || '保存失败' }
  }

  // ---- 星座导入 -----------------------------------------------------------
  const constSources = computed(() => {
    const out = []
    try {
      for (const c of ((o.customConstellations && o.customConstellations()) || [])) {
        const q = c && c.params
        if (!q) continue
        out.push({
          key: 'cc:' + c.id, group: '我的星座', label: c.name || '自定义星座',
          incl: Number(q.incl) || 0, perigeeKm: Number(q.perigeeKm) || 0,
          apogeeKm: Number(q.apogeeKm) || Number(q.perigeeKm) || 0, shape: q.shape || 'circ',
          T: Number(q.T) || 0, P: Number(q.P) || 0, S: 0
        })
      }
    } catch { /* 3D 页未挂载 */ }
    for (const c of CONST_PRESETS) {
      out.push({
        key: 'preset:' + c.key, group: '内置预设', label: c.label,
        incl: Number(c.p.incl) || 0, perigeeKm: Number(c.p.perigeeKm) || 0,
        apogeeKm: Number(c.p.apogeeKm) || Number(c.p.perigeeKm) || 0, shape: c.p.shape || 'circ',
        T: Number(c.p.T) || 0, P: Number(c.p.P) || 0
      })
    }
    return out
  })

  /** 把星座导成一条【壳层】记录。只导轨道——EIRP/波束数/方向图星座数据里没有。 */
  function importShell(key) {
    const s = constSources.value.find((x) => x.key === key)
    if (!s) { msg.value = '请先选择星座'; return false }
    if (s.shape === 'ellip' && s.apogeeKm !== s.perigeeKm) {
      msg.value = `「${s.label}」是椭圆轨道（${s.perigeeKm}~${s.apogeeKm} km），本版只支持圆轨道`
      return false
    }
    if (!(s.perigeeKm > 0)) { msg.value = `「${s.label}」没有可用的轨道高度`; return false }
    const it = newShell({
      source: key.startsWith('cc:') ? 'custom' : 'preset',
      altKm: Math.round(s.perigeeKm * 100) / 100,
      inclDeg: Math.round(s.incl * 100) / 100,
      raanCount: s.P || 1,
      satsPerPlane: s.P > 0 ? Math.round((s.T || 0) / s.P) : (s.T || 1)
    })
    it.name = autoNameShell(it)
    doc.shells.push(it)
    msg.value = `已导入壳层「${it.name}」。载荷（EIRP / 波束数 / 方向图）需另行在载荷库填写`
    return it.id
  }

  // ---- 轻可视化 -----------------------------------------------------------
  const VW = 232, VH = 76, PAD = 4
  function toPath(pts) {
    if (!pts || pts.length < 2) return null
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (const [x, y] of pts) {
      if (x < x0) x0 = x; if (x > x1) x1 = x
      if (y < y0) y0 = y; if (y > y1) y1 = y
    }
    const dx = x1 - x0 || 1, dy = y1 - y0 || 1
    const sx = (x) => PAD + ((x - x0) / dx) * (VW - 2 * PAD)
    const sy = (y) => VH - PAD - ((y - y0) / dy) * (VH - 2 * PAD)
    let d = ''
    for (let i = 0; i < pts.length; i++) d += (i ? 'L' : 'M') + sx(pts[i][0]).toFixed(1) + ' ' + sy(pts[i][1]).toFixed(1)
    return { d, x0, x1, y0, y1, w: VW, h: VH }
  }
  const focusRow = computed(() => byId(doc.rows, lastRowId.value) || doc.rows.find((r) => r.result) || null)
  const patternPath = computed(() => {
    const m = focusRow.value && focusRow.value.result
    return m && m.preview ? toPath(m.preview.pattern) : null
  })
  const profilePath = computed(() => {
    const m = focusRow.value && focusRow.value.result
    return m && m.preview ? toPath(m.preview.profile) : null
  })
  const profileNote = computed(() => {
    const m = focusRow.value && focusRow.value.result
    return m && m.preview ? `纬度 ${m.preview.profileLat.toFixed(2)}° · 方位 ${m.preview.profileAz.toFixed(2)}°` : ''
  })

  return {
    doc, busy, msg, msgLevel, errors, warnings,
    lastXml, lastFiles, lastOpFiles, lastRowId, lastDiscretion,
    exportMode, exportFileList, EXPORT_MODES,
    DIRECTIONS, REF_BW, PATTERN_SECTIONS, LN_VALUES, BEAM_LAYOUTS, ES_PATTERNS, EXCLUSION_OBSERVANCE,
    libAdd, libRemove, libDup, byId,
    rowAdd, rowRemove, rowsFromCross, nextFreeMaskId, dupMaskIds, activeRows,
    generateAll, saveMasks, saveArchive, preflight,
    constSources, importShell,
    focusRow, patternPath, profilePath, profileNote
  }
}
