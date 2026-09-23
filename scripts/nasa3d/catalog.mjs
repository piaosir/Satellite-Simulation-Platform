// npm run nasa3d:catalog —— NASA 3D Resources 全量目录：拉全部条目 → 解析 glb 直链与体积 → 写 .models-src/catalog.json，
// 并与 scripts/nasa3d/include-list.json 对账：新增 / 删除 / 改名 / 改标题 / 文件增减 / 体积变化逐条打印，不许静默。
//
//   node scripts/nasa3d/catalog.mjs [--proxy=URL | --no-proxy] [--strict]
//     --strict   有任何漂移时退出码 2（给 CI / 发版前自检用）；默认只打印、退出码 0
//
// 数据口径（§2.1，2026-09-15 实测）：
//   · 每个资产是一篇 WordPress topic，挂 science-org 6482；/wp/v2/topic 每页 100 条，x-wp-total / x-wp-totalpages 给总数。
//   · 分类树四个父节点：6502 资产类型 / 6484 合集（很稀，不靠它分组）/ 6483 贡献者 / 6487 文件格式。
//   · glb 直链在 content.rendered 里出现两处：
//       ① 模型下载弹窗 <a class="smd-downloads-modal__item" href="…glb" title="<文件名> (Original) (<体积>)">，只列第一个文件；
//       ② 文件列表 hds-file-list-row：<h2>文件名</h2> … <p>日期</p> … <p> (<体积>)</p> … <a href="…glb?emrc=…">，每个文件一行。
//     体积取法按可信度：① 的 title 属性 > ② 同一行里链接【之前】的体积 > §2.1 原口径「链接后 600 字符内」（截到下一个 glb 链接为止，
//     防止把下一行的体积安到这个文件上）。include-list.json 生成时只用了原口径，所以多文件条目的第 2 个起大多没有体积，
//     对账时这类记为「体积补全」单列，不算漂移。
//   · 直链去掉 ?emrc=（CDN 缓存戳，每次生成页面都变）、路径百分号解码，与 include-list.json 同一写法。
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  parseArgs, createNet, fetchJson, canonicalUrl, fileNameFromUrl, decodeEntities, htmlToText,
  sizeTextToBytes, fmtBytes, fmtInt, formatTable, readJson, writeJsonAtomic, loadIncludeList,
  sharedGlbUrls, normTitle,
  NASA_API, NASA_ORG_3D, CATALOG_FILE, REPO_ROOT
} from './lib.mjs'

const TAXONOMY_PARENTS = { 6502: 'assetType', 6484: 'collection', 6483: 'contributor', 6487: 'format' }
const TOPIC_FIELDS = 'id,slug,title,link,modified,excerpt,science-org,content,featured_image_url'
const SIZE_RE = /\(([\d.]+)\s*(KB|MB|GB|B|bytes)\)/i
const SIZE_RE_G = /\(([\d.]+)\s*(KB|MB|GB|B|bytes)\)/gi

// ───────────────────────── 解析 glb 直链 ─────────────────────────

function attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)
  return m ? decodeEntities(m[1]) : null
}

/**
 * content.rendered → [{ url, fileName, bytesApprox, sizeText, sizeSource, fileDate, listName }]（按首次出现顺序、按直链去重）。
 * 另返回 previewGlb（<model-viewer src> 指的那个，常与第一个下载文件相同）。
 */
export function parseGlbLinks(html) {
  const s = String(html || '')
  const links = []
  const aRe = /<a\b[^>]*>/gi
  let m
  while ((m = aRe.exec(s))) {
    const href = attr(m[0], 'href')
    if (!href) continue
    const url = canonicalUrl(href)
    if (!/\.glb$/i.test(url)) continue
    links.push({ url, start: m.index, end: m.index + m[0].length, title: attr(m[0], 'title') })
  }
  const byUrl = new Map()
  const rank = { title: 3, list: 2, after: 1 }
  links.forEach((ln, i) => {
    const prevEnd = i > 0 ? links[i - 1].end : 0
    const nextStart = i + 1 < links.length ? links[i + 1].start : s.length
    let size = null, source = null, fileDate = null, listName = null
    // ① 下载弹窗：title="名字 (Original) (10.56 MB)"
    const tm = ln.title && SIZE_RE.exec(ln.title)
    if (tm) { size = tm; source = 'title' }
    // ② 文件列表行：体积在本行链接之前（本行起点 = 最近一个 hds-file-list-row，且不越过上一个 glb 链接）
    const rowAt = s.lastIndexOf('hds-file-list-row', ln.start)
    if (rowAt >= 0 && rowAt >= prevEnd) {
      const row = s.slice(rowAt, ln.start)
      const hn = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(row)
      if (hn) listName = htmlToText(hn[1]) || null
      const dm = /<p\b[^>]*>\s*([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})\s*<\/p>/.exec(row)
      if (dm) fileDate = dm[1]
      if (!size) {
        let last = null, x
        SIZE_RE_G.lastIndex = 0
        while ((x = SIZE_RE_G.exec(row))) last = x
        if (last) { size = last; source = 'list' }
      }
    }
    // ③ §2.1 原口径：链接后 600 字符内（截到下一个 glb 链接）
    if (!size) {
      const win = s.slice(ln.end, Math.min(ln.end + 600, nextStart))
      const am = SIZE_RE.exec(win)
      if (am) { size = am; source = 'after' }
    }
    const rec = byUrl.get(ln.url) || { url: ln.url, fileName: fileNameFromUrl(ln.url), bytesApprox: null, sizeText: null, sizeSource: null, fileDate: null, listName: null, sizeConflict: null, cands: [] }
    if (size) rec.cands.push({ bytes: sizeTextToBytes(size[1], size[2]), text: `${size[1]} ${size[2]}`, source })
    if (fileDate && !rec.fileDate) rec.fileDate = fileDate
    if (listName && !rec.listName) rec.listName = listName
    byUrl.set(ln.url, rec)
  })
  // 每个直链取可信度最高的体积；① 与 ② 两处写的不一样时记 sizeConflict（③ 是就近猜的，不参与判矛盾）
  const glbs = [...byUrl.values()].map(({ cands, ...rec }) => {
    const best = cands.slice().sort((a, b) => rank[b.source] - rank[a.source])[0]
    if (best) {
      rec.bytesApprox = best.bytes; rec.sizeText = best.text; rec.sizeSource = best.source
      const other = cands.find((c) => rank[c.source] >= 2 && c.bytes !== best.bytes)
      if (other) rec.sizeConflict = `${best.text}（${best.source}）≠ ${other.text}（${other.source}）`
    }
    return rec
  })
  const mv = /<model-viewer\b[^>]*\bsrc\s*=\s*"([^"]+)"/i.exec(s)
  return { glbs, previewGlb: mv ? canonicalUrl(decodeEntities(mv[1])) : null }
}

// ───────────────────────── 拉取 ─────────────────────────

async function fetchAllPages(net, baseUrl, label) {
  const sep = baseUrl.includes('?') ? '&' : '?'
  const onRetry = (e, i, w) => console.warn(`  ${label} 第 ${i} 次失败（${e.message}），${(w / 1000).toFixed(1)} s 后重试`)
  const first = await fetchJson(net, `${baseUrl}${sep}page=1`, { onRetry })
  const total = Number(first.headers.get('x-wp-total'))
  const pages = Number(first.headers.get('x-wp-totalpages')) || 1
  const out = [...first.data]
  for (let p = 2; p <= pages; p++) {
    const r = await fetchJson(net, `${baseUrl}${sep}page=${p}`, { onRetry })
    out.push(...r.data)
  }
  return { items: out, total: Number.isFinite(total) ? total : null, pages }
}

// ───────────────────────── 对账 ─────────────────────────

function reconcile(list, entries) {
  const L = new Map(list.entries.map((e) => [e.slug, e]))
  const C = new Map(entries.map((e) => [e.slug, e]))
  const withGlb = entries.filter((e) => e.glbs.length > 0)
  const r = { added: [], removed: [], renamed: [], titleChanged: [], titleTypography: [], filesAdded: [], filesRemoved: [], urlChanged: [], sizeChanged: [], sizeFilled: [], sizeLost: [] }

  const inL = new Set(L.keys())
  const addedC = withGlb.filter((e) => !inL.has(e.slug))
  const matchedAdded = new Set()
  for (const le of list.entries) {
    const ce = C.get(le.slug)
    if (ce && ce.glbs.length) continue
    // 目录里没有这个 slug（或有但已无 glb）：先看是不是改了 slug（同直链 / 同文件名 / 同标题）
    const lUrls = new Set(le.glbs.map((g) => canonicalUrl(g.url)))
    const lNames = new Set(le.glbs.map((g) => fileNameFromUrl(g.url)))
    const cand = addedC.find((a) => !matchedAdded.has(a.slug) && (a.glbs.some((g) => lUrls.has(g.url)) || normTitle(a.title) === normTitle(le.title) || a.glbs.some((g) => lNames.has(g.fileName))))
    if (cand) { matchedAdded.add(cand.slug); r.renamed.push({ from: le.slug, to: cand.slug, id: cand.id, group: le.group, titleFrom: le.title, titleTo: cand.title }) }
    else r.removed.push({ slug: le.slug, title: le.title, group: le.group, files: le.glbs.length, why: ce ? '条目仍在但已无 glb 直链' : '目录里已没有这个条目' })
  }
  for (const a of addedC) {
    if (matchedAdded.has(a.slug)) continue
    r.added.push({ slug: a.slug, id: a.id, title: a.title, files: a.glbs.length, bytesApprox: a.glbs.reduce((s, g) => s + (g.bytesApprox || 0), 0), assetTypes: a.assetTypes })
  }
  // 同 slug 逐文件比
  const pairs = list.entries.map((le) => [le, C.get(le.slug)]).filter(([, ce]) => ce && ce.glbs.length)
  for (const rn of r.renamed) pairs.push([L.get(rn.from), C.get(rn.to)])
  for (const [le, ce] of pairs) {
    if (le.title !== ce.title && le.slug === ce.slug) {
      if (normTitle(le.title) !== normTitle(ce.title)) r.titleChanged.push({ slug: le.slug, from: le.title, to: ce.title })
      else r.titleTypography.push({ slug: le.slug, from: le.title, to: ce.title })
    }
    const cBy = new Map(ce.glbs.map((g) => [g.url, g]))
    const lBy = new Map(le.glbs.map((g) => [canonicalUrl(g.url), g]))
    const cByName = new Map(ce.glbs.map((g) => [g.fileName, g]))
    for (const [u, lg] of lBy) {
      const cg = cBy.get(u)
      if (!cg) {
        const moved = cByName.get(fileNameFromUrl(u))
        if (moved && !lBy.has(moved.url)) r.urlChanged.push({ slug: ce.slug, file: moved.fileName, from: u, to: moved.url })
        else r.filesRemoved.push({ slug: ce.slug, file: fileNameFromUrl(u), url: u })
        continue
      }
      const a = lg.bytesApprox ?? null, b = cg.bytesApprox ?? null
      if (a != null && b != null && a !== b) r.sizeChanged.push({ slug: ce.slug, file: cg.fileName, from: a, to: b, sizeText: cg.sizeText })
      else if (a == null && b != null) r.sizeFilled.push({ slug: ce.slug, file: cg.fileName, to: b, sizeText: cg.sizeText, sizeSource: cg.sizeSource })
      else if (a != null && b == null) r.sizeLost.push({ slug: ce.slug, file: cg.fileName, from: a })
    }
    for (const [u, cg] of cBy) {
      if (lBy.has(u)) continue
      if (r.urlChanged.some((x) => x.to === u)) continue
      r.filesAdded.push({ slug: ce.slug, file: cg.fileName, url: u, bytesApprox: cg.bytesApprox })
    }
  }
  return r
}

// ───────────────────────── 主流程 ─────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2), { proxy: 'string', 'no-proxy': 'bool', strict: 'bool', help: 'bool' })
  if (args.help) {
    console.log('用法：node scripts/nasa3d/catalog.mjs [--proxy=URL | --no-proxy] [--strict]')
    return 0
  }
  const t0 = Date.now()
  const net = createNet({ proxy: args.proxy, noProxy: args.noProxy })
  console.log(`NASA 3D Resources 目录 · 网络：${net.via}`)
  try {
    // 1) 分类树
    const tax = {}
    const taxById = new Map()
    for (const [parent, key] of Object.entries(TAXONOMY_PARENTS)) {
      const { items } = await fetchAllPages(net, `${NASA_API}science-org?parent=${parent}&per_page=100&_fields=id,slug,name,count,parent`, `分类 ${parent}`)
      tax[key] = items.map((x) => ({ id: x.id, slug: x.slug, name: decodeEntities(x.name), count: x.count }))
      for (const x of tax[key]) taxById.set(x.id, { ...x, key })
    }
    // 2) 全部条目
    const { items: topics, total, pages } = await fetchAllPages(net, `${NASA_API}topic?science-org=${NASA_ORG_3D}&per_page=100&_fields=${TOPIC_FIELDS}`, '条目')
    const seenId = new Set()
    const dupIds = []
    const uniq = topics.filter((t) => (seenId.has(t.id) ? (dupIds.push(t.id), false) : seenId.add(t.id)))
    console.log(`条目：x-wp-total = ${total ?? '缺'}，${pages} 页，实收 ${topics.length} 条${dupIds.length ? `（翻页期间重复 ${dupIds.length} 条已去重）` : ''}`)
    if (total != null && uniq.length !== total) console.warn(`  ！实收去重后 ${uniq.length} 条 ≠ x-wp-total ${total}（翻页期间目录有变动时会这样，重跑一次再看）`)

    // 3) 解析
    const entries = uniq.map((t) => {
      const orgs = Array.isArray(t['science-org']) ? t['science-org'] : []
      const pick = (key, f) => orgs.map((id) => taxById.get(id)).filter((x) => x && x.key === key).map(f)
      const { glbs, previewGlb } = parseGlbLinks(t.content && t.content.rendered)
      return {
        id: t.id,
        slug: t.slug,
        title: decodeEntities(t.title && t.title.rendered).trim(),
        link: t.link || null,
        modified: t.modified || null,
        excerpt: htmlToText(t.excerpt && t.excerpt.rendered),
        featuredImage: t.featured_image_url || null,
        assetTypes: pick('assetType', (x) => x.slug),
        formats: pick('format', (x) => x.slug),
        contributors: pick('contributor', (x) => x.name),
        collections: pick('collection', (x) => x.slug),
        scienceOrg: orgs,
        glbs,
        previewGlb: previewGlb && !glbs.some((g) => g.url === previewGlb) ? previewGlb : null
      }
    }).sort((a, b) => a.slug.localeCompare(b.slug))

    // 跨条目共用的直链（NASA 页面编辑错误，见 lib.mjs sharedGlbUrls）：逐文件标上属主
    const shared = sharedGlbUrls(entries)
    for (const e of entries) for (const g of e.glbs) {
      const x = shared.get(g.url)
      if (x) { g.sharedWith = x.users.filter((s) => s !== e.slug); g.owner = x.owner }
    }

    // 4) 对账
    const list = loadIncludeList()
    const groupOf = new Map(list.entries.map((e) => [e.slug, e]))
    const rec = reconcile(list, entries)
    const renamedTo = new Map(rec.renamed.map((x) => [x.to, x.from]))
    for (const e of entries) {
      const le = groupOf.get(e.slug) || groupOf.get(renamedTo.get(e.slug))
      e.group = le ? le.group : null
      e.include = le ? le.include : null
    }

    // 5) 与上一次 catalog.json 比（modified 增量）
    const prev = readJson(CATALOG_FILE)
    const changedSinceLast = []
    if (prev && Array.isArray(prev.entries)) {
      const pm = new Map(prev.entries.map((e) => [e.id, e]))
      for (const e of entries) {
        const p = pm.get(e.id)
        if (!p) changedSinceLast.push({ slug: e.slug, what: '新出现' })
        else if (p.modified !== e.modified) changedSinceLast.push({ slug: e.slug, what: `modified ${p.modified} → ${e.modified}` })
      }
      const now = new Set(entries.map((e) => e.id))
      for (const p of prev.entries) if (!now.has(p.id)) changedSinceLast.push({ slug: p.slug, what: '已消失' })
    }

    // 6) 汇总与落盘
    const withGlb = entries.filter((e) => e.glbs.length)
    const allFiles = withGlb.flatMap((e) => e.glbs)
    const uniqueUrls = new Set(allFiles.map((g) => g.url))
    const sized = allFiles.filter((g) => g.bytesApprox != null)
    const bySource = sized.reduce((o, g) => ((o[g.sizeSource] = (o[g.sizeSource] || 0) + 1), o), {})
    const tag3d = entries.filter((e) => e.assetTypes.includes('3d-model')).length
    const totals = {
      topics: entries.length,
      xWpTotal: total,
      tagged3dModel: tag3d,
      withGlb: withGlb.length,
      glbFiles: allFiles.length,
      uniqueGlbUrls: uniqueUrls.size,
      multiFileEntries: withGlb.filter((e) => e.glbs.length > 1).length,
      sizedFiles: sized.length,
      unsizedFiles: allFiles.length - sized.length,
      bytesApproxTotal: sized.reduce((s, g) => s + g.bytesApprox, 0),
      sizeSource: bySource
    }
    const out = {
      generated: new Date().toISOString(),
      source: `${NASA_API}topic?science-org=${NASA_ORG_3D}`,
      totals,
      taxonomies: tax,
      reconcile: rec,
      changedSinceLast: prev ? changedSinceLast : null,
      entries
    }
    await writeJsonAtomic(CATALOG_FILE, out)

    // 7) 打印
    const L = (arr, f) => arr.forEach((x) => console.log('  ' + f(x)))
    console.log('')
    console.log('── 与 include-list.json 对账 ──')
    const sec = (name, arr, f) => { console.log(`${name}：${arr.length}`); L(arr, f) }
    sec('新增条目（目录有、清单无，需人工定组）', rec.added, (x) => `+ ${x.slug}「${x.title}」 ${x.files} 个 glb ${fmtBytes(x.bytesApprox)}  [${x.assetTypes.join(',') || '无资产类型'}]`)
    sec('删除条目（清单有、目录无）', rec.removed, (x) => `- ${x.slug}「${x.title}」(${x.group}) ${x.files} 个 glb —— ${x.why}`)
    sec('改名（slug 变化）', rec.renamed, (x) => `~ ${x.from} → ${x.to}（${x.group}）「${x.titleFrom}」→「${x.titleTo}」`)
    sec('改标题', rec.titleChanged, (x) => `~ ${x.slug}「${x.from}」→「${x.to}」`)
    if (rec.titleTypography.length) console.log(`标题仅排印差异（WordPress 把「 - 」排成「 – 」之类，不计漂移）：${rec.titleTypography.length}：${rec.titleTypography.map((x) => x.slug).join(' ')}`)
    sec('文件新增（同条目多了 glb）', rec.filesAdded, (x) => `+ ${x.slug} / ${x.file} ${fmtBytes(x.bytesApprox)}`)
    sec('文件删除（同条目少了 glb）', rec.filesRemoved, (x) => `- ${x.slug} / ${x.file}`)
    sec('直链变化（同文件名换了路径）', rec.urlChanged, (x) => `~ ${x.slug} / ${x.file}：${x.from} → ${x.to}`)
    sec('体积变化', rec.sizeChanged, (x) => `~ ${x.slug} / ${x.file}：${fmtBytes(x.from)} → ${fmtBytes(x.to)}（Δ ${x.to - x.from > 0 ? '+' : ''}${fmtInt(x.to - x.from)} 字节）`)
    sec('体积补全（清单无体积、目录解析出了体积，不算漂移）', rec.sizeFilled, (x) => `· ${x.slug} / ${x.file}：${x.sizeText}（${{ title: '弹窗 title', list: '文件列表行', after: '链接后 600 字符' }[x.sizeSource]}）`)
    sec('体积缺失（清单有体积、目录解析不到）', rec.sizeLost, (x) => `· ${x.slug} / ${x.file}：清单 ${fmtBytes(x.from)}`)
    console.log('')
    console.log(`── 数据质量：跨条目共用的直链 ${shared.size} 个 ──`)
    for (const [u, x] of shared) {
      const borrowers = x.users.filter((s) => s !== x.owner)
      console.log(x.owner
        ? `  ${fileNameFromUrl(u)}：属主 ${x.owner}（${groupOf.get(x.owner)?.group ?? '未分组'}）；被借用 ${borrowers.map((s) => `${s}（${groupOf.get(s)?.group ?? '未分组'}）`).join('、')} —— fetch 默认不在借用方重复下载`
        : `  ${fileNameFromUrl(u)}：${x.users.join('、')} 共用，目录段对不上任何一个 slug，不判属主`)
    }
    const conflicts = allFiles.filter((g) => g.sizeConflict)
    if (conflicts.length) { console.log(`体积文字自相矛盾：${conflicts.length}`); L(conflicts, (g) => `! ${g.fileName}：${g.sizeConflict}`) }
    const drift = rec.added.length + rec.removed.length + rec.renamed.length + rec.titleChanged.length + rec.filesAdded.length + rec.filesRemoved.length + rec.urlChanged.length + rec.sizeChanged.length + rec.sizeLost.length
    console.log(drift ? `漂移合计 ${drift} 项（体积补全 ${rec.sizeFilled.length} 项不计）` : `无漂移（体积补全 ${rec.sizeFilled.length} 项不计）`)

    if (changedSinceLast.length) {
      console.log('')
      console.log(`── 与上次 catalog.json 相比（${prev.generated}）：${changedSinceLast.length} 条变化 ──`)
      L(changedSinceLast, (x) => `${x.slug}：${x.what}`)
    } else if (prev) console.log(`\n与上次 catalog.json（${prev.generated}）相比：条目 modified 无变化`)

    // 分组合计（按目录的当前数据；组别按清单）
    console.log('')
    console.log('── 分组合计（组别按 include-list，数字按本次目录）──')
    const rows = []
    let sumE = 0, sumF = 0, sumB = 0, sumU = 0
    const inDefault = new Set([...list.include, ...list.optional])
    const addRow = (g, label) => {
      const es = entries.filter((e) => e.group === g && e.glbs.length)
      const fs = es.flatMap((e) => e.glbs)
      const b = fs.reduce((s, x) => s + (x.bytesApprox || 0), 0)
      const u = fs.filter((x) => x.bytesApprox == null).length
      const br = es.reduce((s, e) => s + e.glbs.filter((x) => x.owner && x.owner !== e.slug).length, 0)
      rows.push([label, es.length, fs.length, br, fmtBytes(b), u])
      return { e: es.length, f: fs.length, b, u }
    }
    for (const g of list.allGroups) {
      const tag = list.include.includes(g) ? '入库' : list.optional.includes(g) ? '可选' : '排除'
      const t = addRow(g, `${g}（${tag}）`)
      if (inDefault.has(g)) { sumE += t.e; sumF += t.f; sumB += t.b; sumU += t.u }
    }
    const ug = entries.filter((e) => e.glbs.length && !e.group)
    if (ug.length) rows.push(['（未分组·新增）', ug.length, ug.reduce((s, e) => s + e.glbs.length, 0), '', fmtBytes(ug.reduce((s, e) => s + e.glbs.reduce((a, g) => a + (g.bytesApprox || 0), 0), 0)), ug.reduce((s, e) => s + e.glbs.filter((g) => g.bytesApprox == null).length, 0)])
    const sumBr = entries.filter((e) => inDefault.has(e.group)).reduce((s, e) => s + e.glbs.filter((x) => x.owner && x.owner !== e.slug).length, 0)
    rows.push(['默认下载范围（入库 + 可选七组）', sumE, sumF, sumBr, fmtBytes(sumB), sumU])
    console.log(formatTable(['分组', '条目', '文件', '其中借用', '体积（目录文字）', '缺体积'], rows))

    console.log('')
    console.log('── 全库 ──')
    console.log(`条目 ${totals.topics}（带 3d-model 标签 ${tag3d}）；带 glb 直链 ${totals.withGlb} 条、${totals.glbFiles} 个文件（去重直链 ${totals.uniqueGlbUrls}，多文件条目 ${totals.multiFileEntries}）`)
    console.log(`体积文字：${totals.sizedFiles} 个文件有、${totals.unsizedFiles} 个没有；合计约 ${fmtBytes(totals.bytesApproxTotal)}（来源：弹窗 title ${bySource.title || 0} · 文件列表行 ${bySource.list || 0} · 链接后 600 字符 ${bySource.after || 0}）`)
    console.log(`分类：资产类型 ${tax.assetType.length} · 合集 ${tax.collection.length} · 贡献者 ${tax.contributor.length} · 格式 ${tax.format.length}`)
    console.log(`已写 ${path.relative(REPO_ROOT, CATALOG_FILE).replace(/\\/g, '/')} · 用时 ${((Date.now() - t0) / 1000).toFixed(1)} s`)
    return args.strict && drift ? 2 : 0
  } finally {
    await net.close()
  }
}

// 被 import 时（单测复用 parseGlbLinks）不跑主流程
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code }, (e) => { console.error('目录拉取失败：' + ((e && e.stack) || e)); process.exitCode = 1 })
}
