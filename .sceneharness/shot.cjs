// 验证台截图：把四个台子各抓一张 PNG 存到 .sceneharness/shots/。
//   npx electron .sceneharness/shot.cjs [端口]
// 用 Electron 当无头浏览器（仓库里本来就有它，不额外装 puppeteer）；
// capturePage 拿到的是真实位图，与人在验证台上看到的一致。
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

const PORT = process.argv[2] || '5946'
const OUT = path.join(__dirname, 'shots')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// [文件名, URL 查询, 抓图前跑的脚本（可选）]
const SHOTS = [
  ['01-符号台', '?', "(async()=>{const t=[...document.querySelectorAll('.symbar .tg')].find(x=>x.textContent.trim()==='D');if(t)t.click();await new Promise(r=>setTimeout(r,600))})()"],
  ['02-拓扑台', '?topo', "(async()=>{const s=document.querySelector('.hh select');if(s){s.value='tpl.water.dam';s.dispatchEvent(new Event('change'))}await new Promise(r=>setTimeout(r,2500))})()"],
  ['03-地图台', '?map', "(async()=>{await new Promise(r=>setTimeout(r,2500))})()"],
  ['04-面板台', '?panel', "(async()=>{await new Promise(r=>setTimeout(r,2500))})()"]
]

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { offscreen: false } })
  for (const [name, q, script] of SHOTS) {
    await win.loadURL(`http://localhost:${PORT}/${q}`)
    await sleep(3500)
    if (script) { try { await win.webContents.executeJavaScript(script) } catch (e) { console.error(name, e.message) } }
    await sleep(1200)
    const img = await win.webContents.capturePage()
    const f = path.join(OUT, name + '.png')
    fs.writeFileSync(f, img.toPNG())
    console.log('已存', path.relative(path.join(__dirname, '..'), f), (fs.statSync(f).size / 1024).toFixed(0) + ' KB')
  }
  win.destroy()
  app.quit()
})
