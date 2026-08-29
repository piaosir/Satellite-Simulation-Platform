<script setup>
// 「自定义列」独立弹窗：新建/编辑/删除都在这（GSO / NGSO / 再生式三窗共用）。
// 与「结果列」下拉分工——下拉只管勾选显隐，这里负责建：写公式是费时间的事，
// 遮罩刻意【不】点击关闭（口径同高级计算弹窗），只有标题栏 × 与「关闭」按钮能关，误点不丢工作。
// 左栏＝列清单（点选载入、＋新建、悬停删除），右栏＝编辑器（保存不关窗，可连续建多列）。
// 单位【只算不填】：每个引用带着自己的单位进公式，按量纲演算推导（1min/10s=6 无量纲、
// [斜距(km)]/12 仍是 km、dBW−dBW=dB），量纲冲突当场报错。详见 shared/lbCustomCols.js。
// 表达式语法/校验/推导见 shared/lbCustomCols.js；错误行与预览行是状态与读数，不是教学文字。
import { ref, computed, watch } from 'vue'
import Icon from './Icon.vue'
import { compileExpr, deriveColumn, makeResolver, newDefId, unitOf, MAX_DP } from '../shared/lbCustomCols.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  cols: { type: Array, default: () => [] },     // [{ id, label, expr, dp, on }]（单位不存，每次按公式推导）
  pool: { type: Array, default: () => [] },     // 可引用字段池 [{ key, label, unit, group }]（宿主按本体制实际出参过滤）
  subtitle: { type: String, default: '' },      // 再生式传子链路模式名（上行/下行/星间/激光）
  previewFn: { type: Function, default: null }  // (expr, dp) => 值字符串 | null（宿主用当前聚焦行引擎结果算）
})
const emit = defineEmits(['update:cols', 'close'])

const resolve = computed(() => makeResolver(props.pool))
// 「插入字段」分组下拉：按池内分组保序；裸标签唯一用 [标签]，同名多单位带单位消歧；
// 「全部出参」组（label=key）直接插裸键名
const fieldGroups = computed(() => {
  const cnt = {}, cntLU = {}
  for (const it of props.pool) {
    cnt[it.label] = (cnt[it.label] || 0) + 1
    if (it.unit) { const lu = it.label + '(' + it.unit + ')'; cntLU[lu] = (cntLU[lu] || 0) + 1 }
  }
  const m = new Map()
  for (const it of props.pool) {
    const g = it.group || '字段'
    if (!m.has(g)) m.set(g, [])
    // 引用写法逐级退让：标签唯一用 [标签]；同名多单位用 [标签(单位)]；连单位都撞（解析器判歧义）直接插键名
    const ref = it.label === it.key ? it.key
      : cnt[it.label] <= 1 ? '[' + it.label + ']'
        : (it.unit && cntLU[it.label + '(' + it.unit + ')'] === 1) ? '[' + it.label + '(' + it.unit + ')' + ']' : it.key
    m.get(g).push({ text: it.label + (it.unit ? ' (' + it.unit + ')' : ''), ref })
  }
  const groups = [...m.entries()].map(([name, opts]) => ({ name, opts }))
  // 常量组：不是字段（不进池、不参与解析），但插入下拉里该有
  groups.push({ name: '常量', opts: [{ text: 'π 圆周率', ref: 'pi' }, { text: 'e 自然对数底', ref: 'e' }, { text: '% 百分数（20% ≡ 0.2）', ref: '%' }] })
  return groups
})

const editing = ref(null)   // { id|null, label, expr, dp }
const exprEl = ref(null)

// 打开时就位：有列载入第一条，没有直接进新建——弹窗的存在意义就是建
watch(() => props.open, (v) => {
  if (!v) return
  if (props.cols.length) openEdit(props.cols[0])
  else openNew()
})

function openNew() {
  editing.value = { id: null, label: '', expr: '', dp: 2 }
}
function openEdit(c) {
  editing.value = { id: c.id, label: c.label, expr: c.expr, dp: Number.isFinite(Number(c.dp)) ? Number(c.dp) : 2 }
}
function remove(id) {
  if (editing.value && editing.value.id === id) editing.value = null
  emit('update:cols', props.cols.filter((c) => c.id !== id))
}
function insertField(e) {
  const v = e.target.value
  e.target.value = ''
  if (!v || !editing.value) return
  const el = exprEl.value
  const cur = editing.value.expr || ''
  if (el && typeof el.selectionStart === 'number') {
    const s = el.selectionStart, t = el.selectionEnd
    editing.value.expr = cur.slice(0, s) + v + cur.slice(t)
    requestAnimationFrame(() => { try { el.focus(); el.selectionStart = el.selectionEnd = s + v.length } catch (x) { /* ignore */ } })
  } else {
    editing.value.expr = cur + v
  }
}
// 输入期即时校验（语法 → 引用 → 量纲；禁用「保存」直到通过）
const derived = computed(() => (editing.value && String(editing.value.expr || '').trim() ? deriveColumn(editing.value.expr, props.pool) : null))
const liveErr = computed(() => {
  if (!editing.value || !String(editing.value.expr || '').trim()) return ''
  const c = compileExpr(editing.value.expr)
  if (!c.ok) return c.error
  for (const r of c.refs) { if (!resolve.value(r)) return (resolve.value.explain && resolve.value.explain(r)) || ('未知字段：' + r) }
  return (derived.value && derived.value.err) || ''
})
const editUnit = computed(() => (derived.value && !derived.value.err ? derived.value.label : ''))
// 实时预览：当前聚焦行的引擎结果代入公式（运行时读数；没算过 / 无值就不出现）
const preview = computed(() => {
  const ed = editing.value
  if (!ed || liveErr.value || !String(ed.expr || '').trim() || !props.previewFn) return null
  try { return props.previewFn(ed.expr, ed.dp) } catch (e) { return null }
})
function save() {
  const ed = editing.value
  if (!ed || liveErr.value || !String(ed.expr || '').trim()) return
  const dpRaw = Number(ed.dp)
  const def = {
    id: ed.id || newDefId(),
    label: String(ed.label || '').trim() || '自定义',
    expr: ed.expr.trim(),
    // 小数位清空视为缺省 2（Number('')===0 会把「没填」错当成「0 位」）
    dp: String(ed.dp).trim() === '' || !Number.isFinite(dpRaw) ? 2 : Math.min(MAX_DP, Math.max(0, Math.round(dpRaw))),
    on: true
  }
  const cur = props.cols
  const hit = cur.findIndex((c) => c.id === def.id)
  // 编辑保留原勾选态；新建默认勾上。保存不关窗——继续改或「＋ 新建」连续建
  emit('update:cols', hit >= 0 ? cur.map((c, i) => (i === hit ? { ...def, on: c.on !== false } : c)) : [...cur, def])
  editing.value = { ...ed, id: def.id, label: def.label, expr: def.expr, dp: def.dp }
}
const listUnit = (c) => unitOf(c, props.pool)
</script>

<template>
  <div v-if="open" class="ccd-mask">
    <div class="ccd" role="dialog" aria-modal="true">
      <div class="ccd-hd">
        <span class="ccd-fx">ƒx</span>自定义列<span v-if="subtitle" class="ccd-sub">· {{ subtitle }}</span>
        <span class="ccd-sp"></span>
        <button class="ccd-x" title="关闭" aria-label="关闭" @click="emit('close')"><Icon name="x" :size="12" /></button>
      </div>
      <div class="ccd-bd">
        <div class="ccd-list">
          <button class="lb-mini ccd-newbtn" @click="openNew">＋ 新建</button>
          <div v-for="c in cols" :key="c.id" class="ccd-it" :class="{ 'ccd-on': editing && editing.id === c.id }" :title="c.expr" @click="openEdit(c)">
            <span class="ccd-it-n">{{ c.label }}<i v-if="listUnit(c)"> ({{ listUnit(c) }})</i></span>
            <button class="ccd-it-del" title="删除" @click.stop="remove(c.id)"><svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 3l10 10M13 3L3 13"/></svg></button>
          </div>
          <div v-if="!cols.length" class="ccd-empty">还没有自定义列。</div>
        </div>
        <div class="ccd-ed">
          <template v-if="editing">
            <div class="ccd-row">
              <label class="ccd-f ccd-grow"><span class="ccd-l">列名</span>
                <input v-model="editing.label" class="ccd-in" /></label>
              <label class="ccd-f"><span class="ccd-l">小数位</span>
                <input v-model.number="editing.dp" class="ccd-in ccd-dp" type="number" min="0" :max="MAX_DP"
                  title="引擎出参多数只带 2 位小数（toFixed(2+FX)），上限 10 位即引擎自身最大精度；再多位是源数据量化噪声" /></label>
            </div>
            <label class="ccd-f"><span class="ccd-l">表达式</span>
              <textarea ref="exprEl" v-model="editing.expr" class="ccd-expr" rows="3" spellcheck="false"></textarea></label>
            <div class="ccd-row">
              <select class="ccd-in ccd-sel" title="在光标处插入字段引用（池按本体制实际算出的键过滤：输入参数 + 全部输出参数）" @change="insertField">
                <option value="">插入字段</option>
                <optgroup v-for="g in fieldGroups" :key="g.name" :label="g.name">
                  <option v-for="o in g.opts" :key="o.ref + o.text" :value="o.ref">{{ o.text }}</option>
                </optgroup>
              </select>
            </div>
            <div class="ccd-row ccd-unitrow" title="单位由量纲演算得出：引用带着自己的单位进公式，跨标度自动归一（1min/10s=6）">
              <span class="ccd-l">单位</span>
              <span class="ccd-unitv">{{ liveErr ? '—' : (editUnit || '无量纲') }}</span>
            </div>
            <div v-if="preview !== null" class="ccd-prev">预览 <b>{{ preview }}</b><i v-if="editUnit"> {{ editUnit }}</i></div>
            <div v-if="liveErr" class="ccd-err">{{ liveErr }}</div>
            <div class="ccd-row ccd-act">
              <span class="ccd-sp"></span>
              <button class="lb-mini" :disabled="!!liveErr || !String(editing.expr || '').trim()" @click="save">保存</button>
              <button class="lb-mini" @click="emit('close')">关闭</button>
            </div>
            <!-- 语法参考（2026-08-07 用户点名要求的常驻参考区——规格清单不是教学文字，勿按「界面不写说明文字」惯例删除） -->
            <div class="ccd-ref">
              <div class="ccd-ref-r"><b>运算</b><span>+ − * / ^（右结合）· 括号 · 常量 pi e · 百分数 20% ≡ 0.2 · 引用 [列名] / [列名(单位)] / 键名</span></div>
              <div class="ccd-ref-r"><b>函数</b><span>abs sqrt exp ln log10 pow(x,y) · round floor ceil clamp(x,lo,hi) · min max</span></div>
              <div class="ccd-ref-r"><b>dB 域</b><span>db(x)=10·lg x · lin(x)=10^(x/10) · par(a,b,…)=−10·lg Σ10^(−xᵢ/10)（噪声并联）</span></div>
              <div class="ccd-ref-r"><b>三角</b><span>sin cos tan asin acos atan atan2(y,x) · 一律度制</span></div>
              <div class="ccd-ref-r"><b>单位</b><span>量纲演算自动推导：km/12→km · min/s→无量纲 · dBW−dBW→dB · db(W)→dBW · lin(dBW)→W</span></div>
            </div>
          </template>
          <div v-else class="ccd-empty">未选择列。</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ccd-mask { position: fixed; inset: 0; z-index: 220; background: rgba(0, 0, 0, .32); display: flex; align-items: center; justify-content: center; }
.ccd { width: 620px; max-width: calc(100vw - 48px); max-height: calc(100vh - 64px); display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--border-strong, rgba(128,128,128,.5)); border-radius: var(--r-box, 4px); box-shadow: var(--shadow-3); }
.ccd-hd { display: flex; align-items: center; gap: 6px; padding: 8px 10px; font-size: var(--fs-4); font-weight: 600; color: var(--text); border-bottom: 1px solid var(--border, rgba(128,128,128,.3)); }
.ccd-fx { font-style: italic; font-weight: 700; color: var(--accent, var(--text)); }
.ccd-sub { font-weight: 400; color: var(--text-faint, #888); font-size: var(--fs-3); }
.ccd-sp { flex: 1 1 auto; }
.ccd-x { display: inline-flex; border: 0; background: transparent; color: var(--text-faint, #888); cursor: pointer; padding: 2px; }
.ccd-x:hover { color: var(--text); }
.ccd-bd { display: flex; align-items: stretch; min-height: 0; overflow: hidden; }
.ccd-list { flex: 0 0 200px; display: flex; flex-direction: column; gap: 2px; padding: 8px; border-right: 1px solid var(--border, rgba(128,128,128,.3)); overflow-y: auto; }
.ccd-newbtn { align-self: flex-start; margin-bottom: 4px; }
.ccd-it { display: flex; align-items: center; gap: 4px; padding: 4px 6px; font-size: var(--fs-3); color: var(--text); border-radius: var(--r-box); cursor: pointer; }
.ccd-it:hover { background: var(--surface-2, rgba(128,128,128,.12)); }
.ccd-it.ccd-on { background: var(--surface-2, rgba(128,128,128,.16)); font-weight: 600; }
.ccd-it-n { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ccd-it-n i { font-style: normal; color: var(--text-faint, #888); font-size: var(--fs-2); font-weight: 400; }
.ccd-it-del { display: none; flex: 0 0 auto; border: 0; background: transparent; color: var(--text-faint, #888); cursor: pointer; height: var(--h-ctl); white-space: nowrap; padding: 0 2px; }
.ccd-it:hover .ccd-it-del { display: inline-flex; }
.ccd-it-del:hover { color: var(--danger, #9c5751); }
.ccd-empty { padding: 8px 6px; font-size: var(--fs-3); color: var(--text-faint, #888); }
.ccd-ed { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 7px; padding: 10px 12px; overflow-y: auto; }
.ccd-row { display: flex; align-items: center; gap: 8px; }
.ccd-f { display: flex; flex-direction: column; gap: 3px; }
.ccd-grow { flex: 1 1 auto; min-width: 0; }
.ccd-l { font-size: var(--fs-1); color: var(--text-faint, #888); letter-spacing: var(--ls-label); }
.ccd-in { font-size: var(--fs-3); padding: 3px 6px; background-color: var(--surface-2, rgba(128,128,128,.12)); color: var(--text, inherit); border: 1px solid var(--border, rgba(128,128,128,.35)); border-radius: var(--r-box); min-width: 0; }
.ccd-in:focus { outline: none; border-color: var(--border-strong, rgba(128,128,128,.6)); }
.ccd-dp { width: 56px; }
.ccd-sel { flex: 1 1 auto; }
.ccd-unitrow { flex-wrap: wrap; }
.ccd-unitv { font-size: var(--fs-3); color: var(--text); font-family: ui-monospace, Consolas, monospace; }
.ccd-expr { font-size: var(--fs-3); padding: 4px 6px; background: var(--surface-2, rgba(128,128,128,.12)); color: var(--text, inherit); border: 1px solid var(--border, rgba(128,128,128,.35)); border-radius: var(--r-box); resize: vertical; font-family: ui-monospace, Consolas, monospace; }
.ccd-expr:focus { outline: none; border-color: var(--border-strong, rgba(128,128,128,.6)); }
.ccd-prev { font-size: var(--fs-3); color: var(--text-muted, var(--text)); }
.ccd-prev b { font-weight: 600; }
.ccd-prev i { font-style: normal; color: var(--text-faint, #888); font-size: var(--fs-2); }
.ccd-err { font-size: var(--fs-2); color: var(--danger, #9c5751); }
.ccd-act { margin-top: 2px; }
.ccd-ref { margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--border, rgba(128,128,128,.3)); display: flex; flex-direction: column; gap: 2px; }
.ccd-ref-r { display: flex; gap: 8px; font-size: var(--fs-2); color: var(--text-faint, #888); line-height: 1.5; }
.ccd-ref-r b { flex: 0 0 34px; font-weight: 600; color: var(--text-muted, var(--text-faint, #888)); letter-spacing: var(--ls-label); }
.ccd-ref-r span { flex: 1 1 auto; min-width: 0; font-family: ui-monospace, Consolas, monospace; }
</style>
