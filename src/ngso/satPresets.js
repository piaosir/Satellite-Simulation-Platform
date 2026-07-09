// GEO 卫星预设列表（自小程序 index.js 的 satellites 数组原样移植）。
// position 为东经轨道位置（°E）。选中后填入卫星名称 + 轨道位置。
export const SAT_PRESETS = [
  { name: 'CHINASAT 10R', position: '110.5' },
  { name: 'CHINASAT 6D', position: '125' },
  { name: 'CHINASAT 6C', position: '130.5' },
  { name: 'CHINASAT 6E', position: '115.5' },
  { name: 'CHINASAT 9', position: '92.2' },
  { name: 'CHINASAT 9B', position: '101.4' },
  { name: 'CHINASAT 9C', position: '92.2' },
  { name: 'CHINASAT 10', position: '110.5' },
  { name: 'CHINASAT 11', position: '98' },
  { name: 'CHINASAT 12', position: '87.5' },
  { name: 'CHINASAT 15', position: '51.5' },
  { name: 'CHINASAT 19', position: '163.4' },
  { name: 'CHINASAT 16', position: '110.5' },
  { name: 'CHINASAT 26', position: '125' },
  { name: 'CHINASAT 27', position: '87.5' },
  { name: 'APSTAR 5C', position: '138' },
  { name: 'APSTAR 6C', position: '134' },
  { name: 'APSTAR 7', position: '76.5' },
  { name: 'APSTAR 9', position: '142' },
  { name: 'APSTAR 6D', position: '134' },
  { name: 'AsiaSat 5', position: '100.5' },
  { name: 'AsiaSat 6', position: '120' },
  { name: 'AsiaSat 7', position: '105.5' },
  { name: 'AsiaSat 9', position: '122' },
  { name: 'JCSAT-1C', position: '150' },
  { name: 'JCSAT-2B', position: '154' },
  { name: 'JCSAT-3A', position: '128' },
  { name: 'JCSAT-4B', position: '124' }
]

// 工作频段 → 默认上/下行频率（GHz），与小程序 FREQUENCY_BAND_OPTIONS 一致。
export const BAND_FREQ = {
  L: { up: 1.6, dn: 1.5 }, S: { up: 2.1, dn: 2.3 }, X: { up: 8.0, dn: 7.25 },
  ExtC: { up: 6.545, dn: 3.54 }, C: { up: 6.15, dn: 3.95 }, ExtKu: { up: 13.85, dn: 11.55 },
  Ku: { up: 14.25, dn: 12.5 }, 'Ku-BSS': { up: 17.5, dn: 11.9 }, Ka: { up: 29.50, dn: 19.45 },
  Q: { up: 30.0, dn: 42.5 }, V: { up: 52.0, dn: 20.0 }
}
// 频段显示名（其余 value 即 label）
export const BAND_LABEL = { ExtC: '扩展C', ExtKu: '扩展Ku' }

// 选中预设后应用到卫星表单（含中星26 特殊默认参数，与小程序一致）。
export function applySatPreset(form, sat) {
  if (!sat) return
  form.satelliteName = sat.name
  form.orbitPosition = sat.position
  if (sat.name === 'CHINASAT 26') { form.transponderBandwidth = '880'; form.sfdRef = '-68' }
}
