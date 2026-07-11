import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { viteStaticCopy } from 'vite-plugin-static-copy'

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
          suntool: resolve('src/suntool.html')
        }
      }
    },
    plugins: [
      vue(),
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
