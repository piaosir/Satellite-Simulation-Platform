// 2D 平面图 GRD 分带填充的 GPU 后端：把「投影后的经纬三角网」交给 WebGL2 逐像素上色，
// 结果由调用方 drawImage 合成回 Canvas2D 的图层序（见 flatCoverage.drawField）。
//
// 为什么不再逐三角填 Path2D：一张 361×361 的全地球 GRD、4 个 set，光「可见且高于最低档」的
// 网格三角形就有 ~76 万个，每个都是一条独立子路径 —— Path2D 只烘一次，但【光栅化是每帧的】，
// 成本随「图元数 × 边长」走，与电平数几乎无关（1 档 757k 子路径、24 档 851k）。
// 换到 GPU 后成本随【屏幕像素】走：平移/缩放/改档/改色/改透明度/拖指向全部只改 uniform。
//
// 与 CPU 路（coverage.js 的 bandGeometry）的等价性靠三件事保住：
//   · 索引按 bandGeometry 的三角化循环【逐字生成】（同 box、同 stride、末格夹边界、a–c 对角线），
//     并镜像 loadTri 的前两条跳过（任一角 dB 为 NaN / 三角三角全越地平）；
//   · 等距圆柱下屏幕坐标是世界度的仿射变换 → GPU 对 dB 的线性插值 ≡ bandGeometry 沿边的线性插值
//     → 等值线（仍走 CPU）与填充边界重合到亚像素；
//   · 分档判据 k = #{ i : L[i] ≤ dB } − 1 与 bandGeometry 的「d ≥ Lk 且 d ≤ Lk+1」是同一划分。
// 「max dB < L0」那一条【不】进索引（留给片元 discard）：这样索引只随场/指向变，不随电平变。
//
// 六个投影档都走这条路。等距圆柱下平面坐标是经纬的仿射，顶点位置在着色器里现算（LON0 留在
// uniform 里 → 「拖着转 / 换切口」只改一个数）；其余五档没有闭式仿射（d3 正算里有迭代），
// 顶点位置由 CPU 用 PJ.fwd 预投成 aPlane，换平面时重传一次。片元那一半两档完全一样。
//
// 地平：不再用凸包。片元按大地纬经反算归一坐标 (x/A, y/A, z/B) —— 该坐标下椭球即单位球、
// 卫星在 |S′|=ρ 处，可见 ⇔ dot(P′, S′) ≥ 1（与 coverage.limbPoint 同源的推导）。逐像素精确，
// 无采样点数这层妥协。

// 电平表上限：超过这个档数退回 CPU 路（uniform 数组是定长的）。
export const GL_MAX_LEVELS = 64

const VERT = `#version 300 es
in float aLon;
in float aLat;
in float aDb;
in vec2 aPlane;              // 投影档：CPU 用 PJ.fwd 预投出来的世界平面坐标（等距圆柱档不用）
uniform float uLon0, uOff, uK, uTx, uTy, uDpr, uW, uH;
uniform int uProj;           // 0=等距圆柱（平面坐标是经纬的仿射，现算） 1=投影档（读 aPlane）
out float vDb;
out float vLon;
out float vLat;
void main() {
  // 世界平面 → CSS px（与 Canvas2D 路的 setTransform 同一式子）。
  // 等距圆柱：x = lon − LON0（+ 环绕副本偏移），y = 90 − lat —— LON0 留在 uniform 里，
  //   「拖着转 / 换切口」只改一个数、不动缓冲。
  // 投影档：平面坐标没有闭式仿射（d3 的正算里有迭代），只能 CPU 预投；换平面才重传。
  vec2 w = (uProj == 1) ? aPlane : vec2(aLon - uLon0 + uOff, 90.0 - aLat);
  float xc = w.x * uK + uTx;
  float yc = w.y * uK + uTy;
  gl_Position = vec4((xc * uDpr) / uW * 2.0 - 1.0, 1.0 - (yc * uDpr) / uH * 2.0, 0.0, 1.0);
  vDb = aDb; vLon = aLon; vLat = aLat;
}`

// 片元源码单独导出：Node 侧的等价性测试（packages/core/test/glFieldMesh.test.mjs）钉住其中两行判据
export const FRAG_SRC = `#version 300 es
precision highp float;
in float vDb;
in float vLon;
in float vLat;
uniform vec3 uSatN;          // 卫星 ECEF 逐分量除以 (A, A, B)
uniform float uE2;           // 第一偏心率平方
uniform float uRe;           // sqrt(1 − e²)
uniform int uN;
uniform float uLevels[${GL_MAX_LEVELS}];
uniform vec3 uColors[${GL_MAX_LEVELS}];
out vec4 fragColor;
void main() {
  // ① 精确地平：归一坐标下地表点恰在单位球上，可见 ⇔ dot(P′, S′) ≥ 1
  //    经度先取模到 [0,360) 再转弧度 —— lonU 是【解缠】过的（可能到 ±540），直接喂 sin/cos 会白丢有效位
  float la = radians(vLat), lo = radians(mod(vLon, 360.0));
  float s = sin(la), c = cos(la);
  float Nn = 1.0 / sqrt(1.0 - uE2 * s * s);
  vec3 P = vec3(Nn * c * cos(lo), Nn * c * sin(lo), Nn * uRe * s);
  if (dot(P, uSatN) < 1.0) discard;
  // ② 分档：升序表，k = 最后一个 ≤ vDb 的下标。vDb 为 NaN 时比较恒假 → k 停在 −1 → discard
  int k = -1;
  for (int i = 0; i < ${GL_MAX_LEVELS}; i++) {
    if (i >= uN) break;
    if (uLevels[i] <= vDb) k = i; else break;
  }
  if (k < 0) discard;
  fragColor = vec4(uColors[k], 1.0);
}`

const FRAG = FRAG_SRC

function compile(gl, type, src) {
  const sh = gl.createShader(type)
  gl.shaderSource(sh, src); gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh); gl.deleteShader(sh)
    // 内部诊断串（被 init 的 catch 吞掉，不上界面）：写英文，免得进 i18n 扫描的漏译名单
    throw new Error('glField: shader compile failed: ' + log)
  }
  return sh
}

// 索引生成：与 coverage.js bandGeometry 的三角化循环逐字同构。
// 顶点索引以 rowOff（= 上传时截掉的行数 × NX）为基准偏移 —— 缓冲只传 box 覆盖到的那几行。
// 顺带求出【真正被引用到的顶点】的经纬跨度：合成时只 blit 这块包围盒，且视口环绕裁剪按它判。
//   ★ 不能拿整个 box 的 min/max —— limbOutside 的越地平点在极远离轴处会折回星下点乃至反面，
//     那些三角形本来就被剔掉了，让它们把包围盒撑开等于每帧多搬一大片空像素。
// 返回 { idx, lonLo, lonHi, latLo, latHi }；idx 为空时四个跨度是 NaN。
// plane（可选）= { xy: Float32Array（交错 [x,y]，下标以 rowOff 为基准）, W, H }：投影档的预投坐标。
//   给了就多两条跳过（都是 d3 geoPath 自己会做、而三角网必须自己做的事）：
//     · 任一角投不出来（PJ.fwd 给 NaN：方位等距的对跖裁剪、Mercator 的极区）→ 跳
//     · 三角形跨了投影的切口 → 跳。判据不看是哪一档投影，只看【投出来的边有多长】：
//       一个网格格子跨不了半张图，跨了就一定是从切口的一侧接到了另一侧（跨切口 ≈ 整个 W）。
export function buildMeshIndices(mesh, plane = null) {
  const { NX, NY, box, stride, db, vis, lonU, lat } = mesh
  const empty = { idx: new Uint32Array(0), lonLo: NaN, lonHi: NaN, latLo: NaN, latHi: NaN, pxLo: NaN, pxHi: NaN, pyLo: NaN, pyHi: NaN, extra: null }
  const rA = box ? box.r0 : 0, rB = box ? Math.min(box.r1, NY - 1) : NY - 1
  const cA = box ? box.c0 : 0, cB = box ? Math.min(box.c1, NX - 1) : NX - 1
  if (rB <= rA || cB <= cA) return empty
  const st = Math.max(1, stride | 0)
  const rowOff = rA * NX
  const nCells = (Math.ceil((rB - rA) / st) + 1) * (Math.ceil((cB - cA) / st) + 1)
  // 交点细化（与 bandGeometry 同一张表、同一启用条件：stride 1、表与网格 / 档表尺寸相符）。有细化时索引数没有闭式
  // 上界（跨档三角形按档切成环带多边形再扇形化），缓冲按需翻倍。
  const rf = (mesh.refine && mesh.refine.n && st === 1 && mesh.refine.NX === NX && mesh.refine.NY === NY && mesh.levels && mesh.levels.length === mesh.refine.nb) ? mesh.refine : null
  const levels = rf ? mesh.levels : null, nb = rf ? rf.nb : 0
  const len = (rB - rA + 1) * NX                       // 上传的节点顶点数；细化顶点排在其后（下标 len + 记录号）
  // 索引上界：不细化 ≤ 每格 2 三角；细化后一个 m 顶点凸多边形无论切成几带、扇形三角总数恒为 m−2
  //（各带顶点数之和 = m + 2·(带数−1)，各带扇形 m_k−2 → 求和抵消），即每条细化记录最多多出 2 个三角（它两侧的三角形各 +1）。
  // 弦中点再各加最多 2 个（所在带插一个顶点 +1、邻带的薄片 +1）。
  const idx = new Uint32Array(nCells * 6 + (rf ? (rf.n + (rf.nm || 0)) * 6 : 0))
  let n = 0, loMin = Infinity, loMax = -Infinity, laMin = Infinity, laMax = -Infinity
  let pxMin = Infinity, pxMax = -Infinity, pyMin = Infinity, pyMax = -Infinity
  const xy = plane ? plane.xy : null
  const spanX = plane ? plane.W / 2 : 0, spanY = plane ? plane.H / 2 : 0
  // 细化顶点的属性：沿所在格边在两端节点间线性插到 s*（lonU 已按星下点解缠，可直接插）；dB 精确 = 档值
  // （float32，与 uLevels 同一份数 → 片元在该顶点上恰落档边界）；投影档的平面坐标同样沿边线性插。
  // 只算起点在上传行区间内的记录，其余顶点不会被引用（留 0）。
  // 顶点号：格边交点 = len + 记录号；弦中点 = len + 记录数 + 中点号。
  // 位置：pos（projectRefine，掠地格子逐点求交）里有精确解就用它（经度按所在节点的 lonU 解缠），否则格边交点沿边线性插、
  // 弦中点按三角形三个角重心插；投影档的平面坐标一律插节点的预投坐标（与 CPU 路逐点 PJ.fwd 的差只在地平附近、亚像素）。
  // 薄片三角形另配 3 个专属顶点（位置抄 P/M/Q，d 取带内值）：薄片的三个顶点 d 若恰等于档值，片元按「最后一个 ≤ d 的档」
  // 分档会落到相邻档（上弦薄片）或因 1 ulp 舍入掉到档外 —— 专属顶点让它稳稳落在本档。
  let extra = null
  const nR = rf ? rf.n : 0, nM = rf ? (rf.nm || 0) : 0
  if (rf) {
    const nE = nR + nM + 3 * nM, en = rf.en, et = rf.et, ek = rf.ek, es = rf.es
    const pos = (mesh.pos && mesh.pos.lon && mesh.pos.lon.length === nR && mesh.pos.mlon && mesh.pos.mlon.length === nM) ? mesh.pos : null
    extra = { n: nE, lon: new Float32Array(nE), lat: new Float32Array(nE), db: new Float32Array(nE), xy: xy ? new Float32Array(nE * 2) : null }
    const iEnd = Math.min(NX * NY, (rB + 1) * NX)
    const unwrapTo = (l, ref) => { while (l - ref > 180) l -= 360; while (l - ref < -180) l += 360; return l }
    for (let p = 0; p < nR; p++) {                                   // 逐记录（O(记录数)，不扫节点）
      const i = en[p]
      if (i < rowOff || i >= iEnd) continue
      const t = et[p], f = t === 0 ? i + 1 : (t === 1 ? i + NX : i + NX + 1), s = es[p]
      if (f >= iEnd) continue
      if (pos && pos.lon[p] === pos.lon[p]) { extra.lon[p] = unwrapTo(pos.lon[p], lonU[i]); extra.lat[p] = pos.lat[p] }
      else { extra.lon[p] = lonU[i] + (lonU[f] - lonU[i]) * s; extra.lat[p] = lat[i] + (lat[f] - lat[i]) * s }
      extra.db[p] = levels[ek[p]]
      if (xy) { const a = (i - rowOff) * 2, b = (f - rowOff) * 2; extra.xy[p * 2] = xy[a] + (xy[b] - xy[a]) * s; extra.xy[p * 2 + 1] = xy[a + 1] + (xy[b + 1] - xy[a + 1]) * s }
    }
    if (nM) {
      const { cells, moff, mt, mk, mu, mv } = rf
      for (let ci = 0; ci < cells.length; ci++) {
        const a = moff[ci], b = moff[ci + 1]; if (a === b) continue
        const i00 = cells[ci], i10 = i00 + 1, i01 = i00 + NX, i11 = i01 + 1
        if (i00 < rowOff || i11 >= iEnd) continue
        for (let q = a; q < b; q++) {
          const isB = mt[q] === 1, iB = isB ? i11 : i10, iC = isB ? i01 : i11, u = mu[q], v = mv[q]
          const lA = isB ? 1 - v : 1 - u, lB = isB ? u : u - v, lC = isB ? v - u : v
          const e = nR + q
          if (pos && pos.mlon[q] === pos.mlon[q]) { extra.lon[e] = unwrapTo(pos.mlon[q], lonU[i00]); extra.lat[e] = pos.mlat[q] }
          else { extra.lon[e] = lA * lonU[i00] + lB * lonU[iB] + lC * lonU[iC]; extra.lat[e] = lA * lat[i00] + lB * lat[iB] + lC * lat[iC] }
          extra.db[e] = levels[mk[q]]
          if (xy) { const oa = (i00 - rowOff) * 2, ob = (iB - rowOff) * 2, oc = (iC - rowOff) * 2; extra.xy[e * 2] = lA * xy[oa] + lB * xy[ob] + lC * xy[oc]; extra.xy[e * 2 + 1] = lA * xy[oa + 1] + lB * xy[ob + 1] + lC * xy[oc + 1] }
        }
      }
    }
  }
  // loadTri 的前两条：任一角 dB 为 NaN → 跳；三个角 vis 全 < 0 → 跳（整三角越地平）。
  // ★ 第二条必须做：limbOutside 的越地平顶点落在地平【外】，且极远离轴处 pRaw 会折回星下点附近
  //   —— 不剔就会把地平外的方向图值糊到地球上。
  //   「max dB < L0」那一条【不】在这里做：留给片元 discard，索引才不随电平表变。
  const keep = (i0, i1, i2) => {
    const d0 = db[i0], d1 = db[i1], d2 = db[i2]
    if (d0 !== d0 || d1 !== d1 || d2 !== d2) return false
    if (vis[i0] < 0 && vis[i1] < 0 && vis[i2] < 0) return false
    if (!xy) return true
    const a = (i0 - rowOff) * 2, b = (i1 - rowOff) * 2, c = (i2 - rowOff) * 2
    const x0 = xy[a], y0 = xy[a + 1], x1 = xy[b], y1 = xy[b + 1], x2 = xy[c], y2 = xy[c + 1]
    if (!(x0 === x0 && y0 === y0 && x1 === x1 && y1 === y1 && x2 === x2 && y2 === y2)) return false
    if (Math.max(x0, x1, x2) - Math.min(x0, x1, x2) > spanX) return false
    if (Math.max(y0, y1, y2) - Math.min(y0, y1, y2) > spanY) return false
    return true
  }
  const ext = (q) => {
    const u = lonU[q], y = lat[q]
    if (u < loMin) loMin = u
    if (u > loMax) loMax = u
    if (y < laMin) laMin = y
    if (y > laMax) laMax = y
    if (xy) {
      const o = (q - rowOff) * 2, px = xy[o], py = xy[o + 1]
      if (px < pxMin) pxMin = px
      if (px > pxMax) pxMax = px
      if (py < pyMin) pyMin = py
      if (py > pyMax) pyMax = py
    }
  }
  const put = (i0, i1, i2) => {
    idx[n] = i0 - rowOff; idx[n + 1] = i1 - rowOff; idx[n + 2] = i2 - rowOff; n += 3
    ext(i0); ext(i1); ext(i2)
  }
  // 跨档三角形（三条边上有细化交点）：与 bandGeometry.augment 同序插点成凸多边形 → 每档取「d∈[Lk,Lk+1] 的顶点子列」
  // 即该档的环带多边形（相邻档共用细化交点为弦端）→ 逐带扇形三角化。GPU 在每个扇形三角形内线性插值，档边界即弦
  // = CPU 等值线段（同一对细化交点）；带内顶点 d 全在 [Lk,Lk+1] → 片元分档与 CPU 填充逐带一致。
  // 顶点号：节点 = 全局下标 − rowOff；细化顶点 = len + 记录号。d 一律拿 float32 档值 / 节点值比较（与片元同一份数）。
  // 表内同边记录按档升序、s* 沿边单调 → 沿 (ia→ib) 要 s 升序只看 d 沿边升还是降：升取表序、降取倒序。
  const pv = rf ? new Int32Array(8 + 3 * nb) : null, pd = rf ? new Float64Array(8 + 3 * nb) : null
  const rOff = rf ? rf.off : null, rEt = rf ? rf.et : null, rEk = rf ? rf.ek : null
  const pushEdge = (m, ia, ib, node, type) => {
    let p = rOff[node]; const pe = rOff[node + 1]
    while (p < pe && rEt[p] !== type) p++
    if (p === pe) return m
    let q = p + 1; while (q < pe && rEt[q] === type) q++
    if (db[ia] < db[ib]) { for (let i = p; i < q; i++) { pv[m] = len + i; pd[m] = levels[rEk[i]]; m++ } }
    else { for (let i = q - 1; i >= p; i--) { pv[m] = len + i; pd[m] = levels[rEk[i]]; m++ } }
    return m
  }
  const upperB = (arr, cnt, v) => { let lo = 0, hi = cnt; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= v) lo = mid + 1; else hi = mid } return lo }
  // isB=格内第二个三角形。三条边在表里的定位与 coverage.bandGeometry 的 augment 逐字同序：
  //   A=(i00,i10,i11)：底边 h@i00、右边 v@i10、对角 d@i00；B=(i00,i11,i01)：对角 d@i00、顶边 h@i01、左边 v@i00
  // 弦中点（与 coverage.bandGeometry.pushBand 同一套规则）：某档在本三角形的弦 P–Q 若有中点 M，弧鼓进哪一档，
  // 那一档就在弦上插 M 开凹口（扇心取凹口顶点，既不漏画也不重叠），另一档得薄片三角形 (P,M,Q)。
  const rMt = rf ? rf.mt : null, rMk = rf ? rf.mk : null, rMs = rf ? rf.ms : null
  const mBase = len + nR
  const bv = rf ? new Int32Array(12 + 3 * nb) : null, bd = rf ? new Float64Array(12 + 3 * nb) : null
  const midOf = (m0, m1, tri, k) => { for (let p = m0; p < m1; p++) if (rMt[p] === tri && rMk[p] === k) return p; return -1 }
  // 薄片 (P,M,Q) 归第 k 档：三顶点位置抄自 P/M/Q，d 取带内值 → 片元稳落第 k 档
  const copyV = (id, s) => {
    if (id < len) { const i = id + rowOff; extra.lon[s] = lonU[i]; extra.lat[s] = lat[i]; if (xy) { const o = id * 2; extra.xy[s * 2] = xy[o]; extra.xy[s * 2 + 1] = xy[o + 1] } }
    else { const e = id - len; extra.lon[s] = extra.lon[e]; extra.lat[s] = extra.lat[e]; if (xy) { extra.xy[s * 2] = extra.xy[e * 2]; extra.xy[s * 2 + 1] = extra.xy[e * 2 + 1] } }
  }
  const sliver = (q, k, idA, idM, idB) => {
    const s = nR + nM + 3 * q, dIn = k < nb - 1 ? 0.5 * (levels[k] + levels[k + 1]) : levels[k] + 1
    copyV(idA, s); copyV(idM, s + 1); copyV(idB, s + 2)
    extra.db[s] = dIn; extra.db[s + 1] = dIn; extra.db[s + 2] = dIn
    idx[n] = len + s; idx[n + 1] = len + s + 1; idx[n + 2] = len + s + 2; n += 3
  }
  const putR = (i0, i1, i2, isB, m0, m1) => {
    let m = 0
    pv[m] = i0 - rowOff; pd[m++] = db[i0]; m = isB ? pushEdge(m, i0, i1, i0, 2) : pushEdge(m, i0, i1, i0, 0)
    pv[m] = i1 - rowOff; pd[m++] = db[i1]; m = isB ? pushEdge(m, i1, i2, i2, 0) : pushEdge(m, i1, i2, i1, 1)
    pv[m] = i2 - rowOff; pd[m++] = db[i2]; m = isB ? pushEdge(m, i2, i0, i0, 1) : pushEdge(m, i2, i0, i0, 2)
    if (m === 3) { put(i0, i1, i2); return }
    const d0 = db[i0], d1 = db[i1], d2 = db[i2]
    const dmin = Math.min(d0, d1, d2), dmax = Math.max(d0, d1, d2)
    const kHi = upperB(levels, nb, dmax) - 1                          // 三个角全低于最低档 → 什么都不出（片元本来也 discard）
    if (kHi >= 0) {
      const kLo = Math.max(0, upperB(levels, nb, dmin) - 1), tri = isB ? 1 : 0
      for (let k = kLo; k <= kHi; k++) {
        const lo = levels[k], hi = k < nb - 1 ? levels[k + 1] : Infinity
        let c2 = 0
        for (let q = 0; q < m; q++) { const d = pd[q]; if (d < lo || d > hi) continue; bv[c2] = pv[q]; bd[c2] = d; c2++ }   // 本档顶点子列（环序）
        if (c2 < 3) continue
        let apex = 0
        if (m1 > m0) for (let pass = 0; pass < 2; pass++) {
          const q = pass === 0 ? midOf(m0, m1, tri, k) : (k < nb - 1 ? midOf(m0, m1, tri, k + 1) : -1)
          if (q < 0) continue
          const L = pass === 0 ? lo : hi
          let ia = -1
          for (let i = 0; i < c2; i++) { if (bd[i] === L && bd[(i + 1) % c2] === L) { ia = i; break } }   // 弦 = 相邻两个 d===L
          if (ia < 0) continue
          const idM = mBase + q, ib = (ia + 1) % c2
          if (pass === 0 ? rMs[q] === 1 : rMs[q] === 0) {            // 弧鼓进本档 → 插 M 开凹口
            for (let i = c2 - 1; i > ia; i--) { bv[i + 1] = bv[i]; bd[i + 1] = bd[i] }
            bv[ia + 1] = idM; bd[ia + 1] = L; c2++
            if (apex === 0) apex = ia + 1; else if (apex > ia) apex++
          } else sliver(q, k, bv[ia], idM, bv[ib])                       // 薄片归本档
        }
        for (let i = 1; i < c2 - 1; i++) { idx[n] = bv[apex]; idx[n + 1] = bv[(apex + i) % c2]; idx[n + 2] = bv[(apex + i + 1) % c2]; n += 3 }
      }
    }
    ext(i0); ext(i1); ext(i2)
  }
  // 细化：格子按行主序、i00 单调递增，指针 rp 顺着 rf.cells（五条边上有记录的格子，升序）走，每格 O(1) 判要不要进 putR。
  const rCells = rf ? rf.cells : null, nrc = rf ? rf.cells.length : 0, rMoff = (rf && rf.nm) ? rf.moff : null
  let rp = 0
  for (let row = rA; row < rB; row += st) {
    const r2 = Math.min(row + st, rB)
    for (let col = cA; col < cB; col += st) {
      const c2 = Math.min(col + st, cB)
      const i00 = row * NX + col, i10 = row * NX + c2, i01 = r2 * NX + col, i11 = r2 * NX + c2
      let aug = false, m0 = 0, m1 = 0
      if (rf) { while (rp < nrc && rCells[rp] < i00) rp++; aug = rp < nrc && rCells[rp] === i00; if (aug && rMoff) { m0 = rMoff[rp]; m1 = rMoff[rp + 1] } }
      if (aug) {
        if (keep(i00, i10, i11)) putR(i00, i10, i11, false, m0, m1)
        if (keep(i00, i11, i01)) putR(i00, i11, i01, true, m0, m1)
      } else {
        if (keep(i00, i10, i11)) put(i00, i10, i11)
        if (keep(i00, i11, i01)) put(i00, i11, i01)
      }
    }
  }
  if (!n) return empty
  return {
    idx: n === idx.length ? idx : idx.subarray(0, n),
    lonLo: loMin, lonHi: loMax, latLo: laMin, latHi: laMax,
    pxLo: pxMin, pxHi: pxMax, pyLo: pyMin, pyHi: pyMax,
    extra
  }
}

// 三角化实际引用到的行 / 列（与上面的循环同构）：投影档只需要给【这些格点】跑 PJ.fwd，
// stride=2/4 时点数直接降到 1/4 / 1/16。
export function meshLattice(mesh) {
  const { NX, NY, box, stride } = mesh
  const rA = box ? box.r0 : 0, rB = box ? Math.min(box.r1, NY - 1) : NY - 1
  const cA = box ? box.c0 : 0, cB = box ? Math.min(box.c1, NX - 1) : NX - 1
  if (rB <= rA || cB <= cA) return { rows: [], cols: [], rA, rB, cA, cB }
  const st = Math.max(1, stride | 0)
  const rows = [], cols = []
  for (let r = rA; r < rB; r += st) rows.push(r)
  rows.push(rB)
  for (let c = cA; c < cB; c += st) cols.push(c)
  cols.push(cB)
  return { rows, cols, rA, rB, cA, cB }
}

export function createGlField() {
  let cv = null, gl = null, prog = null, lost = false
  let uni = null
  let onLost = null
  const layers = new Map()   // id → { vLon, vLat, vDb, ebo, vao, count, rowOff }
  let W = 1, H = 1

  function init() {
    try {
      cv = document.createElement('canvas')
      cv.width = 1; cv.height = 1
      gl = cv.getContext('webgl2', {
        alpha: true, premultipliedAlpha: true, antialias: false,
        preserveDrawingBuffer: false, depth: false, stencil: false
      })
      if (!gl) { gl = null; return }
      const vs = compile(gl, gl.VERTEX_SHADER, VERT), fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
      prog = gl.createProgram()
      gl.attachShader(prog, vs); gl.attachShader(prog, fs)
      gl.bindAttribLocation(prog, 0, 'aLon'); gl.bindAttribLocation(prog, 1, 'aLat'); gl.bindAttribLocation(prog, 2, 'aDb'); gl.bindAttribLocation(prog, 3, 'aPlane')
      gl.linkProgram(prog)
      gl.deleteShader(vs); gl.deleteShader(fs)
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog))
      uni = {}
      for (const k of ['uLon0', 'uOff', 'uK', 'uTx', 'uTy', 'uDpr', 'uW', 'uH', 'uSatN', 'uE2', 'uRe', 'uN', 'uLevels', 'uColors', 'uProj']) {
        uni[k] = gl.getUniformLocation(prog, k === 'uLevels' || k === 'uColors' ? k + '[0]' : k)
      }
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE)
      gl.clearColor(0, 0, 0, 0)
      // 上下文丢失：立刻停用（调用方据此把后端切回 'paths' 并重算一轮），恢复后重建
      cv.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; layers.clear(); if (onLost) onLost(false) })
      cv.addEventListener('webglcontextrestored', () => { lost = false; gl = null; prog = null; init2(); if (onLost) onLost(true) })
    } catch { gl = null; prog = null }
  }
  // 上下文恢复后的重建：拿回同一张 canvas 上的新上下文（缓冲全丢，由调用方重喂）
  function init2() {
    try {
      gl = cv.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: false, depth: false, stencil: false })
      if (!gl) return
      const vs = compile(gl, gl.VERTEX_SHADER, VERT), fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
      prog = gl.createProgram()
      gl.attachShader(prog, vs); gl.attachShader(prog, fs)
      gl.bindAttribLocation(prog, 0, 'aLon'); gl.bindAttribLocation(prog, 1, 'aLat'); gl.bindAttribLocation(prog, 2, 'aDb'); gl.bindAttribLocation(prog, 3, 'aPlane')
      gl.linkProgram(prog); gl.deleteShader(vs); gl.deleteShader(fs)
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { gl = null; prog = null; return }
      uni = {}
      for (const k of ['uLon0', 'uOff', 'uK', 'uTx', 'uTy', 'uDpr', 'uW', 'uH', 'uSatN', 'uE2', 'uRe', 'uN', 'uLevels', 'uColors', 'uProj']) {
        uni[k] = gl.getUniformLocation(prog, k === 'uLevels' || k === 'uColors' ? k + '[0]' : k)
      }
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE)
      gl.clearColor(0, 0, 0, 0)
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H }
    } catch { gl = null; prog = null }
  }
  init()

  const alive = () => !!(gl && prog && !lost && !gl.isContextLost())

  function dropLayer(e) {
    if (!gl) return
    gl.deleteBuffer(e.vLon); gl.deleteBuffer(e.vLat); gl.deleteBuffer(e.vDb); gl.deleteBuffer(e.vPl); gl.deleteBuffer(e.ebo)
    if (e.vao) gl.deleteVertexArray(e.vao)
  }

  // 顶点缓冲：只传 box 覆盖到的【整行】区间（列没法在不复制的前提下压缩），子数组是视图、零拷贝。
  function uploadAttr(buf, arr, off, len) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW, off, len)
  }

  return {
    canvas: () => cv,
    available: () => alive(),
    // 上下文丢失/恢复的通知（参数 true=恢复可用）
    setOnContextChange(fn) { onLost = fn },
    resize(w, h) {
      W = Math.max(1, w | 0); H = Math.max(1, h | 0)
      if (cv && (cv.width !== W || cv.height !== H)) { cv.width = W; cv.height = H }
    },
    // 该层的 GPU 缓冲：同 id 就地重传（bufferData 同尺寸即原地覆盖），否则新建。
    // plane（可选）= { xy, W, H }：投影档的预投平面坐标（见 buildMeshIndices）。
    // 返回 { lonLo..latHi, pxLo..pyHi, tris }（供视口裁剪与逐层 blit 定包围盒），失败返回 null。
    upload(id, mesh, plane = null) {
      if (!alive()) return null
      const mi = buildMeshIndices(mesh, plane)
      const idx = mi.idx
      let e = layers.get(id)
      if (!e) {
        e = { vLon: gl.createBuffer(), vLat: gl.createBuffer(), vDb: gl.createBuffer(), vPl: gl.createBuffer(), ebo: gl.createBuffer(), vao: gl.createVertexArray(), count: 0 }
        layers.set(id, e)
      }
      const rA = mesh.box ? mesh.box.r0 : 0
      const rB = mesh.box ? Math.min(mesh.box.r1, mesh.NY - 1) : mesh.NY - 1
      const off = rA * mesh.NX, len = Math.max(0, (rB - rA + 1) * mesh.NX)
      e.count = idx.length
      const ret = {
        lonLo: mi.lonLo, lonHi: mi.lonHi, latLo: mi.latLo, latHi: mi.latHi,
        pxLo: mi.pxLo, pxHi: mi.pxHi, pyLo: mi.pyLo, pyHi: mi.pyHi,
        tris: idx.length / 3, proj: !!plane
      }
      if (!len || !idx.length) { e.count = 0; return ret }
      // 细化顶点（buildMeshIndices 的 extra）排在节点区间之后：拼成一份再传（拼接缓冲按层复用、只增不减）；
      // 没有细化时仍是零拷贝子数组。
      const ex = mi.extra, nE = ex ? ex.n : 0, tot = len + nE
      const join = (key, src, srcOff, add, w) => {
        const cat = e.cat || (e.cat = {})
        let a = cat[key]; if (!a || a.length < tot * w) a = cat[key] = new Float32Array(tot * w)
        a.set(src.subarray(srcOff * w, (srcOff + len) * w), 0); a.set(add, len * w); return a
      }
      if (nE) {
        uploadAttr(e.vLon, join('lon', mesh.lonU, off, ex.lon, 1), 0, tot)
        uploadAttr(e.vLat, join('lat', mesh.lat, off, ex.lat, 1), 0, tot)
        uploadAttr(e.vDb, join('db', mesh.db, off, ex.db, 1), 0, tot)
      } else {
        uploadAttr(e.vLon, mesh.lonU, off, len)
        uploadAttr(e.vLat, mesh.lat, off, len)
        uploadAttr(e.vDb, mesh.db, off, len)
      }
      gl.bindVertexArray(e.vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, e.vLon); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 0, 0)
      gl.bindBuffer(gl.ARRAY_BUFFER, e.vLat); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0)
      gl.bindBuffer(gl.ARRAY_BUFFER, e.vDb); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 0, 0)
      // 等距圆柱档不喂 aPlane：关掉这条属性数组，着色器那边 uProj=0 也不读它
      if (plane) {
        gl.bindBuffer(gl.ARRAY_BUFFER, e.vPl)
        if (nE) gl.bufferData(gl.ARRAY_BUFFER, join('xy', plane.xy, 0, ex.xy, 2), gl.STATIC_DRAW, 0, tot * 2)
        else gl.bufferData(gl.ARRAY_BUFFER, plane.xy, gl.STATIC_DRAW)
        gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 0, 0)
      } else gl.disableVertexAttribArray(3)
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, e.ebo)
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW)
      gl.bindVertexArray(null)
      return ret
    },
    has(id) { return layers.has(id) },
    remove(id) { const e = layers.get(id); if (e) { dropLayer(e); layers.delete(id) } },
    // 保留给定 id 集合，其余释放（层消失时收回显存）
    keepOnly(ids) {
      const set = ids instanceof Set ? ids : new Set(ids)
      for (const [id, e] of [...layers]) if (!set.has(id)) { dropLayer(e); layers.delete(id) }
    },
    clear() { if (alive()) { gl.viewport(0, 0, W, H); gl.clear(gl.COLOR_BUFFER_BIT) } },
    // 每帧只改 uniform：视区变化（平移/缩放/换切口）在这里【不触发任何缓冲上传】。
    // 一次调用画一份环绕副本；一层的三份画完由调用方 drawImage 合成一次。
    begin(mesh, projected = false) {
      if (!alive()) return false
      gl.viewport(0, 0, W, H)
      gl.useProgram(prog)
      gl.uniform1i(uni.uProj, projected ? 1 : 0)
      const nb = Math.min(mesh.levels.length, GL_MAX_LEVELS)
      gl.uniform1i(uni.uN, nb)
      gl.uniform1fv(uni.uLevels, mesh.levels.subarray ? mesh.levels.subarray(0, nb) : mesh.levels.slice(0, nb))
      gl.uniform3fv(uni.uColors, mesh.colors.subarray ? mesh.colors.subarray(0, nb * 3) : mesh.colors.slice(0, nb * 3))
      gl.uniform3f(uni.uSatN, mesh.satN[0], mesh.satN[1], mesh.satN[2])
      gl.uniform1f(uni.uE2, mesh.e2); gl.uniform1f(uni.uRe, Math.sqrt(1 - mesh.e2))
      gl.uniform1f(uni.uW, W); gl.uniform1f(uni.uH, H)
      return true
    },
    draw(id, u) {
      if (!alive()) return false
      const e = layers.get(id)
      if (!e || !e.count) return false
      gl.uniform1f(uni.uLon0, u.lon0); gl.uniform1f(uni.uOff, u.off)
      gl.uniform1f(uni.uK, u.k); gl.uniform1f(uni.uTx, u.tx); gl.uniform1f(uni.uTy, u.ty); gl.uniform1f(uni.uDpr, u.dpr)
      gl.bindVertexArray(e.vao)
      gl.drawElements(gl.TRIANGLES, e.count, gl.UNSIGNED_INT, 0)
      gl.bindVertexArray(null)
      return true
    },
    // 该层实际画了多少三角形（验证台/开发计数器用）
    tris(id) { const e = layers.get(id); return e ? e.count / 3 : 0 },
    dispose() {
      if (gl) { for (const [, e] of layers) dropLayer(e); if (prog) gl.deleteProgram(prog) }
      layers.clear(); gl = null; prog = null; cv = null
    }
  }
}
