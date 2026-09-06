<script setup>
// 「SLA 建议」分区（GSO / NGSO / 再生式 / 端到端 四窗共用）。
//
// 三块：左＝条款三线表（条款 / 计算依据 / 建议值 / 采用值 / 单位 / 列入）；
//       右＝参数轨（可用度构成四项 · IP 包长 · 处理时延预留 · EIRP 容差 · 极化隔离度）；
//       依据列每片各占一个 <span>：算式里的操作数名（「发信射频」「卫星与载荷」…）就是靠这个
//       让呈现层逐片精确查表翻成英文的 —— 名字与数字拼进同一片就查不到了（见 lbSla 的 L()）。
//       下＝可用度档位表整幅一行（十列数：塞进右轨会与条款表挤成一团，故独占一行、内部横向可滚）。
//
// 建议值与依据全部由 shared/lbSla.js 算好后传进来（本组件不算任何数）。采用值留空即采用建议值
//（口径写在列头 title：拿建议值当占位符会让同一个数在相邻两列各印一遍，窄格里还被截成半截）；
// 着色只按「采用值比建议更激进」这一条数值规则来，界面上不出现任何文字判定。
// 样式在 styles/lbworkbench.css（.lbx-sla*，非 scoped——四窗共用同一份）。字体走界面字体
// var(--font-ui)（设置 → 界面字体），不走报告那条衬线栈：这是填条款的界面，不是交付文档。
import { computed } from 'vue'
import NumBox from './NumBox.vue'
import { slaRows, fixed, worstMonthAvail, MIN_PER_YEAR, MIN_PER_MONTH } from '../shared/lbSla.js'
import { fmtQtyParts } from '../shared/adaptUnits.js'

const props = defineProps({
  derived: { type: Object, default: null },     // deriveSla(ctx) 的结果
  rowSla: { type: Object, default: null },      // row.sla = { adopt, include }
  params: { type: Object, default: null },      // 场景级 slaParams
  adaptive: { type: Boolean, default: false }   // 结果显示单位档（功能区「单位」）
})
const emit = defineEmits(['adopt', 'include', 'param'])

// 速率/带宽按功能区「单位」档换档：值与单位分两列，换档倍率回传给采用值那格。
// ★ 采用值一律以【基准单位】存进 row.sla：屏上按 Mbps 输入 2.5，落库的是 2500 kbps ——
//   否则换个单位档，同一份场景的承诺速率就差三个数量级。
const fmt = (v, unit) => fmtQtyParts(v, unit, props.adaptive)
const rows = computed(() => slaRows(props.derived, props.rowSla, props.params, fmt))
const has = computed(() => rows.value.some((r) => r.kind === 'item'))
function onAdopt(r, v) {
  const base = (v === null || v === undefined || v === '') ? null : (r.qty ? v / (r.factor || 1) : v)
  emit('adopt', { key: r.key, value: base })
}

// 档位扫描表（§5.3）：晴空样本只喂 MIR，不列进这张表
const scanRows = computed(() => ((props.derived && props.derived.scanRows) || []).filter((r) => r && r.tag !== 'clear'))
const feasibleTier = computed(() => (props.derived ? props.derived.feasibleTier : null))
// 表头 title：这张表是按哪个工作点算出来的。★ 拼串的槽位一律压到末尾，且不同分支各成一条
// 完整句子 —— 呈现层的模板匹配是按字面量切的，槽位夹在中间的句子只能靠 PAT 一条条对，
// 分支越碎越容易漏译（见 shared/i18n/runtime.js 头注）。
const pinTip = computed(() => {
  const p = props.derived && props.derived.scanPin
  if (p && p.kind === 'pa') return `逐档钉住当前工作点重算：功放 ${Number(p.powerW).toPrecision(4)} W`
  if (p && p.kind === 'gt' && p.gtDb != null) return `逐档钉住当前工作点重算：收信站 G/T ${Number(p.gtDb).toFixed(2)} dB/K`
  if (p && p.kind === 'gt') return '逐档钉住当前工作点重算：收信站 G/T 由设计点解出'
  return '逐档钉住当前工作点重算'
})
const sv = (r, key, dec) => fixed(r && r.data ? r.data[key] : null, dec)
const isBadMargin = (r) => { const m = parseFloat(r && r.data ? r.data.linkmargin : NaN); return isFinite(m) && m < 0 }
// 档位表的列（单位另起一行；九列全是数，列头挤不下「上行雨衰 dB」）。
// 整列都取不到数的不画——端到端是按同一个 k 缩放全链地球站节点，本就没有「上行/下行」这一分，
// 留四个空列在那儿只会让人以为是算漏了。
const SCAN_COLS = [
  { key: 'tier', label: '档位', unit: '%' },
  // 综合＝该传播档 × 射频/载荷/基带骨干网那几项因子。没有任何因子时（eqFactor = 1）整列与
  // 「档位」逐字相同 → 由 scanCols 的「整列取不到数」那条规则之外再加一道：eqFactor = 1 不出这列。
  { key: 'comp', label: '综合', unit: '%', dec: 3, comp: true },
  { key: 'up', label: '上行', unit: '%', dec: 3 },
  { key: 'dn', label: '下行', unit: '%', dec: 3 },
  { key: 'uplinkRainAttenuation', label: '上行雨衰', unit: 'dB', dec: 2, data: true },
  { key: 'downlinkRainAttenuationResult', label: '下行雨衰', unit: 'dB', dec: 2, data: true },
  { key: 'linkmargin', label: '链路余量', unit: 'dB', dec: 2, data: true, margin: true },
  { key: 'powerUsageRatio', label: '功率占用', unit: '%', dec: 2, data: true },
  { key: 'bandwidthUsageRatio', label: '带宽占用', unit: '%', dec: 2, data: true },
  { key: 'interruptionMinutes', label: '年中断', unit: 'min', dec: 0, data: true, outage: true }
]
// 考核周期：年 / 最坏月（P.841）。「档位」列恒是引擎的年口径（扫描能动的只有雨衰那一份），
// 「综合」列与中断列跟着考核周期走 —— 同一行里不该并排摆两个口径的数。
const monthly = computed(() => !!(props.derived && props.derived.monthly))
// 传播之外的因子（发信射频 / 收信射频 / 卫星与载荷 / 基带骨干网）的连乘系数：档位是传播域的，承诺值是综合域的，
// 两者差的就是这个系数。表头 title 里也写着这件事。
const eqFactor = computed(() => {
  const f = props.derived ? props.derived.eqFactor : 1
  return (typeof f === 'number' && isFinite(f) && f > 0) ? f : 1
})
const compOf = (r) => {
  const t = parseFloat(r && r.tier)
  if (!isFinite(t)) return NaN
  const base = monthly.value ? worstMonthAvail(t) : t
  return base === null ? NaN : base * eqFactor.value
}
const periodMin = computed(() => (monthly.value ? MIN_PER_MONTH : MIN_PER_YEAR))
const cellOf = (c, r) => {
  if (c.key === 'tier') return fixed(r.tier, r.tier % 1 ? 2 : 0)
  if (c.comp) { const v = compOf(r); return isFinite(v) ? fixed(v, c.dec) : '' }
  // 年中断跟着【综合可用度】走：档位列是传播域的，年中断若还按引擎那份（同样是传播域）给，
  // 同一行里就有两个口径的数
  if (c.outage && (eqFactor.value < 1 || monthly.value)) { const v = compOf(r); return isFinite(v) ? fixed((100 - v) / 100 * periodMin.value, c.dec) : '' }
  return c.data ? sv(r, c.key, c.dec) : fixed(r[c.key], c.dec)
}
const scanCols = computed(() => SCAN_COLS
  .map((c) => (c.outage && monthly.value ? { ...c, label: '月中断' } : c))
  .filter((c) => !(c.comp && eqFactor.value >= 1 && !monthly.value))
  .filter((c) => scanRows.value.some((r) => cellOf(c, r) !== '')))
// 「档位」列是传播域的（扫描能动的只有雨衰那一份），承诺值是综合域的 —— 差的就是这个系数。
// ★ 单独挂在「综合」那一列的列头上，不与 pinTip 拼成一句：拼起来要给 pinTip 的每个分支各配
//   一条模式，呈现层漏译一条就是英文界面上的一句中文。
const compTip = computed(() => (monthly.value
  ? `综合 = P.841 最坏月折算 × ${(eqFactor.value * 100).toFixed(3)} %`
  : `综合 = 档位 × ${(eqFactor.value * 100).toFixed(3)} %`))

// SLA 参数条。前四项＝可用度构成（传播之外的环节，引擎不管这些，见 lbSla.equipAvails）；
// 「基带/骨干网」带一个勾选闸：只卖空间段的场景不该把回传算进承诺，勾上才乘进去。
const PARAMS = [
  { key: 'monthly', gateOnly: true, label: '按月考核', tip: '勾选＝可用度按最坏月考核（ITU-R P.841 年→最坏月折算），中断上限改按月给；不勾＝年平均' },
  { key: 'esTxAvail', avail: true, label: '发信射频可用度', unit: '%', min: 0, max: 100, step: 0.01, tip: '发端地球站功放 / 上变频 / 天线一路的可用度：按设备冗余配置或运营商承诺填；100 = 不计入' },
  { key: 'esRxAvail', avail: true, label: '收信射频可用度', unit: '%', min: 0, max: 100, step: 0.01, tip: '收端地球站 LNB / 下变频 / 天线一路的可用度：按设备冗余配置或运营商承诺填；100 = 不计入' },
  { key: 'spaceAvail', avail: true, label: '卫星与载荷可用度', unit: '%', min: 0, max: 100, step: 0.01, tip: '卫星平台与转发器载荷的可用度，链上逐颗计入；100 = 不计入' },
  { key: 'groundAvail', avail: true, label: '基带/骨干网可用度', unit: '%', min: 0, max: 100, step: 0.01, gate: 'groundOn', tip: '调制解调 / 回传 / 骨干的可用度：只卖空间段不勾，卖网络服务才勾' },
  { key: 'pktBytes', needs: ['loss'], label: 'IP 包长', unit: 'B', min: 1, max: 65535, step: 1, tip: '丢包率换算用的 IP 包长：一个包跨几个 FEC 帧就有几次被丢掉的机会' },
  { key: 'ferExp', needs: ['loss'], label: '帧差错率 10⁻ⁿ', unit: 'n', min: 1, max: 15, step: 1, tip: '编码标准的帧差错率指数：DVB-S2/S2X 与 3GPP NTN 的门限按 QEF 定义，约合 10⁻⁷；未选标准时不生效' },
  { key: 'procMsPerEnd', needs: ['rtt'], label: '处理时延预留', unit: 'ms/单程', min: 0, max: 1000, step: 1, tip: '发端调制 + 收端解调的单程处理时延预留，计入往返时延上限（往返穿两趟）' },
  { key: 'jitterMs', needs: ['jitter'], label: '时延抖动', unit: 'ms', min: 0, max: 1000, step: 1, tip: '按运营商入网要求填；IP 业务惯用 ≤ 30–50 ms' },
  { key: 'eirpTolDb', needs: ['txEirp', 'txPsd'], label: 'EIRP 容差', unit: 'dB', min: 0, max: 20, step: 0.1, tip: '按运营商入网要求填' },
  { key: 'xpdMinDb', needs: ['txXpd'], label: '极化隔离度', unit: 'dB', min: 0, max: 60, step: 1, tip: '按运营商入网要求填' }
]
const paramVal = (k) => (props.params ? props.params[k] : null)
// 隐含年故障次数上限：设备那几项一年总共只有 (1 − 连乘系数) × 525960 min 的中断额度，
// 一次故障要占掉「恢复时间」那么久 —— 两者一除就是「一年最多坏几次」。含运行时数据的读数行，
// 回答的是「99.99 % × 4 h 恢复」自洽不自洽（一年坏一次就已违约）。设备一项都不计入时不出。
const faultBudget = computed(() => {
  const f = eqFactor.value
  const h = Number(paramVal('restoreH'))
  if (!(f < 1) || !isFinite(h) || !(h > 0)) return null
  const mins = (1 - f) * MIN_PER_YEAR
  return { mins: mins.toFixed(1), restore: (h * 60).toFixed(0), n: (mins / (h * 60)).toFixed(2) }
})
const gateOn = (p) => !p.gate || !!Number(paramVal(p.gate))
// 只列【本体制真的用得上】的参数：激光星间没有可用度组也没有丢包行，把地球站可用度、IP 包长
// 摆在那儿只会让人以为它们参与了计算；再生式上行同理不出「收信射频」。
const railParams = computed(() => {
  const d = props.derived
  if (!d) return []
  const has = (k) => !!(d.items && d.items[k])
  const slots = d.eqSlots || []
  return PARAMS.filter((p) => (p.avail ? slots.includes(p.key)
    : p.gateOnly ? has('sysAvail')
      : p.needs ? p.needs.some(has) : true))
})
</script>

<template>
  <div v-if="!has" class="lb-placeholder">尚无 SLA 建议。</div>
  <div v-else class="lbx-sla">
    <!-- 条款三线表：条款 / 计算依据 / 建议值 / 采用值 / 单位 / 列入 -->
    <div class="lbx-sla-main">
      <table class="lbx-sla-tbl">
        <thead>
          <tr>
            <th class="c-t">条款</th>
            <th class="c-b">计算依据</th>
            <th class="c-v">建议值</th>
            <th class="c-a" title="留空即采用建议值">采用值</th>
            <th class="c-u">单位</th>
            <th class="c-k" title="列入报告">列入</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="r in rows" :key="r.key">
            <tr v-if="r.kind === 'group'" class="lbx-sla-g"><td colspan="6">{{ r.label }}</td></tr>
            <tr v-else class="lbx-sla-r">
              <td class="c-t" :title="r.tip">{{ r.label }}<i v-if="r.sub" data-i18n-skip>{{ r.sub }}</i></td>
              <td class="c-b"><span v-for="(p, pi) in r.basis" :key="pi"
                :class="{ 'st-bad': p.bad, tight: pi && r.basis[pi - 1].glue }">{{ p.text }}</span></td>
              <td class="c-v">{{ r.suggestText || '—' }}</td>
              <td class="c-a" :class="{ 'st-bad': r.bad }">
                <input v-if="r.type === 'text' && !r.ro" class="lbx-sla-in" type="text" :value="r.adopt"
                  @change="emit('adopt', { key: r.key, value: $event.target.value })" />
                <NumBox v-else-if="!r.ro" class="lbx-sla-in" :model-value="r.adoptShown"
                  allow-empty @commit="onAdopt(r, $event)" />
              </td>
              <td class="c-u">{{ r.unit }}</td>
              <td class="c-k"><input type="checkbox" :checked="r.include" @change="emit('include', { key: r.key, value: $event.target.checked })" /></td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <!-- 参数轨：竖排定值列，三列对齐（名 / 值 / 单位）。带闸的那项（基带/骨干网）名字前面是勾选框 -->
    <div v-if="railParams.length" class="lbx-sla-side">
      <div class="lbx-sla-cap">参数</div>
      <div class="lbx-sla-pars">
        <div v-for="p in railParams" :key="p.key" class="lbx-sla-par" :class="{ off: !gateOn(p) }" :title="p.tip">
          <label class="lbx-sla-par-l">
            <input v-if="p.gate || p.gateOnly" type="checkbox" :checked="p.gateOnly ? !!Number(paramVal(p.key)) : gateOn(p)"
              @change="emit('param', { key: p.gateOnly ? p.key : p.gate, value: $event.target.checked ? 1 : 0 })" />
            {{ p.label }}
          </label>
          <template v-if="!p.gateOnly">
            <NumBox class="lbx-sla-par-v" :model-value="paramVal(p.key)" :min="p.min" :max="p.max" :step="p.step"
              :disabled="!gateOn(p)" @commit="emit('param', { key: p.key, value: $event })" />
            <i>{{ p.unit }}</i>
          </template>
        </div>
        <div v-if="faultBudget" class="lbx-sla-read" title="设备那几项一年的中断额度 ÷ 一次故障的恢复时间 = 一年最多坏几次">
          {{ faultBudget.mins }} min ÷ {{ faultBudget.restore }} min = {{ faultBudget.n }} <i>次/年</i>
        </div>
      </div>
    </div>

    <!-- 可用度档位：整幅一行（十列数，挤进参数轨那侧会与条款表叠在一起） -->
    <div v-if="scanRows.length" class="lbx-sla-scanwrap">
      <div class="lbx-sla-cap">可用度档位</div>
      <div class="lbx-sla-scanbox">
        <table class="lbx-sla-tbl lbx-sla-scan">
          <thead>
            <tr>
              <th v-for="c in scanCols" :key="c.key" class="c-n" :title="c.comp ? compTip : pinTip">{{ c.label }}</th>
            </tr>
            <tr class="lbx-sla-uh">
              <th v-for="c in scanCols" :key="c.key">{{ c.unit }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in scanRows" :key="r.tag" :class="{ top: r.tier === feasibleTier }">
              <td v-for="c in scanCols" :key="c.key" class="c-n" :class="{ 'st-bad': c.margin && isBadMargin(r) }">{{ cellOf(c, r) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
