<script setup>
import { computed, ref, watch } from 'vue'
import Icon from '../components/Icon.vue'
import { checkNtnBandwidth } from '../shared/ntnLimits.js'
import { MOD_FACTORS, parseFrac, rateChain, rateDisplays, infoRateFrom, anchorOf } from '../shared/carrierRate.js'

// 载波信号参数面板 —— 严格照搬小程序载波信号卡片：DVB/MODCOD 快选、Eb/N₀⇄Es/N₀ 切换（带换算）、
// 频谱效率⇄帧效率切换、速率换算链（信息速率/码片速率/符号率/载波带宽，编辑任一个反算其余）。
const props = defineProps({
  form: { type: Object, required: true },   // 共享载波信号参数（含 noiseRatioMode / rsCodeMode / dvbStandard / modcodIndex）
  options: { type: Object, default: () => ({}) },
  // 本窗支持的计算方式 [{ key, label }]（各窗按自身引擎能力给：弯管四种、再生式两种）；空数组＝不出该栏
  calcModes: { type: Array, default: () => [] }
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
// 这一格里真正的存储字段只有帧效率 rsCode；频谱效率是它的一个视角（η = 调制因子·fec·rs /(滚降·扩频)），
// 用户编辑 η 即反解回 rsCode。两件事：
//   ① 反解不能跟着每一次按键做。η 的显示值是定长 toFixed(4)，边打边反解、边把算回来的值写回输入框，
//      「1.38」在打完「1」的一瞬就被回写成「1.0000」，后面的「.38」全被吞掉（实测落到 1.0001），
//      码片速率/符号率/载波带宽整条链跟着算错。故输入期间只记原文，失焦或回车（change）才提交。
//   ② η 不设上限。理论上帧效率 ≤ 1，于是 η ≤ η_max = 调制因子·fec /(滚降·扩频)（rs = 1，无外码开销）；
//      但「不想逐项去配调制/FEC/外码，直接把总的频谱效率填进来」是常用的省事口径，此时反解出的
//      rs > 1 只是个等效开销因子。故越过 η_max 只灰字提醒（并点明报告照此输出），不夹紧、不阻断。
const rsEditing = ref(null)     // 频谱效率模式下正在输入的原文；null = 不在编辑
const spectralEffMax = computed(() => modFactor.value * fecV.value / (bwV.value * mV.value))
// 人读文案：滚降系数或扩频增益填 0 时 η 与上限都发散，不印 Infinity
const qty = (v) => (isFinite(v) ? v.toFixed(4) + ' bps/Hz' : '无解（滚降系数或扩频增益为 0）')
const capText = computed(() => qty(spectralEffMax.value))

function toggleRsCode() {
  props.form.rsCodeMode = props.form.rsCodeMode === 'spectral' ? 'fraction' : 'spectral'
  rsEditing.value = null
}
// rsCode 字段显示值：帧效率模式=真实 rsCode 原文（分数照写）；频谱效率模式=编辑中的原文，否则实时 η
const rsCodeDisplay = computed(() => {
  if (props.form.rsCodeMode !== 'spectral') return props.form.rsCode
  if (rsEditing.value != null) return rsEditing.value
  return isFinite(spectralEff.value) ? spectralEff.value.toFixed(4) : ''
})
function onRsInput(e) {
  if (props.form.rsCodeMode === 'spectral') rsEditing.value = e.target.value
  else props.form.rsCode = e.target.value   // 帧效率是文本字段（'188/204'），实时写入不经格式化，不会被吞
}
function onRsChange(e) {
  if (props.form.rsCodeMode !== 'spectral') return
  const se = parseFloat(e.target.value)
  rsEditing.value = null
  if (!isFinite(se) || se <= 0 || !modFactor.value || !fecV.value) return  // 非法输入：丢弃，显示回落到实时 η
  props.form.rsCode = String(parseFloat((se * bwV.value * mV.value / (modFactor.value * fecV.value)).toFixed(6)))
}
// 提示行：值无效才拦（红字），越过理论上限只说明（灰字）。
// 覆盖三条来路：频谱效率模式下的直接指定、帧效率模式下的手输、历史配置里已经存下的值
const rsAlert = computed(() => {
  const rs = rsV.value
  if (!isFinite(rs) || rs <= 0) return { level: 'over', text: '帧效率须为正数，当前值无效——带宽与容量结果不可用' }
  if (rs > 1) {
    const rsTxt = parseFloat(rs.toFixed(6))
    return {
      level: 'note',
      // 措辞跟着当前口径走：在频谱效率格里填的，说频谱效率；在帧效率格里填的，说帧效率
      text: props.form.rsCodeMode === 'spectral'
        ? `已按直接指定的频谱效率计算：${qty(spectralEff.value)} 超过当前调制/FEC/滚降的理论上限 ${capText.value}，等效帧效率 ${rsTxt} > 1，报告照此输出`
        : `帧效率 ${rsTxt} > 1 超出理论上限（等效频谱效率 ${qty(spectralEff.value)}），按此口径计算并输出`
    }
  }
  return null
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
  rsEditing.value = null   // MODCOD 整套覆写了 rsCode，编辑中的原文作废
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
      <!-- 带口径钮的行用 div 而非 label：label 会把行内任意位置的点击转发给它的第一个可关联控件，
           而那正是这枚 button（button 也是 labelable）——点标签文字、单位括注甚至行内空白都会误切口径。 -->
      <div class="bb-f bb-f-tg"><span class="bb-l">
          <button type="button" class="bb-tg" :title="`当前 ${form.noiseRatioMode === 'ebno' ? 'Eb/N₀' : 'Es/N₀'} 口径，点击换算为 ${form.noiseRatioMode === 'ebno' ? 'Es/N₀' : 'Eb/N₀'}（门限值同步换算）`"
                  @click.prevent="toggleEbno">{{ form.noiseRatioMode === 'ebno' ? 'Eb/N₀' : 'Es/N₀' }}<Icon name="arrow-left-right" :size="10" /></button>门限<i>(dB)</i>
        </span>
        <input v-model="form.ebno" class="bb-i mono" placeholder="5.50" />
      </div>
      <label class="bb-f"><span class="bb-l">误码率 <i>(1×10⁻ⁿ)</i></span>
        <input v-model="form.ber" class="bb-i mono" placeholder="7" />
      </label>
      <label class="bb-f"><span class="bb-l">滚降系数 <i>(1+α)</i></span>
        <input v-model="form.bandwidthFactor" class="bb-i mono" placeholder="1.20" />
      </label>
      <div class="bb-f bb-f-tg"><span class="bb-l">
          <button type="button" class="bb-tg" :title="`当前按${form.rsCodeMode === 'spectral' ? '频谱效率' : '帧效率'}填，点击切换为${form.rsCodeMode === 'spectral' ? '帧效率' : '频谱效率'}`"
                  @click.prevent="toggleRsCode">{{ form.rsCodeMode === 'spectral' ? '频谱效率' : '帧效率' }}<Icon name="arrow-left-right" :size="10" /></button><i v-if="form.rsCodeMode === 'spectral'">(bps/Hz)</i>
        </span>
        <input :value="rsCodeDisplay" class="bb-i mono" :class="{ 'bb-over': rsAlert && rsAlert.level === 'over' }"
               :placeholder="form.rsCodeMode === 'spectral' ? '1.1520' : '188/204'" @input="onRsInput" @change="onRsChange" />
      </div>
      <label class="bb-f"><span class="bb-l">扩频增益</span>
        <input v-model="form.m" class="bb-i mono" placeholder="1.00" />
      </label>
    </div>

    <!-- 帧效率越界告警 / 频谱效率夹到上限的说明（频谱效率只是帧效率的一个视角，见 script） -->
    <p v-if="rsAlert" class="bb-ntn bb-rs" :class="{ over: rsAlert.level === 'over' }">
      <Icon v-if="rsAlert.level === 'over'" name="alert-triangle" :size="11" />
      <span>{{ rsAlert.text }}</span>
    </p>

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

    <!-- 计算方式：本载波的求解策略。链路表逐行按所选载波取用（功放功率取各行发端地球站配置的 paPowerW），
         故同一批次里不同载波可各按各的方式求解。系统余量只在「设置余量」下为输入，其余方式下是解出的结果。 -->
    <div v-if="calcModes.length" class="bb-cm">
      <label class="bb-f"><span class="bb-l">计算方式</span>
        <select v-model="form.calcMode" class="bb-i">
          <option v-for="m in calcModes" :key="m.key" :value="m.key">{{ m.label }}</option>
        </select>
      </label>
      <label v-if="form.calcMode === 'margin'" class="bb-f"><span class="bb-l">系统余量 <i>(dB)</i></span>
        <input v-model="form.margin" class="bb-i mono" placeholder="3.00" />
      </label>
      <label v-else-if="form.calcMode === 'overbalance'" class="bb-f"><span class="bb-l">超发量 <i>(dB)</i></span>
        <input v-model="form.overDb" class="bb-i mono" placeholder="0.00" />
      </label>
    </div>
  </div>
</template>

<style scoped>
.bb { max-width: 560px; }
.bb-modcod, .bb-grid, .bb-rt, .bb-cm { display: grid; gap: 8px 10px; margin-bottom: 10px; }
.bb-modcod { grid-template-columns: 1fr 2fr; }
.bb-grid { grid-template-columns: repeat(4, 1fr); }
.bb-rt { grid-template-columns: repeat(4, 1fr); padding-top: 8px; border-top: 1px dashed var(--border); }
/* 计算方式：求解策略，与载波信号参数隔一条分隔线；方式名较长，首列给两倍宽 */
.bb-cm { grid-template-columns: 2fr 1fr 1fr; padding-top: 8px; border-top: 1px dashed var(--border); }
.bb-f { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.bb-l { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-muted); white-space: nowrap; }
/* 单位括注：从属信息，比标签名收小半档——既压住视觉权重，也给最窄一列（~87px）匀出余量，
   「频谱效率 (bps/Hz)」这类长标签才不会把括号裁掉 */
.bb-l i { font-size: .95em; color: var(--text-faint); font-style: normal; }
.bb-i { font: inherit; font-size: 12px; padding: 4px 7px; width: 100%; background-color: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.bb-i:focus { outline: none; border-color: var(--accent); }
.bb-i.mono { font-family: var(--font-mono); }
/* 速率链：非锚点＝由锚点算出来的，退一档；锚点＝用户钉住的那个，正常色 */
.bb-rt .bb-i { background-color: var(--surface); color: var(--text-muted); }
.bb-rt .bb-i.bb-anch { color: var(--text); }
/* 3GPP NTN 信道带宽提示 / 帧效率越界：正常灰字说明，超限转红并给输入框描红边 */
.bb-rt .bb-i.bb-over, .bb-grid .bb-i.bb-over { color: var(--danger); border-color: var(--danger); }
.bb-ntn { display: flex; align-items: flex-start; gap: 5px; margin: -4px 0 0; font-size: 11px; line-height: 1.55; color: var(--text-faint); }
.bb-ntn.bb-rs { margin: -6px 0 10px; }   /* 帧效率提示夹在两组之间，上下都要留白 */
.bb-ntn.over { color: var(--danger); }
.bb-ntn :deep(svg) { flex: none; margin-top: 2px; }
/* 口径切换：当前口径名 + 互换图标合成一枚有边框的标签钮（Eb/N₀ ⇄ Es/N₀、频谱效率 ⇄ 帧效率）——
   名字在钮内，一眼看清「现在按哪个口径填」，边框与图标表明它可点。
   钮把口径名包进去而不是另占一格：检查器式排版下标签区只有 ~87px（styles/lbworkbench.css 两列
   minmax(196px,1fr)），另加一枚 20px 的独立钮会被 .bb-l 的 overflow:hidden 裁成半个——旧版即此症。
   这两行的数值都短（门限 4.30、效率 1.3800），故 .bb-f-tg 把输入框收窄，把宽度让给标签。 */
.bb-tg { display: inline-flex; align-items: center; gap: 3px; flex: none; font: inherit; line-height: 1.35;
         padding: 0 3px; cursor: pointer; background: var(--surface-2); color: var(--text);
         border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.bb-tg :deep(svg) { flex: none; color: var(--text-faint); }
.bb-tg:hover { border-color: var(--accent); }
.bb-tg:hover :deep(svg) { color: var(--accent); }
.bb-tg:focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; }
.bb-f.bb-f-tg .bb-i { width: 78px; }   /* 四级：压过 styles/lbworkbench.css 里 104px 的三级规则 */
</style>
