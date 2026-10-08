<script setup>
// 设计页模型视图的功能区「文档」组（2026-10 统一设计）：新建（空白 / 从模板，与装配视图共用 NewMenu）、副本、撤销 / 重做。
// 副本入口只此一处（2026-10-06 任务书 §3.2；原快速设置里的「新建可编辑副本」并进来），按库条目的副本口径（wb.copyKindOf）：
//   · 卫星整星模板 / 实体模板 →「编辑副本」= 打开模板签（编辑时自动创建副本）；已存参数化整星 →「编辑副本」= 驱动装配件副本；
//   · 导入件 / NASA / 内置 / 星座精模 →「另存副本」= 元数据副本（新 user: 条目，署名保留）；装配件 →「另存副本」= 直接复制；
//   · STK 本机件：禁用（不可分发）。
// 撤销 / 重做是模型元数据的快照栈（与装配编辑器的撤销栈各管各）。
import { inject, computed, ref } from 'vue'
import Icon from '../../components/Icon.vue'
import NewMenu from './NewMenu.vue'

const wb = inject('wb')
const { cur, st } = wb
const newMenu = ref(null)
function openNew(ev) {
  const r = ev.currentTarget.getBoundingClientRect()
  newMenu.value = { x: Math.min(r.left, window.innerWidth - 176), y: r.bottom + 2 }
}
const d = computed(() => wb.activeDocState())
const libId = computed(() => (d.value && d.value.kind === 'model' ? d.value.libId : ''))
const kind = computed(() => { void st.list; return libId.value ? wb.copyKindOf(libId.value) : '' })
const isEdit = computed(() => kind.value === 'template' || kind.value === 'drive')
// 参数化件要等元数据（spec）到位才知道拆不拆得出组件；网格要等全精度几何挂上
const loaded = computed(() => !!cur.meta && cur.id === libId.value && !cur.loading)
const can = computed(() => {
  if (!libId.value || st.busy) return false
  if (kind.value === 'template') return true
  if (kind.value === 'drive') return loaded.value && !!(cur.meta.spec && cur.meta.spec.kind !== 'assembly')
  if (kind.value === 'asm') return !!wb.api
  if (kind.value === 'mesh') return loaded.value && !!wb.api && !st.locked && (cur.kind !== 'glb' || cur.lod === 'lod0')
  return false
})
// 拿不到全精度（离线、只有随包低档）：元数据副本不给（副本要按 lod0 复制几何与部件三角形号）
const noFull = computed(() => { void cur.lod; void cur.loading; return !!libId.value && wb.fullDetailMissing(libId.value) })
const tip = computed(() => {
  if (kind.value === 'stk') return '不可分发'
  if (kind.value === 'template') return '打开为模板签：编辑时自动创建副本（模板不变）'
  if (kind.value === 'drive') return '以本模型的整星参数新建驱动装配件：快速设置与逐件编辑均可用，原件不变'
  if (kind.value === 'asm') return '复制为新的装配件并在新签中打开'
  if (kind.value === 'mesh') return noFull.value ? '完整精度模型不可用' : '另存为新的本机模型（几何与当前标定一并复制，署名保留），并在新签中打开'
  return ''
})
function copy() {
  const id = libId.value
  if (!id || !can.value) return
  if (kind.value === 'template') wb.openInDesign(id)
  else if (kind.value === 'drive') wb.requestAssembly({ kind: 'spec', from: id })
  else wb.saveDocCopy(d.value.id)
}
</script>

<template>
  <div class="lbr-g asm-rb" data-grp="doc">
    <div class="lbr-items">
      <button class="lbr-big" data-act="new" title="新建：空白文档或从模板新建" @click="openNew">
        <Icon name="plus" :size="16" />新建
      </button>
      <div class="asm-rb-col">
        <button class="asm-tg" data-act="copy" :data-copy="kind" :disabled="!can" :title="tip" @click="copy">
          <Icon :name="isEdit ? 'copy' : 'folder-plus'" :size="13" /><span>{{ isEdit ? '编辑副本' : '另存副本' }}</span>
        </button>
      </div>
      <div class="asm-rb-col">
        <button class="asm-tg ico" data-act="undo" :disabled="!cur.undoN" title="撤销（Ctrl+Z）" @click="wb.undo()"><Icon name="undo-2" :size="14" /></button>
        <button class="asm-tg ico" data-act="redo" :disabled="!cur.redoN" title="重做（Ctrl+Y）" @click="wb.redo()"><Icon name="redo-2" :size="14" /></button>
      </div>
    </div>
    <div class="lbr-cap">文档</div>
  </div>
  <NewMenu v-if="newMenu" :x="newMenu.x" :y="newMenu.y" @close="newMenu = null" />
</template>
