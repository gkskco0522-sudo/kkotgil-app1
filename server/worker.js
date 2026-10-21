// 너의 꽃길 · 공유 서버 (Cloudflare Worker)
// 아이 정보를 8자리 숫자 코드로 24시간만 맡아 두었다가,
// 받는 사람이 코드를 입력하면 한 번만 내주고 바로 지워요.
// 필요한 설정: 이 Worker 의 Bindings 에서 D1 데이터베이스를 변수 이름 DB 로 연결하기

const KEEP = 24 * 3600; // 코드를 맡아 두는 시간(초) = 24시간
const MAXLEN = 100000; // 한 번에 맡길 수 있는 최대 글자 수
const MAKE_MAX = 10; // 같은 기기가 1시간 동안 만들 수 있는 코드 수
const MISS_MAX = 10; // 같은 기기가 10분 동안 틀릴 수 있는 횟수
const MISS_ALL = 200; // 모든 기기를 합쳐 10분 동안 틀릴 수 있는 횟수 (마구 대입하는 공격 막기)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const reply = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });

// 처음 한 번만 표(테이블)를 만들어요
let ready = false;
async function setup(db) {
  if (ready) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS shares (code TEXT PRIMARY KEY, data TEXT NOT NULL, exp INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS counts (key TEXT PRIMARY KEY, n INTEGER NOT NULL, exp INTEGER NOT NULL)'),
  ]);
  ready = true;
}

// 횟수 세기: 같은 시간 칸(win초) 안에서 key 가 몇 번째인지 알려줘요
const slot = (key, win, now) => key + ':' + Math.floor(now / win);
async function bump(db, key, win, now) {
  const row = await db
    .prepare('INSERT INTO counts (key, n, exp) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET n = n + 1 RETURNING n')
    .bind(slot(key, win, now), (Math.floor(now / win) + 1) * win)
    .first();
  return row.n;
}
async function seen(db, key, win, now) {
  const row = await db.prepare('SELECT n FROM counts WHERE key = ?').bind(slot(key, win, now)).first();
  return row ? row.n : 0;
}

// 기기 구분: IPv6 는 앞 4덩어리(/64)가 같으면 같은 기기로 봐요
function who(ip) {
  if (!ip || ip.indexOf(':') < 0 || ip.indexOf('.') >= 0) return ip || 'x';
  const parts = ip.toLowerCase().split('::');
  const a = parts[0] ? parts[0].split(':') : [];
  const b = parts[1] ? parts[1].split(':') : [];
  const mid = parts.length > 1 ? new Array(Math.max(0, 8 - a.length - b.length)).fill('0') : [];
  return a.concat(mid, b).slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':');
}

// 0 ~ n-1 중에서 공평하게 하나 뽑기
function rnd(n) {
  const a = new Uint32Array(1);
  const limit = 4294967296 - (4294967296 % n);
  do {
    crypto.getRandomValues(a);
  } while (a[0] >= limit);
  return a[0] % n;
}
const newCode = () => String(10000000 + rnd(90000000)); // 8자리, 앞자리는 0이 아니에요

export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // 주소창에서 열어 보면 설정이 잘 됐는지 알려줘요
    if (req.method === 'GET' && path === '/') {
      let msg = '너의 꽃길 공유 서버가 켜져 있어요.\n';
      if (!env.DB) {
        msg += '데이터베이스 연결: 안 됨 ❌\nWorker 의 Bindings 에서 D1 데이터베이스를 변수 이름 DB 로 연결해 주세요.';
      } else {
        try {
          await setup(env.DB);
          await env.DB.prepare('SELECT 1').first();
          msg += '데이터베이스 연결: 잘 됨 ✅';
        } catch (e) {
          msg += '데이터베이스 오류 ❌\n' + String((e && e.message) || e).slice(0, 200);
        }
      }
      return new Response(msg, { headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    if (req.method !== 'POST' || (path !== '/new' && path !== '/get')) return reply({ err: 'path' }, 404);

    const now = Math.floor(Date.now() / 1000);
    const ip = who(req.headers.get('CF-Connecting-IP'));
    try {
      const db = env.DB;
      await setup(db);
      const body = (await req.text()).trim();

      // /new : 코드 만들기
      if (path === '/new') {
        if (!/^KG\d:/.test(body)) return reply({ err: 'bad' }, 400);
        if (body.length > MAXLEN) return reply({ err: 'big' }, 413);
        if ((await bump(db, 'make:' + ip, 3600, now)) > MAKE_MAX) return reply({ err: 'rate' }, 429);
        await db.batch([
          db.prepare('DELETE FROM shares WHERE exp <= ?').bind(now),
          db.prepare('DELETE FROM counts WHERE exp <= ?').bind(now),
        ]);
        for (let i = 0; i < 8; i++) {
          const code = newCode();
          const r = await db
            .prepare('INSERT OR IGNORE INTO shares (code, data, exp) VALUES (?, ?, ?)')
            .bind(code, body, now + KEEP)
            .run();
          if (r.meta.changes > 0) return reply({ code, ttl: KEEP });
        }
        return reply({ err: 'busy' }, 503);
      }

      // /get : 코드로 꺼내기 (꺼내면 바로 지워져요)
      if (!/^\d{8}$/.test(body)) return reply({ err: 'bad' }, 400);
      if ((await seen(db, 'miss:' + ip, 600, now)) >= MISS_MAX || (await seen(db, 'miss:all', 600, now)) >= MISS_ALL) {
        return reply({ err: 'rate' }, 429);
      }
      const row = await db.prepare('DELETE FROM shares WHERE code = ? AND exp > ? RETURNING data').bind(body, now).first();
      if (!row) {
        await bump(db, 'miss:' + ip, 600, now);
        await bump(db, 'miss:all', 600, now);
        return reply({ err: 'none' }, 404);
      }
      return reply({ data: row.data });
    } catch (e) {
      return reply({ err: 'server' }, 500);
    }
  },
};
