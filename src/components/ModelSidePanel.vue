<script setup>
// 「卫星模型」侧栏视图（活动栏 side='model'；设计契约 §6.3）。3D 页只负责 Teleport 挂载与喂数据。
//   ① 当前卫星：缩略图 + 模型名 + 来源 / 保真度（署名与许可放 title）+ 尺寸 / 质量读数 + 姿态律 / 挂点数（二期）；
//      模型下拉（自动 / 无 / 库中模型…）；
//      跟随 / 编辑…（编辑… = 模型工作台「卫星」页：这颗星的姿态律与挂点）
//   ② 显示：显示模型（拨杆，在节标题上；卫星与标记共用）、图标大小（所有卫星模型统一一个值，不逐颗设；标记挂的模型跟标记自己的图标大小，
//      在标记侧栏，模型与图标共用一个设置）、跟随时的 HUD 八项（常驻，跟随时生效）
//   图标大小一律是【默认视角下】的像素，球面上随缩放联动（拉近变大、拉远变小，与标记 / 地名同一把尺，见 viz/globe3d/zoomScale.js）
//   ③ 模型库：搜索 + 来源分段 + 缩略图网格（点卡片 = 绑定到当前卫星；右键：下载 / 移除缓存 / 在工作台中打开）
//   ④ 底部「模型工作台」
// 绑定写回由页面做（要与已有的挂点 / 姿态律合并，见 ConstellationMap3D 的 bindModel）；缩略图、下载、移除、开工作台直接走 IPC。
// ★ 所有 api 调用都 catch，并认 {locked:true}（未激活时 gate 通道回这个，界面静默）。
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import Icon from './Icon.vue'
import { isSecOpen, toggleSec } from '../stores/panelSections'
import { byLang } from '../shared/i18n/lang.js'
import { onLangChange } from '../shared/i18n/runtime.js'
// 缩略图逻辑抽到 modelThumbs.js（模块级单例：本侧栏、标记侧栏的「模型」小块、模型选择弹层共用一份缓存）
import { thumbs, requestThumb, forgetThumb, createThumbObserver } from './modelThumbs.js'

const props = defineProps({
  sat: { type: Object, default: null },          // { key, name } 主选星；null = 未选中
  model: { type: Object, default: null },        // 主选星的模型信息（页面 selModel）
  lib: { type: Array, default: () => [] },       // manifest 条目（含 local 状态）+ 参数化模板
  following: { type: Boolean, default: false },
  canFollow: { type: Boolean, default: true },
  st: { type: Object, required: true }           // focusStyle（modelOn / modelPx / hud*）
})
const emit = defineEmits(['toggle-follow', 'bind', 'set-style', 'reset-style', 'open-wb'])
const models = (typeof window !== 'undefined' && window.api && window.api.models) || null

// ---------------- 当前卫星 ----------------
const FID = {
  outreach: { icon: 'image', t: '科普美术模型' },
  parametric: { icon: 'box', t: '参数化生成' },
  cad: { icon: 'package', t: 'CAD 模型' },
  engineering: { icon: 'ruler', t: '工程模型' }
}
const fidOf = (f) => FID[f] || FID.outreach
// 二期新加的界面词（姿态律 / 挂点）按语言直接出字：词典（uiDict）不归本面板管，呈现层查不到就会在英文界面漏成中文。
// 读 langTick 建立依赖 —— 切语言时模板随之重渲染（byLang 本身读 localStorage，不是响应式）
const langTick = ref(0)
const offLang = onLangChange(() => { langTick.value++ })
onBeforeUnmount(() => offLang())
function zhEn(zh, en) { void langTick.value; return byLang(zh, en) }
// 姿态律名（绑定表 attitude.law；没绑定 = nadir）。口径写进 title
const LAW = {
  nadir: { t: ['对地定向', 'Nadir'], tt: ['+Z 指地心、+X 沿惯性速度', '+Z to Earth centre, +X along inertial velocity'] },
  yawSteer: { t: ['偏航导引', 'Yaw steering'], tt: ['对地定向基础上绕 +Z 偏航，太阳翼轴（本体 ±Y）始终垂直太阳', 'Nadir pointing with yaw about +Z so the array axis (body ±Y) stays perpendicular to the Sun'] },
  sun: { t: ['对日定向', 'Sun pointing'], tt: ['指定本体轴精确指太阳', 'The chosen body axis points exactly at the Sun'] },
  inertial: { t: ['惯性定向', 'Inertial'], tt: ['本体相对 TEME 惯性系固定', 'Body fixed relative to the TEME inertial frame'] },
  target: { t: ['对目标定向', 'Target pointing'], tt: ['指定本体轴精确指地球站或目标星', 'The chosen body axis points exactly at an earth station or target satellite'] }
}
const lawOf = (k) => LAW[k] || LAW.nadir
const lawName = (k) => zhEn(...lawOf(k).t)
const attTitle = computed(() => {
  const m = props.model
  if (!m) return ''
  const tt = zhEn(...lawOf(m.law).tt), n = m.mounts || 0, k = m.masks || 0
  return zhEn('姿态律：' + tt + '\n挂点 ' + n + ' 副，其中有遮挡掩模 ' + k + ' 副', 'Attitude law: ' + tt + '\n' + n + ' mounts, ' + k + ' with obscuration masks')
})
const nameOf = (m) => (m ? (byLang(m.titleZh || m.title || m.id, m.title || m.titleZh || m.id)) : '')
const srcTitle = (m) => {
  if (!m) return ''
  const s = m.source || {}
  return [s.credit, s.license].filter(Boolean).join(' · ') || m.id
}
const bindValue = computed(() => {
  const m = props.model
  if (!m) return 'auto'
  if (m.bound === null) return 'none'
  if (m.bound && m.bound !== 'auto') return m.bound
  return 'auto'
})
const autoLabel = computed(() => {
  const m = props.model
  return m && m.auto && m.id ? '自动（' + (m.name || m.id) + '）' : '自动'
})
function onBindSelect(e) {
  const v = e.target.value
  if (v === '__lib') {
    e.target.value = bindValue.value
    if (!isSecOpen('mdl-lib')) toggleSec('mdl-lib')
    nextTick(() => { const el = libEl.value; if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' }) })
    return
  }
  emit('bind', v === 'auto' ? 'auto' : (v === 'none' ? null : v))
}
// ---------------- 缩略图（按需、可见才取；远端的由主进程下到本机缓存；参数化 / 实体模板现场生成，见 modelThumbs.js） ----------------
const thumbCur = computed(() => (props.model && props.model.id ? thumbs.value.get(props.model.id) || '' : ''))
watch(() => props.model && props.model.id, (id) => { if (id) requestThumb(id) }, { immediate: true })
// ★ 在 setup 里就建：卡片的函数 ref 在首次渲染时（早于 onMounted）就会被调用
const thumbObs = createThumbObserver('120px')
const libEl = ref(null)
function observe(el) { thumbObs.observe(el) }

// ---------------- 下载进度 ----------------
const prog = ref(new Map())            // id → { phase, frac }
let offChanged = null
onMounted(() => {
  if (models && models.onChanged) {
    offChanged = models.onChanged((e) => {
      if (!e || e.type !== 'download' || !e.id) return
      const m = new Map(prog.value)
      if (e.phase === 'ready' || e.phase === 'canceled' || e.phase === 'error') m.delete(e.id)
      else m.set(e.id, { phase: e.phase, frac: e.total > 0 ? Math.min(1, e.received / e.total) : 0 })
      prog.value = m
      if (e.phase === 'ready' && e.lod === 'thumb') { forgetThumb(e.id); requestThumb(e.id) }
    })
  }
})
onBeforeUnmount(() => { if (offChanged) offChanged(); thumbObs.disconnect() })

// ---------------- 模型库 ----------------
const q = ref('')
const seg = ref('all')
const SEGS = [
  { k: 'all', t: '全部' }, { k: 'builtin', t: '内置' }, { k: 'local', t: '已下载' }, { k: 'cloud', t: '云端' }, { k: 'user', t: '本机' }
]
const ready = (m) => !!(m.local && (m.local.lod0 === 'ready' || m.local.lod1 === 'ready' || m.local.lod2 === 'ready'))
const isParam = (m) => String(m.id).startsWith('param:')
// 运行时生成、没有文件的条目（参数化模板 param: / 实体模板 ent:）：没有「下载」「移除缓存」可言
const isGen = (m) => /^(param|ent):/.test(String(m.id))
// 地面 / 空中 / 水面件的占位图标（缩略图出来之前）
const KIND_ICON = { ground: 'satellite-dish', aircraft: 'plane', ship: 'ship', vehicle: 'car' }
const phIcon = (m) => KIND_ICON[m.kind] || (isParam(m) ? 'box' : 'satellite')
function segOf(m) {
  if (isParam(m) && m.origin !== 'user') return 'builtin'
  if (m.origin === 'builtin') return 'builtin'
  if (m.origin === 'user' && !m.overridesId) return 'user'
  return ready(m) || (m.builtin && m.builtin.length) ? 'local' : 'cloud'
}
const norm = (s) => String(s || '').normalize('NFKC').toLowerCase()
// 排序：参数化模板（通信卫星平台，给星绑模型最常用）→ 航天器 → 空间站 / 载人 → 深空 → 部件 → 运载 → 地面设施 → 飞机 → 船 → 车；同类按名称
const KIND_RANK = { spacecraft: 1, station: 2, crewed: 3, deepspace: 4, component: 5, launcher: 6, ground: 7, aircraft: 8, ship: 9, vehicle: 10, other: 11 }
const rankOf = (m) => (isParam(m) ? 0 : (KIND_RANK[m.kind] || 11))
const sorted = computed(() => props.lib.slice().sort((a, b) => (rankOf(a) - rankOf(b)) || nameOf(a).localeCompare(nameOf(b), 'zh-Hans-CN')))
const shown = computed(() => {
  const k = norm(q.value).trim()
  return sorted.value.filter((m) => {
    if (seg.value !== 'all' && segOf(m) !== seg.value) return false
    if (!k) return true
    return norm(m.title).includes(k) || norm(m.titleZh).includes(k) || norm(m.id).includes(k) ||
      (Array.isArray(m.aliases) && m.aliases.some((a) => norm(a).includes(k))) || (Array.isArray(m.tags) && m.tags.some((a) => norm(a).includes(k)))
  })
})
// 点卡片 = 绑定到当前卫星；没有主选星时只在库里点亮（预览选中态，DESIGN §6.3），再点一次取消
const preview = ref('')
function pick(m) {
  if (props.sat) { preview.value = ''; emit('bind', m.id); return }
  preview.value = preview.value === m.id ? '' : m.id
}
watch(() => props.sat && props.sat.key, () => { preview.value = '' })
const cardOn = (m) => (props.sat ? !!(props.model && props.model.id === m.id) : preview.value === m.id)
function stateOf(m) {
  const p = prog.value.get(m.id)
  if (p) return { cls: 'dl', frac: p.frac, t: p.phase === 'queued' ? '排队中' : '下载中' }
  if (isGen(m)) return null
  if (ready(m)) return { cls: 'ok', t: '已缓存' }
  if (m.builtin && m.builtin.length) return { cls: 'ok', t: '随安装包' }
  return m.origin === 'remote' ? { cls: 'cloud', t: '云端' } : null
}

// 卡片右键菜单
const menu = ref(null)   // { x, y, m }
function openMenu(e, m) {
  const host = e.currentTarget.closest('.mdl-side')
  const r = host ? host.getBoundingClientRect() : { left: 0, top: 0 }
  menu.value = { x: e.clientX - r.left, y: e.clientY - r.top + (host ? host.scrollTop : 0), m }
}
function closeMenu() { menu.value = null }
async function doDownload(m) {
  closeMenu()
  if (!models || isGen(m)) return
  try { await models.ensure({ id: m.id, lod: 'lod0' }) } catch { /* 状态由下载事件回报 */ }
}
async function doRemove(m) {
  closeMenu()
  if (!models || !models.remove) return
  try { await models.remove(m.id) } catch { /* ignore */ }
}
function doOpen(m) { closeMenu(); emit('open-wb', { modelId: m.id }) }

// 卡片拖出（DESIGN3 E11）：拖到 3D 球 / 2D 平面图上的地球站、点标记、航迹载具头或卫星上松手 = 挂模型（接收在 3D 页 .stage-wrap）。
// 数据类型 application/x-satsim-model，值 {id, kind}（工作台库卡片下期照同一口径拖出）。
// 拖拽预览：缩略图就绪时现做一枚 64 px 的小卡（原图 384 px，直接交给 setDragImage 会按原尺寸画一大块）
const MDL_TYPE = 'application/x-satsim-model'
function onCardDrag(e, m) {
  const dt = e.dataTransfer
  if (!dt) return
  closeMenu()
  try { dt.setData(MDL_TYPE, JSON.stringify({ id: m.id, kind: m.kind || '' })) } catch { return }
  dt.effectAllowed = 'copy'
  const img = e.currentTarget && e.currentTarget.querySelector ? e.currentTarget.querySelector('.th img') : null
  if (!img || !(img.naturalWidth > 0) || typeof dt.setDragImage !== 'function') return
  try {
    // 画布是同步出内容的（新建 <img> 换 src 要异步解码，拍下来可能是空白）
    const S = 64, dpr = Math.min(3, window.devicePixelRatio || 1)
    const c = document.createElement('canvas')
    c.width = Math.round(S * dpr); c.height = Math.round(S * dpr)
    c.style.cssText = `position:fixed;left:-1000px;top:-1000px;width:${S}px;height:${S}px;pointer-events:none;`
    const x = c.getContext('2d')
    x.scale(dpr, dpr)
    const cs = getComputedStyle(document.documentElement)
    const bg = cs.getPropertyValue('--surface').trim() || '#1e1e1c', ln = cs.getPropertyValue('--accent-ui').trim() || '#6ba3d6'
    x.beginPath(); x.roundRect(1, 1, S - 2, S - 2, 6)
    x.globalAlpha = 0.92; x.fillStyle = bg; x.fill(); x.globalAlpha = 1
    x.lineWidth = 1.5; x.strokeStyle = ln; x.stroke()
    const k = Math.min((S - 8) / img.naturalWidth, (S - 8) / img.naturalHeight)
    const w = img.naturalWidth * k, h = img.naturalHeight * k
    x.drawImage(img, (S - w) / 2, (S - h) / 2, w, h)
    document.body.appendChild(c)
    dt.setDragImage(c, S / 2, S / 2)
    setTimeout(() => c.remove(), 0)   // 浏览器在 dragstart 返回时已把它拍成位图，节点当拍即可摘掉
  } catch { /* 拿不到预览就用浏览器缺省的半透明卡片 */ }
}
function onDocDown(e) { if (menu.value && !(e.target.closest && e.target.closest('.mdl-menu'))) closeMenu() }
onMounted(() => document.addEventListener('pointerdown', onDocDown, true))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocDown, true))

const HUD = [
  { k: 'hudAxes', t: '本体轴', tt: '+X 红 / +Y 绿 / +Z 蓝' }, { k: 'hudLvlh', t: 'LVLH', tt: '沿迹 / 径向 / 轨道法向（r × v）' }, { k: 'hudNadir', t: '天底' },
  { k: 'hudVel', t: '速度', tt: '惯性速度方向' }, { k: 'hudSun', t: '太阳' },
  { k: 'hudIsl', t: 'ISL', tt: '与 500 km 内邻星的通视连线（连线不低于 100 km 高度）' },
  { k: 'hudEs', t: '地球站', tt: '标记层地球站中仰角 ≥ 0° 的方向，近者优先 12 个' },
  { k: 'hudMounts', t: '挂点', tt: '绑定表里各挂点的视轴射线与视场锥（视场取挂点的 fovDeg；没写时按参数化天线的 −3 dB 波束宽）',
    en: 'Mounts', ttEn: 'Boresight ray and field-of-view cone of each bound mount (FOV = the mount\'s fovDeg; otherwise the −3 dB beamwidth of the parametric antenna)' }
]
</script>

<template>
  <div class="cov-side mdl-side docked">

    <div class="sec">
      <div class="sect acc" data-sec="mdl-cur" :class="{ open: isSecOpen('mdl-cur') }" @click="toggleSec('mdl-cur')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('mdl-cur') }" :size="12" /><span>当前卫星</span></div>
      <template v-if="isSecOpen('mdl-cur')">
        <div v-if="!sat" class="empty">未选中卫星。</div>
        <template v-else>
          <div class="cur">
            <div class="cthumb" :class="{ none: !thumbCur }">
              <img v-if="thumbCur" :src="thumbCur" crossorigin="anonymous" alt="" draggable="false" />
              <Icon v-else name="box" :size="30" :stroke-width="1.2" />
            </div>
            <div class="cinfo">
              <div class="csat" :title="sat.name" data-i18n-skip>{{ sat.name }}</div>
              <div class="cmod" :title="model && model.title ? model.title : ''" data-i18n-skip>{{ model && model.id ? model.name : '—' }}</div>
              <div v-if="model && model.id" class="cmeta">
                <span class="ic" :title="fidOf(model.fidelity).t + ' · ' + srcTitle(model.meta)"><Icon :name="fidOf(model.fidelity).icon" :size="12" /></span>
                <span class="ic" :class="{ ok: model.sizeVerified }" :title="model.sizeVerified ? '尺寸已核定（有出处）' : '尺寸未核定'"><Icon name="ruler" :size="12" /></span>
                <span class="ic" :class="{ ok: model.frameVerified }" :title="model.frameVerified ? '本体轴已核定' : '本体轴未核定'"><Icon name="axis-3d" :size="12" /></span>
              </div>
              <div v-if="model && model.dims" class="rd" title="包围盒（本体系 X × Y × Z）"><span class="n">{{ model.dims }}</span><i>m</i></div>
              <div v-if="model && model.mass" class="rd" title="整星质量"><span class="n">{{ model.mass }}</span><i>kg</i></div>
              <div v-if="model" class="rd att" :title="attTitle"><span class="lw">{{ lawName(model.law) }}</span><span class="n">{{ model.mounts || 0 }}</span><i>{{ zhEn('挂点', 'mounts') }}</i></div>
            </div>
          </div>
          <div class="srow"><label>模型</label>
            <select :value="bindValue" title="自动：按卫星名 / NORAD / 轨道类别匹配；无：只画点" @change="onBindSelect">
              <option value="auto">{{ autoLabel }}</option>
              <option value="none">无</option>
              <option v-if="bindValue !== 'auto' && bindValue !== 'none'" :value="bindValue" data-i18n-skip>{{ model && model.name ? model.name : bindValue }}</option>
              <option value="__lib">库中模型…</option>
            </select>
          </div>
          <div class="btns">
            <button type="button" class="btn" :class="{ on: following }" :disabled="!canFollow" :title="canFollow ? '' : '仅 3D 球体'" @click="emit('toggle-follow')"><Icon name="locate-fixed" :size="13" /><span>{{ following ? '退出跟随' : '跟随卫星' }}</span></button>
            <button type="button" class="btn" :disabled="!sat.key" :title="zhEn('模型工作台「卫星」页：姿态律、挂点、遮挡掩模', 'Model workbench, Satellite page: attitude law, mounts, obscuration masks')" @click="emit('open-wb', { tab: 'sat', satKey: sat.key, modelId: model && model.id })"><Icon name="pencil" :size="13" /><span>编辑…</span></button>
          </div>
        </template>
      </template>
    </div>

    <div class="sec" :class="{ hid: !st.modelOn }">
      <div class="sect acc" data-sec="mdl-disp" :class="{ open: isSecOpen('mdl-disp') }" @click="toggleSec('mdl-disp')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('mdl-disp') }" :size="12" /><span>显示</span><span class="lnk" title="本节恢复出厂设置" @click.stop="emit('reset-style')">默认</span><button type="button" class="layersw sect-layersw" :class="{ on: st.modelOn }" role="switch" :aria-checked="st.modelOn ? 'true' : 'false'" :title="st.modelOn ? '隐藏模型（卫星改回画点、标记改回图标）' : '显示模型'" @click.stop="emit('set-style', 'modelOn', !st.modelOn)"><i></i></button></div>
      <template v-if="isSecOpen('mdl-disp')">
        <div class="srow" :title="zhEn('卫星模型在默认视角下的包围半径屏幕像素 × 2，拉近变大、拉远变小；所有卫星统一。标记挂的模型跟标记自己的图标大小', 'Satellite model bounding diameter in pixels at the default view; grows when zooming in, shrinks when zooming out; applies to all satellites. Models on markers follow the marker icon size')"><label>图标大小</label><input class="rng" type="range" min="4" max="2048" step="4" :value="st.modelPx" @input="emit('set-style', 'modelPx', Number($event.target.value))" /><span class="u">{{ st.modelPx }}</span></div>
        <div class="hudt" title="跟随卫星时叠加的方向指示">HUD</div>
        <label v-for="h in HUD" :key="h.k" class="chk2" :title="h.en ? zhEn(h.tt, h.ttEn) : (h.tt || '')"><input type="checkbox" :checked="st[h.k]" @change="emit('set-style', h.k, $event.target.checked)" /><span>{{ h.en ? zhEn(h.t, h.en) : h.t }}</span></label>
      </template>
    </div>

    <div ref="libEl" class="sec lib">
      <div class="sect acc" data-sec="mdl-lib" :class="{ open: isSecOpen('mdl-lib') }" @click="toggleSec('mdl-lib')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('mdl-lib') }" :size="12" /><span>模型库</span><span class="cnt">{{ shown.length }}</span></div>
      <template v-if="isSecOpen('mdl-lib')">
        <div class="srch"><Icon name="search" :size="12" /><input v-model="q" type="text" placeholder="搜索" spellcheck="false" /><span v-if="q" class="clr" title="清除" @click="q = ''"><Icon name="x" :size="12" /></span></div>
        <div class="seg nseg" role="group" aria-label="来源">
          <span v-for="s in SEGS" :key="s.k" class="sg" :class="{ on: seg === s.k }" @click="seg = s.k">{{ s.t }}</span>
        </div>
        <div v-if="!lib.length" class="empty">还没有模型。</div>
        <div v-else-if="!shown.length" class="empty">无匹配模型。</div>
        <div v-else class="grid" @contextmenu.prevent>
          <div
            v-for="m in shown" :key="m.id" :ref="observe" class="card" :class="{ on: cardOn(m) }" :data-id="m.id" draggable="true"
            :title="nameOf(m) + '\n' + srcTitle(m)" @click="pick(m)" @dragstart="onCardDrag($event, m)" @contextmenu.prevent.stop="openMenu($event, m)"
          >
            <div class="th">
              <img v-if="thumbs.get(m.id)" :src="thumbs.get(m.id)" crossorigin="anonymous" alt="" draggable="false" loading="lazy" />
              <Icon v-else :name="phIcon(m)" :size="26" :stroke-width="1.2" />
              <span class="fid" :title="fidOf(m.fidelity).t"><Icon :name="fidOf(m.fidelity).icon" :size="11" /></span>
              <template v-if="stateOf(m)">
                <span v-if="stateOf(m).cls === 'dl'" class="bar" :title="stateOf(m).t"><i :style="{ width: Math.round(stateOf(m).frac * 100) + '%' }"></i></span>
                <span v-else class="stt" :class="stateOf(m).cls" :title="stateOf(m).t"><Icon :name="stateOf(m).cls === 'cloud' ? 'cloud-download' : 'check'" :size="10" /></span>
              </template>
            </div>
            <div class="nm" data-i18n-skip>{{ nameOf(m) }}</div>
          </div>
        </div>
      </template>
    </div>

    <div class="foot">
      <button type="button" class="btn wide" @click="emit('open-wb', { satKey: sat && sat.key, modelId: model && model.id })"><Icon name="box" :size="13" /><span>模型工作台</span></button>
    </div>

    <div v-if="menu" class="mdl-menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
      <div class="mi" :class="{ dis: isGen(menu.m) }" @click="!isGen(menu.m) && doDownload(menu.m)">下载</div>
      <div class="mi" :class="{ dis: isGen(menu.m) || !(ready(menu.m) || menu.m.origin === 'user') }" @click="!isGen(menu.m) && doRemove(menu.m)">移除缓存</div>
      <div class="mi" @click="doOpen(menu.m)">在工作台中打开</div>
    </div>
  </div>
</template>

<style scoped>
/* 侧栏视觉语言照抄 ConstellationMap3D / SatCovPanel 的 .cov-side 一套（那份是 scoped 的、进不到本组件），改动请对照 */
.cov-side { width: 286px; flex: none; background: var(--surface); overflow-y: auto; display: flex; flex-direction: column; font-size: var(--fs-3); }
.cov-side.docked { width: auto; border-left: 0; overflow: visible; }
.mdl-side { position: relative; }
.sec { padding: 12px 16px; border-bottom: 1px solid var(--border); }
.sec > * + * { margin-top: 8px; }
.sec > .sect + * { margin-top: 6px; }
.sec.hid > :not(.sect) { opacity: .5; }
.srow { --srow-lab: 70px; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.srow label { color: var(--text-muted); min-width: var(--srow-lab); max-width: 100%; flex: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.srow select { flex: 1; min-width: 116px; border: 1px solid var(--field-border); background-color: var(--field-bg); padding: 0 7px; font-size: var(--fs-3); outline: none; color: var(--text); }
.srow .u { flex: none; min-width: 34px; text-align: right; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.rng { flex: 1; min-width: 0; }
.sect { display: flex; align-items: center; color: var(--text); }
.sect.acc { cursor: pointer; user-select: none; gap: 5px; margin-inline: -6px; padding: 3px 6px; border-radius: var(--r-box); transition: background-color var(--dur-1) linear; }
.sect.acc .app-icon { flex: none; color: var(--text-faint); }
.sect.acc:hover { background: color-mix(in srgb, var(--text) 5%, transparent); }
.sect.acc:has(.lnk:hover, .layersw:hover) { background: transparent; }
.sec > .sect.acc:first-child { margin-top: -3px; }
.sec > .sect.acc:last-child { margin-bottom: -3px; }
.sect .lnk { margin-left: auto; color: var(--text-muted); cursor: pointer; font-size: var(--fs-3); transition: color var(--dur-1) linear; }
.sect .lnk:hover { color: var(--text); text-decoration: underline; text-underline-offset: 2px; }
.sect-layersw { margin-left: auto; }
.sect .lnk ~ .sect-layersw { margin-left: 12px; }
.sect .cnt { margin-left: auto; color: var(--text-faint); font-variant-numeric: tabular-nums; font-size: var(--fs-2); }
.chk2 { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.chk2 + .chk2 { margin-top: 5px; }
.empty { color: var(--text-faint); padding: 4px 0; }
.hudt { color: var(--text-muted); font-size: var(--fs-2); letter-spacing: var(--ls-caps); }

/* 当前卫星 */
.cur { display: flex; gap: 10px; align-items: flex-start; }
.cthumb { flex: none; width: 96px; height: 96px; border: 1px solid var(--border); border-radius: var(--r-box); background: radial-gradient(ellipse at 50% 38%, color-mix(in srgb, var(--text) 7%, var(--surface)) 0%, var(--surface) 75%); display: flex; align-items: center; justify-content: center; overflow: hidden; color: var(--text-faint); }
.cthumb img { width: 100%; height: 100%; object-fit: contain; }
.cinfo { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.csat { color: var(--text-muted); font-size: var(--fs-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cmod { color: var(--text); font-size: var(--fs-4); line-height: 1.3; overflow-wrap: anywhere; }
.cmeta { display: flex; gap: 6px; }
.cmeta .ic { display: inline-flex; color: var(--text-faint); }
.cmeta .ic.ok { color: var(--ok); }
.rd { font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--text); font-size: var(--fs-3); }
.rd i { font-style: normal; color: var(--text-faint); font-size: var(--fs-2); margin-left: 3px; }
.rd.att { display: flex; align-items: baseline; gap: 6px; }
.rd.att .lw { font-family: var(--font-ui); color: var(--text-muted); font-size: var(--fs-2); }
.rd.att .n + i { margin-left: 0; }
.btns { display: flex; gap: 8px; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: var(--h-ctl); padding: 0 12px; border: 1px solid var(--border-strong); border-radius: var(--r-ctl); background: var(--surface); color: var(--text); font-size: var(--fs-3); cursor: pointer; transition: background-color var(--dur-1) linear, border-color var(--dur-1) linear; }
.btn:hover:not(:disabled) { background: var(--wash-hover); }
.btn:disabled { color: var(--text-faint); cursor: default; }
.btn.on { border-color: var(--accent-ui); color: var(--accent-ui); }
.btns .btn { flex: 1 1 0; }
.btn.wide { width: 100%; }

/* 模型库 */
.srch { display: flex; align-items: center; gap: 6px; height: var(--h-ctl); padding: 0 8px; border: 1px solid var(--field-border); background: var(--field-bg); color: var(--text-faint); }
.srch input { flex: 1; min-width: 0; border: 0; background: transparent; outline: none; color: var(--text); font-size: var(--fs-3); padding: 0; height: 100%; }
.srch .clr { display: inline-flex; cursor: pointer; }
.srch .clr:hover { color: var(--text); }
/* 分段控件：与 3D 页 .seg 同一口径（那份是 scoped 的、进不到本组件，逐字照抄；改动请两边一起改） */
.seg { display: flex; box-sizing: border-box; min-height: var(--h-ctl); border: 1px solid var(--border-strong); border-radius: var(--r-ctl); overflow: hidden; }
.seg .sg { flex: 1 1 auto; text-align: center; padding: 2px 4px; line-height: 16px; cursor: pointer; color: var(--text-muted); user-select: none; white-space: nowrap; transition: var(--t-state); }
.seg .sg + .sg { border-left: 1px solid var(--border); }
.seg .sg:hover:not(.on) { background: var(--surface-2); color: var(--text); }
.seg .sg:active:not(.on) { box-shadow: var(--press); transition-duration: 0s; }
.seg .sg.on { background: var(--sel-fill); color: var(--sel-on); transition-duration: 0s; }
.seg .sg.on, .seg .sg.on + .sg { border-left-color: transparent; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.card { border: 1px solid var(--border); border-radius: var(--r-box); background: var(--surface); cursor: pointer; overflow: hidden; transition: border-color var(--dur-1) linear, background-color var(--dur-1) linear; }
.card:hover { border-color: var(--border-strong); background: color-mix(in srgb, var(--text) 4%, var(--surface)); }
.card.on { border-color: var(--accent-ui); box-shadow: inset 0 0 0 1px var(--accent-ui); }
.th { position: relative; aspect-ratio: 1 / 1; display: flex; align-items: center; justify-content: center; color: var(--text-faint);
  background: radial-gradient(ellipse at 50% 38%, color-mix(in srgb, var(--text) 7%, var(--surface)) 0%, var(--surface) 78%); }
.th img { width: 100%; height: 100%; object-fit: contain; }
.th .fid { position: absolute; left: 4px; top: 4px; display: inline-flex; color: var(--text-faint); }
.th .stt { position: absolute; right: 4px; top: 4px; display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px; border-radius: 50%; background: var(--surface); border: 1px solid var(--border); color: var(--text-faint); }
.th .stt.ok { color: var(--ok); }
.th .stt.cloud { color: var(--text-muted); }
.th .bar { position: absolute; left: 6px; right: 6px; bottom: 5px; height: 3px; border-radius: 2px; background: color-mix(in srgb, var(--text) 14%, transparent); overflow: hidden; }
.th .bar > i { display: block; height: 100%; background: var(--accent-ui); transition: width .2s linear; }
/* 两行截断：留白放在 margin 上 —— 放 padding 里的话第三行会从下内边距里露出半截（overflow 按内边距盒裁） */
.nm { margin: 4px 6px 5px; font-size: var(--fs-2); line-height: 1.3; color: var(--text); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: calc(2 * 1.3em); max-height: calc(2 * 1.3em); }
.foot { padding: 12px 16px; }
.mdl-menu { position: absolute; z-index: 30; min-width: 132px; padding: 4px; background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-box); box-shadow: var(--shadow-2, 0 6px 20px rgba(0,0,0,.25)); font-size: var(--fs-3); }
.mdl-menu .mi { padding: 5px 10px; border-radius: var(--r-box); cursor: pointer; white-space: nowrap; }
.mdl-menu .mi:hover { background: var(--accent-ui); color: var(--bg); }
.mdl-menu .mi.dis, .mdl-menu .mi.dis:hover { color: var(--text-faint); background: none; cursor: default; }
</style>
