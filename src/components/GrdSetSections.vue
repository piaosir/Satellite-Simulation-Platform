<script setup>
// 天线设置四区（Beams To Plot / 参数 / 电平 / 填充 / 指向 / 显示选项）—— 「对地覆盖分析」与
// 「对星覆盖分析」【同一份 UI】。
//
// 这两个视图本来就共用同一份编辑态（grd.s：改哪边都同步，见 useShellCoverage 文件头），
// 界面却各写各的，很快就长歪成两套控件。故整块抽到这里：两边 import 同一个组件，
// 逐像素一致，且以后只有一处要改。变体只影响【文案】，不影响控件与口径：
//   variant='ground' —— 对地覆盖分析（拖拽落点是地表）
//   variant='shell'  —— 对星覆盖分析（拖拽落点是轨道壳层）
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import { isSecOpen, toggleSec } from '../stores/panelSections'

const props = defineProps({
  grd: { type: Object, required: true },            // useGrdCoverage 活实例
  variant: { type: String, default: 'ground' },     // 'ground' | 'shell'
  // 对星跟踪的目标星搜索（宿主注入，全量：星座目录 + 卫星组 + 自定义星座）：
  //   async (q, limit) => { items: [{ name, noradId, group, tag }], total }   total = 不截断的命中总数
  satSearch: { type: Function, default: null }
})
// 本组件是多根（四个 .sec 平铺进宿主侧栏，不套壳）→ 关掉属性透传，免得宿主的 scoped 标记
// 找不到唯一根节点而在控制台刷「Extraneous non-props attributes」。样式各自 scoped，不靠透传。
defineOptions({ inheritAttrs: false })
const grd = props.grd
const st = grd.s
const isShell = computed(() => props.variant === 'shell')

// ---- 电平配色：css(rgb) ↔ #hex（<input type=color> 只认后者）----
function lvHex(css) { const m = /(\d+)\D+(\d+)\D+(\d+)/.exec(css || ''); if (!m) return '#ffffff'; const h = (n) => (+n).toString(16).padStart(2, '0'); return '#' + h(m[1]) + h(m[2]) + h(m[3]) }
const toCss = (x) => `rgb(${parseInt(x.slice(1, 3), 16)},${parseInt(x.slice(3, 5), 16)},${parseInt(x.slice(5, 7), 16)})`
// 填充色：未单独设过线色时线色跟随（一次挑色两处同步）；locked=用户手动配色，不再被 jet 重排覆盖
function setLevelColor(i, e) { const css = toCss(e.target.value); const L = st.levels[i]; L.color = css; if (!L.lineSet) L.lineColor = css; L.locked = true }
function setLineColor(i, e) { const css = toCss(e.target.value); const L = st.levels[i]; L.lineColor = css; L.lineSet = true; L.locked = true }

// ---- 内联改名（波束名 / 电平名）：草稿缓冲 ----
// 实时时钟与星动每秒触发整组件重渲染，Vue 会把 :value 强制写回 <input>、吞掉未提交的输入。
// 故编辑期间 :value 一律取草稿（editX/editXVal），失焦或回车才落库。
const editBeam = ref(''), editBeamVal = ref('')
const beamEditKey = (b) => grd.active.value + '#' + b.i
function startRenameBeam(b) { editBeam.value = beamEditKey(b); editBeamVal.value = b.label }
function inputRenameBeam(b, v) { editBeam.value = beamEditKey(b); editBeamVal.value = v }
function commitRenameBeam(b) {
  if (editBeam.value === '') return                                     // 已提交（blur 与回车可能重复触发）→ 跳过
  if (editBeamVal.value !== b.label) grd.renameBeam(b.i, editBeamVal.value)   // 未改名则跳过，省一次 live 冗余重绘
  editBeam.value = ''; editBeamVal.value = ''
}
const editLv = ref(''), editLvVal = ref('')
const lvDefaultText = (L) => String(L.v)      // 无自定义名时的灰字＝该档在地图上的数值标签文字（所见即所得）
function startRenameLv(i, L) { editLv.value = String(i); editLvVal.value = L.name || '' }
function inputRenameLv(i, v) { editLv.value = String(i); editLvVal.value = v }
function commitRenameLv(i) {
  if (editLv.value === '') return
  const L = st.levels[i], nm = editLvVal.value.trim()
  if (L && nm !== (L.name || '')) L.name = nm    // 未改则跳过（改 levels 会触发 watch(s.levels) 回存+重绘）
  editLv.value = ''; editLvVal.value = ''
}

// ---- 指向 ----
const boreMode = computed({ get: () => grd.boreModeOf(), set: (m) => grd.setBoreMode(m) })
const satResolved = computed(() => grd.boreSatResolved(st))
const isSatMode = computed(() => st.boreType === 'sat' || st.boreType === 'satoff')
// 目标星搜索：★全量（星座目录 / 卫星组 / 自定义星座），不限于在场的星——搜到即可跟踪。
// 结果区与主界面搜索、卫星组管理器【同款】：一行一颗（星名 + 「来源 · NORAD」副行）、可滚动、
// 条数上限同量级（60），底下一行照实报命中总数——只列一小截又不说总数，用户分不清「就这几颗」与「被截了」。
// 目录是懒加载的（首次可能要等几秒），故搜索是异步的：防抖 200 ms + 序号守卫（只认最后一次输入的结果，
// 否则先发后到的旧结果会盖掉新词的候选）。
const bq = ref('')
const bcand = ref([])
const bTotal = ref(0)
const bBusy = ref(false)
let bSeq = 0, bTimer = null
watch(bq, (v) => {
  const q = String(v || '').trim()
  if (bTimer) { clearTimeout(bTimer); bTimer = null }
  bSeq++                                   // 作废在途结果（清空输入时尤其重要）
  if (!q) { bcand.value = []; bTotal.value = 0; bBusy.value = false; return }
  bBusy.value = true
  bTimer = setTimeout(async () => {
    const seq = bSeq
    let r = { items: [], total: 0 }
    try { r = (props.satSearch ? await props.satSearch(q, 60) : null) || { items: [], total: 0 } } catch { r = { items: [], total: 0 } }
    if (seq !== bSeq) return
    bcand.value = r.items || []; bTotal.value = r.total || 0; bBusy.value = false
  }, 200)
})
onBeforeUnmount(() => { if (bTimer) clearTimeout(bTimer) })
function pickBoreSat(e) { grd.setBoreSat(e.noradId ? 'n:' + e.noradId : 'm:' + e.name, e.name); bq.value = '' }
// 读数行：各模式各报各的口径（对地报地表落点，对星报目标星/空间点），不硬套「经纬度」一种说法。
// 数字一律走 fx：数字输入框被清空时 v-model.number 落下的是空串，直接 .toFixed 会当场抛错、整块侧栏白屏。
const fx = (v, n = 2) => (Number.isFinite(+v) && v !== '' && v !== null ? (+v).toFixed(n) : '—')
const boreTip = computed(() => {
  const m = grd.antMeta(); if (!m) return ''
  // 峰值读数取【当前画面上】标出来的那个峰值点（grd.livePeak，两个视图各一份），与地图所见同源。
  // 不再用导入时烘的 meta.peak —— 那是标称指向下的落点，拖了指向就过时。
  // hit=false（峰值方向越过地平 / 没打到那层壳）→ 地表上根本没有这个点，只报 dB 不报坐标。
  // 该天线此刻没画出来（无实时读数）→ 退回天线自身的峰值 dB，同样不报坐标。
  const lp = grd.livePeak.value[isShell.value ? 'shell' : 'ground']
  const tail = lp
    ? ` · 峰值 ${fx(lp.db)}dB` + (lp.hit ? ` @ ${fx(lp.lon)},${fx(lp.lat)}` : '')
    : (Number.isFinite(+m.peakDb) ? ` · 峰值 ${fx(m.peakDb)}dB` : '')
  if (isSatMode.value) {
    const off = st.boreType === 'satoff' ? ` · 偏置 ${fx(st.boreOffAz || 0)}°/${fx(st.boreOffEl || 0)}°` : ''
    return (st.boreSat ? (satResolved.value ? '指向 ' + (st.boreSatName || '目标星') : '目标星不在场，已退回天底') : '未选目标星') + off + tail
  }
  if (st.boreType === 'point') {
    return `指向空间点 ${fx(st.borePtLon == null ? m.satLon : st.borePtLon)}°E, ${fx(st.borePtLat || 0)}°N @ ${fx(st.borePtAlt || 0, 0)} km${tail}`
  }
  const g = grd.boreGround()
  return (g ? `指向 ${fx(g.lon)}°E, ${fx(g.lat)}°N` : '指向深空（越过地平）') + `（默认星下点 ${m.satLon}°）` + tail
})
</script>

<template>
  <template v-if="grd.antMeta()">
    <div class="sec">
      <div class="sect setsect acc" :class="{ open: isSecOpen('grd-set') }" @click="toggleSec('grd-set')">
        <Icon :name="isSecOpen('grd-set') ? 'chevron-down' : 'chevron-right'" :size="12" />
        <svg class="gsvg ant-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 10a7.31 7.31 0 0 0 10 10Z" /><path d="m9 15 3-3" /><path d="M17 13a6 6 0 0 0-6-6" /><path d="M21 13A10 10 0 0 0 11 3" />
        </svg>
        <span class="setlbl">天线设置</span><span class="setname" :title="grd.activeName()">{{ grd.activeName() }}</span>
        <span v-if="grd.selected.value.length > 1" class="editing" title="多选时设置只作用于聚焦（编辑中）天线，各天线独立保存">仅编辑聚焦天线</span>
      </div>
      <template v-if="isSecOpen('grd-set')">
        <template v-if="grd.beamListOn()">
          <div class="sect"><span>Beams To Plot · {{ grd.activeBeams().length }} 波束</span></div>
          <input class="ci bq" :value="grd.beamQuery.value" placeholder="搜索：波束名，或序号 1-62、1,3,5、1-10,20-30" @input="e => grd.setBeamQuery(e.target.value)" />
          <div class="bplist">
            <label class="brow ball">
              <input type="checkbox" :checked="grd.filteredAllOn()" :indeterminate="grd.filteredAnyOn() && !grd.filteredAllOn()" @change="grd.selectFiltered(!grd.filteredAllOn())" />
              <span class="balln">{{ grd.beamQuery.value.trim() ? '(全选搜索结果)' : '(全选)' }}</span>
              <span class="bpk">{{ st.beamsToPlot.length }}/{{ grd.activeBeams().length }}</span>
              <span v-if="st.beamsToPlot.length && grd.activeBeams().length > 1" class="ic del" :title="`删除勾选的 ${st.beamsToPlot.length} 个波束（可重新导入原 GRD 恢复）`" @click.stop.prevent="grd.deleteCheckedBeams()"><Icon name="x" :size="11" /></span>
            </label>
            <label v-for="b in grd.filteredBeams()" :key="b.seq" class="brow" :class="{ on: grd.isBeamOn(b.i) }">
              <input type="checkbox" :checked="grd.isBeamOn(b.i)" @change="grd.toggleBeam(b.i)" />
              <span class="bseq">{{ b.seq }}</span>
              <input class="bnm-in" :value="editBeam === grd.active.value + '#' + b.i ? editBeamVal : b.label" title="编辑波束名（地图标注同步用此名）" @click.stop @focus="startRenameBeam(b)" @input="e => inputRenameBeam(b, e.target.value)" @keydown.enter="e => e.target.blur()" @blur="commitRenameBeam(b)" />
              <span v-if="grd.activeBeams().length > 1" class="ic del" :title="`删除该波束（峰值 ${b.peakDb.toFixed(1)} dB，可重新导入原 GRD 恢复）`" @click.stop.prevent="grd.deleteBeam(b.i)"><Icon name="x" :size="11" /></span>
              <span v-else class="bpk" :title="`峰值 ${b.peakDb.toFixed(1)} dB`">{{ b.peakDb.toFixed(1) }}</span>
            </label>
            <div v-if="!grd.filteredBeams().length" class="empty">无匹配波束</div>
          </div>
        </template>
        <div class="srow"><label>极化</label><select v-model="st.pol"><option value="P1">P1 共极化</option><option value="P2">P2 交叉</option><option value="RSS">RSS 合成</option><option value="P1/P2">P1/P2</option><option value="P2/P1">P2/P1</option></select></div>
        <div class="srow"><label>类型</label>
          <span class="seg sm"><span class="sg" :class="{ on: st.ctype === 'rel' }" @click="st.ctype = 'rel'">相对峰值</span><span class="sg" :class="{ on: st.ctype === 'abs' }" @click="st.ctype = 'abs'">绝对</span></span>
        </div>
        <div class="srow"><label>增益偏置</label><input class="ci" type="number" step="0.5" v-model.number="st.gainOffset" /><span class="u">dB</span></div>
        <div class="srow"><label>路径损耗</label><select v-model="st.pathLoss"><option value="none">无</option><option value="relative">相对(h/Rs)²</option><option value="absolute">通量密度</option></select></div>

        <div class="sect"><span>电平</span></div>
        <div class="glv">
          <!-- 表头落在表内、用与数据行同一套列宽 —— 原来是一串靠右的「填充 · 线 · 值 · 绝对」，
               飘在表格右上角，压根不在它命名的那几列头上，两个色块也分不出谁是填充谁是线。 -->
          <div class="glvhd" aria-hidden="true"><span class="h-clr">填充</span><span class="h-clr">线</span><span class="h-val">值</span><span class="h-nm">名称</span><span class="h-del"></span></div>
          <div v-for="(L, i) in st.levels" :key="i" class="glvrow">
            <input class="lvclr" type="color" title="填充色" :value="lvHex(L.color)" @input="e => setLevelColor(i, e)" />
            <input class="lvclr" type="color" title="线色" :value="lvHex(L.lineColor)" @input="e => setLineColor(i, e)" />
            <input class="lvval" type="number" step="0.5" v-model.number.lazy="L.v" />
            <input class="lvabs lvname" :class="{ named: !!L.name }"
              :value="editLv === String(i) ? editLvVal : (L.name || lvDefaultText(L))"
              :title="L.name ? '自定义名称（等值线数值标签用此名，清空恢复电平值）' : '点击自定义名称（默认显示电平值，作等值线数值标签）'"
              @click.stop @focus="startRenameLv(i, L)" @input="e => inputRenameLv(i, e.target.value)"
              @keydown.enter="e => e.target.blur()" @blur="commitRenameLv(i)" />
            <span class="ic del" title="删除该档" @click="grd.removeLevel(i)"><Icon name="x" :size="11" /></span>
          </div>
          <div class="glvadd" @click="grd.addLevel()"><Icon name="plus" :size="11" /> 添加电平</div>
        </div>
        <div class="srow"><label>线宽</label><input class="rng" type="range" min="0.1" max="8" step="0.1" v-model.number="st.lineWidth" /><span class="u">{{ st.lineWidth.toFixed(1) }}</span></div>
      </template>
    </div>

    <div class="sec">
      <label class="chk2"><input type="checkbox" v-model="st.fill" /><span>Fill Contours（分带填充）</span></label>
      <label class="chk2"><input type="checkbox" v-model="st.line" /><span>显示等值线</span></label>
      <div class="srow sub"><label>透明度</label><input class="rng" type="range" min="0" max="1" step="0.02" v-model.number="st.alpha" /><span class="u">{{ st.alpha.toFixed(2) }}</span></div>
    </div>

    <div class="sec">
      <div class="sect acc" :class="{ open: isSecOpen('grd-bore') }" @click="toggleSec('grd-bore')"><Icon :name="isSecOpen('grd-bore') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>天线 boresight</span>
        <span class="lnk" :class="{ on: grd.dragBore.value }" :title="isShell ? '开启后在 3D 上拖动可把指向点拖到轨道壳层上（对星跟踪时改的是偏置量）' : '开启后在地图上拖动可平移波束中心'" @click.stop="grd.setDragBore(!grd.dragBore.value)"><Icon v-if="grd.dragBore.value" name="check" :size="10" /> 拖拽波束</span>
      </div>
      <template v-if="isSecOpen('grd-bore')">
        <!-- 两大类：对地指向瞄地面/相对天底，对星指向瞄空间（目标星或空间定点，可指反天底）。
             同一份指向设置两视图共用，故两边下拉必须给全，缺项会让另一视图选出来的模式在这里显示空白。 -->
        <div class="srow"><label>指向模式</label>
          <select v-model="boreMode">
            <optgroup label="对地指向">
              <option value="target">目标跟踪 Targeted</option>
              <option value="groundtrack">星下点跟随 Ground-track</option>
              <option value="fixed">本体固定 Fixed (Az/El)</option>
              <option value="nadir">天底 Nadir</option>
            </optgroup>
            <optgroup label="对星指向">
              <option value="sat">对星跟踪 Sat-track</option>
              <option value="satoff">对星跟踪 + 偏置</option>
              <option value="point">空间点 Space-point</option>
            </optgroup>
          </select>
        </div>
        <template v-if="st.boreType === 'geo'">
          <div class="srow"><label>经度</label><input class="ci" type="number" step="0.5" v-model.number="st.boreLon" /><span class="u">°E</span></div>
          <div class="srow"><label>纬度</label><input class="ci" type="number" step="0.5" v-model.number="st.boreLat" /><span class="u">°N</span></div>
        </template>
        <template v-else-if="st.boreType === 'point'">
          <div class="srow"><label>经度</label><input class="ci" type="number" step="0.5" v-model.number="st.borePtLon" /><span class="u">°E</span></div>
          <div class="srow"><label>纬度</label><input class="ci" type="number" step="0.5" v-model.number="st.borePtLat" /><span class="u">°N</span></div>
          <div class="srow"><label>高度</label><input class="ci" type="number" step="10" min="0" v-model.number="st.borePtAlt" title="指向点的轨道高度（地心球面 r = 6378.137 + 该值，与轨道壳层同口径）" /><span class="u">km</span></div>
        </template>
        <template v-else-if="isSatMode">
          <div class="srow"><label>目标星</label>
            <span class="tgtnm" :class="{ bad: st.boreSat && !satResolved }">{{ st.boreSatName || '未选择' }}</span>
            <span v-if="st.boreSat" class="ic del" title="清除目标星" @click="grd.setBoreSat(null, '')"><Icon name="x" :size="11" /></span>
          </div>
          <div class="srow"><input class="ci" v-model="bq" placeholder="搜索目标星：卫星名 / NORAD / 星座 / 卫星组" /></div>
          <div v-if="bq.trim()" class="sres">
            <div v-if="bBusy" class="sres-e">搜索中…</div>
            <div v-else-if="!bcand.length" class="sres-e">没有匹配的卫星。</div>
            <template v-else>
              <div class="sres-list">
                <div v-for="e in bcand" :key="e.noradId || e.name" class="sitem" @click="pickBoreSat(e)">
                  <div class="nm" :title="e.name" data-i18n-skip>{{ e.name }}</div>
                  <div class="sub">{{ e.tag }}<template v-if="e.noradId"><template v-if="e.tag"> · </template>NORAD {{ e.noradId }}</template></div>
                </div>
              </div>
              <div class="sres-n">{{ bTotal > bcand.length ? `命中 ${bTotal} 颗 · 列出前 ${bcand.length}` : `${bTotal} 颗` }}</div>
            </template>
          </div>
          <template v-if="st.boreType === 'satoff'">
            <div class="srow"><label>偏置 Az</label><input class="ci" type="number" step="0.1" v-model.number="st.boreOffAz" /><span class="u">°</span></div>
            <div class="srow"><label>偏置 El</label><input class="ci" type="number" step="0.1" v-model.number="st.boreOffEl" /><span class="u">°</span></div>
          </template>
        </template>
        <template v-else>
          <div class="srow"><label>方位 Az</label><input class="ci" type="number" step="0.5" v-model.number="st.boreAz" /><span class="u">°</span></div>
          <div class="srow"><label>俯仰 El</label><input class="ci" type="number" step="0.5" v-model.number="st.boreEl" /><span class="u">°</span></div>
        </template>
        <div class="srow"><label>旋转 Rot</label><input class="ci" type="number" step="1" v-model.number="st.yaw" /><span class="u">°</span></div>
        <div class="tip">{{ boreTip }}</div>
      </template>
    </div>

    <div class="sec">
      <div class="sect acc" :class="{ open: isSecOpen('grd-disp', false) }" @click="toggleSec('grd-disp', false)"><Icon :name="isSecOpen('grd-disp', false) ? 'chevron-down' : 'chevron-right'" :size="12" /><span>显示选项</span><span class="editing" title="对所有选中天线生效">全局</span></div>
      <template v-if="isSecOpen('grd-disp', false)">
        <label class="chk2"><input type="checkbox" v-model="st.showName" /><span>显示波束名</span></label>
        <div v-if="st.showName" class="srow sub"><label>字号</label><input class="rng" type="range" min="0.5" max="32" step="0.5" v-model.number="st.nameSize" /><span class="u">{{ st.nameSize }}</span></div>
        <label class="chk2"><input type="checkbox" v-model="st.showBore" /><span title="当前场的峰值格点打在地球/壳层上的位置；峰值方向越过地平时不标">显示峰值点</span></label>
        <div v-if="st.showBore" class="srow sub"><label>大小</label><input class="rng" type="range" min="0.1" max="3" step="0.1" v-model.number="st.boreSize" /><span class="u">{{ st.boreSize }}</span></div>
        <label class="chk2"><input type="checkbox" v-model="st.showRay" /><span title="从卫星沿方向图 u=v=0 方向射出的一条线，一根天线一条">显示天线视轴</span></label>
        <template v-if="st.showRay">
          <div class="srow sub"><label>颜色</label><input class="clr" type="color" v-model="st.rayColor" title="视轴颜色（两个视图同一套样式）" /></div>
          <div class="srow sub"><label>线宽</label><input class="rng" type="range" min="0.1" max="6" step="0.1" v-model.number="st.rayWidth" /><span class="u">{{ fx(st.rayWidth, 1) }}</span></div>
          <div class="srow sub"><label>透明度</label><input class="rng" type="range" min="0.05" max="1" step="0.05" v-model.number="st.rayOpacity" /><span class="u">{{ fx(st.rayOpacity) }}</span></div>
        </template>
        <label class="chk2"><input type="checkbox" v-model="st.showPeak" /><span title="峰值点处的 dB 读数，随极化 / 增益偏置 / 路径损耗变">显示峰值电平</span></label>
        <div v-if="st.showPeak" class="srow sub"><label>字号</label><input class="rng" type="range" min="0.5" max="30" step="0.5" v-model.number="st.peakSize" /><span class="u">{{ st.peakSize }}</span></div>
        <label class="chk2"><input type="checkbox" v-model="st.showVal" /><span>显示数值标签</span></label>
        <div v-if="st.showVal" class="srow sub"><label>字号</label><input class="rng" type="range" min="0.5" max="30" step="0.5" v-model.number="st.valSize" /><span class="u">{{ st.valSize }}</span></div>
        <!-- 拖动标签位置只在【对地】视图给：可拖标签由对地图层构建时捕获(_dragLabels)，壳层上的标签不在其中。
             壳层视图里开这个模式只会掐掉左键旋转、什么也拖不动，故不出这个入口。 -->
        <div v-if="st.showVal && !isShell" class="srow sub" style="justify-content:flex-start">
          <span class="lnk" :class="{ on: grd.dragLabel.value }" title="开启后在地图上按住拖动数值标签，可沿等值线滑动其位置（释放后保存；再次点击关闭）" @click="grd.setDragLabel(!grd.dragLabel.value)"><Icon v-if="grd.dragLabel.value" name="check" :size="10" /> 拖动标签位置</span>
        </div>
      </template>
    </div>
  </template>
</template>

<style scoped>
/* 与「对地覆盖分析」侧栏（ConstellationMap3D.vue）逐条同源：本组件在两个视图里各挂一次，
   宿主页的 scoped 样式进不来，故这里自带一份。改动请两处对照，别只改一边。 */
.sec { padding: 12px 16px; border-bottom: 1px solid var(--border); }
/* —— 竖向节奏：只有这三条 ——
   相邻两件之间恒 8px；小标题上方拉开 12、下方收紧 6。原来是各件各给单边 margin：
   .srow 只给下、.chk2 只给上 —— 两者相邻时中间那道缝谁也不出，实测 0px（勾选行与它的
   参数行、电平表与线宽行，四处），另有 6/9/16 三种杂值（9 还是内联写死的）。
   ★ 同一套行距共三份：本文件、SatCovPanel.vue、宿主页 ConstellationMap3D.vue。前两处的 .sec
   里只有这套通用行，故写成 `> * + *`；宿主页的 .sec 还装着波束合成 / 可见性分析那些自带间距的
   块（.bs-* / .vis-*），一刀切会把它们撑开，那份改成把同样的间距挂回 .srow/.sect/.chk2 各自的
   margin 上 —— 结果一致，写法不同。改这里请三处对照。 */
.sec > * + * { margin-top: 8px; }
.sec > * + .sect { margin-top: 12px; }
.sec > .sect + * { margin-top: 6px; }
.srow { display: flex; align-items: center; gap: 8px; }
.srow label { color: var(--text-muted); width: 70px; flex: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* ② 勾选行的从属参数（透明度属于「显示等值线」、字号属于「显示波束名」…）：缩进 19px，
   标签正好落在父行文字的起跑线上（复选框 13 + gap 6）；标签列同步由 70 收到 51 —— 两者相加
   仍是 70，故控件列一动不动，三列网格不破。 */
.srow.sub { padding-left: 19px; }
.srow.sub > label { width: 51px; }
.srow select, .srow .ci { flex: 1; min-width: 0; border: 1px solid var(--border); background-color: var(--bg); padding: 3px 6px; font-size: 12px; outline: none; color: var(--text); }
.srow .ci:disabled { background: var(--surface); color: var(--text-faint); cursor: not-allowed; border-style: dashed; }
/* ③ 读数列：钉宽 + 右对齐 + 等宽数字。原来 .u 宽度随文字走（dB / ° / 0.56 / 5 各不同），
   而滑杆是 flex:1 —— 读数宽一格滑杆就短一格，逐行长短不一。钉住之后所有滑杆等长。 */
.srow .u { flex: none; min-width: 34px; text-align: right; color: var(--text-muted); font-variant-numeric: tabular-nums; }
/* 分段控件：连体框 + 段间细线，选中段填墨。全库四处（主窗 / GRD 设置 / 壳层选择 / 对星窗口）
   原来各写各的——有的没圆角、有的没段间线、段内距 10 与 12 两种；此处收成一份口径，四处逐字一致。 */
.seg { display: flex; border: 1px solid var(--border); border-radius: var(--r-ctl); overflow: hidden; }
.seg .sg { padding: 3px 12px; cursor: pointer; color: var(--text-muted); user-select: none; white-space: nowrap; transition: background .12s, color .12s; }
.seg .sg + .sg { border-left: 1px solid var(--border); }
.seg .sg:hover:not(.on) { background: var(--surface-2); color: var(--text); }
.seg .sg.on { background: var(--accent); color: var(--bg); }
/* 选中段是实底，两侧的分隔线压在墨块边上反而脏，去掉 */
.seg .sg.on, .seg .sg.on + .sg { border-left-color: transparent; }
.seg.sm .sg { padding: 2px 7px; font-size: 11px; }
.sect { display: flex; align-items: center; color: var(--text-muted); }
.sect.acc { cursor: pointer; user-select: none; gap: 5px; }
.sect.acc:hover { color: var(--text); }
.sect .lnk { margin-left: auto; color: var(--accent); cursor: pointer; font-size: 11.5px; }
.sect .lnk.on { font-weight: 600; text-decoration: underline; }
.sect .lnk:hover { text-decoration: underline; }
/* 天线设置区标题：撑满分区宽度的标题条（Blender Properties / VS Code 面板头同款） */
.setsect { margin: -12px -16px 10px; padding: 9px 16px; background: var(--surface-2); border-bottom: 1px solid var(--border); }
.setsect .ant-svg { width: 14px; height: 14px; color: var(--accent); margin-right: 6px; flex: none; }
.setsect .setlbl { color: var(--text); font-weight: 600; }
.setsect .setname { margin-left: 6px; color: var(--accent); font-weight: 600; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sect .editing { margin-left: auto; font-size: 9.5px; font-weight: 600; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent); border-radius: var(--r-pill); padding: 1px 6px; }
.chk2 { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.empty { color: var(--text-faint); padding: 4px 0; }
.tip { color: var(--text-faint); font-size: 11px; line-height: 1.5; }
.rng { flex: 1; min-width: 0; }
.ci.bq { width: 100%; border: 1px solid var(--border); background: var(--bg); padding: 3px 6px; font-size: 12px; outline: none; color: var(--text); }
.ic { flex: none; cursor: pointer; color: var(--text-faint); padding: 0 1px; display: inline-flex; }
.ic:hover { color: var(--text); }
.ic.del:hover { color: #e66; }
/* GRD 电平表 */
.glv { border: 1px solid var(--border); border-radius: var(--r-ctl); }
/* 电平表头：与 .glvrow 同一套列宽（20 / 20 / 66 / flex / 删除），内距对齐到各列输入框的文字起点 */
.glvhd { display: flex; align-items: center; gap: 5px; padding: 4px 6px 3px; border-bottom: 1px solid var(--border); color: var(--text-faint); font-size: 9.5px; white-space: nowrap; }
.glvhd > span { overflow: hidden; }
.glvhd .h-clr { flex: none; width: 20px; }
.glvhd .h-val { flex: none; width: 66px; padding-left: 7px; }
.glvhd .h-nm { flex: 1; min-width: 0; padding-left: 6px; }
.glvhd .h-del { flex: none; width: 13px; }
.glvrow { display: flex; align-items: center; gap: 5px; padding: 3px 6px; }
.glvrow + .glvrow { border-top: 1px solid var(--border); }
.glvrow .lvclr { width: 20px; height: 18px; }
.glvrow .lvval { width: 66px; flex: none; background: var(--bg); border: 1px solid var(--border); color: var(--text); font-size: 11.5px; padding: 2px 6px; font-family: var(--font-mono); }
.glvrow .lvabs { flex: 1; color: var(--text-faint); font-family: var(--font-mono); font-size: 11px; }
/* 电平灰色列改可编辑名：默认透明看似纯文字，hover/focus 现边框；有自定义名时字色转常规 */
.glvrow .lvname { min-width: 0; border: 1px solid transparent; background: transparent; padding: 2px 5px; border-radius: var(--r-ctl); outline: none; }
.glvrow .lvname:hover { border-color: var(--border); }
.glvrow .lvname:focus { border-color: var(--accent); background: var(--bg); color: var(--text); }
.glvrow .lvname.named { color: var(--text); }
.glvrow .ic.del:hover { color: #d66; }
.glvadd { padding: 4px 7px; text-align: center; color: var(--text-muted); cursor: pointer; font-size: 11.5px; border-top: 1px solid var(--border); }
.glvadd:hover { color: var(--accent); background: var(--bg); }
/* Beams To Plot 多波束多选列表（SATSOFT 风格） */
.bplist { border: 1px solid var(--border); border-radius: var(--r-ctl); max-height: 300px; min-height: 48px; overflow-y: auto; resize: vertical; }
.brow { display: flex; align-items: center; gap: 6px; padding: 2px 7px; cursor: pointer; font-size: 11.5px; }
.brow + .brow { border-top: 1px solid var(--border); }
.brow:hover { background: var(--bg); }
.brow.on .bnm-in { color: var(--text); }
.brow .bnm-in { flex: 1; min-width: 0; border: 1px solid transparent; background: transparent; color: var(--text-muted); font-size: 11.5px; padding: 1px 4px; border-radius: var(--r-ctl); outline: none; }
.brow .bnm-in:hover { border-color: var(--border); }
.brow .bnm-in:focus { border-color: var(--accent); background: var(--bg); color: var(--text); }
.brow .bseq { flex: none; min-width: 20px; text-align: right; color: var(--text-faint); font-family: var(--font-mono); font-size: 10.5px; }
.brow .bpk { flex: none; color: var(--text-faint); font-family: var(--font-mono); font-size: 10.5px; }
/* Excel 式「(全选)」主行：置顶 sticky、随列表滚动常驻；三态复选框（全/半/无） */
.brow.ball { position: sticky; top: 0; z-index: 1; background: var(--bg); border-bottom: 1px solid var(--border); }
.brow.ball + .brow { border-top: 0; }
.brow .balln { flex: 1; color: var(--text); font-weight: 600; }
/* 对星指向：目标星名与候选片 */
.tgtnm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.tgtnm.bad { color: #d08b5a; }
/* 目标星搜索结果：与主界面搜索下拉（.search .panel/.item）、卫星组管理器同款——
   一行一颗、星名 + 「来源 · NORAD」副行、可滚动，底下一行命中读数。 */
.sres { border: 1px solid var(--border); background: var(--bg); }
.sres-list { max-height: 210px; overflow-y: auto; }
.sitem { padding: 4px 8px; border-bottom: 1px solid var(--border); cursor: pointer; }
.sitem:last-child { border-bottom: 0; }
.sitem:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.sitem .nm { font-size: 12px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sitem .sub { font-size: 10.5px; color: var(--text-faint); font-family: var(--font-mono); }
.sres-e { padding: 6px 8px; font-size: 11.5px; color: var(--text-faint); }
.sres-n { padding: 3px 8px; border-top: 1px solid var(--border); font-size: 10px; color: var(--text-faint); font-family: var(--font-mono); }
</style>
