<script setup>
// 「波束地图显示」侧栏：覆盖库（GXT / KML / JSON / 脚本导入）的波束 —— 卫星 → 批次 → 波束 + 电平表 + 显示选项。
// 状态与上图逻辑在 viz/beammap/useBeamMapDisplay.js（宿主页持有实例经 bm 传入），这里只有界面。
// 电平表 / 填充 / 等值线 / 显示选项的控件与「对地覆盖分析」（GrdSetSections.vue）同一套语汇与口径：
//   电平表列 = 显示 | 填充色 | 线色 | 值 | 名称 | 该档样式（线型 / 线宽 / 填充不透明度，留空跟批次）；
//   值是文件里的等值线电平（只读），名称可改（数值标签印名称，清空恢复数值）。
import { ref } from 'vue'
import Icon from './Icon.vue'
import { BM_SCHEMES } from '../viz/beammap/useBeamMapDisplay.js'
import { isSecOpen, toggleSec } from '../stores/panelSections'
import { covNav } from '../stores/coveragePanels'

const props = defineProps({
  bm: { type: Object, required: true }   // useBeamMapDisplay 活实例
})
const bm = props.bm
const LV_DASH = [['', '跟批次'], ['solid', '实线'], ['dash', '虚线'], ['dot', '点线'], ['dashdot', '点划线']]
const SCHEME_LABEL = { jet: 'Jet', turbo: 'Turbo', viridis: 'Viridis', inferno: 'Inferno', gray: 'Gray' }

// 当前展开样式编辑的档：批次 id + 档键
const styOpen = ref('')
const styKey = (ba, L) => ba.id + '|' + L.key
const toggleSty = (ba, L) => { styOpen.value = styOpen.value === styKey(ba, L) ? '' : styKey(ba, L) }
const hasSty = (L) => L.dash != null || L.width != null || L.fillAlpha != null
function lvNum(ba, L, f, raw, lo, hi) {
  const s = String(raw).trim()
  if (!s) { bm.setLevel(ba, L.key, { [f]: null }); return }
  const v = Number(s)
  if (Number.isFinite(v)) bm.setLevel(ba, L.key, { [f]: Math.max(lo, Math.min(hi, v)) })
}
function lvName(ba, L, e) { const v = String(e.target.value || '').trim(); if (v !== L.name) bm.setLevel(ba, L.key, { name: v || null }) }
function allOn(rows) { return rows.length > 0 && rows.every((r) => r.on) }
function anyOn(rows) { return rows.some((r) => r.on) }
const anyCustom = (rows, ba) => rows.some((r) => r.custom) || !!(ba.beamColors && Object.keys(ba.beamColors).length)
const fx = (v, d = 2) => Number(v).toFixed(d)
const nOr = (v, d) => (Number.isFinite(+v) ? +v : d)
// 按波束着色（选了「按波束」，或「自动」且批次里全是无数值的环）：电平表的色块不起作用，改在波束行上逐束取色
const byBeam = (it, ba) => bm.isBeamScheme(it, ba)
</script>

<template>
  <div class="cov-side bm-side docked">
    <div class="sec">
      <div class="sect" data-sec="gxt-sats"><span>覆盖卫星</span><button v-if="covNav.openFiles" type="button" class="lnk" title="在文件管理中导入 / 管理波束地图库（GXT / KML / JSON / GeoJSON / Shapefile / 可编程导入）" @click="covNav.openFiles('gxt')"><Icon name="folder-open" :size="12" /> 管理</button></div>
      <div class="srow"><label>添加卫星</label>
        <select class="cmd-sel" :value="bm.addSel.value" @change="(e) => bm.addSat(e.target.value)">
          <option value="" disabled>选择卫星…</option>
          <option v-for="s in bm.sats.value" :key="s.folder" :value="s.folder" :disabled="bm.items.value.some((i) => i.folder === s.folder)">{{ s.displayName }}{{ s.lon != null ? `（${s.lon}°）` : '' }}</option>
        </select>
      </div>
      <div v-if="!bm.items.value.length" class="empty">暂无卫星。</div>
    </div>

    <div v-for="it in bm.items.value" :key="it.id" class="sec satcard">
      <div class="sath">
        <span class="satn" data-i18n-skip>{{ bm.idxOf(it.folder)?.displayName }} <em v-if="bm.idxOf(it.folder)?.lon != null">{{ bm.idxOf(it.folder)?.lon }}°</em></span>
        <span role="radiogroup" class="seg sm">
          <button type="button" role="radio" :aria-checked="it.type === 'EIRP'" class="sg" :class="{ on: it.type === 'EIRP' }" @click="bm.setType(it, 'EIRP')">EIRP</button>
          <button type="button" role="radio" :aria-checked="it.type === 'GT'" class="sg" :class="{ on: it.type === 'GT' }" @click="bm.setType(it, 'GT')">G/T</button>
        </span>
        <button type="button" class="ibtn sm" title="定位" @click="bm.focus(it)"><Icon name="crosshair" :size="12" /></button>
        <button type="button" class="ibtn sm danger" title="移除该星" @click="bm.removeSat(it)"><Icon name="x" :size="12" /></button>
      </div>
      <div class="srow"><label>频段</label>
        <select :value="it.band" @change="(e) => bm.setBand(it, e.target.value)">
          <option value="all">全部频段</option>
          <option v-for="b in bm.itemBands(it)" :key="b" :value="b">{{ b || '—' }}</option>
        </select>
      </div>

      <div v-for="(ba, bi) in it.batches" :key="ba.id" class="batch">
        <div class="bah">
          <input class="bnm" :value="ba.name" :placeholder="'批次' + (bi + 1)" @input="(e) => { ba.name = e.target.value }" />
          <button type="button" class="ibtn sm danger" title="删除批次" @click="bm.removeBatch(it, ba)"><Icon name="x" :size="12" /></button>
        </div>

        <div class="bsub">波束
          <button type="button" class="lnk" @click="bm.allBeams(it, ba, !bm.allFilteredOn(it, ba))">{{ bm.allFilteredOn(it, ba) ? '取消' : '全选' }}</button>
          <button type="button" class="lnk" @click="bm.invertBeams(it, ba)">反选</button>
          <span class="cnt2">已选 {{ ba.beams.length }}</span>
        </div>
        <input class="ci bq search-field" :value="ba.q" placeholder="搜索：拉萨 / Beam 3，或序号 1-62、1,3,5" @input="(e) => { ba.q = e.target.value }" />
        <div class="list">
          <label v-for="r in bm.filteredRows(it, ba)" :key="r.id" class="chk" :title="r.tip || null">
            <input type="checkbox" :checked="ba.beams.includes(r.id)" @change="bm.toggleBeam(it, ba, r.id)" />
            <span class="bseq">{{ r.seq }}</span><span class="bl" data-i18n-skip>{{ r.label }}</span>
            <input v-if="byBeam(it, ba) && ba.beams.includes(r.id)" class="lvclr" type="color" title="该波束的颜色" :value="bm.beamColorOf(it, ba, r.id)" @click.stop @input="(e) => bm.setBeamColor(ba, r.id, e.target.value)" />
          </label>
          <div v-if="!bm.filteredRows(it, ba).length" class="empty">{{ bm.beamRowsOf(it).length ? '无匹配波束' : '该频段/类型无波束' }}</div>
        </div>

        <template v-if="ba.beams.length">
          <template v-for="rows in [bm.levelRows(it, ba)]" :key="'lv' + ba.id">
            <div class="bsub">电平<span class="cnt2">{{ rows.filter((r) => r.on).length }}/{{ rows.length }}</span></div>
            <div v-if="rows.length" class="glv">
              <div class="glvhd">
                <input type="checkbox" class="h-on" title="全部显示 / 全部隐藏" :checked="allOn(rows)" :indeterminate="anyOn(rows) && !allOn(rows)" @change="bm.setAllLevels(it, ba, !allOn(rows))" />
                <span class="h-clr">填充</span><span class="h-clr">线</span><span class="h-val">值</span><span class="h-nm">名称</span><span class="h-del"></span>
              </div>
              <template v-for="L in rows" :key="L.key">
                <div class="glvrow" :class="{ off: !L.on }">
                  <input type="checkbox" class="lvon" :checked="L.on" title="显示该档" @change="bm.setLevelOn(ba, L.key, !L.on)" />
                  <input class="lvclr" type="color" title="填充色" :value="L.color" :disabled="byBeam(it, ba)" @input="(e) => bm.setLevelColor(ba, L.key, e.target.value)" />
                  <input class="lvclr" type="color" title="线色" :value="L.lineColor" :disabled="byBeam(it, ba)" @input="(e) => bm.setLevelLine(ba, L.key, e.target.value)" />
                  <span class="lvval" data-i18n-skip>{{ L.text }}</span>
                  <input class="lvabs lvname" :class="{ named: !!L.name }" :value="L.name" :placeholder="L.key === 'none' ? '名称' : L.text"
                         title="自定义名称（数值标签用此名，清空恢复电平值）" @keydown.enter="(e) => e.target.blur()" @change="(e) => lvName(ba, L, e)" />
                  <button type="button" :aria-pressed="hasSty(L) ? 'true' : 'false'" class="ibtn sm" :class="{ on: hasSty(L) }" title="该档的线型 / 线宽 / 填充不透明度（留空＝跟批次）" @click="toggleSty(ba, L)"><Icon name="sliders-horizontal" :size="12" /></button>
                </div>
                <div v-if="styOpen === styKey(ba, L)" class="glvsty">
                  <div class="srow"><label>线型</label>
                    <select :value="L.dash || ''" @change="(e) => bm.setLevel(ba, L.key, { dash: e.target.value || null })"><option v-for="d in LV_DASH" :key="d[0]" :value="d[0]">{{ d[1] }}</option></select>
                  </div>
                  <div class="srow"><label>线宽</label><input class="ci" type="number" step="0.1" min="0.1" max="8" placeholder="跟批次" :value="L.width == null ? '' : L.width" @change="(e) => lvNum(ba, L, 'width', e.target.value, 0.1, 8)" /></div>
                  <div class="srow"><label>填充不透明度</label><input class="ci" type="number" step="0.05" min="0" max="1" placeholder="跟批次" :value="L.fillAlpha == null ? '' : L.fillAlpha" @change="(e) => lvNum(ba, L, 'fillAlpha', e.target.value, 0, 1)" /></div>
                </div>
              </template>
            </div>
            <div class="srow"><label>配色</label>
              <select :value="ba.scheme" @change="(e) => bm.setBatch(ba, { scheme: e.target.value })">
                <option value="auto">自动</option>
                <option v-for="n in BM_SCHEMES" :key="n" :value="n">{{ SCHEME_LABEL[n] }}</option>
                <option value="solid">纯色</option>
                <option value="beam">按波束</option>
              </select>
              <input v-if="ba.scheme === 'solid'" class="lvclr" type="color" title="颜色" :value="ba.solid" @input="(e) => bm.setBatch(ba, { solid: e.target.value })" />
            </div>
            <div v-if="anyCustom(rows, ba)" class="srow sub"><button type="button" class="lnk" title="清掉逐档 / 逐波束单独设过的颜色，回到配色方案" @click="bm.resetLevelColors(ba)">恢复方案配色</button></div>
          </template>

          <label class="chk2"><input type="checkbox" :checked="!!ba.fill" @change="bm.setBatch(ba, { fill: !ba.fill })" /><span>Fill Contours（分带填充）</span></label>
          <div v-if="ba.fill" class="srow sub"><label>不透明度</label><input class="rng" type="range" min="0" max="1" step="0.01" :value="nOr(ba.fillAlpha, 0.78)" @input="(e) => bm.setBatch(ba, { fillAlpha: Number(e.target.value) })" /><span class="u">{{ fx(nOr(ba.fillAlpha, 0.78)) }}</span></div>
          <label class="chk2"><input type="checkbox" :checked="ba.line !== false" @change="bm.setBatch(ba, { line: ba.line === false })" /><span>显示等值线</span></label>
          <template v-if="ba.line !== false">
            <div class="srow sub"><label>线宽</label><input class="rng" type="range" min="0.1" max="8" step="0.01" :value="nOr(ba.width, 1.6)" @input="(e) => bm.setBatch(ba, { width: Number(e.target.value) })" /><span class="u">{{ fx(nOr(ba.width, 1.6)) }}</span></div>
            <div class="srow sub"><label>线型</label>
              <select :value="ba.lineStyle || 'solid'" @change="(e) => bm.setBatch(ba, { lineStyle: e.target.value })"><option value="solid">实线</option><option value="dash">虚线</option><option value="dot">点线</option><option value="dashdot">点划线</option></select>
            </div>
            <div class="srow sub"><label>不透明度</label><input class="rng" type="range" min="0" max="1" step="0.01" :value="nOr(ba.lineAlpha, 1)" @input="(e) => bm.setBatch(ba, { lineAlpha: Number(e.target.value) })" /><span class="u">{{ fx(nOr(ba.lineAlpha, 1)) }}</span></div>
          </template>
        </template>
      </div>
      <button type="button" class="addbatch" @click="bm.addBatch(it)"><Icon name="plus" :size="12" /> 新建批次</button>
    </div>

    <div class="sec">
      <div class="sect acc" data-sec="gxt-disp" :class="{ open: isSecOpen('gxt-disp', false) }" role="button" tabindex="0" :aria-expanded="isSecOpen('gxt-disp', false) ? 'true' : 'false'"
           @click="toggleSec('gxt-disp', false)" @keydown.enter.self.prevent="toggleSec('gxt-disp', false)" @keydown.space.self.prevent="toggleSec('gxt-disp', false)">
        <Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('gxt-disp', false) }" :size="12" /><span>显示选项</span>
      </div>
      <template v-if="isSecOpen('gxt-disp', false)">
        <label class="chk2"><input type="checkbox" :checked="bm.disp.fontBold" @change="bm.setDisp({ fontBold: !bm.disp.fontBold })" /><span title="卫星名 / 波束名 / 中心电平 / 数值标签共用">标签粗体</span></label>
        <label class="chk2"><input type="checkbox" :checked="bm.disp.showSatName" @change="bm.setDisp({ showSatName: !bm.disp.showSatName })" /><span>显示卫星名</span></label>
        <label class="chk2"><input type="checkbox" :checked="bm.disp.showName" @change="bm.setDisp({ showName: !bm.disp.showName })" /><span>显示波束名</span><input v-if="bm.disp.showName" class="clr sw" type="color" :value="bm.disp.nameColor" title="波束名颜色" @input="(e) => bm.setDisp({ nameColor: e.target.value })" /></label>
        <div v-if="bm.disp.showName" class="srow sub"><label>字号</label><input class="rng" type="range" min="0.5" max="32" step="0.1" :value="bm.disp.nameSize" @input="(e) => bm.setDisp({ nameSize: Number(e.target.value) })" /><span class="u">{{ fx(bm.disp.nameSize, 1) }}</span></div>
        <label class="chk2"><input type="checkbox" :checked="bm.disp.showBore" @change="bm.setDisp({ showBore: !bm.disp.showBore })" /><span title="文件给出的波束中心（GXT [Bn]）；没有给出的波束不标">显示波束中心</span><input v-if="bm.disp.showBore" class="clr sw" type="color" :value="bm.disp.boreColor" title="波束中心十字颜色" @input="(e) => bm.setDisp({ boreColor: e.target.value })" /></label>
        <div v-if="bm.disp.showBore" class="srow sub"><label>大小</label><input class="rng" type="range" min="0.1" max="3" step="0.01" :value="bm.disp.boreSize" @input="(e) => bm.setDisp({ boreSize: Number(e.target.value) })" /><span class="u">{{ fx(bm.disp.boreSize) }}</span></div>
        <label class="chk2"><input type="checkbox" :checked="bm.disp.showPeak" @change="bm.setDisp({ showPeak: !bm.disp.showPeak })" /><span title="文件里波束中心带的电平（GXT [Bn] gain）">显示中心电平</span><input v-if="bm.disp.showPeak" class="clr sw" type="color" :value="bm.disp.peakColor" title="中心电平读数颜色" @input="(e) => bm.setDisp({ peakColor: e.target.value })" /></label>
        <div v-if="bm.disp.showPeak" class="srow sub"><label>字号</label><input class="rng" type="range" min="0.5" max="30" step="0.1" :value="bm.disp.peakSize" @input="(e) => bm.setDisp({ peakSize: Number(e.target.value) })" /><span class="u">{{ fx(bm.disp.peakSize, 1) }}</span></div>
        <label class="chk2"><input type="checkbox" :checked="bm.disp.showRay" @change="bm.setDisp({ showRay: !bm.disp.showRay })" /><span title="卫星到波束中心的连线（3D）">显示波束视轴</span><input v-if="bm.disp.showRay" class="clr sw" type="color" :value="bm.disp.rayColor" title="视轴颜色" @input="(e) => bm.setDisp({ rayColor: e.target.value })" /></label>
        <template v-if="bm.disp.showRay">
          <div class="srow sub"><label>线宽</label><input class="rng" type="range" min="0.1" max="6" step="0.01" :value="bm.disp.rayWidth" @input="(e) => bm.setDisp({ rayWidth: Number(e.target.value) })" /><span class="u">{{ fx(bm.disp.rayWidth) }}</span></div>
          <div class="srow sub"><label>不透明度</label><input class="rng" type="range" min="0.05" max="1" step="0.01" :value="bm.disp.rayOpacity" @input="(e) => bm.setDisp({ rayOpacity: Number(e.target.value) })" /><span class="u">{{ fx(bm.disp.rayOpacity) }}</span></div>
        </template>
        <label class="chk2"><input type="checkbox" :checked="bm.disp.showVal" @change="bm.setDisp({ showVal: !bm.disp.showVal })" /><span>显示数值标签</span><input v-if="bm.disp.showVal" class="clr sw" type="color" :value="bm.disp.valColor" title="数值标签颜色" @input="(e) => bm.setDisp({ valColor: e.target.value })" /></label>
        <template v-if="bm.disp.showVal">
          <div class="srow sub"><label>字号</label><input class="rng" type="range" min="0.5" max="30" step="0.1" :value="bm.disp.valSize" @input="(e) => bm.setDisp({ valSize: Number(e.target.value) })" /><span class="u">{{ fx(bm.disp.valSize, 1) }}</span></div>
          <div class="srow sub"><label>标签</label><select :value="bm.disp.labelMode" @change="(e) => bm.setDisp({ labelMode: e.target.value })"><option value="single">单个</option><option value="interval">沿线间隔</option></select></div>
          <div v-if="bm.disp.labelMode === 'interval'" class="srow sub"><label>间隔</label><input class="ci" type="number" step="1" min="2" max="200" :value="bm.disp.labelGap" title="两个标签之间隔几个标签宽" @change="(e) => bm.setDisp({ labelGap: Math.max(2, Math.min(200, Number(e.target.value) || 35)) })" /></div>
          <label class="chk2 sub"><input type="checkbox" :checked="bm.disp.labelWithName" @change="bm.setDisp({ labelWithName: !bm.disp.labelWithName })" /><span title="该档起过名时，标签印「值 名称」">值 + 名称</span></label>
        </template>
      </template>
    </div>

    <div class="csfoot">
      <span v-if="bm.status.value" class="cst">{{ bm.status.value }}</span>
      <button type="button" class="cclr btn" @click="bm.clearDrawing()">清除绘制</button>
    </div>
  </div>
</template>

<style scoped>
:where(button).lnk, :where(button).addbatch { margin: 0; padding: 0; border: 0; background: none; color: inherit; text-align: inherit; }
/* 与宿主页（ConstellationMap3D.vue）与 GrdSetSections.vue 的同名规则逐条同源：本组件自带一份（scoped 进不来）。改动请对照 */
.cov-side { display: flex; flex-direction: column; font-size: var(--fs-3); background: var(--surface); }
.cov-side.docked { width: auto; border-left: 0; overflow: visible; }
.sec { padding: 12px 16px; border-bottom: 1px solid var(--border); }
.sec > * + * { margin-top: 8px; }
.sec > * + .sect { margin-top: 12px; }
.sec > .sect + * { margin-top: 6px; }
.srow { --srow-lab: 70px; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.srow label { color: var(--text-muted); min-width: var(--srow-lab); max-width: 100%; flex: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.srow.sub { --srow-lab: 51px; padding-left: 19px; }
.srow select, .srow .ci { flex: 1; min-width: 0; border: 1px solid var(--field-border); background-color: var(--field-bg); padding: 0 7px; font-size: var(--fs-3); outline: none; color: var(--text); }
.srow select { min-width: 116px; }
.srow .u { flex: none; min-width: 34px; text-align: right; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.rng { flex: 1; min-width: 0; }
.sect { display: flex; align-items: center; color: var(--text); }
.sect .lnk { margin-left: auto; display: inline-flex; align-items: center; gap: 3px; color: var(--text-muted); cursor: pointer; font-size: var(--fs-3); transition: color var(--dur-1) linear; }
.sect .lnk:hover { color: var(--text); text-decoration: underline; text-underline-offset: 2px; }
.sect .lnk .app-icon { color: inherit; }
.sect.acc { cursor: pointer; user-select: none; gap: 5px; margin-inline: -6px; padding: 3px 6px; border-radius: var(--r-box); transition: background-color var(--dur-1) linear; }
.sect.acc .app-icon { flex: none; color: var(--text-faint); }
.sect.acc:hover { background: color-mix(in srgb, var(--text) 5%, transparent); }
.sect.acc:active { background: color-mix(in srgb, var(--text) 9%, transparent); transition-duration: 0s; }
.sect.acc:hover > .app-icon.disc { color: var(--text-muted); }
.sec > .sect.acc:first-child { margin-top: -3px; }
.sec > .sect.acc:last-child { margin-bottom: -3px; }
.chk2 { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.chk2.sub { padding-left: 19px; }
.chk2:hover > input[type=checkbox]:not(:checked):not(:disabled) { border-color: var(--field-border-hover); }
.chk2:hover > input[type=checkbox]:checked:not(:disabled) { background: var(--accent-fill-hover); border-color: var(--accent-fill-hover); }
.chk2 > .clr.sw { margin-left: auto; }
.clr { height: 22px; }
.empty { color: var(--text-faint); padding: 4px 0; }
/* 卫星卡 / 批次 */
.satcard { border-left: 2px solid var(--accent); }
.sath { display: flex; align-items: center; gap: 6px; }
.satn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.satn em { color: var(--text-muted); font-style: normal; font-weight: 400; font-size: var(--fs-2); }
.batch { border: 1px solid var(--border); border-radius: var(--r-ctl); padding: 7px 8px; }
.batch > * + * { margin-top: 6px; }
.bah { display: flex; align-items: center; gap: 6px; }
.bnm { flex: 1; min-width: 0; border: 1px solid var(--field-border); background: var(--field-bg); padding: 2px 6px; font-size: var(--fs-3); color: var(--text); outline: none; }
.bnm:focus { border-color: var(--accent-ui); }
.bsub { display: flex; align-items: center; gap: 8px; color: var(--text-muted); font-size: var(--fs-3); }
.bsub .lnk, .srow > .lnk { color: var(--text-muted); cursor: pointer; font-size: var(--fs-3); transition: color var(--dur-1) linear; }
.bsub .lnk:hover, .srow > .lnk:hover { color: var(--text); text-decoration: underline; text-underline-offset: 2px; }
.bsub .lnk ~ .lnk, .bsub .lnk ~ .cnt2 { margin-left: 12px; }
.bsub .cnt2 { margin-left: auto; color: var(--text-faint); font-size: var(--fs-2); font-variant-numeric: tabular-nums; }
.bq { display: block; width: 100%; box-sizing: border-box; border: 1px solid var(--field-border); background: var(--field-bg); padding: 3px 6px; font-size: var(--fs-3); color: var(--text); outline: none; }
.bq:focus { border-color: var(--accent-ui); }
.list { max-height: 180px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--r-ctl); padding: 4px 6px; resize: vertical; }
.chk { display: flex; align-items: center; gap: 6px; padding: 2px 0; cursor: pointer; }
.chk .bseq { flex: none; min-width: 20px; text-align: right; color: var(--text-faint); font-family: var(--font-mono); font-size: var(--fs-2); }
.chk .bl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chk .lvclr { flex: none; width: 20px; height: 16px; }
.addbatch { display: block; width: 100%; text-align: center; border: 1px dashed var(--border); padding: 4px; color: var(--accent); cursor: pointer; font-size: var(--fs-3); }
.addbatch:hover { border-color: var(--line-hover); background: var(--surface); }
/* 电平表（与 GrdSetSections 的 .glv 同列宽语汇；首列多一个显示勾选） */
.glv { border: 1px solid var(--border); border-radius: var(--r-ctl); }
.glvhd { display: flex; align-items: center; gap: 5px; padding: 4px 6px 3px; border-bottom: 1px solid var(--border); color: var(--text-faint); font-size: var(--fs-1); white-space: nowrap; }
.glvhd > span { overflow: hidden; }
.glvhd .h-on { flex: none; margin: 0; }
.glvhd .h-clr { flex: none; width: 20px; }
.glvhd .h-val { flex: none; width: 58px; padding-left: 4px; }
.glvhd .h-nm { flex: 1; min-width: 0; padding-left: 6px; }
.glvhd .h-del { flex: none; width: 20px; }
.glvrow { display: flex; align-items: center; gap: 5px; padding: 3px 6px; }
.glvrow + .glvrow, .glvsty + .glvrow { border-top: 1px solid var(--border); }
.glvrow .lvon { flex: none; margin: 0; }
.glvrow .lvclr { width: 20px; height: 18px; flex: none; }
.glvrow .lvval { width: 58px; flex: none; padding: 2px 4px; color: var(--text); font-family: var(--font-mono); font-size: var(--fs-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.glvrow .lvabs { flex: 1; color: var(--text-faint); font-family: var(--font-mono); font-size: var(--fs-2); }
.glvrow .lvname { min-width: 0; border: 1px solid transparent; background: transparent; padding: 2px 5px; border-radius: var(--r-ctl); outline: none; }
.glvrow .lvname:hover { border-color: var(--field-border-hover); }
.glvrow .lvname:focus { border-color: var(--accent-ui); background: var(--field-bg); color: var(--text); }
.glvrow .lvname.named { color: var(--text); }
.glvrow .ibtn { margin: -2px 0; }
.glvrow.off .lvval, .glvrow.off .lvname { color: var(--text-faint); text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--text-faint) 60%, transparent); }
.glvrow.off .lvclr { opacity: .45; }
.glvsty { padding: 4px 6px 6px 22px; border-top: 1px solid var(--border); }
.glvsty > * + * { margin-top: 4px; }
.glvsty .srow label { min-width: 72px; }
.csfoot { margin-top: auto; display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--border); }
.sec + .csfoot { border-top: 0; }
.cst { font-size: var(--fs-2); color: var(--text-faint); }
.cclr { margin-left: auto; }
</style>
