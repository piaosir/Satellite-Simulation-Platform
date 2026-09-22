// 2D 平面图「线」的 GPU 后端：等值线、聚焦卫星的星下点轨迹 / 覆盖圈 / 轨迹面两缘、波束线、仰角线。
// 与 glField.js（分带填充）共用同一个 WebGL2 上下文与画布（见 createGlField().lines()），结果同样由
// flatCoverage 用 drawImage 合成回 Canvas2D 的图层序。
//
// 为什么不再用 Canvas2D 描边：线是【每帧光栅化】的 —— Path2D 只烘一次，但 stroke 是逐帧的，成本随
// 「线段数 × 线宽」走：设备线宽 ≤ 1 px 走 Skia 的 hairline 快路（55 档等值线 11 万段约 11 ms/帧），
// > 1 px 掉进完整描边器（130～155 ms/帧）；聚焦几百颗星的轨迹连 Path2D 都没有，每帧在 JS 里逐点
// 重建路径再描。3D 球体那边同一份线走 LineSegments2（GPU 实例化四边形）每帧 0 ms —— 这里照搬同一思路。
//
// 画法（与 three 的 LineSegments2 同构）：每条线段一个实例，顶点着色器把单位四边形沿线段展开成
// 「屏幕像素」宽度的长条并在两端各外延半个线宽做圆帽；片元按到线段（胶囊）的有符号距离出覆盖率
// 做抗锯齿。逐段圆帽的并集 = Canvas2D 的 lineJoin:'round' + lineCap:'round'，形状相同。
// 虚线：片元按「线上累计距离」（打包时逐链累计的世界距离 × 当前缩放 → 屏幕 px，与 Canvas2D 的
// setLineDash 同为屏幕像素周期）判 on/off，off 段按到最近 on 段的距离出圆帽 —— 与 Canvas 每段虚线
// 各带圆帽一致。
//
// 透明度：一趟里所有实例都按不透明画进 GL 画布，贴回时用 ctx.globalAlpha 乘趟透明度 —— 每个像素
// 只混合一次，与 Canvas2D「一条 Path2D 一次 stroke」的口径相同；逐段带透明度混合会在每个接头（相邻
// 两段的圆帽重叠处）叠出一粒深点，不能那么画。故打包时按透明度分桶，同透明度的实例连续存放，一趟一贴。
//
// 坐标：等距圆柱档实例存 (lon, lat)，位置在着色器里现算 x = lon − LON0 + 环绕偏移、y = 90 − lat
// （LON0 留在 uniform 里，「拖着转」只改一个数）；投影档由 CPU 经 d3 投成平面坐标后存 (x, y)。
// 经度的解缠在打包器里做：每段起点归一到 [−180, 180)、终点相对起点就近解缠 —— 一条绕地球十圈的
// 轨迹不会把 x 累到 ±3600（float32 在那儿只剩千分之几度），也不需要十份环绕副本，±360 三份就够。

// 每条实例记录 40 字节：float32 ×8 = x0 y0 x1 y1 d0 width dashId dashScale；u8 ×4 = r g b 255；4 字节留空
export const REC_BYTES = 40
const REC_F = REC_BYTES / 4
// 虚线花样表容量（uniform 定长）：id 0 恒为实线，1..7 是打包时登记的花样，每种最多 4 段
export const DASH_MAX = 8

export const VERT_SRC = `#version 300 es
// 每个实例 10 个顶点的三角带：0–3 主四边形、4/5 是退化桥（复制 3 与 6）、6–9 接缝副本四边形。
// x∈{0,1} 沿线，y∈{-1,1} 横向，z＝0 主副本 / 1 接缝副本。
layout(location = 0) in vec3 aCorner;
layout(location = 1) in vec4 aSeg;      // x0 y0 x1 y1（等距圆柱：lon lat lon lat；投影档：平面坐标）
layout(location = 2) in vec4 aPar;      // d0（线上累计世界距离）、线宽（CSS px）、虚线花样 id、花样倍率
layout(location = 3) in vec4 aColor;    // rgb（归一化 u8）
uniform float uLon0, uK, uTx, uTy, uDpr, uW, uH;
uniform int uProj;                      // 0=等距圆柱（着色器现算平面坐标） 1=投影档（读 aSeg 原值）
out vec2 vPQ;                           // 沿线 / 横向坐标（设备 px，原点在线段起点）
out float vLen, vS0, vHalf, vAlpha, vDashScale;
flat out float vDashId;
out vec3 vColor;
void main() {
  vec2 w0, w1;
  bool seam = aCorner.z > 0.5;
  if (uProj == 1) {
    if (seam) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); vPQ = vec2(0.0); vLen = 0.0; vS0 = 0.0; vHalf = 0.0; vAlpha = 0.0; vDashScale = 1.0; vDashId = 0.0; vColor = vec3(0.0); return; }
    w0 = aSeg.xy; w1 = aSeg.zw;
  } else {
    // 主副本：起点按切口取模落进世界矩形 [0, 360)，终点相对起点解缠（打包器保证 |Δ| ≤ 180）。
    // 跨出世界矩形的段才需要第二份（接缝副本）：右出（x1 > 360）挪 −360、左出（x1 < 0）挪 +360，
    // 其余实例的接缝副本塌成零面积（不出片元）。比「每个实例画三份环绕副本」省 2/3 的顶点工作。
    float x0 = aSeg.x - uLon0;
    x0 -= 360.0 * floor(x0 / 360.0);
    float x1 = x0 + (aSeg.z - aSeg.x);
    float off = 0.0;
    if (seam) {
      if (x1 > 360.0) off = -360.0;
      else if (x1 < 0.0) off = 360.0;
      else { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); vPQ = vec2(0.0); vLen = 0.0; vS0 = 0.0; vHalf = 0.0; vAlpha = 0.0; vDashScale = 1.0; vDashId = 0.0; vColor = vec3(0.0); return; }
    }
    w0 = vec2(x0 + off, 90.0 - aSeg.y); w1 = vec2(x1 + off, 90.0 - aSeg.w);
  }
  // 世界平面 → 设备 px（与 Canvas2D 路的 setTransform 同一式子，再乘 dpr）
  vec2 p0 = (w0 * uK + vec2(uTx, uTy)) * uDpr;
  vec2 p1 = (w1 * uK + vec2(uTx, uTy)) * uDpr;
  vec2 d = p1 - p0;
  float len = length(d);
  vec2 dir = len > 1e-6 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  // 设备线宽 < 1 px：按 1 px 画、用覆盖率折成透明度（Skia 对亚像素细线同样是 hairline × 宽度的做法）
  float wDev = aPar.y * uDpr;
  float hf = max(wDev, 1.0) * 0.5;
  float hw = hf + 1.0;                  // 外扩 1 px 给抗锯齿过渡
  float along = aCorner.x * len + (aCorner.x * 2.0 - 1.0) * hw;
  vec2 p = p0 + dir * along + nrm * (aCorner.y * hw);
  gl_Position = vec4(p.x / uW * 2.0 - 1.0, 1.0 - p.y / uH * 2.0, 0.0, 1.0);
  vPQ = vec2(along, aCorner.y * hw);
  vLen = len;
  vS0 = aPar.x * uK * uDpr;             // 线上累计距离折成设备 px（虚线周期是屏幕像素）
  vHalf = hf;
  vAlpha = min(wDev, 1.0);
  vDashId = aPar.z;
  vDashScale = aPar.w * uDpr;           // 花样按线宽等比放大（打包时给），再折成设备 px
  vColor = aColor.rgb;
}`

export const FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vPQ;
in float vLen, vS0, vHalf, vAlpha, vDashScale;
flat in float vDashId;
in vec3 vColor;
uniform float uDash[${DASH_MAX * 4}];   // 花样表：每种 4 段（on, off, on, off；CSS px，未乘倍率）
uniform int uDashN[${DASH_MAX}];        // 每种的段数（0 = 实线）
out vec4 fragColor;
void main() {
  float a = vPQ.x, q = vPQ.y;
  float ac = clamp(a, 0.0, vLen);       // 线段内最近点的沿线位置
  float ext = abs(a - ac);              // 越出线段两端多少（圆帽区）
  float da = 0.0;                       // 到最近 on 段的沿线距离（实线恒 0）
  int id = int(vDashId + 0.5);
  int n = (id > 0 && id < ${DASH_MAX}) ? uDashN[id] : 0;
  if (n > 0) {
    float per = 0.0;
    for (int i = 0; i < 4; i++) { if (i < n) per += uDash[id * 4 + i]; }
    per *= vDashScale;
    float s = mod(vS0 + ac, per);
    float best = 1e9, t = 0.0;
    for (int i = 0; i < 4; i += 2) {
      if (i >= n) break;
      float A = t, B = t + uDash[id * 4 + i] * vDashScale;
      // 周期两侧的副本一起比：s 落在周期首尾附近时最近的 on 段可能在上一/下一周期里
      for (int c = -1; c <= 1; c++) { float sc = s + float(c) * per; best = min(best, max(max(A - sc, sc - B), 0.0)); }
      t = B + ((i + 1 < n) ? uDash[id * 4 + i + 1] * vDashScale : 0.0);
    }
    da = best;
  }
  // 到「胶囊」的有符号距离：沿线差（越端 + 虚线空档）与横向差合成 → 段端与每段虚线都是圆帽
  float sd = length(vec2(da + ext, q)) - vHalf;
  float cov = clamp(0.5 - sd, 0.0, 1.0) * vAlpha;
  if (cov <= 0.0) discard;
  fragColor = vec4(vColor * cov, cov);  // premultipliedAlpha 画布
}`

const clamp01 = (v) => (v < 0 ? 0 : (v > 1 ? 1 : v))

// CSS 颜色 → [r, g, b, a]（r g b 为 0..255 整数，a 为 0..1）。只认这几种写法：#rgb / #rrggbb / #rrggbbaa /
// rgb(r,g,b) / rgba(r,g,b,a)。认不出的当白色不透明 —— 与 Canvas2D 对非法 strokeStyle「保留上一次」不同，
// 这里没有「上一次」；渲染端喂进来的颜色都是这几种。
const _colorCache = new Map()
export function parseColor(css) {
  const s = String(css == null ? '' : css).trim()
  let v = _colorCache.get(s)
  if (v) return v
  v = [255, 255, 255, 1]
  if (s[0] === '#') {
    const h = s.slice(1)
    if (h.length === 3 || h.length === 4) {
      const r = parseInt(h[0] + h[0], 16), g = parseInt(h[1] + h[1], 16), b = parseInt(h[2] + h[2], 16)
      const a = h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1
      if ([r, g, b].every(Number.isFinite)) v = [r, g, b, a]
    } else if (h.length === 6 || h.length === 8) {
      const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16)
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
      if ([r, g, b].every(Number.isFinite)) v = [r, g, b, a]
    }
  } else {
    const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s)
    if (m) v = [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3]), m[4] == null ? 1 : clamp01(+m[4])]
  }
  if (_colorCache.size > 4096) _colorCache.clear()
  _colorCache.set(s, v)
  return v
}

// 线段打包器：把若干折线（各带样式）打成实例缓冲。纯 JS，Node 侧可测。
//   period：x 的周期（等距圆柱给 360，投影档给 0）。给了周期时每条链起点归一到 [−p/2, p/2)、后续点相对
//           前一点就近解缠，并把解缠后的终点再归一作为下一段的起点（见文件头）。
//   用法：style(s) → moveTo/lineTo/closePath …（可多条链）→ style(s2) … → finish()
//   finish() 返回 { buf, n, passes:[{alpha, off, n}], dashes, xMin, xMax, yMin, yMax }：
//   实例按透明度分桶后顺序拼接（桶按首次出现的顺序），passes 给出每桶的实例区间。
export function createLinePacker(opt) {
  const period = opt && opt.period > 0 ? +opt.period : 0
  const halfP = period / 2
  const dashes = [null]
  const dashKey = new Map()
  const buckets = [], byAlpha = new Map()
  let cur = null, st = null
  let has = false, x0 = 0, y0 = 0, sx = 0, sy = 0, cum = 0
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity
  const norm = (x) => { if (!period) return x; let r = x - period * Math.floor((x + halfP) / period); if (r >= halfP) r -= period; if (r < -halfP) r += period; return r }
  function bucketOf(alpha) {
    const a = Math.round(clamp01(alpha == null ? 1 : +alpha) * 1000) / 1000
    let b = byAlpha.get(a)
    if (!b) { b = { alpha: a, buf: null, f32: null, u8: null, n: 0, cap: 0 }; byAlpha.set(a, b); buckets.push(b) }
    return b
  }
  function grow(b) {
    const cap = Math.max(1024, b.cap * 2)
    const buf = new ArrayBuffer(cap * REC_BYTES), u8 = new Uint8Array(buf)
    if (b.n) u8.set(new Uint8Array(b.buf, 0, b.n * REC_BYTES))
    b.buf = buf; b.f32 = new Float32Array(buf); b.u8 = u8; b.cap = cap
  }
  function dashIdOf(p) {
    if (!p || !p.length) return 0
    const arr = p.length > 4 ? p.slice(0, 4) : (p.length % 2 ? p.concat(p) : p.slice())   // 奇数长度按 Canvas 规则重复一遍
    const key = arr.join(',')
    let id = dashKey.get(key)
    if (id != null) return id
    if (dashes.length >= DASH_MAX) return 0        // 花样表满：退回实线（渲染端只有四种花样，到不了这里）
    id = dashes.length; dashes.push(arr); dashKey.set(key, id)
    return id
  }
  function emit(ax, ay, bx, by) {
    if (ax === bx && ay === by) return
    const b = cur
    if (b.n >= b.cap) grow(b)
    const o = b.n * REC_F, f = b.f32
    f[o] = ax; f[o + 1] = ay; f[o + 2] = bx; f[o + 3] = by
    f[o + 4] = cum; f[o + 5] = st.width; f[o + 6] = st.dashId; f[o + 7] = st.dashScale
    const u = b.n * REC_BYTES + 32
    b.u8[u] = st.r; b.u8[u + 1] = st.g; b.u8[u + 2] = st.b; b.u8[u + 3] = 255
    b.n++
    if (ax < xMin) xMin = ax; if (ax > xMax) xMax = ax; if (bx < xMin) xMin = bx; if (bx > xMax) xMax = bx
    if (ay < yMin) yMin = ay; if (ay > yMax) yMax = ay; if (by < yMin) yMin = by; if (by > yMax) yMax = by
  }
  const pk = {
    // s = { rgb:[r,g,b] 0..255 | color:css, alpha, width(CSS px), dash:[on,off,…]|null, dashScale }
    style(s) {
      const c = s.rgb || parseColor(s.color)
      cur = bucketOf(s.alpha)
      st = { r: c[0] | 0, g: c[1] | 0, b: c[2] | 0, width: +s.width || 1, dashId: dashIdOf(s.dash), dashScale: s.dashScale > 0 ? +s.dashScale : 1 }
      has = false
    },
    moveTo(x, y) {
      if (!st || !Number.isFinite(x) || !Number.isFinite(y)) { has = false; return }
      x0 = norm(x); y0 = y; sx = x0; sy = y0; cum = 0; has = true
    },
    lineTo(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) { has = false; return }   // 坏点断链（Canvas 对 NaN 也是跳过）
      if (!has) { pk.moveTo(x, y); return }
      let x1 = x
      if (period) { let d = norm(x) - x0; if (d > halfP) d -= period; else if (d < -halfP) d += period; x1 = x0 + d }
      emit(x0, y0, x1, y)
      cum += Math.hypot(x1 - x0, y - y0)
      x0 = norm(x1); y0 = y
    },
    closePath() { if (has) pk.lineTo(sx, sy) },
    end() { has = false },
    // 一条折线一次打进去：pts 为 [x,y] 数组或 {lon,lat} 对象数组（x=lon、y=lat）
    polyline(pts, closed) {
      if (!pts || pts.length < 2) return
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], x = Array.isArray(a) ? a[0] : a.lon, y = Array.isArray(a) ? a[1] : a.lat
        if (i === 0) pk.moveTo(x, y); else pk.lineTo(x, y)
      }
      if (closed) pk.closePath()
      has = false
    },
    count() { let n = 0; for (const b of buckets) n += b.n; return n },
    finish() {
      let n = 0
      for (const b of buckets) n += b.n
      const buf = new ArrayBuffer(n * REC_BYTES), u8 = new Uint8Array(buf)
      const passes = []
      let off = 0
      for (const b of buckets) {
        if (!b.n) continue
        u8.set(new Uint8Array(b.buf, 0, b.n * REC_BYTES), off * REC_BYTES)
        passes.push({ alpha: b.alpha, off, n: b.n })
        off += b.n
      }
      return { buf, n, passes, dashes: dashes.slice(), xMin, xMax, yMin, yMax }
    }
  }
  return pk
}

function compile(gl, type, src) {
  const sh = gl.createShader(type)
  gl.shaderSource(sh, src); gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh); gl.deleteShader(sh)
    throw new Error('glLines: shader compile failed: ' + log)
  }
  return sh
}

// 在既有的 WebGL2 上下文上建线程序（由 createGlField().lines() 持有；上下文丢失后随之作废、恢复后重建）。
export function createGlLines(gl) {
  const vs = compile(gl, gl.VERTEX_SHADER, VERT_SRC), fs = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC)
  const prog = gl.createProgram()
  gl.attachShader(prog, vs); gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  gl.deleteShader(vs); gl.deleteShader(fs)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { const m = gl.getProgramInfoLog(prog); gl.deleteProgram(prog); throw new Error('glLines: link failed: ' + m) }
  const uni = {}
  for (const k of ['uLon0', 'uK', 'uTx', 'uTy', 'uDpr', 'uW', 'uH', 'uProj']) uni[k] = gl.getUniformLocation(prog, k)
  uni.uDash = gl.getUniformLocation(prog, 'uDash[0]')
  uni.uDashN = gl.getUniformLocation(prog, 'uDashN[0]')
  // 每实例 10 顶点的三角带（见 VERT_SRC 头注）：主四边形 4 + 退化桥 2 + 接缝副本四边形 4；每顶点 (x, y, 副本号)
  const quad = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, quad)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    0, -1, 0, 1, -1, 0, 0, 1, 0, 1, 1, 0,
    1, 1, 0, 0, -1, 1,
    0, -1, 1, 1, -1, 1, 0, 1, 1, 1, 1, 1
  ]), gl.STATIC_DRAW)
  const sets = new Map()   // id → { vbo, vao, n, passes, dashes, dashF, dashN, xMin, xMax, yMin, yMax }
  const dashF = new Float32Array(DASH_MAX * 4), dashN = new Int32Array(DASH_MAX)
  let lastDash = null, inPass = false

  function pointInstanced(e, off) {
    gl.bindBuffer(gl.ARRAY_BUFFER, e.vbo)
    const b = off * REC_BYTES
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, REC_BYTES, b); gl.vertexAttribDivisor(1, 1)
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, REC_BYTES, b + 16); gl.vertexAttribDivisor(2, 1)
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, REC_BYTES, b + 32); gl.vertexAttribDivisor(3, 1)
  }
  function drop(e) { if (e.vbo) gl.deleteBuffer(e.vbo); if (e.vao) gl.deleteVertexArray(e.vao) }

  return {
    // 上传一份打包结果（同 id 原地覆盖）。返回绘制用的元数据（不含缓冲；缓冲已在显存里）。
    upload(id, packed) {
      if (gl.isContextLost()) return null
      let e = sets.get(id)
      if (!e) {
        e = { vbo: gl.createBuffer(), vao: gl.createVertexArray(), n: 0 }
        gl.bindVertexArray(e.vao)
        gl.bindBuffer(gl.ARRAY_BUFFER, quad)
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(0, 0)
        pointInstanced(e, 0)
        gl.bindVertexArray(null)
        sets.set(id, e)
      }
      e.n = packed.n; e.passes = packed.passes; e.dashes = packed.dashes
      e.xMin = packed.xMin; e.xMax = packed.xMax; e.yMin = packed.yMin; e.yMax = packed.yMax
      if (packed.n) { gl.bindBuffer(gl.ARRAY_BUFFER, e.vbo); gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(packed.buf, 0, packed.n * REC_BYTES), gl.DYNAMIC_DRAW) }
      if (lastDash === e) lastDash = null
      return { id, n: e.n, passes: e.passes, xMin: e.xMin, xMax: e.xMax, yMin: e.yMin, yMax: e.yMax }
    },
    has(id) { return sets.has(id) },
    remove(id) { const e = sets.get(id); if (e) { drop(e); sets.delete(id); if (lastDash === e) lastDash = null } },
    keepOnly(ids) {
      const set = ids instanceof Set ? ids : new Set(ids)
      for (const [id, e] of [...sets]) if (!set.has(id)) { drop(e); sets.delete(id); if (lastDash === e) lastDash = null }
    },
    // 一趟的开头：视区参数只在这里设一次；u = { w, h（设备 px）, dpr, k, tx, ty, lon0, proj }
    begin(u) {
      if (gl.isContextLost()) return false
      gl.viewport(0, 0, u.w, u.h)
      gl.useProgram(prog)
      gl.enable(gl.BLEND)
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      gl.uniform1f(uni.uW, u.w); gl.uniform1f(uni.uH, u.h); gl.uniform1f(uni.uDpr, u.dpr)
      gl.uniform1f(uni.uK, u.k); gl.uniform1f(uni.uTx, u.tx); gl.uniform1f(uni.uTy, u.ty)
      gl.uniform1f(uni.uLon0, u.lon0); gl.uniform1i(uni.uProj, u.proj ? 1 : 0)
      lastDash = null; inPass = true
      return true
    },
    // 画某集合的某一趟（实例区间 pass = {off, n}）。等距圆柱的环绕副本由着色器自己决定（见 VERT_SRC），一次画完。
    draw(id, pass) {
      if (!inPass) return false
      const e = sets.get(id)
      if (!e || !e.n || !pass || !pass.n) return false
      if (lastDash !== e) {
        dashF.fill(0); dashN.fill(0)
        for (let i = 1; i < e.dashes.length && i < DASH_MAX; i++) { const p = e.dashes[i]; dashN[i] = p.length; for (let j = 0; j < p.length && j < 4; j++) dashF[i * 4 + j] = p[j] }
        gl.uniform1fv(uni.uDash, dashF); gl.uniform1iv(uni.uDashN, dashN)
        lastDash = e
      }
      gl.bindVertexArray(e.vao)
      if (pass.off) pointInstanced(e, pass.off)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 10, pass.n)
      if (pass.off) pointInstanced(e, 0)   // 指针放回区间起点，VAO 保持「整份缓冲」的状态
      gl.bindVertexArray(null)
      return true
    },
    end() { if (inPass) { gl.disable(gl.BLEND); inPass = false } },
    dispose() { for (const [, e] of sets) drop(e); sets.clear(); gl.deleteBuffer(quad); gl.deleteProgram(prog) }
  }
}
