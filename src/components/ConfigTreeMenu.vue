<script setup>
// 配置列表树的右键菜单（五个工作台共用）。
//
// 由来：菜单原先在各 App 的模板里各写一份，条目集互有出入 —— 端到端整个没有、另外三窗都缺
// 「剪切文件夹」与「移到根目录」，且粘贴项用 v-if 隐藏（有没有剪贴板会让菜单条目数跳变，
// 同一个位置每次点到不同功能）。收成一个组件后：条目恒定、灰掉表示当前不可用。
//
// 分组按资源管理器的老规矩：新建 / 剪贴板 / 改名删除 / 视图，组间一道细线。
// 位置在打开后测量修正——菜单比早先长，靠固定的 window.innerWidth-170 那种估算会被切掉。
import { ref, reactive, watch, nextTick } from 'vue'

const props = defineProps({
  menu: { type: Object, required: true },      // { open, x, y, id }
  item: { type: Object, default: null },       // 右键命中的条目（空白处右键为 null）
  isFolder: { type: Boolean, default: false },
  clip: { type: Object, default: null },       // 剪贴板 { mode, name, isFolder }
  hasApi: { type: Boolean, default: true }
})
const emit = defineEmits([
  'close', 'rename', 'new-folder', 'new-config', 'save-new',
  'cut', 'copy', 'paste', 'move-root', 'delete', 'expand-all', 'collapse-all', 'hide'
])

const boxEl = ref(null)
const pos = reactive({ x: 0, y: 0 })
// 先按指针位置落下，再按实测尺寸收进视口：右边放不下就向左翻，下边放不下就上顶
watch(() => props.menu.open, (v) => {
  if (!v) return
  pos.x = props.menu.x; pos.y = props.menu.y
  nextTick(() => {
    const box = boxEl.value; if (!box) return
    const r = box.getBoundingClientRect()
    if (props.menu.x + r.width > window.innerWidth - 6) pos.x = Math.max(6, props.menu.x - r.width)
    if (props.menu.y + r.height > window.innerHeight - 6) pos.y = Math.max(6, window.innerHeight - 6 - r.height)
  })
})
const done = (ev, ...args) => { emit('close'); emit(ev, ...args) }
</script>

<template>
  <div v-if="menu.open" class="lb-ctx-mask" @click="emit('close')" @contextmenu.prevent="emit('close')">
    <div ref="boxEl" class="lb-ctx" :style="{ left: pos.x + 'px', top: pos.y + 'px' }" @click.stop>
      <!-- ① 新建 -->
      <template v-if="isFolder">
        <button class="lb-ctx-i" @click="done('new-config', menu.id)">在此新建配置</button>
        <button class="lb-ctx-i" @click="done('new-folder', menu.id)">新建子文件夹</button>
        <div class="lb-ctx-sep"></div>
      </template>
      <template v-else-if="!item">
        <button class="lb-ctx-i" @click="done('new-config', null)">添加空白配置</button>
        <button class="lb-ctx-i" @click="done('new-folder', null)">新建文件夹</button>
        <button class="lb-ctx-i" :disabled="!hasApi" @click="done('save-new')">保存当前为新配置</button>
        <div class="lb-ctx-sep"></div>
      </template>

      <!-- ② 剪贴板：条目恒定，不可用时灰掉（隐藏会让菜单跳位） -->
      <template v-if="item">
        <button class="lb-ctx-i" @click="done('cut', item)">剪切<span class="lb-ctx-k">Ctrl+X</span></button>
        <button class="lb-ctx-i" :disabled="isFolder" :title="isFolder ? '文件夹只能剪切' : ''" @click="done('copy', item)">复制<span class="lb-ctx-k">Ctrl+C</span></button>
        <button class="lb-ctx-i" :disabled="!clip" @click="done('paste', menu.id, isFolder)">
          {{ isFolder ? '粘贴到此文件夹' : '粘贴到此后' }}<span class="lb-ctx-k">Ctrl+V</span>
        </button>
        <button class="lb-ctx-i" :disabled="item.parentId == null" @click="done('move-root', item)">移到根目录</button>
        <div class="lb-ctx-sep"></div>
      </template>
      <template v-else>
        <button class="lb-ctx-i" :disabled="!clip" @click="done('paste', null, false)">
          粘贴{{ clip && clip.mode === 'cut' ? '（移动到末尾）' : '' }}<span class="lb-ctx-k">Ctrl+V</span>
        </button>
        <div class="lb-ctx-sep"></div>
      </template>

      <!-- ③ 改名 / 删除 -->
      <template v-if="item">
        <button class="lb-ctx-i" @click="done('rename', item)">重命名<span class="lb-ctx-k">F2</span></button>
        <button class="lb-ctx-i danger" @click="done('delete', item)">
          {{ isFolder ? '删除文件夹（含子项）' : '删除' }}<span class="lb-ctx-k">Del</span>
        </button>
        <div class="lb-ctx-sep"></div>
      </template>

      <!-- ④ 视图 -->
      <button class="lb-ctx-i" @click="done('expand-all')">展开全部</button>
      <button class="lb-ctx-i" @click="done('collapse-all')">折叠全部</button>
      <button class="lb-ctx-i" @click="done('hide')">隐藏配置列表</button>
    </div>
  </div>
</template>

<style scoped>
/* 基础外观吃 lbworkbench.css 里的公共 .lb-ctx*（那份刻意不带 .lb-shell 前缀，任何组件都够得到）。
   这里只补菜单挪进组件后新增的两件事：带快捷键标签的两栏行、以及组件自身的最小宽度。 */
.lb-ctx { min-width: 172px; }
.lb-ctx-i { display: flex; align-items: center; gap: 18px; }
.lb-ctx-k { margin-left: auto; font-family: var(--font-mono); font-size: var(--fs-2); color: var(--text-faint); }
.lb-ctx-i:disabled .lb-ctx-k { color: inherit; }
</style>
