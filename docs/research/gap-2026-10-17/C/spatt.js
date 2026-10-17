const fs=require('fs'),path=require('path'),Module=require('module');
const file='C:/Users/85256/WeChatProjects/卫星仿真平台/packages/core/utils/linkCalculator.js';
const src=fs.readFileSync(file,'utf8')+'\n;module.exports.__int={calcSpecificAttenOxygen,calcSpecificAttenWaterVapor};';
const m=new Module(file,null); m.filename=file; m.paths=Module._nodeModulePaths(path.dirname(file)); m._compile(src,file);
const L=m.exports.__int;
// ValEx P.676-13 SpAtt：p=1013.25（干）、e=9.9729、T=288.15、ρ=7.5；N''oxygen 与 N''wv 取自表
const VX={12:[0.003982721643,0.004366020247],20:[0.00326471167,0.02666134748],60:[1.339146044,0.01417965574],90:[0.002372998234,0.02087749661],130:[0.001754399138,0.03177703735]};
for(const f of [12,20,60,90,130]){ const go=0.1820*f*VX[f][0], gw=0.1820*f*VX[f][1];
  const Ptot=1013.25+9.972888786; const po=L.calcSpecificAttenOxygen(f,Ptot/1013.25,1), pw=L.calcSpecificAttenWaterVapor(f,Ptot/1013.25,1,7.5);
  console.log(`${f} GHz  γo 逐线 ${go.toFixed(5)} 平台 ${po.toFixed(5)} (${((po/go-1)*100).toFixed(1)}%)  γw 逐线 ${gw.toFixed(5)} 平台 ${pw.toFixed(5)} (${((pw/gw-1)*100).toFixed(1)}%)`); }
