<script setup>
// PFD EIRP Mask 生成器（ITU-R S.1503）—— 独立计算窗口
//
// 三种掩模各占一个页签，各自独立的参数界面；第四个页签是系统运行参数（进 SRS，不进掩模文件）。
// 术语一律用申报口径，不用内部代号。
import { ref, reactive, computed, watch } from 'vue'
import ActivationLock from '../components/ActivationLock.vue'
import Icon from '../components/Icon.vue'
import {
  DIRECTIONS, REF_BW, PATTERN_SECTIONS, LN_VALUES, BEAM_LAYOUTS, ES_PATTERNS, EXPORT_MODES, SAT_PATTERNS
} from '../viz/pfd/useMaskWorkbench.js'
import { CONST_PRESETS } from '../viz/constellation/walker.js'

const STORE_KEY = 'pfd-mask-window-v1'

/** 四个页签。前三个各产出一份掩模文件，第四个产出运行参数文件。 */
const TABS = [
  { v: 'down', label: '下行 PFD 掩模', el: 'pfd_mask', hint: '空间站向地面辐射的功率通量密度上包络，用于 epfd(下行) 审查' },
  { v: 'is', label: '星间 EIRP 掩模', el: 'eirp_mask_ss', hint: '空间站朝 GSO 弧方向的等效全向辐射功率上包络，用于 epfd(星间) 审查' },
  { v: 'up', label: '上行 EIRP 掩模', el: 'eirp_mask_es', hint: '地球站朝 GSO 弧方向的等效全向辐射功率上包络，用于 epfd(上行) 审查' },
  { v: 'op', label: '系统运行参数', el: 'non_gso_operating_parameters', hint: 'GSO 弧规避角、地球站密度、同频跟踪约束——进 SRS，不写入掩模文件' }
]
const tab = ref('down')
const curTab = computed(() => TABS.find((t) => t.v === tab.value))

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const g = reactive({
  satName: 'Test Ku', ntcId: 1,
  lowFreqGhz: 10.7, highFreqGhz: 12.75,
  altKm: 900, inclDeg: 55, minElevDeg: 20, latStepDeg: 5
})

const down = reactive({
  on: true, maskId: 1, refBwKhz: 40,
  eirpDbwPerRefBw: -5,
  patternKind: 's1528',
  patternSection: '1.2', peakGainDbi: 32, psibDeg: 1, Ln: -25,
  patternMode: 'LEO', dOverLambda: 22.6, farOutDbi: 0,
  dishSizeM: 0.6, efficiency: 0.6, nullFloorDb: -40,
  beamwidth1Deg: 2, gainFloor1Db: -30, beamwidth2Deg: 20, gainFloor2Db: -40,
  nco: 50, beamMinSepDeg: 5, beamLayout: 'hex-ring',
  powerControl: true, powerControlKappa: 1,
  maskAlpha0Deg: 20,
  gridPoints: 60,
  marginDb: 1, noEmissionDb: -999, unresolvedDb: -170
})

const is = reactive({
  on: true, maskId: 2,
  sepStepDeg: 2, marginDb: 1
})

const up = reactive({
  on: true, maskId: 3, refBwKhz: 40,
  esType: 'typical', esId: -1,
  patternStandard: 'S.580-6', diameterM: 1.2, efficiency: 0.65,
  eirpDbwPerRefBw: 20, arrayElements: 64, scanAnglesDeg: '',
  sepStepDeg: 2, marginDb: 1
})

const op = reactive({
  on: true, paramId: 1,
  alpha0Deg: 15,
  esDensityPerKm2: 1e-5, esDistanceKm: 200,
  maxCoFreq: 1, maxCoFreqSat: 1,
  minAngleAtEsDeg: 0, minAngleAtSatDeg: 0,
  minDurationSec: null,
  esLatMin: -90, esLatMax: 90
})

const exportMode = ref('per-mask')
const constPick = ref('')

// 持久化
try {
  const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null')
  if (s && typeof s === 'object') {
    for (const [k, v] of [['g', g], ['down', down], ['is', is], ['up', up], ['op', op]]) {
      if (s[k]) for (const kk of Object.keys(v)) if (s[k][kk] !== undefined) v[kk] = s[k][kk]
    }
    if (s.exportMode) exportMode.value = s.exportMode
  }
} catch { /* ignore */ }
watch([g, down, is, up, op, exportMode], () => {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ g, down, is, up, op, exportMode: exportMode.value })) } catch { /* ignore */ }
}, { deep: true })

// ---------------------------------------------------------------------------
// 计算
// ---------------------------------------------------------------------------
const busy = ref(false)
const msg = ref('')
const msgBad = ref(false)
const problems = ref([])
const warns = ref([])
const results = reactive({ down: null, is: null, up: null })
const files = ref([])
const opFiles = ref([])

const latMax = computed(() => {
  const i = Math.abs(Number(g.inclDeg)) % 360
  const ii = i > 180 ? 360 - i : i
  return Math.min(ii, 180 - ii)
})
const latCount = computed(() => 2 * Math.max(1, Math.round(latMax.value / (Number(g.latStepDeg) || 5))) + 1)
const cellCount = computed(() => latCount.value * down.gridPoints * down.gridPoints)

/** 当前方向图的能力声明——字段显隐直接读它，新增方向图不必改模板。 */
const curPat = computed(() => SAT_PATTERNS.find((x) => x.v === down.patternKind) || SAT_PATTERNS[2])
const patNeeds = (f) => curPat.value.needs.includes(f)
/** 理论抛物面的增益是派生量，不是输入。 */
const derivedPeakGain = computed(() => {
  if (down.patternKind !== 'parabolic') return null
  const lam = 0.299792458 / ((Number(g.lowFreqGhz) + Number(g.highFreqGhz)) / 2)
  const D = Number(down.dishSizeM), e = Number(down.efficiency)
  if (!(D > 0) || !(e > 0) || !(lam > 0)) return null
  return 10 * Math.log10(e * Math.pow(Math.PI * D / lam, 2))
})

/** 频段允许的参考带宽：星间恒 40 kHz（XSD 无该属性）；上行不含 1 MHz（XSD 枚举）。 */
const refBwUp = computed(() => REF_BW.filter((o) => o.v !== 1000))

// 单位标注一律写成 dBW/40 kHz 这种能直接读出口径的形式，跟着各页的下拉走。
const bwLabel = (khz) => (REF_BW.find((o) => o.v === Number(khz)) || {}).label || `${Number(khz) || 0} kHz`
const downBw = computed(() => bwLabel(down.refBwKhz))
const upBw = computed(() => bwLabel(up.refBwKhz))
/** 星间掩模落盘后一律按 40 kHz 解释，下行页填的 EIRP 谱密度若不是这个口径，差值就是这么多 dB。 */
const ssBwOffsetDb = computed(() => {
  const b = Number(down.refBwKhz)
  return b > 0 && b !== 40 ? 10 * Math.log10(40 / b) : 0
})

function check() {
  const bad = []
  const n = String(g.satName || '').length
  if (n < 1 || n > 20) bad.push(`卫星名称 ${n} 个字符，ITU 掩模文件要求 1–20`)
  if (!(Number(g.ntcId) >= 1)) bad.push('ITU 通知号须为不小于 1 的整数')
  if (!(Number(g.highFreqGhz) > Number(g.lowFreqGhz))) bad.push('频段上限必须大于下限')
  if (!(Number(g.altKm) > 0)) bad.push('卫星高度须为正数')
  if (!(Number(g.minElevDeg) >= 0 && Number(g.minElevDeg) < 90)) bad.push('最小工作仰角须在 0–90° 之间')
  const ids = []
  for (const [k, o] of [['下行 PFD 掩模', down], ['星间 EIRP 掩模', is], ['上行 EIRP 掩模', up]]) {
    if (!o.on) continue
    const id = Number(o.maskId)
    if (!(id >= 1 && id <= 999)) bad.push(`${k}：掩模编号须在 1–999 之间`)
    if (ids.includes(id)) bad.push(`掩模编号 ${id} 重复——三种掩模共用同一套 1–999 编号，不得重号`)
    ids.push(id)
  }
  if (up.on && ![4, 40].includes(Number(up.refBwKhz))) {
    bad.push('上行 EIRP 掩模的参考带宽只能取 4 kHz 或 40 kHz（ITU 掩模格式未提供 1 MHz 选项）')
  }
  if (!down.on && !is.on && !up.on && !op.on) bad.push('请至少启用一项输出')
  return bad
}

function jobs() {
  const base = {
    satName: String(g.satName), ntcId: Number(g.ntcId),
    lowFreqGhz: Number(g.lowFreqGhz), highFreqGhz: Number(g.highFreqGhz),
    satHeightKm: Number(g.altKm), incDeg: Number(g.inclDeg), minElevDeg: Number(g.minElevDeg),
    srsAlpha0Deg: Number(op.alpha0Deg)
  }
  const pattern = () => {
    const k = String(down.patternKind)
    const lam = 0.299792458 / ((Number(g.lowFreqGhz) + Number(g.highFreqGhz)) / 2)
    if (k === 'isoflux' || k === 'omni') return { kind: k, peakGainDbi: Number(down.peakGainDbi) }
    if (k === 'parabolic') {
      return { kind: k, diameterM: Number(down.dishSizeM), efficiency: Number(down.efficiency),
               wavelengthM: lam, nullFloorDb: Number(down.nullFloorDb) }
    }
    if (k === 'two-level') {
      return { kind: k, peakGainDbi: Number(down.peakGainDbi),
               beamwidth1Deg: Number(down.beamwidth1Deg), gainFloor1Db: Number(down.gainFloor1Db),
               beamwidth2Deg: Number(down.beamwidth2Deg), gainFloor2Db: Number(down.gainFloor2Db) }
    }
    return down.patternSection === '1.2'
      ? { kind: 's1528', section: '1.2', peakGainDbi: Number(down.peakGainDbi), psibDeg: Number(down.psibDeg), Ln: Number(down.Ln) }
      : { kind: 's1528', section: '1.3', peakGainDbi: Number(down.peakGainDbi), psibDeg: Number(down.psibDeg),
          mode: String(down.patternMode), dOverLambda: Number(down.dOverLambda), farOutDbi: Number(down.farOutDbi) }
  }
  const payload = () => ({
    maxEirpDbwPerRefBw: Number(down.eirpDbwPerRefBw),
    usePowerControl: !!down.powerControl, powerControlKappa: Number(down.powerControlKappa),
    nBeams: Number(down.nco), minAngleDeg: Number(down.beamMinSepDeg), beamLayout: String(down.beamLayout),
    pattern: pattern()
  })
  const out = []
  if (down.on) {
    out.push(Object.assign({}, base, payload(), {
      directions: { down: true }, pfdMaskId: Number(down.maskId), refBwKhz: Number(down.refBwKhz),
      maskAlpha0Deg: Number(down.maskAlpha0Deg),
      nAzElPoints: Number(down.gridPoints), latStepDeg: Number(g.latStepDeg),
      conservativeMarginDb: Number(down.marginDb),
      sentinelNoEmissionDb: Number(down.noEmissionDb), sentinelUnresolvedDb: Number(down.unresolvedDb)
    }))
  }
  if (is.on) {
    out.push(Object.assign({}, base, payload(), {
      directions: { is: true }, eirpMaskId: Number(is.maskId), refBwKhz: 40,
      maskAlpha0Deg: Number(down.maskAlpha0Deg),
      nAzElPoints: Number(down.gridPoints), latStepDeg: Number(g.latStepDeg),
      sepAngleStepDeg: Number(is.sepStepDeg), conservativeMarginDb: Number(is.marginDb)
    }))
  }
  if (up.on) {
    const lam = 0.299792458 / ((Number(g.lowFreqGhz) + Number(g.highFreqGhz)) / 2)
    const scan = String(up.scanAnglesDeg || '').split(/[,，\s]+/).map(Number).filter(Number.isFinite)
    out.push(Object.assign({}, base, {
      directions: { up: true }, eirpEsMaskId: Number(up.maskId), refBwKhz: Number(up.refBwKhz),
      esId: up.esType === 'specific' ? Number(up.esId) : -1,
      maskAlpha0Deg: Number(down.maskAlpha0Deg),
      nAzElPoints: 9, latStepDeg: Number(g.latStepDeg),
      sepAngleStepDeg: Number(up.sepStepDeg), conservativeMarginDb: Number(up.marginDb),
      nBeams: 1, minAngleDeg: 5, beamLayout: 'single', usePowerControl: false,
      maxEirpDbwPerRefBw: Number(up.eirpDbwPerRefBw),
      pattern: { section: '1.2', peakGainDbi: 0, psibDeg: 1, Ln: -25 },
      terminal: {
        kind: String(up.patternStandard), diameterM: Number(up.diameterM), wavelengthM: lam,
        efficiency: Number(up.efficiency), maxEirpDbwPerRefBw: Number(up.eirpDbwPerRefBw),
        arrayElements: Number(up.arrayElements), scanAnglesDeg: scan.length ? scan : [0]
      }
    }))
  }
  return out
}

function opParams() {
  if (!op.on) return null
  const lo = Number(op.esLatMin), hi = Number(op.esLatMax)
  const flat = (v) => [{ lat: lo, value: v }, { lat: hi, value: v }]
  const elev = (lat) => ({ lat, byAz: [{ az: 0, value: Number(g.minElevDeg) }, { az: 360, value: Number(g.minElevDeg) }] })
  return {
    paramId: Number(op.paramId),
    lowFreqMhz: Number(g.lowFreqGhz) * 1000, highFreqMhz: Number(g.highFreqGhz) * 1000,
    esLatMin: lo, esLatMax: hi,
    esDensity: Number(op.esDensityPerKm2), esDistanceKm: Number(op.esDistanceKm),
    minAngleAtEsDeg: Number(op.minAngleAtEsDeg), minAngleAtSatDeg: Number(op.minAngleAtSatDeg),
    maxCoFreqSat: Number(op.maxCoFreqSat), esType: up.esType,
    minExclude: [{ orbId: 0, byLat: flat(Number(op.alpha0Deg)) }],
    minElev: [elev(lo), elev(hi)],
    maxCoFreq: flat(Number(op.maxCoFreq)),
    minDuration: Number(op.minDurationSec) >= 1 ? flat(Number(op.minDurationSec)) : []
  }
}

async function generate() {
  const bad = check()
  problems.value = bad
  if (bad.length) { msg.value = `${bad.length} 处参数需先修正`; msgBad.value = true; return }
  busy.value = true; msg.value = '正在计算…'; msgBad.value = false
  results.down = results.is = results.up = null
  files.value = []; opFiles.value = []; warns.value = []
  try {
    const list = jobs()
    const req = JSON.parse(JSON.stringify({
      satName: g.satName, ntcId: Number(g.ntcId), specVersion: 'S.1503-4',
      jobs: list, operatingParams: opParams()
    }))
    const r = await window.api.pfdGenerate(req)
    if (!r || !r.ok) {
      msg.value = (r && r.error) || '计算失败'; msgBad.value = true
      problems.value = (r && r.errors ? r.errors.map((e) => `${e.path}：${e.message}`) : [])
        .concat((r && r.jobErrors ? r.jobErrors.filter(Boolean) : []))
      return
    }
    // 回填：jobs 顺序与启用顺序一致
    let k = 0
    if (down.on) results.down = r.metas[k++]
    if (is.on) results.is = r.metas[k++]
    if (up.on) results.up = r.metas[k++]
    files.value = (r.files && r.files[exportMode.value]) || []
    opFiles.value = r.opFiles || []
    warns.value = (r.warnings || []).map((w) => (typeof w === 'string' ? w : `${w.path}：${w.message}`))
      .concat(r.opProblems || [])
    const failed = (r.jobErrors || []).filter(Boolean)
    problems.value = failed
    msgBad.value = failed.length > 0
    const nf = files.value.length + opFiles.value.length
    msg.value = failed.length
      ? `完成 ${list.length - failed.length}/${list.length} 项，${failed.length} 项失败`
      : `计算完成，已通过 ITU 官方格式校验，共 ${nf} 个文件待输出（${r.elapsedMs} ms）`
  } catch (e) {
    msg.value = (e && e.message) || '计算失败'; msgBad.value = true
  } finally { busy.value = false }
}

async function exportPackage(withRecord) {
  if (!files.value.length && !opFiles.value.length) { msg.value = '请先计算'; msgBad.value = true; return }
  const out = files.value.map((f) => ({ filename: `Masks/${f.filename}`, text: f.xml }))
  for (const f of opFiles.value) out.push({ filename: `Masks/${f.filename}`, text: f.xml })
  if (withRecord) {
    out.push({
      filename: `${String(g.satName).replace(/[^\w.-]+/g, '_')}_生成参数记录.json`,
      text: JSON.stringify({
        说明: 'ITU-R S.1503 §E3 要求申报时连同生成软件、软件说明与参数一并提交，本文件为参数部分，可完整重现本次计算。',
        生成软件: '卫星仿真平台 · PFD EIRP Mask 生成器',
        掩模格式: 'ITU masks schema v.4.0.0.0（对应 Rec. ITU-R S.1503-2）',
        建模依据: 'Rec. ITU-R S.1503-4',
        通用参数: g, 下行PFD掩模: down, 星间EIRP掩模: is, 上行EIRP掩模: up, 系统运行参数: op
      }, null, 2)
    })
  }
  try {
    const r = await window.api.exportFiles({ dirLabel: '选择输出目录', files: out })
    if (r && r.ok) { msg.value = `已输出 ${r.written.length} 个文件到 ${r.dir}`; msgBad.value = false }
    else if (r && r.canceled) msg.value = '已取消'
    else { msg.value = (r && r.error) || '输出失败'; msgBad.value = true }
  } catch (e) { msg.value = (e && e.message) || '输出失败'; msgBad.value = true }
}

// ---------------------------------------------------------------------------
// 星座来源：五类。前两类本地直出，后三类走星历统计（复用干扰分析已有的 IPC）
//   preset:  内置 Walker 预设（参数即答案）
//   cc:      自定义星座（localStorage 存的就是 Walker 参数，直接读，不必解算星历）
//   sg:      我的卫星组（只存 NORAD 号，须由主进程按星历统计出壳层）
//   custom:  自定义星历组
//   omm:     编目星座（CelesTrak 分组）
// ---------------------------------------------------------------------------
// 「自定义星座」「我的卫星组」只存在渲染端 localStorage（主进程读不到）。
// 本窗口与主窗口同源，直接读得到——与干扰分析窗口同一路数（见 src/ci/useInterference.js:610）。
const LS = { cc: 'constellation3d/customConsts', sg: 'constellation3d/satGroups' }

const ommGroups = ref([])       // 主进程报的编目星座 / 自定义星历组
const constBusy = ref(false)
const constNote = ref('')
const ommErr = ref('')
// ★ localStorage 不是响应式的：必须显式重读，否则用户在主窗口新建星座后本窗口永远看不到
const localSrc = ref({ cc: [], sg: [], err: '' })

function readLocal() {
  const out = { cc: [], sg: [], err: '' }
  try {
    const cc = JSON.parse(localStorage.getItem(LS.cc) || 'null')
    if (cc && Array.isArray(cc.items)) out.cc = cc.items.filter((c) => c && c.id && c.params)
    const sg = JSON.parse(localStorage.getItem(LS.sg) || 'null')
    if (sg && Array.isArray(sg.items)) out.sg = sg.items.filter((x) => x && x.id)
  } catch (e) { out.err = (e && e.message) || String(e) }
  localSrc.value = out
}

async function loadGroupList() {
  ommErr.value = ''
  if (!window.api?.interference?.groups) { ommErr.value = '编目星座与自定义星历需在桌面客户端中运行'; return }
  try {
    const r = await window.api.interference.groups()
    if (r && r.ok) ommGroups.value = r.groups || []
    else ommErr.value = (r && r.error) || '读取星座组列表失败'
  } catch (e) { ommErr.value = (e && e.message) || String(e) }
}

function refreshSources() { readLocal(); loadGroupList() }
refreshSources()
// 回到本窗口时重读：用户很可能刚在主窗口建完星座就切回来
window.addEventListener('focus', readLocal)

const constGroups = computed(() => {
  const out = []
  const ccItems = localSrc.value.cc.map((c) => ({
    key: `cc:${c.id}`,
    text: `${c.name || '自定义星座'} · ${c.params.perigeeKm} km · ${c.params.incl}°`
  }))
  if (ccItems.length) out.push({ label: '自定义星座', items: ccItems })

  const sgItems = localSrc.value.sg.map((x) => ({
    key: `sg:${x.id}`, text: `${x.name || '卫星组'}（${(x.sats || []).length} 星）`,
    disabled: !(x.sats || []).length
  }))
  if (sgItems.length) out.push({ label: '卫星组', items: sgItems })

  const custom = ommGroups.value.filter((x) => x.kind === 'custom')
  if (custom.length) out.push({ label: '自定义星历', items: custom.map((x) => ({ key: x.key, text: `${x.label}（${x.count} 星）` })) })

  const omm = ommGroups.value.filter((x) => x.kind === 'omm')
  if (omm.length) {
    out.push({
      label: '编目星座',
      items: omm.map((x) => ({
        key: x.key,
        text: `${x.label}${x.count ? `（${x.count} 星）` : x.available ? '（未载入，可取）' : '（本地无星历）'}`,
        disabled: !x.count && !x.available
      }))
    })
  }

  out.push({
    label: '内置星座预设',
    items: CONST_PRESETS.map((c) => ({ key: `preset:${c.key}`, text: `${c.label} · ${c.p.perigeeKm} km · ${c.p.incl}°` }))
  })
  return out
})

/** 数据来源自检：分组为空时要能一眼看出是「没建过」还是「读不到」。 */
const srcDiag = computed(() => {
  const p = []
  p.push(`自定义星座 ${localSrc.value.cc.length}`)
  p.push(`卫星组 ${localSrc.value.sg.length}`)
  const c = ommGroups.value.filter((x) => x.kind === 'custom').length
  const o = ommGroups.value.filter((x) => x.kind === 'omm').length
  p.push(`自定义星历 ${c}`)
  p.push(`编目星座 ${o}`)
  let s = '本机可取：' + p.join(' · ')
  if (localSrc.value.err) s += `；读取本地星座出错：${localSrc.value.err}`
  if (ommErr.value) s += `；${ommErr.value}`
  if (!localSrc.value.cc.length && !localSrc.value.sg.length && !localSrc.value.err) {
    s += '。前两类为空说明主窗口「星座」面板里还没建过自定义星座或卫星组。'
  }
  return s
})

function applyOrbit(altKm, inclDeg, note) {
  g.altKm = Math.round(Number(altKm) * 100) / 100
  g.inclDeg = Math.round(Number(inclDeg) * 100) / 100
  constNote.value = note
  msg.value = `已取用轨道参数：高度 ${g.altKm} km、倾角 ${g.inclDeg}°`
  msgBad.value = false
}

// 星历统计出的壳层清单（仅走星历的三类来源有）。一份掩模只对应一个壳层，多壳星座要逐层各出一份，
// 所以这里必须能选——早先固定取占比最大的那一档，其余壳层用户根本够不着。
const shells = ref([])          // [{ inclDeg, altKmMed, altKmMin, altKmMax, count, strayCount }]
const shellPick = ref(0)
const constSrcNote = ref('')    // 「来源：…共 N 星。」前缀，换层时重用
const shellText = (s, i) =>
  `第 ${i + 1} 层：倾角 ${s.inclDeg}° · 高度 ${s.altKmMed} km（${s.altKmMin}–${s.altKmMax}）· ${s.count} 星`

/** 换一层：高度与倾角整取同一层，不跨层拼。 */
function applyShell(i) {
  const s = shells.value[i]
  if (!s) return
  shellPick.value = i
  const more = shells.value.length > 1 ? ' 一份掩模只对应一个壳层，其余壳层需各自单独出一份。' : ''
  applyOrbit(s.altKmMed, s.inclDeg,
    `${constSrcNote.value}本次取第 ${i + 1} 层：倾角 ${s.inclDeg}°、高度中位 ${s.altKmMed} km（实测 ${s.altKmMin}–${s.altKmMax} km，${s.count} 星）。${more}`)
}

async function importConstellation() {
  // ★ 整个函数包在 try 里：异步函数抛出的异常若无人接，浏览器只报一条 unhandled rejection，
  //   界面上表现为「点了按钮毫无反应」——比报错难查得多。任何异常都必须落到 msg 上。
  constBusy.value = true
  try {
    const key = constPick.value
    if (!key) { msg.value = '请先选择星座'; msgBad.value = true; return }
    constNote.value = ''
    shells.value = []; shellPick.value = 0; constSrcNote.value = ''

    // ① 内置预设：参数即答案
    if (key.startsWith('preset:')) {
      const c = CONST_PRESETS.find((x) => `preset:${x.key}` === key)
      if (!c) { msg.value = '该内置预设不存在'; msgBad.value = true; return }
      if (c.p.shape === 'ellip' && c.p.apogeeKm !== c.p.perigeeKm) {
        msg.value = `${c.label} 为椭圆轨道（${c.p.perigeeKm}–${c.p.apogeeKm} km），本版仅支持圆轨道`; msgBad.value = true; return
      }
      applyOrbit(c.p.perigeeKm, c.p.incl, `来源：内置预设「${c.label}」，${c.p.T} 星 / ${c.p.P} 个轨道面。`)
      return
    }

    // ② 自定义星座：localStorage 里存的就是 Walker 参数，不必解算星历
    if (key.startsWith('cc:')) {
      const it = localSrc.value.cc.find((x) => `cc:${x.id}` === key)
      if (!it || !it.params) { msg.value = '该自定义星座已不存在，请点「刷新来源」'; msgBad.value = true; return }
      const p = it.params
      if (p.shape === 'ellip' && p.apogeeKm !== p.perigeeKm) {
        msg.value = `「${it.name}」为椭圆轨道（${p.perigeeKm}–${p.apogeeKm} km），本版仅支持圆轨道`; msgBad.value = true; return
      }
      if (!(Number(p.perigeeKm) > 0)) { msg.value = `「${it.name}」没有可用的轨道高度`; msgBad.value = true; return }
      applyOrbit(p.perigeeKm, p.incl, `来源：自定义星座「${it.name}」，${p.T} 星 / ${p.P} 个轨道面。`)
      return
    }

    // ③④⑤ 其余三类都要按星历统计壳层，走主进程
    if (!window.api?.interference?.loadGroup) {
      msg.value = '该来源的星历需在桌面客户端中读取'; msgBad.value = true; return
    }
    let satIds = null
    if (key.startsWith('sg:')) {
      const it = localSrc.value.sg.find((x) => `sg:${x.id}` === key)
      if (!it) { msg.value = '该卫星组已不存在，请点「刷新来源」'; msgBad.value = true; return }
      satIds = (it.sats || []).map((s) => s && s.id).filter((x) => x != null).map(String)
      if (!satIds.length) { msg.value = `「${it.name}」为空组`; msgBad.value = true; return }
    }
    const r = await window.api.interference.loadGroup(key, false, satIds, null)
    if (!r || !r.ok) { msg.value = (r && r.error) || '读取星历失败'; msgBad.value = true; return }
    const st = r.stats
    if (!st) { msg.value = '该组未能统计出轨道参数（组内卫星的星历可能全部解析失败）'; msgBad.value = true; return }
    // ★ 高度与倾角必须整取同一个壳层：
    //   顶层的 altKmMed 是【全体】高度中位数，与某一层的倾角配在一起，得到的是一条谁都不在其上的
    //   轨道（实测 Starlink：全体中位 475 km，而 53° 层实测在 463 km、70° 层在 570 km）。
    //   壳层的倾角也是【实测中位数】而非取整箱号（OneWeb 87.9° 曾被报成 88°）。
    const list = (st.shells || []).filter((s) => s && Number(s.altKmMed) > 0)
    if (!list.length) { msg.value = '该组未能分出可用的轨道壳层'; msgBad.value = true; return }
    const miss = r.missing ? `另有 ${r.missing} 颗在编目与自定义星历里都找不到，未参与统计。` : ''
    const rest = st.count - list.reduce((a, s) => a + s.count, 0)
    const other = rest > 0 ? `另有 ${rest} 颗未归入任何一层（高度散布，多为抬轨 / 离轨在途或已退役）。` : ''
    shells.value = list
    constSrcNote.value = `来源：${r.source || key}，共 ${st.count} 星，分出 ${list.length} 个轨道壳层。${other}${miss}`
    applyShell(0)
  } catch (e) {
    msg.value = '取用轨道失败：' + ((e && e.message) || String(e))
    msgBad.value = true
  } finally { constBusy.value = false }
}

// 结果卡取当前页签
const curResult = computed(() => results[tab.value] || null)
/** 结果区跟着「算这一份时用的」带宽走，不跟输入走——改了下拉还没重算时，数值与单位才不会对不上。 */
const resultBw = computed(() => (curResult.value ? bwLabel(curResult.value.refBwKhz) : ''))
</script>

<template>
  <div class="pw">
    <ActivationLock />
    <!-- 顶部：申报标识 + 通用参数 -->
    <header class="pw-hd">
      <div class="pw-title"><Icon name="table" :size="16" /><span>PFD EIRP Mask 生成器</span><s>ITU-R S.1503</s></div>
      <div class="pw-gf">
        <label>卫星名称</label>
        <input class="pi w120" type="text" v-model="g.satName" :class="{ bad: String(g.satName || '').length > 20 || !String(g.satName || '').length }" />
        <span class="pu">{{ String(g.satName || '').length }}/20</span>
        <label>ITU 通知号</label><input class="pi w90" type="number" min="1" step="1" v-model.number="g.ntcId" />
        <label>频段</label>
        <input class="pi w70" type="number" step="any" v-model.number="g.lowFreqGhz" /><span class="pu">–</span>
        <input class="pi w70" type="number" step="any" v-model.number="g.highFreqGhz" /><span class="pu">GHz</span>
      </div>
    </header>

    <!-- 轨道与工作条件：三种掩模共用（纬度轴、视场半张角都由它定），故置于页签之上 -->
    <section class="pw-common">
      <div class="pw-r">
        <label>取用星座</label>
        <select class="w280" v-model="constPick" :disabled="constBusy">
          <option value="">（选择星座…）</option>
          <optgroup v-for="grp in constGroups" :key="grp.label" :label="grp.label">
            <option v-for="c in grp.items" :key="c.key" :value="c.key" :disabled="c.disabled">{{ c.text }}</option>
          </optgroup>
        </select>
        <button class="pb sm" :disabled="!constPick || constBusy" @click="importConstellation">{{ constBusy ? '读取中…' : '取用轨道' }}</button>
        <button class="pb sm" :disabled="constBusy" title="重新读取主窗口里的自定义星座与卫星组" @click="refreshSources">刷新来源</button>
      </div>
      <p class="pw-src" :class="{ bad: localSrc.err || ommErr }">{{ srcDiag }}</p>
      <!-- 多壳星座：一份掩模只对应一个壳层，选哪一层由用户定，不替他挑 -->
      <div class="pw-r" v-if="shells.length > 1">
        <label>轨道壳层</label>
        <select class="w360" :value="shellPick" @change="applyShell(Number($event.target.value))">
          <option v-for="(s, i) in shells" :key="i" :value="i">{{ shellText(s, i) }}</option>
        </select>
        <em>该星座分出 {{ shells.length }} 层</em>
      </div>
      <div class="pw-r">
        <label>卫星高度</label><input class="pi w90" type="number" step="any" v-model.number="g.altKm" /><span class="pu">km</span>
        <label>轨道倾角</label><input class="pi w90" type="number" step="any" v-model.number="g.inclDeg" /><span class="pu">°</span>
        <label>最小工作仰角</label><input class="pi w90" type="number" step="any" v-model.number="g.minElevDeg" /><span class="pu">°</span>
        <label>星下点纬度步长</label><input class="pi w80" type="number" step="any" v-model.number="g.latStepDeg" /><span class="pu">°</span>
        <em>纬度范围 ±{{ latMax.toFixed(1) }}°，共 {{ latCount }} 张切片</em>
      </div>
      <p v-if="constNote" class="pw-note">{{ constNote }}</p>
    </section>

    <!-- 页签 -->
    <nav class="pw-tabs">
      <button v-for="t in TABS" :key="t.v" class="pw-tab" :class="{ on: tab === t.v }" :title="t.hint" @click="tab = t.v">
        {{ t.label }}<code>{{ t.el }}</code>
      </button>
    </nav>

    <div class="pw-body">
      <!-- 左：参数 -->
      <section class="pw-main">
        <!-- ── 下行 PFD 掩模 ── -->
        <template v-if="tab === 'down'">
          <label class="pw-en"><input type="checkbox" v-model="down.on" /><span>输出本掩模</span></label>
          <div class="pw-grp"><h3>掩模标识</h3>
            <div class="pw-r"><label>掩模编号</label><input class="pi w80" type="number" min="1" max="999" v-model.number="down.maskId" /></div>
            <div class="pw-r"><label>参考带宽</label>
              <select v-model.number="down.refBwKhz"><option v-for="o in REF_BW" :key="o.v" :value="o.v">{{ o.label }}</option></select></div>
          </div>

          <div class="pw-grp"><h3>星上载荷</h3>
            <div class="pw-r"><label>单波束最大 EIRP 谱密度</label><input class="pi w90" type="number" step="any" v-model.number="down.eirpDbwPerRefBw" /><span class="pu">dBW/{{ downBw }}</span></div>
            <div class="pw-r"><label>天线方向图</label>
              <select class="w280" v-model="down.patternKind">
                <option v-for="o in SAT_PATTERNS" :key="o.v" :value="o.v">{{ o.label }}</option>
              </select>
              <em v-if="!curPat.steerable">固定指向</em></div>

            <!-- 增益：抛物面由口径派生，其余为输入 -->
            <div class="pw-r" v-if="patNeeds('peakGainDbi')">
              <label>{{ curPat.steerable ? '主轴增益' : '天底方向增益' }}</label>
              <input class="pi w90" type="number" step="any" v-model.number="down.peakGainDbi" /><span class="pu">dBi</span></div>
            <div class="pw-r" v-if="patNeeds('diameterM')"><label>天线口径</label>
              <input class="pi w90" type="number" step="any" v-model.number="down.dishSizeM" /><span class="pu">m</span>
              <label>效率</label><input class="pi w70" type="number" step="any" v-model.number="down.efficiency" />
              <em v-if="derivedPeakGain !== null">主轴增益 {{ derivedPeakGain.toFixed(2) }} dBi</em></div>
            <div class="pw-r" v-if="patNeeds('nullFloorDb')"><label>零点下界</label>
              <input class="pi w90" type="number" step="any" v-model.number="down.nullFloorDb" /><span class="pu">dB</span></div>

            <!-- S.1528 专有 -->
            <template v-if="patNeeds('section')">
              <div class="pw-r"><label>参考图节次</label>
                <select class="w220" v-model="down.patternSection"><option v-for="o in PATTERN_SECTIONS" :key="o.v" :value="o.v">{{ o.label }}</option></select></div>
              <div class="pw-r"><label>3 dB 半波束宽度</label><input class="pi w90" type="number" step="any" v-model.number="down.psibDeg" /><span class="pu">°</span></div>
              <div class="pw-r" v-if="down.patternSection === '1.2'"><label>近区旁瓣电平</label>
                <select v-model.number="down.Ln"><option v-for="o in LN_VALUES" :key="o.v" :value="o.v">{{ o.label }}</option></select></div>
              <template v-if="down.patternSection === '1.3'">
                <div class="pw-r"><label>轨道类别</label>
                  <span class="pseg"><span :class="{ on: down.patternMode === 'LEO' }" @click="down.patternMode = 'LEO'">LEO</span><span :class="{ on: down.patternMode === 'MEO' }" @click="down.patternMode = 'MEO'">MEO</span></span></div>
                <div class="pw-r"><label>口径波长比 D/λ</label><input class="pi w90" type="number" step="any" v-model.number="down.dOverLambda" /></div>
                <div class="pw-r"><label>远区旁瓣电平</label><input class="pi w90" type="number" step="any" v-model.number="down.farOutDbi" /><span class="pu">dBi</span></div>
              </template>
            </template>

            <!-- 两级带底 -->
            <template v-if="patNeeds('beamwidth1Deg')">
              <div class="pw-r"><label>主瓣宽度（3 dB）</label><input class="pi w90" type="number" step="any" v-model.number="down.beamwidth1Deg" /><span class="pu">°</span>
                <label>第一级底</label><input class="pi w80" type="number" step="any" v-model.number="down.gainFloor1Db" /><span class="pu">dB</span></div>
              <div class="pw-r"><label>第二级起始宽度</label><input class="pi w90" type="number" step="any" v-model.number="down.beamwidth2Deg" /><span class="pu">°</span>
                <label>第二级底</label><input class="pi w80" type="number" step="any" v-model.number="down.gainFloor2Db" /><span class="pu">dB</span></div>
            </template>
          </div>

          <div class="pw-grp"><h3>多波束</h3>
            <div class="pw-r"><label title="ITU-R S.1503 记作 Nco">同频同时工作波束数</label><input class="pi w90" type="number" min="1" step="1" v-model.number="down.nco" /></div>
            <div class="pw-r"><label>波束间最小间隔角</label><input class="pi w90" type="number" step="any" v-model.number="down.beamMinSepDeg" /><span class="pu">°</span></div>
            <div class="pw-r"><label>波束排布假设</label>
              <select class="w260" v-model="down.beamLayout"><option v-for="o in BEAM_LAYOUTS" :key="o.v" :value="o.v">{{ o.label }}</option></select></div>
            <p v-if="down.beamLayout === 'single'" class="pw-note bad">「仅主波束」会低估多波束叠加，掩模仅供对照。</p>
          </div>

          <div class="pw-grp"><h3>上行功率控制</h3>
            <label class="pw-en"><input type="checkbox" v-model="down.powerControl" /><span>启用功率控制</span></label>
            <div class="pw-r" v-if="down.powerControl"><label>补偿系数</label>
              <input type="range" min="0" max="1" step="0.05" v-model.number="down.powerControlKappa" /><span class="pu">{{ Number(down.powerControlKappa).toFixed(2) }}</span></div>
          </div>

          <div class="pw-grp"><h3>GSO 弧规避</h3>
            <div class="pw-r"><label>掩模用规避角</label><input class="pi w90" type="number" step="any" v-model.number="down.maskAlpha0Deg" /><span class="pu">°</span></div>
          </div>

          <div class="pw-grp"><h3>计算设置</h3>
            <div class="pw-r"><label>方位 / 仰角采样点数</label><input class="pi w80" type="number" min="2" max="200" step="1" v-model.number="down.gridPoints" /><span class="pu">点/轴</span><em>共 {{ latCount }} 张纬度切片，{{ cellCount.toLocaleString() }} 个网格点</em></div>
            <div class="pw-r"><label>保守余量</label><input class="pi w80" type="number" min="0" step="any" v-model.number="down.marginDb" /><span class="pu">dB</span></div>
            <div class="pw-r"><label>不发射区填充值</label><input class="pi w90" type="number" step="any" v-model.number="down.noEmissionDb" /><span class="pu">dBW/m²/{{ downBw }}</span></div>
            <div class="pw-r"><label>几何无解填充值</label><input class="pi w90" type="number" step="any" v-model.number="down.unresolvedDb" /><span class="pu">dBW/m²/{{ downBw }}</span></div>
          </div>
        </template>

        <!-- ── 星间 EIRP 掩模 ── -->
        <template v-else-if="tab === 'is'">
          <label class="pw-en"><input type="checkbox" v-model="is.on" /><span>输出本掩模</span></label>
          <div class="pw-grp"><h3>掩模标识</h3>
            <div class="pw-r"><label>掩模编号</label><input class="pi w80" type="number" min="1" max="999" v-model.number="is.maskId" /></div>
            <div class="pw-r"><label>参考带宽</label><input class="pi w80" type="text" value="40 kHz" disabled /></div>
          </div>
          <div class="pw-grp"><h3>自变量</h3>
            <div class="pw-r"><label>角度采样步长</label><input class="pi w80" type="number" min="0.5" max="30" step="any" v-model.number="is.sepStepDeg" /><span class="pu">°</span></div>
            <div class="pw-r"><label>保守余量</label><input class="pi w80" type="number" min="0" step="any" v-model.number="is.marginDb" /><span class="pu">dB</span></div>
          </div>
          <div class="pw-grp"><h3>取用参数</h3>
            <div class="pw-r"><label>卫星高度</label><span class="pv">{{ g.altKm }} km</span><label>轨道倾角</label><span class="pv">{{ g.inclDeg }}°</span></div>
            <div class="pw-r"><label>单波束最大 EIRP 谱密度</label><span class="pv">{{ down.eirpDbwPerRefBw }} dBW/{{ downBw }}</span>
              <em v-if="ssBwOffsetDb">折合 {{ (Number(down.eirpDbwPerRefBw) + ssBwOffsetDb).toFixed(2) }} dBW/40 kHz</em></div>
            <p class="pw-note bad" v-if="ssBwOffsetDb" title="改用 40 kHz 参考带宽，或按折合值重填单波束 EIRP 谱密度">下行页参考带宽为 {{ downBw }}，本掩模按 40 kHz 落盘：偏{{ ssBwOffsetDb > 0 ? '低' : '高' }} {{ Math.abs(ssBwOffsetDb).toFixed(2) }} dB。</p>
            <div class="pw-r"><label>同频同时工作波束数</label><span class="pv">{{ down.nco }}</span>
              <label>天线方向图</label><span class="pv">{{ curPat.label }}</span></div>
          </div>
        </template>

        <!-- ── 上行 EIRP 掩模 ── -->
        <template v-else-if="tab === 'up'">
          <label class="pw-en"><input type="checkbox" v-model="up.on" /><span>输出本掩模</span></label>
          <div class="pw-grp"><h3>掩模标识</h3>
            <div class="pw-r"><label>掩模编号</label><input class="pi w80" type="number" min="1" max="999" v-model.number="up.maskId" /></div>
            <div class="pw-r"><label>参考带宽</label>
              <select v-model.number="up.refBwKhz"><option v-for="o in refBwUp" :key="o.v" :value="o.v">{{ o.label }}</option></select></div>
          </div>
          <div class="pw-grp"><h3>地球站</h3>
            <div class="pw-r"><label>站型</label>
              <span class="pseg"><span :class="{ on: up.esType === 'typical' }" @click="up.esType = 'typical'">典型站</span><span :class="{ on: up.esType === 'specific' }" @click="up.esType = 'specific'">特定站</span></span></div>
            <div class="pw-r" v-if="up.esType === 'specific'"><label>SNS 序号</label><input class="pi w110" type="number" min="0" step="1" v-model.number="up.esId" /></div>
            <div class="pw-r"><label>天线方向图</label>
              <select class="w240" v-model="up.patternStandard"><option v-for="o in ES_PATTERNS" :key="o.v" :value="o.v">{{ o.label }}</option></select></div>
            <div class="pw-r"><label>天线口径</label><input class="pi w80" type="number" step="any" v-model.number="up.diameterM" /><span class="pu">m</span>
              <label>效率</label><input class="pi w70" type="number" step="any" v-model.number="up.efficiency" /></div>
            <div class="pw-r"><label>最大 EIRP 谱密度</label><input class="pi w90" type="number" step="any" v-model.number="up.eirpDbwPerRefBw" /><span class="pu">dBW/{{ upBw }}</span></div>
            <template v-if="up.patternStandard === 'M.2101'">
              <div class="pw-r"><label>阵元数</label><input class="pi w80" type="number" min="1" step="1" v-model.number="up.arrayElements" /></div>
              <div class="pw-r"><label>扫描角序列</label><input class="pi w180" type="text" v-model="up.scanAnglesDeg" placeholder="0, 15, 30, 45" /><span class="pu">°</span></div>
            </template>
          </div>
          <div class="pw-grp"><h3>自变量与计算</h3>
            <div class="pw-r"><label>角度采样步长</label><input class="pi w80" type="number" min="0.5" max="30" step="any" v-model.number="up.sepStepDeg" /><span class="pu">°</span></div>
            <div class="pw-r"><label>保守余量</label><input class="pi w80" type="number" min="0" step="any" v-model.number="up.marginDb" /><span class="pu">dB</span></div>
          </div>
        </template>

        <!-- ── 系统运行参数 ── -->
        <template v-else>
          <label class="pw-en"><input type="checkbox" v-model="op.on" /><span>输出运行参数文件</span></label>
          <div class="pw-grp"><h3>标识</h3>
            <div class="pw-r"><label>参数集编号</label><input class="pi w80" type="number" min="1" step="1" v-model.number="op.paramId" /></div>
          </div>
          <div class="pw-grp"><h3>GSO 弧规避</h3>
            <div class="pw-r"><label>系统规避角</label><input class="pi w90" type="number" step="any" v-model.number="op.alpha0Deg" /><span class="pu">°</span></div>
          </div>
          <div class="pw-grp"><h3>地球站布设</h3>
            <div class="pw-r"><label>地球站密度</label><input class="pi w110" type="number" step="any" v-model.number="op.esDensityPerKm2" /><span class="pu">站/km²</span></div>
            <div class="pw-r"><label>同频站平均间距</label><input class="pi w90" type="number" step="any" v-model.number="op.esDistanceKm" /><span class="pu">km</span></div>
            <div class="pw-r"><label>纬度范围</label><input class="pi w80" type="number" step="any" v-model.number="op.esLatMin" /><span class="pu">–</span>
              <input class="pi w80" type="number" step="any" v-model.number="op.esLatMax" /><span class="pu">°</span></div>
          </div>
          <div class="pw-grp"><h3>同频跟踪约束</h3>
            <div class="pw-r"><label>单站同频跟踪卫星数上限</label><input class="pi w80" type="number" min="0" step="1" v-model.number="op.maxCoFreq" /></div>
            <div class="pw-r"><label>单星同频接收地球站数上限</label><input class="pi w80" type="number" min="0" step="1" v-model.number="op.maxCoFreqSat" /></div>
            <div class="pw-r"><label>地球站侧最小夹角</label><input class="pi w80" type="number" min="0" step="any" v-model.number="op.minAngleAtEsDeg" /><span class="pu">°</span></div>
            <div class="pw-r"><label>卫星侧最小夹角</label><input class="pi w80" type="number" min="0" step="any" v-model.number="op.minAngleAtSatDeg" /><span class="pu">°</span></div>
            <div class="pw-r"><label>最短切换驻留时间</label><input class="pi w80" type="number" min="1" step="any" v-model.number="op.minDurationSec" placeholder="不设" /><span class="pu">s</span></div>
          </div>
        </template>
      </section>

      <!-- 右：结果 -->
      <aside class="pw-side">
        <h3>计算结果</h3>
        <div v-if="!curResult && tab !== 'op'" class="pw-empty">尚未计算，或本页掩模未启用。</div>
        <div v-else-if="tab === 'op'" class="pw-empty">无计算结果。</div>
        <template v-else>
          <dl class="pw-kv">
            <dt title="ITU 掩模查看器显示为「masks」，即切片数，非掩模份数">纬度切片</dt><dd>{{ curResult.latCount }} 张</dd>
            <dt>星下点纬度范围</dt><dd>±{{ curResult.latMaxDeg.toFixed(1) }}°</dd>
            <dt>星下视场半张角</dt><dd>{{ curResult.rho0Deg.toFixed(2) }}°</dd>
            <template v-if="tab === 'down' && curResult.stat">
              <dt>实算网格</dt><dd>{{ curResult.stat.computed.toLocaleString() }} / {{ curResult.stat.cells.toLocaleString() }}</dd>
              <dt>不发射（低仰角）</dt><dd>{{ curResult.stat.sentinelLowElev.toLocaleString() }}</dd>
              <dt>不发射（GSO 弧规避）</dt><dd>{{ curResult.stat.sentinelAlpha.toLocaleString() }}</dd>
              <dt>几何无解</dt><dd>{{ curResult.stat.sentinelOutOfView.toLocaleString() }}</dd>
              <dt>PFD 范围</dt><dd v-if="curResult.minValueDb !== null">{{ curResult.minValueDb.toFixed(2) }} … {{ curResult.maxValueDb.toFixed(2) }} dBW/m²/{{ resultBw }}</dd><dd v-else>—</dd>
              <dt>多波束聚合增益</dt><dd>+{{ curResult.aggregateGainOverPeakDb.toFixed(2) }} dB</dd>
              <dt>功率控制跨度</dt><dd>{{ curResult.powerControlSpanDb.toFixed(2) }} dB</dd>
            </template>
            <template v-if="tab === 'is' && curResult.eirpSs">
              <dt>角度采样</dt><dd>{{ curResult.eirpSs.axisCount }} 点（步长 {{ curResult.eirpSs.sepAngleStepDeg }}°）</dd>
              <dt>EIRP 范围</dt><dd>{{ curResult.eirpSs.minValueDb.toFixed(2) }} … {{ curResult.eirpSs.maxValueDb.toFixed(2) }} dBW/{{ resultBw }}</dd>
              <dt>多波束聚合抬升</dt><dd>天底 +{{ curResult.eirpSs.aggLiftNadirDb.toFixed(2) }} dB → 远区 +{{ curResult.eirpSs.aggLiftFarDb.toFixed(2) }} dB<s>{{ curResult.eirpSs.nBeams }} 波束，上限 10lg(Nco) = {{ (10 * Math.log10(curResult.eirpSs.nBeams)).toFixed(2) }} dB</s></dd>
              <dt>单调化抬升</dt><dd>{{ curResult.eirpSs.monotoneLift.maxDb.toFixed(2) }} dB（{{ curResult.eirpSs.monotoneLift.count }} 点）</dd>
            </template>
            <template v-if="tab === 'up' && curResult.eirpEs">
              <dt>方向图</dt><dd>{{ curResult.eirpEs.patternKind }}<s>主轴 {{ curResult.eirpEs.peakGainDbi.toFixed(2) }} dBi</s></dd>
              <dt>角度采样</dt><dd>{{ curResult.eirpEs.axisCount }} 点（步长 {{ curResult.eirpEs.sepAngleStepDeg }}°）</dd>
              <dt>EIRP 范围</dt><dd>{{ curResult.eirpEs.minValueDb.toFixed(2) }} … {{ curResult.eirpEs.maxValueDb.toFixed(2) }} dBW/{{ resultBw }}</dd>
              <dt>单调化抬升</dt><dd>{{ curResult.eirpEs.monotoneLift.maxDb.toFixed(2) }} dB（{{ curResult.eirpEs.monotoneLift.count }} 点）</dd>
              <dt v-if="curResult.eirpEs.scanCount > 1">扫描角降维损失</dt>
              <dd v-if="curResult.eirpEs.scanCount > 1">{{ curResult.eirpEs.dimReductionLossDb.toFixed(2) }} dB（{{ curResult.eirpEs.scanCount }} 个扫描角）</dd>
            </template>
          </dl>
        </template>

        <template v-if="curResult && curResult.discretion">
          <h3>无建议书依据的取值</h3>
          <ul class="pw-disc"><li v-for="(d, i) in curResult.discretion" :key="i"><b>{{ d.field }}</b> = {{ d.value }}</li></ul>
        </template>

        <template v-if="files.length || opFiles.length">
          <h3>待输出文件</h3>
          <div class="pw-r"><label>文件划分</label>
            <select class="w240" v-model="exportMode"><option v-for="o in EXPORT_MODES" :key="o.v" :value="o.v">{{ o.label }}</option></select></div>
          <ul class="pw-files">
            <li v-for="f in files" :key="f.filename"><span>{{ f.filename }}</span><b>{{ (f.bytes / 1024).toFixed(0) }} KB</b></li>
            <li v-for="f in opFiles" :key="f.filename"><span>{{ f.filename }}</span><b>运行参数</b></li>
          </ul>
        </template>
      </aside>
    </div>

    <!-- 底栏 -->
    <footer class="pw-ft">
      <button class="pb main" :disabled="busy" @click="generate">{{ busy ? '计算中…' : '计算' }}</button>
      <button class="pb" :disabled="!files.length && !opFiles.length" @click="exportPackage(false)">输出掩模文件…</button>
      <button class="pb" :disabled="!files.length && !opFiles.length" @click="exportPackage(true)"
              title="按 S.1503 §E3，申报时须连同生成软件、软件说明与参数一并提交">输出完整提交包…</button>
      <span class="pw-msg" :class="{ bad: msgBad }">{{ msg }}</span>
    </footer>

    <div v-if="problems.length" class="pw-prob">
      <div class="pw-prob-t"><Icon name="alert-triangle" :size="12" /> {{ problems.length }} 处需要处理</div>
      <div v-for="(p, i) in problems" :key="i">{{ p }}</div>
    </div>
    <div v-if="warns.length" class="pw-warn">
      <div v-for="(w, i) in warns" :key="i">{{ w }}</div>
    </div>
  </div>
</template>

<style scoped>
.pw { display: flex; flex-direction: column; height: 100vh; background: var(--bg); color: var(--text); font-size: var(--fs-4); }
.pw-hd { display: flex; align-items: center; gap: 18px; padding: 8px 14px; border-bottom: 1px solid var(--border); flex: none; flex-wrap: wrap; }
.pw-title { display: flex; align-items: center; gap: 6px; font-size: var(--fs-5); font-weight: 600; color: var(--accent); }
.pw-title s { text-decoration: none; font-size: var(--fs-2); font-weight: 400; color: var(--text-faint); }
.pw-gf { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.pw-gf label { color: var(--text-muted); font-size: var(--fs-3); margin-left: 8px; }

.pw-common { flex: none; padding: 9px 14px 7px; border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--accent-ui) 3%, transparent); }
.pw-common .pw-r { margin-bottom: 5px; }
.pw-common .pw-r:last-of-type { margin-bottom: 0; }
.pw-common .pw-r > label { min-width: auto; margin-right: 2px; }
.pw-common .pw-r > label ~ label { margin-left: 14px; }
.pw-common .pw-note { margin-top: 5px; }
.pw-src { margin: 4px 0 0; font-size: var(--fs-2); color: var(--text-faint); }
.pw-src.bad { color: var(--danger, #c0392b); }
.w280 { width: 280px }
.w360 { width: 360px }

.pw-tabs { display: flex; gap: 2px; padding: 0 14px; border-bottom: 1px solid var(--border); flex: none; }
.pw-tab { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 7px 14px 6px; cursor: pointer;
  background: none; border: none; border-bottom: 2px solid transparent; color: var(--text-muted); font-size: var(--fs-4); }
.pw-tab code { font-size: var(--fs-1); color: var(--text-faint); font-family: var(--font-code); }
.pw-tab:hover { color: var(--text); }
.pw-tab.on { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }

.pw-body { flex: 1; display: grid; grid-template-columns: minmax(560px, 1fr) minmax(330px, 400px); min-height: 0; }
.pw-main { overflow-y: auto; padding: 14px 18px 20px; }
.pw-side { overflow-y: auto; padding: 14px 16px 20px; border-left: 1px solid var(--border); background: color-mix(in srgb, var(--text) 2%, transparent); }
.pw-side h3 { font-size: var(--fs-3); font-weight: 600; color: var(--text-muted); margin: 14px 0 6px; }
.pw-side h3:first-child { margin-top: 0; }
.pw-empty { font-size: var(--fs-3); color: var(--text-faint); padding: 10px 0; }

.pw-grp { margin-bottom: 16px; }
.pw-grp h3 { font-size: var(--fs-4); font-weight: 600; color: var(--text); margin: 0 0 7px; padding-bottom: 4px; border-bottom: 1px solid var(--border); }
.pw-r { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; }
.pw-r > label { min-width: 150px; color: var(--text-muted); font-size: var(--fs-3); }
.pw-r em { font-style: normal; font-size: var(--fs-2); color: var(--text-faint); }
.pw-en { display: inline-flex; align-items: center; gap: 5px; margin-bottom: 12px; font-size: var(--fs-4); cursor: pointer; }
.pw-note { font-size: var(--fs-3); line-height: 1.65; color: var(--text-faint); margin: 6px 0 0; padding-left: 8px; border-left: 2px solid var(--border); }
.pw-note.bad { border-left-color: var(--danger, #c0392b); color: var(--text-muted); }
.pw-note b { color: var(--text-muted); }

.pi { padding: 3px 6px; border: 1px solid var(--field-border); border-radius: var(--r-box); background: var(--field-bg); color: var(--text);
  font-family: var(--font-mono); font-size: var(--fs-3); font-variant-numeric: tabular-nums; }
.pi:disabled { opacity: 0.55; }
.pi.bad { border-color: var(--danger, #c0392b); }
.w70 { width: 70px } .w80 { width: 80px } .w90 { width: 90px } .w110 { width: 110px }
.w120 { width: 120px } .w180 { width: 180px } .w220 { width: 220px } .w240 { width: 240px } .w260 { width: 260px }
select { padding: 3px 6px; border: 1px solid var(--field-border); border-radius: var(--r-box); background-color: var(--field-bg); color: var(--text); font-size: var(--fs-3); }
.pu { font-size: var(--fs-2); color: var(--text-faint); }
.pv { font-family: var(--font-mono); font-size: var(--fs-3); color: var(--text); margin-right: 14px; }
.pseg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--r-box); overflow: hidden; }
.pseg span { padding: 3px 12px; cursor: pointer; color: var(--text-muted); font-size: var(--fs-3); }
.pseg span.on { background: var(--accent); color: var(--bg); }

.pb { height: var(--h-ctl-lg); white-space: nowrap; padding: 0 14px; border: 1px solid var(--border); border-radius: var(--r-box); background: var(--bg); color: var(--text);
  font-size: var(--fs-4); cursor: pointer; }
.pb:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.pb:disabled { opacity: 0.45; cursor: default; }
.pb.main { background: var(--accent); color: var(--bg); border-color: var(--accent); font-weight: 600; }
.pb.sm { height: var(--h-ctl); white-space: nowrap; padding: 0 10px; font-size: var(--fs-3); }

.pw-kv { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; margin: 0; font-size: var(--fs-3); }
.pw-kv dt { color: var(--text-muted); }
.pw-kv dd { margin: 0; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.pw-kv dd s { display: block; text-decoration: none; font-family: var(--font-sans); font-size: var(--fs-2); color: var(--text-faint); }
.pw-disc { margin: 0; padding-left: 16px; font-size: var(--fs-3); line-height: 1.7; color: var(--text-faint); }
.pw-disc b { color: var(--text-muted); font-family: var(--font-mono); }
.pw-files { list-style: none; margin: 4px 0 0; padding: 0; font-size: var(--fs-3); }
.pw-files li { display: flex; gap: 8px; padding: 2px 0; font-family: var(--font-mono); }
.pw-files li span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pw-files li b { margin-left: auto; color: var(--text-faint); font-weight: 400; white-space: nowrap; }

.pw-ft { display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-top: 1px solid var(--border); flex: none; }
.pw-msg { font-size: var(--fs-3); color: var(--text-muted); }
.pw-msg.bad { color: var(--danger, #c0392b); }
.pw-prob, .pw-warn { flex: none; max-height: 130px; overflow-y: auto; padding: 7px 14px; font-size: var(--fs-3); line-height: 1.6; }
.pw-prob { color: var(--danger, #c0392b); background: color-mix(in srgb, var(--danger, #c0392b) 7%, transparent); border-top: 1px solid var(--danger, #c0392b); }
.pw-prob-t { font-weight: 600; display: flex; align-items: center; gap: 4px; margin-bottom: 2px; }
.pw-warn { color: var(--text-muted); background: color-mix(in srgb, #a97c2e 8%, transparent); border-top: 1px solid #a97c2e; }
</style>
