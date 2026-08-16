// UI 语言运行时 —— 界面级中→英翻译（设置里的「语言」）。
//
// 思路：源码与程序状态一律保持中文（键、v-model 值、IPC、存档全不动），只在 DOM 呈现层
// 把文本节点 / title·placeholder 等属性 / canvas fillText 换成英文。中文模式下不装观察器、
// 不加载字典，行为与引入本模块前逐字节一致；英文模式的译文查不到时原样保留中文。
//
// 字典约定沿用 lbDocI18n.js：以中文原文为键、未命中原样返回。词条分两类：
//   EXACT —— 整串精确匹配（去首尾空白、内部空白折叠后查表）
//   PAT   —— 带 ${…}/{{…}} 插值槽位的模板，编译成锚定正则，槽位内容原样搬进译文
// 字典体量大（数千条），做成动态 import：中文用户永不解析。
//
// 跨窗口联动与 stores/theme.js 同一机制：localStorage + storage 事件，十个窗口入口各
// import 一次本模块即可。切换语言当场重走全文档（英文化 / 还原原文），canvas 在下次重绘时跟上。

import { LANG_KEY as KEY, curLang as read } from './lang.js'

const HAN = /[一-鿿]/

let lang = read()
let dict = null            // { EXACT: Object, PAT: [zhTpl, enTpl][] }
let dictLoading = null
let patIndex = null        // 前两字 → 编译后模式列表；首槽位模式进 generic
let observer = null
const memo = new Map()     // 整串 → 译文（含模式命中缓存；数值变动会产生新串，封顶防涨）
const MEMO_CAP = 4096
const textOrig = new WeakMap()   // Text → 原文（还原用）
const attrOrig = new WeakMap()   // Element → { attr: 原文 }
// 我们自己写进去的值。观察器收得到自己造成的 characterData / attributes 变更，若不认出来
// 就会把译文当新原文再翻一遍（「点标记 / 地球站」二次加工成「Point 标记 / / 航迹 earth
// stations」那类残骸），故写入前记一笔，再看到同一个值直接跳过。
const textApplied = new WeakMap()  // Text → 已写入值
const attrApplied = new WeakMap()  // Element → { attr: 已写入值 }
const ATTRS = ['title', 'placeholder', 'aria-label', 'alt']
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'PRE', 'CODE'])
const misses = new Set()   // 未命中词条（调试：window.__i18nMisses）

// ---- 模式编译：('共 ${n} 个', 'Total ${n}') → { re: /^共 ([\s\S]*?) 个$/, enLits: ['Total ', ''] } ----
const SLOT_RE = /\$\{[^}]*\}|\{\{[^}]*\}\}/g
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
// 组合分隔符：运行时把几段话拼一起用的那几个记号。收尾的开放槽位不许跨过它们——
// 否则 `自定义星历 ${c}` 会把「自定义星历 0 · 编目星座 0」整条吃下（后半截再没机会查表）。
const SEPS = [' · ', ' / ', ' → ', '——', '；', '。', '：']
const TAIL = '((?:(?!' + SEPS.map(esc).join('|') + ')[\\s\\S])*?)'
function compilePat(zh, en) {
  const zhLits = zh.split(SLOT_RE)
  const enLits = en.split(SLOT_RE)
  if (zhLits.length !== enLits.length || zhLits.length < 2) return null
  // 槽位统一吃「非空且不吞相邻文字」的最短串；两端槽位允许空。
  // 末尾那个槽位（模式以槽位收尾时）另用 TAIL：贪到分隔符为止，把后面的段落留给下一轮。
  // ★ 只对「有汉字字面量」的内容模式设这道限制。策展的组合模式（`${a}：${b}` 一类）字面量
  //   纯是标点，它们的职责恰恰是跨过分隔符逐层剥——给它们套 TAIL 会让它们一条都匹配不上。
  const openTail = zhLits[zhLits.length - 1] === '' && zhLits.some((l) => HAN.test(l))
  const body = zhLits.map(esc).reduce((acc, lit, i) => {
    if (i === 0) return lit
    const last = i === zhLits.length - 1
    return acc + (last && openTail ? TAIL : '([\\s\\S]*?)') + lit
  }, '')
  return { re: new RegExp('^' + body + '$'), enLits, key: (zhLits[0] || '').slice(0, 2) }
}
function buildPatIndex() {
  patIndex = { buckets: new Map(), generic: [] }
  for (const [zh, en] of dict.PAT) {
    const p = compilePat(zh, en)
    if (!p) continue
    // 首字面量满两字才可按前缀分桶；更短的（含首槽位）走 generic 全试
    if (p.key.length === 2) {
      const list = patIndex.buckets.get(p.key) || []
      list.push(p); patIndex.buckets.set(p.key, list)
    } else patIndex.generic.push(p)
  }
}

function translate(s, depth = 0) {
  const hit = dict.EXACT[s]
  if (hit !== undefined) return hit
  const m = memo.get(s)
  if (m !== undefined) return m
  let out = s
  const cands = (patIndex.buckets.get(s.slice(0, 2)) || []).concat(patIndex.generic)
  for (const p of cands) {
    const mt = p.re.exec(s)
    if (!mt) continue
    let acc = p.enLits[0]
    for (let i = 1; i < p.enLits.length; i++) {
      // 捕获组递归：槽位里插的常是另一条词条（「3 个地球站」的「地球站」），整串模式只
      // 管外壳，里子得自己再查一次，否则译文里剩个中文岛。运行时拼接的串能嵌很多层——
      // 「句。句；名：项 · 项 · 项 · 项」（PFD 那条「本机可取…」）光 · 链就要四层，句号、
      // 分号、冒号各再占一层。给到 8 层管够：每层至少被一个字面量字符吃掉，必然收敛。
      const g = mt[i]
      acc += (depth < 8 && HAN.test(g) ? translate(g, depth + 1) : g) + p.enLits[i]
    }
    out = acc
    break
  }
  if (out === s) misses.add(s)
  if (depth > 0) return out          // 递归层不进缓存：同一片段在不同外壳里可能取不同分支
  if (memo.size >= MEMO_CAP) memo.clear()
  memo.set(s, out)
  return out
}

// 供业务侧显式取译文（canvas 补丁等），中文模式恒等返回
export function t(s) {
  if (lang !== 'en' || !dict || typeof s !== 'string' || !HAN.test(s)) return s
  const key = s.replace(/\s+/g, ' ').trim()
  if (!key) return s
  const en = translate(key)
  return en === key ? s : en
}

// ---- 文本节点 ----
function inSkip(el) {
  for (let e = el; e; e = e.parentElement) {
    if (SKIP_TAGS.has(e.tagName) || e.hasAttribute?.('data-i18n-skip')) return true
  }
  return false
}
function doTextNode(node) {
  const raw = node.data
  if (textApplied.get(node) === raw) return    // 这一版就是我们自己写的，别再翻一遍
  if (!HAN.test(raw)) return
  const p = node.parentElement
  if (!p || inSkip(p)) return
  const lead = raw.match(/^\s*/)[0]
  const trail = raw.match(/\s*$/)[0]
  const key = raw.replace(/\s+/g, ' ').trim()
  if (!key) return
  const en = translate(key)
  if (en === key) return
  // 裸 <option>：value 缺省取显示文本，先把原文钉进 value 再翻，v-model 语义不变
  if (p.tagName === 'OPTION' && !p.hasAttribute('value') && p._value === undefined) {
    p.setAttribute('value', p.textContent.trim())
  }
  // raw 含汉字 ⇒ 必是（Vue 刚写入的）中文原文，无条件刷新快照，键控重排也不会还原到旧值
  textOrig.set(node, raw)
  const next = lead + en + trail
  textApplied.set(node, next)
  node.data = next
}
function doAttrs(el) {
  const done = attrApplied.get(el)
  for (const a of ATTRS) {
    const raw = el.getAttribute?.(a)
    if (!raw || !HAN.test(raw)) continue
    if (done && done[a] === raw) continue       // 自写入，跳过
    const key = raw.replace(/\s+/g, ' ').trim()
    const en = translate(key)
    if (en === key) continue
    let bag = attrOrig.get(el)
    if (!bag) { bag = {}; attrOrig.set(el, bag) }
    bag[a] = raw
    let app = attrApplied.get(el)
    if (!app) { app = {}; attrApplied.set(el, app) }
    app[a] = en
    el.setAttribute(a, en)
  }
}

function walkApply(root) {
  if (root.nodeType === Node.TEXT_NODE) { doTextNode(root); return }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return
  if (root.nodeType === Node.ELEMENT_NODE) {
    if (SKIP_TAGS.has(root.tagName) || root.hasAttribute('data-i18n-skip')) return
    doAttrs(root)
  }
  for (let c = root.firstChild; c; c = c.nextSibling) walkApply(c)
}

function walkRestore(root) {
  if (root.nodeType === Node.TEXT_NODE) {
    const orig = textOrig.get(root)
    if (orig !== undefined) { root.data = orig; textOrig.delete(root) }
    return
  }
  if (root.nodeType === Node.ELEMENT_NODE) {
    const bag = attrOrig.get(root)
    if (bag) { for (const a in bag) root.setAttribute(a, bag[a]); attrOrig.delete(root) }
  }
  for (let c = root.firstChild; c; c = c.nextSibling) walkRestore(c)
}

// ---- 观察器 ----
function onMutations(muts) {
  if (lang !== 'en' || !dict) return
  for (const m of muts) {
    if (m.type === 'characterData') doTextNode(m.target)
    else if (m.type === 'attributes') { if (!inSkip(m.target)) doAttrs(m.target) }
    else if (m.type === 'childList') for (const n of m.addedNodes) walkApply(n)
  }
}
function ensureObserver() {
  if (observer) return
  observer = new MutationObserver(onMutations)
  observer.observe(document.documentElement, {
    subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ATTRS
  })
}

// ---- canvas 补丁：地图/图表/3D 精灵画的中文标注跟着走（逐字形绘制不碰：串长≥2 才查）----
let canvasPatched = false
function patchCanvas() {
  if (canvasPatched || typeof CanvasRenderingContext2D === 'undefined') return
  canvasPatched = true
  const proto = CanvasRenderingContext2D.prototype
  // ctx.__i18nSkip = true 的上下文不翻（交付文档区的画布由「报表语言」自管，如 3D 链路视图精灵）
  const tc = (ctx, s) => (ctx.__i18nSkip || typeof s !== 'string' || s.length < 2 ? s : t(s))
  for (const m of ['fillText', 'strokeText']) {
    const orig = proto[m]
    proto[m] = function (text, ...rest) { return orig.call(this, tc(this, text), ...rest) }
  }
  const origMeasure = proto.measureText
  proto.measureText = function (text) { return origMeasure.call(this, tc(this, text)) }
}

// ---- 装载与切换 ----
function loadDict() {
  if (dict) return Promise.resolve()
  if (!dictLoading) {
    dictLoading = import('./uiDict.data.js').then((m) => {
      dict = { EXACT: m.EXACT, PAT: m.PAT }
      buildPatIndex()
    })
  }
  return dictLoading
}

function activateEn() {
  patchCanvas()
  ensureObserver()
  loadDict().then(() => {
    if (lang !== 'en') return
    memo.clear()
    walkApply(document.documentElement)
    document.documentElement.lang = 'en'
  })
}
function deactivateEn() {
  if (observer) { observer.disconnect(); observer = null }
  walkRestore(document.documentElement)
  document.documentElement.lang = 'zh-CN'
}

// 语言变更订阅（不引 Vue，保持本模块框架无关）。链路预算三窗的「报表语言」靠它跟随平台语言：
// 详细预算区与导出的语汇由 lbDocI18n / WF_DICT 出，换语言要重取一次瀑布数据，故需要通知。
const langListeners = new Set()
export function onLangChange(fn) { langListeners.add(fn); return () => langListeners.delete(fn) }
function emitLang() { for (const fn of langListeners) { try { fn(lang) } catch { /* 单个订阅者出错不连累其余 */ } } }

export function getLang() { return lang }
export function setLang(next) {
  next = next === 'en' ? 'en' : 'zh'
  if (next === lang) return
  lang = next
  try { localStorage.setItem(KEY, next) } catch { /* ignore */ }
  if (next === 'en') activateEn()
  else deactivateEn()
  emitLang()
}

// 多窗口联动：任一窗口切语言，其余窗口经 storage 事件跟随
window.addEventListener('storage', (e) => {
  if (e.key !== KEY) return
  const v = read()
  if (v === lang) return
  lang = v
  if (v === 'en') activateEn()
  else deactivateEn()
  emitLang()
})

if (typeof window !== 'undefined') {
  window.__i18nMisses = misses
  if (lang === 'en') activateEn()
}
