<script setup>
// 文件管理 · 模块库编辑页。
//
// 与 MODCOD 表那一页同一套形制（内置 + 用户改写、改写层只存差异）：
//   · 内置条目可改可隐藏，【不能真删】—— 它在代码里，删了下次启动又回来；
//   · 改过的打「改」标，一键恢复出厂＝删掉它的改写条目；
//   · 自建条目 usr: 前缀，与内置分家（改名不会让已存场景里的 libId 指空）。
//
// 主从两栏：左边库树（分类 → 分组 → 条目），右边这一条的编辑器。
// 端口是这套模型的核心（能不能连全看它），故端口表放在最上面。
import { ref, computed, onMounted, watch } from 'vue'
import Icon from './Icon.vue'
import { drawSymbol, symbolIds } from '../viz/scene/sceneSymbols.js'

const api = () => ((typeof window !== 'undefined' && window.api && window.api.scene) || {})

const mods = ref([])
const cats = ref([])
const groups = ref({})
const catalog = ref(null)
const err = ref('')
const busy = ref(false)
const tip = ref('')
const kw = ref('')
const catF = ref('')
const selId = ref('')
const dirty = ref(false)

const sel = computed(() => mods.value.find((m) => m.id === selId.value) || null)
const media = computed(() => (catalog.value && catalog.value.media) || [])
const mediaGrouped = computed(() => {
  const g = new Map()
  for (const m of media.value) {
    if (!g.has(m.cat)) g.set(m.cat, [])
    g.get(m.cat).push(m)
  }
  const names = Object.fromEntries(((catalog.value && catalog.value.cats) || []).map((c) => [c.key, c.zh]))
  return [...g.entries()].map(([k, items]) => ({ key: k, zh: names[k] || k, items }))
})
const syms = symbolIds()

async function reload() {
  busy.value = true
  try {
    const [l, c] = await Promise.all([api().libList?.({ includeHidden: true }), api().catalog?.()])
    mods.value = (l && l.modules) || []
    cats.value = (l && l.cats) || []
    groups.value = (l && l.groups) || {}
    catalog.value = c || null
    err.value = (l && l.error) || ''
    dirty.value = false
    if (!sel.value && mods.value.length) selId.value = mods.value[0].id
  } catch (e) { err.value = e.message } finally { busy.value = false }
}
onMounted(reload)

const filtered = computed(() => {
  const q = kw.value.trim().toLowerCase()
  return mods.value.filter((m) => {
    if (catF.value && m.cat !== catF.value) return false
    if (!q) return true
    return [m.zh, m.en, m.id, m.vendor, m.model, (m.tags || []).join(' ')].filter(Boolean).join(' ').toLowerCase().includes(q)
  })
})
const tree = computed(() => {
  const g = new Map()
  for (const m of filtered.value) {
    const k = m.cat + '/' + m.group
    if (!g.has(k)) g.set(k, { key: k, cat: m.cat, zh: groups.value[m.group] || m.group, items: [] })
    g.get(k).items.push(m)
  }
  return [...g.values()].sort((a, b) => a.cat.localeCompare(b.cat) || a.zh.localeCompare(b.zh, 'zh'))
})
const catZh = (k) => { const c = cats.value.find((x) => x.key === k); return c ? c.zh : k }

function icon(el, symbol) {
  if (!el) return
  const n = 36; el.width = n; el.height = n
  const ctx = el.getContext('2d'); ctx.clearRect(0, 0, n, n)
  const ink = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#000'
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#fff'
  drawSymbol(ctx, symbol, n / 2, n / 2, n * 0.94, ink, 0, bg)
}

// ── 编辑 ──
const mark = () => { dirty.value = true }
function addPort() {
  if (!sel.value) return
  if (!sel.value.ports) sel.value.ports = []
  let k = 'p1', i = 1
  while (sel.value.ports.some((p) => p.key === k)) k = 'p' + (++i)
  sel.value.ports.push({ key: k, zh: '新端口', medium: 'cat6', dir: 'trx', role: 'data' })
  mark()
}
const rmPort = (i) => { sel.value.ports.splice(i, 1); mark() }

function newModule() {
  const m = {
    id: 'usr:' + Math.random().toString(36).slice(2, 10), cat: 'D', group: 'misc',
    zh: '自定义模块', en: 'Custom module', symbol: 'sensor', ports: [],
    place: { modes: ['fixed'], mountable: false, hostCats: [] }, tags: [], src: '自建',
    builtin: false, modified: false, hidden: false
  }
  mods.value.push(m); selId.value = m.id; mark()
}
function duplicate() {
  const b = sel.value; if (!b) return
  const m = JSON.parse(JSON.stringify(b))
  m.id = 'usr:' + Math.random().toString(36).slice(2, 10)
  m.zh = b.zh + ' 副本'; m.en = (b.en || b.zh) + ' (copy)'
  m.builtin = false; m.modified = false; m.hidden = false
  m.src = '派生自 ' + b.id
  mods.value.push(m); selId.value = m.id; mark()
}
function removeOrHide() {
  const m = sel.value; if (!m) return
  if (m.builtin) { m.hidden = !m.hidden; mark(); return }
  mods.value = mods.value.filter((x) => x.id !== m.id)
  selId.value = mods.value.length ? mods.value[0].id : ''
  mark()
}
async function resetOne() {
  const m = sel.value; if (!m || !m.builtin) return
  const r = await api().libReset?.(m.id)
  if (r && r.ok) { mods.value = r.modules; tip.value = '已恢复出厂'; setTimeout(() => { tip.value = '' }, 1600) }
  else err.value = (r && r.error) || ''
}
async function resetAll() {
  const r = await api().libResetAll?.()
  if (r && r.ok) { mods.value = r.modules; dirty.value = false; tip.value = '全库已恢复出厂'; setTimeout(() => { tip.value = '' }, 1600) }
  else err.value = (r && r.error) || ''
}
async function save() {
  busy.value = true
  try {
    const r = await api().libSave?.(JSON.parse(JSON.stringify(mods.value)))
    if (r && r.ok) { mods.value = r.modules; dirty.value = false; tip.value = '已保存'; setTimeout(() => { tip.value = '' }, 1600) }
    else err.value = (r && r.error) || '保存失败'
  } finally { busy.value = false }
}

// 数值字段的读写（rf / sat 两组，键名与地球站库 / 卫星库逐字一致）
const RF_KEYS = [
  ['antennaDiameter', '天线口径', 'm'], ['gainTxDbi', '发射天线增益', 'dBi'], ['gainRxDbi', '接收天线增益', 'dBi'],
  ['opPowerW', '功放功率', 'W'], ['antennaEfficiency', '发射效率', '%'], ['paBackoff', '功放回退', 'dB'],
  ['feederLoss', '发射馈线', 'dB'], ['rxAntennaEfficiency', '接收效率', '%'],
  ['rxAntennaNoiseTemp', '天线噪温', 'K'], ['rxReceiverNoiseTemp', '接收机噪温', 'K'], ['rxFeederLoss', '接收馈线', 'dB']
]
const SAT_KEYS = [
  ['frequencyBand', '工作频段', ''], ['orbitClass', '轨道类型', ''], ['orbitLongitude', '定点经度', '°E'],
  ['orbitAltitude', '轨道高度', 'km'], ['orbitInclination', '倾角', '°'], ['gt', '卫星 G/T', 'dB/K'],
  ['sfdRef', 'SFD', 'dBW/m²'], ['BOi', 'IBO', 'dB'], ['BOo', 'OBO', 'dB'],
  ['transponderBandwidth', '转发器带宽', 'MHz'], ['eirpSat', '饱和 EIRP', 'dBW'], ['eirp', '再生 EIRP', 'dBW'],
  ['procDelayMs', '处理时延', 'ms']
]
const PW_KEYS = [['txW', '发射功率', 'W'], ['rxW', '接收功率', 'W'], ['idleW', '待机功率', 'W'], ['sleepW', '睡眠功率', 'W'], ['alwaysW', '常供电功率', 'W']]
function setIn(group, k, v) {
  const m = sel.value; if (!m) return
  if (!m[group]) m[group] = {}
  if (v === '' || v == null) delete m[group][k]
  else m[group][k] = (isFinite(+v) && v !== '' && !['frequencyBand', 'orbitClass'].includes(k)) ? +v : v
  mark()
}
const stat = computed(() => ({
  all: mods.value.length,
  mod: mods.value.filter((m) => m.modified).length,
  usr: mods.value.filter((m) => !m.builtin).length,
  hid: mods.value.filter((m) => m.hidden).length
}))
</script>

<template>
  <div class="sl">
    <div class="slbar">
      <input class="ci sq" v-model="kw" placeholder="搜模块 / 型号 / 行业" />
      <select v-model="catF">
        <option value="">全部分类</option>
        <option v-for="c in cats" :key="c.key" :value="c.key">{{ c.zh }}</option>
      </select>
      <span class="spacer"></span>
      <span class="cnt">{{ stat.all }} 条 · 改过 {{ stat.mod }} · 自建 {{ stat.usr }} · 隐藏 {{ stat.hid }}</span>
      <button class="b" @click="newModule">新建</button>
      <button class="b" :disabled="!sel" @click="duplicate">另存为</button>
      <button class="b" @click="resetAll">全库恢复出厂</button>
      <button class="b pri" :disabled="busy || !dirty" @click="save">{{ busy ? '…' : (dirty ? '保存' : '已保存') }}</button>
    </div>
    <div v-if="err" class="errline">{{ err }}</div>
    <div v-if="tip" class="okline">{{ tip }}</div>

    <div class="slbody">
      <!-- 库树 -->
      <div class="sltree">
        <template v-for="g in tree" :key="g.key">
          <div class="tgh">{{ catZh(g.cat) }} · {{ g.zh }}</div>
          <div v-for="m in g.items" :key="m.id" class="tgi" :class="{ on: selId === m.id, hid: m.hidden }" @click="selId = m.id">
            <canvas class="ic" :ref="(el) => icon(el, m.symbol)"></canvas>
            <span class="nm">{{ m.zh }}</span>
            <span v-if="m.modified" class="bd mod" title="已改过出厂值">改</span>
            <span v-if="!m.builtin" class="bd usr" title="自建条目">建</span>
            <span v-if="m.hidden" class="bd" title="已隐藏（不出现在选择器里）">隐</span>
          </div>
        </template>
        <div v-if="!tree.length" class="empty">没有匹配的模块。</div>
      </div>

      <!-- 编辑器 -->
      <div v-if="sel" class="sledit">
        <div class="ehd">
          <canvas class="ic2" :ref="(el) => icon(el, sel.symbol)"></canvas>
          <div class="ehn">
            <input class="ci big" v-model="sel.zh" @input="mark" />
            <div class="eid">{{ sel.id }}</div>
          </div>
          <button v-if="sel.builtin" class="b" @click="resetOne">恢复出厂</button>
          <button class="b" @click="removeOrHide">{{ sel.builtin ? (sel.hidden ? '取消隐藏' : '隐藏') : '删除' }}</button>
        </div>

        <div class="grid2">
          <label>英文名</label><input class="ci" v-model="sel.en" @input="mark" />
          <label>分类</label>
          <select v-model="sel.cat" @change="mark"><option v-for="c in cats" :key="c.key" :value="c.key">{{ c.zh }}</option></select>
          <label>分组</label><input class="ci" v-model="sel.group" @input="mark" />
          <label>符号</label>
          <select v-model="sel.symbol" @change="mark"><option v-for="s in syms" :key="s" :value="s">{{ s }}</option></select>
          <label>厂商</label><input class="ci" v-model="sel.vendor" @input="mark" />
          <label>型号</label><input class="ci" v-model="sel.model" @input="mark" />
          <label>标签</label>
          <input class="ci" :value="(sel.tags || []).join(' ')" @change="sel.tags = $event.target.value.split(/\s+/).filter(Boolean); mark()" />
          <label>出处</label><input class="ci" v-model="sel.src" @input="mark" />
        </div>

        <!-- 端口：这套模型的核心，能不能连全看它 -->
        <div class="esec">
          <span>端口</span><span class="spacer"></span><button class="b sm" @click="addPort">加一个</button>
        </div>
        <div class="ptbl">
          <div class="pth"><span>标识</span><span>名称</span><span>介质</span><span>方向</span><span>角色</span><span></span></div>
          <div v-for="(p, i) in (sel.ports || [])" :key="i" class="ptr">
            <input class="ci" v-model="p.key" @input="mark" />
            <input class="ci" v-model="p.zh" @input="mark" />
            <select v-model="p.medium" @change="mark">
              <optgroup v-for="g in mediaGrouped" :key="g.key" :label="g.zh">
                <option v-for="m in g.items" :key="m.key" :value="m.key">{{ m.zh }}</option>
              </optgroup>
            </select>
            <select v-model="p.dir" @change="mark">
              <option value="trx">收发</option><option value="tx">只发</option><option value="rx">只收</option>
            </select>
            <select v-model="p.role" @change="mark">
              <option value="data">业务</option><option value="if">中频</option><option value="power">供电</option>
              <option value="mgmt">管理</option><option value="sense">采集</option>
            </select>
            <span class="del" @click="rmPort(i)"><Icon name="x" :size="12" /></span>
          </div>
          <div v-if="!(sel.ports || []).length" class="empty">还没有端口。</div>
        </div>

        <!-- 射频出厂值 -->
        <template v-if="sel.rf || sel.cat === 'B' || sel.cat === 'C'">
          <div class="esec"><span>射频出厂值</span><span class="hintx">新建地球站库条目时的初值；场景里改的是库不是这里</span></div>
          <div class="grid3">
            <template v-for="k in RF_KEYS" :key="k[0]">
              <label :title="k[0]">{{ k[1] }}</label>
              <input class="ci" :value="sel.rf ? sel.rf[k[0]] : ''" @change="setIn('rf', k[0], $event.target.value)" />
              <span class="u">{{ k[2] }}</span>
            </template>
          </div>
        </template>

        <!-- 卫星出厂值 -->
        <template v-if="sel.sat || sel.cat === 'A'">
          <div class="esec"><span>卫星出厂值</span>
            <label class="ck"><input type="checkbox" v-model="sel.typical" @change="mark" /><span>电平为该类典型值</span></label>
          </div>
          <div class="grid3">
            <template v-for="k in SAT_KEYS" :key="k[0]">
              <label :title="k[0]">{{ k[1] }}</label>
              <input class="ci" :value="sel.sat ? sel.sat[k[0]] : ''" @change="setIn('sat', k[0], $event.target.value)" />
              <span class="u">{{ k[2] }}</span>
            </template>
          </div>
        </template>

        <!-- 功耗（能量账的入参） -->
        <div class="esec"><span>功耗</span><span class="hintx">能量账入参（与 dB 账并列，不混算）</span></div>
        <div class="grid3">
          <template v-for="k in PW_KEYS" :key="k[0]">
            <label>{{ k[1] }}</label>
            <input class="ci" :value="sel.power ? sel.power[k[0]] : ''" @change="setIn('power', k[0], $event.target.value)" />
            <span class="u">{{ k[2] }}</span>
          </template>
          <label>供电方式</label>
          <select :value="sel.power ? sel.power.supply : ''" @change="setIn('power', 'supply', $event.target.value)">
            <option value="">—</option><option value="ac_mains">市电</option><option value="solar">太阳能</option>
            <option value="battery">电池</option><option value="poe">PoE</option><option value="genset">发电机</option>
            <option value="dc_12">直流 12 V</option><option value="dc_24">直流 24 V</option><option value="dc_48">直流 48 V</option>
          </select><span class="u"></span>
        </div>
      </div>
      <div v-else class="sledit empty">选一条模块。</div>
    </div>
  </div>
</template>

<style scoped>
.sl { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: var(--fs-3); }
.slbar { display: flex; align-items: center; gap: 8px; flex: none; padding-bottom: 8px; }
.slbar .sq { width: 190px; }
.ci, select { border: 1px solid var(--field-border); background-color: var(--field-bg); padding: 3px 6px; font-size: var(--fs-3); color: var(--text); outline: none; }
.spacer { flex: 1; }
.cnt { color: var(--text-faint); font-size: var(--fs-2, 11px); font-variant-numeric: tabular-nums; }
.b { height: var(--ctl-h, 24px); padding: 0 9px; border: 1px solid var(--field-border); background: var(--bg); color: var(--text); cursor: pointer; }
.b:hover { border-color: var(--field-border-hover); }
.b.pri { background: var(--accent-ui); border-color: var(--accent-ui); color: var(--bg); }
.b:disabled { opacity: .55; cursor: default; }
.b.sm { height: 20px; padding: 0 7px; font-size: var(--fs-2, 11px); }
.errline { color: var(--danger); padding: 3px 0; }
.okline { color: var(--ok); padding: 3px 0; }

.slbody { flex: 1; min-height: 0; display: flex; gap: 12px; }
.sltree { width: 292px; flex: none; overflow-y: auto; border: 1px solid var(--border); background: var(--bg); }
.tgh { padding: 4px 9px; background: var(--surface-2); color: var(--text-muted); font-size: var(--fs-2, 11px); position: sticky; top: 0; }
.tgi { display: flex; align-items: center; gap: 6px; padding: 3px 9px; cursor: pointer; }
.tgi:hover { background: var(--accent-ui-wash); }
.tgi.on { background: var(--accent-ui-weak); }
.tgi.hid { opacity: .45; }
.ic { width: 18px; height: 18px; flex: none; }
.ic2 { width: 40px; height: 40px; flex: none; }
.nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bd { flex: none; font-size: 9px; padding: 0 3px; border: 1px solid var(--border-strong); color: var(--text-faint); border-radius: 2px; }
.bd.mod { color: var(--accent-ui); border-color: var(--accent-ui); }
.bd.usr { color: var(--ok); border-color: var(--ok); }

.sledit { flex: 1; min-width: 0; overflow-y: auto; border: 1px solid var(--border); background: var(--bg); padding: 12px 16px; }
.sledit.empty { display: flex; align-items: center; justify-content: center; color: var(--text-faint); }
.ehd { display: flex; align-items: center; gap: 10px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
.ehn { flex: 1; min-width: 0; }
.ci.big { width: 100%; font-size: var(--fs-5); font-weight: 600; }
.eid { font-family: ui-monospace, monospace; font-size: var(--fs-2, 11px); color: var(--text-faint); margin-top: 2px; }
.grid2 { display: grid; grid-template-columns: 88px 1fr 88px 1fr; gap: 6px 10px; align-items: center; margin-top: 10px; }
.grid3 { display: grid; grid-template-columns: repeat(3, 108px 1fr 40px); gap: 5px 8px; align-items: center; margin-top: 6px; }
.grid2 > label, .grid3 > label { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.grid3 .u { color: var(--text-faint); font-size: var(--fs-2, 11px); }
.esec { display: flex; align-items: center; gap: 10px; margin-top: 16px; padding-top: 8px; border-top: 1px solid var(--border); color: var(--text-muted); }
.hintx { color: var(--text-faint); font-size: var(--fs-2, 11px); }
.ck { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; color: var(--text-faint); font-size: var(--fs-2, 11px); }
.ptbl { border: 1px solid var(--border); margin-top: 6px; }
.pth, .ptr { display: grid; grid-template-columns: 88px 1fr 1.5fr 74px 84px 24px; gap: 4px; align-items: center; padding: 3px 6px; }
.pth { background: var(--surface-2); color: var(--text-muted); font-size: var(--fs-2, 11px); }
.ptr { border-top: 1px solid var(--border); }
.del { cursor: pointer; color: var(--text-faint); text-align: center; }
.del:hover { color: var(--danger); }
.empty { color: var(--text-faint); padding: 8px; }
</style>
