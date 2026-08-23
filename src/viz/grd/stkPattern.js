// STK 外部天线方向图（“STK ASCII Directivity”）序列化：把 GRASP 网格（az/el，igrid=6，合成波束即是）
// 导出为 AGI / Ansys STK 可导入的 External Antenna Pattern 文件（AzElPattern，增益 dBi）。
//
// 规范来源：AGI/Ansys STK help「RF External File Formats — External Antenna Pattern Files」
//   (help.agi.com/stk/Content/comm/CommRadarB-01.htm) 与该页链出的官方 AzEl 样例 example_antenna1.htm
//   （53×53、az/el 各 −26..+26 步长 1°）。逐字对照其数据布局：
//     stk.v.<主>.<次>        ← 版本戳必须是第一行
//     <空行>
//     <PatternType>          ← AzElPattern（本导出）/ ElAzPattern / ThetaPhiPattern / PhiThetaPattern
//     AngleUnits Degrees
//     NumberOfPoints <N>     ← = 网格总点数 = NX×NY
//     PatternData
//     <az> <el> <gain>       ← 每行一个点；★第二列(el)变化最快、az 是外层（官方样例中 az 连续 53 行
//                               不变、el 逐行递增）；均匀规则网格；两列均升序；增益单位 dBi。
//                               此序不是可选项：pattern 关键字「describes the type and order of the data」，
//                               AzElPattern 与 ElAzPattern 的差别就在这里；且 NumberOfPoints 只给总数不给
//                               行列数，STK 只能靠哪一列先变来推矩阵形状 —— 写反即被读成转置。
//   单极化标量增益不写 IEEE1979 行（那只用于 RHC/LHC/Tau 双极化形）。
//
// 角度约定（唯一真正风险点，已核对）：STK 直角 AzEl 与 GRASP igrid 4/6 同为 +az=东、+el=北（STK help:
//   「positive azimuth is from the boresight toward the east... elevation... toward the north」）——无镜像、
//   无转置。故 az/el 直接取网格坐标 X/Y。
//   诚实边界：igrid=4(el over az) 与 igrid=6(az over el) 是两种不同的直角 az/el，而 STK 只有一套定义；
//   SATSOFT 的同名导出（手册 p152「STK ASCII Directivity」）则统一重采样到 az=θcosφ / el=θsinφ 的极投影栅。
//   三者在 boresight 附近二阶重合，差随离轴角平方长：实测 ±5° 角 0.03°、±9° 角 0.16°、±12° 角 0.37°。
// 增益：取 RSS 线性功率 P1+P2 → dBi = 10·log10(P1+P2)，与界面显示/链路取值同口径（见 sampleSetPow）。
//   合成波束里即方向性 dBi；导入的 *_EIRP 网格则为 EIRP dBW，STK 一律当增益读，语义由用户把握。
// 多波束：STK 每个文件只读一个方向图 → 多 set 合成「最大值包络」（各方向取各波束最大增益），得单张覆盖方向图。
import { parseGrd } from './parse.js'

const AZEL_IGRIDS = new Set([4, 6, 9, 10])   // az/el 型网格（X=Az, Y=El，度）；uv(1)/θφ(7)/5 暂不支持

// 在某 set 的 (az,el) 窗口内双线性取线性功率；窗外返回 null。范围支持递增/递减（XE 可 < XS）。
//
// ★ 极化口径必须与全平台取值路径同为 RSS，不能只取 P1 ——【别按分量序号硬判哪个是共极化】：
//   真实 GRD 里共极化未必写在第 1 分量。本机三份实测（CS10R 300_X02G icomp=3、EIRP_OK1 icomp=2、
//   to_Bj icomp=2）峰值处都是 P2 远强于 P1（峰值差 31.2 / 14.0 / 36.2 dB）——只取 P1 等于把交叉极化
//   当方向图导出去。同一坑见 grdSampler.js 的共极化判定说明。
//   RSS = P1+P2 → 10log10(Eh²+Ev²)，即 SATSOFT「Display | Component Contours = RSS」那一档（手册 p141
//   明说画 directivity 等值线该用它）；共极化占绝对优势时它与共极化只差交叉极化的那点零头。
function sampleSetPow(s, az, el, pol) {
  const { XS, YS, XE, YE, NX, NY } = s
  const fx = XE === XS ? 0 : (az - XS) / (XE - XS) * (NX - 1)
  const fy = YE === YS ? 0 : (el - YS) / (YE - YS) * (NY - 1)
  if (fx < -1e-6 || fx > NX - 1 + 1e-6 || fy < -1e-6 || fy > NY - 1 + 1e-6) return null
  const cx = Math.min(Math.max(fx, 0), NX - 1), cy = Math.min(Math.max(fy, 0), NY - 1)
  const x0 = Math.floor(cx), y0 = Math.floor(cy)
  const x1 = Math.min(x0 + 1, NX - 1), y1 = Math.min(y0 + 1, NY - 1)
  const tx = cx - x0, ty = cy - y0
  const bil = (arr) => {
    const at = (r, c) => arr[r * NX + c]
    const top = at(y0, x0) * (1 - tx) + at(y0, x1) * tx
    const bot = at(y1, x0) * (1 - tx) + at(y1, x1) * tx
    return top * (1 - ty) + bot * ty
  }
  if (pol === 'P1') return bil(s.P1)
  if (pol === 'P2') return bil(s.P2)
  return bil(s.P1) + bil(s.P2)                 // RSS（缺省）
}

const fnum = (v) => (Object.is(v, -0) ? 0 : v).toFixed(6)

// 解析后的 GRD（或原始文本）→ STK AzElPattern 文本。返回 { text, nx, ny, peakDbi, nBeams }。
export function grdToStkAzEl(input, { name = 'Pattern', floorDb = null, maxPoints = 90000, version = '11.0', pol = 'RSS' } = {}) {
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
      for (const s of sets) { const p = sampleSetPow(s, az, el, pol); if (p != null && p > pmax) pmax = p }
      const v = pmax > 0 ? 10 * Math.log10(pmax) : -Infinity
      dB[r * NX + c] = v
      if (v > peak) { peak = v; peakAz = az; peakEl = el }
    }
  }
  if (!Number.isFinite(peak)) throw new Error('GRD 采样为空，无法导出 STK 方向图')
  const floor = floorDb != null ? floorDb : peak - 60   // 无覆盖点地板（相对峰值 −60 dB）
  // 写文件（AzElPattern：az 外层、el 内层升序 → 第二列 el 变化最快，与官方 AzEl 样例同序）
  const out = ['stk.v.' + version, '', 'AzElPattern', 'AngleUnits Degrees', 'NumberOfPoints ' + NX * NY, 'PatternData']
  for (let c = 0; c < NX; c++) {
    const az = x0 + dx * c
    for (let r = 0; r < NY; r++) {
      const el = y0 + dy * r
      let v = dB[r * NX + c]
      if (!Number.isFinite(v) || v < floor) v = floor
      out.push(fnum(az) + ' ' + fnum(el) + ' ' + fnum(v))
    }
  }
  return { text: out.join('\r\n') + '\r\n', nx: NX, ny: NY, peakDbi: peak, peakAz, peakEl, nBeams: sets.length }
}
