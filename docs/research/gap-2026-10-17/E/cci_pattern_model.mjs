// 量级验证：HTS 蜂窝同频复用下，C/CCI 对「波束方向图模型」的敏感度
// 对比：(a) 平台高斯波束（buildGaussGrd 同式 −12.0412(θ/θ3)²，地板 −50，矩形窗半宽 1.8θ3，窗外=null=不计）
//       (b) 同上但不截窗（纯高斯）
//       (c) 圆口径 parabolic-on-pedestal 照射（边缘锥度 T dB）真实远场 |F(u)|²（含旁瓣），按同一 θ3 缩放
//       (d) ITU-R S.672-4 recommends 1 单馈源圆波束设计目标包络（LN=−20 / −25，z=1）
// 布局：正六边形波束栅（小角平面近似），间距 s=0.866θ3（三重点恰在 −3 dB，高斯口径）
// 指标：受扰点在 (i) 波束中心 (ii) 三重点（覆盖边缘最差点）的聚合 C/I（同色波束线性功率求和）
const J = (n, x) => { // Bessel J_n(x) = (1/π)∫0^π cos(nτ − x sinτ)dτ，Simpson 4000
  const N = 4000, h = Math.PI / N; let s = 0
  for (let i = 0; i <= N; i++) { const t = i * h, w = (i === 0 || i === N) ? 1 : (i % 2 ? 4 : 2); s += w * Math.cos(n * t - x * Math.sin(t)) }
  return s * h / 3 / Math.PI
}
const Lam1 = (u) => (Math.abs(u) < 1e-6 ? 1 : 2 * J(1, u) / u)
const Lam2 = (u) => (Math.abs(u) < 1e-6 ? 1 : 8 * J(2, u) / (u * u))
function pedestal(Tdb) {
  const p = Math.pow(10, Tdb / 20), q = 1 - p
  const F = (u) => (2 * p * Lam1(u) + q * Lam2(u)) / (2 * p + q)
  let lo = 0.5, hi = 3.5
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (F(m) * F(m) > 0.5) lo = m; else hi = m }
  const uh = (lo + hi) / 2
  // 预制查表（θ/θ3 → dB），θ 在 0..12θ3
  const tab = new Float64Array(2401)
  for (let i = 0; i <= 2400; i++) { const r = i / 200; const u = uh * 2 * r; const f = F(u); tab[i] = 10 * Math.log10(Math.max(f * f, 1e-12)) }
  const at = (r) => { const x = r * 200; const i = Math.floor(x); if (i >= 2400) return tab[2400]; const t = x - i; return tab[i] * (1 - t) + tab[i + 1] * t }
  // 首旁瓣电平
  let sl = -Infinity, seenNull = false, prev = tab[0]
  for (let i = 1; i <= 2400; i++) { if (tab[i] > prev && !seenNull) seenNull = true; if (seenNull && tab[i] > sl) { sl = tab[i] } if (seenNull && tab[i] < prev && sl > -Infinity) break; prev = tab[i] }
  return { at, sl }
}
const gauss = (r) => Math.max(-12.0412 * r * r, -50)
const gaussNoFloor = (r) => -12.0412 * r * r
function s672(LN) { // z=1；ψb=θ3/2；a=2.58·sqrt(1−log z)→2.58（LN=20）/ 2.58·sqrt(1−0.8 log z)→2.58（LN=25），b=6.32，α=2
  const a = 2.58, b = 6.32
  return (r) => { // r = θ/θ3 ⇒ ψ/ψb = 2r
    const x = 2 * r
    if (x <= a) return -3 * x * x
    if (x <= 0.5 * b) return LN                 // Gm+LN+20log z（z=1）
    if (x <= b) return LN
    return LN + 25 * Math.log10(b / x)          // X − 25 log ψ，X=Gm+LN+25log(bψb)
  }
}
// 六边形晶格 + 复用子晶格
function lattice(s, rings) {
  const pts = []
  for (let i = -rings; i <= rings; i++) for (let j = -rings; j <= rings; j++) {
    const x = s * (i + j / 2), y = s * (j * Math.sqrt(3) / 2)
    pts.push({ i, j, x, y })
  }
  return pts
}
// N 色子晶格同色判据：(i,j) 与 (0,0) 同色 ⇔ 落在 Λ' = ⟨u, rot60 u⟩ 上；N=4：u=(2,0)；N=7：u=(2,1)；N=3：u=(1,1)
function sameColor(N) {
  const U = { 3: [1, 1], 4: [2, 0], 7: [2, 1], 9: [3, 0], 12: [2, 2], 16: [4, 0] }[N]
  const [a, b] = U
  // rot60 in lattice coords (e1=(1,0), e2=(1/2,√3/2))：rot60(e1)=e2，rot60(e2)=e2−e1
  const v = [-b, a + b]
  const det = a * v[1] - b * v[0]
  return (i, j) => { // solve i,j = m·u + n·v
    const m = (i * v[1] - j * v[0]) / det, n = (a * j - b * i) / det
    return Math.abs(m - Math.round(m)) < 1e-9 && Math.abs(n - Math.round(n)) < 1e-9
  }
}
function cci(pattern, N, victim, s, th3, windowHalf = Infinity) {
  const same = sameColor(N)
  const L = lattice(s, 14)
  let serve = null, sum = 0, cnt = 0
  for (const p of L) {
    const dx = victim[0] - p.x, dy = victim[1] - p.y
    const r = Math.hypot(dx, dy) / th3
    if (Math.abs(dx) > windowHalf * th3 || Math.abs(dy) > windowHalf * th3) { if (p.i === 0 && p.j === 0) serve = null; continue }
    const g = pattern(r)
    if (p.i === 0 && p.j === 0) { serve = g; continue }
    if (!same(p.i, p.j)) continue
    sum += Math.pow(10, g / 10); cnt++
  }
  if (serve == null) return { ci: null, cnt }
  return { ci: sum > 0 ? serve - 10 * Math.log10(sum) : null, cnt }
}
const th3 = 1.0, s = Math.sqrt(3) / 2 * th3
const tp = [s / Math.sqrt(3) * Math.cos(Math.PI / 6), s / Math.sqrt(3) * Math.sin(Math.PI / 6)]   // 三重点（距中心 s/√3）
const ped10 = pedestal(-10), ped14 = pedestal(-14), ped6 = pedestal(-6)
const models = [
  ['平台高斯（地板−50，窗1.8θ3）', gauss, 1.8],
  ['平台高斯·STK k=2.76（窗2θ3）', (r) => -2.76 * 4.3429448 * r * r, 2.0],
  ['纯高斯（不截窗）', gaussNoFloor, Infinity],
  [`口径锥度−6dB（首旁瓣 ${ped6.sl.toFixed(1)}dB）`, ped6.at, Infinity],
  [`口径锥度−10dB（首旁瓣 ${ped10.sl.toFixed(1)}dB）`, ped10.at, Infinity],
  [`口径锥度−14dB（首旁瓣 ${ped14.sl.toFixed(1)}dB）`, ped14.at, Infinity],
  ['S.672-4 rec.1 包络 LN=−25', s672(-25), Infinity],
  ['S.672-4 rec.1 包络 LN=−20', s672(-20), Infinity],
]
console.log(`布局：六边形间距 s=${s.toFixed(3)}θ3，三重点距中心 ${(s / Math.sqrt(3)).toFixed(3)}θ3`)
for (const N of [3, 4, 7]) {
  console.log(`\n== ${N} 色复用（同色间距 ${Math.sqrt(N).toFixed(3)}s = ${(Math.sqrt(N) * s).toFixed(3)}θ3）==`)
  for (const [name, f, w] of models) {
    const c0 = cci(f, N, [0, 0], s, th3, w)
    const c1 = cci(f, N, tp, s, th3, w)
    // 小区内平均（在六边形小区内均匀撒点，取 C/I 的 dB 平均与 5% 分位）
    const vals = []
    for (let a = -0.5; a <= 0.5; a += 0.025) for (let b = -0.5; b <= 0.5; b += 0.025) {
      const x = a * s * 1.2, y = b * s * 1.2
      // 六边形（中心距 s 的 Voronoi 胞）判据：到 6 个邻心的距离都不小于到原点
      let ok = true
      for (let k = 0; k < 6; k++) { const ang = k * Math.PI / 3; const nx = s * Math.cos(ang), ny = s * Math.sin(ang); if (Math.hypot(x - nx, y - ny) < Math.hypot(x, y)) { ok = false; break } }
      if (!ok) continue
      const r = cci(f, N, [x, y], s, th3, w)
      vals.push(r.ci == null ? Infinity : r.ci)
    }
    vals.sort((a, b) => a - b)
    const fin = vals.filter(Number.isFinite)
    const p5 = vals[Math.floor(vals.length * 0.05)], med = vals[Math.floor(vals.length * 0.5)]
    const nullPct = 100 * (vals.length - fin.length) / vals.length
    const fmt = (v) => v == null ? '无同色(null)' : (Number.isFinite(v) ? v.toFixed(1) : '无同色(null)')
    console.log(`${name.padEnd(30)} 中心 ${fmt(c0.ci).padStart(12)}  三重点 ${fmt(c1.ci).padStart(12)}  胞内5%分位 ${fmt(p5).padStart(12)}  中位 ${fmt(med).padStart(12)}  无同色占比 ${nullPct.toFixed(0)}%`)
  }
}
