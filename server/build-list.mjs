// EXP-004 daily BTC trader list. Runs on GitHub Actions (see .github/workflows/build-list.yml), no dependencies.
// 1. public Hyperliquid leaderboard → accounts with value ≥ MIN_EQ and turnover (month volume ÷ value) ≤ MAX_TURN,
//    largest accounts first, at most MAX_WALLETS
// 2. for each: its newest 2,000 fills (or, with RECENT_ONLY=0, every fill of the last 30 days, paged and de-duplicated)
//    → BTC fill count, BTC trading days (UTC), BTC share
//    of all fills, BTC notional, BTC realized PnL
// 3. wallets meeting the BTC activity rules are written to the output JSON that the app reads
// Rules match the app (ACT_MIN_FILLS=20, ACT_MIN_DAYS=5); the share floor is looser here so the app can apply the user's own.
// 4. each listed wallet's BTC position at the end of each of the last 30 UTC days, rebuilt from the fills (startPosition +
//    signed size), plus BTC daily closes, so the app can count how often the group's majority matched the next day's move.
//    This looks back at a past window; wallet selection itself never uses later prices, and the list is not a ranking of skill.
import {writeFileSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

const LB_URL='https://stats-data.hyperliquid.xyz/Mainnet/leaderboard',INFO='https://api.hyperliquid.xyz/info';
const PD=86400000,DAYS=30,PAGE=2000;
export const CONFIG={MIN_EQ:100000,MAX_TURN:200,MAX_WALLETS:1500,MIN_FILLS:20,MIN_DAYS:5,MIN_SHARE:30,MAX_PAGES:15,RECENT_ONLY:1,BUDGET:1000,MAX_MINUTES:120};

const fin=x=>{if(typeof x==='number')return Number.isFinite(x)?x:null;if(typeof x==='string'&&x.trim()!==''){const v=Number(x);return Number.isFinite(v)?v:null}return null};
const isAddr=s=>/^0x[a-fA-F0-9]{40}$/.test(String(s||''));
const utcDay=t=>new Date(t).toISOString().slice(0,10);
const fillKey=f=>[f.tid??'',f.hash??'',f.oid??'',f.time??'',f.coin??'',f.px??'',f.sz??''].join('|');

function monthOf(wp){
 let o=null;
 if(Array.isArray(wp)){const e=wp.find(x=>Array.isArray(x)&&x[0]==='month');o=e?e[1]:null}else if(wp&&typeof wp==='object')o=wp.month;
 return o&&typeof o==='object'?{vlm:fin(o.vlm),pnl:fin(o.pnl)}:null;
}
export function leaderboardRows(d){
 const list=Array.isArray(d?.leaderboardRows)?d.leaderboardRows:Array.isArray(d?.leaderboard_rows)?d.leaderboard_rows:null;
 if(!list)throw Error('leaderboard format changed, top-level keys: '+Object.keys(d||{}).slice(0,12).join(', '));
 const rows=[];
 for(const x of list){const a=x?.ethAddress??x?.eth_address,av=fin(x?.accountValue??x?.account_value),m=monthOf(x?.windowPerformances??x?.window_performances);
  if(!isAddr(a)||av===null||!m)continue;
  const name=x.displayName??x.display_name;
  rows.push({a:a.toLowerCase(),av,vlm:m.vlm,turn:m.vlm!==null&&av>0?m.vlm/av:null,name:typeof name==='string'?name.slice(0,40):''})}
 if(list.length&&!rows.length)throw Error('no readable leaderboard rows');
 return {rows,total:list.length};
}

// Weight-based limiter: Hyperliquid allows 1,200 per minute per IP. Each fills request reserves its largest possible
// weight (20 + 2000/20) and is corrected to 20 + ceil(items/20) after the response.
export function makeClient({fetch=globalThis.fetch,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=()=>Date.now(),budget=CONFIG.BUDGET,log=()=>{}}={}){
 const win=[];let waitedMs=0,requests=0,r429=0;
 const used=()=>{const cut=now()-60000;while(win.length&&win[0].t<cut)win.shift();return win.reduce((a,x)=>a+x.w,0)};
 async function reserve(w){for(;;){if(used()+w<=budget||!win.length){const e={t:now(),w};win.push(e);return e}const ms=Math.max(200,win[0].t+60000-now()+50);waitedMs+=ms;await sleep(ms)}}
 async function info(body){
  const base=body.type==='clearinghouseState'?2:20,div=['userFills','userFillsByTime'].includes(body.type)?20:0;
  for(let attempt=0;;attempt++){
   const e=await reserve(base+(div?PAGE/div:0));requests++;
   let r;
   try{r=await fetch(INFO,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})}
   catch(err){e.w=base;if(attempt>=4)throw err;await sleep(5000*2**attempt);continue}
   if(r.status===429||r.status>=500){e.w=base;if(r.status===429)r429++;if(attempt>=4)throw Error('HTTP '+r.status);const ms=10000*2**attempt;log(`HTTP ${r.status}, waiting ${ms/1000}s`);waitedMs+=ms;await sleep(ms);continue}
   if(!r.ok){e.w=base;throw Error('HTTP '+r.status)}
   const d=await r.json();e.w=base+(div&&Array.isArray(d)?Math.ceil(d.length/div):0);return d;
  }
 }
 return {info,stats:()=>({requests,r429,waitedSec:Math.round(waitedMs/1000)})};
}

// All fills of the last DAYS days. The API returns the OLDEST fills of a time window first, so we page forward from the
// window start with inclusive boundaries and de-duplication. A full page that is all one millisecond is skipped and
// recorded as a hole. Stopping at MAX_PAGES leaves the newest part unread: those wallets are marked incomplete.
// Default since 2026-10-25: one userFills call per wallet (newest 2,000 fills, weight at most 120). The first run read
// every 30-day fill with up to 15 pages; a few very active wallets took most of the 2 hours, so only 590 of 1,500 were
// checked. When 2,000 fills cover less than 30 days the wallet is marked incomplete with the covered days, like the app.
export async function recentFills(client,addr,t0){
 const from=t0-DAYS*PD,p=await client.info({type:'userFills',user:addr});
 if(!Array.isArray(p))throw Error('fills response is not an array');
 const ts=p.map(f=>Number(f.time)).filter(Number.isFinite),oldest=ts.length?Math.min(...ts):null;
 // a full page may cut through its oldest millisecond, so that millisecond counts as unread
 const full=p.length>=PAGE,coverFrom=full&&oldest!==null?Math.max(from,oldest+1):from;
 const fills=coverFrom>from?p.filter(f=>Number(f.time)>=coverFrom):p;
 return {fills,complete:coverFrom===from,pages:1,holes:0,cover:(t0-coverFrom)/PD,coverFrom};
}
export async function fills30(client,addr,t0,maxPages=CONFIG.MAX_PAGES){
 const from=t0-DAYS*PD,seen=new Set(),out=[];let cursor=from,pages=0,holes=0,complete=false;
 while(pages<maxPages){
  const p=await client.info({type:'userFillsByTime',user:addr,startTime:cursor,endTime:t0});pages++;
  if(!Array.isArray(p))throw Error('fills response is not an array');
  let added=0;for(const f of p){const k=fillKey(f);if(!seen.has(k)){seen.add(k);out.push(f);added++}}
  if(p.length<PAGE){complete=true;break}
  const ts=p.map(f=>Number(f.time)).filter(Number.isFinite),mx=Math.max(...ts);
  if(added===0||Math.min(...ts)===mx&&mx===cursor){holes++;cursor=mx+1}else cursor=mx;
 }
 const coveredTo=complete?t0:out.reduce((m,f)=>Math.max(m,Number(f.time)||0),from);
 return {fills:out,complete:complete&&holes===0,pages,holes,cover:(coveredTo-from)/PD};
}
// Day ends: the last DAYS UTC midnights at or before t, oldest first.
export const dayEnds=t=>{const last=Math.floor(t/PD)*PD;return Array.from({length:DAYS},(_,k)=>last-(DAYS-1-k)*PD)};
// One character per day end: L long, S short, F no position, - unknown (no usable fill data, or past the part that was read).
export function dailyDirs(btc,ends,coveredTo,coveredFrom=-Infinity){
 const fs=btc.map(x=>({t:Number(x.time),start:fin(x.startPosition),sz:fin(x.sz),side:x.side})).filter(x=>Number.isFinite(x.t)).sort((a,b)=>a.t-b.t);
 const after=x=>x.start===null||x.sz===null||(x.side!=='B'&&x.side!=='A')?null:x.start+(x.side==='B'?x.sz:-x.sz);
 const ch=v=>v===null?'-':Math.abs(v)<1e-9?'F':v>0?'L':'S';
 let i=-1;
 return ends.map(e=>{
  if(e>coveredTo||e<coveredFrom)return '-';
  while(i+1<fs.length&&fs[i+1].t<=e)i++;
  if(i<0)return fs.length?ch(fs[0].start):'-';
  return ch(after(fs[i]));
 }).join('');
}
export function summarize(f,t0,ends=dayEnds(t0)){
 const from=t0-DAYS*PD,all=f.fills.filter(x=>Number(x.time)>=from),btc=all.filter(x=>x.coin==='BTC');
 // fills30 reads forward from the window start (unread part is the newest), recentFills reads back from now
 const coveredFrom=f.coverFrom??from,coveredTo=f.coverFrom!==undefined||f.complete?t0:from+f.cover*PD;
 return {fills:btc.length,days:new Set(btc.map(x=>utcDay(Number(x.time)))).size,share:all.length?100*btc.length/all.length:null,
  notional:btc.reduce((a,x)=>a+Math.abs((Number(x.px)||0)*(Number(x.sz)||0)),0),pnl30:btc.reduce((a,x)=>a+(Number(x.closedPnl)||0),0),all:all.length,complete:f.complete,cover:Math.round(f.cover*10)/10,dir:dailyDirs(btc,ends,coveredTo,coveredFrom)};
}
export function verdict(s,cfg=CONFIG){
 if(!s.all)return s.complete?'no fills in 30 days':'no fills read';
 if(!s.fills)return 'no BTC fills';
 if((s.share??0)<cfg.MIN_SHARE)return 'BTC share below '+cfg.MIN_SHARE+'%';
 if(s.fills<cfg.MIN_FILLS)return 'fewer than '+cfg.MIN_FILLS+' BTC fills';
 if(s.days<cfg.MIN_DAYS)return 'fewer than '+cfg.MIN_DAYS+' BTC days';
 return '';
}

// BTC close at each day end, from Hyperliquid daily candles (a candle opening at e-PD closes at e).
export async function dailyCloses(client,ends){
 const d=await client.info({type:'candleSnapshot',req:{coin:'BTC',interval:'1d',startTime:ends[0]-2*PD,endTime:ends[ends.length-1]}});
 if(!Array.isArray(d))throw Error('candles response is not an array');
 const m=new Map(d.map(c=>[Number(c.t)+PD,fin(c.c)]));
 return ends.map(e=>m.get(e)??null);
}
// For each day end except the last: majority of known L/S among the wallets (ties and fewer than minOpen open are skipped),
// compared with the close-to-close move to the next day end. Same rule as the app.
export function backtest(dirs,closes,minOpen=5){
 let decided=0,hit=0,up=0,moves=0;
 for(let k=0;k+1<closes.length;k++){
  const c0=closes[k],c1=closes[k+1];if(c0===null||c1===null||c1===c0)continue;
  moves++;if(c1>c0)up++;
  let L=0,S=0;for(const d of dirs){if(d[k]==='L')L++;else if(d[k]==='S')S++}
  if(L+S<minOpen||L===S)continue;
  decided++;if((L>S)===(c1>c0))hit++;
 }
 return {days:moves,decided,hit,up};
}
export async function build({fetch=globalThis.fetch,sleep,now=()=>Date.now(),cfg=CONFIG,log=console.log}={}){
 const started=now(),ends=dayEnds(started),client=makeClient({fetch,sleep,now,budget:cfg.BUDGET,log});
 const lbRes=await fetch(LB_URL);if(!lbRes.ok)throw Error('leaderboard HTTP '+lbRes.status);
 const lb=leaderboardRows(await lbRes.json());
 const excluded={},ex=r=>{excluded[r]=(excluded[r]||0)+1};
 const pool=[];
 for(const r of lb.rows){if(r.av<cfg.MIN_EQ){ex('account value below minimum');continue}if(r.turn!==null&&r.turn>cfg.MAX_TURN){ex('turnover above '+cfg.MAX_TURN+'x');continue}if(r.vlm===0){ex('no volume this month (leaderboard)');continue}pool.push(r)}
 pool.sort((a,b)=>b.av-a.av);
 const queue=pool.slice(0,cfg.MAX_WALLETS);if(pool.length>queue.length)excluded['beyond '+cfg.MAX_WALLETS+' largest accounts']=pool.length-queue.length;
 const wallets=[];let checked=0,failed=0,stoppedByTime=false;
 for(const r of queue){
  if(now()-started>cfg.MAX_MINUTES*60000){stoppedByTime=true;break}
  const t0=now();
  try{
   const s=summarize(cfg.RECENT_ONLY?await recentFills(client,r.a,t0):await fills30(client,r.a,t0,cfg.MAX_PAGES),t0,ends);checked++;
   const why=verdict(s,cfg);
   if(why)ex(why);else wallets.push({dir:s.dir,a:r.a,name:r.name,av:r.av,vlm:r.vlm,turn:r.turn===null?null:Math.round(r.turn*10)/10,fills:s.fills,days:s.days,share:Math.round(s.share*10)/10,notional:Math.round(s.notional),pnl30:Math.round(s.pnl30),complete:s.complete,cover:s.cover});
  }catch(e){failed++;checked++;log('failed '+r.a+': '+e.message)}
  if(checked%50===0)log(`${checked}/${queue.length} checked, ${wallets.length} listed`);
 }
 if(stoppedByTime)excluded['not checked (time limit)']=queue.length-checked;
 let closes=null;
 try{closes=await dailyCloses(client,ends)}catch(e){log('candles failed: '+e.message)}
 return {v:1,generatedAt:now(),window:{days:DAYS},thresholds:{minEq:cfg.MIN_EQ,maxTurn:cfg.MAX_TURN,minFills:cfg.MIN_FILLS,minDays:cfg.MIN_DAYS,minShare:cfg.MIN_SHARE,maxPages:cfg.MAX_PAGES,fills:cfg.RECENT_ONLY?'newest 2000':'30 days paged'},
  days:{ends,closes,backtestAll:closes?backtest(wallets.map(w=>w.dir),closes):null},
  counts:{lbRows:lb.total,pool:pool.length,queued:queue.length,checked,failed,listed:wallets.length,stoppedByTime,excluded,durationSec:Math.round((now()-started)/1000),...client.stats()},
  wallets};
}

if(import.meta.url===`file://${process.argv[1]}`){
 const out=process.argv[2]||'data/btc-traders.json';
 const cfg={...CONFIG};for(const k of Object.keys(cfg)){const v=fin(process.env[k]);if(v!==null)cfg[k]=v}
 build({cfg}).then(d=>{mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(d));console.log(`wrote ${out}: ${d.wallets.length} wallets, ${d.counts.checked} checked in ${d.counts.durationSec}s`)})
  .catch(e=>{console.error(e);process.exit(1)});
}
