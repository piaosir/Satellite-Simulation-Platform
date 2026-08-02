<script setup>
// 频率分配表：这份计划里每一条转发器上摆了哪些载波，逐条写清【起—中—止】与两条带宽。
//
// 体例照运营内部的「转发器装载表 / 载波分配清单」（Intelsat 式）——★ 这一版从「一张长表」改成
// 【逐转发器的编排面板】：整页是一列收起的转发器行，点开哪一条，就在原地摊开那一条的频带条
// （可拖、可拉、可拖出新载波）与它的载波明细。分配表要回答的是「这段频谱分给了谁」，而工作
// 现场一次只编排一条转发器 —— 二十几条并排铺开，每条都只剩一行高，反而哪条都编排不了。
//
// ★★ 这一页只写【下行】。转发器上的载波管理（常规转发器与 DTP 载荷都一样）现场只认下行频率：
//   频谱仪摆在接收站那一侧，卖出去的也是下行那一段。故这里没有上行/下行开关，组头、频带条、
//   起止三列写的都是下行。—— 但【存的】仍是上行中心频率：载波的身份是它从地面打在哪一个频点上，
//   下行随所属转发器的 LO 走（改一次 LO，整条转发器连同其载波在下行域一起平移，这正是物理事实）。
//   两域之间只差该转发器的 Δ（= f上 − f下，见 freqPlanCapacity 的 xlateMHz），换算在录入/落值
//   两处各一次。没有下行频率的转发器（未挂 LO 又没显式填）这一页排不了 —— 组头照出，条与格留空。
//
// 频带条的口径：
//   · 视域 = 转发器频带 ∪ 所有载波块，两端各留一点 —— 越界的载波必须看得见，不能画到条外面去；
//   · ★ 不做钳制：载波可以压在保护带里、可以越出频带边沿、可以互相重叠。保护带留多少是工程
//     口径（现场把它分出去是常事），故保护带只进【吸附】【自动排布】与条上的斜纹留白，不当栏杆
//     用；越界与重叠照旧由核算给出条目，但那是提示，不是拦阻。
//   · 载波块按【所属波束】着色。归属不是一页的显示模式，而是这条转发器自己的事实（见 rowBeam）：
//       频带被切开的（图上左右分色）—— 按频率认领，载波落在哪一段就是哪个波束，条顶上逐段一道
//         色带把切点画出来（见 segsOf），载波色与它上方那一段同色；
//       同频叠放的（图上上下分色）—— 频率上分不出谁是谁，是【二选一】：在组头上点色片指定这条
//         转发器的载波默认归谁（存 carrierBeamId，留空 = 第一个）。条顶那道色带照画，但叠着的
//         几个各错开一层（见 segsOf）—— 这一段上有哪几个波束是事实，只画最后一个等于把它藏了；
//       逐条载波仍可在明细表「波束」列里另行钉死，钉死压过上面两条。
//     占段本身在右栏设置里改（那一栏在这一页可拖宽、可收起）。
//
// 核算口径一个字没动，仍是两条并列的约束（见 freqPlanCapacity 文件头）：
//   带宽占用 Σ occBwMHz 与功率占用 Σ pwrBwMHz，两条都与转发器带宽同量纲、可直接相比。
// 只出数值与色标，不出「达标/受限」这类文字判定（平台既定口径）。
//
// 单位：内部一律 MHz（同模型），屏上一律走工具栏那一个刻度 —— 这一页的每个带宽/频率读数与录入格
// 都经 uFrom/uTo，故切到 kHz 时转发器表与这里写的是同一个数（见 freqPlanModel 的「显示单位」段）。
import { computed, ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { buildAllocation, autoPlace, newCarrier, setCarrierEdge } from '../shared/freqPlanCapacity.js'
import { resolveAll, upFromDn, cleanFreq, POLS, POL_LABEL } from '../shared/freqPlanModel.js'
import { num as parseNum } from '../shared/num.js'   // 全角容错：中文输入法下的全角数字也能落值
import { useFreqUnit } from './fpUnit.js'
import Icon from '../components/Icon.vue'

const props = defineProps({
  plan: { type: Object, required: true },
  carriers: { type: Array, required: true },
  unit: { type: String, default: 'MHz' },
  selectedId: { type: String, default: '' }
})
const emit = defineEmits(['update:carriers', 'select-channel', 'flash', 'set-channel-beam'])

// fu = 只读读数（小数位随刻度：kHz 取整、GHz 五位），故切到 GHz 时 36 MHz 写成 0.036 而不是被 2 位抹成 0.04
const { U, numF: fu, dispF, toM, dval, dput, ddone } = useFreqUnit(() => props.unit)
const guardMHz = ref(0)
const gv = () => Number(guardMHz.value) || 0

// 着色只有开与关 —— 一条载波归哪个波束不是这一页的显示模式，是转发器自己的事实（见 rowBeam）
const colorOn = ref(true)
const res = computed(() => buildAllocation(props.plan, props.carriers, {
  guardMHz: gv(), unit: props.unit, side: 'dn'
}))
const S = computed(() => res.value.summary)

// 「转发器」那一列的下拉：按 id 选，不按编号选 —— 编号可以重（两条 C1 是常事），
// 重号的在标签上补一个下行中心频率把它们分开
const tpList = computed(() => {
  const rs = resolveAll(props.plan).filter((r) => r.kind === 'transponder')
  const dup = new Map()
  for (const r of rs) dup.set(String(r.no || ''), (dup.get(String(r.no || '')) || 0) + 1)
  return rs.map((r) => ({
    id: r.id,
    no: r.no || '',
    label: (r.no || '—') + (dup.get(String(r.no || '')) > 1 && r.dn?.fc != null ? ` · ↓${fu(r.dn.fc)}` : '')
  }))
})

// 未归属转发器的载波并成一条「伪转发器」跟在表末：它没有频带（画不出频带条），其余一切
// 与正经转发器同构，故明细表只写一遍。藏起来只会让人以为它们没录进去。
const groups = computed(() => {
  const gs = res.value.groups.slice()
  const u = res.value.unassigned
  if (u.length) {
    gs.push({
      channelId: '__none__', orphan: true, no: '', f1: null, f2: null, bwMHz: null,
      pol: '', beam: '', beams: [], segs: [], splitSegs: [], pickBeamId: '', xlateMHz: null,
      rows: u, issues: [], count: u.length,
      occSum: u.reduce((s, r) => s + (r.occ || 0), 0),
      pwrSum: u.reduce((s, r) => s + (r.pwr || 0), 0),
      rateSum: u.reduce((s, r) => s + (Number(r.c.infoRateKbps) || 0), 0),
      bwUtil: null, pwrUtil: null, freeMHz: null
    })
  }
  return gs
})

const pct =(v) => (Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '—')
// fx 只剩不随刻度走的量（Mbps、bps/Hz）；带宽与频率一律走 fu
const fx = (v, d = 2) => (Number.isFinite(v) ? (Math.round(v * 10 ** d) / 10 ** d).toString() : '—')
// 占用率色标：> 1 是超，0.9~1 是临界。只上色，不写字。
const utilCls = (v) => (!Number.isFinite(v) ? '' : v > 1.0001 ? 'over' : v > 0.9 ? 'near' : '')

// ---- 下行域 ↔ 存储域（上行）----
// 屏上写的、拖出来的、手敲进去的都是【下行】那一个数；落值前加回该转发器的 Δ 存成上行。
// Δ 缺（未挂 LO 又没显式填下行）→ 这一组无从换算，格子只读、条画不出来。
const dxOf = (g) => (g && Number.isFinite(g.xlateMHz) ? g.xlateMHz : null)
const canEdit = (g) => dxOf(g) != null
const noDxTitle = (g) => (canEdit(g) ? '' : '该转发器上下行没有配成对（缺一侧频率、且未挂 LO）—— 载波频率无从换算')
const toStore = (g, w) => (w == null ? null : upFromDn(w, dxOf(g)))

// ---- 展开哪一条 ----
// 一次只摊开一条（手风琴）。与图上/转发器表的选中互通：图上点一块，这里就摊开那一条。
const openId = ref('')
const isOpen = (g) => g.orphan || g.channelId === openId.value
watch(() => props.selectedId, (v) => { if (v) openId.value = v }, { immediate: true })
// 换计划时给一个落点：优先已选中的，其次第一条装了载波的 —— 满页收起的行，点开才看得见东西
watch(() => props.plan, () => {
  if (props.selectedId) { openId.value = props.selectedId; return }
  const gs = res.value.groups
  openId.value = ((gs.find((g) => g.count > 0) || gs[0]) || {}).channelId || ''
}, { immediate: true })
watch(openId, (id) => {
  if (!id) return
  nextTick(() => { bodyEl.value?.querySelector(`[data-g="${id}"]`)?.scrollIntoView({ block: 'nearest' }) })
})
function pick(g) {
  if (g.orphan) return
  openId.value = openId.value === g.channelId ? '' : g.channelId
  if (openId.value) emit('select-channel', g.channelId)
}

// ---- 选中 ----
// 多选：Ctrl 点加减、Shift 点在组内取区间。复制/剪切/删除都作用在这一份选集上。
const sel = ref([])
const isSel = (id) => sel.value.includes(id)
const selectOne = (id) => { sel.value = id ? [id] : [] }
function onPickCarrier(g, id, e) {
  const tag = e?.target?.tagName
  // 点在格子里 = 要改那一格：选中照做，但焦点不能抢走（抢了就打不出字）
  const inField = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'OPTION'
  if (!inField) focusPanel(g)
  if (e && e.shiftKey && sel.value.length) {
    const ids = g.rows.map((r) => r.c.id)
    const a = ids.findIndex((x) => sel.value.includes(x))
    const b = ids.indexOf(id)
    if (a >= 0 && b >= 0) { sel.value = ids.slice(Math.min(a, b), Math.max(a, b) + 1); return }
  }
  if (e && (e.ctrlKey || e.metaKey)) { sel.value = isSel(id) ? sel.value.filter((x) => x !== id) : [...sel.value, id]; return }
  selectOne(id)
}
// 键盘要落在这一页上才生效（免得在左栏点着计划树也能按 Delete 删载波）
function focusPanel(g) {
  nextTick(() => {
    const p = bodyEl.value?.querySelector(`[data-g="${g.channelId}"] .panel`)
    if (p && !p.contains(document.activeElement)) (p.querySelector('.stripwrap') || p).focus?.({ preventScroll: true })
  })
}

// ---- 载波增删改 ----
// 载波数组是 emit 出去的不可变值：一律整份换新，不原地改（原地改会绕开 update:carriers 这一个收口）
function patch(id, obj) {
  emit('update:carriers', props.carriers.map((c) => (c.id === id ? { ...c, ...obj } : c)))
}
// 组内不重名：删过中间几条之后再加，序号会撞上留着的那一条
function nextName(g) {
  const used = new Set((g.rows || []).map((r) => r.c.name))
  const base = g.no || '载波'
  for (let i = (g.rows || []).length + 1; ; i++) {
    const n = `${base}-${i}`
    if (!used.has(n)) return n
  }
}
function addCarrier(g) {
  const c = newCarrier({ name: nextName(g), channelId: g.channelId, channelNo: g.no || '' })
  emit('update:carriers', [...props.carriers, c])
  selectOne(c.id)
  openId.value = g.channelId       // 收起的那一条上加了一条，不摊开等于没加
}
function removeIds(ids) {
  const s = new Set(ids)
  if (!s.size) return
  emit('update:carriers', props.carriers.filter((c) => !s.has(c.id)))
  sel.value = sel.value.filter((x) => !s.has(x))
}
// 速率不随刻度走（kbps 是它自己的单位），故不经 dput，只做全角容错
const setRate = (id, v) => patch(id, { infoRateKbps: parseNum(v) })
// 改归属：id 是主键，编号一并跟上（编号只当读数与老计划的兼容口）
function setTp(id, tpId) {
  const t = tpList.value.find((x) => x.id === tpId)
  patch(id, { channelId: t ? t.id : '', channelNo: t ? t.no : '' })
}

// 中心频率：即时落值（同转发器表那一格）
function setFc(g, r, mhz) {
  if (!canEdit(g)) return                      // 无 Δ：这一格是禁用的，走到这里只可能是粘贴，宁可不落值
  patch(r.c.id, { fcMHz: mhz == null ? null : toStore(g, mhz) })
}

// 起止两格：不即时落值（同转发器检查器那两格）。起与止相互约束，敲到一半的前缀在等式里同样成立——
// 把 12290 改成 12350 的中途会经过 123，即时落值先把带宽算成荒唐数，下一次按键又正好落在
// 「越过另一端」那条分支上，这条载波就被中间值定死。故走草稿 ref，回车 / 离焦才提交。
const edraft = ref({ k: '', v: '' })
const eKey = (id, which) => `${id}.${which}`
function eVal(r, which) {
  if (edraft.value.k === eKey(r.c.id, which)) return edraft.value.v
  const x = r.f[which]
  return x == null ? '' : dispF(x)             // 带宽或中心未定 → 两端无从谈起，空着
}
const eInput = (id, which, v) => { edraft.value = { k: eKey(id, which), v } }
function commitEdge(g, r, which, v) {
  const x = toM(v)
  edraft.value = { k: '', v: '' }              // 清草稿 = 回到由中心/带宽算出的读数（没落值的输入也就被弹回）
  if (x == null) return
  const up = toStore(g, x)
  if (up == null) return
  const nx = setCarrierEdge(r.c, which, up)
  if (!nx) return
  patch(r.c.id, { fcMHz: nx.fcMHz, occBwMHz: nx.occBwMHz })
  // 「越过另一端」那一下的结果与「另一端钉住」不同，不说人会以为自己填错了
  if (nx.mode === 'shift') emit('flash', `${which === 'f1' ? '起始越过终止' : '终止越过起始'} —— 已按「带宽不变、整条载波平移」处理`)
}
function edgeTitle(which) {
  const self = which === 'f1' ? '起始' : '终止'
  const oth = which === 'f1' ? '终止' : '起始'
  return `载波频带${which === 'f1' ? '下' : '上'}边沿。改这里${oth}钉住，中心与占用带宽一并重算`
    + `（中心 =（起 + 止）/ 2 · 占用带宽 = 止 − 起）；${self}越过${oth}时改按「带宽不变、整条载波平移」处理。回车或离焦落值。`
}

function doAutoPlace() {
  emit('update:carriers', autoPlace(props.plan, props.carriers, { guardMHz: gv(), side: 'dn' }))
}
// 功带平衡：把功率带宽按占用带宽对齐（一键把「等占用」的假设铺上去，之后逐条改）
function balanceAll() {
  emit('update:carriers', props.carriers.map((c) => ({ ...c, pwrBwMHz: Number.isFinite(c.occBwMHz) ? c.occBwMHz : c.pwrBwMHz })))
}

// ---- 复制 / 剪切 / 粘贴 ----
// 剪贴板是这一页自己的（不走系统剪贴板：载波是一组结构化字段，序列化成文本再解回来只会丢东西）。
// 存的是「相对源转发器频带下边沿的中心偏移」而不是绝对频率：把一条转发器排好的一整套载波复制到
// 另一条上（HTS 逐波束同一套布局）时，落到目标频带里的相对位置才是要保的那个量。
const clip = ref([])
function copySel(cut = false) {
  const items = []
  for (const g of groups.value) {
    for (const r of g.rows) {
      if (!isSel(r.c.id)) continue
      items.push({
        c: JSON.parse(JSON.stringify(r.c)),
        off: (r.f.fc != null && Number.isFinite(g.f1)) ? cleanFreq(r.f.fc - g.f1) : null,
        srcId: g.channelId
      })
    }
  }
  if (!items.length) return
  clip.value = items
  if (cut) removeIds(items.map((i) => i.c.id))
  emit('flash', `${cut ? '已剪切' : '已复制'} ${items.length} 条载波`)
}
function pasteInto(gid) {
  const g = groups.value.find((x) => x.channelId === gid)
  if (!g || g.orphan || !clip.value.length) return
  const used = new Set((g.rows || []).map((r) => r.c.name))
  const add = []
  for (const it of clip.value) {
    let name = it.c.name || '载波'
    if (used.has(name)) {
      const base = name
      for (let i = 1; used.has(name); i++) name = i === 1 ? `${base} 副本` : `${base} 副本${i}`
    }
    used.add(name)
    // 贴回同一条转发器 = 「再来一条」：往后挪一个自己的宽度 + 保护带，免得整条压在原件上看不出来
    const shift = it.srcId === g.channelId ? (Number(it.c.occBwMHz) || 0) + gv() : 0
    const w = (it.off != null && Number.isFinite(g.f1)) ? cleanFreq(g.f1 + it.off + shift) : null
    add.push(newCarrier({
      ...it.c, id: '', name, channelId: g.channelId, channelNo: g.no || '',
      beamId: g.beams?.some((b) => b.id === it.c.beamId) ? it.c.beamId : '',
      fcMHz: toStore(g, w)
    }))
  }
  emit('update:carriers', [...props.carriers, ...add])
  sel.value = add.map((c) => c.id)
  openId.value = g.channelId
  emit('flash', `已粘贴 ${add.length} 条载波`)
}

// ---- 右键菜单 ----
const menu = ref(null)
function openMenu(e, g, id) {
  if (g.orphan && !id) return
  if (id && !isSel(id)) selectOne(id)
  const bn = ((groups.value.find((x) => x.channelId === g.channelId) || {}).beams || []).length
  menu.value = {
    x: Math.min(e.clientX, (window.innerWidth || 1200) - 150),
    // 菜单高度随波束条数长（一个波束一行 + 「自动」一行），不算进去的话挂在屏底的那几条会被切掉
    y: Math.min(e.clientY, (window.innerHeight || 800) - 140 - (bn > 1 ? (bn + 1) * 22 + 8 : 0)),
    gid: g.channelId, orphan: !!g.orphan
  }
}
const closeMenu = () => { menu.value = null }
// 右键菜单里的波束：★ 二选一藏在明细表最右边那一列里不好找 —— 现场是在条上摆载波，
// 手边就是右键。只在挂了两个以上波束的转发器上出（一个波束的没什么可选）
const menuBeams = computed(() => {
  const g = groups.value.find((x) => x.channelId === menu.value?.gid)
  return g && !g.orphan && (g.beams || []).length > 1 ? g.beams : []
})
function runMenu(act, arg) {
  const gid = menu.value?.gid
  closeMenu()
  if (act === 'copy') copySel(false)
  else if (act === 'cut') copySel(true)
  else if (act === 'paste') pasteInto(gid)
  else if (act === 'del') removeIds(sel.value)
  else if (act === 'beam') setBeamSel(arg)
}

// ---- 键盘 ----
// 只在这一页拿到焦点时生效；焦点在输入框里时一概让开（那里的 Ctrl+C 是复制文字）
function onKey(e) {
  const t = e.target
  const tag = t && t.tagName
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || t?.isContentEditable) return
  const mod = e.ctrlKey || e.metaKey
  const k = (e.key || '').toLowerCase()
  if (mod && k === 'c') { copySel(false); e.preventDefault(); return }
  if (mod && k === 'x') { copySel(true); e.preventDefault(); return }
  if (mod && k === 'v') { pasteInto(openId.value); e.preventDefault(); return }
  if (mod && k === 'a') {
    const g = groups.value.find((x) => x.channelId === openId.value)
    if (g) { sel.value = g.rows.map((r) => r.c.id); e.preventDefault() }
    return
  }
  if (k === 'delete' || k === 'backspace') { if (sel.value.length) { removeIds(sel.value); e.preventDefault() } }
}

// ── 频带条几何 ─────────────────────────────────────────────────────────────
// 载波块：定频的按自己的【起~止】落位，未定频的顺次铺在频带起点之后（斜纹区分，拖一下即落定）。
function barsOf(g) {
  const out = []
  let cursor = Number.isFinite(g.f1) ? g.f1 : null
  for (const r of g.rows) {
    if (r.occ == null) continue                // 没有占用带宽 —— 一条载波连宽度都没有，画不成块
    if (r.placed) out.push({ r, a: r.f.f1, b: r.f.f2, placed: true })
    else if (cursor != null) { out.push({ r, a: cursor, b: cursor + r.occ, placed: false }); cursor += r.occ }
  }
  return out
}
// 波束占段：这一条转发器的频带在几个波束之间怎么分 —— 画成条顶上的一道色带。
//   频带被切开的（一段一个波束）：逐段一道。载波按频率认领时认的就是这几段，切在哪里必须
//     看得见，否则一条载波为什么是这个色只能靠猜；
//   ★ 同频叠放的（几个波束占同一段频率，常规多波束转发器 / 频率复用的常态）：不能一条压一条
//     画 —— 后画的把先画的整条盖掉，屏上只剩最后那一个波束，读起来像「这段只归它」，而实情是
//     这一段两个波束都在。改成各错开一层（分层判据与图上那套同源，见 freqPlanRender 的
//     layoutStripes），叠着的几个都看得见。
//   一个波束铺满整条频带的不画：组头那排色点已经写着它是谁，条上再铺一道满宽的色带没有信息。
// ★ 认领用的是 splitSegs（互不重叠，见 beamSplitSegs），画出来的是这里 —— 两者不是一回事：
//   叠着的段画得出来（看得见谁在这一段上），却认不出载波归谁（那要在组头上二选一）。
function segsOf(g) {
  if (!colorOn.value) return []
  const band = Number.isFinite(g.f1) && Number.isFinite(g.f2) && g.f2 > g.f1
  // 整段落在频带外的不出片：钳完本就是零宽，却照样占掉一层，把真正在里面的那几片压薄
  // （校验的 segOut 会把它指出来，条上不必再画一条零宽的缝）
  const list = (g.segs || []).filter((s) => s?.beam && Number.isFinite(s.f1) && Number.isFinite(s.f2)
    && s.f2 > s.f1 && (!band || (s.f1 < g.f2 - 1e-6 && s.f2 > g.f1 + 1e-6)))
  if (!list.length || (list.length === 1 && list[0].full)) return []
  const lanes = []
  const laneOf = (a, b) => {
    // 挨着不算叠着：频分排布的相邻两段共一条边，那是同一层里的两段
    for (let k = 0; k < lanes.length; k++) {
      if (lanes[k].every((p) => a >= p[1] - 1e-6 || b <= p[0] + 1e-6)) { lanes[k].push([a, b]); return k }
    }
    lanes.push([[a, b]])
    return lanes.length - 1
  }
  const out = list.map((s) => ({ beam: s.beam, f1: s.f1, f2: s.f2, lane: laneOf(s.f1, s.f2) }))
  const n = Math.max(1, lanes.length)
  const h = (n > 1 ? 6 : 5) / n      // 载波块起于 top:7px，故色带一共只有这 5~6px 可用
  return out.map((s) => ({ ...s, top: s.lane * h, h }))
}
// 拖动期间把视域钉住：视域本由「频带 ∪ 载波」算出，不钉住的话拖着拖着轴自己也在动，手感像橡皮筋
const domFreeze = ref(null)
function stripOf(g) {
  if (!Number.isFinite(g.f1) || !Number.isFinite(g.f2) || !(g.f2 > g.f1)) return null
  const bars = barsOf(g)
  let a = g.f1, b = g.f2
  for (const bb of bars) { if (bb.a < a) a = bb.a; if (bb.b > b) b = bb.b }
  const fz = domFreeze.value
  const pad = (b - a) * 0.05 || 1
  const d0 = fz && fz.id === g.channelId ? fz.d0 : a - pad
  const d1 = fz && fz.id === g.channelId ? fz.d1 : b + pad
  const span = d1 - d0
  const pc = (m) => ((m - d0) / span) * 100
  const wpc = (w) => (w / span) * 100
  // 保护带：每个载波两侧各留一段斜纹 —— 这个数只进吸附与自动排布，画出来才知道它管着什么
  const gd = gv()
  const guards = gd > 0 ? bars.flatMap((bb) => [{ a: bb.a - gd, b: bb.a }, { a: bb.b, b: bb.b + gd }]) : []
  return {
    d0, d1, span, pc, wpc, bars, guards, segs: segsOf(g),
    band: { left: pc(g.f1), width: wpc(g.f2 - g.f1) },
    // 块宽换成像素，只为判断「这一块写不写得下标注」（stripW 是量出来的整条宽度）
    px: (w) => (w / span) * stripW.value
  }
}
// 收起行里那条缩略占用条：只在频带内看位置，越界的裁掉（那一行本就只给一眼的量）
function miniOf(g) {
  if (!Number.isFinite(g.f1) || !(g.f2 > g.f1)) return null
  const bw = g.f2 - g.f1
  return {
    segs: barsOf(g).map((bb) => ({
      r: bb.r, placed: bb.placed, a: bb.a, b: bb.b,
      left: ((bb.a - g.f1) / bw) * 100, width: ((bb.b - bb.a) / bw) * 100
    })),
    pwr: Math.min(100, (g.pwrSum / bw) * 100)
  }
}
const barTitle = (b) => `${b.r.c.name} · ${fu(b.r.occ)} ${U.value}`
  + (b.placed ? ` @ ${fu(b.r.f.fc)} ${U.value}` : '（未定频）')
  + (b.r.beam ? ` · ${b.r.beam.name}` : '')

// ── 颜色 ────────────────────────────────────────────────────────────────────
// 载波块的底色跟着波束走。白字压不住浅色（黄、浅青），故按亮度翻墨色 —— 两套阴影一并翻，
// 深底用黑影、浅底用白影，压在色片上的字才始终读得出来。
const BLUE = '#5B8FD4'
const colorOf = (r) => (colorOn.value && r?.beam?.color ? r.beam.color : BLUE)
// ── 二选一 ──────────────────────────────────────────────────────────────────
// 几个波束同频叠放在一条转发器上（各占整条频带，图上上下分色）时，载波在频率上分不出归谁 ——
// 只能指定。指定的是【整条转发器的默认】，存在转发器身上（carrierBeamId），逐条载波仍可在明细表
// 里另行钉死。频带被切开的那种（图上左右分色）不出这个选择：那里由频率说了算，再让人选一次
// 只会与占段打架 —— 要改归属就去改占段。
const stacked = (g) => !g.orphan && (g.beams || []).length > 1 && !(g.splitSegs || []).length
const pickBeam = (g, id) => emit('set-channel-beam', { channelId: g.channelId, beamId: id })
// 这一格是「钉死的」还是「自动认到的」，口径写在 title 上（界面不写解释文字）
const beamCellTitle = (g, r) => (!g.beams || !g.beams.length ? '这条转发器没有挂波束'
  : r.beamPinned ? `钉死在「${r.beam.name}」。选「自动」交回自动认领`
    : `自动认到「${r.beam?.name || '—'}」（${(g.splitSegs || []).length ? '按频率落在哪一段' : '整条转发器指定的那个'}）。选一个即钉死`)
// 选中的那几条一起改波束（右键菜单那一路）。'' = 交回自动
function setBeamSel(beamId) {
  const s = new Set(sel.value)
  if (!s.size) return
  emit('update:carriers', props.carriers.map((c) => (s.has(c.id) ? { ...c, beamId } : c)))
}
function lum(hex) {
  const h = String(hex || '').replace('#', '')
  if (h.length !== 6) return 0
  const ch = (i) => parseInt(h.slice(i, i + 2), 16) / 255
  const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(ch(0)) + 0.7152 * lin(ch(2)) + 0.0722 * lin(ch(4))
}
const inkOf = (hex) => (lum(hex) > 0.42 ? '#17181a' : '#fff')

// ★ 横跨两个波束的载波按切点分色 —— 切点从它身上穿过时，只涂一个色等于把它整条判给了其中
//   一个，而它实际上确实一半打在这个波束、一半打在那个波束（现场多半是要挪频，但表得先照实画）。
//   压不着任何占段的那几截退回本行认领到的那个色，故不跨段的块与从前逐像素相同。
// ★★ 只吃 splitSegs（两两不重叠，见 beamSplitSegs）—— 同频叠放的那种进来会排出「回头」的
//   渐变停靠点，浏览器把它钳回前一个色，整条载波就涂成头一个波束的色（它明明归后一个）。
//   同频叠放本就没有切点可画，那种块该是一整个实色（归谁在组头上二选一）。
function paintOf(g, a, b) {
  const segs = colorOn.value ? g.splitSegs || [] : []
  const w = b - a
  if (!(w > 0) || segs.length < 2) return null
  const parts = []
  for (const s of segs) {
    const x1 = Math.max(a, s.f1), x2 = Math.min(b, s.f2)
    if (x2 - x1 > w * 1e-6) parts.push({ c: s.beam.color, a: (x1 - a) / w, b: (x2 - a) / w })
  }
  return parts.length > 1 ? parts.sort((x, y) => x.a - y.a) : null
}
// 硬停靠的渐变 = 一条色带。用背景图而不是几个子块：子块会跟着块里的名字/带宽两行一起排版
function gradOf(parts, base) {
  const st = []
  let cur = 0
  for (const p of parts) {
    if (p.a > cur) st.push(`${base} ${cur * 100}%`, `${base} ${p.a * 100}%`)
    st.push(`${p.c} ${p.a * 100}%`, `${p.c} ${p.b * 100}%`)
    cur = p.b
  }
  if (cur < 1) st.push(`${base} ${cur * 100}%`, `${base} 100%`)
  return `linear-gradient(to right, ${st.join(',')})`
}
// 未定频的块不分色：它还没落到频率轴上，且那种块的斜纹本身就占着 background-image
function blkStyle(g, bar) {
  const c = colorOf(bar.r)
  const parts = bar.placed ? paintOf(g, bar.a, bar.b) : null
  const dark = inkOf(c) === '#fff'
  return {
    backgroundColor: c,
    ...(parts ? { backgroundImage: gradOf(parts, c) } : {}),
    '--ink': dark ? '#fff' : '#17181a',
    '--shd': dark ? 'rgba(0,0,0,.4)' : 'rgba(255,255,255,.55)'
  }
}
// 缩略条与明细表那个色点走同一套分色（三处对不上就更难认）
function paintStyle(g, r, a, b) {
  const c = colorOf(r)
  const parts = a != null && b != null ? paintOf(g, a, b) : null
  return parts ? { backgroundColor: c, backgroundImage: gradOf(parts, c) } : { backgroundColor: c }
}

// 几何一次算完存进 Map，模板里按 id 取 —— 模板里直接调 stripOf() 的话，一次渲染要为同一条
// 转发器重算十几遍（每个块、每条标注各一次），拖动时每帧都来一轮。
const strips = computed(() => {
  const m = new Map()
  for (const g of groups.value) if (isOpen(g)) { const s = stripOf(g); if (s) m.set(g.channelId, s) }
  return m
})
const minis = computed(() => {
  const m = new Map()
  for (const g of groups.value) if (!isOpen(g) && g.count) { const s = miniOf(g); if (s) m.set(g.channelId, s) }
  return m
})
// 条上出问题的载波（越界 / 重叠 / 保护带不足）：核算已按 carrierId 标好，这里只取来上色
const bads = computed(() => {
  const m = new Map()
  for (const g of groups.value) {
    const s = new Set()
    for (const is of g.issues || []) if (is.carrierId) s.add(is.carrierId)
    m.set(g.channelId, s)
  }
  return m
})
const st = (g) => strips.value.get(g.channelId) || null
const isBad = (g, id) => !!bads.value.get(g.channelId)?.has(id)

// ── 拖拽：平移 / 拉伸 / 拖出新载波 ─────────────────────────────────────────
// ★ 不钳制。压进保护带、越出频带边沿、与邻条重叠都照做 —— 核算会把它标出来，但不拦着。
//   唯一的下限是「别拖成零宽」（2px 对应的那点频率），否则块就消失在条上了。
const drag = ref(null)
const stripW = ref(900)
const bodyEl = ref(null)
let ro = null
onMounted(() => {
  if (!bodyEl.value || typeof ResizeObserver === 'undefined') return
  ro = new ResizeObserver(() => { stripW.value = Math.max(200, (bodyEl.value?.clientWidth || 900) - 96) })
  ro.observe(bodyEl.value)
})
onBeforeUnmount(() => { ro?.disconnect(); ro = null })

const q = (v) => cleanFreq(Math.round(v * 1000) / 1000)        // 落到 kHz，顺手掸掉浮点尘
function niceStep(x) {
  if (!(x > 0)) return 0.001
  const e = 10 ** Math.floor(Math.log10(x))
  const f = x / e
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e
}
const mPerPx = (d) => (d.rw > 0 ? (d.d1 - d.d0) / d.rw : 1)
const mAtX = (clientX, d) => d.d0 + ((clientX - d.rx) / (d.rw || 1)) * (d.d1 - d.d0)
// 吸附靶：频带两端与中点、其余载波的两端、以及它们外扩一个保护带的位置。
// 保护带只到这里为止 —— 吸得住，但吸不住也放得下（现场把保护带分出去是常事）。
function snapCands(d) {
  // ★ 按 id 现取那一组，不用拖动开始时存的那份：拖动期间每动一下都整份换新载波数组，
  //   存下来的 d.g 立刻成了旧快照，靶子会停在载波原来的位置上。
  const g = groups.value.find((x) => x.channelId === d.gid) || d.g
  const out = []
  if (Number.isFinite(g.f1)) out.push(g.f1, g.f2, (g.f1 + g.f2) / 2)
  const gd = gv()
  for (const bb of barsOf(g)) {
    if (bb.r.c.id === d.id) continue
    out.push(bb.a, bb.b)
    if (gd > 0) out.push(bb.a - gd, bb.b + gd)
  }
  return out
}
// 单点吸附（拉伸用）：吸不着就落到一个干净的刻度上，免得拖出 12303.4172 这种数
function snapOne(m, d) {
  if (d.alt) return q(m)
  const tol = mPerPx(d) * 6
  let best = null, bd = tol
  for (const c of snapCands(d)) { const dd = Math.abs(c - m); if (dd <= bd) { bd = dd; best = c } }
  if (best != null) return q(best)
  const s = niceStep(mPerPx(d) * 2)
  return q(Math.round(m / s) * s)
}
// 整条平移：起 / 中 / 止三点各试一次，取修正量最小的那一次 —— 只吸一端的话，
// 把一条载波推到邻条右边时会一直吸着自己的左沿，右沿永远差着一点点。
function snapShift(a, b, d) {
  if (d.alt) return 0
  const tol = mPerPx(d) * 6
  let best = null, bd = tol
  for (const p of [a, b, (a + b) / 2]) {
    for (const c of snapCands(d)) {
      const dd = c - p
      if (Math.abs(dd) <= bd) { bd = Math.abs(dd); best = dd }
    }
  }
  if (best != null) return best
  const s = niceStep(mPerPx(d) * 2)
  return Math.round(a / s) * s - a
}

function beginDrag(e, g, mode, bar, which) {
  // ★ 非左键不捕获：右键捕获遇上 preventDefault 的 contextmenu 会丢 pointerup，
  //   捕获卡死后截走后续所有点击（见 input-focus-intermittent 那条）。
  if (e.button !== 0) return
  const sp = st(g)
  const el = e.currentTarget?.closest?.('.strip')
  if (!sp || !el || !canEdit(g)) return
  const rect = el.getBoundingClientRect()
  if (!(rect.width > 0)) return
  e.preventDefault()
  // preventDefault 把「按下即聚焦」一并挡掉了，方向键微调就再也拿不到焦点 —— 显式补一次
  el.closest('.stripwrap')?.focus?.({ preventScroll: true })
  try { el.setPointerCapture(e.pointerId) } catch { /* 捕获失败就当普通事件走，不影响落值 */ }
  domFreeze.value = { id: g.channelId, d0: sp.d0, d1: sp.d1 }
  const d = {
    el, pid: e.pointerId, mode, g, gid: g.channelId, which, alt: e.altKey, moved: false,
    rx: rect.left, rw: rect.width, d0: sp.d0, d1: sp.d1,
    x0: e.clientX, id: bar ? bar.r.c.id : '',
    a0: bar ? bar.a : null, b0: bar ? bar.b : null
  }
  d.m0 = mAtX(e.clientX, d)
  d.na = d.m0; d.nb = d.m0
  drag.value = d
  if (bar) onPickCarrier(g, bar.r.c.id, e)
}
const startNew = (e, g) => { if (!g.orphan) beginDrag(e, g, 'new', null, '') }

function onDrag(e) {
  const d = drag.value
  if (!d) return
  d.alt = e.altKey
  if (!d.moved) {
    if (Math.abs(e.clientX - d.x0) < 3) return   // 3px 之内还算「点一下」，不动它
    d.moved = true
  }
  const m = mAtX(e.clientX, d)
  const minW = mPerPx(d) * 2
  if (d.mode === 'new') {
    const a = snapOne(Math.min(d.m0, m), d), b = snapOne(Math.max(d.m0, m), d)
    d.na = Math.min(a, b); d.nb = Math.max(a, b)
    return
  }
  if (d.mode === 'move') {
    const dm = m - d.m0
    const k = snapShift(d.a0 + dm, d.b0 + dm, d)
    const a = d.a0 + dm + k, b = d.b0 + dm + k
    patch(d.id, { fcMHz: toStore(d.g, q((a + b) / 2)) })
    return
  }
  // 拉伸：拖过头就与另一端对调（拖动里「越过另一端」的自然解释是翻转，不是整条平移——
  // 键盘录入那两格仍走 setCarrierEdge 的平移口径，两处各按各的手感）
  const fixed = d.which === 'f1' ? d.b0 : d.a0
  const x = snapOne(d.which === 'f1' ? d.a0 + (m - d.m0) : d.b0 + (m - d.m0), d)
  let a = Math.min(x, fixed), b = Math.max(x, fixed)
  if (b - a < minW) { if (x <= fixed) a = b - minW; else b = a + minW }
  patch(d.id, { fcMHz: toStore(d.g, q((a + b) / 2)), occBwMHz: q(b - a) })
}

function endDrag() {
  const d = drag.value
  if (!d) return
  drag.value = null
  domFreeze.value = null
  try { d.el.releasePointerCapture(d.pid) } catch { /* 已经释放过就算了 */ }
  if (d.mode === 'new') {
    if (!d.moved || !(d.nb - d.na > mPerPx(d) * 3)) { sel.value = []; return }
    const c = newCarrier({
      name: nextName(d.g), channelId: d.g.channelId, channelNo: d.g.no,
      fcMHz: toStore(d.g, q((d.na + d.nb) / 2)), occBwMHz: q(d.nb - d.na)
    })
    emit('update:carriers', [...props.carriers, c])
    selectOne(c.id)
  }
  // 选中在 beginDrag 里就落好了（含 Ctrl / Shift 多选），这里不再动它 —— 再 selectOne 一次
  // 会把刚加进来的那几条又踢出去
}
// 选中的载波用方向键微调（一格 = 条上 2px 那点频率，按住 Shift 走十倍）。
// 只在条本身拿到焦点时生效，故与下面明细表里的输入框不打架。
function nudge(g, sign, big) {
  const sp = st(g)
  if (!sp || !canEdit(g)) return
  const rows = (g.rows || []).filter((x) => isSel(x.c.id) && Number.isFinite(x.c.fcMHz))
  if (!rows.length) return
  const s = niceStep((sp.span / Math.max(200, stripW.value)) * 2) * (big ? 10 : 1)
  const move = new Map(rows.map((r) => [r.c.id, q(r.c.fcMHz + sign * s)]))
  emit('update:carriers', props.carriers.map((c) => (move.has(c.id) ? { ...c, fcMHz: move.get(c.id) } : c)))
}
</script>

<template>
  <div class="fpal">
    <div class="cbar">
      <button class="mini" :disabled="!carriers.length" @click="doAutoPlace" title="将未定中心频率的载波在所属转发器内依次排布（首次适配 + 保护带）">自动排布</button>
      <button class="mini" :disabled="!carriers.length" @click="balanceAll" title="将各载波的功率带宽置为其占用带宽（功带平衡的起点，随后可逐条调整）">功带对齐</button>
      <label class="fld" title="仅作用于吸附、自动排布与条带上的斜纹留白：条带拖动不受其约束，保护带仍可分出">保护带
        <input class="ci num nar" :value="dval('guard', guardMHz)"
          @input="dput('guard', $event.target.value, (m) => { guardMHz = m ?? 0 })" @blur="ddone" /> {{ U }}</label>
      <span class="sep"></span>
      <button class="sw" :class="{ on: colorOn }" @click="colorOn = !colorOn"
        title="载波块按所属波束着色。频带划分给多个波束时按频率归属（条带顶部色带即划分点，载波与其上方对应段同色）；多个波束同频叠放时在组头点击色片选择；逐条载波可在明细表「波束」列中锁定">波束着色</button>
      <span class="spacer"></span>
      <span class="sm" v-if="S.issueCount"><b class="bad">{{ S.issueCount }}</b> 处冲突</span>
    </div>

    <div class="body" ref="bodyEl">
      <section v-for="g in groups" :key="g.channelId" class="tp" :data-g="g.channelId"
        :class="{ open: isOpen(g), used: g.count > 0, bad: g.issues.length, orph: g.orphan }">

        <!-- 收起行 = 一条转发器的身份 + 缩略占用条。点它摊开这一条（图上同步高亮） -->
        <div class="th" @click="pick(g)">
          <span class="tw"><Icon v-if="!g.orphan" :name="isOpen(g) ? 'chevron-down' : 'chevron-right'" :size="11" /></span>
          <span class="gno">{{ g.orphan ? '未归属转发器' : (g.no || '—') }}</span>
          <template v-if="!g.orphan">
            <span class="gf" v-if="g.f1 != null">↓ {{ fu(g.f1) }}~{{ fu(g.f2) }}<i v-if="g.pol">{{ g.pol }}</i></span>
            <span class="gbw">{{ fu(g.bwMHz) }} {{ U }}</span>
            <!-- 波束：同频叠放的那种是【二选一】，色片即选择钮（选中的实底，其余暗着）；
                 频带切开的那种色片只是图例 —— 归谁由频率定，点它没有意义 -->
            <span class="gbm" :class="{ pick: stacked(g) }" v-if="g.beams && g.beams.length">
              <template v-if="stacked(g)">
                <button v-for="b in g.beams" :key="b.id" class="bmp" :class="{ on: g.pickBeamId === b.id }"
                  @click.stop="pickBeam(g, b.id)"
                  :title="`该转发器上多个波束同频叠放，无法按频率区分归属。点击可将本条转发器的载波默认归入「${b.name}」（逐条仍可在明细表中另行指定）`">
                  <i class="dot" :style="{ background: b.color }"></i>{{ b.name }}
                </button>
              </template>
              <template v-else>
                <em v-for="b in g.beams" :key="b.id"><i class="dot" :style="{ background: b.color }"></i>{{ b.name }}</em>
              </template>
            </span>
          </template>
          <span class="spacer"></span>
          <!-- 缩略条只在收起时出现：摊开之后正下方就是那条大的，两条同一件事 -->
          <span class="mini-bar" v-if="minis.get(g.channelId)">
            <i v-for="(s, i) in minis.get(g.channelId).segs" :key="i" class="mseg" :class="{ float: !s.placed }"
              :style="{ left: Math.max(0, s.left) + '%', width: Math.min(100, s.width) + '%',
                        ...paintStyle(g, s.r, s.placed ? s.a : null, s.placed ? s.b : null) }"></i>
            <i class="mpwr" :style="{ width: minis.get(g.channelId).pwr + '%' }"></i>
          </span>
          <span class="gn" v-if="g.count">{{ g.count }}</span>
          <span class="gsum" v-if="g.count">
            <b :class="utilCls(g.bwUtil)">{{ fu(g.occSum) }}</b><i v-if="g.freeMHz != null">剩 {{ fu(g.freeMHz) }}</i>
          </span>
          <button v-if="!g.orphan" class="gadd" @click.stop="addCarrier(g)" title="在该转发器上添加载波">
            <Icon name="plus" :size="11" /> 载波
          </button>
        </div>

        <div v-if="isOpen(g)" class="panel" tabindex="-1" @keydown="onKey">
          <!-- ── 频带条 ── 拖块身平移、拖两端拉伸、在空白处拖出一条新载波 -->
          <div class="stripwrap" v-if="st(g)" tabindex="0"
            @keydown.left.prevent="nudge(g, -1, $event.shiftKey)" @keydown.right.prevent="nudge(g, 1, $event.shiftKey)">
            <div class="strip" :class="{ busy: !!drag, canadd: !g.orphan && canEdit(g) }"
              @pointerdown="startNew($event, g)" @pointermove="onDrag" @pointerup="endDrag"
              @pointercancel="endDrag" @lostpointercapture="endDrag" @contextmenu.prevent="openMenu($event, g, '')"
              :title="canEdit(g) ? '拖块身平移 · 拖两端改起止 · 在空白处拖出一条新载波（按住 Alt 关掉吸附）' : noDxTitle(g)">
              <div class="band" :style="{ left: st(g).band.left + '%', width: st(g).band.width + '%' }"></div>
              <!-- 波束占段：条顶上一道色带，与组头那排色点同色同名；占同一段频率的几个波束
                   各错开一层（见 segsOf）。pointer-events 必须关掉 —— 它压在条的上沿，吃掉指针
                   就在那一带拖不出新载波 -->
              <i class="seg" v-for="(s, i) in st(g).segs" :key="'s' + i"
                :style="{ left: st(g).pc(s.f1) + '%', width: st(g).wpc(s.f2 - s.f1) + '%',
                          top: s.top + 'px', height: s.h + 'px', backgroundColor: s.beam.color }"></i>
              <!-- 保护带：载波两侧各留的那一段。只是留白，不是栏杆 —— 拖进去照样放得下 -->
              <i class="grd" v-for="(gd, i) in st(g).guards" :key="'g' + i"
                :style="{ left: st(g).pc(gd.a) + '%', width: st(g).wpc(gd.b - gd.a) + '%' }"></i>

              <template v-for="b in st(g).bars" :key="b.r.c.id">
                <!-- 边沿读数：块窄到写不下就不写（挤成一团比不写更难读） -->
                <template v-if="st(g).px(b.b - b.a) > 76">
                  <span class="elab" :style="{ left: st(g).pc(b.a) + '%' }">{{ fu(b.a) }}</span>
                  <span class="elab" :style="{ left: st(g).pc(b.b) + '%' }">{{ fu(b.b) }}</span>
                </template>
                <!-- 功率带宽作底衬：从块的左沿起画，与占用带宽同轴比对，超出块宽即功率限 -->
                <i class="pwr" v-if="b.r.pwr" :style="{ left: st(g).pc(b.a) + '%', width: st(g).wpc(b.r.pwr) + '%' }"></i>
                <div class="blk" :class="{ float: !b.placed, on: isSel(b.r.c.id), bad: isBad(g, b.r.c.id) }"
                  :style="{ ...blkStyle(g, b), left: st(g).pc(b.a) + '%', width: st(g).wpc(b.b - b.a) + '%' }"
                  :title="barTitle(b)" @pointerdown.stop="beginDrag($event, g, 'move', b, '')"
                  @contextmenu.prevent.stop="openMenu($event, g, b.r.c.id)">
                  <!-- 名字与带宽上下两行摆在块里：从前带宽是块外一条绝对定位的标注，正压在名字上 -->
                  <span class="bn">{{ b.r.c.name }}</span>
                  <span class="bbw" v-if="st(g).px(b.b - b.a) > 42">{{ fu(b.r.occ) }}</span>
                  <i class="h l" @pointerdown.stop="beginDrag($event, g, 'edge', b, 'f1')"></i>
                  <i class="h r" @pointerdown.stop="beginDrag($event, g, 'edge', b, 'f2')"></i>
                </div>
              </template>

              <!-- 拖出新载波时的预览 -->
              <div class="newblk" v-if="drag && drag.mode === 'new' && drag.moved && drag.gid === g.channelId"
                :style="{ left: st(g).pc(drag.na) + '%', width: st(g).wpc(drag.nb - drag.na) + '%' }">
                <span class="bn">{{ fu(drag.nb - drag.na) }}</span>
              </div>
            </div>
            <!-- 轴：起 · 中 · 止（照运营装载表的写法，转发器身份就写这三个数） -->
            <div class="axis">
              <span class="ax" :style="{ left: st(g).pc(g.f1) + '%' }">{{ fu(g.f1) }}</span>
              <span class="ax" :style="{ left: st(g).pc((g.f1 + g.f2) / 2) + '%' }">{{ fu((g.f1 + g.f2) / 2) }}</span>
              <span class="ax" :style="{ left: st(g).pc(g.f2) + '%' }">{{ fu(g.f2) }}</span>
            </div>
          </div>

          <!-- 本条转发器的读数：占用 / 功率 / 剩余，只出数值与色标 -->
          <div class="psum" v-if="g.count">
            <span class="k">占用</span><b class="v" :class="utilCls(g.bwUtil)">{{ fu(g.occSum) }}</b><i>{{ pct(g.bwUtil) }}</i>
            <span class="k">功率</span><b class="v" :class="utilCls(g.pwrUtil)">{{ fu(g.pwrSum) }}</b><i>{{ pct(g.pwrUtil) }}</i>
            <template v-if="g.freeMHz != null"><span class="k">剩余</span><b class="v">{{ fu(g.freeMHz) }}</b></template>
            <template v-if="g.rateSum"><span class="k">速率</span><b class="v">{{ fx(g.rateSum, 0) }}</b><i>kbps</i></template>
          </div>

          <!-- 明细表自己横滚：十四列有 1000px 的下限，窄栏下若让整页横滚，频带条与上面那排
               转发器行会跟着被推出视野 —— 要横滚的只有这张表 -->
          <div class="tscroll" v-if="g.count">
          <table class="t">
            <colgroup>
              <col style="width:26px" /><col style="min-width:132px" />
              <col style="width:88px" /><col style="width:88px" /><col style="width:88px" />
              <col style="width:76px" /><col style="width:76px" />
              <col style="min-width:132px" /><col style="width:54px" /><col style="width:92px" /><col style="width:78px" />
              <col style="min-width:96px" /><col style="width:78px" /><col style="width:24px" />
            </colgroup>
            <thead>
              <tr>
                <!-- 频率与带宽各列写的是当前刻度（工具栏那个下拉），与转发器表、图上同一把尺子 -->
                <th></th><th>载波</th>
                <th>↓ 起始 {{ U }}</th><th>↓ 中心 {{ U }}</th><th>↓ 终止 {{ U }}</th>
                <th title="Rs×(1+α)">占用 {{ U }}</th><th title="功率占用 × 转发器带宽">功率 {{ U }}</th>
                <th>波束</th><th>极化</th><th>调制 · 编码</th><th>速率 kbps</th><th>备注</th><th>转发器</th><th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in g.rows" :key="r.c.id" class="cr" :class="{ on: isSel(r.c.id) }"
                @click="onPickCarrier(g, r.c.id, $event)" @contextmenu.prevent="openMenu($event, g, r.c.id)">
                <td class="rn">{{ r.idx }}</td>
                <td><input class="ci" :value="r.c.name" @input="patch(r.c.id, { name: $event.target.value })" /></td>
                <td><input class="ci num" :value="eVal(r, 'f1')" :disabled="!canEdit(g)" :title="canEdit(g) ? edgeTitle('f1') : noDxTitle(g)"
                  @input="eInput(r.c.id, 'f1', $event.target.value)" @change="commitEdge(g, r, 'f1', $event.target.value)" /></td>
                <td><input class="ci num" :value="dval(`fc${r.c.id}`, r.f.fc)" :disabled="!canEdit(g)" :title="noDxTitle(g)" @blur="ddone"
                  @input="dput(`fc${r.c.id}`, $event.target.value, (m) => setFc(g, r, m))" /></td>
                <td><input class="ci num" :value="eVal(r, 'f2')" :disabled="!canEdit(g)" :title="canEdit(g) ? edgeTitle('f2') : noDxTitle(g)"
                  @input="eInput(r.c.id, 'f2', $event.target.value)" @change="commitEdge(g, r, 'f2', $event.target.value)" /></td>
                <!-- 这两格绑的是载波身上的原值，不是行模型里那个「> 0 才算数」的派生值：填了 0 也得照显示，
                     否则屏上空着、存着的却是 0（同 dput 的「空 ≠ 0」口径） -->
                <td><input class="ci num" :value="dval(`occ${r.c.id}`, r.c.occBwMHz)" @blur="ddone"
                  @input="dput(`occ${r.c.id}`, $event.target.value, (m) => patch(r.c.id, { occBwMHz: m }))" /></td>
                <td><input class="ci num" :value="dval(`pwr${r.c.id}`, r.c.pwrBwMHz)" @blur="ddone"
                  @input="dput(`pwr${r.c.id}`, $event.target.value, (m) => patch(r.c.id, { pwrBwMHz: m }))" /></td>
                <td>
                  <!-- ★ 下拉里【只列这条转发器挂着的那几个波束】：两个波束就是两项。从前另有一个
                       写着继承值的空项，于是「二选一」的下拉里出现三项、其中两项同名 —— 那一项
                       改成只在钉死之后才出现的「自动」（没钉死时它与当前项恒同值，等于占个重号）。
                       未钉死时选中的是自动认领到的那个，字压灰（同带宽格的灰字继承值）。
                       前面那个色点 = 这一行在条上是什么颜色，跨两段的照样画成两色，表与条对得上 -->
                  <span class="bmcell">
                    <i class="dot" v-if="r.beam" :style="paintStyle(g, r, r.f.f1, r.f.f2)"></i>
                    <select class="ci selc" :class="{ inh: !r.beamPinned }" :value="r.c.beamId || (r.beam ? r.beam.id : '')"
                      :disabled="!g.beams || !g.beams.length" :title="beamCellTitle(g, r)"
                      @change="patch(r.c.id, { beamId: $event.target.value })">
                      <option v-if="r.beamPinned" value="">自动</option>
                      <option v-for="b in g.beams" :key="b.id" :value="b.id">{{ b.name }}</option>
                    </select>
                  </span>
                </td>
                <td>
                  <!-- 留空 = 随所属转发器（灰字继承值），同转发器表带宽那一格的读法 -->
                  <select class="ci selc" :class="{ inh: r.polInherited }" :value="r.c.pol || ''" :title="POL_LABEL[r.pol] || ''"
                    @change="patch(r.c.id, { pol: $event.target.value })">
                    <option value="">{{ g.pol || '—' }}</option>
                    <option v-for="p in POLS" :key="p" :value="p">{{ p }}</option>
                  </select>
                </td>
                <td><input class="ci" :value="r.c.modcod" @input="patch(r.c.id, { modcod: $event.target.value })" /></td>
                <td><input class="ci num" :value="r.c.infoRateKbps ?? ''" @input="setRate(r.c.id, $event.target.value)" /></td>
                <td><input class="ci" :value="r.c.note" @input="patch(r.c.id, { note: $event.target.value })" /></td>
                <td>
                  <select class="ci selc" :value="g.orphan ? '' : g.channelId" @change="setTp(r.c.id, $event.target.value)">
                    <option value="">—</option>
                    <option v-for="t in tpList" :key="t.id" :value="t.id">{{ t.label }}</option>
                  </select>
                </td>
                <td><button class="del" title="删除" @click.stop="removeIds([r.c.id])"><Icon name="x" :size="10" /></button></td>
              </tr>
            </tbody>
          </table>
          </div>
          <div v-else class="pnone">还没有载波。</div>

          <div v-for="(is, i) in g.issues" :key="i" class="isrow">{{ is.msg }}</div>
        </div>
      </section>

      <div v-if="!groups.length" class="none">本频率计划尚无转发器。</div>
    </div>

    <!-- 右键菜单：复制 / 剪切 / 粘贴 / 删除（与 Ctrl+C / X / V / Delete 同一套动作） -->
    <template v-if="menu">
      <!-- pointerdown 上 preventDefault：连带把随后的 mousedown / click 一并压掉，菜单开着时
           点别处只关菜单，不会顺手把底下那一行也点选了 -->
      <div class="mmask" @pointerdown.prevent="closeMenu" @contextmenu.prevent="closeMenu"></div>
      <div class="cmenu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
        <button :disabled="!sel.length" @click="runMenu('copy')"><span>复制</span><i>Ctrl+C</i></button>
        <button :disabled="!sel.length" @click="runMenu('cut')"><span>剪切</span><i>Ctrl+X</i></button>
        <button :disabled="!clip.length || menu.orphan" @click="runMenu('paste')"><span>粘贴</span><i>Ctrl+V</i></button>
        <!-- 波束：选中的那几条一起改。挂两个波束的转发器上，这就是那个「二选一」 -->
        <template v-if="menuBeams.length">
          <div class="msep"></div>
          <button v-for="b in menuBeams" :key="b.id" class="bm" :disabled="!sel.length" @click="runMenu('beam', b.id)">
            <span class="cdot" :style="{ background: b.color }"></span><span>{{ b.name }}</span>
          </button>
          <button class="bm" :disabled="!sel.length" @click="runMenu('beam', '')">
            <span class="cdot none"></span><span>自动</span>
          </button>
        </template>
        <div class="msep"></div>
        <button class="dgr" :disabled="!sel.length" @click="runMenu('del')"><span>删除</span><i>Delete</i></button>
      </div>
    </template>

    <!-- 表末整星合计 -->
    <div class="foot" v-if="res.groups.length">
      <span class="k">载波</span><b>{{ S.carrierCount }}</b>
      <span class="k">转发器</span><b>{{ S.tpUsed }}/{{ S.tpTotal }}</b>
      <span class="k">总带宽</span><b>{{ fu(S.totalBwMHz) }}</b>
      <span class="k">占用</span><b :class="utilCls(S.bwUtil)">{{ fu(S.occupiedBwMHz) }}</b><i>{{ pct(S.bwUtil) }}</i>
      <span class="k">功率</span><b :class="utilCls(S.pwrUtil)">{{ fu(S.powerBwMHz) }}</b><i>{{ pct(S.pwrUtil) }}</i>
      <span class="k">剩余</span><b>{{ fu(S.freeBwMHz) }}</b>
      <span class="spacer"></span>
      <template v-if="S.totalRateKbps"><span class="k">速率</span><b>{{ fx(S.totalRateKbps, 0) }}</b><i>kbps</i></template>
      <template v-if="S.avgEffBpsHz != null"><b>{{ S.avgEffBpsHz.toFixed(3) }}</b><i>bps/Hz</i></template>
    </div>
  </div>
</template>

<style scoped>
.fpal { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.cbar { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-bottom: 1px solid var(--border); }
.spacer { flex: 1; }
.sep { width: 1px; height: 14px; background: var(--border); }
.fld { font-size: 12px; color: var(--text-muted); display: inline-flex; align-items: center; gap: 4px; }
.sm { font-size: 12px; color: var(--text-muted); }
.sm .bad { color: var(--danger); }
/* 波束着色开关：按下是实底（与 .mini 同高，两者在工具栏上并排） */
.sw { font: inherit; font-size: 12.5px; padding: 3px 9px; border: 1px solid var(--border-strong); background: var(--bg); color: var(--text-muted); cursor: pointer; }
.sw:hover { color: var(--text); }
.sw.on { background: var(--text); border-color: var(--text); color: var(--bg); }

.body { flex: 1; overflow: auto; }
.none { padding: 20px; text-align: center; color: var(--text-faint); font-size: 12.5px; }

/* ── 收起行 ── 一条转发器一行：身份 + 缩略占用条 + 两个读数。整页是这样一列，点开一条编排它 */
.tp { border-bottom: 1px solid var(--border); }
.tp.open { border-bottom: 1px solid var(--border-strong); }
.th { display: flex; align-items: center; gap: 10px; padding: 4px 8px; font-size: 12px; cursor: pointer; background: var(--surface-2); }
.th:hover { background: color-mix(in srgb, var(--text) 5%, var(--surface-2)); }
.tp.open .th { border-bottom: 1px solid var(--border); }
.tp.bad .th { background: color-mix(in srgb, var(--danger) 8%, var(--surface-2)); }
.tp.orph .th { background: color-mix(in srgb, var(--warn) 10%, var(--surface-2)); cursor: default; }
.tw { width: 12px; flex: none; color: var(--text-faint); display: inline-flex; }
.gno { font-weight: 600; font-size: 12.5px; flex: none; }
.gf { color: var(--text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; flex: none; }
.gf i { font-style: normal; margin-left: 4px; padding: 0 3px; border: 1px solid var(--border-strong); font-size: 10.5px; }
.gbw { font-variant-numeric: tabular-nums; flex: none; }
.gbm { color: var(--text-faint); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gbm em { font-style: normal; margin-right: 8px; }
.gbm .dot { display: inline-block; width: 7px; height: 7px; margin-right: 3px; vertical-align: baseline; border: 1px solid rgba(0, 0, 0, .25); }
/* 二选一那一组不许被挤掉：只是图例的可以省略号截断，能点的截断了就成了半个按钮 */
.gbm.pick { flex: none; overflow: visible; }
/* 二选一的色片钮：没选中的连色点一并压暗 —— 光靠文字深浅分不出「选中的是哪一个」 */
.bmp { font: inherit; font-size: 11.5px; line-height: 1.1; padding: 1px 5px 1px 3px; margin-right: 4px;
  border: 1px solid transparent; background: none; color: var(--text-faint); cursor: pointer; }
.bmp .dot { opacity: .3; }
.bmp:hover { border-color: var(--border-strong); background: var(--bg); }
.bmp.on { color: var(--text); border-color: var(--border-strong); background: var(--bg); }
.bmp.on .dot { opacity: 1; }
.gn { flex: none; font-size: 11px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
.gsum { flex: none; font-variant-numeric: tabular-nums; white-space: nowrap; }
.gsum b { font-weight: 600; }
.gsum b.over { color: var(--danger); }
.gsum b.near { color: var(--warn); }
.gsum i { font-style: normal; font-size: 11px; color: var(--text-faint); margin-left: 6px; }
/* 缩略占用条：收起行里那一眼。overflow 必须裁——越界的载波算出来就是负 left / 111% 宽 */
.mini-bar { position: relative; flex: none; width: 132px; height: 9px; background: var(--bg); border: 1px solid var(--border); overflow: hidden; }
.mseg { position: absolute; top: 1px; height: 5px; }
.mseg.float { background-image: repeating-linear-gradient(45deg, rgba(255, 255, 255, .45) 0 3px, transparent 3px 6px); }
.mpwr { position: absolute; bottom: 0; left: 0; height: 2px; background: var(--warn); opacity: .85; }
.gadd { display: inline-flex; align-items: center; gap: 2px; font: inherit; font-size: 11px; padding: 0 4px; height: 17px; flex: none;
  border: 1px solid transparent; background: none; color: var(--text-faint); cursor: pointer; }
.th:hover .gadd { color: var(--text); border-color: var(--border-strong); background: var(--bg); }
.th .gadd:hover { color: var(--text); border-color: var(--text); background: var(--bg); }   /* 与上一条同权重，写在后面才压得住 */

/* ── 编排面板 ── 摊开的那一条 */
.panel { padding: 8px 0 6px; background: var(--bg); outline: none; }
.pnone { padding: 8px 14px 10px; color: var(--text-faint); font-size: 12px; }

/* 频带条。左右各留 48px：起 / 止 的读数居中压在边沿上，要有地方往外探出去 */
.stripwrap { padding: 14px 48px 0; outline: none; }
.stripwrap:focus-visible { box-shadow: inset 0 0 0 1px var(--border-strong); }
.strip { position: relative; height: 46px; }
.strip.canadd { cursor: crosshair; }
.strip.busy { cursor: default; }
/* 转发器频带：条上那一段实底 + 两端的强边线（边沿在哪儿必须一眼看得见，载波压不压得住是另一回事） */
.band { position: absolute; top: 0; bottom: 0; background: var(--surface-2);
  border-left: 2px solid var(--border-strong); border-right: 2px solid var(--border-strong); }
/* 波束占段：条顶上一道色带。载波块高 32px 起于 top:7px，故这几个像素不压任何东西。
   叠着的几段各占一层，top / height 由 segsOf 现给（这里的两个数只是单段时的默认） */
.seg { position: absolute; top: 0; height: 5px; pointer-events: none; opacity: .9; }
/* 保护带留白：斜纹，画在块的两侧。只是留白 —— 拖进去照样放得下 */
.grd { position: absolute; top: 7px; height: 32px; pointer-events: none; opacity: .5;
  background-image: repeating-linear-gradient(45deg, transparent 0 3px, var(--text-faint) 3px 4px); }

.blk { position: absolute; top: 7px; height: 32px; background-color: #5B8FD4; border: 1px solid rgba(0, 0, 0, .3);
  display: flex; flex-direction: column; align-items: center; justify-content: center; line-height: 1.15;
  overflow: hidden; cursor: grab; box-sizing: border-box; }
.strip.busy .blk { cursor: grabbing; }
/* 未定频的那几条：斜纹 + 虚边，顺次铺在频带起点之后。拖一下即落定 */
.blk.float { background-image: repeating-linear-gradient(45deg, rgba(255, 255, 255, .3) 0 4px, transparent 4px 8px); border-style: dashed; }
.blk.on { border: 2px solid var(--text); }
.blk.bad { border-color: var(--danger); border-width: 2px; }
.blk .bn, .blk .bbw { color: var(--ink, #fff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;
  padding: 0 5px; pointer-events: none; user-select: none; text-shadow: 0 1px 1px var(--shd, rgba(0, 0, 0, .35)); }
.blk .bn { font-size: 11px; }
.blk .bbw { font-size: 10px; opacity: .92; font-variant-numeric: tabular-nums; }
/* 两端把手：8px 宽的抓取带，压在块的边沿上（块本身是平移，边沿是拉伸） */
.blk .h { position: absolute; top: 0; bottom: 0; width: 8px; cursor: ew-resize; }
.blk .h.l { left: -1px; }
.blk .h.r { right: -1px; }
.blk:hover .h { background: rgba(255, 255, 255, .35); }

/* 拖出新载波时的预览块。★ 别叫 .ghost —— 工具栏那两个按钮用的是 .mini.ghost，
   同名的话它们会被这条的 position:absolute 抓走，一起飞到页面左上角去 */
.newblk { position: absolute; top: 7px; height: 32px; border: 1px dashed var(--text); background: rgba(91, 143, 212, .28);
  display: flex; align-items: center; justify-content: center; pointer-events: none; box-sizing: border-box; }
.newblk .bn { font-size: 11px; color: var(--text); font-variant-numeric: tabular-nums; }

/* 功率带宽底衬：从块的左沿起画，与占用带宽同轴上下对照 —— 探出块宽即功率限 */
.pwr { position: absolute; bottom: 1px; height: 3px; background: var(--warn); opacity: .9; pointer-events: none; }

.elab, .ax { position: absolute; font-size: 10px; font-variant-numeric: tabular-nums;
  white-space: nowrap; pointer-events: none; user-select: none; }
.elab { top: -13px; transform: translateX(-50%); color: var(--text-faint); }
.axis { position: relative; height: 15px; margin-top: 2px; border-top: 1px solid var(--border-strong); }
.ax { top: 2px; transform: translateX(-50%); color: var(--text-muted); font-size: 10.5px; }

/* 本条转发器的读数行 */
.psum { display: flex; align-items: baseline; gap: 4px; padding: 8px 48px 2px; font-size: 12px; font-variant-numeric: tabular-nums; }
.psum .k { color: var(--text-faint); margin-left: 14px; }
.psum .k:first-child { margin-left: 0; }
.psum .v { font-weight: 600; }
.psum .v.over { color: var(--danger); }
.psum .v.near { color: var(--warn); }
.psum i { font-style: normal; font-size: 10.5px; color: var(--text-faint); }

.tscroll { overflow-x: auto; margin-top: 6px; }
.t { width: 100%; min-width: 1000px; border-collapse: collapse; font-size: 12.5px; }
.t thead th { background: var(--surface); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border-strong);
  padding: 3px 6px; text-align: left; font-weight: 600; white-space: nowrap; color: var(--text-muted); }
.t td { border-bottom: 1px solid var(--border); padding: 2px 6px; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.cr .rn { text-align: right; color: var(--text-faint); font-size: 11px; font-variant-numeric: tabular-nums; }
.cr:hover td { background: color-mix(in srgb, var(--text) 3%, transparent); }
.cr.on td { background: color-mix(in srgb, var(--text) 6%, transparent); }

.isrow { color: var(--danger); font-size: 11.5px; padding: 3px 48px 0; }

/* 右键菜单。遮罩吃掉一次点击（含右键）——菜单开着时点别处只该关菜单，不该同时选中别的东西 */
.mmask { position: fixed; inset: 0; z-index: 40; }
.cmenu { position: fixed; z-index: 41; min-width: 132px; padding: 3px 0; background: var(--bg);
  border: 1px solid var(--border-strong); box-shadow: 0 6px 18px rgba(0, 0, 0, .18); }
.cmenu button { display: flex; align-items: center; gap: 14px; width: 100%; font: inherit; font-size: 12.5px;
  padding: 3px 10px; border: none; background: none; color: var(--text); cursor: pointer; text-align: left; }
.cmenu button i { margin-left: auto; font-style: normal; font-size: 10.5px; color: var(--text-faint); }
.cmenu button.bm { gap: 7px; }
.cmenu .cdot { flex: none; width: 8px; height: 8px; border: 1px solid rgba(0, 0, 0, .25); }
.cmenu .cdot.none { background: transparent; border-style: dashed; }
.cmenu button:hover:not(:disabled) { background: var(--surface-2); }
.cmenu button:disabled { color: var(--text-faint); cursor: default; }
.cmenu button.dgr:hover:not(:disabled) { color: var(--danger); }
.msep { height: 1px; margin: 3px 0; background: var(--border); }

/* 表末整星合计：压双线，与上面每一条的分区线拉开层级 */
.foot { display: flex; align-items: baseline; gap: 4px; padding: 4px 10px; font-size: 12px;
  font-variant-numeric: tabular-nums; background: var(--surface); border-top: 3px double var(--text-faint); }
.foot .k { color: var(--text-faint); margin-left: 12px; }
.foot .k:first-child { margin-left: 0; }
.foot b { font-weight: 600; }
.foot b.over { color: var(--danger); }
.foot b.near { color: var(--warn); }
.foot i { font-style: normal; font-size: 10.5px; color: var(--text-faint); }

.ci { width: 100%; background: transparent; border: 1px solid transparent; color: var(--text); padding: 2px 3px; font: inherit; font-family: var(--font-serif); }
.ci:hover:not(:disabled) { border-color: var(--border); }
.ci:focus { border-color: var(--text); outline: none; background: var(--bg); }
.ci:disabled { color: var(--text-faint); cursor: default; }
.ci.num { text-align: right; font-variant-numeric: tabular-nums; }
/* 波束那一格：色点 + 下拉。色点是只读标注（这一行在条上什么颜色），故不吃指针 */
.bmcell { display: flex; align-items: center; gap: 4px; }
.bmcell .dot { flex: none; width: 8px; height: 8px; border: 1px solid rgba(0, 0, 0, .25); pointer-events: none; }
/* 下拉吃掉整格剩下的宽 —— 波束名动辄七八个字（CHINA / Beam 2 / 中星某某），截半个字最难认 */
.bmcell .selc { flex: 1; min-width: 0; }
.selc { -webkit-appearance: none; appearance: none; }
.selc.inh { color: var(--text-faint); }
.del { border: none; background: transparent; color: var(--text-faint); cursor: pointer; padding: 2px 4px; }
.del:hover { color: var(--danger); }
.mini { font: inherit; font-size: 12.5px; padding: 3px 9px; border: 1px solid var(--border-strong); background: var(--bg); color: var(--text-muted); cursor: pointer; }
.mini:hover:not(:disabled) { background: var(--surface-2); color: var(--text); }
.mini:disabled { opacity: .45; cursor: default; }
</style>
