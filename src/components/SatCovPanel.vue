<script setup>
// 对星覆盖分析 · 侧栏面板。
// ★ 天线设置（波束 / 参数 / 电平 / 填充 / 指向 / 显示）与「对地覆盖分析」是【同一个组件】
//   （GrdSetSections.vue，两边都绑 grd.s）——控件、口径、折叠状态全部一致，改哪边都同步。
//   本面板独有的只有：卫星/天线树的勾选（画哪些天线）、轨道壳层库、掠地高度与参照网。
// 视觉语言也照抄对地侧栏（.sec/.srow/.gtree/.csfoot 一套），两个视图切过去不该有「换了个软件」的感觉。
import { ref, computed } from 'vue'
import Icon from './Icon.vue'
import { isSecOpen, toggleSec } from '../stores/panelSections'
import { appAlert } from '../stores/alert'
import GrdSetSections from './GrdSetSections.vue'

const props = defineProps({
  sc: { type: Object, required: true },      // useShellCoverage
  grd: { type: Object, required: true },     // useGrdCoverage
  satCount: { type: Number, default: 0 },
  satSearch: { type: Function, default: null },    // 目标星搜索（对星跟踪选目标用，全量：星座目录 + 卫星组 + 自定义星座）
  tableOpen: { type: Boolean, default: false },
  satVis: { type: Function, default: () => true }  // 小眼睛状态（与对地视图同一份 iconShow/labelShow）
})
const emit = defineEmits(['open-table', 'pick-shells', 'toggle-eye', 'add-sat', 'edit-sat', 'remove-sat'])

const sc = props.sc, grd = props.grd
const satNodes = computed(() => grd.sats.value.filter((x) => x.kind !== 'elevline'))
const actMeta = computed(() => grd.antMeta())

// 天线名内联重命名（与对地树同一套：editAnt 存正在改的天线 key，editVal 为输入框值）。
// 树本身是共用的，改名/删除走 grd 的同一批方法，本视图的勾选由 useShellCoverage 订阅 grd 变更自动跟随。
const editAnt = ref('')
const editVal = ref('')
function startRenameAnt(sat, a) { editAnt.value = grd.keyOf(sat.folder, a.name); editVal.value = a.name }
function commitRenameAnt(sat, a) {
  if (editAnt.value === '') return    // 已提交（blur 与 ✓/回车可能重复触发）→ 跳过
  if (grd.renameAntenna(sat.folder, a.name, editVal.value) === false) {
    appAlert('天线名为空或与同星其他天线重名')   // 校验失败 → 保持编辑态，可继续修改
    return
  }
  editAnt.value = ''
}

const newAlt = ref(550)
function addShellFromInput() {
  const v = Number(newAlt.value)
  if (Number.isFinite(v) && v > 0) sc.addShell(v)
}
// 预置项按【下标】取（早先只把 altKm 当 option 值，名字与颜色到不了 addShell，加进来一律是无名青色）
function addPreset(e) {
  const p = sc.presetShells()[Number(e.target.value)]
  if (p) sc.addShell(p.altKm, p.name, p.color)
  e.target.value = ''
}
// 壳层高于源星 → 每条射线只有一个交点，「近/远」无意义。真正的分支判定在 shellGeom().inside 里按精确 |S| 算
function singleBranch(sh) {
  const m = actMeta.value
  return !!m && sh.altKm >= (m.satAlt || 0)
}
// 该壳层这一轮为什么是空的（'' = 画出来了）
function shellWhy(sh) {
  if (!sc.selected.value.length) return ''
  const e = sc.shellStatus.value[sh.id]
  return e && !e.tris ? e.why : ''
}
</script>

<template>
  <div class="cov-side satcov-side docked">
    <!-- 卫星 / 天线：与对地【同一棵树】（同一份数据、增删改在哪边做都一样），勾选＝画在壳层上。
         唯一的区别是「画哪些」各存一份：本视图勾选的天线不影响对地视图，反之亦然。
         仰角线是纯对地概念（等仰角环画在地表），本树按 kind 过滤掉，也不提供「加仰角线」。 -->
    <div class="sec">
      <div class="sect acc" :class="{ open: isSecOpen('satcov-tree') }" @click="toggleSec('satcov-tree')">
        <Icon :name="isSecOpen('satcov-tree') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>卫星 / 天线</span>
        <span v-if="sc.selected.value.length" class="editing">{{ sc.selected.value.length }} 已选</span>
        <span class="lnk" title="添加自定义卫星，或从星座点选/搜索关联卫星" @click.stop="emit('add-sat')"><Icon name="plus" :size="11" /> 卫星</span>
      </div>
      <template v-if="isSecOpen('satcov-tree')">
        <div class="gtree">
          <div v-if="!satNodes.length" class="empty">还没有卫星。</div>
          <template v-for="sat in satNodes" :key="sat.folder">
            <div class="gsat">
              <i class="tri" :class="{ open: grd.isExpanded(sat.folder) }" @click="grd.toggleExpand(sat.folder)"><Icon name="chevron-right" :size="10" /></i>
              <input type="checkbox" class="gck" :checked="sc.satState(sat) === 'all'" :indeterminate.prop="sc.satState(sat) === 'some'"
                     :disabled="!sat.antennas.length" :title="sat.antennas.length ? '全选 / 全不选该星天线' : '该星暂无天线'" @change="sc.toggleSatAll(sat)" />
              <svg class="gsvg sat-svg" viewBox="0 0 120 120" fill="currentColor" aria-hidden="true">
                <g transform="rotate(-20 60 60)">
                  <rect x="8" y="41" width="10" height="16" rx="3" /><rect x="21" y="41" width="10" height="16" rx="3" /><rect x="34" y="41" width="10" height="16" rx="3" />
                  <rect x="8" y="63" width="10" height="16" rx="3" /><rect x="21" y="63" width="10" height="16" rx="3" /><rect x="34" y="63" width="10" height="16" rx="3" />
                  <rect x="76" y="41" width="10" height="16" rx="3" /><rect x="89" y="41" width="10" height="16" rx="3" /><rect x="102" y="41" width="10" height="16" rx="3" />
                  <rect x="76" y="63" width="10" height="16" rx="3" /><rect x="89" y="63" width="10" height="16" rx="3" /><rect x="102" y="63" width="10" height="16" rx="3" />
                  <rect x="49" y="35" width="22" height="50" rx="10" />
                </g>
              </svg>
              <span class="gsname" @click="grd.toggleExpand(sat.folder)" :title="sat.satName">{{ sat.satName }}<em v-if="sat.antennas.length">{{ sat.antennas.length }}</em><i v-if="sat.elements" class="simtag" title="轨道根数模拟星：星下点随时间移动">轨</i></span>
              <!-- 小眼睛：与对地视图同一个开关（图标 + 卫星名）；本视图另附「聚焦特效」——
                   画出波束的星连同它对星跟踪的目标星一起点亮轨道圈/星下点轨迹/覆盖足迹（不弹信息卡） -->
              <span class="sdisp">
                <span class="ic" :class="{ on: satVis(sat) }" title="显示 / 隐藏该卫星（图标 + 名称）；点亮时，已画波束的星连同其对星跟踪的目标星一并显示轨道圈 / 星下点轨迹 / 覆盖足迹" @click.stop="emit('toggle-eye', sat)"><Icon :name="satVis(sat) ? 'eye' : 'eye-off'" :size="12" /></span>
              </span>
              <span class="sacts">
                <span class="ic" title="导入 GRD：在该星下新建天线（新天线自动勾选，直接画到壳层上）" @click.stop="sc.importGrd(sat)"><Icon name="plus" :size="11" /></span>
                <span class="ic" title="编辑卫星 / 仰角线 / 颜色" @click.stop="emit('edit-sat', sat)"><Icon name="pencil" :size="11" /></span>
                <span class="ic del" title="删除卫星（含其天线）" @click.stop="emit('remove-sat', sat)"><Icon name="x" :size="11" /></span>
              </span>
            </div>
            <div v-if="grd.isExpanded(sat.folder)" class="gbody">
              <div v-if="!sat.antennas.length" class="gant noant">暂无天线。</div>
              <template v-for="a in sat.antennas" :key="a.name">
                <div class="gant" :class="{ on: sc.isSelected(grd.keyOf(sat.folder, a.name)), foc: sc.isActive(grd.keyOf(sat.folder, a.name)) }"
                     title="点击编辑该天线参数（不影响是否显示）" @click="sc.setActive(sat, a)">
                  <input type="checkbox" class="gck" title="勾选＝把该天线的波束画到轨道壳层上" :checked="sc.isSelected(grd.keyOf(sat.folder, a.name))" @click.stop @change="sc.toggleAnt(sat, a)" />
                  <span class="ant-btn" :class="{ on: sc.isSelected(grd.keyOf(sat.folder, a.name)) }" @click.stop="sc.toggleAnt(sat, a)">
                    <svg v-if="sc.isSelected(grd.keyOf(sat.folder, a.name))" class="gsvg ant-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M4 10a7.31 7.31 0 0 0 10 10Z" /><path d="m9 15 3-3" /><path d="M17 13a6 6 0 0 0-6-6" /><path d="M21 13A10 10 0 0 0 11 3" />
                    </svg>
                    <svg v-else class="gsvg ant-svg ant-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M4 10a7.31 7.31 0 0 0 10 10Z" /><path d="m9 15 3-3" />
                    </svg>
                  </span>
                  <template v-if="editAnt === grd.keyOf(sat.folder, a.name)">
                    <input class="aname-in" v-model="editVal" @click.stop @keydown.enter="commitRenameAnt(sat, a)" @blur="commitRenameAnt(sat, a)" />
                    <span class="ic ok" title="确认重命名" @mousedown.prevent @click.stop="commitRenameAnt(sat, a)"><Icon name="check" :size="11" /></span>
                  </template>
                  <template v-else>
                    <span class="aname" title="双击重命名" @dblclick.stop="startRenameAnt(sat, a)">{{ a.name }}</span>
                    <span v-if="sc.isActive(grd.keyOf(sat.folder, a.name))" class="afoc">编辑中</span>
                    <span class="sacts">
                      <span class="ic" title="重命名天线" @click.stop="startRenameAnt(sat, a)"><Icon name="pencil" :size="11" /></span>
                      <span class="ic del" title="删除天线" @click.stop="grd.removeAntenna(sat.folder, a.name)"><Icon name="x" :size="11" /></span>
                    </span>
                  </template>
                </div>
                <div class="gperf" :class="{ on: tableOpen && sc.isActive(grd.keyOf(sat.folder, a.name)) }" title="打开该天线的对星性能指标表" @click.stop="sc.setActive(sat, a); emit('open-table')">
                  <svg class="gsvg perf-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /><path d="M3 15h18" /><path d="M9 3v18" />
                  </svg>
                  <span class="gperfn">对星性能指标表</span>
                </div>
              </template>
            </div>
          </template>
        </div>
      </template>
    </div>

    <!-- 轨道壳层（本视图独有）：波束投到哪些球壳上 -->
    <div class="sec">
      <div class="sect acc" :class="{ open: isSecOpen('satcov-shell') }" @click="toggleSec('satcov-shell')">
        <Icon :name="isSecOpen('satcov-shell') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>轨道壳层</span>
        <span class="lnk" title="从全量在轨目录里挑壳层（可看清每层是哪些星座、哪些星）" @click.stop="emit('pick-shells')">从星座取…</span>
      </div>
      <template v-if="isSecOpen('satcov-shell')">
        <!-- 一层壳 = 一行控件 + 可选的一行归因。两者必须同在 v-for 里（归因那行要读 sh），
             拆到 v-for 外面 sh 就出了作用域 —— 渲染函数当场抛错，整个面板白屏。 -->
        <div class="shlist">
          <template v-for="sh in sc.shells.value" :key="sh.id">
            <div class="shrow">
              <input type="checkbox" :checked="sh.show" title="显示 / 隐藏该层壳的覆盖" @change="sc.updateShell(sh.id, { show: !sh.show })" />
              <input class="lvclr" type="color" title="壳层参照网颜色" :value="sh.color" @change="sc.updateShell(sh.id, { color: $event.target.value })" />
              <input class="shalt" type="number" step="10" :value="sh.altKm" title="轨道高度（不是地心半径）：壳层地心半径 = 6378.137 + 该值。与卫星列表里的「高度」同一口径"
                     @change="sc.updateShell(sh.id, { altKm: Number($event.target.value) || sh.altKm })" /><span class="u">km</span>
              <span class="shnm" :title="sh.name">{{ sh.name }}</span>
              <select v-if="!singleBranch(sh)" class="shbr" :value="sh.branch" @change="sc.updateShell(sh.id, { branch: $event.target.value })">
                <option value="both">近+远</option><option value="near">近侧</option><option value="far">远侧</option>
              </select>
              <span v-else class="shbr one" title="壳层高于源星：一条射线只有一个交点">单支</span>
              <span class="ic del" title="删除壳层" @click="sc.removeShell(sh.id)"><Icon name="x" :size="11" /></span>
            </div>
            <div v-if="sh.show && shellWhy(sh)" class="shwhy">{{ shellWhy(sh) }}</div>
          </template>
          <div v-if="!sc.shells.value.length" class="empty">还没有壳层。</div>
        </div>
        <div class="srow shadd">
          <input class="ci shalt" type="number" step="50" v-model.number="newAlt" /><span class="u">km</span>
          <span class="addb" @click="addShellFromInput"><Icon name="plus" :size="11" /> 加壳层</span>
          <select class="ci shpre" @change="addPreset($event)">
            <option value="">预置…</option>
            <option v-for="(p, i) in sc.presetShells()" :key="p.name" :value="i">{{ p.name }}</option>
          </select>
        </div>
        <div class="srow"><label>掠地高度</label><input class="ci" type="number" step="10" min="0" v-model.number="sc.s.hEx"
             title="视线掠过地球表面的最低高度：低于此高度的路径按被地球挡住处理（把地球膨胀这么多再判遮挡）。0 = 纯几何遮挡" /><span class="u">km</span></div>
        <label class="chk2"><input type="checkbox" v-model="sc.s.guides" /><span>显示壳层参照网</span></label>
      </template>
    </div>

    <!-- 天线设置四区：与「对地覆盖分析」同一个组件 -->
    <GrdSetSections :grd="grd" variant="shell" :sat-search="satSearch" />

    <div class="csfoot">
      <span class="cst" :title="sc.stats.value.fullMs ? '几何 ' + sc.stats.value.ms + ' ms + GPU 重建，整轮 ' + sc.stats.value.fullMs + ' ms。播放时一拍就要这么久，时钟据此拉开两拍的间隔' : ''">{{ sc.stats.value.layers }} 层 · {{ sc.stats.value.tris }} 面片 · {{ sc.stats.value.fullMs || sc.stats.value.ms }} ms · {{ satCount }} 星在场</span>
      <span class="cclr" title="清空壳层上的填充/等值线，保留各天线设置与壳层库" @click="sc.clearDrawing()">清除绘图</span>
    </div>
  </div>
</template>

<style scoped>
/* 与「对地覆盖分析」侧栏同源（ConstellationMap3D.vue 的 .cov-side/.gtree 一套）：那份是 scoped 的、
   进不到本组件，故这里带一份同值副本。改动请两处对照。 */
.cov-side { width: 286px; flex: none; border-left: 1px solid var(--border-strong); background: var(--surface); overflow-y: auto; display: flex; flex-direction: column; font-size: 12px; }
.cov-side.docked { width: auto; border-left: 0; overflow: visible; }
.sec { padding: 12px 16px; border-bottom: 1px solid var(--border); }
.srow { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.srow:last-child { margin-bottom: 0; }
.srow label { color: var(--text-muted); width: 70px; flex: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.srow select, .srow .ci { flex: 1; min-width: 0; border: 1px solid var(--border); background: var(--bg); padding: 3px 6px; font-size: 12px; outline: none; color: var(--text); }
.srow .u { color: var(--text-muted); }
.sect { display: flex; align-items: center; margin-bottom: 6px; color: var(--text-muted); }
.sect.acc { cursor: pointer; user-select: none; gap: 5px; }
.sect.acc:hover { color: var(--text); }
.sect .lnk { margin-left: auto; color: var(--accent); cursor: pointer; font-size: 11.5px; }
.sect .lnk:hover { text-decoration: underline; }
.sect .editing { margin-left: auto; font-size: 9.5px; font-weight: 600; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent); border-radius: 8px; padding: 1px 6px; }
.sect .editing + .lnk { margin-left: 0; }   /* 「n 已选」在时由它顶到右边，链接紧随其后（两个 auto 会把空白对半分） */
.chk2 { display: flex; align-items: center; gap: 6px; margin-top: 8px; cursor: pointer; }
.chk2 input, .shrow input, .gck { accent-color: var(--accent); }
.empty { color: var(--text-faint); padding: 4px 0; }
.ic { flex: none; cursor: pointer; color: var(--text-faint); padding: 0 1px; display: inline-flex; }
.ic:hover { color: var(--text); }
.ic.del:hover { color: #e66; }
/* 卫星 / 天线树（与对地同款两级层次） */
.gtree { margin-top: 6px; max-height: clamp(280px, 48vh, 620px); overflow-y: auto; }
.gsat { display: flex; align-items: center; gap: 6px; padding: 4px 4px 4px 2px; color: var(--text); font-size: 13px; border-radius: 3px; }
.gsat:hover { background: color-mix(in srgb, var(--text) 5%, transparent); }
.gsat .tri { font-style: normal; flex: none; width: 12px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-faint); font-size: 9px; cursor: pointer; transition: transform .12s; }
.gsat .tri.open { transform: rotate(90deg); }
.gsat .gsname { flex: 1; min-width: 0; white-space: normal; overflow-wrap: break-word; line-height: 1.3; cursor: pointer; }
.gsat .gsname:hover { color: var(--accent); }
.gsat .gsname em { font-style: normal; margin-left: 5px; color: var(--text-faint); font-family: var(--font-mono); font-size: 10.5px; }
.gsat .gsname .simtag { font-style: normal; margin-left: 5px; padding: 0 4px; border: 1px solid var(--accent); border-radius: 2px; color: var(--accent); font-size: 10px; vertical-align: middle; }
.gsvg { flex: none; width: 14px; height: 14px; }
.gsat .sat-svg { width: 18px; height: 18px; color: var(--text); opacity: .92; }
/* 卫星行的小眼睛：与对地侧栏 .sdisp 同款（图标按钮，hover 底色淡入，点亮转 accent） */
.sdisp { flex: none; display: flex; align-items: center; gap: 1px; margin-left: 4px; padding-left: 6px; border-left: 1px solid var(--border); }
.sdisp .ic { display: flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 3px; color: var(--text-faint); opacity: .55; cursor: pointer; transition: opacity .12s, color .12s, background .12s; }
.sdisp .ic:hover { opacity: 1; color: var(--text); background: color-mix(in srgb, var(--text) 8%, transparent); }
.sdisp .ic.on { opacity: 1; color: var(--accent); }
.gbody { margin-left: 9px; padding-left: 12px; border-left: 1px solid var(--border); margin-bottom: 2px; }
.gant { display: flex; align-items: center; gap: 6px; padding: 3px 6px; margin: 1px 0; color: var(--text-muted); cursor: pointer; font-size: 11.5px; border-radius: 3px; transition: background .12s, color .12s, box-shadow .12s; }
.gant:hover { color: var(--text); background: color-mix(in srgb, var(--text) 6%, transparent); }
.gant.on { color: var(--text); }
.gant.foc { color: var(--text); background: color-mix(in srgb, var(--accent) 14%, transparent); box-shadow: inset 2px 0 0 var(--accent); font-weight: 600; }
.gant .aname { flex: 1; min-width: 0; white-space: normal; overflow-wrap: break-word; word-break: break-word; line-height: 1.35; }
.gant .aname-in { flex: 1; min-width: 0; border: 1px solid var(--accent); background: var(--bg); padding: 1px 5px; font-size: 11.5px; color: var(--text); outline: none; }
.gant .afoc { flex: none; font-size: 9.5px; font-weight: 600; letter-spacing: .3px; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent); border-radius: 8px; padding: 0 5px; line-height: 14px; }
/* 行内次级操作（卫星行 ＋✎✕ / 天线行 ✎✕ 共用）：常驻但弱化淡灰，hover 该行变亮 */
.sacts { flex: none; display: flex; align-items: center; gap: 8px; margin-left: auto; padding-left: 4px; }
.sacts .ic { font-size: 11px; color: var(--text-faint); opacity: .5; cursor: pointer; padding: 0; transition: opacity .12s, color .12s; }
.gsat:hover .sacts .ic, .gant:hover .sacts .ic { opacity: .9; }
.sacts .ic:hover { color: var(--text); opacity: 1; }
.sacts .ic.del:hover { color: #e66; }
.ic.ok { color: #5fbf6a; font-weight: 700; }
.ic.ok:hover { color: #7ddc88; }
.gant.noant { color: var(--text-faint); font-style: italic; cursor: default; padding-left: 6px; }
.gant.noant:hover { background: none; color: var(--text-faint); }
.gant .ant-btn { display: flex; align-items: center; justify-content: center; flex: none; width: 18px; height: 18px; margin: -2px 0; border-radius: 3px; transition: background .12s; }
.gant .ant-btn:hover { background: color-mix(in srgb, var(--accent) 18%, transparent); }
.gant .ant-svg { width: 13px; height: 13px; color: var(--text-faint); transition: color .12s; }
.gant .ant-btn.on .ant-svg { color: var(--accent); }
.gant .ant-svg.ant-off { color: var(--text-faint); opacity: .7; }
.gant.foc .ant-svg { color: var(--accent); }
.gperf { display: flex; align-items: center; gap: 6px; margin: 0 0 2px 22px; padding: 2px 6px; color: var(--text-faint); cursor: pointer; font-size: 11px; border-radius: 3px; transition: background .12s, color .12s; }
.gperf:hover { color: var(--text-muted); background: color-mix(in srgb, var(--text) 5%, transparent); }
.gperf .perf-svg { width: 12px; height: 12px; flex: none; }
.gperf .gperfn { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gperf.on { color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
/* 壳层库：与电平表同款成框列表 */
.shlist { border: 1px solid var(--border); border-radius: 2px; margin-top: 5px; }
.shrow { display: flex; align-items: center; gap: 5px; padding: 3px 6px; }
.shrow + .shrow { border-top: 1px solid var(--border); }
.shrow .lvclr { width: 20px; height: 18px; padding: 0; border: 1px solid var(--border); background: none; cursor: pointer; flex: none; }
.shrow .u { color: var(--text-faint); font-size: 10.5px; }
.shalt { width: 58px; flex: none; background: var(--bg); border: 1px solid var(--border); color: var(--text); font-size: 11.5px; padding: 2px 4px; font-family: var(--font-mono); text-align: right; }
.shnm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); font-size: 10.5px; }
.shbr { flex: none; width: 56px; background: var(--bg); border: 1px solid var(--border); color: var(--text); font-size: 10.5px; padding: 1px 2px; }
.shbr.one { color: var(--text-faint); text-align: center; border-color: transparent; }
.shwhy { padding: 0 8px 4px 32px; font-size: 10.5px; color: #d08b5a; }
.shadd { margin-top: 7px; gap: 6px; }
.shadd .shalt { flex: none; }
.shadd .shpre { flex: 1; font-size: 11px; }
.addb { flex: none; display: inline-flex; align-items: center; gap: 3px; border: 1px solid var(--border); padding: 2px 8px; font-size: 11.5px; color: var(--text-muted); cursor: pointer; border-radius: 2px; }
.addb:hover { border-color: var(--accent); color: var(--text); }
.csfoot { margin-top: auto; display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--border); }
.cst { font-size: 11px; color: var(--text-faint); font-family: var(--font-mono); }
.cclr { margin-left: auto; font-size: 11.5px; color: var(--text-muted); border: 1px solid var(--border); padding: 3px 10px; cursor: pointer; white-space: nowrap; }
.cclr:hover { border-color: var(--accent); color: var(--text); }
</style>
