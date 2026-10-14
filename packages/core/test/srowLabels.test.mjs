// 参数行 .srow 的「标签 + 控件」程序化关联（src/shared/ui/srowLabelsCore.js）：
//   ① 文本框 / 下拉 → for + 控件 id；数字框 / 滑杆 / 取色 / 复选 → aria-labelledby + 标签 id（点标签不激活控件）
//   ② 不处理：非 .srow 直接子级、包裹式 label（.chk-in）、页面自写 for、控件已有 id / aria-*、隐藏输入、隔着下一个 label
//   ③ 同一行两对、v-if 换掉控件后重配、幂等
// 运行：npm test -- srowLabels
import assert from 'node:assert'
import { srowLabelTarget, pairSrowLabel, linkMode, FOR_PREFIX, LBL_PREFIX } from '../../../src/shared/ui/srowLabelsCore.js'

let pass = 0
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); pass++ }

// —— 最小假 DOM：只实现本模块用到的那几样 ——
class El {
  constructor(tag, attrs = {}, kids = []) {
    this.tagName = tag.toUpperCase()
    this.attrs = {}
    this.children = []
    this.parentElement = null
    for (const k in attrs) this.setAttribute(k, attrs[k])
    for (const k of kids) this.append(k)
    const self = this
    this.classList = { contains: (c) => (self.attrs.class || '').split(/\s+/).includes(c) }
  }
  append(k) { k.parentElement = this; this.children.push(k); return this }
  replace(old, nu) { const i = this.children.indexOf(old); nu.parentElement = this; this.children[i] = nu; old.parentElement = null }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  removeAttribute(k) { delete this.attrs[k] }
  get id() { return this.attrs.id || '' }
  set id(v) { this.attrs.id = v }
  get type() { return this.attrs.type || (this.tagName === 'INPUT' ? 'text' : '') }
  get nextElementSibling() { const p = this.parentElement; if (!p) return null; const i = p.children.indexOf(this); return p.children[i + 1] || null }
  querySelector(sel) {
    const tags = sel.split(',').map((s) => s.trim().toUpperCase())
    const walk = (e) => { for (const c of e.children) { if (tags.includes(c.tagName)) return c; const r = walk(c); if (r) return r } return null }
    return walk(this)
  }
}
const h = (tag, attrs, kids) => new El(tag, attrs, kids)
let n = 0
const nextId = (p) => p + (++n)
const row = (...kids) => h('div', { class: 'srow' }, kids)

// ① 文本框 → for
{
  const lab = h('label'); const inp = h('input'); row(lab, inp)
  const r = pairSrowLabel(lab, nextId)
  eq(r && r.mode, 'for', '文本框走 for')
  eq(inp.id.startsWith(FOR_PREFIX), true, '控件得 id')
  eq(lab.getAttribute('for'), inp.id, '标签 for 指向控件')
  eq(pairSrowLabel(lab, nextId), null, '幂等：配过不再动')
}
{
  const lab = h('label'); const sel = h('select'); row(lab, sel)
  eq(pairSrowLabel(lab, nextId).mode, 'for', '下拉走 for')
  const lab2 = h('label'); const ta = h('textarea'); row(lab2, ta)
  eq(pairSrowLabel(lab2, nextId).mode, 'for', '多行框走 for')
}
// 数字框 / 滑杆 / 取色 / 复选 → aria-labelledby
for (const type of ['number', 'range', 'color', 'checkbox', 'radio', 'file']) {
  const lab = h('label'); const inp = h('input', { type }); row(lab, inp)
  const r = pairSrowLabel(lab, nextId)
  eq(r && r.mode, 'labelledby', type + ' 走 aria-labelledby')
  eq(lab.id.startsWith(LBL_PREFIX), true, type + '：标签得 id')
  eq(inp.getAttribute('aria-labelledby'), lab.id, type + '：控件指向标签')
  eq(lab.getAttribute('for'), null, type + '：标签不加 for（点标签不激活控件 / 不抢横拖）')
  eq(inp.id, '', type + '：控件不加 id')
}
eq(linkMode(h('input', { type: 'NUMBER' })), 'labelledby', 'type 大小写不敏感')
eq(linkMode(h('input', { type: 'datetime-local' })), 'for', '日期时间框走 for')
// 标签已有 id：沿用
{
  const lab = h('label', { id: 'mine' }); const inp = h('input', { type: 'number' }); row(lab, inp)
  pairSrowLabel(lab, nextId)
  eq(inp.getAttribute('aria-labelledby'), 'mine', '沿用标签已有 id')
}

// ② 不处理的情形
{
  const lab = h('label'); const inp = h('input'); h('div', { class: 'row' }, [lab, inp])
  eq(srowLabelTarget(lab), null, '非 .srow')
  eq(pairSrowLabel(lab, nextId), null, '非 .srow 不动')
}
{
  const lab = h('label', { class: 'chk-in' }, [h('input', { type: 'checkbox' })]); const sel = h('select'); row(lab, sel)
  eq(pairSrowLabel(lab, nextId), null, '包裹式 label（自带控件）不动')
  eq(sel.id, '', '旁边的下拉不被误配')
}
{
  const lab = h('label', { for: 'x1' }); const inp = h('input'); row(lab, inp)
  eq(pairSrowLabel(lab, nextId), null, '页面自写 for 不动')
}
{
  const lab = h('label'); const inp = h('input', { id: 'own' }); row(lab, inp)
  eq(pairSrowLabel(lab, nextId), null, '控件已有 id 不动')
  const lab2 = h('label'); const inp2 = h('input', { 'aria-label': '名' }); row(lab2, inp2)
  eq(pairSrowLabel(lab2, nextId), null, '控件已有 aria-label 不动')
}
{
  const lab = h('label'); const hid = h('input', { type: 'hidden' }); const sp = h('span'); const inp = h('input'); row(lab, hid, sp, inp)
  eq(srowLabelTarget(lab), inp, '跳过隐藏输入与非控件，取同行第一个控件')
}
{
  const lab = h('label'); const lab2 = h('label'); const inp = h('input'); row(lab, lab2, inp)
  eq(srowLabelTarget(lab), null, '中间隔着另一个 label：不越过')
  eq(srowLabelTarget(lab2), inp, '后一个 label 认它紧随的控件')
}
{
  const lab = h('label'); row(lab, h('span'))
  eq(pairSrowLabel(lab, nextId), null, '行内没有控件')
}

// ③ 同一行两对
{
  const l1 = h('label'); const i1 = h('input', { type: 'number' }); const l2 = h('label'); const i2 = h('select')
  row(l1, i1, l2, i2)
  pairSrowLabel(l1, nextId); pairSrowLabel(l2, nextId)
  eq(i1.getAttribute('aria-labelledby'), l1.id, '第一对')
  eq(l2.getAttribute('for'), i2.id, '第二对')
}
// v-if 换掉控件：自己配过的 for 失效 → 重配到新控件；页面自写的 for 不在此列（上面已测）
{
  const lab = h('label'); const a = h('input'); const r = row(lab, a)
  pairSrowLabel(lab, nextId)
  const b = h('input'); r.replace(a, b)
  const res = pairSrowLabel(lab, nextId)
  eq(res && res.ctl, b, '换控件后重配')
  eq(lab.getAttribute('for'), b.id, 'for 指向新控件')
  const c = h('input', { type: 'number' }); r.replace(b, c)
  pairSrowLabel(lab, nextId)
  eq(lab.getAttribute('for'), null, '换成数字框：撤掉旧 for')
  eq(c.getAttribute('aria-labelledby'), lab.id, '改走 aria-labelledby')
}

console.log(`srowLabels: ${pass} 项通过`)
