// 外部方向图格式 ⇄ GRASP .grd 互转：ACP4 (#CAL1) 与 Eutelsat ASCII。
//
// 规范来源：
//   · ACP4     —— docs/ACP4格式解析说明.txt（SATSOFT 3.2.0 三份导出件逆向 + 逐点校验；
//                  官方手册 §13.4 只给签名不给布局，原文让用户自己导一份来看）
//   · Eutelsat —— SATSOFT 3.2.0 手册 §13.6（p168，规范完整）
//   · 坐标系换算 —— 手册 §13.3 的 KGRID↔IGRID 对照表 + §4.1 的 (4.1)~(4.3) 恒等式
//
// ★ 全篇最关键的一条：两个格式的 az/el 都是 SATSOFT 坐标系 3（az over el 转台，y 极轴），
//   而它【就是 GRASP igrid=4】—— 实测坐实（EIRP_OK1.grd igrid=4 → SATSOFT 的 ACP4 导出是
//   逐点全等的拷贝，对齐搜索 RMS 0.00003 dB，无镜像无转置）。所以：
//     导入 = 原封不动当成一份 igrid=4 的 GRD 喂进现有管线，【一行换算都不用写】；
//     导出 = 源若是 igrid=4 直接抄数，其它 igrid 才需要重采样（见 resampleToAzEl）。
//   千万别顺手"优化"成 igrid=6 —— 那是另一种直角 az/el（x 极轴），±9° 网格角上差 0.16°。
//
// 导入落地方式：转成 GRASP .grd 文本后走 coverageGrd.save 落盘。这样采样器/覆盖渲染/
//   链路预算主进程取值/STK 导出/GRD 导出全部零改动，且再导出 ACP4 可原样还原表头字段
//   （频率/极化/上下行记在 PATMETA 行里）。
//
// 【能力边界】两个格式都只有标量幅度，没有相位、没有第二分量。转出来的 GRD 里
//   分量2 恒为 0，故轴比 AR / XPD 对这类天线无物理意义 —— icomp 特意写 1（线极化 Eθ/Eφ 对），
//   使 axialRatioDb 走 Stokes 支路给出"纯线极化"而不是 icomp=3 那条会算出【0 dB 假圆极化】。

import { parseGrd } from './parse.js'
import { gridDir, invGridDir, sampleBeamAtParam } from './coverage.js'
import { fexp } from './synth.js'

const D2R = Math.PI / 180, R2D = 180 / Math.PI
const NODATA = -200            // ACP4 无数据哨兵（实测：换算后落到源网格窗口之外的点）
const isNum = (s) => s !== '' && Number.isFinite(+s)
const toks = (s) => String(s == null ? '' : s).trim().split(/[\s,]+/).filter(Boolean)

// ============================ 识别 ============================
// 返回 'acp4' | 'eutelsat' | 'grasp' | 'satsoft:NNNN' | null
// 判据出处：ACP4/GRASP 见 SATSOFT 手册 p138 的文件签名表；Eutelsat 见 §13.6
//（"identified automatically by the fact that there are exactly 6 fields on the second line"）。
export function sniffPatternFormat(text) {
  if (!text) return null
  const L = String(text).split(/\r\n|\n|\r/, 500)
  if (/^#CAL1/.test(L[0] || '')) return 'acp4'
  for (let i = 0; i < L.length; i++) {
    const t = (L[i] || '').trim()
    if (!/^\+{4}/.test(t)) continue
    // ++++NNNN 是 SATSOFT 家族的文件 ID（0020=type20 方向图 / 0025=不规则栅 / 0040=覆盖多边形），
    // 不是 GRASP。识别出来是为了给准话，而不是让它走 GRASP 解析器崩在后面。
    const id = /^\+{4}(\d{4})\s*$/.exec(t)
    return id ? 'satsoft:' + id[1] : 'grasp'
  }
  const f = toks(L[1])
  if (f.length === 6 && f.every(isNum)) return 'eutelsat'
  return null
}

export const FORMAT_LABEL = { acp4: 'ACP4', eutelsat: 'Eutelsat', grasp: 'GRASP' }
export const SATSOFT_ID_LABEL = { '0020': 'SATSOFT type 20 方向图', '0025': 'SATSOFT 不规则栅方向图', '0040': 'SATSOFT 覆盖多边形/等值线' }

// ============ 统一的中间表示（两个格式解析后都长这样）============
// { name, freq, pol, dir, polType, beams:[ { Naz, Nel, azMin, azMax, elMin, elMax,
//   peak, db:Float64Array } ] }   db 一律【已归一】成：升序 az 为内层、升序 el 为外层，
//   索引 = iel*Naz + iaz；无数据点为 NaN。

// ============================ ACP4 解析 ============================
// 表头靠 "*" 注释行【前缀匹配】取值，不靠行号也不靠顺序 —— 注释原文带拼写错误
// （"corrd"、少一个右括号），且字段可能增删，按行号读迟早崩。
const A4 = {
  name: /^name/i, satId: /^satellite/i, beamId: /^beam\s*I/i, dir: /^direction/i,
  polType: /^polarization type/i, pol: /^polarization\s*$/i, freq: /^frequency/i,
  normalized: /^normalized/i, peak: /^peak for/i, azFast: /which is faster/i,
  azDir: /^az direction/i, elDir: /^el direction/i,
  nAz: /^points on az/i, nEl: /^points on el/i,
  azLim: /^min and max az/i, elLim: /^min and max el/i,
  point: /^az and el pointing/i, mult: /^multiplier/i, off: /^offset/i
}

export function parseAcp4(text) {
  const L = String(text).split(/\r\n|\n|\r/)
  const starts = []
  L.forEach((l, i) => { if (l.startsWith('#CAL1')) starts.push(i) })
  if (!starts.length) throw new Error('不是 ACP4 文件：首行没有 #CAL1')
  const warns = []
  const beams = []
  let head0 = null
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k], e = k + 1 < starts.length ? starts[k + 1] : L.length
    // ---- 表头："*键" 后跟若干【单 token】值行；出现多 token 行即进入数据段 ----
    const hdr = new Map()
    let i = s + 1
    for (; i < e; i++) {
      const line = L[i]
      if (line.startsWith('*')) {
        const key = line.slice(1).trim(); const vals = []
        let j = i + 1
        for (; j < e && !L[j].startsWith('*'); j++) {
          const t = toks(L[j])
          if (t.length > 1) break                 // 多 token → 数据段开始
          if (t.length === 1) vals.push(t[0])
        }
        hdr.set(key, vals)
        if (j < e && !L[j].startsWith('*')) { i = j; break }   // 撞上数据段
        i = j - 1
        continue
      }
      if (toks(line).length > 1) break            // 无表头就进数据（异常件）
    }
    // ---- 数据段：从这里到本波束末尾的全部数字（含最后一行的余数）----
    const data = []
    for (; i < e; i++) for (const t of toks(L[i])) if (isNum(t)) data.push(+t)
    // ---- 取值 ----
    const get = (re) => { for (const [k2, v] of hdr) if (re.test(k2)) return v; return null }
    const num = (re, def) => { const v = get(re); const n = v && v.length ? +v[0] : NaN; return Number.isFinite(n) ? n : def }
    const str = (re, def) => { const v = get(re); return v && v.length ? v[0] : def }
    const Naz = num(A4.nAz, NaN), Nel = num(A4.nEl, NaN)
    if (!(Naz >= 2 && Nel >= 2)) throw new Error('ACP4 表头缺少网格点数（points on az/el side of grid）')
    const azL = get(A4.azLim) || [], elL = get(A4.elLim) || []
    if (azL.length < 2 || elL.length < 2) throw new Error('ACP4 表头缺少网格角度范围（Min and max az/el angle）')
    const azMin = Math.min(+azL[0], +azL[1]), azMax = Math.max(+azL[0], +azL[1])
    const elMin = Math.min(+elL[0], +elL[1]), elMax = Math.max(+elL[0], +elL[1])
    const azFast = num(A4.azFast, 1) !== 0                 // 1=az 变化最快（三份样本皆是）
    // ★ "Min and max" 给的是范围，扫描方向由 az/el direction 决定：0=西→东/南→北（升序）
    const azDesc = num(A4.azDir, 0) !== 0, elDesc = num(A4.elDir, 0) !== 0
    const normalized = num(A4.normalized, 1) === 0         // 0 = 值相对峰值，需加回 peak
    const peak = num(A4.peak, 0), off = num(A4.off, 0), mult = num(A4.mult, 1)
    if (Number.isFinite(mult) && Math.abs(mult - 1) > 1e-9) {
      warns.push(`波束 ${k + 1} 的 multiplier=${mult}（手册未定义其用法，本次未施加）`)
    }
    // 指向角：三份样本恒为 0/0（见 docs/ACP4格式解析说明.txt 字段 17），故它与网格 az/el 边界
    // 是「已含在边界里」还是「要再叠加」未经证实 —— 不猜着施加，非零时如实告警，
    // 免得静默把整幅图摆错位置（这类错落在合法数值范围内，任何校验都不会报警）。
    const pt = get(A4.point) || []
    const pAz = pt.length > 0 ? +pt[0] : 0, pEl = pt.length > 1 ? +pt[1] : 0
    if (Math.abs(pAz) > 1e-9 || Math.abs(pEl) > 1e-9) {
      warns.push(`波束 ${k + 1} 的 az/el 指向角=${pAz}/${pEl}（样本恒为 0/0，其与网格边界的关系未经证实，本次未施加）`)
    }
    if (data.length !== Naz * Nel) {
      throw new Error(`ACP4 波束 ${k + 1} 数据点数 ${data.length} 与表头 ${Naz}×${Nel}=${Naz * Nel} 不符`)
    }
    // ---- 归一化到「升序 az 内层 / 升序 el 外层」----
    const db = new Float64Array(Naz * Nel)
    for (let n = 0; n < data.length; n++) {
      const a = azFast ? n % Naz : (n / Nel) | 0            // 写入序里的 az 序号
      const b = azFast ? (n / Naz) | 0 : n % Nel            // 写入序里的 el 序号
      const ia = azDesc ? Naz - 1 - a : a
      const ib = elDesc ? Nel - 1 - b : b
      const v = data[n]
      db[ib * Naz + ia] = v <= NODATA + 1e-9 ? NaN : (normalized ? v + peak : v) + off
    }
    const h = {
      name: str(A4.name, ''), satId: num(A4.satId, 1), beamId: num(A4.beamId, 1),
      dir: str(A4.dir, 'D'), pol: str(A4.pol, ''), polType: num(A4.polType, 0), freq: num(A4.freq, NaN)
    }
    if (!head0) head0 = h
    beams.push({ Naz, Nel, azMin, azMax, elMin, elMax, peak, db })
  }
  return { kind: 'acp4', ...head0, beams, warns }
}

// ============================ Eutelsat 解析 ============================
// 手册 §13.6：行1=标题；行2 = xs, xe, ys, ye, ny, nx；行3起 nx*ny 个 dB 值，
// 内层跑 y（"y is the most rapidly changing index, i.e., elevation cuts"）。
// ★ 注意字段顺序是 (xs,xe,ys,ye) —— 与 GRASP 的 (XS,YS,XE,YE) 交错不同；维度也是先 ny 后 nx。
export function parseEutelsat(text) {
  const L = String(text).split(/\r\n|\n|\r/)
  let i = 0
  while (i < L.length && !toks(L[i]).length) i++
  const title = (L[i] || '').trim(); i++
  while (i < L.length && !toks(L[i]).length) i++
  const h = toks(L[i]); i++
  if (h.length !== 6 || !h.every(isNum)) throw new Error('不是 Eutelsat 方向图：第二行应为 6 个数（xs xe ys ye ny nx）')
  const xs = +h[0], xe = +h[1], ys = +h[2], ye = +h[3], Nel = Math.round(+h[4]), Naz = Math.round(+h[5])
  if (!(Naz >= 2 && Nel >= 2)) throw new Error(`Eutelsat 网格点数非法：nx=${Naz} ny=${Nel}`)
  const data = []
  for (; i < L.length; i++) for (const t of toks(L[i])) if (isNum(t)) data.push(+t)
  if (data.length !== Naz * Nel) throw new Error(`Eutelsat 数据点数 ${data.length} 与 ${Naz}×${Nel}=${Naz * Nel} 不符`)
  const azDesc = xe < xs, elDesc = ye < ys
  const azMin = Math.min(xs, xe), azMax = Math.max(xs, xe)
  const elMin = Math.min(ys, ye), elMax = Math.max(ys, ye)
  const db = new Float64Array(Naz * Nel)
  for (let n = 0; n < data.length; n++) {
    const a = (n / Nel) | 0, b = n % Nel                    // y 最快
    const ia = azDesc ? Naz - 1 - a : a, ib = elDesc ? Nel - 1 - b : b
    const v = data[n]
    db[ib * Naz + ia] = v <= NODATA + 1e-9 ? NaN : v
  }
  let peak = -Infinity
  for (let n = 0; n < db.length; n++) if (Number.isFinite(db[n]) && db[n] > peak) peak = db[n]
  return { kind: 'eutelsat', name: title, freq: NaN, pol: '', dir: 'D', polType: 0, warns: [],
    beams: [{ Naz, Nel, azMin, azMax, elMin, elMax, peak, db }] }
}

// ============================ 外部格式 → GRASP .grd 文本 ============================
// 写成 igrid=4（＝ ACP4/Eutelsat 的 az/el，见文件头说明）、icomp=1、ncomp=2、KLIMIT=0；
// 分量1 = 10^(dB/20)（实数），分量2 恒 0；无数据点写 0 场（下游 P≤0 一律当"域外"返回 null）。
export function foreignToGrdText(p) {
  const n = p.beams.length
  const head = []
  const meta = { kind: p.kind, ...(p.name ? { name: p.name } : {}), ...(Number.isFinite(p.freq) ? { freq: p.freq } : {}),
    ...(p.pol ? { pol: p.pol } : {}), ...(p.dir ? { dir: p.dir } : {}), polType: p.polType || 0, nBeams: n }
  // GRASP ASCII 是纯 ASCII 文本，且落盘走 latin1 —— 表头一律剔除非 ASCII（源名可能是 UTF-8 中文，
  // 见样本 3.pat）。PATMETA 里用 \uXXXX 转义保住原名，JSON.parse 能原样还原。
  const asciiSafe = (s) => String(s == null ? '' : s).replace(/[^\x20-\x7E]+/g, ' ').replace(/\s+/g, ' ').trim()
  const jsonAscii = (o) => JSON.stringify(o).replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
  const sn = asciiSafe(p.name)
  head.push(`Converted to GRASP grid by SatSim from ${FORMAT_LABEL[p.kind] || p.kind}${sn ? ' - ' + sn : ''}. beams=${n}`)
  head.push(`PATMETA ${jsonAscii(meta)}`)
  head.push('++++')
  head.push('1')
  head.push(` ${n} 1 2 4`)                                  // NSET ICOMP=1(Eθ/Eφ) NCOMP=2 IGRID=4
  for (let i = 0; i < n; i++) head.push('  0  0')
  const parts = [head.join('\r\n')]
  const zero = fexp(0)
  for (const b of p.beams) {
    const L = new Array(b.Naz * b.Nel + 2)
    L[0] = ` ${fexp(b.azMin)} ${fexp(b.elMin)} ${fexp(b.azMax)} ${fexp(b.elMax)}`
    L[1] = ` ${b.Naz} ${b.Nel} 0`
    for (let idx = 0; idx < b.Naz * b.Nel; idx++) {
      const v = b.db[idx]
      const amp = Number.isFinite(v) ? Math.pow(10, v / 20) : 0
      L[idx + 2] = ` ${fexp(amp)} ${zero} ${zero} ${zero}`
    }
    parts.push(L.join('\r\n'))
  }
  return parts.join('\r\n') + '\r\n'
}

// 一步到位：外部格式文本 → GRASP 文本（识别 + 解析 + 转换）。返回 { text, kind, warns, beams }
export function foreignPatternToGrd(text) {
  const kind = sniffPatternFormat(text)
  if (kind === 'acp4' || kind === 'eutelsat') {
    const p = kind === 'acp4' ? parseAcp4(text) : parseEutelsat(text)
    return { text: foreignToGrdText(p), kind, warns: p.warns, beams: p.beams.length, meta: p }
  }
  if (kind && kind.startsWith('satsoft:')) {
    const id = kind.slice(8)
    throw new Error(`这是 ${SATSOFT_ID_LABEL[id] || 'SATSOFT ++++' + id} 文件，不是方向图网格`)
  }
  throw new Error('无法识别的方向图格式（既非 GRASP ++++、也非 ACP4 #CAL1 或 Eutelsat）')
}

// 读回导入时记下的 PATMETA（导出 ACP4 时还原频率/极化/上下行）
export function readPatMeta(grdText) {
  const m = /^PATMETA\s+(\{.*\})\s*$/m.exec(String(grdText || ''))
  if (!m) return null
  try { return JSON.parse(m[1]) } catch { return null }
}

// ================== GRASP .grd → az/el (kgrid3 = igrid4) 采样网格 ==================
// 源为 igrid=4 → 节点直接抄，不插值（与 SATSOFT 实测一致）。
// 其它 igrid → 逐点换算 + 复场 bicubic 重采样（走平台自己的 sampleBeamAtParam，口径与界面一致）。
// 输出网格：角度型源沿用其 XS..XE / YS..YE / NX×NY（SATSOFT 对 igrid=6 就是这么干的，
//   样本③ 的边界与源逐位相同）；uv(1)/θφ(7) 无 az/el 边界 → 由源网格四边反算包围盒。
function azElWindow(set, igrid) {
  if (igrid === 1 || igrid === 7) {
    let a0 = Infinity, a1 = -Infinity, e0 = Infinity, e1 = -Infinity
    const dx = (set.XE - set.XS) / (set.NX - 1), dy = (set.YE - set.YS) / (set.NY - 1)
    const put = (X, Y) => {
      const d = gridDir(igrid, X, Y)
      const xy = invGridDir(4, d[0], d[1], d[2]); if (!xy) return
      a0 = Math.min(a0, xy[0]); a1 = Math.max(a1, xy[0]); e0 = Math.min(e0, xy[1]); e1 = Math.max(e1, xy[1])
    }
    for (let c = 0; c < set.NX; c++) { put(set.XS + dx * c, set.YS); put(set.XS + dx * c, set.YE) }
    for (let r = 0; r < set.NY; r++) { put(set.XS, set.YS + dy * r); put(set.XE, set.YS + dy * r) }
    if (!Number.isFinite(a0)) throw new Error('该网格反算不出 az/el 范围（可能整幅都在 boresight 背面）')
    return { azMin: a0, azMax: a1, elMin: e0, elMax: e1, Naz: set.NX, Nel: set.NY }
  }
  return { azMin: Math.min(set.XS, set.XE), azMax: Math.max(set.XS, set.XE),
    elMin: Math.min(set.YS, set.YE), elMax: Math.max(set.YS, set.YE), Naz: set.NX, Nel: set.NY }
}

// 把某个 set 重采样到 az/el 栅，返回 { Naz, Nel, azMin.., db:Float64Array(NaN=无数据), peak }
export function resampleToAzEl(set, igrid, { pol = 'RSS', win = null } = {}) {
  const w = win || azElWindow(set, igrid)
  const { Naz, Nel } = w
  const dAz = Naz > 1 ? (w.azMax - w.azMin) / (Naz - 1) : 0
  const dEl = Nel > 1 ? (w.elMax - w.elMin) / (Nel - 1) : 0
  const db = new Float64Array(Naz * Nel)
  const beam = { grid: { XS: set.XS, YS: set.YS, XE: set.XE, YE: set.YE, NX: set.NX, NY: set.NY },
    c1re: set.c1re, c1im: set.c1im, c2re: set.c2re, c2im: set.c2im, P1: set.P1, P2: set.P2 }
  const direct = igrid === 4 && set.NX === Naz && set.NY === Nel
    && Math.abs(Math.min(set.XS, set.XE) - w.azMin) < 1e-9 && Math.abs(Math.max(set.XS, set.XE) - w.azMax) < 1e-9
    && Math.abs(Math.min(set.YS, set.YE) - w.elMin) < 1e-9 && Math.abs(Math.max(set.YS, set.YE) - w.elMax) < 1e-9
  let peak = -Infinity
  for (let r = 0; r < Nel; r++) {
    const el = w.elMin + dEl * r
    for (let c = 0; c < Naz; c++) {
      const az = w.azMin + dAz * c
      let v = NaN
      if (direct) {
        // 源就是同一张 az/el 栅：直接抄节点（源轴可能递减 → 反查列/行号）
        const ic = set.XE >= set.XS ? c : Naz - 1 - c, ir = set.YE >= set.YS ? r : Nel - 1 - r
        const p = pol === 'P1' ? set.P1[ir * set.NX + ic] : pol === 'P2' ? set.P2[ir * set.NX + ic]
          : set.P1[ir * set.NX + ic] + set.P2[ir * set.NX + ic]
        v = p > 0 ? 10 * Math.log10(p) : NaN
      } else {
        const d = gridDir(4, az, el)
        const xy = invGridDir(igrid, d[0], d[1], d[2])
        const s = xy ? sampleBeamAtParam(beam, xy, 0, { pol, pathLoss: 'none' }) : null
        v = s ? s.db : NaN
      }
      db[r * Naz + c] = v
      if (Number.isFinite(v) && v > peak) peak = v
    }
  }
  return { ...w, db, peak }
}

// ============================ GRASP .grd → ACP4 ============================
// 多波束 = 每波束一份完整表头 + 一份数据，顺序拼接（与 SATSOFT §12.2.8 同）。
// ★ freq/polar/dir/polType 的默认值必须是【取不到】的哨兵（NaN / '' / '' / null）：下面四条兜底链
//   都是「显式入参 → 导入时记下的 PATMETA → 硬缺省」三级，默认值一旦写成真正的缺省值（'D' / 0），
//   第一级就恒真，PATMETA 那一级永远轮不到 —— 由 ACP4 导入的件再导出会静默丢掉上下行与极化类型，
//   而文件其余字段一切正常，接收方无从察觉。
export function grdToAcp4(input, { name = 'Pattern', pol = 'RSS', freq = NaN, polar = '', dir = '', polType = null, satId = 1 } = {}) {
  const g = typeof input === 'string' ? parseGrd(input) : input
  const sets = (g && g.sets) || []
  if (!sets.length) throw new Error('GRD 无有效波束数据，无法导出 ACP4')
  const pm = typeof input === 'string' ? readPatMeta(input) : null   // 由 ACP4 导入的件 → 还原原始表头
  const F = Number.isFinite(freq) ? freq : (pm && Number.isFinite(pm.freq) ? pm.freq : NaN)
  const PL = polar || (pm && pm.pol) || ''
  const DR = dir || (pm && pm.dir) || 'D'
  const PT = Number.isFinite(polType) ? polType : (pm && pm.polType) || 0
  const out = []
  let nBeams = 0, peakAll = -Infinity
  for (const set of sets) {
    const r = resampleToAzEl(set, g.igrid, { pol })
    if (!Number.isFinite(r.peak)) continue                            // 整幅为空的 set 跳过
    nBeams++; peakAll = Math.max(peakAll, r.peak)
    const f6 = (v) => String(+v.toPrecision(6))          // 6 位有效数字，与 SATSOFT 导出件同形
    out.push('#CAL1')
    out.push('*name'); out.push(name)
    out.push('*satellite I.D.'); out.push(String(satId))
    out.push('*beam I.D.'); out.push('1')                             // SATSOFT 亦恒写 1，不是波束序号
    out.push('*direction U or D'); out.push(DR)
    out.push('*polarization'); out.push(PL)
    out.push('*polarization type 0 co, 1 xpol'); out.push(String(PT))
    out.push('*frequency'); out.push(Number.isFinite(F) ? F.toFixed(6) : '0.000000')
    out.push('*normalized data (yes 0, no 1)'); out.push('1')         // 绝对值
    out.push('*peak for this pattern'); out.push(r.peak.toFixed(6))
    out.push('*corrd system (which is faster (az 1, el 0)'); out.push('1')
    out.push('*az direction (W > E 0, E > W 1)'); out.push('0')
    out.push('*el direction (S > N 0, N > S 1)'); out.push('0')
    out.push('*points on az side of grid'); out.push(String(r.Naz))
    out.push('*points on el side of grid'); out.push(String(r.Nel))
    out.push('*Min and max az angle of grid (degrees)'); out.push(r.azMin.toFixed(6)); out.push(r.azMax.toFixed(6))
    out.push('*Min and max el angle of grid (degrees)'); out.push(r.elMin.toFixed(6)); out.push(r.elMax.toFixed(6))
    out.push('*az and el pointing angles'); out.push('0.0'); out.push('0.0')
    out.push('*multiplier'); out.push('1.0')
    out.push('*offset'); out.push('0.0')
    out.push('*reserved field 1'); out.push('0.0')
    out.push('*reserved field 2'); out.push(''); out.push('0.0')      // 注释行与值之间固定夹一个空行
    for (let i = 0; i < r.db.length; i += 4) {
      const row = []
      for (let j = i; j < Math.min(i + 4, r.db.length); j++) {
        const v = r.db[j]
        row.push(Number.isFinite(v) ? f6(v) : String(NODATA))
      }
      out.push(row.join(' ') + ' ')
    }
  }
  if (!nBeams) throw new Error('GRD 采样为空，无法导出 ACP4')
  return { text: out.join('\r\n') + '\r\n', nBeams, peakDb: peakAll }
}

// ============================ GRASP .grd → Eutelsat ============================
// 格式只能装一个标量波束 → 多波束取【最大值包络】（与 STK 导出同口径；该格式无逐波束拼接的余地，
// 它的识别签名就是"第二行正好 6 个字段"，拼起来会歧义）。
export function grdToEutelsat(input, { name = 'Pattern', pol = 'RSS', perLine = 8 } = {}) {
  const g = typeof input === 'string' ? parseGrd(input) : input
  const sets = (g && g.sets) || []
  if (!sets.length) throw new Error('GRD 无有效波束数据，无法导出 Eutelsat 方向图')
  // 公共窗口 = 各 set az/el 窗口的并集；步长取最细的一档
  let azMin = Infinity, azMax = -Infinity, elMin = Infinity, elMax = -Infinity, dA = Infinity, dE = Infinity
  for (const s of sets) {
    const w = azElWindow(s, g.igrid)
    azMin = Math.min(azMin, w.azMin); azMax = Math.max(azMax, w.azMax)
    elMin = Math.min(elMin, w.elMin); elMax = Math.max(elMax, w.elMax)
    dA = Math.min(dA, (w.azMax - w.azMin) / Math.max(1, w.Naz - 1))
    dE = Math.min(dE, (w.elMax - w.elMin) / Math.max(1, w.Nel - 1))
  }
  let Naz = Math.max(2, Math.round((azMax - azMin) / dA) + 1)
  let Nel = Math.max(2, Math.round((elMax - elMin) / dE) + 1)
  const CAP = 2_000_000
  if (Naz * Nel > CAP) { const k = Math.sqrt((Naz * Nel) / CAP); Naz = Math.max(2, Math.round(Naz / k)); Nel = Math.max(2, Math.round(Nel / k)) }
  const win = { azMin, azMax, elMin, elMax, Naz, Nel }
  const env = new Float64Array(Naz * Nel).fill(NaN)
  let peak = -Infinity
  for (const s of sets) {
    const r = resampleToAzEl(s, g.igrid, { pol, win })
    for (let i = 0; i < env.length; i++) {
      const v = r.db[i]
      if (Number.isFinite(v) && !(env[i] >= v)) { env[i] = v; if (v > peak) peak = v }
    }
  }
  if (!Number.isFinite(peak)) throw new Error('GRD 采样为空，无法导出 Eutelsat 方向图')
  const f = (v) => v.toFixed(3)                          // 与手册样例同形（29.290 29.471 …）
  const out = [name || 'Pattern']
  out.push(`${azMin.toFixed(3)} ${azMax.toFixed(3)} ${elMin.toFixed(3)} ${elMax.toFixed(3)} ${Nel} ${Naz}`)
  const row = []
  for (let ia = 0; ia < Naz; ia++) for (let ib = 0; ib < Nel; ib++) {      // ★ y(el) 最快
    const v = env[ib * Naz + ia]
    row.push(Number.isFinite(v) ? f(v) : String(NODATA))
    if (row.length === perLine) { out.push(row.join(' ')); row.length = 0 }
  }
  if (row.length) out.push(row.join(' '))
  return { text: out.join('\r\n') + '\r\n', nBeams: sets.length, peakDb: peak, nx: Naz, ny: Nel }
}
