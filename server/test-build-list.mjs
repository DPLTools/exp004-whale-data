// Mock test of the daily list job: leaderboard and Hyperliquid responses are fake, time is simulated (no real waiting).
import {build,fills30,makeClient,summarize,verdict,CONFIG,dayEnds,dailyDirs,backtest} from './build-list.mjs';
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
 const all=W[b.user]||[];
 if(b.type==='userFills'){const p=[...all].sort((x,y)=>y.time-x.time).slice(0,2000);weightLog.push({t:clock,w:20+Math.ceil(p.length/20)});clock+=150;return new Response(JSON.stringify(p),{status:200})}const p=all.filter(f=>f.time>=b.startTime&&f.time<=b.endTime).slice(0,2000);
 weightLog.push({t:clock,w:20+Math.ceil(p.length/20)});clock+=150;
 return new Response(JSON.stringify(p),{status:200});
};
W[hx(1)]=mk([{coin:'BTC',n:300,days:25},{coin:'ETH',n:100,days:25}]);
W[hx(2)]=mk([{coin:'BTC',n:5000,days:28}]);
W[hx(4)]=mk([{coin:'ETH',n:200,days:20},{coin:'BTC',n:30,days:10}]);
W[hx(5)]=mk([{coin:'BTC',n:25,days:2}]);
W[hx(6)]=mk([{coin:'BTC',n:40000,days:29}]);
W[hx(8)]=mk([{coin:'BTC',n:50,days:12}]);flaky=2;
const PAGED={...CONFIG,RECENT_ONLY:0};
const d=await build({fetch:fetchMock,sleep,now,cfg:PAGED,log:()=>{}});
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
const d2=await build({fetch:fetchMock,sleep,now,cfg:{...PAGED,MAX_MINUTES:0.05},log:()=>{}});
rec('S7','time limit: stops, publishes what was checked and says how many were not checked',d2.counts.stoppedByTime===true&&d2.counts.excluded['not checked (time limit)']>0,`checked ${d2.counts.checked} · not checked ${d2.counts.excluded['not checked (time limit)']}`);
lbStatus=503;let m='';try{await build({fetch:fetchMock,sleep,now,log:()=>{}})}catch(e){m=e.message}
rec('S8','leaderboard down → job fails (no empty list is published)',/leaderboard HTTP 503/.test(m),m);
// daily directions rebuilt from fills
{const t=Date.UTC(2026,9,25,0,20),E=dayEnds(t),f=(day,h,side,start,sz)=>({coin:'BTC',time:E[day]+h*3600000,side,startPosition:String(start),sz:String(sz)});
 // short 0.5 held from before the window; day 2 +1.0 → long 0.5; day 5 −0.5 → flat; day 8 −0.3 → short
 const fl=[f(2,3,'B',-0.5,1),f(5,1,'A',0.5,0.5),f(8,2,'A',0,0.3)];
 const d=dailyDirs(fl,E,t),want='SSS'+'LLL'+'FFF'+'S'.repeat(21);
 const part=dailyDirs(fl,E,E[10]+1),noSide=dailyDirs([{coin:'BTC',time:E[3],sz:'1'}],E,t);
 rec('S9','daily BTC position from fills (startPosition + signed size): before the first fill uses its start; past the read part is unknown; fills without side are unknown',
  d===want&&part===want.slice(0,11)+'-'.repeat(19)&&E.length===30&&E[29]===Date.UTC(2026,9,25)&&noSide==='-'.repeat(3)+'-'.repeat(27),`${d} · ${part} · ${noSide}`)}
// backtest rule
{const closes=[100,110,105,105,120,125,null,130];
 const dirs=['LLSLLFFF','LLSLLFFF','LLSLSFFF','LSSSSFFF','LSSSFFFF','FFSSFFFF'];
 // day0 L5 → up ✓ · day1 L3:S2 → down ✗ · day2 unchanged close, skipped · day3 L3:S3 tie, skipped · day4 4 open (<5), skipped · day5/6 missing close
 const b=backtest(dirs,closes,5);
 rec('S10','majority vs next-day move: ties, fewer than 5 open, unchanged and missing closes are skipped',b.days===4&&b.decided===2&&b.hit===1&&b.up===3,JSON.stringify(b))}
// candles feed the output
{const lb=LB.leaderboardRows.slice(0,2);const CL=dayEnds(clock).map((e,k)=>({t:e-PD,c:String(100000+k*100)}));
 const fm=async(url,opt)=>{if(url.includes('leaderboard'))return new Response(JSON.stringify({leaderboardRows:lb}));const b=JSON.parse(opt.body);if(b.type==='candleSnapshot')return new Response(JSON.stringify(CL));return fetchMock(url,opt)};
 lbStatus=200;const d3=await build({fetch:fm,sleep,now,log:()=>{}});
 rec('S11','output has 30 day ends, closes from daily candles, a dir string per wallet and the whole-list backtest',d3.days.ends.length===30&&d3.days.closes.every(x=>typeof x==='number')&&d3.days.closes[29]===102900&&d3.wallets.every(w=>typeof w.dir==='string'&&w.dir.length===30)&&d3.days.backtestAll&&d3.days.backtestAll.days===29,`closes ${d3.days.closes[0]}…${d3.days.closes[29]} · dirs ${d3.wallets.map(w=>w.dir.slice(0,5)).join(',')} · ${JSON.stringify(d3.days.backtestAll)}`)}
// default mode: one newest-2,000 call per wallet
{lbStatus=200;LB.leaderboardRows.length=8;weightLog=[];const c0=calls.length;flaky=0;
 const d4=await build({fetch:fetchMock,sleep,now,log:()=>{}});const w4=d4.wallets,by=n=>w4.find(w=>w.name===n);
 const fc=calls.slice(c0).filter(b=>b.type==='userFills'||b.type==='userFillsByTime');
 const per=new Map();for(const b of fc)per.set(b.user,(per.get(b.user)||0)+1);
 const w2=w4.find(w=>w.a===hx(2));
 rec('S12','default: one userFills call per wallet; 5,000-fill wallet listed as recent-days sample (1,999: the oldest millisecond of a full page counts as unread); 40,000-fill wallet (2,000 = 1.4 days) excluded for too few days; no userFillsByTime',
  fc.every(b=>b.type==='userFills')&&[...per.values()].every(n=>n===1)&&by('Big')?.complete===true&&by('Big')?.fills===300&&w2&&w2.complete===false&&w2.fills===1999&&w2.cover>10&&w2.cover<12&&w2.dir.slice(0,15)==='-'.repeat(15)&&!by('Heavy')&&d4.counts.excluded['fewer than 5 BTC days']===2,
  `${w4.map(w=>(w.name||w.a.slice(0,6))+':'+w.fills+(w.complete?'':'/'+w.cover+'d')).join(', ')} · calls/wallet ${[...new Set(per.values())]} · ${JSON.stringify(d4.counts.excluded)}`)}
// idle accounts are skipped before any call
{LB.leaderboardRows.push(row(hx(50),9e6,0,'Idle'));const c0=calls.length;const d5=await build({fetch:fetchMock,sleep,now,log:()=>{}});
 rec('S13','month volume 0 on the leaderboard → skipped without a fills call',d5.counts.excluded['no volume this month (leaderboard)']===1&&!calls.slice(c0).some(b=>b.user===hx(50)),JSON.stringify(d5.counts.excluded))}
writeFileSync(new URL('./build_list_test_results.json',import.meta.url),JSON.stringify({kind:'mock (no network, simulated clock)',results},null,1));
const fails=results.filter(r=>!r.pass).length;console.log(`${results.length-fails}/${results.length} passed`);process.exitCode=fails?1:0;
