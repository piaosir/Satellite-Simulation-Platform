<script setup>
// 「链路分析」取点编辑器：链路详情里 Polygon / 航迹节点行下就地展开（设计稿 docs/链路分析·航迹与Polygon节点设计_2026-10-08.md §5.2）。
// 上一行族开关（多选）：Polygon = 质心 · 顶点 · 边界等分 N；航迹 = 载具 · 航点 · 沿迹等分 N。点开 = 整族取，再点 = 整族舍；等分族带点数框。
// 下面点表：一行一个候选点 —— 实心 = 已取、空心 = 未取；单击行 = 取 / 舍这一点；悬停 = 图上高亮这一点（hi 由宿主回传，图上悬停也亮这一行）。
// 行尾读数 = 该点放在这一位时到相邻卫星的仰角（最低那个；低于门限着告警色），逐拍由宿主的读数表给（readOf，载具行的位置也在里面）。
// 航点 / 等分点排得出时刻就显示，点时刻 = 时间轴跳到那一刻（此时载具正好在那一点上）。
// 长表（导入的上千顶点 / 航点）虚拟滚动；键盘：↑↓ 移动、Enter / 空格 取舍、Esc 收起。
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { linkPointLabel } from '../shared/linkPointNames.js'
import { byLang as byLangT } from '../shared/i18n/lang.js'   // title 里拼出来的串与读数串词典翻不到：按界面语言直接出（同 shared/markerNames 口径）

const props = defineProps({
  kind: { type: String, required: true },        // 'pg' | 'tj'
  cands: { type: Array, required: true },        // 全部候选点（mapLinkPoints 的 cand；载具的位置以 readOf 为准）
  stats: { type: Object, required: true },       // 族统计 { one:{on,k,n}, many:{on,k,n}, d:{on,k,n} }（one = 质心 / 载具，many = 顶点 / 航点）
  hi: { type: String, default: '' },              // 悬停的候选点键
  flight: { type: Boolean, default: false },      // 飞行航迹：行上报实际高度
  readOf: { type: Function, required: true },     // key → { el, rangeKm, vis, n, lat, lon, altM } | null（逐拍读数）
  fmtLL: { type: Function, required: true },
  fmtTime: { type: Function, required: true },    // ms → 显示时区的时刻串
  fmtAlt: { type: Function, required: true }      // m → 高度串
})
const emit = defineEmits(['toggle', 'fam', 'div', 'hover', 'seek', 'close'])

const ROW_H = 22, VP_ROWS = 9, OVERSCAN = 4, VIRT_MIN = 60
const famOne = computed(() => (props.kind === 'pg' ? 'c' : 'veh'))
const famMany = computed(() => (props.kind === 'pg' ? 'v' : 'w'))
// 族名按界面语言现出字（全局词典里「质心」译作模型的 CoM，这里要的是面的 Centroid —— 不走词典）
const oneText = computed(() => (props.kind === 'pg' ? byLangT('质心', 'Centroid') : byLangT('载具', 'Vehicle')))
const manyText = computed(() => (props.kind === 'pg' ? byLangT('顶点', 'Vertices') : byLangT('航点', 'Waypoints')))
const divText = computed(() => (props.kind === 'pg' ? byLangT('边界等分', 'Edge points') : byLangT('沿迹等分', 'Track points')))
const cnt = (s) => (!s || !s.n ? '' : s.on && s.k < s.n ? s.k + '/' + s.n : String(s.n))
const total = computed(() => props.cands.reduce((a, c) => a + (c.sel ? 1 : 0), 0))
const totalText = computed(() => byLangT(`${total.value} 点`, `${total.value} pt${total.value === 1 ? '' : 's'}`))

// 等分点数框：失焦 / 回车提交；越界由宿主夹回（:key 换实例回到当前值）
const divN = computed(() => (props.stats.d && props.stats.d.on ? props.stats.d.n : 0))
function onDiv(e) {
  const v = Math.round(Number(e.target.value))
  if (Number.isFinite(v) && v !== divN.value) emit('div', v)
  else e.target.value = String(divN.value)
}

// 行：标签 / 副标题（坐标或时刻 · 高度）/ 读数
function sub(c, r) {
  const lat = c.fam === 'veh' && r ? r.lat : c.lat, lon = c.fam === 'veh' && r ? r.lon : c.lon
  const alt = c.fam === 'veh' && r ? r.altM : c.altM
  const parts = []
  if (props.kind === 'tj' && c.fam !== 'veh' && Number.isFinite(c.tMs)) parts.push(null)   // 时刻另起一个可点的段（见模板）
  else parts.push(props.fmtLL(lat, lon))
  if (props.flight && Number.isFinite(alt)) parts.push(props.fmtAlt(alt))
  return parts
}
function rdText(r) { return r && r.n && r.el != null ? r.el.toFixed(1) + '°' : '—' }
function rdTitle(c, r) {
  if (!r || !r.n) return ''
  const s = [byLangT('仰角', 'Elevation') + ' ' + (r.el != null ? r.el.toFixed(2) + '°' : '—')]
  if (Number.isFinite(r.rangeKm)) s.push(byLangT('斜距', 'Slant range') + ' ' + Math.round(r.rangeKm).toLocaleString('en-US') + ' km')
  if (c.moved) s.push(byLangT('质心落在区外，取区内距边界最远点', 'Centroid falls outside; using the interior point farthest from the edges'))
  return s.join(' · ')
}

// 虚拟滚动（长表）
const vpEl = ref(null), listEl = ref(null)
const scrollTop = ref(0)
const virt = computed(() => props.cands.length > VIRT_MIN)
const vpH = computed(() => Math.max(1, Math.min(VP_ROWS, props.cands.length)) * ROW_H)
const start = computed(() => (virt.value ? Math.max(0, Math.floor(scrollTop.value / ROW_H) - OVERSCAN) : 0))
const end = computed(() => (virt.value ? Math.min(props.cands.length, Math.ceil((scrollTop.value + vpH.value) / ROW_H) + OVERSCAN) : props.cands.length))
const shown = computed(() => props.cands.slice(start.value, end.value))
function onScroll() { if (vpEl.value) scrollTop.value = vpEl.value.scrollTop }
// 宿主那边（图上悬停）亮了某一行：滚进视口
watch(() => props.hi, (k) => {
  if (!k) return
  const i = props.cands.findIndex((c) => c.key === k), el = vpEl.value
  if (i < 0 || !el) return
  const top = i * ROW_H, bot = top + ROW_H
  if (top < el.scrollTop) el.scrollTop = top
  else if (bot > el.scrollTop + el.clientHeight) el.scrollTop = bot - el.clientHeight
  scrollTop.value = el.scrollTop
})

// 键盘：↑↓ 移动悬停行、Enter / 空格 取舍、Esc 收起
function onKey(e) {
  const k = e.key
  if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); emit('close'); return }
  if (k === 'ArrowDown' || k === 'ArrowUp') {
    e.preventDefault()
    const n = props.cands.length
    if (!n) return
    let i = props.cands.findIndex((c) => c.key === props.hi)
    i = i < 0 ? (k === 'ArrowDown' ? 0 : n - 1) : Math.max(0, Math.min(n - 1, i + (k === 'ArrowDown' ? 1 : -1)))
    emit('hover', props.cands[i].key)
    return
  }
  if ((k === 'Enter' || k === ' ') && props.hi) { e.preventDefault(); emit('toggle', props.hi) }
}
onMounted(() => nextTick(() => { if (listEl.value) listEl.value.focus({ preventScroll: true }) }))
</script>

<template>
  <div class="lpe">
    <div class="lpe-fams" role="group" aria-label="取点">
      <button type="button" class="lpe-f" :class="{ on: stats.one && stats.one.on }" :aria-pressed="stats.one && stats.one.on ? 'true' : 'false'" data-i18n-skip @click="emit('fam', famOne, !(stats.one && stats.one.on))">{{ oneText }}</button>
      <button type="button" class="lpe-f" :class="{ on: stats.many && stats.many.on }" :aria-pressed="stats.many && stats.many.on ? 'true' : 'false'" data-i18n-skip @click="emit('fam', famMany, !(stats.many && stats.many.on))">{{ manyText }}<span class="lpe-fn">{{ cnt(stats.many) }}</span></button>
      <span class="lpe-f lpe-fd" :class="{ on: stats.d && stats.d.on }">
        <button type="button" class="lpe-fdb" :aria-pressed="stats.d && stats.d.on ? 'true' : 'false'" data-i18n-skip @click="emit('fam', 'd', !(stats.d && stats.d.on))">{{ divText }}</button>
        <input v-if="stats.d && stats.d.on" :key="'d' + divN" class="lpe-dn" type="number" min="2" max="64" step="1" :value="divN" title="等分点数" @change="onDiv" @keydown.enter="($event.target).blur()" />
      </span>
      <span class="lpe-cnt" :class="{ none: !total }" data-i18n-skip>{{ totalText }}</span>
    </div>
    <div
      ref="listEl" class="lpe-list" tabindex="0" role="listbox" aria-multiselectable="true"
      @keydown="onKey" @mouseleave="emit('hover', '')"
    >
      <div ref="vpEl" class="lpe-vp" :style="virt ? { height: vpH + 'px' } : null" @scroll.passive="onScroll">
        <div :style="virt ? { height: cands.length * ROW_H + 'px', position: 'relative' } : null">
          <div :style="virt ? { position: 'absolute', left: 0, right: 0, top: 0, transform: 'translateY(' + start * ROW_H + 'px)' } : null">
            <div
              v-for="c in shown" :key="c.key" class="lpe-row" role="option"
              :class="{ on: c.sel, hi: c.key === hi }" :aria-selected="c.sel ? 'true' : 'false'"
              @click="emit('toggle', c.key)" @mouseenter="emit('hover', c.key)"
            >
              <span class="lpe-dot"></span>
              <span class="lpe-lb" data-i18n-skip>{{ linkPointLabel(kind, c) }}</span>
              <span class="lpe-sub" data-i18n-skip>
                <template v-for="(s, j) in sub(c, readOf(c.key))" :key="j">
                  <button type="button" v-if="s === null" class="lpe-t" title="时间轴跳到该时刻" @click.stop="emit('seek', c.tMs)">{{ fmtTime(c.tMs) }}</button>
                  <span v-else>{{ s }}</span>
                </template>
              </span>
              <span class="lpe-rd" :class="{ off: readOf(c.key) && readOf(c.key).n && !readOf(c.key).vis, moved: c.moved }" :title="rdTitle(c, readOf(c.key))">{{ rdText(readOf(c.key)) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* span / div 改成 <button> 后仍沿用本地外观的几类：先清 UA 内距与描边，外观由下方各自规则给 */
:where(button).lpe-t { margin: 0; padding: 0; border: 0; background: none; color: inherit; text-align: inherit; }
.lpe { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.lpe-fams { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
/* 族开关：描边小钮，开 = 机位色淡底；等分族的点数框并在钮里 */
.lpe-f {
  display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 7px; margin: 0;
  border: 1px solid var(--border-strong); border-radius: var(--r-ctl); background: var(--raised);
  color: var(--text-muted); font: inherit; font-size: var(--fs-2); cursor: pointer; white-space: nowrap;
}
.lpe-f:hover { color: var(--text); background: var(--raised-hover); border-color: var(--field-border-hover, var(--border-strong)); }
.lpe-f.on { background: var(--accent-ui-weak); border-color: color-mix(in srgb, var(--accent-ui) 55%, transparent); color: var(--accent-ui); }
.lpe-fn { font-family: var(--font-mono); font-size: var(--fs-1); opacity: .85; }
.lpe-fd { padding: 0; cursor: default; overflow: hidden; }
.lpe-fdb { height: 100%; padding: 0 7px; margin: 0; border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.lpe-fd .lpe-dn {
  width: 34px; height: 100%; padding: 0 3px; margin: 0; border: 0; border-left: 1px solid color-mix(in srgb, var(--accent-ui) 35%, transparent);
  border-radius: 0; background: var(--field-bg); color: var(--text); font-family: var(--font-mono); font-size: var(--fs-2); text-align: right;
}
.lpe-cnt { margin-left: auto; font-family: var(--font-mono); font-size: var(--fs-2); color: var(--text-faint); font-variant-numeric: tabular-nums; }
.lpe-cnt.none { color: var(--warn); }
.lpe-list { border: 1px solid var(--border); border-radius: var(--r-ctl); background: var(--bg); outline: none; overflow: hidden; }
.lpe-list:focus-visible { box-shadow: inset 0 0 0 1px var(--accent-ui); }
.lpe-vp { max-height: 198px; overflow-y: auto; overscroll-behavior: contain; }
.lpe-row { display: flex; align-items: center; gap: 6px; height: 22px; box-sizing: border-box; padding: 0 7px; cursor: pointer; font-size: var(--fs-2); }
.lpe-row.hi { background: var(--accent-ui-weak); }
/* 实心 = 已取、空心 = 未取（与图上候选点同一套图形） */
.lpe-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; box-sizing: border-box; border: 1.5px solid var(--text-faint); }
.lpe-row.on .lpe-dot { border-color: var(--accent-fill); background: var(--accent-fill); }
.lpe-lb { flex: none; min-width: 52px; color: var(--text-muted); white-space: nowrap; }
.lpe-row.on .lpe-lb { color: var(--text); }
.lpe-sub { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); color: var(--text-faint); }
.lpe-sub > span + span::before { content: ' · '; }
.lpe-t { cursor: pointer; }
.lpe-t:hover { color: var(--text); text-decoration: underline; text-underline-offset: 2px; }
.lpe-rd { flex: none; min-width: 38px; text-align: right; font-family: var(--font-mono); color: var(--text-muted); font-variant-numeric: tabular-nums; }
.lpe-rd.off { color: var(--warn); }
</style>
