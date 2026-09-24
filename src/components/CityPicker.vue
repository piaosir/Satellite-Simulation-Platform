<script setup>
// 选点对话框 —— 对齐 SATSOFT「Add Cities from Database」：左栏选国家 / 省份，右栏列该组全部条目，勾选后一次加入。
// 一份组件三处用：性能指标表 / 气象指标表的「典型城市」（GroundPerfWin / MetTableWin），
// 链路预算三窗 + 雨衰页 StationGrid 的「导入站址」（附加「标记」分区：点标记 / 地球站 / 航迹），
// 端到端窗口站名旁的「典型城市…」（single：点一行即选定并关闭）。
// 城市库全量分层：中国按省份、国际按国家（core.listCitiesGrouped，经 window.api.linkBudget.cityGroups）。
// 搜索框走 core.searchCities（城市名 / 省份 / 拼音首字母 / 英文名 / 国家名），结果跨组列出并标出所属组；
// 宿主附加分区的条目在本地按名字过滤，与城市命中并列。
// 勾选交互与「导入标记」同一份口径（shared/ui/useCheckList.js）：点行翻勾、按住拖刷、Shift 连选、Ctrl+A。
// 对话框壳自带（遮罩 + 标题条 + 页脚），不依赖任何窗口的 CSS：性能表窗口与链路预算窗口的样式链不同。
import { ref, shallowRef, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import Icon from './Icon.vue'
import { useCheckList } from '../shared/ui/useCheckList.js'
import { cityName, citySubtitle } from '../shared/cityName.js'
import { byLang } from '../shared/i18n/lang.js'
import { onLangChange } from '../shared/i18n/runtime.js'

const props = defineProps({
  title: { type: String, default: '典型城市' },
  width: { type: Number, default: 720 },
  // 已在表里的坐标（±1e-4 判同）：列表里标「已加」；dup=false 时不参与勾选、双击也不加
  has: { type: Function, default: () => false },
  // 允许重复加入（链路表同一站址配不同载波是常事）：「已加」只做标记
  dup: { type: Boolean, default: false },
  // 城市库之外的附加分区，排在「中国 / 国际」之后：
  //   [{ label, labelEn, groups: [{ id, name, nameEn, items: [{ id, name, lon, lat, sub? }] }] }]
  extra: { type: Array, default: () => [] },
  // 单选：无勾选框，点一行即 add([条目]) 并 close
  single: { type: Boolean, default: false },
  // 页脚附加读数（宿主的运行时数据，如「本次已加 N 行」）
  note: { type: String, default: '' }
})
const emit = defineEmits(['add', 'close'])
const api = typeof window !== 'undefined' && window.api && window.api.linkBudget ? window.api.linkBudget : null

// ===== 分层城市库 =====
const cityGroups = shallowRef([])   // [{ id, sec:'cn'|'intl', name, nameEn, cities }]
const loading = ref(true)
const cid = (c) => 'c:' + c.name + '@' + Number(c.lon).toFixed(3) + ',' + Number(c.lat).toFixed(3)
onMounted(async () => {
  try {
    const g = api && api.cityGroups ? await api.cityGroups() : null
    if (g && (g.china || g.intl)) {
      cityGroups.value = [
        ...(g.china || []).map((x) => ({ id: 'cn:' + x.province, sec: 'cn', name: x.province, nameEn: x.provinceEn || x.province, cities: x.cities || [] })),
        ...(g.intl || []).map((x) => ({ id: 'intl:' + x.country, sec: 'intl', name: x.country, nameEn: x.countryEn || x.country, cities: x.cities || [] }))
      ]
    } else if (api && api.cities) {
      // 老主进程没有分层接口：整库一组
      const all = await api.cities()
      cityGroups.value = [{ id: 'all', sec: 'cn', name: '全部', nameEn: 'All', cities: all || [] }]
    }
  } catch { cityGroups.value = [] } finally { loading.value = false }
  if (!cur.value && allGroups.value.length) cur.value = allGroups.value[0].id
  nextTick(() => { if (inputEl.value) inputEl.value.focus({ preventScroll: true }) })
})
// 宿主附加分区 → 组（空组不列；坐标不全的条目丢掉）
const extraGroups = computed(() => {
  const out = []
  props.extra.forEach((s, si) => (s.groups || []).forEach((g) => {
    const items = (g.items || []).filter((it) => Number.isFinite(Number(it.lon)) && Number.isFinite(Number(it.lat)))
    if (items.length) out.push({ id: 'x' + si + ':' + g.id, sec: 'x' + si, name: g.name, nameEn: g.nameEn || g.name, items })
  }))
  return out
})
const allGroups = computed(() => [...cityGroups.value, ...extraGroups.value])
const groupById = computed(() => new Map(allGroups.value.map((g) => [g.id, g])))
// 左栏分区：中国 / 国际 / 宿主分区
const sections = computed(() => {
  const out = []
  const cn = cityGroups.value.filter((g) => g.sec === 'cn'), intl = cityGroups.value.filter((g) => g.sec === 'intl')
  if (cn.length) out.push({ key: 'cn', label: '中国', labelEn: 'China', groups: cn })
  if (intl.length) out.push({ key: 'intl', label: '国际', labelEn: 'International', groups: intl })
  props.extra.forEach((s, si) => {
    const gs = extraGroups.value.filter((g) => g.sec === 'x' + si)
    if (gs.length) out.push({ key: 'x' + si, label: s.label, labelEn: s.labelEn || s.label, groups: gs })
  })
  return out
})
// 组内条目归一：{ id, name, sub, lon, lat, src, gid }。城市名按界面语言取（cityName 不是响应式的，换语言重算一遍）
const langTick = ref(0)
onBeforeUnmount(onLangChange(() => { langTick.value++ }))
const groupItems = computed(() => {
  void langTick.value
  const m = new Map()
  for (const g of cityGroups.value) m.set(g.id, g.cities.map((c) => ({ id: cid(c), name: cityName(c), sub: citySubtitle(c), lon: Number(c.lon), lat: Number(c.lat), src: c, gid: g.id })))
  for (const g of extraGroups.value) m.set(g.id, g.items.map((it) => ({ id: 'x:' + g.id + ':' + it.id, name: String(it.name || ''), sub: it.sub || '', lon: Number(it.lon), lat: Number(it.lat), src: it, gid: g.id })))
  return m
})
const itemById = computed(() => { const m = new Map(); for (const list of groupItems.value.values()) for (const it of list) m.set(it.id, it); return m })
const total = computed(() => { let n = 0; for (const list of groupItems.value.values()) n += list.length; return n })
const groupSize = (g) => (groupItems.value.get(g.id) || []).length
const secCount = (s) => s.groups.reduce((n, g) => n + groupSize(g), 0)
const groupLabel = (g) => (g ? byLang(g.name, g.nameEn) : '')
const cur = ref('')             // 左栏当前组
const curGroup = computed(() => groupById.value.get(cur.value) || null)

// ===== 搜索：城市走引擎（跨组），附加分区本地按名字过滤；结果替换右栏 =====
const q = ref('')
const cityHits = shallowRef([])
const busy = ref(false)
const inputEl = ref(null)
let timer = null, seq = 0
// 没有引擎（验证台 / 老主进程）时的本地兜底：中文名 / 英文名 / 国家名
function localCityHits(s) {
  const l = s.toLowerCase(), out = []
  for (const g of cityGroups.value) for (const c of g.cities) {
    if ([c.name, c.en, c.country, c.countryEn, c.py].some((x) => String(x || '').toLowerCase().includes(l))) out.push(c)
  }
  return out
}
watch(q, (v) => {
  clearTimeout(timer)
  const s = String(v || '').trim()
  if (!s) { cityHits.value = []; busy.value = false; seq++; return }
  busy.value = true
  timer = setTimeout(async () => {
    const mine = ++seq
    let r = null
    try { r = api && api.searchCities ? await api.searchCities(s) : null } catch { r = null }
    if (mine !== seq) return
    if (!Array.isArray(r)) r = localCityHits(s)
    // 回查归一条目（同一份 id，勾选跨搜索保持）；引擎命中但分层库里没有的（老主进程）现造一条
    cityHits.value = r.map((c) => itemById.value.get(cid(c)) || { id: cid(c), name: cityName(c), sub: citySubtitle(c), lon: Number(c.lon), lat: Number(c.lat), src: c, gid: '' })
    busy.value = false
  }, 160)
})
const searching = computed(() => q.value.trim() !== '')
const extraHits = computed(() => {
  const s = q.value.trim().toLowerCase()
  if (!s) return []
  const out = []
  for (const g of extraGroups.value) for (const it of (groupItems.value.get(g.id) || [])) if (it.name.toLowerCase().includes(s)) out.push(it)
  return out
})

// ===== 右栏：当前组（或搜索结果）的条目，多选 =====
const rows = computed(() => {
  const src = searching.value ? [...cityHits.value, ...extraHits.value] : (groupItems.value.get(cur.value) || [])
  return src.map((it, i) => ({ ...it, seq: i + 1, had: !!props.has(it.lon, it.lat), grp: searching.value ? groupLabel(groupById.value.get(it.gid)) : '' }))
})
const sel = ref(new Set())       // 跨组保留的勾选集（条目 id）
const listEl = ref(null)
const L = useCheckList({
  rows: () => rows.value,
  idOf: (r) => r.id,
  isOn: (id) => sel.value.has(id),
  current: () => [...sel.value],
  // 已在表里且不许重复的不收（勾了也加不进去，让人误以为会加）
  commit: (ids) => {
    const blocked = props.dup ? null : new Set(rows.value.filter((r) => r.had).map((r) => r.id))
    sel.value = new Set(blocked ? ids.filter((id) => !blocked.has(id)) : ids)
  },
  el: () => listEl.value,
  rowSelector: '.cpk-item',
  headSelector: '.cpk-all'
})
watch([cur, searching], () => L.reset())
const selCount = computed(() => sel.value.size)
const selInView = computed(() => rows.value.reduce((n, r) => n + (sel.value.has(r.id) ? 1 : 0), 0))
const groupSelCount = (g) => { if (!sel.value.size) return 0; let n = 0; for (const it of (groupItems.value.get(g.id) || [])) if (sel.value.has(it.id)) n++; return n }
function pickGroup(id) { cur.value = id; q.value = '' }
// 勾选的条目按组序回查原对象（城市条目 = 城市库原条目，附加分区 = 宿主给的条目）
function srcOf(ids) {
  const out = []
  for (const g of allGroups.value) for (const it of (groupItems.value.get(g.id) || [])) if (ids.has(it.id)) out.push(it.src)
  for (const it of cityHits.value) if (ids.has(it.id) && !itemById.value.has(it.id)) out.push(it.src)
  return out
}
// 把勾选的一次加入，清空勾选，对话框不关，可接着选
function addSelected() {
  if (!sel.value.size) return
  const out = srcOf(sel.value)
  if (out.length) emit('add', out)
  sel.value = new Set()
}
// 双击一行＝单加这一条（保留「即点即入」的手感）
function addOne(r) {
  if (r.had && !props.dup) return
  emit('add', [r.src])
  if (sel.value.has(r.id)) { sel.value.delete(r.id); sel.value = new Set(sel.value) }
}
function pickRow(r) { emit('add', [r.src]); emit('close') }
function onRowDown(e, i) { if (!props.single) L.onRowDown(e, i) }
function onRowClick(r) { if (props.single) pickRow(r) }
function onListKey(e) {
  if (props.single && e.key === 'Enter') { const r = rows.value[L.cur.value]; if (r) pickRow(r); return }
  L.onKey(e)
}
// 搜索框回车：单选取第一条；多选有勾选就加勾选的，没有就加第一条命中
function onSearchKey(e) {
  if (e.key !== 'Enter') return
  e.preventDefault()
  if (props.single) { const r = rows.value[0]; if (r) pickRow(r); return }
  if (sel.value.size) { addSelected(); return }
  if (searching.value) { const r = rows.value.find((x) => !x.had || props.dup); if (r) addOne(r) }
}
// 输入法组字中的 Esc 是「取消组字」，不关对话框（搜索框常打拼音）
function onKey(e) { if (e.key === 'Escape' && !e.isComposing) { e.stopPropagation(); emit('close') } }
onMounted(() => document.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => document.removeEventListener('keydown', onKey, true))
const fx = (v) => Number(v).toFixed(2)
</script>

<template>
  <div class="cpk-mask">
    <div class="cpk-dlg" :style="{ width: width + 'px' }">
      <div class="cpk-hd">
        <span>{{ title }}</span>
        <slot name="head" />
        <button type="button" class="cpk-x" aria-label="关闭" title="关闭" @click="emit('close')"><Icon name="x" :size="12" /></button>
      </div>
      <div class="cpk-body">
        <input ref="inputEl" class="cpk-q" v-model="q" placeholder="搜索：城市名 / 省份 / 拼音首字母 / 英文名 / 国家" @keydown="onSearchKey" />
        <slot name="bar" />
        <div class="cpk-panes">
          <!-- 左：分区 → 国家 / 省份 / 宿主组 -->
          <div class="cpk-left" :class="{ dim: searching }">
            <template v-for="s in sections" :key="s.key">
              <div class="cpk-sec">{{ byLang(s.label, s.labelEn) }}<em>{{ secCount(s) }}</em></div>
              <div v-for="g in s.groups" :key="g.id" class="cpk-grp" :class="{ on: !searching && cur === g.id, sel: groupSelCount(g) > 0 }" @click="pickGroup(g.id)">
                <span class="cpk-gn" data-i18n-skip>{{ groupLabel(g) }}</span>
                <span v-if="groupSelCount(g)" class="cpk-gs">{{ groupSelCount(g) }}</span>
                <span class="cpk-gc">{{ groupSize(g) }}</span>
              </div>
            </template>
            <div v-if="!sections.length && !loading" class="cpk-empty">城市库不可用。</div>
          </div>
          <!-- 右：该组（或搜索结果）的条目，多选 -->
          <div class="cpk-right">
            <div class="cpk-rh">
              <span v-if="searching" class="cpk-rt">{{ busy ? '搜索中…' : `命中 ${rows.length} 座` }}</span>
              <span v-else-if="curGroup" class="cpk-rt" data-i18n-skip>{{ groupLabel(curGroup) }}</span>
              <span class="cpk-cnt">{{ rows.length }} 座</span>
            </div>
            <div ref="listEl" class="cpk-list" :class="{ painting: L.painting.value, single }" tabindex="0"
                 :title="single ? '点一行即选定 · ↑↓ 移动 · Enter 选定' : '点一行翻勾选 · 按住拖＝刷选一片 · Shift 点＝连选一段 · Ctrl+A 全选 · 双击＝直接加入这一座'" @keydown="onListKey">
              <div v-if="!single" class="cpk-row cpk-all" @mousedown="L.onHeadDown">
                <input type="checkbox" :checked="L.allOn()" :indeterminate.prop="L.anyOn() && !L.allOn()" />
                <span class="cpk-alln">{{ searching ? '(全选搜索结果)' : '(全选本组)' }}</span>
                <span class="cpk-pk">{{ selInView }}/{{ rows.length }}</span>
              </div>
              <div v-for="(r, i) in rows" :key="r.id" class="cpk-row cpk-item" :class="{ on: !single && L.isOn(r.id), cur: L.cur.value === i, had: r.had && !dup }"
                   @mousedown="onRowDown($event, i)" @click="onRowClick(r)" @dblclick="!single && addOne(r)">
                <input v-if="!single" type="checkbox" :checked="L.isOn(r.id)" :disabled="r.had && !dup" />
                <span class="cpk-seq">{{ r.seq }}</span>
                <span class="cpk-nm" :title="r.name" data-i18n-skip>{{ r.name }}<em v-if="r.sub" class="cpk-sub">{{ r.sub }}</em></span>
                <span v-if="r.grp" class="cpk-tag" data-i18n-skip>{{ r.grp }}</span>
                <span class="cpk-ll" data-i18n-skip>{{ fx(r.lon) }}, {{ fx(r.lat) }}</span>
                <slot name="row" :item="r.src" :row="r" />
                <span v-if="r.had" class="cpk-had">已加</span>
              </div>
              <div v-if="!rows.length" class="cpk-empty">{{ searching ? (busy ? '搜索中…' : '没有匹配的城市。') : (loading ? '载入中…' : '该组没有城市。') }}</div>
            </div>
          </div>
        </div>
      </div>
      <div class="cpk-ft">
        <span class="cpk-cnt">{{ single ? `${total} 座` : `${total} 座 · 已选 ${selCount} 座` }}</span>
        <span v-if="note" class="cpk-cnt cpk-note">{{ note }}</span>
        <button v-if="!single" type="button" class="cpk-btn ghost" :disabled="!selCount" title="把勾选的城市加入列表（跨组的勾选一并加入）" @click="addSelected">添加所选<template v-if="selCount">（{{ selCount }}）</template></button>
        <button type="button" class="cpk-btn" @click="emit('close')">{{ single ? '关闭' : '完成' }}</button>
      </div>
    </div>
  </div>
</template>

<style>
/* 壳：与性能指标表窗口的 PwDialog 同一套几何（遮罩 / 标题条 / 页脚），自带一份，两条样式链都能落 */
/* 遮罩全软件一档 --scrim（原冷蓝黑），瞬时出现；框体上浮入场。改这里须同步 perf/perfwin.css 的 PwDialog（孪生） */
.cpk-mask { position: fixed; inset: 0; z-index: 300; display: flex; align-items: center; justify-content: center; background: var(--scrim); }
.cpk-dlg { max-width: calc(100% - 32px); max-height: 92%; display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-card); overflow: hidden; box-shadow: var(--shadow-3); animation: ui-dlg-in var(--dur-3) var(--ease-out); }
.cpk-hd { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--border); font-family: var(--font-serif); font-size: var(--fs-5); color: var(--text); flex: none; }
/* 关闭键是真 <button>（Tab 可达）：去掉按钮默认描边 / 底色，悬停给中性罩 */
.cpk-hd .cpk-x { margin-left: auto; cursor: pointer; display: inline-flex; border: 0; background: transparent; padding: 2px; border-radius: var(--r-ctl); color: var(--text-faint); }
.cpk-hd .cpk-x:hover { color: var(--text); background: var(--wash-hover); }
.cpk-body { padding: 12px 14px; overflow: auto; min-height: 0; display: flex; flex-direction: column; }
.cpk-ft { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--border); flex: none; }
.cpk-cnt { font-size: var(--fs-2); color: var(--text-faint); font-family: var(--font-mono); white-space: nowrap; }
.cpk-ft .cpk-cnt + .cpk-btn { margin-left: auto; }
/* 页脚两钮是真 <button>：同为 --h-ctl-lg 定高（原 ghost 多 1px 描边比主钮高 2px）；主钮墨色实底走 primary token */
.cpk-btn { display: inline-flex; align-items: center; justify-content: center; height: var(--h-ctl-lg); padding: 0 18px;
           font-size: var(--fs-3); white-space: nowrap; cursor: pointer; user-select: none; color: var(--primary-on);
           background: var(--primary-fill); border: 1px solid var(--primary-fill); border-radius: var(--r-ctl); }
.cpk-btn:hover:not(:disabled) { background: var(--primary-fill-hover); border-color: var(--primary-fill-hover); }
.cpk-btn.ghost { color: var(--text); background: var(--bg); border-color: var(--border-strong); }
/* 上一条主钮悬停特异度更高，ghost 悬停须把底色显式压回 --bg */
.cpk-btn.ghost:hover:not(:disabled) { background: var(--bg); border-color: var(--line-hover); }
.cpk-btn:disabled { opacity: .45; cursor: not-allowed; }
/* 搜索框（自绘，不靠窗口的 .ci / .sg-search） */
.cpk-q { width: 100%; box-sizing: border-box; flex: none; margin: 0 0 8px; padding: 5px 9px; font: inherit; font-size: var(--fs-3); background-color: var(--field-bg); color: var(--text); border: 1px solid var(--field-border); border-radius: var(--r-ctl, 2px); }
.cpk-q:focus { outline: none; border-color: var(--accent-ui); }
/* 双栏 */
.cpk-panes { display: flex; gap: 10px; height: min(60vh, 520px); min-height: 260px; }
.cpk-left { flex: 0 0 176px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--r-ctl); background: var(--bg); }
.cpk-left.dim { opacity: .55; }
.cpk-sec { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 6px; padding: 4px 9px 3px; font-size: var(--fs-1); font-weight: 600; letter-spacing: var(--ls-caps); color: var(--text-faint); background: var(--surface); border-bottom: 1px solid var(--border); }
.cpk-sec em { font-style: normal; font-weight: 400; font-family: var(--font-mono); margin-left: auto; }
.cpk-grp { display: flex; align-items: center; gap: 6px; padding: 3px 9px; font-size: var(--fs-3); color: var(--text-muted); cursor: pointer; border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent); }
.cpk-grp:hover { background: var(--surface); color: var(--text); }
.cpk-grp.on { background: color-mix(in srgb, var(--accent-ui) 14%, transparent); color: var(--text); font-weight: 600; }
.cpk-grp .cpk-gn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cpk-grp .cpk-gc { flex: none; font-family: var(--font-mono); font-size: var(--fs-1); color: var(--text-faint); }
.cpk-grp .cpk-gs { flex: none; font-family: var(--font-mono); font-size: var(--fs-1); color: var(--bg); background: var(--accent-ui); border-radius: var(--r-ctl); padding: 0 5px; }
.cpk-right { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.cpk-rh { display: flex; align-items: center; gap: 8px; padding: 0 2px 5px; flex: none; }
.cpk-rh .cpk-cnt { margin-left: auto; }
.cpk-rt { font-size: var(--fs-3); font-weight: 600; color: var(--text); }
/* 勾选列表（与 useCheckList 的行 / 置顶行选择器对应：.cpk-item / .cpk-all） */
.cpk-list { position: relative; flex: 1; min-height: 0; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--r-ctl); outline: none; background: var(--bg); }
.cpk-list:focus-visible { box-shadow: inset 0 0 0 1px var(--accent-ui); }
.cpk-row { display: flex; align-items: center; gap: 6px; padding: 2px 7px; cursor: default; font-size: var(--fs-3); color: var(--text-muted); user-select: none; }
.cpk-row + .cpk-row { border-top: 1px solid var(--border); }
.cpk-row:hover { background: var(--surface); }
.cpk-row.on { background: color-mix(in srgb, var(--accent-ui) 13%, transparent); }
.cpk-row.on:hover { background: color-mix(in srgb, var(--accent-ui) 20%, transparent); }
.cpk-row.cur { outline: 1px solid color-mix(in srgb, var(--accent) 55%, transparent); outline-offset: -1px; }
.cpk-row input[type=checkbox] { pointer-events: none; }
.cpk-list.single .cpk-item { cursor: pointer; }
.cpk-row .cpk-seq { flex: none; min-width: 20px; text-align: right; color: var(--text-faint); font-family: var(--font-mono); font-size: var(--fs-2); }
.cpk-row .cpk-pk, .cpk-row .cpk-ll { flex: none; color: var(--text-faint); font-family: var(--font-mono); font-size: var(--fs-2); }
.cpk-row .cpk-nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cpk-row.on .cpk-nm { color: var(--text); }
.cpk-row .cpk-nm .cpk-sub { margin-left: 6px; font-style: normal; color: var(--text-faint); font-size: var(--fs-2); }
.cpk-row.cpk-all { position: sticky; top: 0; z-index: 1; background: var(--surface); border-bottom: 1px solid var(--border); }
.cpk-row.cpk-all + .cpk-row { border-top: 0; }
.cpk-row .cpk-alln { flex: 1; color: var(--text); font-weight: 600; }
.cpk-row.had, .cpk-row.had .cpk-nm { color: var(--text-faint); }
.cpk-tag { flex: none; font-size: var(--fs-1); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl); padding: 0 5px; white-space: nowrap; }
.cpk-had { flex: none; font-size: var(--fs-1); color: var(--text-faint); border: 1px solid var(--border); border-radius: var(--r-ctl); padding: 0 5px; }
/* 宿主插在行里的悬停钮（如链路预算的 ⇄ 钉另一端）：悬停该行才现形，钉中常亮 */
.cpk-item .cpk-hov { visibility: hidden; }
.cpk-item:hover .cpk-hov, .cpk-item .cpk-hov.on { visibility: visible; }
.cpk-empty { padding: 14px; text-align: center; color: var(--text-faint); font-size: var(--fs-3); }
</style>
