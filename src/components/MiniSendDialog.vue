<script setup>
// 「发送到小程序」弹窗（链路预算三窗的分享弹窗与文件区的频率计划页共用）。
//
// 两种投法并存，由上面那排「发给谁」选：
//   · 已绑定账号 —— 免密钥直投。给常用的人（自己的手机、同事），一次绑定长期有效，
//                    且小程序端会自动同步（改一次内容，手机上那一份跟着变）。
//   · 生成密钥   —— 8 位一次性密钥。给客户 / 临时协作 / 没绑定过的人。
//
// 本组件只管：出包内清单 → 投递 → 把结果摆出来。造包是调用方的事（items 由 lbMiniExport /
// fpMiniExport 备好），本组件不认识任何一种载荷。
//
// 密钥 8 位、字母表 31 个字符（A-Z2-9，去掉易混的 I L O 0 1，见 electron/services/share.js）。
// 对象匿名公读、不可列举 —— 密钥即凭证。链路配置里含站址与工程参数，知晓即可。
import { ref, computed, watch } from 'vue'
import Icon from './Icon.vue'
import MiniBindingsPanel from './MiniBindingsPanel.vue'
import { makePack, sendPack, sendUnitsToBoxes, unitsOfPack, unitOfRaw, estimateBytes, fmtBytes, SIZE_WARN, TTL_DAYS } from '../shared/miniPack.js'
import { loadBindings, markSent } from '../shared/miniBindings.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  // 打开时现算（勾选可能刚变过）。两种返回形态：
  //   { name, items }            标准包 —— 链路配置 / 频率计划，逐件拆开投
  //   { name, raw, sync, label } 整块载荷 —— 覆盖快照（没有 items[]），一件就是一条消息
  // 都为空即禁用发送。收到 picks 的选值作为入参：build({ <key>: <value> })。
  build: { type: Function, required: true },
  // 发送前要先定的选项（覆盖快照用它选「这份数据算哪颗星的」）。
  // [{ key, label, hint, options: [{ value, label }], default }]，选值原样喂给 build()。
  picks: { type: Array, default: () => [] },
  deviceId: { type: String, default: '' },
  configured: { type: Boolean, default: false },
  // 密钥模式下提示去小程序哪里输（覆盖快照落在「卫星覆盖」，配置落在「我的配置」）
  keyHint: { type: String, default: '小程序「我的配置 → 导入 → 平台密钥」输入' }
})
const emit = defineEmits(['update:open', 'toast'])
const close = () => emit('update:open', false)
const api = typeof window !== 'undefined' ? window.api : null

// 包内清单是【逐件可选】的：一份链路配置常有十几条链路，而发给对方的往往只是其中一两条。
// 全量发既费流量，也让手机上那份配置列表被无关链路淹掉。故 allUnits 存全量、on[] 存勾选态，
// 密钥模式的载荷按勾选【重新打包】（不是发全量再让对方挑）。
const src = ref(null)       // 造包原料：{ raw, sync, name, label } 整块载荷 | { name, from, items } 标准包
const allUnits = ref([])    // 全量投递单元（清单显示用）
const on = ref([])          // 与 allUnits 等长的勾选态
const err = ref('')
const busy = ref(false)
const key = ref('')
const warn = ref('')

// —— 发给谁 ——
const bindings = ref([])
const picked = ref(new Set())     // 勾选的认证码
const wantKey = ref(false)        // 另外再生成一个密钥
const mngOpen = ref(false)        // 就地展开绑定管理（三窗是独立窗口，切回主窗口去设置太远）
const sentTo = ref([])            // 投递成功的绑定（结果页展示）
const appVer = ref('')
// 本机在小程序那边显示成什么（「朴东旭的笔记本」）。设置页里改，存 settings.miniSelfLabel；
// 没起过名就退回派生的机器ID —— 手机上至少能认出是哪台机器发来的。
const selfLabel = ref('')

// 上次投给了谁：记在 localStorage，下次打开默认勾上 —— 这个弹窗的高频用法是「反复发给同一个人」
const LAST_KEY = 'mini-send-last'
const readLast = () => { try { return JSON.parse(localStorage.getItem(LAST_KEY) || '[]') } catch { return [] } }
const writeLast = (arr) => { try { localStorage.setItem(LAST_KEY, JSON.stringify(arr)) } catch { /* ignore */ } }

// 发送前要先定的选项（覆盖快照用它选「这份数据算哪颗星的」）。
// 改一项就重攒包 —— 选值要进载荷，不重攒发出去的还是旧的那份。
const pickVals = ref({})
function rebuild() {
  try {
    const b = props.build({ ...pickVals.value }) || {}
    if (b.raw) {
      // 整块载荷（覆盖快照）：不套 makePack 的信封 —— 它自带 kind='gxt-snapshot'，
      // 小程序那边按 kind 分流，套上去反而认不出来了。整块就是一件，勾选对它是恒真。
      src.value = { raw: b.raw, sync: b.sync, name: b.name, label: b.label }
      allUnits.value = unitOfRaw(b.raw, { sync: b.sync, name: b.name, label: b.label })
    } else {
      const items = Array.isArray(b.items) ? b.items.filter(Boolean) : []
      src.value = { name: b.name, from: b.from || props.deviceId, items }
      // unitsOfPack 就是 items.map，故 on[] 的下标对 allUnits 与 src.items 同时成立
      allUnits.value = unitsOfPack(makePack({ name: b.name, from: src.value.from, items }))
    }
    on.value = allUnits.value.map(() => true)     // 默认全选：多数情况就是整份发过去
    err.value = ''
  } catch (e) {
    src.value = null; allUnits.value = []; on.value = []
    err.value = '内容准备失败：' + ((e && e.message) || e)
  }
}
function onPick(k, e) { pickVals.value = { ...pickVals.value, [k]: e.target.value }; rebuild() }

function reset() {
  key.value = ''; err.value = ''; warn.value = ''; busy.value = false; sentTo.value = []
  const init = {}
  for (const p of props.picks || []) {
    init[p.key] = p.default != null && p.default !== '' ? p.default : ((p.options && p.options[0] && p.options[0].value) || '')
  }
  pickVals.value = init
  rebuild()
  loadBindings(api).then((list) => {
    bindings.value = list
    const last = new Set(readLast())
    const hit = list.filter((b) => last.has(b.ch)).map((b) => b.ch)
    // 没有历史就默认全勾（绑定过的账号本就是「我要发给的人」）；一个都没绑定则退回密钥模式
    picked.value = new Set(hit.length ? hit : list.map((b) => b.ch))
    wantKey.value = !list.length
  })
  if (!appVer.value) { try { api?.app?.version?.().then((v) => { appVer.value = String(v || '') }) } catch { /* ignore */ } }
  try { api?.store?.getSettings?.().then((s) => { selfLabel.value = String((s && s.miniSelfLabel) || '') }) } catch { /* ignore */ }
}
// immediate：父组件可能是「挂载时就已经 open」的用法（v-if 挂载 + open 同时为真），
// 那种情况下只监听后续变化就永远不会攒包，弹窗打开是空的。
watch(() => props.open, (v) => { if (v) reset() }, { immediate: true })

const rows = computed(() => allUnits.value)                                   // 清单显示全量（含未勾选的）
const units = computed(() => allUnits.value.filter((u, i) => on.value[i]))    // 绑定模式逐件投的，只投勾选的
const nSel = computed(() => units.value.length)
const allOn = computed(() => rows.value.length > 0 && nSel.value === rows.value.length)
// 密钥模式的整份载荷：按勾选【重新打包】。一件都没勾就是 null（发送按钮同时禁用）。
const pack = computed(() => {
  const s = src.value
  if (!s) return null
  if (s.raw) return on.value[0] ? s.raw : null
  const items = s.items.filter((it, i) => on.value[i])
  return items.length ? makePack({ name: s.name, from: s.from, items }) : null
})
const totalBytes = computed(() => (pack.value ? estimateBytes(pack.value) : 0))
const info = computed(() => ({
  n: nSel.value,
  bytes: totalBytes.value,
  text: `${nSel.value}${rows.value.length > nSel.value ? ' / ' + rows.value.length : ''} 件 · ${fmtBytes(totalBytes.value)}`
}))
const tooBig = computed(() => totalBytes.value > SIZE_WARN)
const nPicked = computed(() => picked.value.size)
const canSend = computed(() => nSel.value > 0 && props.configured && (nPicked.value > 0 || wantKey.value))

function toggleUnit(i) { const a = on.value.slice(); a[i] = !a[i]; on.value = a }
function selectAllUnits(v) { on.value = rows.value.map(() => !!v) }

function toggle(ch) {
  const s = new Set(picked.value)
  if (s.has(ch)) s.delete(ch); else s.add(ch)
  picked.value = s
}

// 就地加/删绑定后同步这边的清单：新加的自动勾上（刚加完必然是想发给它），删掉的从勾选里摘掉
function onBindingsChange(list) {
  const known = new Set(bindings.value.map((b) => b.ch))
  const next = new Set([...picked.value])
  for (const b of list) if (!known.has(b.ch)) next.add(b.ch)
  const alive = new Set(list.map((b) => b.ch))
  for (const ch of [...next]) if (!alive.has(ch)) next.delete(ch)
  bindings.value = list
  picked.value = next
}

async function doSend() {
  if (!pack.value || busy.value || !canSend.value) return
  busy.value = true; err.value = ''; warn.value = ''
  const problems = []

  // 1) 绑定账号直投（一件一条消息，小程序侧按 srcId / 计划 id 幂等覆盖）
  if (nPicked.value) {
    const chs = [...picked.value]
    const r = await sendUnitsToBoxes(api, chs, units.value, {
      pid: props.deviceId, label: selfLabel.value || props.deviceId, app: appVer.value
    })
    if (r.done.length) {
      sentTo.value = bindings.value.filter((b) => r.done.includes(b.ch))
      writeLast(r.done)
      await markSent(api, r.done, rows.value.length)
    }
    if (r.error) problems.push(r.error)
    for (const f of r.fails) problems.push(`${f.ch}：${f.error}`)
  }

  // 2) 另外生成密钥（与直投并行存在：可以既发给同事、又给客户一个码）
  if (wantKey.value) {
    const r = await sendPack(api, pack.value)
    if (r.ok) { key.value = r.key; warn.value = r.warn || '' }
    else problems.push(r.error || '密钥生成失败')
  }

  busy.value = false
  err.value = problems.join('\n')
  if (sentTo.value.length || key.value) {
    const parts = []
    if (sentTo.value.length) parts.push(`已投递 ${sentTo.value.length} 个账号`)
    if (key.value) parts.push('密钥 ' + key.value)
    emit('toast', parts.join('，'))
  }
}
const doneAny = computed(() => sentTo.value.length > 0 || !!key.value)

async function copyKey() {
  if (!key.value) return
  try { await navigator.clipboard.writeText(key.value); emit('toast', '密钥已复制') }
  catch (e) { emit('toast', '复制失败，请手动选择文本复制') }
}
</script>

<template>
  <div v-if="open" class="ms-mask" @click="close">
    <div class="ms-dlg" @click.stop>
      <div class="ms-hd">
        <Icon name="external-link" :size="13" />
        <span class="ms-hd-t">发送到小程序</span>
        <span class="ms-sp"></span>
        <span v-if="deviceId" class="ms-id">本机标识：<b>{{ deviceId }}</b></span>
      </div>

      <div class="ms-bd">
        <template v-if="!doneAny">
          <template v-if="picks.length">
            <div class="ms-sec">发送内容</div>
            <div class="ms-picks">
              <label v-for="p in picks" :key="p.key" class="ms-pk">
                <span class="ms-pk-l">{{ p.label }}</span>
                <select :value="pickVals[p.key]" @change="onPick(p.key, $event)">
                  <option v-for="o in p.options" :key="o.value" :value="o.value">{{ o.label }}</option>
                </select>
              </label>
            </div>
          </template>

          <div class="ms-sec">
            包内清单<span class="ms-src">{{ info.text }}</span>
            <span class="ms-sp"></span>
            <span v-if="rows.length > 1" class="ms-lnk" @click="selectAllUnits(true)">全选</span>
            <span v-if="rows.length > 1" class="ms-lnk" @click="selectAllUnits(false)">清空</span>
          </div>
          <div class="ms-list">
            <label v-for="(u, i) in rows" :key="i" class="ms-row ms-pick" :class="{ off: !on[i] }">
              <input type="checkbox" :checked="on[i]" @change="toggleUnit(i)" />
              <span class="ms-k">{{ u.label }}</span>
              <span class="ms-nm" :title="u.name">{{ u.name }}</span>
              <span v-if="u.payload && u.payload.items && u.payload.items[0] && u.payload.items[0].mod" class="ms-tag">{{ u.payload.items[0].mod }}</span>
            </label>
            <div v-if="!rows.length" class="ms-empty">没有可发送的内容。</div>
          </div>

          <div class="ms-sec">接收方</div>
          <div class="ms-list">
            <label v-for="b in bindings" :key="b.ch" class="ms-row ms-pick">
              <input type="checkbox" :checked="picked.has(b.ch)" @change="toggle(b.ch)" />
              <span class="ms-nm" :title="b.ch">{{ b.name || '未命名账号' }}</span>
              <span class="ms-ch">{{ b.ch.match(/.{1,4}/g).join('-') }}</span>
            </label>
            <label class="ms-row ms-pick">
              <input v-model="wantKey" type="checkbox" />
              <span class="ms-nm">生成一次性密钥</span>
              <span class="ms-ch">用于未绑定账号</span>
            </label>
            <div v-if="!bindings.length" class="ms-empty">尚无已绑定的小程序账号。</div>
          </div>
          <div class="ms-mng">
            <span class="ms-mng-t" @click="mngOpen = !mngOpen">{{ mngOpen ? '收起' : '管理绑定…' }}</span>
          </div>
          <MiniBindingsPanel v-if="mngOpen" compact :list="bindings" @change="onBindingsChange" @toast="(m) => emit('toast', m)" />

          <div v-if="tooBig && wantKey" class="ms-warnbox">
            内容 {{ fmtBytes(info.bytes) }}，接近微信云函数 1 MB 返回上限。该限制仅作用于密钥模式（整包单次拉取），绑定账号按件拉取不受此限。
          </div>
          <div v-if="err" class="ms-warnbox">{{ err }}</div>
          <div v-if="!configured" class="ms-warnbox">「发送到小程序」尚未配置（缺少 COS 凭证：shareConfig.js 或 COS_SECRET_ID 等环境变量）。</div>
          <div class="ms-acts">
            <button class="ms-btn primary" :disabled="busy || !canSend" @click="doSend">{{ busy ? '发送中…' : '发送' }}</button>
            <span v-if="nPicked" class="ms-note">{{ rows.length }} 项内容将同步至 {{ nPicked }} 个账号</span>
          </div>
        </template>

        <template v-else>
          <template v-if="sentTo.length">
            <div class="ms-sec">已投递</div>
            <div class="ms-list">
              <div v-for="b in sentTo" :key="b.ch" class="ms-row">
                <span class="ms-nm">{{ b.name || '未命名账号' }}</span>
                <span class="ms-ch">{{ b.ch.match(/.{1,4}/g).join('-') }}</span>
              </div>
            </div>
            <div class="ms-note">接收方打开小程序后自动同步；同一内容重复投递按原件覆盖。</div>
          </template>

          <template v-if="key">
            <div class="ms-sec">密钥</div>
            <div class="ms-key" @click="copyKey">{{ key }}</div>
            <div class="ms-acts">
              <button class="ms-btn primary" @click="copyKey">复制密钥</button>
              <span class="ms-note">{{ keyHint }}；有效期 {{ TTL_DAYS }} 天。</span>
            </div>
          </template>

          <div v-if="warn" class="ms-warnbox">{{ warn }}</div>
          <div v-if="err" class="ms-warnbox">{{ err }}</div>
        </template>
      </div>

      <div class="ms-ft"><button class="ms-btn" @click="close">关闭</button></div>
    </div>
  </div>
</template>

<style scoped>
/* 视觉语言与 LbShareDialog 一致（同一套 CSS 变量）；类名 ms- 前缀，不与任何 App 内的类冲突 */
.ms-mask { position: fixed; inset: 0; z-index: 320; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.28); }
.ms-dlg { width: 460px; max-width: 92vw; max-height: 84vh; display: flex; flex-direction: column; background: var(--bg); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--r-modal, 4px); box-shadow: 0 8px 24px rgba(0,0,0,.18); overflow: hidden; }
.ms-hd { display: flex; align-items: center; gap: 7px; padding: 10px 12px; background: var(--surface-2); border-bottom: 1px solid var(--border); }
.ms-hd-t { font-size: 11px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; color: var(--text-muted); }
.ms-sp { flex: 1; }
.ms-id { font-size: 11px; color: var(--text-muted); }
.ms-id b { font-family: var(--font-mono); color: var(--text); }
.ms-bd { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 7px; overflow-y: auto; }
.ms-ft { display: flex; justify-content: flex-end; padding: 8px 12px; border-top: 1px solid var(--border); background: var(--surface); }
.ms-sec { display: flex; align-items: baseline; gap: 8px; font-size: 11px; font-weight: 600; color: var(--text-muted); letter-spacing: .5px; }
.ms-src { font-weight: 400; font-size: 10.5px; color: var(--text-faint); }
.ms-list { max-height: 220px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--r-box, 3px); background: var(--bg); }
.ms-row { display: flex; align-items: center; gap: 7px; padding: 4px 8px; font-size: 11.5px; border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent); }
.ms-row:last-child { border-bottom: 0; }
.ms-k { flex: none; width: 56px; color: var(--text-faint); }
.ms-nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ms-tag { flex: none; font-family: var(--font-mono); font-size: 10px; line-height: 15px; padding: 0 5px; color: var(--text-faint); border: 1px solid var(--border-strong); border-radius: 999px; }
.ms-pick { cursor: pointer; user-select: none; }
.ms-pick:hover { background: var(--surface-2); }
.ms-pick input { flex: none; margin: 0; cursor: pointer; }
/* 未勾选的行压暗但仍可读：清单是「这份配置里有哪些链路」的全貌，不是只列要发的那几条 */
.ms-pick.off .ms-k, .ms-pick.off .ms-nm, .ms-pick.off .ms-tag { opacity: .42; }
.ms-lnk { font-weight: 400; font-size: 10.5px; color: var(--text-faint); cursor: pointer; }
.ms-lnk:hover { color: var(--accent); }
.ms-ch { flex: none; font-family: var(--font-mono); font-size: 10.5px; color: var(--text-faint); }
.ms-picks { display: flex; flex-direction: column; gap: 6px; }
.ms-pk { display: flex; align-items: center; gap: 8px; }
.ms-pk-l { flex: none; width: 76px; font-size: 11.5px; color: var(--text-muted); }
.ms-pk select { flex: 1; min-width: 0; font: inherit; font-size: 11.5px; padding: 4px 6px; outline: none;
  color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.ms-mng { display: flex; justify-content: flex-end; margin-top: -2px; }
.ms-mng-t { font-size: 10.5px; color: var(--text-faint); cursor: pointer; }
.ms-mng-t:hover { color: var(--accent); }
.ms-empty { padding: 8px 9px; font-size: 11px; color: var(--text-faint); }
.ms-key { font-family: var(--font-mono); font-size: 30px; font-weight: 600; letter-spacing: 7px; text-align: center; padding: 14px 8px; cursor: pointer; user-select: all; color: var(--text); background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--r-box, 3px); }
.ms-acts { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.ms-note { font-size: 10.5px; color: var(--text-faint); }
.ms-btn { font: inherit; font-size: 11px; line-height: 1; padding: 5px 9px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.ms-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.ms-btn:disabled { opacity: .45; cursor: not-allowed; }
.ms-btn.primary { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.ms-btn.primary:hover:not(:disabled) { opacity: .88; }
.ms-warnbox { font-size: 11.5px; line-height: 1.6; color: var(--warn); background: color-mix(in srgb, var(--warn) 8%, var(--bg)); border: 1px solid color-mix(in srgb, var(--warn) 30%, var(--border)); border-radius: var(--r-ctl, 2px); padding: 6px 8px; }
</style>
