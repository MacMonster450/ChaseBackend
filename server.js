import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load an optional local .env file without requiring an extra package. Hosted environment variables take precedence.
try {
  const envText = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
} catch (error) { if (error.code !== 'ENOENT') console.warn('Could not read optional .env file:', error.message); }
const PORT = Number(process.env.PORT || 3000);
const ROOM_TTL_MS = 30 * 60 * 1000;
const ROUND_MS = 90 * 1000;
const TICK_MS = 33;
const SNAPSHOT_MS = 50;
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const W = 2200, H = 1600, RADIUS = 13;
const pond = {x:1170,y:790,rx:152,ry:96};
const walls = [
  {x:370,y:145,w:165,h:112,type:'cabin'},{x:720,y:270,w:178,h:32,type:'stone'},
  {x:1032,y:138,w:42,h:206,type:'ruinwall'},{x:1480,y:250,w:196,h:126,type:'shed'},
  {x:1815,y:330,w:152,h:34,type:'stone'},{x:270,y:500,w:210,h:40,type:'log'},
  {x:625,y:650,w:250,h:42,type:'stone'},{x:990,y:535,w:172,h:118,type:'ruin'},
  {x:1450,y:668,w:248,h:42,type:'stone'},{x:1800,y:865,w:42,h:202,type:'ruinwall'},
  {x:340,y:1030,w:172,h:114,type:'ruin'},{x:700,y:1240,w:240,h:40,type:'log'},
  {x:1110,y:1050,w:42,h:230,type:'ruinwall'},{x:1430,y:1260,w:210,h:86,type:'shelter'},
  {x:1800,y:1190,w:160,h:36,type:'stone'},{x:845,y:1010,w:176,h:32,type:'stone'},
  {x:1280,y:490,w:162,h:34,type:'stone'},{x:530,y:370,w:38,h:150,type:'ruinwall'}
];
const spawn = {
  runner: {x:150,y:170,dx:1,dy:0,stamina:100,score:0,active:true},
  catcher:{x:2040,y:1430,dx:-1,dy:0,stamina:100,score:0,active:true}
};
function makeTrees(){let seed=731991;const rnd=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296};const out=[];let attempts=0;while(out.length<142&&attempts<2200){attempts++;const x=38+rnd()*(W-76),y=38+rnd()*(H-76),r=13+rnd()*8;if(Math.hypot(x-spawn.runner.x,y-spawn.runner.y)<155||Math.hypot(x-spawn.catcher.x,y-spawn.catcher.y)<155)continue;if(walls.some(w=>x>w.x-35&&x<w.x+w.w+35&&y>w.y-35&&y<w.y+w.h+35))continue;const ex=(x-pond.x)/(pond.rx+30),ey=(y-pond.y)/(pond.ry+30);if(ex*ex+ey*ey<1.22)continue;if(out.some(t=>Math.hypot(x-t.x,y-t.y)<44))continue;out.push({x,y,r,variant:Math.floor(rnd()*4),shade:rnd()});}return out}
const trees=makeTrees();

const app = express();
app.disable('x-powered-by');
app.get('/health', (_req, res) => res.json({ok:true, service:'CHASE.EXE multiplayer backend'}));
app.use(express.static(path.join(__dirname, 'public'), { extensions:['html'] }));
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer:true, maxPayload:8192, perMessageDeflate:false });
const rooms = new Map();
const createLimits = new Map();

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function errorTo(ws, message) { send(ws, {type:'error', message}); }
function token() { return crypto.randomBytes(24).toString('base64url'); }
function makeCode() {
  let code = '';
  do {
    code = '';
    for (let i=0;i<8;i++) code += ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
  } while (rooms.has(code));
  return code;
}
function copySpawn(role) { return {...spawn[role], updatedAt:Date.now(), active:true}; }
function copyPlayer(p, online) {
  return {x:p.x,y:p.y,dx:p.dx,dy:p.dy,stamina:p.stamina,score:p.score,updatedAt:p.updatedAt||0,active:Boolean(online)};
}
function publicRoom(room) {
  return {
    code: room.code,
    game: {...room.game},
    players: {
      runner: copyPlayer(room.players.runner, Boolean(room.members.runner)),
      catcher: copyPlayer(room.players.catcher, Boolean(room.members.catcher))
    },
    online: {runner:Boolean(room.members.runner), catcher:Boolean(room.members.catcher)},
    serverTime: Date.now()
  };
}
function publish(room) {
  const payload = {type:'state', room:publicRoom(room)};
  send(room.members.runner, payload);
  send(room.members.catcher, payload);
}
function publishNotice(room, message) {
  const payload = {type:'notice', message};
  send(room.members.runner, payload);
  send(room.members.catcher, payload);
}
function isOpen(ws) { return ws && ws.readyState === WebSocket.OPEN; }
function touch(room) { room.lastSeen = Date.now(); }
function newRoom(quickMatch = false) {
  const code = makeCode();
  return {
    code,
    quickMatch:Boolean(quickMatch),
    createdAt:Date.now(),
    lastSeen:Date.now(),
    members:{runner:null,catcher:null},
    tokens:{runner:null,catcher:null},
    inputs:{runner:{x:0,y:0,sprint:false,at:0},catcher:{x:0,y:0,sprint:false,at:0}},
    players:{runner:copySpawn('runner'),catcher:copySpawn('catcher')},
    game:{state:'waiting',startAt:0,finishAt:0,winner:'',result:'',round:1,endedAt:0}
  };
}
function snapshotTo(ws, room, role, sessionToken) {
  ws.roomCode = room.code;
  ws.role = role;
  ws.sessionToken = sessionToken;
  room.members[role] = ws;
  room.players[role].active = true;
  room.players[role].updatedAt = Date.now();
  room.inputs[role] = {x:0,y:0,sprint:false,at:Date.now()};
  touch(room);
  send(ws, {type:'joined',ok:true,code:room.code,role,sessionToken,room:publicRoom(room)});
  publish(room);
}
function beginRound(room, increment=false) {
  if (!room.members.runner || !room.members.catcher) return;
  const now = Date.now();
  const round = increment ? Number(room.game.round || 1) + 1 : Number(room.game.round || 1);
  room.players.runner = copySpawn('runner');
  room.players.catcher = copySpawn('catcher');
  room.inputs.runner = {x:0,y:0,sprint:false,at:now};
  room.inputs.catcher = {x:0,y:0,sprint:false,at:now};
  room.game = {state:'countdown',startAt:now+3000,finishAt:now+3000+ROUND_MS,winner:'',result:'',round,endedAt:0};
  publish(room);
}
function finishRound(room, winner, result) {
  if (!room || room.game.state === 'ended') return;
  const now = Date.now();
  room.game.state = 'ended';
  room.game.winner = winner;
  room.game.result = result;
  room.game.endedAt = now;
  const elapsed = Math.max(0, Math.floor((now - (room.game.startAt || now)) / 1000));
  if (winner === 'runner') {
    room.players.runner.score = elapsed * 10 + 100;
    room.players.catcher.score = elapsed * 2;
  } else {
    room.players.catcher.score = elapsed * 2 + 100;
    room.players.runner.score = elapsed * 10;
  }
  room.players.runner.updatedAt = now;
  room.players.catcher.updatedAt = now;
  room.inputs.runner = {x:0,y:0,sprint:false,at:now};
  room.inputs.catcher = {x:0,y:0,sprint:false,at:now};
  publish(room);
}
function collides(x,y) {
  if (x < RADIUS+10 || x > W-RADIUS-10 || y < RADIUS+10 || y > H-RADIUS-10) return true;
  for (const w of walls) {
    const closestX = Math.max(w.x, Math.min(x, w.x+w.w));
    const closestY = Math.max(w.y, Math.min(y, w.y+w.h));
    const dx=x-closestX, dy=y-closestY;
    if (dx*dx+dy*dy < RADIUS*RADIUS) return true;
  }
  for (const t of trees) { const rr=RADIUS+8, dx=x-t.x, dy=y-t.y; if (dx*dx+dy*dy<rr*rr) return true; }
  const px=(x-pond.x)/(pond.rx+RADIUS), py=(y-pond.y)/(pond.ry+RADIUS);
  if (px*px+py*py < 1) return true;
  return false;
}
function movePlayer(room, role, dt, now) {
  const p = room.players[role];
  const input = room.inputs[role];
  if (!p || !input) return;
  if (now - input.at > 250) { input.x=0; input.y=0; input.sprint=false; }
  let dx=input.x, dy=input.y;
  const len=Math.hypot(dx,dy);
  if (len>1) { dx/=len; dy/=len; }
  const wantsSprint = input.sprint && p.stamina > 1 && len > 0;
  const baseSpeed = role === 'runner' ? 178 : 169;
  const speed = baseSpeed * (wantsSprint ? 1.62 : 1);
  p.stamina = Math.max(0,Math.min(100,p.stamina + (wantsSprint ? -38 : 23)*dt));
  if (len > 0) {
    const nx=p.x+dx*speed*dt;
    const ny=p.y+dy*speed*dt;
    if (!collides(nx,p.y)) p.x=nx;
    if (!collides(p.x,ny)) p.y=ny;
    p.dx=dx; p.dy=dy; p.updatedAt=now;
  }
}
function handleDetach(ws, intentional=false) {
  const code = ws.roomCode, role = ws.role;
  if (!code || !role) return;
  const room = rooms.get(code);
  ws.roomCode=null; ws.role=null; ws.sessionToken=null;
  if (!room || room.members[role] !== ws) return;
  room.members[role] = null;
  room.players[role].active = false;
  room.inputs[role] = {x:0,y:0,sprint:false,at:Date.now()};
  touch(room);
  if (intentional) {
    if (role === 'runner') {
      const other = room.members.catcher;
      send(other,{type:'roomClosed',message:'The runner left the room.'});
      if (isOpen(other)) other.close(1000,'Room closed by host');
      rooms.delete(code);
      return;
    }
    room.tokens.catcher = null;
    if (room.game.state === 'ended') {
      room.game.state = 'waiting'; room.game.startAt = 0; room.game.finishAt = 0;
      room.game.winner = ''; room.game.endedAt = 0; room.game.result = 'Catcher left. Waiting for a new catcher.';
    }
  }
  if (!intentional && role === 'catcher' && room.quickMatch && room.game.state === 'ended') {
    room.tokens.catcher = null; room.game.state='waiting'; room.game.startAt=0; room.game.finishAt=0;
    room.game.winner=''; room.game.endedAt=0; room.game.result='Rival disconnected. Searching for another player.';
  }
  if (room.game.state === 'playing' || room.game.state === 'countdown') {
    room.game.state = 'waiting'; room.game.startAt=0; room.game.finishAt=0;
    room.game.winner=''; room.game.result='A player disconnected. Waiting for both players.';
  }
  publish(room);
  if (intentional && role === 'catcher') publishNotice(room,'The catcher left. A new catcher can join with the same code.');
}
function rateAllowed(ws) {
  const ip = ws._ip || 'unknown';
  const now = Date.now();
  const old = createLimits.get(ip) || {count:0,start:now};
  if (now-old.start > 60_000) { old.count=0; old.start=now; }
  old.count++;
  createLimits.set(ip,old);
  return old.count <= 12;
}
function cleanCode(value) { return String(value||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8); }

server.on('upgrade', (req, socket, head) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; }
  catch { socket.destroy(); return; }
  if (pathname !== '/ws') { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
  const origin = req.headers.origin;
  if (allowedOrigins.length && origin && !allowedOrigins.includes(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, ws => {
    ws._ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', ws => {
  ws.on('message', raw => {
    if (raw.length > 8192) { errorTo(ws,'Message too large.'); return; }
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { errorTo(ws,'Invalid message format.'); return; }
    const type = String(msg.type || '');
    if (type === 'heartbeat') { send(ws,{type:'heartbeat',serverTime:Date.now()}); return; }
    if (!ws.roomCode) {
      if (type === 'matchmake') {
        if (!rateAllowed(ws)) { errorTo(ws,'Too many matchmaking requests. Wait a minute and try again.'); return; }
        if (rooms.size >= 1000) { errorTo(ws,'The server is currently full. Try again later.'); return; }
        const waiting = Array.from(rooms.values()).filter(r => r.quickMatch && r.game.state === 'waiting' && isOpen(r.members.runner) && !isOpen(r.members.catcher) && Date.now()-r.lastSeen < ROOM_TTL_MS);
        if (waiting.length) {
          const room = waiting[crypto.randomInt(waiting.length)];
          const sessionToken = token(); room.tokens.catcher = sessionToken;
          snapshotTo(ws,room,'catcher',sessionToken);
          if (room.members.runner && room.members.catcher) beginRound(room,false);
          publishNotice(room,'Random rival found. The chase is starting.');
        } else {
          const room = newRoom(true); rooms.set(room.code,room);
          const sessionToken = token(); room.tokens.runner = sessionToken;
          snapshotTo(ws,room,'runner',sessionToken);
          send(ws,{type:'matchmaking',status:'queued',message:'Searching for another player…'});
        }
        return;
      }
      if (type === 'create') {
        if (!rateAllowed(ws)) { errorTo(ws,'Too many room requests from this connection. Try again in a minute.'); return; }
        if (rooms.size >= 1000) { errorTo(ws,'The server is currently full. Try again later.'); return; }
        const room = newRoom(); rooms.set(room.code,room);
        const sessionToken = token(); room.tokens.runner = sessionToken;
        snapshotTo(ws,room,'runner',sessionToken);
        return;
      }
      if (type === 'join') {
        if (!rateAllowed(ws)) { errorTo(ws,'Too many room requests from this connection. Try again in a minute.'); return; }
        const code = cleanCode(msg.code), room = rooms.get(code);
        if (!room) { errorTo(ws,'Room not found. Check the code or ask your friend to create a new room.'); return; }
        if (room.game.state === 'ended' && room.members.catcher && isOpen(room.members.catcher)) { errorTo(ws,'That round has ended and the catcher is still connected. Ask the runner to start the next round.'); return; }
        if (room.members.catcher && isOpen(room.members.catcher)) { errorTo(ws,'This room already has two players.'); return; }
        const wasEnded = room.game.state === 'ended';
        const sessionToken = token(); room.tokens.catcher=sessionToken;
        snapshotTo(ws,room,'catcher',sessionToken);
        if (room.members.runner && room.members.catcher) beginRound(room,wasEnded);
        return;
      }
      if (type === 'reconnect') {
        const code=cleanCode(msg.code), room=rooms.get(code), supplied=String(msg.sessionToken||'');
        if (!room || !supplied) { errorTo(ws,'Reconnect session is no longer available. Create or join a room again.'); return; }
        const role = room.tokens.runner === supplied ? 'runner' : room.tokens.catcher === supplied ? 'catcher' : '';
        if (!role) { errorTo(ws,'Session token is invalid or expired.'); return; }
        const previous = room.members[role];
        if (previous && previous !== ws && isOpen(previous)) { previous.roomCode=null; previous.role=null; previous.sessionToken=null; previous.close(4001,'Reconnected in another tab'); }
        snapshotTo(ws,room,role,supplied);
        if (room.members.runner && room.members.catcher && room.game.state === 'waiting') beginRound(room,false);
        return;
      }
      errorTo(ws,'Create a room or join with a code first.'); return;
    }
    const code=ws.roomCode, role=ws.role, room=rooms.get(code);
    if (!room || room.members[role] !== ws || room.tokens[role] !== ws.sessionToken) {
      errorTo(ws,'Your room session is no longer active. Reconnect or create a new room.'); return;
    }
    touch(room);
    if (type === 'input') {
      if (room.game.state !== 'playing') return;
      const n = v => Math.max(-1,Math.min(1,Number(v)||0));
      room.inputs[role] = {x:n(msg.x),y:n(msg.y),sprint:Boolean(msg.sprint),at:Date.now()};
      return;
    }
    if (type === 'restart') {
      if (role !== 'runner') { errorTo(ws,'Only the runner can start the next round.'); return; }
      if (room.game.state !== 'ended') { errorTo(ws,'The current round has not ended yet.'); return; }
      if (!room.members.runner || !room.members.catcher) { errorTo(ws,'Wait until both players are connected.'); return; }
      beginRound(room,true); return;
    }
    if (type === 'leave') { handleDetach(ws,true); try { ws.close(1000,'Left room'); } catch {} return; }
  });
  ws.on('close', () => handleDetach(ws,false));
  ws.on('error', () => {});
});

let lastSnapshot = 0, lastTick = Date.now();
setInterval(() => {
  const now=Date.now();
  const dt=Math.max(0,Math.min(0.05,(now-lastTick)/1000));
  lastTick=now;
  for (const [code,room] of rooms) {
    if (now-room.lastSeen > ROOM_TTL_MS) {
      for (const role of ['runner','catcher']) send(room.members[role],{type:'roomClosed',message:'This room expired because it was inactive.'});
      rooms.delete(code); continue;
    }
    if (room.game.state === 'countdown' && now >= room.game.startAt) {
      room.game.state='playing';
      room.players.runner.updatedAt=now; room.players.catcher.updatedAt=now;
    }
    if (room.game.state === 'playing') {
      if (!room.members.runner || !room.members.catcher) {
        room.game.state='waiting'; room.game.startAt=0; room.game.finishAt=0;
        room.game.result='A player disconnected. Waiting for both players.';
      } else {
        movePlayer(room,'runner',dt,now);
        movePlayer(room,'catcher',dt,now);
        const runner=room.players.runner, catcher=room.players.catcher;
        const elapsed=Math.max(0,Math.floor((now-room.game.startAt)/1000));
        runner.score=elapsed*10; catcher.score=elapsed*2;
        if (Math.hypot(runner.x-catcher.x,runner.y-catcher.y) < 28) finishRound(room,'catcher','TAGGED! The catcher caught the runner.');
        else if (now >= room.game.finishAt) finishRound(room,'runner','TIME UP! The runner escaped.');
      }
    }
    if (now-lastSnapshot >= SNAPSHOT_MS) publish(room);
  }
  if (now-lastSnapshot >= SNAPSHOT_MS) lastSnapshot=now;
}, TICK_MS);

server.listen(PORT,'0.0.0.0',() => {
  console.log(`CHASE.EXE backend listening on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} to play locally.`);
});
