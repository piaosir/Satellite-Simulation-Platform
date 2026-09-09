// 标题栏搜索框的【分区 / 参数行索引】—— 从侧栏与设置窗的模板里静态抽出来。
//
// 为什么静态抽：侧栏各视图的分区内容只在展开时才渲染（v-if），运行时扫 DOM 只能看到当前那一小块；
// 而 Office 的搜索框是「功能区上每个控件都搜得到」—— 字号 / 线粗 / 透明度这些参数行必须全量入索引。
//
// 口径：
//   - 视图容器 = v-show="shellUi.side === 'xxx'"（SatCovPanel / SettingsModal 由 SOURCES 直接给定视图）
//   - 分区标题 = 带 data-sec="key" 的元素；标题文本取其中第一个裸 <span>…</span>（带 {{ }} 的算动态，title=null，
//     由 App.vue 兜底命名）；.shd 这类没有 span 的取元素文本
//   - 分区内容 = 从标题到下一个标题 / 下一个视图容器 / </Teleport> 之间的模板文本
//   - 视图里第一个分区之前的内容挂到 "<view>-top"（如 GXT/KML 视图顶部的波束列表样式行）
//   - 参数行 = <label>文本</label>（含 .srow 上或 label 上的静态 title 作说明）、.chk2 复选项、.swrow 拨杆行、
//     .plgl 多边形样式格、.fn 设置项；文本含插值的不算；同一分区内同名只记一次
//
// 消费方：electron.vite.config.mjs 的 cmdIndexPlugin 把 buildIndex() 结果做成虚拟模块 virtual:cmd-index，
// App.vue 据此登记「分区」与「分区 › 参数行」两类命令。本文件也可直接 node 运行看一眼抽到了什么。
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
export const SOURCES = [
  { file: 'src/pages/ConstellationMap3D.vue', view: 'auto' },
  { file: 'src/components/SatCovPanel.vue', view: 'satcov' },
  { file: 'src/components/SettingsModal.vue', view: 'settings' }
]

const HAN = /[一-鿿]/
const clean = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\{\{[^}]*\}\}/g, '').replace(/\s+/g, ' ').trim()
// 只认静态属性：`:title="…"` 是表达式，抽不出文本
function staticAttr(attrs, name) {
  const m = new RegExp('(?:^|\\s)' + name + '="([^"]*)"').exec(attrs || '')
  return m ? clean(m[1]) : ''
}

function extractItems(block) {
  const items = []
  const seen = new Set()
  const add = (label, hint) => {
    label = clean(label)
    if (!label || label.includes('{{')) return
    if (!HAN.test(label) && label.length < 2) return
    if (seen.has(label)) return
    seen.add(label)
    items.push(hint ? { label, hint } : { label })
  }
  // 参数行（先跑：能带上行级 title 作说明）
  for (const m of block.matchAll(/<div class="srow[^"]*"([^>]*)>\s*<label([^>]*)>([^<{]+)<\/label>/g)) add(m[3], staticAttr(m[1], 'title') || staticAttr(m[2], 'title'))
  // 其余 label（.lb2 等）
  for (const m of block.matchAll(/<label([^>]*)>([^<{]+)<\/label>/g)) add(m[2], staticAttr(m[1], 'title'))
  // 复选项：<label class="chk2" title="…"><input …/><span>文本</span>
  for (const m of block.matchAll(/<label class="chk2"([^>]*)>\s*<input[^>]*>\s*<span>([^<{]+)<\/span>/g)) add(m[2], staticAttr(m[1], 'title'))
  // 拨杆行 / 多边形样式格 / 设置项
  for (const m of block.matchAll(/<div class="swrow"[^>]*>\s*<span>([^<{]+)<\/span>/g)) add(m[1])
  for (const m of block.matchAll(/<span class="plgl">([^<{]+)<\/span>/g)) add(m[1])
  for (const m of block.matchAll(/<span class="fn"([^>]*)>([^<{]+)/g)) add(m[2], staticAttr(m[1], 'title'))
  return items
}

// 标题元素：从 data-sec 所在的开标签起到第一个 </div>；标题 = 第一个裸 <span>，没有 span 的取元素文本
function headingTitle(block) {
  const tagEnd = block.indexOf('>')
  const close = block.indexOf('</div>', tagEnd)
  const inner = close > 0 ? block.slice(tagEnd + 1, close) : ''
  const sp = /<span>([^<]*)<\/span>/.exec(inner)
  const raw = sp ? sp[1] : inner
  if (/\{\{/.test(raw)) return { title: null, end: close > 0 ? close + 6 : tagEnd + 1 }
  const title = clean(raw)
  return { title: title || null, end: close > 0 ? close + 6 : tagEnd + 1 }
}

export function buildIndex(sources = SOURCES, root = ROOT) {
  const out = []
  for (const src of sources) {
    const text = fs.readFileSync(path.join(root, src.file), 'utf8')
    const ti = text.indexOf('<template>'), te = text.lastIndexOf('</template>')
    const tpl = ti >= 0 && te > ti ? text.slice(ti, te) : text
    const marks = []
    for (const m of tpl.matchAll(/v-show="shellUi\.side === '([a-zA-Z]+)'"/g)) marks.push({ pos: m.index, kind: 'view', view: m[1] })
    for (const m of tpl.matchAll(/data-sec="([a-z0-9-]+)"/g)) marks.push({ pos: m.index, kind: 'sec', key: m[1] })
    for (const m of tpl.matchAll(/<\/Teleport>/g)) marks.push({ pos: m.index, kind: 'end' })
    marks.sort((a, b) => a.pos - b.pos)
    let view = src.view === 'auto' ? '' : src.view
    for (let i = 0; i < marks.length; i++) {
      const mk = marks[i]
      const end = i + 1 < marks.length ? marks[i + 1].pos : tpl.length
      if (mk.kind === 'end') { view = src.view === 'auto' ? '' : src.view; continue }
      if (mk.kind === 'view') {
        view = mk.view
        const items = extractItems(tpl.slice(mk.pos, end))
        if (items.length) out.push({ view, key: view + '-top', title: null, items })
        continue
      }
      if (!view) continue
      // data-sec 属性位于开标签内部：回退到该标签的 '<' 再取标题
      const tagStart = tpl.lastIndexOf('<', mk.pos)
      const block = tpl.slice(tagStart, end)
      const { title, end: headEnd } = headingTitle(block)
      out.push({ view, key: mk.key, title, items: extractItems(block.slice(headEnd)) })
    }
  }
  return out
}

// ---- 落盘：生成 src/shared/cmdIndex.data.js（真实文件而非虚拟模块：各 harness 直接 import，不需要插件）----
export const OUT_FILE = 'src/shared/cmdIndex.data.js'
export function renderIndex(idx) {
  return '// 自动生成 —— 标题栏搜索框的分区 / 参数行索引，勿手改。\n' +
    '// 生成器：scripts/cmd-index.mjs（electron-vite dev / build 起步时由 cmdIndexPlugin 自动刷新，模板改了随手重生成；\n' +
    '// 也可手动 node scripts/cmd-index.mjs）。口径见生成器头注；packages/core/test/cmdIndex.test.mjs 校验本文件与模板同步。\n' +
    'export default [\n' + idx.map((s) => '  ' + JSON.stringify(s)).join(',\n') + '\n]\n'
}
export function writeIndex(root = ROOT) {
  const idx = buildIndex(SOURCES, root)
  const text = renderIndex(idx)
  const p = path.join(root, OUT_FILE)
  let old = ''
  try { old = fs.readFileSync(p, 'utf8') } catch { /* 首次生成 */ }
  const changed = old !== text
  if (changed) fs.writeFileSync(p, text)
  return { idx, changed }
}

// 直接运行：重生成索引文件；--print 逐分区打印抽到了什么
if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
  const { idx, changed } = writeIndex()
  let n = 0
  for (const s of idx) {
    n += s.items.length
    if (process.argv.includes('--print')) console.log(`[${s.view}] ${s.key}  ${s.title || '(动态标题)'}  ← ${s.items.map((i) => i.label).join(' / ')}`)
  }
  console.log(`共 ${idx.length} 个分区、${n} 条参数行 → ${OUT_FILE}${changed ? '（已更新）' : '（未变）'}`)
}
