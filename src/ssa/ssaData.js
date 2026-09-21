// 空间态势报告 · 数据装载 —— SATCAT 卫星编目 + GP 星历并集 + 「我的卫星组」。
//
// 两段式（与星座 3D 页的缓存优先同一口径）：
//   ① cacheOnly：各组星历与 SATCAT 全部并发取本机缓存 / 随包内置快照，有什么先用什么 —— 断网也能立刻出报告；
//   ② 后台联网版：全部落定后整批替换，只改读数，【不重排已经生成的报告】（用户再点「生成」才按新数据重算）。
// 「刷新」= force:true：清熔断、绕过「今天已完整试过直连」的记账，两份数据都硬走一遍四级链路。
// ★ 第二段一律不 await —— 联网永不阻塞界面；某组取不回来就停在第一段那份，缺几组在功能区读数里如实写出来。
//
// 内存：SATCAT 明文约 6.7 MB，解析后约 6.6 万行对象；GP 并集约 1.3 万条。全部放 shallowRef ——
// 进了响应式深代理，光是建 Proxy 就要几百毫秒，而界面一个字段都不逐行读（只读它们的条数与时间）。
import { ref, reactive, shallowRef, onBeforeUnmount } from 'vue'
import { parseOMMCsv } from '../viz/constellation/tle.js'
import { parseSatcatCsv } from '../shared/ssaStats.js'
import { byLang } from '../shared/i18n/lang.js'
import { epochMs } from '../shared/epochMs.js'

// 「我的卫星组」：星座 3D 页的组管理器写的那份（viz/constellation/useSatGroups.js）。
// 本窗口与主窗口同源，localStorage 直接读得到 —— ★ 只读、永不写回：组的真值源在 3D 页，
// 报告这边写回去等于两个窗口各改各的，后写的整份盖掉先写的。
export const SAT_GROUPS_KEY = 'constellation3d/satGroups'

// 数据来源代码（主进程 omm.fetchCsv 回的 source）→ 读数用词。取不到就不写这一段，不编。
const SRC_LABEL = {
  today: ['当日缓存', 'Today cache'],
  network: ['直连', 'Direct'],
  cloud: ['云镜像', 'Cloud mirror'],
  cache: ['本地缓存', 'Local cache'],
  bundled: ['内置快照', 'Bundled snapshot'],
  sample: ['示例', 'Sample']
}
// 来源的「新鲜度」次序：一批组各走各的链路时，读数按【最弱的一档】写 —— 取巧写成「直连」
// 会让一份大半来自内置快照的并集看着像刚下载的。
const SRC_RANK = ['network', 'today', 'cloud', 'cache', 'bundled', 'sample']
export const srcLabel = (s) => (SRC_LABEL[s] ? byLang(SRC_LABEL[s][0], SRC_LABEL[s][1]) : '')
function weakestSrc(list) {
  let out = ''
  for (const s of list) {
    if (!s) continue
    if (!out) { out = s; continue }
    const a = SRC_RANK.indexOf(s), b = SRC_RANK.indexOf(out)
    if (a > b) out = s
  }
  return out
}
// 历元时刻：同号多组取最新的那一条根数，比的是这个
const recEpochMs = (r) => { const t = epochMs(r && r.epoch); return Number.isFinite(t) ? t : -Infinity }

// 取一组 GP 星历并解析。
// ★ 没有走 tle.js 的 fetchGroupLiveOrSup：它把主进程回的 source（直连 / 云镜像 / 内置快照…）吞掉了，
//   而功能区读数「星历 10:12 · 直连 · 17/18 组」要的正是这一项；tle.js 是 3D 页的数据层、不归本模块改，
//   故照它的形状在此重写一遍 —— 同一条 IPC、同一个解析器、cacheOnly 无数据同样回 null。
async function fetchGroupCsv(api, key, opts) {
  const res = await api.omm.csv(key, opts)
  if (!res) return null                                   // cacheOnly 且本机既无缓存也无内置快照
  const text = typeof res === 'string' ? res : ((res && typeof res.text === 'string') ? res.text : '')
  if (!text) return null                                  // 未激活时 IPC 回 { locked: true }，按「没取到」办
  const sats = parseOMMCsv(text)
  if (!sats.length) return null
  return { key, sats, fetchedAt: (res && res.fetchedAt) || '', source: (res && res.source) || '' }
}

// 组键不硬编码：主进程列什么就取什么（新增一组星座，本窗口自动跟上）。
// kind==='satcat' 那一行是编目、不是星座组，拆出去单独走 api.satcat.csv。
async function groupKeys(api) {
  try {
    const list = (await api.omm.list()) || []
    return list.filter((r) => r && r.key && r.kind !== 'satcat').map((r) => r.key)
  } catch (e) { return [] }
}

// 卫星组：规范成报告模型要的形状 { id, name, color, sats:[{ id, name, missAt? }] }。
// 空组不列（选了也统计不出东西）；成员里 NORAD ≥ 900000 的合成星照样带过去 ——
// 它们在编目里查无此号，由 ssaStats.groupResolve 归到那一类并单独计数，在这里剔掉反而丢了读数。
export function readSatGroups() {
  try {
    const blob = JSON.parse(localStorage.getItem(SAT_GROUPS_KEY) || 'null')
    if (!blob || !Array.isArray(blob.items)) return []
    return blob.items.map((g) => ({
      id: (g && g.id) || '',
      name: ((g && g.name) || '').trim() || byLang('卫星组', 'Satellite Group'),
      color: (g && typeof g.color === 'string') ? g.color : '',
      sats: (((g && g.sats) || []).map((s) => {
        const id = String((s && (s.id != null ? s.id : s.noradId)) || '').trim()
        if (!id) return null
        const o = { id, name: String((s && s.name) || '').trim() }
        if (s && typeof s.missAt === 'string' && s.missAt) o.missAt = s.missAt
        return o
      }).filter(Boolean))
    })).filter((g) => g.id && g.sats.length)
  } catch (e) { return [] }                                // 隐私模式 / 坏数据：当作没有组
}

// 报告名与文件名不在这儿：它们是报告模型的一部分，由 shared/ssaReport.js 的
// ssaReportTitle / ssaReportFileName 单独出（两处各拼一遍必然漂移）。

export function useSsaData() {
  const api = (typeof window !== 'undefined' && window.api) ? window.api : null

  // —— 读数（全是运行时数据，界面直接显示）——
  const meta = reactive({
    satcatAt: '', satcatSource: '', satcatRows: 0,
    gpAt: '', gpSource: '', gpRows: 0, gpGroups: 0, gpTotal: 0
  })
  const dataAt = ref('')        // 本次数据落定的墙钟时刻：与已生成报告的 asOf 比，决定要不要提示「数据比报告新」
  const loading = ref(false)    // 第一段（本机缓存）在跑
  const busy = ref(false)       // 第二段（联网 / 刷新）在跑
  const err = ref('')
  const groups = ref(readSatGroups())

  // —— 数据本体（不进响应式深代理）——
  const satcatRaw = shallowRef(null)   // { text, fetchedAt, source }
  const gpRecs = shallowRef([])        // GP 并集
  let satcatSeq = 0                    // 明文换了一份就 +1；解析缓存按它对号，不去比 6.7 MB 的字符串
  let parsed = { seq: -1, rows: [] }

  // SATCAT 解析结果：惰性 + 按明文版本缓存（联网版到达才重解析）。
  // 约 6.6 万行、300 ms 上下 —— 放在「生成」那一步做，装载阶段不付这笔钱。
  function satcatRows() {
    const raw = satcatRaw.value
    if (!raw || !raw.text) return []
    if (parsed.seq !== satcatSeq) {
      parsed = { seq: satcatSeq, rows: parseSatcatCsv(raw.text) }
      meta.satcatRows = parsed.rows.length
    }
    return parsed.rows
  }
  const gpRecords = () => gpRecs.value

  async function loadSatcat(opts) {
    if (!api || !api.satcat || !api.satcat.csv) return false
    let res = null
    try { res = await api.satcat.csv(opts) } catch (e) { res = null }
    const text = (res && typeof res.text === 'string') ? res.text : ''
    if (!text) return false
    satcatRaw.value = { text, fetchedAt: (res && res.fetchedAt) || '', source: (res && res.source) || '' }
    satcatSeq++
    meta.satcatAt = satcatRaw.value.fetchedAt
    meta.satcatSource = satcatRaw.value.source
    meta.satcatRows = 0                                    // 条数等解析时才算得准（表头 / 空行不计）
    return true
  }

  async function loadGp(opts) {
    if (!api || !api.omm) return false
    const keys = await groupKeys(api)
    meta.gpTotal = keys.length
    if (!keys.length) return false
    const arr = await Promise.all(keys.map((k) => fetchGroupCsv(api, k, opts).catch(() => null)))
    // 并集：NORAD 去重，同号多组以【历元最新】者为准（与 3D 页的「先到先得」不同 —— 报告要的是最新根数）；
    // _group 记【首个命中组】，故归组与取根数分两张表走，换了更新的一条也不改归属。
    const recs = new Map(), groupOf = new Map()
    const ats = [], srcs = []
    let got = 0
    for (let i = 0; i < keys.length; i++) {
      const p = arr[i]
      if (!p) continue
      got++
      if (p.fetchedAt) ats.push(p.fetchedAt)
      if (p.source) srcs.push(p.source)
      for (const s of p.sats) {
        if (!groupOf.has(s.noradId)) groupOf.set(s.noradId, keys[i])
        const old = recs.get(s.noradId)
        if (!old || recEpochMs(s) > recEpochMs(old)) recs.set(s.noradId, s)
      }
    }
    if (!got) return false                                 // 一组都没取到：留着上一段那份数据，不清空
    for (const [id, s] of recs) s._group = groupOf.get(id) || ''
    gpRecs.value = [...recs.values()]
    // ★ 数据时间取【最旧】一组，不取最新：某组回落到内置快照时，拿别组的新时间去写读数就是虚报新鲜度。
    meta.gpAt = ats.length ? ats.reduce((a, b) => (b < a ? b : a)) : ''
    meta.gpSource = weakestSrc(srcs)
    meta.gpRows = gpRecs.value.length
    meta.gpGroups = got
    return true
  }

  // 一轮装载：两份数据并发。opts 直接透传给主进程（{ cacheOnly:true } / {} / { force:true }）。
  async function loadOnce(opts) {
    const [a, b] = await Promise.all([loadSatcat(opts), loadGp(opts)])
    if (a || b) dataAt.value = new Date().toISOString()
    return a || b
  }

  // 装载入口：先缓存后联网。第二段不 await（联网永不阻塞界面），失败就停在第一段那份数据上。
  async function load() {
    if (!api) { err.value = byLang('需在桌面客户端中运行', 'Desktop client required'); return }
    loading.value = true
    try { await loadOnce({ cacheOnly: true }) } catch (e) { /* 本机没数据：等第二段 */ }
    loading.value = false
    live({})
  }
  // 后台联网版
  function live(opts) {
    if (!api || busy.value) return
    busy.value = true
    err.value = ''
    loadOnce(opts)
      .then((ok) => { if (!ok && !satcatRaw.value && !gpRecs.value.length) err.value = byLang('未取到编目与星历数据', 'Catalogue and ephemeris unavailable') })
      .catch((e) => { err.value = (e && e.message) || String(e) })
      .finally(() => { busy.value = false })
  }
  // 「刷新」：硬走一遍全链路
  function refresh() { live({ force: true }) }

  // 卫星组跨窗口同步：3D 页建组 / 改名 / 删组即时反映到范围下拉（storage 事件只在别的窗口触发）。
  const onStorage = (e) => { if (e && e.key === SAT_GROUPS_KEY) groups.value = readSatGroups() }
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage)
    onBeforeUnmount(() => window.removeEventListener('storage', onStorage))
  }

  return { meta, dataAt, loading, busy, err, groups, satcatRows, gpRecords, load, refresh, reloadGroups: () => { groups.value = readSatGroups() } }
}
