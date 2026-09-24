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

// three 的 Draco 解码器 / Basis 转码器：DRACOLoader、KTX2Loader 按「目录 + 固定文件名」经 fetch 取，不能被 vite 打哈希。
// dev 由 static-copy 的 serve 中间件在 /three-libs/* 原样出；build 落 out/renderer/three-libs/*（随 out/** 进 asar，file:// 下 fetch 实测可用）。
// 只拷 wasm 路径要的四个文件（Electron 恒有 WebAssembly，asm.js 回退与编码器 ~1.5 MB 不要）。渲染端取法见 src/viz/models/loader.js 的 THREE_LIBS。
const threeLibs = resolve('node_modules/three/examples/jsm/libs').replace(/\\/g, '/')

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
    // Worker 一律按 ES 模块打包：模型工作台的导出 / 几何 Worker 依赖图里有动态 import（meshoptimizer）与嵌套 Worker（analyze），
    // 缺省的 IIFE 格式不支持代码分割，整包构建会挂。全仓 new Worker(...) 都带 { type: 'module' }，ES 格式对它们都成立
    worker: { format: 'es' },
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
          // 空间态势报告窗口（CelesTrak 卫星编目 SATCAT + 星历统计 → 电子报告 / Word）
          ssa: resolve('src/ssa.html'),
          // 性能指标表窗口（对地 / 对星 / 气象三张表共用一个入口，按 ?kind= 装表）
          perf: resolve('src/perf.html'),
          // 报告打印页：隐藏窗口载入、printToPDF 取材（见 electron/services/reportPdf.js）
          report: resolve('src/report.html'),
          // 卫星模型工作台（库 / 导入 / 标定 / 参数化生成 / 导出）
          model: resolve('src/model.html')
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
          { src: cesiumBuild + '/Widgets', dest: 'cesium' },
          { src: [threeLibs + '/draco/gltf/draco_wasm_wrapper.js', threeLibs + '/draco/gltf/draco_decoder.wasm'], dest: 'three-libs/draco/gltf' },
          { src: [threeLibs + '/basis/basis_transcoder.js', threeLibs + '/basis/basis_transcoder.wasm'], dest: 'three-libs/basis' }
        ]
      })
    ]
  }
})
