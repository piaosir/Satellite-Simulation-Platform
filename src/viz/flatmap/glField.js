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
  const empty = { idx: new Uint32Array(0), lonLo: NaN, lonHi: NaN, latLo: NaN, latHi: NaN, pxLo: NaN, pxHi: NaN, pyLo: NaN, pyHi: NaN }
  const rA = box ? box.r0 : 0, rB = box ? Math.min(box.r1, NY - 1) : NY - 1
  const cA = box ? box.c0 : 0, cB = box ? Math.min(box.c1, NX - 1) : NX - 1
  if (rB <= rA || cB <= cA) return empty
  const st = Math.max(1, stride | 0)
  const rowOff = rA * NX
  const nCells = (Math.ceil((rB - rA) / st) + 1) * (Math.ceil((cB - cA) / st) + 1)
  const idx = new Uint32Array(nCells * 6)
  let n = 0, loMin = Infinity, loMax = -Infinity, laMin = Infinity, laMax = -Infinity
  let pxMin = Infinity, pxMax = -Infinity, pyMin = Infinity, pyMax = -Infinity
  const xy = plane ? plane.xy : null
  const spanX = plane ? plane.W / 2 : 0, spanY = plane ? plane.H / 2 : 0
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
  for (let row = rA; row < rB; row += st) {
    const r2 = Math.min(row + st, rB)
    for (let col = cA; col < cB; col += st) {
      const c2 = Math.min(col + st, cB)
      const i00 = row * NX + col, i10 = row * NX + c2, i01 = r2 * NX + col, i11 = r2 * NX + c2
      if (keep(i00, i10, i11)) put(i00, i10, i11)
      if (keep(i00, i11, i01)) put(i00, i11, i01)
    }
  }
  if (!n) return empty
  return {
    idx: n === idx.length ? idx : idx.subarray(0, n),
    lonLo: loMin, lonHi: loMax, latLo: laMin, latHi: laMax,
    pxLo: pxMin, pxHi: pxMax, pyLo: pyMin, pyHi: pyMax
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
      uploadAttr(e.vLon, mesh.lonU, off, len)
      uploadAttr(e.vLat, mesh.lat, off, len)
      uploadAttr(e.vDb, mesh.db, off, len)
      gl.bindVertexArray(e.vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, e.vLon); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 0, 0)
      gl.bindBuffer(gl.ARRAY_BUFFER, e.vLat); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0)
      gl.bindBuffer(gl.ARRAY_BUFFER, e.vDb); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 0, 0)
      // 等距圆柱档不喂 aPlane：关掉这条属性数组，着色器那边 uProj=0 也不读它
      if (plane) {
        gl.bindBuffer(gl.ARRAY_BUFFER, e.vPl); gl.bufferData(gl.ARRAY_BUFFER, plane.xy, gl.STATIC_DRAW)
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
