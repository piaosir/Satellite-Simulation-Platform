// nasa3d:sheets 离屏页的纯函数（不引 three，node 单测直接 import：packages/core/test/modelPipeline.test.mjs）。
//
// ─────────────────────────────── 稳健取景（细长件不撑画面） ───────────────────────────────
// renderThumb 按全部顶点取景：MMS / Polar / Van Allen / Cluster II / Wind 这类带几十米线天线的星，本体在 512 格里只剩十几个像素，
// 画廊里一格空白。NASA 3D Resources 的做法是裁到本体、让细杆伸出画外。这里照做：全景（3 倍边长）的 alpha 掩模做一次形态学腐蚀
// （半径 ≈ 0.4 % 边长：细于约 12 px 的杆 / 线天线整条消失），剩下的「有厚度的部分」取包围盒，外扩回腐蚀半径 + 每边 12.5 % 边距取正方形。
// 框交给页面【重新渲染】（setViewOffset 只画框内那一块，见 main.js 文件头），不是放大全景的像素，所以放大倍数只设一个理智上限
// MAX_ZOOM（16×：本体不到全景 1/16 的件，画面里本来就几乎只剩杆子）。腐蚀后什么都不剩（整件都是细杆）或包围盒本来就
// 占满画面，就不裁 —— 与 renderThumb 原取景一致。
export const MAX_ZOOM = 16
/** 框相对「有厚度部分」包围盒的外扩倍数（每边 12.5 %）：腐蚀会啃掉本体边上的细小凸起，1.14 时 MMS (A) 这类的本体上下沿会被裁掉 */
export const MARGIN = 1.25
export function contentSquare(alpha, W, { maxZoom = MAX_ZOOM } = {}) {
  const N = W * W
  const r = Math.max(2, Math.round(W * 0.004))
  const win = 2 * r + 1
  // 横向腐蚀：窗口 [x−r, x+r] 全为实（越界算空）
  const h = new Uint8Array(N)
  const ps = new Int32Array(W + 1)
  for (let y = 0; y < W; y++) {
    const o = y * W
    for (let x = 0; x < W; x++) ps[x + 1] = ps[x] + (alpha[o + x] > 40 ? 1 : 0)
    for (let x = r; x < W - r; x++) if (ps[x + r + 1] - ps[x - r] === win) h[o + x] = 1
  }
  // 纵向腐蚀，同时累计行 / 列计数
  const col = new Float64Array(W), row = new Float64Array(W)
  let tot = 0
  for (let x = 0; x < W; x++) {
    ps[0] = 0
    for (let y = 0; y < W; y++) ps[y + 1] = ps[y] + h[y * W + x]
    for (let y = r; y < W - r; y++) if (ps[y + r + 1] - ps[y - r] === win) { col[x]++; row[y]++; tot++ }
  }
  const full = { x: 0, y: 0, side: W, zoom: 1 }
  if (tot < win * win) return full
  // 0.2 % 分位：零星碎点（腐蚀后残留的交叉点）不撑包围盒
  const q = (arr) => {
    let a = 0, lo = 0, hi = W - 1
    for (let i = 0; i < W; i++) { a += arr[i]; if (a > tot * 0.002) { lo = i; break } }
    a = 0
    for (let i = W - 1; i >= 0; i--) { a += arr[i]; if (a > tot * 0.002) { hi = i; break } }
    return [lo - r, hi + r]
  }
  const [x0, x1] = q(col), [y0, y1] = q(row)
  let side = Math.max(x1 - x0, y1 - y0) * MARGIN
  if (side >= W * 0.85) return full
  side = Math.max(side, W / maxZoom)
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
  const sx = Math.min(W - side, Math.max(0, cx - side / 2)), sy = Math.min(W - side, Math.max(0, cy - side / 2))
  return { x: sx, y: sy, side, zoom: W / side }
}

// ─────────────────────────────── 画面质检（进 sheets.json，build 的 REPORT 列出被标记的条目） ───────────────────────────────
// 量的是最终缩略图（RGBA，W×W）：
//   coverage  不透明像素（alpha > 40）占画面比例
//   meanL / stdL  不透明像素的亮度（Rec.709 系数，按 0–1 的 sRGB 值算——只作相对判据）均值与标准差
// 标记只作复核提示（REPORT 列出，不拦）。阈值按 2026-09-24 全量 227 张的分布定：coverage p5 0.048 / p50 0.18，
// meanL p5 0.24 / p50 0.65 / p95 0.88，stdL p5 0.056 / p50 0.17——各取分布尾部之外：
//   tiny   coverage < 0.03（画面基本是空的）
//   dark   meanL < 0.1（死黑：退化材质、背光）
//   flat   stdL < 0.05 且 meanL > 0.7（发白没有明暗：无材质 / 全白金属）
export const QA_LIMITS = Object.freeze({ tiny: 0.03, dark: 0.1, flatStd: 0.05, flatMean: 0.7 })
export function thumbQa(rgba, W) {
  const N = W * W
  let n = 0, s = 0, s2 = 0
  for (let i = 0; i < N; i++) {
    const o = i * 4
    if (rgba[o + 3] <= 40) continue
    const L = (0.2126 * rgba[o] + 0.7152 * rgba[o + 1] + 0.0722 * rgba[o + 2]) / 255
    n++; s += L; s2 += L * L
  }
  const coverage = n / N
  const meanL = n ? s / n : 0
  const stdL = n ? Math.sqrt(Math.max(0, s2 / n - meanL * meanL)) : 0
  const flags = []
  if (coverage < QA_LIMITS.tiny) flags.push('tiny')
  if (n && meanL < QA_LIMITS.dark) flags.push('dark')
  if (n && stdL < QA_LIMITS.flatStd && meanL > QA_LIMITS.flatMean) flags.push('flat')
  const r4 = (v) => +v.toFixed(4)
  return { coverage: r4(coverage), meanL: r4(meanL), stdL: r4(stdL), flags }
}
