// 2D 平面图【投影档影像】的 GPU 后端：把 rasterMesh 规划出来的三角网当纹理网格交给 WebGL2 贴，
// 结果由调用方 drawImage 合成回 Canvas2D 的图层序（见 flatCoverage.drawImagery）。
//
// 为什么不再逐三角 clip + drawImage（warpTri）：那条路每个三角形都要 save + clip + setTransform +
// drawImage 整张源图 + restore，耗时几乎正比于【源图面积 × 三角形数】—— 方位等距全图 1.9 万个三角
// 配 16K 源图实测 60 ms（缩略图命中）到 960 ms（跨一档要重缩一张）。换到 GPU 之后这一步是一次
// drawArrays，成本随屏幕像素走，与源图面积、三角形数都基本无关。
//
// 与 CPU 路的等价性靠一件事保住：**两条路的三角网来自同一个 planRasterMesh**（../geo/rasterMesh.js），
// 顶点逐字相同。差别只剩「怎么把纹理贴进三角形」：
//   · CPU 是每三角一次仿射 + 抗锯齿 clip，靠 TRI_PAD 把相邻三角胀开一点点盖住格缝；
//   · GPU 是共享顶点的三角网，天然水密，不需要 TRI_PAD；跨 ±180 接缝的那一列格 CPU 要「画两遍」
//     补齐，GPU 靠 S 方向 REPEAT 直接越界取样即可（两遍在 GPU 上取到同一批纹素，留着也无害）。
// 故 GPU 出图在三角形【内部】是重采样差（双线性 + mipmap vs 仿射 drawImage），格线与边界为零差。
//
// 导出（PNG/PDF 逐字节一致是硬约束）、无 WebGL2、上下文丢失、以及纹理要到 8192 以上的深缩放，
// 一律退回 CPU 路 —— 判据与 glField 的 fieldBackend 同款，都在调用方。
//
// ── 两套程序 ─────────────────────────────────────────────────────────────────
//   · 整幅程序（16K / 8K 档）：一张 ≤ GL_TEX_MAX 的纹理、S 向 REPEAT。下面这一套【一行不动】——
//     16K / 8K 在投影档的出图要与改前逐像素 0 差，混进一个带分支的着色器会动浮点舍入。
//   · 瓦片程序（高精档，《2D 投影档高精影像》§4.3）：同一份三角网按片分桶（../geo/tileBins.js），
//     每桶绑该片纹理、片外像素 discard；片纹理走 LRU。S / T 都 CLAMP_TO_EDGE（一片不循环），
//     纹理坐标 (G + t·512)/N 把 gutter 那一圈剔出内容区 —— 与 3D 的 tileTexture 的 offset/repeat 同一式。

// 纹理边长上限。源图是 2:1 的整幅世界影像，故这一档 = 8192×4096：解码 134 MB、含 mip 约 179 MB
// —— 与 3D 侧「8K」那一档的显存账同数（见 viz/imagery.js 的 vramMB），是已经在用的量级。
// 再往上就是 16384×8192 = 716 MB，那一档只在用户显式选 3D 的 16K 时才该出现，不许由 2D 自动踩上去；
// 超过它也说明屏上要的分辨率已经过了 srcThumb 的最高一档，那时可见区很小、CPU 路本来就便宜。
export const GL_TEX_MAX = 8192
// 片纹理 LRU 上限：一片 514² RGBA 含 mip ≈ 1.4 MB，160 片最坏 ≈ 215 MB（与 3D 的 TEX_LIMIT=200 同量级）。
export const TILE_TEX_LIMIT = 160
const TILE_MB = 514 * 514 * 4 * 1.34 / 1e6

const VERT = `#version 300 es
in vec2 aPlane;              // 世界平面坐标（与 PJ.fwd 同一坐标系）
in vec2 aUV;                 // 源图归一坐标，可越出 [0,1]（跨接缝的格靠 REPEAT 兜）
uniform float uK, uTx, uTy, uDpr, uW, uH;
out vec2 vUV;
void main() {
  // 世界平面 → CSS px → clip：与 Canvas2D 路的 setTransform、与 glField 的顶点着色器同一式子
  float xc = aPlane.x * uK + uTx;
  float yc = aPlane.y * uK + uTy;
  gl_Position = vec4((xc * uDpr) / uW * 2.0 - 1.0, 1.0 - (yc * uDpr) / uH * 2.0, 0.0, 1.0);
  vUV = aUV;
}`

// 瓦片程序的顶点：与整幅程序同一式子，只把 vUV 改成 centroid 插值。
// ★ 为什么：图廓（世界外轮廓）上的边缘像素中心落在三角形之外，MSAA 仍会给它几个覆盖样本；
//   默认插值按像素中心外推 vUV，外推到有效窗之外就被片元里的 discard 整个丢掉 —— 阿尔伯斯全图
//   沿整条图廓一圈细洞（1041 个，16K 那一套没有 discard 只有 415 个）。centroid 让插值落在被覆盖的
//   样本上，vUV 不会越出三角形。整幅程序没有 discard，不动。
const VERT_TILE = VERT.replace('out vec2 vUV;', 'centroid out vec2 vUV;')

const FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
out vec4 fragColor;
void main() { fragColor = texture(uTex, vUV); }`

// 瓦片程序的片元：vUV 是【该片全跨度】的归一坐标（tileBins 换算过），
//   · 片外（< 0 或 > 有效窗 uWin=(fx,fy)）discard —— 一个三角形跨几片就复制了几份，各画自己那一部分；
//     ★ 判据留半个纹素的余量（EPS = 1/1024）：两份复制在片界上共用同一条线，插值出的 vUV 在那条线上
//       会各自差出几个 ulp，严格 < 0 / > uWin 就把线上的片元两边都丢了 —— 阿尔伯斯全图沿扇面两条切口
//       与南缘一圈实测 1068 个洞、最长 8 CSS px（16K 路 REPEAT 取样没有这一步，只有 415 个）。
//       多取的那半个纹素落在 gutter 里（邻片的真实像素），不是补边。
//   · 祖先片回退：uUvOff / uUvScale 把本片坐标折进祖先片里的子矩形（整片时 (0,0)/(1,1)）；
//   · gutter：内容区落在 [G, G+512]，除以图像边长 N 得纹理坐标。写成 /512 会整体偏一个纹素。
const FRAG_TILE = `#version 300 es
precision highp float;
centroid in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uWin, uUvOff, uUvScale;
uniform float uG, uN, uSub;
out vec4 fragColor;
const float EPS = 1.0 / 1024.0;
void main() {
  if (any(lessThan(vUV, vec2(-EPS))) || any(greaterThan(vUV, uWin + vec2(EPS)))) discard;
  vec2 t = uUvOff + vUV * uUvScale;
  // 子片拼一片（uSub=1）：uUvOff=−(i,j)、uUvScale=2 把本片坐标折进第 (i,j) 个子片；落在子片之外的丢掉，
  // 由另外三次绘制各画自己那一角。半个纹素的余量与上面同理（四份复制在片界上共用同一条线）。
  if (uSub > 0.5 && (any(lessThan(t, vec2(-EPS))) || any(greaterThan(t, vec2(1.0 + EPS))))) discard;
  fragColor = texture(uTex, (vec2(uG) + t * 512.0) / uN);
}`

function compile(gl, type, src) {
  const sh = gl.createShader(type)
  gl.shaderSource(sh, src); gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh))
  return sh
}
function link(gl, vsSrc, fsSrc, names) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc), fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc)
  const prog = gl.createProgram()
  gl.attachShader(prog, vs); gl.attachShader(prog, fs)
  gl.bindAttribLocation(prog, 0, 'aPlane'); gl.bindAttribLocation(prog, 1, 'aUV')
  gl.linkProgram(prog)
  gl.deleteShader(vs); gl.deleteShader(fs)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog))
  const uni = {}
  for (const k of names) uni[k] = gl.getUniformLocation(prog, k)
  return { prog, uni }
}

export function createGlRaster() {
  let cv = null, gl = null, prog = null, uni = null, lost = false, onLost = null
  let vao = null, vbPlane = null, vbUV = null, tex = null
  let count = 0, meshKey = '', texKey = ''
  let W = 1, H = 1
  // 瓦片程序那一套：独立的 VAO / 缓冲 / 程序 / 片纹理 LRU
  let progT = null, uniT = null, vaoT = null, vbPlaneT = null, vbUVT = null
  let countT = 0, meshKeyT = ''
  let aniso = null, anisoMax = 1
  const tileTexes = new Map()        // 纹理键 -> WebGLTexture（Map 的插入序即 LRU 序）
  let tileSeq = 0                    // 给 HTMLImageElement 派发的键（祖先片回退时拿不到 (z,r,c)，按图元身份记）
  let skipped = 0                    // 上一次 renderBins 因上传限额没画成的片数

  const ATTRS = { alpha: true, premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: false, depth: false, stencil: false }

  function build() {
    gl = cv.getContext('webgl2', ATTRS)
    if (!gl) return false
    const P = link(gl, VERT, FRAG, ['uK', 'uTx', 'uTy', 'uDpr', 'uW', 'uH', 'uTex'])
    prog = P.prog; uni = P.uni
    const T = link(gl, VERT_TILE, FRAG_TILE, ['uK', 'uTx', 'uTy', 'uDpr', 'uW', 'uH', 'uTex', 'uWin', 'uUvOff', 'uUvScale', 'uG', 'uN', 'uSub'])
    progT = T.prog; uniT = T.uni
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE)
    gl.clearColor(0, 0, 0, 0)
    vao = gl.createVertexArray(); vbPlane = gl.createBuffer(); vbUV = gl.createBuffer(); tex = gl.createTexture()
    vaoT = gl.createVertexArray(); vbPlaneT = gl.createBuffer(); vbUVT = gl.createBuffer()
    aniso = gl.getExtension('EXT_texture_filter_anisotropic') || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic') || null
    anisoMax = aniso ? (gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1) : 1
    // 缓冲与纹理都得重喂：调用方靠 setMesh / setTexture 的键失配自己补；片纹理 LRU 随上下文一起清
    meshKey = ''; texKey = ''; count = 0
    meshKeyT = ''; countT = 0; tileTexes.clear()
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H }
    return true
  }

  try {
    cv = document.createElement('canvas')
    cv.width = 1; cv.height = 1
    if (!build()) { gl = null }
    else {
      cv.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; if (onLost) onLost(false) })
      cv.addEventListener('webglcontextrestored', () => {
        lost = false; gl = null; prog = null; progT = null
        try { build() } catch { gl = null; prog = null; progT = null }
        if (onLost) onLost(true)
      })
    }
  } catch { gl = null; prog = null; progT = null }

  const alive = () => !!(gl && prog && !lost && !gl.isContextLost())

  function uploadMesh(vaoX, vbP, vbU, xy, uv) {
    gl.bindVertexArray(vaoX)
    gl.bindBuffer(gl.ARRAY_BUFFER, vbP)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(xy), gl.STATIC_DRAW)   // ★ new 不用 from：from 走通用迭代器，30k 三角实测慢一个量级
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindBuffer(gl.ARRAY_BUFFER, vbU)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uv), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)
  }
  // 片纹理：按图元身份取 / 传（祖先片回退时 getTileOrParent 只给图元，拿不到它的 (z,r,c)）。
  // ★ 逐出时【不能】碰到在用的就 break（3D 那条注释）：跳过在用的继续往后扫。
  function tileTexture(img, inUse) {
    if (!img.__glTileId) img.__glTileId = ++tileSeq
    const key = img.__glTileId
    let t = tileTexes.get(key)
    if (t) { tileTexes.delete(key); tileTexes.set(key, t); return t }
    t = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img) }
    catch { gl.bindTexture(gl.TEXTURE_2D, null); gl.deleteTexture(t); return null }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, anisoMax)   // 极区 / 对跖圈压缩极大
    gl.generateMipmap(gl.TEXTURE_2D)                                                         // 514² 非 2 的幂：WebGL2 允许
    gl.bindTexture(gl.TEXTURE_2D, null)
    tileTexes.set(key, t)
    if (tileTexes.size > TILE_TEX_LIMIT) {
      let over = tileTexes.size - TILE_TEX_LIMIT
      for (const k of [...tileTexes.keys()]) {
        if (over <= 0) break
        if (k === key || (inUse && inUse.has(k))) continue
        gl.deleteTexture(tileTexes.get(k)); tileTexes.delete(k); over--
      }
    }
    return t
  }

  return {
    canvas: () => cv,
    available: () => alive(),
    setOnContextChange(fn) { onLost = fn },
    resize(w, h) {
      W = Math.max(1, w | 0); H = Math.max(1, h | 0)
      if (cv && (cv.width !== W || cv.height !== H)) { cv.width = W; cv.height = H }
    },
    hasMesh(key) { return alive() && meshKey === key && count > 0 },
    hasTexture(key) { return alive() && texKey === key },
    // 三角网（非索引，逐三角三个顶点）。xy / uv 是 Float64Array（CPU 路要 double），这里转 float32：
    // 平面坐标量程 0~360，float32 的相对精度 6e-8 → 亚微米级，屏上看不出；uv 同理。
    setMesh(key, xy, uv, n) {
      if (!alive()) return false
      uploadMesh(vao, vbPlane, vbUV, xy, uv)
      count = n * 3; meshKey = key
      return true
    },
    // 源图上传成纹理。S 方向 REPEAT（整幅世界图正好 360° 宽，跨接缝的 uv 越界即对）；
    // T 方向 CLAMP_TO_EDGE（纬度不循环）。mipmap 让缩小时不产生摩尔纹。
    // ★ 只能上传【整幅等经纬世界图】：局部 bbox 的源（环境场栅格）在 S 方向 REPEAT 下会把
    //   越界的 uv 取到图另一边去，那条路仍走 CPU。
    setTexture(key, img) {
      if (!alive()) return false
      const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height
      if (!(w > 0 && h > 0) || w > GL_TEX_MAX || h > GL_TEX_MAX) return false
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)      // v=0 取到第一行 ＝ 源图顶端 ＝ latMax
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img) }
      catch { gl.bindTexture(gl.TEXTURE_2D, null); return false }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.bindTexture(gl.TEXTURE_2D, null)
      texKey = key
      return true
    },
    // 一次 drawArrays 铺完。视区变化（平移 / 缩放 / 换切口）在这里【不触发任何缓冲上传】。
    render(u) {
      if (!alive() || !count || !texKey) return false
      gl.viewport(0, 0, W, H)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.useProgram(prog)
      gl.uniform1f(uni.uK, u.k); gl.uniform1f(uni.uTx, u.tx); gl.uniform1f(uni.uTy, u.ty)
      gl.uniform1f(uni.uDpr, u.dpr); gl.uniform1f(uni.uW, W); gl.uniform1f(uni.uH, H)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.uniform1i(uni.uTex, 0)
      gl.bindVertexArray(vao)
      gl.drawArrays(gl.TRIANGLES, 0, count)
      gl.bindVertexArray(null)
      return true
    },
    tris() { return count / 3 },
    // ── 瓦片路 ──────────────────────────────────────────────────────────────
    hasBinMesh(key) { return alive() && meshKeyT === key && countT > 0 },
    // 分桶后的三角网（tileBins.binByTiles 的 xy / uv / n：含复制，uv 已是片内归一坐标）
    setBinMesh(key, xy, uv, n) {
      if (!alive()) return false
      uploadMesh(vaoT, vbPlaneT, vbUVT, xy, uv)
      countT = n * 3; meshKeyT = key
      return true
    },
    // 逐桶绘制。lookup(bin) 由调用方给：返回 { img, u0, v0, u1, v1, fx, fy, G, N } 或 null（连祖先都没有 → 留洞）；
    // 也可以返回 { draws: [{ img, u0, v0, u1, v1, sub }, …], fx, fy, G, N } —— 同一桶画几遍（四个子片拼一片）。
    // 返回画出的桶数；纹理 LRU 里没有的片现传，逐出时跳过本帧在用的。
    // budget＝本帧最多【新上传】几片纹理（一片 514² + mipmap ≈ 2 ms；一次到货 12 片就是 25 ms 的一帧）。
    // 超额的桶若 lookup 给了 alt（已上传的祖先片）就先画 alt，没有就留到下一帧；skippedUploads() 告诉调用方
    // 还欠着几片，让它再请一帧。
    renderBins(u, bins, lookup, budget = Infinity) {
      skipped = 0
      if (!alive() || !countT || !bins || !bins.length) return 0
      gl.viewport(0, 0, W, H)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.useProgram(progT)
      gl.uniform1f(uniT.uK, u.k); gl.uniform1f(uniT.uTx, u.tx); gl.uniform1f(uniT.uTy, u.ty)
      gl.uniform1f(uniT.uDpr, u.dpr); gl.uniform1f(uniT.uW, W); gl.uniform1f(uniT.uH, H)
      gl.activeTexture(gl.TEXTURE0)
      gl.uniform1i(uniT.uTex, 0)
      gl.bindVertexArray(vaoT)
      // 本帧要用的图元先登记，逐出时跳过它们
      const inUse = new Set()
      const hits = new Array(bins.length)
      const reg = (img) => { if (img && img.__glTileId) inUse.add(img.__glTileId) }
      for (let i = 0; i < bins.length; i++) {
        const h = lookup(bins[i]); hits[i] = h
        if (!h) continue
        if (h.draws) for (const d of h.draws) reg(d.img); else reg(h.img)
        if (h.alt) reg(h.alt.img)
      }
      let uploads = 0
      const getTex = (img) => {
        if (!img) return null
        const had = !!(img.__glTileId && tileTexes.has(img.__glTileId))
        if (!had && uploads >= budget) { skipped++; return null }
        const t = tileTexture(img, inUse)
        if (t && !had) uploads++
        return t
      }
      const drawOne = (h, d, t) => {
        inUse.add(d.img.__glTileId)
        gl.bindTexture(gl.TEXTURE_2D, t)
        gl.uniform2f(uniT.uWin, h.fx, h.fy)
        gl.uniform2f(uniT.uUvOff, d.u0, d.v0)
        gl.uniform2f(uniT.uUvScale, d.u1 - d.u0, d.v1 - d.v0)
        gl.uniform1f(uniT.uG, h.G); gl.uniform1f(uniT.uN, h.N)
        gl.uniform1f(uniT.uSub, d.sub ? 1 : 0)
        gl.drawArrays(gl.TRIANGLES, h.first * 3, h.count * 3)
      }
      let painted = 0
      for (let i = 0; i < bins.length; i++) {
        const h = hits[i]
        if (!h) continue
        h.first = bins[i].first; h.count = bins[i].count
        const list = h.draws || [h]
        // 先把这一桶要的纹理凑齐；凑不齐（限额）就整桶改画 alt
        const texs = []
        let ok = true
        for (const d of list) { const t = d.img ? getTex(d.img) : null; if (!t) { ok = false; break } texs.push(t) }
        if (ok) { for (let j = 0; j < list.length; j++) drawOne(h, list[j], texs[j]); painted++; continue }
        const a = h.alt
        const ta = a && a.img ? getTex(a.img) : null
        if (ta) { drawOne(h, a, ta); painted++ }
      }
      gl.bindVertexArray(null)
      gl.bindTexture(gl.TEXTURE_2D, null)
      return painted
    },
    skippedUploads() { return skipped },
    clearTiles() {
      if (gl) for (const t of tileTexes.values()) gl.deleteTexture(t)
      tileTexes.clear(); meshKeyT = ''; countT = 0
    },
    tileTexMB() { return +(tileTexes.size * TILE_MB).toFixed(1) },
    tileTexCount() { return tileTexes.size },
    dispose() {
      if (gl) {
        if (vao) gl.deleteVertexArray(vao)
        if (vbPlane) gl.deleteBuffer(vbPlane)
        if (vbUV) gl.deleteBuffer(vbUV)
        if (tex) gl.deleteTexture(tex)
        if (prog) gl.deleteProgram(prog)
        if (vaoT) gl.deleteVertexArray(vaoT)
        if (vbPlaneT) gl.deleteBuffer(vbPlaneT)
        if (vbUVT) gl.deleteBuffer(vbUVT)
        for (const t of tileTexes.values()) gl.deleteTexture(t)
        if (progT) gl.deleteProgram(progT)
      }
      tileTexes.clear()
      gl = null; prog = null; progT = null; cv = null; count = 0; meshKey = ''; texKey = ''; countT = 0; meshKeyT = ''
    }
  }
}
