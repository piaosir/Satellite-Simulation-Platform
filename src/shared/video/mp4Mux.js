// H.264 单视频轨 MP4 流式封装（ISO/IEC 14496-12 ISOBMFF + 14496-15 AVC 文件格式）。不依赖任何第三方库。
//
// 用法（编码器 output 回调里逐个喂，顺序 = 解码顺序）：
//   const mux = createMp4Muxer({ width, height, fps, frameCount, bitrate, sink })
//   mux.addChunk(bytes, { key, ptsUs }, decoderConfig)     // decoderConfig 只在首个关键帧带（WebCodecs 的 metadata.decoderConfig）
//   await mux.finalize()                                    // 写 moov；返回 { bytes, frames, durationSec, faststart }
// sink: { write(bytes: Uint8Array, position: number) → Promise | void } —— 按绝对位置写（主进程 fs.write 落盘）
//
// ★ 快启动（moov 在 mdat 之前）：帧数事先已知（逐帧离线渲染），moov 的上界可以按帧数算死 → 文件头上先留一块 free，
//   结束时把 moov 写进这块、余下的再记成一个 free。这样 moov 在前（网页 / 播放器边下边播、PowerPoint 插入都认），
//   又不必像常规「快启动」那样结束后把整个 mdat 往后挪一遍（几个 GB 的 4K 视频挪一次就是几十秒）。
//   万一 moov 超了预留（不应发生：上界按每帧 24 字节 + 4 KB 算），退回到 moov 写在文件尾 —— 仍是合法 MP4。
// ★ 样本数据批量写：攒满 4 MB 再交给 sink（一帧一次 IPC 太碎）。
// ★ 时间戳：stts 恒定帧间隔（逐帧离线渲染，严格等间隔）。编码器若输出 B 帧（解码序 ≠ 展示序），
//   按展示时间戳算 ctts，并用编辑表（elst）把展示起点挪回 0 —— Chromium 的 H.264 编码器目前不出 B 帧，这条是保险。
// ★ 颜色：按编码器报的 colorSpace 写 colr（nclx）。Chromium 把 RGB 画布转 YUV 用的是 BT.601 矩阵 + 有限范围，
//   不标的话播放器多按 BT.709 解，红绿会偏一点。

const BOX_ASCII = (s) => { const a = new Uint8Array(4); for (let i = 0; i < 4; i++) a[i] = s.charCodeAt(i); return a }
const FLUSH_BYTES = 4 * 1024 * 1024
const MAC_EPOCH_OFFSET = 2082844800   // 1904-01-01 → 1970-01-01 的秒数

// —— 字节拼装 ——
class W {
  constructor(n = 256) { this.b = new Uint8Array(n); this.n = 0 }
  need(k) { if (this.n + k > this.b.length) { const nb = new Uint8Array(Math.max(this.b.length * 2, this.n + k)); nb.set(this.b.subarray(0, this.n)); this.b = nb } }
  u8(v) { this.need(1); this.b[this.n++] = v & 0xff; return this }
  u16(v) { this.need(2); this.b[this.n++] = (v >>> 8) & 0xff; this.b[this.n++] = v & 0xff; return this }
  u24(v) { this.need(3); this.b[this.n++] = (v >>> 16) & 0xff; this.b[this.n++] = (v >>> 8) & 0xff; this.b[this.n++] = v & 0xff; return this }
  u32(v) { this.need(4); const x = v >>> 0; this.b[this.n++] = x >>> 24; this.b[this.n++] = (x >>> 16) & 0xff; this.b[this.n++] = (x >>> 8) & 0xff; this.b[this.n++] = x & 0xff; return this }
  i32(v) { return this.u32(v | 0) }
  u64(v) { const hi = Math.floor(v / 4294967296), lo = v - hi * 4294967296; return this.u32(hi).u32(lo) }
  str(s) { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)); return this }
  bytes(a) { this.need(a.length); this.b.set(a, this.n); this.n += a.length; return this }
  zeros(k) { this.need(k); this.b.fill(0, this.n, this.n + k); this.n += k; return this }
  out() { return this.b.subarray(0, this.n) }
}
function box(type, ...parts) {
  let len = 8
  for (const p of parts) len += p.length
  const w = new W(len)
  w.u32(len).bytes(BOX_ASCII(type))
  for (const p of parts) w.bytes(p)
  return w.out()
}
const fullHead = (version, flags) => new W(4).u8(version).u24(flags).out()
const fullBox = (type, version, flags, ...parts) => box(type, fullHead(version, flags), ...parts)
const UNITY = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000]

// —— WebCodecs VideoColorSpace 字符串 → ISO/IEC 23091-2 码点 ——
const PRIM = { bt709: 1, bt470bg: 5, smpte170m: 6, bt2020: 9, smpte432: 12 }
const TRANSFER = { bt709: 1, smpte170m: 6, linear: 8, 'iec61966-2-1': 13, pq: 16, hlg: 18 }
const MATRIX = { rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6, 'bt2020-ncl': 9 }
export function colrNclx(cs) {
  if (!cs) return null
  const p = PRIM[cs.primaries], t = TRANSFER[cs.transfer], m = MATRIX[cs.matrix]
  if (p == null || t == null || m == null) return null
  return box('colr', new W(11).str('nclx').u16(p).u16(t).u16(m).u8(cs.fullRange ? 0x80 : 0).out())
}

/** moov 的字节上界：固定部分按 4 KB 算足（avcC 里的 SPS/PPS 几十字节），每帧最多 stsz 4 + co64 8 + stss 4 + ctts 8 */
export const moovBound = (frames) => 4096 + 24 * Math.max(1, frames | 0)

export function createMp4Muxer(o) {
  const width = o.width | 0, height = o.height | 0, fps = Number(o.fps) || 30
  const frames0 = Math.max(1, o.frameCount | 0)
  const sink = o.sink
  // 媒体时间刻度：90 kHz 能整除 24/25/30/50/60；别的帧率退到 fps×1000
  const TS = Number.isInteger(90000 / fps) ? 90000 : Math.round(fps * 1000)
  const DELTA = Math.round(TS / fps)
  const reserve = o.faststart === false ? 0 : moovBound(frames0) + 8

  const FTYP = box('ftyp', new W(24).str('isom').u32(0x200).str('isom').str('iso2').str('avc1').str('mp41').out())
  const freeAt = FTYP.length
  const mdatAt = freeAt + reserve
  const dataAt = mdatAt + 16                  // mdat 用 64 位 largesize 头（16 字节）：4K 长视频轻松过 4 GB

  const sizes = [], offsets = [], keys = [], pts = []
  let desc = null, colorSpace = null, pos = dataAt, closed = false, failed = null
  let buf = new Uint8Array(FLUSH_BYTES + 1024 * 1024), bufN = 0, bufAt = dataAt
  let chain = Promise.resolve()               // 写盘串行化（sink 可能是 IPC，结果到达次序不保证）
  let inflight = 0

  function sinkWrite(bytes, p) {
    inflight++
    chain = chain.then(() => sink.write(bytes, p)).catch((e) => { if (!failed) failed = e }).finally(() => { inflight-- })
    return chain
  }
  function flushBuf() {
    if (!bufN) return
    const piece = buf.slice(0, bufN)
    sinkWrite(piece, bufAt)
    bufAt += bufN; bufN = 0
  }
  // 头部：ftyp + 预留 free 头 + mdat 头（大小待定）。预留区本体不写 —— 文件系统把空洞读成 0，结束时整块覆写
  function writeHead() {
    const head = new W(FTYP.length + 8)
    head.bytes(FTYP)
    if (reserve) head.u32(reserve).str('free')
    sinkWrite(head.out(), 0)
    sinkWrite(new W(16).u32(1).str('mdat').u64(16).out(), mdatAt)
  }
  writeHead()

  function addChunk(bytes, meta, decoderConfig) {
    if (closed) throw new Error('muxer 已结束')
    if (failed) throw failed
    if (!desc && decoderConfig && decoderConfig.description) {
      const d = decoderConfig.description
      desc = d instanceof Uint8Array ? d.slice() : new Uint8Array(d.buffer ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d)
      colorSpace = decoderConfig.colorSpace || null
    }
    const n = bytes.byteLength
    offsets.push(pos); sizes.push(n); keys.push(!!(meta && meta.key)); pts.push(Math.round(((meta && meta.ptsUs) || 0) * TS / 1e6))
    pos += n
    if (bufN + n > buf.length) { flushBuf(); if (n > buf.length) buf = new Uint8Array(n + FLUSH_BYTES) }
    buf.set(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), bufN); bufN += n
    if (bufN >= FLUSH_BYTES) flushBuf()
  }
  /** 待写字节 / 写盘请求数：调用方据此做反压（编码比写盘快时别把内存撑满） */
  const pending = () => inflight
  async function drain(maxInflight = 2) { while (inflight > maxInflight) await chain }

  function buildMoov() {
    const N = sizes.length
    // 展示序 → ctts：DTS_i = i·Δ；PTS 与之不等（有重排）才写。shift 让所有偏移非负，再由 elst 把展示起点拉回 0
    let reorder = false
    for (let i = 0; i < N; i++) if (pts[i] !== i * DELTA) { reorder = true; break }
    let shift = 0
    if (reorder) for (let i = 0; i < N; i++) shift = Math.max(shift, i * DELTA - pts[i])
    const mediaDur = N * DELTA
    const movieDur = Math.round(mediaDur * 1000 / TS)
    const now = Math.floor(Date.now() / 1000) + MAC_EPOCH_OFFSET
    const big = (o.forceCo64 === true) || offsets.length && offsets[offsets.length - 1] + sizes[sizes.length - 1] > 0xFFFFFFFF
    const v1 = mediaDur > 0xFFFFFFFF

    const mvhd = fullBox('mvhd', 0, 0, (() => {
      const w = new W(96).u32(now).u32(now).u32(1000).u32(movieDur).u32(0x00010000).u16(0x0100).zeros(10)
      for (const m of UNITY) w.u32(m)
      return w.zeros(24).u32(2).out()
    })())
    const tkhd = fullBox('tkhd', 0, 3, (() => {
      const w = new W(80).u32(now).u32(now).u32(1).u32(0).u32(movieDur).zeros(8).u16(0).u16(0).u16(0).u16(0)
      for (const m of UNITY) w.u32(m)
      return w.u32(width * 65536).u32(height * 65536).out()
    })())
    const edts = reorder && shift > 0
      ? box('edts', fullBox('elst', 0, 0, new W(16).u32(1).u32(movieDur).i32(shift).u16(1).u16(0).out()))
      : null
    const mdhd = v1
      ? fullBox('mdhd', 1, 0, new W(32).u64(now).u64(now).u32(TS).u64(mediaDur).u16(0x55C4).u16(0).out())
      : fullBox('mdhd', 0, 0, new W(20).u32(now).u32(now).u32(TS).u32(mediaDur).u16(0x55C4).u16(0).out())
    const hdlr = fullBox('hdlr', 0, 0, new W(40).u32(0).str('vide').zeros(12).str('VideoHandler').u8(0).out())
    const vmhd = fullBox('vmhd', 0, 1, new W(8).u16(0).u16(0).u16(0).u16(0).out())
    const dinf = box('dinf', fullBox('dref', 0, 0, new W(4).u32(1).out(), fullBox('url ', 0, 1)))

    // 样本描述：avc1 + avcC（编码器给的 AVCDecoderConfigurationRecord 原样放）+ colr + pasp + btrt
    const name = 'LinkLab H.264'
    const comp = new W(32).u8(name.length).str(name).zeros(31 - name.length).out()
    const kids = [box('avcC', desc || new Uint8Array(0))]
    const colr = colrNclx(colorSpace); if (colr) kids.push(colr)
    kids.push(box('pasp', new W(8).u32(1).u32(1).out()))
    const avgBr = mediaDur > 0 ? Math.round(sizes.reduce((a, b) => a + b, 0) * 8 / (mediaDur / TS)) : 0
    kids.push(box('btrt', new W(12).u32(0).u32(Math.max(avgBr, o.bitrate | 0)).u32(avgBr).out()))
    const avc1 = box('avc1', new W(78).zeros(6).u16(1).u16(0).u16(0).zeros(12).u16(width).u16(height)
      .u32(0x00480000).u32(0x00480000).u32(0).u16(1).bytes(comp).u16(0x0018).u16(0xFFFF).out(), ...kids)
    const stsd = fullBox('stsd', 0, 0, new W(4).u32(1).out(), avc1)

    const stts = fullBox('stts', 0, 0, new W(12).u32(1).u32(N).u32(DELTA).out())
    let ctts = null
    if (reorder) {
      const runs = []
      for (let i = 0; i < N; i++) {
        const off = pts[i] + shift - i * DELTA
        if (runs.length && runs[runs.length - 1][1] === off) runs[runs.length - 1][0]++
        else runs.push([1, off])
      }
      const w = new W(4 + runs.length * 8).u32(runs.length)
      for (const [c, v] of runs) w.u32(c).u32(v)
      ctts = fullBox('ctts', 0, 0, w.out())
    }
    const keyIdx = []
    for (let i = 0; i < N; i++) if (keys[i]) keyIdx.push(i + 1)
    const stss = keyIdx.length === N ? null : (() => { const w = new W(4 + keyIdx.length * 4).u32(keyIdx.length); for (const k of keyIdx) w.u32(k); return fullBox('stss', 0, 0, w.out()) })()
    const stsc = fullBox('stsc', 0, 0, new W(16).u32(1).u32(1).u32(1).u32(1).out())   // 一帧一块：块偏移即样本偏移
    const stsz = (() => { const w = new W(8 + N * 4).u32(0).u32(N); for (const s of sizes) w.u32(s); return fullBox('stsz', 0, 0, w.out()) })()
    const stco = big
      ? (() => { const w = new W(4 + N * 8).u32(N); for (const x of offsets) w.u64(x); return fullBox('co64', 0, 0, w.out()) })()
      : (() => { const w = new W(4 + N * 4).u32(N); for (const x of offsets) w.u32(x); return fullBox('stco', 0, 0, w.out()) })()
    const stbl = box('stbl', ...[stsd, stts, ctts, stss, stsc, stsz, stco].filter(Boolean))
    const minf = box('minf', vmhd, dinf, stbl)
    const mdia = box('mdia', mdhd, hdlr, minf)
    const trak = box('trak', ...[tkhd, edts, mdia].filter(Boolean))
    return { moov: box('moov', mvhd, trak), durationSec: mediaDur / TS }
  }

  async function finalize() {
    if (closed) throw new Error('muxer 已结束')
    closed = true
    flushBuf()
    if (!sizes.length) throw new Error('没有任何帧')
    if (!desc) throw new Error('编码器没有给出解码配置（avcC）')
    const mdatSize = pos - mdatAt
    sinkWrite(new W(8).u64(mdatSize).out(), mdatAt + 8)
    const { moov, durationSec } = buildMoov()
    let faststart = false, total = pos
    if (reserve && moov.length + 8 <= reserve) {
      // moov 进预留区，余下的记成一个 free（至少 8 字节：上界留足了 8）
      sinkWrite(moov, freeAt)
      const rest = reserve - moov.length
      sinkWrite(new W(8).u32(rest).str('free').out(), freeAt + moov.length)
      faststart = true
    } else {
      sinkWrite(moov, pos)
      total = pos + moov.length
    }
    await chain
    if (failed) throw failed
    return { bytes: total, frames: sizes.length, keyFrames: keys.filter(Boolean).length, durationSec, faststart }
  }
  /** 中途放弃：停止收样本，等已发出的写完（调用方随后删文件） */
  async function abort() { closed = true; bufN = 0; try { await chain } catch { /* 已失败就算了 */ } }

  return { addChunk, finalize, abort, drain, pending, timescale: TS, delta: DELTA, get frames() { return sizes.length }, get bytes() { return pos } }
}

// —— 回读（测试与自检用）：遍历顶层 / 嵌套 box ——
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts'])
export function parseBoxes(u8, start = 0, end = u8.length, depth = 0) {
  const out = []
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  let p = start
  while (p + 8 <= end) {
    let size = dv.getUint32(p)
    const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7])
    let hdr = 8
    if (size === 1) { size = dv.getUint32(p + 8) * 4294967296 + dv.getUint32(p + 12); hdr = 16 }
    else if (size === 0) size = end - p
    if (size < hdr || p + size > end) { out.push({ type, at: p, size, bad: true }); break }
    const b = { type, at: p, size, hdr }
    if (CONTAINERS.has(type)) b.kids = parseBoxes(u8, p + hdr, p + size, depth + 1)
    else if (type === 'stsd') b.kids = parseBoxes(u8, p + hdr + 8, p + size, depth + 1)
    else if (type === 'avc1') b.kids = parseBoxes(u8, p + hdr + 78, p + size, depth + 1)
    out.push(b)
    p += size
  }
  return out
}
