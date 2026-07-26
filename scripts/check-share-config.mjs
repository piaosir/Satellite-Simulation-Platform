// 打包前自检：安装包里必须真的带上在线分享凭证。运行：node scripts/check-share-config.mjs
//
// 为什么需要这个脚本 —— 它拦的是一次真实发生过的发版事故：
//   electron/services/shareConfig.js 因为 gitignore 且「本来就该手动放」，实际从来没建过；
//   而 share.js 有一条开发兜底（无该文件时读 COS_SECRET_ID/KEY 环境变量），开发机上正好有，
//   于是「在线分享」「发送到小程序」在开发机自测一路通过，打出来的安装包里却压根没有凭证 ——
//   所有用户点了都是「未配置」，而这个失败在开发机上永远复现不出来。
//
// 因此本脚本挂在 dist 的最前面（见 package.json），让「这个包带不带分享功能」在打包时就说清楚，
// 而不是等用户点了才发现。
//
// 分寸：当前是【有意不带分享功能】的状态（未建 shareConfig.js，功能在用户侧显示「未配置」，
// 线下分享码不受影响）。所以缺文件只大声警告、不中断 —— 那是一个明确的选择，不是事故。
// 真正会中断的是「文件在但配坏了」：那种情况下打出来的包看着有功能、实则必然失败，属于事故。
// 等哪天真把凭证配上了，设 SATSIM_REQUIRE_SHARE=1 让缺文件重新变成硬错误，防止再次漏带。
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cfgPath = join(root, 'electron/services/shareConfig.js')
const require = createRequire(import.meta.url)

const die = (lines) => {
  console.error('\n✗ 打包中断：在线分享凭证未就绪\n')
  for (const l of lines) console.error('  ' + l)
  console.error('\n  配置方法见 electron/services/shareConfig.example.js（含可直接粘贴的 CAM 策略）。')
  console.error('  确实要打一个不含分享功能的包：删掉 shareConfig.js 且不设 SATSIM_REQUIRE_SHARE。\n')
  process.exit(1)
}

if (!existsSync(cfgPath)) {
  // 有意不带分享功能：警告但放行。这是一个明确的选择（不想为此配一把随包分发的密钥），
  // 不是事故 —— 用户侧会显示「未配置」，线下分享码照常可用。
  if (process.env.SATSIM_REQUIRE_SHARE === '1') {
    die(['缺少 electron/services/shareConfig.js，但已设 SATSIM_REQUIRE_SHARE=1 要求必须带上。'])
  }
  console.log('⚠ 未配置在线分享凭证（无 electron/services/shareConfig.js）。')
  console.log('⚠ 本次产出的安装包中「在线分享」与「发送到小程序」在用户侧不可用；线下分享码不受影响。')
  console.log('  这是当前的既定选择。若哪天配上了凭证，设 SATSIM_REQUIRE_SHARE=1 可让漏带重新变成硬错误。')
  console.log('  注意：开发机上这两个功能看着能用，是因为 share.js 回退到了 COS_SECRET_ID/KEY 环境变量，')
  console.log('        用户机器上没有这些环境变量 —— 别拿开发机的表现当验收依据。')
  process.exit(0)
}

let cfg
try { cfg = require(cfgPath) } catch (e) {
  die([`shareConfig.js 无法加载：${e.message}`])
}

const missing = ['secretId', 'secretKey', 'bucket', 'region'].filter((k) => !(cfg && String(cfg[k] || '').trim()))
if (missing.length) die([`shareConfig.js 存在，但这些字段为空：${missing.join('、')}`])

// 凭证不该被误提交：文件在 .gitignore 里，但确认一下比事后 revoke 便宜
const ignored = readFileSync(join(root, '.gitignore'), 'utf8').includes('electron/services/shareConfig.js')
if (!ignored) die(['shareConfig.js 未被 .gitignore 忽略 —— 含密钥的文件不能进仓库。'])

console.log('✓ 分享凭证就绪：' + `${cfg.bucket} / ${cfg.region} / 前缀 ${cfg.prefix || 'share'}`)
console.log('  提醒：CAM 策略只应给 share/* · omm/* · updates/gxt/* 三个前缀，')
console.log('        绝不可放宽成 updates/*（那是自动更新的下载目录，见 shareConfig.example.js）。')
