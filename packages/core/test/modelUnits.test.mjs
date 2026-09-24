// 单位推断与已知尺寸反算自测（packages/core/models/units.mjs）。运行：node packages/core/test/modelUnits.test.mjs
//
// 为什么测：单位错一档，跟随视图里卫星就差 10–1000 倍，挂点、质量特性全跟着错；NASA 美术模型单位本就不可信，
// 推断的优先级与可信度必须确定可复现。钉死：① 反算缺省照给定尺寸原值（不吸附）、显式窗口才吸附；② 五档优先级（STEP 头 > extras.satsim > 已知尺寸 >
// 导出器线索 > 包围盒量级）；③ 包围盒分档边界；④ OBJ / STEP 文件头解析；⑤ SSL-1300 夹具的真实数字。
//
// ★ SSL-1300 的口径（与任务书 §2.1 的说法不同，按夹具实测）：夹具包围盒是 268.33 × 61.27 × 80.37 单位，
//   最长边 268.33 是太阳翼方向（翼展）；80.37 是另一根轴（glTF +Z）。任务书说的「跨度 80.4 → 英尺 → 24.5 m 翼展」
//   把高度轴当成了翼展。按 known-dims.json 的 SSL-1300 条目（翼展「超过 24 m」，出处史密森尼 NASM Sirius FM-4
//   展品页 Wayback 存档，secondary，下界）反算：24 / 268.33 = 0.0894 m/单位，离任何标准单位都超过 10%，
//   不吸附——unitGuess 'unknown'、按原比值缩放。这条测试把真实结论钉住，免得有人按任务书改回英尺。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as U from '../models/units.mjs'
import { parseGlb, gltfBoundsApprox } from '../models/glb.mjs'

let pass = 0
const ok = (c, msg) => { assert.ok(c, msg); pass++ }
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); pass++ }
const near = (a, b, tol, msg) => { assert.ok(Math.abs(a - b) <= tol, `${msg}：${a} vs ${b}`); pass++ }

// ① 反算与吸附
eq(U.UNIT_SCALE, { m: 1, cm: 0.01, mm: 0.001, in: 0.0254, ft: 0.3048 }, '单位表')
// 缺省不吸附（工作台「反算」口径）：用户给的尺寸必须原样兑现，不能被吸附改掉
const exact26 = U.scaleFromKnownDim({ measuredModelUnits: 80, knownMeters: 26 })
eq([exact26.ok, exact26.scaleToMeters, exact26.unitGuess, exact26.snapped], [true, 26 / 80, 'unknown', false], '缺省不吸附：80 单位 ↔ 26 m → 0.325（不变成英尺的 24.38 m）')
near(80 * exact26.scaleToMeters, 26, 1e-12, '反算后的尺寸与给定尺寸逐位一致')
eq([exact26.nearest.unitGuess, exact26.nearest.scaleToMeters], ['ft', 0.3048], 'nearest 给出最近的标准单位（界面可作为可选的吸附项）')
near(exact26.nearest.relErr, 0.325 / 0.3048 - 1, 1e-12, 'nearest.relErr = 与英尺的偏差 6.6%')
const snap26 = U.scaleFromKnownDim({ measuredModelUnits: 80, knownMeters: 26, snapTolerance: U.INFER_SNAP })
eq([snap26.scaleToMeters, snap26.unitGuess, snap26.snapped], [0.3048, 'ft', true], '显式给 INFER_SNAP（自动推断 / 离线管线口径）才吸附到英尺')
const ft = U.scaleFromKnownDim({ measuredModelUnits: 80.4, knownMeters: 24.5, snapTolerance: U.INFER_SNAP })
eq([ft.ok, ft.unitGuess, ft.scaleToMeters, ft.snapped], [true, 'ft', 0.3048, true], '合成例：80.4 单位 ↔ 24.5 m、10% 窗口 → 英尺')
near(ft.rawScale, 24.5 / 80.4, 1e-15, '原始比值保留在 rawScale')
eq(U.INFER_SNAP, 0.1, '自动推断的吸附窗口 10%')
const mm = U.scaleFromKnownDim({ measuredModelUnits: 1000, knownMeters: 1 })
eq([mm.unitGuess, mm.scaleToMeters, mm.snapped], ['mm', 0.001, true], '缺省窗口下比值恰为标准单位（只差浮点尾数）仍认作该单位：1000 单位 ↔ 1 m → 毫米')
eq(U.scaleFromKnownDim({ measuredModelUnits: 100, knownMeters: 2.54 }).unitGuess, 'in', '100 单位 ↔ 2.54 m → 英寸（2.54/100 的浮点尾数不影响）')
eq(U.scaleFromKnownDim({ measuredModelUnits: 3, knownMeters: 3.2 }).unitGuess, 'unknown', '缺省：偏差 6.7% 不吸附')
eq(U.scaleFromKnownDim({ measuredModelUnits: 3, knownMeters: 3.2, snapTolerance: U.INFER_SNAP }).unitGuess, 'm', '10% 窗口：偏差 6.7% 吸附到米')
const loose = U.scaleFromKnownDim({ measuredModelUnits: 3, knownMeters: 3.6, snapTolerance: U.INFER_SNAP })
eq([loose.unitGuess, loose.snapped, loose.scaleToMeters], ['unknown', false, 1.2], '10% 窗口：偏差 20% 不吸附，按原比值')
eq(U.scaleFromKnownDim({ measuredModelUnits: 3, knownMeters: 3.6, snapTolerance: 0.25 }).unitGuess, 'm', '吸附窗口可调')
eq(U.scaleFromKnownDim({ measuredModelUnits: 3, knownMeters: 3.6, snapTolerance: -1 }).unitGuess, 'unknown', '非法窗口按不吸附')
eq(U.scaleFromKnownDim({ measuredModelUnits: 1e-300, knownMeters: 1e300 }).ok, false, '比值溢出 → 错误不抛')
eq(U.scaleFromKnownDim({ measuredModelUnits: 0, knownMeters: 1 }).ok, false, '量得长度 0 → 错误')
eq(U.scaleFromKnownDim({ measuredModelUnits: 5, knownMeters: -1 }).ok, false, '已知尺寸负 → 错误')
eq(U.scaleFromKnownDim().ok, false, '无参数 → 错误不抛')
eq(U.scaleFromKnownDim({ measuredModelUnits: NaN, knownMeters: 1 }).ok, false, 'NaN → 错误')

// ⑤ SSL-1300 夹具（口径见文件头）
const ssl = gltfBoundsApprox(parseGlb(new Uint8Array(readFileSync(new URL('./fixtures/models/ssl-1300.glb', import.meta.url)))).json)
near(ssl.span, 268.33, 0.01, 'SSL-1300 最长边（翼展方向）268.33 单位')
near(ssl.size[2], 80.37, 0.01, 'SSL-1300 的 80.4 是 glTF Z 轴，不是翼展')
// known-dims.json：space-systems-loral-ssl-1300，measure=span，valueM=24，出处 NASM Sirius FM-4（Wayback 存档），secondary
const KNOWN_SPAN_M = 24
const KNOWN_SRC = 'http://web.archive.org/web/20241214192625/https://airandspace.si.edu/collection-objects/satellite-communications-sirius-fm-4/nasm_A20130001000'
const g = U.guessUnits({ bboxSpanModelUnits: ssl.span, sourceFormat: 'glb', headerHints: { knownDim: { measuredModelUnits: ssl.span, knownMeters: KNOWN_SPAN_M, source: KNOWN_SRC } } })
eq([g.rule, g.unitGuess, g.confidence], ['known-dim', 'unknown', 'medium'], 'SSL-1300 按已知翼展反算：不落在任何标准单位上 → unknown、medium')
near(g.scaleToMeters, 24 / 268.33, 1e-4, 'SSL-1300 scaleToMeters ≈ 0.0894')
near(ssl.span * g.scaleToMeters, 24, 1e-9, '反算后翼展正好 24 m')
ok(Math.abs(g.scaleToMeters / 0.3048 - 1) > 0.5, '英尺（0.3048）会把翼展放大到 81.8 m——任务书的英尺说法不成立')
const gb = U.guessUnits({ bboxSpanModelUnits: ssl.span, sourceFormat: 'glb' })
eq([gb.rule, gb.unitGuess, gb.confidence], ['bbox', 'm', 'low'], 'SSL-1300 没有已知尺寸时：包围盒规则按米、low')

// ② 优先级
const all = { stepUnit: 'mm', satsimUnits: { scaleToMeters: 0.5, unitGuess: 'unknown', sizeVerified: true }, knownDim: { measuredModelUnits: 10, knownMeters: 10, source: 's' }, objHeader: '# This file uses centimeters as units for non-parametric coordinates.' }
eq(U.guessUnits({ bboxSpanModelUnits: 5000, sourceFormat: 'step', headerHints: all }).rule, 'step-header', 'STEP 头最优先')
eq(U.guessUnits({ bboxSpanModelUnits: 5000, sourceFormat: 'step', headerHints: all }).scaleToMeters, 1, 'STEP 已由 OCCT 换成米（T7）→ 1')
eq(U.guessUnits({ sourceFormat: 'stp', headerHints: { stepUnit: 'mm', convertedToMeters: false } }), { unitGuess: 'mm', scaleToMeters: 0.001, confidence: 'high', rule: 'step-header', notes: ['STEP 头声明 mm'] }, '未换算时按文件单位')
const s2 = U.guessUnits({ bboxSpanModelUnits: 5000, sourceFormat: 'obj', headerHints: all })
eq([s2.rule, s2.scaleToMeters, s2.confidence], ['satsim', 0.5, 'high'], '非 STEP：extras.satsim 次之（已核定 → high）')
eq(U.guessUnits({ sourceFormat: 'glb', headerHints: { satsimUnits: { scaleToMeters: 0.01, unitGuess: 'cm' } } }).confidence, 'medium', 'extras.satsim 未核定 → medium')
const s3 = U.guessUnits({ bboxSpanModelUnits: 5000, sourceFormat: 'obj', headerHints: { knownDim: all.knownDim, objHeader: all.objHeader } })
eq([s3.rule, s3.unitGuess, s3.confidence], ['known-dim', 'm', 'high'], '已知尺寸 > 导出器线索；有出处且吸附 → high')
eq(U.guessUnits({ sourceFormat: 'glb', headerHints: { knownDim: { measuredModelUnits: 10, knownMeters: 10 } } }).confidence, 'medium', '已知尺寸无出处 → medium')
const kdSnap = U.guessUnits({ sourceFormat: 'glb', headerHints: { knownDim: { measuredModelUnits: 80, knownMeters: 26, source: 's' } } })
eq([kdSnap.unitGuess, kdSnap.scaleToMeters, kdSnap.confidence], ['ft', 0.3048, 'high'], '自动推断档缺省按 10% 吸附（公开尺寸常是约数）')
const kdExact = U.guessUnits({ sourceFormat: 'glb', headerHints: { knownDim: { measuredModelUnits: 80, knownMeters: 26, source: 's', snapTolerance: 0 } } })
eq([kdExact.unitGuess, kdExact.scaleToMeters, kdExact.confidence], ['unknown', 0.325, 'medium'], 'knownDim.snapTolerance: 0 → 照尺寸原值')
eq(U.guessUnits({ bboxSpanModelUnits: 50, sourceFormat: 'glb', headerHints: { knownDim: { measuredModelUnits: 0, knownMeters: 10 } } }).rule, 'bbox', '已知尺寸无效 → 落到下一档')
const s4 = U.guessUnits({ bboxSpanModelUnits: 500, sourceFormat: 'obj', headerHints: { objHeader: all.objHeader } })
eq([s4.rule, s4.unitGuess, s4.scaleToMeters, s4.confidence], ['exporter', 'cm', 0.01, 'medium'], 'Maya OBJ 首行 centimeters → 厘米')
eq(U.guessUnits({ bboxSpanModelUnits: 500, sourceFormat: 'obj', headerHints: { objHeader: '# 3ds Max Wavefront OBJ Exporter v0.97b\n# File Created: 01.01.2020' } }).unitGuess, 'in', '3ds Max OBJ → 英寸')
eq(U.guessUnits({ bboxSpanModelUnits: 4, sourceFormat: 'obj', headerHints: { objHeader: all.objHeader } }).confidence, 'low', '导出器说厘米但换算后只有 4 cm（< 5 cm）→ 降 low')
eq(U.guessUnits({ bboxSpanModelUnits: 5, sourceFormat: 'obj', headerHints: { objHeader: all.objHeader } }).confidence, 'medium', '恰好 5 cm 仍算合理（下界含）')
eq(U.guessUnits({ bboxSpanModelUnits: 200, sourceFormat: 'fbx', headerHints: { fbxUnitScaleFactor: 1 } }).unitGuess, 'cm', 'FBX UnitScaleFactor=1 → 厘米')
eq(U.guessUnits({ bboxSpanModelUnits: 200, sourceFormat: 'fbx', headerHints: { fbxUnitScaleFactor: 2.54 } }).unitGuess, 'in', 'FBX UnitScaleFactor=2.54 → 英寸')
const f7 = U.guessUnits({ bboxSpanModelUnits: 200, sourceFormat: 'fbx', headerHints: { fbxUnitScaleFactor: 7 } })
eq([f7.unitGuess, f7.scaleToMeters], ['unknown', 0.07], 'FBX 非标准系数 → unknown、按系数缩放')
eq(U.guessUnits({ bboxSpanModelUnits: 300, sourceFormat: 'glb', headerHints: { generator: 'Autodesk 3ds Max 2021' } }).unitGuess, 'in', 'glTF generator 为 3ds Max → 英寸线索')
eq(U.guessUnits({ bboxSpanModelUnits: 300, sourceFormat: 'glb', headerHints: { objHeader: all.objHeader } }).rule, 'bbox', 'OBJ 头只对 OBJ 生效')

// ③ 包围盒分档
const bb = (s) => { const r = U.guessUnits({ bboxSpanModelUnits: s }); return [r.unitGuess, r.scaleToMeters, r.confidence] }
eq(bb(0.29), ['unknown', 1, 'low'], '< 0.3 → unknown（不擅自放大，1U 立方星按米也说得通）')
eq(bb(0.3), ['m', 1, 'low'], '0.3 → 米（下界含）')
eq(bb(300), ['m', 1, 'low'], '300 → 米（上界含）')
eq(bb(301), ['cm', 0.01, 'low'], '300–3000 → 厘米')
eq(bb(3000), ['mm', 0.001, 'low'], '3000–300000 → 毫米')
eq(bb(300000), ['mm', 0.001, 'low'], '300000 → 毫米（上界含）')
eq(bb(300001), ['unknown', 1, 'low'], '> 300000 → unknown')
eq(U.guessUnits().rule, 'none', '无参数 → none 不抛')
eq(U.guessUnits({ bboxSpanModelUnits: -3 }).rule, 'none', '负跨度 → none')
eq(U.guessUnits('x').unitGuess, 'unknown', '非对象 → unknown')

// ④ 文件头
eq(U.objHeaderUnit('# This file uses centimeters as units for non-parametric coordinates.\nv 0 0 0'), 'cm', 'Maya 头')
eq(U.objHeaderUnit('# Units: millimeters\nv 0 0 0'), 'mm', '通用「Units:」写法')
eq(U.objHeaderUnit('v 0 0 0\n# uses centimeters'), 'cm', '前 20 行内的注释都看')
eq(U.objHeaderUnit('v 0 0 0\nf 1 2 3'), null, '无线索 → null')
eq(U.objHeaderUnit(null), null, '非字符串 → null')
const step = (unitLine) => `ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#10=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));\n${unitLine}\nENDSEC;`
eq(U.stepLengthUnit(step('#11=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));')), 'mm', 'STEP 毫米')
eq(U.stepLengthUnit(step('#11 = ( LENGTH_UNIT ( ) NAMED_UNIT ( * ) SI_UNIT ( $, .METRE. ) );')), 'm', 'STEP 米（带空格）')
eq(U.stepLengthUnit(step('#11=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.CENTI.,.METRE.));')), 'cm', 'STEP 厘米')
eq(U.stepLengthUnit(step("#11=(CONVERSION_BASED_UNIT('INCH',#12)LENGTH_UNIT()NAMED_UNIT(#13));\n#12=LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),#14);\n#14=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));")), 'in', 'STEP 英寸（换算基准里的毫米不误判）')
eq(U.stepLengthUnit(step('#11=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.KILO.,.METRE.));')), null, 'STEP 千米 → null（交给包围盒）')
eq(U.stepLengthUnit(step('')), null, '没有长度单位 → null')
eq(U.stepLengthUnit(42), null, '非字符串 → null')

console.log(`modelUnits: ${pass} 项通过`)
