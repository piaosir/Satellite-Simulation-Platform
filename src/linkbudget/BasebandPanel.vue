<script setup>
import { computed, ref, watch } from 'vue'
import Icon from '../components/Icon.vue'

// 基带参数面板 —— 严格照搬小程序基带卡片：DVB/MODCOD 快选、Eb/N₀⇄Es/N₀ 切换（带换算）、
// 频谱效率⇄帧效率切换、实时载波带宽/符号率（可编辑反算信息速率）。
const props = defineProps({
  form: { type: Object, required: true },   // 共享基带参数（含 noiseRatioMode / rsCodeMode / dvbStandard / modcodIndex）
  options: { type: Object, default: () => ({}) }
})

const MOD_FACTORS = { BPSK: 1, QPSK: 2, '8PSK': 3, '8QAM': 3, '16QAM': 4, '16APSK': 4, '32APSK': 5, '64QAM': 6, '64APSK': 6, '128APSK': 7, '256APSK': 8 }
function parseFrac(s, def) {
  if (s === '' || s == null) return def
  if (typeof s === 'number') return s
  s = String(s).trim()
  if (s.includes('/')) { const p = s.split('/'); const a = Number(p[0]); const b = Number(p[1]); return b ? a / b : def }
  const n = parseFloat(s); return isNaN(n) ? def : n
}
const num = (v, d) => { const n = parseFloat(v); return isNaN(n) ? d : n }

const modFactor = computed(() => MOD_FACTORS[props.form.modulation] || 2)
const fecV = computed(() => parseFrac(props.form.fec, 0.75))
const rsV = computed(() => parseFrac(props.form.rsCode, 188 / 204))
const mV = computed(() => num(props.form.m, 1))
const bwV = computed(() => num(props.form.bandwidthFactor, 1.2))
// 组合效率 k = fec·rsCode·调制因子 / 扩频增益（Es/N₀ = Eb/N₀ + 10·lg k）
const kComb = computed(() => (fecV.value * rsV.value * modFactor.value) / mV.value)
// 频谱效率 η = 调制因子·fec·rsCode / (滚降·扩频)
const spectralEff = computed(() => modFactor.value * fecV.value * rsV.value / (bwV.value * mV.value))

const modOptions = computed(() => props.options.modulation || [{ value: 'QPSK', label: 'QPSK' }])
const dvbStandards = computed(() => props.options.dvbStandards || [{ value: 'custom', label: '自定义' }])
const modcodList = computed(() => (props.options.modcod && props.options.modcod[props.form.dvbStandard]) || [])

// —— 门限 Eb/N₀ ⇄ Es/N₀（带数值换算）——
function toggleEbno() {
  const cur = parseFloat(props.form.ebno)
  const newMode = props.form.noiseRatioMode === 'ebno' ? 'esno' : 'ebno'
  if (!isNaN(cur) && props.form.modulation) {
    const conv = newMode === 'esno' ? cur + 10 * Math.log10(kComb.value) : cur - 10 * Math.log10(kComb.value)
    props.form.ebno = String(parseFloat(conv.toFixed(4)))
  }
  props.form.noiseRatioMode = newMode
}

// —— 频谱效率 ⇄ 帧效率 ——
function toggleRsCode() {
  props.form.rsCodeMode = props.form.rsCodeMode === 'spectral' ? 'fraction' : 'spectral'
}
// rsCode 字段显示值：帧效率模式=真实 rsCode；频谱效率模式=η（编辑则反解回 rsCode）
const rsCodeDisplay = computed({
  get() { return props.form.rsCodeMode === 'spectral' ? (isNaN(spectralEff.value) ? '' : spectralEff.value.toFixed(4)) : props.form.rsCode },
  set(v) {
    if (props.form.rsCodeMode === 'spectral') {
      const se = parseFloat(v)
      if (!isNaN(se) && modFactor.value && fecV.value) props.form.rsCode = String(parseFloat((se * bwV.value * mV.value / (modFactor.value * fecV.value)).toFixed(6)))
    } else {
      props.form.rsCode = v
    }
  }
})

// —— DVB / MODCOD ——
function onDvbChange(e) {
  props.form.dvbStandard = e.target.value
  props.form.modcodIndex = -1
}
function applyModcod(e) {
  const i = parseInt(e.target.value)
  const mc = modcodList.value[i]; if (!mc) return
  props.form.modcodIndex = i
  props.form.modulation = mc.modulation
  props.form.fec = mc.fec
  props.form.rsCode = mc.rsCode
  props.form.bandwidthFactor = String(mc.bandwidthFactor)
  props.form.ebno = mc.threshold.toFixed(2)
  props.form.noiseRatioMode = mc.noiseRatioMode
}

// —— 实时码片速率 / 符号率 / 载波带宽（可编辑反算 infoRate）——
// 换算链与引擎 linkCalculator.js 完全一致：
// infoRate → carrierRate(÷fec÷rs) → chipRate(×m，码片速率) → symbolRate(÷调制因子) → carrierBW(×滚降)
const carrierRate = computed(() => {
  const info = num(props.form.infoRate, NaN)
  if (isNaN(info)) return NaN
  return info / fecV.value / rsV.value
})
const chipRate = computed(() => (isNaN(carrierRate.value) ? NaN : carrierRate.value * mV.value))
const symbolRate = computed(() => (isNaN(chipRate.value) ? NaN : chipRate.value / modFactor.value))
const carrierBW = computed(() => (isNaN(symbolRate.value) ? NaN : symbolRate.value * bwV.value))
const fmt = (v) => (isNaN(v) ? '--' : (Math.round(v * 1000) / 1000).toString())

// 信息速率是唯一真实存储字段，码片速率/符号率/载波带宽都是按当前调制/FEC/扩频/滚降反推的视角。
// 问题：若只在编辑那一刻反算一次 infoRate，后续再改调制方式等参数，infoRate 不变但乘数变了，
// 三个派生量会一起跟着漂移——包括用户刚刚手动定下来的那个值，体验上像是“白改了”。
// 改法：记下用户最近编辑的是哪一个字段（锚点）和它当时的目标值；调制/FEC/扩频/滚降任何一个变化时，
// 都按锚点的目标值反解 infoRate，使锚点字段保持不变，其余字段顺着联动——而不是死守 infoRate 不变。
const rateAnchor = ref('info')   // 'info' | 'chip' | 'symbol' | 'bw'
const anchorValue = ref(null)
function infoRateFor(which, v) {
  const fec = fecV.value, rs = rsV.value, mf = modFactor.value, m = mV.value, bw = bwV.value
  if (which === 'chip') return v / m * fec * rs
  if (which === 'symbol') return v * mf / m * fec * rs
  if (which === 'bw') return (v / bw) * mf / m * fec * rs
  return null
}
function setAnchor(which, raw) {
  const v = parseFloat(raw); if (isNaN(v)) return
  rateAnchor.value = which
  anchorValue.value = v
  const ir = infoRateFor(which, v)
  if (ir != null && !isNaN(ir)) props.form.infoRate = String(Math.round(ir * 1000) / 1000)
}
watch([modFactor, fecV, rsV, mV, bwV], () => {
  if (rateAnchor.value === 'info' || anchorValue.value == null) return
  const ir = infoRateFor(rateAnchor.value, anchorValue.value)
  if (ir != null && !isNaN(ir)) props.form.infoRate = String(Math.round(ir * 1000) / 1000)
})
function onInfoInput() { rateAnchor.value = 'info' }   // 用户直接改信息速率：信息速率重新成为锚点
function onChipInput(e) { setAnchor('chip', e.target.value) }
function onSymbolInput(e) { setAnchor('symbol', e.target.value) }
function onBwInput(e) { setAnchor('bw', e.target.value) }
</script>

<template>
  <div class="bb">
    <!-- MODCOD 快速选择 -->
    <div class="bb-modcod">
      <label class="bb-f"><span class="bb-l">标准</span>
        <select :value="form.dvbStandard" class="bb-i" @change="onDvbChange">
          <option v-for="o in dvbStandards" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </label>
      <label v-if="form.dvbStandard !== 'custom'" class="bb-f bb-wide"><span class="bb-l">MODCOD</span>
        <select :value="form.modcodIndex" class="bb-i" @change="applyModcod">
          <option :value="-1" disabled>请选择</option>
          <option v-for="(mc, i) in modcodList" :key="i" :value="i">{{ mc.label }}</option>
        </select>
      </label>
    </div>

    <!-- 第一行 -->
    <div class="bb-grid">
      <label class="bb-f"><span class="bb-l">信息速率 <i>(kbps)</i></span>
        <input v-model="form.infoRate" class="bb-i mono" placeholder="2048" @input="onInfoInput" />
      </label>
      <label class="bb-f"><span class="bb-l">调制方式</span>
        <select v-model="form.modulation" class="bb-i">
          <option v-for="o in modOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </label>
      <label class="bb-f"><span class="bb-l">FEC 码率</span>
        <input v-model="form.fec" class="bb-i mono" placeholder="3/4" />
      </label>
      <label class="bb-f"><span class="bb-l">
          {{ form.noiseRatioMode === 'ebno' ? 'Eb/N₀' : 'Es/N₀' }}门限 <i>(dB)</i>
          <button class="bb-tg" title="Eb/N₀ ⇄ Es/N₀" @click.prevent="toggleEbno"><Icon name="arrow-left-right" :size="11" /></button>
        </span>
        <input v-model="form.ebno" class="bb-i mono" placeholder="5.50" />
      </label>
    </div>

    <!-- 第二行 -->
    <div class="bb-grid">
      <label class="bb-f"><span class="bb-l">误码率 <i>(1×10⁻ⁿ)</i></span>
        <input v-model="form.ber" class="bb-i mono" placeholder="7" />
      </label>
      <label class="bb-f"><span class="bb-l">扩频增益</span>
        <input v-model="form.m" class="bb-i mono" placeholder="1.00" />
      </label>
      <label class="bb-f"><span class="bb-l">滚降系数 <i>(1+α)</i></span>
        <input v-model="form.bandwidthFactor" class="bb-i mono" placeholder="1.20" />
      </label>
      <label class="bb-f"><span class="bb-l">
          {{ form.rsCodeMode === 'spectral' ? '频谱效率' : '帧效率' }}<i v-if="form.rsCodeMode === 'spectral'"> (bps/Hz)</i>
          <button class="bb-tg" title="频谱效率 ⇄ 帧效率" @click.prevent="toggleRsCode"><Icon name="arrow-left-right" :size="11" /></button>
        </span>
        <input v-model="rsCodeDisplay" class="bb-i mono" :placeholder="form.rsCodeMode === 'spectral' ? '0.9216' : '188/204'" />
      </label>
    </div>

    <!-- 实时结果（可编辑反算，三者与信息速率同一条换算链，编辑任一个即把它设为锚点）——
         系统余量不在此处：它是批量计算的目标值，不随基带配置走，在 LinkBudgetApp 底部「计算方式」栏统一设置 -->
    <div class="bb-rt">
      <label class="bb-f"><span class="bb-l">码片速率 <i>(kbps)</i></span>
        <input :value="fmt(chipRate)" class="bb-i mono" @change="onChipInput" />
      </label>
      <label class="bb-f"><span class="bb-l">符号率 <i>(ksps)</i></span>
        <input :value="fmt(symbolRate)" class="bb-i mono" @change="onSymbolInput" />
      </label>
      <label class="bb-f"><span class="bb-l">载波带宽 <i>(kHz)</i></span>
        <input :value="fmt(carrierBW)" class="bb-i mono" @change="onBwInput" />
      </label>
    </div>
  </div>
</template>

<style scoped>
.bb { max-width: 560px; }
.bb-modcod, .bb-grid, .bb-rt { display: grid; gap: 8px 10px; margin-bottom: 10px; }
.bb-modcod { grid-template-columns: 1fr 2fr; }
.bb-grid { grid-template-columns: repeat(4, 1fr); }
.bb-rt { grid-template-columns: repeat(3, 1fr); padding-top: 8px; border-top: 1px dashed var(--border); }
.bb-f { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.bb-l { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-muted); white-space: nowrap; }
.bb-l i { color: var(--text-faint); font-style: normal; }
.bb-i { font: inherit; font-size: 12px; padding: 4px 7px; width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.bb-i:focus { outline: none; border-color: var(--accent); }
.bb-i.mono { font-family: var(--font-mono); }
.bb-rt .bb-i { background: var(--surface); }
.bb-tg { font: inherit; font-size: 11px; line-height: 1; padding: 1px 4px; cursor: pointer; background: var(--surface-2); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.bb-tg:hover { color: var(--text); border-color: var(--border-strong); }
</style>
