/* ════════════════════════════════════════════════════════════════════
   MAIA · backend SIMULADO (modo demo, apiBase = null)
   ────────────────────────────────────────────────────────────────────
   Implementa el mismo contrato que la API (docs/API_CONTRACT.md) dentro
   del navegador, para trabajar la interfaz sin Python:
     - los registros y las correcciones se guardan en localStorage;
     - el análisis «tarda» unos segundos y pasa por los mismos estados;
     - hipnograma, probabilidades y señal son sintéticos y deterministas
       (mismo registro → mismos datos).
   Las reglas (umbral, revisión, métricas) son las mismas de la API.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const DB_KEY = "somnoai_v2_db";
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const EP = 30;
  const STAGES = ["W", "N1", "N2", "N3", "REM"];
  const p2 = n => String(n).padStart(2, "0");
  const nowISO = (d = new Date()) =>
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;

  /* misma respuesta que GET /config */
  const CONFIG = {
    stages: STAGES, epoch_s: EP,
    channels: {
      fpz: { label: "EEG Fpz-Cz", kind: "eeg", name: "Fpz-Cz" },
      pz: { label: "EEG Pz-Oz", kind: "eeg", name: "Pz-Oz" },
      eog: { label: "EOG horizontal", kind: "eog", name: "EOG" },
      emg: { label: "EMG submental", kind: "emg", name: "EMG" }
    },
    channel_aliases: {
      fpz: ["^(eeg)?fpz-?cz$"], pz: ["^(eeg)?pz-?oz$"],
      eog: ["^eog(horizontal|horiz|hor|h)?$", "^heog$", "^e1-?e2$", "^loc-?roc$"],
      emg: ["^(emg)?(submental|chin|mentalis)$", "^emg$", "^chinemg$"]
    },
    confidence_threshold: 0.65, night_review_fraction: 0.273, mf1_goal: 0.75,
    window_margin_min: 30, min_window_min: 10, max_upload_mb: 600,
    expected: {
      fpz: { cv_mf1: 0.802, test_mf1: 0.772, test_ci: [0.736, 0.802], test_kappa: 0.750, test_f1_n1: 0.518 },
      fpz_emg: { cv_mf1: 0.805, test_mf1: 0.772, test_ci: [0.735, 0.803], test_kappa: 0.747, test_f1_n1: 0.523 },
      fpz_eog: { cv_mf1: 0.811, test_mf1: 0.782, test_ci: [0.749, 0.811], test_kappa: 0.755, test_f1_n1: 0.533 },
      fpz_eog_emg: { cv_mf1: 0.813, test_mf1: 0.781, test_ci: [0.748, 0.810], test_kappa: 0.752, test_f1_n1: 0.534 },
      pz: { cv_mf1: 0.762, test_mf1: 0.737, test_ci: [0.686, 0.773], test_kappa: 0.704, test_f1_n1: 0.492 },
      pz_emg: { cv_mf1: 0.766, test_mf1: 0.738, test_ci: [0.685, 0.777], test_kappa: 0.702, test_f1_n1: 0.499 },
      pz_eog: { cv_mf1: 0.790, test_mf1: 0.753, test_ci: [0.698, 0.793], test_kappa: 0.718, test_f1_n1: 0.506 },
      pz_eog_emg: { cv_mf1: 0.790, test_mf1: 0.757, test_ci: [0.711, 0.794], test_kappa: 0.722, test_f1_n1: 0.508 },
      eeg2: { cv_mf1: 0.812, test_mf1: 0.780, test_ci: [0.751, 0.805], test_kappa: 0.758, test_f1_n1: 0.522 },
      eeg2_emg: { cv_mf1: 0.814, test_mf1: 0.779, test_ci: [0.750, 0.804], test_kappa: 0.754, test_f1_n1: 0.526 },
      eeg2_eog: { cv_mf1: 0.819, test_mf1: 0.785, test_ci: [0.755, 0.812], test_kappa: 0.759, test_f1_n1: 0.531 },
      eeg2_eog_emg: { cv_mf1: 0.819, test_mf1: 0.784, test_ci: [0.753, 0.810], test_kappa: 0.758, test_f1_n1: 0.534 }
    },
    model: { kind: "mock", version: "simulado-navegador-1.0" }
  };

  /* noches demo reales (encabezados y ventana de sueño tomados de los EDF de Sleep-EDFx) */
  const LABELS = ["EEG Fpz-Cz", "EEG Pz-Oz", "EOG horizontal", "Resp oro-nasal", "EMG submental", "Temp rectal", "Event marker"];
  const FS = { "EEG Fpz-Cz": 100, "EEG Pz-Oz": 100, "EOG horizontal": 100, "Resp oro-nasal": 1, "EMG submental": 1, "Temp rectal": 1, "Event marker": 1 };
  const DETECTED = { fpz: "EEG Fpz-Cz", pz: "EEG Pz-Oz", eog: "EOG horizontal", emg: "EMG submental" };
  const DEMOS = [
    { id: "SC4001E0", subject: 0, night: 1, age: 33, sex: "F", lights_off: "00:38", psg: "SC4001E0-PSG.edf",
      hypnogram: "SC4001EC-Hypnogram.edf", split: "test", featured: true, has_hypnogram: true,
      header: { labels: LABELS, fs: FS, start_clock_s: 58380, duration_s: 79500 }, detected: DETECTED, window: [961, 1802] },
    { id: "SC4331F0", subject: 33, night: 1, age: 60, sex: "M", lights_off: "22:58", psg: "SC4331F0-PSG.edf",
      hypnogram: "SC4331FV-Hypnogram.edf", split: "test", featured: true, has_hypnogram: true,
      header: { labels: LABELS, fs: FS, start_clock_s: 54900, duration_s: 84300 }, detected: DETECTED, window: [886, 2775] },
    { id: "SC4601E0", subject: 60, night: 1, age: 89, sex: "F", lights_off: "21:35", psg: "SC4601E0-PSG.edf",
      hypnogram: "SC4601EC-Hypnogram.edf", split: "test", featured: true, has_hypnogram: true,
      header: { labels: LABELS, fs: FS, start_clock_s: 57900, duration_s: 81900 }, detected: DETECTED, window: [667, 2016] }
  ];

  /* ── azar determinista ── */
  function seedFrom(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pick = (rng, probs) => { let r = rng(), k = 0; while (k < probs.length - 1 && (r -= probs[k]) > 0) k++; return k; };
  const uni = (rng, a, b) => a + rng() * (b - a);

  /* ── noche y predicción sintéticas (mismas reglas que app/model/mock_client.py) ── */
  function syntheticNight(rng, n, onset) {
    const s = new Array(n).fill(0);
    const end = Math.min(n - 20, onset + 900 + Math.floor(rng() * 120));
    let i = onset, cycle = 0;
    while (i < end) {
      for (const [st, len] of [[1, 3 + rng() * 6], [2, 40 + rng() * 24], [3, Math.max(4, (46 - cycle * 11) * uni(rng, .7, 1.3))],
                               [2, 20 + rng() * 22], [4, (22 + cycle * 8) * uni(rng, .7, 1.3)], [0, 1 + rng() * 5]]) {
        const L = Math.floor(len);
        for (let k = i; k < Math.min(i + L, end); k++) s[k] = st;
        i += L;
      }
      cycle++;
    }
    return s;
  }
  const CONFUSION = [[0, .70, .15, 0, .15], [.30, 0, .45, 0, .25], [.05, .40, 0, .50, .05], [0, .05, .95, 0, 0], [.20, .55, .25, 0, 0]];
  const ERR = [0.06, 0.45, 0.10, 0.18, 0.10];

  function predict(rng, truth, combo) {
    const weaker = (1 - CONFIG.expected[combo].test_mf1) / (1 - 0.784), n = truth.length;
    return truth.map((t, i) => {
      const tr = (i > 0 && truth[i - 1] !== t) || (i < n - 1 && truth[i + 1] !== t);
      const wrong = rng() < Math.min(0.9, ERR[t] * weaker * (tr ? 1.8 : 1));
      const pred = wrong ? pick(rng, CONFUSION[t]) : t;
      let second = wrong && rng() < 0.86 ? t : pick(rng, CONFUSION[t]);
      if (second === pred) second = (pred + 1) % 5;
      let conf = wrong ? uni(rng, .36, .72) : 0.45 + 0.55 * Math.pow(rng(), 0.18);
      if (tr && !wrong) conf *= uni(rng, .75, 1);
      conf = Math.min(.995, Math.max(.34, conf));
      const rest = 1 - conf, share = Math.min(uni(rng, .55, .9) * rest, conf - .02);
      const p = [0, 0, 0, 0, 0];
      p[pred] = conf; p[second] = share;
      const others = [0, 1, 2, 3, 4].filter(k => k !== pred && k !== second);
      const w = others.map(() => rng() + 0.01), ws = w.reduce((a, b) => a + b, 0);
      others.forEach((k, j) => { p[k] = (rest - share) * w[j] / ws; });
      return p;
    });
  }

  /* ── reglas de la API: decisión, revisión y métricas ── */
  const r3 = v => Math.round(v * 1000) / 1000, r1 = v => (v == null ? null : Math.round(v * 10) / 10);

  function decide(probs, thr) {
    const stage = [], second = [], confidence = [], review = [];
    probs.forEach(p => {
      const o = [0, 1, 2, 3, 4].sort((a, b) => p[b] - p[a] || a - b);
      stage.push(o[0]); second.push(o[1]); confidence.push(r3(p[o[0]])); review.push(p[o[0]] < thr ? 1 : 0);
    });
    return { stage, second, confidence, review, probs: probs.map(p => p.map(r3)) };
  }

  function architecture(stages, lo) {
    const start = Math.min(Math.max(lo || 0, 0), stages.length), s = stages.slice(start), m = EP / 60;
    const sleep = s.map(v => v >= 1 && v <= 4);
    const tib = s.length * m, tst = sleep.filter(Boolean).length * m;
    const out = { tib_min: r1(tib), tst_min: r1(tst), efficiency_pct: tib ? r1(100 * tst / tib) : null,
                  sol_min: null, rem_latency_min: null, waso_min: null, awakenings: 0, stages: {} };
    STAGES.forEach((name, k) => {
      const min = s.filter(v => v === k).length * m, base = k === 0 ? tib : tst;
      out.stages[name] = { min: r1(min), pct: base ? r1(100 * min / base) : 0 };
    });
    const onset = sleep.indexOf(true);
    if (onset >= 0) {
      const last = sleep.lastIndexOf(true), rem = s.indexOf(4, onset);
      out.sol_min = r1(onset * m);
      out.rem_latency_min = rem >= 0 ? r1((rem - onset) * m) : null;
      let waso = 0, run = 0, aw = 0;
      for (let i = onset; i <= last + 1; i++) {
        if (i <= last && s[i] === 0) { waso++; run++; } else { if (run >= 2) aw++; run = 0; }
      }
      out.waso_min = r1(waso * m);
      out.awakenings = aw;
    }
    return out;
  }

  function agreement(pred, ref) {
    const cm = STAGES.map(() => [0, 0, 0, 0, 0]);
    let n = 0;
    ref.forEach((r, i) => { if (r >= 0 && pred[i] >= 0) { cm[r][pred[i]]++; n++; } });
    if (!n) return null;
    const tp = cm.map((r, i) => r[i]), rows = cm.map(r => r.reduce((a, b) => a + b, 0)),
          cols = STAGES.map((_, j) => cm.reduce((a, r) => a + r[j], 0));
    const f1 = tp.map((v, i) => (rows[i] + cols[i] ? 2 * v / (rows[i] + cols[i]) : null));
    const present = f1.filter(v => v != null);
    const po = tp.reduce((a, b) => a + b, 0) / n, pe = rows.reduce((a, r, i) => a + r * cols[i], 0) / (n * n);
    return { n_epochs: n, accuracy: r3(po), mf1: r3(present.reduce((a, b) => a + b, 0) / present.length),
             kappa: pe < 1 ? r3((po - pe) / (1 - pe)) : 1, f1: Object.fromEntries(STAGES.map((s, i) => [s, r3(f1[i] || 0)])),
             confusion: cm };
  }

  function reviewState(ep, corr, signed, frac) {
    const flagged = ep.review.reduce((a, f, i) => (f ? [...a, i] : a), []);
    const resolved = flagged.filter(i => i in corr);
    const n = ep.stage.length;
    return {
      status: signed.by ? "signed_off" : Object.keys(corr).length ? "in_progress" : "pending",
      n_epochs: n, flagged: flagged.length, flagged_fraction: r3(flagged.length / n * 10) / 10,
      whole_night_recommended: flagged.length / n > frac, resolved: resolved.length, pending: flagged.length - resolved.length,
      confirmed: resolved.filter(i => corr[i].stage === ep.stage[i]).length,
      corrected: Object.entries(corr).filter(([i, c]) => c.stage !== ep.stage[+i]).length,
      signed_off_by: signed.by || null, signed_off_at: signed.at || null
    };
  }

  /* ── base de datos local ── */
  let _db = null;
  function db() {
    if (_db) return _db;
    try { _db = JSON.parse(localStorage.getItem(DB_KEY)); } catch (e) { _db = null; }
    if (!_db) {
      _db = { records: [] };
      const t = Date.now();
      [["SC4001E0", ["fpz", "pz", "eog", "emg"], 50], ["SC4331F0", ["fpz", "eog"], 30], ["SC4601E0", ["pz"], 10]]
        .forEach(([id, ch, minAgo], k) => newRecord(demoSpec(DEMOS.find(d => d.id === id), ch, "reference", null, null, undefined),
          "Sistema", new Date(t - minAgo * 60000), "seed" + k));
      save();
    }
    return _db;
  }
  function save() { try { localStorage.setItem(DB_KEY, JSON.stringify(_db)); } catch (e) { /* modo efímero */ } }

  const keyFor = slots => {
    const s = new Set(slots);
    return (s.has("fpz") && s.has("pz") ? "eeg2" : s.has("fpz") ? "fpz" : "pz") + (s.has("eog") ? "_eog" : "") + (s.has("emg") ? "_emg" : "");
  };
  const nameFor = slots => Object.keys(CONFIG.channels).filter(s => slots.includes(s)).map(s => CONFIG.channels[s].name).join(" + ");
  const offset = (clock, startClock) => {
    const [h, m] = clock.split(":").map(Number);
    return (((h * 3600 + m * 60) - startClock) % 86400 + 86400) % 86400;
  };

  function resolveWindow(mode, header, refWindow, startClock, endClock) {
    const total = Math.floor(header.duration_s / EP);
    if (mode === "reference") {
      if (!refWindow) throw { code: "invalid_file", message: "La ventana del hipnograma necesita el hipnograma de referencia." };
      return refWindow;
    }
    if (mode === "range") {
      if (!startClock || !endClock) throw { code: "invalid_file", message: "Indique la hora de inicio y la de fin del análisis." };
      const s0 = offset(startClock, header.start_clock_s);
      let s1 = offset(endClock, header.start_clock_s);
      if (s1 <= s0) s1 += 86400;
      if (s0 >= header.duration_s) throw { code: "invalid_file", message: `La hora de inicio ${startClock} queda fuera del registro.` };
      const w = [Math.floor(s0 / EP), Math.min(Math.floor(s1 / EP), total)];
      if (w[1] - w[0] < 20) throw { code: "invalid_file", message: "La ventana de análisis es demasiado corta: el mínimo son 10 minutos." };
      return w;
    }
    return [0, total];
  }

  function validateChannels(channels, available) {
    if (!channels.length || !(channels.includes("fpz") || channels.includes("pz"))) {
      throw { code: "invalid_channels", message: "El modelo necesita al menos un EEG: seleccione Fpz-Cz o Pz-Oz." };
    }
    const missing = channels.filter(c => !available[c]);
    if (missing.length) throw { code: "invalid_channels", message: `El archivo no tiene ${missing.map(c => CONFIG.channels[c].label).join(", ")}.` };
  }

  function demoSpec(d, channels, mode, startClock, endClock, lightsOff) {
    const w = resolveWindow(mode || "reference", d.header, d.window, startClock, endClock);
    const lo = lightsOff === undefined || lightsOff === null ? d.lights_off : (lightsOff === "none" ? null : lightsOff);
    return { source: "demo", file_name: d.psg, header: d.header, channels, available: d.detected, window: w,
             mode: mode || "reference", has_ref: true, lights_off: lo, lights_off_source: lo ? (lo === d.lights_off ? "dataset-index" : "manual") : null,
             dataset: { id: d.id, subject: d.subject, night: d.night, age: d.age, sex: d.sex, lights_off: d.lights_off, split: d.split },
             sex: d.sex, age: d.age, size_mb: 48 };
  }

  function newRecord(spec, author, at = new Date(), salt = "") {
    const id = (spec.file_name.replace(/\.(edf|zip)$/i, "").slice(0, 8) + "-" + (at.getTime() + salt).toString(36)).toLowerCase();
    const m = /^SC4(\d\d)\d/i.exec(spec.file_name);
    const rec = {
      id, created_at: nowISO(at), spec, corrections: {}, history: [], signed: {},
      summary: {
        id, created_at: nowISO(at), created_by: author, source: spec.source, file_name: spec.file_name,
        subject_code: m ? "SC" + m[1] : spec.file_name.slice(0, 8).toUpperCase(), sex: spec.sex || null, age: spec.age || null,
        channels: spec.channels, combination: keyFor(spec.channels), combination_name: nameFor(spec.channels),
        window_mode: spec.mode, n_epochs: spec.window[1] - spec.window[0], has_reference: spec.has_ref,
        dataset_split: spec.dataset ? spec.dataset.split : null, model_version: CONFIG.model.version
      }
    };
    db().records.unshift(rec);
    save();
    return rec;
  }

  /* ── estado del análisis según el tiempo transcurrido (simula el trabajo en segundo plano) ── */
  const STEPS = [[1200, "queued", "En cola"], [2400, "reading", "Leyendo el registro"],
                 [4600, "staging", "Estadificando con simulado-navegador-1.0"], [5600, "metrics", "Calculando métricas"]];
  function statusOf(rec) {
    const el = Date.now() - new Date(rec.created_at).getTime();
    for (const [ms, step, message] of STEPS) {
      if (el < ms) return { status: step === "queued" ? "queued" : "running", progress: { step, label: message, message } };
    }
    return { status: "done", progress: null };
  }

  const cache = new Map();
  function base(rec) {
    if (cache.has(rec.id)) return cache.get(rec.id);
    const sp = rec.spec, rng = mulberry32(seedFrom(rec.id));
    const n = sp.window[1] - sp.window[0];
    const loEpoch = sp.lights_off ? Math.floor(offset(sp.lights_off, sp.header.start_clock_s) / EP) - sp.window[0] : null;
    const onset = sp.mode === "reference" ? 60 : Math.max(0, (loEpoch != null ? loEpoch : 60) + 30);
    const truth = syntheticNight(rng, n, onset);
    const combo = keyFor(sp.channels);
    const ep = decide(predict(rng, truth, combo), CONFIG.confidence_threshold);
    ep.reference = sp.has_ref ? truth.map(v => (rng() < 0.003 ? -1 : v)) : null;
    const ex = CONFIG.expected[combo];
    const totalH = sp.header.duration_s / 3600, wh = n * EP / 3600, bh = sp.window[0] * EP / 3600;
    const d = {
      ...rec.summary, status: "done", finished_at: rec.created_at,
      patient: { age: sp.age || null, sex: sp.sex || null, source: sp.age ? "edf-header" : null },
      channels: { selected: sp.channels, combination: combo, combination_name: nameFor(sp.channels),
                  mask: Object.keys(CONFIG.channels).map(s => sp.channels.includes(s)),
                  map: Object.fromEntries(sp.channels.map(s => [s, sp.available[s]])), available: sp.available,
                  file_labels: sp.header.labels, fs: Object.fromEntries(Object.entries(sp.available).map(([s, l]) => [s, sp.header.fs[l] || 100])) },
      model: { version: CONFIG.model.version, kind: "mock", threshold: CONFIG.confidence_threshold,
               night_review_fraction: CONFIG.night_review_fraction,
               notes: ["Resultados simulados en el navegador (modo demo): no provienen de ningún modelo."],
               expected: { ...ex, below_goal: ex.test_mf1 < CONFIG.mf1_goal, goal_mf1: CONFIG.mf1_goal } },
      night: { epoch_s: EP, n_epochs: n, start_epoch: sp.window[0],
               start_clock_s: sp.header.start_clock_s != null ? sp.header.start_clock_s + sp.window[0] * EP : null,
               window: { mode: sp.mode, start_s: sp.window[0] * EP, end_s: sp.window[1] * EP },
               lights_off_clock: sp.lights_off, lights_off_source: sp.lights_off_source, lights_off_epoch: loEpoch },
      epochs: ep,
      metrics: { predicted: architecture(ep.stage, loEpoch), reference: ep.reference ? architecture(ep.reference, loEpoch) : null },
      agreement: ep.reference ? { predicted: agreement(ep.stage, ep.reference) } : null,
      quality: {
        file: { name: sp.file_name, size_mb: sp.size_mb, start: null, start_clock_s: sp.header.start_clock_s,
                total_duration_s: sp.header.duration_s, channels: sp.header.labels.length, sampling_hz: 100 },
        composition: [{ label: "Antes de la ventana", hours: bh, kind: "outside" }, { label: "Ventana analizada", hours: wh, kind: "window" },
                      { label: "Después de la ventana", hours: totalH - bh - wh, kind: "outside" }].filter(s => s.hours > 0.01),
        reference_unscored: ep.reference ? ep.reference.filter(v => v < 0).length : null,
        timings: { read_s: 0.4, model_s: 2.2, total_s: 2.9 }
      },
      dataset: sp.dataset || null
    };
    cache.set(rec.id, d);
    return d;
  }

  function dynamic(rec) {
    const d = base(rec), corr = rec.corrections;
    const final = d.epochs.stage.map((s, i) => (i in corr ? corr[i].stage : s));
    return {
      final, metrics_final: architecture(final, d.night.lights_off_epoch),
      agreement_final: d.epochs.reference ? agreement(final, d.epochs.reference) : null,
      corrections: Object.entries(corr).map(([e, c]) => ({ epoch: +e, ...c })).sort((a, b) => a.epoch - b.epoch),
      review: reviewState(d.epochs, corr, rec.signed, d.model.night_review_fraction),
      history: rec.history.slice(0, 100)
    };
  }

  const find = id => {
    const rec = db().records.find(r => r.id === id);
    if (!rec) throw { code: "not_found", message: "El registro no existe." };
    return rec;
  };

  function summaryOf(rec) {
    const st = statusOf(rec);
    return { ...rec.summary, ...st, error: null, review: st.status === "done" ? dynamic(rec).review : null };
  }

  /* ── señal sintética por estadio y modalidad ── */
  function sigAt(slot, st, t) {
    const r = n => { const x = Math.sin(t * n + n * 7.13) * 43758.5453; return x - Math.floor(x) - 0.5; };
    const sin = (f, ph = 0) => Math.sin(2 * Math.PI * f * t + ph);
    if (slot === "emg") return [4, 3, 2.4, 2, 0.8][st] + 0.4 * r(13.1);
    if (slot === "eog") {
      if (st === 4) return 140 * Math.tanh(4 * sin(0.45)) * (r(3.3) > 0.1 ? 1 : -1) + 12 * r(51.7);
      if (st === 0) return 90 * Math.exp(-Math.pow(((t % 4.3) - 2) / 0.12, 2)) + 40 * sin(0.3) + 12 * r(47.9);
      if (st === 1) return 70 * sin(0.25) + 10 * r(39.1);
      return 18 * sin(1.2) + 8 * r(33.7);
    }
    const alpha = slot === "pz" ? 1.6 : 1;
    if (st === 0) return 22 * alpha * sin(10.2) * (0.45 + 0.55 * sin(0.31)) + 14 * r(91.7) + 8 * sin(23.4);
    if (st === 1) return 20 * sin(5.6) + 10 * sin(7.9) + 12 * r(83.1);
    if (st === 2) {
      const sp = Math.exp(-Math.pow(((t % 17) - 8.5) / 0.5, 2)), kc = Math.exp(-Math.pow(((t % 43) - 21) / 0.6, 2));
      return (0.6 + 0.4 * sin(0.041)) * 20 * sin(3.1) + 30 * sp * sin(13.3) + 55 * kc * sin(0.85) + 11 * r(77.3);
    }
    if (st === 3) return (0.5 + 0.5 * sin(0.055)) * (48 * sin(1.05) + 21 * sin(2.3, 1.1)) + 13 * r(69.9);
    return 15 * sin(6.4) + 9 * sin(9.1) + 13 * r(61.3);
  }

  function csvDownload(text, name) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ══════════════ interfaz pública (misma forma que la API real) ══════════════ */
  window.MaiaMock = {
    async login(username, password) {
      await delay(380);
      if (username === "superusuario" && password === "somnoai2026") {
        return { token: "demo-token", user: { username, name: "Superusuario", initials: "SU" } };
      }
      throw { code: "invalid_credentials", message: "Usuario o contraseña incorrectos." };
    },
    async getConfig() { await delay(60); return CONFIG; },
    async listDemos() { await delay(120); return { demos: DEMOS }; },
    async lookupNight(fileName) {
      const d = DEMOS.find(x => x.psg.slice(0, 6) === fileName.slice(0, 6).toUpperCase());
      return { night: d ? { id: d.id, subject: d.subject, night: d.night, age: d.age, sex: d.sex,
        lights_off: d.lights_off, psg: d.psg, hypnogram: d.hypnogram, split: d.split } : null };
    },

    async createDemoAnalysis({ demoId, channels, windowMode, startClock, endClock, lightsOff }) {
      await delay(250);
      const d = DEMOS.find(x => x.id === demoId);
      if (!d) throw { code: "not_found", message: "Registro demo desconocido." };
      validateChannels(channels, d.detected);
      return summaryOf(newRecord(demoSpec(d, channels, windowMode, startClock, endClock, lightsOff), "Superusuario"));
    },

    async createAnalysis({ file, hypnogram, channels, channelMap, windowMode, startClock, endClock, lightsOff }) {
      await delay(500);
      let header = null, name = file.name;
      if (/\.zip$/i.test(file.name)) {
        const z = await MaiaEdf.readZip(file);
        if (z && z.psg) { header = z.psg.header; name = z.psg.name; if (z.hypnogram) hypnogram = hypnogram || true; }
      } else header = await MaiaEdf.readEdf(file);
      if (!header || !header.durationS) throw { code: "invalid_file", message: "El modo demo no pudo leer el encabezado del archivo." };
      const available = { ...MaiaEdf.detect(header.labels, CONFIG.channel_aliases), ...(channelMap || {}) };
      validateChannels(channels, available);
      const h = { labels: header.labels, fs: header.fs, start_clock_s: header.startClockS, duration_s: header.durationS };
      const total = Math.floor(h.duration_s / EP);
      const refWindow = hypnogram ? [Math.min(total - 40, 40), Math.min(total, 40 + 1000)] : null;
      const w = resolveWindow(windowMode || (refWindow ? "reference" : "full"), h, refWindow, startClock, endClock);
      const lo = lightsOff && lightsOff !== "none" ? lightsOff : null;
      return summaryOf(newRecord({
        source: "upload", file_name: name, header: h, channels, available, window: w, mode: windowMode || "full",
        has_ref: !!hypnogram, lights_off: lo, lights_off_source: lo ? "manual" : null, dataset: null,
        sex: header.patient.sex, age: header.patient.age, size_mb: Math.round(file.size / 104857.6) / 10
      }, "Superusuario"));
    },

    async listRecords() { await delay(150); return { records: db().records.map(summaryOf) }; },

    async getRecord(id) {
      await delay(160);
      const rec = find(id), st = statusOf(rec);
      if (st.status !== "done") return summaryOf(rec);
      const d = base(rec), dyn = dynamic(rec);
      return { ...d, epochs: { ...d.epochs, final: dyn.final }, metrics: { ...d.metrics, final: dyn.metrics_final },
               agreement: d.agreement ? { ...d.agreement, final: dyn.agreement_final } : null,
               corrections: dyn.corrections, review: dyn.review, history: dyn.history };
    },

    async deleteRecord(id) {
      await delay(200);
      const recs = db().records, i = recs.findIndex(r => r.id === id);
      if (i < 0) throw { code: "not_found", message: "El registro no existe." };
      recs.splice(i, 1);
      cache.delete(id);
      save();
      return { deleted: id };
    },

    async getSignal(id, startS, durationS, points, channels) {
      await delay(60);
      const rec = find(id), d = base(rec), fin = dynamic(rec).final;
      const traces = {};
      channels.filter(c => c in d.channels.available).forEach(slot => {
        const min = new Array(points), max = new Array(points), sub = durationS <= 120 ? 6 : 12;
        for (let i = 0; i < points; i++) {
          const ta = startS + (i / points) * durationS, tb = startS + ((i + 1) / points) * durationS;
          let mn = Infinity, mx = -Infinity;
          for (let k = 0; k < sub; k++) {
            const t = ta + (k / sub) * (tb - ta);
            const st = fin[Math.max(0, Math.min(fin.length - 1, Math.floor(t / EP)))];
            const v = sigAt(slot, st, t);
            if (v < mn) mn = v;
            if (v > mx) mx = v;
          }
          min[i] = Math.round(mn * 10) / 10;
          max[i] = Math.round(mx * 10) / 10;
        }
        traces[slot] = { min, max };
      });
      return { start_s: startS, duration_s: durationS, points, unit: "µV", traces };
    },

    async changeEpochs(id, changes) {
      await delay(90);
      const rec = find(id), d = base(rec);
      if (rec.signed.by) throw { code: "review_locked", message: "La revisión está finalizada. Reábrala para hacer cambios." };
      const at = nowISO();
      changes.forEach(({ epoch, stage }) => {
        const prev = epoch in rec.corrections ? rec.corrections[epoch].stage : d.epochs.stage[epoch];
        if (stage == null) delete rec.corrections[epoch];
        else rec.corrections[epoch] = { stage, author: "Superusuario", at };
        rec.history.unshift({ at, author: "Superusuario", action: stage == null ? "clear" : "set", epoch, stage, previous: prev });
      });
      save();
      return dynamic(rec);
    },

    async reviewAction(id, action) {
      await delay(150);
      const rec = find(id);
      rec.signed = action === "sign_off" ? { by: "Superusuario", at: nowISO() } : {};
      rec.history.unshift({ at: nowISO(), author: "Superusuario", action, epoch: null, stage: null, previous: null });
      save();
      return dynamic(rec);
    },

    async download(path, fallbackName) {
      const m = /^\/records\/([^/]+)\/export\.csv$/.exec(path);
      if (m) {
        const rec = find(decodeURIComponent(m[1])), d = base(rec), dyn = dynamic(rec), ep = d.epochs;
        const rows = ep.stage.map((s, i) => [i, d.night.start_epoch * EP + i * EP, STAGES[s], ep.confidence[i], STAGES[ep.second[i]],
          ...ep.probs[i], ep.review[i], STAGES[dyn.final[i]], ep.reference ? (ep.reference[i] >= 0 ? STAGES[ep.reference[i]] : "?") : ""].join(","));
        return csvDownload(["epoca,inicio_s,prediccion,confianza,segunda_opcion,p_W,p_N1,p_N2,p_N3,p_REM,marcada_revisar,estadio_final,referencia",
          ...rows].join("\n"), `${d.file_name.replace(/\.edf$/i, "")}_${d.combination}.csv`);
      }
      const rows = [];
      db().records.forEach(rec => Object.entries(rec.corrections).forEach(([e, c]) => {
        const d = base(rec);
        rows.push([rec.id, d.file_name, d.combination, e, STAGES[d.epochs.stage[e]], STAGES[c.stage], c.author, c.at].join(","));
      }));
      csvDownload(["registro,archivo,combinacion,epoca,prediccion,estadio_especialista,autor,fecha", ...rows].join("\n"), fallbackName);
    },

    reset() { localStorage.removeItem(DB_KEY); _db = null; cache.clear(); }
  };
})();
