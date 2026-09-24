<script setup>
// 解析高斯天线（STK Gaussian）的方向图参数行 —— 波束合成「高斯组」与覆盖分析「方向图」两处共用一份。
// 三驱动（口径 / 波束宽 / 峰值增益）选一个可编辑，另两项是算出值（STK InputType 同款）；
// 每次改动都经 syncModel 把三项拉齐后整份发出（update），宿主 Object.assign 回自己的模型对象。
import { computed } from 'vue'
import NumBox from './NumBox.vue'
import { solveStk, syncModel, promoteDrv, DRV_DIGITS } from '../viz/grd/gaussStk.js'

const props = defineProps({
  model: { type: Object, required: true },     // { fGHz, drv, D, bw3, G, eff, back, k }
  readonly: { type: Boolean, default: false }
})
const emit = defineEmits(['update'])

const r = computed(() => solveStk(props.model))
const drv = computed(() => (props.model.drv === 'bw' || props.model.drv === 'G') ? props.model.drv : 'D')
const fmt = (v, d) => (Number.isFinite(v) ? +v.toFixed(d) : '')
// 非驱动项显示算出值；驱动项显示给定值（用户打的原值，或切驱动时按显示位数圆过的那个值，见 promoteDrv）
const vD = computed(() => (drv.value === 'D' ? props.model.D : (r.value.ok ? fmt(r.value.Dm, DRV_DIGITS.D) : '')))
const vBw = computed(() => (drv.value === 'bw' ? props.model.bw3 : (r.value.ok ? fmt(r.value.th3Deg, DRV_DIGITS.bw) : '')))
const vG = computed(() => (drv.value === 'G' ? props.model.G : (r.value.ok ? fmt(r.value.g0Dbi, DRV_DIGITS.G) : '')))

function put(p) {
  if (props.readonly) return
  const next = syncModel({ ...props.model, ...p })
  emit('update', next)
}
// 切驱动：先把当前三项拉齐（非驱动项存的就是算出值），新驱动项圆到刚才显示的位数 —— 切过去数值不跳、也不冒出 17 位小数
function setDrv(d) { if (props.readonly || d === drv.value) return; emit('update', promoteDrv(props.model, d)) }
</script>

<template>
  <div class="gmf">
    <div class="srow"><label>设计频率</label>
      <NumBox class="ci" :model-value="model.fGHz" :min="0.001" :step="0.1" :disabled="readonly" @commit="(v) => put({ fGHz: v })" /><span class="u">GHz</span>
    </div>
    <div class="srow"><label>输入量</label>
      <div class="seg" :class="{ ro: readonly }">
        <span class="sg" :class="{ on: drv === 'D' }" title="给定口径，算出波束宽与峰值增益" @click="setDrv('D')">口径</span>
        <span class="sg" :class="{ on: drv === 'bw' }" title="给定 3 dB 波束宽，算出口径与峰值增益（峰值增益 = π²/θ3²，与效率无关）" @click="setDrv('bw')">波束宽</span>
        <span class="sg" :class="{ on: drv === 'G' }" title="给定峰值增益，算出波束宽与口径" @click="setDrv('G')">峰值增益</span>
      </div>
    </div>
    <div class="srow"><label>口径</label>
      <NumBox class="ci" :model-value="vD" :min="0.001" :step="0.1" :disabled="readonly || drv !== 'D'" @commit="(v) => put({ D: v })" /><span class="u">m</span>
    </div>
    <div class="srow"><label>3 dB 波束宽</label>
      <NumBox class="ci" :model-value="vBw" :min="0.0001" :max="179" :step="0.1" :disabled="readonly || drv !== 'bw'" @commit="(v) => put({ bw3: v })" /><span class="u">°</span>
    </div>
    <div class="srow"><label>峰值增益</label>
      <NumBox class="ci" :model-value="vG" :min="0.01" :step="0.1" :disabled="readonly || drv !== 'G'" @commit="(v) => put({ G: v })" /><span class="u">dBi</span>
    </div>
    <div class="srow"><label>口径效率</label>
      <NumBox class="ci" :model-value="model.eff" :min="1" :max="100" :step="1" :disabled="readonly" @commit="(v) => put({ eff: v })" /><span class="u">%</span>
    </div>
    <div class="srow"><label>背瓣增益</label>
      <NumBox class="ci" :model-value="model.back" :step="1" :disabled="readonly" title="偏离视轴超过 90° 时的增益（绝对值）" @commit="(v) => put({ back: v })" /><span class="u">dBi</span>
    </div>
    <div class="srow"><label>滚降系数</label>
      <select :value="model.k === '4ln2' ? '4ln2' : 'stk'" :disabled="readonly" title="相对电平 = −k·10lg(e)·(θ/θ3)²；STK 取 k = 2.76，严格半功率取 k = 4ln2" @change="put({ k: $event.target.value })">
        <option value="stk">STK（k = 2.76）</option>
        <option value="4ln2">4ln2（严格半功率）</option>
      </select>
    </div>
  </div>
</template>

<style scoped>
/* 行与控件的口径同 GrdSetSections.vue（宿主 scoped 样式进不来，这里自带一份；改动请对照） */
.gmf > * + * { margin-top: 8px; }
.srow .ci, .srow select { flex: 1; min-width: 0; border: 1px solid var(--field-border); background-color: var(--field-bg); padding: 0 7px; font-size: var(--fs-3); outline: none; color: var(--text); }
.srow select { min-width: 116px; }
.srow .ci:disabled, .srow select:disabled { background: var(--surface); color: var(--text-muted); cursor: not-allowed; border-style: dashed; }
.srow .u { flex: none; min-width: 34px; text-align: right; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.seg { display: flex; border: 1px solid var(--border-strong); border-radius: var(--r-ctl); overflow: hidden; }
.seg .sg { padding: 2px 12px; line-height: 16px; cursor: pointer; color: var(--text-muted); user-select: none; white-space: nowrap; transition: var(--t-state); }
.seg .sg + .sg { border-left: 1px solid var(--border); }
.seg .sg:hover:not(.on) { background: var(--surface-2); color: var(--text); }
.seg .sg:active:not(.on) { box-shadow: var(--press); transition-duration: 0s; }
.seg .sg.on { background: var(--sel-fill); color: var(--sel-on); transition-duration: 0s; }
.seg .sg.on, .seg .sg.on + .sg { border-left-color: transparent; }
.seg.ro .sg { cursor: default; }
.seg.ro .sg:hover:not(.on) { background: none; color: var(--text-muted); }
</style>
