// 链路表「自定义列」：用公式把引擎出参组合成新列（AWB 式自定义标量的最小可用形态）。
// GEO / NGSO / 再生式三窗共用；本文件纯逻辑、无框架依赖（Vue 接线在各窗 App，UI 见
// components/LbCustomColsDialog.vue），可被 packages/core/test/lbCustomCols.test.mjs 直接引用。
//
// 表达式语言（自带递归下降求值器，不走 eval/Function，无注入面）：
//   引用   裸标识符 = 引擎出参键名（uplinkCN）；[标签] / [标签(单位)] = 按列名引用（[上行C/N]）
//   运算   + - * / ^（^ 右结合且优先于一元负号：-2^2 = -4，同数学写法）、括号
//   函数   abs sqrt exp ln log10 pow(x,y) min(…) max(…) round floor ceil clamp(x,lo,hi)，
//          dB 域三件套 db / lin / par（噪声并联），三角一族【一律度制】sin cos tan asin acos atan atan2(y,x)
//   常量   pi（圆周率）、e（自然对数底）
//   百分数 数字后缀 %：20% ≡ 0.2（无量纲），故 [年中断时长]*20% 仍是 min
// 任一操作数缺失 / 非有限（含除零）→ 整格 '—'，不猜不补。
//
// ★ 单位体系（2026-08-07 起量纲演算，不再让用户手填）：
//   每个引用都带着它的单位进公式，单位随运算推导、跨标度自动换算——1min / 10s = 6（无量纲）、
//   [斜距(km)] / 12 仍是 km、[带宽(kHz)] / [带宽(MHz)] 先归一再除。
//   线性单位走七维量纲（m · s · bit · sym · chip · K · W，另有角度 °；% 是 0.01 标量；Hz≡s⁻¹——
//   这样带宽×时延＝时带积、载波带宽/符号速率 才能正确相消；但显示时按「来自频率单位」的 f 标记
//   把 s⁻¹ 写回 Hz：功率×带宽＝W·Hz、功率÷带宽＝W/Hz，而斜距/时延这种除时间的仍写 m/s）；
//   dB 族按对数单位规则：dBX ± dB = dBX、dBX − dBX = dB、dBX − dBY = dB(X/Y)、
//   db(线性量)=dB(该量纲)（db(W 量)=dBW）、lin(dBX)=X、par 要求同一 dB 单位；
//   对数单位的标度差按 +10·lg(k比) 换算（dBm ↔ dBW 差 30）。
//   量纲冲突（min + dB、sin(米数) 之类）→ 值判 '—'，编辑器报「量纲不一致」。
//   显示单位优先沿用来源字段的写法（斜距仍标 km 不折成 m），池里找不到同量纲写法才按基元合成（m/s、m²）。
//
// 列定义存 localStorage（视图态，不入场景配置——口径同「结果列」勾选集）。

// ============================================================================
// 单位模型
// ============================================================================
// 线性单位 { k, d }：k=折到基元标度的系数，d=量纲指数表（键：m s bit sym chip K W deg 与 a:<原子>）。
// 对数单位 { log:true, k, d }：k/d 描述参考量（dBW → d={W:1},k=1；dBm → k=1e-3）；纯 dB → d={} k=1。
const DIMLESS = Object.freeze({ k: 1, d: {} })

const dimsEq = (a, b) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) if (Math.abs((a[k] || 0) - (b[k] || 0)) > 1e-9) return false
  return true
}
// 频率族标记：显示用，不参与量纲判等（Hz 与 s⁻¹ 同量纲，是同一件事的两种写法）
const fOf = (u) => (u && Number.isFinite(u.f) ? u.f : 0)
const dimsMul = (a, b, sign) => {
  const out = { ...a }
  for (const [k, e] of Object.entries(b)) {
    const v = (out[k] || 0) + sign * e
    if (Math.abs(v) < 1e-9) delete out[k]; else out[k] = v
  }
  return out
}
const dimsPow = (d, n) => {
  const out = {}
  for (const [k, e] of Object.entries(d)) { const v = e * n; if (Math.abs(v) > 1e-9) out[k] = v }
  return out
}
const isDimless = (u) => !u.log && Object.keys(u.d).length === 0

// —— 单位字符串解析 ——
// 线性词元表（精确匹配优先；未知词元降级为原子量纲 a:<词元>，同名仍可相消/相加，只是不跨词元换算）
const LIN_TOKENS = {
  '': { k: 1, d: {} }, '%': { k: 0.01, d: {} },
  '°': { k: 1, d: { deg: 1 } }, '°E': { k: 1, d: { deg: 1 } }, '°/s': { k: 1, d: { deg: 1, s: -1 } },
  m: { k: 1, d: { m: 1 } }, km: { k: 1e3, d: { m: 1 } }, mm: { k: 1e-3, d: { m: 1 } }, 'm²': { k: 1, d: { m: 2 } },
  s: { k: 1, d: { s: 1 } }, ms: { k: 1e-3, d: { s: 1 } }, min: { k: 60, d: { s: 1 } }, h: { k: 3600, d: { s: 1 } },
  // 频率族带 f 标记：量纲仍是 s⁻¹（这样带宽×时延＝时带积、载波带宽/符号速率 都能正确相消），
  // 但记住它「来自频率单位」，合成标签时写回 Hz——否则 功放输出×带宽 会显示成 W/s（射频语境里
  // 那读作「每秒瓦」，实为 W·Hz），功率÷带宽 更会显示成 W·s（实为功率谱密度 W/Hz）。
  Hz: { k: 1, d: { s: -1 }, f: 1 }, kHz: { k: 1e3, d: { s: -1 }, f: 1 }, MHz: { k: 1e6, d: { s: -1 }, f: 1 }, GHz: { k: 1e9, d: { s: -1 }, f: 1 },
  W: { k: 1, d: { W: 1 } }, mW: { k: 1e-3, d: { W: 1 } }, kW: { k: 1e3, d: { W: 1 } },
  K: { k: 1, d: { K: 1 } },
  bit: { k: 1, d: { bit: 1 } }, kbit: { k: 1e3, d: { bit: 1 } },
  bps: { k: 1, d: { bit: 1, s: -1 } }, kbps: { k: 1e3, d: { bit: 1, s: -1 } }, Mbps: { k: 1e6, d: { bit: 1, s: -1 } }, Gbps: { k: 1e9, d: { bit: 1, s: -1 } },
  Baud: { k: 1, d: { sym: 1, s: -1 } }, kBaud: { k: 1e3, d: { sym: 1, s: -1 } }, sps: { k: 1, d: { sym: 1, s: -1 } }, ksps: { k: 1e3, d: { sym: 1, s: -1 } }, Msps: { k: 1e6, d: { sym: 1, s: -1 } },
  cps: { k: 1, d: { chip: 1 } }, kcps: { k: 1e3, d: { chip: 1, s: -1 } }
}
// dB 族（精确匹配；未列出的 dB* 写法降级为原子对数单位，仅同名可运算）
const LOG_TOKENS = {
  dB: { k: 1, d: {} }, dBi: { k: 1, d: {} },
  dBW: { k: 1, d: { W: 1 } }, dBm: { k: 1e-3, d: { W: 1 } },
  dBHz: { k: 1, d: { s: -1 }, f: 1 }, dBK: { k: 1, d: { K: 1 } },   // dBK＝10·lg(T/1K)，是对数单位不是线性
  'dB/K': { k: 1, d: { K: -1 } },
  'dBW/Hz': { k: 1, d: { W: 1, s: 1 }, f: -1 },
  'dBW/m²': { k: 1, d: { W: 1, m: -2 } },
  'dBW/K': { k: 1, d: { W: 1, K: -1 } }
}

const unitCache = new Map()
export function parseUnit(str) {
  const s = String(str || '').trim()
  if (unitCache.has(s)) return unitCache.get(s)
  let u
  if (LOG_TOKENS[s]) u = { log: true, ...LOG_TOKENS[s] }
  else if (/^dB/i.test(s)) u = { log: true, k: 1, d: { ['a:' + s]: 1 } }   // 未知 dB 写法：原子对数单位
  else {
    // 线性：按 '/' 与 '·' 拆词元，首段分子、其余分母
    const segs = s.split('/')
    let k = 1, d = {}, f = 0
    let bad = false
    segs.forEach((seg, i) => {
      for (const tok of seg.split('·')) {
        const t = tok.trim()
        if (t === '' && i === 0 && segs.length === 1) continue
        const hit = LIN_TOKENS[t]
        const unit = hit || { k: 1, d: { ['a:' + t]: 1 } }
        if (!hit && t === '') { bad = true; continue }
        const sign = i === 0 ? 1 : -1
        k = i === 0 ? k * unit.k : k / unit.k
        d = dimsMul(d, unit.d, sign)
        f += sign * fOf(unit)
      }
    })
    u = bad ? { k: 1, d: { ['a:' + s]: 1 } } : { k, d, f }
  }
  unitCache.set(s, u)
  return u
}

// —— 显示单位挑选：来源字段写法优先 → 全池同量纲写法 → 基元合成 ——
const SUP = { 2: '²', 3: '³' }
function composeLabel(u) {
  if (u.log) {
    if (Object.keys(u.d).length === 0) return 'dB'
    const inner = composeLabel({ k: 1, d: u.d, f: fOf(u) })
    return 'dB(' + (inner || '1') + ')'
  }
  if (isDimless(u)) return ''
  const NAMES = { W: 'W', m: 'm', bit: 'bit', sym: 'sym', chip: 'chip', K: 'K', deg: '°', s: 's' }
  const num = [], den = []
  // 频率族回写：残余的 s 指数若来自 Hz 一族（f 标记），按 Hz 记而不按秒记——
  //   功放输出 × 带宽 → W·Hz（不是 W/s，那在射频语境读作「每秒瓦」）
  //   功率 ÷ 带宽 → W/Hz（功率谱密度，不是 W·s）
  // 来自「除以时间」的 s⁻¹（f=0）照旧记秒：斜距/时延仍是 m/s，不会被写成 m·Hz。
  let sExp = u.d.s || 0
  const f = fOf(u)
  let hzExp = 0
  if (sExp < 0 && f > 0) hzExp = Math.min(-sExp, f)
  else if (sExp > 0 && f < 0) hzExp = -Math.min(sExp, -f)
  sExp += hzExp
  const order = ['W', 'm', 'bit', 'sym', 'chip', 'K', 'deg']
  const keys = [...order.filter((k) => u.d[k]), ...Object.keys(u.d).filter((k) => k.startsWith('a:'))]
  const push = (name, e) => {
    if (!e) return
    const abs = Math.abs(e)
    const tag = abs === 1 ? name : name + (SUP[abs] || '^' + abs)
    ;(e > 0 ? num : den).push(tag)
  }
  for (const k of keys) push(NAMES[k] || k.slice(2), u.d[k])
  push('Hz', hzExp)
  push('s', sExp)
  return (num.join('·') || '1') + (den.length ? '/' + den.join('/') : '')
}
function pickDisplayUnit(u, sourceUnits, pool) {
  if (!u) return null
  // 无量纲【不】直接落成纯数：% 是标度 0.01 的无量纲量，功率占用那一列该继续读作 38.98%，
  // 不是 0.3898。故一律先按「量纲+标度」找现成写法，找不到才折成纯数（k=1、无单位）。
  // 量纲与【标度】都要对上才算同一种写法：只比量纲会把 dBW 挑成 dBm（100 W 报成 50 dBm 虽不算错，
  // 但列的口径应当沿用来源字段的写法而不是池里碰巧排在前面的那个），km 同理不该折成 m。
  // f（频率族标记）也要对上：W·s（功率×时间＝能量）与 W/Hz（功率谱密度）同量纲同标度，
  // 只有这个标记能把它们分开——不比就会把能量标成 dBW/Hz。
  const match = (cand) => cand && !!cand.log === !!u.log && dimsEq(cand.d, u.d)
    && Math.abs(Math.log10(cand.k / u.k)) < 1e-9 && fOf(cand) === fOf(u)
  const hunt = (cand) => {
    for (const s of (sourceUnits || [])) if (cand(s.unit)) return s
    for (const it of (pool || [])) { if (!it.unit) continue; const cu = parseUnit(it.unit); if (cand(cu)) return { unit: cu, label: it.unit } }
    return null
  }
  const hit = hunt(match)
  if (hit) return hit
  // 折到基元标度（km/s → m/s、kbps·ms → bit、W/kHz → W/Hz）后再找一次现成写法：
  // db(功率/带宽) 的中间标度是 W/kHz，只有归一到 W/Hz 才认得出池里的 dBW/Hz 那条。
  const base = u.log ? { log: true, k: 1, d: u.d, f: fOf(u) } : { k: 1, d: u.d, f: fOf(u) }
  const baseMatch = (cand) => cand && !!cand.log === !!u.log && dimsEq(cand.d, u.d)
    && Math.abs(Math.log10(cand.k)) < 1e-9 && fOf(cand) === fOf(u)
  return hunt(baseMatch) || { unit: base, label: composeLabel(base) }
}
// 值换算到显示单位（量纲已保证一致）：线性按标度比，对数按 +10lg(k比)
const convTo = (v, from, to) => (from.log ? v + 10 * Math.log10(from.k / to.k) : v * (from.k / to.k))

// ============================================================================
// 词法与语法 → AST
// ============================================================================
function tokenize(src) {
  const s = String(src || '')
  const ts = []
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (/\s/.test(c)) { i++; continue }
    if ('+-*/^(),'.includes(c)) { ts.push({ t: c }); i++; continue }
    if (c === '[') {
      const j = s.indexOf(']', i + 1)
      if (j < 0) throw new Error('缺少配对的 ]')
      const name = s.slice(i + 1, j).trim()
      if (!name) throw new Error('[] 里没有字段名')
      ts.push({ t: 'ref', v: name }); i = j + 1; continue
    }
    let m = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(s.slice(i))
    if (m) {
      i += m[0].length
      // 百分数字面量：20% ≡ 0.2（无量纲纯数），[年中断时长]*20% 因此仍是 min
      if (s[i] === '%') { ts.push({ t: 'num', v: parseFloat(m[0]) / 100 }); i++; continue }
      ts.push({ t: 'num', v: parseFloat(m[0]) }); continue
    }
    m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i))
    if (m) { ts.push({ t: 'id', v: m[0] }); i += m[0].length; continue }
    throw new Error('无法识别的字符：' + c)
  }
  return ts
}

const FN_ARITY = {
  abs: 1, sqrt: 1, exp: 1, ln: 1, log10: 1, pow: 2, min: -1, max: -1,
  round: 1, floor: 1, ceil: 1, clamp: 3, db: 1, lin: 1, par: -1,
  sin: 1, cos: 1, tan: 1, asin: 1, acos: 1, atan: 1, atan2: 2
}
const CONSTS = { pi: Math.PI, e: Math.E }

/**
 * 编译表达式 → { ok:true, refs, ops, ast, fn } 或 { ok:false, error }。
 * fn(get)＝纯数值求值（get 给数、单位一律当无量纲），供快速验算；
 * 带单位的正式求值走 evalRows / previewValue（量演算，见下）。
 */
export function compileExpr(src) {
  if (!String(src || '').trim()) return { ok: false, error: '表达式为空' }
  let ts
  try { ts = tokenize(src) } catch (e) { return { ok: false, error: e.message } }
  const refs = []
  const ops = new Set()
  let p = 0
  const peek = () => ts[p]
  const eat = (t) => { if (!ts[p] || ts[p].t !== t) throw new Error('语法错误：预期 ' + t); return ts[p++] }
  function expr() {
    let node = term()
    while (peek() && (peek().t === '+' || peek().t === '-')) { const op = ts[p++].t; ops.add(op); node = { t: 'bin', op, a: node, b: term() } }
    return node
  }
  function term() {
    let node = factor()
    while (peek() && (peek().t === '*' || peek().t === '/')) { const op = ts[p++].t; ops.add(op); node = { t: 'bin', op, a: node, b: factor() } }
    return node
  }
  function factor() {   // 一元 ± 低于 ^：-2^2 = -(2^2)
    if (peek() && peek().t === '-') { p++; ops.add('neg'); return { t: 'neg', a: factor() } }
    if (peek() && peek().t === '+') { p++; return factor() }
    return power()
  }
  function power() {    // ^ 右结合：2^3^2 = 2^9；指数位可带一元号（2^-3）
    const base = primary()
    if (peek() && peek().t === '^') { p++; ops.add('^'); return { t: 'bin', op: '^', a: base, b: factor() } }
    return base
  }
  function args() {
    eat('(')
    const list = [expr()]
    while (peek() && peek().t === ',') { p++; list.push(expr()) }
    eat(')')
    return list
  }
  function primary() {
    const tk = peek()
    if (!tk) throw new Error('表达式不完整')
    if (tk.t === 'num') { p++; return { t: 'num', v: tk.v } }
    if (tk.t === 'ref') { p++; refs.push(tk.v); return { t: 'ref', name: tk.v } }
    if (tk.t === '(') { p++; const node = expr(); eat(')'); return node }
    if (tk.t === 'id') {
      p++
      if (peek() && peek().t === '(') {
        const n = FN_ARITY[tk.v]
        if (n === undefined) throw new Error('未知函数：' + tk.v)
        ops.add(tk.v)
        const list = args()
        if (n >= 0 && list.length !== n) throw new Error(tk.v + ' 需要 ' + n + ' 个参数')
        if (n < 0 && list.length < 1) throw new Error(tk.v + ' 至少要 1 个参数')
        return { t: 'fn', name: tk.v, args: list }
      }
      if (tk.v in CONSTS) return { t: 'num', v: CONSTS[tk.v] }
      refs.push(tk.v)
      return { t: 'ref', name: tk.v }
    }
    throw new Error('语法错误：意外的 ' + tk.t)
  }
  try {
    const ast = expr()
    if (p < ts.length) throw new Error('语法错误：多余的 ' + (ts[p].v !== undefined ? ts[p].v : ts[p].t))
    const fn = (get) => {
      const q = evalQty(ast, (name) => {
        const v = get(name)
        return v === null || v === undefined ? null : { v, u: DIMLESS }
      }, null)
      return q === null ? null : q.v
    }
    return { ok: true, refs, ops: [...ops], ast, fn }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// ============================================================================
// 量演算：{ v, u } 逐节点求值。量纲冲突抛 UnitError（编辑器据此报错，值判 '—'）
// ============================================================================
function UnitError(msg) { const e = new Error(msg); e.unitErr = true; return e }
const uLabel = (u) => composeLabel(u) || (u.log ? 'dB' : '无量纲')

// 加法族对齐：量纲一致把 b 换算进 a 的标度；对数族按 dB 规则
function alignAdd(a, b, op) {
  if (!a.u.log && !b.u.log) {
    if (!dimsEq(a.u.d, b.u.d)) throw UnitError('量纲不一致：' + uLabel(a.u) + ' 与 ' + uLabel(b.u))
    return { av: a.v, bv: convTo(b.v, b.u, a.u), u: a.u }
  }
  // 对数域：纯 dB 当增益/损耗贴上去；dBX ± dBX 同参考对齐；减法跨参考 = dB(X/Y)
  const aq = a.u.log ? a : { v: a.v, u: { log: true, k: 1, d: {} } }
  const bq = b.u.log ? b : { v: b.v, u: { log: true, k: 1, d: {} } }
  if ((!a.u.log && !isDimless(a.u)) || (!b.u.log && !isDimless(b.u))) {
    throw UnitError('量纲不一致：' + uLabel(a.u) + ' 与 ' + uLabel(b.u))
  }
  const aPure = Object.keys(aq.u.d).length === 0
  const bPure = Object.keys(bq.u.d).length === 0
  if (bPure) return { av: aq.v, bv: bq.v, u: aq.u }
  if (aPure) return { av: aq.v, bv: op === '-' ? convTo(bq.v, bq.u, bq.u) : bq.v, u: op === '-' ? { log: true, k: 1 / bq.u.k, d: dimsPow(bq.u.d, -1) } : bq.u, flip: op === '-' }
  if (dimsEq(aq.u.d, bq.u.d)) {
    const bv = convTo(bq.v, bq.u, aq.u)
    return { av: aq.v, bv, u: op === '-' ? { log: true, k: 1, d: {} } : null, sameRef: true }
  }
  if (op === '-') return { av: aq.v, bv: bq.v, u: { log: true, k: aq.u.k / bq.u.k, d: dimsMul(aq.u.d, bq.u.d, -1) } }
  return { av: aq.v, bv: bq.v, u: { log: true, k: aq.u.k * bq.u.k, d: dimsMul(aq.u.d, bq.u.d, 1) } }
}

function evalQty(node, getQ, srcUnits) {
  const ev = (n) => evalQty(n, getQ, srcUnits)
  const fin = (v, u) => (Number.isFinite(v) ? { v, u } : null)
  const needDimless = (q, what) => {
    if (q.u.log || !isDimless(q.u)) throw UnitError(what + ' 只吃无量纲量（现为 ' + uLabel(q.u) + '）')
    return q.v * q.u.k
  }
  switch (node.t) {
    case 'num': return { v: node.v, u: DIMLESS }
    case 'ref': {
      const q = getQ(node.name)
      if (q === null) return null
      if (srcUnits && q.label && !srcUnits.some((s) => s.label === q.label)) srcUnits.push({ unit: q.u, label: q.label })
      return { v: q.v, u: q.u }
    }
    case 'neg': { const a = ev(node.a); return a === null ? null : fin(-a.v, a.u) }
    case 'bin': {
      const a = ev(node.a); if (a === null) return null
      const b = ev(node.b); if (b === null) return null
      switch (node.op) {
        case '+': case '-': {
          const al = alignAdd(a, b, node.op)
          if (node.op === '+' && al.sameRef) throw UnitError('两个 ' + uLabel(a.u) + ' 电平相加无定义（并联用 par）')
          const v = node.op === '+' ? al.av + al.bv : al.flip ? al.av - al.bv : al.av - al.bv
          return fin(v, al.u || a.u)
        }
        case '*': case '/': {
          if (a.u.log || b.u.log) {
            // 对数量只许乘/除无量纲标量（XPD/2 这类），dB×dB 无定义
            const logQ = a.u.log ? a : b
            const linQ = a.u.log ? b : a
            if (linQ.u.log || !isDimless(linQ.u)) throw UnitError('对数量只能与无量纲标量相乘除')
            const s = linQ.v * linQ.u.k
            const v = node.op === '*' ? logQ.v * s : (a.u.log ? a.v / s : (() => { throw UnitError('标量除以对数量无定义') })())
            return fin(v, logQ.u)
          }
          const sign = node.op === '*' ? 1 : -1
          return fin(node.op === '*' ? a.v * b.v : a.v / b.v, { k: node.op === '*' ? a.u.k * b.u.k : a.u.k / b.u.k, d: dimsMul(a.u.d, b.u.d, sign), f: fOf(a.u) + sign * fOf(b.u) })
        }
        case '^': {
          const n = needDimless(b, '指数')
          if (a.u.log) throw UnitError('对数量不做幂运算')
          if (isDimless(a.u)) return fin(Math.pow(a.v * a.u.k, n), DIMLESS)
          if (node.b.t !== 'num' && node.b.t !== 'neg') throw UnitError('带量纲量的指数必须是数字字面量')
          return fin(Math.pow(a.v, n), { k: Math.pow(a.u.k, n), d: dimsPow(a.u.d, n), f: fOf(a.u) * n })
        }
      }
      return null
    }
    case 'fn': {
      const name = node.name
      const qs = []
      for (const arg of node.args) { const q = ev(arg); if (q === null) return null; qs.push(q) }
      const sameFamily = () => {   // min/max/clamp/par：全体对齐到首参单位
        const u0 = qs[0].u
        const vs = [qs[0].v]
        for (let i = 1; i < qs.length; i++) {
          const q = qs[i]
          if (!!q.u.log !== !!u0.log) {
            if (u0.log && !q.u.log && isDimless(q.u)) { vs.push(q.v * q.u.k); continue }   // 纯数当 dB 标量
            throw UnitError('量纲不一致：' + uLabel(u0) + ' 与 ' + uLabel(q.u))
          }
          if (!dimsEq(q.u.d, u0.d)) throw UnitError('量纲不一致：' + uLabel(u0) + ' 与 ' + uLabel(q.u))
          vs.push(convTo(q.v, q.u, u0))
        }
        return { vs, u: u0 }
      }
      switch (name) {
        case 'abs': return fin(Math.abs(qs[0].v), qs[0].u)
        case 'round': return fin(Math.round(qs[0].v), qs[0].u)
        case 'floor': return fin(Math.floor(qs[0].v), qs[0].u)
        case 'ceil': return fin(Math.ceil(qs[0].v), qs[0].u)
        case 'min': case 'max': { const { vs, u } = sameFamily(); return fin(Math[name](...vs), u) }
        case 'clamp': { const { vs, u } = sameFamily(); return fin(Math.min(vs[2], Math.max(vs[1], vs[0])), u) }
        case 'sqrt': {
          if (qs[0].u.log) throw UnitError('对数量不开方')
          return fin(Math.sqrt(qs[0].v), { k: Math.sqrt(qs[0].u.k), d: dimsPow(qs[0].u.d, 0.5), f: fOf(qs[0].u) / 2 })
        }
        case 'exp': return fin(Math.exp(needDimless(qs[0], 'exp')), DIMLESS)
        case 'ln': return fin(Math.log(needDimless(qs[0], 'ln')), DIMLESS)
        case 'log10': return fin(Math.log10(needDimless(qs[0], 'log10')), DIMLESS)
        case 'pow': {
          const n = needDimless(qs[1], '指数')
          if (qs[0].u.log) throw UnitError('对数量不做幂运算')
          if (isDimless(qs[0].u)) return fin(Math.pow(qs[0].v * qs[0].u.k, n), DIMLESS)
          if (node.args[1].t !== 'num' && node.args[1].t !== 'neg') throw UnitError('带量纲量的指数必须是数字字面量')
          return fin(Math.pow(qs[0].v, n), { k: Math.pow(qs[0].u.k, n), d: dimsPow(qs[0].u.d, n), f: fOf(qs[0].u) * n })
        }
        case 'db': {
          const q = qs[0]
          if (q.u.log) throw UnitError('db() 只吃线性量')
          return fin(10 * Math.log10(q.v), { log: true, k: q.u.k, d: q.u.d, f: fOf(q.u) })
        }
        case 'lin': {
          const q = qs[0]
          if (!q.u.log) { return fin(Math.pow(10, needDimless(q, 'lin') / 10), DIMLESS) }
          return fin(Math.pow(10, q.v / 10), { k: q.u.k, d: q.u.d, f: fOf(q.u) })
        }
        case 'par': {
          const u0 = qs[0].u.log ? qs[0].u : (isDimless(qs[0].u) ? { log: true, k: 1, d: {} } : null)
          if (!u0) throw UnitError('par 只吃 dB 量')
          const vs = []
          for (const q of qs) {
            if (q.u.log) {
              if (!dimsEq(q.u.d, u0.d)) throw UnitError('par 各支必须同一 dB 单位')
              vs.push(convTo(q.v, q.u, u0))
            } else if (isDimless(q.u)) vs.push(q.v * q.u.k)
            else throw UnitError('par 只吃 dB 量')
          }
          return fin(-10 * Math.log10(vs.reduce((s, x) => s + Math.pow(10, -x / 10), 0)), u0)
        }
        case 'sin': case 'cos': case 'tan': {
          const q = qs[0]
          if (q.u.log || (!isDimless(q.u) && !dimsEq(q.u.d, { deg: 1 }))) throw UnitError('三角函数只吃角度（°）或无量纲量')
          const deg = isDimless(q.u) ? q.v * q.u.k : q.v * q.u.k   // 角度基元即度
          return fin(Math[name](deg * Math.PI / 180), DIMLESS)
        }
        case 'asin': case 'acos': case 'atan':
          return fin(Math[name](needDimless(qs[0], name)) * 180 / Math.PI, { k: 1, d: { deg: 1 } })
        case 'atan2': {
          // 同量纲两参（各自换到首参标度后取比值），返回度
          const { vs } = sameFamily()
          return fin(Math.atan2(vs[0], vs[1]) * 180 / Math.PI, { k: 1, d: { deg: 1 } })
        }
      }
      return null
    }
  }
  return null
}

// ============================================================================
// 池 / 解析器 / 校验
// ============================================================================
/** 若干份 {key,label,unit,group?} 清单合成字段池：按 key 去重（先到先得，前面的清单优先）。 */
export function buildPool(...lists) {
  const seen = new Set()
  const out = []
  for (const list of lists) {
    for (const it of (list || [])) {
      if (!it || !it.key || seen.has(it.key)) continue
      seen.add(it.key)
      out.push({ key: it.key, label: it.label || it.key, unit: it.unit || '', group: it.group || '' })
    }
  }
  return out
}

/**
 * 字段池 → 引用解析器 resolve(name) → 引擎键 | null。
 * 优先级：键名精确匹配 → 「标签(单位)」 → 裸标签。同名跨键（含同标签同单位）一律判歧义拒认。
 */
export function makeResolver(pool) {
  const byKey = new Set()
  const byLabel = new Map()
  const byLabelUnit = new Map()
  const cands = new Map()       // label → [{key, unit}…]，供歧义时给出可照抄的写法
  const AMBIG = Symbol('ambig')
  for (const it of (pool || [])) {
    byKey.add(it.key)
    byLabel.set(it.label, byLabel.has(it.label) && byLabel.get(it.label) !== it.key ? AMBIG : it.key)
    if (!cands.has(it.label)) cands.set(it.label, [])
    if (!cands.get(it.label).some((c) => c.key === it.key)) cands.get(it.label).push({ key: it.key, unit: it.unit || '' })
    if (it.unit) {
      const lu = it.label + '(' + it.unit + ')'
      byLabelUnit.set(lu, byLabelUnit.has(lu) && byLabelUnit.get(lu) !== it.key ? AMBIG : it.key)
    }
  }
  const resolve = (name) => {
    if (byKey.has(name)) return name
    if (byLabelUnit.has(name)) { const k = byLabelUnit.get(name); return k === AMBIG ? null : k }
    const k = byLabel.get(name)
    return k === undefined || k === AMBIG ? null : k
  }
  // 解析失败的原因：歧义（同名多个量）与查无此名要分开报——把「歧义」也说成「未知字段」，
  // 用户会对着字段列表里明明有的名字发懵。
  resolve.explain = (name) => {
    if (resolve(name)) return null
    const list = cands.get(name)
    if (list && list.length > 1) {
      const forms = list.map((c) => (c.unit ? `[${name}(${c.unit})]` : `${c.key}`)).join(' 或 ')
      return `字段名有歧义：${name} 有 ${list.length} 个同名量，请写 ${forms}`
    }
    return `未知字段：${name}`
  }
  return resolve
}

/**
 * schema 字段表 → 输入参数池条目（策展：只收 type==='num' 的声明字段，不倒整包入参对象）。
 * specs=[{ fields, group, side?('tx'|'rx'), useRxKey? }]；sample＝该行真正送进引擎的入参对象，
 * schema ∩ sample 才收（分体制的最终裁决）。跨侧同名标签自动加（发）/（收）；仍撞回退键名。
 */
export function schemaInputPool(specs, sample) {
  if (!sample) return []
  const cand = []
  const seen = new Set()
  for (const sp of (specs || [])) {
    for (const f of (sp.fields || [])) {
      if (!f || f.type !== 'num') continue
      const key = sp.useRxKey ? f.rxKey : f.key
      if (!key || seen.has(key)) continue
      const v = sample[key]
      if (v === undefined || v === null || v === '' || !Number.isFinite(parseFloat(v))) continue
      seen.add(key)
      cand.push({ key, label: f.label || key, unit: f.unit || '', group: sp.group || '输入参数', side: sp.side || '' })
    }
  }
  const cnt = {}
  for (const c of cand) cnt[c.label] = (cnt[c.label] || 0) + 1
  const out = []
  for (const c of cand) {
    let label = c.label
    if (cnt[c.label] > 1) label = c.label + (c.side === 'rx' ? '（收）' : c.side === 'tx' ? '（发）' : '')
    if (out.some((x) => x.label === label && x.unit === c.unit)) label = c.key
    out.push({ key: c.key, label, unit: c.unit, group: c.group })
  }
  return out
}

/** 编辑器校验：语法 + 引用可解析 + 量纲自洽。通过返回 null，否则返回错误文案（状态文本，进界面）。 */
export function validateExpr(src, resolve, pool) {
  const c = compileExpr(src)
  if (!c.ok) return c.error
  for (const r of c.refs) { if (!resolve(r)) return (resolve.explain && resolve.explain(r)) || ('未知字段：' + r) }
  if (pool) { const d = deriveColumn(src, pool); if (d.err) return d.err }
  return null
}

// ============================================================================
// 列口径推导（单位只算不填）与逐行求值
// ============================================================================
const unitByKey = (pool) => {
  const m = new Map()
  for (const it of (pool || [])) m.set(it.key, { u: parseUnit(it.unit), label: it.unit || '' })
  return m
}

/**
 * 由表达式+池静态推导整列口径：{ unit, label, err }。
 * 量纲只由公式结构决定、与行值无关（用占位值 1 走一遍量演算），err 即编辑器要报的量纲冲突。
 */
export function deriveColumn(src, pool) {
  const c = compileExpr(src)
  if (!c.ok) return { unit: null, label: '', err: c.error }
  const resolve = makeResolver(pool)
  const um = unitByKey(pool)
  const srcUnits = []
  try {
    const q = evalQty(c.ast, (name) => {
      const k = resolve(name)
      if (!k) return null
      const info = um.get(k) || { u: DIMLESS, label: '' }
      return { v: 1, u: info.u, label: info.label }
    }, srcUnits)
    if (q === null) return { unit: null, label: '', err: null }   // 占位值算出非有限（如 ln(1)=0 再除）→ 单位未知但不报错
    const disp = pickDisplayUnit(q.u, srcUnits, pool)
    return { unit: disp.unit, label: disp.label, err: null }
  } catch (e) {
    if (e.unitErr) return { unit: null, label: '', err: e.message }
    return { unit: null, label: '', err: null }
  }
}

/** 列显示单位（自动推导；用户不再手填）。 */
export function unitOf(def, pool) { return deriveColumn(def.expr, pool || []).label }
export function inferUnit(src, pool) { return deriveColumn(src, pool || []).label }

// 小数位上限 10＝引擎自己的最大精度（出参走 toFixed(2 + FX)，FX 钳在 0~8）。
// 再往上没有意义：引擎出参多数只带 2 位小数，更多位显示的是源数据的量化噪声而非精度。
export const MAX_DP = 10

const fmtVal = (v, dp) => {
  if (v === null || !Number.isFinite(v)) return '—'
  // dp 清空（''）视为缺省 2：Number('')===0 会把「没填」错当成「0 位」，预览与落库口径必须一致
  const raw = dp === undefined || dp === null || String(dp).trim() === '' ? 2 : Number(dp)
  const d = Number.isFinite(raw) ? Math.min(MAX_DP, Math.max(0, Math.round(raw))) : 2
  return v.toFixed(d)
}

/**
 * 逐行求值（量演算）：defs=[{id,expr,dp,…}]、rows=[{id,data}]、pool 给单位与解析。
 * 值按整列推导出的显示单位换算后落格（[年中断时长(min)]/[时延(s)] 这类先归一标度再除）。
 */
export function evalRows(defs, rows, resolve, pool) {
  const out = {}
  if (!defs.length || !rows.length) return out
  const um = unitByKey(pool || [])
  const compiled = defs.map((d) => ({ d, c: compileExpr(d.expr), col: deriveColumn(d.expr, pool || []) }))
  for (const row of rows) {
    const getQ = (name) => {
      const k = resolve(name)
      if (!k || !row.data) return null
      const n = parseFloat(row.data[k])
      if (!Number.isFinite(n)) return null
      const info = um.get(k) || { u: DIMLESS, label: '' }
      return { v: n, u: info.u, label: info.label }
    }
    const patch = {}
    for (const { d, c, col } of compiled) {
      let cell = '—'
      if (c.ok && row.data && !col.err) {
        try {
          const q = evalQty(c.ast, getQ, null)
          if (q !== null) {
            // 有推导出的列单位就一律换算过去（含 % 这种标度 0.01 的无量纲量）；
            // 推不出时无量纲量按自身标度折成纯数
            const v = col.unit ? convTo(q.v, q.u, col.unit) : (isDimless(q.u) ? q.v * q.u.k : q.v)
            cell = fmtVal(v, d.dp)
          }
        } catch (e) { /* 量纲冲突 → '—' */ }
      }
      patch['_c' + d.id] = cell
    }
    out[row.id] = patch
  }
  return out
}

/** 勾选中的自定义列 → 链路表结果列组的字段定义（列头悬停显示公式；单位自动推导）。 */
export function customFieldDefs(defs, pool) {
  return (defs || []).filter((c) => c.on !== false)
    .map((c) => ({ key: '_c' + c.id, label: c.label, unit: unitOf(c, pool), type: 'num', ro: true, group: 'res', target: 'meta', tip: c.expr }))
}

export function newDefId() { return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) }

const sanitizeDef = (c) => (c && typeof c === 'object' && c.id && typeof c.expr === 'string')
  ? {
      id: String(c.id), label: String(c.label || '自定义'), expr: c.expr,
      dp: Number.isFinite(Number(c.dp)) ? Number(c.dp) : 2, on: c.on !== false
    }
  : null

export function loadDefs(storageKey) {
  try {
    const v = JSON.parse(localStorage.getItem(storageKey) || '')
    return Array.isArray(v) ? v.map(sanitizeDef).filter(Boolean) : []
  } catch (e) { return [] }
}

export function saveDefs(storageKey, defs) {
  try { localStorage.setItem(storageKey, JSON.stringify(defs || [])) } catch (e) { /* ignore */ }
}
