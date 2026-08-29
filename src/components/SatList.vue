<script setup>
// 卫星列表（虚拟滚动 + Excel 式多选）：星座页「内置组 / 卫星组 / 自定义星座」三处行内展开共用。
//
// 性能口径（目标：上万条列表与几十条同样跟手）
//   · 只吃扁平数组 [{ id, name, lc, sub, tip, dot? }]，lc = name 小写由父级预建 —— 逐次键入筛选时不能每条 toLowerCase；
//     数组本身由父级用 shallowRef 装载，Vue 不深代理，三万条也没有建代理的开销。
//   · 视口内只渲染 ceil(视口高/行高) + 上下各 OVERSCAN 行；滚动直接改 scrollTop 状态（合帧交给 Vue 调度器，见 onScroll）。
//   · 选择集是 Map(id → item) 装在 shallowRef 里：全选三万条也只触发一次重渲染；
//     用 Map 而非 Set 是因为「被筛选词临时藏起来的选中项」也要能取回原对象交给调用方。
//
// 选择口径（对齐 Excel / 资源管理器）
//   点选=只选它 · Ctrl 点=增减 · Shift 点=从锚点连选 · Ctrl+Shift 点=把连选并入
//   行上左键拖=连选到指针所在行 · 【行首勾选框上左键拖=刷选】（按住多选最直觉的一条路，见 onCheckDown）
//   Ctrl+A=把当前筛选结果并入已选 · Esc=清除 · ↑↓/PgUp/PgDn/Home/End 移动，配 Shift 为扩选 · 回车/双击=定位
// 换筛选词不清选择集（跨多次筛选累积攒一批，与卫星组管理器的勾选口径一致），只重置锚点。
import { ref, shallowRef, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'

const props = defineProps({
  items: { type: Array, default: () => [] },     // 扁平数据源（原始数组，勿传深响应式）
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
  rows: { type: Number, default: 12 },           // 视口最多几行（不足则按实际条数收缩）
  actions: { type: Array, default: () => [] },   // [{ key, label, icon, title, tone, always }]
  placeholder: { type: String, default: '筛选' },
  empty: { type: String, default: '没有卫星。' },
  // 「这是哪一处的列表」。★ 清空选择/筛选/滚动位置只认它变，不认 items 换引用 ——
  // 卫星组那一路的 items 会在【全量目录建好之后】重映射一次（补 GEO 定点标注），数组是新的、
  // 内容还是那批星；跟着 items 清，用户刚攒的一批选中就在几秒后自己没了（正是「多选不管用」的一种）。
  resetKey: { type: String, default: '' }
})
const emit = defineEmits(['action', 'activate'])

const ROW_H = 22
const OVERSCAN = 6

/* ——— 筛选（防抖 120ms；名称与编号同时命中） ——— */
const kw = ref('')
const kwLive = ref('')
let kwTimer = null
watch(kw, (v) => {
  if (kwTimer) clearTimeout(kwTimer)
  kwTimer = setTimeout(() => { kwLive.value = String(v || '').trim().toLowerCase(); kwTimer = null }, 120)
})
const view = computed(() => {
  const k = kwLive.value, arr = props.items || []
  if (!k) return arr
  const out = []
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i]
    if ((it.lc || '').includes(k) || String(it.id).includes(k)) out.push(it)
  }
  return out
})
const total = computed(() => view.value.length)

/* ——— 虚拟滚动 ——— */
const vpEl = ref(null)
const scrollTop = ref(0)
const vpRows = computed(() => Math.max(3, Math.min(props.rows, total.value || 3)))
const vpH = computed(() => vpRows.value * ROW_H)
const start = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_H) - OVERSCAN))
const end = computed(() => Math.min(total.value, Math.ceil((scrollTop.value + vpH.value) / ROW_H) + OVERSCAN))
const win = computed(() => view.value.slice(start.value, end.value))
const offsetY = computed(() => start.value * ROW_H)
// 直接赋值即可：Chromium 每帧最多派发一次 scroll，Vue 的调度器又把同一帧内的多次改动并成一次重渲染。
// 【勿改回 rAF 节流】：页面不可见时 rAF 根本不触发，窗口被遮挡/后台再回来就停在上一帧的行上。
function onScroll() { if (vpEl.value) scrollTop.value = vpEl.value.scrollTop }

/* ——— 选择集 ——— */
const sel = shallowRef(new Map())
const anchor = ref(-1)   // 连选锚点（当前筛选视图下标）
const cursor = ref(-1)   // 键盘焦点行
const count = computed(() => sel.value.size)
const setSel = (m) => { sel.value = m }
const at = (i) => view.value[i] || null

function selectOnly(i) {
  const it = at(i); const m = new Map()
  if (it) m.set(it.id, it)
  anchor.value = i; cursor.value = i; setSel(m)
}
function toggleAt(i) {
  const it = at(i); if (!it) return
  const m = new Map(sel.value)
  if (m.has(it.id)) m.delete(it.id); else m.set(it.id, it)
  anchor.value = i; cursor.value = i; setSel(m)
}
// base=null → 连选替换整个选择集；base=某个 Map → 在它之上叠这一段（Ctrl 连选 / Ctrl 拖刷；
// 拖刷时 base 是按下那一刻的快照，所以往回拖能把多出来的行还原，而不是只进不退）
function selectRange(i, base) {
  const a = anchor.value < 0 ? i : anchor.value
  const lo = Math.min(a, i), hi = Math.max(a, i), v = view.value
  const m = base ? new Map(base) : new Map()
  for (let k = lo; k <= hi; k++) { const it = v[k]; if (it) m.set(it.id, it) }
  if (anchor.value < 0) anchor.value = i
  cursor.value = i; setSel(m)
}
// 全选=把当前筛选结果【并入】已选（不是替换）：搜 A 全选 → 换词搜 B 全选 → 攒成一批加进卫星组，
// 与卫星组管理器「跨多次搜索累积勾选」同口径。无筛选词时并集就是全表，与常规 Ctrl+A 无异。
function selectAll() {
  const m = new Map(sel.value)
  for (const it of view.value) m.set(it.id, it)
  setSel(m)
}
function clearSel() { anchor.value = -1; cursor.value = -1; setSel(new Map()) }
// 换了一处展开（resetKey 变）→ 清选择、清筛选词、回到顶部
watch(() => props.resetKey, () => { kw.value = ''; kwLive.value = ''; clearSel(); scrollTop.value = 0; if (vpEl.value) vpEl.value.scrollTop = 0 })
// 同一处、items 换了引用（成员增删、标注补齐）→ 只把选择集按 id 重挂到新对象上，还在的留下、
// 没了的丢掉；筛选词与滚动位置不动。选择集存的是【对象】，不重挂的话交给调用方的会是一批旧对象。
watch(() => props.items, (arr) => {
  if (!sel.value.size) return
  const by = new Map((arr || []).map((it) => [it.id, it]))
  const m = new Map()
  for (const id of sel.value.keys()) { const it = by.get(id); if (it) m.set(id, it) }
  anchor.value = -1; cursor.value = -1
  setSel(m)
})
watch(kwLive, () => { anchor.value = -1; cursor.value = -1 })

// 展开的是侧栏靠下的行时，面板可能整块开在视口外 —— 自己滚进来（够看即可，不强行居中）
const rootEl = ref(null)
onMounted(() => { try { if (rootEl.value) rootEl.value.scrollIntoView({ block: 'nearest' }) } catch { /* 老环境无此参数 */ } })

/* ——— 鼠标：点选 / Ctrl / Shift / 左键拖刷（拖到上下边缘自动滚动，可一路刷到表尾） ——— */
// 拖刷全程按【指针坐标】算行号（listen 在 window 上），不靠逐行 mouseenter：
// 这样拖出列表上/下沿之后照样跟得住 —— 那正是需要自动滚动的时候，而那时鼠标已不在任何行上。
const EDGE = 20            // 距上/下沿多少像素起自动滚动
const AUTO_MS = 16
// dragMode='range' 行上拖＝连选到指针所在行；'paint' 勾选框上拖＝把按下那一刻定下的目标状态
// （paintOn）刷到经过的每一行 —— 勾选框是「多选」这件事在界面上唯一看得见的入口，从它按下去拖
// 却只动一行，用户看到的就是「长按多选不管用」。
let dragging = false, dragBase = null, dragY = 0, dragIdx = -1, dragMode = 'range', paintOn = true
let autoTimer = null, autoV = 0
function stopAuto() { if (autoTimer) { clearInterval(autoTimer); autoTimer = null } autoV = 0 }
function endDrag() {
  if (!dragging) return
  dragging = false; dragBase = null; dragIdx = -1
  stopAuto()
  window.removeEventListener('mousemove', onDragMove)
}
function beginDrag(e, i, base, mode) {
  dragging = true; dragBase = base; dragIdx = i; dragY = e.clientY; dragMode = mode || 'range'
  window.addEventListener('mousemove', onDragMove)
}
// 刷选：把 paintOn 刷到 [a,b] 这一段上。必须按段刷、不能只刷落点那一行 ——
// 快拖与自动滚动一次会跳好几行，只刷落点会漏掉中间的。
function paintSpan(a, b) {
  const v = view.value
  const lo = Math.max(0, Math.min(a, b)), hi = Math.min(v.length - 1, Math.max(a, b))
  let m = null
  for (let k = lo; k <= hi; k++) {
    const it = v[k]; if (!it) continue
    if (sel.value.has(it.id) === paintOn) continue
    if (!m) m = new Map(sel.value)
    paintOn ? m.set(it.id, it) : m.delete(it.id)
  }
  anchor.value = b; cursor.value = b
  if (m) setSel(m)
}
// 捕获相：内层若把 mouseup stopPropagation 掉了，冒泡相的收尾就永远等不到（拖刷卡住）
window.addEventListener('mouseup', endDrag, true)
onBeforeUnmount(() => {
  window.removeEventListener('mouseup', endDrag, true)
  window.removeEventListener('mousemove', onDragMove)
  stopAuto()
  if (kwTimer) clearTimeout(kwTimer)
})
// 指针 Y → 行号（夹在视口内：拖出上/下沿时即对应首/末可见行），把连选拉到那一行
function extendToPointer() {
  const el = vpEl.value; if (!el || !total.value) return
  const r = el.getBoundingClientRect()
  const y = Math.max(0, Math.min(el.clientHeight - 1, dragY - r.top))
  const i = Math.max(0, Math.min(total.value - 1, Math.floor((el.scrollTop + y) / ROW_H)))
  if (i === dragIdx) return
  const prev = dragIdx
  dragIdx = i
  if (dragMode === 'paint') paintSpan(prev < 0 ? i : prev, i)
  else selectRange(i, dragBase)
}
// 【必须查 e.buttons】：只靠 window 的 mouseup 收尾，一旦那次 mouseup 没送达（窗口外松手、被别处
// stopPropagation 掉），dragging 就永久卡住 —— 此后光鼠标划过就把攒好的多选刷成一段连选，
// 表现正是「多选不起作用」。每次移动都确认左键仍按着，按不住就地收工。
function onDragMove(e) {
  if (!dragging) return
  if (!(e.buttons & 1)) { endDrag(); return }
  dragY = e.clientY
  extendToPointer()
  const el = vpEl.value; if (!el) return
  const r = el.getBoundingClientRect()
  const up = (r.top + EDGE) - e.clientY, dn = e.clientY - (r.bottom - EDGE)
  autoV = up > 0 ? -Math.min(24, 2 + up * 0.4) : (dn > 0 ? Math.min(24, 2 + dn * 0.4) : 0)   // 越界越远滚得越快，封顶 24px/帧
  if (autoV && !autoTimer) autoTimer = setInterval(autoTick, AUTO_MS)
  else if (!autoV) stopAuto()
}
function autoTick() {
  const el = vpEl.value
  if (!el || !dragging || !autoV) { stopAuto(); return }
  const max = Math.max(0, total.value * ROW_H - el.clientHeight)
  const next = Math.max(0, Math.min(max, el.scrollTop + autoV))
  if (next === el.scrollTop) return   // 已到头：停在边界但不撤计时器（用户可能又往回拖）
  el.scrollTop = next
  scrollTop.value = next              // 不等 scroll 事件：窗口不合成帧时它未必派发
  extendToPointer()
}
function onRowDown(e, idx) {
  if (e.button !== 0) return
  const i = start.value + idx
  const ctrl = e.ctrlKey || e.metaKey
  if (e.shiftKey) {
    const base = ctrl ? new Map(sel.value) : null    // 连选的底：Ctrl+Shift 才在已选之上叠这一段
    selectRange(i, base)
    beginDrag(e, i, base, 'range')                   // Shift 按住继续拖也能接着改这一段的另一端
  } else if (ctrl) { toggleAt(i); beginDrag(e, i, new Map(sel.value), 'range') }   // Ctrl 拖＝在已选之上加刷
  else { selectOnly(i); beginDrag(e, i, null, 'range') }
  if (vpEl.value) vpEl.value.focus({ preventScroll: true })
}
// 行首勾选框：等价于 Ctrl 点（只增减这一行，不动其它选中项）。Ctrl/Shift 不好发现，给一个看得见的入口。
// 从它按下去拖＝刷选（把这一下翻成的状态刷到经过的每一行）——「按住多选」最直觉的一条路。
function onCheckDown(e, idx) {
  if (e.button !== 0) return
  const i = start.value + idx
  const it = at(i); if (!it) return
  paintOn = !sel.value.has(it.id)
  paintSpan(i, i)
  beginDrag(e, i, null, 'paint')
  if (vpEl.value) vpEl.value.focus({ preventScroll: true })
}

/* ——— 键盘 ——— */
function ensureVisible(i) {
  const el = vpEl.value; if (!el) return
  const top = i * ROW_H, bot = top + ROW_H
  if (top < el.scrollTop) el.scrollTop = top
  else if (bot > el.scrollTop + vpH.value) el.scrollTop = bot - vpH.value
}
function onKey(e) {
  const n = total.value
  if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); selectAll(); return }
  if (e.key === 'Escape') { clearSel(); return }
  if (!n) return
  if (e.key === 'Enter') { const it = at(cursor.value); if (it) emit('activate', it); return }
  let i = cursor.value
  const cur = i < 0 ? 0 : i
  if (e.key === 'ArrowDown') i = i < 0 ? 0 : Math.min(n - 1, i + 1)
  else if (e.key === 'ArrowUp') i = i < 0 ? 0 : Math.max(0, i - 1)
  else if (e.key === 'Home') i = 0
  else if (e.key === 'End') i = n - 1
  else if (e.key === 'PageDown') i = Math.min(n - 1, cur + vpRows.value)
  else if (e.key === 'PageUp') i = Math.max(0, cur - vpRows.value)
  else return
  e.preventDefault()
  if (e.shiftKey) selectRange(i, (e.ctrlKey || e.metaKey) ? sel.value : null); else selectOnly(i)
  ensureVisible(i)
}

/* ——— 操作条：把选中项连同按钮屏幕坐标交给调用方（弹出菜单需要锚点） ——— */
function onAction(a, e) {
  const n = count.value
  if (!a.always && !n) return
  const r = e.currentTarget.getBoundingClientRect()
  emit('action', a.key, { items: [...sel.value.values()], x: r.left, y: r.bottom + 4, right: r.right })
}
</script>

<template>
  <div ref="rootEl" class="sl" :class="{ hassel: count > 0 }">
    <div class="slh">
      <span class="slf">
        <Icon name="search" :size="12" />
        <input v-model="kw" :placeholder="placeholder" spellcheck="false" @keydown.esc.stop="kw = ''" @keydown.stop />
      </span>
      <span class="slb" title="全选当前筛选结果（并入已选）· 列表内 Ctrl+A" @click="selectAll"><Icon name="check" :size="12" /></span>
      <span class="slb" :class="{ off: !count }" title="清除选择 · 列表内 Esc" @click="clearSel"><Icon name="x" :size="12" /></span>
    </div>
    <div class="slm">
      <span class="sln"><template v-if="!loading">{{ total }} 颗<template v-if="count"> · 已选 {{ count }}</template></template></span>
      <span
        v-for="a in actions" :key="a.key"
        class="sla" :class="[a.tone || '', { off: !a.always && !count }]"
        :title="(!a.always && !count) ? '先在下面选中卫星：点选一颗 · 按住拖刷一片 · Shift 点连选 · Ctrl+A 全选' : (a.title || a.label)"
        @click="onAction(a, $event)"
      ><Icon v-if="a.icon" :name="a.icon" :size="12" />{{ a.label }}</span>
    </div>
    <div v-if="loading" class="slmsg">加载中…</div>
    <div v-else-if="error" class="slmsg err">{{ error }}</div>
    <div v-else-if="!items.length" class="slmsg">{{ empty }}</div>
    <div v-else-if="!total" class="slmsg">无匹配。</div>
    <div
      v-else
      ref="vpEl" class="slvp" tabindex="0"
      :style="{ height: vpH + 'px' }"
      @scroll.passive="onScroll" @keydown="onKey"
    >
      <div class="slsp" :style="{ height: total * ROW_H + 'px' }">
        <div class="slwin" :style="{ transform: 'translateY(' + offsetY + 'px)' }">
          <div
            v-for="(it, idx) in win" :key="it.id"
            class="slr" :class="{ on: sel.has(it.id), cur: start + idx === cursor }"
            :title="it.tip || (it.name + ' · ' + it.id)"
            @mousedown="onRowDown($event, idx)"
            @dblclick="emit('activate', it)"
          >
            <span class="slck" :class="{ on: sel.has(it.id) }" title="加入 / 移出选择（等同 Ctrl 点）· 按住往下拖可连着刷一片" @mousedown.stop="onCheckDown($event, idx)"><Icon v-if="sel.has(it.id)" name="check" :size="12" /></span>
            <span v-if="it.dot" class="sldot" :style="{ background: it.dot }"></span>
            <span class="slnm" data-i18n-skip>{{ it.name }}</span>
            <span v-if="it.sub" class="slsub">{{ it.sub }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 整块面板左缘一道竖条，把列表和上面那行「挂」在一起（比行内选中条淡一档，避免两道同强度的线打架） */
.sl { border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); background: var(--surface-2); box-shadow: inset 2px 0 0 color-mix(in srgb, var(--accent) 55%, transparent); }
/* 头：筛选框 + 全选/清除 */
.slh { display: flex; align-items: center; gap: 5px; padding: 5px 10px 4px 12px; }
.slf { flex: 1; min-width: 0; display: flex; align-items: center; gap: 4px; border: 1px solid var(--border); background: var(--bg); padding: 1px 6px; color: var(--text-faint); }
.slf:focus-within { border-color: var(--accent-ui); }
.slf input { flex: 1; min-width: 0; border: 0; background: transparent; color: var(--text); font: inherit; font-size: var(--fs-3); padding: 2px 0; outline: none; }
.slb { flex: none; display: inline-flex; align-items: center; padding: 2px; color: var(--text-faint); cursor: pointer; }
.slb:hover { color: var(--text); }
.slb.off { opacity: .4; }
/* 读数行 + 操作条 */
.slm { display: flex; align-items: center; gap: 8px; padding: 0 10px 5px 12px; font-size: var(--fs-2); }
.sln { flex: 1; min-width: 0; color: var(--text-faint); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sla { flex: none; display: inline-flex; align-items: center; gap: 3px; color: var(--accent); cursor: pointer; white-space: nowrap; padding: 1px 6px; border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent); border-radius: var(--r-card); }
.sla:hover { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.sla.warn { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, transparent); }
.sla.warn:hover { background: color-mix(in srgb, var(--danger) 14%, transparent); }
/* 没选星时按钮是真的不可点：色/描边压到底 + not-allowed，别让人以为「点了没反应」 */
.sla.off { color: var(--text-faint); border-color: var(--border); border-style: dashed; opacity: .55; cursor: not-allowed; background: transparent; }
.sla.off:hover { background: transparent; }
/* 列表本体：定高视口 + 撑高占位 + 平移窗口 */
.slvp { overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; background: var(--bg); border-top: 1px solid var(--border); outline: none; user-select: none; }
.slvp:focus-visible { box-shadow: inset 0 0 0 1px var(--accent-ui); }
.slsp { position: relative; }
.slwin { position: absolute; top: 0; left: 0; right: 0; will-change: transform; }
.slr { height: 22px; box-sizing: border-box; display: flex; align-items: center; gap: 6px; padding: 0 10px 0 10px; font-size: var(--fs-3); color: var(--text-muted); cursor: default; }
/* 勾选框：常占位不常显 —— 悬停该行、该行已选、或已有任何选中时才现身（Explorer 式，不做成常驻复选框列） */
.slck { flex: none; width: 12px; height: 12px; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--text-faint); border-radius: var(--r-ctl); opacity: 0; }
.slr:hover .slck, .slr.on .slck, .sl.hassel .slck { opacity: 1; }
.slck:hover { border-color: var(--accent); }
.slck.on { background: var(--accent); border-color: var(--accent); color: var(--bg); }
.slr:hover { background: var(--surface-2); color: var(--text); }
.slr.on { background: color-mix(in srgb, var(--accent-ui) 20%, transparent); color: var(--text); box-shadow: inset 2px 0 0 var(--accent-ui); }
.slr.cur { outline: 1px solid color-mix(in srgb, var(--accent) 70%, transparent); outline-offset: -1px; }
/* 行首色点（可选 it.dot）：卫星组成员显示生效配色；'transparent' 为占位对齐 */
.sldot { flex: none; width: 7px; height: 7px; border-radius: 50%; }
.slnm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slsub { flex: none; font-size: var(--fs-2); color: var(--text-faint); font-variant-numeric: tabular-nums; }
.slr.on .slsub { color: var(--text-muted); }
.slmsg { padding: 3px 12px 7px; font-size: var(--fs-2); color: var(--text-faint); }
.slmsg.err { color: var(--danger); }
</style>
