// 发版前自检：源码必须全部已提交进 git（npm run dist 第一步；也可单独 npm run check:untracked）。
//
// 为什么：发版按「提交 → 打 tag → dist」走，tag 必须能复现安装包。没提交的文件从 tag / 干净检出 / 派生 worktree
// 构建时会缺：渲染端缺件 electron-vite 当场报错还算好；主进程运行时才 require 的（如 electron/services/videoFile.js）
// electron-vite 不打包、verify-asar 也不查，缺了就是「装得上、启动不出窗口、进程挂着占单实例锁」。
//
// 规则：下列目录 / 文件里有未跟踪文件（.gitignore 之外）就中断并列出清单；docs 不管。
// SATSIM_ALLOW_UNTRACKED=1 跳过（临时出包自测用，正式发版别开）。
import { execFileSync } from 'node:child_process'

const PATHS = ['src', 'electron', 'packages', 'resources', 'build', 'scripts', 'package.json', 'package-lock.json', 'electron.vite.config.mjs']

if (process.env.SATSIM_ALLOW_UNTRACKED === '1') {
  console.log('⚠ 已跳过未跟踪文件检查（SATSIM_ALLOW_UNTRACKED=1）')
  process.exit(0)
}
let out = ''
try {
  out = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', ...PATHS], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
} catch (e) {
  console.error('✗ 读不到 git 状态：' + ((e && e.message) || e))
  process.exit(1)
}
const files = out.split('\0').filter(Boolean)
if (!files.length) {
  console.log('✓ 源码全部已提交（无未跟踪文件）')
  process.exit(0)
}
console.error(`✗ 有 ${files.length} 个源文件还没提交进 git，先提交再发版（从 tag / 干净检出构建会缺它们）：`)
for (const f of files.slice(0, 100)) console.error('   ' + f)
if (files.length > 100) console.error(`   …另有 ${files.length - 100} 个`)
process.exit(1)
