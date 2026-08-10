<script setup>
// 未激活全窗遮罩（八个独立功能窗口根部各挂一份；主窗口刻意不用——主窗口挂全窗遮罩
// 试过一轮，用户明确否掉（2026-08-10，「完全无法使用」）：未激活也保留地球/星座等
// 已加载内容的查看，锁在功能入口与侧栏面板上，见 App.vue）。
// 挂上即自管：初始化状态订阅、未激活时盖住整窗。
// 遮罩上只有状态本身与两个操作：复制设备ID（报给管理员开通用）、刷新激活状态。
import { onMounted, ref } from 'vue'
import { activation, activationLocked, initActivation, refreshActivation, lockTitle } from '../stores/activation'

onMounted(initActivation)

const copied = ref(false)
async function copyId() {
  try {
    await navigator.clipboard.writeText(activation.deviceId || '')
    copied.value = true
    setTimeout(() => { copied.value = false }, 1200)
  } catch { /* 剪贴板不可用 */ }
}
</script>

<template>
  <div v-if="activationLocked" class="al-mask">
    <div class="al-card">
      <div class="al-tt">{{ lockTitle() }}</div>
      <div class="al-id mono" :title="copied ? '已复制' : '点击复制设备ID'" @click="copyId">
        <span class="al-idk">设备ID</span>{{ activation.deviceId || '—' }}<span v-if="copied" class="al-ok">已复制</span>
      </div>
      <button class="al-btn" :disabled="activation.busy" @click="refreshActivation()">
        {{ activation.busy ? '刷新中…' : '刷新激活状态' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.al-mask {
  position: fixed; inset: 0; z-index: 4000;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--bg) 72%, transparent);
  backdrop-filter: blur(5px);
}
.al-card {
  min-width: 320px; padding: 30px 40px 26px; text-align: center;
  background: var(--surface); border: 1px solid var(--border-strong);
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.3);
}
.al-tt { font-family: var(--font-serif); font-size: 20px; letter-spacing: 1px; }
.al-id {
  margin-top: 12px; padding: 5px 10px; display: inline-flex; align-items: center; gap: 8px;
  font-size: 15px; border: 1px solid var(--border); background: var(--bg);
  cursor: pointer; user-select: text;
}
.al-id:hover { border-color: var(--accent); }
.al-idk { color: var(--text-faint); font-size: 11.5px; }
.al-ok { color: var(--ok); font-size: 11.5px; }
.al-btn {
  display: block; margin: 18px auto 0; padding: 5px 26px;
  border: 1px solid var(--border-strong); background: var(--bg); color: var(--text);
  cursor: pointer; border-radius: 2px;
}
.al-btn:hover { border-color: var(--accent); }
.al-btn:disabled { opacity: .5; cursor: default; }
</style>
