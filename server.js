import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { Pool } from 'pg';
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
const WAITING_ROOM_TIMEOUT_MS = Math.max(30_000, Number(process.env.ROOM_WAIT_TIMEOUT_MS || 120_000));
const PROFILE_IP_RETENTION_DAYS = Math.max(1, Number(process.env.PROFILE_IP_RETENTION_DAYS || 30));
const ROUND_MS = 90 * 1000;
const TICK_MS = 33;
const SNAPSHOT_MS = 50;
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const databaseUrl = process.env.DATABASE_URL || '';
const databaseSslMode = (() => { try { return new URL(databaseUrl).searchParams.get('sslmode') || ''; } catch { return ''; } })();
const databaseConnectionString = (() => { try { const parsed = new URL(databaseUrl); parsed.searchParams.delete('sslmode'); return parsed.toString(); } catch { return databaseUrl; } })();
const dbPool = databaseUrl ? new Pool({
  connectionString: databaseConnectionString,
  // Use normal certificate validation when the provider's URL requires TLS (e.g. Neon).
  // Render internal URLs have no sslmode query parameter and can use the private network without TLS.
  ssl: ['require','verify-ca','verify-full'].includes(databaseSslMode) ? true : false,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
}) : null;
let dbReady = false;

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

async function initializeDatabase() {
  if (!dbPool) {
    console.warn('DATABASE_URL is not configured. Player memory/IP storage is disabled; active matches still work in memory.');
    return;
  }
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS chase_players (
      player_id VARCHAR(64) PRIMARY KEY,
      profile_token_hash CHAR(64) NOT NULL,
      display_name VARCHAR(24) NOT NULL,
      first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_ip TEXT,
      ip_last_seen TIMESTAMPTZ,
      matches_played INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0
    )
  `);
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS chase_matches (
      match_id UUID PRIMARY KEY,
      runner_id VARCHAR(64) REFERENCES chase_players(player_id) ON DELETE SET NULL,
      catcher_id VARCHAR(64) REFERENCES chase_players(player_id) ON DELETE SET NULL,
      winner_role VARCHAR(12) NOT NULL CHECK (winner_role IN ('runner','catcher')),
      round_number INTEGER NOT NULL,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await dbPool.query('CREATE INDEX IF NOT EXISTS chase_players_last_seen_idx ON chase_players(last_seen)');
  await dbPool.query('CREATE INDEX IF NOT EXISTS chase_matches_completed_at_idx ON chase_matches(completed_at)');
  dbReady = true;
  await cleanExpiredIpData();
  console.log('Persistent PostgreSQL player memory enabled. IP retention: ' + PROFILE_IP_RETENTION_DAYS + ' days after last seen.');
}

async function cleanExpiredIpData() {
  if (!dbReady || !dbPool) return;
  try {
    await dbPool.query(
      `UPDATE chase_players SET last_ip = NULL WHERE last_ip IS NOT NULL AND ip_last_seen < NOW() - ($1::text || ' days')::interval`,
      [String(PROFILE_IP_RETENTION_DAYS)]
    );
  } catch (err) {
    console.error('IP-retention cleanup failed:', err.message);
  }
}

function profileIdValid(v) { return /^[a-f0-9]{32}$/i.test(String(v || '')); }
function profileTokenValid(v) { return /^[a-f0-9]{64}$/i.test(String(v || '')); }
function hashProfileToken(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }
function cleanDisplayName(v) {
  const name = String(v || '').normalize('NFKC').replace(/[<>"'`\\]/g, '').replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 24);
  return name || 'Forest Scout';
}

async function rememberPlayer(ws, profile) {
  if (!profile || profile.consent !== true) throw new Error('Please accept the player-data notice before joining.');
  const playerId = String(profile.playerId || '');
  const profileToken = String(profile.profileToken || '');
  if (!profileIdValid(playerId) || !profileTokenValid(profileToken)) throw new Error('Saved player profile is invalid. Use “Forget saved profile” and try again.');
  const displayName = cleanDisplayName(profile.displayName);
  const tokenHash = hashProfileToken(profileToken);
  ws.playerId = playerId;
  ws.displayName = displayName;
  ws.profileStorage = dbReady;
  ws.profileReturning = false;
  if (!dbReady || !dbPool) return;

  const ip = isIP(String(ws._ip || '')) ? String(ws._ip) : null;
  const result = await dbPool.query(`
    INSERT INTO chase_players (player_id, profile_token_hash, display_name, last_ip, ip_last_seen)
    VALUES ($1, $2, $3, $4, CASE WHEN $4 IS NULL THEN NULL ELSE NOW() END)
    ON CONFLICT (player_id) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      last_seen = NOW(),
      last_ip = EXCLUDED.last_ip,
      ip_last_seen = CASE WHEN EXCLUDED.last_ip IS NULL THEN chase_players.ip_last_seen ELSE NOW() END
    WHERE chase_players.profile_token_hash = EXCLUDED.profile_token_hash
    RETURNING player_id, display_name, (xmax = 0) AS is_new
  `, [playerId, tokenHash, displayName, ip]);
  if (!result.rowCount) throw new Error('This saved profile could not be verified. Select “Forget saved profile” on this device and try again.');
  ws.profileReturning = !result.rows[0].is_new;
  ws.profileStorage = true;
}

async function forgetPlayer(profile) {
  const playerId = String(profile?.playerId || '');
  const profileToken = String(profile?.profileToken || '');
  if (!profileIdValid(playerId) || !profileTokenValid(profileToken)) return {ok:false, persistent:dbReady, message:'Saved profile details are missing.'};
  if (!dbReady || !dbPool) return {ok:true, deleted:false, persistent:false, message:'The backend database is not configured; only this device profile can be cleared.'};
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const ownership = await client.query('SELECT player_id FROM chase_players WHERE player_id = $1 AND profile_token_hash = $2 FOR UPDATE', [playerId, hashProfileToken(profileToken)]);
    if (!ownership.rowCount) {
      await client.query('ROLLBACK');
      return {ok:true, deleted:false, persistent:true, message:'No matching saved profile was found.'};
    }
    const linked = await client.query('SELECT DISTINCT CASE WHEN runner_id = $1 THEN catcher_id ELSE runner_id END AS other_id FROM chase_matches WHERE runner_id = $1 OR catcher_id = $1', [playerId]);
    await client.query('DELETE FROM chase_matches WHERE runner_id = $1 OR catcher_id = $1', [playerId]);
    const deleted = await client.query('DELETE FROM chase_players WHERE player_id = $1 AND profile_token_hash = $2', [playerId, hashProfileToken(profileToken)]);
    if (deleted.rowCount) {
      for (const row of linked.rows) {
        if (!row.other_id) continue;
        await client.query(`
          UPDATE chase_players p SET
            matches_played = (SELECT COUNT(*)::int FROM chase_matches m WHERE m.runner_id = p.player_id OR m.catcher_id = p.player_id),
            wins = (SELECT COUNT(*)::int FROM chase_matches m WHERE (m.runner_id = p.player_id AND m.winner_role = 'runner') OR (m.catcher_id = p.player_id AND m.winner_role = 'catcher')),
            losses = (SELECT COUNT(*)::int FROM chase_matches m WHERE (m.runner_id = p.player_id AND m.winner_role = 'catcher') OR (m.catcher_id = p.player_id AND m.winner_role = 'runner'))
          WHERE p.player_id = $1
        `, [row.other_id]);
      }
    }
    await client.query('COMMIT');
    return {ok:true, deleted:deleted.rowCount > 0, persistent:true, message:deleted.rowCount ? 'Saved profile, IP record, and linked match records were deleted.' : 'No matching saved profile was found.'};
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

async function recordMatch(room, winner) {
  if (!dbReady || !dbPool || !room.playerIds?.runner || !room.playerIds?.catcher) return;
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`
      INSERT INTO chase_matches (match_id, runner_id, catcher_id, winner_role, round_number)
      VALUES ($1::uuid, $2, $3, $4, $5)
      ON CONFLICT (match_id) DO NOTHING
    `, [crypto.randomUUID(), room.playerIds.runner, room.playerIds.catcher, winner, Number(room.game.round || 1)]);
    if (result.rowCount) {
      await client.query(`UPDATE chase_players SET matches_played = matches_played + 1, wins = wins + $2, losses = losses + $3, last_seen = NOW() WHERE player_id = $1`, [room.playerIds.runner, winner === 'runner' ? 1 : 0, winner === 'runner' ? 0 : 1]);
      await client.query(`UPDATE chase_players SET matches_played = matches_played + 1, wins = wins + $2, losses = losses + $3, last_seen = NOW() WHERE player_id = $1`, [room.playerIds.catcher, winner === 'catcher' ? 1 : 0, winner === 'catcher' ? 0 : 1]);
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Could not record match result:', err.message);
  } finally {
    client.release();
  }
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({limit:'8kb'}));

// Admin credentials must be configured in the hosting environment, never embedded in HTML or committed to Git.
const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || 'MacMonster').trim();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ADMIN_COOKIE = 'chase_admin';
const adminSessions = new Map();
const adminLoginAttempts = new Map();
function safeSecretEqual(a, b) {
  const aa = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}
function adminSessionFrom(req) {
  const header = String(req.headers.cookie || '');
  const pair = header.split(';').map(v => v.trim()).find(v => v.startsWith(ADMIN_COOKIE + '='));
  if (!pair) return null;
  let raw = pair.slice(ADMIN_COOKIE.length + 1);
  try { raw = decodeURIComponent(raw); } catch { return null; }
  const key = crypto.createHash('sha256').update(raw).digest('hex');
  const session = adminSessions.get(key);
  if (!session || session.expiresAt < Date.now()) { adminSessions.delete(key); return null; }
  return {key, ...session};
}
function requireAdmin(req, res, next) {
  const session = adminSessionFrom(req);
  if (!session) return res.status(401).json({ok:false, message:'Admin session expired. Please sign in again.'});
  req.adminSession = session;
  res.set('Cache-Control', 'no-store');
  next();
}
function adminLoginAllowed(req) {
  const key = String(req.ip || req.socket?.remoteAddress || 'unknown');
  const now = Date.now();
  let record = adminLoginAttempts.get(key);
  if (!record || now - record.startedAt > 15 * 60 * 1000) record = {startedAt:now, count:0};
  if (record.count >= 8) { adminLoginAttempts.set(key, record); return false; }
  record.count++;
  adminLoginAttempts.set(key, record);
  return true;
}
function adminCookie(tokenValue, req, maxAgeSeconds) {
  const secure = req.secure || process.env.NODE_ENV === 'production';
  return `${ADMIN_COOKIE}=${encodeURIComponent(tokenValue)}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}
app.get('/admin', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Frame-Options', 'DENY');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.post('/api/admin/login', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) return res.status(503).json({ok:false, message:'Admin login is not configured on the server.'});
  if (!adminLoginAllowed(req)) return res.status(429).json({ok:false, message:'Too many sign-in attempts. Wait 15 minutes and try again.'});
  const usernameOk = safeSecretEqual(req.body?.username, ADMIN_USERNAME);
  const passwordOk = safeSecretEqual(req.body?.password, ADMIN_PASSWORD);
  if (!usernameOk || !passwordOk) return res.status(401).json({ok:false, message:'Username or password is incorrect.'});
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const key = crypto.createHash('sha256').update(rawToken).digest('hex');
  adminSessions.set(key, {username:ADMIN_USERNAME, expiresAt:Date.now() + ADMIN_SESSION_TTL_MS});
  adminLoginAttempts.delete(String(req.ip || req.socket?.remoteAddress || 'unknown'));
  res.set('Set-Cookie', adminCookie(rawToken, req, ADMIN_SESSION_TTL_MS / 1000));
  return res.json({ok:true, username:ADMIN_USERNAME, expiresInSeconds:ADMIN_SESSION_TTL_MS / 1000});
});
app.get('/api/admin/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const session = adminSessionFrom(req);
  return res.json({ok:true, authenticated:Boolean(session), username:session?.username || null});
});
app.post('/api/admin/logout', (req, res) => {
  const session = adminSessionFrom(req);
  if (session) adminSessions.delete(session.key);
  res.set('Set-Cookie', adminCookie('', req, 0));
  res.set('Cache-Control', 'no-store');
  return res.json({ok:true});
});
app.get('/api/admin/summary', requireAdmin, async (_req, res) => {
  if (!dbReady || !dbPool) return res.status(503).json({ok:false, message:'PostgreSQL is not configured. Add DATABASE_URL in the hosting environment.'});
  try {
    const [players, matches, wins, ips] = await Promise.all([
      dbPool.query('SELECT COUNT(*)::int AS n FROM chase_players'),
      dbPool.query('SELECT COUNT(*)::int AS n FROM chase_matches'),
      dbPool.query('SELECT COALESCE(SUM(wins),0)::int AS n FROM chase_players'),
      dbPool.query('SELECT COUNT(*)::int AS n FROM chase_players WHERE last_ip IS NOT NULL')
    ]);
    return res.json({ok:true, storage:{enabled:true,type:'postgres'}, players:players.rows[0].n, matches:matches.rows[0].n, wins:wins.rows[0].n, ips:ips.rows[0].n});
  } catch (err) { console.error('Admin summary query failed:', err.message); return res.status(500).json({ok:false,message:'Could not load database summary.'}); }
});
app.get('/api/admin/players', requireAdmin, async (_req, res) => {
  if (!dbReady || !dbPool) return res.status(503).json({ok:false, message:'PostgreSQL is not configured. Add DATABASE_URL in the hosting environment.'});
  try {
    const result = await dbPool.query(`SELECT player_id, display_name, last_ip, first_seen, last_seen, matches_played, wins, losses FROM chase_players ORDER BY last_seen DESC LIMIT 500`);
    return res.json({ok:true, players:result.rows});
  } catch (err) { console.error('Admin players query failed:', err.message); return res.status(500).json({ok:false,message:'Could not load player records.'}); }
});
app.get('/api/admin/matches', requireAdmin, async (_req, res) => {
  if (!dbReady || !dbPool) return res.status(503).json({ok:false, message:'PostgreSQL is not configured. Add DATABASE_URL in the hosting environment.'});
  try {
    const result = await dbPool.query(`
      SELECT m.match_id, m.completed_at, m.round_number, m.winner_role,
        r.display_name AS runner_name, c.display_name AS catcher_name
      FROM chase_matches m
      LEFT JOIN chase_players r ON r.player_id = m.runner_id
      LEFT JOIN chase_players c ON c.player_id = m.catcher_id
      ORDER BY m.completed_at DESC LIMIT 100
    `);
    return res.json({ok:true, matches:result.rows});
  } catch (err) { console.error('Admin matches query failed:', err.message); return res.status(500).json({ok:false,message:'Could not load match records.'}); }
});
app.get('/health', (_req, res) => res.json({ok:true, service:'CHASE.EXE multiplayer backend', storage:{enabled:dbReady, type:dbReady?'postgres':'ephemeral'}}));
app.use(express.static(path.join(__dirname, 'public'), { extensions:['html'] }));
const server = http.createServer(app);
setInterval(() => {
  const now = Date.now();
  for (const [key, session] of adminSessions) if (session.expiresAt < now) adminSessions.delete(key);
  for (const [key, record] of adminLoginAttempts) if (now - record.startedAt > 30 * 60 * 1000) adminLoginAttempts.delete(key);
}, 5 * 60 * 1000).unref();
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
    waitTimeoutAt: room.waitingSince ? room.waitingSince + WAITING_ROOM_TIMEOUT_MS : 0,
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
    waitingSince:Date.now(),
    playerIds:{runner:null,catcher:null},
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
  room.playerIds[role] = ws.playerId || null;
  room.players[role].active = true;
  room.players[role].updatedAt = Date.now();
  room.inputs[role] = {x:0,y:0,sprint:false,at:Date.now()};
  touch(room);
  send(ws, {type:'joined',ok:true,code:room.code,role,sessionToken,room:publicRoom(room),profile:{displayName:ws.displayName||'Forest Scout',returning:Boolean(ws.profileReturning),persistent:Boolean(ws.profileStorage)}});
  publish(room);
}
function beginRound(room, increment=false) {
  if (!room.members.runner || !room.members.catcher) return;
  const now = Date.now();
  room.waitingSince = 0;
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
  room.waitingSince = 0;
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
  void recordMatch(room, winner);
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
    if (room.game.state === 'waiting') room.waitingSince = Date.now();
    if (room.game.state === 'ended') {
      room.game.state = 'waiting'; room.game.startAt = 0; room.game.finishAt = 0;
      room.game.winner = ''; room.game.endedAt = 0; room.game.result = 'Catcher left. Waiting for a new catcher.';
      room.waitingSince = Date.now();
    }
  }
  if (!intentional && role === 'catcher' && room.game.state === 'waiting' && room.members.runner) room.waitingSince = Date.now();
  if (!intentional && role === 'catcher' && room.quickMatch && room.game.state === 'ended') {
    room.tokens.catcher = null; room.game.state='waiting'; room.game.startAt=0; room.game.finishAt=0;
    room.game.winner=''; room.game.endedAt=0; room.game.result='Rival disconnected. Searching for another player.';
    room.waitingSince = Date.now();
  }
  if (room.game.state === 'playing' || room.game.state === 'countdown') {
    room.game.state = 'waiting'; room.game.startAt=0; room.game.finishAt=0;
    room.game.winner=''; room.game.result='A player disconnected. Waiting for both players.';
    room.waitingSince = Date.now();
  } else if (room.game.state === 'waiting' && (room.members.runner || room.members.catcher) && !room.waitingSince) {
    room.waitingSince = Date.now();
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
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(v => v.trim()).filter(Boolean);
    ws._ip = forwarded.length ? forwarded[forwarded.length - 1] : String(req.socket.remoteAddress || 'unknown');
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', ws => {
  ws.on('message', async raw => {
    if (raw.length > 8192) { errorTo(ws,'Message too large.'); return; }
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { errorTo(ws,'Invalid message format.'); return; }
    const type = String(msg.type || '');
    if (type === 'forgetProfile') {
      try { send(ws, {type:'forgotten', ...await forgetPlayer(msg.profile || {})}); }
      catch (err) { send(ws, {type:'forgotten',ok:false,persistent:dbReady,message:'Could not process the profile deletion request.'}); }
      return;
    }
    if (['matchmake','create','join','reconnect'].includes(type)) {
      try {
        if (ws.profileReady) {
          if (String(msg.profile?.playerId || '') !== ws.playerId || String(msg.profile?.profileToken || '') !== ws._profileToken) throw new Error('Player identity changed during this connection. Reconnect and try again.');
        } else { await rememberPlayer(ws, msg.profile); ws._profileToken = String(msg.profile.profileToken); ws.profileReady = true; }
      }
      catch (err) { errorTo(ws, err.message || 'Could not verify your player profile.'); return; }
    }
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
    if (room.game.state === 'waiting' && room.waitingSince && now - room.waitingSince >= WAITING_ROOM_TIMEOUT_MS && !(isOpen(room.members.runner) && isOpen(room.members.catcher))) {
      const message = room.quickMatch ? 'No rival joined before the matchmaking timer expired. Please find a match again.' : 'Invite expired because nobody joined within the time limit. Create a new room or share a fresh invite.';
      for (const role of ['runner','catcher']) {
        const member = room.members[role];
        send(member,{type:'roomClosed',message});
        if (isOpen(member)) { try { member.close(4000,'Waiting room timed out'); } catch {} }
      }
      rooms.delete(code);
      continue;
    }
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

async function startServer() {
  try {
    await initializeDatabase();
  } catch (err) {
    console.error('Database initialization failed. Check DATABASE_URL and the PostgreSQL service:', err.message);
    process.exit(1);
  }
  setInterval(cleanExpiredIpData, 6 * 60 * 60 * 1000).unref();
  server.listen(PORT,'0.0.0.0',() => {
    console.log(`CHASE.EXE backend listening on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} to play locally.`);
    if (!dbReady) console.warn('WARNING: persistent player memory is disabled until DATABASE_URL is configured.');
  });
}
void startServer();
