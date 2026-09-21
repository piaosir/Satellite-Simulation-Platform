// 一片聚焦卫星在某个时刻的完整几何：星历 → 轨道圈/星下点轨迹/覆盖圈 → 场景顶点缓冲。
//
// ★ 这份代码【主线程与 Worker 跑的是同一份】：Worker 只是在外面套了一层 onmessage（见 focusGeomWorker.js），
//   池子在拿不到 Worker 时就地同步调它（见 focusGeomPool.js）。所以不存在「两套实现漂移」这个隐患 ——
//   几何原语来自 globe3d/focusLanes.js，覆盖圈口径来自 focusFootprint.js，轨道圈/轨迹缓存来自 focusGeomCache.js。
// ★ 分片必须稳定：同一颗星恒落在同一片上，轨道圈缓存与星下点环形缓冲才立得住（池子按 key 哈希分片）。
// ★ 出参一律是 Float32Array（连同底层 buffer 一起 transfer 回主线程，零拷贝），主线程只管上传。
import sat from './satellite.js'
import { posAt, periodMinOf, validSpan } from './satPos.js'   // 取位的唯一入口（satrec 与星历点序列两种传播体都走它）
import { createFocusGeomCache, ringSegments } from './focusGeomCache.js'
import { footprintRing } from './focusFootprint.js'
import { swathK, swathSig, sectionOf, headingAz, swathLayout, swathDiscs, emitSwath3D, swathFlatGeom } from './focusSwath.js'
import { llaToVec, pushDashed, densifyArc, footprintFill, coneFace, createSink, LIFT, RE } from '../globe3d/focusLanes.js'

export function createShard() {
  return { recs: new Map(), list: [], cache: createFocusGeomCache(), hint: new Map() }
}
// msg: { keys:[key...], add:[{key, rec, cc, color}], primary: key|null }
// 只在选中集/主选变化时调一次；satrec 只在头一次见到这颗星时传（结构化克隆，实测 102 个字段全数值/字符串、克隆后推演逐位一致）
export function syncShard(st, msg) {
  if (msg.add) for (const a of msg.add) st.recs.set(a.key, { rec: a.rec, cc: !!a.cc, color: a.color })
  st.list = []
  for (const k of msg.keys) { const e = st.recs.get(k); if (e) st.list.push({ key: k, rec: e.rec, cc: e.cc, color: e.color, primary: k === msg.primary }) }
  const keep = new Set(msg.keys)
  for (const k of [...st.recs.keys()]) if (!keep.has(k)) st.recs.delete(k)
  st.cache.retain(keep)
}

const sink = (st, k) => createSink(Math.max(1024, st.hint.get(k) || 0))
const done = (st, k, s) => { st.hint.set(k, s.n); return { n: s.n, buf: s.a.buffer } }

// p: { tMs, gmst, ccTMs, ccGmst, lod:{samples,stepDeg,fpSeg}, per, spanMs(时长档 >0，否则按 per×周期),
//      ring:{on, tMs, gmst, rebuild}, fp:{mode,beamDeg,elevDeg}, style:{...}, want2d }
export function computeTick(st, p) {
  const n = st.list.length
  const S = p.style
  const orb = sink(st, 'orb'), orbP = sink(st, 'orbP'), trk = sink(st, 'trk')
  const fp = sink(st, 'fp'), gen = sink(st, 'gen'), fill = sink(st, 'fill'), cone = sink(st, 'cone'), swa = sink(st, 'swath')
  // 点层（在轨点 / 星下点图标 / 高亮环）也在这儿分好桶：主线程收到的就是可以直接建 BufferGeometry 的顶点流，
  // 逐颗建对象那一步彻底没有了 —— 那正是取消颗数上限后第一个会塌的地方。
  const dots = new Map()                          // 'px|色' -> sink
  const dotOf = (px, tint) => { const k = px + '|' + tint; let d = dots.get(k); if (!d) { d = { px, tint, s: createSink(1024) }; dots.set(k, d) } return d.s }
  const sub = sink(st, 'sub'), hl = sink(st, 'hl'), hlP = sink(st, 'hlP')
  // 星下点经纬曾在这里另出一份 Float32Array(n×2) 回传，但两个渲染端都不读它
  //（3D 收的是顶点 sub/hl/hlP，2D 收的是下面 f2.sub）—— 每拍白算白传，已删。
  let bMaxDeg = null, clampText = null
  // 2D 平面图要的经纬折线（只在平面图真在看时才打包 —— 不看时打了也是白打）
  // 轨迹面的 2D 打包：swK/swOff/swLL 逐星断面经纬；swSk 逐步「非平移步」标志（按各星断面数−1 顺排）；
  // swOut 逐星「整轨打转描轮廓」；圆盘环两级偏移 swRgOff（逐星起始环号）/ swRgPt（逐环起始点号）→ swRgLL
  const f2 = p.want2d ? { trkOff: [0], trkLL: [], fpOff: [0], fpLL: [], sub: [], swK: [], swOff: [0], swLL: [], swSk: [], swOut: [], swRgOff: [0], swRgPt: [0], swRgLL: [] } : null
  for (let i = 0; i < n; i++) {
    const e = st.list[i]
    const rec = e.rec
    const tMs = e.cc ? p.ccTMs : p.tMs, g = e.cc ? p.ccGmst : p.gmst
    const t = new Date(tMs)
    let pv = null
    pv = posAt(rec, t)
    if (!pv || !pv.position) { if (f2) { f2.trkOff.push(f2.trkLL.length / 2); f2.fpOff.push(f2.fpLL.length / 2); f2.sub.push(NaN, NaN); f2.swK.push(0); f2.swOff.push(f2.swLL.length / 2); f2.swOut.push(0); f2.swRgOff.push(f2.swRgPt.length - 1) } continue }
    const gd = sat.eciToGeodetic(pv.position, g)
    const lat = sat.degreesLat(gd.latitude), lon = sat.degreesLong(gd.longitude), h = gd.height
    // 星下点图标（贴地 ×1.0012，与 setFocusSatLLA 逐字同口径）+ 金色高亮环（套在星本体上，主选大一档）
    if (S.subOn) { const v = llaToVec(lat, lon, 0).multiplyScalar(1.0012); sub.push3(v.x, v.y, v.z) }
    if (S.ringOn) { const v = llaToVec(lat, lon, h); (e.primary ? hlP : hl).push3(v.x, v.y, v.z) }
    // ① 轨道圈：惯性系里那条闭合曲线，逐拍只差个地球转角 → 缓存 + 整组旋转
    if (p.ring.on) {
      const lla = st.cache.ring(e.key, rec, p.ring.tMs, p.ring.gmst, ringSegments(rec, p.lod.samples), p.lod.stepDeg, p.ring.rebuild)
      if (lla && lla.length > 1 && p.ring.build) {
        const out = e.primary ? orbP : orb
        pushDashed(out, lla.map((q) => llaToVec(q.lat, q.lon, q.altKm || 0)), S.orbDash)
      }
    }
    // ② 星下点轨迹：环形缓冲，逐拍只补窗口两端（头点＝上面刚算好的星下点，白送）
    //    「轨迹面」档：同一条轨迹的每个采样点各出一条横断面（缓存在点上，口径签名对不上才重算；头尾两点每拍新算），
    //    两缘走 trk 线通道（与轨迹线同一份样式），带面走 swath 面通道。
    let track = null, lay = null, discs = null, K = 0
    const swathOn = S.trkOn && S.trkMode === 'swath'
    if (S.trkOn || p.want2d) {
      // 周期：satrec → 2π/no；星历点序列表 → 表内升交点估计（原来直接读 rec.no，表上没有这个字段
      // 得到 NaN，spanMs / dtMs 全是 NaN，轨迹一根都画不出来）
      const periodMin = periodMinOf(rec)
      const sp = validSpan(rec)
      // 长度：时长档（p.spanMs > 0）全体同一段；圈数档各星按自己的周期 × p.per；
      // 估不出周期的星历星没有「圈」可言，按表的整段长度给 —— 表本身就是轨迹
      const spanMs = p.spanMs > 0 ? p.spanMs : (periodMin > 0 ? periodMin * p.per * 60000 : (sp ? sp.t1 - sp.t0 : 0))
      // 节拍：有周期按周期 / 采样数，否则按整段 / 采样数
      const dtMs = (periodMin > 0 ? periodMin * 60000 : spanMs) / p.lod.samples
      track = st.cache.track(e.key, rec, tMs, spanMs, dtMs, p.lod.stepDeg,
        { tMs, t, lat, lon, h, az: headingAz(pv, g) })
      if (swathOn && track.length > 1) {
        K = swathK(Math.max(h, (rec.alta > 0 ? rec.alta : 0) * RE), p.fp)   // 按远地点高度定横向分段（rec.alta 以地球半径为单位）
        const sig = swathSig(p.fp, K)
        const secs = new Array(track.length)
        for (let j = 0; j < track.length; j++) {
          const q = track[j]
          if (q.swSig !== sig) { q.sw = sectionOf(q, p.fp, K); q.swSig = sig }
          secs[j] = q.sw
        }
        // 定向一致 + 平移/打转分段（见 focusSwath.swathLayout）：平移段连四边形、打转段落覆盖圆盘；
        // 整轨打转（GEO）时圆盘轮廓只在覆盖圈层关着时描（开着就与覆盖圈重合）
        lay = swathLayout(secs, K)
        discs = swathDiscs(lay, track, p.fp, p.lod.fpSeg)
        emitSwath3D(lay, discs, { edge: trk, fill: S.trkFillOn ? swa : null, dash: S.trkDash, outlineOn: lay.allRot && !S.fpOn })
      } else if (S.trkOn && track.length > 1) {
        // densifyArc：贴地线的直弦在节拍降档后会沉进地球（见 focusLanes.js 那段），满细节时不补一个点
        pushDashed(trk, densifyArc(track.map((q) => llaToVec(q.lat, q.lon, LIFT))), S.trkDash)
      }
    }
    // ③ 覆盖圈（波束角 / 最低仰角两种口径）+ 圈内填充 + 覆盖锥
    const ecf = sat.eciToEcf(pv.position, g)
    const lim = e.primary ? {} : null
    const ring = (S.fpOn || S.coneOn) ? footprintRing([ecf.x, ecf.y, ecf.z], h, p.lod.fpSeg, p.fp, lim) : null
    if (lim && lim.bMaxDeg != null) { bMaxDeg = lim.bMaxDeg; clampText = lim.clampText }
    let rv = null
    if (ring && ring.length > 1) {
      rv = ring.map((q) => llaToVec(q.lat, q.lon, LIFT))
      if (S.fpOn) {
        pushDashed(fp, densifyArc(rv), S.fpDash)   // 补密只给【线】：填充/锥面各自有同款补密，rv 原样传下去
        if (S.fillOn) footprintFill(rv, { lat, lon }, fill)
      }
      if (S.coneOn && h > 0) {
        const apex = llaToVec(lat, lon, h)
        if (S.faceOn) coneFace(apex, rv, cone)
        if (S.genCount > 0) {
          const m = rv.length - 1, k = Math.max(1, Math.min(m, Math.round(S.genCount)))
          for (let j = 0; j < k; j++) pushDashed(gen, [apex, rv[Math.round(j * m / k) % m]], S.genDash)
        }
      }
    }
    // ④ 在轨点
    if (S.dotOn) {
      const v = llaToVec(lat, lon, h || 0)
      dotOf(e.primary ? S.dotPx : Math.max(2, S.dotPx - 2), e.color).push3(v.x, v.y, v.z)
    }
    if (f2) {
      if (track) for (const q of track) { f2.trkLL.push(q.lat, q.lon) }
      f2.trkOff.push(f2.trkLL.length / 2)
      if (ring) for (const q of ring) { f2.fpLL.push(q.lat, q.lon) }
      f2.fpOff.push(f2.fpLL.length / 2)
      f2.sub.push(lat, lon)
      // 轨迹面：定向后的横断面经纬（每点 (K+1) 对 lat/lon）+ 逐步标志 + 圆盘环，平面图按平移步围切片、打转段填圆盘
      if (lay) {
        const fg = swathFlatGeom(lay, discs, lay.allRot && !S.fpOn)
        const ll = fg.swath.ll
        for (let a = 0; a < ll.length; a++) f2.swLL.push(ll[a])
        for (let a = 0; a < fg.swath.skip.length; a++) f2.swSk.push(fg.swath.skip[a])
        f2.swK.push(K); f2.swOut.push(fg.swOutline ? 1 : 0)
        for (const ring of fg.swRings) { for (const q of ring) f2.swRgLL.push(q.lat, q.lon); f2.swRgPt.push(f2.swRgLL.length / 2) }
      } else { f2.swK.push(0); f2.swOut.push(0) }
      f2.swRgOff.push(f2.swRgPt.length - 1)
      f2.swOff.push(f2.swLL.length / 2)
    }
  }
  const out = {
    n, bMaxDeg, clampText,
    orb: done(st, 'orb', orb), orbP: done(st, 'orbP', orbP), trk: done(st, 'trk', trk),
    fp: done(st, 'fp', fp), gen: done(st, 'gen', gen), fill: done(st, 'fill', fill), cone: done(st, 'cone', cone), swath: done(st, 'swath', swa),
    sub: done(st, 'sub', sub), hl: done(st, 'hl', hl), hlP: done(st, 'hlP', hlP),
    dots: [...dots.values()].map((d) => ({ px: d.px, tint: d.tint, n: d.s.n, buf: d.s.a.buffer }))
  }
  if (f2) out.flat = { trkOff: new Int32Array(f2.trkOff), trkLL: new Float32Array(f2.trkLL), fpOff: new Int32Array(f2.fpOff), fpLL: new Float32Array(f2.fpLL), sub: new Float32Array(f2.sub), swK: new Int32Array(f2.swK), swOff: new Int32Array(f2.swOff), swLL: new Float32Array(f2.swLL),
    swSk: new Uint8Array(f2.swSk), swOut: new Uint8Array(f2.swOut), swRgOff: new Int32Array(f2.swRgOff), swRgPt: new Int32Array(f2.swRgPt), swRgLL: new Float32Array(f2.swRgLL) }
  return out
}
// 这次结果里所有可 transfer 的底层缓冲（postMessage 第二参用）
export function transfersOf(r) {
  const t = [r.orb.buf, r.orbP.buf, r.trk.buf, r.fp.buf, r.gen.buf, r.cone.buf, r.fill.buf, r.swath.buf,
    r.sub.buf, r.hl.buf, r.hlP.buf]
  for (const d of r.dots) t.push(d.buf)
  if (r.flat) t.push(r.flat.trkOff.buffer, r.flat.trkLL.buffer, r.flat.fpOff.buffer, r.flat.fpLL.buffer, r.flat.sub.buffer, r.flat.swK.buffer, r.flat.swOff.buffer, r.flat.swLL.buffer,
    r.flat.swSk.buffer, r.flat.swOut.buffer, r.flat.swRgOff.buffer, r.flat.swRgPt.buffer, r.flat.swRgLL.buffer)
  return t
}
