<script setup>
import { computed, watch, ref, onMounted } from 'vue'
import { BAND_FREQ, BAND_LABEL } from './satPresets.js'
import { listPlans, getPlan, transponderOptions, applyChannel, MANAGED_KEYS } from '../shared/lbFreqPlanRef.js'
import Icon from '../components/Icon.vue'

// 卫星模块（资源库「卫星」库的条目编辑器）：方向图匹配 + 完整卫星参数表单。
// 方向图＝从「卫星树」选星（星座3D 页导入的 GRD 卫星）→ 给「卫星EIRP / 卫星G/T」各匹配一面天线 →
// 按各发/收信站经纬度取该天线多波束的最大 Parameter，回填到链路表（联动逻辑在父组件 LinkBudgetApp）。
// 匹配结果写入 sel＝该卫星库条目的 grd 属性（v1.4.3 起从场景态下沉到库条目：方向图是这颗卫星的属性，
// 不是某个场景的属性；工作台卫星分区只留只读速览行）。
// v1.4 工作台重构：单列窄表单 → 自适应多列密排网格（标签在上、输入在下），一屏尽收全部空间段参数。
const props = defineProps({
  form: { type: Object, required: true },
  fields: { type: Array, required: true },
  satTree: { type: Array, default: () => [] },   // [{ folder, satName, lon, antennas:[{name,beams}] }]
  sel: { type: Object, default: () => ({ satFolder: '', eirpKey: '', gtKey: '' }) },  // 库条目的 grd，本组件就地写入
  // 「导入方向图」：直接在本编辑器里导入 GRD/PAT，挂到本卫星条目名下（免去先去「星座3D」页导入一趟）。
  // 由父组件实现（它知道条目 id / 星位，且导入后要重载卫星树并落匹配），本组件只管按钮与忙态。
  onImport: { type: Function, default: null },
  onRemoveAnt: { type: Function, default: null },  // (antName) => Promise<void>：删除本模块导入的天线
  importing: { type: Boolean, default: false }
})

// 当前选中的卫星树节点 + 其天线列表
const curSat = computed(() => props.satTree.find((s) => s.folder === props.sel.satFolder) || null)
const antKey = (a) => (curSat.value ? curSat.value.folder + '|' + a.name : '')
// 已匹配、但本机卫星树里没有这颗 GRD 卫星（换机器 / 尚未在「星座3D」导入）：保留原值占位显示，
// 不静默清空——库是全局资产，清掉的匹配无从找回；未命中期间父组件自然不回填。
const staleFolder = computed(() => ((props.sel.satFolder && !curSat.value) ? props.sel.satFolder : ''))
// 卫星树按来源分两组：星座3D 页导入的 / 本模块（本编辑器「导入方向图」）导入的
const treeSats = computed(() => props.satTree.filter((s) => !s.local))
const localSats = computed(() => props.satTree.filter((s) => s.local))
// 本条目自己导入的方向图（local 节点上的天线）——「删除方向图」按钮据此出现
const localAnts = computed(() => ((curSat.value && curSat.value.local) ? curSat.value.antennas : []))

// 选星：写入卫星名称/轨道位置；切换卫星时清空已匹配天线（不同星天线不同）。
// 条目名跟随星名由 satelliteName 这一处写入触发（自动命名，见 shared/lbAutoName.js），此处不另行通知父组件。
function onPickSat() {
  const s = curSat.value
  if (s) { props.form.satelliteName = s.satName; props.form.orbitPosition = String(s.lon) }
  props.sel.eirpKey = ''
  props.sel.gtKey = ''
}

// 选完工作频段，上/下行频率跟随预设变（与小程序一致；仍可手改）。
// ★ 已引用频率计划时不动：那五项由转发器托管，频段预设再来覆盖就把引用值冲掉了。
watch(() => props.form.frequencyBand, (band) => {
  if (fpActive.value) return
  const f = BAND_FREQ[band]; if (!f) return
  props.form.centerFrequency = String(f.up)
  props.form.rxCenterFrequency = String(f.dn)
})
const bandLabel = (o) => BAND_LABEL[o] || o

/* ---- 频率计划引用：选「计划 → 转发器」，上下行频率/极化/转发器带宽由该转发器托管 ----
   引用关系存在 sel（即卫星库条目的 grd 属性）里，随条目入库/复制/分享，与方向图匹配同一去处。 */
const fpIndex = ref([])
const fpPlan = ref(null)
const fpLoading = ref(false)
// 本卫星名下的计划优先；其余计划仍可选（同一份计划服务多个卫星条目是常见做法）
const fpOwn = computed(() => fpIndex.value.filter((e) => e.satFolder && e.satFolder === props.sel.satFolder))
const fpOther = computed(() => fpIndex.value.filter((e) => !e.satFolder || e.satFolder !== props.sel.satFolder))
const fpOptions = computed(() => transponderOptions(fpPlan.value))
const fpActive = computed(() => !!(props.sel.fpId && props.sel.fpNo && fpPlan.value))
// 引用生效后被托管的字段灰显——避免有人改了手填值却发现算出来不对
const isManaged = (key) => fpActive.value && MANAGED_KEYS.includes(key)

async function loadFpIndex() { fpIndex.value = await listPlans() }
async function loadFpPlan() {
  const id = props.sel.fpId
  if (!id) { fpPlan.value = null; return }
  fpLoading.value = true
  try { fpPlan.value = await getPlan(id) } finally { fpLoading.value = false }
}
async function onPickPlan() {
  props.sel.fpNo = ''
  await loadFpPlan()
  // 计划里只有一个转发器时直接选中——多点一次没有信息量
  if (fpOptions.value.length === 1) { props.sel.fpNo = fpOptions.value[0].no; applyFp() }
}
function applyFp() {
  if (!fpPlan.value || !props.sel.fpNo) return
  applyChannel(props.form, fpPlan.value, props.sel.fpNo)
}
function clearFp() {
  props.sel.fpId = ''
  props.sel.fpNo = ''
  fpPlan.value = null
}
onMounted(async () => { await loadFpIndex(); await loadFpPlan() })
// 换库条目时（同一组件实例复用于不同 cfg）重新解引用
watch(() => props.sel.fpId, loadFpPlan)
// 引用生效期间计划本身可能在另一个窗口被改过 —— 每次选转发器都按当前计划重取值，不缓存结果
</script>

<template>
  <div class="sp">
    <!-- 方向图：从卫星树选星 + 为「卫星EIRP / 卫星G/T」匹配天线（横排一行三选），
         写入本条目的 grd 属性；工作台卫星分区第三行只做只读速览。 -->
    <div class="sp-grd">
      <div class="sp-gmain">
        <label class="sp-gf" title="从「星座3D」页导入的 GRD 天线树选星（星名/轨位随之回填本卫星配置）">
          <span class="sp-gl">卫星方向图</span>
          <select v-model="sel.satFolder" class="sp-gi" :class="{ unset: !sel.satFolder }" @change="onPickSat">
            <!-- 空值可选＝解除匹配（本条目不接方向图，EIRP/G·T 回到手工填）——库条目的匹配得能撤 -->
            <option value="">— 未匹配 —</option>
            <optgroup v-if="treeSats.length" label="星座3D 导入">
              <option v-for="s in treeSats" :key="s.folder" :value="s.folder">{{ s.satName }}（{{ s.lon }}°E）</option>
            </optgroup>
            <optgroup v-if="localSats.length" label="本模块导入">
              <option v-for="s in localSats" :key="s.folder" :value="s.folder">{{ s.satName }}（{{ s.lon }}°E）</option>
            </optgroup>
            <option v-if="staleFolder" :value="staleFolder">{{ staleFolder }}（未导入）</option>
          </select>
        </label>
        <template v-if="curSat">
          <label class="sp-gf" title="按各收信站经纬度取该天线多波束最大 Parameter → 回填收信站「卫星EIRP」">
            <span class="sp-gl">EIRP 天线</span>
            <select v-model="sel.eirpKey" class="sp-gi" :class="{ unset: !sel.eirpKey }">
              <option value="">— 未匹配 —</option>
              <option v-for="a in curSat.antennas" :key="a.name" :value="antKey(a)">{{ a.name }}（{{ a.beams }} 波束）</option>
            </select>
          </label>
          <label class="sp-gf" title="按各发信站经纬度取该天线多波束最大 Parameter → 回填发信站「卫星G/T」">
            <span class="sp-gl">G/T 天线</span>
            <select v-model="sel.gtKey" class="sp-gi" :class="{ unset: !sel.gtKey }">
              <option value="">— 未匹配 —</option>
              <option v-for="a in curSat.antennas" :key="a.name" :value="antKey(a)">{{ a.name }}（{{ a.beams }} 波束）</option>
            </select>
          </label>
        </template>
        <!-- 直接导入：本条目就是一颗星，导进来的方向图即挂在它名下（与「星座3D」页导入的天线并列可选） -->
        <button v-if="onImport" class="sp-gbtn" :disabled="importing"
                title="直接导入 GRD / PAT 方向图（可多选），挂到本卫星条目名下；一个文件＝一副天线，文件内多个 set＝多波束"
                @click.prevent="onImport()">
          <Icon name="folder-plus" :size="12" /><span>{{ importing ? '导入中…' : '导入方向图' }}</span>
        </button>
        <button v-if="onRemoveAnt && localAnts.length" class="sp-gbtn" :disabled="importing"
                :title="'删除本条目导入的方向图：' + localAnts.map((a) => a.name).join('、')"
                @click.prevent="onRemoveAnt()">
          <Icon name="eye-off" :size="12" /><span>删除方向图</span>
        </button>
        <span v-if="staleFolder" class="sp-tip">本机卫星树中没有该 GRD 卫星，匹配已保留：在「星座3D」页导入后自动恢复回填</span>
        <span v-else-if="!satTree.length" class="sp-tip">卫星树为空：点「导入方向图」直接导入，或在「星座3D」页导入 GRD 天线</span>
        <span v-else-if="curSat" class="sp-tip" title="匹配后按各站经纬度自动回填：收信站「卫星EIRP」、发信站「卫星G/T」；一面天线多波束时取 Parameter 最大者">
          自动回填 → 收信站 EIRP · 发信站 G/T（多波束取最大）
        </span>
      </div>
    </div>

    <!-- 频率计划引用：选「计划 → 转发器」，上下行频率/极化/转发器带宽由该转发器托管 -->
    <div class="sp-grd sp-fp">
      <div class="sp-gmain">
        <label class="sp-gf" title="转发器频率计划（挂在卫星下，与 GRD 天线平级）。选定后本卫星的上下行频率/极化/转发器带宽由所选转发器托管。">
          <span class="sp-gl">频率计划</span>
          <select v-model="sel.fpId" class="sp-gi" :class="{ unset: !sel.fpId }" @change="onPickPlan">
            <option value="">— 未引用 —</option>
            <optgroup v-if="fpOwn.length" label="本卫星">
              <option v-for="e in fpOwn" :key="e.id" :value="e.id">{{ e.name }}（{{ e.transponderCount }} 转发器）</option>
            </optgroup>
            <optgroup v-if="fpOther.length" label="其他">
              <option v-for="e in fpOther" :key="e.id" :value="e.id">{{ e.satName ? e.satName + ' · ' : '' }}{{ e.name }}</option>
            </optgroup>
          </select>
        </label>
        <label v-if="sel.fpId" class="sp-gf" title="选定转发器后，其上下行频率/极化/带宽即刻填入下方卫星参数并锁定">
          <span class="sp-gl">转发器</span>
          <select v-model="sel.fpNo" class="sp-gi wide" :class="{ unset: !sel.fpNo }" @change="applyFp">
            <option value="">— 未选 —</option>
            <option v-for="o in fpOptions" :key="o.no" :value="o.no">{{ o.label }}</option>
          </select>
        </label>
        <button v-if="sel.fpId" class="sp-gbtn" title="解除引用，五项频率参数交回手工填写" @click.prevent="clearFp">
          <Icon name="lock-open" :size="12" /><span>解除引用</span>
        </button>
        <span v-if="fpLoading" class="sp-tip">载入中…</span>
        <span v-else-if="fpActive" class="sp-tip">已锁定 → 上/下行频率 · 上/下行极化 · 转发器带宽（改动请回频率计划工作台）</span>
        <span v-else-if="!fpIndex.length" class="sp-tip">尚无频率计划：在「计算 → 转发器频率计划」里新建，或从标准频率计划图截图导入</span>
      </div>
    </div>

    <!-- 卫星参数：自适应多列密排。f.br=true 的字段前插一个整行占位（sp-break），令其另起一行——
         用于把上/下行干扰各自归为一行，按上下行区分而不做成带边框的分区块。
         被频率计划托管的字段置为只读并淡显：值的来源只有一处，免得手改了却不生效。 -->
    <div class="sp-fields">
      <template v-for="f in fields" :key="f.key">
        <span v-if="f.br" class="sp-break" aria-hidden="true"></span>
        <label class="sp-f" :title="isManaged(f.key) ? '由所引用的转发器托管 — 到频率计划工作台修改，或先解除引用' : (f.tip || f.label)">
          <span class="sp-l">{{ f.label }}<i v-if="f.unit"> ({{ f.unit }})</i><i v-if="isManaged(f.key)" class="sp-lk">·计划</i></span>
          <select v-if="f.type === 'select'" v-model="form[f.key]" class="sp-i" :disabled="isManaged(f.key)" :class="{ managed: isManaged(f.key) }">
            <option v-for="o in f.options" :key="o" :value="o">{{ f.key === 'frequencyBand' ? bandLabel(o) : o }}</option>
          </select>
          <input v-else v-model="form[f.key]" class="sp-i mono" :placeholder="f.ph || ''" :readonly="isManaged(f.key)" :class="{ managed: isManaged(f.key) }" />
        </label>
      </template>
    </div>
  </div>
</template>

<style scoped>
.sp { max-width: 940px; }
.sp-grd { margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px dashed var(--border); }
/* 取星行内容：横排「标签 + 选择框」三组 + 尾部提示，窄窗自动折行 */
.sp-gmain { display: flex; align-items: center; flex-wrap: wrap; gap: 5px 16px; min-width: 0; }
.sp-gf { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; }
.sp-gl { font-size: 12px; color: var(--text-muted); white-space: nowrap; }
/* 188px 是常规宽度；资源库栏可拖窄，故允许压缩（min-width:0）而不撑破栏宽 */
.sp-gi { font: inherit; font-size: 12px; flex: 0 1 188px; width: 188px; min-width: 0; padding: 3px 6px; cursor: pointer; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.sp-gi:focus { outline: none; border-color: var(--accent); }
/* 未匹配态压成弱色：一眼看出哪一路还没接上方向图 */
.sp-gi.unset { color: var(--text-faint); }
.sp-tip { font-size: 11px; color: var(--text-faint); line-height: 1.5; }
/* 直接导入 / 删除方向图：与取星选择框同高的小按钮 */
.sp-gbtn { display: inline-flex; align-items: center; gap: 4px; font: inherit; font-size: 12px; padding: 3px 8px; cursor: pointer; white-space: nowrap; background: var(--surface-2); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.sp-gbtn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.sp-gbtn:disabled { opacity: .55; cursor: default; }

.sp-fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 7px 11px; }
/* 整行占位：令下一字段另起一行（上/下行干扰分行用）；零高度，仅靠栅格行距形成一点间隔，不加边框/底色（不做成分区块） */
.sp-break { grid-column: 1 / -1; height: 0; }
.sp-f { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.sp-l { font-size: 12px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sp-l i { color: var(--text-faint); font-style: normal; }
.sp-i { font: inherit; font-size: 12px; padding: 4px 7px; width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.sp-i:focus { outline: none; border-color: var(--accent); }
.sp-i.mono { font-family: var(--font-mono); }
/* 频率计划引用行：与方向图行同构，两条虚线分隔三段（方向图 / 频率计划 / 参数） */
.sp-fp { margin-top: -2px; }
.sp-gi.wide { flex: 0 1 300px; width: 300px; font-family: var(--font-mono); }
/* 被频率计划托管的字段：只读 + 淡显，一眼看出「这个数不归这里管」 */
.sp-i.managed { background: var(--surface-2); color: var(--text-muted); cursor: default; }
.sp-i.managed:focus { border-color: var(--border); }
.sp-lk { font-style: normal; color: var(--text-faint); font-size: 10.5px; margin-left: 3px; }
</style>
