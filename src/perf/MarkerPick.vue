<script setup>
// 「导入标记」：三栏一次勾 —— 点标记 / 地球站 / 航迹（航迹按整条勾，导入时每个航点一行）。
// 不一键把地图上的全部标记倒进表里；勾选交互与覆盖分析侧栏的 Beams To Plot 同一份口径（shared/ui/useCheckList.js）。
import { ref, computed } from 'vue'
import MarkLegend from '../components/MarkLegend.vue'
import { useCheckList } from '../shared/ui/useCheckList.js'
import { byLang } from '../shared/i18n/lang.js'
import PwDialog from './PwDialog.vue'

const props = defineProps({
  title: { type: String, default: '' },
  pts: { type: Array, default: () => [] },     // [{ id, seq, name }]
  sts: { type: Array, default: () => [] },     // [{ id, seq, name, ll }]
  trajs: { type: Array, default: () => [] },   // [{ id, name, kind, n }]
  polygons: { type: Array, default: null },    // 独立的 Polygon 导入入口
  trajNote: { type: String, default: '' }      // 航迹栏的悬停说明（两张表的口径不同）
})
const emit = defineEmits(['confirm', 'close'])
const q = ref('')
const onPts = ref(new Set()), onSts = ref(new Set()), onTrs = ref(new Set())
const ptEl = ref(null), stEl = ref(null), trEl = ref(null)
const ql = computed(() => q.value.trim().toLowerCase())
const ptRows = computed(() => { const s = ql.value; return props.pts.filter((r) => !s || String(r.seq) === s || String(r.name).toLowerCase().includes(s)) })
const stRows = computed(() => { const s = ql.value; return props.sts.filter((r) => !s || String(r.seq) === s || String(r.name).toLowerCase().includes(s) || String(r.ll || '').toLowerCase().includes(s)) })
const paths = computed(() => props.polygons ?? props.trajs)
const trRows = computed(() => { const s = ql.value; return paths.value.map((t, i) => ({ ...t, seq: i + 1 })).filter((r) => !s || String(r.seq) === s || String(r.name).toLowerCase().includes(s)) })
const P = useCheckList({ rows: () => ptRows.value, idOf: (r) => r.id, isOn: (id) => onPts.value.has(id), current: () => [...onPts.value], commit: (ids) => { onPts.value = new Set(ids) }, el: () => ptEl.value })
const S = useCheckList({ rows: () => stRows.value, idOf: (r) => r.id, isOn: (id) => onSts.value.has(id), current: () => [...onSts.value], commit: (ids) => { onSts.value = new Set(ids) }, el: () => stEl.value })
const T = useCheckList({ rows: () => trRows.value, idOf: (r) => r.id, isOn: (id) => onTrs.value.has(id), current: () => [...onTrs.value], commit: (ids) => { onTrs.value = new Set(ids) }, el: () => trEl.value })
const total = computed(() => onPts.value.size + onSts.value.size + onTrs.value.size)
const kindOf = (t) => (t.kind === 'flight' ? byLang('飞行', 'Flight') : byLang('航行', 'Maritime'))
function confirm() {
  if (!total.value) return
  if (props.polygons) emit('confirm', { polygons: [...onTrs.value] })
  else emit('confirm', { pts: [...onPts.value], sts: [...onSts.value], trajs: [...onTrs.value] })
}
</script>

<template>
  <PwDialog :title="title || (polygons ? byLang('从 Polygon 导入', 'Import from Polygon') : '导入标记')" :width="460" @close="emit('close')">
    <input class="ci bq search-field" v-model="q" placeholder="搜索：序号、名称或坐标" />
    <section v-if="!polygons" class="po-card">
      <div class="po-ct">点标记</div>
      <div ref="ptEl" class="bplist mkl" :class="{ painting: P.painting.value }" tabindex="0" title="点一行翻勾选 · 按住拖＝刷选一片 · Shift 点＝连选一段 · Ctrl+A 全选" @keydown="P.onKey">
        <div class="brow ball" @mousedown="P.onHeadDown">
          <input type="checkbox" :checked="P.allOn()" :indeterminate.prop="P.anyOn() && !P.allOn()" />
          <span class="balln">{{ q.trim() ? '(全选搜索结果)' : '(全选)' }}</span>
          <span class="bpk">{{ P.onCount.value }}/{{ pts.length }}</span>
        </div>
        <div v-for="(r, i) in ptRows" :key="r.id" class="brow bitem" :class="{ on: P.isOn(r.id), cur: P.cur.value === i }" @mousedown="P.onRowDown($event, i)">
          <input type="checkbox" :checked="P.isOn(r.id)" />
          <MarkLegend :size="16" v-bind="r.legend || { type: 'icon', icon: 'map-pin' }" />
          <span class="bseq">{{ r.seq }}</span>
          <span class="pbnm" :title="r.name" data-i18n-skip>{{ r.name }}</span>
        </div>
        <div v-if="!ptRows.length" class="empty">{{ pts.length ? '无匹配标记' : '暂无点标记。' }}</div>
      </div>
    </section>
    <section v-if="!polygons" class="po-card">
      <div class="po-ct">地球站</div>
      <div ref="stEl" class="bplist mkl" :class="{ painting: S.painting.value }" tabindex="0" title="点一行翻勾选 · 按住拖＝刷选一片 · Shift 点＝连选一段 · Ctrl+A 全选" @keydown="S.onKey">
        <div class="brow ball" @mousedown="S.onHeadDown">
          <input type="checkbox" :checked="S.allOn()" :indeterminate.prop="S.anyOn() && !S.allOn()" />
          <span class="balln">{{ q.trim() ? '(全选搜索结果)' : '(全选)' }}</span>
          <span class="bpk">{{ S.onCount.value }}/{{ sts.length }}</span>
        </div>
        <div v-for="(r, i) in stRows" :key="r.id" class="brow bitem" :class="{ on: S.isOn(r.id), cur: S.cur.value === i }" @mousedown="S.onRowDown($event, i)">
          <input type="checkbox" :checked="S.isOn(r.id)" />
          <MarkLegend type="station" :size="16" />
          <span class="bseq">{{ r.seq }}</span>
          <span class="pbnm" :title="r.name" data-i18n-skip>{{ r.name }}</span>
          <span class="bll" data-i18n-skip>{{ r.ll }}</span>
        </div>
        <div v-if="!stRows.length" class="empty">{{ sts.length ? '无匹配标记' : '暂无地球站。' }}</div>
      </div>
    </section>
    <section class="po-card">
      <div class="po-ct" :title="trajNote">{{ polygons ? 'Polygon' : '航迹' }}</div>
      <div ref="trEl" class="bplist mkl" :class="{ painting: T.painting.value }" tabindex="0" :title="polygons ? byLang('每个顶点一行', 'One row per vertex') : '整条勾选，导入时每个航点一行 · 按住拖＝刷选一片 · Shift 点＝连选一段 · Ctrl+A 全选'" @keydown="T.onKey">
        <div class="brow ball" @mousedown="T.onHeadDown">
          <input type="checkbox" :checked="T.allOn()" :indeterminate.prop="T.anyOn() && !T.allOn()" />
          <span class="balln">{{ q.trim() ? '(全选搜索结果)' : '(全选)' }}</span>
          <span class="bpk">{{ T.onCount.value }}/{{ paths.length }}</span>
        </div>
        <div v-for="(r, i) in trRows" :key="r.id" class="brow bitem" :class="{ on: T.isOn(r.id), cur: T.cur.value === i }" @mousedown="T.onRowDown($event, i)">
          <input type="checkbox" :checked="T.isOn(r.id)" />
          <MarkLegend v-if="polygons" type="icon" icon="polygon" :color="r.color" :size="16" />
          <MarkLegend v-else :size="16" v-bind="r.legend || { type: 'icon', icon: r.kind === 'flight' ? 'plane' : 'ship' }" />
          <span class="bseq">{{ r.seq }}</span>
          <span class="pbnm" :title="r.name" data-i18n-skip>{{ r.name }}</span>
          <span class="bll" data-i18n-skip>{{ polygons ? byLang(r.n + ' 个顶点', r.n + ' vertices') : kindOf(r) + ' · ' + r.n }}</span>
        </div>
        <div v-if="!trRows.length" class="empty">{{ polygons ? (paths.length ? byLang('无匹配 Polygon。', 'No matching polygons.') : byLang('暂无 Polygon。', 'No polygons.')) : (trajs.length ? '无匹配航迹' : '暂无航迹。') }}</div>
      </div>
    </section>
    <template #foot>
      <button type="button" class="cancel btn" @click="emit('close')">取消</button>
      <button type="button" :disabled="!total" class="save btn primary" :class="{ dis: !total }" @click="confirm">导入 {{ total }} 项</button>
    </template>
  </PwDialog>
</template>

<style scoped src="./checkList.css"></style>
<style scoped>
.bq { width: 100%; box-sizing: border-box; margin-bottom: 6px; }
.po-card { padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--r-box); }
.po-card + .po-card { margin-top: 8px; }
.po-ct { color: var(--text-muted); font-weight: 600; font-size: var(--fs-2); }
.mkl { max-height: 26vh; }
</style>
