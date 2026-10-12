// 视频导出的纯计算（src/shared/video/videoPlan.js）：节奏三角、首尾帧落点、取景框、渲染几何、H.264 Level 选择、码率与体积；
// 仿真秒读数（亚秒步长）、导出入口单飞闸。
// 运行：npm test -- videoPlan
import { computePace, frameTime, frameTsUs, cropRect, renderGeom, normFrame, frameOfRect, fitSize, FRAME_SMIN, h264Codec, bitrateOf, gopFrames, estimateBytes, evenDims, fmtClock, fmtSpeed, fmtSimSec, singleFlight, MAX_FRAMES } from '../../../src/shared/video/videoPlan.js'
import { parseDur } from '../../../src/shared/tlPeriod.js'

let pass = 0, fail = 0
const ok = (name, cond, note) => {
  if (cond) { pass++; console.log('PASS  ' + name + (note ? '  (' + note + ')' : '')) }
  else { fail++; console.log('FAIL  ' + name + (note ? '  — ' + note : '')) }
}
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e

// ① 节奏：三种填法折成同一组 帧数 / 时长 / 倍速 / 步长
{
  const S = 6 * 3600
  const a = computePace(S, 30, { mode: 'speed', speed: 600 })        // 6 h ÷ 600 = 36 s
  ok('① 倍速：6 h × 600 → 36 s 视频、1081 帧', a.ok && a.frames === 1081 && near(a.durationSec, 36) && near(a.speed, 600) && near(a.stepSec, 20), JSON.stringify(a))
  const b = computePace(S, 30, { mode: 'duration', durationSec: 36 })
  ok('① 视频时长：36 s → 同一组数', b.frames === a.frames && near(b.speed, 600))
  const c = computePace(S, 30, { mode: 'step', stepSec: 20 })
  ok('① 步长：20 s/帧 → 同一组数', c.frames === a.frames && near(c.speed, 600))
  const d = computePace(S, 30, { mode: 'step', stepSec: 7 })          // 不整除：⌊21600/7⌋+1 = 3086 帧，步长按帧数回推
  ok('① 步长不整除：帧数取整、步长回推使首尾落在起止上', d.frames === 3086 && near(d.stepSec * (d.frames - 1), S, 1e-6))
  const e = computePace(100 * 365 * 86400, 60, { mode: 'speed', speed: 1 })
  ok('① 帧数封顶 MAX_FRAMES 并标出', e.tooMany && e.frames === MAX_FRAMES)
}
// ①b 单帧（单张图像）：起止重合、或填的数撑不满一个帧间隔 → 1 帧，派生量记 0
{
  const one = (r) => r.ok && r.frames === 1 && r.durationSec === 0 && r.speed === 0 && r.stepSec === 0
  const z = [{ mode: 'speed', speed: 600 }, { mode: 'duration', durationSec: 30 }, { mode: 'step', stepSec: 10 }].map((p) => computePace(0, 30, p))
  ok('①b 起止重合（时段 0）→ 单帧，三种填法都一样', z.every(one), JSON.stringify(z[0]))
  ok('①b 步长大于时段 → 单帧；步长 = 时段 → 首尾两帧', one(computePace(3600, 30, { mode: 'step', stepSec: 7200 })) && computePace(3600, 30, { mode: 'step', stepSec: 3600 }).frames === 2)
  ok('①b 倍速大到不足半个帧间隔 → 单帧', one(computePace(6 * 3600, 30, { mode: 'speed', speed: 1e12 })))
  const bad = [computePace(-1, 30, { mode: 'speed', speed: 1 }), computePace(NaN, 30, { mode: 'speed', speed: 1 }), computePace(Infinity, 30, { mode: 'speed', speed: 1 }),
    computePace(3600, 0, { mode: 'speed', speed: 1 }), computePace(3600, 30, { mode: 'step', stepSec: 0 }), computePace(3600, 30, { mode: 'speed', speed: Infinity }), computePace(3600, 30, null)]
  ok('①b 时段为负 / 非数、帧率或节奏无效 → ok=false', bad.every((r) => !r.ok && r.frames === 0))
  ok('①b 单帧落在起始时刻', frameTime(1_700_000_000_000, 1_700_000_000_000, 1, 0) === 1_700_000_000_000 && frameTime(5, 9, 1, 0) === 5)
}
// ② 首尾帧精确落在起止时刻；时间戳严格等间隔
{
  const t0 = 1_700_000_000_000, t1 = t0 + 3600e3, N = 1081
  ok('② 第 0 帧 = t0、末帧 = t1', frameTime(t0, t1, N, 0) === t0 && frameTime(t0, t1, N, N - 1) === t1)
  ok('② 中间帧线性', near(frameTime(t0, t1, N, 540), t0 + 1800e3, 1e-3))
  let mono = true
  for (let k = 1; k < 2000; k++) if (frameTsUs(k, 30) <= frameTsUs(k - 1, 30)) mono = false
  ok('② 帧时间戳单调、30 fps 第 30 帧 = 1 s', mono && frameTsUs(30, 30) === 1e6)
}
// ③ 取景框：舞台里按成片宽高比取最大居中矩形（contain）
{
  const a = cropRect(1500, 900, 1920, 1080)        // 舞台比 16:9 高 → 上下留边
  ok('③ 宽舞台：取满宽、上下居中', near(a.w, 1500) && near(a.h, 843.75) && near(a.y, 28.125) && a.x === 0)
  const b = cropRect(1000, 900, 1080, 1920)        // 竖屏 → 左右留边
  ok('③ 竖屏：取满高、左右居中', near(b.h, 900) && near(b.w, 506.25) && near(b.x, 246.875))
  // 摆位：出厂 = 最大居中（与不给摆位逐位相同）；缩放 + 平移；夹进舞台；屏上框 ⇄ 摆位回环
  const d = cropRect(1500, 900, 1920, 1080, { x: 0.5, y: 0.5, s: 1 })
  ok('③ 出厂摆位 = 最大居中框', d.x === a.x && d.y === a.y && d.w === a.w && d.h === a.h)
  const e = cropRect(1500, 900, 1920, 1080, { x: 0.25, y: 0.3, s: 0.5 })
  ok('③ 半大、框心在 (25%, 30%)', near(e.w, 750) && near(e.h, 421.875) && near(e.x + e.w / 2, 375) && near(e.y + e.h / 2, 270))
  const f = cropRect(1500, 900, 1920, 1080, { x: 0, y: 1, s: 0.5 })
  ok('③ 拖出界：贴着舞台边停住', near(f.x, 0) && near(f.y + f.h, 900))
  const g0 = cropRect(1500, 900, 1920, 1080, { x: 0.9, y: 0.1, s: 1 })
  ok('③ 最大框只能沿有余量的那一轴挪（宽舞台：横向贴满、纵向贴顶）', near(g0.x, 0) && near(g0.w, 1500) && near(g0.y, 0))
  const fr = frameOfRect(1500, 900, 1920, 1080, e)
  ok('③ 屏上框 → 摆位回环', near(fr.x, 0.25) && near(fr.y, 0.3) && near(fr.s, 0.5))
  const nf = normFrame({ x: -3, y: 'a', s: 0.01 })
  ok('③ 坏摆位规整：夹到 0…1、大小下限 FRAME_SMIN', nf.x === 0 && nf.y === 0.5 && nf.s === FRAME_SMIN && normFrame(null).s === 1)
  const fs = fitSize(1500, 900, 1920, 1080)
  ok('③ 最大可容框尺寸', near(fs.w, 1500) && near(fs.h, 843.75))
}
// ④ 渲染几何：整舞台定取景（CSS 尺寸 = 舞台 / u），只出取景框一块（画布 = 框 / u，像素恰 = 成片 × 超采样）；标注缩放只改 CSS 尺寸
{
  const c = cropRect(1500, 900, 1920, 1080)
  const g = renderGeom(1500, 900, c, 1920, 1080, 1, 2)
  ok('④ 源矩形宽高 = 成片 × 超采样', near(g.src.w, 3840, 1e-6) && near(g.src.h, 2160, 1e-6), JSON.stringify(g.src))
  ok('④ u=1：CSS 尺寸 = 舞台', g.cssW === 1500 && g.cssH === 900)
  const g2 = renderGeom(1500, 900, c, 1920, 1080, 1.5, 1)
  ok('④ u=1.5：CSS 尺寸缩 1.5 倍、源矩形仍 = 成片', near(g2.cssW, 1000) && near(g2.src.w, 1920, 1e-6) && near(g2.src.h, 1080, 1e-6))
  // 画布 = 取景框：floor(框宽 × 倍率) 恰为成片像素（不因浮点少 1 px）；视口原点 = 框在整舞台里的位置
  const e = cropRect(1500, 900, 3840, 2160, { x: 0.3, y: 0.62, s: 0.37 })
  let allExact = true
  for (const u of [0.5, 1, 1.25, 2]) for (const ss of [1, 2]) {
    const q = renderGeom(1500, 900, e, 3840, 2160, u, ss)
    if (Math.floor(q.view.w * q.renderPr) !== 3840 * ss || Math.floor(q.view.h * q.renderPr) !== 2160 * ss) allExact = false
  }
  ok('④ 画布像素恰 = 成片 × 超采样（任意框、任意标注缩放）', allExact)
  const q = renderGeom(1500, 900, e, 3840, 2160, 1.25, 1)
  ok('④ 视口：框在渲染 CSS 坐标里的原点与大小', near(q.view.x, e.x / 1.25) && near(q.view.y, e.y / 1.25) && near(q.view.w, e.w / 1.25, 1e-5) && near(q.cssW, 1200))
  ok('④ 整舞台视口像素 = 舞台 × 成片宽 / 框宽（框越小越大，按它判显卡视口上限）', near(q.cssW * q.renderPr, 1500 * 3840 / e.w, 1e-6))
}
// ⑤ H.264 Level：最低可行档
{
  const L = (w, h, f, br) => (h264Codec(w, h, f, br) || {}).codec
  ok('⑤ 720p30 → 3.1', L(1280, 720, 30, 5e6) === 'avc1.64001F')
  ok('⑤ 1080p30 → 4.0', L(1920, 1080, 30, 12e6) === 'avc1.640028')
  ok('⑤ 1080p30 高码率 40 Mbps → 4.1（4.0 的 High 上限 25 Mbps）', L(1920, 1080, 30, 40e6) === 'avc1.640029')
  ok('⑤ 1080p60 → 4.2', L(1920, 1080, 60, 12e6) === 'avc1.64002A')
  ok('⑤ 2160p30 → 5.1', L(3840, 2160, 30, 40e6) === 'avc1.640033')
  ok('⑤ 2160p60 → 5.2', L(3840, 2160, 60, 60e6) === 'avc1.640034')
  ok('⑤ 1080×1920 竖屏 30 → 4.0（单边宏块数 120 ≤ √(8·8192)）', L(1080, 1920, 30, 12e6) === 'avc1.640028')
  ok('⑤ 超出 5.2 → null', h264Codec(8192, 4320, 30, 50e6) === null)
}
// ⑥ 码率 / 关键帧 / 体积 / 宽高规整
{
  ok('⑥ 1080p30 高档 ≈ 12.4 Mbps', Math.abs(bitrateOf(1920, 1080, 30, 'high') - 12.44e6) < 0.01e6)
  ok('⑥ 自定义码率按 Mbps、夹在 [1, 240]', bitrateOf(1920, 1080, 30, 'custom', 500) === 240e6 && bitrateOf(1920, 1080, 30, 'custom', 0.2) === 1e6)
  ok('⑥ 关键帧间隔：30 fps × 1 s = 30 帧；0.5 s @25 → 13 帧（取整）', gopFrames(30, 1) === 30 && gopFrames(25, 0.5) === 13)
  ok('⑥ MP4 体积 = 码率 × 时长', near(estimateBytes('mp4', 1920, 1080, 901, 30, 12e6), 45e6))
  const e = evenDims(1921, 33)
  ok('⑥ 宽高取偶、夹到 [64, 4096]', e.w === 1922 && e.h === 64 && evenDims(9999, 1080).w === 4096)
  ok('⑥ 读数：fmtClock 3725 → 1:02:05、fmtSpeed', fmtClock(3725) === '1:02:05' && fmtClock(36) === '0:36' && fmtSpeed(1800) === '×1,800' && fmtSpeed(0.5) === '×0.5')
}
// ⑦ 仿真秒读数（面板「时长」「每帧步长」）：亚秒步长不能读成「0s」；10 s 起与共用的 fmtSpanSec 同一写法
{
  const p1 = computePace(3600, 30, { mode: 'speed', speed: 1 })      // ×1 @ 30 fps：每帧 1/30 s
  ok('⑦ 倍速 ×1 @30 fps → 0.033s/帧（旧读数 0s）', fmtSimSec(p1.stepSec) === '0.033s', fmtSimSec(p1.stepSec))
  const cases = [[0.5, '0.5s'], [0.25, '0.25s'], [0.1, '0.1s'], [0.999, '1s'], [1, '1s'], [2.5, '2.5s'], [10 / 3, '3.33s'], [9.996, '10s'], [10, '10s'], [90, '1m30s'], [3600, '1h'], [0, '0s']]
  const bad = cases.filter(([s, w]) => fmtSimSec(s) !== w).map(([s, w]) => `${s}→${fmtSimSec(s)}≠${w}`)
  ok('⑦ 1 s 起两位小数、1 s 以下两位有效数字、10 s 起照旧', !bad.length, bad.join(' '))
  ok('⑦ 极小步长不出科学计数', fmtSimSec(2.8e-6) === '0.0000028s', fmtSimSec(2.8e-6))
  ok('⑦ 步长框回填可原样解析（parseDur）', [0.5, 0.033, 2.5, 3.33].every((s) => Math.abs(parseDur(fmtSimSec(s), 1) - s) < 1e-9))
}
// ⑧ 导出入口单飞闸（「开始导出」双击）：闸在同步入口落下 —— 第一路还在等保存框时第二下进不来；跑完 / 抛错 / 中途 return 都抬起
{
  const flag = { value: false }
  let calls = 0, release
  const dialog = new Promise((r) => { release = r })
  const run = singleFlight(async () => { calls++; await dialog; return 'done' }, flag)
  const p1 = run(), p2 = run()                                        // 同一拍里连点两下
  ok('⑧ 双击：只进一路、闸同步落下', calls === 1 && flag.value === true)
  release()
  const [a, b] = await Promise.all([p1, p2])
  ok('⑧ 第二下直接返回、第一路照常跑完、闸抬起', a === 'done' && b === undefined && flag.value === false)
  ok('⑧ 收尾后能再进', (await run()) === 'done' && calls === 2 && flag.value === false)
  const boom = singleFlight(async () => { calls++; throw new Error('x') }, flag)
  let threw = false
  try { await boom() } catch { threw = true }
  ok('⑧ 出错也抬闸（报错后还能再导出）', threw && flag.value === false && calls === 3)
  const early = singleFlight(async () => { calls++ }, flag)          // 保存框点了取消：中途 return
  await early(); await early()
  ok('⑧ 中途 return 也抬闸', calls === 5 && flag.value === false)
}

console.log(`\n${fail ? 'FAIL' : 'OK'} ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
