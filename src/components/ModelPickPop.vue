<script setup>
// 模型选择弹层（标记侧栏的「模型」小块点开：给地球站 / 点标记 / 航迹载具挂模型；DESIGN3 E7 / E11）。
// 受控组件：页面 v-if 开关，选中 / 清除 / 改图标像素都经事件交给页面落到标记对象上（内联字段 obj.model = {id, px?}）。
//   搜索 + 领域分段（缺省按实体类：站 → 地球站、飞行 → 飞机、航行 → 船）+ 缩略图网格（当前值 .on）；
//   有模型时底部多一行「图标」滑杆（8–256，值 = 本实体覆盖 || 全局；双击 / 右键回到全局）与「清除」。
// ★ Teleport 到 body：侧栏层层 overflow，留在原位会被裁；Esc / 点外面关；选卡片即 pick 并关。
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import Icon from './Icon.vue'
import { byLang } from '../shared/i18n/lang.js'
import { thumbs, createThumbObserver } from './modelThumbs.js'

const props = defineProps({
  anchor: { type: Object, required: true },     // {x, y, w, h}：触发块的屏幕矩形（client 像素）
  lib: { type: Array, default: () => [] },      // 页面 modelLib.list
  domain: { type: String, default: '' },        // '' | 'ground' | 'aircraft' | 'ship' | 'vehicle' | 'space'
  value: { type: String, default: '' },         // 当前模型 id（'' = 没挂）
  px: { type: Number, default: 0 },             // 本实体的图标像素覆盖（0 = 跟全局）
  defPx: { type: Number, default: 28 }          // 全局图标像素（focusStyle.modelPx）
})
const emit = defineEmits(['pick', 'px', 'clear', 'close'])

const DOMAINS = [
  { k: '', t: '全部' }, { k: 'ground', t: '地球站' }, { k: 'aircraft', t: '飞机' },
  { k: 'ship', t: '船' }, { k: 'vehicle', t: '车' }, { k: 'space', t: '航天器' }
]
const ENT_KINDS = new Set(['ground', 'aircraft', 'ship', 'vehicle'])
const domOf = (m) => (ENT_KINDS.has(m.kind) ? m.kind : 'space')
const ICON_OF = { ground: 'satellite-dish', aircraft: 'plane', ship: 'ship', vehicle: 'car', space: 'satellite' }
const dom = ref(DOMAINS.some((d) => d.k === props.domain) ? props.domain : '')
const q = ref('')
const nameOf = (m) => (m ? byLang(m.titleZh || m.title || m.id, m.title || m.titleZh || m.id) : '')
const srcOf = (m) => { const s = (m && m.source) || {}; return [s.credit, s.license].filter(Boolean).join(' · ') || (m && m.id) || '' }
const norm = (s) => String(s || '').normalize('NFKC').toLowerCase()
// 排序：实体模板（生成件）先、再按名称；领域「全部」时地面 / 空中件排在航天器前（挂到标记上最常用）
const RANK = { ground: 0, aircraft: 1, ship: 2, vehicle: 3, space: 4 }
const sorted = computed(() => props.lib.slice().sort((a, b) =>
  (RANK[domOf(a)] - RANK[domOf(b)]) || nameOf(a).localeCompare(nameOf(b), 'zh-Hans-CN')))
const shown = computed(() => {
  const k = norm(q.value).trim()
  return sorted.value.filter((m) => {
    if (dom.value && domOf(m) !== dom.value) return false
    if (!k) return true
    return norm(m.title).includes(k) || norm(m.titleZh).includes(k) || norm(m.id).includes(k) ||
      (Array.isArray(m.aliases) && m.aliases.some((a) => norm(a).includes(k))) || (Array.isArray(m.tags) && m.tags.some((a) => norm(a).includes(k)))
  })
})

// ---- 位置：贴触发块右侧开（放不下翻到左侧），再夹进视口 ----
const W = 340, H = 452, GAP = 8, PAD = 6
const box = ref(null)
const pos = ref({ left: '0px', top: '0px' })
function place() {
  const a = props.anchor || { x: 0, y: 0, w: 0, h: 0 }
  const vw = window.innerWidth, vh = window.innerHeight
  const el = box.value, h = el ? el.getBoundingClientRect().height : H
  let left = a.x + a.w + GAP
  if (left + W > vw - PAD) left = a.x - GAP - W
  left = Math.max(PAD, Math.min(left, vw - W - PAD))
  const top = Math.max(PAD, Math.min(a.y - 10, vh - h - PAD))
  pos.value = { left: left + 'px', top: top + 'px' }
}

// ---- 缩略图：可见才取 ----
const obs = createThumbObserver('60px')
const observe = (el) => obs.observe(el)

// ---- 交互 ----
const qEl = ref(null)
function pick(m) { emit('pick', m.id); emit('close') }
function onEnter() { const m = shown.value[0]; if (m) pick(m) }
const pxVal = computed(() => (props.px > 0 ? props.px : props.defPx))
function onPx(e, final) { const v = Math.round(Number(e.target.value)); if (Number.isFinite(v)) emit('px', v, final) }
function pxReset() { emit('px', null, true) }
function onKey(e) {
  if (e.key !== 'Escape' || e.isComposing) return
  e.preventDefault(); e.stopPropagation()
  emit('close')
}
function onResize() { place() }
onMounted(() => {
  place()
  nextTick(() => { place(); if (qEl.value) qEl.value.focus({ preventScroll: true }) })
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey, true)
  window.removeEventListener('resize', onResize)
  obs.disconnect()
})
</script>

<template>
  <Teleport to="body">
    <div class="mpp-mask" @mousedown="emit('close')" @contextmenu.prevent="emit('close')" @wheel.prevent>
      <div ref="box" class="mpp" role="dialog" :style="pos" @mousedown.stop @wheel.stop @contextmenu.stop>
        <div class="mpp-srch"><Icon name="search" :size="12" /><input ref="qEl" v-model="q" type="text" placeholder="搜索" spellcheck="false" @keydown.enter.prevent="onEnter" /><span v-if="q" class="clr" title="清除" @click="q = ''"><Icon name="x" :size="12" /></span></div>
        <div class="seg nseg mpp-seg" role="group" aria-label="领域">
          <span v-for="d in DOMAINS" :key="d.k" class="sg" :class="{ on: dom === d.k }" @click="dom = d.k">{{ d.t }}</span>
        </div>
        <div v-if="!shown.length" class="mpp-empty">无匹配模型。</div>
        <div v-else class="mpp-grid">
          <div
            v-for="m in shown" :key="m.id" :ref="observe" class="mpp-card" :class="{ on: value === m.id }" :data-id="m.id"
            :title="nameOf(m) + '\n' + srcOf(m)" @click="pick(m)"
          >
            <div class="th">
              <img v-if="thumbs.get(m.id)" :src="thumbs.get(m.id)" crossorigin="anonymous" alt="" draggable="false" loading="lazy" />
              <Icon v-else :name="ICON_OF[domOf(m)]" :size="22" :stroke-width="1.2" />
            </div>
            <div class="nm" data-i18n-skip>{{ nameOf(m) }}</div>
          </div>
        </div>
        <div v-if="value" class="mpp-foot">
          <label title="模型包围半径的屏幕像素 × 2；双击或右键回到全局设置">图标</label>
          <input class="rng" type="range" min="8" max="256" step="2" :value="pxVal" @input="onPx($event, false)" @change="onPx($event, true)" @dblclick="pxReset" @contextmenu.prevent="pxReset" />
          <span class="u" :class="{ inh: !(px > 0) }" :title="px > 0 ? '' : '跟随全局'">{{ pxVal }}</span>
          <span class="lnk" title="卸下模型" @click="emit('clear'); emit('close')">清除</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style>
/* Teleport 出去了，scoped 打不到（同 TzPicker）；类名一律 mpp- 前缀免撞 */
.mpp-mask { position: fixed; inset: 0; z-index: 2400; }
.mpp {
  position: fixed; z-index: 2401; width: 340px; max-height: 452px; display: flex; flex-direction: column; gap: 8px; padding: 10px;
  background: var(--surface, var(--bg)); border: 1px solid var(--border-strong, var(--border)); border-radius: var(--r-float, 6px); box-shadow: var(--shadow-2);
  font-size: var(--fs-3); color: var(--text); animation: ui-fade-in var(--dur-2) var(--ease-out);
}
.mpp-srch { flex: none; display: flex; align-items: center; gap: 6px; height: var(--h-ctl); padding: 0 8px; border: 1px solid var(--field-border); background: var(--field-bg); color: var(--text-faint); border-radius: var(--r-ctl); }
.mpp-srch input { flex: 1; min-width: 0; border: 0; background: transparent; outline: none; color: var(--text); font-size: var(--fs-3); padding: 0; height: 100%; }
/* 焦点环画在整个搜索框上（里头的无框输入框自己不描，免得环缩在框里一截） */
.mpp-srch:focus-within { outline: 2px solid var(--accent-ui); outline-offset: -1px; }
.mpp-srch input:focus-visible { outline: none !important; }
.mpp-srch .clr { display: inline-flex; cursor: pointer; }
.mpp-srch .clr:hover { color: var(--text); }
/* 分段控件：与 3D 页 / ModelSidePanel 的 .seg 同一口径（那两份是 scoped 的，逐字照抄；改动请几处一起改） */
.mpp-seg { flex: none; display: flex; box-sizing: border-box; min-height: var(--h-ctl); border: 1px solid var(--border-strong); border-radius: var(--r-ctl); overflow: hidden; }
.mpp-seg .sg { flex: 1 1 auto; text-align: center; padding: 2px 4px; line-height: 16px; cursor: pointer; color: var(--text-muted); user-select: none; white-space: nowrap; transition: var(--t-state); }
.mpp-seg .sg + .sg { border-left: 1px solid var(--border); }
.mpp-seg .sg:hover:not(.on) { background: var(--surface-2); color: var(--text); }
.mpp-seg .sg:active:not(.on) { box-shadow: var(--press); transition-duration: 0s; }
.mpp-seg .sg.on { background: var(--sel-fill); color: var(--sel-on); transition-duration: 0s; }
.mpp-seg .sg.on, .mpp-seg .sg.on + .sg { border-left-color: transparent; }
.mpp-empty { color: var(--text-faint); padding: 18px 0; text-align: center; }
/* 行高按内容（grid-auto-rows: max-content）：网格被弹层 max-height 压着时，auto 行会按 overflow:hidden 卡片的最小尺寸 0 往下收、把名字裁掉 */
.mpp-grid { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); grid-auto-rows: max-content; align-content: start; gap: 6px; padding-right: 2px; }
.mpp-card { border: 1px solid var(--border); border-radius: var(--r-box); background: var(--surface); cursor: pointer; overflow: hidden; transition: border-color var(--dur-1) linear, background-color var(--dur-1) linear; }
.mpp-card:hover { border-color: var(--border-strong); background: color-mix(in srgb, var(--text) 4%, var(--surface)); }
.mpp-card.on { border-color: var(--accent-ui); box-shadow: inset 0 0 0 1px var(--accent-ui); }
.mpp-card .th { position: relative; aspect-ratio: 1 / 1; display: flex; align-items: center; justify-content: center; color: var(--text-faint);
  background: radial-gradient(ellipse at 50% 38%, color-mix(in srgb, var(--text) 7%, var(--surface)) 0%, var(--surface) 78%); }
.mpp-card .th img { width: 100%; height: 100%; object-fit: contain; }
.mpp-card .nm { margin: 3px 5px 4px; font-size: var(--fs-1); line-height: 1.3; color: var(--text); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: calc(2 * 1.3em); max-height: calc(2 * 1.3em); }
.mpp-foot { flex: none; display: flex; align-items: center; gap: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
.mpp-foot label { color: var(--text-muted); flex: none; white-space: nowrap; }
.mpp-foot .rng { flex: 1; min-width: 0; }
.mpp-foot .u { flex: none; min-width: 30px; text-align: right; color: var(--text); font-variant-numeric: tabular-nums; }
.mpp-foot .u.inh { color: var(--text-faint); }
.mpp-foot .lnk { flex: none; color: var(--text-muted); cursor: pointer; transition: color var(--dur-1) linear; }
.mpp-foot .lnk:hover { color: var(--danger); text-decoration: underline; text-underline-offset: 2px; }
</style>
