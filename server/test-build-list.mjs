// Mock test of the daily list job: leaderboard and Hyperliquid responses are fake, time is simulated (no real waiting).
import {build,fills30,makeClient,summarize,verdict,CONFIG} from './build-list.mjs';
import {writeFileSync} from 'node:fs';
const results=[];const rec=(id,item,pass,actual)=>{results.push({id,item,pass:!!pass,actual:String(actual)});console.log((pass?'PASS ':'FAIL ')+id+' '+item+' · '+actual)};
const PD=86400000;let clock=Date.UTC(2026,9,25,0,20);const now=()=>clock,sleep=async ms=>{clock+=ms};
const hx=i=>'0x'+String(i).padStart(40,'a');
const mk=(spec)=>{const arr=[];let k=0;for(const {coin,n,days,sameMs} of spec)for(let i=0;i<n;i++){const t=sameMs?clock-PD:clock-3600000-Math.floor((days*PD-2*3600000)*i/Math.max(1,n-1));arr.push({coin,time:t,tid:'t'+(k++),px:'100000',sz:'0.01',closedPnl:'1'})}return arr.sort((a,b)=>a.time-b.time)};
const W={};let calls=[],lbStatus=200,flaky=0,weightLog=[];
const row=(a,av,vlm,name)=>({ethAddress:a,accountValue:String(av),displayName:name,windowPerformances:[['day',{vlm:'1',pnl:'0'}],['month',{vlm:String(vlm),pnl:'5'}]]});
const LB={leaderboardRows:[row(hx(1),5e6,5e7,'Big'),row(hx(2),3e6,3e7,null),row(hx(3),2e6,1e9,'Bot'),row(hx(4),1e6,1e7,'Eth'),row(hx(5),9e5,5e6,'Few'),row(hx(6),8e5,8e6,'Heavy'),row(hx(7),5e4,1e6,'Small'),row(hx(8),7e5,7e6,'Flaky')]};
const fetchMock=async(url,opt)=>{
 if(url.includes('leaderboard'))return new Response(JSON.stringify(LB),{status:lbStatus});
 const b=JSON.parse(opt.body);calls.push(b);
 if(b.user===hx(8)&&flaky>0){flaky--;return new Response('rate',{status:429})}
 const all=W[b.user]||[];const p=all.filter(f=>f.time>=b.startTime&&f.time<=b.endTime).slice(0,2000);
 weightLog.push({t:clock,w:20+Math.ceil(p.length/20)});clock+=150;
 return new Response(JSON.stringify(p),{status:200});
};
W[hx(1)]=mk([{coin:'BTC',n:300,days:25},{coin:'ETH',n:100,days:25}]);
W[hx(2)]=mk([{coin:'BTC',n:5000,days:28}]);
W[hx(4)]=mk([{coin:'ETH',n:200,days:20},{coin:'BTC',n:30,days:10}]);
W[hx(5)]=mk([{coin:'BTC',n:25,days:2}]);
W[hx(6)]=mk([{coin:'BTC',n:40000,days:29}]);
W[hx(8)]=mk([{coin:'BTC',n:50,days:12}]);flaky=2;
const d=await build({fetch:fetchMock,sleep,now,log:()=>{}});
const names=d.wallets.map(w=>w.name||w.a.slice(0,6));
rec('S1','selection: Big, 0xaaaa(5,000 BTC fills over 2.5 pages), Flaky after two 429s; Bot (turnover 500x), Small (value), Eth (share 13%), Few (2 days) excluded; Heavy (40,000 fills) listed as incomplete',
 names.join(',')==='Big,0xaaaa,Heavy,Flaky'&&d.counts.excluded['turnover above 200x']===1&&d.counts.excluded['account value below minimum']===1&&d.counts.excluded['BTC share below 30%']===1&&d.counts.excluded['fewer than 5 BTC days']===1,
 names.join(',')+' · '+JSON.stringify(d.counts.excluded));
const big=d.wallets[0],w2=d.wallets[1],heavy=d.wallets.find(w=>w.name==='Heavy');
rec('S2','exact counts: Big 300 BTC of 400 fills (75%), wallet 2 all 5,000 fills read once (de-duplicated), complete',big.fills===300&&big.share===75&&big.complete&&w2.fills===5000&&w2.complete,`Big ${big.fills} ${big.share}% ${big.complete} · w2 ${w2.fills} ${w2.complete}`);
rec('S3','page cap: 40,000 fills > 15 pages → listed with complete=false and cover < 30 days (pages overlap by the boundary millisecond, so slightly under 30,000 distinct fills)',heavy&&heavy.complete===false&&heavy.cover<30&&heavy.fills>29900&&heavy.fills<=30000,heavy?`${heavy.fills} fills · complete ${heavy.complete} · cover ${heavy.cover}d`:'missing');
let maxWin=0;for(const x of weightLog){const s=weightLog.filter(y=>y.t>=x.t&&y.t<x.t+60000).reduce((a,y)=>a+y.w,0);maxWin=Math.max(maxWin,s)}
rec('S4','rate limit: no 60-second window above the 1,000 budget (server-side weights), 429s retried',maxWin<=1000&&d.counts.r429===2,`max 60s weight ${maxWin} · requests ${d.counts.requests} · 429 ${d.counts.r429} · waited ${d.counts.waitedSec}s (simulated)`);
rec('S5','output schema the app reads (v, generatedAt, wallets[a,av,share,complete,...])',d.v===1&&typeof d.generatedAt==='number'&&d.wallets.every(w=>/^0x[0-9a-f]{40}$/.test(w.a)&&typeof w.av==='number'&&typeof w.share==='number'&&typeof w.complete==='boolean'),Object.keys(d).join(',')+' · '+Object.keys(d.wallets[0]).join(','));
// same-millisecond page
W[hx(9)]=mk([{coin:'BTC',n:2500,days:1,sameMs:true}]);
const c=makeClient({fetch:fetchMock,sleep,now});const f=await fills30(c,hx(9),clock);
rec('S6','2,500 fills in one millisecond: hole recorded, marked incomplete, no endless loop',f.complete===false&&f.holes===1&&f.pages<=3,`pages ${f.pages} · holes ${f.holes} · fills ${f.fills.length}`);
// time limit
LB.leaderboardRows.push(...Array.from({length:30},(_,i)=>row(hx(100+i),6e5,6e6,'X'+i)));for(let i=0;i<30;i++)W[hx(100+i)]=mk([{coin:'BTC',n:30,days:10}]);
const d2=await build({fetch:fetchMock,sleep,now,cfg:{...CONFIG,MAX_MINUTES:0.05},log:()=>{}});
rec('S7','time limit: stops, publishes what was checked and says how many were not checked',d2.counts.stoppedByTime===true&&d2.counts.excluded['not checked (time limit)']>0,`checked ${d2.counts.checked} · not checked ${d2.counts.excluded['not checked (time limit)']}`);
lbStatus=503;let m='';try{await build({fetch:fetchMock,sleep,now,log:()=>{}})}catch(e){m=e.message}
rec('S8','leaderboard down → job fails (no empty list is published)',/leaderboard HTTP 503/.test(m),m);
writeFileSync(new URL('./build_list_test_results.json',import.meta.url),JSON.stringify({kind:'mock (no network, simulated clock)',results},null,1));
const fails=results.filter(r=>!r.pass).length;console.log(`${results.length-fails}/${results.length} passed`);process.exitCode=fails?1:0;
