(() => {
  'use strict';

  const N = 5;
  const MAX_SEC = 60;
  const DB_NAME = 'picnicking-recorder';
  const STORE = 'takes';
  const FEED_STORE = 'feed_posts';
  const FX_KEY = 'picnicking-fx';
  const VOL_KEY = 'picnicking-vol';
  const USER_KEY = 'picnicking-user';
  const CLOUD_URL_KEY = 'picnicking-cloud-url';
  // ---------- Firebase 設定（toride-picnic） ----------
  const firebaseConfig = {
    apiKey: "AIzaSyA7jnOk0o5V4652vWQGflSzDyA_QELDxYg",
    authDomain: "toride-picnic.firebaseapp.com",
    projectId: "toride-picnic",
    storageBucket: "toride-picnic.firebasestorage.app",
    messagingSenderId: "133398915165",
    appId: "1:133398915165:web:1484b1d86fd27074e785b4",
    measurementId: "G-5CH8YS90LL"
  };

  let fbDb = null;
  try {
    if (window.firebase && typeof firebase.initializeApp === 'function') {
      if (!firebase.apps || !firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
      }
      fbDb = firebase.firestore();
      console.log('Firebase initialized: toride-picnic');
    }
  } catch (err) {
    console.warn('Firebase init warning:', err);
  }


  // 東京藝術大学 取手校地の緯度経度バウンディングボックス（GPS→マップ座標変換用）
  const TORIDE_BOUNDS = {
    minLat: 35.8755, maxLat: 35.8810,
    minLng: 140.1145, maxLng: 140.1225
  };

  // マップ上の主要エリア名判定（x, y は 0〜100%）
  const SPOTS = [
    { name: 'ヤギ小屋広場', x: 49, y: 36 },
    { name: 'バス停付近',   x: 38, y: 53 },
    { name: 'メディア棟前', x: 25, y: 28 },
    { name: '共通工房付近', x: 74, y: 26 },
    { name: '専門教育棟前', x: 76, y: 58 },
    { name: '福利施設付近', x: 27, y: 68 },
    { name: '芝生・斜面',   x: 60, y: 76 }
  ];

  const orbs = [...document.querySelectorAll('.orb')];
  const mains = orbs.map((o) => o.querySelector('.main'));
  const foots = orbs.map((o) => o.querySelector('.foot'));
  const redos = orbs.map((o) => o.querySelector('.redo'));
  const lowcuts = orbs.map((o) => o.querySelector('.lowcut'));
  const shares = orbs.map((o) => o.querySelector('.share'));
  const isLowcut = new Array(N).fill(false);
  const isShared = new Array(N).fill(false);

  const msg = document.getElementById('msg');
  const head = document.getElementById('head');
  const space = document.getElementById('space');
  const vol = document.getElementById('vol');
  const volVal = document.getElementById('volVal');
  const spaceVal = document.getElementById('spaceVal');
  const pager = document.getElementById('pager');
  const toFeedBtn = document.getElementById('toFeedBtn');
  const syncBtn = document.getElementById('syncBtn');

  // ナビゲーションタブ
  const tabHome = document.getElementById('tabHome');
  const tabFeed = document.getElementById('tabFeed');
  const tabIndicator = document.getElementById('tabIndicator');
  const feedCountBadge = document.getElementById('feedCountBadge');

  // ユーザー名モーダル要素
  const welcome = document.getElementById('welcome');
  const welcomeForm = document.getElementById('welcomeForm');
  const nameInput = document.getElementById('nameInput');
  const userChip = document.getElementById('userChip');
  const userChipName = document.getElementById('userChipName');

  // 場所選択モーダル要素
  const locModal = document.getElementById('locModal');
  const locOrbBadge = document.getElementById('locOrbBadge');
  const locPrompt = document.getElementById('locPrompt');
  const locSpotName = document.getElementById('locSpotName');
  const locCancel = document.getElementById('locCancel');
  const locGpsBtn = document.getElementById('locGpsBtn');
  const locConfirmBtn = document.getElementById('locConfirmBtn');
  const pickerMap = document.getElementById('pickerMap');
  const pickerPinLayer = document.getElementById('pickerPinLayer');

  // フィード・マップ要素
  const feedMap = document.getElementById('feedMap');
  const feedPinLayer = document.getElementById('feedPinLayer');
  const feedList = document.getElementById('feedList');

  const takes = new Array(N).fill(null);    // { buf: ArrayBuffer, type, dur, at, lowcut, sharedId, peaks }
  const buffers = new Array(N).fill(null);  // デコード済み AudioBuffer
  const playing = new Array(N).fill(null);  // 録音ホームの再生中情報
  let feedPosts = [];                       // みんなの投稿一覧 [{ id, user, orbIdx, dur, type, buf, b64, x, y, spot, lowcut, peaks, at }]
  let feedPlaying = null;                   // { postId, src, el, url, filter, t0, dur }
  let pendingShareIdx = null;               // 場所選択中の円インデックス
  let pickedCoord = { x: 49, y: 36 };       // デフォルト：ヤギ小屋広場

  let userName = '';
  let rec = null;                           // 録音中の状態
  let busy = false;
  let ctx = null;
  let chain = null;
  let outEl = null;                         // 出力用の <audio>（iPhoneの消音スイッチ対策）
  let bc = null;                            // BroadcastChannel

  const say = (t) => { msg.textContent = t || ''; };
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  /* ---------- 保存（IndexedDB v2：takes + feed_posts） ---------- */
  let dbp = null;
  const openDB = () => new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
      if (!d.objectStoreNames.contains(FEED_STORE)) d.createObjectStore(FEED_STORE, { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const db = () => dbp || (dbp = openDB());
  const tx = async (storeName, mode, fn) => {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(storeName, mode);
      const q = fn(t.objectStore(storeName));
      t.oncomplete = () => res(q && q.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  };
  const dbGet = (i) => tx(STORE, 'readonly', (s) => s.get(i));
  const dbPut = (i, v) => tx(STORE, 'readwrite', (s) => s.put(v, i));
  const dbDel = (i) => tx(STORE, 'readwrite', (s) => s.delete(i));
  const dbClear = () => tx(STORE, 'readwrite', (s) => s.clear());

  const dbFeedAll = () => tx(FEED_STORE, 'readonly', (s) => s.getAll());
  const dbFeedPut = (post) => tx(FEED_STORE, 'readwrite', (s) => s.put(post));
  const dbFeedDel = (id) => tx(FEED_STORE, 'readwrite', (s) => s.delete(id));

  /* ---------- ArrayBuffer ⇔ Base64 変換（クラウド送受信・軽量化用） ---------- */
  function bufToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function base64ToBuf(b64) {
    const binary = atob(b64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  /* ---------- 波形ピーク計算（スケッチの波形バー表示用・28分割） ---------- */
  function calcPeaksFromAudioBuffer(audioBuf, bins = 28) {
    try {
      const raw = audioBuf.getChannelData(0);
      const step = Math.max(1, Math.floor(raw.length / bins));
      const peaks = [];
      let max = 0.01;
      for (let i = 0; i < bins; i++) {
        let sum = 0;
        const start = i * step;
        const end = Math.min(raw.length, start + step);
        for (let j = start; j < end; j++) {
          const v = Math.abs(raw[j]);
          if (v > sum) sum = v;
        }
        peaks.push(sum);
        if (sum > max) max = sum;
      }
      return peaks.map((p) => Number(Math.max(0.08, Math.min(1, p / max)).toFixed(2)));
    } catch (e) {
      return Array.from({ length: bins }, (_, k) => Number((0.2 + 0.6 * Math.abs(Math.sin(k * 0.7))).toFixed(2)));
    }
  }

  function buildWaveSvgPath(peaks) {
    const arr = (peaks && peaks.length) ? peaks : [0.25, 0.6, 0.35, 0.8, 0.45, 0.7, 0.3, 0.9, 0.5, 0.4, 0.75, 0.35, 0.6, 0.3];
    const w = 180;
    const h = 16;
    const mid = h / 2;
    let d = `M 0,${mid}`;
    const step = w / arr.length;
    arr.forEach((v, idx) => {
      const x1 = (idx + 0.3) * step;
      const x2 = (idx + 0.7) * step;
      const x3 = (idx + 1) * step;
      const amp = Math.max(1.5, v * (mid - 1.5));
      d += ` L ${x1.toFixed(1)},${(mid - amp).toFixed(1)} L ${x2.toFixed(1)},${(mid + amp).toFixed(1)} L ${x3.toFixed(1)},${mid}`;
    });
    return `<svg class="track-wave-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${d}"/></svg>`;
  }

  /* ---------- マップ上の最寄りスポット判定 ---------- */
  function nearestSpotName(x, y) {
    let best = '広場周辺';
    let minD = Infinity;
    for (const s of SPOTS) {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < minD) { minD = d; best = s.name; }
    }
    return minD < 28 ? best : '取手校地内';
  }

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
    chain = { input, dry, wet, master, an, td: new Uint8Array(an.fftSize) };

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
    chain.master.gain.setTargetAtTime(Number(vol.value) / 50, now, 0.03);
  }

  space.addEventListener('input', () => {
    applyFx();
    if (spaceVal) spaceVal.textContent = space.value;
    try { localStorage.setItem(FX_KEY, space.value); } catch (e) {}
  });
  vol.addEventListener('input', () => {
    applyFx();
    if (volVal) volVal.textContent = vol.value;
    try { localStorage.setItem(VOL_KEY, vol.value); } catch (e) {}
  });

  /* ---------- 録音ホーム側の再生 ---------- */
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
    if (!t.peaks) {
      t.peaks = calcPeaksFromAudioBuffer(b);
      dbPut(i, t).catch(() => {});
    }
    return b;
  }

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
    stopFeedPlay();
    setSession('playback');
    ensureCtx();
    if (ctx.state !== 'running') { try { await ctx.resume(); } catch (e) {} }
    let buf = null;
    try { buf = await getBuffer(i); } catch (e) { buf = null; }
    if (playing[i]) return;
    if (!buf) { playPlain(i); return; }
    const src = ctx.createBufferSource();
    src.buffer = buf;

    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = isLowcut[i] ? 120 : 10;
    filter.Q.value = 0.7;
    src.connect(filter);
    filter.connect(chain.input);

    const p = { kind: 'buf', src, filter, t0: ctx.currentTime, dur: buf.duration };
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
      try { p.src.stop(); } catch (e) {}
    } else {
      p.el.pause();
      URL.revokeObjectURL(p.url);
    }
    paint(i);
  }

  const stopAll = () => {
    for (let i = 0; i < N; i++) stop(i);
    stopFeedPlay();
  };

  /* ---------- フィード（みんなの音）の再生 ---------- */
  function stopFeedPlay() {
    if (!feedPlaying) return;
    const fp = feedPlaying;
    feedPlaying = null;
    if (fp.src) {
      try { fp.src.stop(); } catch (e) {}
    }
    if (fp.el) {
      fp.el.pause();
      if (fp.url) URL.revokeObjectURL(fp.url);
    }
    updateFeedPlayUI();
  }

  async function toggleFeedPlay(postId) {
    if (feedPlaying && feedPlaying.postId === postId) {
      stopFeedPlay();
      return;
    }
    stopAll();
    const post = feedPosts.find((p) => p.id === postId);
    if (!post) return;

    setSession('playback');
    ensureCtx();
    if (ctx.state !== 'running') { try { await ctx.resume(); } catch (e) {} }

    let rawBuf = post.buf;
    if (!rawBuf && post.b64) {
      try { rawBuf = base64ToBuf(post.b64); post.buf = rawBuf; } catch (e) {}
    }
    if (!rawBuf) return;

    try {
      const decoded = await new Promise((res, rej) => {
        const p = ctx.decodeAudioData(rawBuf.slice(0), res, rej);
        if (p && p.catch) p.catch(rej);
      });
      const src = ctx.createBufferSource();
      src.buffer = decoded;
      const filter = ctx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = post.lowcut ? 120 : 10;
      filter.Q.value = 0.7;
      src.connect(filter);
      filter.connect(chain.input);

      const fp = { postId, src, filter, t0: ctx.currentTime, dur: decoded.duration };
      feedPlaying = fp;
      src.onended = () => {
        if (feedPlaying === fp) {
          feedPlaying = null;
          updateFeedPlayUI();
        }
      };
      src.start();
      updateFeedPlayUI();
      startMeter();
    } catch (e) {
      const url = URL.createObjectURL(new Blob([rawBuf], { type: post.type || 'audio/mp4' }));
      const el = new Audio(url);
      el.playsInline = true;
      const fp = { postId, el, url, t0: performance.now() / 1000, dur: post.dur || 5 };
      feedPlaying = fp;
      el.onended = () => {
        if (feedPlaying === fp) {
          feedPlaying = null;
          URL.revokeObjectURL(url);
          updateFeedPlayUI();
        }
      };
      el.play().catch(() => { stopFeedPlay(); });
      updateFeedPlayUI();
      startMeter();
    }
  }

  function updateFeedPlayUI() {
    const activeId = feedPlaying ? feedPlaying.postId : null;
    document.querySelectorAll('.map-pin[data-post-id]').forEach((pin) => {
      pin.classList.toggle('is-playing', pin.dataset.postId === activeId);
    });
    document.querySelectorAll('.track-row[data-post-id]').forEach((row) => {
      const on = row.dataset.postId === activeId;
      row.classList.toggle('is-playing', on);
      const btn = row.querySelector('.track-play-btn');
      if (btn) btn.textContent = on ? '■' : '▶';
      if (!on) row.style.setProperty('--tp', '0');
    });
  }

  /* ---------- メーター更新 ---------- */
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

    if (feedPlaying) {
      any = true;
      const el = feedPlaying.src ? (ctx.currentTime - feedPlaying.t0) : (feedPlaying.el ? feedPlaying.el.currentTime : 0);
      const frac = Math.max(0, Math.min(1, el / (feedPlaying.dur || 1)));
      const row = document.querySelector(`.track-row[data-post-id="${feedPlaying.postId}"]`);
      if (row) row.style.setProperty('--tp', frac.toFixed(3));
    }

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
    let peaks = null;
    try {
      ensureCtx();
      const decoded = await new Promise((res, rej) => {
        const p = ctx.decodeAudioData(buf.slice(0), res, rej);
        if (p && p.catch) p.catch(rej);
      });
      buffers[i] = decoded;
      peaks = calcPeaksFromAudioBuffer(decoded);
    } catch (e) {}

    const row = { buf, type, dur, at: Date.now(), lowcut: isLowcut[i], sharedId: null, peaks };
    takes[i] = row;
    isShared[i] = false;
    paint(i);
    setSession('playback');
    ensureCtx();
    try {
      await dbPut(i, row);
    } catch (e) {
      say('保存できませんでした。リロードすると消えます');
    }
  }

  /* ---------- 取り直す・ローカット ---------- */
  async function redo(i) {
    if (busy || rec) return;
    if (!window.confirm(`円${i + 1}の録音を消して、取り直しますか？`)) return;
    stop(i);
    const oldSharedId = takes[i] && takes[i].sharedId;
    takes[i] = null;
    buffers[i] = null;
    isLowcut[i] = false;
    isShared[i] = false;
    try { await dbDel(i); } catch (e) {}
    if (oldSharedId) {
      feedPosts = feedPosts.filter((p) => p.id !== oldSharedId);
      try { await dbFeedDel(oldSharedId); } catch (e) {}
      renderFeed();
    }
    paint(i);
  }

  function toggleLowcut(i, e) {
    e.stopPropagation();
    isLowcut[i] = !isLowcut[i];
    paint(i);
    const p = playing[i];
    if (p && p.filter) {
      const now = ctx.currentTime;
      const targetFreq = isLowcut[i] ? 120 : 10;
      p.filter.frequency.setTargetAtTime(targetFreq, now, 0.03);
    }
    if (takes[i]) {
      takes[i].lowcut = isLowcut[i];
      dbPut(i, takes[i]).catch(() => {});
    }
  }

  /* ---------- 共有（取手マップ上の位置指定＆フィード投稿） ---------- */
  function openShareModal(i, e) {
    e.stopPropagation();
    if (!takes[i]) return;
    if (!userName) {
      welcome.hidden = false;
      nameInput.focus();
      return;
    }
    pendingShareIdx = i;
    const offsets = [
      { x: 48, y: 36 },
      { x: 54, y: 42 },
      { x: 43, y: 44 },
      { x: 52, y: 31 },
      { x: 45, y: 33 }
    ];
    pickedCoord = takes[i].coord || offsets[i % offsets.length];
    if (locOrbBadge) locOrbBadge.textContent = `円${i + 1}`;
    if (locPrompt) locPrompt.textContent = 'どこで録った音ですか？';
    if (locSpotName) locSpotName.textContent = nearestSpotName(pickedCoord.x, pickedCoord.y);
    renderPickerPin();
    locModal.hidden = false;
  }

  function renderPickerPin() {
    pickerPinLayer.innerHTML = '';
    const pin = document.createElement('div');
    pin.className = 'map-pin is-playing';
    pin.style.left = `${pickedCoord.x}%`;
    pin.style.top = `${pickedCoord.y}%`;
    pin.textContent = pendingShareIdx != null ? String(pendingShareIdx + 1) : '●';
    pickerPinLayer.appendChild(pin);
  }

  pickerMap.addEventListener('click', (e) => {
    const rect = pickerMap.getBoundingClientRect();
    const x = Math.max(8, Math.min(92, ((e.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(10, Math.min(90, ((e.clientY - rect.top) / rect.height) * 100));
    pickedCoord = { x: Number(x.toFixed(1)), y: Number(y.toFixed(1)) };
    if (locSpotName) locSpotName.textContent = nearestSpotName(pickedCoord.x, pickedCoord.y);
    renderPickerPin();
  });

  locGpsBtn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      locPrompt.textContent = 'GPS非対応のため、マップを直接タップしてください';
      return;
    }
    locPrompt.textContent = '現在地を取得しています…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        if (
          latitude >= TORIDE_BOUNDS.minLat && latitude <= TORIDE_BOUNDS.maxLat &&
          longitude >= TORIDE_BOUNDS.minLng && longitude <= TORIDE_BOUNDS.maxLng
        ) {
          const x = ((longitude - TORIDE_BOUNDS.minLng) / (TORIDE_BOUNDS.maxLng - TORIDE_BOUNDS.minLng)) * 80 + 10;
          const y = (1 - (latitude - TORIDE_BOUNDS.minLat) / (TORIDE_BOUNDS.maxLat - TORIDE_BOUNDS.minLat)) * 76 + 12;
          pickedCoord = { x: Number(x.toFixed(1)), y: Number(y.toFixed(1)) };
          if (locSpotName) locSpotName.textContent = nearestSpotName(pickedCoord.x, pickedCoord.y);
          locPrompt.textContent = '現在地を反映しました';
        } else {
          pickedCoord = { x: 49, y: 36 };
          if (locSpotName) locSpotName.textContent = 'ヤギ小屋広場';
          locPrompt.textContent = '広場に合わせました（タップで調整可）';
        }
        renderPickerPin();
      },
      () => {
        locPrompt.textContent = '位置情報を取得できませんでした。マップをタップしてください';
      },
      { enableHighAccuracy: true, timeout: 5000 }
    );
  });

  locCancel.addEventListener('click', () => {
    locModal.hidden = true;
    pendingShareIdx = null;
  });

  locConfirmBtn.addEventListener('click', async () => {
    if (pendingShareIdx == null) return;
    const i = pendingShareIdx;
    const t = takes[i];
    if (!t) { locModal.hidden = true; return; }

    const id = t.sharedId || `post_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const spot = nearestSpotName(pickedCoord.x, pickedCoord.y);
    const b64 = bufToBase64(t.buf);

    const post = {
      id,
      user: userName || 'ゲスト',
      orbIdx: i + 1,
      dur: t.dur,
      type: t.type || 'audio/mp4',
      buf: t.buf,
      b64,
      x: pickedCoord.x,
      y: pickedCoord.y,
      spot,
      lowcut: isLowcut[i],
      peaks: t.peaks || null,
      at: Date.now()
    };

    t.sharedId = id;
    t.coord = { ...pickedCoord };
    isShared[i] = true;
    await dbPut(i, t).catch(() => {});

    // 既存の同じIDがあれば更新、なければ追加
    const existingIdx = feedPosts.findIndex((p) => p.id === id);
    if (existingIdx >= 0) feedPosts[existingIdx] = post;
    else feedPosts.push(post);

    await dbFeedPut(post).catch(() => {});
    if (bc) {
      try { bc.postMessage({ type: 'new_post', post: { ...post, buf: null } }); } catch (e) {}
    }
    pushPostToCloud(post);

    locModal.hidden = true;
    pendingShareIdx = null;
    paint(i);
    renderFeed();
    say(`円${i + 1}を「${spot}」に共有しました → 右スワイプで表示`);
    setTimeout(() => {
      pager.scrollTo({ left: pager.clientWidth, behavior: 'smooth' });
    }, 350);
  });

    /* ---------- クラウド同期（Firestoreリアルタイム同期 ＋ オフライン完全両立） ---------- */
  async function pushPostToCloud(post) {
    if (fbDb) {
      try {
        await fbDb.collection('toride_sounds').doc(post.id).set({
          id: post.id,
          user: post.user,
          orbIdx: post.orbIdx,
          dur: post.dur,
          type: post.type,
          b64: post.b64,
          x: post.x,
          y: post.y,
          spot: post.spot,
          lowcut: post.lowcut,
          peaks: post.peaks || null,
          at: post.at
        });
      } catch (err) {
        console.warn('Firebase upload warning (saved locally):', err);
      }
    }

    const cloudUrl = localStorage.getItem(CLOUD_URL_KEY);
    if (!cloudUrl) return;
    try {
      const payload = {
        action: 'post',
        id: post.id,
        user: post.user,
        orbIdx: post.orbIdx,
        dur: post.dur,
        type: post.type,
        b64: post.b64,
        x: post.x,
        y: post.y,
        spot: post.spot,
        lowcut: post.lowcut,
        peaks: post.peaks,
        at: post.at
      };
      await fetch(cloudUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      // 電波が悪い場合もローカルで確実に動くようエラーは無視
    }
  }

    function startFirebaseListener() {
    if (!fbDb) return;
    try {
      fbDb.collection('toride_sounds').orderBy('at', 'asc').onSnapshot((snapshot) => {
        let changed = false;
        snapshot.docChanges().forEach((change) => {
          const item = change.doc.data();
          if (!item || !item.id) return;
          if (change.type === 'added' || change.type === 'modified') {
            if (item.b64 && !item.buf) {
              try { item.buf = base64ToBuf(item.b64); } catch (e) {}
            }
            const idx = feedPosts.findIndex((p) => p.id === item.id);
            if (idx >= 0) feedPosts[idx] = item;
            else feedPosts.push(item);
            dbFeedPut(item).catch(() => {});
            changed = true;
          } else if (change.type === 'removed') {
            feedPosts = feedPosts.filter((p) => p.id !== item.id);
            dbFeedDel(item.id).catch(() => {});
            changed = true;
          }
        });
        if (changed) renderFeed();
      }, (err) => {
        console.warn('Firebase listener error (offline or rules):', err);
      });
    } catch (e) {
      console.warn('Firebase listener setup error:', e);
    }
  }

  async function syncFromCloud() {
    const cloudUrl = localStorage.getItem(CLOUD_URL_KEY);
    if (!cloudUrl) {
      renderFeed();
      return;
    }
    syncBtn.textContent = '通信中';
    try {
      const res = await fetch(cloudUrl);
      const data = await res.json();
      if (Array.isArray(data)) {
        for (const item of data) {
          if (!item || !item.id) continue;
          if (!feedPosts.some((p) => p.id === item.id)) {
            if (item.b64 && !item.buf) {
              try { item.buf = base64ToBuf(item.b64); } catch (e) {}
            }
            feedPosts.push(item);
            await dbFeedPut(item).catch(() => {});
          }
        }
        renderFeed();
      }
    } catch (e) {
      // オフライン時はローカル保存分を表示
    } finally {
      syncBtn.textContent = '更新';
    }
  }

  /* ---------- フィード＆取手マップ描画（スケッチ準拠：マップ上①②③＋下部にユーザーごと①②▶波形） ---------- */
  function renderFeed() {
    feedPinLayer.innerHTML = '';
    feedList.innerHTML = '';

    const sorted = [...feedPosts].sort((a, b) => a.at - b.at);

    if (feedCountBadge) {
      feedCountBadge.textContent = String(sorted.length);
      feedCountBadge.hidden = sorted.length === 0;
    }

    if (sorted.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'feed-empty';
      empty.innerHTML = 'まだ共有された音がありません。<br>左の画面で音を録り、円の中の「共有」を押すと<br>取手マップとここにみんなの音が並びます。';
      feedList.appendChild(empty);
      return;
    }

    // 1. マップ上に番号ピンを配置
    sorted.forEach((post, idx) => {
      const globalNum = idx + 1;
      post._globalNum = globalNum;
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = `map-pin${post.user === userName ? ' is-mine' : ''}${feedPlaying && feedPlaying.postId === post.id ? ' is-playing' : ''}`;
      pin.dataset.postId = post.id;
      pin.style.left = `${post.x}%`;
      pin.style.top = `${post.y}%`;
      pin.textContent = String(globalNum);
      pin.title = `${post.user}（${post.spot}）`;
      pin.addEventListener('click', () => {
        toggleFeedPlay(post.id);
        const card = document.querySelector(`.track-row[data-post-id="${post.id}"]`);
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      feedPinLayer.appendChild(pin);
    });

    // 2. 下部リスト：ユーザーごとにグループ化して表示（スケッチ通り「ユーザー名」の下に① ▶ [波形]）
    const groups = new Map();
    for (const post of sorted) {
      const u = post.user || 'ゲスト';
      if (!groups.has(u)) groups.set(u, []);
      groups.get(u).push(post);
    }

    for (const [uName, posts] of groups.entries()) {
      const card = document.createElement('div');
      card.className = 'user-card';

      const headEl = document.createElement('div');
      headEl.className = 'user-card-head';
      const nameEl = document.createElement('span');
      nameEl.className = 'user-card-name';
      nameEl.textContent = uName;
      const metaEl = document.createElement('span');
      metaEl.className = 'user-card-meta';
      metaEl.textContent = `${posts.length}つの音`;
      headEl.appendChild(nameEl);
      headEl.appendChild(metaEl);
      card.appendChild(headEl);

      posts.forEach((post) => {
        const isPlayingThis = feedPlaying && feedPlaying.postId === post.id;
        const row = document.createElement('div');
        row.className = `track-row${isPlayingThis ? ' is-playing' : ''}`;
        row.dataset.postId = post.id;

        // マップ対応の丸番号バッジ
        const badge = document.createElement('button');
        badge.type = 'button';
        badge.className = 'track-pin-badge';
        badge.textContent = String(post._globalNum);
        badge.title = 'タップで再生';
        badge.addEventListener('click', () => toggleFeedPlay(post.id));

        // 再生ボタン ▶ / ■
        const playBtn = document.createElement('button');
        playBtn.type = 'button';
        playBtn.className = 'track-play-btn';
        playBtn.textContent = isPlayingThis ? '■' : '▶';
        playBtn.setAttribute('aria-label', `${uName}の音${post._globalNum}を再生`);
        playBtn.addEventListener('click', () => toggleFeedPlay(post.id));

        // 波形バー（スケッチの横長ボックス＋波形線）
        const waveBox = document.createElement('div');
        waveBox.className = 'track-wave';
        waveBox.innerHTML = `<div class="track-wave-fill"></div>${buildWaveSvgPath(post.peaks)}`;
        waveBox.addEventListener('click', () => toggleFeedPlay(post.id));

        // 場所ラベル＋秒数
        const spotEl = document.createElement('span');
        spotEl.className = 'track-spot';
        spotEl.textContent = post.spot || '広場';

        const durEl = document.createElement('span');
        durEl.className = 'track-dur';
        durEl.textContent = fmt(post.dur || 0);

        row.appendChild(badge);
        row.appendChild(playBtn);
        row.appendChild(waveBox);
        row.appendChild(spotEl);
        row.appendChild(durEl);

        // 自分の投稿なら削除（共有取り消し）ボタンも控えめに表示
        if (post.user === userName) {
          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'track-del';
          delBtn.textContent = '×';
          delBtn.title = '共有を取り消す';
          delBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!window.confirm('この音の共有を取り消しますか？')) return;
            if (feedPlaying && feedPlaying.postId === post.id) stopFeedPlay();
            feedPosts = feedPosts.filter((p) => p.id !== post.id);
            await dbFeedDel(post.id).catch(() => {});
            if (fbDb) {
              fbDb.collection('toride_sounds').doc(post.id).delete().catch(() => {});
            }
            for (let k = 0; k < N; k++) {
              if (takes[k] && takes[k].sharedId === post.id) {
                takes[k].sharedId = null;
                isShared[k] = false;
                await dbPut(k, takes[k]).catch(() => {});
                paint(k);
              }
            }
            renderFeed();
          });
          row.appendChild(delBtn);
        }

        card.appendChild(row);
      });

      feedList.appendChild(card);
    }
  }

  /* ---------- 表示更新 ---------- */
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
    foots[i].hidden = st !== 'saved';
    lowcuts[i].classList.toggle('is-on', isLowcut[i]);
    lowcuts[i].setAttribute('aria-pressed', String(isLowcut[i]));
    if (shares[i]) {
      shares[i].classList.toggle('is-shared', isShared[i]);
      shares[i].textContent = isShared[i] ? '共有済' : '共有';
    }
    mains[i].setAttribute('aria-label', `円${i + 1}、${STATE_JA[st]}${playing[i] ? '、再生中' : ''}`);
  }

  /* ---------- 操作イベント ---------- */
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
  lowcuts.forEach((l, i) => l.addEventListener('click', (e) => toggleLowcut(i, e)));
  shares.forEach((s, i) => s.addEventListener('click', (e) => openShareModal(i, e)));

  // タブ切り替えと横スワイプの同期
  function switchPage(pageIdx) {
    const w = pager.clientWidth;
    pager.scrollTo({ left: pageIdx * w, behavior: 'smooth' });
    updateTabs(pageIdx === 1);
  }

  function updateTabs(isRight) {
    if (tabHome) tabHome.classList.toggle('is-active', !isRight);
    if (tabFeed) tabFeed.classList.toggle('is-active', isRight);
    if (tabIndicator) tabIndicator.classList.toggle('is-right', isRight);
  }

  if (tabHome) tabHome.addEventListener('click', () => switchPage(0));
  if (tabFeed) tabFeed.addEventListener('click', () => switchPage(1));
  if (toFeedBtn) toFeedBtn.addEventListener('click', () => switchPage(1));
  if (syncBtn) syncBtn.addEventListener('click', () => syncFromCloud());

  pager.addEventListener('scroll', () => {
    const isRight = pager.scrollLeft > (pager.clientWidth * 0.45);
    updateTabs(isRight);
  }, { passive: true });

  // ユーザー名登録・変更
  function updateUserChip() {
    if (userChipName) {
      userChipName.textContent = userName || '名前を設定';
    }
  }
  welcomeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = nameInput.value.trim();
    if (!val) return;
    userName = val;
    try { localStorage.setItem(USER_KEY, userName); } catch (err) {}
    updateUserChip();
    welcome.hidden = true;
    renderFeed();
  });
  userChip.addEventListener('click', (e) => {
    e.stopPropagation();
    nameInput.value = userName;
    welcome.hidden = false;
    setTimeout(() => nameInput.focus(), 50);
  });

  // 見出しを長押し（約1.5秒）で、録音をすべて消す
  let hold = 0;
  const holdStart = (e) => {
    if (e.target === userChip) return;
    clearTimeout(hold);
    hold = setTimeout(async () => {
      if (!window.confirm('録音をすべて消しますか？')) return;
      stopAll();
      if (rec) stopRec();
      takes.fill(null);
      buffers.fill(null);
      isLowcut.fill(false);
      isShared.fill(false);
      try { await dbClear(); } catch (err) {}
      for (let i = 0; i < N; i++) paint(i);
    }, 1500);
  };
  const holdEnd = () => clearTimeout(hold);
  head.addEventListener('pointerdown', holdStart);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => head.addEventListener(ev, holdEnd));
  head.addEventListener('contextmenu', (e) => e.preventDefault());

  /* ---------- 起動 ---------- */
  async function init() {
    // URLクエリ ?cloud=https://... が指定されていれば保存（GASやWebhook連携用）
    try {
      const params = new URLSearchParams(location.search);
      const cUrl = params.get('cloud');
      if (cUrl) localStorage.setItem(CLOUD_URL_KEY, cUrl);
    } catch (e) {}

    try {
      const v = localStorage.getItem(FX_KEY);
      if (v != null) space.value = v;
      if (spaceVal) spaceVal.textContent = space.value;
      const vv = localStorage.getItem(VOL_KEY);
      if (vv != null) vol.value = vv;
      if (volVal) volVal.textContent = vol.value;
      const savedUser = localStorage.getItem(USER_KEY);
      if (savedUser) {
        userName = savedUser;
      } else {
        welcome.hidden = false;
      }
      updateUserChip();
    } catch (e) {
      welcome.hidden = false;
    }

    // 同一ブラウザ・別タブ間のリアルタイム同期
    try {
      if ('BroadcastChannel' in window) {
        bc = new BroadcastChannel('picnicking_toride_channel');
        bc.onmessage = async (ev) => {
          const data = ev.data;
          if (data && data.type === 'new_post' && data.post) {
            const p = data.post;
            if (p.b64 && !p.buf) {
              try { p.buf = base64ToBuf(p.b64); } catch (e) {}
            }
            const idx = feedPosts.findIndex((x) => x.id === p.id);
            if (idx >= 0) feedPosts[idx] = p;
            else feedPosts.push(p);
            await dbFeedPut(p).catch(() => {});
            renderFeed();
          }
        };
      }
    } catch (e) {}

    try {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
      for (let i = 0; i < N; i++) {
        takes[i] = (await dbGet(i)) || null;
        isLowcut[i] = !!(takes[i] && takes[i].lowcut);
        isShared[i] = !!(takes[i] && takes[i].sharedId);
      }
      const savedPosts = await dbFeedAll();
      if (Array.isArray(savedPosts)) {
        feedPosts = savedPosts.map((p) => {
          if (!p.buf && p.b64) {
            try { p.buf = base64ToBuf(p.b64); } catch (e) {}
          }
          return p;
        });
      }
    } catch (e) {
      say('保存の領域を開けませんでした。リロードすると消えます');
    }

    for (let i = 0; i < N; i++) paint(i);
    renderFeed();
    syncFromCloud();
    startFirebaseListener();
  }
  init();

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
