// 너의 꽃길 · 서버 (Cloudflare Worker)
// ① 아이 정보를 8자리 숫자 코드로 24시간만 맡아 두었다가, 받는 사람이 입력하면 한 번만 내주고 바로 지워요.
// ② 구글 계정으로 로그인하면, 기록을 계정에 저장해 두었다가 다른 폰에서도 꺼내 쓸 수 있게 해줘요.
//
// 필요한 설정
//   - 이 Worker 의 Bindings 에서 D1 데이터베이스를 변수 이름 DB 로 연결하기 (①②모두 필요)
//   - ②를 쓰려면 Settings → Variables and Secrets 에 GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET 추가하기
//   - (선택) ALLOW_EMAILS : 로그인을 허락할 이메일들(쉼표로 구분). 비워 두면 구글에서 허락한 계정은 모두 가능해요.

const KEEP = 24 * 3600; // 코드를 맡아 두는 시간(초) = 24시간
const MAXLEN = 100000; // 한 번에 맡길 수 있는 최대 글자 수
const MAKE_MAX = 10; // 같은 기기가 1시간 동안 만들 수 있는 코드 수
const MISS_MAX = 10; // 같은 기기가 10분 동안 틀릴 수 있는 횟수
const MISS_ALL = 200; // 모든 기기를 합쳐 10분 동안 틀릴 수 있는 횟수 (마구 대입하는 공격 막기)

const LOGIN_KEEP = 600; // 로그인 시도 하나가 살아 있는 시간(초) = 10분
const CODE_KEEP = 300; // 구글 로그인이 끝난 뒤 앱이 열쇠를 가져갈 수 있는 시간(초) = 5분
const SESSION_KEEP = 180 * 86400; // 로그인 유지 기간 = 180일 (쓰면 늘어나요)
const VAULT_MAX = 1500000; // 계정 하나가 맡길 수 있는 기록 크기(바이트)
const WEB_OK = ['https://gkskco0522-sudo.github.io']; // 웹 버전 주소 (웹에서 로그인한 뒤 돌아갈 곳)
const APP_LINK = 'kkotgil://auth'; // 안드로이드 앱으로 돌아오는 주소
const G_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const G_TOKEN = 'https://oauth2.googleapis.com/token';
// (시험용) env.GOOGLE_AUTH_URL / env.GOOGLE_TOKEN_URL 을 넣으면 위 구글 주소 대신 그 주소를 써요. 평소에는 비워 두세요.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Expose-Headers': 'X-KG-Rev',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const reply = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
// 기록 본문을 그대로(글자 그대로) 돌려줄 때: 번호(rev)는 머리글에 담아요
const raw = (text, status, rev) =>
  new Response(status === 204 ? null : text, { status, headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8', 'X-KG-Rev': String(rev) } });

// 브라우저에 보여 주는 간단한 안내 화면
const PAGE_CSS =
  'body{font-family:system-ui,-apple-system,sans-serif;background:#FBFAFF;color:#1F2A5C;margin:0;display:grid;place-items:center;min-height:100vh}' +
  '.c{max-width:360px;margin:16px;padding:26px 22px;background:#fff;border:1px solid #E4E8FA;border-radius:20px;text-align:center}' +
  'h1{font-size:20px;margin:0 0 10px}p{font-size:15px;line-height:1.6;margin:8px 0}' +
  'a.b{display:block;margin-top:18px;padding:14px;border-radius:13px;background:#CFE0FF;color:#1F2A5C;font-weight:700;text-decoration:none}';
const page = (inner, status = 200) =>
  new Response(
    '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>너의 꽃길</title><style>' +
      PAGE_CSS + '</style></head><body><div class="c">' + inner + '</div></body></html>',
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      },
    },
  );
const MSG = {
  expired: '이 로그인 시도는 시간이 지났거나 이미 썼어요.<br>앱으로 돌아가 "Google로 로그인"을 다시 눌러 주세요.',
  denied: '로그인이 취소됐거나, 이 계정은 허용되지 않았어요.<br>(구글 설정이 "테스트" 상태라면, 등록해 둔 "테스트 사용자" 계정만 로그인할 수 있어요.)',
  fail: '구글 로그인을 확인하지 못했어요.<br>잠시 뒤 앱에서 다시 시도해 주세요.',
  conf: '서버에 구글 설정이 아직 안 돼 있어요.<br>안내서의 구글·Cloudflare 설정을 먼저 해 주세요.',
  who: '이 계정은 이 앱을 쓸 수 있는 목록에 없어요.',
};
function failPage(ret, key) {
  const back = ret ? ret + '?kgerr=' + key : APP_LINK + '?err=' + key;
  return page('<h1>로그인하지 못했어요</h1><p>' + (MSG[key] || MSG.fail) + '</p><a class="b" href="' + back + '">앱으로 돌아가기</a>', 400);
}

// 처음 한 번만 표(테이블)를 만들어요
let ready = false;
async function setup(db) {
  if (ready) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS shares (code TEXT PRIMARY KEY, data TEXT NOT NULL, exp INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS counts (key TEXT PRIMARY KEY, n INTEGER NOT NULL, exp INTEGER NOT NULL)'),
    // 계정(구글 번호 sub 가 열쇠예요. 이메일은 화면에 보여 주는 용도)
    db.prepare('CREATE TABLE IF NOT EXISTS users (sub TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, made INTEGER NOT NULL, seen INTEGER NOT NULL)'),
    // 로그인 시도 (st: 0 시작, 1 구글로 보냄, 2 구글 확인 끝(열쇠 발급), 3 열쇠 사용됨)
    db.prepare('CREATE TABLE IF NOT EXISTS logins (id TEXT PRIMARY KEY, ch TEXT NOT NULL, nonce TEXT NOT NULL, ret TEXT NOT NULL, st INTEGER NOT NULL, sub TEXT, code TEXT, exp INTEGER NOT NULL)'),
    // 로그인 유지표 (열쇠 그대로가 아니라 SHA-256 으로 바꾼 값만 저장해요)
    db.prepare('CREATE TABLE IF NOT EXISTS sessions (h TEXT PRIMARY KEY, sub TEXT NOT NULL, exp INTEGER NOT NULL)'),
    // 계정에 저장된 기록 (rev: 저장될 때마다 1씩 늘어나는 번호)
    db.prepare('CREATE TABLE IF NOT EXISTS vault (sub TEXT PRIMARY KEY, rev INTEGER NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL)'),
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
// 오래된 것 치우기
async function tidy(db, now) {
  await db.batch([
    db.prepare('DELETE FROM shares WHERE exp <= ?').bind(now),
    db.prepare('DELETE FROM counts WHERE exp <= ?').bind(now),
    db.prepare('DELETE FROM logins WHERE exp <= ?').bind(now),
    db.prepare('DELETE FROM sessions WHERE exp <= ?').bind(now),
  ]);
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

// ───── 로그인에 쓰는 도구들 ─────
const b64u = (buf) => {
  const a = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const rndId = (bytes) => {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return b64u(a);
};
const sha256 = async (s) => b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
function jwtBody(t) {
  try {
    const p = String(t).split('.')[1];
    const s = atob(p.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(p.length / 4) * 4, '='));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(s, (c) => c.charCodeAt(0))));
  } catch (e) {
    return null;
  }
}
const parseJson = (t) => {
  try {
    return JSON.parse(t);
  } catch (e) {
    return null;
  }
};
const gOk = (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
const webOk = (env) => WEB_OK.concat(String(env.WEB_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean));

// 로그인 유지표로 누구인지 알아내기 (Authorization: Bearer 열쇠)
async function authed(db, req, now) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.get('Authorization') || '');
  if (!m) return null;
  const h = await sha256(m[1]);
  const row = await db
    .prepare('SELECT s.sub AS sub, s.exp AS exp, u.email AS email, u.name AS name FROM sessions s JOIN users u ON u.sub = s.sub WHERE s.h = ? AND s.exp > ?')
    .bind(h, now)
    .first();
  if (!row) return null;
  if (row.exp - now < SESSION_KEEP - 30 * 86400) await db.prepare('UPDATE sessions SET exp = ? WHERE h = ?').bind(now + SESSION_KEEP, h).run(); // 30일에 한 번만 늘려요
  return { sub: row.sub, email: row.email, name: row.name, h };
}

// 구글 로그인 ① 앱/웹이 연 주소 → 구글 로그인 화면으로 보내기
async function authGo(env, db, url, now) {
  const id = url.searchParams.get('t') || '';
  const row = /^[A-Za-z0-9_-]{20,64}$/.test(id) ? await db.prepare('SELECT nonce, ret FROM logins WHERE id = ? AND st IN (0, 1) AND exp > ?').bind(id, now).first() : null;
  if (!row) return failPage('', 'expired');
  if (!gOk(env)) return failPage(row.ret, 'conf');
  await db.prepare('UPDATE logins SET st = 1 WHERE id = ? AND st = 0').bind(id).run();
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: url.origin + '/auth/callback',
    response_type: 'code',
    scope: 'openid email profile',
    state: id,
    nonce: row.nonce,
    prompt: 'select_account',
  });
  return new Response(null, { status: 302, headers: { Location: (env.GOOGLE_AUTH_URL || G_AUTH) + '?' + q, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

// 구글 로그인 ② 구글이 돌려보낸 곳 → 누구인지 확인하고, 앱/웹으로 열쇠를 들려 돌려보내기
async function authCallback(env, db, url, now) {
  const state = url.searchParams.get('state') || '';
  const tx = /^[A-Za-z0-9_-]{20,64}$/.test(state) ? await db.prepare('SELECT nonce, ret FROM logins WHERE id = ? AND st = 1 AND exp > ?').bind(state, now).first() : null;
  if (!tx) return failPage('', 'expired');
  const err = url.searchParams.get('error');
  const code = url.searchParams.get('code') || '';
  if (err || !code) return failPage(tx.ret, err === 'access_denied' ? 'denied' : 'fail');
  if (!gOk(env)) return failPage(tx.ret, 'conf');
  let c = null;
  try {
    const tr = await fetch(env.GOOGLE_TOKEN_URL || G_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: url.origin + '/auth/callback',
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (tr.ok) c = jwtBody((await tr.json()).id_token); // 구글 서버에서 직접 받은 신분증이라 서명 검사는 생략해도 돼요(구글 안내)
  } catch (e) {}
  const okIss = c && (c.iss === 'https://accounts.google.com' || c.iss === 'accounts.google.com');
  if (!okIss || c.aud !== env.GOOGLE_CLIENT_ID || !(c.exp > now) || c.nonce !== tx.nonce || typeof c.sub !== 'string' || !c.sub || c.sub.length > 64) {
    return failPage(tx.ret, 'fail');
  }
  const email = String(c.email || '').slice(0, 120);
  const allow = String(env.ALLOW_EMAILS || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (allow.length && !(c.email_verified && allow.indexOf(email.toLowerCase()) >= 0)) return failPage(tx.ret, 'who');
  const key = rndId(24);
  const upd = await db.prepare('UPDATE logins SET st = 2, sub = ?, code = ?, exp = ? WHERE id = ? AND st = 1').bind(c.sub, key, now + CODE_KEEP, state).run();
  if (!upd.meta.changes) return failPage(tx.ret, 'expired');
  await db
    .prepare('INSERT INTO users (sub, email, name, made, seen) VALUES (?, ?, ?, ?, ?) ON CONFLICT(sub) DO UPDATE SET email = excluded.email, name = excluded.name, seen = excluded.seen')
    .bind(c.sub, email, String(c.name || '').slice(0, 60), now, now)
    .run();
  if (tx.ret) {
    return new Response(null, { status: 302, headers: { Location: tx.ret + '?kgcode=' + key, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  }
  const link = APP_LINK + '?code=' + key;
  return page(
    '<h1>로그인이 끝났어요</h1><p>앱으로 돌아가는 중이에요.<br>자동으로 안 돌아가면 아래 버튼을 눌러 주세요.</p><a class="b" href="' + link + '">앱으로 돌아가기</a>' +
      '<script>setTimeout(function(){location.href="' + link + '"},400)</script>',
  );
}

async function status(env, url) {
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
  msg += '\n구글 로그인: ' + (gOk(env) ? '켜져 있어요 ✅' : '아직 켜지 않았어요 ⚠️ (Variables and Secrets 에 GOOGLE_CLIENT_ID 와 GOOGLE_CLIENT_SECRET 를 추가하세요)');
  msg += '\n구글 콘솔의 "승인된 리디렉션 URI" 에 넣을 주소:\n' + url.origin + '/auth/callback';
  return new Response(msg, { headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // 주소창에서 열어 보면 설정이 잘 됐는지 알려줘요
    if (req.method === 'GET' && path === '/') return status(env, url);

    const now = Math.floor(Date.now() / 1000);
    const ip = who(req.headers.get('CF-Connecting-IP'));
    const isPage = req.method === 'GET' && (path === '/auth/go' || path === '/auth/callback');
    try {
      const db = env.DB;
      await setup(db);

      // 브라우저가 직접 여는 로그인 주소 두 개
      if (isPage) return path === '/auth/go' ? await authGo(env, db, url, now) : await authCallback(env, db, url, now);

      // ───── 계정 ─────
      if (req.method === 'POST' && path === '/auth/begin') {
        // 앱/웹이 "로그인 시작할게요" 하고 알리는 곳 (열쇠의 해시만 받아 둬요)
        if (!gOk(env)) return reply({ err: 'nogoogle' }, 503);
        if ((await bump(db, 'begin:' + ip, 3600, now)) > 30) return reply({ err: 'rate' }, 429);
        const body = await req.text();
        const j = body.length < 2000 ? parseJson(body) : null;
        if (!j || !/^[A-Za-z0-9_-]{43}$/.test(String(j.ch || ''))) return reply({ err: 'bad' }, 400);
        let ret = '';
        if (j.web) {
          try {
            const u = new URL(String(j.web));
            if (webOk(env).indexOf(u.origin) < 0) throw 0;
            ret = u.origin + u.pathname;
          } catch (e) {
            return reply({ err: 'web' }, 400);
          }
        }
        if (Math.random() < 0.05) await tidy(db, now);
        const id = rndId(24);
        await db.prepare('INSERT INTO logins (id, ch, nonce, ret, st, sub, code, exp) VALUES (?, ?, ?, ?, 0, NULL, NULL, ?)').bind(id, j.ch, rndId(16), ret, now + LOGIN_KEEP).run();
        return reply({ go: url.origin + '/auth/go?t=' + id });
      }
      if (req.method === 'POST' && path === '/auth/exchange') {
        // 구글 확인이 끝난 뒤, 앱이 받은 열쇠 + 처음에 만든 비밀값(verifier)으로 로그인 열쇠를 받아가는 곳
        if ((await bump(db, 'xchg:' + ip, 600, now)) > 30) return reply({ err: 'rate' }, 429);
        const body = await req.text();
        const j = body.length < 2000 ? parseJson(body) : null;
        const code = j ? String(j.code || '') : '';
        const v = j ? String(j.v || '') : '';
        if (!/^[A-Za-z0-9_-]{20,64}$/.test(code) || !/^[A-Za-z0-9_-]{32,128}$/.test(v)) return reply({ err: 'bad' }, 400);
        const row = await db.prepare('SELECT id, ch, sub FROM logins WHERE code = ? AND st = 2 AND exp > ?').bind(code, now).first();
        if (!row || (await sha256(v)) !== row.ch) return reply({ err: 'none' }, 404);
        const used = await db.prepare('UPDATE logins SET st = 3 WHERE id = ? AND st = 2').bind(row.id).run();
        if (!used.meta.changes) return reply({ err: 'none' }, 404);
        const u = await db.prepare('SELECT email, name FROM users WHERE sub = ?').bind(row.sub).first();
        const token = rndId(32);
        await db.prepare('INSERT INTO sessions (h, sub, exp) VALUES (?, ?, ?)').bind(await sha256(token), row.sub, now + SESSION_KEEP).run();
        return reply({ token, sub: row.sub, email: u ? u.email : '', name: u ? u.name : '' });
      }
      if (path === '/auth/logout' || path === '/me' || path === '/sync' || path === '/account/delete') {
        const me = await authed(db, req, now);
        if (!me) return reply({ err: 'auth' }, 401);

        if (req.method === 'POST' && path === '/auth/logout') {
          await db.prepare('DELETE FROM sessions WHERE h = ?').bind(me.h).run();
          return reply({ ok: true });
        }
        if (req.method === 'GET' && path === '/me') return reply({ sub: me.sub, email: me.email, name: me.name });

        // 계정과 서버에 저장된 기록을 모두 지워요 (이 폰의 기록은 그대로예요)
        if (req.method === 'POST' && path === '/account/delete') {
          await db.batch([
            db.prepare('DELETE FROM vault WHERE sub = ?').bind(me.sub),
            db.prepare('DELETE FROM sessions WHERE sub = ?').bind(me.sub),
            db.prepare('DELETE FROM logins WHERE sub = ?').bind(me.sub),
            db.prepare('DELETE FROM users WHERE sub = ?').bind(me.sub),
          ]);
          return reply({ ok: true });
        }

        // ───── 기록 맞추기 ─────
        if (req.method === 'GET' && path === '/sync') {
          if ((await bump(db, 'rd:' + me.sub, 3600, now)) > 600) return reply({ err: 'rate' }, 429);
          const row = await db.prepare('SELECT rev, body FROM vault WHERE sub = ?').bind(me.sub).first();
          if (url.searchParams.get('peek')) return reply({ rev: row ? row.rev : 0 }); // 번호만 살짝 확인
          return row ? raw(row.body, 200, row.rev) : raw('', 204, 0);
        }
        if (req.method === 'PUT' && path === '/sync') {
          // ?base=내가 마지막으로 본 번호 → 그 번호 그대로일 때만 저장해요 (다른 기기가 먼저 저장했으면 충돌 알림)
          const base = parseInt(url.searchParams.get('base') || '', 10);
          if (!(base >= 0)) return reply({ err: 'bad' }, 400);
          const len = parseInt(req.headers.get('Content-Length') || '0', 10);
          if (len > VAULT_MAX) return reply({ err: 'big' }, 413);
          const body = await req.text();
          if (!len && new TextEncoder().encode(body).length > VAULT_MAX) return reply({ err: 'big' }, 413);
          if (body.length > VAULT_MAX) return reply({ err: 'big' }, 413);
          if (body.charCodeAt(0) !== 123) return reply({ err: 'bad' }, 400);
          if ((await bump(db, 'put:' + me.sub, 3600, now)) > 240) return reply({ err: 'rate' }, 429);
          if (Math.random() < 0.05) await tidy(db, now);
          let rev = 0;
          if (base === 0) {
            const r = await db.prepare('INSERT INTO vault (sub, rev, body, at) VALUES (?, 1, ?, ?) ON CONFLICT(sub) DO NOTHING').bind(me.sub, body, now).run();
            if (r.meta.changes > 0) rev = 1;
          } else {
            const r = await db.prepare('UPDATE vault SET rev = rev + 1, body = ?, at = ? WHERE sub = ? AND rev = ? RETURNING rev').bind(body, now, me.sub, base).first();
            if (r) rev = r.rev;
          }
          if (rev) return reply({ rev });
          const cur = await db.prepare('SELECT rev, body FROM vault WHERE sub = ?').bind(me.sub).first();
          return raw(cur ? cur.body : '', 409, cur ? cur.rev : 0);
        }
        return reply({ err: 'path' }, 404);
      }

      // ───── 숫자 공유 코드 ─────
      if (req.method !== 'POST' || (path !== '/new' && path !== '/get')) return reply({ err: 'path' }, 404);
      const body = (await req.text()).trim();

      // /new : 코드 만들기
      if (path === '/new') {
        if (!/^KG\d:/.test(body)) return reply({ err: 'bad' }, 400);
        if (body.length > MAXLEN) return reply({ err: 'big' }, 413);
        if ((await bump(db, 'make:' + ip, 3600, now)) > MAKE_MAX) return reply({ err: 'rate' }, 429);
        await tidy(db, now);
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
      return isPage ? failPage('', 'fail') : reply({ err: 'server' }, 500);
    }
  },
};
