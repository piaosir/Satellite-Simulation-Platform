# 日凌太阳亮温模型 v5.3 —— 拟合数据与脚本（2026-09-21）

`packages/core/utils/sunOutageCalculator.js` 里 `SOLAR_ANCHORS` 那张表的出处。数据与结论见
`docs/日凌太阳亮温自动化与收尾任务书_2026-09-21.md` 附录 A。

- `norp/nbymYYMM`：野边山射电偏振计（NoRP）逐日总流量表，1 / 2 / 3.75 / 9.4 / 17 GHz，sfu，
  `ftp://solar-pub.nao.ac.jp/pub/nsro/norp/data/daily/`，2004-10 … 2026-07（252 个月；缺 2015-11、2016-09、
  2018-05、2019-05/06/10、2020-11、2022-02/04/05 十个月当时未下到）。
- `fluxtable.txt`（未入库，2 MB）：DRAO Penticton F10.7 逐日表，
  `https://www.spaceweather.gc.ca/solar_flux_data/daily_flux_values/fluxtable.txt`，抓取日 2026-09-21；
  回归用 `fluxobsflux`（观测值）列的 20 UT 那次。重跑前下载到本目录 `pent/fluxtable.txt`。
- `fit.mjs`：逐频稳健线性回归 S_f = a_f + b_f·F10.7（3σ 剔野点迭代 5 轮），输出 `coef.json`。
- `check.mjs`：用 `coef.json` 在锚点间 log-log 插值，对 NOAA SWPC RSTN 七天多频报表
  （`rstn_2026-09-21.txt`，`https://services.swpc.noaa.gov/text/solar_radio_flux.txt`）做交叉验证。

```bash
mkdir -p pent && curl -o pent/fluxtable.txt https://www.spaceweather.gc.ca/solar_flux_data/daily_flux_values/fluxtable.txt
node fit.mjs && node check.mjs
```
