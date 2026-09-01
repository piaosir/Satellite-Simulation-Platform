// MODCOD 表用户改写层的持久化（主进程）。
//
// 分工：合并/归一/差异计算全在 packages/core/utils/modcodTables.js（纯逻辑、可测），
// 本文件只管一件事 —— 把那份差异读写到 userData/data/modcod.json，并带上损坏回退。
//
// 与 storage.js 同一个数据目录、同一套原子写（jsonStore）。★读不出来就不许写：
// 主文件与 .bak 同时解析不出时，若当成空库照写，用户攒了半天的自定义标准会被一次瞬时读失败抹平。

const fs = require('fs')
const path = require('path')
const { writeJsonAtomic, readJsonSafe } = require('./jsonStore')
const mt = require('../../packages/core/utils/modcodTables.js')

function dataDir() {
  const base = process.env.SATSIM_DATA_DIR ||
    path.join(require('electron').app.getPath('userData'), 'data')
  fs.mkdirSync(base, { recursive: true })
  return base
}
const storeFile = () => path.join(dataDir(), 'modcod.json')

function createModcod() {
  // 读改写层。返回 { store, corrupt }：corrupt=true 专指「文件在、两份都读不出」，据此拒写。
  function readStore() {
    const { value, corrupt } = readJsonSafe(storeFile(), null)
    return { store: mt.normalizeStore(value), corrupt }
  }

  return {
    // 合并后的标准清单（文件管理编辑页用）：内置在前 + 自建在后，带 builtin / modified 标志
    list() {
      const { store, corrupt } = readStore()
      return { ok: true, standards: mt.listStandards(store), readOnly: !!corrupt, error: corrupt ? 'MODCOD 库文件损坏，已按内置表显示；本次修改不会落盘' : '' }
    },
    // 整份清单落库（只存与内置表的差异，见 modcodTables 头部说明）
    save(standards) {
      const { corrupt } = readStore()
      if (corrupt) return { ok: false, error: 'MODCOD 库文件与其备份均无法解析，已放弃本次写入（不拿空库覆盖既有数据）' }
      try {
        writeJsonAtomic(storeFile(), mt.storeFromList(standards), 2)
        return { ok: true, standards: mt.listStandards(readStore().store) }
      } catch (err) {
        return { ok: false, error: err.message || String(err) }
      }
    },
    // 恢复某个内置标准的出厂内容：删掉它的改写条目即可（内置表恒在代码里，无需另存一份）
    reset(key) {
      const { store, corrupt } = readStore()
      if (corrupt) return { ok: false, error: 'MODCOD 库文件与其备份均无法解析，已放弃本次写入' }
      if (!store.overrides[key]) return { ok: true, standards: mt.listStandards(store) }
      delete store.overrides[key]
      try {
        writeJsonAtomic(storeFile(), store, 2)
        return { ok: true, standards: mt.listStandards(store) }
      } catch (err) {
        return { ok: false, error: err.message || String(err) }
      }
    },
    // 供 link:baseband 用：当前生效的改写层（读不出来即视作没有改写，一律退回内置表）
    store() { return readStore().store }
  }
}

module.exports = createModcod
