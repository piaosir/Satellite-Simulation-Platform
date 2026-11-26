<script setup>
// 对星覆盖分析 · 侧栏面板。
// ★ 天线设置（波束 / 参数 / 电平 / 填充 / 指向 / 显示）与「对地覆盖分析」是【同一个组件】
//   （GrdSetSections.vue，两边都绑 grd.s）——控件、口径、折叠状态全部一致，改哪边都同步。
//   本面板独有的只有：卫星/天线树的勾选（画哪些天线）、轨道壳层库、掠地高度与参照网。
// 视觉语言也照抄对地侧栏（.sec/.srow/.gtree/.csfoot 一套），两个视图切过去不该有「换了个软件」的感觉。
import { ref, computed } from 'vue'
import Icon from './Icon.vue'
import CoverageAngleTreeRow from './CoverageAngleTreeRow.vue'
import PerfTreeRow from './PerfTreeRow.vue'
import CoverageSidebar from './CoverageSidebar.vue'
import CoverageTreeIcon from './CoverageTreeIcon.vue'
import { isSecOpen, toggleSec } from '../stores/panelSections'
import { appAlert } from '../stores/alert'
import GrdSetSections from './GrdSetSections.vue'
import { treeNavState, nodeLinkId } from '../viz/grd/treeLink.js'

const props = defineProps({
  sc: { type: Object, required: true },      // useShellCoverage
  grd: { type: Object, required: true },     // useGrdCoverage
  satelliteEditor: Object,
  satCount: { type: Number, default: 0 },
  satSearch: { type: Function, default: null },    // 目标星搜索（对星跟踪选目标用，全量：星座目录 + 卫星组 + 自定义星座）
  tables: { type: Object, required: true },
  delArm: { type: String, default: '' },
  tableOpenKeys: { type: Object, default: () => new Set() },   // 开着对星性能指标表窗口的表 key 集
  satVis: { type: Function, default: () => true },  // 小眼睛状态（与对地视图同一份 iconShow/labelShow）
  selFolders: { type: Object, default: () => new Set() },   // 星座选中集关联着的 folder（卫星行 cur 回显，宿主 selFolderSet）
  linkMiss: { type: Object, default: () => new Set() },     // 关联星不在当前星历的 folder（卫星行告警，宿主 linkMissSet）
  followId: { type: String, default: '' },                  // 正在跟随的星的 NORAD（'' = 没在跟随，宿主 followLinkId；3D / 2D 都算）
  geoIds: { type: Object, default: () => new Map() }        // 天线树定点同步星 folder → 合成号（宿主 treeGeoIdMap；它们在星座里有条目）
})
// focus-sat(sat, force, additive)：树 → 星座聚焦（天线行点击 force=false 看小眼睛；双击星名 / 「聚焦」钮 force=true；
//   「聚焦」钮恒 additive=true：单击加入 / 移出聚焦集）
// follow-sat(sat)：「跟随」钮（宿主 followTreeSat：跟随该星 / 正跟随它则退出）
// tree-menu(ev, sat, antenna?, tableId?)：两种覆盖视图共用树节点菜单与删除确认。
// open-synth(groupId)：「方向图」节「在波束合成中编辑」，转给宿主
const emit = defineEmits(['close-satellite', 'open-table', 'pick-shells', 'toggle-eye', 'add-sat', 'edit-sat', 'remove-sat', 'remove-ant', 'remove-table', 'focus-sat', 'follow-sat', 'tree-menu', 'angle-menu', 'rename-table', 'open-synth'])
function openAngleMenu(ev, id) { emit('angle-menu', ev, id) }

const sc = props.sc, grd = props.grd
const satNodes = computed(() => grd.sats.value.filter((x) => x.kind !== 'elevline'))
function addStandaloneElevation() {
  sc.angleLines.add('', 'elevation', { position: { lon: 0, lat: 0, altKm: 35786 } })
}
const actMeta = computed(() => grd.antMeta())
// 卫星行「聚焦 / 跟随」两钮的状态：与对地树同一个判据（treeLink.treeNavState），按 folder 查
const navMap = computed(() => {
  const m = new Map()
  for (const n of satNodes.value) m.set(n.folder, treeNavState(n, { cur: props.selFolders.has(n.folder), miss: props.linkMiss.has(n.folder), followId: props.followId, linkId: nodeLinkId(n, props.geoIds) }))
  return m
})
const navOf = (sat) => navMap.value.get(sat.folder) || treeNavState(sat)
function onFocusBtn(sat) { if (!navOf(sat).focusDis) emit('focus-sat', sat, true, true) }   // 单击＝加入 / 移出聚焦集
function onFollowBtn(sat) { if (!navOf(sat).followDis) emit('follow-sat', sat) }

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

// 天线行点击：设为编辑对象（不转到导入时的旧峰值点）→ 宿主按卫星此刻位置聚焦（小眼睛灭着不动）
function showAntenna() { emit('close-satellite'); sc.angleLines.editing.value = '' }
async function onAntClick(sat, a) {
  showAntenna()
  if (await sc.setActive(sat, a, { face: false })) emit('focus-sat', sat, false)
}
const newAlt = ref(550)
const addMenu = ref(null)
const heightOrder = ref(0)
const shellRows = computed(() => heightOrder.value
  ? [...sc.shells.value].sort((a, b) => heightOrder.value * (a.altKm - b.altKm))
  : sc.shells.value)
function sortHeight() { heightOrder.value = heightOrder.value === 1 ? -1 : heightOrder.value === -1 ? 0 : 1 }
function addShellFromInput() {
  const v = Number(newAlt.value)
  if (Number.isFinite(v) && v > 0) { sc.addShell(v); addMenu.value?.hidePopover() }
}
// 预置项按【下标】取（早先只把 altKm 当 option 值，名字与颜色到不了 addShell，加进来一律是无名青色）
function addPreset(e) {
  const p = sc.presetShells()[Number(e.target.value)]
  if (p) { sc.addShell(p.altKm, p.name, p.color); addMenu.value?.hidePopover() }
  e.target.value = ''
}
// ==================== 壳层高度就地编辑 ====================
// 正在输入的那一格用【本地草稿】顶住。早先这格是一次性的 :value + @change，两处会跳变：
//   ① 被后台重算改写回旧值：每轮 recompute 都重写 stats/shellStatus（读数行与空层归因都在本面板），
//      面板整块重渲染，而 Vue 对 <input> 的 value 是【无条件回写】的（patchProp 里 value 不比对新旧
//      vnode）——播放时钟一开、或上一次改动的重算落地，正打到一半的数字就被旧值盖掉；
//   ② 微调箭头把新输入吸到旧值的台阶上：箭头的「台阶基准」取 value 属性（Vue 只在重渲染时同步它，
//      ＝上次提交的高度）。基准与显示不一致时，浏览器按 基准 + k×step 吸附 ——
//      旧值 1002.1、输入 39680、点一下 ▲ ＝ 39682.1（截图里那个数）。
// 草稿一并解决：渲染出去的就是用户正在打的那串 → 无条件回写写的是同一个值（等值不落笔、光标不动），
// value 属性也随之跟到当前值上 → 箭头就是「当前值 ±step」。
const altEdit = ref(null)      // { id, text }：只存正在编辑的那一格
const altText = (sh) => (altEdit.value && altEdit.value.id === sh.id ? altEdit.value.text : String(sh.altKm))
function altInput(sh, e) { altEdit.value = { id: sh.id, text: e.target.value } }
function altCommit(sh) {
  const d = altEdit.value
  if (!d || d.id !== sh.id) return
  altEdit.value = null                    // 先退出草稿：空值/非法输入靠这一步让显示回落到原高度
  const v = Number(d.text)
  if (Number.isFinite(v) && v > 0 && v !== sh.altKm) sc.updateShell(sh.id, { altKm: v })
}
function altCancel(e) { altEdit.value = null; e.target.blur() }
// 滚轮：Chromium 把滚轮当微调轮使（输入框带焦点时），侧栏一滚高度就被悄悄改掉 → 焦点在本格时吃掉滚轮
function altWheel(e) { if (e.target === document.activeElement) e.preventDefault() }

// 壳层高于源星 → 每条射线只有一个交点，「近/远」无意义。真正的分支判定在 shellGeom().inside 里按精确 |S| 算
function singleBranch(sh) {
  const m = actMeta.value
  return !!m && sh.altKm >= (m.satAlt || 0)
}
// 该壳层这一轮为什么是空的（'' = 画出来了）
function placeShellMenu(event) {
  if (event.newState !== 'open') return
  const menu = event.currentTarget
  const rect = menu.previousElementSibling.getBoundingClientRect()
  const right = Math.min(window.innerWidth - menu.offsetWidth - 4, window.innerWidth - rect.right)
  menu.style.right = Math.max(4, right) + 'px'
  menu.style.top = (rect.bottom + menu.offsetHeight + 4 < window.innerHeight ? rect.bottom + 2 : Math.max(4, rect.top - menu.offsetHeight - 2)) + 'px'
}
function shellWhy(sh) {
  if (!sc.selected.value.length) return ''
  const e = sc.shellStatus.value[sh.id]
  return e && !e.tris ? e.why : ''
}
</script>

<template>
  <CoverageSidebar class="satcov-side" tree-id="satcov-tree" :grd="grd" :lines="sc.angleLines" :satellite="satelliteEditor" @close-satellite="emit('close-satellite')" :shells="sc.shells.value" :selected-count="sc.selected.value.length">
    <template #satellite><slot name="satellite" /></template>
    <template #heading><div data-sec="satcov-tree"><span>卫星 / 天线</span></div></template>
    <template #actions>
        <button type="button" class="lnk" title="添加自定义卫星，或从星座点选/搜索关联卫星" @click.stop="emit('add-sat')"><Icon name="plus" :size="12" /> 卫星</button>
        <button type="button" class="lnk" title="添加独立仰角线" @click.stop="addStandaloneElevation"><Icon name="plus" :size="12" /> 独立仰角线</button>
    </template>
    <template #tree>
        <div class="gtree">
          <CoverageAngleTreeRow v-for="line in sc.angleLines.list('', 'elevation')" :key="line.id"
                                :line="line" :collection="sc.angleLines" @menu="openAngleMenu" />
          <div v-if="!satNodes.length && !sc.angleLines.list('', 'elevation').length" class="empty">暂无卫星。</div>
          <template v-for="sat in satNodes" :key="sat.folder">
            <div class="gsat" :class="{ cur: selFolders.has(sat.folder), 'sat-editing': satelliteEditor?.folder === sat.folder }" :data-folder="sat.folder" @contextmenu.prevent.stop="emit('tree-menu', $event, sat)">
              <button type="button" class="tri" :class="{ open: grd.isExpanded(sat.folder) }" :title="grd.isExpanded(sat.folder) ? '收起' : '展开'" :aria-label="grd.isExpanded(sat.folder) ? '收起' : '展开'" :aria-expanded="grd.isExpanded(sat.folder) ? 'true' : 'false'" @click="grd.toggleExpand(sat.folder)"><Icon name="chevron-right" :size="12" /></button>
              <input type="checkbox" class="gck" :checked="sc.satState(sat) === 'all'" :indeterminate.prop="sc.satState(sat) === 'some'"
                     :disabled="!sat.antennas.length" :title="sat.antennas.length ? '全选 / 全不选该星天线' : '该星暂无天线'" @change="sc.toggleSatAll(sat)" />
              <button type="button" class="ibtn sat-toggle" :aria-pressed="satVis(sat)"
                      title="显示 / 隐藏该卫星（图标 + 名称）；点亮时，已画波束的星连同其对星跟踪的目标卫星一并显示轨道圈 / 星下点轨迹 / 覆盖足迹" @click.stop="emit('toggle-eye', sat)">
                <CoverageTreeIcon kind="satellite" :visible="satVis(sat)" />
              </button>
              <button type="button" class="gsname" @click="emit('edit-sat', sat)" @dblclick.stop="emit('focus-sat', sat, true)" :title="sat.satName">{{ sat.satName }}<em v-if="sat.antennas.length">{{ sat.antennas.length }}</em><i v-if="sat.elements" class="simtag" title="轨道根数模拟星：星下点随时间移动">轨</i></button>
              <span v-if="linkMiss.has(sat.folder)" class="lmiss" :title="`关联卫星 NORAD ${sat.noradId} 不在当前星历中`"><Icon name="alert-triangle" :size="12" /></span>
              <!-- 聚焦 / 跟随该星：与对地树同款两钮。
                   小眼睛：与对地视图同一个开关（图标 + 卫星名）；本视图另附「聚焦特效」——
                   画出波束的星连同它对星跟踪的目标卫星一起点亮轨道圈/星下点轨迹/覆盖足迹（不弹信息卡） -->
              <span class="sdisp">
                <button type="button" :aria-disabled="(navOf(sat).focusDis) ? 'true' : null" :aria-pressed="(navOf(sat).focusOn) ? 'true' : 'false'" class="ibtn sm" :class="{ on: navOf(sat).focusOn, dis: navOf(sat).focusDis }" :title="navOf(sat).focusTip" @click.stop="onFocusBtn(sat)"><Icon name="crosshair" :size="12" /></button>
                <button type="button" :aria-disabled="(navOf(sat).followDis) ? 'true' : null" :aria-pressed="(navOf(sat).followOn) ? 'true' : 'false'" class="ibtn sm" :class="{ on: navOf(sat).followOn, dis: navOf(sat).followDis }" :title="navOf(sat).followTip" @click.stop="onFollowBtn(sat)"><Icon name="locate-fixed" :size="12" /></button>

              </span>
              <span class="sacts">
                <button type="button" class="ibtn sm tree-add" aria-haspopup="menu" title="添加天线或仰角线" @click.stop="emit('tree-menu', $event, sat)"><Icon name="plus" :size="14" /></button>
                <button type="button" class="ibtn sm" title="编辑卫星" @click.stop="emit('edit-sat', sat)"><Icon name="pencil" :size="12" /></button>
                <button type="button" class="del ibtn sm danger" :class="{ arm: delArm === 'sat:' + sat.folder }" :title="delArm === 'sat:' + sat.folder ? '再点一次删除（GRD 原件移入回收站）' : '删除卫星（含其天线）'" @click.stop="emit('remove-sat', sat)"><Icon v-if="delArm !== 'sat:' + sat.folder" name="x" :size="12" /><template v-else>确认删除</template></button>
              </span>
            </div>
            <div v-if="grd.isExpanded(sat.folder)" class="gbody">
              <CoverageAngleTreeRow v-for="line in sc.angleLines.list(sat.folder, 'elevation')" :key="line.id"
                                    :line="line" :collection="sc.angleLines" @menu="openAngleMenu" />
              <div v-if="!sat.antennas.length && !sc.angleLines.list(sat.folder, 'elevation').length" class="gant noant">暂无天线。</div>
              <template v-for="a in sat.antennas" :key="a.name">
                <div class="gant" :class="{ on: sc.isSelected(grd.keyOf(sat.folder, a.name)), foc: !satelliteEditor && !sc.angleLines.editing.value && sc.isActive(grd.keyOf(sat.folder, a.name)) }" @contextmenu.prevent.stop="emit('tree-menu', $event, sat, a)"
                     title="点击编辑该天线参数（不影响是否显示）" @click="onAntClick(sat, a)">
                  <input type="checkbox" class="gck" title="勾选＝把该天线的波束画到轨道壳层上" :checked="sc.isSelected(grd.keyOf(sat.folder, a.name))" @click.stop @change="sc.toggleAnt(sat, a)" />
                  <button type="button" :aria-pressed="(sc.isSelected(grd.keyOf(sat.folder, a.name))) ? 'true' : 'false'" class="ant-btn" title="显示 / 隐藏该天线覆盖范围" @click.stop="sc.toggleAnt(sat, a)">
                    <CoverageTreeIcon kind="antenna" :visible="sc.isSelected(grd.keyOf(sat.folder, a.name))" />
                  </button>
                  <template v-if="editAnt === grd.keyOf(sat.folder, a.name)">
                    <input class="aname-in" v-model="editVal" @click.stop @keydown.enter="commitRenameAnt(sat, a)" @keydown.esc.stop="editAnt = ''" @blur="commitRenameAnt(sat, a)" />
                    <button type="button" class="ok ibtn sm" title="确认重命名" @mousedown.prevent @click.stop="commitRenameAnt(sat, a)"><Icon name="check" :size="12" /></button>
                  </template>
                  <template v-else>
                    <span class="aname" title="双击定位到卫星 · ✎ 重命名" @dblclick.stop="emit('focus-sat', sat, true)" data-i18n-skip>{{ a.name }}</span>
                    <span v-if="!satelliteEditor && !sc.angleLines.editing.value && sc.isActive(grd.keyOf(sat.folder, a.name))" class="afoc">编辑中</span>
                    <span class="sacts">
                      <button type="button" class="ibtn sm tree-add" aria-haspopup="menu" title="添加波束角或性能指标表" @click.stop="emit('tree-menu', $event, sat, a)"><Icon name="plus" :size="14" /></button>
                      <button type="button" class="ibtn sm" title="重命名天线" @click.stop="startRenameAnt(sat, a)"><Icon name="pencil" :size="12" /></button>
                      <button type="button" class="del ibtn sm danger" :class="{ arm: delArm === 'ant:' + grd.keyOf(sat.folder, a.name) }" :title="delArm === 'ant:' + grd.keyOf(sat.folder, a.name) ? '再点一次删除（GRD 原件移入回收站）' : '删除天线'" @click.stop="emit('remove-ant', sat, a)"><Icon v-if="delArm !== 'ant:' + grd.keyOf(sat.folder, a.name)" name="x" :size="12" /><template v-else>确认删除</template></button>
                    </span>
                  </template>
                </div>
                <CoverageAngleTreeRow v-for="line in sc.angleLines.list(grd.keyOf(sat.folder, a.name))" :key="line.id"
                                  :line="line" :collection="sc.angleLines" @menu="openAngleMenu" />
                <PerfTreeRow v-for="t in tables.list('shell', grd.keyOf(sat.folder, a.name))" :key="t.id"
                             :name="t.name" :open="tableOpenKeys.has(t.id)" @open="emit('open-table', sat, a, t.id)"
                             :confirm-delete="delArm === 'shell:' + t.id" @remove="emit('remove-table', t.id)"
                             @menu="emit('tree-menu', $event, sat, a, t.id)" @rename="name => emit('rename-table', t.id, name)" />
              </template>
            </div>
          </template>
        </div>
    </template>

    <div class="coverage-settings">
    <GrdSetSections :grd="grd" @show-parameters="showAntenna" variant="shell" :sat-search="satSearch" @open-synth="(id) => emit('open-synth', id)">
      <template #shells>
    <div class="sec shell-settings">
      <div class="sect shell-tools" data-sec="satcov-shell">
        <span>轨道壳层</span>
        <span class="shell-count"><Icon name="layers" :size="13" />{{ sc.shells.value.length }} 层</span>
        <button type="button" class="shell-tool" title="从全量在轨目录中选择壳层（可查看每层包含的星座与卫星）" @click="emit('pick-shells')">从星座取…</button>
        <button type="button" class="shell-tool add-shell" popovertarget="coverage-add-shell"><Icon name="plus" :size="13" />添加壳层</button>
        <div id="coverage-add-shell" ref="addMenu" class="shell-menu add-menu" popover="auto" @toggle="placeShellMenu">
          <form @submit.prevent="addShellFromInput">
            <label for="coverage-new-height">高度 (km)</label>
            <input id="coverage-new-height" class="ci" v-model.number="newAlt" type="number" min="1" max="400000" step="any" required />
            <button type="submit" class="btn">添加</button>
          </form>
          <select class="ci" aria-label="预置" @change="addPreset">
            <option value="">预置…</option>
            <option v-for="(p, i) in sc.presetShells()" :key="p.name" :value="i" data-i18n-skip>{{ p.name }}</option>
          </select>
        </div>
      </div>
      <div class="shell-fields">
        <!-- 一层壳 = 一行控件 + 可选的一行归因。两者必须同在 v-for 里（归因那行要读 sh），
             拆到 v-for 外面 sh 就出了作用域 —— 渲染函数当场抛错，整个面板白屏。 -->
        <div v-if="sc.shells.value.length" class="shlist">
          <div class="shgrid shhead">
            <span></span><span>名称</span>
            <button class="sort-height" type="button" title="按高度排序" @click="sortHeight"><span>高度 (km)</span><Icon :name="heightOrder < 0 ? 'arrow-down' : 'arrow-up'" :class="{ idle: !heightOrder }" :size="10" /></button>
            <span class="branch-title">分支</span><span></span>
          </div>
          <div v-for="sh in shellRows" :key="sh.id" class="shell-entry" :class="{ muted: !sh.show }">
            <div class="shgrid shrow">
              <input type="checkbox" :checked="sh.show" title="显示 / 隐藏该层壳的覆盖" @change="sc.updateShell(sh.id, { show: !sh.show })" />
              <div class="shell-name">
                <input class="lvclr" type="color" title="壳层参照网颜色" :value="sh.color" @change="sc.updateShell(sh.id, { color: $event.target.value })" />
                <span class="shnm" :title="sh.name || '自定义'">{{ sh.name || '自定义' }}</span>
              </div>
              <input class="shalt" type="number" step="10" :value="altText(sh)" title="轨道高度（不是地心半径）：壳层地心半径 = 6378.137 + 该值。与卫星列表中的「高度」同一口径"
                     @input="altInput(sh, $event)" @change="altCommit(sh)" @blur="altCommit(sh)"
                     @keydown.enter="$event.target.blur()" @keydown.esc="altCancel($event)" @wheel="altWheel" />
              <select v-if="!singleBranch(sh)" class="shbr" title="分支" :value="sh.branch" @change="sc.updateShell(sh.id, { branch: $event.target.value })">
                <option value="both">近+远</option><option value="near">近侧</option><option value="far">远侧</option>
              </select>
              <span v-else class="shbr one" title="壳层高于源星：一条射线仅有一个交点">单支</span>
              <button type="button" class="ibtn sm shell-more" title="壳层操作" :popovertarget="'shell-menu-' + sh.id"><Icon name="ellipsis" :size="14" /></button>
              <div :id="'shell-menu-' + sh.id" class="shell-menu" popover="auto" @toggle="placeShellMenu">
                <button type="button" class="menu-item" @click="sc.removeShell(sh.id)">删除壳层</button>
              </div>
            </div>
            <div v-if="sh.show && shellWhy(sh)" class="shwhy">{{ shellWhy(sh) }}</div>
          </div>
        </div>
        <div v-else class="empty">暂无壳层。</div>
        <div class="srow shell-alt-limit"><label>掠地高度</label><input class="ci" type="number" step="10" min="0" v-model.number="sc.s.hEx"
             title="视线掠过地球表面的最低高度：低于此高度的路径按被地球挡住处理（把地球膨胀这么多再判遮挡）。0 = 纯几何遮挡" /><span class="u">km</span></div>
        <div class="guide-tools">
          <label class="chk2"><input type="checkbox" v-model="sc.s.guides" /><span>显示壳层参照网</span></label>
          <div data-sec="satcov-guides"><button type="button" class="shell-tool guide-toggle" :disabled="!sc.s.guides"
                  :aria-expanded="isSecOpen('satcov-guides', false)" @click="toggleSec('satcov-guides', false)">
            <Icon name="sliders-horizontal" :size="12" /><span>参照网样式</span>
          </button></div>
        <template v-if="sc.s.guides && isSecOpen('satcov-guides', false)">
          <div class="srow sub"><label>网格间隔</label>
            <select v-model.number="sc.s.guideStep" title="经线与纬线的角度间隔">
              <option :value="10">10°</option><option :value="15">15°</option><option :value="30">30°</option><option :value="45">45°</option>
            </select></div>
          <div class="srow sub"><label>纬线范围</label>
            <select v-model.number="sc.s.guideLat" title="纬线仅绘制到该纬度以内；经线始终画全程。取间隔的整倍数">
              <option :value="30">±30°</option><option :value="60">±60°</option><option :value="80">±80°</option>
            </select></div>
          <div class="srow sub"><label>线宽</label>
            <input class="rng" type="range" min="0.1" max="4" step="0.01" v-model.number="sc.s.guideWidth" title="像素线宽，与屏幕缩放/分辨率无关" /><span class="u">{{ sc.s.guideWidth.toFixed(2) }}</span></div>
          <div class="srow sub"><label>不透明度</label>
            <input class="rng" type="range" min="0.02" max="1" step="0.01" v-model.number="sc.s.guideAlpha" /><span class="u">{{ sc.s.guideAlpha.toFixed(2) }}</span></div>
          <div class="srow sub"><label>线型</label>
            <select v-model="sc.s.guideDash" title="虚线：与壳层上的等值线区分开">
              <option :value="false">实线</option><option :value="true">虚线</option>
            </select></div>
        </template>
        </div>
      </div>
    </div>
      </template>
    </GrdSetSections>
    </div>

    <template #footer><div class="csfoot">
      <span class="cst" :title="sc.stats.value.fullMs ? '几何 ' + sc.stats.value.ms + ' ms + GPU 重建，整轮 ' + sc.stats.value.fullMs + ' ms。播放时一拍就要这么久，时钟据此拉开两拍的间隔' : ''">{{ sc.stats.value.layers }} 层 · {{ sc.stats.value.tris }} 面片 · {{ sc.stats.value.fullMs || sc.stats.value.ms }} ms · {{ satCount }} 星在场</span>
      <button type="button" class="cclr btn" title="清空壳层上的填充/等值线，保留各天线设置与壳层库" @click="sc.clearDrawing()">清除绘图</button>
    </div></template>
  </CoverageSidebar>
</template>

<style scoped>
/* span / i / div 改成 <button> 后仍沿用本地外观的几类：先清 UA 内距与描边，外观由下方各自规则给 */
:where(button).tri, :where(button).ant-btn, :where(button).gperf, :where(button).lnk { margin: 0; padding: 0; border: 0; background: none; color: inherit; text-align: inherit; }
/* 与「对地覆盖分析」侧栏同源（ConstellationMap3D.vue 的 .cov-side/.gtree 一套）：那份是 scoped 的、
   进不到本组件，故这里带一份同值副本。改动请两处对照。 */
.shell-fields > * + * { margin-top: 8px; }
.sec { padding: 12px 16px; border-bottom: 1px solid var(--border); }
/* 竖向节奏与从属缩进：与 GrdSetSections.vue 逐字同源（口径与三处对照的说明见那边），
   宿主页 ConstellationMap3D.vue 是同一行距的第三份，写法不同、结果一致 */
.sec > * + * { margin-top: 8px; }
.sec > * + .sect { margin-top: 12px; }
.sec > .sect + * { margin-top: 6px; }
/* ★ 换行 + 「标签列是下限不是定宽」的口径在 styles/controls.css 的 .srow 里，四份副本同改 */
.srow { --srow-lab: 70px; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.srow label { color: var(--text-muted); min-width: var(--srow-lab); max-width: 100%; flex: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.srow.sub { --srow-lab: 51px; padding-left: 19px; }
.srow select, .srow .ci { flex: 1; min-width: 0; border: 1px solid var(--field-border); background-color: var(--field-bg); padding: 0 7px; font-size: var(--fs-3); outline: none; color: var(--text); }
/* 下拉框的可读下限：挤到装不下最长选项时整件掉到下一行，而不是裁掉选项名 */
.srow select { min-width: 116px; }
.srow .u { flex: none; min-width: 34px; text-align: right; color: var(--text-muted); font-variant-numeric: tabular-nums; }
/* 标题 / 行尾动作 / 可点标题带：与 GrdSetSections.vue 逐字同源（各条口径的说明见那边） */
.sect { display: flex; align-items: center; color: var(--text); }
.sect.acc { cursor: pointer; user-select: none; gap: 5px; }
.sect.acc .app-icon { flex: none; color: var(--text-faint); }
.sect .lnk { margin-left: auto; color: var(--text-muted); cursor: pointer; font-size: var(--fs-3); transition: color var(--dur-1) linear; }
.sect .lnk:hover { color: var(--text); text-decoration: underline; text-underline-offset: 2px; }
.sect .lnk.on { color: var(--accent-ui); font-weight: 600; text-decoration: none; }
.sect.acc .lnk .app-icon { color: inherit; }
.sect .lnk ~ .lnk { margin-left: 12px; }
.sect.acc:not(.setsect) { margin-inline: -6px; padding: 3px 6px; border-radius: var(--r-box); transition: background-color var(--dur-1) linear; }
.sec > * + .sect.acc:not(.setsect) { margin-top: 9px; }
.sec > .sect.acc:not(.setsect) + * { margin-top: 3px; }
.sec > .sect.acc:not(.setsect):first-child { margin-top: -3px; }
.sec > .sect.acc:not(.setsect):last-child { margin-bottom: -3px; }
.sect.acc:not(.setsect):hover { background: color-mix(in srgb, var(--text) 5%, transparent); }
.sect.acc:not(.setsect):active { background: color-mix(in srgb, var(--text) 9%, transparent); transition-duration: 0s; }
.sect.acc:has(.lnk:hover, .layersw:hover, .lnk:active, .layersw:active) { background: transparent; }
.sect.acc:hover > .app-icon.disc { color: var(--text-muted); }
.sect .editing { margin-left: auto; font-size: var(--fs-1); font-weight: 600; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent); border-radius: var(--r-ctl); padding: 1px 6px; }
.sect .editing + .lnk { margin-left: 0; }   /* 「n 已选」在时由它顶到右边，链接紧随其后（两个 auto 会把空白对半分） */
.chk2 { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.chk2:hover > input[type=checkbox]:not(:checked):not(:disabled) { border-color: var(--field-border-hover); }
.chk2:hover > input[type=checkbox]:checked:not(:disabled) { background: var(--accent-fill-hover); border-color: var(--accent-fill-hover); }
/* 滑块：同 ConstellationMap3D 的 .rng（那份 scoped 进不到本组件） */
.rng { flex: 1; min-width: 0; }
.empty { color: var(--text-faint); padding: 4px 0; }
/* 卫星 / 天线树（与对地同款两级层次） */

.gsat { display: flex; align-items: center; gap: 6px; padding: 4px 4px 4px 2px; color: var(--text); font-size: var(--fs-4); border-radius: var(--r-box); }
.gsat .sat-toggle { width: 24px; height: 24px; }
.gsat:hover { background: color-mix(in srgb, var(--text) 5%, transparent); }
.gsat .tri { font-style: normal; flex: none; width: 12px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-faint); font-size: var(--fs-1); cursor: pointer; transition: transform var(--dur-2); }
.gsat .tri.open { transform: rotate(90deg); }
.gsat .gsname { flex: 1; min-width: 0; white-space: normal; overflow-wrap: break-word; line-height: 1.3; cursor: pointer; }
.gsat .gsname:hover { color: var(--accent); }
.gsat .gsname em { font-style: normal; margin-left: 5px; color: var(--text-faint); font-family: var(--font-mono); font-size: var(--fs-2); }
.gsat .gsname .simtag { font-style: normal; margin-left: 5px; padding: 0 4px; border: 1px solid var(--accent); border-radius: var(--r-ctl); color: var(--accent); font-size: var(--fs-1); vertical-align: middle; }
.gsvg { flex: none; width: 14px; height: 14px; }
/* 星座选中集回显 / 关联星缺失告警：与对地树（宿主页 .gsat.cur / .gsat .lmiss）同值，两处对照 */
.gsat.cur { box-shadow: inset 2px 0 0 var(--accent-ui); }
.gsat.cur .gsname { color: var(--accent-ui); }
.gsat .lmiss { flex: none; display: inline-flex; align-items: center; color: var(--warn); }
/* 卫星行导航按钮：与对地侧栏 .sdisp 同款（图标按钮，hover 底色淡入，点亮转 accent） */
.sdisp { flex: none; display: flex; align-items: center; gap: 1px; margin-left: 4px; padding-left: 6px; border-left: 1px solid var(--border); }
.sdisp .ibtn { margin: -1px 0; }
.gbody { margin-left: 9px; padding-left: 12px; border-left: 1px solid var(--border); margin-bottom: 2px; }
.gant { display: flex; align-items: center; gap: 6px; padding: 3px 6px; margin: 1px 0; color: var(--text-muted); cursor: pointer; font-size: var(--fs-3); border-radius: var(--r-box); transition: background var(--dur-2), color var(--dur-2), box-shadow var(--dur-2); }
.gant:hover { color: var(--text); background: color-mix(in srgb, var(--text) 6%, transparent); }
.gant.on { color: var(--text); }
.gant.foc { color: var(--text); background: color-mix(in srgb, var(--accent-ui) 14%, transparent); box-shadow: inset 2px 0 0 var(--accent-ui); font-weight: 600; }
.gant .aname { flex: 1; min-width: 0; white-space: normal; overflow-wrap: break-word; word-break: break-word; line-height: 1.35; }
.gant .aname-in { flex: 1; min-width: 0; border: 1px solid var(--accent); background: var(--field-bg); padding: 1px 5px; font-size: var(--fs-3); color: var(--text); outline: none; }
.gant .afoc { flex: none; font-size: var(--fs-1); font-weight: 600; letter-spacing: var(--ls-tight); color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent); border-radius: var(--r-ctl); padding: 0 5px; line-height: 14px; }
/* 行内次级操作（卫星行 ＋✎✕ / 天线行 ✎✕ 共用）：常驻但弱化淡灰，hover 该行变亮 */
/* 命中框走 .ibtn.sm（20×20），图标仍 12；间距 2 让命中框不重叠。负外边距：命中框比行高出的那截不撑高行 */
.sacts { flex: none; display: flex; align-items: center; gap: 2px; margin-left: auto; padding-left: 4px; }
.sacts .ibtn { margin: -2px 0; }
.sacts .ibtn:where(:not(.tree-add)) { opacity: .6; }
.gsat:hover .sacts .ibtn, .gant:hover .sacts .ibtn, .sacts .ibtn:hover, .sacts .ibtn:focus-visible { opacity: 1; }
.sacts .ibtn.del.arm { width: auto; padding: 0 4px; color: var(--danger); opacity: 1; font-size: var(--fs-1); font-weight: 600; white-space: nowrap; }
/* 确认钮走状态色 token（两主题各有一档），悬停向墨色收一点而不是再提亮 */
.ibtn.ok, .ibtn.ok:hover:not(:disabled) { color: var(--ok); }
.gant.noant { color: var(--text-faint); font-style: italic; cursor: default; padding-left: 6px; }
.gant.noant:hover { background: none; color: var(--text-faint); }
.gant .ant-btn { display: flex; align-items: center; justify-content: center; flex: none; width: 24px; height: 24px; padding: 0; margin: -2px 0; border-radius: var(--r-box); transition: background var(--dur-2); }
.gant .ant-btn:hover { background: color-mix(in srgb, var(--accent) 18%, transparent); }
/* 壳层表共用列轨道。单元格在悬停或键盘聚焦时显出编辑边界。 */
.shell-settings { container-type: inline-size; }
.shell-tools, .guide-tools { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; }
.shell-tools > span:first-child { position: absolute; width: 1px; height: 1px; clip-path: inset(50%); overflow: hidden; white-space: nowrap; }
.shell-count { display: inline-flex; align-items: center; gap: 5px; margin-right: auto; font-variant-numeric: tabular-nums; }
.shell-tool, .sort-height { display: inline-flex; align-items: center; justify-content: center; gap: 3px; padding: 2px 4px; background: none; border: 1px solid transparent; border-radius: var(--r-ctl); color: var(--text-muted); font: inherit; cursor: pointer; }
.shell-tool:hover, .sort-height:hover { background: var(--wash-hover); color: var(--text); }
.add-shell { color: var(--text); border-color: var(--field-border); }
.shlist { --cols: 15px minmax(0,1fr) minmax(6.1em,24%) minmax(4.5em,18%) 18px; border-block: 1px solid var(--border); }
.shgrid { display: grid; grid-template-columns: var(--cols); align-items: center; gap: 5px; padding: 3px 2px; }
.shhead { position: sticky; top: 0; z-index: 1; background: var(--surface-2); color: var(--text-muted); }
.shhead, .shrow { font-size: var(--fs-2); }
.sort-height { justify-self: end; padding-inline: 0; white-space: nowrap; }
.sort-height .idle { opacity: .4; }
.branch-title { text-align: center; }
.shell-entry + .shell-entry { border-block-start: 1px solid color-mix(in srgb,var(--border) 65%,transparent); }
.shell-entry:is(:hover,:focus-within) { background: var(--wash-hover); }
.shell-name { min-width: 0; display: flex; align-items: center; gap: 6px; }
.shnm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.muted .shnm { color: var(--text-faint); }
.shrow input[type=color] { appearance: none; flex: none; width: 12px; height: 14px; padding: 0; background: transparent; border: 0; cursor: pointer; }
.shrow input[type=color]::-webkit-color-swatch-wrapper { padding: 1px 0; }
.shrow input[type=color]::-webkit-color-swatch { border: 1px solid color-mix(in srgb, var(--text) 18%, transparent); border-radius: 2px; }
.shrow .shalt, .shrow .shbr { width: 100%; min-width: 0; box-sizing: border-box; height: var(--h-ctl); border: 1px solid transparent; border-radius: var(--r-ctl); background-color: transparent; color: var(--text); font: inherit; }
.shrow .shalt { padding: 0 4px; font-variant-numeric: tabular-nums; text-align: right; }
.shrow .shalt::-webkit-inner-spin-button { display: none; }
.shrow select.shbr { text-align: center; padding-inline: 2px 12px; background-position: right 1px center; cursor: pointer; }
.shrow .one { display: grid; align-items: center; text-align: center; padding-inline-end: 10px; color: var(--text-muted); }
.shrow :is(.shalt,select.shbr):is(:hover,:focus-visible) { border-color: var(--field-border-hover); background-color: var(--field-bg); }
.shell-more { opacity: 0; }
.shrow:is(:hover,:focus-within) .shell-more, .shrow:has(:popover-open) .shell-more { opacity: 1; }
@media (hover: none) { .shell-more { opacity: 1; } }
.shwhy { padding: 0 6px 4px 24px; font-size: var(--fs-2); color: var(--warn); }
.shell-menu { position: fixed; inset: auto; margin: 0; padding: 3px; background: var(--surface); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--r-ctl); box-shadow: 0 3px 10px #0002; }
.shell-menu .menu-item { color: var(--danger); }
.add-menu { width: 212px; max-width: 90vw; padding: 10px; }
.add-menu form { display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: center; gap: 6px; }
.add-menu input { width: 100%; min-width: 0; text-align: right; }
.add-menu select { width: 100%; margin-top: 8px; }
.shell-alt-limit > label { flex: 1; }
.shell-alt-limit input.ci { max-width: 7em; text-align: right; font-variant-numeric: tabular-nums; }
.shell-alt-limit .u { min-width: 2em; }
.guide-tools { justify-content: space-between; }
.guide-tools > .srow { flex: 0 0 100%; }
.guide-toggle { font-size: var(--fs-2); }
@container (max-width: 245px) { .shgrid { gap: 2px; } .shell-name { gap: 3px; } }
/* 页脚左右内距 16：与上方各 .sec 同一条左缘 */
.csfoot { margin-top: auto; display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--border); }
.cst { font-size: var(--fs-2); color: var(--text-faint); font-family: var(--font-mono); }
/* 侧栏小按钮家族（同宿主页 .mini / .expb2 / .cclr）：定高 --h-ctl，描边取按钮结构线 */
.cclr { margin-left: auto; }
</style>
