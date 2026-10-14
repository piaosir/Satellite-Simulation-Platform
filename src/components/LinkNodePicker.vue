<script setup>
// 「链路分析」视图的节点选择器：链路详情节点竖链里，插入光标那一位（或被替换的那个节点）就地展开的检索框 + 候选列表。
// 交互范式 = WAI-ARIA 组合框（combobox + listbox）+ 检索范围（GitHub 命令面板的作用域标签）：
//   打字即过滤；↑↓ / PgUp PgDn 移动；Enter 选中（没停在哪条时取第一条可选的）；Esc 先清检索词、再退出范围、再收起。
//   根视图 = 地球站 / 点标记 / 航迹 / Polygon / 城市库 / 常用卫星 / 卫星集；有检索词时卫星查全量，末尾「全部 N 颗」进整份命中表。
//   卫星集行上 Enter / Tab / → / 单击 = 进入该集：检索框左侧出范围标签，列表换成该集全部成员（虚拟滚动，几万颗同样跟手），
//   检索只在该集里做；空词 Backspace / ← 、Esc（无词时）或标签上的 × = 退出范围。
//   插入位选中后不收：清词、光标后移、回到第一层，接着挑下一个 —— 与图上依次单击同一节奏；
//   根视图空词时 Backspace 撤销本次插进去的上一个节点（按住连发不算）、Enter 完成（同图上建链的键位）。替换位选中即收。
// 候选与几何读数来自 viz/links/linkPickSource.js；本组件只管输入、列表与键盘，选中 / 悬停交给宿主（pick / hover）。
import { ref, shallowRef, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import { byLang } from '../shared/i18n/lang.js'

const props = defineProps({
  source: { type: Object, required: true },      // createLinkPickSource(...)
  nbrs: { type: Object, required: true },        // { prev, next, cur? }：该位前后的节点；替换时 cur = 被换的那个
  sig: { type: String, required: true },         // 该位签名（链路 · 位置 · 两侧节点 · 门限）：变了才重算候选
  mode: { type: String, default: 'ins' },        // 'ins' 插入位 | 'rep' 替换
  autofocus: { type: Boolean, default: false },
  drawing: { type: Boolean, default: false },    // 插入态：空词 Enter = 完成、Backspace = 撤销
  placeholder: { type: String, default: '' }
})
const emit = defineEmits(['pick', 'hover', 'close', 'undo', 'finish'])

const ICON = { st: 'satellite-dish', pt: 'map-pin', sat: 'satellite', city: 'map-pin', tj: 'ship', pg: 'polygon' }
const ROW_H = 24                 // 行高（与 .lnp-it 同值：虚拟滚动按它换算）
const VP_ROWS = 12               // 卫星集视图的视口行数
const OVERSCAN = 4
const uid = 'lnp' + Math.random().toString(36).slice(2, 8)
const optId = (id) => uid + '-' + String(id).replace(/[^\w-]/g, '_')
const fmtN = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? '' : Number(v).toLocaleString('en-US'))

const q = ref('')
const open = ref(false)
const rootEl = ref(null)
const inputEl = ref(null)
const listEl = ref(null)
const vpEl = ref(null)
const act = ref('')                                          // 高亮条目 id（键盘 / 悬停共用一个）
const scope = shallowRef(null)                               // 检索范围（进入的卫星集）{ id, name, lit, icon } | null
// 根视图
const loc = shallowRef({ st: null, pt: null, tj: null, pg: null, sat: null, sets: null })   // 同步部分：地球站 / 点标记 / 航迹 / Polygon / 常用卫星 / 卫星集
const satHits = shallowRef(null)                             // 有词时：全量卫星检索 { items, total }
const cityHits = shallowRef(null)                            // 有词时：城市库 { items, total }
const satBusy = ref(false), cityBusy = ref(false)
// 卫星集视图
const sv = shallowRef(null)                                  // { items, total, n, visN, nb } | null（未到）
const svBusy = ref(false)
const svErr = ref('')
const scrollTop = ref(0)
let seq = 0, timer = 0, queued = false
let tok = { dead: true }   // 本次刷新的作废令牌：新一次刷新把上一次的置 dead，源里分片算星位的循环据此提前收工
let pendEnter = false      // 检索还在路上就按了 Enter：结果回来后取第一条可选的（打字快的人不必等列表）

const kw = computed(() => q.value.trim())
const busy = computed(() => (scope.value ? svBusy.value : (satBusy.value || cityBusy.value)))
const groups = computed(() => {
  if (scope.value) return []
  const L = loc.value, out = []
  const add = (key, label, r) => { if (r && r.items && r.items.length) out.push({ key, label, items: r.items, shown: r.items.length, total: r.total }) }
  add('st', '地球站', L.st)
  add('pt', '点标记', L.pt)
  add('tj', byLang('航迹', 'Tracks'), L.tj)   // 全局词典里「航迹」是卫星星下点轨迹（Ground Track），这里是载具航迹：按界面语言直接出字
  add('pg', 'Polygon', L.pg)
  if (kw.value) {
    add('city', '城市库', cityHits.value)
    add('set', '卫星集', L.sets)
    const h = satHits.value
    if (h && h.items.length) {
      // 命中多于列出的：末尾一行「全部 N 颗」进全量表（带着检索词）
      const items = h.total > h.items.length ? h.items.concat([{ id: 'more', kind: 'more', n: h.total, dis: '' }]) : h.items
      out.push({ key: 'sat', label: '卫星', items, shown: h.items.length, total: h.total })
    }
  } else {
    add('sat', '常用卫星', L.sat)
    add('set', '卫星集', L.sets)
  }
  return out
})
const countText = (g) => (g.total > g.shown ? fmtN(g.shown) + '/' + fmtN(g.total) : fmtN(g.shown))
// 键盘与高亮所走的那一串条目（根视图 = 各组摊平；卫星集视图 = 该集命中表）
const rows = computed(() => (scope.value ? (sv.value ? sv.value.items : []) : groups.value.flatMap((g) => g.items)))
const enabled = computed(() => rows.value.filter((it) => !it.dis))
const rowIdx = computed(() => { const m = new Map(); rows.value.forEach((it, i) => m.set(it.id, i)); return m })
const enIdx = computed(() => { const m = new Map(); enabled.value.forEach((it, i) => m.set(it.id, i)); return m })
const actItem = computed(() => { const i = act.value ? rowIdx.value.get(act.value) : undefined; return i == null ? null : rows.value[i] })
// 卫星集视图的虚拟窗口
const total = computed(() => rows.value.length)
const vpH = computed(() => Math.max(1, Math.min(VP_ROWS, total.value)) * ROW_H)
const start = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_H) - OVERSCAN))
const end = computed(() => Math.min(total.value, Math.ceil((scrollTop.value + vpH.value) / ROW_H) + OVERSCAN))
// 渲染行：根视图 = 组头 + 条目（全量渲染，组头吸顶）；卫星集视图 = 视口内那几行
const visRows = computed(() => {
  if (scope.value) return rows.value.slice(start.value, end.value).map((it) => ({ key: it.id, it }))
  const out = []
  for (const g of groups.value) { out.push({ key: 'h:' + g.key, h: g }); for (const it of g.items) out.push({ key: it.id, it }) }
  return out
})
const scopeCount = computed(() => {
  const r = sv.value
  if (!r) return ''
  return (r.n < r.total ? fmtN(r.n) + ' / ' + fmtN(r.total) : fmtN(r.total)) + ' 颗'
})
const isNav = (it) => !!it && (it.kind === 'set' || it.kind === 'more')
const rowTitle = (it) => it.dis || (it.kind === 'city' ? '新建地球站' : it.kind === 'sat' ? it.name + (it.norad ? ' · NORAD ' + it.norad : '') : it.kind === 'set' ? (it.tip || undefined) : undefined)

// 直接赋值即可：Chromium 每帧最多派发一次 scroll，Vue 调度器又把同帧多次改动并成一次重渲染（勿改 rAF 节流：窗口不可见时不触发）
function onScroll() { if (vpEl.value) scrollTop.value = vpEl.value.scrollTop }
function resetScroll() { scrollTop.value = 0; if (vpEl.value) vpEl.value.scrollTop = 0 }

function newTok() { tok.dead = true; tok = { dead: false }; return tok }
function land() {
  fixAct()
  if (!pendEnter || busy.value) return
  pendEnter = false
  const it = enabled.value[0]
  if (it) activate(it)
}
function refresh() {
  const s = kw.value, nb = props.nbrs || {}
  const src = props.source
  clearTimeout(timer)
  const my = ++seq, tk = newTok()
  pendEnter = false
  if (scope.value) { refreshScope(my, tk, s, nb); return }
  const g = src.ground(s, nb)
  loc.value = { st: g ? g.st : null, pt: g ? g.pt : null, tj: g ? g.tj : null, pg: g ? g.pg : null, sat: s ? null : src.satsLocal(nb), sets: src.sets ? src.sets(s) : null }
  if (!s) { satHits.value = null; cityHits.value = null; satBusy.value = false; cityBusy.value = false; fixAct(); return }
  satBusy.value = true; cityBusy.value = !!g
  satHits.value = null; cityHits.value = null
  fixAct()
  timer = setTimeout(() => {
    src.satsSearch(s, nb, tk).then((r) => { if (my === seq && r) { satHits.value = r; satBusy.value = false; land() } })
      .catch(() => { if (my === seq) { satHits.value = { items: [], total: 0 }; satBusy.value = false; land() } })
    if (g) {
      src.cities(s, nb).then((r) => { if (my === seq) { cityHits.value = r; cityBusy.value = false; land() } })
        .catch(() => { if (my === seq) { cityHits.value = { items: [], total: 0 }; cityBusy.value = false; land() } })
    }
  }, 160)
}
// 卫星集视图：换集 / 换位立刻算；同一集里打字稍等一拍（检索在本地，只是不必每个键都排一遍几万条）。
// 新表到之前旧表照显示（不闪「加载中」），到了回到顶部
function refreshScope(my, tk, s, nb) {
  const id = scope.value.id
  svBusy.value = true
  const run = () => props.source.scopeList(id, s, nb, tk).then((r) => {
    if (my !== seq || tk.dead) return
    sv.value = r || { items: [], total: 0, n: 0, visN: 0, nb: false }   // null 且没被作废 = 该集已不在（删了）：按空集显示
    svErr.value = ''; svBusy.value = false
    resetScroll()
    land()
  }).catch((e) => {
    if (my !== seq) return
    svBusy.value = false
    svErr.value = '加载失败：' + ((e && e.message) || String(e))
  })
  if (s && sv.value) timer = setTimeout(run, 90)
  else run()
}
// 同一拍里检索词、范围与插入位一起变（选中后清词 + 光标后移）只算一遍
function queueRefresh() {
  if (queued) return
  queued = true
  Promise.resolve().then(() => { queued = false; if (open.value) refresh() })
}
// 高亮跟着列表走：原来那条还在且可选就留着；有检索词时落到第一条可选的（Enter 直接取它），空词不预选
function fixAct() {
  if (act.value && enIdx.value.has(act.value)) return
  const en = enabled.value
  act.value = kw.value && en.length ? en[0].id : ''
}
watch(q, queueRefresh)
watch(() => props.sig, queueRefresh)
// 只有能放进链路的条目才预览（卫星集 / 「全部 N 颗」是导航行）
watch([actItem, open], ([it, o]) => emit('hover', o && it && !isNav(it) ? it : null))

// 进入 / 退出检索范围。keepQ：从「全部 N 颗」进来时带着检索词
function enterScope(it, keepQ) {
  if (!it) return
  let s
  if (it.kind === 'more') {
    const all = ((loc.value.sets && loc.value.sets.items) || []).find((x) => x.sid === '*')
    s = { id: '*', name: all ? all.name : '全部卫星', lit: all ? all.lit : true, icon: (all && all.icon) || 'globe' }
  } else s = { id: it.sid, name: it.name, lit: it.lit, icon: it.icon || 'layers' }
  scope.value = s
  sv.value = null; svErr.value = ''
  act.value = ''
  if (!keepQ) q.value = ''
  resetScroll()
  queueRefresh()
  focus()
  nextTick(reveal)
}
function exitScope() {
  if (!scope.value) return
  scope.value = null
  sv.value = null; svErr.value = ''; svBusy.value = false
  act.value = ''
  resetScroll()
  queueRefresh()
}
function onTokX() { exitScope(); focus() }

function onFocus() { open.value = true; refresh(); nextTick(reveal) }
function onBlur() {
  open.value = false
  clearTimeout(timer); seq++; newTok()
  satBusy.value = false; cityBusy.value = false; svBusy.value = false; pendEnter = false
  if (props.mode === 'rep') emit('close')
}
function focus() { const el = inputEl.value; if (el && document.activeElement !== el) el.focus({ preventScroll: false }) }
defineExpose({ focus })
// 侧栏里这一位可能在视口下沿：展开后把整块（检索框 + 列表）滚进来
function reveal() { const el = rootEl.value; if (el && el.scrollIntoView) { try { el.scrollIntoView({ block: 'nearest' }) } catch { /* 老环境无此参数 */ } } }
// 点检索框空白处（范围标签旁）也聚焦输入
function onBoxDown(e) { if (e.target === inputEl.value) return; e.preventDefault(); focus() }

function move(d, page) {
  const en = enabled.value
  if (!en.length) return
  let i = act.value ? enIdx.value.get(act.value) : undefined
  if (i == null) i = d > 0 ? 0 : en.length - 1
  else if (page) i = Math.max(0, Math.min(en.length - 1, i + d))
  else i = (i + d + en.length) % en.length
  act.value = en[i].id
  showAct()
}
// 高亮行滚进视口：卫星集视图按行号换算（不在 DOM 里的行也能到），根视图交给浏览器（组头吸顶由 scroll-margin 让位）
function showAct() {
  const id = act.value
  if (!id) return
  if (scope.value) {
    const el = vpEl.value, i = rowIdx.value.get(id)
    if (!el || i == null) return
    const top = i * ROW_H, bot = top + ROW_H
    if (top < el.scrollTop) el.scrollTop = top
    else if (bot > el.scrollTop + el.clientHeight) el.scrollTop = bot - el.clientHeight
    scrollTop.value = el.scrollTop
    return
  }
  nextTick(() => {
    const box = listEl.value, el = box && box.querySelector('#' + optId(id))
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' })
  })
}
// 插入位选中后：清词、回到第一层（下一个节点多半换类别：站 → 星 → 站），接着挑下一个
function pick(it) {
  emit('pick', it)
  if (props.mode === 'ins') { q.value = ''; act.value = ''; exitScope() }
}
// 条目被选：导航行进范围，其余交给宿主
function activate(it) {
  if (!it || it.dis) return
  if (isNav(it)) { enterScope(it, it.kind === 'more'); return }
  pick(it)
}
const caretAtEnd = () => { const el = inputEl.value; return !el || (el.selectionStart === el.value.length && el.selectionEnd === el.value.length) }
function onKey(e) {
  if (e.isComposing) return
  const k = e.key
  if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); if (!open.value) onFocus(); move(k === 'ArrowDown' ? 1 : -1); return }
  if (k === 'PageDown' || k === 'PageUp') { if (!open.value) return; e.preventDefault(); move((k === 'PageDown' ? 1 : -1) * (VP_ROWS - 1), true); return }
  if (k === 'Enter') {
    e.preventDefault()
    const it = actItem.value && !actItem.value.dis ? actItem.value : (kw.value ? enabled.value[0] : null)
    if (it) activate(it)
    else if (kw.value && busy.value) pendEnter = true
    else if (!kw.value && props.mode === 'ins' && props.drawing) emit('finish')
    return
  }
  // 停在卫星集行上：Tab / →（光标在词尾）= 进入该集（同 GitHub 命令面板 Tab 收窄范围）
  if ((k === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey) || k === 'ArrowRight') {
    const it = actItem.value
    if (open.value && isNav(it) && (k === 'Tab' || caretAtEnd())) { e.preventDefault(); enterScope(it, it.kind === 'more') }
    return
  }
  if (k === 'ArrowLeft') { if (scope.value && !q.value) { e.preventDefault(); exitScope() } return }
  if (k === 'Escape') {
    e.preventDefault(); e.stopPropagation()
    if (q.value) q.value = ''
    else if (scope.value) exitScope()
    else { const el = inputEl.value; if (el) el.blur() }
    return
  }
  // 空词 Backspace = 退出范围 / 撤销上一节点。★ 按住时的自动连发不算：按住 Backspace 删检索词，删空之后的连发
  // 会接着退出范围、再一个接一个撤节点 —— 结构性的动作要单独按一下
  if (k === 'Backspace' && !q.value) {
    if (e.repeat) { if (scope.value || (props.mode === 'ins' && props.drawing)) e.preventDefault(); return }
    if (scope.value) { e.preventDefault(); exitScope(); return }
    if (props.mode === 'ins' && props.drawing) { e.preventDefault(); emit('undo') }
  }
}

onMounted(() => { if (props.autofocus) nextTick(focus) })
onBeforeUnmount(() => { clearTimeout(timer); seq++; newTok(); if (open.value) emit('hover', null) })
</script>

<template>
  <div ref="rootEl" class="lnp" :class="['m-' + mode, { open, scoped: !!scope }]">
    <div class="lnp-in search-field" @mousedown="onBoxDown">
      <Icon name="search" :size="12" class="lnp-si" />
      <span v-if="scope" class="lnp-tok" :title="scope.name">
        <Icon :name="scope.icon || 'layers'" :size="12" class="lnp-toki" />
        <span class="lnp-tokn" :data-i18n-skip="scope.lit ? undefined : ''">{{ scope.name }}</span>
        <button type="button" class="lnp-tokx" title="清除检索范围" aria-label="清除检索范围" @mousedown.prevent.stop @click.stop="onTokX"><Icon name="x" :size="12" /></button>
      </span>
      <input
        ref="inputEl" v-model="q" class="lnp-q" type="text" spellcheck="false" autocomplete="off"
        role="combobox" aria-autocomplete="list" :aria-expanded="open ? 'true' : 'false'" :aria-controls="uid"
        :aria-activedescendant="open && act ? optId(act) : undefined" :placeholder="scope ? '搜索名 / 编号' : placeholder"
        @focus="onFocus" @blur="onBlur" @keydown="onKey"
      />
    </div>
    <div v-if="open" :id="uid" ref="listEl" class="lnp-list" role="listbox" @mousedown.prevent>
      <!-- 卫星集视图：集内颗数（检索时为命中 / 全部）· 此刻可见颗数；重算中右侧转圈 -->
      <div v-if="scope" class="lnp-gh lnp-sh" role="presentation">
        <span>{{ scopeCount }}</span>
        <span v-if="sv && sv.nb">此刻可见 {{ fmtN(sv.visN) }}</span>
        <span v-if="svBusy && sv" class="lnp-spin" aria-hidden="true"></span>
      </div>
      <div
        v-if="!scope || (sv && sv.items.length)" ref="vpEl" class="lnp-vp" :class="{ virt: !!scope }"
        :style="scope ? { height: vpH + 'px' } : null" @scroll.passive="onScroll"
      >
        <div :class="{ 'lnp-sp': !!scope }" :style="scope ? { height: total * ROW_H + 'px' } : null">
          <div :class="{ 'lnp-win': !!scope }" :style="scope ? { transform: 'translateY(' + start * ROW_H + 'px)' } : null">
            <template v-for="r in visRows" :key="r.key">
              <div v-if="r.h" class="lnp-gh" role="presentation"><span>{{ r.h.label }}</span><span class="lnp-gn" data-i18n-skip>{{ countText(r.h) }}</span></div>
              <div
                v-else :id="optId(r.it.id)" class="lnp-it" role="option"
                :class="['k-' + r.it.kind, { act: r.it.id === act, dis: !!r.it.dis, cur: r.it.cur, sep: r.it.sep }]"
                :aria-selected="r.it.id === act ? 'true' : 'false'" :aria-disabled="r.it.dis ? 'true' : undefined"
                :title="rowTitle(r.it)"
                @mouseenter="!r.it.dis && (act = r.it.id)" @click="activate(r.it)"
              >
                <template v-if="r.it.kind === 'set'">
                  <Icon :name="r.it.icon || 'layers'" :size="12" class="lnp-ic" />
                  <span class="lnp-nm grow" :data-i18n-skip="r.it.lit ? undefined : ''">{{ r.it.name }}</span>
                  <span class="lnp-cnt" data-i18n-skip>{{ fmtN(r.it.count) }}</span>
                  <Icon name="chevron-right" :size="12" class="lnp-chev" />
                </template>
                <template v-else-if="r.it.kind === 'more'">
                  <span class="lnp-nm grow lnp-mo">全部 {{ fmtN(r.it.n) }} 颗</span>
                  <Icon name="chevron-right" :size="12" class="lnp-chev" />
                </template>
                <template v-else>
                  <Icon :name="r.it.icon || ICON[r.it.kind] || 'circle'" :size="12" class="lnp-ic" />
                  <span class="lnp-nm" data-i18n-skip>{{ r.it.name }}</span>
                  <span v-if="r.it.kind === 'sat'" class="lnp-sub"><span v-if="r.it.slot" data-i18n-skip>{{ r.it.slot }}</span><span v-else-if="r.it.orb">{{ r.it.orb }}</span><span v-if="r.it.tag">{{ r.it.tag }}</span><span v-if="r.it.norad" data-i18n-skip>NORAD {{ r.it.norad }}</span></span>
                  <span v-else class="lnp-sub" data-i18n-skip>{{ r.it.sub }}</span>
                  <span v-if="r.it.rd" class="lnp-rd" :class="{ off: r.it.off }" :title="r.it.rdTitle">{{ r.it.rd }}</span>
                </template>
              </div>
            </template>
          </div>
        </div>
      </div>
      <template v-if="scope">
        <div v-if="svErr" class="lnp-e err">{{ svErr }}</div>
        <div v-else-if="!sv" class="lnp-e">加载中…</div>
        <div v-else-if="!sv.items.length" class="lnp-e">{{ sv.total ? '无匹配项。' : '暂无卫星。' }}</div>
      </template>
      <template v-else>
        <div v-if="busy" class="lnp-e">搜索中…</div>
        <div v-else-if="!rows.length" class="lnp-e">无匹配项。</div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.lnp { min-width: 0; }
.lnp-in {
  display: flex; align-items: center; gap: 5px; height: var(--h-ctl); padding: 0 6px; cursor: text;
  border: 1px solid var(--field-border); border-radius: var(--r-ctl); background: var(--field-bg);
}
.lnp-in:hover { border-color: var(--field-border-hover); }
.lnp.open .lnp-in { border-color: var(--focus-ring); box-shadow: var(--focus-halo); }
.lnp-si { flex: none; color: var(--text-faint); }
/* 输入框外观交给外层壳：controls.css 给裸 input 的边框 / 底色 / 高度在这里全部让位 */
.lnp-in .lnp-q {
  flex: 1; min-width: 48px; height: 100%; padding: 0; margin: 0;
  border: 0; outline: 0; box-shadow: none; background: transparent;
  color: var(--text); font: inherit; font-size: var(--fs-3);
}
/* 检索范围标签（GitHub 命令面板的作用域标签）：机位色淡底，名字过长省略，× 退出范围 */
.lnp-tok {
  flex: 0 1 auto; min-width: 0; max-width: 58%; display: inline-flex; align-items: center; gap: 3px;
  height: 18px; padding: 0 1px 0 5px; border-radius: var(--r-ctl);
  background: var(--accent-ui-weak); color: var(--accent-ui); font-size: var(--fs-2); cursor: default;
}
.lnp-toki { flex: none; }
.lnp-tokn { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lnp-tokx {
  flex: none; display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px; padding: 0; margin: 0;
  border: 0; border-radius: var(--r-ctl); background: transparent; color: inherit; opacity: .7; cursor: pointer;
}
.lnp-tokx:hover { opacity: 1; background: color-mix(in srgb, var(--accent-ui) 18%, transparent); }
.lnp-list {
  margin-top: 3px; border: 1px solid var(--border); border-radius: var(--r-ctl); background: var(--bg); overflow: hidden;
}
/* 根视图：整块滚动、组头吸顶；卫星集视图：定高视口 + 撑高占位 + 平移窗口（虚拟滚动） */
.lnp-vp { max-height: 300px; overflow-y: auto; overscroll-behavior: contain; }
.lnp-vp.virt { max-height: none; }
.lnp-sp { position: relative; }
.lnp-win { position: absolute; top: 0; left: 0; right: 0; will-change: transform; }
.lnp-gh {
  position: sticky; top: 0; z-index: 1; display: flex; align-items: center; height: 20px; padding: 0 8px;
  background: var(--surface-2); color: var(--text-faint); font-size: var(--fs-1); letter-spacing: var(--ls-label);
}
.lnp-gn { margin-left: auto; font-family: var(--font-mono); letter-spacing: 0; }
/* 卫星集视图的读数头：颗数 · 此刻可见（数字等宽） */
.lnp-sh { position: static; gap: 10px; border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent); font-variant-numeric: tabular-nums; letter-spacing: 0; }
.lnp-spin {
  margin-left: auto; width: 10px; height: 10px; border-radius: 50%; box-sizing: border-box;
  border: 2px solid color-mix(in srgb, var(--text) 18%, transparent); border-top-color: var(--accent-ui);
  animation: ui-spin .7s linear infinite;
}
.lnp-it {
  display: flex; align-items: center; gap: 6px; height: 24px; box-sizing: border-box; padding: 0 8px;
  cursor: pointer; font-size: var(--fs-3); scroll-margin-top: 20px;
}
.lnp-it.sep { border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent); }
.lnp-it.act { background: var(--accent-ui-weak); }
.lnp-it.dis { cursor: default; opacity: .45; }
.lnp-ic { flex: none; color: var(--text-muted); }
.lnp-it.act .lnp-ic, .lnp-it.act .lnp-chev { color: var(--accent-ui); }
.lnp-nm { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.lnp-nm.grow { flex: 1 1 auto; }
.lnp-it.cur .lnp-nm { color: var(--accent-ui); font-weight: 600; }
.lnp-sub { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-2); color: var(--text-faint); }
.lnp-sub > span + span::before { content: ' · '; }
.lnp-rd { flex: none; font-family: var(--font-mono); font-size: var(--fs-2); color: var(--text-muted); font-variant-numeric: tabular-nums; }
.lnp-rd.off { color: var(--warn); }
/* 卫星集行：颗数右对齐等宽 + 进入箭头 */
.lnp-cnt { flex: none; font-family: var(--font-mono); font-size: var(--fs-2); color: var(--text-faint); font-variant-numeric: tabular-nums; }
.lnp-chev { flex: none; color: var(--text-faint); }
.lnp-mo { color: var(--accent); }
.lnp-e { padding: 6px 8px; font-size: var(--fs-3); color: var(--text-faint); }
.lnp-e.err { color: var(--danger); }
</style>
