<script setup>
// 「高级计算」对话框：多载波功带平衡（VSAT 组网 / CNC 载波叠加），GEO / NGSO 两窗共用。
//
// 它解决的是单链路口径解决不了的事——转发器上跑一组载波时，平衡是整组的账：前向 TDM 超发、
// 返向 TDMA 欠发，各自都不平衡，合起来 Σ功率带宽 = Σ载波带宽 才是要的结果；CNC 则是两条链路
// 占同一段频谱、功率叠加。求解在核心算法外层（见 shared/advBalance.js），结果落成各载波的
// 「设置余量」，落地后照常走一次正常计算，屏幕上的数全部来自引擎本身。
//
// 参考态取【上一次计算的结果】：勾选列表里每条链路的载波带宽/功率带宽/余量都是引擎算出来的，
// 预览里的解算是闭式的（余量抬 x dB ⇔ 功率带宽 ×10^(x/10)），所以拖动开关时读数即时刷新，
// 不用每调一下都往引擎跑一趟；点「应用」写回余量后重算全表，残差回读的就是引擎真值。
import { ref, reactive, computed, watch } from 'vue'
import Icon from './Icon.vue'
import { ADV_MODES, ADV_BASES, solveAdv } from '../shared/advBalance.js'
import { pickColumn, fmtScaled } from '../shared/adaptUnits.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  // 候选链路（全表）：{ no, rowId, name, carrierId, carrierName, bwKHz, pbwKHz, marginDb, error }
  rows: { type: Array, default: () => [] },
  tpBwMhz: { type: Number, default: 0 },   // 转发器带宽 MHz（占用率读数用）
  busy: { type: Boolean, default: false },
  stale: { type: Boolean, default: false },  // 上一次计算之后输入又改过 → 参考态可能已不对
  // 应用后若派生了载波副本，宿主回传 { 原载波id: 副本id }——锁定/偏置跟着搬过去，
  // 否则下一轮打开时这些开关会因为载波换了 id 而悄悄归零，解出来的余量跟着变
  carrierRemap: { type: Object, default: null },
  storeKey: { type: String, default: 'lb' }
})
const emit = defineEmits(['close', 'apply'])

// —— 面板状态（按窗口记忆：一轮试错要反复开合，选择不该每次重来）——
const KEY = computed(() => props.storeKey + '/advBalance')
const mode = ref('vsat')
const base = ref('current')
const overDb = ref('0')
const pickedIds = ref(new Set())
const cstate = reactive({})   // { [carrierId]: { locked, bias } }

function loadSaved() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY.value) || 'null')
    if (!s) return
    if (s.mode) mode.value = s.mode
    if (s.base) base.value = s.base
    if (s.overDb != null) overDb.value = String(s.overDb)
    if (Array.isArray(s.rowIds)) pickedIds.value = new Set(s.rowIds)
    if (s.carriers) for (const [k, v] of Object.entries(s.carriers)) cstate[k] = { locked: !!v.locked, bias: v.bias == null ? 0 : v.bias }
  } catch (e) { /* 记忆坏了就用默认值 */ }
}
function persist() {
  try {
    localStorage.setItem(KEY.value, JSON.stringify({
      mode: mode.value, base: base.value, overDb: overDb.value,
      rowIds: [...pickedIds.value], carriers: JSON.parse(JSON.stringify(cstate))
    }))
  } catch (e) { /* ignore */ }
}
watch([mode, base, overDb, pickedIds, cstate], persist, { deep: true })

// 可参与配平的行＝上次算出了带宽/功率带宽/余量的行（算失败或没算过的行只列出、不可勾）
const usable = (r) => isFinite(r.bwKHz) && isFinite(r.pbwKHz) && isFinite(r.marginDb)

// 打开时对齐现表：记忆里的行可能已被删；一条都没勾中（首次开）则默认全选可用链路
watch(() => props.open, (v) => {
  if (!v) return
  loadSaved()
  const alive = new Set(props.rows.map((r) => r.rowId))
  const keep = new Set([...pickedIds.value].filter((id) => alive.has(id)))
  pickedIds.value = keep.size ? keep : new Set(props.rows.filter((r) => usable(r)).map((r) => r.rowId))
}, { immediate: true })   // 挂载时若已是打开态也照样初始化（关着即空转）

const isPicked = (r) => pickedIds.value.has(r.rowId)
function togglePick(r) {
  if (!usable(r)) return
  const s = new Set(pickedIds.value)
  if (s.has(r.rowId)) s.delete(r.rowId); else s.add(r.rowId)
  pickedIds.value = s
}
const allPicked = computed(() => { const u = props.rows.filter(usable); return u.length > 0 && u.every(isPicked) })
function toggleAll() {
  pickedIds.value = allPicked.value ? new Set() : new Set(props.rows.filter(usable).map((r) => r.rowId))
}

const picked = computed(() => props.rows.filter((r) => isPicked(r)))
// 逐载波开关（锁定 / 偏置），键就是载波条目 id。读是纯的（没这一项就返回默认值，不在渲染里写
// 响应式状态，否则读一次多触发一轮渲染），写只在用户动开关时发生。
const cs = (id) => cstate[id] || { locked: false, bias: 0 }
const setCs = (id, patch) => { cstate[id] = { ...cs(id), ...patch } }
watch(() => props.carrierRemap, (m) => {
  if (!m) return
  for (const [from, to] of Object.entries(m)) if (cstate[from] && !cstate[to]) { cstate[to] = cstate[from]; delete cstate[from] }
})
const modeInfo = computed(() => ADV_MODES.find((m) => m.key === mode.value) || ADV_MODES[0])
const baseInfo = computed(() => ADV_BASES.find((b) => b.key === base.value) || ADV_BASES[0])
const res = computed(() => solveAdv({
  mode: mode.value, picked: picked.value, state: cstate, base: base.value, overDb: overDb.value, tpBwMHz: props.tpBwMhz
}))
// CNC 只有一份载波（校验已强制），锁定/偏置/基准都无意义 → 只在 VSAT 下露出那一栏
const showCarrierTab = computed(() => mode.value === 'vsat')
const canApply = computed(() => !props.busy && res.value.ok && res.value.carriers.some((c) => !c.locked))

// —— 带宽读数共选一个单位（档位表同结果列）：全对话框统一，不在同一屏里混 kHz/MHz ——
// 档位按【最小】的那个值挑，不按最大：一组载波里大小差两三个数量级是常态（8 MHz 前向 + 75 kHz 返向），
// 按最大挑会把小的那些压成 0.0749 MHz——有效数字全丢在小数点后，残差也看不出来
const bwUnit = computed(() => {
  const vals = []
  for (const r of props.rows) { if (isFinite(r.bwKHz)) vals.push(Math.abs(r.bwKHz)); if (isFinite(r.pbwKHz)) vals.push(Math.abs(r.pbwKHz)) }
  const pos = vals.filter((v) => v > 0)
  if (!pos.length) return { unit: 'kHz', conv: (v) => v }
  return pickColumn([Math.min(...pos)], 'kHz') || { unit: 'kHz', conv: (v) => v }
})
const bw = (kHz) => (isFinite(kHz) ? fmtScaled(bwUnit.value.conv(kHz)) : '—')
const bwU = computed(() => bwUnit.value.unit)
const d2 = (v) => (isFinite(v) ? v.toFixed(2) : '—')
const sign = (v) => (isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) : '—')
// 单条链路的功带差：功率带宽 / 载波带宽（正＝超发，负＝欠发）
const gapOf = (r) => (usable(r) && r.bwKHz > 0 ? 10 * Math.log10(r.pbwKHz / r.bwKHz) : NaN)

function apply() {
  if (!canApply.value) return
  emit('apply', {
    mode: mode.value, base: base.value, overDb: parseFloat(overDb.value) || 0,
    rowIds: picked.value.map((p) => p.rowId),
    carriers: res.value.carriers.map((c) => ({ id: c.id, name: c.name, locked: c.locked, toDb: c.toDb, fromDb: c.fromDb }))
  })
}
</script>

<template>
  <div v-if="open" class="ab-mask">
    <div class="ab" role="dialog" aria-modal="true">
      <div class="ab-hd">
        <Icon name="sliders" :size="13" />高级计算 · 多载波功带平衡
        <span class="ab-sp"></span>
        <button class="ab-x" :disabled="busy" title="关闭" aria-label="关闭" @click="emit('close')"><Icon name="x" :size="13" /></button>
      </div>

      <div class="ab-bd">
        <!-- 模式：两种组平衡口径 -->
        <div class="ab-modes">
          <button v-for="m in ADV_MODES" :key="m.key" class="ab-mode" :class="{ on: mode === m.key }" :title="m.desc" @click="mode = m.key">{{ m.label }}</button>
          <span class="ab-mode-desc">{{ modeInfo.desc }}</span>
        </div>
        <div v-if="stale" class="ab-warn">链路表输入在上次计算之后又改过——下面的参考数据来自那次计算，建议先重新计算再配平。</div>

        <!-- ① 参与链路 -->
        <div class="ab-sec">参与链路<i>勾选进入本组配平；数据取自上一次计算</i></div>
        <div class="ab-tw">
          <table class="ab-t">
            <thead>
              <tr>
                <th class="ck"><input type="checkbox" :checked="allPicked" title="全选 / 全不选" @change="toggleAll" /></th>
                <th class="no">#</th>
                <th>链路</th>
                <th>载波</th>
                <th class="n">载波带宽<i>{{ bwU }}</i></th>
                <th class="n">功率带宽<i>{{ bwU }}</i></th>
                <th class="n" title="功率带宽 ÷ 载波带宽：正＝超发（功率占用多于带宽），负＝欠发（带宽占用多于功率）">功带差<i>dB</i></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in rows" :key="r.rowId" :class="{ on: isPicked(r), off: !usable(r) }" @click="togglePick(r)">
                <td class="ck"><input type="checkbox" :checked="isPicked(r)" :disabled="!usable(r)" @click.stop="togglePick(r)" /></td>
                <td class="no">{{ r.no }}</td>
                <td class="nm" :title="r.name">{{ r.name }}</td>
                <td class="nm" :title="r.carrierName">{{ r.carrierName }}</td>
                <td class="n">{{ usable(r) ? bw(r.bwKHz) : '—' }}</td>
                <td class="n">{{ usable(r) ? bw(r.pbwKHz) : '—' }}</td>
                <td class="n" :class="{ over: gapOf(r) > 0.005, under: gapOf(r) < -0.005 }">{{ usable(r) ? sign(gapOf(r)) : (r.error || '未计算') }}</td>
              </tr>
              <tr v-if="!rows.length"><td colspan="7" class="ab-empty">链路表还没有可用结果，请先「计算」</td></tr>
            </tbody>
          </table>
        </div>

        <!-- ② 载波（未知数）：余量存在载波配置上，同一份载波被几条链路共用就共用一个余量 -->
        <template v-if="showCarrierTab">
          <div class="ab-sec">载波余量<i>一份载波一个未知数；可锁定（维持现状）或加偏置（相对基准的超发量），其余载波统一平移吸收</i></div>
          <div class="ab-tw">
            <table class="ab-t">
              <thead>
                <tr>
                  <th>载波配置</th>
                  <th class="n">链路</th>
                  <th class="n">当前余量<i>dB</i></th>
                  <th class="n" title="该载波单独看时的功带平衡余量">自身平衡点<i>dB</i></th>
                  <th class="ck2" title="锁定＝这份载波的余量保持不动，配平由其余载波吸收">锁定</th>
                  <th class="n" title="相对基准的固定偏置，如前向按设计超发 +2 dB">偏置<i>dB</i></th>
                  <th class="n">解出余量<i>dB</i></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in res.carriers" :key="c.id">
                  <td class="nm" :title="c.name">{{ c.name }}</td>
                  <td class="n">{{ c.n }}</td>
                  <td class="n">{{ d2(c.fromDb) }}</td>
                  <td class="n dim">{{ d2(c.balanceDb) }}</td>
                  <td class="ck2"><input type="checkbox" :checked="cs(c.id).locked" @change="setCs(c.id, { locked: $event.target.checked })" /></td>
                  <td class="n"><input class="ab-in" type="number" step="0.1" :disabled="cs(c.id).locked" :value="cs(c.id).bias" @change="setCs(c.id, { bias: parseFloat($event.target.value) || 0 })" /></td>
                  <td class="n st" :class="{ dim: c.locked, bad: !c.locked && c.toDb < 0 }">{{ d2(c.toDb) }}<i v-if="!c.locked" class="ab-sh">{{ sign(c.shiftDb) }}</i></td>
                </tr>
                <tr v-if="!res.carriers.length"><td colspan="7" class="ab-empty">先在上表勾选链路</td></tr>
              </tbody>
            </table>
          </div>
        </template>

        <!-- ③ 配平口径 + 结果读数 -->
        <div class="ab-sec">配平</div>
        <div class="ab-ctl">
          <label v-if="showCarrierTab" title="统一平移的起点：以各载波当前余量为准，或先各自移到自身功带平衡点再平移">
            <span>基准</span>
            <select v-model="base"><option v-for="b in ADV_BASES" :key="b.key" :value="b.key" :title="b.desc">{{ b.label }}</option></select>
          </label>
          <label title="目标总功率带宽相对组占用带宽再抬高的 dB 数；0 即严格功带平衡">
            <span>组超发量</span>
            <input v-model="overDb" class="ab-in w" type="number" step="0.1" /><i>dB</i>
          </label>
          <span v-if="showCarrierTab" class="ab-ctl-note">{{ baseInfo.desc }}</span>
        </div>

        <div v-if="!res.ok" class="ab-err">{{ res.message }}</div>
        <div v-else class="ab-out">
          <div class="ab-kv"><span>组占用带宽</span><b>{{ bw(res.occBwKHz) }}</b><i>{{ bwU }}</i>
            <em v-if="mode === 'cnc'">同频叠加，带宽只算一份（Σ载波带宽 {{ bw(res.sumBwKHz) }} {{ bwU }}）</em></div>
          <div class="ab-kv"><span>目标总功率带宽</span><b>{{ bw(res.targetKHz) }}</b><i>{{ bwU }}</i>
            <em v-if="res.overDb">＝组占用带宽 + {{ d2(res.overDb) }} dB 超发</em></div>
          <div class="ab-kv"><span>Σ功率带宽</span><b>{{ bw(res.beforePbwKHz) }} → {{ bw(res.afterPbwKHz) }}</b><i>{{ bwU }}</i>
            <em>残差 {{ bw(res.residualKHz) }} {{ bwU }}</em></div>
          <div class="ab-kv"><span>统一平移量 Δ</span><b class="st">{{ sign(res.deltaDb) }}</b><i>dB</i>
            <em>可调载波在基准余量上同抬同降</em></div>
          <div v-if="isFinite(res.bwUsePct)" class="ab-kv"><span>转发器占用</span><b :class="{ bad: res.pwUsePct > 100 || res.bwUsePct > 100 }">带宽 {{ d2(res.bwUsePct) }}% · 功率 {{ d2(res.pwUsePct) }}%</b>
            <em>解后（占用率 &gt;100% 表示这组载波超出转发器资源）</em></div>
        </div>
        <div v-for="(w, i) in (res.warnings || [])" :key="i" class="ab-warn">{{ w }}</div>

        <div class="ab-hint">
          应用＝把解出的余量写进对应载波配置（计算方式一并置为「设置余量」），随后自动重算全表。
          载波若还被本表中未勾选的链路引用，会另派生一份专用副本（原载波不动，那些链路不受影响）。
        </div>
      </div>

      <div class="ab-ft">
        <button class="ab-btn" :disabled="busy" @click="emit('close')">关闭</button>
        <button class="ab-btn primary" :disabled="!canApply" @click="apply">{{ busy ? '计算中…' : '应用并重算' }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 与导出报告等对话框同一套控件语言（方角、细边、衬线数字），宽一档——里面是两张表 */
.ab-mask { position: fixed; inset: 0; z-index: 320; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.28); }
.ab {
  width: 760px; max-width: 96vw; max-height: 90vh; display: flex; flex-direction: column;
  font-family: var(--lb-serif, var(--font-serif));
  background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-modal, 3px);
  box-shadow: 0 8px 24px rgba(0,0,0,.18); overflow: hidden;
}
.ab-hd {
  display: flex; align-items: center; gap: 6px; padding: 10px 12px;
  font-size: 11px; font-weight: 600; letter-spacing: 1px; color: var(--text-muted);
  background: var(--surface-2); border-bottom: 1px solid var(--border);
}
.ab-sp { flex: 1; }
.ab-x {
  display: inline-flex; align-items: center; justify-content: center; margin: -4px -4px -4px 4px; padding: 3px;
  font: inherit; color: var(--text-faint); cursor: pointer; background: transparent; border: 1px solid transparent; border-radius: var(--r-ctl, 2px);
}
.ab-x:hover:not(:disabled) { color: var(--text); background: var(--bg); border-color: var(--border); }
.ab-bd { padding: 12px; overflow: auto; }

.ab-modes { display: flex; align-items: center; gap: 0; flex-wrap: wrap; }
.ab-mode {
  font: inherit; font-size: 12px; padding: 4px 12px; cursor: pointer;
  background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: 0;
}
.ab-mode + .ab-mode { border-left: none; }
.ab-mode:first-of-type { border-radius: var(--r-ctl, 2px) 0 0 var(--r-ctl, 2px); }
.ab-mode:nth-of-type(2) { border-radius: 0 var(--r-ctl, 2px) var(--r-ctl, 2px) 0; }
.ab-mode.on { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.ab-mode-desc { flex: 1 1 100%; margin-top: 5px; font-size: 11px; color: var(--text-faint); line-height: 1.5; }

.ab-sec {
  display: flex; align-items: baseline; gap: 8px; margin: 12px 0 5px; padding-bottom: 3px;
  font-size: 11px; font-weight: 700; color: var(--text); border-bottom: 1px solid var(--lb-rule, var(--border));
}
.ab-sec i { font-style: normal; font-weight: 400; font-size: 10px; color: var(--text-faint); }

.ab-tw { max-height: 208px; overflow: auto; border: 1px solid var(--border); }
.ab-t { width: 100%; border-collapse: collapse; font-size: 11px; }
.ab-t th {
  position: sticky; top: 0; z-index: 1; padding: 4px 6px; text-align: left; font-weight: 600; white-space: nowrap;
  color: var(--text-muted); background: var(--surface-2); border-bottom: 1px solid var(--border);
}
.ab-t th i { font-style: normal; font-weight: 400; color: var(--text-faint); margin-left: 3px; }
.ab-t td { padding: 3px 6px; border-bottom: 1px solid var(--border); color: var(--text); }
.ab-t tbody tr { cursor: pointer; }
.ab-t tbody tr:hover { background: var(--surface); }
.ab-t tbody tr.on { background: var(--surface-2); }
.ab-t tbody tr.off { color: var(--text-faint); cursor: not-allowed; }
.ab-t .ck, .ab-t .ck2 { width: 26px; text-align: center; }
.ab-t .ck input, .ab-t .ck2 input { margin: 0; accent-color: var(--accent); }
.ab-t .no { width: 26px; color: var(--text-faint); }
.ab-t .n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.ab-t .nm { max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ab-t .dim { color: var(--text-faint); }
.ab-t .st { font-weight: 700; }
.ab-t .over { color: var(--warn, #b06a2c); }
.ab-t .under { color: var(--text-muted); }
.ab-t .bad { color: var(--danger, #b3403a); }
.ab-sh { font-style: normal; margin-left: 5px; font-weight: 400; font-size: 10px; color: var(--text-faint); }
.ab-empty { text-align: center; color: var(--text-faint); padding: 10px; cursor: default; }
.ab-in {
  width: 62px; font: inherit; font-size: 11px; padding: 2px 4px; text-align: right;
  background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px);
}
.ab-in:focus { outline: none; border-color: var(--accent); }
.ab-in:disabled { opacity: .4; }
.ab-in.w { width: 72px; }

.ab-ctl { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; font-size: 11px; }
.ab-ctl label { display: inline-flex; align-items: center; gap: 5px; color: var(--text); }
.ab-ctl label > span { color: var(--text-muted); }
.ab-ctl label > i { font-style: normal; color: var(--text-faint); }
.ab-ctl select { font: inherit; font-size: 11px; padding: 2px 4px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.ab-ctl-note { flex: 1 1 100%; font-size: 10px; color: var(--text-faint); }

.ab-out { margin-top: 8px; display: grid; grid-template-columns: 1fr 1fr; gap: 4px 18px; }
.ab-kv { display: flex; align-items: baseline; gap: 5px; font-size: 11px; min-width: 0; }
.ab-kv > span { color: var(--text-muted); }
.ab-kv > b { font-variant-numeric: tabular-nums; color: var(--text); }
.ab-kv > b.st { font-size: 13px; }
.ab-kv > b.bad { color: var(--danger, #b3403a); }
.ab-kv > i { font-style: normal; color: var(--text-faint); }
.ab-kv > em { font-style: normal; color: var(--text-faint); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.ab-err { margin-top: 8px; padding: 6px 8px; font-size: 11px; line-height: 1.5; color: var(--danger, #b3403a); background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.ab-warn { margin-top: 6px; font-size: 10px; line-height: 1.5; color: var(--warn, #b06a2c); }
.ab-hint { margin-top: 10px; font-size: 10px; line-height: 1.6; color: var(--text-faint); }

.ab-ft { display: flex; justify-content: flex-end; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--border); background: var(--surface); }
.ab-btn {
  font: inherit; font-size: 11px; line-height: 1; padding: 4px 12px; cursor: pointer;
  background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px);
}
.ab-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.ab-btn:disabled { opacity: .45; cursor: not-allowed; }
.ab-btn.primary { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.ab-btn.primary:hover:not(:disabled) { opacity: .88; }
</style>
