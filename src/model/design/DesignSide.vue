<script setup>
// 设计页左栏（2026-10 统一设计）：页眉两档「快速设置 | 组件」，下面是对应窗格。
//   · 快速设置：打开的文档最先要定的那几项（驱动装配件 = 整星驱动参数；普通装配件 = 各件的主要参数；模型 = 尺寸 / 朝向 / 质量 / 部件识别）；
//   · 组件：装配签才有——组件库（拖进视口 / 双击添加）与「从模板新建」。模型签只有快速设置一档。
// 选哪档按签记（DocState.pane，2026-10-06 文档标签条）：换签各回各的档；新开的空装配文档缺省组件库（建签时定，首次挂载即生效）。
// 没有打开的文档：左栏空。组件库的 DOM（.asm-lib [data-type] …）与原装配页一致，验证台照用。
// 模型视图的快速设置按签重建（:key = 签 id，体检 2026-10-16 二.23）：「已知尺寸」的尺寸项 / 已知值、识别 / 估算中的状态只属于那一件，
// 同一个实例带到下一个模型签，「缩放」就按上一件填的尺寸缩当前件。
import { inject, computed } from 'vue'
import AsmTab from '../AsmTab.vue'
import QuickSat from './QuickSat.vue'
import QuickAsm from './QuickAsm.vue'
import QuickMesh from './QuickMesh.vue'

const wb = inject('wb')

const d = computed(() => wb.activeDocState())
const isAsm = computed(() => !!d.value && d.value.kind === 'asm')
const pane = computed({
  get: () => (d.value && d.value.pane === 'lib' ? 'lib' : 'quick'),
  set: (v) => { if (d.value) d.value.pane = v === 'lib' ? 'lib' : 'quick' }
})
const eff = computed(() => (isAsm.value ? pane.value : 'quick'))
// 驱动装配件：按激活签自己的文档判（DocState.driven 随每次载入 / 提交更新；换签瞬间 asm.doc 还是上一份，不能按它判）
const driven = computed(() => isAsm.value && d.value.driven)
</script>

<template>
  <div v-if="d" class="dsg-side">
    <div class="dsg-hd">
      <div v-if="isAsm" class="dsg-tabs" role="tablist">
        <button type="button" role="tab" data-act="pane-quick" :class="{ on: eff === 'quick' }" :aria-selected="eff === 'quick'"
                title="打开的文档最先要定的参数：驱动装配件为整星驱动参数，普通装配件为各组件的主要参数" @click="pane = 'quick'">快速设置</button>
        <button type="button" role="tab" data-act="pane-lib" :class="{ on: eff === 'lib' }" :aria-selected="eff === 'lib'"
                title="组件库：拖进视口安装、双击添加；从模板新建" @click="pane = 'lib'">组件</button>
      </div>
      <span v-else class="dsg-hd-t">快速设置</span>
    </div>
    <div class="dsg-bd" :class="{ lib: eff === 'lib' }">
      <AsmTab v-if="eff === 'lib'" />
      <QuickSat v-else-if="driven" />
      <QuickAsm v-else-if="isAsm" />
      <QuickMesh v-else :key="d.id" />
    </div>
  </div>
</template>

<style scoped>
.dsg-side { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dsg-hd { flex: none; display: flex; align-items: center; height: 30px; padding: 0 8px; background: var(--surface-2); border-bottom: 1px solid var(--border); }
.dsg-hd-t { padding-left: 4px; font-size: var(--fs-2); font-weight: 600; letter-spacing: var(--ls-label); text-transform: uppercase; color: var(--text-muted); }
/* 两档页眉：经典连体页签（选中页与内容面同底 + 底缘机位色），与功能区页签同一套语言 */
.dsg-tabs { display: flex; align-self: stretch; gap: 0; }
.dsg-tabs > button {
  position: relative; display: inline-flex; align-items: center; padding: 0 12px; font: inherit; font-size: var(--fs-3); font-weight: 600; cursor: pointer;
  color: var(--text-muted); background: transparent; border: 0; border-right: 1px solid transparent; border-left: 1px solid transparent; transition: var(--t-state);
}
.dsg-tabs > button:hover:not(.on) { color: var(--text); background: var(--wash-hover); }
.dsg-tabs > button.on { color: var(--text); background: var(--bg); border-left-color: var(--border); border-right-color: var(--border); transition-duration: 0s; }
.dsg-tabs > button.on::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; background: var(--accent-ui); }
.dsg-tabs > button:first-child.on { border-left-color: transparent; }
.dsg-bd { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.dsg-bd.lib { padding: 10px 10px 0; }
</style>
