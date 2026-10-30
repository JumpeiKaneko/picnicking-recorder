(() => {
  'use strict';

  const N = 5;
  const MAX_SEC = 60;
  const DB_NAME = 'picnicking-recorder';
  const STORE = 'takes';
  const FX_KEY = 'picnicking-fx';

  const orbs = [...document.querySelectorAll('.orb')];
  const msg = document.getElementById('msg');
  const head = document.getElementById('head');
  const sliders = {
    pitch: document.getElementById('pitch'),
    tone: document.getElementById('tone'),
    space: document.getElementById('space'),
  };

  const takes = new Array(N).fill(null);    // { buf: ArrayBuffer, type, dur, at }
  const buffers = new Array(N).fill(null);  // デコード済み AudioBuffer
  const playing = new Array(N).fill(null);  // { src }
  let rec = null;                           // 録音中の状態
  let busy = false;
  let ctx = null;
  let chain = null;

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
  const dbClear = () => tx('readwrite', (s) => s.clear());

  /* ---------- 音の加工 ---------- */
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
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass';
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    const conv = ctx.createConvolver(); conv.buffer = makeIR();
    const master = ctx.createGain();
    const an = ctx.createAnalyser(); an.fftSize = 256;
    hp.connect(lp);
    lp.connect(dry); lp.connect(conv);
    conv.connect(wet);
    dry.connect(master); wet.connect(master);
    master.connect(an); an.connect(ctx.destination);
    chain = { input: hp, hp, lp, dry, wet, an, td: new Uint8Array(an.fftSize) };
    applyFx();
  }

  function ensureCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      buildChain();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  const rate = () => Math.pow(2, Number(sliders.pitch.value) / 12);

  function applyFx() {
    if (!chain) return;
    const t = Number(sliders.tone.value) / 100;
    const s = Number(sliders.space.value) / 100;
    const now = ctx.currentTime;
    chain.lp.frequency.setTargetAtTime(t < 0 ? 20000 * Math.pow(0.012, -t) : 20000, now, 0.03);
    chain.hp.frequency.setTargetAtTime(t > 0 ? 20 * Math.pow(150, t) : 20, now, 0.03);
    chain.dry.gain.setTargetAtTime(1 - 0.5 * s, now, 0.03);
    chain.wet.gain.setTargetAtTime(1.4 * s, now, 0.03);
    playing.forEach((p) => { if (p) p.src.playbackRate.value = rate(); });
  }

  Object.values(sliders).forEach((el) => el.addEventListener('input', () => {
    applyFx();
    try {
      localStorage.setItem(FX_KEY, JSON.stringify({
        pitch: sliders.pitch.value, tone: sliders.tone.value, space: sliders.space.value,
      }));
    } catch (e) { /* 保存できなくても動く */ }
  }));

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

  async function play(i) {
    ensureCtx();
    let buf;
    try { buf = await getBuffer(i); } catch (e) { say('この音を再生できませんでした'); return; }
    if (!buf || playing[i]) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate();
    src.connect(chain.input);
    src.onended = () => {
      if (playing[i] && playing[i].src === src) { playing[i] = null; paint(i); }
    };
    playing[i] = { src };
    src.start();
    paint(i);
    startMeter();
  }

  function stop(i) {
    const p = playing[i];
    if (!p) return;
    playing[i] = null;
    try { p.src.stop(); } catch (e) { /* すでに終了 */ }
    paint(i);
  }

  const stopAll = () => { for (let i = 0; i < N; i++) stop(i); };

  let raf = 0;
  function meter() {
    raf = 0;
    if (!chain) return;
    chain.an.getByteTimeDomainData(chain.td);
    let sum = 0;
    for (const v of chain.td) { const x = (v - 128) / 128; sum += x * x; }
    const lv = Math.min(1, Math.sqrt(sum / chain.td.length) * 3);
    orbs.forEach((o, i) => o.style.setProperty('--lv', playing[i] ? lv.toFixed(3) : '0'));
    if (playing.some(Boolean)) raf = requestAnimationFrame(meter);
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
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
    } catch (e) {
      say('マイクを使えません。ブラウザの許可を確認してください');
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
    try {
      await dbPut(i, row);
    } catch (e) {
      say('保存できませんでした。リロードすると消えます');
    }
  }

  /* ---------- 表示 ---------- */
  const STATE_JA = { empty: '空', rec: '録音中', saved: '録音済み' };
  function paint(i) {
    const o = orbs[i];
    const st = rec && rec.i === i ? 'rec' : takes[i] ? 'saved' : 'empty';
    o.dataset.state = st;
    o.classList.toggle('is-play', !!playing[i]);
    const t = o.querySelector('.t');
    if (st === 'saved') t.textContent = fmt(takes[i].dur);
    else if (st === 'empty') t.textContent = '';
    o.setAttribute('aria-label', `円${i + 1}、${STATE_JA[st]}${playing[i] ? '、再生中' : ''}`);
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
  orbs.forEach((o, i) => o.addEventListener('click', () => onTap(i)));

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
      const fx = JSON.parse(localStorage.getItem(FX_KEY) || 'null');
      if (fx) for (const k of Object.keys(sliders)) if (fx[k] != null) sliders[k].value = fx[k];
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
