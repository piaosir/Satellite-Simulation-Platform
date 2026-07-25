import { reactive } from 'vue'

// 鼠标在 3D 地球上的实时经纬度，供底部状态栏（ITU 那块）读取显示。
// { ll: { lat, lon } | null }
// env：当前环境场图层在该点的读数 { short, label, unit, text, value, step } | null
//   取自【已显示的那张栅格】（双线性），格距比数据原生分辨率粗时与引擎逐点取数会有微差，
//   故状态栏那格的 title 里如实写明格距——要精确值请以链路预算的取数为准。
export const cursor = reactive({ ll: null, env: null })
