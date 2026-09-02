// 应用场景仿真 · 模块库用户改写层的持久化（主进程）。
//
// 分工与 modcod.js 逐字相同：合并 / 归一 / 差异计算全在 packages/core/utils/sceneLibrary.js
// （纯逻辑、可测），本文件只管把那份差异读写到 userData/data/sceneModules.json，并带损坏回退。
//
// ★ 读不出来就不许写：主文件与 .bak 同时解析不出时，若当成空库照写，用户攒的自建模块
//   会被一次瞬时读失败抹平。

const fs = require('fs')
const path = require('path')
const { writeJsonAtomic, readJsonSafe } = require('./jsonStore')
const lib = require('../../packages/core/utils/sceneLibrary.js')

function dataDir() {
  const base = process.env.SATSIM_DATA_DIR ||
    path.join(require('electron').app.getPath('userData'), 'data')
  fs.mkdirSync(base, { recursive: true })
  return base
}
const storeFile = () => path.join(dataDir(), 'sceneModules.json')

function createSceneLib() {
  function readStore() {
    const { value, corrupt } = readJsonSafe(storeFile(), null)
    return { store: lib.normalizeStore(value), corrupt }
  }

  return {
    // 合并后的整份清单（库浏览器 / 编辑页用）
    list(opt) {
      const { store, corrupt } = readStore()
      return {
        ok: true,
        modules: lib.listModules(store, opt),
        cats: lib.CATS, groups: lib.GROUPS,
        readOnly: !!corrupt,
        error: corrupt ? '模块库文件损坏，已按内置表显示；本次修改不会落盘' : ''
      }
    },
    // 库树（分类 → 分组 → 条目）
    tree() {
      const { store } = readStore()
      return { ok: true, tree: lib.libraryTree(store) }
    },
    // 整份清单落库（只存差异）
    save(modules) {
      const { corrupt } = readStore()
      if (corrupt) return { ok: false, error: '模块库文件与其备份均无法解析，已放弃本次写入（不拿空库覆盖既有数据）' }
      try {
        writeJsonAtomic(storeFile(), lib.storeFromList(modules), 2)
        return { ok: true, modules: lib.listModules(readStore().store, { includeHidden: true }) }
      } catch (err) {
        return { ok: false, error: err.message || String(err) }
      }
    },
    // 恢复某条内置模块的出厂内容：删掉它的改写条目 + 取消隐藏
    reset(id) {
      const { store, corrupt } = readStore()
      if (corrupt) return { ok: false, error: '模块库文件与其备份均无法解析，已放弃本次写入' }
      delete store.overrides[id]
      store.hidden = store.hidden.filter((k) => k !== id)
      try {
        writeJsonAtomic(storeFile(), store, 2)
        return { ok: true, modules: lib.listModules(store, { includeHidden: true }) }
      } catch (err) {
        return { ok: false, error: err.message || String(err) }
      }
    },
    // 全库恢复出厂（只删改写层，内置表恒在代码里）
    resetAll() {
      try {
        writeJsonAtomic(storeFile(), lib.normalizeStore(null), 2)
        return { ok: true, modules: lib.listModules(null, { includeHidden: true }) }
      } catch (err) {
        return { ok: false, error: err.message || String(err) }
      }
    },
    // 供计算用：当前生效的改写层（读不出即视作没有改写，退回内置表）
    store() { return readStore().store }
  }
}

module.exports = createSceneLib
