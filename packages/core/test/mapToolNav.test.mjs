// 地图工具态「按住 Shift 操作地图」自测（src/shared/mapToolNav.js + 两个渲染器 / 主页面的源码钉）。运行：npm test
//   ① 口径真值表：工具态外左键拖动一律操作地图；工具态里只有 Shift + 左键拖动操作地图
//   ② OrbitControls 左键分派：按 orbitLeftMode 挑的那一档，three 自己的修饰键分派落下来恰好是「转 / 不转」
//      （拿 node_modules 里 OrbitControls 的源码核对它真是这么分派的 —— 升级 three 改了口径这里先红）
//   ③ 源码钉：3D 捕获阶段挑档、Shift 那一下工具与点选都不接；2D 工具态 Shift = 平移、空白处不平移；
//      绘制态拖动 = 连续加点（不再要 Shift）；横幅一律挂 ShiftNavHint；页面那把锁喂给两个渲染器
import { readFileSync } from 'node:fs'
import { leftPressNavigates, orbitLeftMode } from '../../../src/shared/mapToolNav.js'

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + msg + (extra ? `  (${extra})` : '')); cond ? pass++ : fail++ }
const src = (p) => readFileSync(new URL('../../../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

// ① 真值表（16 种修饰键组合 × 工具态开 / 关）
const combos = []
for (let m = 0; m < 8; m++) combos.push({ shiftKey: !!(m & 1), ctrlKey: !!(m & 2), metaKey: !!(m & 4) })
{
  let bad = 0
  for (const e of combos) {
    if (leftPressNavigates(false, e) !== true) bad++
    if (leftPressNavigates(true, e) !== e.shiftKey) bad++
  }
  ok(bad === 0, '口径：工具态外左键拖动操作地图；工具态里只认 Shift', `${combos.length * 2} 组`)
  ok(leftPressNavigates(true, null) === false && leftPressNavigates(false, null) === true, '口径：没有事件对象时按「无修饰键」算')
}

// ② OrbitControls 的修饰键分派（three r184 onMouseDown）：LEFT=ROTATE → 无修饰键转、有修饰键走平移；LEFT=PAN → 反过来。
//    本项目 enablePan=false，「走平移」= 什么也不做
{
  const oc = src('node_modules/three/examples/jsm/controls/OrbitControls.js')
  const md = oc.slice(oc.indexOf('function onMouseDown('), oc.indexOf('function onMouseMove('))
  const iRot = md.indexOf('case MOUSE.ROTATE:'), iPan = md.indexOf('case MOUSE.PAN:')
  const rot = md.slice(iRot, iPan)
  const pan = md.slice(iPan, md.indexOf('default:', iPan))   // ★ 从 PAN 分支往后找：前面按键码那个 switch 也有一个 default
  const modTest = 'if ( event.ctrlKey || event.metaKey || event.shiftKey )'
  ok(rot.includes(modTest) && rot.indexOf('_handleMouseDownPan') < rot.indexOf('_handleMouseDownRotate'),
    'three OrbitControls：LEFT=ROTATE 时带修饰键先走平移分支')
  ok(pan.includes(modTest) && pan.indexOf('_handleMouseDownRotate') < pan.indexOf('_handleMouseDownPan'),
    'three OrbitControls：LEFT=PAN 时带修饰键先走旋转分支')
  const rotates = (mode, e) => { const mod = e.ctrlKey || e.metaKey || e.shiftKey; return mode === 'rotate' ? !mod : mod }
  let bad = 0
  for (const toolOn of [false, true]) for (const e of combos) {
    const m = orbitLeftMode(toolOn, e)
    if (m !== 'rotate' && m !== 'pan') bad++
    else if (rotates(m, e) !== leftPressNavigates(toolOn, e)) bad++
  }
  ok(bad === 0, 'orbitLeftMode：挑的那一档经 OrbitControls 分派后「转不转」与口径逐组一致', `${combos.length * 2} 组`)
}

// ③ 源码钉
{
  const sc = src('src/viz/globe3d/scene.js')
  ok(/addEventListener\('pointerdown', \(e\) => \{\s*if \(e\.button !== 0[^\n]*\n\s*const left = orbitLeftMode\(toolOn\(\), e\)[\s\S]{0,200}controls\.mouseButtons\.LEFT = left[\s\S]{0,160}\}, true\)/.test(sc),
    '3D：捕获阶段按 orbitLeftMode 给地球控件挑 LEFT 档（先于 OrbitControls 自己的 pointerdown）')
  ok(/followDriver\.setLeftButton\(left\)/.test(sc) && /setLeftButton\(b\) \{\s*if \(ctl\) ctl\.mouseButtons\.LEFT = b/.test(src('src/viz/globe3d/modelLayer.js')),
    '3D：跟随卫星时局部控件同样挑档')
  ok(/if \(e\.button === 0 && toolOn\(\)\) \{\s*if \(e\.shiftKey\) \{ navPress = true; return \}\s*pressLock = true; updateRotate\(\)/.test(sc),
    '3D：工具态 Shift + 左键归地图（工具不接），其余左键归工具（地球不转）')
  ok(/if \(navPress\) \{ navPress = false; return \}/.test(sc), '3D：Shift 那一下抬起不加点 / 不放置 / 不选星')
  ok(!/polyDrawMode && e\.button === 0 && e\.shiftKey/.test(sc) && /else if \(polyDrawMode && e\.button === 0\) drawArm = /.test(sc)
    && /if \(drawArm && \(e\.buttons & 1\) && [^\n]*> 6\)/.test(sc), '3D：绘制态按住拖动 = 连续加点（拖过 6 px 起笔，不再要 Shift）')
  ok(/setToolLock: \(v\) => \{ toolLock = !!v \}/.test(sc), '3D：setToolLock 已导出')

  const fl = src('src/viz/flatmap/flatCoverage.js')
  ok(/const tool = e\.button === 0 && toolOn\(\)\s*if \(tool && e\.shiftKey\) \{ startPan\(e\); return \}/.test(fl), '2D：工具态 Shift + 左键 = 平移（工具不接）')
  ok(/if \(tool\) return[^\n]*\n\s*startPan\(e\)\s*\n\s*\}/.test(fl), '2D：工具态里按在空白处地图不动')
  ok(!/polyDrawMode && e\.button === 0 && e\.shiftKey/.test(fl) && /if \(drawClickArm && \(e\.buttons & 1\) && [^\n]*> 6\)/.test(fl),
    '2D：绘制态按住拖动 = 连续加点（拖过 6 px 起笔，不再要 Shift）')
  ok(/function onDbl\(\) \{[\s\S]{0,160}if \(toolOn\(\)\) return/.test(fl), '2D：工具态双击不回全图')
  ok(/setToolLock\(v\) \{ toolLock = !!v \}/.test(fl), '2D：setToolLock 已导出')

  const pg = src('src/pages/ConstellationMap3D.vue')
  ok(/const navLock = computed\(\(\) => !!\(mapTool\.value \|\| \(satModal\.value && satPick\.value\)\)\)/.test(pg), '页面：工具态 = 任一地图工具 + 卫星点选')
  ok(/watch\(navLock, \(v\) => \{ if \(scene\) scene\.setToolLock\(v\); if \(flat\) flat\.setToolLock\(v\) \}/.test(pg)
    && /scene\.setToolLock\(navLock\.value\)/.test(pg) && /flat\.setToolLock\(navLock\.value\)/.test(pg), '页面：锁喂给两个渲染器（含懒建的平面图）')
  ok(/e\.button !== 0 \|\| \(e\.shiftKey && navLock\.value\)\) \{ _lnkDown = null; return \}/.test(pg), '页面：建链 Shift + 左键不追加节点')
  const banners = pg.match(/<div v-if="[^"]*" class="(?:traj|sat)-banner"[\s\S]*?<\/div>/g) || []
  const noHint = banners.filter((b) => !b.includes('<ShiftNavHint :on="shiftDown" />'))
  ok(banners.length >= 12 && noHint.length === 0, '横幅：每条工具态横幅都挂同一枚 Shift 键帽', `${banners.length} 条` + (noHint.length ? '；缺：' + noHint.map((b) => b.slice(0, 60)).join(' | ') : ''))
  ok(!/class="bn-hint"/.test(pg), '横幅：不再各写一份键帽（统一走 ShiftNavHint）')
  ok(/\.stage-wrap\.nav-shift :deep\(canvas\) \{ cursor: grab !important; \}/.test(pg) && /'nav-shift': navLock && shiftDown/.test(pg), '舞台：工具态按住 Shift 光标换抓手')
  const hint = src('src/components/ShiftNavHint.vue')
  ok(/<kbd class="bn-kbd">Shift<\/kbd><span class="bn-plus">\+<\/span><span>拖动地图<\/span>/.test(hint), 'ShiftNavHint：Shift + 拖动地图')
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
