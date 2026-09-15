<script setup>
// 性能指标表窗口的根：按 ?kind= 装三张表之一（对地 ground / 对星 shell / 气象 met）。
// 窗口标题由主窗口在开窗时按卫星 / 天线定（改名后经 perfwin:setTitle 跟进），这里不再画标题栏。
import { computed } from 'vue'
import ActivationLock from '../components/ActivationLock.vue'
import Icon from '../components/Icon.vue'
import { alertMsg, closeAlert } from '../stores/alert.js'
import GroundPerfWin from './GroundPerfWin.vue'
import ShellPerfWin from './ShellPerfWin.vue'
import MetTableWin from './MetTableWin.vue'

const q = new URLSearchParams(location.search)
const kind = q.get('kind') || 'ground'
const comp = computed(() => (kind === 'shell' ? ShellPerfWin : kind === 'met' ? MetTableWin : GroundPerfWin))
</script>

<template>
  <div class="pw-root">
    <component :is="comp" />
    <!-- 应用内提示（替代原生 alert：原生弹窗关掉后会夺走渲染进程焦点，之后输入框点不进去） -->
    <div v-if="alertMsg" class="pw-mask" @click.self="closeAlert">
      <div class="pw-dlg pw-alert">
        <div class="sdh"><span>提示</span><span class="csx" @click="closeAlert"><Icon name="x" :size="12" /></span></div>
        <div class="sdbody"><p class="al-msg">{{ alertMsg }}</p></div>
        <div class="sdfoot"><span class="save" @click="closeAlert">确定</span></div>
      </div>
    </div>
    <ActivationLock />
  </div>
</template>
