(() => {
  'use strict';

  const N = 5;
  const MAX_SEC = 60;
  const DB_NAME = 'picnicking-recorder';
  const STORE = 'takes';
  const FX_KEY = 'picnicking-fx';

  const orbs = [...document.querySelectorAll('.orb')];
  const mains = orbs.map((o) => o.querySelector('.main'));
  const redos = orbs.map((o) => o.querySelector('.redo'));
  const msg = document.getElementById('msg');
  const head = document.getElementById('head');
  const space = document.getElementById('space');

  const takes = new Array(N).fill(null);    // { buf: ArrayBuffer, type, dur, at }
  const buffers = new Array(N).fill(null);  // デコード済み AudioBuffer
  const playing = new Array(N).fill(null);  // 再生中の情報
  let rec = null;                           // 録音中の状態
  let busy = false;
  let ctx = null;
  let chain = null;
  let outEl = null;                         // 出力用の <audio>（iPhoneの消音スイッチ対策）

  const say = (t) => { msg.textContent = t || ''; };
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  /* ---------- 保存（IndexedDB） ---------- */
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

  /* ---------- 音の経路と残響 ---------- */
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
    chain = { input, dry, wet, an, td: new Uint8Array(an.fftSize) };

    // iPhoneは、消音スイッチがオンだとWebオーディオが無音になる。
    // <audio>要素を経由させると、スイッチに関係なく鳴る。
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
          // 再生できなければ通常の出力に切り替える
          try { an.disconnect(dest); } catch (e) { /* なし */ }
          an.connect(ctx.destination);
          outEl = null;
        });
      }
    } catch (e) { routed = false; }
    if (!routed) an.connect(ctx.destination);
    applyFx();
  }

  // iPhoneの音の使い方を切り替える：録音中は録音向き、鳴らすときは再生向き
  function setSession(type) {
    try { if (navigator.audioSession) navigator.audioSession.type = type; } catch (e) { /* 非対応 */ }
  }

  function ensureCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      buildChain();
    }
    // suspended のほか、iPhoneでマイク使用後に入る interrupted でも再開する
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
  }

  space.addEventListener('input', () => {
    applyFx();
    try { localStorage.setItem(FX_KEY, space.value); } catch (e) { /* 保存できなくても動く */ }
  });

  /* ---------- 再生 ---------- */
  async function getBuffer(i) {
    if (buffers[i]) return buffers[i];
    const t = takes[i];
    if (!t) return null;
    const ab = t.buf.slice(0);
    const b = await new Promise((res, rej) => {
      const p = ctx.decodeAudioData(ab, res, rej);
      if (p && p.catch) p.catch(rej);
    });
    buffers[i] = b;
    return b;
  }

  // デコードできない端末では、<audio>で直接鳴らす（残響は効かない）
  function playPlain(i) {
    const t = takes[i];
    const url = URL.createObjectURL(new Blob([t.buf], { type: t.type || 'audio/mp4' }));
    const el = new Audio(url);
    el.playsInline = true;
    const p = { kind: 'el', el, url, dur: t.dur };
    const done = () => {
      if (playing[i] !== p) return;
      playing[i] = null;
      URL.revokeObjectURL(url);
      paint(i);
    };
    el.onended = done;
    el.onerror = () => { say('この音を再生できませんでした'); done(); };
    playing[i] = p;
    paint(i);
    startMeter();
    el.play().catch(() => { say('この音を再生できませんでした'); done(); });
  }

  async function play(i) {
    setSession('playback');
    ensureCtx();
    if (ctx.state !== 'running') { try { await ctx.resume(); } catch (e) { /* なし */ } }
    let buf = null;
    try { buf = await getBuffer(i); } catch (e) { buf = null; }
    if (playing[i]) return;
    if (!buf) { playPlain(i); return; }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(chain.input);
    const p = { kind: 'buf', src, t0: ctx.currentTime, dur: buf.duration };
    src.onended = () => { if (playing[i] === p) { playing[i] = null; paint(i); } };
    playing[i] = p;
    src.start();
    paint(i);
    startMeter();
  }

  function stop(i) {
    const p = playing[i];
    if (!p) return;
    playing[i] = null;
    if (p.kind === 'buf') {
      try { p.src.stop(); } catch (e) { /* すでに終了 */ }
    } else {
      p.el.pause();
      URL.revokeObjectURL(p.url);
    }
    paint(i);
  }

  const stopAll = () => { for (let i = 0; i < N; i++) stop(i); };

  // 再生中の円：音量に合わせた拡縮、濃い色の満ち方、残り時間
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
    let any = false;
    orbs.forEach((o, i) => {
      const p = playing[i];
      if (!p) { o.style.setProperty('--lv', '0'); return; }
      any = true;
      const el = p.kind === 'buf' ? ctx.currentTime - p.t0 : p.el.currentTime;
      const dur = p.kind === 'buf' ? p.dur : (p.el.duration && isFinite(p.el.duration) ? p.el.duration : p.dur);
      const frac = Math.max(0, Math.min(1, el / dur));
      o.style.setProperty('--p', frac.toFixed(3));
      o.style.setProperty('--lv', lv.toFixed(3));
      o.querySelector('.t').textContent = `再生 ${fmt(Math.max(0, dur - el))}`;
    });
    if (any) raf = requestAnimationFrame(meter);
  }
  const startMeter = () => { if (!raf) raf = requestAnimationFrame(meter); };

  /* ---------- 録音 ---------- */
  function pickType() {
    if (!window.MediaRecorder) return null;
    const list = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    for (const t of list) {
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
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
      mr = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      say('録音を始められませんでした');
      return;
    }
    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = () => finishRec(i, chunks, mr.mimeType || type || 'audio/mp4');
    rec = { i, mr, stream, t0: performance.now(), timer: setInterval(tick, 200), stopping: false };
    mr.start();
    paint(i);
    tick();
  }

  function stopRec() {
    if (!rec || rec.stopping) return;
    rec.stopping = true;
    try { rec.mr.stop(); } catch (e) { finishRec(rec.i, [], ''); }
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
    const row = { buf, type, dur, at: Date.now() };
    takes[i] = row;
    buffers[i] = null;
    paint(i);
    // マイクを離したあとに、再生側の出力を戻しておく
    setSession('playback');
    ensureCtx();
    try {
      await dbPut(i, row);
    } catch (e) {
      say('保存できませんでした。リロードすると消えます');
    }
  }

  /* ---------- 取り直す ---------- */
  async function redo(i) {
    if (busy || rec) return;
    if (!window.confirm(`円${i + 1}の録音を消して、取り直しますか？`)) return;
    stop(i);
    takes[i] = null;
    buffers[i] = null;
    try { await dbDel(i); } catch (e) { /* なし */ }
    paint(i);
  }

  /* ---------- 表示 ---------- */
  const STATE_JA = { empty: '空', rec: '録音中', saved: '録音済み' };
  function paint(i) {
    const o = orbs[i];
    const st = rec && rec.i === i ? 'rec' : takes[i] ? 'saved' : 'empty';
    o.dataset.state = st;
    o.classList.toggle('is-play', !!playing[i]);
    if (!playing[i]) { o.style.setProperty('--p', '0'); o.style.setProperty('--lv', '0'); }
    const t = o.querySelector('.t');
    if (st === 'saved' && !playing[i]) t.textContent = fmt(takes[i].dur);
    else if (st === 'empty') t.textContent = '';
    redos[i].hidden = st !== 'saved';
    mains[i].setAttribute('aria-label', `円${i + 1}、${STATE_JA[st]}${playing[i] ? '、再生中' : ''}`);
  }

  /* ---------- 操作 ---------- */
  async function onTap(i) {
    if (busy) return;
    say('');
    if (rec) { if (rec.i === i) stopRec(); return; }
    if (takes[i]) { if (playing[i]) stop(i); else play(i); return; }
    busy = true;
    try { await startRec(i); } finally { busy = false; }
  }
  mains.forEach((m, i) => m.addEventListener('click', () => onTap(i)));
  redos.forEach((r, i) => r.addEventListener('click', () => redo(i)));

  // 見出しを長押し（約1.5秒）で、録音をすべて消す
  let hold = 0;
  const holdStart = () => {
    clearTimeout(hold);
    hold = setTimeout(async () => {
      if (!window.confirm('録音をすべて消しますか？')) return;
      stopAll();
      if (rec) stopRec();
      takes.fill(null);
      buffers.fill(null);
      try { await dbClear(); } catch (e) { /* なし */ }
      for (let i = 0; i < N; i++) paint(i);
    }, 1500);
  };
  const holdEnd = () => clearTimeout(hold);
  head.addEventListener('pointerdown', holdStart);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => head.addEventListener(ev, holdEnd));
  head.addEventListener('contextmenu', (e) => e.preventDefault());

  /* ---------- 起動 ---------- */
  async function init() {
    try {
      const v = localStorage.getItem(FX_KEY);
      if (v != null) space.value = v;
    } catch (e) { /* 既定値のまま */ }

    try {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
      for (let i = 0; i < N; i++) takes[i] = (await dbGet(i)) || null;
    } catch (e) {
      say('保存の領域を開けませんでした。リロードすると消えます');
    }
    for (let i = 0; i < N; i++) paint(i);
  }
  init();

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
