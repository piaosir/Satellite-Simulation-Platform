<script setup>
// 设计页模型视图的右侧 dock（2026-10 统一设计）：模型级属性——原「模型」页各节（概况 / 单位 / 本体轴 / 质量特性 / 部件 / 挂点 /
// 关节 / 太阳翼组 / 遮挡计算排除节点 / JSON）原样搬到这里，与装配视图「选根节点 = 模型级属性」同一个位置。
// 栏宽由 ModelApp 那一列管（左缘拖宽）。
import { inject, computed } from 'vue'
import ModelTab from '../ModelTab.vue'
import { displayName } from '../wbLogic.js'

const wb = inject('wb')
const { cur } = wb
const title = computed(() => (cur.meta ? displayName(cur.meta, 'zh') || cur.id : ''))
</script>

<template>
  <div class="asm md-dock">
    <div class="asm-hd">
      <span class="asm-hd-k">属性</span>
      <span class="asm-hd-t" :title="cur.id" data-i18n-skip>{{ title }}</span>
    </div>
    <div class="md-dock-bd"><ModelTab /></div>
  </div>
</template>

<style scoped>
.md-dock { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--bg); }
.md-dock-bd { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 10px 10px 16px; }
</style>
