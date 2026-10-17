<script setup>
// 「容量汇总」对话框（GSO / NGSO / 再生式 三窗共用；功能区「导出 › 容量」打开）。
//
// 外壳是 AppDialog，宽一档。本组件不算任何数：账目由 shared/lbCapacity.buildCapModel 算好传进来，
// 这里只排一张按转发器分组的三线表——组头写转发器身份，组内逐链路一行，组末「小计 / 可用 / 剩余」
// 三行与资费读数，≥ 2 组时表末合计（体例同频率分配表的分组小计、运营商的传输计划）。
// 四样自定义回传宿主落盘：列入 / 载波数 → 行上 row.cap；可用带宽 / 可用功率 / 单价 → 场景级 capParams。
//
// 功率带宽两列按体制（model.pbw）：'sum' 组内求和并出可用 / 剩余；'list'（NGSO）只逐行列、小计与剩余留空；
// 'none'（再生式）整列不出。数值着色只有一条规则：超过可用（占用 > 100 %、剩余 < 0）标红。
import { computed } from 'vue'
import Icon from './Icon.vue'
import AppDialog from './AppDialog.vue'
import NumBox from './NumBox.vue'
import { CAP_PBW, CAP_DEC, capUnits, capFx } from '../shared/lbCapacity.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  model: { type: Object, default: null },      // buildCapModel(items, capParams, opts) 的结果
  adaptive: { type: Boolean, default: false }, // 功能区「单位」档
  sub: { type: String, default: '' },          // 题条副标（再生式：当前模块名）
  error: { type: String, default: '' }         // 整批计算的报错（与详细预算同一句）
})
const emit = defineEmits(['close', 'include', 'count', 'param', 'toggle-all', 'reset', 'export'])

const groups = computed(() => (props.model && props.model.groups) || [])
const total = computed(() => (props.model && props.model.total) || null)
const mode = computed(() => (props.model && props.model.pbw) || CAP_PBW.SUM)
const sumPw = computed(() => mode.value === CAP_PBW.SUM)
const hasPw = computed(() => mode.value !== CAP_PBW.NONE)
// 列：列入 · # · 链路 · 载波 · 载波数 ‖ 容量 · 载波带宽 · [功率带宽] · 带宽占用 · [功率占用]
const NLEAD = 5
const nval = computed(() => (hasPw.value ? 5 : 3))
const ncol = computed(() => NLEAD + nval.value)
const has = computed(() => groups.value.some((g) => g.rows.length))
const allOn = computed(() => groups.value.every((g) => g.rows.every((r) => r.on)))
const onCount = computed(() => (props.model && props.model.counts && props.model.counts.on) || 0)

// 显示档：整表带宽一档、容量一档（见 lbCapacity.capUnits）
const u = computed(() => capUnits(props.model, props.adaptive))
const fb = (v) => capFx(v != null ? v * u.value.bw.f : v, CAP_DEC.bw)
const fc = (v) => capFx(v != null ? v * u.value.cap.f : v, CAP_DEC.cap)
const fp = (v) => capFx(v, CAP_DEC.pct)
const fe = (v) => capFx(v, CAP_DEC.eff)
const ff = (v) => capFx(v, CAP_DEC.fee)
const fu = (v) => capFx(v, CAP_DEC.unitCost)
// 可用资源输入框按表的带宽档显示、按 kHz 回存（换档后输入 9 MHz 落库的是 9000 kHz）
const inBw = (kHz) => (kHz == null || !Number.isFinite(kHz) ? null : parseFloat((kHz * u.value.bw.f).toFixed(6)))
const phBw = (kHz) => { const v = inBw(kHz); return v == null ? '' : String(v) }
function setAvail(g, field, v) {
  emit('param', { key: g.key, field, value: v == null ? null : v / u.value.bw.f })
}

// 口径进悬停（界面不写说明文字）
const tipPbw = computed(() => (sumPw.value ? '功率占用 × 转发器带宽 × 载波数' : '各链路最差时刻的功率带宽，组内不求和'))
const tipPwUse = computed(() => (sumPw.value ? '功率带宽 / 可用功率' : '功率带宽 / 转发器带宽'))
const tipAvail = computed(() => (sumPw.value ? '留空：可用带宽＝转发器带宽，可用功率＝可用带宽'
  : mode.value === CAP_PBW.LIST ? '留空：可用带宽＝转发器带宽' : ''))
const tipBill = computed(() => (sumPw.value ? 'max(Σ载波带宽, Σ功率带宽)' : 'Σ载波带宽'))
</script>

<template>
  <AppDialog :open="open" width="min(1120px, 94vw)" flush @close="emit('close')">
    <template #title><span class="cd-t"><Icon name="sigma" :size="12" />容量汇总</span></template>
    <template v-if="sub" #head><span class="cd-head"><span class="cd-sub">{{ sub }}</span></span></template>

    <div class="cd-bd">
      <div v-if="error" class="lb-err">{{ error }}</div>
      <div v-else-if="!has" class="cd-empty">暂无链路。</div>
      <div v-else class="cd-scroll">
        <table class="cd-tbl">
          <thead>
            <tr>
              <th class="c-k" title="勾掉即不进汇总">列入</th>
              <th class="c-no">#</th>
              <th class="c-n">链路</th>
              <th class="c-c">载波</th>
              <th class="c-x" title="一行代表几路同型载波，容量与带宽按倍数计">载波数</th>
              <th class="c-v" title="频谱效率 × 载波带宽 × 载波数">容量<i>{{ u.cap.unit }}</i></th>
              <th class="c-v">载波带宽<i>{{ u.bw.unit }}</i></th>
              <th v-if="hasPw" class="c-v" :title="tipPbw">功率带宽<i>{{ u.bw.unit }}</i></th>
              <th class="c-v" title="载波带宽 / 可用带宽">带宽占用<i>%</i></th>
              <th v-if="hasPw" class="c-v" :title="tipPwUse">功率占用<i>%</i></th>
            </tr>
          </thead>
          <tbody v-for="g in groups" :key="g.key">
            <tr class="cd-g">
              <td :colspan="ncol">
                <span class="g-n" data-i18n-skip>{{ g.name || '—' }}</span>
                <span v-if="g.tpBwMHz" class="g-tp"><span>转发器带宽</span><b>{{ g.tpBwMHz }}</b><i>MHz</i></span>
              </td>
            </tr>
            <tr v-for="r in g.rows" :key="r.rowId" class="cd-r" :class="{ off: !r.on }">
              <td class="c-k"><input type="checkbox" :checked="r.on" @change="emit('include', { rowId: r.rowId, on: $event.target.checked })" /></td>
              <td class="c-no">{{ r.no }}</td>
              <td class="c-n" :title="r.name" data-i18n-skip>{{ r.name }}</td>
              <td class="c-c" :title="r.carrier" data-i18n-skip>{{ r.carrier }}</td>
              <td class="c-x"><NumBox class="cd-in n" :model-value="r.n" :min="1" :max="1000000" :step="1" @commit="(v) => emit('count', { rowId: r.rowId, n: v })" /></td>
              <template v-if="r.ok">
                <td class="c-v">{{ fc(r.capKbps) }}</td>
                <td class="c-v">{{ fb(r.bwKHz) }}</td>
                <td v-if="hasPw" class="c-v">{{ fb(r.pbwKHz) }}</td>
                <td class="c-v" :class="{ 'st-bad': r.on && r.bwPct > 100 }">{{ fp(r.bwPct) }}</td>
                <td v-if="hasPw" class="c-v" :class="{ 'st-bad': r.on && r.pwPct > 100 }">{{ fp(r.pwPct) }}</td>
              </template>
              <td v-else class="c-err" :colspan="nval">{{ r.error || '—' }}</td>
            </tr>
            <tr class="cd-s">
              <td></td><td></td><td class="c-l">小计</td><td></td>
              <td class="c-x c-v">{{ g.n }}</td>
              <td class="c-v">{{ fc(g.capKbps) }}</td>
              <td class="c-v">{{ fb(g.bwKHz) }}</td>
              <td v-if="hasPw" class="c-v">{{ sumPw ? fb(g.pbwKHz) : '' }}</td>
              <td class="c-v" :class="{ 'st-bad': g.bwPct > 100 }">{{ fp(g.bwPct) }}</td>
              <td v-if="hasPw" class="c-v" :class="{ 'st-bad': g.pwPct > 100 }">{{ sumPw ? fp(g.pwPct) : '' }}</td>
            </tr>
            <tr class="cd-a">
              <td></td><td></td><td class="c-l" :title="tipAvail || null">可用</td><td></td><td></td><td></td>
              <td class="c-v"><NumBox class="cd-in" :model-value="g.availBwUser ? inBw(g.availBwKHz) : null" :placeholder="phBw(g.availBwDef)"
                allow-empty :min="0" @commit="(v) => setAvail(g, 'bwKHz', v)" /></td>
              <td v-if="hasPw" class="c-v"><NumBox v-if="sumPw" class="cd-in" :model-value="g.availPwUser ? inBw(g.availPwKHz) : null" :placeholder="phBw(g.availPwDef)"
                allow-empty :min="0" @commit="(v) => setAvail(g, 'pwKHz', v)" /></td>
              <td></td><td v-if="hasPw"></td>
            </tr>
            <tr class="cd-m">
              <td></td><td></td><td class="c-l" title="可用 − 小计">剩余</td><td></td><td></td><td></td>
              <td class="c-v" :class="{ 'st-bad': g.remBwKHz < 0 }">{{ fb(g.remBwKHz) }}</td>
              <td v-if="hasPw" class="c-v" :class="{ 'st-bad': g.remPwKHz < 0 }">{{ sumPw ? fb(g.remPwKHz) : '' }}</td>
              <td></td><td v-if="hasPw"></td>
            </tr>
            <tr class="cd-f">
              <td :colspan="ncol">
                <span class="cf-i" title="Σ容量 / Σ载波带宽"><span>频谱效率</span><b>{{ fe(g.effBpsHz) }}</b><i>bps/Hz</i></span>
                <span class="cf-i" :title="tipBill"><span>结算带宽</span><b>{{ fb(g.billKHz) }}</b><i>{{ u.bw.unit }}</i></span>
                <span class="cf-i"><span>单价</span><NumBox class="cd-in pr" :model-value="g.price" allow-empty :min="0"
                  @commit="(v) => emit('param', { key: g.key, field: 'price', value: v })" /><i>万元/MHz/年</i></span>
                <template v-if="g.price != null">
                  <span class="cf-i" title="单价 × 结算带宽"><span>年费</span><b>{{ ff(g.feeWan) }}</b><i>万元/年</i></span>
                  <span class="cf-i" title="年费 / 容量"><span>单位容量成本</span><b>{{ fu(g.unitCostWan) }}</b><i>万元/Mbps/年</i></span>
                </template>
              </td>
            </tr>
          </tbody>
          <tfoot v-if="total">
            <tr class="cd-t1">
              <td></td><td></td><td class="c-l" :title="sumPw ? '功率带宽不跨转发器相加' : null">合计</td><td></td>
              <td class="c-x c-v">{{ total.n }}</td>
              <td class="c-v">{{ fc(total.capKbps) }}</td>
              <td class="c-v">{{ fb(total.bwKHz) }}</td>
              <td v-if="hasPw"></td><td></td><td v-if="hasPw"></td>
            </tr>
            <tr class="cd-f">
              <td :colspan="ncol">
                <span class="cf-i" title="Σ容量 / Σ载波带宽"><span>频谱效率</span><b>{{ fe(total.effBpsHz) }}</b><i>bps/Hz</i></span>
                <span class="cf-i"><span>结算带宽</span><b>{{ fb(total.billKHz) }}</b><i>{{ u.bw.unit }}</i></span>
                <template v-if="total.feeWan != null">
                  <span class="cf-i"><span>年费</span><b>{{ ff(total.feeWan) }}</b><i>万元/年</i></span>
                  <span class="cf-i" title="年费 / 容量"><span>单位容量成本</span><b>{{ fu(total.unitCostWan) }}</b><i>万元/Mbps/年</i></span>
                </template>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>

    <template #footer>
      <span class="adlg-ft-l">
        <button class="btn" :disabled="!has" :title="allOn ? '全部链路不列入汇总' : '全部链路列入汇总'"
          @click="emit('toggle-all', !allOn)">{{ allOn ? '全部不列入' : '全部列入' }}</button>
        <button class="btn" :disabled="!has" title="全部链路重新列入、载波数回 1，可用资源与单价清空" @click="emit('reset')">重置</button>
        <!-- 独立的《容量汇总》报告：不出 PDF、不带图，只印本表的账（同 SLA 弹窗的「导出报告」） -->
        <button class="btn" :disabled="!onCount"
          :title="onCount ? '单出一份《容量汇总》报告（Excel / Word）' : '尚无列入的链路'"
          @click="emit('export')"><Icon name="file-export" :size="12" />导出报告</button>
      </span>
      <button class="btn primary" @click="emit('close')">关闭</button>
    </template>
  </AppDialog>
</template>

<style scoped>
/* 字体走界面字体 var(--font-ui)、字号吃 --lb-fs（功能区「字号」）——同 SLA 弹窗：这是界面不是交付文档。
   三线表口径同 WaterfallTable / SLA 条款表：顶线 / 底线 --lb-rule-strong、栏目线 --lb-rule、组间 --lb-rule-soft，
   行间无框线无底纹，层次靠字重。尺寸一律 em，随字号整体缩放。 */
.cd-t { display: inline-flex; align-items: center; gap: 6px; }
.cd-head { flex: 0 1 auto; min-width: 0; display: flex; align-items: center; padding: 0 10px; }
.cd-sub { font-size: var(--fs-2); color: var(--text-faint); white-space: nowrap; }
.cd-bd { padding: 12px; }
.cd-empty { padding: 8px; color: var(--text-faint); font-size: var(--fs-3); }
.cd-scroll { overflow-x: auto; }
.cd-tbl {
  width: 100%; border-collapse: collapse; font-family: var(--font-ui); font-size: var(--lb-fs);
  font-variant-numeric: tabular-nums;
}
.cd-tbl thead th {
  padding: 2px 6px 3px; text-align: left; font-weight: 600; color: var(--text-muted); white-space: nowrap;
  border-top: 2px solid var(--lb-rule-strong); border-bottom: 1px solid var(--lb-rule);
}
.cd-tbl thead th i { font-style: normal; font-weight: 400; color: var(--text-faint); margin-left: .35em; }
.cd-tbl td { padding: 1px 6px; line-height: 1.6; vertical-align: baseline; white-space: nowrap; }
.cd-tbl .c-v { text-align: right; }
.cd-tbl .c-k { width: 3.2em; text-align: center; }
.cd-tbl .c-k input { margin: 0; vertical-align: middle; }
.cd-tbl .c-no { width: 2.4em; text-align: right; color: var(--text-faint); }
.cd-tbl .c-n { max-width: 22em; overflow: hidden; text-overflow: ellipsis; }
.cd-tbl .c-c { max-width: 14em; overflow: hidden; text-overflow: ellipsis; color: var(--text-muted); }
.cd-tbl .c-x { width: 5.4em; text-align: right; }
.cd-tbl .c-l { color: var(--text-muted); }
.cd-tbl .c-err { color: var(--text-faint); }
/* 组头：加粗 + 组间发丝线，转发器身份跟在星名后 */
.cd-g > td { padding-top: .7em; font-weight: 700; color: var(--text); border-top: 1px solid var(--lb-rule-soft); }
.cd-tbl tbody:first-of-type .cd-g > td { padding-top: 3px; border-top: none; }
.cd-g .g-tp { margin-left: 1.4em; font-weight: 400; color: var(--text-muted); }
.cd-g .g-tp b { margin: 0 .3em; font-weight: 600; color: var(--text); }
.cd-g .g-tp i { font-style: normal; color: var(--text-faint); }
.cd-r:hover > td { background: var(--surface); }
/* 不列入：整行压暗（数还在，只是不进和） */
.cd-r.off > td:not(.c-k) { color: var(--text-faint); }
/* 组末三行：小计带一道发丝线、加粗；可用 / 剩余照常字重 */
.cd-s > td { font-weight: 600; color: var(--text); border-top: 1px solid var(--lb-rule-soft); }
.cd-s > td.c-l { font-weight: 600; }
/* 资费与效率读数：一行横排，项间留白 */
.cd-f > td { padding: 1px 6px 4px; white-space: normal; color: var(--text-muted); }
.cf-i { display: inline-flex; align-items: baseline; gap: .35em; margin-right: 1.8em; white-space: nowrap; }
.cf-i b { font-weight: 600; color: var(--text); }
.cf-i i { font-style: normal; color: var(--text-faint); }
/* 合计：栏目线隔开，加粗；整表底线落在最后一行 */
.cd-t1 > td { font-weight: 700; color: var(--text); border-top: 1px solid var(--lb-rule); padding-top: 3px; }
.cd-tbl > :last-child > tr:last-child > td { border-bottom: 2px solid var(--lb-rule-strong); }
.st-bad, .cd-tbl td.st-bad { color: var(--danger); font-weight: 600; }
.cd-in {
  width: 7.4em; font: inherit; font-size: var(--lb-fs); text-align: right; padding: 0 4px;
  font-variant-numeric: tabular-nums;
  background: var(--field-bg); color: var(--text); border: 1px solid var(--field-border); border-radius: var(--r-ctl, 2px);
}
.cd-in:focus { outline: none; border-color: var(--accent-ui); }
.cd-in.n { width: 4.6em; }
.cd-in.pr { width: 5.6em; }
.cd-in::placeholder { color: var(--text-faint); }
</style>
