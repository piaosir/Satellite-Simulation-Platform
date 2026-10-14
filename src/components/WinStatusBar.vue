<script setup>
// 计算窗底部状态栏（22 px，VS Code / Office 状态栏式）：
//   左 = 通知（NoticeLine，配 shared/useNotice.js）+ 进行中状态句（中性色）+「输入已变」琥珀点 + 默认插槽
//   右 = #right 插槽（运行时读数：耗时、条数等）
// 原先这些都挤在功能区右缘（.lbr-status，margin-left:auto），功能区一溢出就落到窗外看不见。
// 本件只管排布，不持有状态；放在窗口根 flex 列的最后一个子元素即可吸底。
import NoticeLine from './NoticeLine.vue'

defineProps({
  n: { type: Object, default: null },          // useNotice() 的返回值；给了就渲染 NoticeLine
  busy: { type: String, default: '' },         // 进行中的状态句（「计算中…」等），中性色
  stale: { type: Boolean, default: false },    // 结果对应修改前的输入 → 琥珀点 +「输入已变」
  staleTitle: { type: String, default: '计算输入已被修改，结果对应修改前的参数' },
})
</script>

<template>
  <div class="wsb" role="status">
    <div class="wsb-l">
      <span v-if="busy" class="wsb-busy" :title="busy">{{ busy }}</span>
      <NoticeLine v-if="n" :n="n" />
      <span v-if="stale" class="wsb-stale" :title="staleTitle">输入已变</span>
      <slot />
    </div>
    <div class="wsb-r"><slot name="right" /></div>
  </div>
</template>

<style scoped>
.wsb {
  flex: none; display: flex; align-items: center; gap: 12px; height: 22px; padding: 0 8px; min-width: 0;
  background: var(--surface); border-top: 1px solid var(--border); color: var(--text-muted);
  font-size: var(--fs-2); line-height: 1; white-space: nowrap; overflow: hidden;
}
.wsb-l { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; overflow: hidden; }
.wsb-r { flex: none; display: flex; align-items: center; gap: 10px; font-variant-numeric: tabular-nums; }
.wsb-r:empty { display: none; }
.wsb-busy { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.wsb-stale { flex: none; display: inline-flex; align-items: center; gap: 5px; color: var(--warn); }
.wsb-stale::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--warn); }
.wsb :deep(.nl) { max-width: none; flex: 0 1 auto; }
</style>
