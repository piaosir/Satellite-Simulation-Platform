// 选中集按身份认星（src/viz/constellation/selIdentity.js）+ 3D 页接线。运行：node packages/core/test/selIdentity.test.mjs
//
// 缺陷（2026-10-16 体检二档「主窗口 3D 与星座」）：选中集按对象认星，同一颗星却是几份不同的对象（内置组 / 全量池 / 导入组 /
//   搜索结果各建各的，组重载 / 换池又整批换新）——
//   · Ctrl+点已聚焦的星、右键「移出聚焦」「跟随卫星」、搜索下拉里的 ✓ 都变成再并进一份同号副本（轨迹 / 覆盖圈画两层、每拍多推 SGP4）；
//   · 每天首次联网后聚焦星停在本机缓存版根数上，「导出星历」导出的也是旧根数；
//   · 文件管理「导入替换」内置星座组后星座页仍用旧数据，要重启；
//   · 2D「跟随卫星」中点「取消聚焦」跟随不退出。
// 钉死的事：
//   ① 模块：sameSat / indexOfSat / findSat 先认对象、再认身份；remapSel 只换对象不改是哪几颗、撞号只留一份、主选 / 跟随目标跟着换、
//      没变化原样返回（同一个数组）。
//   ② 典型场景按模块复演：图上那份 A1、搜索给的 A2（同号）—— Ctrl 点 A2 是移出 A1；联网版 A3 换进来后选中集 / 主选 / 跟随一起换成 A3。
//   ③ 页面接线按源码钉：selectSat / startFollow / startFlatFollow / onMapPick / 右键 / scene:cmd 按身份判重；渲染集重建、换池、组 put
//      之后选中集换成当前对象（retire → syncSelObjects）；内置组「聚焦」先挑已载入那批；卫星组 / 卫星集解析回退点序列表；
//      导入替换经 fileBridge.ommReplaced 重载；closeCard / 换主选退出 2D 跟随。
import { readFileSync } from 'node:fs'
import { sameSat, indexOfSat, findSat, remapSel } from '../../../src/viz/constellation/selIdentity.js'
import { fileBridge, bumpOmmReplaced } from '../../../src/stores/fileBridge.js'

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + msg + (extra ? `  (${extra})` : '')); cond ? pass++ : fail++ }
// 与 3D 页 satIdOf 同式（③ 里另按源码钉住页面那一份没变）
const satIdOf = (e) => (e && e.noradId ? 'n:' + e.noradId : (e ? 'm:' + e.name : ''))

// ==================== ① 模块 ====================
{
  const a1 = { noradId: 41838, name: 'ZX-15', v: 1 }, a2 = { noradId: '41838', name: 'ZX-15', v: 2 }, b = { noradId: 25544, name: 'ISS' }
  const m1 = { name: 'X' }, m2 = { name: 'X' }
  ok(sameSat(a1, a1, satIdOf) && sameSat(a1, a2, satIdOf), '① sameSat：同一对象 / 同号另一份（数字号与字符串号同一身份）都算同一颗')
  ok(!sameSat(a1, b, satIdOf) && !sameSat(a1, null, satIdOf) && !sameSat(null, null, satIdOf), '① sameSat：不同号 / 有空值 → false')
  ok(sameSat(m1, m2, satIdOf), '① 没号的按名字认（m:）')
  const list = [b, a1]
  ok(indexOfSat(list, a1, satIdOf) === 1 && indexOfSat(list, a2, satIdOf) === 1 && indexOfSat(list, { noradId: 1 }, satIdOf) === -1, '① indexOfSat：对象 / 身份都认，没有 -1')
  ok(indexOfSat([], a1, satIdOf) === -1 && indexOfSat(list, null, satIdOf) === -1, '① indexOfSat：空表 / 空值 → -1')
  // 对象优先：同号两份都在时先认对象本身
  ok(indexOfSat([a1, a2], a2, satIdOf) === 1 && findSat([a1, a2], a2, satIdOf) === a2, '① 同号两份都在：先认对象本身')
  ok(findSat(list, a2, satIdOf) === a1 && findSat(list, { noradId: 9 }, satIdOf) === null, '① findSat：返回已选的那一份')

  const same = remapSel(list, a1, a1, (e) => e, satIdOf)
  ok(!same.changed && same.list === list && same.primary === a1 && same.follow === a1, '① remapSel：没变化原样返回（同一个数组）')
  const nul = remapSel(list, a1, null, () => null, satIdOf)
  ok(!nul.changed && nul.list === list, '① remapSel：to 返回假值＝原样留着')
  const a3 = { noradId: 41838, name: 'ZX-15', v: 3 }
  const r = remapSel(list, a1, a1, (e) => (sameSat(e, a3, satIdOf) ? a3 : e), satIdOf)
  ok(r.changed && r.list.length === 2 && r.list[0] === b && r.list[1] === a3, '① remapSel：换对象、顺序与颗数不变')
  ok(r.primary === a3 && r.follow === a3, '① remapSel：主选 / 跟随目标跟着换成同号那一份')
  const dup = remapSel([a1, b, a2], a2, null, (e) => e, satIdOf)
  ok(dup.changed && dup.list.length === 2 && dup.list[0] === a1 && dup.list[1] === b && dup.primary === a1, '① remapSel：原先同号两份 → 只留第一份，指着被并掉那份的主选改指留下的')
  const out = { noradId: 7 }
  const keepF = remapSel(list, a1, out, (e) => (e === a1 ? a3 : e), satIdOf)
  ok(keepF.follow === out, '① remapSel：跟随目标不在集里就原样留着')
  const lost = remapSel([a1], { noradId: 99 }, null, (e) => a3, satIdOf)
  ok(lost.primary === a3, '① remapSel：主选落空取最后一颗（同移出主选的口径）')
}

// ==================== ② 典型场景复演（页面 selectSat 的判重 + 换池后的 syncSelObjects 口径） ====================
{
  const a1 = { noradId: 41838, name: 'ZX-15', group: 'geo' }          // 图上那份（内置组）
  const a2 = { noradId: 41838, name: 'ZX-15', group: 'geo', pool: 1 } // 搜索下拉 / 查找给的（全量池）
  const b = { noradId: 25544, name: 'ISS', group: 'stations' }
  let sel = [b, a1], primary = a1, follow = a1
  // Ctrl 点（additive）a2：按身份认出已在集里 → 移出 a1，不并进副本
  const i = indexOfSat(sel, a2, satIdOf)
  ok(i === 1, '② Ctrl 点同号另一份：认出已在聚焦集里')
  const was = sel[i]; sel = sel.filter((_, k) => k !== i); if (primary === was) primary = sel[sel.length - 1] || null
  ok(sel.length === 1 && sel[0] === b && primary === b, '② 再点＝移出（修前 indexOf 认不出，会并进第二份 ZX-15）')
  // 联网版换进来（组 put / 换池）：旧对象退役，选中集 / 主选 / 跟随一起换成新那份
  sel = [b, a1]; primary = a1; follow = a1
  const a3 = { noradId: 41838, name: 'ZX-15', group: 'geo', online: true }
  const retired = new Set([a1])
  const r = remapSel(sel, primary, follow, (e) => (retired.has(e) ? a3 : e), satIdOf)
  ok(r.changed && r.list[1] === a3 && r.primary === a3 && r.follow === a3, '② 换版：选中集 / 主选 / 跟随目标都换到联网版（不再停在缓存版根数上）')
}

// ==================== ③ 页面接线（按源码钉）====================
{
  const page = readFileSync(new URL('../../../src/pages/ConstellationMap3D.vue', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const fm = readFileSync(new URL('../../../src/components/FileManager.vue', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const body = (sig) => { const i = page.indexOf(sig), j = page.indexOf('\n}\n', i); return i >= 0 && j > i ? page.slice(i, j) : '' }
  ok(page.includes("const satIdOf = (e) => (e && e.noradId ? 'n:' + e.noradId : (e ? 'm:' + e.name : ''))"), '③ 页面 satIdOf 与本测试同式')
  ok(page.includes('const sameSat = (a, b) => sameSatBy(a, b, satIdOf)') && page.includes('const findSel = (e) => findSatBy(selEntries, e, satIdOf)'), '③ 页面判重走 selIdentity，身份串用 satIdOf')

  const ss = body('function selectSat(e, face, additive) {')
  ok(ss.includes('e = curEntryOf(e)') && ss.includes('indexOfSatBy(selEntries, e, satIdOf)') && !ss.includes('selEntries.indexOf(e)'), '③ selectSat：先换成图上那份，Ctrl 判重按身份')
  for (const sig of ['function startFollow(e) {', 'function startFlatFollow(e) {']) {
    const b = body(sig)
    ok(b.includes('!sameSat(e, selEntry)') && b.includes('const had = findSel(e)') && !b.includes('selEntries.includes(e)'), `③ ${/function (\w+)/.exec(sig)[1]}：已在集里按身份认那一份只换主选（不走 Ctrl 式 selectSat，免得被当成移出）`)
  }
  const sf = body('function startFlatFollow(e) {')
  ok(sf.indexOf("applySubPt({ src: 'sat', id: satIdOf(e), name: e.name })") > 0 && sf.indexOf("applySubPt({ src: 'sat'") < sf.indexOf('const had = findSel(e)'), '③ startFlatFollow：先换星下点参考再换主选（refreshSelection 的 2D 退出判据认得出要跟的星）')
  const rs = body('function refreshSelection() {')
  ok(rs.includes('if (!sameSat(selEntry, followEntry)) stopFollow()') && rs.includes('else if (selEntry !== followEntry) followEntry = selEntry'), '③ refreshSelection：3D 跟随按身份判换星，同一颗换了对象只跟着换')
  ok(rs.includes('if (_flatFollowSat && flatFollowing.value && (!selEntry || satIdOf(selEntry) !== mapCrs.subPt.id)) stopFlatFollow()'), '③ refreshSelection：2D 跟随同一口径（主选换成别的星就退出）')
  ok(/function closeCard\(\) \{ _userSelTick\+\+; stopFollow\(\); if \(_flatFollowSat\) stopFlatFollow\(\);/.test(page), '③ closeCard：取消聚焦连 2D「跟随卫星」一起退出')
  for (const [name, re] of [['onMapPick', /if \(!additive && !\(selEntries\.length === 1 && sameSat\(selEntries\[0\], en\)\)\) notePrevFocus\(\)/], ['ctxFocusSat', /if \(!\(selEntries\.length === 1 && sameSat\(selEntries\[0\], e\)\)\) notePrevFocus\(\); selectSat\(e, false, false\)/], ['onSceneCmd', /if \(!\(selEntries\.length === 1 && sameSat\(selEntries\[0\], e\)\)\) notePrevFocus\(\)\n\s*selectSat\(e, true, false\)/]]) ok(re.test(page), `③ ${name}：「上一聚焦」的换星判据按身份`)
  ok(!/selEntries\[0\] === (e|en)\b/.test(page), '③ 页面里不再按对象比单选')

  const rb = body('function rebuildRenderSet() {')
  const iOut = rb.indexOf('renderEntries = out'), iSync = rb.indexOf('if (syncSelObjects()) refreshSelModel()'), iRef = rb.indexOf('refreshPositions()', iOut)
  ok(iOut > 0 && iSync > iOut && iRef > iSync, '③ rebuildRenderSet：渲染集换好之后、出这一拍之前把选中集换成图上那份')
  const cu = body('function curEntryOf(e) {')
  ok(cu.includes('if (!e || isCustomEntry(e)) return e') && cu.includes('renderById(satIdOf(e))') && cu.includes('if (!_retired.has(e)) return e') && cu.includes('poolIndex().get(id)'), '③ curEntryOf：合成星不碰（按名重绑另有一路）→ 图上那份 → 退役条目换新池 / 已载组同号那份')
  const sy = body('function syncSelObjects() {')
  ok(sy.includes('remapSel(selEntries, selEntry, followEntry, curEntryOf, satIdOf)') && sy.includes('remapSel(_prevFocus.list, _prevFocus.primary, null, curEntryOf, satIdOf)'), '③ syncSelObjects：选中集 / 主选 / 跟随 / 上一聚焦一起换')
  const sp = body('function setSearchPool(sats) {')
  ok(sp.indexOf('retire(searchPool)') > 0 && sp.indexOf('retire(searchPool)') < sp.indexOf('searchPool = pool') && sp.indexOf('if (syncSelObjects()) refreshSelModel()') > sp.indexOf('searchPool = pool'), '③ setSearchPool：旧池退役 → 换池 → 选中集换到新池那份')
  const eg = body('function ensureGroup(key, reload) {')
  ok(eg.indexOf('retire(groupEntries.get(key))') > 0 && eg.indexOf('retire(groupEntries.get(key))') < eg.indexOf('groupEntries.set(key, list)'), '③ ensureGroup put：上一版整批退役再换新')
  ok(eg.includes('grpListCache.delete(key)') && eg.includes("expLoad(expTag.value)"), '③ ensureGroup put：行内名录随新版作废，正展开着当场重读（体检第四节：内置组名录不随联网版刷新）')
  ok(eg.includes('if (groupEntries.has(key) && !reload) return Promise.resolve()'), '③ ensureGroup(key, reload)：导入替换时已载入也重取')
  const er = body('async function expResolve(sats, tagOverride) {')
  const iLoaded = er.indexOf('const loaded = groupEntries.get(key)'), iFresh = er.indexOf("fetchGroupLiveOrSup(key, { cacheOnly: true })")
  ok(iLoaded > 0 && iFresh > iLoaded, '③ expResolve：内置组「聚焦」先挑已载入那批（不再现建同号副本）')
  ok(er.includes('for (const en of await ephOwnByIds(left))'), '③ expResolve：池里找不到的回退点序列表（800000 段）')
  ok(body('async function expFocus(sats, label, tagOverride) {').includes('selEntries = remapSel(hit, null, null, curEntryOf, satIdOf).list'), '③ expFocus：落选中前换成图上那份、同号只留一份')
  const sg = body('async function ensureSatGroupEntries(id) {')
  ok(sg.includes('for (const en of await ephOwnByIds(left))') && sg.includes('sgEntries.set(id, { sig: satGroupSig(g), entries: hit })'), '③ ensureSatGroupEntries：点序列成员回退点序列表，签名带点序列表版本')
  ok(page.includes("for (const id of satSets.visible.value) if (id[0] === 's') ensureSatGroupEntries(id.slice(2))"), '③ 换池：显示中的卫星组按新池重解')
  ok(body('function liveEntriesOf(list) {').includes('put(curEntryOf(e))'), '③ 上一聚焦恢复：真实星换成图上那份')
  const bm = body('async function bindModel(id, entry) {')
  ok(bm.includes('if (entry && !findSel(entry))') && bm.includes('const en = curEntryOf(entry)') && bm.includes('selEntries.push(en)'), '③ 拖模型到星上并入聚焦集：按身份判重、并进图上那份')

  // 导入替换 → 重载（不必重启）
  ok(/bumpOmmReplaced\(row\.key\)/.test(fm) && fm.indexOf('bumpOmmReplaced(row.key)') > fm.indexOf('if (r && r.ok) {'), '③ 文件管理 importOmm 成功分支发桥信号（带组 key）')
  ok(page.includes('watch(() => fileBridge.ommReplaced, (ev) => { if (ev && ev.key) onOmmReplaced(ev.key) })'), '③ 星座页收桥信号')
  const om = body('function onOmmReplaced(key) {')
  ok(om.includes("if (key === 'satcat') { loadSatcatIndex({ force: true })") && om.includes("[key, 'all', 'other']") && om.includes("key === 'active' ? ['all', 'other']"), '③ onOmmReplaced：编目强制重读；星座组连同全部 / 其他并集作废；active 只进并集')
  ok(om.includes('ensureGroup(k, true)') && om.includes('retire(groupEntries.get(k)); groupEntries.delete(k)') && om.includes('repoolFromDisk()') && om.includes('Promise.allSettled(inflight).then(reload)'), '③ onOmmReplaced：开着的当场重载、关着的作废、全量池按本机重建、等在飞的加载落定')
  ok(/fileBridge\.customSatTick[\s\S]{0,400}repoolFromDisk\(\)/.test(page), '③ 自定义卫星增删同样按本机重建全量池（在建那次落定后再建）')
}

// ==================== ④ fileBridge.ommReplaced：每次换新对象（watch 必触发，同组连导两次也算两次）====================
{
  fileBridge.ommReplaced = null
  bumpOmmReplaced('geo')
  const a = fileBridge.ommReplaced
  bumpOmmReplaced('geo')
  const b = fileBridge.ommReplaced
  ok(a && a.key === 'geo' && b && b.key === 'geo' && a !== b && b.seq === a.seq + 1, '④ bumpOmmReplaced：{ key, seq }，每次新对象、seq 递增', JSON.stringify([a, b]))
  bumpOmmReplaced('satcat')
  ok(fileBridge.ommReplaced.key === 'satcat' && fileBridge.ommReplaced.seq === b.seq + 1, '④ 编目同一通道')
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
