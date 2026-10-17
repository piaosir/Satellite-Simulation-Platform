// 极简 XML DOM（纯 JS、无依赖）：可编程导入的沙箱跑在 Worker 里，Worker 没有 DOMParser。
//
// 只实现脚本解析常用的那一小片 DOM，接口名与浏览器一致（会用 DOM 的人不必另学）：
//   Document / Element：documentElement、childNodes、children、firstElementChild、parentNode、nodeType、
//     tagName、nodeName、localName、prefix、attributes（{ 名: 值 }）、getAttribute、hasAttribute、textContent、
//     getElementsByTagName(名)（'*' = 全部；按 tagName 精确匹配）、getElementsByTagNameNS(ns, 本地名)（ns 只认 '*'）
//   Text：nodeType 3、nodeValue / textContent（CDATA 并入文本）
// 另有 MiniDOMParser.parseFromString(text)：语法错时与浏览器一样返回一份根为 <parsererror> 的文档（kml/parse.js 靠它判错）。
// 不做：命名空间解析（前缀照原样留在 tagName 里，localName 去掉前缀）、DTD 实体、样式表、写回。

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
function decodeEnt(s) {
  if (s.indexOf('&') < 0) return s
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m
    }
    return ENT[e] != null ? ENT[e] : m
  })
}

class XText {
  constructor(v, parent) { this.nodeType = 3; this.nodeName = '#text'; this.nodeValue = v; this.parentNode = parent }
  get textContent() { return this.nodeValue }
}
function collectByName(el, test, out) {
  for (const c of el.childNodes) {
    if (c.nodeType !== 1) continue
    if (test(c)) out.push(c)
    collectByName(c, test, out)
  }
  return out
}
class XElement {
  constructor(tag, parent) {
    this.nodeType = 1
    this.tagName = tag
    this.nodeName = tag
    const i = tag.indexOf(':')
    this.prefix = i > 0 ? tag.slice(0, i) : null
    this.localName = i > 0 ? tag.slice(i + 1) : tag
    this.attributes = {}
    this.childNodes = []
    this.parentNode = parent || null
  }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1) }
  get firstElementChild() { return this.childNodes.find((n) => n.nodeType === 1) || null }
  get textContent() {
    let s = ''
    const walk = (n) => { for (const c of n.childNodes) { if (c.nodeType === 3) s += c.nodeValue; else if (c.nodeType === 1) walk(c) } }
    walk(this)
    return s
  }
  getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attributes, n) ? this.attributes[n] : null }
  hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attributes, n) }
  getElementsByTagName(name) { return collectByName(this, name === '*' ? () => true : (c) => c.tagName === name, []) }
  getElementsByTagNameNS(ns, name) { return collectByName(this, name === '*' ? () => true : (c) => c.localName === name, []) }
}
class XDocument {
  constructor() { this.nodeType = 9; this.nodeName = '#document'; this.childNodes = []; this.parentNode = null }
  get documentElement() { return this.childNodes.find((n) => n.nodeType === 1) || null }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1) }
  get textContent() { return null }
  getElementsByTagName(name) { return XElement.prototype.getElementsByTagName.call(this, name) }
  getElementsByTagNameNS(ns, name) { return XElement.prototype.getElementsByTagNameNS.call(this, ns, name) }
}

const NAME = /[A-Za-z_:À-￿][\w.:\-·À-￿]*/y
/** 文本 → XDocument；语法错抛 Error（带行号） */
export function parseXml(text) {
  const s = String(text == null ? '' : text).replace(/^﻿/, '')
  const doc = new XDocument()
  let cur = doc
  let i = 0
  const n = s.length
  const lineAt = (p) => s.slice(0, p).split('\n').length
  const err = (msg, p) => { throw new Error(`XML: ${msg} (line ${lineAt(p)})`) }
  while (i < n) {
    const lt = s.indexOf('<', i)
    if (lt < 0) { addText(s.slice(i)); break }
    if (lt > i) addText(s.slice(i, lt))
    i = lt
    if (s.startsWith('<!--', i)) { const e = s.indexOf('-->', i + 4); if (e < 0) err('unterminated comment', i); i = e + 3; continue }
    if (s.startsWith('<![CDATA[', i)) {
      const e = s.indexOf(']]>', i + 9); if (e < 0) err('unterminated CDATA', i)
      if (cur !== doc) cur.childNodes.push(new XText(s.slice(i + 9, e), cur))
      i = e + 3; continue
    }
    if (s.startsWith('<?', i)) { const e = s.indexOf('?>', i + 2); if (e < 0) err('unterminated processing instruction', i); i = e + 2; continue }
    if (s.startsWith('<!', i)) {
      // DOCTYPE（可能带内部子集 [...]）
      let depth = 0, j = i + 2
      for (; j < n; j++) { const ch = s[j]; if (ch === '[') depth++; else if (ch === ']') depth--; else if (ch === '>' && depth <= 0) break }
      if (j >= n) err('unterminated declaration', i)
      i = j + 1; continue
    }
    if (s[i + 1] === '/') {
      const e = s.indexOf('>', i + 2); if (e < 0) err('unterminated end tag', i)
      const tag = s.slice(i + 2, e).trim()
      if (cur === doc || cur.tagName !== tag) err(`mismatched end tag </${tag}>`, i)
      cur = cur.parentNode
      i = e + 1; continue
    }
    NAME.lastIndex = i + 1
    const m = NAME.exec(s)
    if (!m) err('invalid tag name', i)
    const el = new XElement(m[0], cur === doc ? doc : cur)
    let j = NAME.lastIndex
    for (;;) {
      while (j < n && /\s/.test(s[j])) j++
      if (j >= n) err('unterminated start tag', i)
      if (s[j] === '>') { j++; break }
      if (s[j] === '/' && s[j + 1] === '>') { j += 2; el._selfClose = true; break }
      NAME.lastIndex = j
      const a = NAME.exec(s)
      if (!a) err('invalid attribute', j)
      j = NAME.lastIndex
      while (j < n && /\s/.test(s[j])) j++
      let val = ''
      if (s[j] === '=') {
        j++
        while (j < n && /\s/.test(s[j])) j++
        const q = s[j]
        if (q !== '"' && q !== "'") err('attribute value must be quoted', j)
        const e = s.indexOf(q, j + 1); if (e < 0) err('unterminated attribute value', j)
        val = decodeEnt(s.slice(j + 1, e)); j = e + 1
      }
      el.attributes[a[0]] = val
    }
    if (cur === doc && doc.documentElement) err('multiple root elements', i)
    cur.childNodes.push(el)
    if (!el._selfClose) cur = el
    delete el._selfClose
    i = j
  }
  if (cur !== doc) err(`unclosed element <${cur.tagName}>`, n)
  if (!doc.documentElement) err('no root element', 0)
  return doc

  function addText(t) {
    if (cur === doc) { if (t.trim()) err('text outside root element', i); return }
    cur.childNodes.push(new XText(decodeEnt(t), cur))
  }
}

/** 浏览器 DOMParser 的替身：语法错返回根为 <parsererror> 的文档（不抛） */
export class MiniDOMParser {
  parseFromString(text) {
    try { return parseXml(text) }
    catch (e) {
      const doc = new XDocument()
      const pe = new XElement('parsererror', doc)
      pe.childNodes.push(new XText(String(e.message || e), pe))
      doc.childNodes.push(pe)
      return doc
    }
  }
}
