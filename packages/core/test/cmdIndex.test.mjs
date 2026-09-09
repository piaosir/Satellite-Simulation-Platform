// 标题栏搜索框的分区 / 参数行索引自测：抽取器对真实模板的不变量 + 生成文件与模板同步。运行：npm test
//
// 为什么测：索引是从 .vue 模板里按几条正则抽出来的（scripts/cmd-index.mjs），模板改个写法（标题 span 挪位、
// 参数行换类名、data-sec 漏打）抽取就悄悄少一块 —— 搜索框不报错，只是「字号 / 线粗」这类词突然搜不到。
// 这里钉住几处代表性的抽取结果，再校验落盘的 cmdIndex.data.js 没过期。
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { buildIndex, renderIndex, OUT_FILE } from '../../../scripts/cmd-index.mjs'

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..')
let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}

const idx = buildIndex()
const by = (k) => idx.filter((s) => s.key === k)
const has = (k, label) => by(k).some((s) => s.items.some((i) => i.label === label))

ok('分区数量在合理范围', idx.length >= 40 && idx.length <= 200, String(idx.length))
ok('每个分区都有视图归属', idx.every((s) => s.view), idx.filter((s) => !s.view).map((s) => s.key).join(','))
ok('同一 key 不跨视图', new Set(idx.map((s) => s.key)).size === new Set(idx.map((s) => s.key + '@' + s.view)).size)
ok('标题不含插值 / 标签', idx.every((s) => !s.title || !/[<>{}]/.test(s.title)))
ok('参数行文本不含插值 / 标签', idx.every((s) => s.items.every((i) => !/[<>{}]/.test(i.label))))
ok('同一分区内参数行不重名', idx.every((s) => new Set(s.items.map((i) => i.label)).size === s.items.length))

// 代表性抽取结果（用户最先要搜的那几个词）
ok('边界线 → 线粗', has('geo-border', '线粗'))
ok('地名 → 字号', has('geo-name', '字号'))
ok('点标记 → 字号 / 描边', has('mk-points', '字号') && has('mk-points', '描边'))
ok('聚焦卫星 · 覆盖锥 → 母线线粗', has('foc-cone', '母线线粗'))
ok('晨昏线 → 夜区颜色', has('geo-term', '夜区颜色'))
ok('复选项也入索引（显示波束名）', has('gxt-disp', '显示波束名'))
ok('行级 title 作说明', by('mk-points')[0].items.some((i) => i.label === '描边' && i.hint))
ok('晨昏线归地图设置视图', by('geo-term')[0] && by('geo-term')[0].view === 'geo')
ok('轨道壳层（SatCovPanel）归对星覆盖分析', by('satcov-shell')[0] && by('satcov-shell')[0].view === 'satcov' && has('satcov-shell', '线宽'))
ok('设置窗按 settings 归档', by('set-quality')[0] && by('set-quality')[0].view === 'settings' && has('set-quality', '渲染分辨率'))
ok('视图顶部（分区前）的行挂到 <view>-top', has('gxt-top', '线粗'))
ok('动态标题的分区 title 为空', by('vis-list')[0] && by('vis-list')[0].title === null)

// 模板里每个 data-sec 都进了索引（漏一个就是一块搜不到）
for (const f of ['src/pages/ConstellationMap3D.vue', 'src/components/SatCovPanel.vue', 'src/components/SettingsModal.vue']) {
  const tpl = fs.readFileSync(path.join(ROOT, f), 'utf8')
  const keys = [...new Set([...tpl.matchAll(/data-sec="([a-z0-9-]+)"/g)].map((m) => m[1]))]
  const miss = keys.filter((k) => !by(k).length)
  ok(`${path.basename(f)} 的 data-sec 全部入索引`, !miss.length, miss.join(','))
}

// 落盘文件与模板同步（过期 = 有人改了模板没跑 dev/build，也没手动 node scripts/cmd-index.mjs）
let cur = ''
try { cur = fs.readFileSync(path.join(ROOT, OUT_FILE), 'utf8') } catch { /* 缺文件也算过期 */ }
ok('cmdIndex.data.js 与模板同步（过期请跑 node scripts/cmd-index.mjs）', cur === renderIndex(idx))

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
