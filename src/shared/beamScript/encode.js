// 可编程波束地图 · 输出文件的文本编码（渲染端 / Worker / Node 测试通用的纯 ESM，零依赖）。
//
// 脚本用 file(name, text, { encoding, eol }) 声明「这份文本按什么字节落盘」，这里负责把文本变成字节：
//   utf-8       缺省
//   utf-8-bom   带 EF BB BF —— Excel 直接双击打开含中文的 CSV 必须带它，否则按 ANSI 读成乱码
//   gbk         Windows 简体中文 ANSI 代码页（CP936）—— 国内老软件（MapInfo 中文版等）只认它
//   latin1      逐字符一个字节（GXT 原文的口径；> U+00FF 的字符写成 '?'）
//   utf-16le    带 FF FE
// GBK 写出与 packages/core/utils/textCodec.js 同一算法：反查表由 TextDecoder('gbk') 现推（同一张 WHATWG 编码表，
// 回环天然一致），首次用到时建一次（约 20 ms）后常驻；表外字符写成 '?'。那份是 CommonJS（主进程用），
// 渲染端没有 import CJS 的先例，故原样移植一份；两边改算法要一起改。

export const ENCODINGS = ['utf-8', 'utf-8-bom', 'gbk', 'latin1', 'utf-16le']

const ALIAS = {
  'utf-8': 'utf-8', utf8: 'utf-8',
  'utf-8-bom': 'utf-8-bom', 'utf8-bom': 'utf-8-bom', utf8bom: 'utf-8-bom', 'utf-8-sig': 'utf-8-bom', 'utf8-sig': 'utf-8-bom',
  gbk: 'gbk', gb2312: 'gbk', gb18030: 'gbk', cp936: 'gbk', ansi: 'gbk',
  latin1: 'latin1', 'iso-8859-1': 'latin1', 'latin-1': 'latin1',
  'utf-16le': 'utf-16le', utf16le: 'utf-16le', 'utf-16': 'utf-16le', ucs2: 'utf-16le'
}
/** 编码名归一；认不出返回 null（由调用方报错，不静默落成 UTF-8） */
export function normEncoding(e) {
  if (e == null || e === '') return 'utf-8'
  return ALIAS[String(e).trim().toLowerCase()] || null
}

/** 换行归一：'crlf' | 'lf'；其他值原样不动 */
export function applyEol(text, eol) {
  const s = String(text)
  if (eol === 'crlf') return s.replace(/\r\n|\r|\n/g, '\r\n')
  if (eol === 'lf') return s.replace(/\r\n|\r/g, '\n')
  return s
}

/* ===================== GBK 写出 ===================== */
let _gbk = null   // Map<codePoint, 双字节 (lead<<8)|trail>；单字节欧元符记为 -0x80
function hasDecoder(label) { try { new TextDecoder(label); return true } catch { return false } }
function gbkTable() {
  if (_gbk) return _gbk
  const map = new Map()
  if (!hasDecoder('gbk')) { _gbk = map; return map }
  // 每个字节对后接一个 \n：WHATWG 解码器遇到非法次字节（落在 ASCII 段）会先吐 U+FFFD 再按 ASCII 重放，
  // 单靠「两字节一字」切分会错位；\n 恒为 ASCII，按它切就永远对齐。
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
  if (!map.has(0x20AC)) map.set(0x20AC, -0x80)   // CP936 单字节 0x80 = 欧元符（WHATWG gbk 解码同此）
  _gbk = map
  return map
}
function encodeGbk(s) {
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

/**
 * 文本 → 字节。返回 { bytes, unmapped }：unmapped = 目标编码表达不了、写成 '?' 的字符数（UTF 系恒为 0）。
 * encoding 须已归一（normEncoding）。
 */
export function encodeText(text, encoding) {
  const s = String(text == null ? '' : text)
  switch (encoding) {
    case 'utf-8-bom': {
      const body = new TextEncoder().encode(s)
      const out = new Uint8Array(body.length + 3)
      out[0] = 0xEF; out[1] = 0xBB; out[2] = 0xBF; out.set(body, 3)
      return { bytes: out, unmapped: 0 }
    }
    case 'gbk': return encodeGbk(s)
    case 'latin1': {
      const out = new Uint8Array(s.length)
      let miss = 0
      for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c > 0xFF) { out[i] = 0x3F; miss++ } else out[i] = c }
      return { bytes: out, unmapped: miss }
    }
    case 'utf-16le': {
      const out = new Uint8Array(2 + s.length * 2)
      out[0] = 0xFF; out[1] = 0xFE
      for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out[2 + 2 * i] = c & 0xFF; out[3 + 2 * i] = c >> 8 }
      return { bytes: out, unmapped: 0 }
    }
    default: return { bytes: new TextEncoder().encode(s), unmapped: 0 }
  }
}
