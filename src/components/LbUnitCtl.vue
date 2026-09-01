<script setup>
// 功能区「单位」组：结果显示单位的档位（锁定 / 自适应），四窗共用（GSO / NGSO / 再生式 / 端到端）。
// 出厂锁定＝一律按引擎基准单位（W / kHz / kbps / dBW）显示；档位口径与作用范围见 shared/lbUnitMode.js。
// 值跨窗共享（localStorage + storage 事件），本窗切换由各窗自己订阅后重排结果列与详细预算。
// 样式（.lbu-seg）在 styles/lbworkbench.css。
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { isUnitAdaptive, setUnitAdaptive, onUnitModeChange } from '../shared/lbUnitMode.js'

const adaptive = ref(isUnitAdaptive())
let off = null
onMounted(() => { off = onUnitModeChange((v) => { adaptive.value = v }) })
onBeforeUnmount(() => { if (off) off() })
</script>

<template>
  <div class="lbr-g">
    <div class="lbr-items">
      <div class="lbu-seg">
        <button :class="{ on: !adaptive }"
          title="锁定：结果一律按引擎基准单位显示（W / kHz / kbps / dBW），不随数值大小换单位"
          @click="setUnitAdaptive(false)">锁定</button>
        <button :class="{ on: adaptive }"
          title="自适应：按数值大小换档（0.5 W → 500 mW、2457.6 kHz → 2.4576 MHz、整组 &lt;0 dBW → dBm），同一列跨行共选一档"
          @click="setUnitAdaptive(true)">自适应</button>
      </div>
    </div>
    <div class="lbr-cap">单位</div>
  </div>
</template>
