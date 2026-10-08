<script setup>
// 卫星页「选择卫星」：一个组合框（combobox）——搜索框 + 下拉列表，四路来源分组列出：
//   已绑定（绑定表里有记录的星）· 卫星天线树（星座 3D 页的 GRD 卫星树）· 链路预算（四窗卫星库条目）·
//   编目（与 NGSO / 端到端「搜索卫星」同一份共享候选池；输入后才列，池子单独转圈，不挡别的组）。
// 同一颗星（同一个绑定键）只列一次，hint 取各来源并集；键规则、去重与筛选口径在 satPickLogic.js（与 3D 页对同一颗星给同一个键）。
// 交互：聚焦 / 点击 / 打字展开，右侧箭头展开 / 收起；↑↓ 移动、Enter 选中、Esc 收起（焦点留在输入框）、Tab / 点外面 / 窗口失焦收起。
// 3D 页「编辑…」带 satKey 打开工作台时直接选中（satStore.selectSat 自己回填名字与 hint），不经这里。
// ★ 列表 Teleport 到 body、position: fixed 按输入框矩形摆：左栏层层 overflow，留在原位会被裁；
//   滚动（捕获阶段，任一祖先滚都算）/ 改窗口大小时重摆，输入框滚出视口就收起。
import { ref, shallowRef, computed, inject, watch, nextTick, onMounted, onBeforeUnmount, onDeactivated } from 'vue'
import Icon from '../../components/Icon.vue'
import MdSec from '../MdSec.vue'
import { catalogPool, catalogPoolStale, invalidateCatalogPool, searchPool, lbLibrarySats, grdTreeSats } from '../satSources.js'
import { treeRows, treeKeyOf, treeKeyNeedsPool, lbRows, boundRows, catalogRows, mergeGroups, CAT_MAX } from '../satPickLogic.js'
import { keyLabel } from '../satStore.js'
import { byLang } from '../../shared/i18n/lang.js'

const sat = inject('sat')
const S = sat.st

const q = ref('')
const qt = computed(() => q.value.trim())
const open = ref(false)
const active = ref(-1)      // 键盘 / 悬停高亮行（扁平序号）；当前选中的星另用 .on 标
const boxEl = ref(null), inEl = ref(null), popEl = ref(null), listEl = ref(null)

// ───────── 数据：树 / 已绑定同步取；库每次展开重读；候选池首次展开时建（之后常驻） ─────────
const pool = shallowRef(null), poolBusy = ref(false), poolErr = ref('')
const lbList = shallowRef([]), treeList = shallowRef([])
let poolP = null
/** 候选池（建好了直接给；在建就等同一次；失败给 null） */
function ensurePool() {
  if (pool.value) return Promise.resolve(pool.value)
  if (!poolP) {
    poolBusy.value = true; poolErr.value = ''
    poolP = catalogPool()
      .then((p) => { pool.value = p; return p }, (e) => { poolErr.value = (e && e.message) || String(e); return null })
      .finally(() => { poolBusy.value = false; poolP = null })
  }
  return poolP
}
let lbSeq = 0
async function loadLb() {
  const s = ++lbSeq
  let v = []
  try { v = await lbLibrarySats() } catch { v = [] }
  if (s === lbSeq) lbList.value = v
}
function loadTree() { try { treeList.value = grdTreeSats() } catch { treeList.value = [] } }
onMounted(() => { if (!S.loaded) sat.loadAll() })

const boundR = computed(() => boundRows(sat.boundList.value))
const treeR = computed(() => treeRows(treeList.value, pool.value && pool.value.byNorad))
const lbR = computed(() => lbRows(lbList.value))
const catHits = computed(() => (pool.value && qt.value ? searchPool(pool.value, qt.value, CAT_MAX) : []))
const catR = computed(() => catalogRows(catHits.value))
// 分组 + 扁平序号（r.i：键盘导航 / aria-activedescendant 用；mergeGroups 每次给新行对象，就地编号不污染来源）
const groups = computed(() => {
  const gs = mergeGroups({ bound: boundR.value, tree: treeR.value, lb: lbR.value, cat: catR.value }, qt.value)
  let i = 0
  for (const g of gs) for (const r of g.rows) r.i = i++
  return gs
})
const flat = computed(() => groups.value.flatMap((g) => g.rows))
const catPending = computed(() => !!qt.value && poolBusy.value)
const countOf = (g) => (g.key === 'cat' && catHits.value.length >= CAT_MAX ? g.rows.length + '+' : String(g.rows.length))
// 结果集变了（按键序列比，库重读出来同样的一批不算）：有搜索词时高亮第一条（Enter 即选它），空框不预选
const sig = computed(() => flat.value.map((r) => r.key).join('|'))
watch(sig, () => { active.value = qt.value && flat.value.length ? 0 : -1 })

// ───────── 位置 ─────────
const GAP = 3, PAD = 6
const pos = ref({}), up = ref(false)
// 输入框是否还看得见：视口与各级滚动祖先（左栏）的可视区求交——滚到左栏顶边外面时列表不该悬空挂着
function boxVisible(el, r) {
  if (!r.width || r.bottom <= 0 || r.top >= window.innerHeight) return false
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p)
    if (cs.overflowY === 'visible' && cs.overflowX === 'visible') continue
    const c = p.getBoundingClientRect()
    if (r.bottom <= c.top || r.top >= c.bottom) return false
  }
  return true
}
function place() {
  const el = boxEl.value
  if (!el || !open.value) return
  const r = el.getBoundingClientRect()
  const vw = window.innerWidth, vh = window.innerHeight
  if (!boxVisible(el, r)) { close(); return }   // 节被折叠 / 输入框滚出左栏或视口
  const cap = Math.min(vh * 0.5, 360)
  const below = vh - r.bottom - GAP - PAD, above = r.top - GAP - PAD
  const goUp = below < Math.min(cap, 160) && above > below        // 下方放不下一截像样的列表、上方更宽才朝上开
  const w = Math.min(r.width, vw - 2 * PAD)
  const left = Math.max(PAD, Math.min(r.left, vw - w - PAD))
  up.value = goUp
  pos.value = {
    left: left + 'px', width: w + 'px', maxHeight: Math.max(60, Math.min(cap, goUp ? above : below)) + 'px',
    ...(goUp ? { bottom: (vh - r.top + GAP) + 'px' } : { top: (r.bottom + GAP) + 'px' })
  }
}
function onScroll(e) { if (popEl.value && e.target instanceof Node && popEl.value.contains(e.target)) return; place() }

// ───────── 开合 ─────────
let quiet = false     // 程序交还焦点时的 focus 不算「点进来」
let resume = false    // 窗口失焦那一刻焦点在输入框：切回窗口时那一下 focus 不展开
function show() {
  if (open.value) return
  open.value = true
  if (pool.value && catalogPoolStale()) pool.value = null   // 星座页改过自定义星座：池按新的重建（合成号关联星的键跟着变）
  loadTree(); loadLb(); ensurePool()
  active.value = qt.value && flat.value.length ? 0 : -1
  // 滚到当前那颗要等 place() 给的 max-height 落到 DOM（下一拍）；同一拍里列表还没限高、不可滚，scrollTop 会被夹成 0
  nextTick(() => { place(); nextTick(scrollToCurrent) })
}
function close(refocus = false) {
  if (!open.value) return
  open.value = false
  active.value = -1
  dropWait()
  if (refocus) focusInput()
}
function focusInput() {
  const el = inEl.value
  if (!el || document.activeElement === el) return
  quiet = true
  try { el.focus({ preventScroll: true }) } finally { quiet = false }
}
function onFocus() { if (resume) { resume = false; return } if (!quiet) show() }
function toggle() { if (open.value) close(); else { focusInput(); show() } }
function clearQ() { q.value = ''; focusInput(); show() }
// 点在框里的空白 / 放大镜上：焦点给输入框并展开（按钮与输入框自己处理）
function onBoxDown(e) {
  const t = e.target
  if (t === inEl.value || (t && t.closest && t.closest('button'))) return
  e.preventDefault(); focusInput(); show()
}
// 关联合成号（≥ 800000）的树节点：键是候选池里那条的 cc: / ephem: 键，池没好时 treeKeyOf 只能给临时的 name:<星名>——
// 拿它绑定，3D 页（按自定义星座 / 星历条目认键）读不到。这种行点下去先等池（行上转圈），按池重算出键与 hint 再选；
// 等的时候列表收起、改了搜索词或又点了别的行，这一次作废。关联目录号（< 800000）的键不变，直接选，poolRec / 区制由 selectSat 回填
const waitKey = ref('')
let pickSeq = 0
function dropWait() { pickSeq++; waitKey.value = '' }
watch(q, () => { if (waitKey.value) dropWait() })
async function pick(r) {
  if (!r) return
  const seq = ++pickSeq
  const node = r.hint && r.hint.treeNode
  // 池在但查不到这个合成号（池建好之后才导入的星历 / 新建的星座）：作废重建一次再算键
  const miss = !!pool.value && treeKeyNeedsPool(node) && !(pool.value.byNorad && pool.value.byNorad.has(String(node.noradId)))
  if (miss) { invalidateCatalogPool(); pool.value = null }
  if (!pool.value && treeKeyNeedsPool(node)) {
    waitKey.value = r.key
    const p = await ensurePool()
    if (seq !== pickSeq) return
    waitKey.value = ''
    const k = treeKeyOf(node, p && p.byNorad)
    r = flat.value.find((x) => x.key === k) || treeRows([node], p && p.byNorad)[0] || r
  }
  sat.selectSat({ satKey: r.key, label: r.name, hint: r.hint })
  q.value = ''
  close(true)
}

// ───────── 键盘 ─────────
function onKey(e) {
  if (e.isComposing || e.keyCode === 229) return     // 输入法组字中的方向键 / 回车 / Esc 归输入法
  const k = e.key
  if (k === 'Escape') { if (open.value) { e.preventDefault(); e.stopPropagation(); close(true) } return }
  if (k === 'Tab') { close(); return }
  if (k === 'ArrowDown' || k === 'ArrowUp') {
    e.preventDefault()
    if (!open.value) { show(); return }
    const n = flat.value.length
    if (!n) return
    active.value = k === 'ArrowDown' ? (active.value + 1) % n : (active.value <= 0 ? n - 1 : active.value - 1)
    scrollActive()
    return
  }
  if (k === 'Enter' && open.value) {
    e.preventDefault()
    pick(flat.value[active.value] || (qt.value ? flat.value[0] : null))
  }
}
function scrollActive() {
  nextTick(() => {
    const el = listEl.value && listEl.value.querySelector('#spk-o' + active.value)
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' })
  })
}
// 展开时当前那颗星滚到列表中部（空框时它多半在某组深处，看不到等于没标）
function scrollToCurrent() {
  const sc = listEl.value
  const on = sc && sc.querySelector('.spk-row.on')
  if (on) sc.scrollTop = Math.max(0, on.offsetTop - sc.clientHeight / 2 + on.offsetHeight / 2)
}

// ───────── 收起的几条路：点外面 / 窗口失焦 / 页签切走 ─────────
function onDocDown(e) {
  const t = e.target
  if ((boxEl.value && boxEl.value.contains(t)) || (popEl.value && popEl.value.contains(t))) return
  close()
}
function onWinBlur() { resume = !!inEl.value && document.activeElement === inEl.value; close() }
function onWinFocus() { setTimeout(() => { resume = false }, 0) }
watch(open, (v) => {
  const f = v ? 'addEventListener' : 'removeEventListener'
  document[f]('mousedown', onDocDown, true)
  window[f]('resize', place)
  window[f]('scroll', onScroll, true)
})
onMounted(() => { window.addEventListener('blur', onWinBlur); window.addEventListener('focus', onWinFocus) })
onDeactivated(() => close())
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocDown, true)
  window.removeEventListener('resize', place)
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('blur', onWinBlur)
  window.removeEventListener('focus', onWinFocus)
})

// 输入框带 data-i18n-skip（占位符是卫星名，不该进词典查），界面词改走 byLang
const ph = () => (S.satKey ? (S.label || keyLabel(S.satKey)) : byLang('搜索卫星', 'Search satellites'))
const tip = () => [S.satKey, byLang('名称、常用名、NORAD 编号（不区分大小写、空格与连字符）', 'Name, alias or NORAD ID (case, spaces and hyphens ignored)')].filter(Boolean).join('\n')
</script>

<template>
  <MdSec id="s-pick" title="选择卫星" :summary="S.satKey ? S.label : ''">
    <div ref="boxEl" class="sp-box" :class="{ open, has: !!S.satKey }" @mousedown="onBoxDown">
      <Icon name="search" :size="13" />
      <input
        ref="inEl" v-model="q" class="sp-q" type="text" spellcheck="false" autocomplete="off" data-i18n-skip
        role="combobox" aria-autocomplete="list" aria-controls="spk-list" :aria-expanded="open ? 'true' : 'false'"
        :aria-activedescendant="open && active >= 0 ? 'spk-o' + active : null"
        :placeholder="ph()" :title="tip()" @focus="onFocus" @click="show" @input="show" @keydown="onKey"
      />
      <button v-if="q" type="button" class="sp-ib" tabindex="-1" title="清空" @mousedown.prevent @click="clearQ"><Icon name="x" :size="12" /></button>
      <button type="button" class="sp-ib sp-chev" tabindex="-1" :title="open ? '收起' : '展开'" @mousedown.prevent @click="toggle"><Icon name="chevron-down" :size="13" /></button>
    </div>
    <Teleport to="body">
      <div v-if="open" ref="popEl" class="spk-pop" :class="{ up }" :style="pos" @mousedown.prevent>
        <div id="spk-list" ref="listEl" class="spk-list" role="listbox">
          <template v-for="g in groups" :key="g.key">
            <div class="spk-h" role="presentation"><span>{{ g.title }}</span><span class="spk-h-n" data-i18n-skip>{{ countOf(g) }}</span></div>
            <div
              v-for="r in g.rows" :id="'spk-o' + r.i" :key="r.key" role="option" class="spk-row"
              :class="{ on: r.key === S.satKey, act: r.i === active }" :aria-selected="r.key === S.satKey ? 'true' : 'false'" :title="r.key"
              :aria-busy="waitKey === r.key ? 'true' : null" @mousemove="active = r.i" @click="pick(r)"
            >
              <span class="spk-n" data-i18n-skip>{{ r.name }}</span>
              <span v-if="waitKey === r.key" class="spk-spin"></span>
              <span v-else-if="r.n != null" class="spk-b" :title="'已绑定 · ' + r.n + ' 个挂点'"><Icon name="locate-fixed" :size="11" /><span data-i18n-skip>{{ r.n }}</span></span>
              <span v-if="r.sub" class="spk-s" data-i18n-skip>{{ r.sub }}</span>
            </div>
          </template>
          <template v-if="catPending">
            <div class="spk-h" role="presentation"><span>编目</span></div>
            <div class="spk-busy"><span class="spk-spin"></span></div>
          </template>
          <div v-if="qt && poolErr" class="spk-empty spk-err" :title="poolErr">{{ poolErr }}</div>
          <div v-if="!flat.length && !catPending && !(qt && poolErr)" class="spk-empty"><template v-if="qt">无匹配卫星。</template><template v-else>暂无卫星。</template></div>
        </div>
      </div>
    </Teleport>
  </MdSec>
</template>

<style scoped>
.sp-box { display: flex; align-items: center; gap: 5px; height: var(--h-ctl); padding: 0 1px 0 6px; color: var(--text-faint); cursor: text;
  background: var(--field-bg); border: 1px solid var(--field-border); border-radius: var(--r-ctl); }
/* 焦点环画在整个框上（里头的无框输入框自己不描，免得环缩在框里一截；同 ModelPickPop 的搜索框） */
.sp-box:focus-within { outline: 2px solid var(--accent-ui); outline-offset: -1px; }
.sp-box.open { border-color: var(--accent-ui); }
.sp-q { flex: 1; min-width: 0; height: 100%; border: 0 !important; background: transparent !important; outline: none; padding: 0 !important; font-size: var(--fs-3); color: var(--text); box-shadow: none !important; }
.sp-q:focus, .sp-q:focus-visible { outline: none !important; }
/* 选了星：占位符就是当前值，收起时按正文色读；展开（正在搜）时退成占位色 */
.sp-q::placeholder { color: var(--text-faint); }
.sp-box.has .sp-q::placeholder { color: var(--text); font-weight: 600; }
.sp-box.has.open .sp-q::placeholder { color: var(--text-muted); font-weight: 400; }
.sp-ib { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 20px; height: calc(var(--h-ctl) - 4px); padding: 0;
  border: 0; border-radius: var(--r-box); background: transparent; color: var(--text-faint); cursor: pointer; }
.sp-ib:hover { background: var(--wash-hover); color: var(--text); }
.sp-chev :deep(.app-icon) { transition: transform var(--dur-2) var(--ease-std); }
.sp-box.open .sp-chev { color: var(--text); }
.sp-box.open .sp-chev :deep(.app-icon) { transform: rotate(180deg); }
</style>

<style>
/* 列表 Teleport 出去了：与 TzPicker / ModelPickPop 同一做法写成全局样式，类名一律 spk- 前缀免撞 */
.spk-pop {
  position: fixed; z-index: 2401; display: flex; flex-direction: column; overflow: hidden; padding: 3px;
  background: var(--surface, var(--bg)); border: 1px solid var(--border-strong, var(--border)); border-radius: var(--r-float); box-shadow: var(--shadow-2);
  font-size: var(--fs-3); color: var(--text); animation: ui-float-in var(--dur-2) var(--ease-out);
}
.spk-pop.up { animation-name: ui-float-up; }
.spk-list { position: relative; min-height: 0; overflow-y: auto; }   /* relative：行的 offsetTop 以列表为参照（滚到当前那颗按它算） */
.spk-h {
  position: sticky; top: 0; z-index: 1; display: flex; align-items: baseline; gap: 5px; padding: 5px 7px 2px;
  background: var(--surface, var(--bg)); font-size: var(--fs-2); letter-spacing: var(--ls-label); color: var(--text-faint);
}
.spk-h-n { font-variant-numeric: tabular-nums; letter-spacing: 0; }
.spk-row {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 6px; align-items: baseline; padding: 3px 7px;
  border-radius: var(--r-box); cursor: pointer; scroll-margin-top: 24px;   /* 留出吸顶组标题的高度，↑ 滚上去不被它压住 */
}
.spk-row.act { background: var(--wash-hover); }
.spk-row.on { background: var(--accent-ui-weak); box-shadow: inset 2px 0 0 var(--accent-ui); }
.spk-row.on.act { background: color-mix(in srgb, var(--accent-ui) 24%, transparent); }
.spk-n { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.spk-b { display: inline-flex; align-items: center; gap: 2px; font-size: var(--fs-1); color: var(--accent-ui); font-variant-numeric: tabular-nums; }
.spk-s { grid-column: 1 / -1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-1); color: var(--text-faint); }
.spk-empty { padding: 8px 7px 6px; color: var(--text-faint); }
.spk-err { color: var(--danger); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.spk-busy { display: flex; justify-content: center; padding: 8px 0; }
.spk-spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--text) 18%, transparent); border-top-color: var(--accent-ui); animation: spk-spin .7s linear infinite; }
.spk-row > .spk-spin { align-self: center; width: 10px; height: 10px; }   /* 行内：等候选池算出键（合成号关联星） */
@keyframes spk-spin { to { transform: rotate(360deg); } }
</style>
