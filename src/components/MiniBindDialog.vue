<script setup>
// 「绑定小程序账号」独立弹窗（主窗口 工具 菜单，与「设置」平级）。
//
// 为什么独立于设置：绑定不是偏好设置，是一份【收件人名册】—— 会经常回来加人、改备注、解绑，
// 而设置是配一次就不再进的地方。埋在设置第四节里等于让人找不到。
//
// 管理面板本体是共享组件（MiniBindingsPanel），发送弹窗里也嵌着同一个，改一处两处都变。
import { ref, onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import MiniBindingsPanel from './MiniBindingsPanel.vue'

const emit = defineEmits(['close', 'toast'])

// 提交只有一处：底栏「绑定」（面板的行内键关掉）。原先行内「添加」+ 底栏「完成」两个键，
// 粘完码顺手点「完成」就是关窗、码白粘了。绑定后不关窗：新账号出现在名册里就是回执
// （toast 只进默认收起的日志窗格，关了窗什么都看不到）；关窗走 ✕ / Esc / 点遮罩。
const panel = ref(null)

// Esc 关窗（捕获阶段先收；输入法组字中不关）。不自动聚焦底栏主钮：这扇窗的正事是粘贴认证码
function onKey(e) { if (e.key === 'Escape' && !e.isComposing) { e.stopPropagation(); emit('close') } }
onMounted(() => window.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dlg" role="dialog" aria-modal="true">
      <header class="dhd">
        <span class="dt"><Icon name="wechat" :size="16" />绑定小程序账号</span>
        <button class="winx" type="button" aria-label="关闭" title="关闭" @click="emit('close')"><Icon name="x" :size="12" /></button>
      </header>

      <div class="body">
        <MiniBindingsPanel ref="panel" :add-btn="false" @toast="(m) => emit('toast', m)" />
      </div>

      <footer class="dft">
        <button class="ok" :disabled="!panel?.canAdd" @click="panel?.add()">绑定</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* 与 SettingsModal 同一套视觉语言（同样的 mask / dlg / dhd / dft） */
/* 遮罩瞬时出现（压在画布上不做淡入）；框体 160ms 升入，出场瞬时 */
.mask { position: fixed; inset: 0; z-index: 2000; background: var(--scrim); display: flex; align-items: center; justify-content: center; }
.dlg { width: 520px; max-width: calc(100vw - 32px); max-height: calc(100vh - 64px); display: flex; flex-direction: column;
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-card); box-shadow: var(--shadow-3);
  animation: ui-dlg-in var(--dur-3) var(--ease-out); }
/* 标题栏内距挪进 .dt，关闭键才能占满整条标题栏高度（总高不变） */
.dhd { display: flex; align-items: stretch; justify-content: space-between; padding: 0; border-bottom: 1px solid var(--border); }
.dt { display: inline-flex; align-items: center; gap: 8px; font-family: var(--font-serif); font-size: var(--fs-5); padding: 12px 16px; align-self: center; }
/* 关闭键与「设置」「文件管理」同一枚：Windows 风矩形热区，悬停红底白字；右上内圆角 = 框体圆角 − 1px */
.winx { width: 44px; align-self: stretch; border: 0; background: transparent; color: var(--text-muted); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: var(--t-state);
  border-top-right-radius: calc(var(--r-card) - 1px); }
.winx:hover { background: #c42b1c; color: #fff; }
.body { padding: 14px 16px; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
.dft { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 12px 16px; border-top: 1px solid var(--border); }
.dft button { height: var(--h-ctl-lg); white-space: nowrap; padding: 0 16px; cursor: pointer; border-radius: var(--r-box); font-size: var(--fs-4); }
/* 主钮：墨色实底（走 token，深色压一档）；字色跟 --primary-on，禁写死 #fff。按下由全局按下罩提供 */
.ok { background: var(--primary-fill); border: 1px solid var(--primary-fill); color: var(--primary-on); font-weight: 600; }
.ok:hover:not(:disabled) { background: var(--primary-fill-hover); border-color: var(--primary-fill-hover); }
.ok:disabled { opacity: 1; background: var(--primary-fill-disabled); border-color: transparent; color: var(--primary-on); cursor: default; }
</style>
