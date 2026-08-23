// ACP4 (#CAL1) / Eutelsat 方向图 ⇄ GRASP .grd 互转自测。运行：npm test
// 被测文件是渲染端 ESM，故本测试自身也是 .mjs。
//
// 口径依据 docs/ACP4格式解析说明.txt（三份 SATSOFT 3.2.0 导出件逆向 + 逐点校验）与
// SATSOFT 手册 §13.6（Eutelsat）。本测试不依赖那三份样本（它们不在仓库里），只用手搓件锁住
// 五条最容易踩的不变式：
//   ① 三个标志位（az/el 谁变化最快、两轴扫描方向）必须真的读——写死会得到一张【转置或镜像】
//      的方向图，且数值全在合法范围内，任何校验都不报警，只有拿真值比对才发现；
//   ② normalized=0 表示值相对峰值，要加回 peak——漏了直接错 50~70 dB；
//   ③ -200 是「无数据」不是「−200 dB」——必须落成 0 场，让下游按域外返回 null；
//   ④ ACP4/Eutelsat 的 az/el 就是 GRASP igrid=4（实测坐实，无镜像），转出来的 GRD 必须写 igrid=4；
//   ⑤ 非 GRASP 的 SATSOFT 家族文件（++++0020/0025/0040）要认出来并给准话，不能塞进 GRASP 解析器。
import { sniffPatternFormat, parseAcp4, parseEutelsat, foreignPatternToGrd, foreignToGrdText, grdToAcp4, grdToEutelsat, readPatMeta } from '../../../src/viz/grd/patFormats.js'
import { parseGrd } from '../../../src/viz/grd/parse.js'

let pass = 0, fail = 0
const ok = (m, c, extra = '') => { if (c) { pass++; console.log('PASS  ' + m + (extra ? '  ' + extra : '')) } else { fail++; console.log('FAIL  ' + m + (extra ? '  ' + extra : '')) } }
const near = (a, b, t = 1e-6) => Math.abs(a - b) <= t

// ───────── ① 识别 ─────────
{
  const grasp = 'title\n++++\n1\n 1 3 2 6\n 0 0\n -1 -1 1 1\n 2 2 0\n 1 0 0 0\n1 0 0 0\n1 0 0 0\n1 0 0 0\n'
  ok('① GRASP', sniffPatternFormat(grasp) === 'grasp')
  ok('① ACP4', sniffPatternFormat('#CAL1\r\n*name\r\nX\r\n') === 'acp4')
  ok('① Eutelsat（第二行正好 6 个数）', sniffPatternFormat('t\n-6.5 5.4 3.4 8.9 193 140\n1 2\n') === 'eutelsat')
  ok('① 第二行 5 个数不算 Eutelsat', sniffPatternFormat('t\n-6.5 5.4 3.4 8.9 193\n1 2\n') === null)
  ok('① ++++0040 认成 SATSOFT 覆盖多边形', sniffPatternFormat('t\n++++0040\n 5 2\n') === 'satsoft:0040')
  ok('① ++++0020 认成 SATSOFT type20', sniffPatternFormat('t\n++++0020\n 1 3 2 1 5 5\n') === 'satsoft:0020')
  // TICRA 自带的对抗样例：标题区里塞一行 "extra lines ++++++++++"（不在行首，按官方 TEXT(1:4) 判据不算）
  ok('① 诱饵行不在行首 → 不算结束标记', sniffPatternFormat('t\nextra lines ++++++++++\n++++\n1\n 1 3 2 6\n') === 'grasp')
}

// ───────── ② ACP4 标志位 / 归一化 / 哨兵 ─────────
// 3(az) × 2(el) 栅，真值 v(az,el) = 10*el + az → 归一后恒为 [0,1,2,10,11,12]
const mkAcp4 = (azFast, azDesc, elDesc, norm, { sentinelAt = -1, extra = [] } = {}) => {
  const at = (a, b) => 10 * b + a
  const v = []
  if (azFast) { for (let b = 0; b < 2; b++) for (let a = 0; a < 3; a++) v.push(at(azDesc ? 2 - a : a, elDesc ? 1 - b : b)) }
  else { for (let a = 0; a < 3; a++) for (let b = 0; b < 2; b++) v.push(at(azDesc ? 2 - a : a, elDesc ? 1 - b : b)) }
  const pk = 11
  const body = (norm ? v.map((x) => x - pk) : v).slice()
  if (sentinelAt >= 0) body[sentinelAt] = -200
  return ['#CAL1', '*name', 'T', ...extra,
    '*peak for this pattern', String(pk),
    '*normalized data (yes 0, no 1)', norm ? '0' : '1',
    '*corrd system (which is faster (az 1, el 0)', azFast ? '1' : '0',
    '*az direction (W > E 0, E > W 1)', azDesc ? '1' : '0',
    '*el direction (S > N 0, N > S 1)', elDesc ? '1' : '0',
    '*points on az side of grid', '3', '*points on el side of grid', '2',
    '*Min and max az angle of grid (degrees)', '0.0', '2.0',
    '*Min and max el angle of grid (degrees)', '0.0', '1.0',
    '*multiplier', '1.0', '*offset', '0.0',
    '*reserved field 2', '', '0.0',
    body.slice(0, 4).join(' '), body.slice(4).join(' ')].join('\r\n') + '\r\n'
}
{
  const want = [0, 1, 2, 10, 11, 12]
  for (const [af, ad, ed, nm] of [[1, 0, 0, 0], [0, 0, 0, 0], [1, 1, 0, 0], [1, 0, 1, 0], [1, 1, 1, 0], [0, 1, 1, 0], [0, 1, 0, 0]]) {
    const b = parseAcp4(mkAcp4(af, ad, ed, nm)).beams[0]
    ok(`② 标志位 azFast=${af} azDesc=${ad} elDesc=${ed}`, Array.from(b.db).every((x, i) => near(x, want[i])), JSON.stringify(Array.from(b.db)))
  }
  const n0 = parseAcp4(mkAcp4(1, 0, 0, 1)).beams[0]
  ok('② normalized=0 加回 peak', Array.from(n0.db).every((x, i) => near(x, want[i])), JSON.stringify(Array.from(n0.db)))
  const st = parseAcp4(mkAcp4(1, 0, 0, 0, { sentinelAt: 2 })).beams[0]
  ok('② -200 解析成 NaN（无数据）', Number.isNaN(st.db[2]) && near(st.db[1], 1))
  const off = parseAcp4(mkAcp4(1, 0, 0, 0).replace('*offset\r\n0.0', '*offset\r\n2.5')).beams[0]
  ok('② offset 加到每个格点', near(off.db[0], 2.5) && near(off.db[5], 14.5))
  const mw = parseAcp4(mkAcp4(1, 0, 0, 0).replace('*multiplier\r\n1.0', '*multiplier\r\n2.0'))
  ok('② multiplier≠1 只告警不施加（手册未定义其用法）', mw.warns.length === 1 && near(mw.beams[0].db[5], 12))
  // 指向角同待遇：它决定整幅图摆在哪儿，而静默忽略造成的错落在合法数值范围内，任何校验都不报警
  const pw = parseAcp4(mkAcp4(1, 0, 0, 0, { extra: ['*az and el pointing angles', '1.5', '-2.0'] }))
  ok('② az/el 指向角≠0 只告警不施加', pw.warns.length === 1 && pw.warns[0].includes('指向角=1.5/-2'), pw.warns[0])
  ok('② 指向角 0/0（三份样本的常态）不告警', parseAcp4(mkAcp4(1, 0, 0, 0, { extra: ['*az and el pointing angles', '0.0', '0.0'] })).warns.length === 0)
  // 表头靠 "*" 注释行前缀匹配，不靠顺序 —— 打乱顺序 + 插入未知字段仍要读对
  const shuffled = mkAcp4(1, 0, 0, 0, { extra: ['*some future field', '7', '*satellite I.D.', '3'] })
  ok('② 未知字段/乱序不影响取值', Array.from(parseAcp4(shuffled).beams[0].db).every((x, i) => near(x, want[i])))
  let msg = ''
  try { parseAcp4(mkAcp4(1, 0, 0, 0).replace('*points on az side of grid\r\n3', '*points on az side of grid\r\n4')) } catch (e) { msg = e.message }
  ok('② 点数与表头不符 → 报错而不是静默错位', /数据点数/.test(msg), msg)
}

// ───────── ③ ACP4 → GRD ─────────
{
  const g = parseGrd(foreignPatternToGrd(mkAcp4(1, 0, 0, 0, { sentinelAt: 2 })).text)
  ok('③ 写成 igrid=4（＝ACP4 的 az/el，无需换算）', g.igrid === 4, `igrid=${g.igrid}`)
  ok('③ icomp=1 / ncomp=2 / 单 set', g.icomp === 1 && g.ncomp === 2 && g.nset === 1)
  const s = g.sets[0]
  ok('③ 网格边界与点数照搬', s.NX === 3 && s.NY === 2 && near(s.XS, 0) && near(s.XE, 2) && near(s.YS, 0) && near(s.YE, 1))
  ok('③ 场幅 = 10^(dB/20)', near(10 * Math.log10(s.P1[5]), 12, 1e-4), (10 * Math.log10(s.P1[5])).toFixed(4))
  ok('③ 哨兵落成 0 场（下游按域外返回 null）', s.P1[2] === 0)
  ok('③ 分量2 恒 0（无相位无交叉极化）', Array.from(s.P2).every((v) => v === 0))
  const meta = readPatMeta(foreignPatternToGrd(mkAcp4(1, 0, 0, 0)).text)
  ok('③ PATMETA 记下来源格式', meta && meta.kind === 'acp4')
}

// ───────── ④ Eutelsat ─────────
{
  // 手册 §13.6：行2 = xs, xe, ys, ye, ny, nx；数据 y(el) 最快
  const eu = ['T', '0.0 2.0 0.0 1.0 2 3', '0 10 1 11 2 12'].join('\r\n') + '\r\n'
  const b = parseEutelsat(eu).beams[0]
  ok('④ 字段序 (xs,xe,ys,ye,ny,nx) + y 最快', b.Naz === 3 && b.Nel === 2 && Array.from(b.db).every((x, i) => near(x, [0, 1, 2, 10, 11, 12][i])), JSON.stringify(Array.from(b.db)))
  const euDesc = ['T', '2.0 0.0 1.0 0.0 2 3', '12 2 11 1 10 0'].join('\r\n') + '\r\n'
  ok('④ xe<xs / ye<ys（轴递减）照样归一到升序', Array.from(parseEutelsat(euDesc).beams[0].db).every((x, i) => near(x, [0, 1, 2, 10, 11, 12][i])))
  const g = parseGrd(foreignToGrdText(parseEutelsat(eu)).text || foreignToGrdText(parseEutelsat(eu)))
  ok('④ 转出的 GRD 也是 igrid=4 单 set', g.igrid === 4 && g.nset === 1)
}

// ───────── ⑤ 往返 ─────────
{
  const src = mkAcp4(1, 0, 0, 0, { sentinelAt: 2 })
  const grd = foreignPatternToGrd(src).text
  const back = parseAcp4(grdToAcp4(grd, { name: 'T' }).text).beams[0]
  const a0 = parseAcp4(src).beams[0]
  let worst = 0, sentBad = 0
  for (let i = 0; i < a0.db.length; i++) {
    const x = a0.db[i], y = back.db[i]
    if (!Number.isFinite(x) || !Number.isFinite(y)) { if (Number.isFinite(x) !== Number.isFinite(y)) sentBad++; continue }
    worst = Math.max(worst, Math.abs(x - y))
  }
  ok('⑤ ACP4→GRD→ACP4 数值往返', worst < 1e-3, `最大偏差 ${worst.toExponential(2)} dB`)
  ok('⑤ 哨兵位置往返一致', sentBad === 0)
  ok('⑤ 往返件仍能被自己识别', sniffPatternFormat(grdToAcp4(grd, { name: 'T' }).text) === 'acp4')
  const e = grdToEutelsat(grd, { name: 'T' })
  ok('⑤ 导出的 Eutelsat 能被自己识别', sniffPatternFormat(e.text) === 'eutelsat')
  ok('⑤ Eutelsat 往返网格一致', parseEutelsat(e.text).beams[0].Naz === e.nx)
  // ★ 表头字段往返：ACP4 → GRD(PATMETA) → ACP4。曾经 grdToAcp4 的默认参数写成 dir='D'/polType=0，
  //   使「显式入参 → PATMETA → 硬缺省」三级兜底的第一级恒真，PATMETA 那一级永远轮不到 —— 上行图
  //   导出成下行、交叉极化图导出成共极化，而文件其余字段一切正常，接收方无从察觉。
  const meta4 = mkAcp4(1, 0, 0, 0, { extra: ['*direction U or D', 'U', '*polarization', 'RHCP',
    '*polarization type 0 co, 1 xpol', '1', '*frequency', '14250.0'] })
  const hdrOf = (txt) => txt.split(/\r\n/)
  const fldOf = (h, k) => { const i = h.findIndex((x) => x.trim().toLowerCase().startsWith('*' + k)); return i < 0 ? '(缺)' : h[i + 1] }
  const hdr = hdrOf(grdToAcp4(foreignPatternToGrd(meta4).text, { name: 'T' }).text)
  ok('⑤ 上下行 direction 往返（U 不能变回 D）', fldOf(hdr, 'direction') === 'U', fldOf(hdr, 'direction'))
  ok('⑤ 极化类型 polType 往返（1 不能变回 0）', fldOf(hdr, 'polarization type') === '1', fldOf(hdr, 'polarization type'))
  ok('⑤ 极化名与频率往返', hdr[hdr.findIndex((x) => x.trim() === '*polarization') + 1] === 'RHCP' && fldOf(hdr, 'frequency').startsWith('14250.'), fldOf(hdr, 'frequency'))
  // 反面：没有 PATMETA 的件（原生 GRASP / 合成件）仍走硬缺省，与修复前逐字节相同
  const h2 = hdrOf(grdToAcp4(grd.replace(/^PATMETA .*$/m, ''), { name: 'T' }).text)
  ok('⑤ 无 PATMETA 时仍是硬缺省 D/0', fldOf(h2, 'direction') === 'D' && fldOf(h2, 'polarization type') === '0')
}

// ───────── ⑥ igrid=6 源导出要做换算（不是原样搬）─────────
{
  // 造一个 igrid=6 的单 set：场幅只与 az 有关（v = 20*log10(amp) = az 的线性函数），
  // 这样"做没做换算"会体现在 el≠0 的行上（换算后 Az 随 el 弯曲）。
  const N = 41, LO = -8, HI = 8, ST = (HI - LO) / (N - 1)
  const L = ['t', '++++', '1', ' 1 3 2 6', '  0  0',
    ` ${LO}.0 ${LO}.0 ${HI}.0 ${HI}.0`.replace(/--/g, '-'), ` ${N} ${N} 0`]
  const lim = ` ${LO.toFixed(1)} ${LO.toFixed(1)} ${HI.toFixed(1)} ${HI.toFixed(1)}`
  L[5] = lim
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const az = LO + ST * c
    const amp = Math.pow(10, (30 - Math.abs(az)) / 20)          // dB = 30 − |az|，与 el 无关
    L.push(` ${amp.toExponential(9)} 0 0 0`)
  }
  const grdText = L.join('\r\n') + '\r\n'
  const g = parseGrd(grdText)
  ok('⑥ 造出的源确为 igrid=6', g.igrid === 6 && g.sets[0].NX === N)
  const a = parseAcp4(grdToAcp4(grdText, { name: 'T' }).text).beams[0]
  ok('⑥ 输出网格沿用源边界与点数（SATSOFT 亦如此）', a.Naz === N && a.Nel === N && near(a.azMin, LO, 1e-6) && near(a.azMax, HI, 1e-6))
  // 中线（el=0）上换算是恒等 → 值应为 30−|az|
  const mid = (N - 1) / 2
  ok('⑥ el=0 中线上仍是 30−|az|', near(a.db[mid * N + mid], 30, 2e-3) && near(a.db[mid * N + 0], 30 - 8, 5e-3),
    `${a.db[mid * N + mid].toFixed(4)} / ${a.db[mid * N + 0].toFixed(4)}`)
  // 离轴点上 igrid6 的 Az 与 ACP4 的 az 不再重合 → 原样搬会等于 30−|az|，做了换算则偏离。
  // 取内点而不是网格角：角上换算后会越出源窗口，本就该是哨兵（真实文件里 el=±9 整行几乎全是 -200）。
  const cT = 2, rT = N - 3
  const azT = LO + ST * cT, elT = LO + ST * rT
  const D2R = Math.PI / 180
  const rx = -Math.sin(azT * D2R) * Math.cos(elT * D2R)
  const ry = Math.sin(elT * D2R), rz = Math.cos(azT * D2R) * Math.cos(elT * D2R)
  const azG = Math.atan2(-rx, Math.hypot(ry, rz)) * 180 / Math.PI
  const expConv = 30 - Math.abs(azG), expRaw = 30 - Math.abs(azT)
  const got = a.db[rT * N + cT]
  ok(`⑥ (az ${azT}, el ${elT}) 按换算后的 Az 取值（不是原样搬）`,
    Number.isFinite(got) && Math.abs(got - expConv) < 0.02 && Math.abs(got - expRaw) > 0.03,
    `实得 ${Number(got).toFixed(4)}，换算预期 ${expConv.toFixed(4)}，原样搬会是 ${expRaw.toFixed(4)}`)
  // 网格角（两轴都到边）换算后必然越界 → 必须是哨兵，不能凭空外推出一个值
  ok('⑥ 网格角换算后越界 → 哨兵', !Number.isFinite(a.db[(N - 1) * N + 0]))
}

// ───────── ⑦ 异常件给准话 ─────────
{
  for (const [t, re] of [['t\n++++0040\n 5 2\n', /覆盖多边形/], ['t\n++++0020\n 1 3 2 1 5 5\n', /type 20/], ['随便\n乱码\n', /无法识别/]]) {
    let msg = ''
    try { foreignPatternToGrd(t) } catch (e) { msg = e.message }
    ok('⑦ 拒绝并说明是什么：' + msg, re.test(msg))
  }
}

// ───────── ⑧ 告警不是失败：调用端 useGrdCoverage.importGrd 的两条通道 ─────────
// 这条必须端到端跑真调用端 —— 转换器一直是对的（warns 与 throw 走两条路），坑在调用端曾把
// c.warns 推进 errs，于是带 multiplier 的文件明明导入成功，界面弹的却是「部分文件导入失败」。
{
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0)   // 树/设置的深监听走 rAF 合帧重算，node 里没有这个全局
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
  const mult2 = mkAcp4(1, 0, 0, 0).replace('*multiplier\r\n1.0', '*multiplier\r\n2.0')
  const bad = mkAcp4(1, 0, 0, 0).replace('*points on az side of grid\r\n3', '*points on az side of grid\r\n4')
  let feed = []
  globalThis.window = { api: { coverageGrd: { open: async () => ({ files: feed }), save: async () => ({ file: 'stub.grd' }) } } }
  const { useGrdCoverage } = await import('../../../src/viz/grd/useGrdCoverage.js')
  const { alertMsg } = await import('../../../src/stores/alert.js')
  const grd = useGrdCoverage(() => null, () => null, () => false)
  const mkSat = () => ({ folder: 'T', satName: 'T', kind: 'preset', lon: 110.5, lat: 0, altKm: 35786, antennas: [] })

  feed = [{ base: 'MULT.pat', text: mult2 }]
  let sat = mkSat(); alertMsg.value = ''
  let added = await grd.importGrd(sat)
  ok('⑧ 带告警的文件照样导入成功', added.length === 1 && sat.antennas.length === 1, 'added=' + added.length)
  ok('⑧ 提示走「导入告警」，不说「导入失败」', /导入告警/.test(alertMsg.value) && !/失败/.test(alertMsg.value), JSON.stringify(alertMsg.value))

  feed = [{ base: 'BAD.pat', text: bad }]
  sat = mkSat(); alertMsg.value = ''
  added = await grd.importGrd(sat)
  ok('⑧ 真错误仍报失败（反面）', added.length === 0 && /导入失败/.test(alertMsg.value), JSON.stringify(alertMsg.value))

  feed = [{ base: 'MULT.pat', text: mult2 }, { base: 'BAD.pat', text: bad }]
  sat = mkSat(); alertMsg.value = ''
  added = await grd.importGrd(sat)
  ok('⑧ 一失败一告警：两段都在，各说各的', added.length === 1 && /导入失败/.test(alertMsg.value) && /导入告警/.test(alertMsg.value), JSON.stringify(alertMsg.value))
}

// ───────── ⑨ '++++' 判据：多候选试读 + 可读报错（parse.js 与 grdSampler.js 两份同源）─────────
// 官方判据 TEXT(1:4)=='++++' 会把两类冒名者一并放进来：SATSOFT 的 '++++NNNN'、文本头里的装饰行。
// 只取第一个候选就会读到垃圾头，且旧实现是抛 undefined.trim() 的 JS 内部异常，界面上完全看不懂。
{
  const good = 'title line\r\n++++\r\n1\r\n 1 3 2 6\r\n 0 0\r\n -1 -1 1 1\r\n 2 2 0\r\n 1 0 0 0\r\n1 0 0 0\r\n1 0 0 0\r\n1 0 0 0\r\n'
  const core = (await import('../utils/grdSampler.js')).default || (await import('node:module')).createRequire(import.meta.url)('../utils/grdSampler.js')
  for (const [who, pg] of [['parse.js', parseGrd], ['grdSampler.js', core.parseGrd]]) {
    const r = pg(good)
    ok(`⑨ ${who}：正常件照旧`, r.nset === 1 && r.igrid === 6 && r.sets[0].NX === 2)
    // 装饰行满足官方判据但其后不是头 → 跳过它继续找，结果须与无装饰行时逐位相同
    const r2 = pg('t\r\n++++++++ Notes ++++++++\r\nsome note\r\n' + good)
    ok(`⑨ ${who}：文本头装饰行 ++++++++ 在前仍解析正确`,
      r2.nset === 1 && r2.sets[0].NX === 2 && r2.sets[0].c1re[0] === r.sets[0].c1re[0])
    ok(`⑨ ${who}：'++++ Grid' 带尾注是合法结束标记`, pg(good.replace('++++', '++++ Grid')).nset === 1)
    // SATSOFT ++++0040：头是 ' 5 2 / 721 38'，按 GRASP 读是垃圾 → 必须报可读的错
    let msg = ''
    try { pg('CS6E_Tx200\r\n++++0040\r\n 5 2\r\n 721 38\r\n') } catch (e) { msg = e.message }
    ok(`⑨ ${who}：++++0040 报可读错误而非 JS 内部异常`, /不是 GRASP 网格头/.test(msg), JSON.stringify(msg))
    msg = ''
    try { pg(good.split('\r\n').slice(0, 9).join('\r\n')) } catch (e) { msg = e.message }
    ok(`⑨ ${who}：截断件报可读错误`, /提前结束/.test(msg), JSON.stringify(msg))
    msg = ''
    try { pg('no marker at all\r\n1 2 3\r\n') } catch (e) { msg = e.message }
    ok(`⑨ ${who}：完全没有 ++++ 时仍报原来那条`, /未找到结束标记/.test(msg), JSON.stringify(msg))
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
