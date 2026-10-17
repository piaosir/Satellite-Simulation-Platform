// PFD Mask 生成器的入参装配（纯函数，不依赖 Vue / window）：面板态 → 引擎 job 列表 + 输入校验。
//
// 从 PfdMaskApp.vue 拆出来，是为了让回归测试能拿真引擎跑「面板态 → 掩模频段 / 文件名 / EIRP 口径」整条链——
// 2026-10-16 体检的两处口径错都出在这一层：上行掩模用了页头的下行频段；星间掩模把 dBW/4 kHz 当 dBW/40 kHz 落盘。
// 入参的五块（g / down / is / up / op）与 PfdMaskApp 的面板态逐字同形。

const C_GHZ_M = 0.299792458   // λ(m) = C_GHZ_M / f(GHz)

/**
 * 下行频段 → 同一网络惯用的上行频段（FSS 成对频段的工程常规），按页头频段的中心频率归档（dn → up）。
 *   C    3.4–4.2 GHz   → 5.925–6.425（常规 C 频段 500 MHz）
 *   Ku   10.7–12.75    → 14.0–14.5
 *   Ka   17.3–21.2     → 27.5–30.0
 *   Q/V  37.5–42.5     → 47.2–50.2
 * upSpan 是该频段整个上行划分：页头填的本身就落在上行段里（只出上行掩模时常这么填——从前上行掩模也确实取页头），
 * 就照用页头，不再另推。两头都落不进就不推定，上行页须手填。
 */
export const UPLINK_BAND_PAIRS = [
  { dn: [3.4, 4.2], up: [5.925, 6.425], upSpan: [5.85, 7.075] },
  { dn: [10.7, 12.75], up: [14, 14.5], upSpan: [12.75, 14.8] },
  { dn: [17.3, 21.2], up: [27.5, 30], upSpan: [27, 31] },
  { dn: [37.5, 42.5], up: [47.2, 50.2], upSpan: [47.2, 51.4] }
]

/** 页头频段对应的上行频段 { lowGhz, highGhz }：下行段 → 成对的上行段；本身是上行段 → 原样；推不出给 null。 */
export function pairedUplinkBand(lowGhz, highGhz) {
  const lo = Number(lowGhz), hi = Number(highGhz)
  if (!(lo > 0) || !(hi > lo)) return null
  const f0 = (lo + hi) / 2
  const p = UPLINK_BAND_PAIRS.find((x) => f0 >= x.dn[0] && f0 <= x.dn[1])
  if (p) return { lowGhz: p.up[0], highGhz: p.up[1] }
  return UPLINK_BAND_PAIRS.some((x) => f0 >= x.upSpan[0] && f0 <= x.upSpan[1]) ? { lowGhz: lo, highGhz: hi } : null
}

const blank = (v) => v === '' || v === null || v === undefined || !Number.isFinite(Number(v))

/**
 * 上行掩模实际用的频段：上行页自己填了的端点用它，留空的端点按页头频段推定（pairedUplinkBand；老配置没有这两个字段，同样走推定）。
 * 两头都推不出时给 NaN，由 checkInputs 拦下。
 */
export function uplinkBandOf(g, up) {
  const auto = pairedUplinkBand(g && g.lowFreqGhz, g && g.highFreqGhz)
  const u = up || {}
  return {
    lowGhz: blank(u.lowFreqGhz) ? (auto ? auto.lowGhz : NaN) : Number(u.lowFreqGhz),
    highGhz: blank(u.highFreqGhz) ? (auto ? auto.highGhz : NaN) : Number(u.highFreqGhz)
  }
}

/**
 * 星间掩模恒按 40 kHz 落盘（XSD 的 eirp_mask_ss 无 refbw_khz 属性）：下行页按 b kHz 填的 EIRP 谱密度
 * 折合到 40 kHz 要加的 dB（平谱假设，+10·lg(40/b)；b = 40 时为 0）。
 */
export function ssEirpOffsetDb(refBwKhz) {
  const b = Number(refBwKhz)
  return b > 0 && b !== 40 ? 10 * Math.log10(40 / b) : 0
}

/** 输入校验：返回需修正的问题列表（空 = 可以算）。 */
export function checkInputs({ g, down, is, up, op }) {
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
    bad.push('上行 EIRP 掩模的参考带宽仅可取 4 kHz 或 40 kHz（ITU 掩模格式未提供 1 MHz 选项）')
  }
  if (up.on) {
    const ub = uplinkBandOf(g, up)
    if (!(ub.lowGhz > 0 && ub.highGhz > 0)) bad.push('上行 EIRP 掩模：未给出频段')
    else if (!(ub.highGhz > ub.lowGhz)) bad.push('上行 EIRP 掩模：频段上限必须大于下限')
  }
  if (!down.on && !is.on && !up.on && !op.on) bad.push('未启用任何输出。')
  return bad
}

/** 面板态 → 引擎 job 列表（顺序 = 下行 / 星间 / 上行里启用的那几项，结果按同一顺序回填）。全是纯数据，可直接过 IPC。 */
export function buildJobs({ g, down, is, up, op }) {
  const base = {
    satName: String(g.satName), ntcId: Number(g.ntcId),
    lowFreqGhz: Number(g.lowFreqGhz), highFreqGhz: Number(g.highFreqGhz),
    satHeightKm: Number(g.altKm), incDeg: Number(g.inclDeg), minElevDeg: Number(g.minElevDeg),
    srsAlpha0Deg: Number(op.alpha0Deg)
  }
  const pattern = () => {
    const k = String(down.patternKind)
    const lam = C_GHZ_M / ((Number(g.lowFreqGhz) + Number(g.highFreqGhz)) / 2)
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
      // ★ 星间掩模恒按 40 kHz 落盘，而下行页的单波束 EIRP 谱密度是按下行页的参考带宽填的：折合到 40 kHz 再用。
      //   从前原值照搬，下行按 4 kHz 填时星间掩模偏低 10 dB——偏在不安全的方向，校验也拦不住
      maxEirpDbwPerRefBw: Number(down.eirpDbwPerRefBw) + ssEirpOffsetDb(down.refBwKhz),
      directions: { is: true }, eirpMaskId: Number(is.maskId), refBwKhz: 40,
      maskAlpha0Deg: Number(down.maskAlpha0Deg),
      nAzElPoints: Number(down.gridPoints), latStepDeg: Number(g.latStepDeg),
      sepAngleStepDeg: Number(is.sepStepDeg), conservativeMarginDb: Number(is.marginDb)
    }))
  }
  if (up.on) {
    // ★ 上行掩模讲的是地球站的发射频段：low/high_freq 属性、per-mask 文件名与终端增益的 λ 一律取上行页的频段，
    //   不是页头那个下行频段（从前出厂即输出 Mask_id_3_EIRP_ES_10.7-12.75.xml，终端增益也按下行频率算）
    const ub = uplinkBandOf(g, up)
    const lam = C_GHZ_M / ((ub.lowGhz + ub.highGhz) / 2)
    const scan = String(up.scanAnglesDeg || '').split(/[,，\s]+/).map(Number).filter(Number.isFinite)
    out.push(Object.assign({}, base, {
      lowFreqGhz: ub.lowGhz, highFreqGhz: ub.highGhz,
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
