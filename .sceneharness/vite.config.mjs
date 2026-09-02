import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const require = createRequire(import.meta.url)

// ★ core 是 CommonJS，vite 不转译源码里的 require —— 故不在浏览器侧 import，
//   而是在 dev server 里用 Node 的 require 跑，通过 /api/scene/* 暴露。
//   这条边界与真实的 渲染端 ↔ 主进程 IPC 同构，验证台因此测的是同一条路。
function coreApi() {
  return {
    name: 'scene-core-api',
    configureServer(server) {
      const M = require(path.join(ROOT, 'packages/core/utils/sceneMedia.js'))
      const L = require(path.join(ROOT, 'packages/core/utils/sceneLibrary.js'))
      const T = require(path.join(ROOT, 'packages/core/utils/sceneTemplates.js'))
      const R = require(path.join(ROOT, 'packages/core/utils/sceneReduce.js'))
      const TE = require(path.join(ROOT, 'packages/core/utils/sceneTerrestrial.js'))
      const EN = require(path.join(ROOT, 'packages/core/utils/sceneEnergy.js'))
      const C = require(path.join(ROOT, 'packages/core/utils/linkChain.js'))
      let store = null
      const send = (res, v) => { res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(v)) }
      server.middlewares.use('/api/scene', (req, res, next) => {
        const url = new URL(req.url, 'http://x')
        const op = url.pathname.replace(/^\//, '')
        let body = ''
        req.on('data', (c) => { body += c })
        req.on('end', () => {
          let p = {}
          try { p = body ? JSON.parse(body) : {} } catch { /* ignore */ }
          try {
            if (op === 'catalog') return send(res, { media: M.MEDIA, cats: M.MEDIA_CATS, connectors: M.CONNECTORS, bands: M.BANDS, modCats: L.CATS, groups: L.GROUPS })
            if (op === 'libList') return send(res, { ok: true, modules: L.listModules(store, {}), cats: L.CATS, groups: L.GROUPS, error: '' })
            if (op === 'libTree') return send(res, { ok: true, tree: L.libraryTree(store) })
            if (op === 'libSave') { store = L.storeFromList(p.modules || []); return send(res, { ok: true, modules: L.listModules(store, { includeHidden: true }) }) }
            if (op === 'libResetAll') { store = null; return send(res, { ok: true, modules: L.listModules(null, { includeHidden: true }) }) }
            if (op === 'templates') return send(res, { list: T.listTemplates(), industries: T.industries() })
            if (op === 'template') return send(res, T.buildTemplate(p.id))
            if (op === 'compute') return send(res, { ok: true, result: R.computeScene(p.scene || {}, store, { chain: (c) => C.computeLinkChain(c) }, p.opts || {}) })
            if (op === 'segment') return send(res, { ok: true, result: TE.computeSegment(p.seg || {}) })
            if (op === 'energy') return send(res, { ok: true, result: EN.computeEnergy(p.spec || {}) })
          } catch (e) { return send(res, { ok: false, error: e.message, stack: e.stack }) }
          next()
        })
      })
    }
  }
}

export default defineConfig({
  root: HERE,
  plugins: [vue(), coreApi()],
  server: { port: 5944, strictPort: false, fs: { allow: [ROOT] } },
  resolve: { dedupe: ['vue'] },
  optimizeDeps: { include: ['vue'] }
})
