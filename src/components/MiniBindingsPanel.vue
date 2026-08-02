<script setup>
// 「小程序绑定」管理面板（主窗口设置弹窗 与 链路预算三窗的发送弹窗共用）。
//
// 为什么做成共享组件而不是只放在主窗口的设置里：链路预算三窗是【独立窗口】，在 GEO 窗口里想加
// 一个收件人却得切回主窗口去设置 —— 那是最容易让人放弃这个功能的一步。故发送弹窗里就地能加。
//
// 认证码由小程序端生成（方向不能反，见 shared/miniBindings.js 头部），这里只负责记下来。
import { ref, onMounted } from 'vue'
import Icon from './Icon.vue'
import { normalizeCh, isCh, fmtCh } from '../shared/miniPack.js'
import { loadBindings, addBinding, removeBinding, renameBinding } from '../shared/miniBindings.js'

const props = defineProps({
  // compact：嵌在发送弹窗里时用（去掉标题、收窄留白）
  compact: { type: Boolean, default: false },
  // 初始列表。调用方手上已经有（发送弹窗为了出「发给谁」本就加载过一遍）就传进来，
  // 省掉一次 getSettings 往返；不传就自己去读。往后的增删仍以本组件读回的为准。
  list: { type: Array, default: null }
})
const emit = defineEmits(['change', 'toast'])
const api = typeof window !== 'undefined' ? window.api : null

const list = ref(Array.isArray(props.list) ? props.list.slice() : [])
const chIn = ref('')
const nameIn = ref('')
const err = ref('')
const selfLabel = ref('')
const busy = ref(false)

const chOk = () => isCh(chIn.value)

async function refresh() {
  list.value = await loadBindings(api)
  emit('change', list.value)
}

onMounted(async () => {
  await refresh()
  try { const s = await api?.store?.getSettings?.(); selfLabel.value = String((s && s.miniSelfLabel) || '') } catch { /* ignore */ }
})

// 粘贴时顺手归一：用户从微信复制过来多半带着分隔符或空格
function onChInput(e) {
  chIn.value = normalizeCh(e.target.value)
  err.value = ''
}

async function add() {
  if (busy.value) return
  err.value = ''
  if (!isCh(chIn.value)) { err.value = '认证码应为 12 位（在小程序「设置 → 仿真平台绑定」里长按复制）'; return }
  busy.value = true
  const r = await addBinding(api, chIn.value, nameIn.value)
  busy.value = false
  if (!r.ok) { err.value = r.error || '添加失败'; return }
  list.value = r.list
  emit('change', r.list)
  emit('toast', r.dup ? '该账号已绑定，备注名已更新' : '已绑定')
  chIn.value = ''; nameIn.value = ''
}

async function del(b) {
  list.value = await removeBinding(api, b.ch)
  emit('change', list.value)
}

async function rename(b, e) {
  const v = String(e.target.value || '').slice(0, 40)
  if (v === b.name) return
  list.value = await renameBinding(api, b.ch, v)
  emit('change', list.value)
}

async function saveSelf() {
  try { await api?.store?.setSettings?.({ miniSelfLabel: selfLabel.value.slice(0, 40) }) } catch { /* ignore */ }
}

// 「3 天前」这类相对时刻：绝对时间在这儿没有信息量，用户只关心「最近发过没有」
function ago(ts) {
  if (!ts) return '—'
  const d = Date.now() - ts
  if (d < 60000) return '刚刚'
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前'
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前'
  if (d < 30 * 86400000) return Math.floor(d / 86400000) + ' 天前'
  return new Date(ts).toLocaleDateString('zh-CN')
}
</script>

<template>
  <div class="mb" :class="{ compact }">
    <div v-if="!compact" class="mb-self">
      <span class="mb-lb">本机名称</span>
      <input v-model="selfLabel" maxlength="40" placeholder="如「朴东旭的笔记本」" @blur="saveSelf" @keyup.enter="saveSelf" />
      <span class="mb-hint">该名称作为投递来源显示在接收端</span>
    </div>

    <div class="mb-list">
      <div v-for="b in list" :key="b.ch" class="mb-row">
        <input class="mb-nm" :value="b.name" maxlength="40" placeholder="未命名账号" @change="rename(b, $event)" />
        <span class="mb-ch" :title="'认证码 ' + fmtCh(b.ch)">{{ fmtCh(b.ch) }}</span>
        <span class="mb-at">{{ b.lastSentAt ? ago(b.lastSentAt) : '未投递' }}</span>
        <span class="mb-x" title="解除绑定" @click="del(b)"><Icon name="x" :size="12" /></span>
      </div>
      <div v-if="!list.length" class="mb-empty">尚无已绑定的小程序账号。</div>
    </div>

    <div class="mb-add">
      <input
        class="mb-in-ch"
        :value="chIn"
        maxlength="14"
        placeholder="粘贴 12 位认证码"
        :class="{ ok: chOk() }"
        @input="onChInput"
        @keyup.enter="add"
      />
      <input v-model="nameIn" class="mb-in-nm" maxlength="40" placeholder="备注名（可选）" @keyup.enter="add" />
      <button class="mb-btn" :disabled="busy || !chOk()" @click="add">添加</button>
    </div>
    <div v-if="err" class="mb-err">{{ err }}</div>
  </div>
</template>

<style scoped>
.mb { display: flex; flex-direction: column; gap: 8px; }
.mb-self { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mb-lb { font-size: 12.5px; color: var(--text); flex: none; }
.mb-self input { flex: 1; min-width: 160px; font: inherit; font-size: 12px; padding: 5px 8px; outline: none;
  color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.mb-hint { flex: 100%; font-size: 11px; color: var(--text-faint); }
.mb-list { border: 1px solid var(--border); border-radius: var(--r-box, 3px); background: var(--bg); max-height: 190px; overflow-y: auto; }
.mb-row { display: flex; align-items: center; gap: 7px; padding: 3px 6px 3px 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent); }
.mb-row:last-child { border-bottom: 0; }
.mb-nm { flex: 1; min-width: 0; font: inherit; font-size: 11.5px; padding: 2px 4px; color: var(--text);
  background: transparent; border: 1px solid transparent; border-radius: var(--r-ctl, 2px); outline: none; }
.mb-nm:hover { border-color: var(--border); }
.mb-nm:focus { border-color: var(--accent); background: var(--bg); }
.mb-ch { flex: none; font-family: var(--font-mono); font-size: 10.5px; color: var(--text-muted); letter-spacing: .3px; }
.mb-at { flex: none; width: 62px; text-align: right; font-size: 10.5px; color: var(--text-faint); }
.mb-x { flex: none; display: inline-flex; padding: 2px; cursor: pointer; color: var(--text-faint); border-radius: var(--r-ctl, 2px); }
.mb-x:hover { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.mb-empty { padding: 8px 9px; font-size: 11px; color: var(--text-faint); }
.mb-add { display: flex; gap: 6px; }
.mb-add input { font: inherit; font-size: 11.5px; padding: 5px 8px; outline: none; color: var(--text);
  background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.mb-in-ch { flex: none; width: 150px; font-family: var(--font-mono); letter-spacing: .5px; text-transform: uppercase; }
.mb-in-ch.ok { border-color: var(--ok); }
.mb-in-nm { flex: 1; min-width: 0; }
.mb-btn { flex: none; font: inherit; font-size: 11.5px; line-height: 1; padding: 5px 11px; cursor: pointer;
  background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.mb-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.mb-btn:disabled { opacity: .45; cursor: not-allowed; }
.mb-err { font-size: 11.5px; line-height: 1.55; color: var(--warn); }
.compact .mb-list { max-height: 120px; }
</style>
