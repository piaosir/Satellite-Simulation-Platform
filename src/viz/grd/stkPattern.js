// STK 外部天线方向图（“STK ASCII Directivity”）序列化：把 GRASP 网格（az/el，igrid=6，合成波束即是）
// 导出为 AGI / Ansys STK 可导入的 External Antenna Pattern 文件（AzElPattern，增益 dBi）。
//
// 规范来源：AGI/Ansys STK help「RF External File Formats — External Antenna Pattern Files」
//   (help.agi.com/stk/Content/comm/CommRadarB-01.htm)。逐字对照页内 IEEE1979/ThetaPhi 样例的数据布局：
//     stk.v.<主>.<次>        ← 版本戳必须是第一行
//     <空行>
//     <PatternType>          ← AzElPattern（本导出）/ ElAzPattern / ThetaPhiPattern / PhiThetaPattern
//     AngleUnits Degrees
//     NumberOfPoints <N>     ← = 网格总点数 = NX×NY
//     PatternData
//     <az> <el> <gain>       ← 每行一个点；第一列(az)变化最快、升序；均匀规则网格；增益单位 dBi
//   单极化标量增益不写 IEEE1979 行（那只用于 RHC/LHC/Tau 双极化形）。
//
// 角度约定（唯一真正风险点，已核对）：STK 直角 AzEl 与 GRASP igrid=6 同为 +az=东、+el=北 —— 无镜像、
//   无转置；仅差二阶 tan 弯曲（近天底 GEO 波束边缘 <0.15°）。故 az/el 直接取网格坐标 X/Y。
// 增益：取共极化线性功率 P1=|E_co|² → dBi = 10·log10(P1)（合成波束里即方向性 dBi；导入的 *_EIRP 网格
//   则为 EIRP dBW，STK 一律当增益读，语义由用户把握）。
// 多波束：STK 每个文件只读一个方向图 → 多 set 合成「最大值包络」（各方向取各波束最大增益），得单张覆盖方向图。
import { parseGrd } from './parse.js'

const AZEL_IGRIDS = new Set([4, 6, 9, 10])   // az/el 型网格（X=Az, Y=El，度）；uv(1)/θφ(7)/5 暂不支持

// 在某 set 的 (az,el) 窗口内双线性取线性功率 P1；窗外返回 null。范围支持递增/递减（XE 可 < XS）。
function sampleSetP1(s, az, el) {
  const { XS, YS, XE, YE, NX, NY, P1 } = s
  const fx = XE === XS ? 0 : (az - XS) / (XE - XS) * (NX - 1)
  const fy = YE === YS ? 0 : (el - YS) / (YE - YS) * (NY - 1)
  if (fx < -1e-6 || fx > NX - 1 + 1e-6 || fy < -1e-6 || fy > NY - 1 + 1e-6) return null
  const cx = Math.min(Math.max(fx, 0), NX - 1), cy = Math.min(Math.max(fy, 0), NY - 1)
  const x0 = Math.floor(cx), y0 = Math.floor(cy)
  const x1 = Math.min(x0 + 1, NX - 1), y1 = Math.min(y0 + 1, NY - 1)
  const tx = cx - x0, ty = cy - y0
  const at = (r, c) => P1[r * NX + c]
  const top = at(y0, x0) * (1 - tx) + at(y0, x1) * tx
  const bot = at(y1, x0) * (1 - tx) + at(y1, x1) * tx
  return top * (1 - ty) + bot * ty
}

const fnum = (v) => (Object.is(v, -0) ? 0 : v).toFixed(6)

// 解析后的 GRD（或原始文本）→ STK AzElPattern 文本。返回 { text, nx, ny, peakDbi, nBeams }。
export function grdToStkAzEl(input, { name = 'Pattern', floorDb = null, maxPoints = 90000, version = '11.0' } = {}) {
  const g = typeof input === 'string' ? parseGrd(input) : input
  const sets = (g && g.sets) || []
  if (!sets.length) throw new Error('GRD 无有效波束数据，无法导出 STK 方向图')
  if (!AZEL_IGRIDS.has(g.igrid)) throw new Error(`STK 方向图导出目前支持 az/el 网格（igrid 4/6/9/10，合成波束即 6）；该天线 igrid=${g.igrid}（uv/θφ），暂不支持`)
  // 并集 az/el 边界 + 最细步长（多波束各自窗口不同 → 取包络网格）
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, step = Infinity
  for (const s of sets) {
    x0 = Math.min(x0, s.XS, s.XE); x1 = Math.max(x1, s.XS, s.XE)
    y0 = Math.min(y0, s.YS, s.YE); y1 = Math.max(y1, s.YS, s.YE)
    const sxp = Math.abs(s.XE - s.XS) / Math.max(1, s.NX - 1)
    const syp = Math.abs(s.YE - s.YS) / Math.max(1, s.NY - 1)
    if (sxp > 0) step = Math.min(step, sxp)
    if (syp > 0) step = Math.min(step, syp)
  }
  if (!(step > 0) || !Number.isFinite(step)) step = (Math.max(x1 - x0, y1 - y0) / 100) || 0.1
  let NX = Math.max(2, Math.floor((x1 - x0) / step + 1e-6) + 1)
  let NY = Math.max(2, Math.floor((y1 - y0) / step + 1e-6) + 1)
  if (NX * NY > maxPoints) { const k = Math.sqrt((NX * NY) / maxPoints); NX = Math.max(2, Math.round(NX / k)); NY = Math.max(2, Math.round(NY / k)) }
  const dx = (x1 - x0) / (NX - 1), dy = (y1 - y0) / (NY - 1)
  // 采样最大值包络 → dBi
  const dB = new Float64Array(NX * NY)
  let peak = -Infinity, peakAz = x0, peakEl = y0
  for (let r = 0; r < NY; r++) {
    const el = y0 + dy * r
    for (let c = 0; c < NX; c++) {
      const az = x0 + dx * c
      let pmax = 0
      for (const s of sets) { const p = sampleSetP1(s, az, el); if (p != null && p > pmax) pmax = p }
      const v = pmax > 0 ? 10 * Math.log10(pmax) : -Infinity
      dB[r * NX + c] = v
      if (v > peak) { peak = v; peakAz = az; peakEl = el }
    }
  }
  if (!Number.isFinite(peak)) throw new Error('GRD 采样为空，无法导出 STK 方向图')
  const floor = floorDb != null ? floorDb : peak - 60   // 无覆盖点地板（相对峰值 −60 dB）
  // 写文件（AzElPattern：el 外层、az 内层升序 → 第一列 az 变化最快，与规范样例同序）
  const out = ['stk.v.' + version, '', 'AzElPattern', 'AngleUnits Degrees', 'NumberOfPoints ' + NX * NY, 'PatternData']
  for (let r = 0; r < NY; r++) {
    const el = y0 + dy * r
    for (let c = 0; c < NX; c++) {
      const az = x0 + dx * c
      let v = dB[r * NX + c]
      if (!Number.isFinite(v) || v < floor) v = floor
      out.push(fnum(az) + ' ' + fnum(el) + ' ' + fnum(v))
    }
  }
  return { text: out.join('\r\n') + '\r\n', nx: NX, ny: NY, peakDbi: peak, peakAz, peakEl, nBeams: sets.length }
}
