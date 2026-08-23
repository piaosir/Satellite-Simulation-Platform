// GRASP 网格(.grd/.pat) 解析器 —— 按 TICRA 权威定义，兼容本数据集实测变体。
// 见 docs/GRD格式解析说明.txt（权威口径）与 docs/GRD导入与覆盖可视化设计.md。
//
// 健壮化（实测数据要求）：
//  · 结束标记按官方判据（参考实现 TEXT(1:4) == '++++'）：行首 4 个 '+' 即算，其后可跟任意内容——
//    覆盖 '+++++'（CS11）与 '++++ Grid' 一类带尾注的写法，旧的「整行等于 ++++」判据会误拒它们。
//    ★ 但 '++++NNNN'（四位数字、其后无内容）不是 GRASP：那是 SATSOFT 家族的文件 ID
//    （0020=type20 方向图 / 0025=不规则栅 / 0040=覆盖多边形，如 CS6E_Tx200 的 '++++0040'），
//    其后是 ' 5 2 / 721 38' 这类完全不同的头，硬按 GRASP 读只会读出垃圾。这类文件由
//    viz/grd/patFormats.js 的 sniffPatternFormat 在进本解析器之前就认出来并给准话，
//    两条导入路径（3D 页 useGrdCoverage.importGrd、主进程 coverage.sniffHead）都已前置。
//    本解析器不重复那套判别，只保证：头读不出来时报可读的错，而不是抛 JS 内部异常。
//  · 结束标记候选可能不止一个：文本头里的装饰行（'++++++++ Notes'）同样满足官方判据。
//    故按候选逐个试读头部，头不合法就找下一个；全不合法才报错。合法文件第一个就中，行为不变。
//  · 不假设 KTYPE=1（CS26 为 2，字段结构相同）。
//  · 不假设方形/固定尺寸（91²/101×66/179²/181²/201×161/201²/361²）。
//  · 指数 E+001(三位) 与 E+01 均可（Number() 直接解析）。
//  · KLIMIT=1 时每 Y 行前缀 (起始列, 点数)。
//  · 扩展名无关：.grd 与 .pat 同为本格式，按内容解析。
//
// 每点存两个分量的线性功率 P1=|c1|²、P2=|c2|²（极化取值/增益偏置在显示层做），
// 并保留两分量的复振幅 (Re/Im)：性能指标表的 AR 轴比需相位（由复场 bicubic 插值算）。
// 注：dir/功率取值用功率域 bicubic（见 coverage.sampleBeamAt）。

// 读某个 '++++' 之后的头：KTYPE / NSET ICOMP NCOMP IGRID。形状不对返回 null（该候选不是真结束标记）。
// 判据只卡「结构上不可能是 GRASP 头」的情形，不卡取值范围——KTYPE 实测有 1 与 2，NCOMP 有 2 与 4，
// 各家导出件的取值还会有别的，卡死了就成了误拒。
function readHead(L, at) {
  if (at + 1 >= L.length) return null
  const ktype = parseInt(L[at].trim())
  if (!Number.isFinite(ktype)) return null
  const head = L[at + 1].trim().split(/\s+/).map(Number)
  if (head.length < 4 || !head.slice(0, 4).every(Number.isFinite)) return null
  const [nset, icomp, ncomp, igrid] = head
  if (!(nset >= 1) || !(ncomp >= 1)) return null
  // 头之后至少要有：nset 行中心偏移 + 第一个 set 的两行边界/点数
  if (at + 2 + nset + 1 >= L.length) return null
  const b = L[at + 2 + nset].trim().split(/\s+/).map(Number)
  const g = L[at + 3 + nset].trim().split(/\s+/).map(Number)
  if (b.length < 4 || !b.slice(0, 4).every(Number.isFinite)) return null
  if (!(g[0] >= 2) || !(g[1] >= 2)) return null                // NX/NY：一格的网格不成其为网格
  return { ktype, nset, icomp, ncomp, igrid, next: at + 2 }
}

export function parseGrd(text) {
  const L = text.split(/\r\n|\n|\r/)
  // 逐个 '++++' 候选试读头部（官方判据 TEXT(1:4)=='++++'：行首 4 个 '+'，其后可跟任意内容）
  let h = null, i = 0, marks = 0
  for (let k = 0; k < L.length; k++) {
    if (!/^\+{4}/.test(L[k].trim())) continue
    marks++
    h = readHead(L, k + 1)
    if (h) { i = h.next; break }
  }
  if (!marks) throw new Error('未找到结束标记 ++++：可能非 GRASP 网格或二进制')
  if (!h) throw new Error('找到了 ++++ 但其后不是 GRASP 网格头（应为 KTYPE 与 NSET ICOMP NCOMP IGRID）：可能是 SATSOFT ++++NNNN 一类的同标记异格式文件')
  const { ktype, nset, icomp, ncomp, igrid } = h
  for (let s = 0; s < nset; s++) i++                           // 跳过 NSET 行中心偏移
  const sets = []
  // 取一行；文件在中途断掉时给可读的错，而不是让 undefined.trim() 抛 JS 内部异常
  const line = (n) => { const v = L[n]; if (v === undefined) throw new Error(`文件在第 ${n + 1} 行处提前结束：网格数据不完整（可能被截断或非 GRASP 网格）`); return v }
  for (let s = 0; s < nset; s++) {
    const [XS, YS, XE, YE] = line(i++).trim().split(/\s+/).map(Number)
    const [NX, NY, KLIMIT] = line(i++).trim().split(/\s+/).map(Number)
    if (!(NX >= 2) || !(NY >= 2)) throw new Error(`波束 ${s + 1} 的网格点数无效（NX=${NX}, NY=${NY}）`)
    const N = NX * NY
    const P1 = new Float32Array(N), P2 = new Float32Array(N)   // 线性功率
    const c1re = new Float32Array(N), c1im = new Float32Array(N), c2re = new Float32Array(N), c2im = new Float32Array(N)   // 复振幅（最准确取值/AR 用）
    let peakLin = -Infinity, peakIdx = 0
    for (let row = 0; row < NY; row++) {
      let cs = 0, ce = NX
      if (KLIMIT === 1) { const p = line(i++).trim().split(/\s+/).map(Number); cs = p[0] - 1; ce = cs + p[1] }
      for (let col = cs; col < ce; col++) {
        const r = line(i++).trim().split(/\s+/)
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
