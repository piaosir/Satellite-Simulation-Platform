<script setup>
// 「检查更新」对话框（主窗口 帮助 菜单，与「关于」平级）。
//
// 自动更新本身全程静默（services/updater.js：启动后台检查、发现即下载、退出时装），这扇窗只是
// 把同一条流水线的当前状态摆出来，并给两个主动入口：现在就查一次、下载完了现在就装。
// 状态快照是主进程的（stores/updater.js 镜像），这里不自己算任何东西；打开即检查一次。
// 视觉沿用平台的弹窗语言（AboutDialog / MiniBindDialog 那套 mask / dlg / dhd / kv / dft）。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import { updater, initUpdater, checkUpdate, installUpdate } from '../stores/updater'

const emit = defineEmits(['close'])

// 显示态：手动检查已发出、主进程的 checking 事件还没到时也按「正在检查」显示，
// 免得上一次的「已是最新」先闪一下
const shown = computed(() => {
  const p = updater.phase
  if (p === 'downloading' || p === 'downloaded' || p === 'disabled') return p
  if (updater.busy || p === 'checking') return 'checking'
  return p
})
const busy = computed(() => updater.busy || shown.value === 'checking' || shown.value === 'downloading')
const pct = computed(() => Math.max(0, Math.min(100, Math.round(updater.percent || 0))))
const mb = (b) => (b > 0 ? (b / 1048576).toFixed(1) + ' MB' : '')
const ICON = { checking: 'refresh-cw', latest: 'check', downloading: 'download', downloaded: 'check', error: 'alert-triangle', disabled: 'info', idle: 'info' }

const installErr = ref('')
async function doInstall() {
  installErr.value = ''
  if (!(await installUpdate())) installErr.value = '无法启动安装程序'
}
function doCheck() { installErr.value = ''; checkUpdate() }

onMounted(() => { initUpdater(); checkUpdate() })

// Esc 关窗（捕获阶段先收；输入法组字中不关）。不自动聚焦：下载完成后主钮会变成「立即重启安装」，
// 焦点停在它上面，一个回车就把整个软件关了
function onKey(e) { if (e.key === 'Escape' && !e.isComposing) { e.stopPropagation(); emit('close') } }
onMounted(() => window.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dlg" role="dialog" aria-modal="true">
      <header class="dhd">
        <span class="dt">检查更新</span>
        <button class="winx" type="button" aria-label="关闭" title="关闭" @click="emit('close')"><Icon name="x" :size="12" /></button>
      </header>

      <div class="body">
        <div class="kv">
          <div class="k">当前版本</div>
          <div class="v mono" data-i18n-skip>{{ updater.current || '—' }}</div>
          <template v-if="updater.latest && (shown === 'downloading' || shown === 'downloaded')">
            <div class="k">最新版本</div>
            <div class="v mono" data-i18n-skip>{{ updater.latest }}</div>
          </template>
        </div>

        <div class="st" :class="shown">
          <Icon :name="ICON[shown] || 'info'" :size="14" class="sti" />
          <div class="stx">
            <span v-if="shown === 'checking'">正在检查…</span>
            <span v-else-if="shown === 'latest'">已是最新版本。</span>
            <span v-else-if="shown === 'downloading'">正在下载新版本…</span>
            <span v-else-if="shown === 'downloaded'">新版本已下载。</span>
            <span v-else-if="shown === 'error'">检查失败：{{ updater.error }}</span>
            <span v-else-if="shown === 'disabled'">开发模式下不检查更新。</span>
            <span v-else>—</span>
            <div v-if="shown === 'downloading'" class="prog">
              <div class="bar"><i :style="{ width: pct + '%' }"></i></div>
              <span class="pt mono" data-i18n-skip>{{ pct }}%<template v-if="updater.total"> · {{ mb(updater.transferred) }} / {{ mb(updater.total) }}</template></span>
            </div>
            <!-- 已下载后的错误（拉不起安装器 / 之后的例行检查离线）不降级，只多一行 -->
            <div v-if="installErr || (shown === 'downloaded' && updater.error)" class="ierr">{{ installErr || updater.error }}</div>
          </div>
        </div>
      </div>

      <footer class="dft">
        <template v-if="shown === 'downloaded'">
          <button class="gh" @click="emit('close')">关闭</button>
          <button class="ok" title="关闭所有窗口，静默安装后自动重新打开" @click="doInstall">立即重启安装</button>
        </template>
        <template v-else>
          <button class="gh" :disabled="busy || shown === 'disabled'" @click="doCheck">{{ shown === 'checking' ? '检查中…' : '重新检查' }}</button>
          <button class="ok" @click="emit('close')">关闭</button>
        </template>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* 与 AboutDialog / MiniBindDialog / SettingsModal 同一套视觉语言 */
/* 遮罩瞬时出现（压在画布上不做淡入）；框体 160ms 升入，出场瞬时 */
.mask { position: fixed; inset: 0; z-index: 2000; background: var(--scrim); display: flex; align-items: center; justify-content: center; }
.dlg { width: 420px; max-width: calc(100vw - 32px); max-height: calc(100vh - 64px); display: flex; flex-direction: column;
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-card); box-shadow: var(--shadow-3);
  animation: ui-dlg-in var(--dur-3) var(--ease-out); }
/* 标题栏内距挪进 .dt，关闭键才能占满整条标题栏高度（总高不变） */
.dhd { display: flex; align-items: stretch; justify-content: space-between; padding: 0; border-bottom: 1px solid var(--border); }
.dt { font-family: var(--font-serif); font-size: var(--fs-5); padding: 12px 16px; align-self: center; }
/* 关闭键与「设置」「文件管理」同一枚：Windows 风矩形热区，悬停红底白字；右上内圆角 = 框体圆角 − 1px */
.winx { width: 44px; align-self: stretch; border: 0; background: transparent; color: var(--text-muted); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: var(--t-state);
  border-top-right-radius: calc(var(--r-card) - 1px); }
.winx:hover { background: #c42b1c; color: #fff; }
.body { padding: 16px; overflow: auto; display: flex; flex-direction: column; gap: 14px; }

/* 键值两栏共用一根 76px 栏名轴（与关于窗同宽） */
.kv { display: grid; grid-template-columns: 76px 1fr; column-gap: 14px; row-gap: 7px; align-items: baseline; }
.k { font-size: var(--fs-3); color: var(--text-faint); }
.v { font-size: var(--fs-4); color: var(--text); min-width: 0; overflow-wrap: anywhere; }

/* 状态行：图标 + 一句陈述；下载中在句子下面挂进度条 */
.st { display: flex; align-items: flex-start; gap: 9px; padding: 10px 12px; font-size: var(--fs-4); color: var(--text);
  background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-box); }
.sti { flex: none; margin-top: 2px; color: var(--text-muted); }
.st.latest .sti, .st.downloaded .sti { color: var(--ok); }
.st.error .sti { color: var(--danger); }
.st.checking .sti { animation: spin 1.1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
/* 减弱动效：检查中的转圈停住（无限动画不归全局过渡守卫管，得就地关） */
@media (prefers-reduced-motion: reduce) { .st.checking .sti { animation: none; } }
.stx { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 7px; overflow-wrap: anywhere; }
.prog { display: flex; align-items: center; gap: 10px; }
.bar { flex: 1; height: 4px; background: var(--border); border-radius: 2px; overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--accent); transition: width .25s linear; }
.pt { flex: none; font-size: var(--fs-2); color: var(--text-muted); }
.ierr { font-size: var(--fs-3); color: var(--danger); }

.dft { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 12px 16px; border-top: 1px solid var(--border); }
.dft button { height: var(--h-ctl-lg); white-space: nowrap; padding: 0 16px; cursor: pointer; border-radius: var(--r-box); font-size: var(--fs-4); }
/* 次要钮：纸底 + 结构描边 + 正文字；主钮：墨色实底（走 token，深色压一档）。按下由全局按下罩提供 */
.gh, .ghost { background: var(--bg); border: 1px solid var(--border-strong); color: var(--text); }
.gh:hover:not(:disabled), .ghost:hover:not(:disabled) { border-color: var(--line-hover); }
.gh:disabled { opacity: 1; color: var(--text-faint); background: var(--field-disabled-bg); border-color: var(--border); cursor: default; }
/* 实底控件的字色一律跟 token（--primary-on = --bg）：深色主题下底色是浅色，写死 #fff 会白底白字 */
.ok { background: var(--primary-fill); border: 1px solid var(--primary-fill); color: var(--primary-on); font-weight: 600; }
.ok:hover:not(:disabled) { background: var(--primary-fill-hover); border-color: var(--primary-fill-hover); }
.ok:disabled { opacity: 1; background: var(--primary-fill-disabled); border-color: transparent; color: var(--primary-on); cursor: default; }
</style>
