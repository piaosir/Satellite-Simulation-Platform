// GRASP 网格(.grd/.pat) 解析器 —— 按 TICRA 权威定义，兼容本数据集实测变体。
// 见 docs/GRD格式解析说明.txt（权威口径）与 docs/GRD导入与覆盖可视化设计.md。
//
// 健壮化（实测数据要求）：
//  · 结束标记接受 4 个或更多 '+'（CS11 用 '+++++'）。
//  · 不假设 KTYPE=1（CS26 为 2，字段结构相同）。
//  · 不假设方形/固定尺寸（91²/101×66/179²/181²/201×161/201²/361²）。
//  · 指数 E+001(三位) 与 E+01 均可（Number() 直接解析）。
//  · KLIMIT=1 时每 Y 行前缀 (起始列, 点数)。
//  · 扩展名无关：.grd 与 .pat 同为本格式，按内容解析。
//
// 每点存两个分量的线性功率 P1=|c1|²、P2=|c2|²（极化取值/增益偏置在显示层做），
// 并保留两分量的复振幅 (Re/Im)：性能指标表的 AR 轴比需相位（由复场 bicubic 插值算）。
// 注：dir/功率取值用功率域 bicubic（见 coverage.sampleBeamAt）。

export function parseGrd(text) {
  const L = text.split(/\r\n|\n|\r/)
  let i = 0
  while (i < L.length && !/^\+{4,}$/.test(L[i].trim())) i++   // 定位结束标记（4+ 个 '+'）
  if (i >= L.length) throw new Error('未找到结束标记 ++++：可能非 GRASP 网格或二进制')
  i++
  const ktype = parseInt(L[i++].trim())                        // 不假设 =1
  const head = L[i++].trim().split(/\s+/).map(Number)
  const nset = head[0], icomp = head[1], ncomp = head[2], igrid = head[3]
  for (let s = 0; s < nset; s++) i++                           // 跳过 NSET 行中心偏移
  const sets = []
  for (let s = 0; s < nset; s++) {
    const [XS, YS, XE, YE] = L[i++].trim().split(/\s+/).map(Number)
    const [NX, NY, KLIMIT] = L[i++].trim().split(/\s+/).map(Number)
    const N = NX * NY
    const P1 = new Float32Array(N), P2 = new Float32Array(N)   // 线性功率
    const c1re = new Float32Array(N), c1im = new Float32Array(N), c2re = new Float32Array(N), c2im = new Float32Array(N)   // 复振幅（最准确取值/AR 用）
    let peakLin = -Infinity, peakIdx = 0
    for (let row = 0; row < NY; row++) {
      let cs = 0, ce = NX
      if (KLIMIT === 1) { const p = L[i++].trim().split(/\s+/).map(Number); cs = p[0] - 1; ce = cs + p[1] }
      for (let col = cs; col < ce; col++) {
        const r = L[i++].trim().split(/\s+/)
        const a = +r[0], b = +r[1], c = ncomp >= 2 ? +r[2] : 0, d = ncomp >= 2 ? +r[3] : 0
        const idx = row * NX + col
        const p1 = a * a + b * b, p2 = c * c + d * d
        P1[idx] = p1; P2[idx] = p2
        c1re[idx] = a; c1im[idx] = b; c2re[idx] = c; c2im[idx] = d
        if (p1 > peakLin) { peakLin = p1; peakIdx = idx }
      }
    }
    sets.push({ XS, YS, XE, YE, NX, NY, P1, P2, c1re, c1im, c2re, c2im, peakLin, peakIdx })
  }
  return { ktype, nset, icomp, ncomp, igrid, sets }
}
