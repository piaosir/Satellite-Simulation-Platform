// 只读：列出已打包 asar 的组成（不解包、不读密钥值）
const path = require('path')
const ROOT = process.argv[2]
const asar = require(path.join(ROOT, 'node_modules', '@electron', 'asar'))
const list = asar.listPackage(path.join(ROOT, 'release/win-unpacked/resources/app.asar')).map((f) => f.replace(/\\/g, '/'))
console.log('files', list.length)
const lic = list.filter((f) => /LICEN[CS]E|COPYING|NOTICE/i.test(path.basename(f)))
console.log('license-like files', lic.length)
const pk = new Set()
for (const f of list) {
  if (!f.startsWith('/node_modules/')) continue
  const seg = f.split('/').slice(2)
  if (!seg[0]) continue
  pk.add(seg[0].startsWith('@') ? seg[0] + '/' + (seg[1] || '') : seg[0])
}
console.log('node_modules pkgs in asar', pk.size)
console.log([...pk].sort().join(' '))
console.log('cfg files', list.filter((f) => /shareConfig|weatherConfig|cosConfig/.test(f)))
console.log('sourcemaps', list.filter((f) => /\.map$/.test(f)).length)
console.log('tests', list.filter((f) => /packages\/core\/test/.test(f)).length)
console.log('top-level', [...new Set(list.map((f) => f.split('/')[1]))].join(' '))
const pkWithLic = [...pk].filter((p) => lic.some((l) => l.startsWith('/node_modules/' + p + '/')))
console.log('pkgs with license file', pkWithLic.length, 'without:', [...pk].filter((p) => !pkWithLic.includes(p)).join(' '))
const outRenderer = list.filter((f) => f.startsWith('/out/renderer/'))
console.log('out/renderer files', outRenderer.length)
const maps = list.filter((f) => f.endsWith('.map'))
const by = {}
for (const m of maps) { const k = m.split('/').slice(1, 3).join('/'); by[k] = (by[k] || 0) + 1 }
console.log('maps by dir', Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 10))
console.log('packages/ files', list.filter((f) => f.startsWith('/packages/')).length, 'electron/ files', list.filter((f) => f.startsWith('/electron/')).length)
