<script setup>
// 「微信小程序 LinkLab」介绍弹窗（主窗口 帮助 菜单，与「关于」平级）。
//
// 平台与小程序是同一套引擎的两端：桌面端出方案，手机端随身查、外场对星。
// 三条投递通道（覆盖快照 / 链路配置 / 频率计划）分散在三处入口，这里是唯一把它们
// 摆在一起说清楚的地方 —— 否则用户只会碰到自己恰好点开的那一条。
//
// 视觉沿用 MiniBindDialog（同一套 mask / dlg / dhd / dft）。
import Icon from './Icon.vue'
import avatarUrl from '../assets/linklab-miniapp-mark.png'
import { TTL_DAYS } from '../shared/miniPack.js'

const emit = defineEmits(['close', 'bind'])

// 手机端功能（与小程序内「使用帮助 · 软件概述」逐条对齐）
const FEATURES = [
  ['链路预算', 'GSO / NGSO 全链路预算；反算功放、正向反推余量、一键功带平衡'],
  ['现场对星', 'AR 对星 · 方位仰角 · 日凌预报'],
  ['可视化', '卫星覆盖图 · 星间链路 · 三维星座地图 · 转发器频率计划'],
  ['配置与报告', '配置管理 / 历史记录；中英双语、普通 / 专业版，Word / Excel / PDF 导出']
]

// 平台 → 小程序的三条通道及其入口
const CHANNELS = [
  ['覆盖等值线 + 协调区', '导出 → 发送到小程序', '小程序「卫星覆盖」'],
  ['链路预算配置', '三个工作台 → 分享 → 发送到小程序', '小程序「我的配置」'],
  ['转发器频率计划', '文件管理 / 频率计划窗口 → 发送到小程序', '小程序「工具栏 · 频率计划」']
]
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dlg" role="dialog" aria-modal="true">
      <header class="dhd">
        <span class="dt"><Icon name="wechat" :size="16" />微信小程序</span>
        <span class="x" @click="emit('close')"><Icon name="x" :size="16" /></span>
      </header>

      <div class="body">
        <div class="idcard">
          <img class="ava" :src="avatarUrl" alt="LinkLab" draggable="false" />
          <div class="idtx">
            <div class="nm">LinkLab星链链路计算</div>
            <div class="sub">地球同步轨道卫星链路预算工具</div>
            <div class="find">微信「搜一搜」搜索小程序名即可打开，免安装、免登录</div>
          </div>
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
          <div class="sec">与本平台联动</div>
          <!-- 三列：内容 / 平台入口 / 小程序落点。落点列右对齐共用一根轴，三行的收尾不参差 -->
          <div class="kv ch">
            <template v-for="(c, i) in CHANNELS" :key="i">
              <div class="k">{{ c[0] }}</div>
              <div class="v">{{ c[1] }}</div>
              <div class="dest">{{ c[2] }}</div>
            </template>
            <div class="k">投递方式</div>
            <div class="v wide">绑定账号后免密钥直投、接收方打开即同步；未绑定则生成 8 位一次性密钥，有效期 {{ TTL_DAYS }} 天</div>
          </div>
        </section>
      </div>

      <footer class="dft">
        <button class="gh" @click="emit('bind')">绑定小程序账号…</button>
        <button class="ok" @click="emit('close')">完成</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* 与 MiniBindDialog / SettingsModal 同一套视觉语言 */
.mask { position: fixed; inset: 0; z-index: 2000; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; }
.dlg { width: 580px; max-width: calc(100vw - 32px); max-height: calc(100vh - 64px); display: flex; flex-direction: column;
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-card); box-shadow: var(--shadow-3); }
.dhd { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.dt { display: inline-flex; align-items: center; gap: 8px; font-family: var(--font-serif); font-size: var(--fs-5); }
.x { cursor: pointer; color: var(--text-muted); padding: 2px 6px; display: inline-flex; align-items: center; }
.x:hover { color: var(--text); }
.body { padding: 16px; overflow: auto; display: flex; flex-direction: column; gap: 16px; }

/* 名片：头像 + 名称 + 一句话 */
.idcard { display: flex; align-items: center; gap: 14px; padding-bottom: 14px; border-bottom: 1px solid var(--border); }
/* 小程序真身头像：不随主题反相 —— 品牌标识按其本来面目呈现（同微信图标固定绿的口径）。
   原图背景与「L」笔画都是镂空的，深色主题下直接放会连球体带笔画一起糊掉，故必须垫一层固定白底；
   墨迹恰好居中且不出内切圆（实测圆形裁切 0 损失），圆片与微信里的头像呈现一致。 */
.ava { width: 56px; height: 56px; flex: none; background: #fff; border-radius: 50%; user-select: none; -webkit-user-drag: none; }
.idtx { min-width: 0; }
.nm { font-family: var(--font-serif); font-size: var(--fs-5); letter-spacing: var(--ls-tight); color: var(--text); }
.sub { margin-top: 3px; font-size: var(--fs-3); color: var(--text-muted); }
.find { margin-top: 5px; font-size: var(--fs-3); color: var(--text-faint); }

.sec { font-size: var(--fs-2); letter-spacing: var(--ls-label); color: var(--text-faint); padding-bottom: 5px; margin-bottom: 8px; border-bottom: 1px solid var(--border); }
/* 术语 + 说明：两节共用同一根 128px 栏名轴（够宽以容下「覆盖等值线 + 协调区」不折行） */
.kv { display: grid; grid-template-columns: 128px 1fr; column-gap: 12px; row-gap: 7px; }
.ch { grid-template-columns: 128px 1fr auto; }
.k { font-size: var(--fs-3); color: var(--text); }
.v { font-size: var(--fs-3); line-height: 1.6; color: var(--text-muted); }
.dest { font-size: var(--fs-2); line-height: 1.6; color: var(--text-faint); text-align: right; white-space: nowrap; }
.wide { grid-column: 2 / -1; }

.dft { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 12px 16px; border-top: 1px solid var(--border); }
.dft button { height: var(--h-ctl-lg); white-space: nowrap; padding: 0 16px; cursor: pointer; border-radius: var(--r-box); font-size: var(--fs-4); }
.gh { background: var(--bg); border: 1px solid var(--border-strong); color: var(--text); }
.gh:hover { border-color: var(--accent); }
.ok { background: var(--accent); border: 1px solid var(--accent); color: var(--bg); font-weight: 600; }
</style>
