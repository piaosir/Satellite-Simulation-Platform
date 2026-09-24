<script setup>
// 「发送到小程序」弹窗（链路预算三窗的分享弹窗与文件区的频率计划页共用）。
//
// 两条去向并存，也可同时用：
//   · 接收方（已绑定账号）—— 免密钥直投。给常用的人（自己的手机、同事），一次绑定长期有效，
//                            且小程序端会自动同步（改一次内容，手机上那一份跟着变）。
//   · 一次性密钥          —— 8 位密钥，【不指定接收方】、就地产出，谁拿到谁能导入。给客户 /
//                            临时协作 / 没绑定过的人。
//
// ★ 密钥不是一个「接收方」，故不与绑定账号同列勾选 —— 它是本次操作的产出物，摆在收件人清单
//   之外单独一行。只勾密钥时这一趟没有「发给谁」这回事，按钮的动词也跟着换（actLabel）。
//
// 本组件只管：出内容清单 → 投递 → 把结果摆出来。造包是调用方的事（items 由 lbMiniExport /
// fpMiniExport 备好），本组件不认识任何一种载荷。
//
// 密钥 8 位、字母表 31 个字符（A-Z2-9，去掉易混的 I L O 0 1，见 electron/services/share.js）。
// 对象匿名公读、不可列举 —— 密钥即凭证。链路配置里含站址与工程参数，知晓即可。
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import MiniBindingsPanel from './MiniBindingsPanel.vue'
import { makePack, sendPack, sendUnitsToBoxes, unitsOfPack, unitOfRaw, estimateBytes, fmtBytes, SIZE_WARN, TTL_DAYS } from '../shared/miniPack.js'
import { loadBindings, markSent } from '../shared/miniBindings.js'
import { byLang } from '../shared/i18n/lang.js'   // 空名占位是界面语汇，却画在打了 skip 的名字位上（呈现层翻不到），故在这里按语言出字

const props = defineProps({
  open: { type: Boolean, default: false },
  // 打开时现算（勾选可能刚变过）。两种返回形态：
  //   { name, items }            标准包 —— 链路配置 / 频率计划，逐件拆开投
  //   { name, raw, sync, label } 整块载荷 —— 覆盖快照（没有 items[]），一件就是一条消息
  // 都为空即禁用发送。调用形如 build(picked, { name })：
  //   picked —— picks 的选值 { <key>: <value> }（文本 / 数值框给的是原文字符串，由调用方解析）
  //   name   —— renamable 时用户在清单里改过的名称；'' = 没改过，由调用方自动命名
  build: { type: Function, required: true },
  // 发送前要先定的选项（覆盖快照用它定「这份数据挂在小程序哪颗星下」）：
  // [{ key, label, title?, type?: 'select' | 'text' | 'number', default?,
  //    options?: [{ value, label, group?, vals? }],   select：相邻且 group 相同的项归进同一个 <optgroup>；
  //                                                   vals＝选中该项时顺带写进其他键的值（见 withVals）
  //    when?: { <key>: <value> },                     其他键取这些值时才出现；隐藏的不参与校验
  //    required?, min?, max?, unit?, placeholder? }]  文本 / 数值框
  picks: { type: Array, default: () => [] },
  // 整块载荷的名称可改（覆盖快照：手机上就是那个波束的名字）。清单那一行换成输入框。
  renamable: { type: Boolean, default: false },
  deviceId: { type: String, default: '' },
  configured: { type: Boolean, default: false },
  // 密钥模式下提示去小程序哪里输（覆盖快照落在「卫星覆盖」，配置落在「我的配置」）
  keyHint: { type: String, default: '小程序「我的配置 → 导入 → 平台密钥」输入' }
})
// sent：至少一路（绑定直投 / 密钥）成功后发出，载荷 { picked, name } —— 调用方据此记住用过的选项
const emit = defineEmits(['update:open', 'toast', 'sent'])
const close = () => emit('update:open', false)
const api = typeof window !== 'undefined' ? window.api : null

// 内容清单是【逐件可选】的：一份链路配置常有十几条链路，而发给对方的往往只是其中一两条。
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

// 发送前要先定的选项（覆盖快照用它定目标卫星）。
// 改一项就重攒包 —— 选值要进载荷，不重攒发出去的还是旧的那份。
const pickVals = ref({})
// 整块载荷的名称：null = 跟随调用方的自动名（随目标星走），字符串 = 用户改过、就此钉住。
// 清空后离开输入框 = 交还自动命名 —— 判在 change 上而不在 input 上：边打字边判，
// 删到空的那一瞬自动名就被塞回框里（与资源库自动命名同一口径）。
const nameEdit = ref(null)
function rebuild() {
  try {
    const b = props.build({ ...pickVals.value }, { name: nameEdit.value == null ? '' : nameEdit.value.trim() }) || {}
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
    // 默认全选：多数情况就是整份发过去。件数没变就保住勾选 —— 改目标星 / 改名都会重攒，
    // 别把刚取消的勾又打回来（reset 先把 on 清空，打开时照样全选）
    if (on.value.length !== allUnits.value.length) on.value = allUnits.value.map(() => true)
    err.value = ''
  } catch (e) {
    src.value = null; allUnits.value = []; on.value = []
    err.value = '内容准备失败：' + ((e && e.message) || e)
  }
}

const isSel = (p) => !p.type || p.type === 'select'
const pickOn = (p) => !p.when || Object.keys(p.when).every((k) => pickVals.value[k] === p.when[k])
const visPicks = computed(() => (props.picks || []).filter(pickOn))
// select 的选项分段：相邻且 group 相同的归一段，有 group 的段包成 <optgroup>
function optSegs(p) {
  const segs = []
  for (const o of p.options || []) {
    const g = o.group || ''
    const last = segs[segs.length - 1]
    if (last && last.group === g) last.options.push(o)
    else segs.push({ group: g, options: [o] })
  }
  return segs
}
// 选中带 vals 的项时把它携带的值一并写进别的键：选中某颗星，「卫星名称 / 轨道位置」两格就跟着它走，
// 切到「手动指定」时两格里是刚才那颗星的名称与轨位，改一两处即可，不必从空白开始
function withVals(vals, p, v) {
  const o = (p.options || []).find((x) => x.value === v)
  return o && o.vals ? { ...vals, ...o.vals } : vals
}
function onPick(p, e) { pickVals.value = withVals({ ...pickVals.value, [p.key]: e.target.value }, p, e.target.value); rebuild() }
// 文本 / 数值框存原文、不转数字：半截输入（「-」「12.」）转了数就会在重渲染时被改写，西经会打成东经
function onPickText(p, e) { pickVals.value = { ...pickVals.value, [p.key]: e.target.value }; rebuild() }
// 数值框四态：'' 空 / 'part' 打到一半（「-」「.」「-.」，合法数的前缀）/ 'bad' 非法或越界 / 'ok'。
// 只有 bad 描红；空与打到一半只让「发送」置灰 —— 输西经先打的那个「-」不该闪一下红框
const pickText = (p) => String(pickVals.value[p.key] ?? '').trim()
function numState(p) {
  const s = pickText(p)
  if (!s) return ''
  if (/^[+-]?\.?$/.test(s)) return 'part'
  const v = Number(s)
  return !Number.isFinite(v) || (p.min != null && v < p.min) || (p.max != null && v > p.max) ? 'bad' : 'ok'
}
const pickBad = (p) => p.type === 'number' && numState(p) === 'bad'
function pickOk(p) {
  if (isSel(p)) return true
  if (p.type === 'number') { const st = numState(p); return st === 'ok' || (st === '' && !p.required) }
  return !p.required || !!pickText(p)
}
const picksOk = computed(() => visPicks.value.every(pickOk))

function onNameInput(e) { nameEdit.value = e.target.value; rebuild() }
function onNameDone() { if (nameEdit.value != null && !nameEdit.value.trim()) { nameEdit.value = null; rebuild() } }
const canRename = computed(() => props.renamable && !!(src.value && src.value.raw))

function reset() {
  key.value = ''; err.value = ''; warn.value = ''; busy.value = false; sentTo.value = []
  nameEdit.value = null; on.value = []
  const init = {}
  for (const p of props.picks || []) {
    init[p.key] = p.default != null && p.default !== '' ? p.default
      : (isSel(p) ? ((p.options && p.options[0] && p.options[0].value) || '') : '')
  }
  // select 的初值也带上它的 vals（初选的那颗星 → 名称 / 轨位两格跟着它）
  let vals = init
  for (const p of props.picks || []) if (isSel(p)) vals = withVals(vals, p, init[p.key])
  pickVals.value = vals
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

// 捕获阶段收 Esc（与 LbReportDialog 同一套）：这一层在最上面，Esc 就该是它的，不漏给下面的分享窗 / 文件管理。
// 组字中的 Esc 是取消组字；投递中不关（结果还没回来，关了就看不到密钥 / 失败原因）
function onKey(e) {
  if (e.key !== 'Escape' || e.isComposing) return
  if (busy.value) return
  e.stopPropagation()
  close()
}
watch(() => props.open, (v) => (v ? window.addEventListener('keydown', onKey, true) : window.removeEventListener('keydown', onKey, true)), { immediate: true })
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))

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
const canSend = computed(() => nSel.value > 0 && props.configured && picksOk.value && (nPicked.value > 0 || wantKey.value))
// 只出密钥的那一趟没有收件人，动词就不该是「发送」——投给账号才叫发送，产出凭证叫生成。
const actLabel = computed(() => (busy.value
  ? (nPicked.value ? '发送中…' : '生成中…')
  : (nPicked.value ? '发送' : '生成密钥')))

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
    emit('sent', { picked: { ...pickVals.value }, name: src.value ? src.value.name : '' })
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
        <Icon name="external-link" :size="12" />
        <span class="ms-hd-t">发送到小程序</span>
        <span class="ms-sp"></span>
        <span v-if="deviceId" class="ms-id">本机标识：<b>{{ deviceId }}</b></span>
      </div>

      <div class="ms-bd">
        <template v-if="!doneAny">
          <template v-if="picks.length">
            <div class="ms-sec">发送选项</div>
            <div class="ms-picks">
              <label v-for="p in visPicks" :key="p.key" class="ms-pk" :title="p.title || null">
                <span class="ms-pk-l">{{ p.label }}</span>
                <span class="ms-pk-c">
                  <select v-if="isSel(p)" :value="pickVals[p.key]" @change="onPick(p, $event)">
                    <template v-for="(sg, si) in optSegs(p)" :key="si">
                      <optgroup v-if="sg.group" :label="sg.group">
                        <option v-for="o in sg.options" :key="o.value" :value="o.value">{{ o.label }}</option>
                      </optgroup>
                      <template v-else>
                        <option v-for="o in sg.options" :key="o.value" :value="o.value">{{ o.label }}</option>
                      </template>
                    </template>
                  </select>
                  <template v-else>
                    <input type="text" class="ms-pk-i" :class="{ num: p.type === 'number', bad: pickBad(p) }"
                      :inputmode="p.type === 'number' ? 'decimal' : null" :value="pickVals[p.key]"
                      :placeholder="p.placeholder || null" spellcheck="false" @input="onPickText(p, $event)" />
                    <span v-if="p.unit" class="ms-pk-u">{{ p.unit }}</span>
                  </template>
                </span>
              </label>
            </div>
          </template>

          <div class="ms-sec">
            内容清单<span class="ms-src">{{ info.text }}</span>
            <span class="ms-sp"></span>
            <span v-if="rows.length > 1" class="ms-lnk" @click="selectAllUnits(true)">全选</span>
            <span v-if="rows.length > 1" class="ms-lnk" @click="selectAllUnits(false)">清空</span>
          </div>
          <div class="ms-list">
            <label v-for="(u, i) in rows" :key="i" class="ms-row ms-pick" :class="{ off: !on[i] }">
              <input type="checkbox" :checked="on[i]" @change="toggleUnit(i)" />
              <span class="ms-k">{{ u.label }}</span>
              <!-- 名字是数据（自动名也是调用方按语言现拼的），整格 skip：占位符同样不让呈现层去翻 -->
              <input v-if="canRename" type="text" class="ms-nmi" :value="nameEdit != null ? nameEdit : u.name" :placeholder="u.name"
                spellcheck="false" data-i18n-skip @input="onNameInput" @change="onNameDone" />
              <span v-else class="ms-nm" :title="u.name" data-i18n-skip>{{ u.name }}</span>
              <span v-if="u.tag" class="ms-tag">{{ u.tag }}</span>
            </label>
            <div v-if="!rows.length" class="ms-empty">没有可发送的内容。</div>
          </div>

          <div class="ms-sec">接收账号</div>
          <div class="ms-list">
            <label v-for="b in bindings" :key="b.ch" class="ms-row ms-pick">
              <input type="checkbox" :checked="picked.has(b.ch)" @change="toggle(b.ch)" />
              <span class="ms-nm" :title="b.ch" data-i18n-skip>{{ b.name || byLang('未命名账号', 'Unnamed account') }}</span>
              <span class="ms-ch">{{ b.ch.match(/.{1,4}/g).join('-') }}</span>
            </label>
            <div v-if="!bindings.length" class="ms-empty">尚无已绑定的小程序账号。</div>
          </div>
          <div class="ms-mng">
            <span class="ms-mng-t" @click="mngOpen = !mngOpen">{{ mngOpen ? '收起' : '绑定管理…' }}</span>
          </div>
          <MiniBindingsPanel v-if="mngOpen" compact :list="bindings" @change="onBindingsChange" @toast="(m) => emit('toast', m)" />

          <label class="ms-opt" title="不指定接收账号，生成 8 位一次性密钥；持有密钥即可在小程序中导入本次内容">
            <input v-model="wantKey" type="checkbox" />
            <span>{{ nPicked ? '同时生成一次性密钥' : '生成一次性密钥' }}</span>
          </label>

          <div v-if="tooBig && wantKey" class="ms-warnbox">
            内容 {{ fmtBytes(info.bytes) }}，接近密钥模式 1 MB 上限。
          </div>
          <div v-if="err" class="ms-warnbox">{{ err }}</div>
          <div v-if="!configured" class="ms-warnbox">「发送到小程序」尚未配置。</div>
          <div class="ms-acts">
            <button class="ms-btn primary" :disabled="busy || !canSend" @click="doSend">{{ actLabel }}</button>
            <span v-if="nPicked" class="ms-note">{{ nSel }} 项内容将投递至 {{ nPicked }} 个账号</span>
          </div>
        </template>

        <template v-else>
          <template v-if="sentTo.length">
            <div class="ms-sec">已投递</div>
            <div class="ms-list">
              <div v-for="b in sentTo" :key="b.ch" class="ms-row">
                <span class="ms-nm" data-i18n-skip>{{ b.name || byLang('未命名账号', 'Unnamed account') }}</span>
                <span class="ms-ch">{{ b.ch.match(/.{1,4}/g).join('-') }}</span>
              </div>
            </div>
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
/* 遮罩瞬时出现（全软件一档 --scrim）；框体 160ms 升入，出场瞬时 */
.ms-mask { position: fixed; inset: 0; z-index: 320; display: flex; align-items: center; justify-content: center; background: var(--scrim); }
.ms-dlg { width: 460px; max-width: 92vw; max-height: 84vh; display: flex; flex-direction: column; background: var(--bg); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--r-card, 4px); box-shadow: var(--shadow-3); overflow: hidden;
  animation: ui-dlg-in var(--dur-3) var(--ease-out); }
.ms-hd { display: flex; align-items: center; gap: 7px; padding: 10px 12px; background: var(--surface-2); border-bottom: 1px solid var(--border); }
.ms-hd-t { font-size: var(--fs-2); font-weight: 600; letter-spacing: var(--ls-label); text-transform: uppercase; color: var(--text-muted); }
.ms-sp { flex: 1; }
.ms-id { font-size: var(--fs-2); color: var(--text-muted); }
.ms-id b { font-family: var(--font-code); color: var(--text); }
.ms-bd { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 7px; overflow-y: auto; }
.ms-ft { display: flex; justify-content: flex-end; padding: 8px 12px; border-top: 1px solid var(--border); background: var(--surface); }
.ms-sec { display: flex; align-items: baseline; gap: 8px; font-size: var(--fs-2); font-weight: 600; color: var(--text-muted); letter-spacing: var(--ls-tight); }
.ms-src { font-weight: 400; font-size: var(--fs-2); color: var(--text-faint); }
.ms-list { max-height: 220px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--r-box, 3px); background: var(--bg); }
.ms-row { display: flex; align-items: center; gap: 7px; padding: 4px 8px; font-size: var(--fs-3); border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent); }
.ms-row:last-child { border-bottom: 0; }
/* 类型名列：中文恒 ≤4 字，定 56px 对齐；英文名更长时按内容撑开，不压到后面的名称框上 */
.ms-k { flex: none; min-width: 56px; white-space: nowrap; color: var(--text-faint); }
.ms-nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 清单行内的名称框：密排档高度，行不因它变高；可选中文字（外层 .ms-pick 关了 user-select） */
.ms-nmi { flex: 1; min-width: 0; height: var(--h-ctl-sm); font: inherit; font-size: var(--fs-3); padding: 0 5px; outline: none; cursor: text; user-select: text;
  color: var(--text); background-color: var(--field-bg); border: 1px solid var(--field-border); border-radius: var(--r-ctl, 2px); }
.ms-tag { flex: none; font-family: var(--font-mono); font-size: var(--fs-1); line-height: 15px; padding: 0 5px; color: var(--text-faint); border: 1px solid var(--border-strong); border-radius: var(--r-ctl); }
.ms-pick { cursor: pointer; user-select: none; }
.ms-pick:hover { background: var(--surface-2); }
.ms-pick input[type="checkbox"] { flex: none; margin: 0; cursor: pointer; }
/* 未勾选的行压暗但仍可读：清单是「这份配置里有哪些链路」的全貌，不是只列要发的那几条 */
.ms-pick.off .ms-k, .ms-pick.off .ms-nm, .ms-pick.off .ms-nmi, .ms-pick.off .ms-tag { opacity: .42; }
.ms-lnk { font-weight: 400; font-size: var(--fs-2); color: var(--text-faint); cursor: pointer; }
.ms-lnk:hover { color: var(--accent); }
.ms-ch { flex: none; font-family: var(--font-mono); font-size: var(--fs-2); color: var(--text-faint); }
/* 选项区两列栅格：标签列取最宽的那个（英文「Orbital Position」比中文长一倍，定宽会压字），
   至少 76px 与改版前的中文版式一致；每行的 <label> 用 display: contents 把标签与控件交给栅格 */
.ms-picks { display: grid; grid-template-columns: max-content minmax(0, 1fr); align-items: center; column-gap: 8px; row-gap: 6px; }
.ms-pk { display: contents; }
.ms-pk-l { min-width: 76px; font-size: var(--fs-3); color: var(--text-muted); white-space: nowrap; }
.ms-pk-c { display: flex; align-items: center; gap: 6px; min-width: 0; }
.ms-pk select, .ms-pk-i { flex: 1; min-width: 0; font: inherit; font-size: var(--fs-3); padding: 0 6px; outline: none;
  color: var(--text); background-color: var(--field-bg); border: 1px solid var(--field-border); border-radius: var(--r-ctl, 2px); }
.ms-pk-i.num { flex: none; width: 96px; text-align: right; font-variant-numeric: tabular-nums; }
.ms-pk-i.bad { border-color: var(--danger); }
.ms-pk-u { flex: none; font-size: var(--fs-3); color: var(--text-muted); }
.ms-opt { display: flex; align-items: center; gap: 7px; font-size: var(--fs-3); cursor: pointer; user-select: none; }
.ms-opt input { flex: none; margin: 0; cursor: pointer; }
.ms-mng { display: flex; justify-content: flex-end; margin-top: -2px; }
.ms-mng-t { font-size: var(--fs-2); color: var(--text-faint); cursor: pointer; }
.ms-mng-t:hover { color: var(--accent); }
.ms-empty { padding: 8px 9px; font-size: var(--fs-2); color: var(--text-faint); }
.ms-key { font-family: var(--font-code); font-size: 30px; font-weight: 600; letter-spacing: 7px; text-align: center; padding: 14px 8px; cursor: pointer; user-select: all; color: var(--text); background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--r-box, 3px); }
.ms-acts { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.ms-note { font-size: var(--fs-2); color: var(--text-faint); }
/* 定高 --h-ctl（原靠内距撑出 23px）；主钮机位色，悬停压深一档、字色显式 --bg（通用悬停会把字染成 --text） */
.ms-btn { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: var(--h-ctl); font: inherit; font-size: var(--fs-2); line-height: 1; padding: 0 9px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.ms-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.ms-btn:disabled { opacity: .45; cursor: not-allowed; }
.ms-btn.primary { background: var(--accent-ui); color: var(--bg); border-color: var(--accent-ui); }
.ms-btn.primary:hover:not(:disabled) { opacity: 1; color: var(--bg); background: var(--accent-ui-hover); border-color: var(--accent-ui-hover); }
.ms-warnbox { font-size: var(--fs-3); line-height: 1.6; color: var(--warn); background: color-mix(in srgb, var(--warn) 8%, var(--bg)); border: 1px solid color-mix(in srgb, var(--warn) 30%, var(--border)); border-radius: var(--r-ctl, 2px); padding: 6px 8px; }
</style>
