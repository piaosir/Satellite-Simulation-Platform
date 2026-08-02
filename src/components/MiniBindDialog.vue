<script setup>
// 「绑定小程序账号」独立弹窗（主窗口 工具 菜单，与「设置」平级）。
//
// 为什么独立于设置：绑定不是偏好设置，是一份【收件人名册】—— 会经常回来加人、改备注、解绑，
// 而设置是配一次就不再进的地方。埋在设置第四节里等于让人找不到。
//
// 管理面板本体是共享组件（MiniBindingsPanel），发送弹窗里也嵌着同一个，改一处两处都变。
import Icon from './Icon.vue'
import MiniBindingsPanel from './MiniBindingsPanel.vue'

const emit = defineEmits(['close', 'toast'])
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dlg" role="dialog" aria-modal="true">
      <header class="dhd">
        <span class="dt"><Icon name="wechat" :size="15" />绑定小程序账号</span>
        <span class="x" @click="emit('close')"><Icon name="x" :size="14" /></span>
      </header>

      <div class="body">
        <p class="lead">
          绑定后，「发送到小程序」可免密钥直接投递至这些账号；接收方打开小程序后自动同步，
          同一内容重复投递按原件覆盖。
        </p>
        <ol class="how">
          <li>在小程序「设置 → 仿真平台绑定」中长按复制认证码</li>
          <li>将认证码传至本机（可经微信「文件传输助手」），粘贴至下方输入框</li>
          <li>填写备注名，用于投递时识别账号</li>
        </ol>

        <MiniBindingsPanel @toast="(m) => emit('toast', m)" />
      </div>

      <footer class="dft">
        <button class="ok" @click="emit('close')">完成</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* 与 SettingsModal 同一套视觉语言（同样的 mask / dlg / dhd / dft） */
.mask { position: fixed; inset: 0; z-index: 2000; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; }
.dlg { width: 520px; max-width: calc(100vw - 32px); max-height: calc(100vh - 64px); display: flex; flex-direction: column;
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: 4px; box-shadow: 0 12px 40px rgba(0,0,0,0.5); }
.dhd { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.dt { display: inline-flex; align-items: center; gap: 8px; font-family: var(--font-serif); font-size: 15px; }
.x { cursor: pointer; color: var(--text-muted); padding: 2px 6px; display: inline-flex; align-items: center; }
.x:hover { color: var(--text); }
.body { padding: 14px 16px; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
.lead { font-size: 12px; line-height: 1.65; color: var(--text-muted); }
.how { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 3px; }
.how li { font-size: 11.5px; line-height: 1.6; color: var(--text-faint); }
.dft { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 12px 16px; border-top: 1px solid var(--border); }
.dft button { padding: 6px 16px; cursor: pointer; border-radius: 3px; font-size: 12.5px; }
.ok { background: var(--accent); border: 1px solid var(--accent); color: var(--bg); font-weight: 600; }
</style>
