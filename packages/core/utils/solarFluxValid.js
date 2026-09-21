// 太阳射电流量（F10.7）合并快照的有效性判据 —— 主进程服务（electron/services/solarFlux.js）、
// 快照脚本（scripts/fetch-solar-flux.mjs）与云镜像回传三处共用同一份实现，别各写一份。
// 做法同 satcatValid.js：判据是"这份文本能不能当兜底数据用"，宽松但足以挡住
// 把 GP CSV / 错误页 / 空对象当成 F10.7 快照写进缓存或传上云。
//
// 形状见 solarFluxPick.js 的头注：{ fetchedAt, products: { daily30, forecast45, monthly, predicted } }。
// 门槛取"月序列各至少 12 个键"：这两个产品是"任意过去 / 未来月份都查得到"这条能力的下限，
// 逐日两条可以全缺（30 天窗口之外的目标日本来就用不上它们）。

function validSolarFlux(text) {
  if (!text) return false;
  var o = null;
  try { o = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { return false; }
  if (!o || typeof o !== 'object') return false;
  var p = o.products;
  if (!p || typeof p !== 'object') return false;
  var nKeys = function (k) {
    var d = p[k] && p[k].data;
    return (d && typeof d === 'object') ? Object.keys(d).length : 0;
  };
  return nKeys('monthly') >= 12 && nKeys('predicted') >= 12;
}

module.exports = { validSolarFlux: validSolarFlux };
