// 外部文本文件的编码识别与编码写出（纯 CommonJS，主进程 / Node 测试通用；渲染端经 IPC 交给主进程，不直接用）。
//
// 【为什么要有这一层】星历导入原先一律 fs.readFileSync(fp, 'utf8')。国内测控 / 运控软件（中国卫通 .eph 等）
//   出的文件是 Windows 简体中文系统的 ANSI 代码页（CP936 = GBK）：按 UTF-8 读，表头里的「地固坐标系瞬根」
//   就成了一串 U+FFFD，帧信息当场丢失。数据行是纯 ASCII，读得出来——所以这种错不报错、只会静默丢帧。
//
// 【判据顺序】BOM（UTF-8 / UTF-16LE / UTF-16BE）→ 严格 UTF-8（fatal 解码不抛）→ GB18030（GBK 的超集）。
//   纯 ASCII 恒为合法 UTF-8，走第二档；含中文的 GBK 文本几乎不可能恰好是合法 UTF-8（GBK 双字节的
//   首字节 0x81–0xFE、次字节 0x40–0xFE，与 UTF-8 的续字节 0x80–0xBF 规则冲突），故第二、三档不会互相误判。
//
// 【GBK 写出】TextEncoder 只会 UTF-8。反查表由 TextDecoder('gbk') 现推：逐个解出全部双字节码位（约 2.4 万个），
//   字符 → 字节对，首次用到时建一次（~20 ms），之后常驻。表外字符写成 '?'。这样不引第三方依赖，且编码与解码
//   出自同一张 WHATWG 编码表，回环天然一致。

'use strict'

const toU8 = (input) => {
  if (input == null) return new Uint8Array(0)
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  if (Array.isArray(input)) return Uint8Array.from(input)
  return null
}

const hasDecoder = (label) => { try { new TextDecoder(label); return true } catch { return false } }

/**
 * 字节 → 文本。返回 { text, encoding, bom }：encoding ∈ 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030' | 'latin1'。
 * 已经是字符串的原样返回（encoding 记 'text'），方便调用方不分支。
 */
function decodeText(input) {
  if (typeof input === 'string') return { text: input.replace(/^﻿/, ''), encoding: 'text', bom: /^﻿/.test(input) }
  const u8 = toU8(input)
  if (!u8) return { text: String(input), encoding: 'text', bom: false }
  if (u8.length >= 3 && u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) {
    return { text: new TextDecoder('utf-8').decode(u8.subarray(3)), encoding: 'utf-8', bom: true }
  }
  if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xFE) return { text: new TextDecoder('utf-16le').decode(u8.subarray(2)), encoding: 'utf-16le', bom: true }
  if (u8.length >= 2 && u8[0] === 0xFE && u8[1] === 0xFF) return { text: new TextDecoder('utf-16be').decode(u8.subarray(2)), encoding: 'utf-16be', bom: true }
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(u8), encoding: 'utf-8', bom: false } } catch { /* 不是 UTF-8：往下 */ }
  if (hasDecoder('gb18030')) return { text: new TextDecoder('gb18030').decode(u8), encoding: 'gb18030', bom: false }
  // 运行时没有中文码表（small-icu 的 Node）：逐字节 latin1，至少 ASCII 数据行不丢
  let s = ''
  for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 8192)))
  return { text: s, encoding: 'latin1', bom: false }
}

/* ===================== GBK 写出 ===================== */
let _gbk = null   // Map<codePoint, 双字节 (lead<<8)|trail>
function gbkTable() {
  if (_gbk) return _gbk
  const map = new Map()
  if (!hasDecoder('gbk')) { _gbk = map; return map }
  // 每个字节对后接一个 \n：WHATWG 解码器遇到非法次字节（落在 ASCII 段）会先吐 U+FFFD 再按 ASCII 重放，
  // 单靠「两字节一字」切分会错位；\n 恒为 ASCII，按它切就永远对齐，切出来不是恰好一个字符的就是非法对。
  const pairs = []
  for (let lead = 0x81; lead <= 0xFE; lead++) for (let trail = 0x40; trail <= 0xFE; trail++) { if (trail !== 0x7F) pairs.push((lead << 8) | trail) }
  const buf = new Uint8Array(pairs.length * 3)
  for (let i = 0; i < pairs.length; i++) { buf[3 * i] = pairs[i] >> 8; buf[3 * i + 1] = pairs[i] & 0xFF; buf[3 * i + 2] = 0x0A }
  const parts = new TextDecoder('gbk').decode(buf).split('\n')
  for (let i = 0; i < pairs.length; i++) {
    const ch = parts[i]
    if (!ch || ch === '�') continue
    const cps = Array.from(ch)
    if (cps.length !== 1) continue
    const cp = cps[0].codePointAt(0)
    if (cp < 0x80) continue
    if (!map.has(cp)) map.set(cp, pairs[i])
  }
  // CP936 单字节 0x80 = 欧元符（WHATWG gbk 解码同此）
  if (!map.has(0x20AC)) map.set(0x20AC, -0x80)
  _gbk = map
  return map
}
/** 字符串 → GBK 字节（ASCII 原样；表外字符写 '?'）。返回 { bytes, unmapped }：unmapped = 写成 '?' 的字符数。 */
function encodeGbk(str) {
  const s = String(str == null ? '' : str)
  const tab = gbkTable()
  const out = new Uint8Array(s.length * 2)
  let n = 0, miss = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0)
    if (cp < 0x80) { out[n++] = cp; continue }
    const code = tab.get(cp)
    if (code == null) { out[n++] = 0x3F; miss++; continue }
    if (code < 0) { out[n++] = -code; continue }
    out[n++] = code >> 8; out[n++] = code & 0xFF
  }
  return { bytes: out.slice(0, n), unmapped: miss }
}
/** GBK 下的显示宽度（ASCII 1、其余 2）—— 定长表头按字节对齐要用它 */
function gbkWidth(str) {
  let w = 0
  for (const ch of String(str == null ? '' : str)) w += ch.codePointAt(0) < 0x80 ? 1 : 2
  return w
}

/** 文本 → 指定编码的字节。encoding：'utf-8'（缺省）| 'gbk' | 'gb18030' | 'latin1' */
function encodeText(str, encoding) {
  const e = String(encoding || 'utf-8').toLowerCase()
  if (e === 'gbk' || e === 'gb2312' || e === 'gb18030' || e === 'cp936') return encodeGbk(str).bytes
  if (e === 'latin1' || e === 'iso-8859-1') {
    const s = String(str == null ? '' : str), u = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xFF
    return u
  }
  return new TextEncoder().encode(String(str == null ? '' : str))
}

module.exports = { decodeText, encodeGbk, encodeText, gbkWidth, hasDecoder }
