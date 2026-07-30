<script setup>
// 容量规划：在频率计划上摆载波，逐转发器给出【带宽占用】与【功率占用】两条约束的并列读数。
// 口径承接 LbCapFoot 的「功率带宽」，两条都以 MHz 计、可直接与转发器带宽相比。
// 只出数值与色标，不出「达标/受限」这类文字判定（平台既定口径）。
import { computed, ref } from 'vue'
import { computeLoading, autoPlace, newCarrier } from '../shared/freqPlanCapacity.js'
import { resolveAll } from '../shared/freqPlanModel.js'
import Icon from '../components/Icon.vue'

const props = defineProps({
  plan: { type: Object, required: true },
  carriers: { type: Array, required: true }
})
const emit = defineEmits(['update:carriers', 'select-channel'])

const guardMHz = ref(0)
const expanded = ref({})

const tpNos = computed(() => resolveAll(props.plan).filter((r) => r.kind === 'transponder').map((r) => r.no).filter(Boolean))
const res = computed(() => computeLoading(props.plan, props.carriers, { guardMHz: Number(guardMHz.value) || 0 }))
const S = computed(() => res.value.summary)

const pct = (v) => (Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '—')
const fx = (v, d = 2) => (Number.isFinite(v) ? (Math.round(v * 10 ** d) / 10 ** d).toString() : '—')
// 占用率色标：> 1 是超，0.9~1 是临界。只上色，不写字。
const utilCls = (v) => (!Number.isFinite(v) ? '' : v > 1.0001 ? 'over' : v > 0.9 ? 'near' : '')

function addCarrier() {
  emit('update:carriers', [...props.carriers, newCarrier({ name: `载波 ${props.carriers.length + 1}`, channelNo: tpNos.value[0] || '' })])
}
function removeCarrier(id) { emit('update:carriers', props.carriers.filter((c) => c.id !== id)) }
function patchCarrier(id, key, val) {
  emit('update:carriers', props.carriers.map((c) => {
    if (c.id !== id) return c
    const v = ['occBwMHz', 'pwrBwMHz', 'infoRateKbps', 'fcMHz'].includes(key)
      ? (val === '' || val == null ? null : (Number.isFinite(Number(val)) ? Number(val) : null))
      : val
    return { ...c, [key]: v }
  }))
}
function doAutoPlace() {
  emit('update:carriers', autoPlace(props.plan, props.carriers, { guardMHz: Number(guardMHz.value) || 0 }))
}
// 功带平衡：把功率带宽按占用带宽对齐（一键把「等占用」的假设铺上去，之后逐条改）
function balanceAll() {
  emit('update:carriers', props.carriers.map((c) => ({ ...c, pwrBwMHz: Number.isFinite(c.occBwMHz) ? c.occBwMHz : c.pwrBwMHz })))
}

// 装填条：转发器带宽内载波的位置与宽度（未定频的顺序铺在后面，用斜纹区分）
function bars(t) {
  if (!Number.isFinite(t.bwMHz) || t.bwMHz <= 0) return []
  const out = []
  let cursor = 0
  for (const c of t.carriers) {
    const bw = Number(c.occBwMHz)
    if (!Number.isFinite(bw) || bw <= 0) continue
    if (Number.isFinite(c.fcMHz) && Number.isFinite(t.f1)) {
      out.push({ c, left: ((c.fcMHz - bw / 2 - t.f1) / t.bwMHz) * 100, width: (bw / t.bwMHz) * 100, placed: true })
    } else {
      out.push({ c, left: (cursor / t.bwMHz) * 100, width: (bw / t.bwMHz) * 100, placed: false })
      cursor += bw
    }
  }
  return out
}
</script>

<template>
  <div class="fpcap">
    <div class="cbar">
      <button class="mini" @click="addCarrier"><Icon name="plus" :size="12" /> 载波</button>
      <button class="mini ghost" :disabled="!carriers.length" @click="doAutoPlace" title="把未定中心频率的载波在其转发器内依次摆开（首次适配 + 保护带）">自动排布</button>
      <button class="mini ghost" :disabled="!carriers.length" @click="balanceAll" title="把每条载波的功率带宽置为其占用带宽（功带平衡的起点，之后可逐条改）">功带对齐</button>
      <label class="fld">保护带 <input class="ci num nar" v-model="guardMHz" /> MHz</label>
      <span class="spacer"></span>
      <span class="sm" v-if="S.unassignedCount"><b class="warn">{{ S.unassignedCount }}</b> 条未归属转发器</span>
      <span class="sm" v-if="S.issueCount"><b class="bad">{{ S.issueCount }}</b> 处冲突</span>
    </div>

    <!-- 整星汇总 -->
    <div class="sum">
      <div class="si"><span class="sl">转发器</span><span class="sv">{{ S.tpUsed }}<i>/{{ S.tpTotal }}</i></span></div>
      <div class="si"><span class="sl">总带宽</span><span class="sv">{{ fx(S.totalBwMHz) }}<i>MHz</i></span></div>
      <div class="si"><span class="sl">占用带宽</span><span class="sv" :class="utilCls(S.bwUtil)">{{ fx(S.occupiedBwMHz) }}<i>MHz</i></span></div>
      <div class="si"><span class="sl">带宽占用率</span><span class="sv" :class="utilCls(S.bwUtil)">{{ pct(S.bwUtil) }}</span></div>
      <div class="si"><span class="sl">功率带宽</span><span class="sv" :class="utilCls(S.pwrUtil)">{{ fx(S.powerBwMHz) }}<i>MHz</i></span></div>
      <div class="si"><span class="sl">功率占用率</span><span class="sv" :class="utilCls(S.pwrUtil)">{{ pct(S.pwrUtil) }}</span></div>
      <div class="si"><span class="sl">剩余</span><span class="sv">{{ fx(S.freeBwMHz) }}<i>MHz</i></span></div>
      <div class="si"><span class="sl">总信息速率</span><span class="sv">{{ fx(S.totalRateMbps, 3) }}<i>Mbps</i></span></div>
      <div class="si"><span class="sl">频谱效率</span><span class="sv">{{ S.avgEffBpsHz != null ? S.avgEffBpsHz.toFixed(3) : '—' }}<i>bps/Hz</i></span></div>
    </div>

    <div class="split">
      <!-- 逐转发器装填 -->
      <div class="tppane">
        <table class="t">
          <thead>
            <tr>
              <th></th><th>转发器</th><th>带宽</th><th>载波</th>
              <th title="Σ 载波占用带宽（Rs×(1+α)）">占用带宽</th><th>占用率</th>
              <th title="Σ 载波功率带宽（功率占用 × 转发器带宽）">功率带宽</th><th>功率率</th>
              <th title="两条约束里更紧的那条">剩余</th><th>速率 Mbps</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="t in res.transponders" :key="t.channelId">
              <tr :class="{ used: t.count > 0, bad: t.issues.length }" @click="emit('select-channel', t.channelId)">
                <td class="tw">
                  <button v-if="t.count" class="twb" @click.stop="expanded[t.no] = !expanded[t.no]">
                    <Icon :name="expanded[t.no] ? 'chevron-down' : 'chevron-right'" :size="11" />
                  </button>
                </td>
                <td class="nm">{{ t.no || '—' }}<i v-if="t.beam" class="bm">{{ t.beam }}</i></td>
                <td class="num">{{ fx(t.bwMHz) }}</td>
                <td class="num">{{ t.count || '' }}</td>
                <td class="num">{{ t.count ? fx(t.occSum) : '' }}</td>
                <td class="num" :class="utilCls(t.bwUtil)">{{ t.count ? pct(t.bwUtil) : '' }}</td>
                <td class="num">{{ t.count ? fx(t.pwrSum) : '' }}</td>
                <td class="num" :class="utilCls(t.pwrUtil)">{{ t.count ? pct(t.pwrUtil) : '' }}</td>
                <td class="num">{{ t.count ? fx(t.freeMHz) : fx(t.bwMHz) }}</td>
                <td class="num">{{ t.rateSum ? fx(t.rateSum / 1000, 3) : '' }}</td>
              </tr>
              <tr v-if="t.count" class="barrow">
                <td></td>
                <td colspan="9">
                  <div class="bar" :title="`转发器带宽 ${fx(t.bwMHz)} MHz`">
                    <div v-for="(b, i) in bars(t)" :key="i" class="seg" :class="{ float: !b.placed }"
                      :style="{ left: b.left + '%', width: b.width + '%' }" :title="`${b.c.name} · ${fx(b.c.occBwMHz)} MHz${b.placed ? ' @ ' + fx(b.c.fcMHz) + ' MHz' : '（未定频）'}`"></div>
                    <!-- 功率占用作为底衬横线，与带宽占用同轴比对 -->
                    <div class="pwr" :style="{ width: Math.min(100, (t.pwrSum / t.bwMHz) * 100) + '%' }"></div>
                  </div>
                </td>
              </tr>
              <tr v-if="expanded[t.no]" class="detrow">
                <td></td>
                <td colspan="9">
                  <div v-for="c in t.carriers" :key="c.id" class="cline">
                    <span class="cn">{{ c.name }}</span>
                    <span class="cd">{{ fx(c.occBwMHz) }} MHz</span>
                    <span class="cd">{{ Number.isFinite(c.fcMHz) ? fx(c.fcMHz) + ' MHz' : '未定频' }}</span>
                    <span class="cd">{{ c.modcod }}</span>
                  </div>
                </td>
              </tr>
              <tr v-for="(is, i) in t.issues" :key="t.channelId + 'i' + i" class="isrow">
                <td></td><td colspan="9" class="ismsg">{{ is.msg }}</td>
              </tr>
            </template>
          </tbody>
        </table>
        <div v-if="!res.transponders.length" class="none">频率计划里还没有转发器</div>
      </div>

      <!-- 载波清单 -->
      <div class="crpane">
        <div class="ph">载波清单</div>
        <div class="crscroll">
          <table class="t">
            <thead>
              <tr><th>名称</th><th>转发器</th><th title="Rs×(1+α)">占用 MHz</th><th title="功率占用 × 转发器带宽">功率 MHz</th><th>中心 MHz</th><th>速率 kbps</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="c in carriers" :key="c.id">
                <td><input class="ci" :value="c.name" @input="patchCarrier(c.id, 'name', $event.target.value)" /></td>
                <td>
                  <select class="ci nar" :value="c.channelNo" @change="patchCarrier(c.id, 'channelNo', $event.target.value)">
                    <option value="">—</option>
                    <option v-for="no in tpNos" :key="no" :value="no">{{ no }}</option>
                  </select>
                </td>
                <td><input class="ci num nar" :value="c.occBwMHz ?? ''" @input="patchCarrier(c.id, 'occBwMHz', $event.target.value)" /></td>
                <td><input class="ci num nar" :value="c.pwrBwMHz ?? ''" @input="patchCarrier(c.id, 'pwrBwMHz', $event.target.value)" /></td>
                <td><input class="ci num nar" :value="c.fcMHz ?? ''" @input="patchCarrier(c.id, 'fcMHz', $event.target.value)" /></td>
                <td><input class="ci num nar" :value="c.infoRateKbps ?? ''" @input="patchCarrier(c.id, 'infoRateKbps', $event.target.value)" /></td>
                <td><button class="del" title="删除" @click="removeCarrier(c.id)"><Icon name="x" :size="10" /></button></td>
              </tr>
            </tbody>
          </table>
          <div v-if="!carriers.length" class="none sm">
            还没有载波。点上方「载波」手工添加，或在链路预算工作台把链路表推送过来。
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fpcap { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.cbar { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-bottom: 1px solid var(--border); }
.spacer { flex: 1; }
.fld { font-size: 12px; color: var(--text-muted); display: inline-flex; align-items: center; gap: 4px; }
.sm { font-size: 12px; color: var(--text-muted); }
.sm .warn { color: var(--warn); }
.sm .bad { color: var(--danger); }

.sum { display: flex; flex-wrap: wrap; gap: 2px 18px; padding: 6px 10px; border-bottom: 1px solid var(--border); background: var(--surface); }
.si { display: flex; align-items: baseline; gap: 5px; }
.sl { font-size: 11.5px; color: var(--text-muted); }
.sv { font-size: 13px; font-variant-numeric: tabular-nums; }
.sv i { font-size: 10.5px; color: var(--text-faint); font-style: normal; margin-left: 1px; }
.sv.over { color: var(--danger); }
.sv.near { color: var(--warn); }

.split { flex: 1; display: grid; grid-template-columns: 1fr 480px; min-height: 0; }
.tppane { overflow: auto; border-right: 1px solid var(--border); }
.crpane { display: flex; flex-direction: column; min-height: 0; }
.ph { padding: 5px 8px; font-size: 12px; color: var(--text-muted); border-bottom: 1px solid var(--border); }
.crscroll { flex: 1; overflow: auto; }

.t { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.t thead th { position: sticky; top: 0; z-index: 1; background: var(--surface); border-bottom: 1px solid var(--border-strong); padding: 4px 6px; text-align: left; font-weight: 600; white-space: nowrap; }
.t td { border-bottom: 1px solid var(--border); padding: 2px 6px; }
.t tbody tr.used { background: color-mix(in srgb, var(--text) 3%, transparent); }
.t tbody tr.bad td { background: color-mix(in srgb, var(--danger) 7%, transparent); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.num.over { color: var(--danger); font-weight: 600; }
.num.near { color: var(--warn); }
.nm { white-space: nowrap; }
.nm .bm { font-style: normal; font-size: 11px; color: var(--text-faint); margin-left: 5px; }
.tw { width: 18px; }
.twb { border: none; background: transparent; color: var(--text-muted); cursor: pointer; padding: 0; }

.barrow td { padding: 0 6px 4px; border-bottom: 1px solid var(--border); }
.bar { position: relative; height: 13px; background: var(--surface-2); border: 1px solid var(--border); }
.seg { position: absolute; top: 1px; height: 7px; background: #5B8FD4; border: 1px solid rgba(0,0,0,.25); }
.seg.float { background: repeating-linear-gradient(45deg, #5B8FD4, #5B8FD4 3px, #8fb3e0 3px, #8fb3e0 6px); }
/* 功率占用作底衬：与带宽占用同一根轴上下对照，一眼看出是功率限还是带宽限 */
.pwr { position: absolute; bottom: 1px; left: 0; height: 3px; background: var(--warn); opacity: .85; }

.detrow td { padding: 2px 6px 5px; background: var(--surface); }
.cline { display: flex; gap: 12px; font-size: 11.5px; color: var(--text-muted); padding: 1px 0; }
.cn { min-width: 120px; color: var(--text); }
.cd { font-variant-numeric: tabular-nums; }
.isrow .ismsg { color: var(--danger); font-size: 11.5px; padding: 2px 6px 4px; }

.ci { width: 100%; background: transparent; border: 1px solid transparent; color: var(--text); padding: 2px 3px; font: inherit; font-family: var(--font-serif); }
.ci:hover { border-color: var(--border); }
.ci:focus { border-color: var(--text); outline: none; background: var(--bg); }
.ci.num { text-align: right; font-variant-numeric: tabular-nums; }
.ci.nar { max-width: 86px; }
.del { border: none; background: transparent; color: var(--text-faint); cursor: pointer; padding: 2px 4px; }
.del:hover { color: var(--danger); }
.none { padding: 20px; text-align: center; color: var(--text-faint); font-size: 12.5px; line-height: 1.7; }
.mini { font: inherit; font-size: 12.5px; padding: 3px 9px; border: 1px solid var(--border-strong); background: var(--bg); color: var(--text); cursor: pointer; }
.mini:hover:not(:disabled) { background: var(--surface-2); }
.mini:disabled { opacity: .45; cursor: default; }
.mini.ghost { color: var(--text-muted); }
</style>
