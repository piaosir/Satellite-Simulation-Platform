// 图上链路箭头让聚焦星模型图标此刻的屏上轮廓（2026-10-08 用户：3D 视图里聚焦两颗星，星间链路的箭头停在终点星图标外一大截 ——
// 原先让图标的包围圆，包围半径 ≈ 半翼展）：
//  ① iconBatch.edgePx（SSL-1300 / 平板 LEO，屏幕中心与屏幕边上两个机位）：轮廓表每一档 = 独立暴力求的轮廓外沿
//     （按 iconVertexMirror 摆好部件、three 相机投影、逐三角形求射线出射点），查表 = 线方向两侧两档里大的那个；
//     多数方向都比包围圆近得多；平板星不塌到中心（3D 撞面口径会塌：板厚几厘米）
//  ② 没在画就交还兜底：不认识的星 / 还没淡入 / 太小画成点 → −1
//  ③ 接线（源码钉）：scene 登记 → 逐帧回填（近场连端点快照）；页面 linkIconEdge 与图标键同口径；着色器不动
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORE = pathToFileURL(path.resolve(HERE, '..') + '/').href
const SRC = pathToFileURL(path.resolve(HERE, '../../../src') + '/').href
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith('@core/')) return next(${JSON.stringify(CORE)} + s.slice(6), c); return next(s, c) }`))

// 假 document：参数化模型现生成贴图、标签量字宽要一块 canvas（只记调用，不真画）
if (!globalThis.document) {
  const ctx2d = () => new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k]
      if (k === 'measureText') return (s) => ({ width: String(s).length * 7 })
      if (k === 'createImageData' || k === 'getImageData') return (...a) => { const w = a.length >= 4 ? a[2] : a[0], h = a.length >= 4 ? a[3] : a[1]; return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) } }
      if (k === 'createRadialGradient' || k === 'createLinearGradient' || k === 'createPattern') return () => ({ addColorStop() {} })
      return () => {}
    },
    set(t, k, v) { t[k] = v; return true }
  })
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: ctx2d }) }
}

const THREE = await import('three')
const IB = await import(SRC + 'viz/globe3d/iconBatch.js')
const ML = await import(SRC + 'viz/globe3d/modelLayer.js')
const sat = (await import(SRC + 'viz/constellation/satellite.js')).default
const { posAt } = await import(SRC + 'viz/constellation/satPos.js')
const { Q_BODY2L_NADIR } = await import(CORE + 'models/attitude.mjs')

let n = 0
const t = async (name, fn) => { try { await fn() } catch (e) { console.error('FAIL ' + name); throw e } n++ }
const src = (p) => readFileSync(path.resolve(HERE, '../../../src', p), 'utf8')
const V = (x, y, z) => new THREE.Vector3(x, y, z)

// 一颗低轨星此刻的锚点 / L 系（与页面 satModelState 同一份 satStateAt 算式）
const ISS = sat.twoline2satrec('1 25544U 98067A   26265.47000000  .00016717  00000+0  30000-3 0  9990', '2 25544  51.6300 180.2400 0004800 167.1100 193.0000 15.49050000400000')
const d0 = new Date(Date.UTC(2026, 8, 24, 4, 0, 0)), g0 = sat.gstime(d0)
const sun = ML.sunStateAt(d0)
const st = ML.satStateAt(posAt(ISS, d0), g0, sun.sunE)
const W = 1600, H = 900

async function iconLayer(modelId, px) {
  const L = ML.createModelLayer({})
  L.setIconStyle({ on: true, px })
  L.setSun(sun.sunS, g0)
  const ico = { key: 'A', modelId, px, anchor: st.anchor, qL2S: st.qL2S, qB2L: Q_BODY2L_NADIR, altKm: st.altKm, eclipse: 1 }
  const t0 = Date.now()
  while (!L._iconEdgeState('A')) {
    assert.ok(Date.now() - t0 < 15000, modelId + ' 图标 15 s 内没就绪')
    L.setIcons([ico])
    await new Promise((r) => setTimeout(r, 50))
  }
  return { L, ico }
}
// 机位：从锚点外侧斜上方看过去（pan：让图标偏到屏幕边上，透视拉伸也要对）
function cameraAt(pan) {
  const C = V(...st.anchor)
  const up = C.clone().normalize()
  const side = V(0, 1, 0).cross(up).normalize()
  const cam = new THREE.PerspectiveCamera(42, W / H, 1e-4, 50)
  cam.position.copy(C).addScaledVector(up, 0.35).addScaledVector(side, 0.12)
  cam.up.copy(side.clone().cross(up).normalize())
  cam.lookAt(C.clone().addScaledVector(side, pan))
  cam.updateMatrixWorld(true)
  return cam
}
// 与 iconBatch 同口径的伪角 / 档中心方向（镜像）
const SIL_N = 720
const dia = (x, y) => (y >= 0 ? (x >= 0 ? (x + y > 0 ? y / (x + y) : 0) : 1 - x / (y - x)) : (x < 0 ? 2 - y / (-x - y) : 3 + x / (x - y)))
const binDir = (k) => { const d = (k + 0.5) * 4 / SIL_N; const x = d < 2 ? 1 - d : d - 3, y = d < 1 ? d : (d < 3 ? 2 - d : d - 4); const l = Math.hypot(x, y); return [x / l, y / l] }

await t('① edgePx：轮廓表每一档 = 暴力求的轮廓外沿；查表取两侧两档大的；比包围圆近得多、平板星不塌到中心', async () => {
  for (const [modelId, px] of [['param:ssl1300', 120], ['param:flat-leo', 160]]) {
    const { L, ico } = await iconLayer(modelId, px)
    for (const pan of [0, 0.075]) {
      const cam = cameraAt(pan)
      for (let i = 0; i < 30; i++) { L.setIcons([ico]); L.overlay.update(0.05, cam, W, H) }   // 淡入到位、本帧相机进批次
      const S = L._iconEdgeState('A')
      assert.ok(S.alpha > 0.99 && S.pxR > 10, `${modelId}：图标在画（透明度 ${S.alpha}、屏幕半径 ${S.pxR}）`)
      // 独立参照：部件按此刻转角摆好、放到图标的世界尺寸（iconBatch icK0 同式），three 相机投影成屏上三角形（相对图标中心，px，y 向上）
      const C = V(...S.pos)
      const D = C.distanceTo(cam.position)
      const k0 = S.pxR * D * (2 * Math.tan(cam.fov * Math.PI / 360) / H) / S.radius
      const toPx = (v) => { const c = v.clone().project(cam); return [(c.x * 0.5 + 0.5) * W, (c.y * 0.5 + 0.5) * H] }
      const c0 = toPx(C)
      const tris = []
      for (const p of S.parts) {
        const P2 = []
        for (let v = 0; v < p.pos.length; v += 3) {
          const w = IB.iconVertexMirror(p, [p.pos[v], p.pos[v + 1], p.pos[v + 2]], S.angles, { pos: S.pos, quat: S.quat, k0 })
          const s = toPx(V(w[0], w[1], w[2]))
          P2.push(s[0] - c0[0], s[1] - c0[1])
        }
        const I = p.index0
        for (let k = 0; k < I.length; k += 3) tris.push([P2[I[k] * 2], P2[I[k] * 2 + 1], P2[I[k + 1] * 2], P2[I[k + 1] * 2 + 1], P2[I[k + 2] * 2], P2[I[k + 2] * 2 + 1]])
      }
      // 从原点沿 (ux, uy) 的射线，所有三角形里最远的出射点（解 2×2：o + t·u = A + s·(B − A)）
      const ext = (ux, uy) => {
        let best = 0
        for (const T of tris) {
          for (let e = 0; e < 3; e++) {
            const ax = T[e * 2], ay = T[e * 2 + 1], bx = T[(e * 2 + 2) % 6], by = T[(e * 2 + 3) % 6]
            const ex = bx - ax, ey = by - ay, det = ex * uy - ey * ux
            if (Math.abs(det) < 1e-12) continue
            const tt = (ex * ay - ey * ax) / det, ss = (ux * ay - uy * ax) / det
            if (ss >= 0 && ss <= 1 && tt > best) best = tt
          }
        }
        return best
      }
      const ratios = []
      for (let j = 0; j < 36; j++) {
        // 链路另一端：沿各方向 800 km 外（近水平的星间链路 + 上下斜的星地链路都有）
        const a = j * 2 * Math.PI / 36, el = (j % 3 - 1) * 0.5
        const dir = V(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el)).normalize()
        const other = C.clone().addScaledVector(dir, 0.125)
        const got = L.iconEdgePx('A', other)
        // 线在屏上的方向
        const pn = toPx(C.clone().addScaledVector(dir, 1e-4))
        const dx = pn[0] - c0[0], dy = pn[1] - c0[1]
        const fb = dia(dx, dy) * SIL_N / 4 - 0.5
        const kA = ((Math.floor(fb) % SIL_N) + SIL_N) % SIL_N, kB = (kA + 1) % SIL_N
        const want = Math.max(ext(...binDir(kA)), ext(...binDir(kB)))
        assert.ok(Math.abs(got - want) <= 1e-3 * Math.max(1, want), `${modelId} pan=${pan} 方向 ${j}：查表 ${got} ≠ 两档暴力外沿 ${want}`)
        // 与线方向本身的外沿只差档宽内的起伏
        const l = Math.hypot(dx, dy)
        assert.ok(got >= ext(dx / l, dy / l) - 2, `${modelId} 方向 ${j}：停进了图标轮廓里（${got} < ${ext(dx / l, dy / l)}）`)
        ratios.push(got / S.pxR)
      }
      ratios.sort((x, y) => x - y)
      const med = ratios[ratios.length >> 1]
      assert.ok(med < 0.85, `${modelId} pan=${pan}：外沿中位数 ${med.toFixed(3)} × 屏幕半径，应比包围圆（1）近得多`)
      if (modelId === 'param:flat-leo') assert.ok(med > 0.1, `平板星外沿中位数 ${med.toFixed(3)} × 屏幕半径：不该塌到中心`)
    }
    L.dispose()
  }
})

await t('② 没在画交还兜底：不认识的星 / 还没淡入 / 太小画成点 → −1', async () => {
  const { L, ico } = await iconLayer('param:flat-leo', 160)
  const cam = cameraAt(0)
  const other = V(...st.anchor).addScaledVector(V(1, 0, 0), 0.1)
  assert.equal(L.iconEdgePx('nope', other), -1, '不认识的星')
  L.overlay.update(0, cam, W, H)   // dt = 0：透明度还是 0
  assert.equal(L.iconEdgePx('A', other), -1, '还没淡入')
  for (let i = 0; i < 30; i++) { L.setIcons([ico]); L.overlay.update(0.05, cam, W, H) }
  assert.ok(L.iconEdgePx('A', other) > 0, '淡入后有值')
  L.setIcons([{ ...ico, px: 0.5 }]); L.overlay.update(0.05, cam, W, H)
  assert.equal(L.iconEdgePx('A', other), -1, '太小（画成点）')
  L.dispose()
})

await t('③ 接线（源码钉）', () => {
  const sc = src('viz/globe3d/scene.js')
  assert.match(sc, /function setLinkIconEdge\(fn\) \{ linkIconEdge = typeof fn === 'function' \? fn : null \}/)
  assert.match(sc, /setLinkIconPx, setLinkIconEdge, lonLatAt/)
  // 登记：远场终点、近场终点（不是主星）与近场起点；近场在 va / vb 就地改成相对锚点之前登记
  assert.match(sc, /noteIconEnd\(h\.e, L\.sel, tp, va, q\.ie, q\.t\.length \/ 4\)   \/\/ 画着模型图标的星端/)
  assert.match(sc, /if \(!eb\) noteIconEnd\(h\.e, L\.sel, tp, va, q\.ie, q\.t\.length \/ 4\)/)
  assert.match(sc, /if \(t0\) noteIconEnd\(h\.s, L\.sel, t0, vb, q\.ie0, q\.t0\.length \/ 4\)/)
  assert.ok(sc.indexOf('if (t0) noteIconEnd(') < sc.indexOf('va.sub(followA)'), '近场：先登记（绝对坐标）再就地改相对锚点')
  assert.match(sc, /list\.push\(\{ seg, key: e\.key, other: other\.clone\(\), dot: linkDotR\(sel\), fb: tp \}\)/)
  assert.match(sc, /for \(const p of gq\.ie\) linkIconEnds\.push\(\{ \.\.\.p, geo: ls\.geometry, attr: 'instanceTip', ok: 't' \}\)/)
  assert.match(sc, /if \(near\) for \(const p of gq\.ie0\) linkIconEnds\.push\(\{ \.\.\.p, geo: ls\.geometry, attr: 'instanceTip0', ok: 't0' \}\)/)
  // 逐帧回填：在画 → 屏幕恒定（z = 0）、不小于链路小圆点；不在画 → 包围圆兜底；近场连端点快照一起改
  assert.match(sc, /const x = px >= 0 \? 0 : it\.fb\[0\], y = px >= 0 \? Math\.max\(px, it\.dot \* zk\) : it\.fb\[1\], z = px >= 0 \? 0 : it\.fb\[2\]/)
  assert.match(sc, /if \(O\) \{ O\[j\] = x; O\[j \+ 1\] = y; O\[j \+ 2\] = z \}/)
  // 只还原自己改过的：跟随近场里钉到邻星的端点归模型层逐帧摆（邻星不在图标表里 → −1），兜底不许盖它
  assert.match(sc, /if \(!\(px >= 0\) && !it\.mine\) continue\r?\n      it\.mine = px >= 0/)
  assert.match(sc, /if \(linkIconEnds\.length && linkIconEdge\) syncLinkIcons\(\)/)
  // 出帧顺序：叠加层本帧 update 在 renderFrame 之前（edgePx 用本帧相机）
  assert.match(sc, /if \(overlay\) overlay\.update\(dtSec, camera, curW, curH(, smpSec)?\)\r?\n    renderFrame\(\)/)
  const pg = src('pages/ConstellationMap3D.vue')
  assert.match(pg, /scene\.setLinkIconEdge\(linkIconEdge\)/)
  assert.match(pg, /return mo && mo\.id \? modelLayer\.iconEdgePx\(mo\.key \|\| e\.name, other\) : -1/)
  assert.match(pg, /const key = mo\.key \|\| e\.name\r?\n/, '图标键口径（feedModels）')
  // 着色器不动：仍是四档口径（0 / 1 / 2 / 3）
  assert.doesNotMatch(src('viz/globe3d/linkLineMaterial.js'), /instanceTip\.z > 3\.5|tipCircle/)
})

console.log(`linkIconEdge: ${n} 项通过`)
