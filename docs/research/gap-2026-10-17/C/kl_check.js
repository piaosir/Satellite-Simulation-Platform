const lc = require('C:/Users/85256/WeChatProjects/卫星仿真平台/packages/core/utils/linkCalculator.js');
const VALEX = { 6: 0.03112778185, 15: 0.1901133491, 30: 0.7078539584, 45: 1.443059887 };
const corr = (f) => 0.1522 * Math.exp(-((f + 23.9589) ** 2) / 3.2991e3) + 11.51 * Math.exp(-((f - 219.2096) ** 2) / 2.7595e6) - 10.4912;
for (const f of [6, 12, 15, 20, 30, 40, 45, 50]) {
  const plat = lc.cloudSpecificAttenuation(f, 273.15);
  const k9 = lc.cloudSpecificAttenuation(f, 273.75) * corr(f);
  console.log(`${f} GHz  平台Kl(273.15)=${plat.toFixed(5)}  P.840-9 KL*=${k9.toFixed(5)}  ValEx=${VALEX[f] ? VALEX[f].toFixed(5) : '-'}  平台/P840-9=${(plat / k9).toFixed(4)} (${((plat / k9 - 1) * 100).toFixed(1)}%)`);
}
