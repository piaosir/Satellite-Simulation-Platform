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

// 纹理边长上限。源图是 2:1 的整幅世界影像，故这一档 = 8192×4096：解码 134 MB、含 mip 约 179 MB
// —— 与 3D 侧「8K」那一档的显存账同数（见 viz/imagery.js 的 vramMB），是已经在用的量级。
// 再往上就是 16384×8192 = 716 MB，那一档只在用户显式选 3D 的 16K 时才该出现，不许由 2D 自动踩上去；
// 超过它也说明屏上要的分辨率已经过了 srcThumb 的最高一档，那时可见区很小、CPU 路本来就便宜。
export const GL_TEX_MAX = 8192

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

const FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
out vec4 fragColor;
void main() { fragColor = texture(uTex, vUV); }`

function compile(gl, type, src) {
  const sh = gl.createShader(type)
  gl.shaderSource(sh, src); gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh))
  return sh
}

export function createGlRaster() {
  let cv = null, gl = null, prog = null, uni = null, lost = false, onLost = null
  let vao = null, vbPlane = null, vbUV = null, tex = null
  let count = 0, meshKey = '', texKey = ''
  let W = 1, H = 1

  const ATTRS = { alpha: true, premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: false, depth: false, stencil: false }

  function build() {
    gl = cv.getContext('webgl2', ATTRS)
    if (!gl) return false
    const vs = compile(gl, gl.VERTEX_SHADER, VERT), fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
    prog = gl.createProgram()
    gl.attachShader(prog, vs); gl.attachShader(prog, fs)
    gl.bindAttribLocation(prog, 0, 'aPlane'); gl.bindAttribLocation(prog, 1, 'aUV')
    gl.linkProgram(prog)
    gl.deleteShader(vs); gl.deleteShader(fs)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog))
    uni = {}
    for (const k of ['uK', 'uTx', 'uTy', 'uDpr', 'uW', 'uH', 'uTex']) uni[k] = gl.getUniformLocation(prog, k)
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE)
    gl.clearColor(0, 0, 0, 0)
    vao = gl.createVertexArray(); vbPlane = gl.createBuffer(); vbUV = gl.createBuffer(); tex = gl.createTexture()
    // 缓冲与纹理都得重喂：调用方靠 setMesh / setTexture 的键失配自己补
    meshKey = ''; texKey = ''; count = 0
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
        lost = false; gl = null; prog = null
        try { build() } catch { gl = null; prog = null }
        if (onLost) onLost(true)
      })
    }
  } catch { gl = null; prog = null }

  const alive = () => !!(gl && prog && !lost && !gl.isContextLost())

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
      gl.bindVertexArray(vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, vbPlane)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(xy), gl.STATIC_DRAW)   // ★ new 不用 from：from 走通用迭代器，30k 三角实测慢一个量级
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
      gl.bindBuffer(gl.ARRAY_BUFFER, vbUV)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uv), gl.STATIC_DRAW)
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0)
      gl.bindVertexArray(null)
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
    dispose() {
      if (gl) {
        if (vao) gl.deleteVertexArray(vao)
        if (vbPlane) gl.deleteBuffer(vbPlane)
        if (vbUV) gl.deleteBuffer(vbUV)
        if (tex) gl.deleteTexture(tex)
        if (prog) gl.deleteProgram(prog)
      }
      gl = null; prog = null; cv = null; count = 0; meshKey = ''; texKey = ''
    }
  }
}
