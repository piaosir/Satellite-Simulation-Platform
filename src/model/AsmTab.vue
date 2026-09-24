<script setup>
// 装配页左栏（P3，契约 §6.3）：搜索 + 组件库（按领域分组的卡片，拖进视口安装 / 双击快速加）+ 从模板开始。
// 结构树与属性在右侧 dock（asm/AsmDock.vue）；视口与功能区归 ModelApp。
import { inject, computed } from 'vue'
import Icon from '../components/Icon.vue'
import AsmLib from './asm/AsmLib.vue'

const asm = inject('asm')
const q = computed({ get: () => asm.ui.libQ, set: (v) => { asm.ui.libQ = v } })
</script>

<template>
  <div class="asm asm-tab">
    <label class="asm-search">
      <Icon name="search" :size="13" />
      <input v-model="q" type="text" spellcheck="false" placeholder="搜索组件" title="按中英文名、组件类型、参数名搜索；大小写、全角半角、连字符不计" />
      <button v-if="q" type="button" title="清空" @click="q = ''"><Icon name="x" :size="12" /></button>
    </label>
    <AsmLib :q="q" />
  </div>
</template>

<style scoped>
.asm-tab { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
</style>
