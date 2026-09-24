// 车辆内置实体模板数据（三期契约 DESIGN3 §1 P1b、E13；A3 规格 §7.3 记录形状、§7.4「车」）。
//
// 纯数据 + 小的派生计算；只 import ./common.mjs（不 import assembly / components/index，防环）。汇总、校验、冻结与对外 API
// 在 models/entityTemplates.mjs。
//
// ★ 数值口径：
//   dims = 研究表 research/entity-templates.json 的有出处字段，value / unit / source / confidence 逐字抄；note 是中性短句。
//   prov（组件参数 ← 出处字段）：{dim, pick?, k?}（mm × 0.001、cm × 0.01；范围值取 max = 包络口径）或派生 {dims, derive, fn, with}：
//     'mul'     dims[0] 的值 × Π with 的全部值（车顶展开天线转轴下移 = 反射面口径 × 0.5）；
//     'linear'  with.a + with.b × dims[0] 的值（对象型取 [with.pick]）：车高 = 出处车高 × 0.001 + 车顶架高。
//   车高口径：veh.body.heightM 是「地面到车顶架顶」；出处车高是出厂状态的车顶外高（Sprinter 原文 on the outside；LC300 不含车顶天线），
//   车顶架是为装终端加装的件，所以 heightM = 出处车高 + rackHM（组件缺省 0.1 m），车壳顶恰在出处车高。
//   车身比例（轴距、轮径、离地间隙、车顶架高…）走 veh.body 的车型比例表（示意）；厢式车车宽无出处（needsInput），填示意 2.02 m。
//   平板终端 / 展开座的外形参数与型号预设同值（型号选中时预设生效；这里照填并记 prov，改成 custom 时也不走样）。

import { VEH_COMPONENTS } from '../components/veh.mjs'
import { dim, record } from './common.mjs'

const U = Object.freeze({
  lc300: 'https://media.adtorqueedge.com/new-cars/toyota-au/brochures/20231024_lc300_spec-sheet-v2.pdf',
  hilux: 'https://media.adtorqueedge.com/new-cars/toyota-au/hilux/hilux-specs.pdf',
  sprinter: 'https://www.vanguide.co.uk/guides/mercedes-benz-sprinter-dimensions/',
  u8: 'https://www.idirect.net/wp-content/uploads/2023/01/ProductSheet-Kymeta-Hawk-u8.pdf',
  inetvu: 'https://www.c-comsat.com/wp-content/uploads/2022/02/iNetVuDatasheets_RevFeb2022-1.pdf'
})

const rec = (r) => record('vehicle', r)
const vehDoc = (name, comps) => ({ kind: 'assembly', schema: 1, domain: 'vehicle', name, comps, density: {}, massTargetKg: null })
const vOf = (d, pick) => (d.value !== null && typeof d.value === 'object' ? d.value[pick] : d.value)
/** 车顶架高：veh.body 的 rackHM 缺省（模板不改它，车高派生里按它加）。 */
const RACK_HM = VEH_COMPONENTS.find((d) => d.type === 'veh.body').params.rackHM.def
/** 车高派生：出处车高（mm）× 0.001 + 车顶架高。 */
const heightProv = (pick) => ({ dims: ['heightMm'], derive: 'heightMm × 0.001 + rackHM（出处车高 = 出厂车顶外高，车顶架为加装件）', fn: 'linear', with: pick ? { a: RACK_HM, b: 0.001, pick } : { a: RACK_HM, b: 0.001 } })
const heightOf = (d, pick) => RACK_HM + 0.001 * vOf(d, pick)

const U8_DIMS = () => ({ LWHcm: dim({ L: 89.5, W: 89.5, H: 14 }, 'cm', U.u8, '平板终端外形') })
const U8_PROV = (id) => ({
  [`${id}.lengthM`]: { dim: 'LWHcm', pick: 'L', k: 0.01 }, [`${id}.widthM`]: { dim: 'LWHcm', pick: 'W', k: 0.01 }, [`${id}.heightM`]: { dim: 'LWHcm', pick: 'H', k: 0.01 }
})
const u8Params = (d) => ({ model: 'kymeta-u8', lengthM: d.LWHcm.value.L * 0.01, widthM: d.LWHcm.value.W * 0.01, heightM: d.LWHcm.value.H * 0.01 })
/** 车体 + 车顶平板动中通（贴车顶架插座）。 */
function cotmCar(o) {
  const { dims, pick } = o
  const body = { style: o.style, lengthM: vOf(dims.lengthMm, pick) * 0.001, widthM: vOf(dims.widthMm, pick) * 0.001, heightM: heightOf(dims.heightMm, pick) }
  const pk = pick ? { pick } : {}
  return rec({
    id: o.id, title: o.title, titleZh: o.titleZh, representative: o.representative, dims,
    prov: {
      'body.lengthM': { dim: 'lengthMm', ...pk, k: 0.001 }, 'body.widthM': { dim: 'widthMm', ...pk, k: 0.001 }, 'body.heightM': heightProv(pick),
      ...U8_PROV('cotm')
    },
    needsInput: [],
    doc: vehDoc(o.titleZh, [
      { id: 'body', type: 'veh.body', parent: null, params: body },
      { id: 'cotm', type: 'veh.cotm.flat', parent: 'body', attach: { mode: 'socket', socket: 'roof' }, params: u8Params(dims) }
    ])
  })
}

// —— 越野车 + 平板动中通
const suv = cotmCar({
  id: 'ent:suv-cotm', title: 'SUV with flat-panel COTM', titleZh: '动中通越野车', style: 'suv', pick: null,
  representative: '丰田 LandCruiser 300 + Kymeta Hawk u8',
  dims: {
    lengthMm: dim(4980, 'mm', U.lc300), widthMm: dim(1980, 'mm', U.lc300), heightMm: dim(1950, 'mm', U.lc300, '车高，不含车顶天线'),
    ...U8_DIMS()
  }
})

// —— 双排座皮卡 + 平板动中通（长 / 宽 / 高取各等级范围上限 = 包络口径）
const pickup = cotmCar({
  id: 'ent:pickup-cotm', title: 'Pickup with flat-panel COTM', titleZh: '动中通皮卡', style: 'pickup', pick: 'max',
  representative: '丰田 HiLux 4x4 双排座 + Kymeta Hawk u8',
  dims: {
    lengthMm: dim({ min: 5320, max: 5380 }, 'mm', U.hilux, '各等级范围'), widthMm: dim({ min: 1855, max: 1885 }, 'mm', U.hilux, '各等级范围'),
    heightMm: dim({ min: 1848, max: 1880 }, 'mm', U.hilux, '各等级范围'),
    ...U8_DIMS()
  }
})

// —— 高顶厢式指挥车 + 车顶自动展开 1.2 m 偏馈（静中通）
const van = (() => {
  const dims = {
    lengthMm: dim(6967, 'mm', U.sprinter, '长轴距车型', 'secondary'), heightMm: dim(2620, 'mm', U.sprinter, '高顶车型', 'secondary'),
    reflectorM: dim(1.2, 'm', U.inetvu, '反射面口径'), offsetAngleDeg: dim(16.97, 'deg', U.inetvu),
    elevationRangeDeg: dim({ min: 0, max: 90 }, 'deg', U.inetvu),
    stowedLWHcm: dim({ L: 203, W: 124, H: 35 }, 'cm', U.inetvu, '收拢外形，不含整流罩')
  }
  const D = dims.reflectorM.value, drop = { ratio: 0.5 }
  return rec({
    id: 'ent:van-driveaway', title: 'Command van with drive-away antenna', titleZh: '静中通指挥车',
    representative: '奔驰 Sprinter 长轴高顶 + C-COM iNetVu 1202',
    dims,
    prov: {
      'body.lengthM': { dim: 'lengthMm', k: 0.001 }, 'body.heightM': heightProv(null),
      'dw.lengthM': { dim: 'stowedLWHcm', pick: 'L', k: 0.01 }, 'dw.widthM': { dim: 'stowedLWHcm', pick: 'W', k: 0.01 }, 'dw.heightM': { dim: 'stowedLWHcm', pick: 'H', k: 0.01 },
      'refl.diameterM': { dim: 'reflectorM' }, 'refl.offsetDeg': { dim: 'offsetAngleDeg' },
      'refl.elMinDeg': { dim: 'elevationRangeDeg', pick: 'min' }, 'refl.elMaxDeg': { dim: 'elevationRangeDeg', pick: 'max' },
      'refl.pivotDropM': { dims: ['reflectorM'], derive: 'reflectorM × 0.5（转轴在口径下缘）', fn: 'mul', with: { ...drop } }
    },
    needsInput: ['widthMm'],
    doc: vehDoc('静中通指挥车', [
      { id: 'body', type: 'veh.body', parent: null, params: { style: 'van', lengthM: dims.lengthMm.value * 0.001, widthM: 2.02, heightM: heightOf(dims.heightMm, null) } },
      {
        id: 'dw', type: 'veh.driveaway', parent: 'body', attach: { mode: 'socket', socket: 'roof' },
        params: { model: 'inetvu-1202', lengthM: 203 * 0.01, widthM: 124 * 0.01, heightM: 35 * 0.01, azTravelDeg: 400 }
      },
      {
        id: 'refl', type: 'es.refl.offset', parent: 'dw', attach: { mode: 'socket', socket: 'el' },
        params: { diameterM: D, offsetDeg: dims.offsetAngleDeg.value, elMinDeg: 0, elMaxDeg: 90, azTravelDeg: 400, collar: false, feedArm: 'boom', pivotDropM: D * drop.ratio, el0Deg: 35 }
      }
    ])
  })
})()

export const VEH_TEMPLATES = [suv, pickup, van]
