<script setup>
// 「微信小程序」介绍弹窗（主窗口 帮助 菜单，与「关于」平级）。
//
// 平台与小程序是同一套引擎的两端：桌面端出方案，手机端随身查、外场对星。
// 四条投递通道（链路配置 / 频率计划 / 覆盖快照 / 卫星组）分散在四处入口，这里是唯一把它们
// 摆在一起的地方 —— 否则用户只会碰到自己恰好点开的那一条。
//
// 引导方式：微信没有能从桌面浏览器直接拉起小程序的 URL，长期有效的入口只有【小程序码】
// （URL Scheme / URL Link 最长 30 天）。小程序码在 微信公众平台 → 设置 → 基本设置 →
// 「小程序码及线下物料下载」取得，放到 src/assets/linklab-wxacode.png 即显示；文件不在时
// 这一块整体不出现（import.meta.glob 不报编译错），只留「搜一搜」文字入口 + 复制名称。
//
// 视觉沿用 MiniBindDialog（同一套 mask / dlg / dhd / dft）。
import { ref } from 'vue'
import Icon from './Icon.vue'
import AppDialog from './AppDialog.vue'
import avatarUrl from '../assets/linklab-miniapp-mark.png'
import { TTL_DAYS } from '../shared/miniPack.js'
import { MINI_NAME } from '../shared/appLinks.js'

const emit = defineEmits(['close', 'bind'])

const codes = import.meta.glob('../assets/linklab-wxacode.{png,jpg,svg}', { eager: true, import: 'default' })
const wxaCodeUrl = Object.values(codes)[0] || ''

// 手机端功能（与小程序「使用帮助 · 软件概述」对齐）
const FEATURES = [
  ['链路预算', 'GSO / NGSO 全链路预算，DVB 与 3GPP NTN 体制，功放反算与功带平衡'],
  ['现场对星', 'AR 对星、方位仰角、日凌预报'],
  ['可视化', '卫星覆盖图、星座地图、星间链路、转发器频率计划'],
  ['配置与报告', '配置云端保存与分享，Word / Excel / PDF 报告，中英双语']
]

// 平台 → 小程序：内容 / 平台入口 / 小程序落点
const CHANNELS = [
  ['链路预算配置', '工作台「分享」', '我的配置'],
  ['转发器频率计划', '频率计划窗口 / 文件管理', '工具栏 · 频率计划'],
  ['覆盖等值线与协调区', '「导出」菜单', '卫星覆盖'],
  ['卫星组与星座', '卫星组面板', '星座地图']
]

const copied = ref(false)
async function copyName() {
  try { await navigator.clipboard.writeText(MINI_NAME); copied.value = true; setTimeout(() => { copied.value = false }, 1200) } catch (e) { /* 无剪贴板权限 */ }
}

// 外壳是 AppDialog（Esc / 关闭钮关、打开即聚焦「关闭」、点遮罩不关）
</script>

<template>
  <AppDialog :width="580" flush initial-focus=".mabt-ok" @close="emit('close')">
      <template #title><span class="dt"><Icon name="wechat" :size="16" />微信小程序</span></template>
      <div class="body">
        <!-- 名片：头像 + 名称 + 定位 + 打开方式；右侧小程序码（有图才出） -->
        <div class="idcard">
          <img class="ava" :src="avatarUrl" alt="" draggable="false" />
          <div class="idtx">
            <div class="nm">{{ MINI_NAME }}</div>
            <div class="sub">卫星链路预算与现场对星工具，与本平台共用同一套计算引擎</div>
            <div class="open">
              <span class="how">微信「搜一搜」搜索小程序名</span>
              <button class="cp" :title="copied ? '已复制' : '复制小程序名'" @click="copyName">
                <Icon :name="copied ? 'check' : 'copy'" :size="12" />{{ copied ? '已复制' : '复制名称' }}
              </button>
            </div>
          </div>
          <figure v-if="wxaCodeUrl" class="qr">
            <img :src="wxaCodeUrl" alt="" draggable="false" />
            <figcaption>微信扫码打开</figcaption>
          </figure>
        </div>

        <section>
          <div class="sec">手机端功能</div>
          <div class="kv">
            <template v-for="(f, i) in FEATURES" :key="i">
              <div class="k">{{ f[0] }}</div>
              <div class="v">{{ f[1] }}</div>
            </template>
          </div>
        </section>

        <section>
          <div class="sec">从本平台发送</div>
          <!-- 三列：内容 / 平台入口 / 小程序落点。落点列右对齐共用一根轴 -->
          <div class="kv ch">
            <div class="k hd">内容</div><div class="v hd">平台入口</div><div class="dest hd">小程序落点</div>
            <template v-for="(c, i) in CHANNELS" :key="i">
              <div class="k">{{ c[0] }}</div>
              <div class="v">{{ c[1] }}</div>
              <div class="dest">{{ c[2] }}</div>
            </template>
            <div class="k">投递方式</div>
            <div class="v wide">绑定账号后免密钥直投，打开小程序即同步；未绑定则生成 8 位密钥，{{ TTL_DAYS }} 天内有效</div>
          </div>
        </section>
      </div>

      <template #footer>
        <button class="btn" @click="emit('bind')">绑定小程序账号…</button>
        <button class="btn primary mabt-ok" @click="emit('close')">关闭</button>
      </template>
  </AppDialog>
</template>

<style scoped>
/* 与 MiniBindDialog / SettingsModal 同一套视觉语言 */
/* 外壳归 AppDialog；题条里图标 + 字（字体 / 字号跟 AppDialog 题条） */
.dt { display: inline-flex; align-items: center; gap: 8px; }
.body { padding: 16px; display: flex; flex-direction: column; gap: 16px; }

/* 名片：头像 + 名称 + 一句话 + 打开方式 */
.idcard { display: flex; align-items: center; gap: 14px; padding-bottom: 14px; border-bottom: 1px solid var(--border); }
/* 小程序真身头像：不随主题反相 —— 品牌标识按其本来面目呈现（同微信图标固定绿的口径）。
   原图背景与「L」笔画都是镂空的，深色主题下直接放会连球体带笔画一起糊掉，故必须垫一层固定白底；
   墨迹恰好居中且不出内切圆（实测圆形裁切 0 损失），圆片与微信里的头像呈现一致。
   垫底走 token：浅色 = 纸白；深色取正文灰 #dbdbdb —— 纯白 56px 圆片在深色面板上是全屏最亮的块。 */
.ava { width: 56px; height: 56px; flex: none; align-self: flex-start; background: var(--bg); border-radius: 50%; user-select: none; -webkit-user-drag: none; }
:root[data-theme="dark"] .ava { background: var(--text); }
.idtx { min-width: 0; flex: 1; }
.nm { font-family: var(--font-serif); font-size: var(--fs-5); letter-spacing: var(--ls-tight); color: var(--text); }
.sub { margin-top: 3px; font-size: var(--fs-3); line-height: 1.5; color: var(--text-muted); }
.open { margin-top: 8px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.how { font-size: var(--fs-3); color: var(--text-faint); }
.cp { display: inline-flex; align-items: center; gap: 4px; height: var(--h-ctl-sm); white-space: nowrap; padding: 0 7px; font-size: var(--fs-2); cursor: pointer;
  color: var(--text-muted); background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-ctl); }
.cp:hover { color: var(--text); border-color: var(--line-hover); }
/* 小程序码：品牌图，白底不反相；96px 足够手机扫 */
.qr { flex: none; margin: 0; display: flex; flex-direction: column; align-items: center; gap: 4px; }
.qr img { width: 96px; height: 96px; background: #fff; border: 1px solid var(--border); border-radius: var(--r-ctl); user-select: none; -webkit-user-drag: none; }
.qr figcaption { font-size: var(--fs-2); color: var(--text-faint); }

.sec { font-size: var(--fs-2); letter-spacing: var(--ls-label); color: var(--text-faint); padding-bottom: 5px; margin-bottom: 8px; border-bottom: 1px solid var(--border); }
/* 术语 + 说明：两节共用同一根 128px 栏名轴（够宽以容下「覆盖等值线与协调区」不折行） */
.kv { display: grid; grid-template-columns: 128px 1fr; column-gap: 12px; row-gap: 7px; }
.ch { grid-template-columns: 128px 1fr auto; }
.k { font-size: var(--fs-3); color: var(--text); }
.v { font-size: var(--fs-3); line-height: 1.6; color: var(--text-muted); }
.dest { font-size: var(--fs-2); line-height: 1.6; color: var(--text-faint); text-align: right; white-space: nowrap; }
.hd { font-size: var(--fs-2); color: var(--text-faint); }
.wide { grid-column: 2 / -1; }
</style>
