// 2D 平面图「底图线」的 GPU 呈现层：经纬网 / 图廓 / 二级·一级行政区界 / 五类边界线 / 岛链。
// 线本身由 glLines.js 的实例化胶囊程序画（与数据线、等值线同一套），本文件只管两件事：
//   ① 按视口挑块（纯函数，Node 侧可测）：打包后的实例按「连续 + 空间相近」切块记包围盒，每帧只画与视口相交的块；
//   ② 分类合成 + 缓存（WebGL2）：各类按 drawLinesContent 的层序画进一张离屏缓存纹理 —— 每类先在暂存纹理里
//      按 MAX 混合画（覆盖率取最大 = 按到整条折线的最近距离抗锯齿，与 Canvas2D「一条 Path2D 一次 stroke」同口径；
//      逐段普通混合会在密集顶点上把抗锯齿边缘层层叠深），再按该类透明度贴回（每像素只混合一次）。
//      视角与内容都没变时整张缓存原样复用，时间轴播放这类「只有别的层在动」的帧只付一次贴图。
//
// 为什么底图线要搬上 GPU：它原本烘在静态快照里，缩放手势期间快照只能按比例缩着贴（放大 = 位图放大 = 糊），
// 要等手势冷下来再整份重建（10m 一次 30～130 ms 的光栅，全花在几十万点的描边上）。每帧由 GPU 按当前视角
// 现画之后，缩放的每一格都是清楚的，快照里只剩填充与文字，重建也随之变便宜。
//
// ★ 导出（PNG / PDF）一行不走这里：flatCoverage 的闸门含 !compat && !exporting，导出照旧 Canvas2D 描边。

// ---- 分块（视口裁剪）----
// f：打包结果的 Float32Array 视图（每实例 REC_F=10 个 float：x0 y0 x1 y1 …）；n：实例数。
// period>0（等距圆柱，x=经度 y=纬度）：块内按块首的参考经度就近解缠，包围盒是连续的经度区间；
// period=0（平面坐标，x/y 就是平面坐标）：直接取包围盒。
// 切块：满 maxN 个实例，或再加一段包围盒就超出 maxSpan（世界单位：度 / 平面单位）就另起一块。
// 返回 [{ off, n, x0, x1, y0, y1 }]，off/n 是实例区间（与 glLines.draw 的 pass 同形）。
export const CHUNK_REC_F = 10
export function buildChunks(f, n, period, maxN = 1024, maxSpan = 24) {
  const out = []
  let off = 0, cnt = 0, x0 = 0, x1 = 0, y0 = 0, y1 = 0, ref = 0
  for (let i = 0; i < n; i++) {
    const o = i * CHUNK_REC_F
    let ax = f[o], bx = f[o + 2]
    const ay = f[o + 1], by = f[o + 3]
    if (cnt && period) { const s = period * Math.round((ref - 0.5 * (ax + bx)) / period); ax += s; bx += s }
    const lx = ax < bx ? ax : bx, hx = ax < bx ? bx : ax, ly = ay < by ? ay : by, hy = ay < by ? by : ay
    if (cnt && (cnt >= maxN || (hx > x1 ? hx : x1) - (lx < x0 ? lx : x0) > maxSpan || (hy > y1 ? hy : y1) - (ly < y0 ? ly : y0) > maxSpan)) {
      out.push({ off, n: cnt, x0, x1, y0, y1 }); cnt = 0
    }
    if (!cnt) { off = i; x0 = lx; x1 = hx; y0 = ly; y1 = hy; ref = 0.5 * (ax + bx) }
    else { if (lx < x0) x0 = lx; if (hx > x1) x1 = hx; if (ly < y0) y0 = ly; if (hy > y1) y1 = hy }
    cnt++
  }
  if (cnt) out.push({ off, n: cnt, x0, x1, y0, y1 })
  return out
}

// 挑出与视口相交的块，相邻的并成一段。
// v = { period, lon0, x0, x1, y0, y1 }：x0..y1 是视口在【世界平面】里的范围（已含线宽 / 抗锯齿余量）。
//   period>0：块的包围盒是 (经度, 纬度)，世界 x = (经度 − lon0) mod 360（与 glLines 着色器同式）、世界 y = 90 − 纬度；
//   着色器只给跨出世界矩形的段补一份 ±360 的接缝副本，故横向按三个落点（−360 / 0 / +360）都判一遍。
// 返回 { ranges:[{off,n}], box }：box 是可见块落在视口内那部分的并（世界平面坐标），全不可见时为 null。
export function visibleRanges(chunks, v) {
  const ranges = []
  let rOff = -1, rEnd = -1
  let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity
  const take = (a, b, c, d) => {   // 世界平面里的一块 [a,b]×[c,d]，裁到视口后并进 box
    const p = a > v.x0 ? a : v.x0, q = b < v.x1 ? b : v.x1, r = c > v.y0 ? c : v.y0, s = d < v.y1 ? d : v.y1
    if (q < p || s < r) return false
    if (p < bx0) bx0 = p; if (q > bx1) bx1 = q; if (r < by0) by0 = r; if (s > by1) by1 = s
    return true
  }
  for (const c of chunks) {
    let vis = false
    if (v.period) {
      const wy0 = 90 - c.y1, wy1 = 90 - c.y0
      if (c.x1 - c.x0 >= v.period) vis = take(v.x0, v.x1, wy0, wy1)
      else {
        let a = (c.x0 - v.lon0) % v.period
        if (a < 0) a += v.period
        const b = a + (c.x1 - c.x0)
        const m = take(a, b, wy0, wy1), l = take(a - v.period, b - v.period, wy0, wy1), r = take(a + v.period, b + v.period, wy0, wy1)
        vis = m || l || r
      }
    } else vis = take(c.x0, c.x1, c.y0, c.y1)
    if (!vis) continue
    if (c.off === rEnd) rEnd = c.off + c.n
    else { if (rOff >= 0) ranges.push({ off: rOff, n: rEnd - rOff }); rOff = c.off; rEnd = c.off + c.n }
  }
  if (rOff >= 0) ranges.push({ off: rOff, n: rEnd - rOff })
  return { ranges, box: bx1 >= bx0 ? { x0: bx0, x1: bx1, y0: by0, y1: by1 } : null }
}

// ---- 分类合成 + 缓存（WebGL2）----
// 合成程序：全屏三角形，按像素 texelFetch 取纹理（与目标同尺寸、同朝向 → 1:1 不重采样），乘 uAlpha。
// 纹理里是预乘色（glLines 片元输出 vec4(rgb·cov, cov)），乘透明度仍是预乘色。
const COMP_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID & 1) * 4 - 1), float((gl_VertexID & 2) * 2 - 1));
  gl_Position = vec4(p, 0.0, 1.0);
}`
const COMP_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform float uAlpha;
out vec4 fragColor;
void main() { fragColor = texelFetch(uTex, ivec2(gl_FragCoord.xy), 0) * uAlpha; }`
// 挪位拷贝：缓存整张平移整数个像素（GL 坐标，y 向上）。出界的地方给 0（透明），即「露出来、待补画」的那一圈。
const SHIFT_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform ivec2 uOff;
out vec4 fragColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) - uOff;
  ivec2 sz = textureSize(uTex, 0);
  fragColor = (p.x < 0 || p.y < 0 || p.x >= sz.x || p.y >= sz.y) ? vec4(0.0) : texelFetch(uTex, p, 0);
}`

// 同一缩放下纯平移（设备像素 dx 右正、dy 下正）之后，画布上【露出来】的那一圈：互不重叠的矩形（左上原点，
// 设备像素）—— 一竖条整高 + 一横条去掉竖条那几列。★ 必须不重叠：每块各自按类合成一遍，重叠处同一类会被贴两次。
// 位移太大（露出超过 maxFrac 的画面）返回 null：那时整张重画不比补条带贵。
export function shiftStrips(dx, dy, W, H, maxFrac = 0.6) {
  if (!dx && !dy) return []
  if (Math.abs(dx) >= W || Math.abs(dy) >= H) return null
  const out = []
  let xa = 0, xw = W
  if (dx > 0) { out.push({ x: 0, y: 0, w: dx, h: H }); xa = dx; xw = W - dx }
  else if (dx < 0) { out.push({ x: W + dx, y: 0, w: -dx, h: H }); xw = W + dx }
  if (dy > 0 && xw > 0) out.push({ x: xa, y: 0, w: xw, h: dy })
  else if (dy < 0 && xw > 0) out.push({ x: xa, y: H + dy, w: xw, h: -dy })
  let area = 0
  for (const r of out) area += r.w * r.h
  return area > maxFrac * W * H ? null : out
}

function compile(gl, type, src) {
  const sh = gl.createShader(type)
  gl.shaderSource(sh, src); gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh); gl.deleteShader(sh)
    throw new Error('glBaseLines: shader compile failed: ' + log)
  }
  return sh
}

// gl：glField 的 WebGL2 上下文；gll：同一上下文上的线程序（createGlLines）。上下文丢失即整份作废（由 glField 置空重建）。
function link(gl, vsSrc, fsSrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc), fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc)
  const p = gl.createProgram()
  gl.attachShader(p, vs); gl.attachShader(p, fs)
  gl.linkProgram(p)
  gl.deleteShader(vs); gl.deleteShader(fs)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { const m = gl.getProgramInfoLog(p); gl.deleteProgram(p); throw new Error('glBaseLines: link failed: ' + m) }
  return p
}

export function createBaseLineLayer(gl, gll) {
  const prog = link(gl, COMP_VS, COMP_FS)
  const uTex = gl.getUniformLocation(prog, 'uTex'), uAlpha = gl.getUniformLocation(prog, 'uAlpha')
  let shiftProg = null
  try { shiftProg = link(gl, COMP_VS, SHIFT_FS) } catch (e) { gl.deleteProgram(prog); throw e }
  const uSTex = gl.getUniformLocation(shiftProg, 'uTex'), uSOff = gl.getUniformLocation(shiftProg, 'uOff')
  const vao = gl.createVertexArray()   // 合成不吃任何顶点属性：空 VAO，免得撞上别的程序留在缺省 VAO 上的属性
  let cache = null, scratch = null    // { tex, fb, w, h }
  let valid = false                   // 缓存纹理里是不是一张完整的画（尺寸变 / 渲染半途失败即作废）

  function makeTarget(w, h) {
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindTexture(gl.TEXTURE_2D, null)
    const fb = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    if (!ok) { gl.deleteFramebuffer(fb); gl.deleteTexture(tex); return null }
    return { tex, fb, w, h }
  }
  function dropTarget(t) { if (t) { gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.tex) } }
  function ensure(w, h) {
    if (cache && cache.w === w && cache.h === h && scratch) return true
    dropTarget(cache); dropTarget(scratch); cache = null; scratch = null; valid = false
    cache = makeTarget(w, h); scratch = cache ? makeTarget(w, h) : null
    if (!cache || !scratch) { dropTarget(cache); dropTarget(scratch); cache = null; scratch = null; return false }
    return true
  }
  // 把 src 纹理按透明度 a 贴到当前绑定的帧缓冲上（blend=true 预乘 over；false 原样覆盖）
  function composite(src, a, blend) {
    gl.useProgram(prog)
    gl.bindVertexArray(vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, src.tex)
    gl.uniform1i(uTex, 0); gl.uniform1f(uAlpha, a)
    if (blend) { gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA) } else gl.disable(gl.BLEND)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.disable(gl.BLEND)
    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.bindVertexArray(null)
  }
  // 设备像素矩形（左上原点）→ GL 剪裁框（左下原点）；null = 整张
  function scissorOf(r, w, h) {
    if (!r) { gl.disable(gl.SCISSOR_TEST); return }
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(r.x, h - r.y - r.h, r.w, r.h)
  }

  return {
    // 渲染进缓存。u = { w, h, dpr, k, tx, ty, lon0 }（与 glLines.begin 同形，proj 由每类给）；
    // layers = [{ alpha, proj, rect（设备 px 剪裁框，可为 null）, draws:[{ id, ranges:[{off,n}] }] }]，按层序。
    // opt.keep：不清缓存，只在各层的 rect 里补画（平移后补露出来的条带；rect 之间必须互不重叠）。
    // 返回 false = 半途失败（调用方退回 Canvas2D），缓存作废。
    render(u, layers, opt) {
      const keep = !!(opt && opt.keep)
      if (gl.isContextLost()) return false
      if (keep ? !this.ready(u.w, u.h) : !ensure(u.w, u.h)) return false
      valid = false
      gl.bindFramebuffer(gl.FRAMEBUFFER, cache.fb)
      gl.viewport(0, 0, u.w, u.h)
      gl.disable(gl.SCISSOR_TEST)
      gl.clearColor(0, 0, 0, 0)
      if (!keep) gl.clear(gl.COLOR_BUFFER_BIT)
      let ok = true
      // ★ 一类之内按 MAX 混合：底图线顶点极密（10m 全图下相邻顶点不到 1 px），逐段胶囊的抗锯齿边缘在同一像素上层层
      //   叠成 1−(1−a)(1−b)… —— 实测普通 over 混合着墨比 Canvas2D 重 22～36%。一类只有一种颜色，预乘色取 MAX 就是
      //   「覆盖率取最大」= 按到整条折线的【最近距离】出覆盖率，正是一条路径一次描边的抗锯齿口径。
      //   不透明类也走暂存再贴回（MAX 只能在本类自己的画布上取，不能跟下面已画的类比）。
      for (const L of layers) {
        if (!L.draws.length || !(L.alpha > 0)) continue
        gl.bindFramebuffer(gl.FRAMEBUFFER, scratch.fb)
        scissorOf(L.rect, u.w, u.h)
        gl.clear(gl.COLOR_BUFFER_BIT)
        if (!gll.begin({ ...u, proj: L.proj })) { ok = false; break }
        gl.blendEquation(gl.MAX)
        for (const d of L.draws) for (const r of d.ranges) gll.draw(d.id, r)
        gl.blendEquation(gl.FUNC_ADD)   // 还给后来者（线程序 / 填充程序都默认 FUNC_ADD）
        gll.end()
        gl.bindFramebuffer(gl.FRAMEBUFFER, cache.fb); gl.viewport(0, 0, u.w, u.h)
        composite(scratch, Math.min(1, L.alpha), true)
      }
      gl.disable(gl.SCISSOR_TEST)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      valid = ok
      return ok
    },
    // 缓存里有没有一张可用的画（尺寸对得上）
    ready(w, h) { return valid && !!cache && cache.w === w && cache.h === h && !gl.isContextLost() },
    // 同一缩放下纯平移：缓存整张挪 (dx, dy) 个设备像素（canvas 坐标：右正、下正）—— 拷进暂存纹理、两张互换；
    // 露出来的那一圈是空的，调用方随后 render(u, layers, { keep: true }) 只补那一圈。
    shift(dx, dy) {
      if (!valid || !cache || gl.isContextLost()) return false
      gl.bindFramebuffer(gl.FRAMEBUFFER, scratch.fb)
      gl.viewport(0, 0, cache.w, cache.h)
      gl.disable(gl.SCISSOR_TEST); gl.disable(gl.BLEND)
      gl.useProgram(shiftProg)
      gl.bindVertexArray(vao)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, cache.tex)
      gl.uniform1i(uSTex, 0); gl.uniform2i(uSOff, dx | 0, -(dy | 0))   // GL 的 y 朝上
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.bindTexture(gl.TEXTURE_2D, null)
      gl.bindVertexArray(null)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      const t = cache; cache = scratch; scratch = t
      return true
    },
    // 把缓存原样铺进缺省帧缓冲（GL 画布），调用方随后 drawImage 合成回 Canvas2D
    present(w, h) {
      if (!this.ready(w, h)) return false
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, w, h)
      gl.disable(gl.SCISSOR_TEST)
      composite(cache, 1, false)
      return true
    },
    invalidate() { valid = false },
    // 显存账（验证台读数）：两张 RGBA8
    texMB: () => (cache ? (cache.w * cache.h * 4 * 2) / 1048576 : 0),
    dispose() {
      dropTarget(cache); dropTarget(scratch); cache = null; scratch = null; valid = false
      try { gl.deleteVertexArray(vao); gl.deleteProgram(prog); gl.deleteProgram(shiftProg) } catch { /* 上下文已丢 */ }
    }
  }
}
