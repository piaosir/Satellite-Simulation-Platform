<script setup>
// 转发器频率计划工作台（独立窗口）。
//
// 归属：频率计划挂在【卫星】下、与 GRD 天线平级，因此左栏按卫星分组——与覆盖分析那棵卫星树同源
// （shared/freqPlanSats 直读 localStorage，同 origin 无需 IPC）。
//
// 版式沿用平台既定范式：左列表（主从）· 中主体（图 + 页签）· 右检查器，同屏一个上下文。
// 存盘策略是「改即存」（debounce 600ms）——频率计划是「文件」不是「会话」，所以不设关窗守卫。
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import {
  newPlan, normalizePlan, newChannel, newLo, newBeam, genSeries, validatePlan, errorCount,
  resolveChannel, resolveAll, planSummary, POLS, POL_LABEL, CHANNEL_KINDS, KIND_LABEL,
  DEFAULT_BEAM_COLORS, POL_ORTHO, guessBand
} from '../shared/freqPlanModel.js'
import { loadSatNodes, satLabel } from '../shared/freqPlanSats.js'
import { toPngDataUrl, toPdfDataUrl, toSvgText } from './fpExport.js'
import { setLbFontSize, getLbFontSize } from '../shared/lbFont.js'
import FpChart from './FpChart.vue'
import FpCapacity from './FpCapacity.vue'
import Icon from '../components/Icon.vue'

const api = typeof window !== 'undefined' ? window.api : null

// ---- 状态 ----
const index = ref([])              // 计划索引（左栏）
const plan = ref(null)             // 当前打开的计划全文
const currentId = ref('')
const selectedId = ref('')         // 选中通道
const tab = ref('table')           // table | capacity | check
const carriers = ref([])           // 容量规划的载波（随计划走，存在计划里）
const msg = ref('')
const busy = ref('')
const confirmMsg = ref('')
let _confirmResolve = null
const chartWrap = ref(null)
const chartW = ref(1240)

// 图的显示选项
const opt = ref({ unit: 'MHz', fontSize: 12, showFreqLabels: true, showLegend: true, showLo: true, showGuides: true })

function flash(t) { msg.value = t; setTimeout(() => { if (msg.value === t) msg.value = '' }, 3600) }
function ask(m) { confirmMsg.value = m; return new Promise((r) => { _confirmResolve = r }) }
function answer(ok) { confirmMsg.value = ''; const r = _confirmResolve; _confirmResolve = null; if (r) r(ok) }

// ---- 卫星分组的左栏 ----
const satNodes = ref([])
const groups = computed(() => {
  const bySat = new Map()
  for (const e of index.value) {
    const k = e.satFolder || ''
    if (!bySat.has(k)) bySat.set(k, [])
    bySat.get(k).push(e)
  }
  const out = []
  for (const s of satNodes.value) {
    const items = bySat.get(s.folder) || []
    if (items.length) { out.push({ key: s.folder, label: satLabel(s), items }); bySat.delete(s.folder) }
  }
  // 宿主卫星已不在树里的（卫星被删/改过 folder）单列，不让它们从界面上消失
  for (const [k, items] of bySat) {
    out.push({ key: k, label: k ? `（卫星已不在树中：${items[0].satName || k}）` : '（未归属卫星）', items, orphan: true })
  }
  return out
})
// 还没有计划的卫星也列出来——「这颗星还没建频率计划」本身就是要看到的信息
const emptySats = computed(() => {
  const has = new Set(index.value.map((e) => e.satFolder))
  return satNodes.value.filter((s) => !has.has(s.folder))
})

// ---- 载入 / 存盘 ----
async function loadIndex() {
  if (!api?.freqPlan) return
  try { index.value = await api.freqPlan.list() || [] } catch { index.value = [] }
}
async function openPlan(id) {
  if (!api?.freqPlan || !id) return
  const p = await api.freqPlan.get(id)
  if (!p) { flash('计划不存在'); await loadIndex(); return }
  plan.value = normalizePlan(p)
  carriers.value = Array.isArray(p.carriers) ? p.carriers : []
  currentId.value = id
  selectedId.value = plan.value.channels[0]?.id || ''
  dirty = false
}

let saveTimer = null
let dirty = false
function scheduleSave() {
  dirty = true
  clearTimeout(saveTimer)
  saveTimer = setTimeout(doSave, 600)
}
async function doSave() {
  if (!api?.freqPlan || !plan.value || !currentId.value) return
  clearTimeout(saveTimer)
  try {
    // 载波跟着计划走（容量规划是这份计划的一部分，分开存会出现「计划改了载波还挂在旧转发器上」）
    const r = await api.freqPlan.save({ ...JSON.parse(JSON.stringify(plan.value)), id: currentId.value, carriers: JSON.parse(JSON.stringify(carriers.value)) })
    if (r?.ok) { dirty = false; await loadIndex() }
  } catch (e) { flash('保存失败：' + e.message) }
}
// 深监听：图/表/检查器三处都直接改 plan，逐处调 scheduleSave 迟早漏
watch(plan, () => { if (plan.value) scheduleSave() }, { deep: true })
watch(carriers, () => { if (plan.value) scheduleSave() }, { deep: true })

// ---- 新建 / 删除 / 改名 ----
const newSatFolder = ref('')
async function createPlan(fromPlan = null, satFolder = '') {
  if (!api?.freqPlan) return
  const folder = satFolder || newSatFolder.value || satNodes.value[0]?.folder || ''
  const node = satNodes.value.find((s) => s.folder === folder)
  const p = fromPlan ? normalizePlan(fromPlan) : newPlan()
  p.id = ''
  p.satFolder = folder
  p.satName = node?.satName || ''
  if (!fromPlan) p.name = node ? `${node.satName} 频率计划` : '频率计划'
  const r = await api.freqPlan.save(JSON.parse(JSON.stringify(p)))
  if (r?.ok) {
    await loadIndex()
    await openPlan(r.id)
    flash('已新建')
  }
  return r?.id
}
async function removePlan(e) {
  if (!(await ask(`删除频率计划「${e.name}」？此操作不可撤销。`))) return
  await api.freqPlan.remove(e.id)
  if (currentId.value === e.id) { plan.value = null; currentId.value = ''; carriers.value = [] }
  await loadIndex()
  flash('已删除')
}
async function duplicatePlan(e) {
  const src = await api.freqPlan.get(e.id)
  if (!src) return
  const copy = { ...src, id: '', name: src.name + ' 副本' }
  const r = await api.freqPlan.save(copy)
  if (r?.ok) { await loadIndex(); await openPlan(r.id); flash('已复制') }
}

// ---- 通道编辑 ----
const selected = computed(() => plan.value?.channels.find((c) => c.id === selectedId.value) || null)
const selectedResolved = computed(() => (plan.value && selected.value ? resolveChannel(plan.value, selected.value) : null))
const rowsResolved = computed(() => (plan.value ? resolveAll(plan.value) : []))
const issues = computed(() => (plan.value ? validatePlan(plan.value) : []))
const errCount = computed(() => errorCount(issues.value))

function addChannel() {
  if (!plan.value) return
  const last = plan.value.channels[plan.value.channels.length - 1]
  const ch = newChannel({
    no: '',
    up: { fcMHz: last?.up.fcMHz != null ? last.up.fcMHz + (last.up.bwMHz || 36) : null, bwMHz: last?.up.bwMHz ?? 36, pol: last?.up.pol || 'H' },
    dn: { pol: POL_ORTHO[last?.up.pol || 'H'] || 'V' },
    loId: last?.loId || plan.value.los[0]?.id || '',
    beamUpId: last?.beamUpId || ''
  })
  plan.value.channels.push(ch)
  selectedId.value = ch.id
}
function removeChannel(id) {
  if (!plan.value) return
  plan.value.channels = plan.value.channels.filter((c) => c.id !== id)
  if (selectedId.value === id) selectedId.value = plan.value.channels[0]?.id || ''
}
function duplicateChannel(id) {
  const c = plan.value?.channels.find((x) => x.id === id)
  if (!c) return
  const copy = newChannel({ ...JSON.parse(JSON.stringify(c)), id: undefined, no: c.no + "'" })
  const i = plan.value.channels.indexOf(c)
  plan.value.channels.splice(i + 1, 0, copy)
  selectedId.value = copy.id
}
function setNum(obj, key, v) {
  const n = v === '' || v == null ? null : Number(v)
  obj[key] = Number.isFinite(n) ? n : null
}
function sortChannels() {
  if (!plan.value) return
  plan.value.channels.sort((a, b) => (a.up.fcMHz ?? a.dn.fcMHz ?? 0) - (b.up.fcMHz ?? b.dn.fcMHz ?? 0))
  flash('已按上行频率排序')
}

// ---- 批量生成 ----
const gen = ref({ count: 6, startFcMHz: 14022, stepMHz: 41.5, bwMHz: 36, pol: 'H', polMode: 'fixed', noPattern: 'C{n}', noStart: 1, loId: '', beamUpId: '', kind: 'transponder' })
function runGen() {
  if (!plan.value) return
  const chs = genSeries({ ...gen.value, count: Number(gen.value.count) || 0, startFcMHz: Number(gen.value.startFcMHz), stepMHz: Number(gen.value.stepMHz), bwMHz: Number(gen.value.bwMHz), noStart: Number(gen.value.noStart) || 1 })
  if (!chs.length) { flash('数量为 0'); return }
  plan.value.channels.push(...chs)
  selectedId.value = chs[0].id
  if (!plan.value.band || plan.value.band === 'Ku') plan.value.band = guessBand(Number(gen.value.startFcMHz))
  flash(`已生成 ${chs.length} 个转发器`)
}

// ---- LO / 波束 ----
function addLo() { plan.value?.los.push(newLo({ name: `LO${(plan.value.los.length || 0) + 1}`, valueMHz: null })) }
function removeLo(id) {
  if (!plan.value) return
  plan.value.los = plan.value.los.filter((l) => l.id !== id)
  for (const c of plan.value.channels) if (c.loId === id) c.loId = ''
}
function addBeam() {
  const i = plan.value?.beams.length || 0
  plan.value?.beams.push(newBeam({ name: `波束 ${i + 1}`, code: String.fromCharCode(65 + i), color: DEFAULT_BEAM_COLORS[i % DEFAULT_BEAM_COLORS.length] }))
}
function removeBeam(id) {
  if (!plan.value) return
  plan.value.beams = plan.value.beams.filter((b) => b.id !== id)
  for (const c of plan.value.channels) {
    if (c.beamUpId === id) c.beamUpId = ''
    if (c.beamDnId === id) c.beamDnId = ''
    c.switchableBeamIds = (c.switchableBeamIds || []).filter((x) => x !== id)
  }
}

// ---- 导入 ----
async function importJson() {
  if (!api?.freqPlan?.importJson) return
  const r = await api.freqPlan.importJson()
  if (!r || r.canceled) return
  await loadIndex()
  flash(`导入 ${r.added} 份${r.replaced ? `，覆盖 ${r.replaced} 份` : ''}${r.errors?.length ? `，${r.errors.length} 份失败` : ''}`)
}

// ---- 导出 ----
async function doExport(kind) {
  if (!plan.value || !api?.freqPlan?.exportFile) return
  busy.value = '导出中…'
  try {
    const style = { ...opt.value, width: chartW.value }
    let payload = ''
    if (kind === 'json') payload = JSON.stringify({ ...plan.value, carriers: carriers.value }, null, 2)
    else if (kind === 'svg') payload = toSvgText(plan.value, style)
    else if (kind === 'pdf') payload = await toPdfDataUrl(plan.value, style)
    else payload = await toPngDataUrl(plan.value, style, kind === 'png2' ? 2 : kind === 'png6' ? 6 : 4)
    const ext = kind === 'json' ? 'json' : kind === 'svg' ? 'svg' : kind === 'pdf' ? 'pdf' : 'png'
    const r = await api.freqPlan.exportFile(ext, payload, plan.value.name || '频率计划')
    if (r?.canceled) return
    flash(r?.ok ? '已导出：' + r.filePath : '导出失败：' + (r?.error || '未知错误'))
  } catch (e) { flash('导出失败：' + e.message) } finally { busy.value = '' }
}

// ---- 字号 ----
const fontSize = ref(getLbFontSize())
watch(fontSize, (v) => setLbFontSize(v))

// ---- 尺寸自适应 ----
function measure() {
  const el = chartWrap.value
  if (el) chartW.value = Math.max(760, el.clientWidth - 24)
}

onMounted(async () => {
  satNodes.value = loadSatNodes()
  newSatFolder.value = satNodes.value[0]?.folder || ''
  await loadIndex()
  if (index.value.length) await openPlan(index.value[0].id)
  measure()
  window.addEventListener('resize', measure)
  // 从文件区双击某份计划进来
  api?.freqPlan?.onOpenPlan?.((id) => { if (id) openPlan(id) })
  // 窗口失焦/关闭前把待存的落盘（debounce 尾巴不能丢）
  window.addEventListener('beforeunload', () => { if (dirty) doSave() })
})
watch(tab, () => nextTick(measure))
</script>

<template>
  <div class="fp">
    <!-- 工具栏 -->
    <header class="tb">
      <span class="brand">转发器频率计划</span>
      <span class="sep"></span>
      <button class="mini imp" :disabled="!satNodes.length" @click="createPlan()"><Icon name="plus" :size="12" /> 新建</button>
      <button class="mini ghost" @click="importJson"><Icon name="import" :size="12" /> 导入 JSON</button>
      <span class="sep"></span>
      <div class="dd">
        <button class="mini ghost" :disabled="!plan">导出 ▾</button>
        <div class="ddm">
          <button @click="doExport('png2')">PNG 2×</button>
          <button @click="doExport('png4')">PNG 4×</button>
          <button @click="doExport('png6')">PNG 6×</button>
          <button @click="doExport('pdf')">PDF（矢量）</button>
          <button @click="doExport('svg')">SVG</button>
          <button @click="doExport('json')">JSON 数据</button>
        </div>
      </div>
      <span class="spacer"></span>
      <label class="ck"><input type="checkbox" v-model="opt.showFreqLabels" /> 频率标注</label>
      <label class="ck"><input type="checkbox" v-model="opt.showLegend" /> 图例</label>
      <label class="ck"><input type="checkbox" v-model="opt.showLo" /> LO</label>
      <select class="ci nar" v-model="opt.unit" title="只影响标注文字，不改任何数值口径">
        <option value="MHz">MHz</option><option value="GHz">GHz</option>
      </select>
      <label class="fld">图字号 <input class="ci num xnar" type="number" v-model.number="opt.fontSize" min="8" max="22" /></label>
      <label class="fld">界面 <input class="ci num xnar" type="number" v-model.number="fontSize" min="9" max="16" /></label>
      <span v-if="busy" class="busy">{{ busy }}</span>
    </header>
    <div v-if="msg" class="msg">{{ msg }}</div>

    <div class="body">
      <!-- 左：按卫星分组的计划列表 -->
      <aside class="left">
        <div class="lh">
          <span>计划库</span>
          <span class="spacer"></span>
          <span class="dim">{{ index.length }}</span>
        </div>
        <div class="lscroll">
          <div v-if="!satNodes.length" class="lnone">
            卫星树为空 — 频率计划挂在卫星下（与 GRD 天线平级）。请先到主窗口「星座地图 3D · 覆盖分析」或「文件管理 · GRD 天线」添加卫星。
          </div>
          <template v-else>
            <div v-for="g in groups" :key="g.key" class="grp">
              <div class="gh" :class="{ orphan: g.orphan }">{{ g.label }}</div>
              <div v-for="e in g.items" :key="e.id" class="li" :class="{ on: e.id === currentId }" @click="openPlan(e.id)">
                <div class="ln">{{ e.name }}</div>
                <div class="lm">{{ e.band }} · {{ e.transponderCount }} 转发器<template v-if="e.beamCount"> · {{ e.beamCount }} 波束</template></div>
                <div class="lops" @click.stop>
                  <button class="lop" title="复制" @click="duplicatePlan(e)"><Icon name="copy" :size="11" /></button>
                  <button class="lop del" title="删除" @click="removePlan(e)"><Icon name="trash" :size="11" /></button>
                </div>
              </div>
            </div>
            <div v-if="emptySats.length" class="grp">
              <div class="gh dim">尚无频率计划的卫星</div>
              <div v-for="s in emptySats" :key="s.folder" class="li add" @click="createPlan(null, s.folder)">
                <div class="ln">{{ satLabel(s) }}</div>
                <div class="lm">点击为其新建频率计划</div>
              </div>
            </div>
          </template>
        </div>
      </aside>

      <!-- 中：图 + 页签 -->
      <main class="center">
        <div v-if="!plan" class="mnone">
          <p>未打开频率计划。</p>
          <p class="dim">左栏选一份，或新建一份后用右侧「批量生成」按「首频 + 步进 + 数量」铺一排转发器。</p>
        </div>
        <template v-else>
          <div class="chartbox" ref="chartWrap">
            <FpChart :plan="plan" :selected-id="selectedId" :chart-style="opt" :width="chartW"
              @select="selectedId = $event" />
          </div>

          <div class="tabs">
            <button class="tb-b" :class="{ on: tab === 'table' }" @click="tab = 'table'">转发器表 <i>{{ plan.channels.length }}</i></button>
            <button class="tb-b" :class="{ on: tab === 'capacity' }" @click="tab = 'capacity'">容量规划 <i v-if="carriers.length">{{ carriers.length }}</i></button>
            <button class="tb-b" :class="{ on: tab === 'check' }" @click="tab = 'check'">校验 <i v-if="issues.length" :class="{ bad: errCount }">{{ issues.length }}</i></button>
            <span class="spacer"></span>
            <template v-if="tab === 'table'">
              <button class="mini" @click="addChannel"><Icon name="plus" :size="12" /> 转发器</button>
              <button class="mini ghost" @click="sortChannels" title="按上行频率升序重排">排序</button>
            </template>
          </div>

          <div class="tabbody">
            <!-- 转发器表 -->
            <div v-if="tab === 'table'" class="tscroll">
              <table class="t">
                <thead>
                  <tr>
                    <th>编号</th><th>类型</th><th>上行 MHz</th><th>带宽</th><th>极化</th>
                    <th>LO</th><th>下行 MHz</th><th>极化</th><th>波束</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(ch, i) in plan.channels" :key="ch.id" :class="{ on: ch.id === selectedId }" @click="selectedId = ch.id">
                    <td><input class="ci nar" v-model="ch.no" @click.stop /></td>
                    <td>
                      <select class="ci nar" v-model="ch.kind" @click.stop>
                        <option v-for="k in CHANNEL_KINDS" :key="k.key" :value="k.key">{{ k.label }}</option>
                      </select>
                    </td>
                    <td><input class="ci num" :value="ch.up.fcMHz ?? ''" @input="setNum(ch.up, 'fcMHz', $event.target.value)" @click.stop /></td>
                    <td><input class="ci num nar" :value="ch.up.bwMHz ?? ''" @input="setNum(ch.up, 'bwMHz', $event.target.value)" @click.stop /></td>
                    <td><select class="ci xnar" v-model="ch.up.pol" @click.stop><option v-for="p in POLS" :key="p" :value="p">{{ p }}</option></select></td>
                    <td>
                      <select class="ci nar" v-model="ch.loId" @click.stop>
                        <option value="">—</option>
                        <option v-for="l in plan.los" :key="l.id" :value="l.id">{{ l.name }}</option>
                      </select>
                    </td>
                    <td class="dnum">
                      <input class="ci num" :value="ch.dn.fcMHz ?? ''" :placeholder="rowsResolved[i]?.dn ? String(Math.round(rowsResolved[i].dn.fc * 100) / 100) : ''"
                        @input="setNum(ch.dn, 'fcMHz', $event.target.value)" @click.stop
                        :title="rowsResolved[i]?.dnDerived ? '留空 = 由 LO 推算（灰字为推算值）；填值 = 显式指定，用于 cross-strap / 下行重排' : '显式指定的下行频率'" />
                    </td>
                    <td><select class="ci xnar" v-model="ch.dn.pol" @click.stop><option v-for="p in POLS" :key="p" :value="p">{{ p }}</option></select></td>
                    <td>
                      <select class="ci nar" v-model="ch.beamUpId" @click.stop>
                        <option value="">—</option>
                        <option v-for="b in plan.beams" :key="b.id" :value="b.id">{{ b.name }}</option>
                      </select>
                    </td>
                    <td class="ops" @click.stop>
                      <button class="lop" title="复制" @click="duplicateChannel(ch.id)"><Icon name="copy" :size="11" /></button>
                      <button class="lop del" title="删除" @click="removeChannel(ch.id)"><Icon name="x" :size="11" /></button>
                    </td>
                  </tr>
                </tbody>
              </table>
              <div v-if="!plan.channels.length" class="none">
                还没有转发器。用右侧「批量生成」按「首频 + 步进 + 数量」一次铺一排，或点上方「转发器」逐个加。
              </div>
            </div>

            <!-- 容量规划 -->
            <FpCapacity v-else-if="tab === 'capacity'" :plan="plan" :carriers="carriers"
              @update:carriers="carriers = $event" @select-channel="selectedId = $event" />

            <!-- 校验 -->
            <div v-else class="tscroll chk">
              <div v-if="!issues.length" class="none">无待处理项。</div>
              <div v-for="(is, i) in issues" :key="i" class="ci-item" :class="is.severity"
                @click="is.refs?.length && (selectedId = is.refs[0])">
                <span class="sev">{{ is.severity === 'error' ? '错' : is.severity === 'warn' ? '注' : '提' }}</span>
                <span class="cm">{{ is.msg }}</span>
              </div>
            </div>
          </div>
        </template>
      </main>

      <!-- 右：检查器 -->
      <aside class="right" v-if="plan">
        <div class="sec">
          <div class="sh">计划</div>
          <label class="row"><span>名称</span><input class="ci" v-model="plan.name" /></label>
          <label class="row"><span>卫星</span>
            <select class="ci" v-model="plan.satFolder" @change="plan.satName = (satNodes.find((s) => s.folder === plan.satFolder) || {}).satName || ''">
              <option value="">（未归属）</option>
              <option v-for="s in satNodes" :key="s.folder" :value="s.folder">{{ satLabel(s) }}</option>
            </select>
          </label>
          <label class="row"><span>频段</span><input class="ci nar" v-model="plan.band" /></label>
          <div class="sum">{{ planSummary(plan) }}</div>
        </div>

        <div class="sec" v-if="selected">
          <div class="sh">转发器 {{ selected.no || '—' }}</div>
          <label class="row"><span>编号</span><input class="ci nar" v-model="selected.no" /></label>
          <label class="row"><span>类型</span>
            <select class="ci" v-model="selected.kind"><option v-for="k in CHANNEL_KINDS" :key="k.key" :value="k.key">{{ k.label }}</option></select>
          </label>
          <label class="row"><span>上行 MHz</span><input class="ci num" :value="selected.up.fcMHz ?? ''" @input="setNum(selected.up, 'fcMHz', $event.target.value)" /></label>
          <label class="row"><span>带宽 MHz</span><input class="ci num" :value="selected.up.bwMHz ?? ''" @input="setNum(selected.up, 'bwMHz', $event.target.value)" /></label>
          <label class="row"><span>上行极化</span>
            <select class="ci" v-model="selected.up.pol"><option v-for="p in POLS" :key="p" :value="p">{{ POL_LABEL[p] }}</option></select>
          </label>
          <label class="row"><span>LO</span>
            <select class="ci" v-model="selected.loId">
              <option value="">—</option>
              <option v-for="l in plan.los" :key="l.id" :value="l.id">{{ l.name }} · {{ l.valueMHz ?? '—' }} MHz</option>
            </select>
          </label>
          <label class="row"><span>下行 MHz</span>
            <input class="ci num" :value="selected.dn.fcMHz ?? ''"
              :placeholder="selectedResolved?.dn ? String(Math.round(selectedResolved.dn.fc * 100) / 100) + '（推算）' : '由 LO 推算'"
              @input="setNum(selected.dn, 'fcMHz', $event.target.value)" />
          </label>
          <p class="tip">下行留空 = 由 LO 推算；填值 = 显式指定（cross-strap / 下行重排用）。</p>
          <label class="row"><span>下行极化</span>
            <select class="ci" v-model="selected.dn.pol"><option v-for="p in POLS" :key="p" :value="p">{{ POL_LABEL[p] }}</option></select>
          </label>
          <label class="row"><span>波束</span>
            <select class="ci" v-model="selected.beamUpId">
              <option value="">—</option>
              <option v-for="b in plan.beams" :key="b.id" :value="b.id">{{ b.name }}</option>
            </select>
          </label>
          <div class="sh sub">转发器参数（可留空）</div>
          <p class="tip">填了的项在链路预算引用本转发器时一并带过去；留空则沿用卫星配置里的值。</p>
          <div class="grid2">
            <label class="row2"><span>SFD dBW/m²</span><input class="ci num" :value="selected.sfdDbwm2 ?? ''" @input="setNum(selected, 'sfdDbwm2', $event.target.value)" /></label>
            <label class="row2"><span>G/T dB/K</span><input class="ci num" :value="selected.gtDbK ?? ''" @input="setNum(selected, 'gtDbK', $event.target.value)" /></label>
            <label class="row2"><span>IBO dB</span><input class="ci num" :value="selected.boiDb ?? ''" @input="setNum(selected, 'boiDb', $event.target.value)" /></label>
            <label class="row2"><span>OBO dB</span><input class="ci num" :value="selected.booDb ?? ''" @input="setNum(selected, 'booDb', $event.target.value)" /></label>
            <label class="row2"><span>C/IM dB</span><input class="ci num" :value="selected.cimDb ?? ''" @input="setNum(selected, 'cimDb', $event.target.value)" /></label>
            <label class="row2"><span>EIRP dBW</span><input class="ci num" :value="selected.eirpDbw ?? ''" @input="setNum(selected, 'eirpDbw', $event.target.value)" /></label>
          </div>
        </div>

        <div class="sec">
          <div class="sh">本振 LO <button class="mini ghost xs" @click="addLo"><Icon name="plus" :size="10" /></button></div>
          <div v-for="l in plan.los" :key="l.id" class="lorow">
            <input class="ci nar" v-model="l.name" />
            <input class="ci num" :value="l.valueMHz ?? ''" @input="setNum(l, 'valueMHz', $event.target.value)" placeholder="MHz" />
            <button class="lop del" @click="removeLo(l.id)"><Icon name="x" :size="10" /></button>
          </div>
          <p v-if="!plan.los.length" class="tip">还没有 LO。下行频率靠 f下 = f上 − LO 推算，先加一个。</p>
        </div>

        <div class="sec">
          <div class="sh">波束 <button class="mini ghost xs" @click="addBeam"><Icon name="plus" :size="10" /></button></div>
          <div v-for="b in plan.beams" :key="b.id" class="bmrow">
            <input class="clr" type="color" v-model="b.color" />
            <input class="ci nar" v-model="b.code" placeholder="代号" />
            <input class="ci" v-model="b.name" />
            <button class="lop del" @click="removeBeam(b.id)"><Icon name="x" :size="10" /></button>
          </div>
        </div>

        <div class="sec">
          <div class="sh">批量生成</div>
          <p class="tip">图上一排转发器几乎总是等差的。给首频、步进、数量即可铺一排。</p>
          <div class="grid2">
            <label class="row2"><span>数量</span><input class="ci num" v-model="gen.count" /></label>
            <label class="row2"><span>首频 MHz</span><input class="ci num" v-model="gen.startFcMHz" /></label>
            <label class="row2"><span>步进 MHz</span><input class="ci num" v-model="gen.stepMHz" /></label>
            <label class="row2"><span>带宽 MHz</span><input class="ci num" v-model="gen.bwMHz" /></label>
          </div>
          <label class="row"><span>极化</span>
            <select class="ci nar" v-model="gen.pol"><option v-for="p in POLS" :key="p" :value="p">{{ p }}</option></select>
            <select class="ci" v-model="gen.polMode">
              <option value="fixed">全同</option><option value="alternate">逐个交替</option>
            </select>
          </label>
          <label class="row"><span>编号</span><input class="ci nar" v-model="gen.noPattern" title="{n} 替换为序号" /><input class="ci num xnar" v-model="gen.noStart" title="起始序号" /></label>
          <label class="row"><span>LO</span>
            <select class="ci" v-model="gen.loId"><option value="">—</option><option v-for="l in plan.los" :key="l.id" :value="l.id">{{ l.name }}</option></select>
          </label>
          <label class="row"><span>波束</span>
            <select class="ci" v-model="gen.beamUpId"><option value="">—</option><option v-for="b in plan.beams" :key="b.id" :value="b.id">{{ b.name }}</option></select>
          </label>
          <button class="mini imp wide" @click="runGen">生成 {{ gen.count }} 个转发器</button>
        </div>
      </aside>
    </div>

    <div v-if="confirmMsg" class="mask">
      <div class="cdlg">
        <p>{{ confirmMsg }}</p>
        <div class="cops">
          <button class="mini ghost" @click="answer(false)">取消</button>
          <button class="mini imp" @click="answer(true)">确定</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fp { height: 100vh; display: flex; flex-direction: column; background: var(--bg); color: var(--text); font-family: var(--font-serif); font-size: var(--lb-fs, 13px); }
.tb { display: flex; align-items: center; gap: 7px; padding: 6px 10px; border-bottom: 1px solid var(--border-strong); background: var(--surface); flex-wrap: wrap; }
.brand { font-weight: 600; }
.sep { width: 1px; height: 16px; background: var(--border-strong); margin: 0 2px; }
.spacer { flex: 1; }
.busy { color: var(--text-muted); font-size: 12px; }
.msg { padding: 4px 10px; background: var(--surface-2); border-bottom: 1px solid var(--border); font-size: 12.5px; color: var(--text-muted); }

.body { flex: 1; display: grid; grid-template-columns: 236px 1fr 316px; min-height: 0; }
.left { border-right: 1px solid var(--border); display: flex; flex-direction: column; min-height: 0; }
.lh { display: flex; padding: 5px 8px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted); }
.lscroll { flex: 1; overflow: auto; }
.lnone { padding: 14px 10px; color: var(--text-faint); font-size: 12px; line-height: 1.7; }
.grp { margin-bottom: 2px; }
.gh { padding: 4px 8px; font-size: 11.5px; color: var(--text-muted); background: var(--surface); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 1; }
.gh.orphan { color: var(--warn); }
.gh.dim { color: var(--text-faint); }
.li { padding: 5px 8px; border-bottom: 1px solid var(--border); cursor: pointer; position: relative; }
.li:hover { background: var(--surface); }
.li.on { background: var(--surface-2); box-shadow: inset 2px 0 0 var(--text); }
.li.add { color: var(--text-muted); }
.ln { font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lm { font-size: 11px; color: var(--text-faint); margin-top: 1px; }
.lops { position: absolute; right: 4px; top: 5px; display: none; gap: 2px; }
.li:hover .lops { display: flex; }
.lop { border: none; background: var(--surface-2); color: var(--text-muted); cursor: pointer; padding: 2px 4px; }
.lop:hover { color: var(--text); }
.lop.del:hover { color: var(--danger); }

.center { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.mnone { padding: 40px; color: var(--text-muted); }
.mnone .dim { color: var(--text-faint); font-size: 12.5px; }
.chartbox { padding: 10px 12px; border-bottom: 1px solid var(--border); overflow: auto; max-height: 52%; }
.tabs { display: flex; align-items: center; gap: 4px; padding: 4px 8px; border-bottom: 1px solid var(--border); background: var(--surface); }
.tb-b { font: inherit; font-size: 12.5px; padding: 3px 10px; border: 1px solid transparent; background: transparent; color: var(--text-muted); cursor: pointer; }
.tb-b.on { background: var(--bg); border-color: var(--border-strong); color: var(--text); }
.tb-b i { font-style: normal; font-size: 11px; color: var(--text-faint); margin-left: 3px; }
.tb-b i.bad { color: var(--danger); }
.tabbody { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.tscroll { flex: 1; overflow: auto; }

.t { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.t thead th { position: sticky; top: 0; z-index: 1; background: var(--surface); border-bottom: 1px solid var(--border-strong); padding: 4px 6px; text-align: left; font-weight: 600; white-space: nowrap; }
.t td { border-bottom: 1px solid var(--border); padding: 1px 5px; }
.t tbody tr { cursor: pointer; }
.t tbody tr:hover { background: var(--surface); }
.t tbody tr.on { background: var(--surface-2); box-shadow: inset 2px 0 0 var(--text); }
.dnum input::placeholder { color: var(--text-faint); font-style: italic; }
.ops { white-space: nowrap; }
.none { padding: 22px; text-align: center; color: var(--text-faint); font-size: 12.5px; line-height: 1.7; }

.chk { padding: 4px 0; }
.ci-item { display: flex; gap: 8px; padding: 4px 10px; border-bottom: 1px solid var(--border); font-size: 12.5px; cursor: pointer; }
.ci-item:hover { background: var(--surface); }
.sev { flex: none; width: 18px; text-align: center; font-size: 11px; border: 1px solid var(--border-strong); height: 16px; line-height: 14px; }
.ci-item.error .sev { color: var(--danger); border-color: var(--danger); }
.ci-item.warn .sev { color: var(--warn); border-color: var(--warn); }
.ci-item.info .sev { color: var(--text-muted); }
.cm { color: var(--text-muted); }

.right { border-left: 1px solid var(--border); overflow: auto; }
.sec { border-bottom: 1px solid var(--border); padding: 7px 9px 9px; }
.sh { font-size: 12px; font-weight: 600; color: var(--text); margin-bottom: 5px; display: flex; align-items: center; gap: 6px; }
.sh.sub { margin-top: 8px; color: var(--text-muted); font-weight: 500; }
.row { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; }
.row > span { flex: none; width: 74px; font-size: 11.5px; color: var(--text-muted); }
.row2 { display: flex; flex-direction: column; gap: 1px; }
.row2 > span { font-size: 11px; color: var(--text-muted); }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 3px 6px; margin-bottom: 4px; }
.sum { font-size: 11px; color: var(--text-faint); margin-top: 4px; }
.tip { font-size: 11px; color: var(--text-faint); line-height: 1.55; margin: 2px 0 5px; }
.lorow, .bmrow { display: flex; align-items: center; gap: 4px; margin-bottom: 3px; }
.clr { width: 26px; height: 20px; border: 1px solid var(--border); background: none; padding: 0; cursor: pointer; }

.ci { flex: 1; min-width: 0; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 2px 4px; font: inherit; font-size: 12.5px; font-family: var(--font-serif); }
.ci:focus { border-color: var(--text); outline: none; }
.ci.num { text-align: right; font-variant-numeric: tabular-nums; }
.ci.nar { max-width: 88px; }
.ci.xnar { max-width: 54px; }
.t .ci { border-color: transparent; background: transparent; width: 100%; }
.t .ci:hover { border-color: var(--border); }
.t .ci:focus { border-color: var(--text); background: var(--bg); }

.mini { font: inherit; font-size: 12.5px; padding: 3px 9px; border: 1px solid var(--border-strong); background: var(--bg); color: var(--text); cursor: pointer; white-space: nowrap; }
.mini:hover:not(:disabled) { background: var(--surface-2); }
.mini:disabled { opacity: .45; cursor: default; }
.mini.imp { background: var(--text); color: var(--bg); border-color: var(--text); }
.mini.ghost { color: var(--text-muted); }
.mini.xs { padding: 0 5px; font-size: 11px; }
.mini.wide { width: 100%; margin-top: 5px; }
.ck { font-size: 11.5px; color: var(--text-muted); display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.fld { font-size: 11.5px; color: var(--text-muted); display: inline-flex; align-items: center; gap: 4px; }

.dd { position: relative; }
.dd:hover .ddm { display: block; }
.ddm { display: none; position: absolute; left: 0; top: 100%; z-index: 20; background: var(--bg); border: 1px solid var(--border-strong); min-width: 130px; }
.ddm button { display: block; width: 100%; text-align: left; font: inherit; font-size: 12.5px; padding: 4px 10px; border: none; background: transparent; color: var(--text); cursor: pointer; }
.ddm button:hover { background: var(--surface-2); }

.mask { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; z-index: 99; }
.cdlg { background: var(--bg); border: 1px solid var(--border-strong); padding: 16px 18px; max-width: 420px; }
.cdlg p { margin: 0 0 12px; line-height: 1.6; }
.cops { display: flex; gap: 8px; justify-content: flex-end; }
.dim { color: var(--text-faint); }
</style>
