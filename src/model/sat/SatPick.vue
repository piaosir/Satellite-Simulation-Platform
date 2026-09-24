<script setup>
// 卫星页「选星」：四路来源——目录星（与 NGSO / 端到端「搜索卫星」同一份共享候选池）、链路预算四窗卫星库条目、GRD 卫星树、已有绑定的星。
// 点一行即选中（绑定键规则见 satSources.js 头注）；3D 页「编辑…」带 satKey 打开工作台时直接选中，不经这里。
import { ref, shallowRef, computed, inject, watch, onMounted } from 'vue'
import Icon from '../../components/Icon.vue'
import MdSec from '../MdSec.vue'
import { catalogPool, searchPool, lbLibrarySats, grdTreeSats, grdSatKey, lbSatKey } from '../satSources.js'
import { LB_NS_LABEL } from '../mountLogic.js'
import { keyLabel } from '../satStore.js'

const sat = inject('sat')
const S = sat.st
const SRC = [
  { key: 'cat', label: '目录', tip: '目录星：CelesTrak active 全域 + 常用名组 + 本机自定义卫星库 / 星历 / 自定义星座（与链路预算「搜索卫星」同一份候选池）' },
  { key: 'lb', label: '链路预算', tip: '链路预算四个窗口（GEO / NGSO / 再生式 / 端到端）的卫星库条目' },
  { key: 'grd', label: 'GRD 树', tip: '星座 3D 页覆盖图（GRD）卫星树里的星' },
  { key: 'bound', label: '已绑定', tip: '绑定表里已有记录（模型 / 挂点 / 姿态律）的星' }
]
const src = ref((() => { try { return localStorage.getItem('model/satSrc') || 'cat' } catch { return 'cat' } })())
watch(src, (v) => { try { localStorage.setItem('model/satSrc', v) } catch { /* 便利数据 */ } })
const q = ref('')
const pool = shallowRef(null), poolBusy = ref(false), poolErr = ref('')
const lbList = shallowRef([]), grdList = shallowRef([])

async function ensurePool() {
  if (pool.value || poolBusy.value) return
  poolBusy.value = true; poolErr.value = ''
  try { pool.value = await catalogPool() } catch (e) { poolErr.value = (e && e.message) || String(e) }
  poolBusy.value = false
}
async function loadLb() { try { lbList.value = await lbLibrarySats() } catch { lbList.value = [] } }
function loadGrd() { try { grdList.value = grdTreeSats() } catch { grdList.value = [] } }
watch(src, (v) => { if (v === 'cat') ensurePool(); else if (v === 'lb') loadLb(); else if (v === 'grd') loadGrd() }, { immediate: true })
onMounted(() => { if (!S.loaded) sat.loadAll() })

const norm = (s) => String(s || '').toUpperCase().replace(/[\s\-_()（）]+/g, '')
const match = (...xs) => { const k = norm(q.value); return !k || xs.some((x) => norm(x).includes(k)) }
const rows = computed(() => {
  const all = S.all || {}
  const tag = (k) => (all[k] ? (all[k].mounts || []).length : null)
  if (src.value === 'cat') {
    if (!pool.value) return []
    const hits = q.value.trim() ? searchPool(pool.value, q.value, 200) : []
    return hits.map((x) => ({ key: x.key, name: x.name, sub: [x.norad && Number(x.norad) < 800000 ? 'NORAD ' + x.norad : '', x.group].filter(Boolean).join(' · '), n: tag(x.key), hint: { poolRec: x.rec } }))
  }
  if (src.value === 'lb') {
    return lbList.value.filter((e) => match(e.name, e.summary, e.id)).map((e) => {
      const key = lbSatKey(e.ns, e.id)
      return { key, name: e.name, sub: [LB_NS_LABEL[e.ns] || e.ns, e.summary].filter(Boolean).join(' · '), n: tag(key), hint: { lbEntry: e } }
    }).filter((r) => r.key)
  }
  if (src.value === 'grd') {
    return grdList.value.filter((s) => match(s.satName, s.folder, s.noradId)).map((s) => {
      // 有目录身份的星用 norad:<号>（与 3D 页同一颗星同一个键），没有的用 grdsat:<folder>（D8）
      const n = Number(s.noradId)
      const key = Number.isInteger(n) && n >= 1 && n < 800000 ? 'norad:' + n : grdSatKey(s.folder)
      return { key, name: s.satName || s.folder, sub: [n ? 'NORAD ' + n : '', (s.antennas || []).length ? (s.antennas.length + ' 副天线') : ''].filter(Boolean).join(' · '), n: tag(key), hint: { treeNode: s } }
    }).filter((r) => r.key)
  }
  return sat.boundList.value.filter((b) => match(b.label, b.key)).map((b) => ({ key: b.key, name: b.label, sub: b.key, n: b.n, hint: null }))
})
function pick(r) { sat.selectSat({ satKey: r.key, label: r.name, hint: r.hint }) }
const emptyText = computed(() => {
  if (src.value === 'cat') return poolBusy.value ? '' : (poolErr.value ? poolErr.value : (q.value.trim() ? '没有匹配的卫星。' : ''))
  if (src.value === 'bound') return '还没有绑定。'
  return q.value.trim() ? '没有匹配的卫星。' : (src.value === 'lb' ? '卫星库为空。' : 'GRD 树为空。')
})
</script>

<template>
  <MdSec id="s-pick" title="选星" :summary="S.satKey ? S.label : ''">
    <div class="sp-seg lbu-seg">
      <button v-for="s in SRC" :key="s.key" :class="{ on: src === s.key }" :title="s.tip" @click="src = s.key">{{ s.label }}</button>
    </div>
    <label class="sp-search">
      <Icon name="search" :size="13" />
      <input v-model="q" class="sp-q" type="text" spellcheck="false" :placeholder="src === 'cat' ? '名称 / NORAD' : '筛选'" title="名称、常用名、NORAD 号（大小写、空格、连字符不计）" />
      <button v-if="q" type="button" class="sp-x" title="清空" @click="q = ''"><Icon name="x" :size="12" /></button>
    </label>
    <div class="sp-list">
      <div v-if="src === 'cat' && poolBusy" class="sp-busy"><span class="sp-spin"></span></div>
      <button v-for="r in rows" :key="r.key" type="button" class="sp-row" :class="{ on: r.key === S.satKey }" :title="r.key" @click="pick(r)">
        <span class="sp-n" data-i18n-skip>{{ r.name }}</span>
        <span v-if="r.n != null" class="sp-b" :title="'已绑定 · ' + r.n + ' 个挂点'"><Icon name="locate-fixed" :size="11" /><span data-i18n-skip>{{ r.n }}</span></span>
        <span class="sp-s" data-i18n-skip>{{ r.sub }}</span>
      </button>
      <div v-if="!rows.length && emptyText" class="lb-placeholder sp-empty">{{ emptyText }}</div>
    </div>
    <div v-if="S.satKey" class="sp-cur">
      <Icon name="satellite" :size="13" />
      <span class="sp-cur-t" :title="S.satKey" data-i18n-skip>{{ S.label || keyLabel(S.satKey) }}</span>
      <span class="sp-cur-k" data-i18n-skip>{{ S.satKey }}</span>
    </div>
  </MdSec>
</template>

<style scoped>
.sp-seg { display: flex; width: 100%; }
.sp-seg > button { flex: 1 1 auto; min-width: 0; padding: 4px 3px; height: var(--h-ctl); font-size: var(--fs-2); overflow: hidden; text-overflow: ellipsis; }
.sp-search { display: flex; align-items: center; gap: 5px; height: var(--h-ctl); padding: 0 6px; color: var(--text-faint);
  background: var(--field-bg); border: 1px solid var(--field-border); border-radius: var(--r-ctl); }
.sp-search:focus-within { border-color: var(--accent-ui); }
.sp-q { flex: 1; min-width: 0; height: 100%; border: 0 !important; background: transparent !important; outline: none; padding: 0 !important; font-size: var(--fs-3); color: var(--text); box-shadow: none !important; }
.sp-x { display: inline-flex; padding: 0; border: 0; background: transparent; color: var(--text-faint); cursor: pointer; }
.sp-x:hover { color: var(--text); }
.sp-list { max-height: 196px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--r-ctl); display: flex; flex-direction: column; }
.sp-list:empty { display: none; }
.sp-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-rows: auto auto; column-gap: 6px; align-items: baseline; text-align: left;
  padding: 3px 7px; border: 0; border-bottom: 1px solid var(--lb-rule-soft); background: transparent; color: var(--text); font: inherit; cursor: pointer; transition: var(--t-state); }
.sp-row:last-child { border-bottom: 0; }
.sp-row:hover { background: var(--wash-hover, var(--surface)); }
.sp-row:active { background: var(--press, var(--surface-2)); }
.sp-row.on { background: var(--accent-ui-weak); color: var(--text); box-shadow: inset 2px 0 0 var(--accent-ui); transition-duration: 0s; }
.sp-n { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-3); font-weight: 600; }
.sp-b { display: inline-flex; align-items: center; gap: 2px; font-size: var(--fs-1); color: var(--accent-ui); font-variant-numeric: tabular-nums; }
.sp-s { grid-column: 1 / -1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-1); color: var(--text-faint); }
.sp-empty { padding: 8px 0; }
.sp-busy { display: flex; justify-content: center; padding: 10px 0; }
.sp-spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--text) 18%, transparent); border-top-color: var(--accent-ui); animation: sp-spin .7s linear infinite; }
@keyframes sp-spin { to { transform: rotate(360deg); } }
.sp-cur { display: flex; align-items: center; gap: 6px; min-height: 22px; color: var(--text-muted); }
.sp-cur-t { flex: none; max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-3); font-weight: 700; color: var(--text); }
.sp-cur-k { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-1); font-family: var(--font-mono); color: var(--text-faint); }
</style>
