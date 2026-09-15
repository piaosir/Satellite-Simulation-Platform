<script setup>
// 「导入标记」：三栏一次勾 —— 点标记 / 地球站 / 航迹（航迹按整条勾，导入时每个航点一行）。
// 不一键把地图上的全部标记倒进表里；勾选交互与覆盖分析侧栏的 Beams To Plot 同一份口径（shared/ui/useCheckList.js）。
import { ref, computed } from 'vue'
import Icon from '../components/Icon.vue'
import { useCheckList } from '../shared/ui/useCheckList.js'
import { byLang } from '../shared/i18n/lang.js'
import PwDialog from './PwDialog.vue'

const props = defineProps({
  pts: { type: Array, default: () => [] },     // [{ id, seq, name }]
  sts: { type: Array, default: () => [] },     // [{ id, seq, name, ll }]
  trajs: { type: Array, default: () => [] },   // [{ id, name, kind, n }]
  trajNote: { type: String, default: '' }      // 航迹栏的悬停说明（两张表的口径不同）
})
const emit = defineEmits(['confirm', 'close'])
const q = ref('')
const onPts = ref(new Set()), onSts = ref(new Set()), onTrs = ref(new Set())
const ptEl = ref(null), stEl = ref(null), trEl = ref(null)
const ql = computed(() => q.value.trim().toLowerCase())
const ptRows = computed(() => { const s = ql.value; return props.pts.filter((r) => !s || String(r.seq) === s || String(r.name).toLowerCase().includes(s)) })
const stRows = computed(() => { const s = ql.value; return props.sts.filter((r) => !s || String(r.seq) === s || String(r.name).toLowerCase().includes(s) || String(r.ll || '').toLowerCase().includes(s)) })
const trRows = computed(() => { const s = ql.value; return props.trajs.map((t, i) => ({ ...t, seq: i + 1 })).filter((r) => !s || String(r.seq) === s || String(r.name).toLowerCase().includes(s)) })
const P = useCheckList({ rows: () => ptRows.value, idOf: (r) => r.id, isOn: (id) => onPts.value.has(id), current: () => [...onPts.value], commit: (ids) => { onPts.value = new Set(ids) }, el: () => ptEl.value })
const S = useCheckList({ rows: () => stRows.value, idOf: (r) => r.id, isOn: (id) => onSts.value.has(id), current: () => [...onSts.value], commit: (ids) => { onSts.value = new Set(ids) }, el: () => stEl.value })
const T = useCheckList({ rows: () => trRows.value, idOf: (r) => r.id, isOn: (id) => onTrs.value.has(id), current: () => [...onTrs.value], commit: (ids) => { onTrs.value = new Set(ids) }, el: () => trEl.value })
const total = computed(() => onPts.value.size + onSts.value.size + onTrs.value.size)
const kindOf = (t) => (t.kind === 'flight' ? byLang('飞行', 'Flight') : byLang('航行', 'Maritime'))
function confirm() { if (!total.value) return; emit('confirm', { pts: [...onPts.value], sts: [...onSts.value], trajs: [...onTrs.value] }) }
</script>

<template>
  <PwDialog title="导入标记" :width="460" @close="emit('close')">
    <input class="ci bq" v-model="q" placeholder="搜索：序号、名称或坐标" />
    <section class="po-card">
      <div class="po-ct">点标记</div>
      <div ref="ptEl" class="bplist mkl" :class="{ painting: P.painting.value }" tabindex="0" title="点一行翻勾选 · 按住拖＝刷选一片 · Shift 点＝连选一段 · Ctrl+A 全选" @keydown="P.onKey">
        <div class="brow ball" @mousedown="P.onHeadDown">
          <input type="checkbox" :checked="P.allOn()" :indeterminate.prop="P.anyOn() && !P.allOn()" />
          <span class="balln">{{ q.trim() ? '(全选搜索结果)' : '(全选)' }}</span>
          <span class="bpk">{{ P.onCount.value }}/{{ pts.length }}</span>
        </div>
        <div v-for="(r, i) in ptRows" :key="r.id" class="brow bitem" :class="{ on: P.isOn(r.id), cur: P.cur.value === i }" @mousedown="P.onRowDown($event, i)">
          <input type="checkbox" :checked="P.isOn(r.id)" />
          <span class="bseq">{{ r.seq }}</span>
          <span class="pbnm" :title="r.name" data-i18n-skip>{{ r.name }}</span>
        </div>
        <div v-if="!ptRows.length" class="empty">{{ pts.length ? '无匹配标记' : '暂无点标记。' }}</div>
      </div>
    </section>
    <section class="po-card">
      <div class="po-ct">地球站</div>
      <div ref="stEl" class="bplist mkl" :class="{ painting: S.painting.value }" tabindex="0" title="点一行翻勾选 · 按住拖＝刷选一片 · Shift 点＝连选一段 · Ctrl+A 全选" @keydown="S.onKey">
        <div class="brow ball" @mousedown="S.onHeadDown">
          <input type="checkbox" :checked="S.allOn()" :indeterminate.prop="S.anyOn() && !S.allOn()" />
          <span class="balln">{{ q.trim() ? '(全选搜索结果)' : '(全选)' }}</span>
          <span class="bpk">{{ S.onCount.value }}/{{ sts.length }}</span>
        </div>
        <div v-for="(r, i) in stRows" :key="r.id" class="brow bitem" :class="{ on: S.isOn(r.id), cur: S.cur.value === i }" @mousedown="S.onRowDown($event, i)">
          <input type="checkbox" :checked="S.isOn(r.id)" />
          <span class="bseq">{{ r.seq }}</span>
          <span class="pbnm" :title="r.name" data-i18n-skip>{{ r.name }}</span>
          <span class="bll" data-i18n-skip>{{ r.ll }}</span>
        </div>
        <div v-if="!stRows.length" class="empty">{{ sts.length ? '无匹配标记' : '暂无地球站。' }}</div>
      </div>
    </section>
    <section class="po-card">
      <div class="po-ct" :title="trajNote">航迹</div>
      <div ref="trEl" class="bplist mkl" :class="{ painting: T.painting.value }" tabindex="0" title="整条勾选，导入时每个航点一行 · 按住拖＝刷选一片 · Shift 点＝连选一段 · Ctrl+A 全选" @keydown="T.onKey">
        <div class="brow ball" @mousedown="T.onHeadDown">
          <input type="checkbox" :checked="T.allOn()" :indeterminate.prop="T.anyOn() && !T.allOn()" />
          <span class="balln">{{ q.trim() ? '(全选搜索结果)' : '(全选)' }}</span>
          <span class="bpk">{{ T.onCount.value }}/{{ trajs.length }}</span>
        </div>
        <div v-for="(r, i) in trRows" :key="r.id" class="brow bitem" :class="{ on: T.isOn(r.id), cur: T.cur.value === i }" @mousedown="T.onRowDown($event, i)">
          <input type="checkbox" :checked="T.isOn(r.id)" />
          <span class="bseq">{{ r.seq }}</span>
          <span class="pbnm" :title="r.name" data-i18n-skip>{{ r.name }}</span>
          <span class="bll" data-i18n-skip>{{ kindOf(r) }} · {{ r.n }}</span>
        </div>
        <div v-if="!trRows.length" class="empty">{{ trajs.length ? '无匹配航迹' : '暂无航迹。' }}</div>
      </div>
    </section>
    <template #foot>
      <span class="cancel" @click="emit('close')">取消</span>
      <span class="save" :class="{ dis: !total }" @click="confirm">导入 {{ total }} 项</span>
    </template>
  </PwDialog>
</template>
