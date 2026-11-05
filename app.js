(() => {
  'use strict';

  /* ================= 設定 ================= */
  const N = 5;
  const MAX_SEC = 60;
  const BARS = 48;
  const LOWCUT_HZ = 120;
  const DB_NAME = 'picnicking-recorder';
  const STORE = 'takes';
  const K = { pitch: 'picnicking-pitch', fx: 'picnicking-fx', uid: 'picnicking-uid', name: 'picnicking-name', del: 'picnicking-del' };

  // 東京藝術大学 取手校地（国土地理院の住所検索 小文間5000 を中心にした範囲）
  const CAMPUS = { lat: 35.8828, lng: 140.1147, dLat: 0.0030, dLng: 0.0037 };
  const CAMPUS_BOUNDS = [[CAMPUS.lat - CAMPUS.dLat, CAMPUS.lng - CAMPUS.dLng], [CAMPUS.lat + CAMPUS.dLat, CAMPUS.lng + CAMPUS.dLng]];
  const TILE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

  const FIREBASE = {
    apiKey: 'AIzaSyA7jnOk0o5V4652vWQGflSzDyA_QELDxYg',
    authDomain: 'toride-picnic.firebaseapp.com',
    projectId: 'toride-picnic',
    storageBucket: 'toride-picnic.firebasestorage.app',
    messagingSenderId: '133398915165',
    appId: '1:133398915165:web:1484b1d86fd27074e785b4',
  };
  const FB_JS = [
    'https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore-compat.js',
  ];

  /* ================= 要素 ================= */
  const $ = (id) => document.getElementById(id);
  const orbs = [...document.querySelectorAll('.orb')];
  const mains = orbs.map((o) => o.querySelector('.main'));
  const redos = orbs.map((o) => o.querySelector('.redo'));
  const lowcuts = orbs.map((o) => o.querySelector('.lowcut'));
  const msg = $('msg'), head = $('head'), space = $('space'), pitch = $('pitch');
  const pager = $('pager'), feedEl = $('feed'), emptyEl = $('empty'), netEl = $('net');
  const whoBtn = $('who'), gate = $('gate'), gateForm = $('gateForm'), nameIn = $('nameIn'), gateCancel = $('gateCancel');

  const say = (t, ok) => { msg.textContent = t || ''; msg.classList.toggle('ok', !!ok); };
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* なし */ } },
  };

  /* ================= 自分 ================= */
  let uid = ls.get(K.uid);
  if (!uid) { uid = Math.random().toString(36).slice(2, 10).padEnd(8, '0'); ls.set(K.uid, uid); }
  let myName = (ls.get(K.name) || '').trim();
  const idOf = (slot) => `${uid}_${slot}`;

  /* ================= 端末内の保存（IndexedDB） ================= */
  const takes = new Array(N).fill(null);   // { buf, type, dur, at, lat, lng, acc, peaks, synced }
  let dbp = null;
  const openDB = () => new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const db = () => dbp || (dbp = openDB());
  const tx = async (mode, fn) => {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(STORE, mode);
      const q = fn(t.objectStore(STORE));
      t.oncomplete = () => res(q && q.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  };
  const dbGet = (i) => tx('readonly', (s) => s.get(i));
  const dbPut = (i, v) => tx('readwrite', (s) => s.put(v, i));
  const dbDel = (i) => tx('readwrite', (s) => s.delete(i));
  const dbClear = () => tx('readwrite', (s) => s.clear());

  /* ================= 共有（Firestore） ================= */
  // clips  : 軽い情報（名前、地点、長さ、波形）。一覧はこれだけを購読する
  // audio  : 音そのもの。再生するときに1件だけ取りに行く
  const loadScript = (src) => new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('load ' + src));
    document.head.appendChild(s);
  });

  function firebaseCloud() {
    let fdb = null;
    return {
      async start(onClips, onState, onComments) {
        onState('connecting');
        for (const src of FB_JS) await Promise.race([loadScript(src), sleep(12000).then(() => { throw new Error('timeout'); })]);
        if (!firebase.apps.length) firebase.initializeApp(FIREBASE);
        fdb = firebase.firestore();
        try { fdb.settings({ experimentalAutoDetectLongPolling: true, merge: true }); } catch (e) { /* なし */ }
        fdb.collection('clips').onSnapshot(
          (snap) => {
            const m = new Map();
            snap.forEach((d) => m.set(d.id, d.data()));
            onClips(m);
            onState('on');
          },
          (err) => onState('err', err)
        );
        const watch = (name, cb) => fdb.collection(name).onSnapshot((snap) => {
          const m = new Map();
          snap.forEach((d) => m.set(d.id, d.data()));
          cb(m);
        }, () => {});
        watch('comments', onComments);
      },
      async setDoc(col, id, obj) { await fdb.collection(col).doc(id).set(obj); },
      async delDoc(col, id) { await fdb.collection(col).doc(id).delete(); },
      async post(meta, bytes, type) {
        const b = fdb.batch();
        b.set(fdb.collection('audio').doc(meta.id), {
          data: firebase.firestore.Blob.fromUint8Array(new Uint8Array(bytes)), type: type || '',
        });
        b.set(fdb.collection('clips').doc(meta.id), meta);
        await b.commit();
      },
      async audio(id) {
        const d = await fdb.collection('audio').doc(id).get();
        if (!d.exists) return null;
        const x = d.data();
        const u = x.data.toUint8Array();
        return { buf: u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength), type: x.type };
      },
      async remove(ids) {
        const b = fdb.batch();
        ids.forEach((id) => { b.delete(fdb.collection('clips').doc(id)); b.delete(fdb.collection('audio').doc(id)); });
        await b.commit();
      },
      async patch(id, fields) {
        await fdb.collection('clips').doc(id).update(fields);
      },
      async rename(ids, name) {
        const b = fdb.batch();
        ids.forEach((id) => b.update(fdb.collection('clips').doc(id), { name }));
        await b.commit();
      },
    };
  }

  const cloud = window.__mockCloud || firebaseCloud();
  let cloudState = 'idle';         // idle | connecting | on | err
  let remote = new Map();          // 共有されている全クリップ（id → 情報）
  let comments = new Map();        // コメントid → { postUid, by, name, text, at }
  const audioCache = new Map();    // id:at → { buf, type }

  function onCloudState(s) {
    cloudState = s;
    renderNet();
    if (s === 'on') { flushDeletes(); syncAll(); }
  }
  function onCloudClips(m) { remote = m; renderFeed(); }
  function onCloudComments(m) { comments = m; renderAllReact(); }

  async function connect() {
    try { await cloud.start(onCloudClips, onCloudState, onCloudComments); }
    catch (e) { onCloudState('err'); }
  }

  const sharing = new Set();
  async function share(i) {
    const t = takes[i];
    if (!t || t.synced || cloudState !== 'on' || !myName || sharing.has(i)) return;
    if (t.buf.byteLength > 950000) { say('長すぎて共有できませんでした。この端末には残っています'); return; }
    sharing.add(i);
    try {
      await cloud.post(metaOf(i), t.buf, t.type);
      if (takes[i] === t) { t.synced = true; try { await dbPut(i, t); } catch (e) { /* なし */ } }
      say('共有しました', true);
    } catch (e) {
      say('共有できませんでした。この端末には残っています');
    } finally { sharing.delete(i); }
  }
  const syncAll = () => { for (let i = 0; i < N; i++) share(i); };

  const delQueue = () => { try { return JSON.parse(ls.get(K.del) || '[]'); } catch (e) { return []; } };
  async function removeRemote(ids) {
    const q = [...new Set([...delQueue(), ...ids])];
    ls.set(K.del, JSON.stringify(q));
    if (cloudState === 'on') await flushDeletes();
  }
  async function flushDeletes() {
    const q = delQueue();
    if (!q.length) return;
    try { await cloud.remove(q); ls.set(K.del, '[]'); } catch (e) { /* 次の接続で再試行 */ }
  }

  function metaOf(i) {
    const t = takes[i];
    return {
      id: idOf(i), uid, name: myName, slot: i, at: t.at, dur: Math.round(t.dur * 10) / 10, type: t.type || '',
      lat: t.lat == null ? null : t.lat, lng: t.lng == null ? null : t.lng, acc: t.acc == null ? null : t.acc,
      peaks: t.peaks || [], lowcut: !!t.lowcut,
    };
  }

  // 一覧に出すクリップ。自分の分は端末内の録音を使う（すぐ出る）
  let view = new Map();
  function buildView() {
    const v = new Map();
    remote.forEach((m, id) => { if (m.uid !== uid) v.set(id, m); });
    for (let i = 0; i < N; i++) if (takes[i] && myName) v.set(idOf(i), metaOf(i));
    view = v;
    return v;
  }

  /* ================= 音の経路と残響 ================= */
  let ctx = null, chain = null, outEl = null;

  function makeIR() {
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * 2.4);
    const b = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let k = 0; k < len; k++) d[k] = (Math.random() * 2 - 1) * Math.pow(1 - k / len, 3);
    }
    return b;
  }

  function buildChain() {
    const input = ctx.createGain();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    const conv = ctx.createConvolver(); conv.buffer = makeIR();
    const master = ctx.createGain();
    const an = ctx.createAnalyser(); an.fftSize = 256;
    input.connect(dry); input.connect(conv);
    conv.connect(wet);
    dry.connect(master); wet.connect(master);
    master.connect(an);
    chain = { input, dry, wet, master, an, td: new Uint8Array(an.fftSize) };

    // iPhoneは、消音スイッチがオンだとWebオーディオが無音になる。<audio>要素を経由させると鳴る。
    let routed = false;
    try {
      if (ctx.createMediaStreamDestination) {
        const dest = ctx.createMediaStreamDestination();
        outEl = new Audio();
        outEl.srcObject = dest.stream;
        outEl.playsInline = true;
        an.connect(dest);
        routed = true;
        outEl.play().catch(() => {
          try { an.disconnect(dest); } catch (e) { /* なし */ }
          an.connect(ctx.destination);
          outEl = null;
        });
      }
    } catch (e) { routed = false; }
    if (!routed) an.connect(ctx.destination);
    applyFx();
  }

  function setSession(type) {
    try { if (navigator.audioSession) navigator.audioSession.type = type; } catch (e) { /* 非対応 */ }
  }

  function ensureCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      buildChain();
    }
    if (ctx.state !== 'running') { try { ctx.resume(); } catch (e) { /* なし */ } }
    if (outEl && outEl.paused) outEl.play().catch(() => {});
    return ctx;
  }

  function applyFx() {
    if (!chain) return;
    const s = Number(space.value) / 100;
    const now = ctx.currentTime;
    chain.dry.gain.setTargetAtTime(1 - 0.5 * s, now, 0.03);
    chain.wet.gain.setTargetAtTime(1.4 * s, now, 0.03);
    // 音程：半音単位。速さも一緒に変わる
    const rate = rateNow();
    playing.forEach((p) => {
      if (p.kind === 'buf') { tickPos(p); p.src.playbackRate.setTargetAtTime(rate, now, 0.02); }
      else { p.el.preservesPitch = false; p.el.playbackRate = rate; }
    });
  }
  const rateNow = () => Math.pow(2, Number(pitch.value) / 12);
  const tickPos = (p) => { const t = ctx.currentTime; p.pos += (t - p.last) * p.rate; p.last = t; p.rate = rateNow(); };
  space.addEventListener('input', () => { applyFx(); ls.set(K.fx, space.value); });
  pitch.addEventListener('input', () => { applyFx(); ls.set(K.pitch, pitch.value); });
  pitch.addEventListener('dblclick', () => { pitch.value = 0; applyFx(); ls.set(K.pitch, '0'); });

  /* ================= 再生（円も一覧も同じ仕組み） ================= */
  const playing = new Map();    // id → 再生の状態
  const loading = new Set();
  const buffers = new Map();    // id:at → AudioBuffer

  const elsOf = (id) => document.querySelectorAll(`[data-pk="${id}"]`);
  function paintKey(id) {
    const on = playing.has(id) || loading.has(id);
    elsOf(id).forEach((e) => {
      e.classList.toggle('is-play', on);
      if (!playing.has(id)) {
        e.style.setProperty('--p', '0');
        if (e.classList.contains('orb')) e.style.setProperty('--lv', '0');
      }
    });
    if (!playing.has(id)) {
      const m = view.get(id);
      elsOf(id).forEach((e) => {
        const t = e.classList.contains('orb') ? e.querySelector('.t') : e.querySelector('.tm');
        if (t && m) t.textContent = fmt(m.dur);
      });
    }
  }

  async function sourceOf(id, m) {
    if (id.startsWith(uid + '_')) {
      const t = takes[Number(id.slice(uid.length + 1))];
      return t ? { buf: t.buf, type: t.type } : null;
    }
    const ck = `${id}:${m.at}`;
    if (audioCache.has(ck)) return audioCache.get(ck);
    const a = await cloud.audio(id);
    if (a) audioCache.set(ck, a);
    return a;
  }

  async function decode(id, m, src) {
    const ck = `${id}:${m.at}`;
    if (buffers.has(ck)) return buffers.get(ck);
    const b = await new Promise((res, rej) => {
      const p = ctx.decodeAudioData(src.buf.slice(0), res, rej);
      if (p && p.catch) p.catch(rej);
    });
    buffers.set(ck, b);
    return b;
  }

  function playPlain(id, src, dur) {
    const url = URL.createObjectURL(new Blob([src.buf], { type: src.type || 'audio/mp4' }));
    const el = new Audio(url);
    el.playsInline = true;
    el.preservesPitch = false;
    el.playbackRate = rateNow();
    const p = { kind: 'el', el, url, dur };
    const done = () => {
      if (playing.get(id) !== p) return;
      playing.delete(id);
      URL.revokeObjectURL(url);
      paintKey(id);
    };
    el.onended = done;
    el.onerror = () => { say('この音を再生できませんでした'); done(); };
    playing.set(id, p);
    paintKey(id);
    startMeter();
    el.play().catch(() => { say('この音を再生できませんでした'); done(); });
  }

  async function play(id) {
    const m = view.get(id);
    if (!m || playing.has(id) || loading.has(id)) return;
    setSession('playback');
    ensureCtx();
    loading.add(id);
    paintKey(id);
    let src = null;
    try {
      src = await sourceOf(id, m);
      if (ctx.state !== 'running') { try { await ctx.resume(); } catch (e) { /* なし */ } }
    } catch (e) { src = null; }
    if (!loading.has(id)) return;           // 読み込み中に止められた
    loading.delete(id);
    if (!src) { say('この音を読み込めませんでした'); paintKey(id); return; }
    let buf = null;
    try { buf = await decode(id, m, src); } catch (e) { buf = null; }
    if (!buf) { playPlain(id, src, m.dur); return; }
    const node = ctx.createBufferSource();
    node.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.Q.value = 0.7;
    hp.frequency.value = m.lowcut ? LOWCUT_HZ : 10;
    node.connect(hp); hp.connect(chain.input);
    const r0 = rateNow();
    node.playbackRate.value = r0;
    const p = { kind: 'buf', src: node, hp, pos: 0, last: ctx.currentTime, rate: r0, dur: buf.duration };
    node.onended = () => { if (playing.get(id) === p) { playing.delete(id); paintKey(id); } };
    playing.set(id, p);
    node.start();
    paintKey(id);
    startMeter();
  }

  function stop(id) {
    loading.delete(id);
    const p = playing.get(id);
    if (p) {
      playing.delete(id);
      if (p.kind === 'buf') { try { p.src.stop(); } catch (e) { /* 終了済み */ } }
      else { p.el.pause(); URL.revokeObjectURL(p.url); }
    }
    paintKey(id);
  }
  const stopAll = () => { [...playing.keys(), ...loading].forEach(stop); };
  const toggle = (id) => { if (playing.has(id) || loading.has(id)) stop(id); else play(id); };

  let raf = 0;
  function meter() {
    raf = 0;
    let lv = 0;
    if (chain) {
      chain.an.getByteTimeDomainData(chain.td);
      let sum = 0;
      for (const v of chain.td) { const x = (v - 128) / 128; sum += x * x; }
      lv = Math.min(1, Math.sqrt(sum / chain.td.length) * 3);
    }
    playing.forEach((p, id) => {
      if (p.kind === 'buf') tickPos(p);
      const el = p.kind === 'buf' ? p.pos : p.el.currentTime;
      const dur = p.kind === 'buf' ? p.dur : (p.el.duration && isFinite(p.el.duration) ? p.el.duration : p.dur);
      const frac = Math.max(0, Math.min(1, el / dur));
      const left = `再生 ${fmt(Math.max(0, dur - el))}`;
      elsOf(id).forEach((e) => {
        e.style.setProperty('--p', frac.toFixed(3));
        if (e.classList.contains('orb')) {
          e.style.setProperty('--lv', lv.toFixed(3));
          e.querySelector('.t').textContent = left;
        } else {
          const t = e.querySelector('.tm');
          if (t) t.textContent = fmt(Math.max(0, dur - el));
        }
      });
    });
    if (playing.size) raf = requestAnimationFrame(meter);
  }
  const startMeter = () => { if (!raf) raf = requestAnimationFrame(meter); };

  /* ================= 録音 ================= */
  let rec = null;
  let busy = false;

  function pickType() {
    if (!window.MediaRecorder) return null;
    for (const t of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  }

  function locate() {
    return new Promise((res) => {
      if (!navigator.geolocation) { res(null); return; }
      navigator.geolocation.getCurrentPosition(
        (p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy) }),
        () => res(null),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 4000 }
      );
    });
  }

  function tick() {
    if (!rec) return;
    const sec = (performance.now() - rec.t0) / 1000;
    orbs[rec.i].querySelector('.t').textContent = fmt(sec);
    if (sec >= MAX_SEC) stopRec();
  }

  async function startRec(i) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      say('このブラウザは録音に対応していません');
      return;
    }
    ensureCtx();
    stopAll();
    if (outEl) outEl.pause();
    setSession('play-and-record');
    const loc = locate();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
    } catch (e) {
      setSession('playback');
      say(`マイクを使えません（${(e && e.name) || 'エラー'}）。ブラウザの許可を確認してください`);
      return;
    }
    const type = pickType();
    let mr;
    try {
      try { mr = type ? new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: 48000 }) : new MediaRecorder(stream, { audioBitsPerSecond: 48000 }); }
      catch (e) { mr = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream); }
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      say('録音を始められませんでした');
      return;
    }
    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = () => finishRec(i, chunks, mr.mimeType || type || 'audio/mp4');
    rec = { i, mr, stream, loc, t0: performance.now(), timer: setInterval(tick, 200), stopping: false };
    mr.start();
    paint(i);
    tick();
  }

  function stopRec() {
    if (!rec || rec.stopping) return;
    rec.stopping = true;
    try { rec.mr.stop(); } catch (e) { finishRec(rec.i, [], ''); }
  }

  // 波形用に、音を48個の高さにまとめる
  async function calcPeaks(ab) {
    try {
      const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const o = new OAC(1, 1, 44100);
      const buf = await new Promise((res, rej) => {
        const p = o.decodeAudioData(ab.slice(0), res, rej);
        if (p && p.catch) p.catch(rej);
      });
      const d = buf.getChannelData(0);
      const n = Math.max(1, Math.floor(d.length / BARS));
      const raw = [];
      for (let b = 0; b < BARS; b++) {
        let mx = 0;
        const end = Math.min(d.length, (b + 1) * n);
        for (let k = b * n; k < end; k++) { const v = Math.abs(d[k]); if (v > mx) mx = v; }
        raw.push(mx);
      }
      const top = Math.max(...raw, 1e-6);
      return raw.map((v) => Math.max(5, Math.round(100 * Math.pow(v / top, 0.6))));
    } catch (e) { return null; }
  }

  async function finishRec(i, chunks, type) {
    const r = rec;
    rec = null;
    if (r) {
      clearInterval(r.timer);
      r.stream.getTracks().forEach((t) => t.stop());
    }
    const dur = r ? (performance.now() - r.t0) / 1000 : 0;
    const blob = new Blob(chunks, { type });
    if (blob.size < 200) {
      say('音が録れませんでした。もう一度押してください');
      paint(i);
      return;
    }
    const buf = await blob.arrayBuffer();
    const loc = r ? await Promise.race([r.loc, sleep(3000).then(() => null)]) : null;
    const peaks = await calcPeaks(buf);
    const row = {
      buf, type, dur, at: Date.now(), peaks,
      lat: loc ? loc.lat : null, lng: loc ? loc.lng : null, acc: loc ? loc.acc : null, synced: false, lowcut: false,
    };
    takes[i] = row;
    paint(i);
    renderFeed();
    setSession('playback');
    ensureCtx();
    try { await dbPut(i, row); } catch (e) { say('保存できませんでした。リロードすると消えます'); }
    if (!loc) say('場所を取得できませんでした。地図には出ません');
    share(i);
  }

  async function redo(i) {
    if (busy || rec) return;
    if (!window.confirm(`円${i + 1}の録音を消して、取り直しますか？`)) return;
    stop(idOf(i));
    takes[i] = null;
    try { await dbDel(i); } catch (e) { /* なし */ }
    paint(i);
    renderFeed();
    removeRemote([idOf(i)]);
  }

  async function toggleLowcut(i) {
    const t = takes[i];
    if (!t) return;
    t.lowcut = !t.lowcut;
    buildView();
    const p = playing.get(idOf(i));
    if (p && p.hp) p.hp.frequency.setTargetAtTime(t.lowcut ? LOWCUT_HZ : 10, ctx.currentTime, 0.02);
    paint(i);
    try { await dbPut(i, t); } catch (e) { /* なし */ }
    if (t.synced && cloudState === 'on') { try { await cloud.patch(idOf(i), { lowcut: t.lowcut }); } catch (e) { /* なし */ } }
  }

  /* ================= 円の表示 ================= */
  const STATE_JA = { empty: '空', rec: '録音中', saved: '録音済み' };
  function paint(i) {
    const o = orbs[i];
    const id = idOf(i);
    o.dataset.pk = id;
    const st = rec && rec.i === i ? 'rec' : takes[i] ? 'saved' : 'empty';
    o.dataset.state = st;
    const on = playing.has(id) || loading.has(id);
    o.classList.toggle('is-play', on);
    if (!playing.has(id)) { o.style.setProperty('--p', '0'); o.style.setProperty('--lv', '0'); }
    const t = o.querySelector('.t');
    if (st === 'saved' && !playing.has(id)) t.textContent = fmt(takes[i].dur);
    else if (st === 'empty') t.textContent = '';
    redos[i].hidden = st !== 'saved';
    lowcuts[i].hidden = st !== 'saved';
    lowcuts[i].setAttribute('aria-pressed', String(!!(takes[i] && takes[i].lowcut)));
    mains[i].setAttribute('aria-label', `円${i + 1}、${STATE_JA[st]}${on ? '、再生中' : ''}`);
  }

  async function onTap(i) {
    if (busy) return;
    say('');
    if (!myName) { openGate(false); return; }
    if (rec) { if (rec.i === i) stopRec(); return; }
    if (takes[i]) { toggle(idOf(i)); return; }
    busy = true;
    try { await startRec(i); } finally { busy = false; }
  }
  mains.forEach((m, i) => m.addEventListener('click', () => onTap(i)));
  redos.forEach((r, i) => r.addEventListener('click', () => redo(i)));
  lowcuts.forEach((l, i) => l.addEventListener('click', () => toggleLowcut(i)));

  // 見出しを長押し（約1.5秒）で、録音をすべて消す
  let hold = 0;
  head.addEventListener('pointerdown', () => {
    clearTimeout(hold);
    hold = setTimeout(async () => {
      if (!window.confirm('録音をすべて消しますか？（共有した分も消えます）')) return;
      stopAll();
      if (rec) stopRec();
      const ids = takes.map((_, i) => idOf(i));
      takes.fill(null);
      try { await dbClear(); } catch (e) { /* なし */ }
      for (let i = 0; i < N; i++) paint(i);
      renderFeed();
      removeRemote(ids);
    }, 1500);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => head.addEventListener(ev, () => clearTimeout(hold)));
  head.addEventListener('contextmenu', (e) => e.preventDefault());

  /* ================= 聴く（投稿の一覧） ================= */
  const cards = new Map();   // uid → { el, list, map, layer, sig }

  const two = (n) => String(n).padStart(2, '0');
  function whenText(at) {
    const d = new Date(at), n = new Date();
    const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
    return d.toDateString() === n.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  }

  function wfSvg(peaks) {
    const p = peaks && peaks.length ? peaks : new Array(BARS).fill(10);
    let r = '';
    p.forEach((v, i) => { const h = Math.max(1, (v / 100) * 18); r += `<rect x="${i + 0.2}" y="${(10 - h / 2).toFixed(2)}" width="0.6" height="${h.toFixed(2)}" rx="0.3"/>`; });
    return `<svg viewBox="0 0 ${p.length} 20" preserveAspectRatio="none" aria-hidden="true" fill="currentColor">${r}</svg>`;
  }

  function newCard(u) {
    const el = document.createElement('article');
    el.className = 'post';
    el.innerHTML = '<div class="map"></div><div class="head2"><span class="name"></span><span class="when"></span></div><ul class="clips"></ul><p class="note"></p><div class="act"><button type="button" class="cmt" aria-label="コメント" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.500 11.500c0 4.100-3.800 7.500-8.500 7.500-1.100 0-2.200-.2-3.200-.5L4 20l1.400-3.900c-1.200-1.300-1.900-2.900-1.900-4.600C3.500 7.400 7.300 4 12 4s8.500 3.400 8.500 7.500z"/></svg><b class="cn"></b></button></div><div class="cp" hidden><ul class="cm"></ul><form class="cf" autocomplete="off"><input type="text" maxlength="80" placeholder="コメントを追加" aria-label="コメント"><button type="submit" disabled>投稿</button></form></div>';
    const c = { uid: u, el, list: [], map: null, layer: null, sig: '' };
    el.querySelector('.cmt').addEventListener('click', () => {
      const cp = el.querySelector('.cp');
      cp.hidden = !cp.hidden;
      el.querySelector('.cmt').setAttribute('aria-expanded', String(!cp.hidden));
      if (!cp.hidden) el.querySelector('.cf input').focus();
    });
    el.querySelector('.cf input').addEventListener('input', (e) => { el.querySelector('.cf button').disabled = !e.target.value.trim(); });
    el.querySelector('.cf').addEventListener('submit', (e) => {
      e.preventDefault();
      const inp = e.target.querySelector('input');
      if (sendComment(u, inp.value)) { inp.value = ''; e.target.querySelector('button').disabled = true; }
    });
    io.observe(el.querySelector('.map'));
    el.querySelector('.map').__card = c;
    return c;
  }

  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver((es) => {
      es.forEach((e) => { if (e.isIntersecting) { mountMap(e.target.__card); io.unobserve(e.target); } });
    }, { rootMargin: '240px' })
    : { observe: (t) => mountMap(t.__card), unobserve() {} };

  function mountMap(c) {
    if (c.map || !window.L) return;
    const box = c.el.querySelector('.map');
    const map = L.map(box, {
      zoomControl: false, dragging: false, touchZoom: false, doubleClickZoom: false, scrollWheelZoom: false,
      boxZoom: false, keyboard: false, tap: false, zoomSnap: 0.25, attributionControl: true,
    });
    L.tileLayer(TILE, {
      minZoom: 14, maxZoom: 19, maxNativeZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
    }).addTo(map);
    map.attributionControl.setPrefix('');
    c.map = map;
    c.layer = L.layerGroup().addTo(map);
    map.fitBounds(CAMPUS_BOUNDS);
    setPins(c);
  }

  function setPins(c) {
    if (!c.map) return;
    c.layer.clearLayers();
    const pts = c.list.filter((m) => m.lat != null && m.lng != null);
    const seen = new Map();
    pts.forEach((m) => {
      // ほぼ同じ場所の音は、ピンが重ならないよう少しずつずらして表示する
      const key = `${m.lat.toFixed(5)},${m.lng.toFixed(5)}`;
      const k = seen.get(key) || 0;
      seen.set(key, k + 1);
      const lat = m.lat, lng = m.lng + k * 0.00006;
      const icon = L.divIcon({
        className: '', iconSize: [26, 26], iconAnchor: [13, 13],
        html: `<div class="pin${playing.has(m.id) || loading.has(m.id) ? ' is-play' : ''}" data-pk="${m.id}">${m.slot + 1}</div>`,
      });
      const mk = L.marker([lat, lng], { icon, keyboard: false, riseOnHover: true });
      mk.on('click', () => toggle(m.id));
      mk.addTo(c.layer);
    });
    const inside = pts.every((m) => Math.abs(m.lat - CAMPUS.lat) <= CAMPUS.dLat && Math.abs(m.lng - CAMPUS.lng) <= CAMPUS.dLng);
    if (!pts.length || inside) c.map.fitBounds(CAMPUS_BOUNDS);
    else c.map.fitBounds(L.latLngBounds(pts.map((m) => [m.lat, m.lng])).pad(0.5), { maxZoom: 17 });
    c.map.invalidateSize();
    let over = c.el.querySelector('.nomap');
    if (!pts.length) {
      if (!over) { over = document.createElement('div'); over.className = 'nomap'; over.style.zIndex = 500; over.style.pointerEvents = 'none'; c.el.querySelector('.map').appendChild(over); }
      over.textContent = '場所の記録がありません';
    } else if (over) over.remove();
  }

  function fillCard(c, list) {
    c.list = list;
    const first = list[0];
    c.el.querySelector('.name').textContent = first.name || '名前なし';
    c.el.querySelector('.when').textContent = whenText(Math.max(...list.map((m) => m.at)));
    const ul = c.el.querySelector('.clips');
    ul.innerHTML = '';
    list.forEach((m) => {
      const li = document.createElement('li');
      li.className = 'clip';
      li.dataset.pk = m.id;
      li.innerHTML = `<button type="button" class="pl" aria-label="${m.slot + 1}を再生"><span class="no">${m.slot + 1}</span><span class="wf"><span class="off">${wfSvg(m.peaks)}</span><span class="on">${wfSvg(m.peaks)}</span></span><span class="tm">${fmt(m.dur)}</span></button>`;
      li.querySelector('.pl').addEventListener('click', () => toggle(m.id));
      ul.appendChild(li);
      if (playing.has(m.id) || loading.has(m.id)) li.classList.add('is-play');
    });
    const miss = list.filter((m) => m.lat == null).map((m) => m.slot + 1);
    c.el.querySelector('.note').textContent = miss.length && miss.length < list.length ? `場所の記録がない音：${miss.join('、')}` : '';
    setPins(c);
  }

  let netTimer = 0;
  function flashNet(t) {
    netEl.textContent = t;
    clearTimeout(netTimer);
    netTimer = setTimeout(renderNet, 3000);
  }
  const needCloud = () => {
    if (!myName) { openGate(false); return false; }
    if (cloudState !== 'on') { flashNet('共有につながっていないため、操作できません'); return false; }
    return true;
  };

  function sendComment(u, raw) {
    const text = raw.trim().slice(0, 80);
    if (!text || !needCloud()) return false;
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const obj = { postUid: u, by: uid, name: myName, text, at: Date.now() };
    comments.set(id, obj);
    renderAllReact();
    cloud.setDoc('comments', id, obj).catch(() => { comments.delete(id); renderAllReact(); flashNet('送れませんでした'); });
    return true;
  }

  function removeComment(id) {
    if (!window.confirm('このコメントを消しますか？')) return;
    const keep = comments.get(id);
    comments.delete(id);
    renderAllReact();
    cloud.delDoc('comments', id).catch(() => { if (keep) comments.set(id, keep); renderAllReact(); flashNet('消せませんでした'); });
  }

  function renderReact(c) {
    const u = c.uid;
    const list = [...comments.entries()].filter(([, x]) => x.postUid === u).sort((a, b) => a[1].at - b[1].at);
    const shown = list;
    c.el.querySelector('.cn').textContent = list.length ? String(list.length) : '';
    const ul = c.el.querySelector('.cm');
    ul.innerHTML = '';
    shown.forEach(([id, x]) => {
      const li = document.createElement('li');
      const nm = document.createElement('b'); nm.textContent = x.name || '名前なし';
      const tx = document.createElement('span'); tx.textContent = x.text;
      const tm = document.createElement('time'); tm.textContent = whenText(x.at);
      li.append(nm, tx);
      li.appendChild(tm);
      if (x.by === uid) {
        const rm = document.createElement('button');
        rm.type = 'button'; rm.className = 'rm'; rm.textContent = '消す';
        rm.addEventListener('click', () => removeComment(id));
        li.appendChild(rm);
      }
      ul.appendChild(li);
    });
  }
  const renderAllReact = () => cards.forEach(renderReact);

  function renderNet() {
    const t = { idle: '', connecting: '共有につなぎ中', on: '', err: '共有につながっていません。録音はこの端末に残ります' }[cloudState];
    netEl.textContent = t || '';
  }

  function renderFeed() {
    const v = buildView();
    const groups = new Map();
    v.forEach((m) => { if (!groups.has(m.uid)) groups.set(m.uid, []); groups.get(m.uid).push(m); });
    groups.forEach((l) => l.sort((a, b) => a.slot - b.slot));
    const order = [...groups.entries()].sort((a, b) => Math.max(...b[1].map((m) => m.at)) - Math.max(...a[1].map((m) => m.at)));

    emptyEl.hidden = order.length > 0;
    const keep = new Set(order.map(([u]) => u));
    cards.forEach((c, u) => { if (!keep.has(u)) { if (c.map) c.map.remove(); c.el.remove(); cards.delete(u); } });

    order.forEach(([u, list], idx) => {
      let c = cards.get(u);
      if (!c) { c = newCard(u); cards.set(u, c); }
      const sig = list.map((m) => `${m.id}.${m.at}.${m.lat}.${m.lng}.${m.name}.${m.lowcut ? 1 : 0}`).join('|');
      if (sig !== c.sig) { c.sig = sig; fillCard(c, list); }
      if (feedEl.children[idx] !== c.el) feedEl.insertBefore(c.el, feedEl.children[idx] || null);
      renderReact(c);
    });
    // 円の見た目も合わせる
    for (let i = 0; i < N; i++) paint(i);
  }

  /* ================= 画面の切り替え（右へスワイプ） ================= */
  const tabBtns = [...document.querySelectorAll('#tabs button')];
  const ul = $('ul');
  function syncTabs() {
    const w = pager.clientWidth || 1;
    const r = Math.max(0, Math.min(1, pager.scrollLeft / w));
    const a = tabBtns[0], b = tabBtns[1];
    const x = a.offsetLeft + (b.offsetLeft - a.offsetLeft) * r;
    const wd = a.offsetWidth + (b.offsetWidth - a.offsetWidth) * r;
    ul.style.transform = `translateX(${x}px) scaleX(${(wd / 20).toFixed(3)})`;
    tabBtns.forEach((t, i) => t.setAttribute('aria-current', String((r > 0.5 ? 1 : 0) === i)));
  }
  pager.addEventListener('scroll', syncTabs, { passive: true });
  window.addEventListener('resize', syncTabs);
  tabBtns.forEach((b, i) => b.addEventListener('click', () => pager.scrollTo({ left: i * pager.clientWidth, behavior: 'smooth' })));

  /* ================= ユーザーネーム ================= */
  function openGate(canCancel) {
    nameIn.value = myName;
    gateCancel.hidden = !canCancel;
    gate.hidden = false;
    setTimeout(() => nameIn.focus(), 50);
  }
  gateCancel.addEventListener('click', () => { gate.hidden = true; });
  whoBtn.addEventListener('click', () => openGate(true));
  gateForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = nameIn.value.trim().slice(0, 12);
    if (!n) return;
    const changed = n !== myName;
    const had = !!myName;
    myName = n;
    ls.set(K.name, n);
    whoBtn.textContent = n;
    gate.hidden = true;
    locate();     // 位置情報の許可を、この操作のときに先に出しておく
    renderFeed();
    if (changed && had && cloudState === 'on') {
      const ids = takes.map((t, i) => (t && t.synced ? idOf(i) : null)).filter(Boolean);
      if (ids.length) { try { await cloud.rename(ids, n); } catch (err) { /* なし */ } }
    }
    syncAll();
  });

  /* ================= 起動 ================= */
  async function init() {
    const fx = ls.get(K.fx); if (fx != null) space.value = fx;
    const p1 = ls.get(K.pitch); if (p1 != null) pitch.value = p1;
    whoBtn.textContent = myName;
    if (!myName) openGate(false);

    try {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
      for (let i = 0; i < N; i++) takes[i] = (await dbGet(i)) || null;
    } catch (e) {
      say('保存の領域を開けませんでした。リロードすると消えます');
    }
    renderFeed();
    syncTabs();
    connect();

    // 以前の録音に波形がなければ作る
    for (let i = 0; i < N; i++) {
      const t = takes[i];
      if (t && !t.peaks) {
        const pk = await calcPeaks(t.buf);
        if (pk && takes[i] === t) { t.peaks = pk; try { await dbPut(i, t); } catch (e) { /* なし */ } renderFeed(); }
      }
    }
  }
  init();

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
