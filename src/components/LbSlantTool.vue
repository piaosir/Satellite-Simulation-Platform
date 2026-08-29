<script setup>
// 「斜距工具」—— 手动几何模式下的斜距核对与批量填入（NGSO / 再生式两窗共用）。
//
// 手动几何模式里仰角与斜距是用户自己给的两个数，彼此并不联动（软件不替用户假定轨道）。
// 本工具只做一件事：把「轨道高度 × 仰角」换成斜距，让用户能核对手里那个数，并可按各行自己的
// 仰角一次性填进链路表。
//
// 口径：WGS-84 椭球 + 站点大地纬度/海拔，方位取【绕站一圈斜距最大】的那个（北半球正北、南半球正南）。
// 真实站点的地心距随纬度变、大地垂线又不过地心，故同一 (纬度, 仰角, 高度) 下斜距还随方位差出几十公里；
// 手动模式没有方位这个量（星在动），取最大值与「最差工况」口径一致，也不会比自动几何偏乐观。
// 换算式见 shared/slantRange.js。
import { ref, computed, watch } from 'vue'
import Icon from './Icon.vue'
import { wgs84Geometry, altFromSlantWgs84, oneWayDelayMs } from '../shared/slantRange.js'
import { pf } from '../shared/num.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  altKm: { type: [String, Number], default: '' },     // 初值：当前卫星条目的轨道高度
  elevDeg: { type: [String, Number], default: 10 },   // 初值：当前行仰角
  latDeg: { type: [String, Number], default: '' },    // 初值：当前行站点纬度
  staAltM: { type: [String, Number], default: 0 },    // 初值：当前行站点海拔（m，与站表同单位）
  rowCount: { type: Number, default: 0 },
  hasRow: { type: Boolean, default: false },          // 是否有聚焦行（无则只给「全部行」）
  sideLabel: { type: String, default: '' }            // 再生式：当前子链路模式名（上行/下行）
})
const emit = defineEmits(['close', 'fill'])

const h = ref('')
const el = ref('')
const lat = ref('')
const staAlt = ref('')
const dIn = ref('')
// 每次打开按宿主当前值重播种（换卫星 / 换行后再开是新的一次核对）
watch(() => props.open, (o) => {
  if (!o) return
  h.value = String(props.altKm ?? '')
  el.value = String(props.elevDeg ?? '')
  lat.value = String(props.latDeg ?? '')
  staAlt.value = String(props.staAltM ?? 0)
  dIn.value = ''
})

const fmt = (v, dp) => (v == null || !isFinite(v) ? '—' : Number(v).toFixed(dp))
const hNum = computed(() => pf(h.value))
const elNum = computed(() => pf(el.value))
const latNum = computed(() => pf(lat.value))
const staAltKm = computed(() => (pf(staAlt.value) || 0) / 1000)
const geo = computed(() => wgs84Geometry(latNum.value, staAltKm.value, elNum.value, hNum.value))
const tauOut = computed(() => oneWayDelayMs(geo.value && geo.value.slantKm))
const hBack = computed(() => altFromSlantWgs84(latNum.value, staAltKm.value, elNum.value, pf(dIn.value)))

// 速查表：常用仰角一列 —— 手里那个数落在哪一档，一眼就对得上
const QUICK_ELEV = [0, 5, 10, 15, 20, 30, 45, 60, 90]
const quick = computed(() => QUICK_ELEV.map((e) => {
  const g = wgs84Geometry(latNum.value, staAltKm.value, e, hNum.value)
  return { e, d: g && g.slantKm }
}))

const canFill = computed(() => hNum.value > 0 && props.rowCount > 0)
function fill(scope) { if (canFill.value) emit('fill', { altKm: hNum.value, scope }) }
</script>

<template>
  <div v-if="open" class="slt-mask">
    <div class="slt" role="dialog" aria-modal="true">
      <div class="slt-hd">
        斜距工具<span v-if="sideLabel" class="slt-sub">· {{ sideLabel }}</span>
        <span class="slt-sp"></span>
        <button class="slt-x" title="关闭" aria-label="关闭" @click="emit('close')"><Icon name="x" :size="12" /></button>
      </div>

      <div class="slt-bd">
        <label class="slt-f"><span class="slt-l">轨道高度</span>
          <input v-model="h" class="slt-in mono" inputmode="decimal" /><i class="slt-u">km</i></label>
        <label class="slt-f" title="站点大地纬度：WGS-84 椭球上站点的地心距随纬度变，斜距因此随纬度变"><span class="slt-l">站点纬度</span>
          <input v-model="lat" class="slt-in mono" inputmode="decimal" /><i class="slt-u">°</i></label>
        <label class="slt-f"><span class="slt-l">站点海拔</span>
          <input v-model="staAlt" class="slt-in mono" inputmode="decimal" /><i class="slt-u">m</i></label>

        <div class="slt-sep"></div>

        <label class="slt-f"><span class="slt-l">仰角</span>
          <input v-model="el" class="slt-in mono" inputmode="decimal" /><i class="slt-u">°</i></label>
        <div class="slt-out">
          <span class="slt-big mono">{{ fmt(geo && geo.slantKm, 2) }}</span><i>km</i>
          <span class="slt-aux mono" title="离轴角 η：卫星看该站相对天底的夹角">η {{ fmt(geo && geo.nadirDeg, 2) }}°</span>
          <span class="slt-aux mono" title="地心角 γ：站点相对星下点的地心张角">γ {{ fmt(geo && geo.centralDeg, 2) }}°</span>
          <span class="slt-aux mono" title="单程传播时延">τ {{ fmt(tauOut, 3) }} ms</span>
          <span class="slt-aux mono" title="绕站一圈中斜距最大的方位（手动几何没有方位这个量，故取最大值）">方位 {{ fmt(geo && geo.azDeg, 0) }}°</span>
        </div>

        <div class="slt-sep"></div>

        <label class="slt-f"><span class="slt-l">斜距</span>
          <input v-model="dIn" class="slt-in mono" inputmode="decimal" placeholder="反算轨道高度" /><i class="slt-u">km</i></label>
        <div class="slt-out">
          <span class="slt-big mono">{{ fmt(hBack, 1) }}</span><i>km</i>
          <span class="slt-aux">按上方仰角</span>
        </div>

        <div class="slt-sep"></div>

        <table class="slt-tb">
          <thead><tr><th>仰角 (°)</th><th>斜距 (km)</th></tr></thead>
          <tbody>
            <tr v-for="q in quick" :key="q.e" :class="{ on: Math.abs(q.e - elNum) < 1e-9 }">
              <td class="mono">{{ q.e }}</td><td class="mono">{{ fmt(q.d, 1) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="slt-ft">
        <button class="slt-btn" :disabled="!canFill || !hasRow"
                title="按该行自己的纬度/海拔/仰角与上方轨道高度算出斜距，填入当前行" @click="fill('row')">填入当前行</button>
        <button class="slt-btn" :disabled="!canFill"
                :title="`按各行自己的纬度/海拔/仰角与上方轨道高度算出斜距，填入全部 ${rowCount} 行`" @click="fill('all')">填入全部行</button>
        <span class="slt-sp"></span>
        <button class="slt-btn" @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.slt-mask { position: fixed; inset: 0; background: rgba(0, 0, 0, .38); display: flex; align-items: center; justify-content: center; z-index: 60; }
.slt { width: 360px; max-height: 88vh; display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--border-strong, var(--border)); border-radius: var(--r-card, 4px); box-shadow: var(--shadow-3); }
.slt-hd { display: flex; align-items: center; gap: 6px; padding: 8px 10px; font-size: var(--fs-4); color: var(--text); border-bottom: 1px solid var(--border); }
.slt-sub { color: var(--text-faint); font-size: var(--fs-3); }
.slt-sp { flex: 1; }
.slt-x { display: inline-flex; align-items: center; padding: 2px; background: none; border: none; color: var(--text-muted); cursor: pointer; }
.slt-x:hover { color: var(--text); }
.slt-bd { padding: 10px; overflow-y: auto; }
.slt-sep { height: 1px; background: var(--border); margin: 9px 0; }
.slt-f { display: grid; grid-template-columns: 62px 1fr 26px; align-items: center; gap: 6px; }
.slt-f + .slt-f { margin-top: 5px; }
.slt-l { font-size: var(--fs-3); color: var(--text-muted); }
.slt-in { font: inherit; font-size: var(--fs-3); padding: 4px 7px; width: 100%; background: var(--field-bg); color: var(--text); border: 1px solid var(--field-border); border-radius: var(--r-ctl, 2px); }
.slt-in:focus { outline: none; border-color: var(--accent-ui); }
.slt-u { font-size: var(--fs-2); color: var(--text-faint); font-style: normal; }
.mono { font-family: var(--font-mono); }
.slt-out { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; margin: 6px 0 0 68px; }
.slt-big { font-size: var(--fs-5); color: var(--accent); }
.slt-out i { font-size: var(--fs-2); color: var(--text-faint); font-style: normal; }
.slt-aux { font-size: var(--fs-2); color: var(--text-muted); }
.slt-tb { width: 100%; border-collapse: collapse; font-size: var(--fs-2); }
.slt-tb th { text-align: right; font-weight: 500; color: var(--text-faint); padding: 2px 6px; border-bottom: 1px solid var(--border); }
.slt-tb td { text-align: right; padding: 2px 6px; color: var(--text-muted); }
.slt-tb tr.on td { color: var(--text); background: var(--surface); }
/* 读数可框选复制：全局 user-select:none 是为了拖拽手感，但这些数就是拿来抄走的（口径同卫星名那处）。
   文本光标作可选的提示；只放开读数，标签/按钮仍不可选，免得框选时连带选中一堆字。 */
.slt-out, .slt-tb td { user-select: text; -webkit-user-select: text; cursor: text; }
.slt-ft { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--border); }
/* 页脚按钮：与工作台 .lb-mini 同款（宿主样式是 scoped，进不到子组件，故本组件自带一份） */
.slt-btn { font: inherit; font-size: var(--fs-2); line-height: 1; padding: 4px 9px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.slt-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.slt-btn:disabled { opacity: .45; cursor: not-allowed; }
</style>
