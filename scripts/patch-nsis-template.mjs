// 打包前修补 electron-builder 的 NSIS 模板：首次安装闪退。运行：node scripts/patch-nsis-template.mjs（幂等）
//
// 为什么需要这个脚本 —— 它拦的是「新用户第一次装，安装器一声不响就没了」：
//   app-builder-lib 24.13.3 的 templates/nsis/multiUser.nsh 里，setInstallModePerUser 在注册表没有 InstallLocation
//   （= 这台机器上从没装过）时调 SHGetKnownFolderPath 取 %LOCALAPPDATA%\Programs，再用
//   System::Call '*$2(&w${NSIS_MAX_STRLEN} .s)' 读回路径 —— System 插件按结构体尺寸整块拷，NSIS_MAX_STRLEN = 8192，
//   于是从一个几十字节的字符串起连读 16 KB，越过所在堆块。崩不崩看堆布局：2026-09-24 本机（Win11 26200）测试包首装
//   9 次崩 6 次，System.dll 访问违例（0xC0000005，偏移 0x1581），界面出来之前安装器就消失，事件查看器里才看得到。
//   覆盖安装 / 自动更新不走这段（注册表里已有 InstallLocation），只有首次安装会踩到。
//
// 同一段里另有两处缺陷一并修掉：System::Store L 把 $0 还原，查到的已知文件夹路径从没被用上；
// .s 压进 NSIS 栈的那串从不弹出。换成上游的写法（app-builder-lib 26.12.0 起，26.15.3 核对过逐字相同）：
// lstrcpynW 拷到 NUL 为止，SHGetKnownFolderPath 失败时也释放它分配的内存。
//
// 为什么不升级 electron-builder：大版本跨两级，build/installer.nsh 依赖模板内部流程（调旧卸载器、customFiles_*、
// _CHECK_APP_RUNNING），全部要重测。为什么不在 installer.nsh 里重定义这个宏：得整段抄模板，上游以后再改，这边的
// 副本会悄悄盖掉；不带 installer.nsh 的构建（.updharness 的 baseA）也照样崩。
//
// 挂在 dist 里 electron-builder 之前（见 package.json）。npm install 会把模板还原，下次 dist 又补上。
// 判据看危险写法在不在，不看版本号：
//   · 危险写法已不在（本脚本改过、或已升级到上游修好的版本）→ 不动
//   · 危险写法在、且整段与 24.13.3 原文逐字一致 → 改写并复核
//   · 危险写法在、但上下文对不上 → 中断打包，人工核对（不能带着它出包）
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const die = (lines) => {
  console.error('\n✗ 打包中断：NSIS 模板首装越界读修补失败（带着它出的安装包，新用户首次安装会闪退）\n')
  for (const l of lines) console.error('  ' + l)
  console.error('\n  对照上游 app-builder-lib 26.12.0+ 的 templates/nsis/multiUser.nsh 核对这段，再更新本脚本。\n')
  process.exit(1)
}

// 取 electron-builder 真正加载的那份 app-builder-lib（它可能嵌套在 electron-builder/node_modules 下）
let libDir
try {
  const req = createRequire(join(root, 'package.json'))
  const ebReq = createRequire(req.resolve('electron-builder/package.json'))
  libDir = dirname(ebReq.resolve('app-builder-lib/package.json'))
} catch (e) {
  die([`找不到 electron-builder / app-builder-lib：${e.message.split('\n')[0]}`, '先 npm install。'])
}
const libVersion = JSON.parse(readFileSync(join(libDir, 'package.json'), 'utf8')).version
const file = join(libDir, 'templates', 'nsis', 'multiUser.nsh')
const rel = relative(root, file)

// 定长读 NSIS_MAX_STRLEN 个宽字符的结构体读取
const DANGER = /\*\$\w+\(&w\$\{NSIS_MAX_STRLEN\}/

// setInstallModePerUser 的 ${else} 分支：24.13.3 原文 → 上游 26.12.0+ 写法（缩进照原文）
const BROKEN = [
  '      StrCpy $0 "$LocalAppData\\Programs"',
  '      System::Store S',
  '      # Win7 has a per-user programfiles known folder and this can be a non-default location',
  `      System::Call 'SHELL32::SHGetKnownFolderPath(g "\${FOLDERID_UserProgramFiles}", i \${KF_FLAG_CREATE}, p 0, *p .r2)i.r1'`,
  '      ${If} $1 == 0',
  `        System::Call '*$2(&w\${NSIS_MAX_STRLEN} .s)'`,
  '        StrCpy $0 $1',
  `        System::Call 'OLE32::CoTaskMemFree(p r2)'`,
  '      ${endif}',
  '      System::Store L',
  '      StrCpy $INSTDIR "$0\\${APP_FILENAME}"'
]
const FIXED = [
  '      StrCpy $0 "$LocalAppData\\Programs"',
  '',
  '      Push $1',
  '      Push $2',
  '      # UserProgramFiles is the per-user install root and can be a non-default location',
  '      StrCpy $2 0',
  `      System::Call 'SHELL32::SHGetKnownFolderPath(g "\${FOLDERID_UserProgramFiles}", i \${KF_FLAG_CREATE}, p 0, *p .r2)i.r1'`,
  '      ${If} $1 == 0',
  `        System::Call 'KERNEL32::lstrcpynW(w .r0, p r2, i \${NSIS_MAX_STRLEN})p'`,
  '      ${endif}',
  '      # SHGetKnownFolderPath may return allocated memory even on failure',
  '      ${If} $2 != 0',
  `        System::Call 'OLE32::CoTaskMemFree(p r2)'`,
  '      ${endif}',
  '      Pop $2',
  '      Pop $1',
  '',
  '      StrCpy $INSTDIR "$0\\${APP_FILENAME}"'
]

let text
try {
  text = readFileSync(file, 'utf8')
} catch (e) {
  die([`读不到 ${rel}：${e.message}`])
}

if (!DANGER.test(text)) {
  const how = text.includes(FIXED.join('\n')) || text.includes(FIXED.join('\r\n'))
    ? '已是修好的写法，不动'
    : '模板里已没有这处定长读，不动（上游已修？升级后本脚本可删）'
  console.log(`✓ NSIS 模板首装越界读：${how}（app-builder-lib ${libVersion}）`)
  process.exit(0)
}

const eol = text.includes('\r\n') ? '\r\n' : '\n'
const broken = BROKEN.join(eol)
const hits = text.split(broken).length - 1
if (hits !== 1) {
  die([
    `${rel}（app-builder-lib ${libVersion}）里有 System::Call '*$2(&w\${NSIS_MAX_STRLEN} .s)' 这处越界读，`,
    `但所在段落与 24.13.3 原文对不上（匹配 ${hits} 处），不能自动改写。`
  ])
}

// 替换内容里满是 $0 / $1，用函数形式免得被当成替换模式
const patched = text.replace(broken, () => FIXED.join(eol))
try {
  writeFileSync(file, patched)
} catch (e) {
  die([`写不进 ${rel}：${e.message}`])
}
if (DANGER.test(readFileSync(file, 'utf8'))) die([`${rel} 写回后复核仍有越界读。`])
console.log(`✓ NSIS 模板首装越界读：已改写 ${rel}（app-builder-lib ${libVersion} → 上游 26.12.0+ 写法）`)
