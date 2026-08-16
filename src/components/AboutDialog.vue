<script setup>
// 「关于卫星仿真平台」——交付级信息窗。
//
// 旧版是一摞居中小字（名称/版本/设备ID/激活态/一行功能），既认不出层次，也答不上交付现场
// 真正会问的那几件事。这版排成报头（名称/版本）+ 两段分区：授权（状态/档位/期限/设备ID）·
// 功能模块（本机装了哪些工作台）。视觉沿用平台的弹窗语言（MiniAboutDialog / SettingsModal 那套
// mask / dlg / dhd / sec / kv / dft），键值两栏共用一根栏名轴。
// 内核（Electron/Chromium）与运行平台曾单列一段「软件」，2026-08-16 用户定：不展示。
//
// 设备ID 行连点 5 次 = 刷新激活状态的「特定动作」之二（口径不变，由宿主传入 onTap）。
import { ref, computed, onUnmounted } from 'vue'
import Icon from './Icon.vue'
import logoUrl from '../assets/logo.png'
import { activation } from '../stores/activation'
import { byLang } from '../shared/i18n/lang.js'
import { getLang, onLangChange } from '../shared/i18n/runtime.js'

const props = defineProps({
  version: { type: String, default: '' },
  actText: { type: String, default: '' }
})
const emit = defineEmits(['close', 'refresh', 'tap'])

// 本组件里少数几处在 JS 里出字的串（授权档位/期限，见下）不经 DOM 呈现层，故得自己盯着语言变：
// 别的窗口切了语言会经 storage 事件传过来，本窗开着的对话框也要当场跟上。
const lang = ref(getLang())
const offLang = onLangChange((l) => { lang.value = l })
onUnmounted(offLang)

// 授权档位：签发端的档位码（perm / mN / yN / custom）翻成人话。
// 带数字的那两档在这里就按语言出字（不进 uiDict）：那需要一条「${n} 个月」式的开放槽位模式，
// 而首字面量为空的模式要落进 generic 全量试匹配，为两个词条给全平台加一道匹配开销不划算。
const planText = computed(() => {
  void lang.value                                  // 换语言即重算（byLang 自身不是响应式的）
  const p = String(activation.plan || '')
  if (!p) return '—'
  if (p === 'perm') return byLang('永久授权', 'Perpetual License')
  if (p === 'custom') return byLang('自定义期限', 'Custom Term')
  const m = /^m(\d{1,2})$/.exec(p); if (m) return byLang(`${Number(m[1])} 个月`, `${Number(m[1])} months`)
  const y = /^y(\d)$/.exec(p); if (y) return byLang(`${Number(y[1])} 年`, `${Number(y[1])} years`)
  return p
})
const ymd = (ms) => {
  if (!ms) return ''
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const expiryText = computed(() => (void lang.value, activation.expiresAt ? ymd(activation.expiresAt) : byLang('永久', 'Perpetual')))

// 本机装着的工作台（与「工具」菜单同一份清单）
const MODULES = [
  '链路预算 · GSO 透明转发', '链路预算 · NGSO 透明转发',
  '链路预算 · 再生处理（OBP）', '链路预算 · 端到端多跳',
  '干扰分析 C/I', 'PFD / EIRP 掩模',
  '雨衰计算', '转发器频率计划',
  '星座可视化与覆盖分析', '波束合成与方向图',
  '可见性分析', '日凌预报'
]

const copied = ref(false)
async function copyId() {
  const id = activation.deviceId; if (!id) return
  try { await navigator.clipboard.writeText(id); copied.value = true; setTimeout(() => { copied.value = false }, 1200) } catch (e) { /* 无剪贴板权限 */ }
  emit('tap')
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dlg" role="dialog" aria-modal="true">
      <header class="dhd">
        <span class="dt">关于</span>
        <span class="x" @click="emit('close')"><Icon name="x" :size="14" /></span>
      </header>

      <div class="body">
        <!-- 身份牌：标识 + 名称 + 版本 -->
        <div class="idcard">
          <img class="mark" :src="logoUrl" alt="" draggable="false" />
          <div class="idtx">
            <div class="nm">卫星仿真平台</div>
            <div class="sub">卫星通信系统链路预算与仿真分析软件</div>
          </div>
          <div v-if="version" class="vchip mono" data-i18n-skip>{{ version }}</div>
        </div>

        <section>
          <div class="sec">授权</div>
          <div class="kv">
            <div class="k">状态</div>
            <div class="v st" :class="activation.active ? 'on' : 'off'"><i class="dot"></i>{{ actText || '—' }}</div>
            <template v-if="activation.plan"><div class="k">授权档位</div><div class="v">{{ planText }}</div></template>
            <template v-if="activation.activatedAt">
              <div class="k">激活日期</div><div class="v mono" data-i18n-skip>{{ ymd(activation.activatedAt) }}</div>
            </template>
            <template v-if="activation.active"><div class="k">有效期至</div><div class="v mono">{{ expiryText }}</div></template>
            <div class="k">设备 ID</div>
            <div class="v idrow">
              <span class="id mono" data-i18n-skip>{{ activation.deviceId || '—' }}</span>
              <button v-if="activation.deviceId" class="cp" :title="copied ? '已复制' : '点击复制设备ID'" @click="copyId">
                <Icon :name="copied ? 'check' : 'copy'" :size="12" />{{ copied ? '已复制' : '复制' }}
              </button>
            </div>
          </div>
        </section>

        <section>
          <div class="sec">功能模块</div>
          <ul class="mods">
            <li v-for="m in MODULES" :key="m">{{ m }}</li>
          </ul>
        </section>
      </div>

      <footer class="dft">
        <button class="gh" :disabled="activation.busy" @click="emit('refresh')">{{ activation.busy ? '刷新中…' : '刷新激活状态' }}</button>
        <button class="ok" @click="emit('close')">确定</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* 与 MiniAboutDialog / MiniBindDialog / SettingsModal 同一套视觉语言 */
.mask { position: fixed; inset: 0; z-index: 2000; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; }
/* 512px：模块清单两栏里最长的那条英文（Link Budget · End-to-End Multi-Hop）刚好不折行 */
.dlg { width: 512px; max-width: calc(100vw - 32px); max-height: calc(100vh - 64px); display: flex; flex-direction: column;
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: 4px; box-shadow: 0 12px 40px rgba(0,0,0,0.5); }
.dhd { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.dt { font-family: var(--font-serif); font-size: 15px; }
.x { cursor: pointer; color: var(--text-muted); padding: 2px 6px; display: inline-flex; align-items: center; }
.x:hover { color: var(--text); }
.body { padding: 16px; overflow: auto; display: flex; flex-direction: column; gap: 15px; }

/* 身份牌：贴着标题栏做成通栏报头（负外边距顶掉 .body 的内边距），不是浮在里面的一个方框；
   标识墨稿在深色主题下反相（与标题栏 .brand 同一口径） */
.idcard { display: flex; align-items: center; gap: 13px; margin: -16px -16px 0; padding: 15px 16px;
  background: var(--surface-2); border-bottom: 1px solid var(--border); }
.mark { height: 26px; width: auto; flex: none; user-select: none; -webkit-user-drag: none; }
:root[data-theme='dark'] .mark { filter: invert(1) brightness(1.06); }
.idtx { min-width: 0; flex: 1; }
.nm { font-family: var(--font-serif); font-size: 16.5px; letter-spacing: .4px; }
.sub { margin-top: 3px; font-size: 11.5px; color: var(--text-muted); }
.vchip { flex: none; align-self: flex-start; padding: 1px 7px; font-size: 11px; color: var(--text-muted);
  border: 1px solid var(--border-strong); background: var(--bg); }

.sec { font-size: 11px; letter-spacing: 1px; color: var(--text-faint); padding-bottom: 5px; margin-bottom: 9px; border-bottom: 1px solid var(--border); }
/* 键值两栏共用一根 76px 栏名轴（英文「Activated」不折行） */
.kv { display: grid; grid-template-columns: 76px 1fr; column-gap: 14px; row-gap: 7px; align-items: baseline; }
.k { font-size: 11.5px; color: var(--text-faint); }
.v { font-size: 12.5px; color: var(--text); min-width: 0; overflow-wrap: anywhere; }

.st { display: inline-flex; align-items: baseline; gap: 7px; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; transform: translateY(-1px); }
.st.on { color: var(--ok); }
.st.off { color: var(--danger); }

.idrow { display: flex; align-items: center; gap: 10px; }
.id { user-select: text; }
.cp { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; font-size: 11px; cursor: pointer;
  color: var(--text-muted); background: var(--bg); border: 1px solid var(--border-strong); border-radius: 2px; }
.cp:hover { color: var(--text); border-color: var(--accent); }

/* 模块清单：两栏，行首短横（无彩细线，与地物线同一口径——不抢内容的色） */
.mods { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: 1fr 1fr; column-gap: 14px; row-gap: 5px; }
.mods li { position: relative; padding-left: 11px; font-size: 12px; color: var(--text-muted); }
.mods li::before { content: ''; position: absolute; left: 0; top: .62em; width: 6px; height: 1px; background: var(--border-strong); }

.dft { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 12px 16px; border-top: 1px solid var(--border); }
.dft button { padding: 6px 16px; cursor: pointer; border-radius: 3px; font-size: 12.5px; }
.gh { background: var(--bg); border: 1px solid var(--border-strong); color: var(--text); }
.gh:hover { border-color: var(--accent); }
.gh:disabled { opacity: .5; cursor: default; }
/* accent 实底控件的字色一律 var(--bg)：深色主题下 accent 是浅色，写死 #fff 会白底白字 */
.ok { background: var(--accent); border: 1px solid var(--accent); color: var(--bg); font-weight: 600; }
</style>
