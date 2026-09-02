// 应用场景仿真验证台入口。core 跑在 dev server 侧（见 vite.config.mjs 的 /api/scene/*），
// 这里只把它桥成 window.api —— 与真实的 渲染端 ↔ 主进程 边界同构。
import { createApp } from 'vue'
import SceneHarness from './SceneHarness.vue'
import '../src/styles/global.css'
import '../src/styles/controls.css'

const call = async (op, payload) => {
  const r = await fetch('/api/scene/' + op, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {})
  })
  return r.json()
}
window.api = {
  scene: {
    libList: () => call('libList'),
    libTree: () => call('libTree'),
    libSave: (modules) => call('libSave', { modules }),
    libReset: (id) => call('libSave', { modules: [] }),
    libResetAll: () => call('libResetAll'),
    catalog: () => call('catalog'),
    templates: () => call('templates'),
    template: (id) => call('template', { id }),
    compute: (p) => call('compute', p),
    segment: (seg) => call('segment', { seg }),
    energy: (spec) => call('energy', { spec })
  },
  store: { saveConfig: async () => ({ id: 'harness' }) },
  gridXlsx: { export: async () => ({ ok: false, error: '验证台不落盘' }) }
}
createApp(SceneHarness).mount('#app')
