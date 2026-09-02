<script setup>
// 应用场景仿真 · 侧栏面板：模块库 → 场景树 → 检查器 → 结果，四段一屏。
//
// 数据直接读 viz/scene/sceneStore.js（模块级单例），不经 props —— 拓扑视图与地图渲染读的是
// 同一份，「两种可视化是同一个场景的两个投影」这条约束在数据层就成立。
import { ref, computed, onMounted, watch } from 'vue'
import Icon from './Icon.vue'
import SceneInspect from './SceneInspect.vue'
import {
  scene, loadLibrary, applyTemplate, newScene, addModule, removeModule, addLink, removeLink,
  addFlow, removeFlow, compute, effective, modById, libById, mediaLabel, tierOf, placeOf,
  portsCompatible, snapshot, loadScene
} from '../viz/scene/sceneStore.js'
import { drawSymbol } from '../viz/scene/sceneSymbols.js'
import { exportSceneReport } from '../shared/sceneReport.js'
import { mediaOf } from '../viz/scene/sceneStore.js'

const emit = defineEmits(['focus-module'])

const open = ref({ lib: true, mods: true, links: false, flows: true, res: true })
const toggle = (k) => { open.value[k] = !open.value[k] }
const kw = ref('')
const catFilter = ref('')
const tplOpen = ref(false)
const tplInd = ref('')

onMounted(() => loadLibrary())

// ── 模块库树（按分类 → 分组）──
const filtered = computed(() => {
  const q = kw.value.trim().toLowerCase()
  return scene.lib.filter((m) => {
    if (m.hidden) return false
    if (catFilter.value && m.cat !== catFilter.value) return false
    if (!q) return true
    return [m.zh, m.en, m.id, (m.tags || []).join(' ')].filter(Boolean).join(' ').toLowerCase().includes(q)
  })
})
const grouped = computed(() => {
  const g = new Map()
  const gl = (scene.catalog && scene.catalog.groups) || {}
  for (const m of filtered.value) {
    const k = m.cat + '/' + m.group
    if (!g.has(k)) g.set(k, { key: k, cat: m.cat, zh: gl[m.group] || m.group, items: [] })
    g.get(k).items.push(m)
  }
  return [...g.values()].sort((a, b) => a.cat.localeCompare(b.cat))
})
const cats = computed(() => (scene.catalog && scene.catalog.modCats) || [])

// 库条目的小图标（16px canvas，符号与地图/拓扑同一支画笔）。
// 传的是【模块条目】不是图标名 —— 逐条映射与徽标都在 drawSymbol 里解析（sceneSymbolMap.js）。
function iconRef(el, mod) {
  if (!el) return
  const n = 32
  el.width = n; el.height = n
  const ctx = el.getContext('2d')
  ctx.clearRect(0, 0, n, n)
  const ink = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#000'
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#fff'
  drawSymbol(ctx, mod, n / 2, n / 2, n * 0.96, ink, 0, bg)
}

// ── 放置 ──
function pick(libId) {
  scene.placing = scene.placing === libId ? null : libId
  scene.sel = null
}
const placingName = computed(() => (scene.placing ? (libById.value.get(scene.placing) || {}).zh : ''))

// ── 场景树 ──
const modRows = computed(() => scene.modules.map((m) => {
  const e = effective(m)
  return { m, e, sym: e, cat: e ? e.cat : '', host: m.place && m.place.mode === 'mounted' ? (modById.value.get(m.place.hostId) || {}).name : '' }
}))
const selMod = computed(() => (scene.sel && scene.sel.type === 'module' ? modById.value.get(scene.sel.id) : null))
function selectMod(id) { scene.sel = { type: 'module', id }; scene.placing = null }
function selectLink(id) { scene.sel = { type: 'link', id }; scene.placing = null }
function selectFlow(id) { scene.sel = { type: 'flow', id }; scene.placing = null }

// ── 连线 ──
const linkStep = ref(null)   // { fromMod, fromPort } | null
const portMenu = ref(null)   // { modId, side:'from'|'to', ports:[] }
function beginLink(modId) {
  const e = effective(modById.value.get(modId)); if (!e) return
  portMenu.value = { modId, side: 'from', ports: (e.ports || []).filter((p) => p.role !== 'power') }
}
function choosePort(p) {
  const pm = portMenu.value; if (!pm) return
  if (pm.side === 'from') { linkStep.value = { fromMod: pm.modId, fromPort: p.key }; portMenu.value = null; scene.linking = { modId: pm.modId, portKey: p.key } }
  else {
    const r = addLink(linkStep.value.fromMod, linkStep.value.fromPort, pm.modId, p.key)
    if (!r.ok) linkErr.value = r.reason
    else { linkErr.value = ''; scene.sel = { type: 'link', id: r.link.id }; open.value.links = true }
    portMenu.value = null; linkStep.value = null; scene.linking = null
  }
}
const linkErr = ref('')
function targetMod(modId) {
  if (!linkStep.value) { selectMod(modId); return }
  if (modId === linkStep.value.fromMod) { cancelLink(); return }
  const e = effective(modById.value.get(modId)); if (!e) return
  const from = effective(modById.value.get(linkStep.value.fromMod))
  const fp = (from.ports || []).find((p) => p.key === linkStep.value.fromPort)
  const ok = (e.ports || []).filter((p) => portsCompatible(fp, p).ok)
  if (!ok.length) { linkErr.value = `「${e.name}」上没有能接 ${fp.zh || fp.key} 的端口`; cancelLink(); return }
  portMenu.value = { modId, side: 'to', ports: ok }
}
function cancelLink() { linkStep.value = null; portMenu.value = null; scene.linking = null }

// ── 业务流 ──
const flowRows = computed(() => scene.flows.map((f) => ({
  f, a: (modById.value.get(f.aId) || {}).name || '?', b: (modById.value.get(f.bId) || {}).name || '?',
  r: scene.result ? (scene.result.flows || []).find((x) => x.id === f.id) : null
})))
const canAddFlow = computed(() => scene.modules.length >= 2)
function newFlow() {
  const ids = scene.modules.map((m) => m.id)
  addFlow(ids[0], ids[ids.length - 1])
  open.value.flows = true
}

// ── 模板 ──
const tplList = computed(() => scene.templates.filter((t) => !tplInd.value || t.industry === tplInd.value))
async function useTpl(id) { await applyTemplate(id); tplOpen.value = false; await compute() }

// ── 存档 ──
const cfgName = ref('')
async function saveCfg() {
  const api = typeof window !== 'undefined' ? window.api : null
  if (!api || !api.store) return
  // preload 的签名是 saveConfig(ns, cfg) 两个参数，不是一个对象
  const cfg = { id: scene.id || undefined, name: cfgName.value || scene.name, state: snapshot() }
  const r = await api.store.saveConfig('scene', cfg)
  if (r && r.id) scene.id = r.id
  saveTip.value = '已保存'
  setTimeout(() => { saveTip.value = '' }, 1600)
}
const saveTip = ref('')

// ── 方案报告（Excel 三线表，与链路预算报告同款版式）──
const rpBusy = ref('')
async function report() {
  if (!scene.result) { rpBusy.value = '先算一次'; setTimeout(() => { rpBusy.value = '' }, 1600); return }
  rpBusy.value = '导出中'
  try {
    const r = await exportSceneReport({
      scene, result: scene.result, effective, mediaOf, tierOf
    })
    rpBusy.value = (r && r.ok) ? '已导出' : ((r && (r.canceled ? '' : r.error)) || '导出失败')
  } catch (e) { rpBusy.value = e.message } finally { setTimeout(() => { rpBusy.value = '' }, 2200) }
}

const fmtRate = (b) => (b == null ? '—' : b >= 1e6 ? (b / 1e6).toFixed(2) + ' Mbps' : b >= 1e3 ? (b / 1e3).toFixed(1) + ' kbps' : b + ' bps')
</script>

<template>
  <div class="cov-side sc-side docked">

    <!-- ═══ 工具条 ═══ -->
    <div class="sec sc-top">
      <div class="srow"><label>场景</label><input class="ci" v-model="scene.name" placeholder="场景名称" /></div>
      <div class="scbar">
        <button class="sb" @click="newScene()"><Icon name="plus" :size="12" /> 新建</button>
        <button class="sb" :class="{ on: tplOpen }" @click="tplOpen = !tplOpen"><Icon name="layers" :size="12" /> 模板</button>
        <button class="sb" @click="saveCfg"><Icon name="save" :size="12" /> 保存</button>
        <button class="sb" :disabled="!scene.result" title="导出方案报告（Excel · 三线表）" @click="report"><Icon name="file-down" :size="12" /> 报告</button>
        <button class="sb pri" :disabled="scene.busy" @click="compute()">
          <Icon name="play" :size="12" /> {{ scene.busy ? '计算中' : '计算' }}
        </button>
      </div>
      <div v-if="tplOpen" class="tpl">
        <div class="tplf">
          <span class="tg" :class="{ on: !tplInd }" @click="tplInd = ''">全部</span>
          <span v-for="i in scene.industries" :key="i" class="tg" :class="{ on: tplInd === i }" @click="tplInd = i">{{ i }}</span>
        </div>
        <div v-for="t in tplList" :key="t.id" class="tpli" @click="useTpl(t.id)">
          <b>{{ t.zh }}</b><em>{{ t.hint }}</em>
        </div>
      </div>
      <div class="scstat">
        <span>{{ scene.modules.length }} 模块 · {{ scene.links.length }} 边 · {{ scene.flows.length }} 流</span>
        <span v-if="rpBusy" class="okc">{{ rpBusy }}</span>
        <span v-else-if="saveTip" class="okc">{{ saveTip }}</span>
        <span v-else-if="scene.error" class="errc">{{ scene.error }}</span>
        <span v-else-if="scene.busy">…</span>
        <span v-else-if="scene.result && !scene.dirty">{{ scene.ms }} ms</span>
        <span v-else-if="scene.result && scene.dirty" class="warnc">输入已变</span>
      </div>
      <div class="scbar">
        <span class="seg2" role="group" aria-label="视图">
          <span :class="{ on: scene.view === 'map' }" @click="scene.view = 'map'">地图</span>
          <span :class="{ on: scene.view === 'topo' }" @click="scene.view = 'topo'">拓扑</span>
        </span>
      </div>
      <div class="scbar">
        <button type="button" class="layersw" :class="{ on: scene.showLayer }" role="switch" :aria-checked="scene.showLayer ? 'true' : 'false'" title="显示 / 隐藏场景层" @click="scene.showLayer = !scene.showLayer"><i></i></button>
        <label class="chk2"><input type="checkbox" v-model="scene.labels" /><span>名称</span></label>
        <label class="chk2"><input type="checkbox" v-model="scene.showLinks" /><span>连线</span></label>
        <span class="lnk" :class="{ on: scene.editPos }" :title="scene.editPos ? '完成，退出拖动' : '解锁鼠标拖动：在图上直接拖模块改坐标'" @click="scene.editPos = !scene.editPos">{{ scene.editPos ? '完成调整' : '调整位置' }}</span>
      </div>
    </div>

    <!-- ═══ 模块库 ═══ -->
    <div class="sec">
      <div class="sect acc" :class="{ open: open.lib }" @click="toggle('lib')">
        <Icon :name="open.lib ? 'chevron-down' : 'chevron-right'" :size="12" /><span>模块库</span>
        <span class="lnk">{{ filtered.length }}</span>
      </div>
      <template v-if="open.lib">
        <div class="srow"><input class="ci" v-model="kw" placeholder="搜模块 / 型号 / 行业" /></div>
        <div class="tplf">
          <span class="tg" :class="{ on: !catFilter }" @click="catFilter = ''">全部</span>
          <span v-for="c in cats" :key="c.key" class="tg" :class="{ on: catFilter === c.key }" :title="c.hint" @click="catFilter = c.key">{{ c.zh }}</span>
        </div>
        <div v-if="scene.libError" class="errc">{{ scene.libError }}</div>
        <div v-if="scene.placing" class="hintbar">点地图落点放置「{{ placingName }}」<span class="x" @click="scene.placing = null"><Icon name="x" :size="11" /></span></div>
        <div class="libl">
          <template v-for="g in grouped" :key="g.key">
            <div class="lgh">{{ g.zh }}</div>
            <div v-for="m in g.items" :key="m.id" class="lgi" :class="{ on: scene.placing === m.id }" :title="m.src" @click="pick(m.id)">
              <canvas class="lic" :ref="(el) => iconRef(el, m)"></canvas>
              <span class="lnm">{{ m.zh }}</span>
              <span v-if="m.typical" class="tpc" title="电平类数值为该类设备典型值，非该型号实测">典</span>
              <span v-if="m.modified" class="tpc mod" title="已改过出厂值">改</span>
            </div>
          </template>
        </div>
      </template>
    </div>

    <!-- ═══ 场景 · 模块 ═══ -->
    <div class="sec">
      <div class="sect acc" :class="{ open: open.mods }" @click="toggle('mods')">
        <Icon :name="open.mods ? 'chevron-down' : 'chevron-right'" :size="12" /><span>模块</span>
        <span class="lnk">{{ scene.modules.length }}</span>
      </div>
      <template v-if="open.mods">
        <div v-if="!scene.modules.length" class="empty">还没有模块。</div>
        <div v-if="linkStep" class="hintbar">选目标模块连线<span class="x" @click="cancelLink"><Icon name="x" :size="11" /></span></div>
        <div v-if="linkErr" class="errc">{{ linkErr }}</div>
        <div class="mlist">
          <div v-for="r in modRows" :key="r.m.id" class="mrow2" :class="{ on: scene.sel && scene.sel.id === r.m.id, tgt: !!linkStep }"
               @click="linkStep ? targetMod(r.m.id) : selectMod(r.m.id)">
            <canvas class="lic" :ref="(el) => iconRef(el, r.sym)"></canvas>
            <span class="mnm">{{ r.m.name }}<em v-if="r.host">@{{ r.host }}</em></span>
            <span class="mac" title="从这个模块拉一条连线" @click.stop="beginLink(r.m.id)"><Icon name="chain-hops" :size="11" /></span>
            <span class="mac" title="在图上定位" @click.stop="emit('focus-module', r.m.id)"><Icon name="crosshair" :size="11" /></span>
            <span class="del" @click.stop="removeModule(r.m.id)"><Icon name="x" :size="12" /></span>
          </div>
        </div>
      </template>
    </div>

    <!-- ═══ 场景 · 连线 ═══ -->
    <div class="sec">
      <div class="sect acc" :class="{ open: open.links }" @click="toggle('links')">
        <Icon :name="open.links ? 'chevron-down' : 'chevron-right'" :size="12" /><span>连线</span>
        <span class="lnk">{{ scene.links.length }}</span>
      </div>
      <template v-if="open.links">
        <div v-if="!scene.links.length" class="empty">还没有连线。</div>
        <div class="mlist">
          <div v-for="l in scene.links" :key="l.id" class="mrow2" :class="{ on: scene.sel && scene.sel.id === l.id }" @click="selectLink(l.id)">
            <span class="tier" :class="tierOf(l.medium)"></span>
            <span class="mnm">{{ (modById.get(l.a.modId) || {}).name }} → {{ (modById.get(l.b.modId) || {}).name }}<em>{{ mediaLabel(l.medium) }}</em></span>
            <span v-if="l.role === 'backup'" class="tpc" title="备份链路：与主路并联，合成可用度走「至少一条在」">备</span>
            <span class="del" @click.stop="removeLink(l.id)"><Icon name="x" :size="12" /></span>
          </div>
        </div>
      </template>
    </div>

    <!-- ═══ 业务流 ═══ -->
    <div class="sec">
      <div class="sect acc" :class="{ open: open.flows }" @click="toggle('flows')">
        <Icon :name="open.flows ? 'chevron-down' : 'chevron-right'" :size="12" /><span>业务流</span>
        <span v-if="canAddFlow" class="lnk" @click.stop="newFlow">新建</span>
      </div>
      <template v-if="open.flows">
        <div v-if="!scene.flows.length" class="empty">还没有业务流。</div>
        <div class="mlist">
          <div v-for="r in flowRows" :key="r.f.id" class="frow" :class="{ on: scene.sel && scene.sel.id === r.f.id }" @click="selectFlow(r.f.id)">
            <div class="fhd">
              <span class="fnm">{{ r.f.name }}</span>
              <span class="fdir" :title="r.f.dir === 'bidir' ? '双向：两个方向各自成链' : '单向'">{{ r.f.dir === 'bidir' ? '⇄' : '→' }}</span>
              <span class="del" @click.stop="removeFlow(r.f.id)"><Icon name="x" :size="12" /></span>
            </div>
            <div class="fsub">{{ r.a }} {{ r.f.dir === 'ba' ? '←' : (r.f.dir === 'ab' ? '→' : '⇄') }} {{ r.b }}</div>
            <div v-if="r.r" class="fnum">
              <span :class="{ neg: r.r.summary.marginDb != null && r.r.summary.marginDb < 0 }">
                {{ r.r.summary.marginDb == null ? '—' : r.r.summary.marginDb.toFixed(2) + ' dB' }}
              </span>
              <span>{{ r.r.summary.availPct == null ? '—' : r.r.summary.availPct.toFixed(3) + '%' }}</span>
              <span>{{ r.r.summary.rttMs != null ? r.r.summary.rttMs.toFixed(0) + ' ms' : (r.r.summary.latencyMs != null ? r.r.summary.latencyMs.toFixed(0) + ' ms' : '—') }}</span>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- ═══ 检查器 + 结果 ═══ -->
    <SceneInspect />

    <!-- 端口选择浮层 -->
    <div v-if="portMenu" class="pmask" @click="portMenu = null">
      <div class="pmenu" @click.stop>
        <div class="pmh">{{ portMenu.side === 'from' ? '从哪个端口出' : '接到哪个端口' }}</div>
        <div v-for="p in portMenu.ports" :key="p.key" class="pmi" @click="choosePort(p)">
          <span class="pmn">{{ p.zh || p.key }}</span>
          <span class="pmm">{{ mediaLabel(p.medium) }}</span>
          <span class="pmd">{{ p.dir === 'tx' ? '发' : p.dir === 'rx' ? '收' : '收发' }}</span>
        </div>
        <div v-if="!portMenu.ports.length" class="empty">没有可用端口。</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 侧栏外壳：与 SatCovPanel.vue / ConstellationMap3D.vue 的 .cov-side 一套同值副本
   （那两份是 scoped 的、进不到本组件）。改动请三处对照。 */
.cov-side { width: 286px; flex: none; border-left: 1px solid var(--border-strong); background: var(--surface); overflow-y: auto; display: flex; flex-direction: column; font-size: var(--fs-3); }
.cov-side.docked { width: auto; border-left: 0; overflow: visible; }
.sec { padding: 12px 16px; border-bottom: 1px solid var(--border); }
.sec > * + * { margin-top: 8px; }
.sec > * + .sect { margin-top: 12px; }
.sec > .sect + * { margin-top: 6px; }
.srow { --srow-lab: 70px; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.srow label { color: var(--text-muted); min-width: var(--srow-lab); max-width: 100%; flex: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.srow .ci { flex: 1; min-width: 0; border: 1px solid var(--field-border); background-color: var(--field-bg); padding: 3px 6px; font-size: var(--fs-3); outline: none; color: var(--text); }
.sect { display: flex; align-items: center; color: var(--text-muted); }
.sect.acc { cursor: pointer; user-select: none; gap: 5px; }
.sect.acc:hover { color: var(--text); }
.sect .lnk { margin-left: auto; color: var(--accent); cursor: pointer; font-size: var(--fs-3); }
.sect .lnk:hover { text-decoration: underline; }

/* ── 工具条 ── */
.scbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sb { display: inline-flex; align-items: center; gap: 4px; height: var(--ctl-h, 24px); padding: 0 8px; border: 1px solid var(--field-border); background: var(--bg); color: var(--text); font-size: var(--fs-3); cursor: pointer; border-radius: var(--r-1, 2px); }
.sb:hover { border-color: var(--field-border-hover); }
.sb.on, .sb.pri { background: var(--accent-ui); border-color: var(--accent-ui); color: var(--bg); }
.sb:disabled { opacity: .55; cursor: default; }
.scstat { display: flex; gap: 10px; align-items: center; color: var(--text-faint); font-size: var(--fs-2, 11px); font-variant-numeric: tabular-nums; }
.okc { color: var(--ok); } .errc { color: var(--danger); font-size: var(--fs-2, 11px); } .warnc { color: var(--warn); }
.lnk.on { font-weight: 600; }
.seg2 { display: inline-flex; border: 1px solid var(--field-border); border-radius: var(--r-1, 2px); overflow: hidden; }
.seg2 > span { padding: 2px 11px; cursor: pointer; color: var(--text-muted); user-select: none; }
.seg2 > span + span { border-left: 1px solid var(--field-border); }
.seg2 > span.on { background: var(--accent-ui); color: var(--bg); }

/* ── 模板 ── */
.tpl { border: 1px solid var(--border); background: var(--bg); max-height: 260px; overflow-y: auto; }
.tplf { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px; }
.tg { padding: 1px 7px; border: 1px solid var(--border); color: var(--text-muted); cursor: pointer; font-size: var(--fs-2, 11px); border-radius: var(--r-pill, 9px); }
.tg.on { background: var(--accent-ui); border-color: var(--accent-ui); color: var(--bg); }
.tpli { padding: 6px 9px; border-top: 1px solid var(--border); cursor: pointer; }
.tpli:hover { background: var(--accent-ui-wash); }
.tpli b { display: block; font-weight: 600; }
.tpli em { display: block; font-style: normal; color: var(--text-faint); font-size: var(--fs-2, 11px); margin-top: 2px; line-height: 1.45; }

/* ── 库列表 ── */
.libl { max-height: 300px; overflow-y: auto; border: 1px solid var(--border); background: var(--bg); }
.lgh { padding: 4px 8px; background: var(--surface-2); color: var(--text-muted); font-size: var(--fs-2, 11px); position: sticky; top: 0; }
.lgi { display: flex; align-items: center; gap: 6px; padding: 3px 8px; cursor: pointer; }
.lgi:hover { background: var(--accent-ui-wash); }
.lgi.on { background: var(--accent-ui-weak); }
.lic { width: 16px; height: 16px; flex: none; }
.lnm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tpc { flex: none; font-size: 9px; padding: 0 3px; border: 1px solid var(--border-strong); color: var(--text-faint); border-radius: 2px; }
.tpc.mod { color: var(--accent-ui); border-color: var(--accent-ui); }

/* ── 场景列表 ── */
.mlist { max-height: 240px; overflow-y: auto; }
.mrow2 { display: flex; align-items: center; gap: 6px; padding: 3px 4px; cursor: pointer; border-bottom: 1px solid var(--border); }
.mrow2:hover { background: var(--accent-ui-wash); }
.mrow2.on { background: var(--accent-ui-weak); }
.mrow2.tgt { outline: 1px dashed var(--accent-ui); outline-offset: -2px; }
.mnm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mnm em { font-style: normal; color: var(--text-faint); margin-left: 5px; font-size: var(--fs-2, 11px); }
.mac, .del { flex: none; color: var(--text-faint); cursor: pointer; padding: 1px; }
.mac:hover, .del:hover { color: var(--text); }
.tier { width: 3px; align-self: stretch; flex: none; background: var(--border-strong); }
.tier.satellite { background: var(--accent-ui); }
.tier.contract { background: var(--warn); }
.tier.power { background: var(--text); }
.tier.supply { background: var(--text-faint); }
.empty { color: var(--text-faint); }
.hintbar { display: flex; align-items: center; gap: 6px; padding: 3px 7px; background: var(--accent-ui-weak); color: var(--text); font-size: var(--fs-2, 11px); }
.hintbar .x { margin-left: auto; cursor: pointer; }

/* ── 业务流 ── */
.frow { padding: 5px 4px; border-bottom: 1px solid var(--border); cursor: pointer; }
.frow:hover { background: var(--accent-ui-wash); }
.frow.on { background: var(--accent-ui-weak); }
.fhd { display: flex; align-items: center; gap: 6px; }
.fnm { flex: 1; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fdir { color: var(--accent-ui); font-size: 13px; }
.fsub { color: var(--text-faint); font-size: var(--fs-2, 11px); margin-top: 1px; }
.fnum { display: flex; gap: 12px; margin-top: 3px; font-variant-numeric: tabular-nums; font-size: var(--fs-2, 11px); color: var(--text-muted); }
.fnum .neg { color: var(--danger); }

/* ── 端口浮层 ── */
.pmask { position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,.18); display: flex; align-items: center; justify-content: center; }
.pmenu { background: var(--bg); border: 1px solid var(--border-strong); box-shadow: var(--shadow-3, 0 8px 24px rgba(0,0,0,.2)); min-width: 240px; max-height: 60vh; overflow-y: auto; }
.pmh { padding: 7px 10px; background: var(--surface); border-bottom: 1px solid var(--border); color: var(--text-muted); }
.pmi { display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer; border-bottom: 1px solid var(--border); }
.pmi:hover { background: var(--accent-ui-wash); }
.pmn { flex: 1; }
.pmm { color: var(--text-faint); font-size: var(--fs-2, 11px); }
.pmd { color: var(--text-muted); font-size: var(--fs-2, 11px); min-width: 24px; text-align: right; }
</style>
