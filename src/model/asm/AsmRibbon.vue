<script setup>
// 装配页功能区（契约 §6.2）：一个组件渲染四个 .lbr-g —— 文档（含撤销 / 重做）/ 变换 / 吸附（含对称）/ 编辑。
// 「姿态 零位 / 初值」在视图组（ModelApp）。按钮文字只写动作名；快捷键与口径进 title（界面零说明文字）。每个按钮带 data-act（验证台定位）。
// ★ 宽度：出厂窗口（内容宽 1544）下整条功能区不横向滚出（修复轮 rv1：五组 + 状态区原先要 1821 px，吸附 / 穿插状态永远看不见）。
//   装配状态移到视口状态片（ModelApp .asm-stchip），这里不承载。
import { inject, computed, ref, watch, onBeforeUnmount } from 'vue'
import Icon from '../../components/Icon.vue'
import { MOVE_STEPS, ROT_STEPS } from '@core/models/asmSnap.mjs'
import { SPACE_UI, SYM_UI, DOMAIN_LABELS, DOMAIN_ICONS, NEW_DOMAINS, compById } from '../asmLogic.js'
import { displayName } from '../wbLogic.js'

const asm = inject('asm')
const wb = inject('wb')
const { cur } = wb
const ui = asm.ui
const A = wb.asm

const doc = computed(() => asm.doc.value)
const nSel = computed(() => ui.selIds.length)
const primary = computed(() => (ui.selIds.length === 1 && doc.value ? compById(doc.value, ui.selIds[0]) : null))
const lock = computed(() => ui.posePreview)
const LOCK_TIP = '初值姿态下不可编辑'
const busy = computed(() => ui.dragging)

// ── 文档 ──
const canSave = computed(() => A.dirty && !A.empty && !A.invalid && !A.saving && !!wb.api)
const canSaveAs = computed(() => !A.empty && !A.invalid && !A.saving && !!wb.api)
const saveTip = computed(() => (A.invalid ? '参数非法，暂不入库' : A.dirty ? '立即入库（停手 1.5 s 后也会自动入库）' : '已入库'))
const newMenu = ref(null)
function openNew(ev) {
  const r = ev.currentTarget.getBoundingClientRect()
  newMenu.value = { x: Math.min(r.left, window.innerWidth - 176), y: r.bottom + 2 }
}
function pickNew(d) { newMenu.value = null; wb.requestAssembly({ kind: 'new', domain: d }) }
// 菜单开着时 Esc 关菜单（捕获阶段先收，装配页的 Esc = 清选择不再跟着触发）
function onMenuKey(e) { if (e.key === 'Escape' && newMenu.value) { newMenu.value = null; e.preventDefault(); e.stopPropagation() } }
watch(newMenu, (m) => { if (m) window.addEventListener('keydown', onMenuKey, true); else window.removeEventListener('keydown', onMenuKey, true) })
onBeforeUnmount(() => window.removeEventListener('keydown', onMenuKey, true))
// 「转为装配」：当前 wb 模型是参数化整星（模板 / 已存参数化 / 生成页的临时星）或实体模板预览
const convert = computed(() => {
  if (!cur.meta || !['tpl', 'param', 'gen'].includes(cur.kind)) return null
  if (typeof cur.id === 'string' && cur.id.startsWith('ent:')) return { kind: 'template', entId: cur.id }
  const r = wb.currentParam()
  if (!r || !r.spec || r.spec.kind === 'assembly') return null
  if (cur.kind === 'gen') return { kind: 'spec', spec: JSON.parse(JSON.stringify(r.spec)), base: { titleZh: cur.meta.titleZh || cur.meta.title || '' } }
  return { kind: 'spec', from: cur.id }
})
const convertTip = computed(() => (convert.value ? '转为装配：' + displayName(cur.meta, 'zh') : '转为装配：先在库页或生成页选中一颗参数化卫星 / 实体模板'))
function doConvert() { if (convert.value) wb.requestAssembly(convert.value) }

// ── 变换 ──
// 插座 / 贴面件的坐标系恒为安装面（另两档禁用）；插座件只剩绕法向的滚转 → 工具恒为「旋转」、「移动」禁用（手柄就是一条滚转环）
const mountOnly = computed(() => !!(primary.value && primary.value.parent && primary.value.attach && primary.value.attach.mode !== 'free'))
const rollOnly = computed(() => !!(mountOnly.value && primary.value.attach.mode === 'socket'))
const effSpace = computed(() => (mountOnly.value ? 'mount' : ui.space))
const effTool = computed(() => (rollOnly.value ? 'rotate' : ui.tool))
const spaceTip = (s) => (mountOnly.value && s.key !== 'mount' ? '插座 / 贴面件恒按安装面变换' : s.tip + '（Q 循环）')

// ── 吸附 / 对称 ──
const symTip = computed(() => (SYM_UI.find((s) => s.key === ui.sym.op) || SYM_UI[0]).tip + '\n放置新组件时的对称（接到已对称的件上时自动随之对称）')

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
      <button class="lbr-big" data-act="new" title="新建装配件（选领域）" @click="openNew">
        <Icon name="plus" :size="16" />新建
      </button>
      <div class="asm-rb-col">
        <button class="asm-tg" data-act="save" :disabled="!canSave" :title="saveTip" @click="asm.save()">
          <Icon name="save" :size="13" /><span>保存</span><i v-if="A.dirty && !A.empty" class="asm-dirty"></i>
        </button>
        <button class="asm-tg" data-act="saveAs" :disabled="!canSaveAs" title="另存为新的装配件（库里的原件不动）" @click="asm.saveAs()">
          <Icon name="folder-plus" :size="13" /><span>另存</span>
        </button>
        <button class="asm-tg" data-act="convert" :disabled="!convert" :title="convertTip" @click="doConvert">
          <Icon name="boxes" :size="13" /><span>转为装配</span>
        </button>
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
        <button class="asm-tg" data-act="move" :class="{ on: effTool === 'move' }" :disabled="lock || rollOnly"
                :title="lock ? LOCK_TIP : rollOnly ? '插座件只可绕插座法向滚转' : '移动（W）'" @click="asm.setTool('move')">
          <Icon name="move" :size="13" /><span>移动</span>
        </button>
        <button class="asm-tg" data-act="rotate" :class="{ on: effTool === 'rotate' }" :disabled="lock" :title="lock ? LOCK_TIP : '旋转（E）'" @click="asm.setTool('rotate')">
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
          <button class="asm-tg asm-rb-lead" data-act="snap" :class="{ on: ui.snap.on }" title="吸附：插座 / 面心 / 边中点 / 角点 / 网格步长（按住 Shift 临时关闭）" @click="asm.setSnap({ on: !ui.snap.on })">
            <Icon name="magnet" :size="13" /><span>吸附</span>
          </button>
          <select data-act="snap-move" class="asm-rb-sm" :value="String(ui.snap.move)" title="平移吸附步长（贴面件从面心起算的绝对网格）" @change="asm.setSnap({ move: Number($event.target.value) })">
            <option v-for="v in MOVE_STEPS" :key="v" :value="String(v)">{{ v }} m</option>
          </select>
          <select data-act="snap-rot" class="asm-rb-sm" :value="String(ui.snap.rot)" title="旋转吸附步长（插座件取插座允许的滚转档）" @change="asm.setSnap({ rot: Number($event.target.value) })">
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
        <button class="asm-tg ico" data-act="duplicate" :disabled="!can.dup" :title="lock ? LOCK_TIP : '复制（Ctrl+D）：复制选中子树并拾起放置'" @click="asm.duplicate()"><Icon name="copy" :size="14" /></button>
        <button class="asm-tg ico" data-act="pickup" :disabled="!can.pick" :title="lock ? LOCK_TIP : '拾起（G）：连子树重新吸附放置，Esc 复原'" @click="asm.pickup()"><Icon name="grab" :size="14" /></button>
        <button class="asm-tg ico" data-act="mirror" :disabled="!can.mirror" title="镜像（M）：开 / 关选中件的镜像对称" @click="asm.mirror()"><Icon name="flip-horizontal-2" :size="14" /></button>
        <button class="asm-tg ico" data-act="remove" :disabled="!can.del" title="删除（Delete）：连同子件与对称件" @click="asm.remove()"><Icon name="trash" :size="14" /></button>
      </div>
    </div>
    <div class="lbr-cap">编辑</div>
  </div>

  <Teleport to="body">
    <div v-if="newMenu" class="lb-ctx-mask" @mousedown="newMenu = null" @contextmenu.prevent="newMenu = null">
      <div class="lb-ctx" :style="{ left: newMenu.x + 'px', top: newMenu.y + 'px' }" @mousedown.stop>
        <button v-for="d in NEW_DOMAINS" :key="d" class="lb-ctx-i" :data-act="'new-' + d" @click="pickNew(d)"><Icon :name="DOMAIN_ICONS[d]" :size="14" />{{ DOMAIN_LABELS[d] }}</button>
      </div>
    </div>
  </Teleport>
</template>
