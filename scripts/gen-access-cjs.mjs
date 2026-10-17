// 唯一访问引擎的 CJS 镜像生成器：packages/core/utils/access/accessCore.mjs（ESM，唯一源）→ accessCore.js（CJS）。
//
// 为什么要镜像：渲染端只能 import ESM（Vite 不转 packages/ 下的 CJS 源码），主进程 ngsoGeometry.js 是 CJS、
// 且 Electron 31 内置 Node 20.18 不能同步 require ESM —— 同一份引擎两头都要用，只好一份源、机械生成另一份。
// 规则：去掉声明行首的 `export `，末尾补 module.exports；源文件不许有 import / export default / export { }（引擎必须零依赖）。
// 用法：node scripts/gen-access-cjs.mjs（改了 .mjs 必跑）。packages/core/test/accessEngine.test.mjs 用 buildCjs 现生成一份
// 与仓库里的 accessCore.js 逐字比对，并逐个导出函数比 String(fn)，漂了就红。
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SRC = join(ROOT, 'packages/core/utils/access/accessCore.mjs')
export const DST = join(ROOT, 'packages/core/utils/access/accessCore.js')

export function buildCjs(srcText) {
  const lines = String(srcText).replace(/\r\n/g, '\n').split('\n')
  const names = []
  const body = lines.map((ln, i) => {
    if (/^\s*import\s/.test(ln) || /^\s*export\s+(default|\{)/.test(ln)) throw new Error(`accessCore.mjs 第 ${i + 1} 行：引擎必须零依赖、只用具名声明导出（${ln.trim()}）`)
    const m = /^export\s+(?:async\s+)?(function|const|let|class)\s+([A-Za-z_$][\w$]*)/.exec(ln)
    if (!m) return ln
    names.push(m[2])
    return ln.replace(/^export\s+/, '')
  })
  while (body.length && body[body.length - 1] === '') body.pop()
  return [
    '// ⚠ 自动生成，勿手改 —— 源：accessCore.mjs（ESM）。重生成：node scripts/gen-access-cjs.mjs',
    "'use strict'",
    '',
    ...body,
    '',
    `module.exports = { ${names.join(', ')} }`,
    ''
  ].join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = buildCjs(readFileSync(SRC, 'utf8'))
  writeFileSync(DST, out)
  console.log(`已生成 ${DST}（${out.split('\n').length} 行）`)
}
