import { reactive } from 'vue'

// 鼠标在 3D 地球上的实时经纬度，供底部状态栏（ITU 那块）读取显示。
// { ll: { lat, lon } | null }
// env：当前环境场图层在该点的读数 { short, label, unit, text, value, step } | null
//   取自【已显示的那张栅格】（双线性），格距比数据原生分辨率粗时与引擎逐点取数会有微差，
//   故状态栏那格的 title 里如实写明格距——要精确值请以链路预算的取数为准。
// look：光标所在点【相对参考卫星】的视角读数 { short, text, unit, title } | null
//   参考卫星与读数档位（az/el 还是 u/v）在 stores/mapCrs 里，几何走 viz/grd/coverage 的 satLookAt。
// tz：时区图层在该点的读数 { off, text, dst, title, value } | null（off = 偏移、text = 当地时刻、value = 偏移分钟；内陆水域 off 为「—」）
//   偏移与当地时刻按 tzdb 2026e 规则表算（viz/geo/tzRules.js），不走 Intl —— 见 viz/env/useTzLayer.js 头注。
export const cursor = reactive({ ll: null, env: null, look: null, tz: null })
