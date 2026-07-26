<script setup>
import { computed, watch } from 'vue'
import Icon from '../components/Icon.vue'
import { checkNtnBandwidth } from '../shared/ntnLimits.js'
import { MOD_FACTORS, parseFrac, rateChain, rateDisplays, infoRateFrom, anchorOf } from '../shared/carrierRate.js'

// 载波信号参数面板 —— 严格照搬小程序载波信号卡片：DVB/MODCOD 快选、Eb/N₀⇄Es/N₀ 切换（带换算）、
// 频谱效率⇄帧效率切换、速率换算链（信息速率/码片速率/符号率/载波带宽，编辑任一个反算其余）。
const props = defineProps({
  form: { type: Object, required: true },   // 共享载波信号参数（含 noiseRatioMode / rsCodeMode / dvbStandard / modcodIndex）
  options: { type: Object, default: () => ({}) }
})

// 调制因子/分数解析/换算链都在 shared/carrierRate.js（面板与资源库自动命名共用一份口径）
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

// —— 速率换算链：信息速率 / 码片速率 / 符号率 / 载波带宽（四者并列，编辑任一个反算其余）——
// 换算链与引擎 linkCalculator.js 完全一致：
// infoRate → carrierRate(÷fec÷rs) → chipRate(×m，码片速率) → symbolRate(÷调制因子) → carrierBW(×滚降)
const chain = computed(() => rateChain(props.form))
const carrierBW = computed(() => chain.value.bw)          // NTN 带宽合规提示按真实链算，不取显示值
const disp = computed(() => rateDisplays(props.form))     // 三个派生框的显示值（锚点那项照用户原值）

// 信息速率是唯一真实存储字段，码片速率/符号率/载波带宽都是按当前调制/FEC/扩频/滚降反推的视角。
// 问题：若只在编辑那一刻反算一次 infoRate，后续再改调制方式等参数，infoRate 不变但乘数变了，
// 三个派生量会一起跟着漂移——包括用户刚刚手动定下来的那个值，体验上像是“白改了”。
// 改法：记下用户最近编辑的是哪一个字段（锚点）和它当时的目标值；调制/FEC/扩频/滚降任何一个变化时，
// 都按锚点的目标值反解 infoRate，使锚点字段保持不变，其余字段顺着联动——而不是死守 infoRate 不变。
// 锚点与其目标值随配置入库（form.rateAnchor / rateAnchorValue，不再是面板局部态）：切走再回来、
// 重开软件，用户按的还是自己那个口径；条目自动命名也据此报（改带宽就报带宽，见 lbAutoName）。
const rateAnchor = computed(() => anchorOf(props.form))
function setAnchor(which, raw) {
  const v = parseFloat(raw); if (isNaN(v)) return
  props.form.rateAnchor = which
  props.form.rateAnchorValue = v
  const ir = infoRateFrom(props.form, which, v)
  if (ir != null && !isNaN(ir)) props.form.infoRate = String(Math.round(ir * 1000) / 1000)
}
watch([modFactor, fecV, rsV, mV, bwV], () => {
  const anch = rateAnchor.value
  const av = props.form.rateAnchorValue
  if (anch === 'info' || av == null || av === '') return
  const ir = infoRateFrom(props.form, anch, parseFloat(av))
  if (ir != null && !isNaN(ir)) props.form.infoRate = String(Math.round(ir * 1000) / 1000)
})
// —— 3GPP NTN 载波带宽合规提示 ——
// 选了 3GPP 体制（NB-IoT NTN / NR-NTN）时，标准把「信道带宽」枚举死了几档：超出上限红字告警，
// 未超则灰字说明当前载波需占用哪一档信道带宽。DVB 各体制不判（其带宽按转发器切片自由定）。
// 限值与出处见 shared/ntnLimits.js。
const ntnBw = computed(() => checkNtnBandwidth(props.form.dvbStandard, carrierBW.value))

// 用户直接改信息速率：信息速率重新成为锚点（它自己就是存储字段，无需另记目标值）
function onInfoInput() { props.form.rateAnchor = 'info'; props.form.rateAnchorValue = null }
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

    <!-- 调制编码与门限（速率不在此处，见下方换算链）——
         两列排布时左右自然成对：调制⇄FEC、门限⇄误码率、滚降⇄帧效率 -->
    <div class="bb-grid">
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
      <label class="bb-f"><span class="bb-l">误码率 <i>(1×10⁻ⁿ)</i></span>
        <input v-model="form.ber" class="bb-i mono" placeholder="7" />
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
      <label class="bb-f"><span class="bb-l">扩频增益</span>
        <input v-model="form.m" class="bb-i mono" placeholder="1.00" />
      </label>
    </div>

    <!-- 速率换算链（信息速率 → 码片速率 → 符号率 → 载波带宽）：四者同一条链上的不同视角，编辑任一个
         即把它设为锚点、其余三个跟着算；正常色的那个＝当前锚点，退一档的＝由它算出来的。
         系统余量不在此处：它是批量计算的目标值，不随载波信号配置走，在 LinkBudgetApp 底部「计算方式」栏统一设置 -->
    <div class="bb-rt">
      <label class="bb-f"><span class="bb-l">信息速率 <i>(kbps)</i></span>
        <input v-model="form.infoRate" class="bb-i mono" :class="{ 'bb-anch': rateAnchor === 'info' }" placeholder="2048" @input="onInfoInput" />
      </label>
      <label class="bb-f"><span class="bb-l">码片速率 <i>(kcps)</i></span>
        <input :value="disp.chip" class="bb-i mono" :class="{ 'bb-anch': rateAnchor === 'chip' }" @change="onChipInput" />
      </label>
      <label class="bb-f"><span class="bb-l">符号率 <i>(ksps)</i></span>
        <input :value="disp.symbol" class="bb-i mono" :class="{ 'bb-anch': rateAnchor === 'symbol' }" @change="onSymbolInput" />
      </label>
      <label class="bb-f"><span class="bb-l">载波带宽 <i>(kHz)</i></span>
        <input :value="disp.bw" class="bb-i mono" :class="{ 'bb-anch': rateAnchor === 'bw', 'bb-over': ntnBw && ntnBw.level === 'over' }" @change="onBwInput" />
      </label>
    </div>

    <!-- 3GPP NTN 信道带宽合规提示（仅 3GPP 体制出现） -->
    <p v-if="ntnBw" class="bb-ntn" :class="{ over: ntnBw.level === 'over' }">
      <Icon v-if="ntnBw.level === 'over'" name="alert-triangle" :size="11" />
      <span>{{ ntnBw.text }}</span>
    </p>
  </div>
</template>

<style scoped>
.bb { max-width: 560px; }
.bb-modcod, .bb-grid, .bb-rt { display: grid; gap: 8px 10px; margin-bottom: 10px; }
.bb-modcod { grid-template-columns: 1fr 2fr; }
.bb-grid { grid-template-columns: repeat(4, 1fr); }
.bb-rt { grid-template-columns: repeat(4, 1fr); padding-top: 8px; border-top: 1px dashed var(--border); }
.bb-f { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.bb-l { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-muted); white-space: nowrap; }
.bb-l i { color: var(--text-faint); font-style: normal; }
.bb-i { font: inherit; font-size: 12px; padding: 4px 7px; width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.bb-i:focus { outline: none; border-color: var(--accent); }
.bb-i.mono { font-family: var(--font-mono); }
/* 速率链：非锚点＝由锚点算出来的，退一档；锚点＝用户钉住的那个，正常色 */
.bb-rt .bb-i { background: var(--surface); color: var(--text-muted); }
.bb-rt .bb-i.bb-anch { color: var(--text); }
/* 3GPP NTN 信道带宽提示：正常灰字说明占哪一档，超限转红并给输入框描红边 */
.bb-rt .bb-i.bb-over { color: var(--danger); border-color: var(--danger); }
.bb-ntn { display: flex; align-items: flex-start; gap: 5px; margin: -4px 0 0; font-size: 11px; line-height: 1.55; color: var(--text-faint); }
.bb-ntn.over { color: var(--danger); }
.bb-ntn :deep(svg) { flex: none; margin-top: 2px; }
.bb-tg { font: inherit; font-size: 11px; line-height: 1; padding: 1px 4px; cursor: pointer; background: var(--surface-2); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.bb-tg:hover { color: var(--text); border-color: var(--border-strong); }
</style>
