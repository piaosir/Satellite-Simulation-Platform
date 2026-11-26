<script setup>
import { computed } from 'vue'
import Icon from './Icon.vue'
import AngleVisibilityButton from './AngleVisibilityButton.vue'

const props = defineProps({ line: Object, collection: Object })
const emit = defineEmits(['menu'])
const elevation = computed(() => props.line.kind === 'elevation')
const title = computed(() => elevation.value ? '仰角线' : '波束角线')
const angleTip = computed(() => elevation.value ? '从观测端当地水平面量起' : '圆锥两侧边缘之间的夹角')
const editing = computed(() => props.collection.editing.value === props.line.id)
const patterns = [['solid', '实线', ''], ['dash', '虚线', '7 5'], ['dot', '点线', '1 4'], ['dashdot', '点划线', '9 4 2 4']]
const pattern = computed(() => patterns.find(p => p[0] === props.line.dash)?.[2])
function selectLine() { props.collection.editing.value = props.line.id }
</script>

<template>
  <div class="angle-child" :data-line-id="line.id" :class="{ editing, elevation }">
    <div class="angle-head" @contextmenu.prevent.stop="emit('menu', $event, line.id)">
      <AngleVisibilityButton :visible="line.show" :color="line.color" :width="line.width" :dash-array="pattern"
                            :label="(line.name || title) + ' ' + line.angle + '°'" @click.stop="collection.toggle(line)" />
      <button type="button" class="angle-name" :aria-pressed="editing" title="编辑设置" @click="selectLine">
        <span>{{ line.name || title }}</span><b :title="angleTip">{{ line.angle }}°</b>
      </button>
      <button type="button" class="ibtn sm danger" title="删除角度线" @click="collection.remove(line.id)"><Icon name="x" :size="12" /></button>
    </div>

  </div>
</template>

<style scoped>
.angle-child { margin: 0 0 2px 22px; padding: 0 6px; border-radius: var(--r-box); color: var(--text-muted); font-size: var(--fs-2); }
.angle-child:hover { background: var(--wash-hover); }
.angle-child.editing { background: var(--accent-ui-wash); box-shadow: inset 2px 0 var(--accent-ui); }
.angle-child.elevation { margin-left: 0; }
.angle-head, .angle-name { display: flex; align-items: center; gap: 6px; min-width: 0; }
.angle-head { gap: 2px; }
.angle-name { flex: 1; background: none; border: 0; color: inherit; font: inherit; padding: 4px 0; cursor: pointer; }
.angle-name b { font-variant-numeric: tabular-nums; color: var(--text); }
.angle-name span { text-overflow: ellipsis; overflow: hidden; white-space: nowrap; }
.angle-name svg, .angle-name b { flex: none; }
</style>
