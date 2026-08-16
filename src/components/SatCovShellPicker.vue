<script setup>
// 「从星座取」壳层挑选器 —— 对星覆盖分析的轨道壳层库入口。
//
// 取代原先那个一键按钮（按当前在场卫星的高度全量归并、一股脑加进库）。两条都不合用：
//   ① 在场卫星受主界面「星座分组」限制，选了 GEO 组就取不到 Starlink 的壳层；
//   ② 不给看就先加十几层，加完还得逐层删。
// 现在默认吃【全量在轨目录】（与主界面搜索同一个池，不受分组选择限制），先把每一层是
// 哪些星座、哪些星摆出来，勾中哪层加哪层。
//
// 归并（altKm ± 容差 → 一层）在 shellProj.shellCandidates 里做，纯函数、可离线单测；
// 本组件只管筛选 / 排序 / 勾选。高度取【平均轨道高度】(a−RE)，与时刻无关。
import { ref, computed, watch } from 'vue'
import Icon from './Icon.vue'
import { shellCandidates } from '../viz/grd/shellProj.js'

const props = defineProps({
  sats: { type: Array, default: () => [] },       // 候选池：[{name, noradId, groupLabel, altKm, incDeg, ecc}]
  loading: { type: Boolean, default: false },
  source: { type: String, default: 'all' },       // 'all' 全量在轨目录 ｜ 'live' 当前在场卫星
  existing: { type: Array, default: () => [] }    // 已在库壳层高度 km（标「已在库」，加入时自动跳过）
})
const emit = defineEmits(['close', 'add', 'set-source'])

const SAT_CAP = 200                                // 展开时最多列多少颗（Starlink 一层五千颗，全铺 DOM 会卡）
const q = ref('')
const tol = ref(60)
const sortBy = ref('alt')
const sel = ref(new Set())
const exp = ref(new Set())

// 筛选【先于】归并：搜 starlink 就只按 Starlink 的星归并，层的星数也随之只数它自己的
const pool = computed(() => {
  const k = q.value.trim().toLowerCase()
  if (!k) return props.sats
  return props.sats.filter((s) => String(s.groupLabel || '').toLowerCase().includes(k)
    || String(s.name || '').toLowerCase().includes(k) || String(s.noradId || '').includes(k))
})
const rows = computed(() => {
  const r = shellCandidates(pool.value, Math.max(1, Number(tol.value) || 1))
  return sortBy.value === 'n' ? r.slice().sort((a, b) => b.n - a.n || a.altKm - b.altKm) : r
})
// 归并口径一变，层的身份（altKm）就变了 → 勾选与展开一并作废
watch([tol, q], () => { sel.value = new Set(); exp.value = new Set() })
watch(() => props.source, () => { sel.value = new Set(); exp.value = new Set() })

const inLib = (alt) => props.existing.some((x) => Math.abs(x - alt) <= 1)
function toggle(r) { const s = new Set(sel.value); if (s.has(r.altKm)) s.delete(r.altKm); else s.add(r.altKm); sel.value = s }
function toggleExp(r) { const s = new Set(exp.value); if (s.has(r.altKm)) s.delete(r.altKm); else s.add(r.altKm); exp.value = s }
function selAll() { sel.value = new Set(rows.value.filter((r) => !inLib(r.altKm)).map((r) => r.altKm)) }
function selNone() { sel.value = new Set() }
function incText(r) {
  if (r.incLo == null) return '—'
  return r.incHi - r.incLo < 0.5 ? r.incLo.toFixed(1) + '°' : r.incLo.toFixed(1) + '–' + r.incHi.toFixed(1) + '°'
}
// 层名 = 星最多的那个星座（层高度已单独成列，名字里不再重复）；多星座层缀上「+n」
function shellName(r) {
  if (!r.groups.length) return ''
  return r.groups[0].name + (r.groups.length > 1 ? '+' + (r.groups.length - 1) : '')
}
function add() {
  const items = rows.value.filter((r) => sel.value.has(r.altKm)).map((r) => ({ altKm: r.altKm, name: shellName(r) }))
  if (items.length) emit('add', items)
}
</script>

<template>
  <div class="sat-mask" @click.self="emit('close')">
    <div class="sp-dlg">
      <div class="sdh"><span>从星座取壳层</span><span class="csx" title="关闭" @click="emit('close')"><Icon name="x" :size="12" /></span></div>

      <div class="sp-bar">
        <select class="ci src" :value="source" @change="emit('set-source', $event.target.value)">
          <option value="all">全量在轨目录</option>
          <option value="live">当前在场卫星</option>
        </select>
        <input class="ci q" v-model="q" placeholder="筛选：星座 / 卫星名 / NORAD" />
        <label class="tolb">归并容差<input class="ci n" type="number" step="10" min="1" v-model.number="tol" /><i>km</i></label>
        <span class="seg sm">
          <span class="sg" :class="{ on: sortBy === 'alt' }" @click="sortBy = 'alt'">按高度</span>
          <span class="sg" :class="{ on: sortBy === 'n' }" @click="sortBy = 'n'">按星数</span>
        </span>
        <span class="cnt">{{ pool.length }} 星 · {{ rows.length }} 层</span>
      </div>

      <div class="sp-head">
        <span class="c-ck"></span><span class="c-alt">高度 (km)</span><span class="c-n">星数</span>
        <span class="c-inc">倾角</span><span class="c-grp">星座</span>
      </div>
      <div class="sp-body">
        <div v-if="loading" class="sp-empty">载入中…</div>
        <div v-else-if="!rows.length" class="sp-empty">没有可归并的卫星。</div>
        <template v-for="r in rows" :key="r.altKm">
          <div class="sp-row" :class="{ on: sel.has(r.altKm) }" @click="toggle(r)">
            <span class="c-ck"><input type="checkbox" :checked="sel.has(r.altKm)" @click.stop @change="toggle(r)" /></span>
            <i class="tri" :class="{ open: exp.has(r.altKm) }" :title="`列出该层的 ${r.n} 颗星`" @click.stop="toggleExp(r)"><Icon name="chevron-right" :size="10" /></i>
            <span class="c-alt">{{ r.altKm.toFixed(1) }}<em v-if="r.hiKm - r.loKm >= 1">±{{ ((r.hiKm - r.loKm) / 2).toFixed(0) }}</em></span>
            <span class="c-n">{{ r.n }}</span>
            <span class="c-inc">{{ incText(r) }}</span>
            <span class="c-grp">
              <span v-for="g in r.groups.slice(0, 3)" :key="g.name" class="gchip">{{ g.name }}<i>{{ g.n }}</i></span>
              <span v-if="r.groups.length > 3" class="gmore">+{{ r.groups.length - 3 }}</span>
            </span>
            <span v-if="r.eccMax >= 0.05" class="ecc" :title="`层内最大偏心率 ${r.eccMax}`">e {{ r.eccMax.toFixed(2) }}</span>
            <span v-if="inLib(r.altKm)" class="lib">已在库</span>
          </div>
          <div v-if="exp.has(r.altKm)" class="sp-sats">
            <div v-for="s in r.sats.slice(0, SAT_CAP)" :key="s.noradId || s.name" class="sp-sat">
              <span class="s-nm" :title="s.name" data-i18n-skip>{{ s.name }}</span>
              <span class="s-id">{{ s.noradId || '' }}</span>
              <span class="s-gp">{{ s.groupLabel }}</span>
              <span class="s-alt">{{ s.altKm.toFixed(1) }}</span>
              <span class="s-inc">{{ Number.isFinite(s.incDeg) ? s.incDeg.toFixed(1) + '°' : '' }}</span>
            </div>
            <div v-if="r.sats.length > SAT_CAP" class="sp-more">共 {{ r.n }} 颗 · 列出前 {{ SAT_CAP }}</div>
          </div>
        </template>
      </div>

      <div class="sdfoot">
        <span class="save ghost" @click="selAll">全选</span>
        <span class="save ghost" @click="selNone">全不选</span>
        <span class="cnt sel">已选 {{ sel.size }} 层</span>
        <span class="save ghost" @click="emit('close')">取消</span>
        <span class="save" :class="{ dis: !sel.size }" @click="add">加入壳层</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 弹窗外壳与「对星性能表选项」同源（SatCovWindows.vue 的 .sat-mask/.sdh/.sdfoot 一套）：
   那份是 scoped 的、进不到本组件，故这里带一份同值副本。改动请两处对照。 */
.sat-mask { position: absolute; inset: 0; background: rgba(4, 8, 14, .55); display: flex; align-items: center; justify-content: center; z-index: 70; }
.sp-dlg { width: 880px; max-width: calc(100% - 32px); height: 620px; max-height: 88%; display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border-strong); border-radius: 8px; box-shadow: 0 16px 48px rgba(0, 0, 0, .55); font-size: 12px; color: var(--text); }
.sdh { display: flex; align-items: center; padding: 11px 14px; border-bottom: 1px solid var(--border); font-family: var(--font-serif); font-size: 14px; }
.sdh .csx { margin-left: auto; cursor: pointer; color: var(--text-faint); display: inline-flex; }
.sdh .csx:hover { color: var(--text); }
.sdfoot { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--border); }
.sdfoot .save { background: var(--accent); color: var(--bg); padding: 4px 18px; cursor: pointer; font-size: 12px; }
.sdfoot .save.ghost { background: transparent; color: var(--text); border: 1px solid var(--border); padding: 3px 12px; }
.sdfoot .save.ghost:hover { border-color: var(--accent); }
.sdfoot .save.dis { opacity: .4; pointer-events: none; }
.sdfoot .sel { margin-left: auto; }
/* 工具条 */
.sp-bar { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--border); flex: none; flex-wrap: wrap; }
.ci { border: 1px solid var(--border); background: var(--bg); color: var(--text); padding: 3px 6px; font-size: 12px; outline: none; border-radius: 3px; }
.ci.src { flex: none; width: 128px; }
.ci.q { flex: 1; min-width: 120px; }
.ci.n { width: 56px; font-family: var(--font-mono); text-align: right; }
.tolb { display: flex; align-items: center; gap: 5px; color: var(--text-muted); white-space: nowrap; }
.tolb i { font-style: normal; color: var(--text-faint); font-size: 11px; }
.seg { display: flex; border: 1px solid var(--border); border-radius: 3px; overflow: hidden; }
.seg .sg { padding: 3px 10px; cursor: pointer; color: var(--text-muted); }
.seg .sg.on { background: var(--accent); color: var(--bg); }
.cnt { font-family: var(--font-mono); font-size: 11px; color: var(--text-faint); white-space: nowrap; }
/* 层列表：表头与行同一套列宽 */
.sp-head, .sp-row { display: flex; align-items: center; gap: 8px; padding: 3px 14px; }
.sp-head { flex: none; border-bottom: 1px solid var(--border); color: var(--text-muted); font-size: 11px; padding-top: 6px; padding-bottom: 6px; }
.sp-head .c-alt { margin-left: 20px; }   /* 对齐行里的展开三角（12px + 8px gap） */
.c-ck { flex: none; width: 14px; display: inline-flex; }
.c-ck input { accent-color: var(--accent); }
.tri { flex: none; width: 12px; font-style: normal; display: inline-flex; align-items: center; justify-content: center; color: var(--text-faint); cursor: pointer; transition: transform .12s; }
.tri.open { transform: rotate(90deg); }
.tri:hover { color: var(--text); }
.c-alt { flex: none; width: 96px; font-family: var(--font-mono); text-align: right; }
.c-alt em { font-style: normal; color: var(--text-faint); font-size: 10px; margin-left: 3px; }
.c-n { flex: none; width: 52px; font-family: var(--font-mono); text-align: right; color: var(--text-muted); }
.c-inc { flex: none; width: 92px; font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); text-align: right; }
.c-grp { flex: 1; min-width: 0; display: flex; gap: 4px; overflow: hidden; }
.sp-body { flex: 1; min-height: 0; overflow-y: auto; }
.sp-row { cursor: pointer; border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent); }
.sp-row:hover { background: color-mix(in srgb, var(--text) 5%, transparent); }
.sp-row.on { background: color-mix(in srgb, var(--accent) 13%, transparent); }
.gchip { flex: none; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 1px solid var(--border); border-radius: 8px; padding: 0 7px; font-size: 10.5px; line-height: 16px; color: var(--text-muted); }
.gchip i { font-style: normal; margin-left: 5px; color: var(--text-faint); font-family: var(--font-mono); }
.gmore { color: var(--text-faint); font-size: 10.5px; }
.ecc { flex: none; font-family: var(--font-mono); font-size: 10px; color: #d08b5a; }
.lib { flex: none; font-size: 9.5px; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent); border-radius: 8px; padding: 0 6px; line-height: 15px; }
.sp-empty { padding: 26px; text-align: center; color: var(--text-faint); }
/* 展开：该层的卫星清单 */
.sp-sats { background: color-mix(in srgb, var(--text) 3%, transparent); border-bottom: 1px solid var(--border); padding: 3px 0; }
.sp-sat { display: flex; align-items: center; gap: 8px; padding: 1px 14px 1px 46px; font-size: 11px; color: var(--text-muted); }
.sp-sat:hover { color: var(--text); }
.s-nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.s-id, .s-alt, .s-inc { flex: none; font-family: var(--font-mono); font-size: 10.5px; color: var(--text-faint); }
.s-id { width: 56px; text-align: right; }
.s-alt { width: 66px; text-align: right; }
.s-inc { width: 52px; text-align: right; }
.s-gp { flex: none; width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; color: var(--text-faint); }
.sp-more { padding: 3px 14px 3px 46px; font-family: var(--font-mono); font-size: 10.5px; color: var(--text-faint); }
</style>
