import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { writeIndex, SOURCES as CMD_INDEX_SOURCES } from './scripts/cmd-index.mjs'

// 标题栏搜索框的分区 / 参数行索引：dev / build 起步时按模板重生成 src/shared/cmdIndex.data.js（内容没变不写盘），
// dev 下模板一改随手刷新。生成的是真实文件而非虚拟模块 —— 各 harness 直接 import 也不需要本插件。
function cmdIndexPlugin() {
  const watched = new Set(CMD_INDEX_SOURCES.map((x) => resolve(x.file).replace(/\\/g, '/')))
  return {
    name: 'satsim-cmd-index',
    buildStart() { writeIndex() },
    handleHotUpdate({ file }) { if (watched.has(String(file).replace(/\\/g, '/'))) writeIndex() }
  }
}

// Cesium 运行时资源目录（绝对路径 + 正斜杠，供 fast-glob 在 Windows 下正确匹配）。
const cesiumBuild = resolve('node_modules/cesium/Build/Cesium').replace(/\\/g, '/')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: { input: resolve('electron/main.js') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: resolve('electron/preload.js'),
        output: { format: 'cjs', entryFileNames: 'preload.js' }
      }
    }
  },
  renderer: {
    root: 'src',
    resolve: {
      alias: {
        '@': resolve('src'),
        '@core': resolve('packages/core')
      }
    },
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          index: resolve('src/index.html'),
          linkbudget: resolve('src/linkbudget.html'),
          ngso: resolve('src/ngso.html'),
          regen: resolve('src/regen.html'),
          e2e: resolve('src/e2e.html'),
          suntool: resolve('src/suntool.html'),
          rain: resolve('src/rain.html'),
          ci: resolve('src/ci.html'),
          pfd: resolve('src/pfd.html'),
          freqplan: resolve('src/freqplan.html'),
          // 性能指标表窗口（对地 / 对星 / 气象三张表共用一个入口，按 ?kind= 装表）
          perf: resolve('src/perf.html'),
          // 报告打印页：隐藏窗口载入、printToPDF 取材（见 electron/services/reportPdf.js）
          report: resolve('src/report.html')
        }
      }
    },
    plugins: [
      vue(),
      cmdIndexPlugin(),
      viteStaticCopy({
        targets: [
          { src: cesiumBuild + '/Workers', dest: 'cesium' },
          { src: cesiumBuild + '/ThirdParty', dest: 'cesium' },
          { src: cesiumBuild + '/Assets', dest: 'cesium' },
          { src: cesiumBuild + '/Widgets', dest: 'cesium' }
        ]
      })
    ]
  }
})
