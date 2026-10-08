// H.264 MP4 封装器（src/shared/video/mp4Mux.js）：盒结构、快启动布局、样本表与真实偏移、颜色盒、B 帧重排、co64、回退路径。
// 用内存里的「按位置写」sink 当文件，写完逐字节回读核对 —— 样本数据必须一个字节不差地落在 stco 指的位置上。
// 真编码器 + Chromium <video> 回放的端到端核对另在 Electron 里做（WebCodecs 只在渲染进程里有）。
// 运行：npm test -- videoMp4Mux
import { createMp4Muxer, parseBoxes, moovBound, colrNclx } from '../../../src/shared/video/mp4Mux.js'

let pass = 0, fail = 0
const ok = (name, cond, note) => {
  if (cond) { pass++; console.log('PASS  ' + name + (note ? '  (' + note + ')' : '')) }
  else { fail++; console.log('FAIL  ' + name + (note ? '  — ' + note : '')) }
}

function memSink() {
  let buf = new Uint8Array(1 << 16), len = 0
  return {
    async write(bytes, pos) {
      if (pos + bytes.length > buf.length) { const nb = new Uint8Array(Math.max(buf.length * 2, pos + bytes.length)); nb.set(buf.subarray(0, len)); buf = nb }
      buf.set(bytes, pos); len = Math.max(len, pos + bytes.length)
      await Promise.resolve()
    },
    get bytes() { return buf.subarray(0, len) }
  }
}
const find = (boxes, path) => {
  let cur = boxes
  let b = null
  for (const t of path.split('/')) { b = (cur || []).find((x) => x.type === t); if (!b) return null; cur = b.kids }
  return b
}
const u32 = (u8, p) => ((u8[p] << 24) >>> 0) + (u8[p + 1] << 16) + (u8[p + 2] << 8) + u8[p + 3]
// 伪造的 AVCDecoderConfigurationRecord（内容无所谓，封装器原样放进 avcC）
const AVCC = new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 2, 0x68, 0xee])
function frames(n, key = (i) => i % 30 === 0) {
  const out = []
  for (let i = 0; i < n; i++) {
    const sz = 50 + ((i * 37) % 400)
    const b = new Uint8Array(sz)
    for (let j = 0; j < sz; j++) b[j] = (i * 131 + j * 7) & 0xff
    out.push({ b, key: key(i) })
  }
  return out
}

async function build(n, opt = {}) {
  const sink = memSink()
  const fps = opt.fps || 30
  const mux = createMp4Muxer({ width: 1920, height: 1080, fps, frameCount: n, bitrate: 12e6, sink, ...opt })
  const fr = frames(n, opt.key)
  const pts = opt.pts || ((i) => Math.round(i * 1e6 / fps))
  fr.forEach((f, i) => mux.addChunk(f.b, { key: f.key, ptsUs: pts(i) }, i === 0 ? { description: AVCC, colorSpace: { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'smpte170m', fullRange: false } } : undefined))
  const r = await mux.finalize()
  return { u8: sink.bytes, r, fr, mux }
}

// ① 快启动布局：ftyp → moov → free → mdat
{
  const { u8, r, fr } = await build(300)
  const top = parseBoxes(u8)
  ok('① 顶层顺序 ftyp / moov / free / mdat', top.map((b) => b.type).join(',') === 'ftyp,moov,free,mdat' && r.faststart, top.map((b) => b.type).join(','))
  const mdat = top.find((b) => b.type === 'mdat')
  const dataBytes = fr.reduce((a, f) => a + f.b.length, 0)
  ok('① mdat 用 64 位 largesize，大小 = 16 + 样本总字节', mdat.hdr === 16 && mdat.size === 16 + dataBytes)
  ok('① 文件末尾 = mdat 末尾（没有尾随的 moov）', mdat.at + mdat.size === u8.length && r.bytes === u8.length)
  ok('① 顶层盒首尾相接、无空洞（free 吃满预留）', top.every((b, i) => i === 0 || b.at === top[i - 1].at + top[i - 1].size) && top[0].at === 0)

  // ② 样本表：数目 / 大小 / 偏移逐个对上真实数据
  const stsz = find(top, 'moov/trak/mdia/minf/stbl/stsz'), stco = find(top, 'moov/trak/mdia/minf/stbl/stco')
  const n = u32(u8, stsz.at + 16)
  let sizesOk = n === fr.length, dataOk = true
  for (let i = 0; i < n; i++) {
    const sz = u32(u8, stsz.at + 20 + i * 4), off = u32(u8, stco.at + 16 + i * 4)
    if (sz !== fr[i].b.length) sizesOk = false
    const want = fr[i].b
    for (let j = 0; j < sz; j += 13) if (u8[off + j] !== want[j]) { dataOk = false; break }
  }
  ok('② stsz：300 个样本、大小逐个相符', sizesOk)
  ok('② stco：每个偏移处的字节就是那一帧的数据', dataOk)
  const stts = find(top, 'moov/trak/mdia/minf/stbl/stts')
  ok('② stts：一条记录 300 × 3000（90 kHz @30 fps）', u32(u8, stts.at + 12) === 1 && u32(u8, stts.at + 16) === 300 && u32(u8, stts.at + 20) === 3000)
  const stss = find(top, 'moov/trak/mdia/minf/stbl/stss')
  ok('② stss：关键帧 1, 31, 61 …（1 起）', stss && u32(u8, stss.at + 12) === 10 && u32(u8, stss.at + 16) === 1 && u32(u8, stss.at + 20) === 31)
  ok('② 无重排时不写 ctts / edts', !find(top, 'moov/trak/mdia/minf/stbl/ctts') && !find(top, 'moov/trak/edts'))
  const mdhd = find(top, 'moov/trak/mdia/mdhd'), mvhd = find(top, 'moov/mvhd')
  ok('② mdhd：90000 刻度、时长 900000（10 s）；mvhd 10000 ms', u32(u8, mdhd.at + 20) === 90000 && u32(u8, mdhd.at + 24) === 900000 && u32(u8, mvhd.at + 24) === 10000 && Math.abs(r.durationSec - 10) < 1e-9)
  const tkhd = find(top, 'moov/trak/tkhd')
  ok('② tkhd：1920 × 1080（16.16 定点）', u32(u8, tkhd.at + 84) === 1920 * 65536 && u32(u8, tkhd.at + 88) === 1080 * 65536)

  // ③ 样本描述：avc1 → avcC 原样 + colr nclx（BT.709 原色 / sRGB 传递 / BT.601 矩阵 / 有限范围）+ pasp + btrt
  const avc1 = find(top, 'moov/trak/mdia/minf/stbl/stsd/avc1')
  const kids = (avc1 && avc1.kids || []).map((b) => b.type)
  ok('③ avc1 的子盒 avcC / colr / pasp / btrt', kids.join(',') === 'avcC,colr,pasp,btrt', kids.join(','))
  const avcC = avc1.kids[0]
  ok('③ avcC 字节与编码器给的一致', avcC.size === 8 + AVCC.length && AVCC.every((v, i) => u8[avcC.at + 8 + i] === v))
  const colr = avc1.kids[1], cb = u8.subarray(colr.at + 8, colr.at + colr.size)
  ok('③ colr nclx 1 / 13 / 6 / 有限范围', String.fromCharCode(...cb.subarray(0, 4)) === 'nclx' && cb[5] === 1 && cb[7] === 13 && cb[9] === 6 && cb[10] === 0)
  ok('③ avc1 宽高字段', ((u8[avc1.at + 32] << 8) | u8[avc1.at + 33]) === 1920 && ((u8[avc1.at + 34] << 8) | u8[avc1.at + 35]) === 1080)
  ok('③ 预留上界够用：moov ≤ moovBound', find(top, 'moov').size <= moovBound(300))
}
// ④ B 帧重排：展示序 ≠ 解码序 → ctts（偏移非负）+ edts/elst 把展示起点拉回 0
{
  // 解码序 I P B B P B B …：P 先于两个 B 解码。展示时间戳 = 0, 3, 1, 2, 6, 4, 5 …（单位：帧）
  const order = []
  for (let g = 0; g < 10; g++) { const b = g * 3; if (g === 0) order.push(0); else { order.push(b); order.push(b - 2); order.push(b - 1) } }
  const n = order.length
  const { u8 } = await build(n, { pts: (i) => Math.round(order[i] * 1e6 / 30), key: (i) => i === 0 })
  const top = parseBoxes(u8)
  const ctts = find(top, 'moov/trak/mdia/minf/stbl/ctts'), elst = find(top, 'moov/trak/edts/elst')
  ok('④ 有重排 → 写 ctts 与 elst', !!ctts && !!elst)
  if (ctts && elst) {
    const runs = u32(u8, ctts.at + 12)
    const offs = []
    for (let k = 0; k < runs; k++) { const c = u32(u8, ctts.at + 16 + k * 8), v = u32(u8, ctts.at + 20 + k * 8); for (let j = 0; j < c; j++) offs.push(v) }
    const shift = u32(u8, elst.at + 20)
    const ptsBack = offs.map((o, i) => i * 3000 + o - shift)
    ok('④ DTS + ctts − shift 回到每帧的展示时间戳', offs.length === n && ptsBack.every((p, i) => p === order[i] * 3000), 'shift ' + shift)
  }
}
// ⑤ co64：偏移超 4 GB 时换 64 位块偏移（这里强制打开核对写法）
{
  const { u8 } = await build(40, { forceCo64: true })
  const top = parseBoxes(u8)
  const co64 = find(top, 'moov/trak/mdia/minf/stbl/co64')
  ok('⑤ forceCo64 → co64 且偏移可读', !!co64 && u32(u8, co64.at + 12) === 40 && u32(u8, co64.at + 16) === 0 && u32(u8, co64.at + 20) > 0)
}
// ⑥ 关掉快启动：moov 写在 mdat 之后，同样合法
{
  const { u8, r } = await build(60, { faststart: false })
  const top = parseBoxes(u8)
  ok('⑥ faststart=false → ftyp / mdat / moov', top.map((b) => b.type).join(',') === 'ftyp,mdat,moov' && !r.faststart, top.map((b) => b.type).join(','))
}
// ⑦ 24 fps 与非 90 kHz 整除帧率的刻度
{
  const { mux } = await build(48, { fps: 24 })
  ok('⑦ 24 fps：90 kHz / Δ 3750', mux.timescale === 90000 && mux.delta === 3750)
  const m2 = createMp4Muxer({ width: 640, height: 360, fps: 29, frameCount: 10, sink: memSink() })
  ok('⑦ 29 fps：退到 fps × 1000 刻度', m2.timescale === 29000 && m2.delta === 1000)
}
// ⑧ 颜色盒映射表
{
  ok('⑧ 未知颜色串不写 colr', colrNclx({ primaries: 'xyz', transfer: 'bt709', matrix: 'bt709' }) === null && colrNclx(null) === null)
  const c = colrNclx({ primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: true })
  // 盒：size(4) 'colr'(4) 'nclx'(4) 原色 u16 @12 / 传递 u16 @14 / 矩阵 u16 @16 / 范围 u8 @18
  ok('⑧ BT.709 全范围 → 1/1/1 + 0x80', c.length === 19 && c[13] === 1 && c[15] === 1 && c[17] === 1 && c[18] === 0x80)
}
// ⑨ 出错与边界：没有帧 / 没有 avcC 都拒绝收尾；收尾后再喂帧抛错
{
  let e1 = null, e2 = null, e3 = null
  try { await createMp4Muxer({ width: 64, height: 64, fps: 30, frameCount: 1, sink: memSink() }).finalize() } catch (e) { e1 = e }
  const m = createMp4Muxer({ width: 64, height: 64, fps: 30, frameCount: 1, sink: memSink() })
  m.addChunk(new Uint8Array(10), { key: true, ptsUs: 0 })
  try { await m.finalize() } catch (e) { e2 = e }
  try { m.addChunk(new Uint8Array(1), { key: false, ptsUs: 1 }) } catch (e) { e3 = e }
  ok('⑨ 空片 / 缺 avcC / 结束后再写 都抛错', !!e1 && !!e2 && !!e3)
}
// ⑩ 写盘失败要冒出来（sink 抛错 → finalize 抛错）
{
  const bad = { write: async (b, p) => { if (p > 100) throw new Error('磁盘满') } }
  const m = createMp4Muxer({ width: 64, height: 64, fps: 30, frameCount: 4, sink: bad })
  for (let i = 0; i < 4; i++) m.addChunk(new Uint8Array(20), { key: i === 0, ptsUs: i * 33333 }, i === 0 ? { description: AVCC } : undefined)
  let err = null
  try { await m.finalize() } catch (e) { err = e }
  ok('⑩ sink 写失败 → finalize 抛出原错误', !!err && /磁盘满/.test(err.message))
}

console.log(`\n${fail ? 'FAIL' : 'OK'} ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
