// npm run nasa3d:fetch —— 按 include-list.json 把 NASA glb 原件下到 .models-src/nasa/<slug>/<原文件名>.glb（只读保存）。
//
//   node scripts/nasa3d/fetch.mjs [--groups=a,b | --all | --only=slug1,slug2 | --failed]
//                                 [--proxy=URL | --no-proxy] [--max-mb=N] [--concurrency=3]
//                                 [--source=nasa|cos] [--include-borrowed] [--dry-run]
//
//   组别      缺省 = include ∪ optional（入库五组 + crewed / launcher；2026-09-23 用户拍板七组全下）；
//             --groups 指定组；--all 连排除组（human / tool / facility / aircraft / body / robot / unclassified）一起下；
//             --only 按 slug 挑条目（不看组别）；--failed 只重跑 .models-src/fetch-failures.json 里记着的文件。
//   网络      --proxy 显式代理 > 环境变量 HTTPS_PROXY / HTTP_PROXY > 直连；--no-proxy 强制直连（lib.mjs createNet）。
//   来源      --source=nasa（缺省，assets.science.nasa.gov）；--source=cos 走本桶镜像 updates/models/src/nasa/<slug>/<文件>，
//             镜像还没发布时第一条探针就会报 404 并退出（退出码 2），不会刷一屏失败。
//   顺序      先 < 5 MB，再 5–20 MB，最后 > 20 MB（ISS IGOAL 91 MB、Gateway 63 MB 垫底）；同档内入库组先于可选组先于排除组，再按体积升序。
//             体积先取清单的 bytesApprox，缺了取 catalog.json 解析出的体积，都没有按 5–20 MB 档排在该档末尾。
//   校验      Range 续传（.part）；长度只认服务器的 Content-Length / Content-Range；落盘后写 <文件>.sha256 旁车并置只读。
//             已有文件且旁车 sha256 与实算一致 → 跳过；旁车缺失或不一致 → 当损坏处理，删掉重下。
//   借用直链  NASA 有几个页面的下载链接指向别的条目的文件（rosetta 等 → IBEX，aqua-a 的第二个文件 → Aquarius (A)）。
//             缺省不在借用方重复下载，只在借用方的 meta.json 里记 borrowed；--include-borrowed 照下。
//   失败      逐文件指数退避 5 次；最终失败写 .models-src/fetch-failures.json（与已有清单合并），重跑本命令或加 --failed 补齐。
//   Ctrl+C    停止派发，进行中的文件保留 .part，重跑续传；再按一次立即退出。
//   退出码    0 全部就绪 / 1 有失败 / 2 参数或来源不可用 / 130 被中断。
import fs from 'node:fs'
import path from 'node:path'
import {
  parseArgs, createNet, downloadWithResume, verifyExisting, forceRemove, readSidecar, statSize,
  loadIncludeList, readJson, writeJsonAtomic, canonicalUrl, encodeUrl, fileNameFromUrl, slugDir,
  sharedGlbUrls, borrowedOwner, fmtBytes, fmtSec, formatTable, httpError,
  CATALOG_FILE, FAILURES_FILE, NASA_DIR, COS_NASA_SRC_BASE, REPO_ROOT, MiB
} from './lib.mjs'

const SPEC = {
  groups: 'list', all: 'bool', only: 'list', failed: 'bool',
  proxy: 'string', 'no-proxy': 'bool', 'max-mb': 'number', concurrency: 'int',
  source: 'string', 'include-borrowed': 'bool', 'dry-run': 'bool', help: 'bool'
}
const HEARTBEAT_MS = 15000
const rel = (p) => path.relative(REPO_ROOT, p).replace(/\\/g, '/')
const BUCKET_NAME = ['< 5 MB', '5–20 MB', '> 20 MB']
const bucketOf = (b) => (b == null ? 1 : b < 5 * MiB ? 0 : b <= 20 * MiB ? 1 : 2)

function usage() {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'))
}

// ───────────────────────── 计划 ─────────────────────────

function buildPlan(args, list, catalog) {
  const catBySlug = new Map(((catalog && catalog.entries) || []).map((e) => [e.slug, e]))
  const shared = sharedGlbUrls(list.entries)
  const bySlug = new Map(list.entries.map((e) => [e.slug, e]))
  let entries, scope

  if (args.failed) {
    const fl = readJson(FAILURES_FILE, { failures: [] })
    const keys = new Set((fl.failures || []).map((f) => `${f.slug}/${f.file}`))
    if (!keys.size) return { entries: [], files: [], scope: '失败清单为空', groups: [] }
    entries = [...new Set((fl.failures || []).map((f) => f.slug))].map((s) => bySlug.get(s)).filter(Boolean)
    scope = `失败清单（${keys.size} 个文件）`
    const files = planFiles(entries, args, catBySlug, shared, list).filter((f) => keys.has(`${f.slug}/${f.fileName}`))
    return { entries, files, scope, groups: [...new Set(entries.map((e) => e.group))] }
  }
  if (args.only) {
    if (args.groups || args.all) throw new Error('--only 与 --groups / --all 不能同时用')
    const unknown = args.only.filter((s) => !bySlug.has(s))
    if (unknown.length) throw new Error(`--only 里有清单中不存在的 slug：${unknown.join(', ')}`)
    entries = args.only.map((s) => bySlug.get(s))
    scope = `--only ${args.only.length} 条`
  } else {
    let groups
    if (args.all) { groups = list.allGroups; scope = '--all 全部分组' }
    else if (args.groups) {
      const bad = args.groups.filter((g) => !list.allGroups.includes(g))
      if (bad.length) throw new Error(`--groups 里有不存在的组：${bad.join(', ')}（可选：${list.allGroups.join(', ')}）`)
      groups = args.groups; scope = `--groups ${groups.join(',')}`
    } else { groups = [...list.include, ...list.optional]; scope = `缺省七组（入库 ${list.include.join(',')} + 可选 ${list.optional.join(',')}）` }
    entries = list.entries.filter((e) => groups.includes(e.group))
  }
  return { entries, files: planFiles(entries, args, catBySlug, shared, list), scope, groups: [...new Set(entries.map((e) => e.group))] }
}

function planFiles(entries, args, catBySlug, shared, list) {
  const rankOf = (g) => (list.include.includes(g) ? 0 : list.optional.includes(g) ? 1 : 2)
  const files = []
  const seenDest = new Map()
  for (const e of entries) {
    const cat = catBySlug.get(e.slug)
    for (const g of e.glbs) {
      const url = canonicalUrl(g.url)
      const fileName = fileNameFromUrl(url)
      const dest = path.join(slugDir(e.slug), fileName)
      if (seenDest.has(dest.toLowerCase())) throw new Error(`两个直链落到同一个本机文件：${rel(dest)}（${seenDest.get(dest.toLowerCase())} / ${url}）`)
      seenDest.set(dest.toLowerCase(), url)
      const catG = cat && cat.glbs.find((x) => x.url === url)
      const approx = g.bytesApprox ?? (catG ? catG.bytesApprox : null) ?? null
      const owner = borrowedOwner(shared, e.slug, url)
      const src = args.source === 'cos' ? `${COS_NASA_SRC_BASE}${e.slug}/${fileName}` : url
      files.push({ slug: e.slug, entry: e, group: e.group, url, src, fileName, dest, approx, owner, bucket: bucketOf(approx), rank: rankOf(e.group) })
    }
  }
  // > 20 MB 档不分组别、纯按体积升序，保证 ISS IGOAL / Gateway 两个大件垫底
  files.sort((a, b) => a.bucket - b.bucket || (a.bucket === 2 ? 0 : a.rank - b.rank) || (a.approx ?? Infinity) - (b.approx ?? Infinity) || a.slug.localeCompare(b.slug) || a.fileName.localeCompare(b.fileName))
  return files
}

// ───────────────────────── meta.json ─────────────────────────

async function writeMeta(entry, results, catalog) {
  const dir = slugDir(entry.slug)
  const metaFile = path.join(dir, 'meta.json')
  const old = readJson(metaFile, {})
  const byFile = new Map((old.files || []).map((f) => [f.file, f]))
  const borrowed = new Map((old.borrowed || []).map((b) => [b.file, b]))
  for (const r of results) {
    if (r.state === 'downloaded') byFile.set(r.fileName, r.record)
    else if (r.state === 'existing') {
      const prev = byFile.get(r.fileName)
      byFile.set(r.fileName, prev && prev.sha256 === r.record.sha256 ? { ...prev, url: r.url } : r.record)
    } else if (r.state === 'borrowed') { borrowed.set(r.fileName, { file: r.fileName, url: r.url, owner: r.owner }); byFile.delete(r.fileName) }
  }
  // 只留磁盘上真有的文件
  const files = []
  for (const f of byFile.values()) if ((await statSize(path.join(dir, f.file))) >= 0) files.push(f)
  files.sort((a, b) => a.file.localeCompare(b.file))
  if (!files.length && !borrowed.size) return
  const cat = catalog && catalog.entries ? catalog.entries.find((e) => e.slug === entry.slug) : null
  const fetchedAt = files.map((f) => f.fetchedAt).filter(Boolean).sort().pop() || null
  const meta = {
    ...(cat ? { id: cat.id } : {}),
    slug: entry.slug,
    title: entry.title,
    group: entry.group,
    include: entry.include,
    ...(cat && cat.link ? { page: cat.link } : {}),
    ...(cat && cat.modified ? { modified: cat.modified } : {}),
    ...(cat && cat.contributors && cat.contributors.length ? { contributors: cat.contributors } : {}),
    urls: files.map((f) => f.url),
    files,
    ...(borrowed.size ? { borrowed: [...borrowed.values()] } : {}),
    bytes: files.reduce((s, f) => s + (f.bytes || 0), 0),
    fetchedAt
  }
  await fs.promises.mkdir(dir, { recursive: true })
  await writeJsonAtomic(metaFile, meta)
}

// ───────────────────────── 主流程 ─────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2), SPEC)
  if (args.help) { usage(); return 0 }
  if (args.source && !['nasa', 'cos'].includes(args.source)) throw new Error(`--source 只能是 nasa 或 cos，收到「${args.source}」`)
  args.source = args.source || 'nasa'
  const conc = args.concurrency ?? 3
  if (conc < 1 || conc > 16) throw new Error('--concurrency 取 1–16')
  const maxBytes = args.maxMb != null ? Math.round(args.maxMb * MiB) : null
  if (maxBytes != null && maxBytes <= 0) throw new Error('--max-mb 须为正数')

  const list = loadIncludeList()
  const catalog = readJson(CATALOG_FILE)
  const plan = buildPlan(args, list, catalog)
  const net = createNet({ proxy: args.proxy, noProxy: args.noProxy })
  const t0 = Date.now()

  const results = []
  const bumpState = (f, state, extra = {}) => { const r = { ...f, state, ...extra }; results.push(r); return r }
  const planned = plan.files.map((f) => {
    if (f.owner && !args.includeBorrowed) return { f, pre: 'borrowed' }
    if (maxBytes != null && f.approx != null && f.approx > maxBytes) return { f, pre: 'tooLarge' }
    return { f, pre: null }
  })
  const queue = planned.filter((x) => !x.pre).map((x) => x.f)
  const qBytes = queue.reduce((s, f) => s + (f.approx || 0), 0)

  console.log(`NASA glb 原件 → ${rel(NASA_DIR)}/<slug>/`)
  console.log(`范围：${plan.scope}；${plan.entries.length} 条、${plan.files.length} 个文件（排队 ${queue.length}，约 ${fmtBytes(qBytes)}；借用跳过 ${planned.filter((x) => x.pre === 'borrowed').length}；超 --max-mb 跳过 ${planned.filter((x) => x.pre === 'tooLarge').length}）`)
  console.log(`来源：${args.source === 'cos' ? 'COS 镜像 ' + COS_NASA_SRC_BASE : 'assets.science.nasa.gov'} · 网络：${net.via} · 并发 ${conc}${maxBytes ? ` · 上限 ${args.maxMb} MB` : ''}${catalog ? '' : ' · 未找到 catalog.json（id / modified 不进 meta.json，先跑 nasa3d:catalog 可补）'}`)

  if (args.dryRun) {
    const rows = planned.map(({ f, pre }, i) => [i + 1, BUCKET_NAME[f.bucket], f.group, `${f.slug}/${f.fileName}`, fmtBytes(f.approx), pre === 'borrowed' ? `借用 → ${f.owner}` : pre === 'tooLarge' ? '超限' : (readSidecar(f.dest) ? '已有' : '排队')])
    console.log(formatTable(['#', '档', '分组', '文件', '体积', '状态'], rows, ['r', 'l', 'l', 'l', 'r', 'l']))
    await net.close()
    return 0
  }
  if (!plan.files.length) { console.log('没有要处理的文件。'); await net.close(); return 0 }

  // COS 镜像探针：第一条 404 / 403 直接退出，不刷一屏失败
  if (args.source === 'cos' && queue.length) {
    const probe = queue[0]
    try {
      const res = await net.fetch(encodeUrl(probe.src), { method: 'HEAD' })
      if (res.status === 404) { console.error(`COS 镜像里没有 ${probe.slug}/${probe.fileName}（HTTP 404）：镜像 updates/models/src/nasa/ 尚未发布。改用 --source=nasa。`); await net.close(); return 2 }
      if (res.status === 403) { console.error(`COS 拒绝访问（HTTP 403）：${encodeUrl(probe.src)}。桶策略未放行 updates/models/src/* 的公有读。`); await net.close(); return 2 }
      if (!res.ok) throw httpError(res.status)
    } catch (e) {
      console.error(`COS 镜像探针失败：${e.message}`); await net.close(); return 2
    }
  }

  // Ctrl+C：停止派发，进行中的保留 .part
  const ac = new AbortController()
  let interrupted = false
  const onSigint = () => {
    if (interrupted) process.exit(130)
    interrupted = true
    console.log('\n收到中断：不再派发新文件，进行中的保留 .part，重跑即续传（再按一次立即退出）')
    ac.abort()
  }
  process.on('SIGINT', onSigint)

  for (const { f, pre } of planned) {
    if (pre === 'borrowed') bumpState(f, 'borrowed')
    else if (pre === 'tooLarge') bumpState(f, 'tooLarge')
  }
  const total = plan.files.length
  let done = 0
  let bytesThisRun = 0
  const active = new Map()
  const tag = () => `[${String(++done).padStart(String(total).length)}/${total}]`
  for (const r of results) {
    if (r.state === 'borrowed') console.log(`${tag()} 借用  ${r.slug}/${r.fileName} → 属主 ${r.owner}，不重复下载`)
    else console.log(`${tag()} 超限  ${r.slug}/${r.fileName} ${fmtBytes(r.approx)}（--max-mb ${args.maxMb}）`)
  }

  // 条目收尾：该条目的文件全部有结果就写 meta.json
  const pendingBySlug = new Map()
  for (const f of plan.files) pendingBySlug.set(f.slug, (pendingBySlug.get(f.slug) || 0) + 1)
  const metaWritten = new Set()
  const settle = async (slug) => {
    const n = pendingBySlug.get(slug) - 1
    pendingBySlug.set(slug, n)
    if (n === 0 && !metaWritten.has(slug)) {
      metaWritten.add(slug)
      await writeMeta(plan.entries.find((e) => e.slug === slug), results.filter((r) => r.slug === slug), catalog).catch((e) => console.warn(`  ！写 ${slug}/meta.json 失败：${e.message}`))
    }
  }
  for (const r of [...results]) await settle(r.slug)

  const hb = setInterval(() => {
    if (!active.size) return
    const el = (Date.now() - t0) / 1000
    const cur = [...active.values()].map((a) => `${a.f.slug}/${a.f.fileName} ${a.total ? Math.floor((a.got / a.total) * 100) + '%' : fmtBytes(a.got)}`).join(' · ')
    console.log(`  … 进行中：${cur}；本次已收 ${fmtBytes(bytesThisRun + [...active.values()].reduce((s, a) => s + a.got - a.from, 0))}，均速 ${fmtBytes(bytesThisRun / Math.max(el, 1))}/s`)
  }, HEARTBEAT_MS)

  let qi = 0
  const worker = async () => {
    while (!ac.signal.aborted && qi < queue.length) {
      const f = queue[qi++]
      const st = Date.now()
      try {
        const ex = await verifyExisting(f.dest)
        if (ex.state === 'ok') {
          bumpState(f, 'existing', { record: { file: f.fileName, url: f.url, bytes: ex.bytes, sha256: ex.sha256 }, bytes: ex.bytes })
          console.log(`${tag()} 已有  ${f.slug}/${f.fileName} ${fmtBytes(ex.bytes)}（sha256 核对一致）`)
          continue
        }
        if (ex.state === 'nosidecar' || ex.state === 'mismatch') {
          console.warn(`  ！${f.slug}/${f.fileName} ${ex.state === 'nosidecar' ? '缺 .sha256 旁车' : 'sha256 与旁车不一致'}，按损坏处理，删掉重下`)
          await forceRemove(f.dest)
          await forceRemove(f.dest + '.sha256')
        }
        const a = { f, got: 0, total: null, from: 0 }
        active.set(f.dest, a)
        const r = await downloadWithResume(f.src, f.dest, {
          net, signal: ac.signal, maxBytes, tries: 5,
          onResponse: ({ total: t, resumedFrom }) => { a.total = t; a.from = resumedFrom; a.got = resumedFrom },
          onProgress: (got) => { a.got = got },
          onRetry: (e, i, w) => console.warn(`  重试 ${f.slug}/${f.fileName}：第 ${i} 次失败（${e.message}），${(w / 1000).toFixed(1)} s 后再试`)
        })
        active.delete(f.dest)
        const got = r.bytes - r.resumedFrom
        bytesThisRun += got
        const ms = Date.now() - st
        const record = {
          file: f.fileName, url: f.url, bytes: r.bytes, sha256: r.sha256,
          contentLength: r.total, lengthVerified: r.lengthVerified,
          ...(r.etag ? { etag: r.etag } : {}), ...(r.lastModified ? { lastModified: r.lastModified } : {}),
          fetchedAt: new Date().toISOString(), fetchedFrom: args.source
        }
        bumpState(f, 'downloaded', { record, bytes: r.bytes, got })
        const dev = f.approx ? Math.abs(r.bytes - f.approx) / f.approx : 0
        console.log(`${tag()} 下载  ${f.slug}/${f.fileName} ${fmtBytes(r.bytes)} ${fmtSec(ms)}` +
          (got ? ` ${fmtBytes(got / Math.max(ms / 1000, 0.001))}/s` : '') +
          (r.resumedFrom ? (got ? `（续传自 ${fmtBytes(r.resumedFrom)}）` : '（.part 上次已收齐，本次只做校验收尾）') : '') +
          (r.lengthVerified ? '' : '（！服务器没给长度，未能按 Content-Length 校验）') +
          (dev > 0.05 ? `（与目录体积 ${fmtBytes(f.approx)} 相差 ${(dev * 100).toFixed(0)}%）` : ''))
      } catch (e) {
        active.delete(f.dest)
        if (e && e.code === 'TOO_LARGE') {
          bumpState(f, 'tooLarge', { approx: e.total })
          console.log(`${tag()} 超限  ${f.slug}/${f.fileName} ${fmtBytes(e.total)}（--max-mb ${args.maxMb}）`)
        } else if (ac.signal.aborted || (e && e.aborted)) {
          bumpState(f, 'interrupted', { error: '中断', attempts: e.attempts || 0 })
          console.log(`${tag()} 中断  ${f.slug}/${f.fileName}（.part 保留）`)
        } else {
          const msg = (e && e.status === 404 && args.source === 'cos') ? 'COS 镜像缺此文件（HTTP 404）' : (e && e.message) || String(e)
          bumpState(f, 'failed', { error: msg, status: e && e.status, attempts: (e && e.attempts) || 1 })
          console.log(`${tag()} 失败  ${f.slug}/${f.fileName}：${msg}（尝试 ${(e && e.attempts) || 1} 次）`)
        }
      } finally {
        await settle(f.slug)
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(conc, queue.length || 1) }, worker))
  } finally {
    clearInterval(hb)
    process.off('SIGINT', onSigint)
    await net.close()
  }
  // 被中断时没轮到的文件也记一笔「中断」，写各自已完成条目的 meta.json
  if (qi < queue.length) {
    for (const f of queue.slice(qi)) { bumpState(f, 'interrupted', { error: '中断（未开始）', attempts: 0 }); await settle(f.slug) }
  }

  // 失败清单：与已有清单合并（本次处理过的文件先剔掉，再加本次失败 / 中断的）
  const old = readJson(FAILURES_FILE, { failures: [] })
  const touched = new Set(results.map((r) => `${r.slug}/${r.fileName}`))
  const failures = (old.failures || []).filter((x) => !touched.has(`${x.slug}/${x.file}`))
  for (const r of results) {
    if (r.state === 'failed' || r.state === 'interrupted') {
      failures.push({ slug: r.slug, file: r.fileName, url: r.url, group: r.group, error: r.error, ...(r.status ? { status: r.status } : {}), attempts: r.attempts, ...(r.state === 'interrupted' ? { interrupted: true } : {}), at: new Date().toISOString() })
    }
  }
  await writeJsonAtomic(FAILURES_FILE, { generated: new Date().toISOString(), failures })

  // 汇总表
  const order = list.allGroups.filter((g) => plan.groups.includes(g))
  const rows = []
  const sum = { e: 0, f: 0, ready: 0, dl: 0, ex: 0, br: 0, tl: 0, fail: 0, bytes: 0 }
  for (const g of order) {
    const rs = results.filter((r) => r.group === g)
    const c = {
      e: plan.entries.filter((e) => e.group === g).length,
      f: plan.files.filter((f) => f.group === g).length,
      dl: rs.filter((r) => r.state === 'downloaded').length,
      ex: rs.filter((r) => r.state === 'existing').length,
      br: rs.filter((r) => r.state === 'borrowed').length,
      tl: rs.filter((r) => r.state === 'tooLarge').length,
      fail: rs.filter((r) => r.state === 'failed' || r.state === 'interrupted').length,
      bytes: rs.filter((r) => r.state === 'downloaded' || r.state === 'existing').reduce((s, r) => s + (r.bytes || 0), 0)
    }
    c.ready = c.dl + c.ex
    for (const k of Object.keys(sum)) sum[k] += c[k]
    const tagG = list.include.includes(g) ? '入库' : list.optional.includes(g) ? '可选' : '排除'
    rows.push([`${g}（${tagG}）`, c.e, c.f, c.ready, c.dl, c.ex, c.br, c.tl, c.fail, fmtBytes(c.bytes)])
  }
  rows.push(['合计', sum.e, sum.f, sum.ready, sum.dl, sum.ex, sum.br, sum.tl, sum.fail, fmtBytes(sum.bytes)])
  console.log('')
  console.log(formatTable(['分组', '条目', '文件', '就绪', '本次下载', '已有', '借用', '超限', '失败', '就绪字节'], rows))

  const readyRs = results.filter((r) => r.state === 'downloaded' || r.state === 'existing')
  const sideOk = readyRs.filter((r) => readSidecar(r.dest)).length
  const el = Date.now() - t0
  console.log(`本次收 ${fmtBytes(bytesThisRun)} · 用时 ${fmtSec(el)} · 均速 ${fmtBytes(bytesThisRun / Math.max(el / 1000, 0.001))}/s · sha256 旁车 ${sideOk}/${readyRs.length}`)
  console.log(failures.length
    ? `失败清单 ${rel(FAILURES_FILE)}：${failures.length} 个文件（重跑本命令续传，或加 --failed 只补这些）`
    : `失败清单为空（${rel(FAILURES_FILE)}）`)
  if (interrupted) return 130
  return sum.fail ? 1 : 0
}

main().then((code) => { process.exitCode = code }, (e) => { console.error('下载中止：' + ((e && e.message) || e)); process.exitCode = 2 })
