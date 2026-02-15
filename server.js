const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const WORLD = 3000;
const FOOD_N = 600;
const FOOD_R = 4;
const TICK = 1000 / 20; // 20 ticks/sec
const SDIST = 5;
const BASE_LEN = 10;
const SPEED = 110;
const BOOST_M = 1.85;
const BASE_TURN = 3.2;
const BOOST_MIN = 30;
const BOOST_RATE = 8;
const FOOD_VAL = 3;
const BOT_N = 20;

const skins = [
  ['#44ff44','#1a8a1a'],['#ff4455','#991133'],['#4499ff','#1144aa'],
  ['#ffcc00','#aa8800'],['#ff44ff','#aa11aa'],['#44ffff','#11aaaa'],
  ['#ff8833','#aa5511'],['#ddddff','#7777aa'],['#ff6699','#aa2255'],
  ['#88ff44','#44aa11']
];

const bNames = ['Python','Cobra','Viper','Mamba','Anaconda','Boa','Asp','Krait',
  'Naga','Taipan','Adder','Racer','King','Coral','Sidewinder','Rinkhals',
  'Bushmaster','Copperhead','Rattler','Boomslang'];

let players = new Map(); // id -> playerState
let foods = [];
let bots = [];
let nextId = 1;

// --- Utils ---
function di(a,b,c,d){ let x=a-c,y=b-d; return Math.sqrt(x*x+y*y); }
function dq(a,b,c,d){ let x=a-c,y=b-d; return x*x+y*y; }
function ad(a,b){ let d=b-a; while(d>Math.PI)d-=Math.PI*2; while(d<-Math.PI)d+=Math.PI*2; return d; }
function na(a){ while(a>Math.PI)a-=Math.PI*2; while(a<-Math.PI)a+=Math.PI*2; return a; }
function oob(x,y){ let h=WORLD/2; return Math.abs(x)>h||Math.abs(y)>h; }
function sLen(s){ return BASE_LEN+Math.floor(s.score*0.4); }
function bw(s){ return 8+Math.min(s.score*0.04,14); }
function hr(s){ return bw(s)/2+1.5; }
function spd(s){ let f=Math.min(s.score/1200,0.1); let b=SPEED*(1-f); return s.boosting?b*BOOST_M:b; }
function trn(s){ let f=Math.min(s.score/600,0.35); return BASE_TURN*(1-f); }

function mkFood(x,y,sz,col){
  return {
    id: nextId++,
    x: x!==undefined?x:(Math.random()*WORLD-WORLD/2),
    y: y!==undefined?y:(Math.random()*WORLD-WORLD/2),
    size: sz||FOOD_R,
    color: col||('hsl('+Math.floor(Math.random()*360)+',80%,55%)')
  };
}

function safeSpawn(){
  let all = getAllSnakes();
  for(let a=0;a<50;a++){
    let px=(Math.random()-0.5)*WORLD*0.7, py=(Math.random()-0.5)*WORLD*0.7, ok=true;
    for(let s of all){ if(!s.alive)continue; if(di(px,py,s.sg[0].x,s.sg[0].y)<250){ok=false;break;} }
    if(ok) return {x:px,y:py};
  }
  return {x:(Math.random()-0.5)*WORLD*0.4, y:(Math.random()-0.5)*WORLD*0.4};
}

function mkSnake(x,y,name,sk,isBot,acc){
  let sg=[], a=Math.random()*Math.PI*2;
  for(let i=0;i<BASE_LEN;i++) sg.push({x:x-Math.cos(a)*i*SDIST, y:y-Math.sin(a)*i*SDIST});
  return {
    id: nextId++, sg, a, ta:a, name, sk, accs:acc||0, isBot, alive:true, score:0,
    boosting:false, bAcc:0, bTimer:0, spawnP:3,
    foodTarget:null, huntTarget:null, huntTime:0,
    circleDir:0, circleTime:0, mode:'food',
    stuckTime:0, lastX:x, lastY:y,
    avoidTimer:0, backoffTime:0, cautionTime:0,
    skipTargets:[], lootZoneX:0, lootZoneY:0
  };
}

function getAllSnakes(){
  let all = [...players.values()].map(p=>p.snake).filter(s=>s);
  return all.concat(bots);
}

// --- Init ---
function initWorld(){
  foods = [];
  for(let i=0;i<FOOD_N;i++) foods.push(mkFood());
  bots = [];
  for(let i=0;i<BOT_N;i++){
    let sp = safeSpawn();
    let ba = Math.random()<0.35?Math.floor(Math.random()*7)+1:0;
    let b = mkSnake(sp.x,sp.y,bNames[i%bNames.length],Math.floor(Math.random()*skins.length),true,ba);
    bots.push(b);
  }
}
initWorld();

// --- Physics ---
function updSnake(s,dt){
  if(!s.alive) return;
  let hd=s.sg[0], sp2=spd(s), ts=trn(s), tLen=sLen(s);
  if(s.spawnP>0) s.spawnP-=dt;
  
  if(s.boosting){
    if(s.score<BOOST_MIN){s.boosting=false;}
    else{
      s.bAcc+=dt; let ci=1/BOOST_RATE;
      while(s.bAcc>=ci && s.score>=BOOST_MIN){
        s.bAcc-=ci; s.score=Math.max(0,s.score-1);
        if(s.sg.length>tLen+2){
          let t=s.sg.pop();
          foods.push(mkFood(t.x+(Math.random()-0.5)*8,t.y+(Math.random()-0.5)*8,FOOD_R*0.8,skins[s.sk][0]));
        }
        if(s.score<BOOST_MIN) s.boosting=false;
      }
    }
  } else { s.bAcc=0; }

  let df=ad(s.a,s.ta), ta=ts*dt;
  if(Math.abs(df)<ta) s.a=s.ta; else s.a+=Math.sign(df)*ta;
  hd.x+=Math.cos(s.a)*sp2*dt;
  hd.y+=Math.sin(s.a)*sp2*dt;
  if(oob(hd.x,hd.y)){killS(s);return;}
  
  for(let i=1;i<s.sg.length;i++){
    let p=s.sg[i-1],c=s.sg[i],dx=c.x-p.x,dy=c.y-p.y,d=Math.sqrt(dx*dx+dy*dy);
    if(d>SDIST){let r=SDIST/d;c.x=p.x+dx*r;c.y=p.y+dy*r;}
  }
  while(s.sg.length<tLen){let last=s.sg[s.sg.length-1];s.sg.push({x:last.x,y:last.y});}
  while(s.sg.length>tLen+5) s.sg.pop();
}

function eatFood(s){
  if(!s.alive) return;
  let hd=s.sg[0], r=hr(s)+FOOD_R+4;
  for(let i=foods.length-1;i>=0;i--){
    let f=foods[i], cr=r+f.size;
    if(dq(hd.x,hd.y,f.x,f.y)<cr*cr){
      s.score+=FOOD_VAL;
      foods.splice(i,1);
    }
  }
}

function collide(s,all){
  if(!s.alive) return;
  if(s.spawnP>0) return;
  if(s.avoidTimer>0) return;
  let hd=s.sg[0], r=hr(s);
  for(let o of all){
    if(o===s||!o.alive) continue;
    let oMaxR=o.sg.length*SDIST+80;
    let hd2=dq(hd.x,hd.y,o.sg[0].x,o.sg[0].y);
    if(hd2>oMaxR*oMaxR) continue;
    let ow=bw(o);
    for(let i=3;i<o.sg.length;i++){
      let sg=o.sg[i], cr=r+ow/2;
      if(dq(hd.x,hd.y,sg.x,sg.y)<cr*cr){
        killS(s); o.score+=Math.floor(s.score*0.15); return;
      }
    }
    let or2=hr(o);
    if(hd2<(r+or2)*(r+or2)){
      if(sLen(s)<=sLen(o)){killS(s);return;}
    }
  }
}

function killS(s){
  s.alive=false;
  let totalFood=Math.max(Math.floor(s.score/FOOD_VAL),Math.floor(s.sg.length*0.8)),placed=0;
  for(let i=0;i<s.sg.length&&placed<totalFood;i++){
    let sg=s.sg[i];
    foods.push(mkFood(sg.x+(Math.random()-0.5)*12,sg.y+(Math.random()-0.5)*12,FOOD_R+2,skins[s.sk][0]));
    placed++;
  }
  
  if(s.isBot){
    setTimeout(()=>{
      let sp=safeSpawn();
      let ba=Math.random()<0.35?Math.floor(Math.random()*7)+1:0;
      let ns=mkSnake(sp.x,sp.y,s.name,s.sk,true,ba);
      ns.avoidTimer=2;
      let idx=bots.indexOf(s);
      if(idx!==-1) bots[idx]=ns;
    }, 4000+Math.random()*5000);
  } else {
    // Notify player
    for(let [id,p] of players){
      if(p.snake===s){
        let ws=p.ws;
        if(ws.readyState===WebSocket.OPEN){
          ws.send(JSON.stringify({type:'death', score:s.score}));
        }
        p.snake=null;
        break;
      }
    }
  }
}

// --- Bot AI (simplified server version) ---
function checkBodyAhead(hx,hy,angle,dist,self){
  let all=getAllSnakes(), steps=8, sl=dist/steps, sw=bw(self)/2;
  for(let st=1;st<=steps;st++){
    let px=hx+Math.cos(angle)*sl*st, py=hy+Math.sin(angle)*sl*st;
    for(let s of all){
      if(s===self||!s.alive) continue;
      let hdist=di(px,py,s.sg[0].x,s.sg[0].y);
      if(hdist>s.sg.length*SDIST+60) continue;
      let ow=bw(s)/2+sw+10;
      for(let i=2;i<s.sg.length;i++){
        if(dq(px,py,s.sg[i].x,s.sg[i].y)<ow*ow) return {snake:s,seg:s.sg[i],dist:sl*st};
      }
    }
  }
  return null;
}

function safeTurn(b,baseAngle){
  let hd=b.sg[0], sd=Math.max(90,spd(b)*0.65);
  let offsets=[0,0.3,-0.3,0.6,-0.6,0.95,-0.95,1.3,-1.3,1.7,-1.7,2.2,-2.2,Math.PI];
  for(let off of offsets){
    let a=na(baseAngle+off);
    if(!checkBodyAhead(hd.x,hd.y,a,sd,b)) return a;
  }
  return na(baseAngle+Math.PI);
}

function wouldCircle(b,tx,ty){
  let hd=b.sg[0], fd=di(hd.x,hd.y,tx,ty), a2=Math.atan2(ty-hd.y,tx-hd.x);
  let angleDiff=Math.abs(ad(b.a,a2)), turnR=spd(b)/trn(b), thr=turnR*1.6;
  if(fd<thr && angleDiff>Math.PI/3) return true;
  if(fd<35 && angleDiff>Math.PI/4) return true;
  return false;
}

function nearestFood(hx,hy,range,skip){
  let best=null, bd=range*range;
  for(let f of foods){
    if(skip&&skip.indexOf(f)!==-1) continue;
    let dd=dq(hx,hy,f.x,f.y);
    if(dd<bd){bd=dd;best=f;}
  }
  return best;
}

function countLootChasers(cx,cy,range,exc){
  let cnt=0;
  for(let b of bots){
    if(b===exc||!b.alive) continue;
    if(b.mode==='loot' && di(b.sg[0].x,b.sg[0].y,cx,cy)<range) cnt++;
  }
  return cnt;
}

function botAI(b,dt){
  if(!b.alive) return;
  let hd=b.sg[0], half=WORLD/2;
  b.bTimer-=dt; b.boosting=false; b.huntTime-=dt;
  if(b.avoidTimer>0) b.avoidTimer-=dt;
  if(b.backoffTime>0) b.backoffTime-=dt;
  if(b.cautionTime>0) b.cautionTime-=dt;

  if(b.foodTarget && foods.indexOf(b.foodTarget)===-1) b.foodTarget=null;

  let moved=di(hd.x,hd.y,b.lastX,b.lastY);
  if(moved<0.5*dt*60) b.stuckTime+=dt; else b.stuckTime=0;
  b.lastX=hd.x; b.lastY=hd.y;

  if(b.stuckTime>1){
    b.ta=na(b.a+Math.PI*0.7+(Math.random()-0.5)*0.6);
    b.stuckTime=0;b.foodTarget=null;b.bTimer=0.5;b.backoffTime=0.5;return;
  }
  if(b.backoffTime>0){b.ta=safeTurn(b,b.a);b.bTimer=0.1;return;}

  let wd=Math.min(half-Math.abs(hd.x),half-Math.abs(hd.y));
  if(wd<200){
    let flee=Math.atan2(-hd.y,-hd.x);b.ta=safeTurn(b,flee);
    if(wd<100&&b.score>=BOOST_MIN)b.boosting=true;
    b.bTimer=0.2;b.foodTarget=null;return;
  }

  let lookD=Math.max(110,spd(b)*0.75);
  let ahead=checkBodyAhead(hd.x,hd.y,b.a,lookD,b);
  if(ahead){
    let av=Math.atan2(hd.y-ahead.seg.y,hd.x-ahead.seg.x);
    b.ta=safeTurn(b,av);
    if(ahead.dist<35&&b.score>=BOOST_MIN) b.boosting=true;
    b.bTimer=0.25;b.foodTarget=null;b.cautionTime=0.5;return;
  }

  let dangerDist=bw(b)/2+28, nearDD=999, dangerSeg=null;
  let all=getAllSnakes();
  for(let s of all){
    if(s===b||!s.alive) continue;
    let hdd=di(hd.x,hd.y,s.sg[0].x,s.sg[0].y);
    if(hdd>s.sg.length*SDIST+90) continue;
    for(let i=2;i<s.sg.length;i++){
      let d=di(hd.x,hd.y,s.sg[i].x,s.sg[i].y);
      if(d<nearDD){nearDD=d;dangerSeg=s.sg[i];}
    }
  }
  if(dangerSeg&&nearDD<dangerDist){
    let av=Math.atan2(hd.y-dangerSeg.y,hd.x-dangerSeg.x);
    b.ta=safeTurn(b,av);
    if(nearDD<dangerDist*0.5&&b.score>=BOOST_MIN)b.boosting=true;
    b.bTimer=0.15;b.foodTarget=null;b.cautionTime=0.4;return;
  }

  if(b.bTimer<=0){
    let f=nearestFood(hd.x,hd.y,300,b.skipTargets);
    if(f&&wouldCircle(b,f.x,f.y)){
      if(!b.skipTargets) b.skipTargets=[];
      b.skipTargets.push(f);
      b.ta=safeTurn(b,b.a);b.backoffTime=0.3;b.bTimer=0.1;return;
    }
    if(f){
      b.foodTarget=f;
      b.ta=safeTurn(b,Math.atan2(f.y-hd.y,f.x-hd.x));
      b.mode='food';
    } else {
      b.ta=safeTurn(b,b.a+(Math.random()-0.5)*0.6);
      b.mode='wander';b.foodTarget=null;
    }
    b.bTimer=0.3+Math.random()*0.3;
    if(b.skipTargets&&b.skipTargets.length>4) b.skipTargets=[];
  }
}

// --- Game Loop ---
const DT = TICK/1000;

function gameTick(){
  let all = getAllSnakes();
  
  // Update bots
  for(let b of bots){
    if(!b.alive) continue;
    botAI(b,DT);
    updSnake(b,DT);
    eatFood(b);
    collide(b,all);
  }
  
  // Update players
  for(let [id,p] of players){
    let s=p.snake;
    if(!s||!s.alive) continue;
    updSnake(s,DT);
    eatFood(s);
    collide(s,all);
  }
  
  // Spawn food
  if(foods.length<FOOD_N && Math.random()<0.15){
    foods.push(mkFood());
  }
  
  // Send state to all players
  broadcast();
}

function compressState(viewerX, viewerY, viewRange){
  let snakes = [];
  let all = getAllSnakes();
  
  for(let s of all){
    if(!s.alive) continue;
    let hd=s.sg[0];
    if(di(hd.x,hd.y,viewerX,viewerY)>viewRange+s.sg.length*SDIST) continue;
    
    // Send only every 2nd segment for bandwidth
    let segs=[];
    for(let i=0;i<s.sg.length;i+=2){
      segs.push(Math.round(s.sg[i].x*10)/10, Math.round(s.sg[i].y*10)/10);
    }
    snakes.push({
      id:s.id, n:s.name, sk:s.sk, ac:s.accs,
      a:Math.round(s.a*100)/100,
      s:s.score, b:s.boosting?1:0,
      sg:segs
    });
  }
  
  let visFood=[];
  for(let f of foods){
    if(di(f.x,f.y,viewerX,viewerY)>viewRange) continue;
    visFood.push(Math.round(f.x*10)/10, Math.round(f.y*10)/10, 
                 Math.round(f.size*10)/10);
  }
  
  // Leaderboard
  let sorted=[...all].filter(s=>s.alive).sort((a,b)=>b.score-a.score).slice(0,10);
  let lb=sorted.map(s=>({n:s.name,s:s.score}));
  
  return {type:'state', snakes, food:visFood, lb};
}

function broadcast(){
  for(let [id,p] of players){
    if(p.ws.readyState!==WebSocket.OPEN) continue;
    let s=p.snake;
    let vx=0,vy=0;
    if(s&&s.alive){vx=s.sg[0].x;vy=s.sg[0].y;}
    let state=compressState(vx,vy,1200);
    state.pid=s?s.id:0;
    try{ p.ws.send(JSON.stringify(state)); }catch(e){}
  }
}

// --- WebSocket ---
wss.on('connection', (ws) => {
  let playerId = nextId++;
  let playerData = { ws, snake: null };
  players.set(playerId, playerData);
  
  console.log(`Player ${playerId} connected. Total: ${players.size}`);
  
  ws.send(JSON.stringify({type:'welcome', id:playerId, world:WORLD}));
  
  ws.on('message', (msg) => {
    try{
      let data = JSON.parse(msg);
      
      if(data.type==='join'){
        let sp=safeSpawn();
        let s=mkSnake(sp.x,sp.y, data.name||'Player', data.skin||0, false, data.acc||0);
        playerData.snake=s;
        ws.send(JSON.stringify({type:'spawned', id:s.id}));
      }
      
      if(data.type==='input' && playerData.snake && playerData.snake.alive){
        playerData.snake.ta = data.a;
        playerData.snake.boosting = data.b && playerData.snake.score>=BOOST_MIN;
      }
      
      if(data.type==='respawn'){
        let sp=safeSpawn();
        let s=mkSnake(sp.x,sp.y, data.name||'Player', data.skin||0, false, data.acc||0);
        playerData.snake=s;
        ws.send(JSON.stringify({type:'spawned', id:s.id}));
      }
    }catch(e){}
  });
  
  ws.on('close', ()=>{
    let s=playerData.snake;
    if(s&&s.alive) killS(s);
    players.delete(playerId);
    console.log(`Player ${playerId} disconnected. Total: ${players.size}`);
  });
});

// Start game loop
setInterval(gameTick, TICK);

// Health check for Render/Railway
app.get('/health', (req, res) => res.status(200).send('OK'));

// Keep-alive ping to prevent idle shutdown (Render free tier sleeps after 15min)
setInterval(() => {
  for(let [id,p] of players){
    if(p.ws.readyState === WebSocket.OPEN){
      try { p.ws.ping(); } catch(e) {}
    }
  }
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', ()=>{
  console.log(`Slither server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} to play`);
});
