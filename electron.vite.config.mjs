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

// three 的 Draco 解码器 / Basis 转码器：DRACOLoader、KTX2Loader 按「目录 + 固定文件名」经 fetch 取，不能被 vite 打哈希。
// dev 由 static-copy 的 serve 中间件在 /three-libs/* 原样出；build 落 out/renderer/three-libs/*（随 out/** 进 asar，file:// 下 fetch 实测可用）。
// 只拷 wasm 路径要的四个文件（Electron 恒有 WebAssembly，asm.js 回退与编码器 ~1.5 MB 不要）。渲染端取法见 src/viz/models/loader.js 的 THREE_LIBS。
const threeLibs = resolve('node_modules/three/examples/jsm/libs').replace(/\\/g, '/')

// Monaco 编辑器（可编程波束地图）的两个 Worker：用官方预构建件（min/vs/assets 下自包含的 IIFE，与 ESM 主体同版同协议）
// 原样拷出、改成固定文件名，不进 Rollup —— TypeScript 语言服务源码约 12 MB（typescriptServices + lib），本已是现成的
// 打包产物，再交给 Rollup 处理只会徒增构建内存与时间（渲染端构建的堆余量本就紧，见 package.json 的 build 脚本）。
// dev 由 static-copy 中间件在 /monaco/* 出，build 落 out/renderer/monaco/*；取法见 src/viz/beamScript/monacoCore.js 的
// MonacoEnvironment.getWorker。
const monacoWorkers = resolve('node_modules/monaco-editor/min/vs/assets').replace(/\\/g, '/')
// Monaco ESM 主体里还有两处 new URL(<自家 Worker 源文件>, import.meta.url)：Vite 构建时见到就把它们当 Worker / 资源打进包
// （TypeScript 那份就是上面说的 12 MB）。运行时这两条路走不到 —— MonacoEnvironment.getWorker 优先 —— 故在进 Vite 的
// Worker / 资源插件之前把这两个表达式摘掉。Monaco 升级后表达式变了会告警，届时按新写法改 RULES。
function monacoWorkerUrlStrip() {
  const RULES = [
    { file: /monaco-editor[\\/]esm[\\/]vs[\\/]languages[\\/]features[\\/]typescript[\\/]workerManager\.js$/, from: `new Worker(new URL('ts.worker.js', import.meta.url), { type: "module" })` },
    { file: /monaco-editor[\\/]esm[\\/]vs[\\/]editor[\\/]browser[\\/]services[\\/]editorWorkerService\.js$/, from: `new URL('../../common/services/editorWebWorkerMain.js', import.meta.url)` }
  ]
  return {
    name: 'satsim-monaco-worker-url-strip',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]
      const r = RULES.find((x) => x.file.test(file))
      if (!r) return null
      if (!code.includes(r.from)) { this.warn(`Monaco 源码已变，未找到待摘除的 Worker 表达式：${file}`); return null }
      return { code: code.replace(r.from, 'null'), map: null }
    }
  }
}

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
    // 可编程波束地图的沙箱 Worker 用 acorn 做静态检查：依赖扫描不进 Worker 入口，dev 下第一次运行脚本才发现它，
    // 会触发一次「依赖已更新，整页重载」—— 预先列进来
    optimizeDeps: { include: ['acorn'] },
    // JSON 模块产出 JSON.parse("…") 而不是展开成 JS 对象字面量：10m 底图（basemap-10m.json）原来被展开成约 195 万行字面量，
    // 每个画地图的窗口都要编译一遍、常驻约 55 MB；JSON.parse 的值与键序与字面量逐一相同，编译与内存都降一个量级
    json: { stringify: true },
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
      monacoWorkerUrlStrip(),
      viteStaticCopy({
        targets: [
          { src: [threeLibs + '/draco/gltf/draco_wasm_wrapper.js', threeLibs + '/draco/gltf/draco_decoder.wasm'], dest: 'three-libs/draco/gltf' },
          { src: [threeLibs + '/basis/basis_transcoder.js', threeLibs + '/basis/basis_transcoder.wasm'], dest: 'three-libs/basis' },
          { src: monacoWorkers + '/ts.worker-*.js', dest: 'monaco', rename: 'ts.worker.js' },
          { src: monacoWorkers + '/editor.worker-*.js', dest: 'monaco', rename: 'editor.worker.js' }
        ]
      })
    ]
  }
})
