// 性能指标表窗口的宿主端（3D 页那一侧）：开窗、推状态、收操作。
//
// 三张表（对地 ground / 对星 shell / 气象 met）的界面都在独立窗口（src/perf/*），数据与取值留在本页：
//   · 对地：城市列表 / 选项 / 城市组由弹窗编辑后整份发回，这里落进 perf 的持久化桶并按天线取值（computeRows），
//     行推回去；同一份城市与设置再算出地图上的指向误差框（cityBoxes）喂给两个渲染器。
//     ★ 城市层画不画由树里「性能指标表」行的眼睛（opts.cityShow，出厂关）决定，与窗口开没开无关：窗口只是编辑器，
//       关掉窗口标记还在；眼睛关了才清。眼睛关着的天线也不会为了画层去载方向图。
//   · 对星：目标星名单 / 选项 / 时窗参数的操作发回，取值（瞬时 / 时段扫描 / 游标）都在 satPerf 的逐 key 会话里跑；
//     会话的每个字段各设 watcher，变了就推。
//   · 气象：站点列表由弹窗编辑后整份发回 envLive.sites；读数随时钟由 envLive 自己刷，装配成快照推过去。
// 主进程只中继（electron/main.js 的 perfWin）；推过去的一律是纯数据（JSON 克隆），响应式代理过不了 IPC。
import { ref, watch, nextTick } from 'vue'
import { cityLabelText } from './usePerfTable.js'
import { cityBoxItems } from './cityBoxes.js'
import { perfGeomOf, pointingSig } from './useSatPerfTable.js'
import { byLang } from '../../shared/i18n/lang.js'
// 相对路径（不走 @core 别名）：perfCityLayer 单测在 node 里直接 import 本文件
import { trajWaypointInfo } from '../../../packages/core/models/trajKinematics.mjs'

const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)))

export function createPerfWinHost(D) {
  const api = D.api || null
  const wins = new Map()           // id → { id, kind, key, ready, stops: [] }
  const ver = ref(0)               // 开关窗计数（供依赖「哪些窗开着」的 computed / watcher）
  const has = () => !!api

  // ---------- 推送（按窗合帧：一拍里改了好几个字段只发一次） ----------
  const queue = new Map()          // id → patch
  let flushTimer = 0
  function push(id, patch) {
    if (!api) return
    const w = wins.get(id); if (!w || !w.ready) return
    const cur = queue.get(id) || {}
    for (const k of Object.keys(patch)) cur[k] = patch[k]
    queue.set(id, cur)
    if (!flushTimer) flushTimer = setTimeout(flush, 0)
  }
  function flush() {
    flushTimer = 0
    for (const [id, patch] of queue) {
      queue.delete(id)
      if (!wins.has(id)) continue
      let p
      try { p = plain(patch) } catch { continue }
      api.push(id, { type: 'state', patch: p }).catch(() => {})
    }
  }
  function reply(id, reqId, result, error) { if (api && reqId) api.push(id, { type: 'reply', reqId, result: plain(result), error: error || null }).catch(() => {}) }

  // ---------- 标题 ----------
  function antOf(key) {
    const [folder, ant] = String(key || '').split('|')
    const node = (D.grd.sats.value || []).find((x) => x.folder === folder)
    return { satName: node ? node.satName : folder, antName: ant || '' }
  }
  function titleOf(kind, key) {
    if (kind === 'met') return byLang('气象指标表', 'Meteorological Table')
    const a = antOf(key)
    const head = kind === 'shell' ? byLang('对星性能指标表', 'Sat-to-Sat Performance Table') : byLang('性能指标表', 'Performance Table')
    return `${head} · ${a.satName} / ${a.antName}`
  }

  // ---------- 开窗 / 关窗 ----------
  const keysOf = (kind) => { const out = []; for (const w of wins.values()) if (w.kind === kind) out.push(w.key); return out }
  const groundKeys = () => keysOf('ground')
  const shellKeys = () => keysOf('shell')
  // 地图上要画城市层的天线：表里有城市 且 眼睛开着（不看窗口）。这些天线的星位也要随时钟走（进 liveKeys）
  function boxKeys() {
    const out = []
    const sb = D.perf.stationsByAnt.value || {}
    for (const k of Object.keys(sb)) if (sb[k] && sb[k].length && D.perf.cityShowOf(k)) out.push(k)
    return out
  }
  const liveKeys = () => { const s = new Set([...groundKeys(), ...shellKeys(), ...boxKeys()]); return [...s] }
  const winsOf = (kind, key) => { const out = []; for (const w of wins.values()) if (w.kind === kind && (key == null || w.key === key)) out.push(w); return out }
  const metOpen = () => winsOf('met').length > 0
  async function open(kind, key) {
    if (!api) return null
    const k = String(key || '')
    let r = null
    try { r = await api.open({ kind, key: k, title: titleOf(kind, k) }) } catch { r = null }
    if (!r || !r.id) return null
    if (!wins.has(r.id)) { wins.set(r.id, { id: r.id, kind, key: k, ready: false, stops: [] }); ver.value++ }
    return r.id
  }
  function isOpen(kind, key) { return winsOf(kind, key).length > 0 }
  function closeKey(key) { for (const w of [...wins.values()]) if (w.key === key && api) api.close(w.id).catch(() => {}) }
  function dropWin(id) {
    const w = wins.get(id); if (!w) return
    for (const s of w.stops) { try { s() } catch { /* 已停 */ } }
    wins.delete(id)
    queue.delete(id)
    if (w.kind === 'shell') D.satPerf.dropSession(w.key)
    ver.value++
  }
  // 树改名 / 删天线：窗口跟着改标题或关掉（perf / satPerf 的桶由各自 key 记着，改名后按新 key 走）
  function onTreeKey(ev) {
    if (!ev) return
    if (ev.type === 'remove') for (const k of (ev.keys || [])) closeKey(k)
    else if (ev.type === 'rename') {
      const mv = (o) => { if (o.value[ev.from] && !o.value[ev.to]) { const m = { ...o.value }; m[ev.to] = m[ev.from]; delete m[ev.from]; o.value = m } }
      mv(D.perf.stationsByAnt); mv(D.perf.optsByAnt)
      D.satPerf.renameKey(ev.from, ev.to)   // 名单 / 来源档 / 选项 / 时窗 / 运行中的会话一起搬（先搬，下面重绑要按新 key 取会话）
      for (const w of wins.values()) {
        if (w.key !== ev.from) continue
        w.key = ev.to
        if (api) api.setTitle(w.id, titleOf(w.kind, w.key)).catch(() => {})
        if (!w.ready) continue
        // 对星窗的 watcher 闭包里钉着旧 key（shellSnapLight(key) / session(key)）：停掉、按新 key 重绑，再整份重推
        if (w.kind === 'shell') { for (const s of w.stops) { try { s() } catch { /* 已停 */ } } w.stops = []; bindShell(w); pushShellFull(w) }
        else if (w.kind === 'ground') pushGroundFull(w)
      }
    }
    pushBoxes()   // 删天线：它的层随之消失；改名：桶换了键，按新键重画
  }

  // ---------- 对地 ----------
  function markersSnap() {
    const M = D.markers() || {}
    const fmt = D.fmtLL
    return {
      pts: (M.pts || []).map((p, i) => ({ id: p.id, seq: i + 1, name: fmt(Number(p.lon) || 0, Number(p.lat) || 0), lon: p.lon, lat: p.lat })),
      sts: (M.sts || []).map((s, i) => ({ id: s.id, seq: i + 1, name: s.name || '', ll: fmt(Number(s.lon) || 0, Number(s.lat) || 0), lon: s.lon, lat: s.lat })),
      trajs: (M.trs || []).map((t) => ({ id: t.id, name: t.name || '', kind: t.kind || 'sea', n: (t.pts || []).length }))
    }
  }
  function groundCtxSnap(key) {
    const ctx = D.grd.getPerfContext(key)
    if (!ctx) return { ctx: null, ctxBeams: [] }
    return {
      ctx: { key, satName: ctx.satName, antName: ctx.antName, beams: ctx.beams.length, satNo: ctx.satNo, antNo: ctx.antNo },
      ctxBeams: ctx.beams.map((b) => ({ bi: b.bi, seq: b.seq || b.bi + 1, name: b.name, peakDb: b.peakDb }))
    }
  }
  // 带时刻的城市行按那一刻取值：源星沿星历走到那一刻、指向按各自语义重算（与对星表时段扫描同一套 perfGeomOf）。
  // 没有带时刻的行 / 宿主没给星历钩子 → null（时刻只作一列读数，取值照当前时刻）
  // 返回 { at, fp }：at 懒建几何（缓存全命中时一次星历都不解），fp＝带时刻行取值的全部输入指纹
  // （时钟不在里面：带时刻行的值只看自己那一刻）。
  function ctxAtOf(ctx, stations) {
    if (!ctx || ctx.noEph || !ctx.meta || typeof D.perfGeomEnv !== 'function' || typeof D.satcovTimes !== 'function') return null
    if (!(stations || []).some((s) => Number.isFinite(s.tMs))) return null
    let env = null, times = null
    try { env = D.perfGeomEnv(ctx) || {}; times = D.satcovTimes() } catch { return null }
    let geom = null, bad = false
    const at = (tMs) => {
      if (!geom && !bad) { try { geom = perfGeomOf(ctx, times, env) } catch { bad = true } }
      if (!geom) return null
      const m = geom.srcMetaAt(tMs)
      return m ? { basis: geom.basisAt(tMs, m), meta: m } : null
    }
    return { at, fp: groundFp(ctx, D.perf.getOpts(ctx.key), env, times) }
  }
  // 对象身份编号（星历 / 方向图网格按引用认：内容一换就是新对象）
  const _oid = new WeakMap(); let _oidSeq = 0
  const oid = (o) => { if (!o || (typeof o !== 'object' && typeof o !== 'function')) return 0; let i = _oid.get(o); if (!i) { i = ++_oidSeq; _oid.set(o, i) } return i }
  function groundFp(ctx, opts, env, times) {
    const src = env.srcRec || null, bore = env.boreRec || null, m = ctx.meta
    const cc = (src && src._cc) || (bore && bore._cc)
    const ccOff = cc && times && times.ccNow && times.now ? times.ccNow.getTime() - times.now.getTime() : 0
    let sig = null
    try { sig = pointingSig(ctx.settings, m) } catch { sig = null }
    try {
      return JSON.stringify([
        ctx.key, ctx.anRev || 0, ctx.satNo, ctx.antNo, ctx.satName, ctx.antName, oid(ctx.igrid), oid(ctx.icomp),
        ctx.beams.map((b) => b.bi + ':' + oid(b.beam) + ':' + (b.seq || '')), ctx.settings, sig, opts,
        oid(src && src.rec), src ? 0 : [m.satLon, m.satLat, m.satAlt], oid(bore && bore.rec), ccOff
      ])
    } catch { return null }   // 设置里有拼不成 JSON 的东西 → 不缓存（每拍照旧全算）
  }
  const _groundCache = new Map()   // key → { fp, map }：带时刻行的取值缓存（见 usePerfTable.computeRows 的 cache 参数）
  function refreshGround(key) {
    const list = winsOf('ground', key)
    if (!list.length) { _groundCache.delete(key); return }
    const ctx = D.grd.getPerfContext(key)
    const opts = D.perf.getOpts(key)
    const stations = D.perf.stationsOf(key)
    const ca = ctxAtOf(ctx, stations)
    let cache = null
    if (ca && ca.fp) {
      cache = _groundCache.get(key)
      if (!cache || cache.fp !== ca.fp) { cache = { fp: ca.fp, map: new Map() }; _groundCache.set(key, cache) }
    } else _groundCache.delete(key)
    const r = D.perf.computeRows(ctx, opts, stations, ca ? ca.at : null, cache)
    const snap = groundCtxSnap(key)
    for (const w of list) push(w.id, { rows: r.rows, ctx: snap.ctx, ctxBeams: snap.ctxBeams, stamp: D.timeLabel(), tzMode: D.tzMode() })
  }
  function pushGroundFull(w) {
    const key = w.key
    const snap = groundCtxSnap(key)
    push(w.id, {
      ...snap,
      stations: D.perf.stationsOf(key),
      opts: D.perf.getOpts(key),
      cityGroups: D.perf.cityGroups.value,
      markers: markersSnap(),
      stamp: D.timeLabel(),
      tzMode: D.tzMode()
    })
    refreshGround(key)
    pushBoxes()
  }
  // 地图上的城市层：每根眼睛开着、表里有城市的天线一层（这张表的城市 × 这根天线此刻的基底）。
  // 天线还没载入（没显示过覆盖、也没开过表）就先载一次再画；载不到（已删 / 文件缺）只试一次。
  let _boxT = 0
  // 载入失败的天线记在 _loadFailed，只在「树变了」（GRD 索引载完 / 加天线 / 改名）或用户再开眼睛时清掉重试：
  // 启动时城市桶比 GRD 索引先恢复，第一次 ensureAntLoaded 必然查不到天线 —— 09-15 版记成「试过一次」就永不再试，
  // 表现为重启后眼睛开着也不上图、再点眼睛也没用（用户 09-16 报）。_loading 防同一根天线并发重复载。
  const _loadFailed = new Set(), _loading = new Set()
  function pushBoxes() {
    if (_boxT) return
    _boxT = setTimeout(() => {
      _boxT = 0
      const layers = []
      for (const key of boxKeys()) {
        const o = D.perf.getOpts(key)
        if (!o || (o.cityMarkOn === false && o.cityLabelOn === false)) continue
        const ctx = D.grd.getPerfContext(key)
        if (!ctx) {
          if (!_loadFailed.has(key) && !_loading.has(key) && typeof D.grd.ensureAntLoaded === 'function') {
            _loading.add(key)
            Promise.resolve(D.grd.ensureAntLoaded(key)).then((ok) => { if (ok) pushBoxes(); else _loadFailed.add(key) }, () => _loadFailed.add(key)).finally(() => _loading.delete(key))
          }
          continue
        }
        const items = cityBoxItems(ctx.basis, D.perf.stationsOf(key), o, (s) => (o.cityLabelOn === false ? '' : cityLabelText(s, o.cityLabelType)))
        if (!items.length) continue
        layers.push({ key, color: o.cityMarkColor || '#ff2a2a', width: Number(o.cityMarkWidth) || 1.2, markOn: o.cityMarkOn !== false, labelOn: o.cityLabelOn !== false, labelPt: Number(o.cityLabelPt) || 8, labelAlign: o.cityLabelAlign || 'right', labelBold: !!o.cityLabelBold, items })
      }
      const sc = D.scene(), fl = D.flat()
      if (sc && sc.setCityBoxes) sc.setCityBoxes(layers)
      if (fl && fl.setCityBoxes) fl.setCityBoxes(layers)
    }, 0)
  }
  // 树里「性能指标表」行的眼睛：改总开关 → 重画城市层，并把整份选项推给开着的该表窗口
  // （镜像按内容签名判回声，窗口那份不跟上的话，它下次发回的整份选项会带着旧值把眼睛翻回去）
  function setCityShow(key, on) {
    if (!key) return
    D.perf.setCityShow(key, on)
    if (on) _loadFailed.delete(key)   // 用户明确要看 → 之前载不到的再试一次
    for (const w of winsOf('ground', key)) push(w.id, { opts: D.perf.getOpts(key) })
    pushBoxes()
  }
  function actGround(w, m) {
    const key = w.key, p = m.payload
    switch (m.type) {
      case 'ready': w.ready = true; pushGroundFull(w); break
      case 'stations': D.perf.setStationsOf(key, p || []); refreshGround(key); pushBoxes(); break
      case 'opts': D.perf.setOptsOf(key, p || {}); D.perf.rememberOpts(key); refreshGround(key); pushBoxes(); break
      case 'cityGroups':
        D.perf.setCityGroups(p || [])
        for (const o of winsOf('ground')) if (o.id !== w.id) push(o.id, { cityGroups: D.perf.cityGroups.value })
        break
      case 'trajPts': {
        // ids=[…] 按勾选取；id='*' 全部；单个 id 兼容。
        // 每个航点带上排程时刻（tMs，排不出省略）与实际高度（altM，只飞行航迹带；航行恒 0 不带）—— 与航迹表格同一份 trajWaypointInfo
        const M = D.markers() || {}, id = p && p.id, ids = p && Array.isArray(p.ids) ? new Set(p.ids) : null
        const want = (t) => (ids ? ids.has(t.id) : (id === '*' || t.id === id))
        const list = (M.trs || []).filter(want).map((t) => {
          let info = []
          try { info = trajWaypointInfo(t) } catch { info = [] }
          const fl = t.kind === 'flight'
          return {
            id: t.id, name: t.name || '',
            pts: (t.pts || []).map((q, i) => {
              const o = { lon: q.lon, lat: q.lat }, e = info[i]
              if (e && Number.isFinite(e.tMs)) o.tMs = Math.round(e.tMs)
              if (e && fl && Number.isFinite(e.altM)) o.altM = Math.round(e.altM * 10) / 10
              return o
            })
          }
        })
        reply(w.id, m.reqId, list)
        break
      }
      default: break
    }
  }

  // ---------- 对星 ----------
  function shellSnapLight(key) {
    const s = D.satPerf.session(key)
    return {
      picks: D.satPerf.picksOf(key), targetMode: D.satPerf.targetModeOf(key), beamPicks: s.beamPicks.value,
      note: s.note.value, stampMs: s.stampMs.value,
      win: { on: s.win.on, startMs: s.win.startMs, durH: s.win.durH, cursorMs: s.win.cursorMs, busy: s.win.busy, progress: s.win.progress, msg: s.win.msg },
      winNote: s.winNote.value, winInfo: s.winInfo.value, stale: D.satPerf.winStaleFor(key),
      tzMode: D.tzMode(), nowMs: D.nowMs(), timeLabel: D.timeLabel()
    }
  }
  function pushShellFull(w) {
    const key = w.key, s = D.satPerf.session(key)
    const snap = groundCtxSnap(key)
    push(w.id, { ...snap, opts: D.satPerf.getOpts(key), rows: s.rows.value, ...shellSnapLight(key) })
  }
  // 逐 key 重算瞬时表（原 satcovRefreshTable 的逐窗版）
  function refreshShell(key) {
    if (!winsOf('shell', key).length) return
    const ctx = D.grd.getPerfContext(key)
    const s = D.satPerf.session(key)
    if (!ctx) { D.satPerf.compute(null, null, null, null, null, 0, key); D.satPerf.setBeamTargets([], key); return }
    // 时间窗口档：表钉在【游标时刻】，不能被「按当前时钟重算」冲掉；还没扫过就空着
    if (s.win.on) {
      if (s.winInfo.value) D.satPerf.seekCursor(s.win.cursorMs, key); else D.satPerf.clearRows(key)
      return
    }
    D.satPerf.compute(ctx, D.satPerf.getOpts(key), D.satcovResolveTargets(ctx, key), D.satcovTimes(), D.satcov.shells.value, D.satcov.s.hEx)
  }
  function shellClockTick() {
    for (const w of winsOf('shell')) { const s = D.satPerf.session(w.key); if (!s.win.on) refreshShell(w.key) }
  }
  const shellBeamModeOpen = () => winsOf('shell').some((w) => D.satPerf.targetModeOf(w.key) === 'beam')
  function bindShell(w) {
    const key = w.key, s = D.satPerf.session(key)
    // 轻量字段（名单 / 时窗 / 读数 / 进度）与重量字段（行）分开推，扫描进度不必带着几百行一起走
    w.stops.push(watch(() => shellSnapLight(key), (v) => push(w.id, v), { deep: true }))
    w.stops.push(watch(() => s.rows.value, (rows) => push(w.id, { rows }), { flush: 'post' }))
    w.stops.push(watch(() => s.ctxBeams.value, () => push(w.id, groundCtxSnap(key))))
  }
  async function actShell(w, m) {
    const key = w.key, p = m.payload, s = D.satPerf.session(key)
    switch (m.type) {
      case 'ready': w.ready = true; bindShell(w); pushShellFull(w); refreshShell(key); break
      case 'picks:add': D.satPerf.addTarget(p, key); refreshShell(key); break
      case 'picks:addMany': { const n = D.satPerf.addTargets(p || [], key); if (!n) push(w.id, { note: '这些卫星都已在目标星列表里' }); refreshShell(key); break }
      case 'picks:remove': D.satPerf.removeTarget(p && p.id, key); refreshShell(key); break
      case 'picks:removeMany': D.satPerf.removeTargets(p, key); refreshShell(key); break   // { ids } 来自名单表、{ keys } 来自结果表
      case 'picks:clear': D.satPerf.clearTargets(key); refreshShell(key); break
      case 'targetMode': D.satPerf.setTargetModeOf(key, p); refreshShell(key); break
      case 'opts':
        D.satPerf.setOptsOf(key, p || {}); D.satPerf.rememberOpts(key)
        if (s.win.on && s.winInfo.value) D.satPerf.computeAtCursor(s.win.cursorMs, key); else refreshShell(key)
        break
      case 'recompute': refreshShell(key); break
      case 'addInBeam': D.satcovAddInBeam(key); refreshShell(key); break
      case 'scan': await D.satcovScanWindows(key); break
      case 'cancelScan': D.satPerf.cancelWindows(key); break
      case 'win': {
        const o = p || {}
        if ('startMs' in o) s.win.startMs = Number.isFinite(o.startMs) ? o.startMs : null
        if ('durH' in o) { const n = Number(o.durH); if (Number.isFinite(n) && n > 0) s.win.durH = n }
        if ('on' in o && !!o.on !== s.win.on) {
          s.win.on = !!o.on
          if (s.win.on) { if (s.winInfo.value) D.satPerf.seekCursor(s.win.cursorMs, key); else D.satPerf.clearRows(key) } else refreshShell(key)
        }
        break
      }
      case 'cursor': if (p && Number.isFinite(p.t)) { D.satPerf.setCursor(p.t, key); D.satPerf.computeAtCursor(s.win.cursorMs, key) } break
      case 'seekClock': if (p && Number.isFinite(p.t)) D.seekClock(p.t); break
      case 'focus': D.focusTarget(p); break
      case 'search': {
        let r = null
        try { r = await D.satcovSearch(p ? p.q : '', (p && p.limit) || 60, (p && p.exclude) || null) } catch (e) { reply(w.id, m.reqId, null, String(e && e.message || e)); break }
        reply(w.id, m.reqId, r)
        break
      }
      default: break
    }
  }

  // ---------- 气象 ----------
  function metSnap() {
    const E = D.envLive
    const pv = E.providers.value
    return {
      sites: E.sites.value, rows: E.metRows.value, cols: E.siteCols.value,
      msg: E.siteMsg.value, busy: E.siteBusy.value, obsBusy: E.obsBusy.value, obsAt: E.obsAt.value,
      pointOk: !pv || !pv.point || pv.point.ok !== false, pointMsg: pv && pv.point ? (pv.point.message || '') : '',
      siteMeta: E.siteMeta.value, hasMeta: !!E.meta.value, inRange: !!(E.frameInfo.value && E.frameInfo.value.inRange),
      timeText: D.liveTimeText(), satReady: !!E.satReady.value, satName: E.satName.value || '',
      tzMode: typeof D.tzMode === 'function' ? D.tzMode() : 'local',
      markers: markersSnap()
    }
  }
  function bindMet(w) {
    w.stops.push(watch(() => metSnap(), (v) => push(w.id, v), { deep: true }))
  }
  function actMet(w, m) {
    const E = D.envLive, p = m.payload
    switch (m.type) {
      case 'ready': w.ready = true; bindMet(w); push(w.id, metSnap()); E.refreshSites(true); break
      case 'sites': {
        const seen = new Set()
        E.sites.value = (Array.isArray(p) ? p : []).map((s) => {
          let id = s && s.id ? String(s.id) : ''
          if (!id || seen.has(id)) id = E.nextSiteId()
          seen.add(id)
          const o = { id, name: String(s.name == null ? '' : s.name), lon: s.lon == null ? null : Number(s.lon), lat: s.lat == null ? null : Number(s.lat), src: s.src || 'manual' }
          if (s && Number.isFinite(s.tMs)) o.tMs = s.tMs      // 该行的取值时刻（航迹航点 / 手填），没有就跟时间轴
          return o
        })
        break
      }
      case 'cols': if (Array.isArray(p) && p.length) E.siteCols.value = p.slice(); break
      case 'resetCols': E.resetSiteCols(); break
      case 'fetchObs': E.fetchObsAll(); break
      case 'importMarkers': {
        // 三栏一次：点标记 + 地球站一批，航迹逐条（每条航迹每个航点一行，站名「航迹名 #序号」）
        const pts = (p && p.pts) || [], sts = (p && p.sts) || [], trs = (p && p.trajs) || []
        if (pts.length || sts.length) E.importMarkers('mk', { pts: new Set(pts), sts: new Set(sts) })
        for (const id of trs) E.importMarkers('traj', id)
        break
      }
      case 'importTraj': E.importMarkers('traj', p && p.id !== '*' ? p.id : null); break
      default: break
    }
  }

  // ---------- 总入口 ----------
  function handleAct(m) {
    if (!m || !m.id) return
    let w = wins.get(m.id)
    if (!w) { w = { id: m.id, kind: m.kind, key: m.key, ready: false, stops: [] }; wins.set(m.id, w); ver.value++ }   // 主窗口热重载后弹窗还在：就地认领
    if (w.kind === 'ground') actGround(w, m)
    else if (w.kind === 'shell') actShell(w, m)
    else if (w.kind === 'met') actMet(w, m)
  }
  let attached = false
  async function attach() {
    if (!api || attached) return
    attached = true
    api.onAct(handleAct)
    api.onClosed((m) => { if (m && m.id) dropWin(m.id) })
    // 主窗口重载（开发期 HMR / 崩溃重启）时弹窗可能还开着：认领它们，等它们下一次 act 或主动重推
    try {
      const list = await api.list()
      for (const w of (list || [])) if (!wins.has(w.id)) wins.set(w.id, { id: w.id, kind: w.kind, key: w.key, ready: false, stops: [] })
      if (list && list.length) ver.value++
    } catch { /* 无窗口 */ }
    D.grd.onTreeKeys(onTreeKey)
    // 城市组 / 标记变了 → 推给开着的对地 / 气象窗
    watch(() => D.perf.cityGroups.value, (v) => { for (const w of winsOf('ground')) push(w.id, { cityGroups: v }) }, { deep: true })
    watch(() => markersSnap(), (v) => { for (const w of wins.values()) if (w.kind !== 'shell') push(w.id, { markers: v }) }, { deep: true })
    // 显示时区改了 → 对地表的「时间」列按新时区重排（对星表的 tzMode 随 shellSnapLight 走）
    if (typeof D.tzMode === 'function') watch(() => D.tzMode(), (v) => { for (const w of winsOf('ground')) push(w.id, { tzMode: v }) })
    // 城市桶 / 选项桶整份换了（页面快照恢复、弹窗整份发回）→ 城市层重画；眼睛与逐项改动各自显式调 pushBoxes
    watch(() => [D.perf.stationsByAnt.value, D.perf.optsByAnt.value], () => pushBoxes())
    // 天线树整份换了（GRD 索引载完 / 加天线 / 改名 / 删除）→ 之前载不到的天线重试（启动时城市桶先于索引恢复，见 _loadFailed）
    watch(() => (D.grd.sats ? D.grd.sats.value : null), () => { _loadFailed.clear(); pushBoxes() })
    pushBoxes()
  }
  // 卫星动了（时钟 / 拖拽 / 改指向）：动过的天线的表重算，城市框重画
  function onMoved(moved) {
    if (!moved || !moved.size) return
    for (const k of groundKeys()) if (moved.has(k)) refreshGround(k)
    if (boxKeys().some((k) => moved.has(k))) pushBoxes()
  }
  // 聚焦天线的设置（极化 / 增益 / 路损 / 指向 …）变了：该天线的表与城市框重算
  function onSettingsChanged(key) {
    if (!key) return
    if (winsOf('ground', key).length) refreshGround(key)
    if (boxKeys().includes(key)) pushBoxes()
    if (winsOf('shell', key).length) refreshShell(key)
  }
  function refreshAll() { for (const k of groundKeys()) refreshGround(k); for (const k of shellKeys()) refreshShell(k); pushBoxes() }

  return {
    ver, has, attach, open, isOpen, closeKey,
    groundKeys, shellKeys, liveKeys, boxKeys, metOpen, shellBeamModeOpen,
    refreshGround, refreshShell, refreshAll, shellClockTick, onMoved, onSettingsChanged, pushBoxes, setCityShow
  }
}
