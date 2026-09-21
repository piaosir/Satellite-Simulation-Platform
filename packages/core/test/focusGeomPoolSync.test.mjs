// 聚焦几何 Worker 池的选中集同步（src/viz/constellation/focusGeomPool.js）：
//  同一个 key 换了 satrec / 颜色，池必须把新的那份重新喂给分片 —— 否则分片一直拿头一次见到的旧星算几何。
//  真实形状：星座向导的预览星 NORAD 号固定（1800000 起），从默认草稿（550 km 低轨）改成地球同步后
//  key 不变、satrec 换了；信息卡读主线程的新 satrec 显示 GEO，而轨道线 / 覆盖圈按分片里的旧低轨星画。
//  ① 同 key 换 satrec → 几何随之变，且与「从头只喂新星」的池逐位相同
//  ② 同 key 换颜色 → 在轨点的色桶随之变
//  ③ 同 key 同 satrec 重复 setSats → 不重发（缓存立得住）
import sat from '../../../src/viz/constellation/satellite.js'
import { createFocusGeomPool } from '../../../src/viz/constellation/focusGeomPool.js'
import { createShard, syncShard } from '../../../src/viz/constellation/focusGeomTick.js'

let fails = 0
const ok = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  (' + extra + ')' : ''}`); if (!cond) fails++ }

const EPOCH = '2026-09-22T00:00:00.000Z'
const mk = (meanMotion, incl) => sat.omm2satrec({ noradId: 'SIM', epoch: EPOCH, meanMotion, ecc: 0, incl, raan: 0, argp: 0, ma: 0, bstar: 0, mdot: 0, mddot: 0 })
const LEO = mk(15.06, 53)       // 向导默认草稿：550 km / 53°
const GEO = mk(1.0027, 0)       // 地球同步
const KEY = 'n:1800000'         // 预览星座第一颗的合成号，改参数不变

const t = Date.parse('2026-09-22T06:00:00Z')
const gm = sat.gstime(new Date(t))
const P = {
  tMs: t, gmst: gm, ccTMs: t, ccGmst: gm,
  lod: { samples: 120, stepDeg: 4, fpSeg: 72 }, per: 1,
  ring: { on: true, tMs: t, gmst: gm, rebuild: true, build: true },
  fp: { mode: 'elev', beamDeg: NaN, elevDeg: 45 },
  style: { orbDash: 'solid', trkOn: true, trkDash: 'solid', trkMode: 'line', trkFillOn: false, fpOn: true, fpDash: 'dash', fillOn: false,
    coneOn: false, faceOn: false, genCount: 0, genDash: 'solid', dotOn: true, dotPx: 13, subOn: true, ringOn: true },
  want2d: false
}
const arr = (x) => (x && x.n > 0 ? Array.from(new Float32Array(x.buf, 0, x.n)) : [])
const digest = (shards) => JSON.stringify(shards.map((s) => ({ orbP: arr(s.orbP), fp: arr(s.fp), trk: arr(s.trk), hlP: arr(s.hlP), dots: s.dots.map((d) => d.px + ':' + d.tint + ':' + arr(d).join(',')) })))
// 覆盖圈顶点离球心的最大张角：低轨 45° 仰角圈只有几度，GEO 的有三十几度
const fpSpanDeg = (shards) => {
  const v = arr(shards[0].fp); let best = 0
  for (let i = 0; i + 2 < v.length; i += 3) for (let j = i + 3; j + 2 < v.length; j += 3) {
    const d = (v[i] * v[j] + v[i + 1] * v[j + 1] + v[i + 2] * v[j + 2]) / (Math.hypot(v[i], v[i + 1], v[i + 2]) * Math.hypot(v[j], v[j + 1], v[j + 2]))
    best = Math.max(best, Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI)
  }
  return best
}

// —— ① 同 key 换 satrec ——
{
  const pool = createFocusGeomPool(-1)
  pool.setSats([{ key: KEY, rec: LEO, cc: true, color: 0x4dabf7 }], KEY)
  const leoOut = await pool.compute(P)
  pool.setSats([{ key: KEY, rec: GEO, cc: true, color: 0x4dabf7 }], KEY)
  const geoOut = await pool.compute(P)
  const fresh = createFocusGeomPool(-1)
  fresh.setSats([{ key: KEY, rec: GEO, cc: true, color: 0x4dabf7 }], KEY)
  const freshOut = await fresh.compute(P)
  ok(digest(leoOut) !== digest(geoOut), '① 同 key 换 satrec 后几何变了', `低轨圈张角 ${fpSpanDeg(leoOut).toFixed(1)}° → ${fpSpanDeg(geoOut).toFixed(1)}°`)
  ok(fpSpanDeg(geoOut) > 30, '① 换成 GEO 后覆盖圈是 GEO 的口径（张角 > 30°）', fpSpanDeg(geoOut).toFixed(1) + '°')
  ok(digest(geoOut) === digest(freshOut), '① 与从头只喂 GEO 的池逐位相同')
}

// —— ② 同 key 同 satrec 换颜色 ——
{
  const pool = createFocusGeomPool(-1)
  pool.setSats([{ key: KEY, rec: GEO, cc: true, color: 0x4dabf7 }], KEY)
  const a = await pool.compute(P)
  pool.setSats([{ key: KEY, rec: GEO, cc: true, color: 0xff8800 }], KEY)
  const b = await pool.compute(P)
  ok(a[0].dots.some((d) => d.tint === 0x4dabf7) && b[0].dots.some((d) => d.tint === 0xff8800) && !b[0].dots.some((d) => d.tint === 0x4dabf7),
    '② 同 key 换颜色后在轨点色桶换了', a[0].dots.map((d) => d.tint.toString(16)).join('/') + ' → ' + b[0].dots.map((d) => d.tint.toString(16)).join('/'))
}

// —— ③ 同 key 同 satrec 同颜色：分片里的对象不换（缓存立得住）——
{
  const st = createShard()
  const e = { key: KEY, rec: GEO, cc: true, color: 0x4dabf7 }
  syncShard(st, { keys: [KEY], add: [e], primary: KEY })
  const before = st.recs.get(KEY)
  syncShard(st, { keys: [KEY], add: [], primary: KEY })
  ok(st.recs.get(KEY) === before && st.list.length === 1, '③ 不带 add 的重同步不换分片里的对象')
  syncShard(st, { keys: [KEY], add: [{ key: KEY, rec: LEO, cc: true, color: 0x4dabf7 }], primary: KEY })
  ok(st.recs.get(KEY) !== before && st.recs.get(KEY).rec === LEO, '③ 带 add 的重同步换成新 satrec')
}

if (fails) { console.log(`\n${fails} 项失败`); process.exit(1) } else console.log('\n全部通过')
