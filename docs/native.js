/* 안드로이드 앱에서만 동작해요. 약 시간과 접종 예정일을 휴대폰 알림으로 예약하고, 고른 알람 소리로 울려요. 웹에서는 아무 일도 하지 않아요. */
(function () {
  var C = window.Capacitor;
  if (!C || !C.isNativePlatform || !C.isNativePlatform()) return;
  var AP = C.Plugins && C.Plugins.App;
  if (AP && AP.addListener) AP.addListener('backButton', function () { if (window.appBack) window.appBack(); });
  var LN = C.Plugins && C.Plugins.LocalNotifications;
  if (!LN) return;

  var SOUNDS = { snd_bell: '맑은 종소리', snd_musicbox: '오르골', snd_chime: '부드러운 차임', snd_drop: '물방울', snd_marimba: '마림바', snd_bird: '아침 새소리', snd_piano: '피아노', snd_harp: '하프', snd_xylo: '실로폰', snd_pop: '뿅뿅' };
  var ready = {}, chanP = null;

  function load(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function two(n) { return (n < 10 ? '0' : '') + n; }
  function say(t) { if (window.toast) window.toast(t); }

  /* 안드로이드 8 이상은 소리가 "채널"에 묶여 있어서, 소리마다 채널을 하나씩 만들어 둬요 */
  function channels() {
    if (chanP) return chanP;
    chanP = Promise.all(Object.keys(SOUNDS).map(function (id) {
      return LN.createChannel({ id: id, name: '알람 소리: ' + SOUNDS[id], description: '약·접종 알림', sound: id + '.wav', importance: 4, visibility: 1, vibration: true })
        .then(function () { ready[id] = true; }, function () {});
    }));
    return chanP;
  }
  function pickSound() { var s = load('imbonote_sound'); return (typeof s === 'string' && SOUNDS[s]) ? s : 'snd_bell'; }

  function build() {
    var dogs = load('imbonote_dogs') || [], meds = load('imbonote_meds') || [], vacc = load('imbonote_vacc') || [];
    var who = {}; dogs.forEach(function (d) { who[d.id] = d.name || '아이'; });
    var ch = ready[pickSound()] ? pickSound() : null;
    var out = [], id = 1, now = new Date();
    function add(title, body, schedule) { var n = { id: id++, title: title, body: body, schedule: schedule }; if (ch) n.channelId = ch; out.push(n); }

    meds.forEach(function (m) {
      var hm = String(m.h || '').split(':'), h = parseInt(hm[0], 10), mi = parseInt(hm[1], 10);
      if (isNaN(h) || isNaN(mi)) return;
      var body = (who[m.dog] || '아이') + ' · ' + m.n + (m.d ? ' (' + m.d + ')' : '') + ' 먹일 시간이에요';
      var rp = m.rp || 'd';
      if (rp === 'd') add('약 시간', body, { on: { hour: h, minute: mi }, allowWhileIdle: true });
      else if (rp === 'w') (m.wd || []).forEach(function (w) { add('약 시간', body, { on: { weekday: w + 1, hour: h, minute: mi }, allowWhileIdle: true }); });
      else if (rp === 'm') add('약 시간', body, { on: { day: m.md || 1, hour: h, minute: mi }, allowWhileIdle: true });
      else if (rp === 'o' && m.od) { var at = new Date(m.od + 'T' + two(h) + ':' + two(mi) + ':00'); if (at > now) add('약 시간', body, { at: at, allowWhileIdle: true }); }
    });

    vacc.forEach(function (v) {
      if (!v.n) return;
      var name = (who[v.dog] || '아이') + ' · ' + v.t + (v.x ? ' (' + v.x + ')' : '');
      var day = new Date(v.n + 'T09:00:00');
      if (day > now) add('접종 알림', name + ' 접종 예정일이에요', { at: day, allowWhileIdle: true });
      var eve = new Date(day.getTime() - 864e5);
      if (eve > now) add('접종 알림', name + ' 접종이 내일이에요', { at: eve, allowWhileIdle: true });
    });
    return out;
  }

  var busy = false, again = false;
  function sync(notify) {
    if (busy) { again = true; return Promise.resolve(); }
    busy = true;
    return channels().then(function () { return LN.checkPermissions(); }).then(function (p) {
      return p.display === 'granted' ? p : LN.requestPermissions();
    }).then(function (p) {
      if (p.display !== 'granted') { if (notify) say('알림 권한이 꺼져 있어요. 휴대폰 설정에서 알림을 허용해 주세요'); return; }
      return LN.getPending().then(function (pend) {
        var ids = (pend.notifications || []).filter(function (n) { return n.id !== TESTID; }).map(function (n) { return { id: n.id }; });
        return ids.length ? LN.cancel({ notifications: ids }) : null;
      }).then(function () {
        var list = build();
        return (list.length ? LN.schedule({ notifications: list }) : null).then(function () { if (notify) say('알림 ' + list.length + '개를 예약했어요'); });
      });
    }).catch(function () { if (notify) say('알림 예약 중 문제가 생겼어요'); })
      .then(function () { busy = false; if (again) { again = false; sync(false); } });
  }

  var tm = null;
  function soon(notify) { clearTimeout(tm); tm = setTimeout(function () { sync(notify); }, 900); }

  var oldSv = window.sv;
  if (typeof oldSv === 'function') {
    window.sv = function (k) {
      var r = oldSv.apply(this, arguments);
      if (/^imbonote_(meds|vacc|sound)$/.test(k)) soon(true); else if (k === 'imbonote_dogs') soon(false);
      return r;
    };
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) soon(false); });
  soon(false);
  /* ── 알림 점검: 설정의 '알림 점검' 카드가 불러다 써요 ── */
  var TESTID = 2147480000; /* 약·접종 알림 번호(1, 2, 3…)와 겹치지 않는 큰 번호 */
  function permState() { return LN.checkPermissions().then(function (p) { return p.display; }, function () { return 'prompt'; }); }
  function info() {
    var sel = pickSound();
    return channels().then(function () {
      return Promise.all([
        permState(),
        LN.areEnabled ? LN.areEnabled().then(function (r) { return r.value !== false; }, function () { return true; }) : Promise.resolve(true),
        LN.checkExactNotificationSetting ? LN.checkExactNotificationSetting().then(function (r) { return r.exact_alarm; }, function () { return 'granted'; }) : Promise.resolve('granted'),
        LN.getPending().then(function (r) { return (r.notifications || []).filter(function (n) { return n.id !== TESTID; }).length; }, function () { return -1; }),
        LN.listChannels ? LN.listChannels().then(function (r) { var c = (r.channels || []).filter(function (x) { return x.id === sel; })[0]; return c && typeof c.importance === 'number' ? c.importance : null; }, function () { return null; }) : Promise.resolve(null)
      ]);
    }).then(function (a) {
      var expected = 0; try { expected = build().length; } catch (e) {}
      return { perm: a[0], enabled: a[1], exact: a[2], pending: a[3], expected: expected, soundId: sel, soundName: SOUNDS[sel], importance: a[4] };
    });
  }
  function test() {
    return channels().then(permState).then(function (d) {
      return d === 'granted' ? d : LN.requestPermissions().then(function (p) { return p.display; });
    }).then(function (d) {
      if (d !== 'granted') return { ok: false, why: 'perm' };
      var sel = pickSound(), n = { id: TESTID, title: '테스트 알림', body: '알림이 잘 울려요 🔔 약·접종 알림도 이렇게 울려요', schedule: { at: new Date(Date.now() + 10000), allowWhileIdle: true } };
      if (ready[sel]) n.channelId = sel;
      return LN.cancel({ notifications: [{ id: TESTID }] }).then(null, function () {}).then(function () { return LN.schedule({ notifications: [n] }); }).then(function () { return { ok: true }; });
    }).then(null, function () { return { ok: false, why: 'error' }; });
  }
  function ask() { return LN.requestPermissions().then(function (p) { return p.display; }, function () { return 'denied'; }); }
  function exact() { return LN.changeExactNotificationSetting ? LN.changeExactNotificationSetting().then(function (r) { return r.exact_alarm; }, function () { return 'denied'; }) : Promise.resolve('granted'); }
  window.__kkotgilNotif = { info: info, test: test, ask: ask, exact: exact, resched: function () { return sync(true); } };
  window.__kkotgilBuild = build;
  /* 계정에서 새 기록을 받아왔을 때, 알림 예약을 조용히(안내 문구 없이) 다시 맞춰요 */
  window.__kkotgilResched = function () { soon(false); };
})();
