// 应用场景仿真 · 真 Electron 窗口里的端到端自检。
//
// 验证台（vite）跑不了这一段：星历取自主进程（内置 OMM 兜底 + CelesTrak），
// 卫星库落在 userData/library.json，几何走 link:ngsoGeometry —— 三条都要真主进程。
//
// 做法：起打好包的应用（out/），带 --remote-debugging-port，用 CDP 在【渲染进程里】
// 直接调 sceneStore 的导出函数，把「添加卫星 → 星历搜索 → 加入 → 计算」跑一遍。
// 用 CDP 而不是模拟点击：点击流会被布局/滚动位置左右，而这里要验的是数据链路本身。
//
//   node .sceneharness/electron-check.mjs
// 前置：npm run build（本脚本跑的是 out/ 里那份，与用户装机跑的是同一份代码）

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 9223
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let proc = null
function bye(code) { try { proc && proc.kill() } catch { /* ignore */ } process.exit(code) }

async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  return r.json()
}

// 极简 CDP 客户端：够用就好（Runtime.evaluate + Page.captureScreenshot）
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const waits = new Map()
    ws.addEventListener('message', (ev) => {
      let m = null
      try { m = JSON.parse(ev.data) } catch { return }
      if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id) }
    })
    ws.addEventListener('error', reject)
    ws.addEventListener('open', () => resolve({
      send(method, params) {
        const i = ++id
        return new Promise((res) => { waits.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })) })
      },
      close() { try { ws.close() } catch { /* ignore */ } }
    }))
  })
}

async function evalIn(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400))
  const res = r.result && r.result.result
  if (r.result && r.result.exceptionDetails) throw new Error('eval 抛异常')
  return res ? res.value : undefined
}

let pass = 0, fail = 0
const ok = (n, c, extra) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (extra ? `  (${extra})` : '')); c ? pass++ : fail++ }

const main = async () => {
  const exe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  proc = spawn(exe, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = []
  proc.stdout.on('data', (b) => log.push(String(b)))
  proc.stderr.on('data', (b) => log.push(String(b)))

  // 等窗口起来（主窗口的 3D 场景初始化要几秒）
  let list = []
  for (let i = 0; i < 60; i++) {
    await sleep(1000)
    try { list = await targets() } catch { list = [] }
    if (list.some((t) => t.type === 'page' && /index\.html/.test(t.url))) break
  }
  const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
  if (!page) { console.error('主窗口没起来。日志：\n' + log.join('').slice(-2000)); bye(1) }
  ok('真 Electron 主窗口起得来', true, page.url.split('/').pop())

  const cdp = await connect(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await sleep(6000)   // 等星历 / 底图那几步异步初始化跑完

  // 场景工作台的 store 挂到 window 上（模块级单例，构建产物里拿不到模块引用，
  // 故渲染端在 App 挂载时把它挂出来一份专供自检 —— 见 src/App.vue 的 __sceneStore）
  const hasStore = await evalIn(cdp, `!!window.__sceneStore`)
  ok('渲染端暴露了 sceneStore（自检钩子）', hasStore)
  if (!hasStore) { console.error(log.join('').slice(-2000)); cdp.close(); bye(1) }

  // ── ① IPC：目录 + 预置 ──
  const cat = await evalIn(cdp, `(async()=>{const c=await window.api.scene.catalog();return {media:(c.media||[]).length,presets:(c.satPresets||[]).length,catA:(c.modCats||[]).some(x=>x.key==='A'&&x.lib===false)}})()`)
  ok('scene:catalog 回得来（介质 / 预置卫星）', cat && cat.media > 0 && cat.presets === 25, JSON.stringify(cat))
  ok('A 空间段标了 lib:false（不进模块库树）', !!(cat && cat.catA))

  // ── ② 星历搜索池（真主进程：内置 OMM 兜底 + 联网）──
  // ★ 逐组联网最坏能拖到分钟级（17 组 × 主/备端点），给个上限：超时就当「这台机器没网」，
  //   后面的断言仍能跑（内置 OMM 兜底本来就是为这种情况准备的）。
  const poolN = await evalIn(cdp, `(async()=>{
    const s = window.__sceneStore
    const r = await Promise.race([ s.ensureSearchPool(), new Promise((res) => setTimeout(() => res(null), 240000)) ])
    return r && r.all ? r.all.length : 0
  })()`)
  ok('★ 星历搜索池取得到卫星（全量目录）', poolN > 1000, `${poolN} 颗`)

  // ── ③ 添加卫星：从星历搜索里挑一颗真星 → 建库条目 → 加入场景 ──
  const added = await evalIn(cdp, `(async()=>{
    const s = window.__sceneStore
    await s.loadLibrary(true)
    s.newScene()
    const r = await s.ensureSearchPool()
    const rec = r.all.find(x => /STARLINK/i.test(x.name)) || r.all[0]
    const e = s.addSatEntryFromRec(rec)
    const m = s.addSatModule(e.id)
    return { entry: e.id, name: e.name, band: e.form.frequencyBand, cls: e.form.orbitClass,
             alt: e.form.orbitAltitude, incl: e.form.orbitInclination,
             mode: e.ngsoSat.mode, orbitType: e.ngsoSat.orbit && e.ngsoSat.orbit.type,
             mod: m && m.id, mods: s.scene.modules.length, lib: s.scene.satLib.length }
  })()`)
  ok('★ 星历搜索 → 建卫星库条目 → 加入场景', !!(added && added.mod && added.entry), JSON.stringify(added))
  ok('选星后轨道高度 / 倾角由所选卫星确定', !!(added && +added.alt > 0 && added.orbitType === 'omm'), `h=${added && added.alt} km, i=${added && added.incl}°`)

  // ── ④ 库真的落盘了（读回来还在）──
  const persisted = await evalIn(cdp, `(async()=>{
    const s = window.__sceneStore
    await s.saveSatLibrary()
    const lib = await window.api.store.getLibrary('e2e')
    return { sat: (lib && lib.sat || []).length, es: (lib && lib.es || []).length,
             hit: (lib && lib.sat || []).some(c => c.id === ${JSON.stringify(added && added.entry)}) }
  })()`)
  ok('★ 卫星库落盘（读回来还在）', !!(persisted && persisted.hit), JSON.stringify(persisted))
  ok('★ 写卫星库没有抹掉端到端窗口的地球站库', !!(persisted && persisted.es > 0), `es ${persisted && persisted.es} 条`)

  // ── ⑤ 模板 + 计算（走真 IPC 的 scene:compute，几何走 link:ngsoGeometry）──
  const calc = await evalIn(cdp, `(async()=>{
    const s = window.__sceneStore
    await s.applyTemplate('tpl.power.dtu')
    await s.compute()
    const f = s.scene.result && s.scene.result.flows && s.scene.result.flows[0]
    const d = f && f.dirs && f.dirs[0]
    const sat = d && d.segments.find(x => x.kind === 'sat')
    return { err: s.scene.error, ms: s.scene.ms, flows: (s.scene.result && s.scene.result.flows || []).length,
             margin: f && f.summary.marginDb, geoKeys: Object.keys(s.scene.geo).length,
             slant: sat && sat.hops && +sat.hops[0].distanceResult,
             satMods: s.scene.modules.filter(m => m.kind === 'sat').length,
             satIds: s.scene.modules.filter(m => m.kind === 'sat').map(m => m.satId) }
  })()`)
  ok('★ 模板迁移到平台卫星库后算得出', !!(calc && !calc.err && calc.flows > 0 && calc.margin != null), JSON.stringify(calc))
  ok('★ 模板里的卫星换成了卫星库引用（satId 非空）', !!(calc && calc.satMods === 1 && calc.satIds[0]), (calc && calc.satIds || []).join(','))
  ok('★ 几何走真轨道（预解结果注入了 opts.geo）', !!(calc && calc.geoKeys >= 2), `${calc && calc.geoKeys} 条注入`)
  // GSO 站-星斜距的合理区间（35786 天顶 ~ 41679 地平）
  ok('斜距落在静止轨道站星几何的合理区间', !!(calc && calc.slant > 35000 && calc.slant < 42000), `${calc && calc.slant} km`)

  // ── ⑥ 与端到端窗口对拍：同一颗星、同一站址，几何必须逐位一致 ──
  const cross = await evalIn(cdp, `(async()=>{
    const s = window.__sceneStore
    const sat = s.scene.modules.find(m => m.kind === 'sat')
    const e = s.scene.satLib.find(c => c.id === sat.satId)
    const orbit = s.satOrbitSpec(e)
    const st = { lonDeg: 75.99, latDeg: 39.47, altKm: 1.29, minElevDeg: 10 }
    const t0ISO = new Date(1767225600000).toISOString()
    const a = await window.api.linkBudget.ngsoGeometry({ orbit, tx: st, rx: st, t0ISO, horizonHours: 24 })
    const b = await window.api.linkBudget.ngsoGeometry({ orbit, tx: st, rx: st, t0ISO, horizonHours: 24 })
    return { ok: !!(a && a.feasible), slant: a && a.worst && a.worst.up.slantKm, elev: a && a.worst && a.worst.up.elevDeg,
             same: JSON.stringify(a) === JSON.stringify(b) }
  })()`)
  ok('★ link:ngsoGeometry 对同一入参可重复（两窗同参必同解）', !!(cross && cross.ok && cross.same), JSON.stringify(cross))

  // 截图存档
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  if (shot && shot.result && shot.result.data) {
    const fs = await import('node:fs')
    fs.writeFileSync(path.join(ROOT, '.sceneharness', 'electron-shot.png'), Buffer.from(shot.result.data, 'base64'))
    console.log('截图：.sceneharness/electron-shot.png')
  }

  cdp.close()
  console.log(`\n${pass} passed, ${fail} failed`)
  bye(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); bye(1) })
