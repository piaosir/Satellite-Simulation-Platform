<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { quality, effective, setTier, setField, setMapLevel, currentMapLevelIndex, TIERS, FIELD_OPTS, MAP_LEVELS } from '../stores/displayQuality'
import { viewPrefs } from '../stores/viewPrefs'
import { theme, setTheme } from '../stores/theme'
import { uiFont, setUiFont, availableFonts } from '../stores/uiFont'
import { getLang, setLang } from '../shared/i18n/runtime'
import Icon from './Icon.vue'

// 外观：跟随系统 / 浅色 / 深色
const THEME_OPTS = [
  { key: 'system', label: '跟随系统', icon: 'monitor' },
  { key: 'light', label: '浅色', icon: 'sun' },
  { key: 'dark', label: '深色', icon: 'moon' }
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

// Esc 关窗（捕获阶段先收，不漏给下面的画布 / 菜单）；输入法组字中的 Esc 是取消组字，不关。
// 打开即把焦点落在「完成」上：回车 = 完成，与系统对话框同手感。
const okBtn = ref(null)
function onKey(e) { if (e.key === 'Escape' && !e.isComposing) { e.stopPropagation(); emit('close') } }
onMounted(() => {
  window.addEventListener('keydown', onKey, true)
  okBtn.value?.focus({ preventScroll: true })
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dlg" role="dialog" aria-modal="true">
      <header class="dhd">
        <span class="dt">设置</span>
        <button class="winx" type="button" aria-label="关闭" title="关闭" @click="emit('close')"><Icon name="x" :size="12" /></button>
      </header>

      <div class="body">
        <!-- 外观 -->
        <section class="sec">
          <div class="shd" data-sec="set-look">外观</div>
          <div class="tiers">
            <button v-for="t in THEME_OPTS" :key="t.key" class="tier ttheme" :class="{ on: theme.mode === t.key }" @click="setTheme(t.key)">
              <Icon :name="t.icon" :size="12" />{{ t.label }}
            </button>
          </div>
        </section>

        <!-- 语言 -->
        <section class="sec">
          <div class="shd" data-sec="set-lang">语言</div>
          <div class="tiers" data-i18n-skip>
            <button v-for="l in LANG_OPTS" :key="l.key" class="tier" :class="{ on: langCur === l.key }" @click="pickLang(l.key)">{{ l.label }}</button>
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
          <div class="shd" data-sec="set-quality">显示设置</div>
          <div class="tiers">
            <button v-for="t in TIERS" :key="t.key" class="tier" :class="{ on: quality.tier === t.key }" @click="setTier(t.key)">{{ t.label }}</button>
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
              <div class="tiers seg">
                <button v-for="f in FRAME_OPTS" :key="f.key" class="tier" :class="{ on: viewPrefs.frame === f.key }" @click="viewPrefs.frame = f.key">{{ f.label }}</button>
              </div>
            </div>
            <label class="frow">
              <span class="fn" title="拖动的粘滞感：0% 直连，越大越重、停得越柔；地面不会滑过光标">拖拽阻尼<em>{{ viewPrefs.dragDamping }}%</em></span>
              <input type="range" min="0" max="100" step="5" v-model.number="viewPrefs.dragDamping" />
            </label>
            <label class="frow">
              <span class="fn" title="每滚一格，底部状态栏的缩放读数走多少个百分点">3D 滚轮缩放<em>{{ viewPrefs.wheelStep3d }}%</em></span>
              <input type="range" min="1" max="20" step="1" v-model.number="viewPrefs.wheelStep3d" />
            </label>
            <label class="frow">
              <span class="fn" title="每滚一格，底部状态栏的缩放读数走多少个百分点">2D 滚轮缩放<em>{{ viewPrefs.wheelStep2d }}%</em></span>
              <input type="range" min="1" max="20" step="1" v-model.number="viewPrefs.wheelStep2d" />
            </label>
          </div>
        </section>
      </div>

      <footer class="dft">
        <button class="ghost" @click="setTier('high')">恢复默认（高）</button>
        <button ref="okBtn" class="ok" @click="emit('close')">完成</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* 遮罩瞬时出现（压在逐帧重绘的画布上，不做淡入）；只有框体 160ms 升入，出场瞬时 */
.mask { position: fixed; inset: 0; z-index: 2000; background: var(--scrim); display: flex; align-items: center; justify-content: center; }
.dlg { width: 560px; max-width: calc(100vw - 32px); max-height: calc(100vh - 64px); display: flex; flex-direction: column;
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-card); box-shadow: var(--shadow-3);
  animation: ui-dlg-in var(--dur-3) var(--ease-out); }
.dhd { display: flex; align-items: stretch; justify-content: space-between; border-bottom: 1px solid var(--border); }
.dt { font-family: var(--font-serif); font-size: var(--fs-5); padding: 12px 16px; align-self: center; }
/* 关闭按钮：与「文件管理」一致——Windows 风矩形热区，悬停变红。
   右上内圆角 = 框体圆角 − 1px 描边：红色悬停块贴合圆角，不戳出方角 */
.winx { width: 44px; align-self: stretch; border: 0; background: transparent; color: var(--text-muted); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: var(--t-state);
  border-top-right-radius: calc(var(--r-card) - 1px); }
.winx:hover { background: #c42b1c; color: #fff; }
/* 右内距 6 + 常驻滚动槽 10 = 16：有无滚动条控件右缘都与页脚「完成」齐 */
.body { padding: 14px 6px 14px 16px; overflow: auto; scrollbar-gutter: stable; }
.sec { margin-bottom: 16px; }
.sec:last-child { margin-bottom: 0; }
.shd { font-size: var(--fs-2); letter-spacing: var(--ls-label); color: var(--text-faint); padding-bottom: 4px; margin-bottom: 8px; border-bottom: 1px solid var(--border); }
.tiers { display: flex; gap: 6px; flex-wrap: wrap; }
.tier { flex: 1; min-width: 64px; padding: 7px 0; cursor: pointer; font-size: var(--fs-4); color: var(--text-muted);
  background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-box); transition: var(--t-state); }
.tier.ttheme { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.tier:hover { color: var(--text); border-color: var(--line-hover); }
/* 选中档填墨（走 token：深色下压一档，不再是整块近白）；进入选中瞬时 */
.tier.on { color: var(--sel-on); background: var(--sel-fill); border-color: var(--sel-fill); font-weight: 600; transition-duration: 0s; }
.tiers + .grid { margin-top: 14px; }
.grid { display: flex; flex-direction: column; gap: 11px; }
.frow { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.fn { font-size: var(--fs-4); color: var(--text); display: flex; flex-direction: column; }
.fn em { font-style: normal; font-size: var(--fs-2); color: var(--text-faint); margin-top: 2px; }
.frow select { border: 1px solid var(--field-border); background-color: var(--field-bg); color: var(--text); padding: 5px 8px; outline: none; }
/* 右侧控件列统一 176px：下拉、滑块、行内两段式左缘落在同一根竖线上 */
.frow select, .frow select.fsel { width: 176px; min-width: 0; }
.frow input[type=range] { width: 176px; }
/* 行内两段式（参考系）：宽度跟着内容走，下限 176px 与右侧那一栏齐；
   英文「Camera Follows」一枚就要 114px，钉死宽度会裁字。grid + 1fr 让两枚等宽并取较宽那个的宽度。*/
.frow .tiers.seg { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 6px; flex: none; width: auto; min-width: 176px; }
/* 行内段与同列下拉等高（--h-ctl），不再比邻行控件高出一截 */
.frow .tiers.seg .tier { min-width: 72px; height: var(--h-ctl); padding: 0 10px; white-space: nowrap; }
/* 行高保持旧段高（≈28.7px），下方滑块行不上移 */
.frow:has(> .tiers.seg) { min-height: 29px; }
.dft { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 12px 16px; border-top: 1px solid var(--border); }
.dft button { height: var(--h-ctl-lg); white-space: nowrap; padding: 0 16px; cursor: pointer; border-radius: var(--r-box); font-size: var(--fs-4); }
/* 次要钮：纸底 + 结构描边 + 正文字；主钮：墨色实底（走 token，深色压一档）。按下由全局按下罩提供 */
.gh, .ghost { background: var(--bg); border: 1px solid var(--border-strong); color: var(--text); }
.gh:hover:not(:disabled), .ghost:hover:not(:disabled) { border-color: var(--line-hover); }
.gh:disabled { opacity: 1; color: var(--text-faint); background: var(--field-disabled-bg); border-color: var(--border); cursor: default; }
.ok { background: var(--primary-fill); border: 1px solid var(--primary-fill); color: var(--primary-on); font-weight: 600; }
.ok:hover:not(:disabled) { background: var(--primary-fill-hover); border-color: var(--primary-fill-hover); }
.ok:disabled { opacity: 1; background: var(--primary-fill-disabled); border-color: transparent; color: var(--primary-on); cursor: default; }
</style>
