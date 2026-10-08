<script setup>
// 设计页装配视图的功能区（契约 §6.2）：一个组件渲染四个 .lbr-g —— 文档（含撤销 / 重做）/ 变换 / 吸附（含对称）/ 编辑。
// 「新建」下拉与模型视图共用 design/NewMenu.vue（空白文档 + 从模板新建）。2026-10 去掉「转为装配」：它作用于看不见的当前模型，
// 模板 / 已存参数化件改为在库页双击或模型视图功能区「编辑副本」。
// 文档组「另存副本」（2026-10-06 任务书 §3.2）：新 id、「<名称> 副本」、新签打开，原签保留；下拉另有「另存副本并还原原件」（DM-2）。
// 「姿态 零位 / 初值」在视图组（ModelApp）。按钮文字只写动作名；快捷键与口径进 title（界面零说明文字）。每个按钮带 data-act（验证台定位）。
// ★ 宽度：出厂窗口（内容宽 1544）下整条功能区不横向滚出（修复轮 rv1：五组 + 状态区原先要 1821 px，吸附 / 穿插状态永远看不见）。
//   装配状态移到视口状态片（ModelApp .asm-stchip），这里不承载。
import { inject, computed, ref, watch, onBeforeUnmount } from 'vue'
import Icon from '../../components/Icon.vue'
import { MOVE_STEP_OPTS, ROT_STEPS } from '@core/models/asmSnap.mjs'
import { SPACE_UI, SYM_UI, compById, PLACE_KEYS_TIP, moveStepLabel, fmtStep, effMoveStep } from '../asmLogic.js'
import NewMenu from '../design/NewMenu.vue'

const asm = inject('asm')
const wb = inject('wb')
const ui = asm.ui
const A = wb.asm

const doc = computed(() => asm.doc.value)
const nSel = computed(() => ui.selIds.length)
const primary = computed(() => (ui.selIds.length === 1 && doc.value ? compById(doc.value, ui.selIds[0]) : null))
const lock = computed(() => ui.posePreview)
const LOCK_TIP = '初值姿态下不可编辑'
const busy = computed(() => ui.dragging)

// ── 文档 ──
// 从未入库的新文档（原样的模板副本 / 驱动装配件，不自动入库）也能手动「保存」
const unsaved = computed(() => A.dirty || !A.inLib)
const canSave = computed(() => unsaved.value && !A.empty && !A.invalid && !A.saving && !!wb.api)
const saveTip = computed(() => (A.invalid ? '参数无效，暂不入库' : A.dirty ? '立即入库（停止编辑 1.5 s 后自动入库）' : !A.inLib ? '入库' : '已入库'))
// 另存副本（§3.2）：新 id、「<名称> 副本」、新签打开，原签保留；下拉第二项「另存副本并还原原件」= 副本拿走改动、原件写回打开时的样子。
// 模板签不给（编辑即成副本，原样存一份用「保存」）
const docId = computed(() => (A.id ? A.id : ''))
const canSaveAs = computed(() => { void A.rev; void A.empty; void A.invalid; void A.templateKey; return !!docId.value && !A.saving && wb.canSaveDocCopy(docId.value) })
const canRestore = computed(() => { void A.rev; void A.inLib; return !!docId.value && !A.saving && wb.canRevertDocCopy(docId.value) })
const saveAsTip = computed(() => (A.templateKey ? '模板签编辑时自动创建副本' : '另存为新的装配件并在新签中打开（当前文档保持打开）'))
const newMenu = ref(null)
function openNew(ev) {
  const r = ev.currentTarget.getBoundingClientRect()
  newMenu.value = { x: Math.min(r.left, window.innerWidth - 176), y: r.bottom + 2 }
}
const saveAsMenu = ref(null)
function openSaveAs(ev) {
  const r = ev.currentTarget.getBoundingClientRect()
  saveAsMenu.value = { x: Math.min(r.left, window.innerWidth - 230), y: r.bottom + 2 }
}
function saveAsDo(restore) { saveAsMenu.value = null; asm.saveAs({ restore }) }

// ── 变换 ──
// 接口 / 面安装件的坐标系恒为安装系（另两档禁用）。2026-10-06（§3.3.3）起接口件也可平移：移动手柄写接口系偏移（x / y / 法向），
// 「移动」不再禁用；旋转工具对接口 / 面安装件只给绕法向的滚转环（倾角走属性面板数值）。
const mountOnly = computed(() => !!(primary.value && primary.value.parent && primary.value.attach && primary.value.attach.mode !== 'free'))
const effSpace = computed(() => (mountOnly.value ? 'mount' : ui.space))
const effTool = computed(() => ui.tool)
const spaceTip = (s) => (mountOnly.value && s.key !== 'mount' ? '接口 / 面安装件始终按安装系变换' : s.tip + '（Q 循环）')
const NUDGE_TIP = '\n方向键：沿安装系微调一个吸附步长（Shift 取 1/10），PageUp / PageDown 沿法向'
const moveTip = computed(() => (lock.value ? LOCK_TIP : (mountOnly.value
  ? (primary.value.attach.mode === 'socket' ? '移动（W）：接口系偏移 x / y / 法向' : '移动（W）：面内 u / v、法向偏移')
  : '移动（W）') + NUDGE_TIP))
const rotTip = computed(() => (lock.value ? LOCK_TIP : mountOnly.value ? '旋转（E）：绕安装法向滚转' : '旋转（E）'))

// ── 吸附 / 对称 ──
const symTip = computed(() => (SYM_UI.find((s) => s.key === ui.sym.op) || SYM_UI[0]).tip + '\n放置新组件时的对称方式（安装到已对称的件上时自动随之对称）')
const snapTip = '吸附：接口 / 面心 / 边中点 / 角点 / 网格步长\n' + PLACE_KEYS_TIP
// 平移步长：选「自动」时下拉旁给当前生效值（运行时读数）。来源依次：会话的 ui.step（若会话转发了编辑器 'step' 事件）→ 本组件直接订阅的
// 编辑器 'step' 事件 {move, m}（拖动中按落点锚面、空闲按选中件）→ 编辑器 effMoveStep()（若有）→ 按选中件的锚面现算
// （asmLogic.effMoveStep，与内核 autoGridStep 同式）；都给不出只显示「自动」。只在「自动」档时才建文档副本（JSON 往返：生成缓存不吃冻结快照）
const stepEv = ref(null)
let offStep = null
function hookStep() {
  if (offStep) return
  const ed = asm.editor ? asm.editor() : null
  if (!ed || typeof ed.on !== 'function') return
  try {
    const off = ed.on('step', (e) => { stepEv.value = e && typeof e.m === 'number' ? { move: e.move, m: e.m } : null })
    offStep = typeof off === 'function' ? off : () => {}
  } catch { offStep = null }
}
watch(() => ui.ready, (r) => { if (r) hookStep() }, { immediate: true })
onBeforeUnmount(() => { if (offStep) { try { offStep() } catch { /* 无 */ } } offStep = null })
const pdoc = computed(() => (ui.snap.move === 'auto' && doc.value ? JSON.parse(JSON.stringify(doc.value)) : null))
const autoStep = computed(() => {
  if (ui.snap.move !== 'auto') return ''
  const us = ui.step
  if (us && us.move === 'auto' && typeof us.m === 'number') return fmtStep(us.m)
  const se = stepEv.value
  if (se && se.move === 'auto') return fmtStep(se.m)
  void ui.dragTarget; void ui.live; void ui.mode
  const ed = asm.editor ? asm.editor() : null
  if (ed && typeof ed.effMoveStep === 'function') {
    let v = null
    try { v = ed.effMoveStep() } catch { v = null }
    if (typeof v === 'number' && v > 0) return fmtStep(v)
  }
  const c = primary.value && pdoc.value ? compById(pdoc.value, primary.value.id) : null
  return c ? fmtStep(effMoveStep(pdoc.value, c, 'auto')) : ''
})
function setMoveStep(raw) { asm.setSnap({ move: raw === 'auto' ? 'auto' : Number(raw), moveSet: true }) }

// ── 编辑 ──
const isRootSel = computed(() => !!(primary.value && primary.value.parent === null))
const anyLocked = computed(() => !!(doc.value && ui.selIds.some((id) => { const c = compById(doc.value, id); return c && c.locked })))
const can = computed(() => ({
  dup: nSel.value > 0 && !lock.value && !busy.value,
  del: nSel.value > 0 && !anyLocked.value && !busy.value,
  pick: nSel.value === 1 && !isRootSel.value && !anyLocked.value && !lock.value && !busy.value,
  mirror: nSel.value > 0 && !isRootSel.value && !anyLocked.value && !busy.value,
  undo: ui.canUndo && !busy.value,
  redo: ui.canRedo && !busy.value
}))
</script>

<template>
  <div class="lbr-g asm-rb">
    <div class="lbr-items">
      <button class="lbr-big" data-act="new" title="新建：空白文档或从模板新建" @click="openNew">
        <Icon name="plus" :size="16" />新建
      </button>
      <div class="asm-rb-col">
        <button class="asm-tg" data-act="save" :disabled="!canSave" :title="saveTip" @click="asm.save()">
          <Icon name="save" :size="13" /><span>保存</span><i v-if="unsaved && !A.empty" class="asm-dirty"></i>
        </button>
        <span class="asm-rb-split">
          <button class="asm-tg" data-act="saveAs" :disabled="!canSaveAs" :title="saveAsTip" @click="saveAsDo(false)">
            <Icon name="folder-plus" :size="13" /><span>另存副本</span>
          </button>
          <button class="asm-tg ico asm-rb-caret" data-act="saveAs-more" :class="{ on: !!saveAsMenu }" :disabled="!canSaveAs" title="另存副本选项" @click="openSaveAs"><Icon name="chevron-down" :size="12" /></button>
        </span>
      </div>
      <div class="asm-rb-col">
        <button class="asm-tg ico" data-act="undo" :disabled="!can.undo" title="撤销（Ctrl+Z）" @click="asm.undo()"><Icon name="undo-2" :size="14" /></button>
        <button class="asm-tg ico" data-act="redo" :disabled="!can.redo" title="重做（Ctrl+Y）" @click="asm.redo()"><Icon name="redo-2" :size="14" /></button>
      </div>
    </div>
    <div class="lbr-cap">文档</div>
  </div>

  <div class="lbr-g asm-rb">
    <div class="lbr-items">
      <div class="asm-rb-col">
        <button class="asm-tg" data-act="move" :class="{ on: effTool === 'move' }" :disabled="lock"
                :title="moveTip" @click="asm.setTool('move')">
          <Icon name="move" :size="13" /><span>移动</span>
        </button>
        <button class="asm-tg" data-act="rotate" :class="{ on: effTool === 'rotate' }" :disabled="lock" :title="rotTip" @click="asm.setTool('rotate')">
          <Icon name="rotate-3d" :size="13" /><span>旋转</span>
        </button>
      </div>
      <div class="lbr-form">
        <label><span class="asm-rb-ic" title="坐标系（Q 循环）"><Icon name="axis-3d" :size="14" /></span>
          <span class="lbu-seg">
            <button v-for="s in SPACE_UI" :key="s.key" :data-act="'space-' + s.key" :class="{ on: effSpace === s.key }" :disabled="mountOnly && s.key !== 'mount'" :title="spaceTip(s)" @click="asm.setSpace(s.key)">{{ s.label }}</button>
          </span>
        </label>
      </div>
    </div>
    <div class="lbr-cap">变换</div>
  </div>

  <div class="lbr-g asm-rb">
    <div class="lbr-items">
      <div class="lbr-form">
        <label>
          <button class="asm-tg asm-rb-lead" data-act="snap" :class="{ on: ui.snap.on }" :title="snapTip" @click="asm.setSnap({ on: !ui.snap.on })">
            <Icon name="magnet" :size="13" /><span>吸附</span>
          </button>
          <select data-act="snap-move" class="asm-rb-sm" :value="String(ui.snap.move)" title="平移吸附步长（面安装件以面心为原点的绝对网格；自动 = 锚面短边 / 20，取 1-2-5 档）" @change="setMoveStep($event.target.value)">
            <option v-for="v in MOVE_STEP_OPTS" :key="v" :value="String(v)">{{ moveStepLabel(v) }}</option>
          </select>
          <span v-if="autoStep" class="asm-rb-eff" data-act="snap-eff" title="当前生效的平移吸附步长">{{ autoStep }}</span>
          <select data-act="snap-rot" class="asm-rb-sm" :value="String(ui.snap.rot)" title="旋转吸附步长（接口件取接口允许的滚转档位）" @change="asm.setSnap({ rot: Number($event.target.value) })">
            <option v-for="v in ROT_STEPS" :key="v" :value="String(v)">{{ v }}°</option>
          </select>
        </label>
        <label><span class="asm-rb-lead-l" :title="symTip">对称</span>
          <span class="lbu-seg">
            <button v-for="s in SYM_UI" :key="s.key" :data-act="'sym-' + s.key" :class="{ on: ui.sym.op === s.key }" :title="s.tip" @click="asm.setSym({ op: s.key })">{{ s.short }}</button>
          </span>
          <select data-act="sym-n" class="asm-rb-n" :value="String(ui.sym.n)" :disabled="ui.sym.op !== 'radial'" title="径向对称的件数（含主件）" @change="asm.setSym({ n: Number($event.target.value) })">
            <option v-for="n in 7" :key="n" :value="String(n + 1)">{{ n + 1 }}</option>
          </select>
        </label>
      </div>
    </div>
    <div class="lbr-cap">吸附</div>
  </div>

  <div class="lbr-g asm-rb">
    <div class="lbr-items">
      <div class="asm-rb-grid two">
        <button class="asm-tg ico" data-act="duplicate" :disabled="!can.dup" :title="lock ? LOCK_TIP : '复制（Ctrl+D）：复制选中子树并进入放置'" @click="asm.duplicate()"><Icon name="copy" :size="14" /></button>
        <button class="asm-tg ico" data-act="pickup" :disabled="!can.pick" :title="lock ? LOCK_TIP : '重新放置（G）：连同子树重新吸附放置\n' + PLACE_KEYS_TIP" @click="asm.pickup()"><Icon name="grab" :size="14" /></button>
        <button class="asm-tg ico" data-act="mirror" :disabled="!can.mirror" title="镜像（M）：切换选中件的镜像对称" @click="asm.mirror()"><Icon name="flip-horizontal-2" :size="14" /></button>
        <button class="asm-tg ico" data-act="remove" :disabled="!can.del" title="删除（Delete）：连同子件与对称件" @click="asm.remove()"><Icon name="trash" :size="14" /></button>
      </div>
    </div>
    <div class="lbr-cap">编辑</div>
  </div>

  <NewMenu v-if="newMenu" :x="newMenu.x" :y="newMenu.y" @close="newMenu = null" />
  <Teleport to="body">
    <div v-if="saveAsMenu" class="lb-ctx-mask" @mousedown="saveAsMenu = null" @contextmenu.prevent="saveAsMenu = null">
      <div class="lb-ctx" :style="{ left: saveAsMenu.x + 'px', top: saveAsMenu.y + 'px' }" @mousedown.stop>
        <button class="lb-ctx-i" data-act="saveAs-copy" :disabled="!canSaveAs" @click="saveAsDo(false)">另存副本</button>
        <button class="lb-ctx-i" data-act="saveAs-restore" :disabled="!canRestore" title="副本保留当前内容，原件恢复为打开时的状态" @click="saveAsDo(true)">另存副本并还原原件</button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* 「另存副本」+ 下拉箭头连成一体 */
.asm-rb-split { display: inline-flex; align-items: stretch; }
.asm-rb-split > .asm-tg:first-child { border-top-right-radius: 0; border-bottom-right-radius: 0; }
.asm-rb-caret { width: 16px !important; min-width: 16px; padding: 0 !important; border-top-left-radius: 0 !important; border-bottom-left-radius: 0 !important; }
/* 「自动」步长的生效值读数：紧跟步长下拉，等宽数字、淡一档 */
.asm-rb-eff { flex: none; min-width: 44px; font-family: var(--font-mono); font-size: var(--fs-1); font-variant-numeric: tabular-nums; color: var(--text-muted); white-space: nowrap; }
</style>
