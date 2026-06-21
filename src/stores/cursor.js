import { reactive } from 'vue'

// 鼠标在 3D 地球上的实时经纬度，供底部状态栏（ITU 那块）读取显示。
// { ll: { lat, lon } | null }
export const cursor = reactive({ ll: null })
