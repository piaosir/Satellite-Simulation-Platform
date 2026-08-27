<script setup>
// 「高级计算」对话框：多载波功带平衡（VSAT 组网 / CNC 载波叠加），GEO / NGSO 两窗共用。
//
// 它解决的是单链路口径解决不了的事——转发器上跑一组载波时，平衡是整组的账：前向 TDM 超发、
// 返向 TDMA 欠发，各自都不平衡，合起来 Σ功率带宽 = Σ载波带宽 才是要的结果；CNC 则是两条链路
// 占同一段频谱、功率叠加。求解在核心算法外层（见 shared/advBalance.js），结果落成各载波的
// 「设置余量」，落地后照常走一次正常计算，屏幕上的数全部来自引擎本身。
//
// 参考态取【上一次计算的结果】：勾选列表里每条链路的载波带宽/功率带宽/余量都是引擎算出来的，
// 预览里的解算是闭式的（余量抬 x dB ⇔ 功率带宽 ×10^(x/10)），所以改一下旋钮读数即时刷新，
// 不用每调一下都往引擎跑一趟；点「应用」写回余量后重算全表，残差回读的就是引擎真值。
//
// 面向用户的字串（列名 / 读数名 / 提示 / 报错）一律走全软件的术语：系统余量、载波带宽、功率带宽、
// 功带平衡、超发/欠发、转发器资源占用……与链路表结果列、载波配置面板同名同义，别在这儿另起一套。
import { ref, reactive, computed, watch } from 'vue'
import NumBox from './NumBox.vue'
import Icon from './Icon.vue'
import { ADV_MODES, ADV_BASES, solveAdv } from '../shared/advBalance.js'
import { pickColumn, fmtScaled, fmtQty } from '../shared/adaptUnits.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  // 候选链路（全表）：{ no, rowId, name, carrierId, carrierName, bwKHz, pbwKHz, marginDb, baseDb, error }
  // baseDb＝该载波进本功能之前那份原始余量（宿主用 advBaseMargin 从载波配置上取）：反复应用不叠偏置
  rows: { type: Array, default: () => [] },
  tpBwMhz: { type: Number, default: 0 },   // 转发器带宽 MHz（占用率读数用）
  busy: { type: Boolean, default: false },
  stale: { type: Boolean, default: false },  // 上一次计算之后输入又改过 → 参考态可能已不对
  // 应用后若派生了载波副本，宿主回传 { 原载波id: 副本id }——偏置跟着搬过去，
  // 否则下一轮打开时这些值会因为载波换了 id 而悄悄归零，解出来的余量跟着变
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
const cstate = reactive({})   // { [carrierId]: { bias } }

function loadSaved() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY.value) || 'null')
    if (!s) return
    if (s.mode) mode.value = s.mode
    if (s.base) base.value = s.base
    if (s.overDb != null) overDb.value = String(s.overDb)
    if (Array.isArray(s.rowIds)) pickedIds.value = new Set(s.rowIds)
    // 旧记忆里可能还带着已删掉的 locked 位，只取 bias（多余的键读不进来自然就没了）
    if (s.carriers) for (const [k, v] of Object.entries(s.carriers)) cstate[k] = { bias: v.bias == null ? 0 : v.bias }
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
// 逐载波偏置，键就是载波条目 id。读是纯的（没这一项就返回默认值，不在渲染里写响应式状态，
// 否则读一次多触发一轮渲染），写只在用户改值时发生。
const cs = (id) => cstate[id] || { bias: 0 }
const setCs = (id, patch) => { cstate[id] = { ...cs(id), ...patch } }
watch(() => props.carrierRemap, (m) => {
  if (!m) return
  for (const [from, to] of Object.entries(m)) if (cstate[from] && !cstate[to]) { cstate[to] = cstate[from]; delete cstate[from] }
})
const res = computed(() => solveAdv({
  mode: mode.value, picked: picked.value, state: cstate, base: base.value, overDb: overDb.value, tpBwMHz: props.tpBwMhz
}))
// CNC 只有一份载波（校验已强制），偏置/基准都无意义 → 只在 VSAT 下露出那一栏
const showCarrierTab = computed(() => mode.value === 'vsat')
const canApply = computed(() => !props.busy && res.value.ok && res.value.carriers.length > 0)
const baseDesc = computed(() => (ADV_BASES.find((b) => b.key === base.value) || {}).desc || '')
// 解后余量按行索引：链路表里逐条摊出「此刻 → 解后」，CNC 下更是唯一能看到解出余量的地方（那边没有载波表）
const solvedMargin = computed(() => {
  const m = new Map()
  if (res.value.ok) for (const l of res.value.links) m.set(l.rowId, l.marginAfter)
  return m
})

// —— 带宽读数的显示单位：全自动挑档（Hz/kHz/MHz/GHz，档位表同结果列，无手动开关）——
// 分三处各挑各的，因为它们只在各自内部横向比较：
// ① 链路表的载波带宽 / 功率带宽两列共用一档——同一行这两个数要直接比大小（功率带宽 > 载波带宽
//    ＝超发），一个 MHz 一个 kHz 就没法看。档位按两列里【最小】的那个值挑，不按最大：一组载波里
//    大小差两三个数量级是常态（8 MHz 前向 + 75 kHz 返向），按最大挑会把小的压成 0.0749；
// ② 总账那四个数（组占用带宽 / 目标 / Σ功率带宽前后）本就同量级、也要互相比，按常规的最大值口径；
// ③ 残差是独立读数，单值自适应——它可能比总账小好几个数量级，跟着总账走就只剩一个 0。
const pickBw = (vals, byMin) => {
  const pos = vals.filter((v) => isFinite(v) && v > 0).map(Math.abs)
  if (!pos.length) return { unit: 'kHz', conv: (v) => v }
  return pickColumn([byMin ? Math.min(...pos) : Math.max(...pos)], 'kHz') || { unit: 'kHz', conv: (v) => v }
}
const linkUnit = computed(() => pickBw(props.rows.flatMap((r) => [r.bwKHz, r.pbwKHz]), true))
const totalUnit = computed(() => {
  const r = res.value
  return pickBw(r.ok ? [r.occBwKHz, r.sumBwKHz, r.targetKHz, r.beforePbwKHz, r.afterPbwKHz] : [], false)
})
const fmtIn = (u, kHz) => (isFinite(kHz) ? fmtScaled(u.conv(kHz)) : '—')
const bw = (kHz) => fmtIn(linkUnit.value, kHz)          // 链路表两列
const bwU = computed(() => linkUnit.value.unit)
const tot = (kHz) => fmtIn(totalUnit.value, kHz)        // 总账
const totU = computed(() => totalUnit.value.unit)
const qty = (kHz) => fmtQty(kHz, 'kHz')                 // 残差（数值 + 单位一体）
const d2 = (v) => (isFinite(v) ? v.toFixed(2) : '—')
const sign = (v) => (isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) : '—')
// 载波表「基准余量」：取「当前余量」口径而基准与此刻的余量又不一致时——即这份载波已被本功能改过、
// 基准仍钉在它进来之前那份原始余量上——注明现值，免得读的人以为数错了（「各自平衡点」口径下两者
// 本就该不同，那是口径使然，不必注）
const drifted = (c) => base.value === 'current' && isFinite(c.baseDb) && isFinite(c.fromDb) && Math.abs(c.baseDb - c.fromDb) > 0.005

function apply() {
  if (!canApply.value) return
  emit('apply', {
    mode: mode.value, base: base.value, overDb: parseFloat(overDb.value) || 0,
    rowIds: picked.value.map((p) => p.rowId),
    carriers: res.value.carriers.map((c) => ({ id: c.id, name: c.name, toDb: c.toDb, fromDb: c.fromDb }))
  })
}
</script>

<template>
  <div v-if="open" class="ab-mask">
    <div class="ab" role="dialog" aria-modal="true">
      <div class="ab-hd">
        <!-- 图标与工具栏「计算 / 高级计算」两个按钮同一枚实心三角：同一件事的两档，不该长成两个族 -->
        <svg viewBox="0 0 16 16" class="ab-ic" aria-hidden="true"><path d="M4 2.5 13 8 4 13.5z" /></svg>高级计算 · 多载波组功带平衡
        <span class="ab-sp"></span>
        <button class="ab-x" :disabled="busy" title="关闭" aria-label="关闭" @click="emit('close')"><Icon name="x" :size="13" /></button>
      </div>

      <div class="ab-bd">
        <!-- 模式：两种组平衡口径 -->
        <div class="ab-modes">
          <button v-for="m in ADV_MODES" :key="m.key" class="ab-mode" :class="{ on: mode === m.key }" :title="m.desc" @click="mode = m.key">{{ m.label }}</button>
        </div>
        <div v-if="stale" class="ab-warn">链路表输入已在上次计算之后变更，下列参考数据取自该次计算结果。</div>

        <!-- ① 参与链路 -->
        <div class="ab-sec">参与链路</div>
        <div class="ab-tw">
          <table class="ab-t">
            <thead>
              <tr>
                <th class="ck"><input type="checkbox" :checked="allPicked" title="全选 / 全不选" @change="toggleAll" /></th>
                <th class="no">#</th>
                <th title="发信站 → 收信站">链路</th>
                <th title="该链路引用的载波配置：系统余量即存于此，是本次配平的未知数">载波配置</th>
                <th class="n" title="载波占用的频谱带宽，由信息速率、调制方式与滚降系数决定，与系统余量无关">载波带宽<i>{{ bwU }}</i></th>
                <th class="n" title="功率占用 × 转发器带宽，即该载波所占转发器功率折合的等效带宽。与载波带宽比较即单条链路的功带平衡状况：大于为超发（受功率限），小于为欠发（受带宽限）">功率带宽<i>{{ bwU }}</i></th>
                <th class="n" title="当前系统余量 → 配平余量。系统余量存于载波配置，引用同一份载波的各条链路共用一个取值">系统余量<i>dB</i></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in rows" :key="r.rowId" :class="{ on: isPicked(r), off: !usable(r) }" @click="togglePick(r)">
                <td class="ck"><input type="checkbox" :checked="isPicked(r)" :disabled="!usable(r)" @click.stop="togglePick(r)" /></td>
                <td class="no">{{ r.no }}</td>
                <td class="nm" :title="r.name" data-i18n-skip>{{ r.name }}</td>
                <td class="nm" :title="r.carrierName">{{ r.carrierName }}</td>
                <td class="n">{{ usable(r) ? bw(r.bwKHz) : '—' }}</td>
                <td class="n" :class="{ over: r.pbwKHz > r.bwKHz, under: r.pbwKHz < r.bwKHz }">{{ usable(r) ? bw(r.pbwKHz) : '—' }}</td>
                <td v-if="usable(r)" class="n">{{ d2(r.marginDb) }}<i v-if="solvedMargin.has(r.rowId)" class="ab-to" :class="{ bad: solvedMargin.get(r.rowId) < 0 }">→{{ d2(solvedMargin.get(r.rowId)) }}</i></td>
                <td v-else class="n">{{ r.error || '未计算' }}</td>
              </tr>
              <tr v-if="!rows.length"><td colspan="7" class="ab-empty">链路表暂无计算结果。</td></tr>
            </tbody>
          </table>
        </div>

        <!-- ② 载波（未知数）：余量存在载波配置上，同一份载波被几条链路共用就共用一个余量 -->
        <template v-if="showCarrierTab">
          <div class="ab-sec">载波余量</div>
          <div class="ab-tw">
            <table class="ab-t">
              <thead>
                <tr>
                  <th title="一份载波配置 = 一个未知数：它的系统余量被引用它的各条链路共用">载波配置</th>
                  <th class="n" title="引用该载波配置的链路条数">链路数</th>
                  <th class="n" :title="'配平的起点，口径见下方「基准」：' + baseDesc">基准余量<i>dB</i></th>
                  <th class="n" title="使该载波自身功率带宽等于其载波带宽的系统余量，即单载波口径的「功带平衡」">单载波平衡点<i>dB</i></th>
                  <th class="n" title="相对基准的固定偏移量，如前向载波按设计超发 +2 dB；整组仍保持平衡，多占用的功率由统一平移量 Δ 从其余载波让出">余量偏置<i>dB</i></th>
                  <th class="n" title="配平解出的系统余量，应用后写入该载波配置；右侧小字为相对当前余量的变化量">配平余量<i>dB</i></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in res.carriers" :key="c.id">
                  <td class="nm" :title="c.name" data-i18n-skip>{{ c.name }}</td>
                  <td class="n">{{ c.n }}</td>
                  <td class="n" :title="drifted(c) ? '该载波的系统余量已由本功能配平写入（当前 ' + d2(c.fromDb) + ' dB）；基准仍取其配平前的原始余量，故重复应用不会累加偏置' : ''">
                    <!-- 「现」单独成节点：与数字挤在一个文本节点里，英文模式下整串查不到表 -->
                    {{ d2(c.baseDb) }}<i v-if="drifted(c)" class="ab-sh"><span>现</span> {{ d2(c.fromDb) }}</i></td>
                  <td class="n dim">{{ d2(c.balanceDb) }}</td>
                  <td class="n"><NumBox class="ab-in" :step="0.1" :model-value="cs(c.id).bias" @commit="(v) => setCs(c.id, { bias: v || 0 })" /></td>
                  <td class="n st" :class="{ bad: c.toDb < 0 }">{{ d2(c.toDb) }}<i class="ab-sh">{{ sign(c.shiftDb) }}</i></td>
                </tr>
                <tr v-if="!res.carriers.length"><td colspan="6" class="ab-empty">未选择链路。</td></tr>
              </tbody>
            </table>
          </div>
        </template>

        <!-- ③ 配平口径 + 结果读数 -->
        <div class="ab-sec">配平口径与结果</div>
        <div class="ab-ctl">
          <label v-if="showCarrierTab" :title="baseDesc">
            <span>基准</span>
            <select v-model="base"><option v-for="b in ADV_BASES" :key="b.key" :value="b.key">{{ b.label }}</option></select>
          </label>
          <label title="目标总功率带宽相对组占用带宽抬高的 dB 数；0 为严格平衡（Σ功率带宽 = 组占用带宽）">
            <span>组超发量</span>
            <input v-model="overDb" class="ab-in w" type="number" step="0.1" /><i>dB</i>
          </label>
        </div>

        <div v-if="!res.ok" class="ab-err">{{ res.message }}</div>
        <div v-else class="ab-out">
          <div class="ab-kv" title="本组载波在转发器上占用的频谱带宽：VSAT 各占各的频段故求和，CNC 同频叠加故只计一份">
            <span>组占用带宽</span><b>{{ tot(res.occBwKHz) }}</b><i>{{ totU }}</i>
            <em v-if="mode === 'cnc'">Σ载波带宽 {{ tot(res.sumBwKHz) }} {{ totU }}</em></div>
          <div class="ab-kv" title="配平目标 = 组占用带宽 × 10^(组超发量/10)"><span>目标总功率带宽</span><b>{{ tot(res.targetKHz) }}</b><i>{{ totU }}</i></div>
          <div class="ab-kv" title="Σ 各链路功率带宽：配平前 → 配平后；残差为配平后与目标之差"><span>Σ功率带宽</span>
            <b>{{ tot(res.beforePbwKHz) }} → {{ tot(res.afterPbwKHz) }}</b><i>{{ totU }}</i>
            <em>残差 {{ qty(res.residualKHz) }}</em></div>
          <div class="ab-kv" title="各载波在各自基准余量上同抬同降的量，由配平方程解出"><span>统一平移量 Δ</span><b class="st">{{ sign(res.deltaDb) }}</b><i>dB</i></div>
          <div v-if="isFinite(res.bwUsePct)" class="ab-kv" title="配平后本组载波对转发器资源的占用：带宽按组占用带宽计，功率按 Σ功率带宽计"><span>转发器资源占用</span>
            <b :class="{ bad: res.pwUsePct > 100 || res.bwUsePct > 100 }">带宽 {{ d2(res.bwUsePct) }}% · 功率 {{ d2(res.pwUsePct) }}%</b></div>
        </div>
        <div v-for="(w, i) in (res.warnings || [])" :key="i" class="ab-warn">{{ w }}</div>
      </div>

      <div class="ab-ft">
        <button class="ab-btn" :disabled="busy" @click="emit('close')">关闭</button>
        <button class="ab-btn primary" :disabled="!canApply"
          title="将配平余量写入各载波配置（VSAT 派生专用副本，原配置不改动），随后重新计算全表"
          @click="apply">{{ busy ? '计算中…' : '应用并重新计算' }}</button>
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
  background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-card, 3px);
  box-shadow: 0 8px 24px rgba(0,0,0,.18); overflow: hidden;
}
.ab-hd {
  display: flex; align-items: center; gap: 6px; padding: 10px 12px;
  font-size: 11px; font-weight: 600; letter-spacing: var(--ls-label); color: var(--text-muted);
  background: var(--surface-2); border-bottom: 1px solid var(--border);
}
.ab-ic { flex: none; width: 13px; height: 13px; fill: currentColor; stroke: none; vertical-align: -0.125em; }
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

.ab-sec {
  display: flex; align-items: baseline; gap: 8px; margin: 12px 0 5px; padding-bottom: 3px;
  font-size: 11px; font-weight: 700; color: var(--text); border-bottom: 1px solid var(--lb-rule, var(--border));
}

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
.ab-t .ck { width: 26px; text-align: center; }
.ab-t .ck input { margin: 0; }
.ab-t .no { width: 26px; color: var(--text-faint); }
.ab-t .n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.ab-t .nm { max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ab-t .dim { color: var(--text-faint); }
.ab-t .st { font-weight: 700; }
.ab-t .over { color: var(--warn, #b06a2c); }
.ab-t .under { color: var(--text-muted); }
.ab-t .bad { color: var(--danger, #b3403a); }
.ab-sh { font-style: normal; margin-left: 5px; font-weight: 400; font-size: 10px; color: var(--text-faint); }
/* 「此刻 → 解后」：解后那半是本对话框的结论，比现值重一档 */
.ab-to { font-style: normal; margin-left: 3px; font-weight: 600; color: var(--text); }
.ab-to.bad { color: var(--danger, #b3403a); }
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
.ab-ctl select { font: inherit; font-size: 11px; padding: 2px 4px; background-color: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }

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
