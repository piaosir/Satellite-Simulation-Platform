<script setup>
import { computed, ref } from 'vue'
import { quality, effective, setTier, setField, setMapLevel, currentMapLevelIndex, TIERS, FIELD_OPTS, MAP_LEVELS } from '../stores/displayQuality'
import { viewPrefs } from '../stores/viewPrefs'
import { theme, setTheme } from '../stores/theme'
import { uiFont, setUiFont, availableFonts } from '../stores/uiFont'
import { getLang, setLang } from '../shared/i18n/runtime'
import Icon from './Icon.vue'
import AppDialog from './AppDialog.vue'

// 外观：跟随系统 / 专业浅色 / 专业深色 = 剪辑软件口径（中性灰阶 + 面板块留缝 + 蓝色选中，global.css [data-skin="studio"]）。
// 10-14 起原暖灰深色由专业深色替换（键仍是 'dark'），原「浅色」档删除（旧存档读作专业浅色，见 stores/theme.js）；出厂跟随系统
const THEME_OPTS = [
  { key: 'system', label: '跟随系统', icon: 'monitor' },
  { key: 'studio-light', label: '专业浅色', icon: 'sun' },
  { key: 'dark', label: '专业深色', icon: 'moon' }
]

// 语言：界面语言，跨窗口即时生效；选项名保持各自语言的本名，不随界面翻译
const LANG_OPTS = [
  { key: 'zh', label: '中文' },
  { key: 'en', label: 'English' }
]
const langCur = ref(getLang())
function pickLang(k) { setLang(k); langCur.value = k }

// 界面字体：西文面 / 中文面各一档，合成 --font-ui 后主窗口与各独立窗口一起换（stores/uiFont.js）。
// 列表先过一遍可用性检测 —— 没装的面列出来选了也不生效。字体名不进翻译词典，按当前语言取本名。
const fontOpts = availableFonts()
const fontLabel = (f) => (langCur.value === 'en' && f.en ? f.en : f.label)

const emit = defineEmits(['close'])

const eff = effective   // 当前生效值（预设或自定义）

const optsOf = (k) => FIELD_OPTS[k] || []
const onPick = (k, e) => setField(k, Number(e.target.value))
// 底图精细化：单下拉映射 MAP_LEVELS（粗→细）。当前序号据生效值反查。
const mapLevelIdx = computed(() => currentMapLevelIndex(eff.value))
const onPickMapLevel = (e) => { const l = MAP_LEVELS[Number(e.target.value)]; if (l) setMapLevel(l.detail, l.thin) }

const msaaOn = computed(() => eff.value.msaa !== false)
function toggleMsaa() { setField('msaa', !msaaOn.value) }

// 参考系两档：惯性视角（相机固定在惯性空间，地球随仿真时钟东转）/ 相机跟随（相机随地球一起转）
const FRAME_OPTS = [
  { key: 'inertial', label: '惯性视角' },
  { key: 'fixed', label: '相机跟随' }
]

// 外壳是 AppDialog（Esc / 关闭钮关、焦点落在「关闭」上、Tab 在框内循环）
</script>

<template>
  <AppDialog title="设置" :width="560" flush initial-focus=".set-ok" @close="emit('close')">
      <div class="body">
        <!-- 外观 -->
        <section class="sec">
          <div class="shd" data-sec="set-look">外观</div>
          <div class="seg set-seg" role="radiogroup" aria-label="外观">
            <button v-for="t in THEME_OPTS" :key="t.key" type="button" class="sg" role="radio" :aria-checked="theme.mode === t.key" :class="{ on: theme.mode === t.key }" @click="setTheme(t.key)">
              <Icon :name="t.icon" :size="12" />{{ t.label }}
            </button>
          </div>
        </section>

        <!-- 语言 -->
        <section class="sec">
          <div class="shd" data-sec="set-lang">语言</div>
          <div class="seg set-seg" role="radiogroup" aria-label="语言" data-i18n-skip>
            <button v-for="l in LANG_OPTS" :key="l.key" type="button" class="sg" role="radio" :aria-checked="langCur === l.key" :class="{ on: langCur === l.key }" @click="pickLang(l.key)">{{ l.label }}</button>
          </div>
        </section>

        <!-- 界面字体 -->
        <section class="sec">
          <div class="shd" data-sec="set-font">界面字体</div>
          <div class="grid">
            <label class="frow">
              <span class="fn">西文</span>
              <select class="fsel" data-i18n-skip :value="uiFont.latin" @change="setUiFont($event.target.value, null)">
                <option v-for="f in fontOpts.latin" :key="f.key" :value="f.key" :style="{ fontFamily: f.stack }">{{ fontLabel(f) }}</option>
              </select>
            </label>
            <label class="frow">
              <span class="fn">中文</span>
              <select class="fsel" data-i18n-skip :value="uiFont.cjk" @change="setUiFont(null, $event.target.value)">
                <option v-for="f in fontOpts.cjk" :key="f.key" :value="f.key" :style="{ fontFamily: f.stack }">{{ fontLabel(f) }}</option>
              </select>
            </label>
          </div>
        </section>

        <!-- 显示设置 -->
        <section class="sec">
          <div class="shd" data-sec="set-quality"><span>显示设置</span><button type="button" class="ibtn sm" title="恢复本节默认（高）" aria-label="恢复本节默认" @click="setTier('high')"><Icon name="rotate-ccw" :size="12" /></button></div>
          <div class="seg set-seg" role="radiogroup" aria-label="显示档位">
            <button v-for="t in TIERS" :key="t.key" type="button" class="sg" role="radio" :aria-checked="quality.tier === t.key" :class="{ on: quality.tier === t.key }" @click="setTier(t.key)">{{ t.label }}</button>
          </div>

          <div class="grid">
            <label class="frow">
              <span class="fn" title="超采样倍率，对性能影响最大">渲染分辨率</span>
              <select :value="eff.pixelRatio" @change="onPick('pixelRatio', $event)">
                <option v-for="o in optsOf('pixelRatio')" :key="o.label" :value="o.v">{{ o.label }}</option>
              </select>
            </label>
            <label class="frow">
              <span class="fn">底图精细化</span>
              <select :value="mapLevelIdx" @change="onPickMapLevel">
                <option v-for="(l, i) in MAP_LEVELS" :key="i" :value="i">{{ l.label }}</option>
              </select>
            </label>
            <label class="frow">
              <span class="fn">覆盖网格</span>
              <select :value="eff.gridStride" @change="onPick('gridStride', $event)">
                <option v-for="o in optsOf('gridStride')" :key="o.label" :value="o.v">{{ o.label }}</option>
              </select>
            </label>
            <label class="frow">
              <span class="fn" title="帧率上限越低越省电">渲染帧率</span>
              <select :value="eff.fps" @change="onPick('fps', $event)">
                <option v-for="o in optsOf('fps')" :key="o.label" :value="o.v">{{ o.label }}</option>
              </select>
            </label>
            <label class="frow">
              <span class="fn" title="地球网格精度">球体细分</span>
              <select :value="eff.sphereSeg" @change="onPick('sphereSeg', $event)">
                <option v-for="o in optsOf('sphereSeg')" :key="o.label" :value="o.v">{{ o.label }}</option>
              </select>
            </label>
            <div class="frow">
              <span class="fn">MSAA 抗锯齿</span>
              <button type="button" class="layersw lg" :class="{ on: msaaOn }" role="switch" :aria-checked="msaaOn ? 'true' : 'false'" :aria-label="'MSAA 抗锯齿'" @click="toggleMsaa"><i></i></button>
            </div>
          </div>
        </section>

        <!-- 基础设置 -->
        <section class="sec">
          <div class="shd" data-sec="set-basic">基础设置</div>
          <div class="grid">
            <div class="frow">
              <span class="fn" title="惯性视角：相机固定在惯性空间，地球随仿真时钟东转；相机跟随：相机随地球一起转，地面不动">地球自转</span>
              <div class="seg set-seg inl" role="radiogroup" aria-label="地球自转">
                <button v-for="f in FRAME_OPTS" :key="f.key" type="button" class="sg" role="radio" :aria-checked="viewPrefs.frame === f.key" :class="{ on: viewPrefs.frame === f.key }" @click="viewPrefs.frame = f.key">{{ f.label }}</button>
              </div>
            </div>
            <label class="frow">
              <span class="fn" title="拖动的粘滞感：0% 直连，越大越重、停得越柔；地面不会滑过光标">拖拽阻尼</span>
              <span class="frng"><input type="range" min="0" max="100" step="1" v-model.number="viewPrefs.dragDamping" /><span>{{ viewPrefs.dragDamping }}%</span></span>
            </label>
            <label class="frow">
              <span class="fn" title="每滚一格，底部状态栏的缩放读数走多少个百分点">3D 滚轮缩放</span>
              <span class="frng"><input type="range" min="1" max="20" step="0.1" v-model.number="viewPrefs.wheelStep3d" /><span>{{ Number(viewPrefs.wheelStep3d).toFixed(1) }}%</span></span>
            </label>
            <label class="frow">
              <span class="fn" title="每滚一格，底部状态栏的缩放读数走多少个百分点">2D 滚轮缩放</span>
              <span class="frng"><input type="range" min="1" max="20" step="0.1" v-model.number="viewPrefs.wheelStep2d" /><span>{{ Number(viewPrefs.wheelStep2d).toFixed(1) }}%</span></span>
            </label>
          </div>
        </section>
      </div>

      <template #footer>
        <button type="button" class="btn primary set-ok" @click="emit('close')">关闭</button>
      </template>
  </AppDialog>
</template>

<style scoped>
/* 外壳（遮罩 / 框体 / 题条 / 关闭钮 / 页脚）是 AppDialog；分段是 controls.css 的分段本体 */
/* 右内距 6 + 常驻滚动槽 10 = 16：有无滚动条控件右缘都与页脚「完成」齐 */
.body { padding: 14px 6px 14px 16px; overflow: auto; scrollbar-gutter: stable; }
.sec { margin-bottom: 16px; }
.sec:last-child { margin-bottom: 0; }
.shd { display: flex; align-items: center; justify-content: space-between; min-height: 20px; font-size: var(--fs-2); letter-spacing: var(--ls-label); color: var(--text-faint); padding-bottom: 4px; margin-bottom: 8px; border-bottom: 1px solid var(--border); }
/* 整行分段：各段等分整行（外观 / 语言 / 显示档位）；行内分段（地球自转）跟右侧控件列齐 */
.set-seg > .sg { flex: 1 1 0; gap: 6px; }
.set-seg + .grid { margin-top: 14px; }
.set-seg.inl { flex: none; min-width: 176px; }
.set-seg.inl > .sg { white-space: nowrap; padding: 2px 10px; }
.grid { display: flex; flex-direction: column; gap: 11px; }
.frow { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.fn { font-size: var(--fs-4); color: var(--text); display: flex; flex-direction: column; }
.frow select { border: 1px solid var(--field-border); background-color: var(--field-bg); color: var(--text); padding: 5px 8px; outline: none; }
/* 右侧控件列统一 176px：下拉、滑块、行内两段式左缘落在同一根竖线上 */
.frow select, .frow select.fsel { width: 176px; min-width: 0; }
.frow input[type=range] { width: 176px; }
/* 滑杆 + 数值框合占右侧那一栏 176px：滑杆让出读数的宽度，左右两缘仍与下拉框对齐 */
.frng { display: flex; align-items: center; gap: 8px; flex: none; width: 176px; font-size: var(--fs-3); }
.frng input[type=range] { flex: 1; width: auto; min-width: 0; }
</style>
