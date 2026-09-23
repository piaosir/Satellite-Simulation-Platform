// npm run nasa3d:corpus-report —— 语料体检：逐个读 .models-src/nasa/*/ 下 glb 的文件头（magic / 版本 / JSON 块），不解网格，
// 统计 generator、扩展（Draco / meshopt / 贴图格式）、节点 / 网格 / 材质 / 贴图数、三角形数、包围盒跨度，
// 写 .models-src/corpus-report.md（分组表格）与 .models-src/corpus-report.json（逐文件全量），作 §5.3 归一化 / §5.4 部件分割的输入。
//
//   node scripts/nasa3d/corpus-report.mjs [--span-max=300] [--span-min=0.05]
//
// 四类标记：
//   单网格无贴图   meshes = 1 且 images = 0（部件识别只能靠材质分组 + 几何聚类，§5.4）
//   Draco必需      extensionsRequired 含 KHR_draco_mesh_compression（不解 Draco 读不开）
//   多文件条目     该条目在清单里有 ≥ 2 个 glb（零件集 / 多姿态）
//   可疑单位       包围盒跨度按米读 > --span-max 或 < --span-min（缺省 300 m / 0.05 m）；NASA 原件单位不可信（§2.1、§5.3）
// 三角形与包围盒的口径见 lib.mjs summarizeGltf 头注释（包围盒是节点世界变换后的外包盒近似，旋转节点下偏大）。
// 只看已落盘且带 .sha256 旁车的文件（.part 与没收完的不算）。终端打印 Draco 必需 / 单网格 / 可疑单位三个数。
import fs from 'node:fs'
import path from 'node:path'
import {
  parseArgs, readGlbHeaderFile, summarizeGltf, readSidecar, readJson, writeJsonAtomic, loadIncludeList,
  fmtBytes, fmtInt, formatTable, mdTable, NASA_DIR, SRC_ROOT, REPO_ROOT
} from './lib.mjs'

const REPORT_MD = path.join(SRC_ROOT, 'corpus-report.md')
const REPORT_JSON = path.join(SRC_ROOT, 'corpus-report.json')
const rel = (p) => path.relative(REPO_ROOT, p).replace(/\\/g, '/')
const num = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : Math.abs(x) >= 1000 ? x.toFixed(0) : Math.abs(x) >= 1 ? x.toFixed(d) : x.toPrecision(3))

async function main() {
  const args = parseArgs(process.argv.slice(2), { 'span-max': 'number', 'span-min': 'number', help: 'bool' })
  if (args.help) { console.log('用法：node scripts/nasa3d/corpus-report.mjs [--span-max=300] [--span-min=0.05]'); return 0 }
  const spanMax = args.spanMax ?? 300
  const spanMin = args.spanMin ?? 0.05
  const list = loadIncludeList()
  const listBy = new Map(list.entries.map((e) => [e.slug, e]))
  if (!fs.existsSync(NASA_DIR)) { console.error(`没有 ${rel(NASA_DIR)}：先跑 npm run nasa3d:fetch`); return 2 }

  const dirs = fs.readdirSync(NASA_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  const files = []
  const entries = []
  let skippedPartial = 0
  for (const slug of dirs) {
    const dir = path.join(NASA_DIR, slug)
    const meta = readJson(path.join(dir, 'meta.json'), {})
    const le = listBy.get(slug)
    const group = meta.group || (le && le.group) || '（清单外）'
    const glbs = fs.readdirSync(dir).filter((n) => /\.glb$/i.test(n)).sort()
    const listFiles = le ? le.glbs.length : glbs.length
    entries.push({ slug, group, title: meta.title || (le && le.title) || slug, onDisk: glbs.length, listFiles, borrowed: meta.borrowed || [] })
    for (const name of glbs) {
      const p = path.join(dir, name)
      if (!readSidecar(p)) { skippedPartial++; continue }
      const rec = { slug, group, file: name, bytes: fs.statSync(p).size, multiFile: listFiles > 1 }
      try {
        const h = await readGlbHeaderFile(p)
        const s = summarizeGltf(h.json)
        Object.assign(rec, s, { glbLength: h.length, lengthMatches: h.lengthMatches, binLength: h.binLength })
        const span = s.bbox ? s.bbox.span : null
        rec.flags = {
          singleMeshNoTex: s.counts.meshes === 1 && s.counts.images === 0,
          singleMesh: s.counts.meshes === 1,
          dracoRequired: s.draco.required,
          multiFile: rec.multiFile,
          suspiciousUnit: span != null && (span > spanMax || span < spanMin)
        }
      } catch (e) {
        rec.error = e.message
        rec.flags = { multiFile: rec.multiFile }
      }
      files.push(rec)
    }
  }
  if (!files.length) { console.error(`${rel(NASA_DIR)} 里还没有带 .sha256 旁车的 glb`); return 2 }

  const ok = files.filter((f) => !f.error)
  const bad = files.filter((f) => f.error)
  const cnt = (pred) => ok.filter(pred).length
  const nDraco = cnt((f) => f.flags.dracoRequired)
  const nSingle = cnt((f) => f.flags.singleMesh)
  const nSingleNoTex = cnt((f) => f.flags.singleMeshNoTex)
  const nSusp = cnt((f) => f.flags.suspiciousUnit)
  const multiEntries = entries.filter((e) => e.listFiles > 1 && e.onDisk > 0)
  const nMultiFiles = files.filter((f) => f.multiFile).length
  const lenBad = ok.filter((f) => !f.lengthMatches)

  // ── 分组汇总 ──
  const groupOrder = [...list.allGroups, ...new Set(files.map((f) => f.group).filter((g) => !list.allGroups.includes(g)))]
  const groups = groupOrder.filter((g) => files.some((f) => f.group === g))
  const summaryRows = groups.map((g) => {
    const fs_ = files.filter((f) => f.group === g)
    const oks = fs_.filter((f) => !f.error)
    return [g, new Set(fs_.map((f) => f.slug)).size, fs_.length, fmtBytes(fs_.reduce((s, f) => s + f.bytes, 0)), fmtInt(oks.reduce((s, f) => s + f.triangles, 0)),
      oks.filter((f) => f.flags.dracoRequired).length, oks.filter((f) => f.flags.singleMeshNoTex).length, oks.filter((f) => f.flags.suspiciousUnit).length, fs_.filter((f) => f.error).length]
  })
  summaryRows.push(['合计', new Set(files.map((f) => f.slug)).size, files.length, fmtBytes(files.reduce((s, f) => s + f.bytes, 0)), fmtInt(ok.reduce((s, f) => s + f.triangles, 0)), nDraco, nSingleNoTex, nSusp, bad.length])
  const summaryHead = ['分组', '条目', '文件', '体积', '三角形', 'Draco必需', '单网格无贴图', '可疑单位', '解析失败']

  // ── 分布 ──
  const tally = (arr) => [...arr.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
  const genRows = tally(ok.map((f) => f.generator || '（未写）'))
  const extNames = [...new Set(ok.flatMap((f) => [...f.extensionsUsed, ...f.extensionsRequired]))].sort()
  const extRows = extNames.map((x) => [x, ok.filter((f) => f.extensionsUsed.includes(x)).length, ok.filter((f) => f.extensionsRequired.includes(x)).length])
  const texRows = tally(ok.flatMap((f) => Object.entries(f.imageFormats).flatMap(([k, v]) => Array(v).fill(k))))
  const texFiles = ok.filter((f) => f.counts.images > 0).length

  const flagText = (f) => {
    if (f.error) return '解析失败'
    const t = []
    if (f.flags.singleMeshNoTex) t.push('单网格无贴图')
    if (f.flags.dracoRequired) t.push('Draco必需')
    if (f.flags.multiFile) t.push('多文件条目')
    if (f.flags.suspiciousUnit) t.push('可疑单位')
    if (f.externalUris) t.push('外链资源')
    if (!f.lengthMatches) t.push('头长≠文件长')
    if (f.specGloss) t.push('SpecGloss')
    return t.join('、')
  }
  const bboxText = (f) => (f.bbox ? f.bbox.size.map((x) => num(x)).join(' × ') + (f.bboxApprox ? ' ≈' : '') : '—')
  const detailHead = ['条目', '文件', '体积', 'generator', '节点', '网格', '图元', '材质', '贴图', '三角形', '包围盒 (x × y × z)', '跨度', '标记']
  const detailRow = (f) => [f.slug, f.file, fmtBytes(f.bytes), f.generator || '—', f.error ? '—' : f.counts.nodes, f.error ? '—' : f.counts.meshes, f.error ? '—' : f.counts.primitives,
    f.error ? '—' : f.counts.materials, f.error ? '—' : f.counts.images, f.error ? '—' : fmtInt(f.triangles), f.error ? '—' : bboxText(f), f.error ? '—' : num(f.bbox && f.bbox.span), flagText(f)]
  const detailAlign = ['l', 'l', 'r', 'l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'l']

  // ── Markdown ──
  const now = new Date().toISOString()
  const md = []
  md.push('# NASA glb 语料报告', '')
  md.push(`生成 ${now} · 来源 \`${rel(NASA_DIR)}/\` · ${new Set(files.map((f) => f.slug)).size} 个条目、${files.length} 个 glb、${fmtBytes(files.reduce((s, f) => s + f.bytes, 0))}` +
    (skippedPartial ? ` · 另有 ${skippedPartial} 个未收完（无 .sha256）未计入` : ''), '')
  md.push('## 汇总', '', mdTable(summaryHead, summaryRows), '')
  md.push('## 四类标记', '')
  md.push(`- Draco 必需：**${nDraco}** / ${ok.length} 个文件`)
  md.push(`- 单网格：**${nSingle}** 个文件，其中无贴图 **${nSingleNoTex}**`)
  md.push(`- 多文件条目：**${multiEntries.length}** 条、${nMultiFiles} 个文件（${multiEntries.map((e) => `${e.slug}×${e.listFiles}`).join('、') || '无'}）`)
  md.push(`- 包围盒跨度可疑单位：**${nSusp}** 个文件（跨度按米读 > ${spanMax} 或 < ${spanMin}）`)
  if (lenBad.length) md.push(`- 文件头声明总长 ≠ 实际文件长：${lenBad.map((f) => `${f.slug}/${f.file}`).join('、')}`)
  const borrowedEntries = entries.filter((e) => e.borrowed.length)
  if (borrowedEntries.length) md.push(`- 借用他条目直链、未重复下载：${borrowedEntries.map((e) => `${e.slug}（→ ${e.borrowed.map((b) => b.owner).join('、')}）`).join('、')}`)
  md.push('')
  md.push('## generator', '', mdTable(['generator', '文件'], genRows), '')
  md.push('## 扩展', '', extRows.length ? mdTable(['扩展', 'extensionsUsed', 'extensionsRequired'], extRows) : '（无）', '')
  md.push(`## 贴图格式（带贴图的文件 ${texFiles} 个）`, '', texRows.length ? mdTable(['格式', '贴图数'], texRows) : '（无贴图）', '')
  const suspicious = ok.filter((f) => f.flags.suspiciousUnit).sort((a, b) => b.bbox.span - a.bbox.span)
  if (suspicious.length) md.push('## 可疑单位明细', '', mdTable(['条目', '文件', '跨度', '按英尺折米', '按厘米折米', '按英寸折米'], suspicious.map((f) => [f.slug, f.file, num(f.bbox.span), num(f.bbox.span * 0.3048), num(f.bbox.span * 0.01), num(f.bbox.span * 0.0254)]), ['l', 'l', 'r', 'r', 'r', 'r']), '')
  for (const g of groups) {
    const rows = files.filter((f) => f.group === g).sort((a, b) => a.slug.localeCompare(b.slug) || a.file.localeCompare(b.file)).map(detailRow)
    md.push(`## 明细：${g}`, '', mdTable(detailHead, rows, detailAlign), '')
  }
  if (bad.length) md.push('## 解析失败', '', mdTable(['条目', '文件', '原因'], bad.map((f) => [f.slug, f.file, f.error])), '')
  md.push('## 口径', '')
  md.push('- 只读 GLB 文件头与 JSON 块，不解网格、不解 Draco；三角形数取 indices 访问器的 count（无索引取 POSITION），TRIANGLES 取 ⌊n/3⌋、STRIP / FAN 取 n−2，按网格去重计。')
  md.push('- 包围盒：POSITION 访问器 min / max 的 8 个角点经节点世界矩阵变换后取外包盒；节点带旋转时是保守上界（表中带「≈」），蒙皮 / 变形目标 / 动画不计。跨度 = 三边最长者，单位为模型单位。')
  md.push(`- 可疑单位判据：跨度按米读 > ${spanMax} 或 < ${spanMin}。只是初筛，单位最终以 known-dims.json 的出处为准（§5.3）。`)
  md.push('')
  fs.writeFileSync(REPORT_MD, md.join('\n'), 'utf8')

  await writeJsonAtomic(REPORT_JSON, {
    generated: now,
    criteria: { spanMax, spanMin },
    totals: { entries: new Set(files.map((f) => f.slug)).size, files: files.length, bytes: files.reduce((s, f) => s + f.bytes, 0), parseErrors: bad.length, skippedPartial, dracoRequired: nDraco, singleMesh: nSingle, singleMeshNoTex: nSingleNoTex, multiFileEntries: multiEntries.length, multiFileFiles: nMultiFiles, suspiciousUnit: nSusp },
    entries,
    files
  })

  // ── 终端 ──
  console.log(formatTable(summaryHead, summaryRows))
  console.log('')
  console.log(`Draco 必需：${nDraco} 个文件`)
  console.log(`单网格：${nSingle} 个文件（其中无贴图 ${nSingleNoTex}）`)
  console.log(`包围盒跨度可疑单位：${nSusp} 个文件（> ${spanMax} 或 < ${spanMin}，按米读）`)
  if (bad.length) console.log(`解析失败：${bad.length} 个文件（见报告末节）`)
  if (skippedPartial) console.log(`未收完（无 .sha256）未计入：${skippedPartial} 个`)
  console.log(`已写 ${rel(REPORT_MD)}、${rel(REPORT_JSON)}`)
  return bad.length ? 1 : 0
}

main().then((code) => { process.exitCode = code }, (e) => { console.error('语料报告失败：' + ((e && e.stack) || e)); process.exitCode = 1 })
