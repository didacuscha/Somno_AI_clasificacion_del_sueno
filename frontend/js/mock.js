/* ════════════════════════════════════════════════════════════════════
   MAIA · backend SIMULADO (modo demo, apiBase = null)
   ────────────────────────────────────────────────────────────────────
   Implementa el mismo contrato que la API (docs/API_CONTRACT.md) dentro
   del navegador, para mostrar la interfaz sin Python:
     - los registros, decisiones y notas se guardan en localStorage;
     - el análisis «tarda» unos segundos y pasa por los mismos pasos;
     - hipnograma, probabilidades, señal y evidencia son sintéticos y
       deterministas (mismo registro → mismos datos).
   Las reglas (umbral, revisión, métricas) son las mismas de la API.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const DB_KEY = "somnoai_v2_db_2";
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const EP = 30;
  const STAGES = ["W", "N1", "N2", "N3", "REM"];
  const USER = "Superusuario";
  const p2 = n => String(n).padStart(2, "0");
  const nowISO = (d = new Date()) =>
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  const fail = (code, message) => { throw { code, message }; };

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
    channel_kinds: {
      eeg: ["eeg", "^(fp|af|f|fc|c|cp|p|po|o|t|tp|ft)[0-9z]{1,2}(-?((fp|af|f|fc|c|cp|p|po|o|t|tp|ft)[0-9z]{1,2}|[am][12]|ref|avg))?$"],
      eog: ["eog", "^(loc|roc|e1|e2)(-?([am][12]|loc|roc|e1|e2))?$"],
      emg: ["emg", "chin", "submental", "mentalis"]
    },
    confidence_threshold: 0.65, night_review_fraction: 0.273, mf1_goal: 0.75,
    window_margin_min: 30, min_window_min: 10, max_upload_mb: 600, max_note_chars: 2000,
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
    expected_source: "Modelo del proyecto, Tabla IV del informe (test, 16 sujetos)",
    model: { kind: "mock", name: "Modelo simulado (navegador)", version: "simulado-navegador-2.0", threshold: 0.65,
             night_review_fraction: 0.273, expected_source: "Modelo del proyecto, Tabla IV del informe (test, 16 sujetos)" },
    bands: [
      { key: "delta", label: "Delta", lo: 0.5, hi: 4 }, { key: "theta", label: "Theta", lo: 4, hi: 8 },
      { key: "alpha", label: "Alfa", lo: 8, hi: 12 }, { key: "sigma", label: "Sigma (husos)", lo: 12, hi: 15 },
      { key: "beta", label: "Beta", lo: 15, hi: 30 }
    ],
    steps: [{ key: "load", label: "Cargar señales" }, { key: "preprocess", label: "Preprocesar" },
            { key: "predict", label: "Predecir" }, { key: "flag", label: "Marcar épocas" }, { key: "save", label: "Guardar" }],
    catalog: { kind: "local", location: "modo demo (navegador)" }
  };
  const SLOTS = Object.keys(CONFIG.channels);

  /* ── canales: mismas reglas que app/channels.py ── */
  const norm = l => l.trim().toLowerCase().replace(/[–—]/g, "-").replace(/[\s_.]+/g, "");
  const RX = (pats, anchored) => pats.map(p => new RegExp(p));
  const ALIAS = Object.fromEntries(Object.entries(CONFIG.channel_aliases).map(([k, v]) => [k, RX(v)]));
  const KINDS = Object.fromEntries(Object.entries(CONFIG.channel_kinds).map(([k, v]) => [k, RX(v)]));
  const matchSlot = l => SLOTS.find(s => ALIAS[s].some(r => r.test(norm(l)))) || null;
  const kindOf = l => {
    const s = matchSlot(l);
    if (s) return CONFIG.channels[s].kind;
    return Object.keys(KINDS).find(k => KINDS[k].some(r => r.test(norm(l)))) || null;
  };
  function inspect(labels, fs) {
    const sig = labels.filter(l => l !== "EDF Annotations");
    const matched = {};
    sig.forEach(l => { const s = matchSlot(l); if (s && !matched[s]) matched[s] = l; });
    const rows = sig.map(l => ({ label: l, fs: (fs || {})[l] ?? null, kind: kindOf(l),
                                 match: Object.keys(matched).find(s => matched[s] === l) || null, usable: !!kindOf(l) }));
    return { channels: rows, matched,
             candidates: Object.fromEntries(SLOTS.map(s => [s, sig.filter(l => kindOf(l) === CONFIG.channels[s].kind)])),
             total: sig.length, usable: rows.filter(r => r.usable).length, unused: rows.filter(r => !r.usable).map(r => r.label),
             has_eeg: rows.some(r => r.kind === "eeg") };
  }
  function resolveChannels(selected, cmap, labels) {
    if (!selected.length) fail("invalid_channels", "Seleccione al menos un canal.");
    if (!selected.includes("fpz") && !selected.includes("pz")) fail("invalid_channels", "El modelo necesita al menos un EEG: seleccione Fpz-Cz o Pz-Oz.");
    const det = inspect(labels).matched, out = {};
    Object.entries(cmap || {}).forEach(([s, l]) => {
      if (!labels.includes(l)) fail("invalid_channels", `El canal «${l}» no está en el archivo.`);
      if (kindOf(l) !== CONFIG.channels[s].kind) fail("invalid_channels", `El canal «${l}» no se puede asignar a ${CONFIG.channels[s].label}: el modelo no lo usa.`);
    });
    SLOTS.filter(s => selected.includes(s)).forEach(s => {
      const l = (cmap || {})[s] || det[s];
      if (!l) fail("invalid_channels", `El archivo no tiene un canal reconocible como ${CONFIG.channels[s].label}.`);
      if (Object.values(out).includes(l)) fail("invalid_channels", `Un mismo canal del archivo («${l}») no puede ocupar dos entradas del modelo.`);
      out[s] = l;
    });
    return out;
  }

  /* noches demo reales (encabezados y ventana de sueño tomados de los EDF de Sleep-EDFx) */
  const LABELS = ["EEG Fpz-Cz", "EEG Pz-Oz", "EOG horizontal", "Resp oro-nasal", "EMG submental", "Temp rectal", "Event marker"];
  const FS = { "EEG Fpz-Cz": 100, "EEG Pz-Oz": 100, "EOG horizontal": 100, "Resp oro-nasal": 1, "EMG submental": 1, "Temp rectal": 1, "Event marker": 1 };
  const BASE = [
    { label: "SC4001E0", subject: 0, night: 1, age: 33, sex: "F", lights_off: "00:38", hyp: "SC4001EC-Hypnogram.edf", start: 58380, dur: 79500, window: [961, 1802] },
    { label: "SC4331F0", subject: 33, night: 1, age: 60, sex: "M", lights_off: "22:58", hyp: "SC4331FV-Hypnogram.edf", start: 54900, dur: 84300, window: [886, 2775] },
    { label: "SC4601E0", subject: 60, night: 1, age: 89, sex: "F", lights_off: "21:35", hyp: "SC4601EC-Hypnogram.edf", start: 57900, dur: 81900, window: [667, 2016] }
  ];
  const DROP = { fpz: "EEG Fpz-Cz", pz: "EEG Pz-Oz", eog: "EOG horizontal", emg: "EMG submental" };
  function night(b, keep) {
    const labels = keep ? LABELS.filter(l => !Object.values(DROP).includes(l) || keep.some(s => DROP[s] === l)) : LABELS;
    const combo = keep ? keyFor(keep) : null;
    const insp = inspect(labels, FS);
    return {
      id: keep ? `subsets/${b.label}-${combo}/${b.label}-PSG.edf` : `${b.label}-PSG.edf`, label: b.label, psg: `${b.label}-PSG.edf`,
      hypnogram: b.hyp, folder: keep ? `subsets/${b.label}-${combo}` : "", subset: !!keep, size_mb: keep ? 22 : 48,
      subject: b.subject, night: b.night, age: b.age, sex: b.sex, lights_off: b.lights_off, split: "test",
      featured: !keep, has_hypnogram: true,
      header: { labels, fs: FS, duration_s: b.dur, start_clock_s: b.start, n_channels: labels.length, patient: { age: b.age, sex: b.sex } },
      channels: insp, available: SLOTS.filter(s => insp.matched[s]), _window: b.window
    };
  }
  const keyFor = slots => {
    const s = new Set(slots);
    return (s.has("fpz") && s.has("pz") ? "eeg2" : s.has("fpz") ? "fpz" : "pz") + (s.has("eog") ? "_eog" : "") + (s.has("emg") ? "_emg" : "");
  };
  const nameFor = slots => SLOTS.filter(s => slots.includes(s)).map(s => CONFIG.channels[s].name).join(" + ");
  const NIGHTS = [...BASE.map(b => night(b)), night(BASE[0], ["pz"]), night(BASE[1], ["fpz", "eog"]), night(BASE[2], ["fpz", "pz", "emg"])];
  const pub = n => Object.fromEntries(Object.entries(n).filter(([k]) => !k.startsWith("_")));

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

  /* ── noche y predicción sintéticas (mismas reglas que app/model/mock.py) ── */
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

  function reviewState(ep, corr, fin, frac) {
    const flagged = ep.review.reduce((a, f, i) => (f ? [...a, i] : a), []);
    const resolved = flagged.filter(i => i in corr);
    const n = ep.stage.length, whole = flagged.length / n > frac;
    const ent = Object.entries(corr);
    return {
      status: fin.by ? "finalized" : ent.length ? "in_review" : whole ? "full_review_suggested" : "to_review",
      n_epochs: n, flagged: flagged.length, flagged_fraction: Math.round(flagged.length / n * 10000) / 10000,
      whole_night_recommended: whole, resolved: resolved.length, pending: flagged.length - resolved.length,
      confirmed: ent.filter(([i, c]) => c.stage === ep.stage[+i]).length,
      corrected: ent.filter(([i, c]) => c.stage !== ep.stage[+i]).length,
      finalized_by: fin.by || null, finalized_at: fin.at || null
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
      [[NIGHTS[0], ["fpz", "pz", "eog", "emg"], 50], [NIGHTS[1], ["fpz", "eog"], 30], [NIGHTS[2], ["pz"], 10]]
        .forEach(([n, ch], k) => newRecord(specFor(n, ch, "reference", null, null, undefined), "Sistema", new Date(t - (50 - 10 * k) * 60000), "seed" + k));
      save();
    }
    return _db;
  }
  function save() { try { localStorage.setItem(DB_KEY, JSON.stringify(_db)); } catch (e) { /* modo efímero */ } }

  const offset = (clock, startClock) => {
    const [h, m] = clock.split(":").map(Number);
    return (((h * 3600 + m * 60) - startClock) % 86400 + 86400) % 86400;
  };

  function resolveWindow(mode, header, refWindow, startClock, endClock) {
    const total = Math.floor(header.duration_s / EP);
    if (mode === "reference") {
      if (!refWindow) fail("invalid_file", "La ventana del hipnograma necesita el hipnograma de referencia.");
      return refWindow;
    }
    if (mode === "range") {
      if (!startClock || !endClock) fail("invalid_file", "Indique la hora de inicio y la de fin del análisis.");
      const s0 = offset(startClock, header.start_clock_s);
      let s1 = offset(endClock, header.start_clock_s);
      if (s1 <= s0) s1 += 86400;
      if (s0 >= header.duration_s) fail("invalid_file", `La hora de inicio ${startClock} queda fuera del registro.`);
      const w = [Math.floor(s0 / EP), Math.min(Math.floor(s1 / EP), total)];
      if (w[1] - w[0] < 20) fail("invalid_file", "La ventana de análisis es demasiado corta: el mínimo son 10 minutos.");
      return w;
    }
    return [0, total];
  }

  function specFor(n, channels, mode, startClock, endClock, lightsOff, cmap) {
    const map = resolveChannels(channels, cmap, n.header.labels);
    const w = resolveWindow(mode || "reference", n.header, n._window, startClock, endClock);
    const lo = lightsOff === undefined || lightsOff === null ? n.lights_off : (lightsOff === "none" ? null : lightsOff);
    return { source: "catalog", source_id: n.id, label: n.label, subset: n.subset, file_name: n.psg, header: n.header, channels: SLOTS.filter(s => map[s]),
             map, available: n.channels.matched, window: w, mode: mode || "reference", has_ref: true, lights_off: lo,
             lights_off_source: lo ? (lo === n.lights_off ? "dataset-index" : "manual") : null,
             dataset: { id: n.label, subject: n.subject, night: n.night, age: n.age, sex: n.sex, lights_off: n.lights_off, split: n.split },
             sex: n.sex, age: n.age, size_mb: n.size_mb, unused: n.channels.unused };
  }

  function newRecord(spec, author, at = new Date(), salt = "") {
    const id = (spec.file_name.replace(/\.(edf|zip)$/i, "").slice(0, 8) + "-" + (at.getTime() + salt).toString(36)).toLowerCase();
    const m = /^SC4(\d\d)\d/i.exec(spec.file_name);
    const rec = {
      id, created_at: nowISO(at), started: at.getTime(), spec, corrections: {}, history: [], notes: [], finalized: {},
      summary: {
        id, created_at: nowISO(at), created_by: author, source: spec.source, source_id: spec.source_id, night_label: spec.label,
        subset: !!spec.subset, file_name: spec.file_name,
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

  /* ── pasos del análisis según el tiempo transcurrido (simula el trabajo en segundo plano) ── */
  const TIMES = [700, 1700, 2300, 4300, 4900, 5300];       // fin de: cola, load, preprocess, predict, flag, save
  const MSG = { load: "Leyendo el EDF", predict: "Estadificando con " + CONFIG.model.name };
  function progressOf(rec) {
    const el = Date.now() - (rec.started || new Date(rec.created_at).getTime());
    const steps = CONFIG.steps.map((s, k) => {
      const status = el >= TIMES[k + 1] ? "done" : el >= TIMES[k] ? "running" : "pending";
      return { ...s, status, message: status === "running" ? (MSG[s.key] || null) : null,
               seconds: status === "done" ? (TIMES[k + 1] - TIMES[k]) / 1000 : null };
    });
    const status = el < TIMES[0] ? "queued" : el < TIMES[5] ? "running" : "done";
    return { status, progress: { current: (steps.find(s => s.status === "running") || {}).key || null, steps } };
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
                  mask: SLOTS.map(s => sp.channels.includes(s)), map: sp.map, available: sp.available,
                  file_labels: sp.header.labels, unused: sp.unused || [],
                  fs: Object.fromEntries(Object.entries(sp.available).map(([s, l]) => [s, sp.header.fs[l] || 100])) },
      model: { ...CONFIG.model, notes: ["Resultados simulados en el navegador (modo demo): no provienen de ningún modelo."],
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
        timings: { read_s: 1.0, model_s: 2.0, total_s: 3.6 }
      },
      dataset: sp.dataset || null,
      source_info: { type: sp.source, id: sp.source_id, label: sp.label, subset: !!sp.subset, location: CONFIG.catalog.location }
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
      review: reviewState(d.epochs, corr, rec.finalized, d.model.night_review_fraction),
      history: rec.history.slice(0, 200), notes: rec.notes
    };
  }

  const find = id => db().records.find(r => r.id === id) || fail("not_found", "El registro no existe.");

  function summaryOf(rec) {
    const st = progressOf(rec);
    return { ...rec.summary, ...st, error: null, attempts: 1, review: st.status === "done" ? dynamic(rec).review : null };
  }
  const log = (rec, action, extra = {}) =>
    rec.history.unshift({ at: nowISO(), author: USER, action, epoch: null, stage: null, previous: null, old: null, new: null, ...extra });

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
  /* perfil espectral típico por estadio (delta, theta, alfa, sigma, beta) */
  const PROFILE = [[0.62, 0.12, 0.14, 0.04, 0.08], [0.66, 0.2, 0.07, 0.03, 0.04], [0.8, 0.11, 0.03, 0.04, 0.02],
                   [0.93, 0.05, 0.01, 0.005, 0.005], [0.7, 0.2, 0.05, 0.02, 0.03]];

  function csvDownload(text, name) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const uploads = new Map();

  /* ══════════════ interfaz pública (misma forma que la API real) ══════════════ */
  window.MaiaMock = {
    async login(username, password) {
      await delay(380);
      if (username === "superusuario" && password === "somnoai2026") {
        return { token: "demo-token", user: { username, name: USER, initials: "SU" } };
      }
      fail("invalid_credentials", "Usuario o contraseña incorrectos.");
    },
    async getConfig() { await delay(60); return CONFIG; },
    async listCatalog() { await delay(200); return { source: CONFIG.catalog, nights: NIGHTS.map(pub) }; },

    async uploadPsg(file, hypnogram) {
      await delay(500);
      let header = null, name = file.name, zipHyp = null;
      if (/\.zip$/i.test(file.name)) {
        const z = await MaiaEdf.readZip(file);
        if (!z || !z.psg) fail("invalid_file", "El .zip no contiene ningún .edf de PSG (la señal del registro).");
        header = z.psg.header; name = z.psg.name; zipHyp = z.hypnogram ? z.hypnogram.name : null;
      } else header = await MaiaEdf.readEdf(file);
      if (!header) fail("invalid_file", `«${name}» no es un EDF legible: el encabezado no tiene el formato EDF/EDF+.`);
      if (header.annotationsOnly) fail("invalid_file", `«${name}» es solo un hipnograma (anotaciones, sin señal).`);
      const insp = inspect(header.labels, header.fs);
      if (!insp.usable) fail("invalid_file", `«${name}» no tiene ninguno de los canales que usa el modelo. Canales del archivo: ${header.labels.join(", ")}.`);
      if (!insp.has_eeg) fail("invalid_file", `«${name}» no tiene ningún canal de EEG y el modelo necesita al menos uno.`);
      const id = Math.random().toString(16).slice(2, 18).padEnd(16, "0");
      const up = { id, file_name: name, size_mb: Math.round(file.size / 104857.6) / 10,
                   header: { labels: header.labels, fs: header.fs, duration_s: header.durationS, start_clock_s: header.startClockS,
                             n_channels: header.nChannels, patient: header.patient },
                   channels: insp, hypnogram: hypnogram ? { name: hypnogram.name } : zipHyp ? { name: zipHyp } : null,
                   dataset: (await this.lookupNight(name)).night };
      uploads.set(id, up);
      return up;
    },
    async attachHypnogram(id, file) {
      await delay(200);
      const up = uploads.get(id) || fail("not_found", "La carga no existe.");
      const h = await MaiaEdf.readEdf(file);
      if (!h || !h.annotationsOnly) fail("invalid_file", `«${file.name}» no parece un hipnograma: debe ser un EDF+ que solo trae anotaciones de estadios.`);
      up.hypnogram = { name: file.name };
      return up;
    },
    async removeHypnogram(id) { const up = uploads.get(id) || fail("not_found", "La carga no existe."); up.hypnogram = null; return up; },
    async deleteUpload(id) { uploads.delete(id); return { deleted: id }; },
    async lookupNight(fileName) {
      const b = BASE.find(x => x.label.slice(0, 6) === fileName.slice(0, 6).toUpperCase());
      return { night: b ? { id: b.label, subject: b.subject, night: b.night, age: b.age, sex: b.sex, lights_off: b.lights_off, split: "test" } : null };
    },

    async createAnalysis(body) {
      await delay(250);
      const { source, channels, channel_map, window_mode, start_clock, end_clock, lights_off } = body;
      let spec;
      if (source.type === "catalog") {
        const n = NIGHTS.find(x => x.id === source.id) || fail("not_found", `La noche «${source.id}» no está en el catálogo.`);
        spec = specFor(n, channels, window_mode, start_clock, end_clock, lights_off, channel_map);
      } else {
        const up = uploads.get(source.id) || fail("not_found", "La carga no existe o ya se borró: suba el archivo de nuevo.");
        const map = resolveChannels(channels, channel_map, up.header.labels);
        const h = up.header, total = Math.floor(h.duration_s / EP);
        const refWindow = up.hypnogram ? [Math.min(total - 40, 40), Math.min(total, 40 + 1000)] : null;
        const mode = window_mode || (refWindow ? "reference" : "full");
        const w = resolveWindow(mode, h, refWindow, start_clock, end_clock);
        const lo = lights_off && lights_off !== "none" ? lights_off : null;
        spec = { source: "upload", source_id: up.id, label: up.file_name.replace(/\.edf$/i, ""), file_name: up.file_name, header: h,
                 channels: SLOTS.filter(s => map[s]), map, available: { ...up.channels.matched, ...map }, window: w, mode,
                 has_ref: !!up.hypnogram, lights_off: lo, lights_off_source: lo ? "manual" : null, dataset: up.dataset,
                 sex: h.patient.sex, age: h.patient.age, size_mb: up.size_mb, unused: up.channels.unused };
        uploads.delete(up.id);
      }
      return summaryOf(newRecord(spec, USER));
    },
    async retry() { await delay(100); fail("not_failed", "Solo se puede reintentar un análisis que falló."); },

    async listRecords() { await delay(150); return { records: db().records.map(summaryOf) }; },

    async getRecord(id) {
      await delay(140);
      const rec = find(id), st = progressOf(rec);
      if (st.status !== "done") return summaryOf(rec);
      const d = base(rec), dyn = dynamic(rec);
      return { ...d, ...st, attempts: 1, epochs: { ...d.epochs, final: dyn.final }, metrics: { ...d.metrics, final: dyn.metrics_final },
               agreement: d.agreement ? { ...d.agreement, final: dyn.agreement_final } : null,
               corrections: dyn.corrections, review: dyn.review, history: dyn.history, notes: dyn.notes };
    },

    async deleteRecord(id) {
      await delay(200);
      const recs = db().records, i = recs.findIndex(r => r.id === id);
      if (i < 0) fail("not_found", "El registro no existe.");
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

    async getEvidence(id, epoch, channel) {
      await delay(180);
      const rec = find(id), d = base(rec), fin = dynamic(rec).final;
      const eeg = Object.keys(d.channels.available).filter(s => CONFIG.channels[s].kind === "eeg");
      const ch = channel || d.channels.selected.find(s => eeg.includes(s)) || eeg[0];
      const rng = mulberry32(seedFrom(`${id}|${epoch}|${ch}`));
      const prof = PROFILE[fin[epoch]].map(v => v * uni(rng, 0.8, 1.25));
      const sum = prof.reduce((a, b) => a + b, 0);
      const typical = {};
      STAGES.forEach((s, k) => { if (fin.some(x => x === k)) typical[s] = { n: fin.filter(x => x === k).length, values: PROFILE[k] }; });
      const cands = [d.epochs.stage[epoch], d.epochs.second[epoch]];
      const dist = c => typical[STAGES[c]] ? Math.hypot(...prof.map((v, j) => Math.log(v / sum) - Math.log(PROFILE[c][j]))) : Infinity;
      return { epoch, channel: ch, channel_name: CONFIG.channels[ch].name, file_label: d.channels.available[ch], channels: eeg, fs: 100,
               bands: CONFIG.bands.map((b, j) => ({ ...b, value: Math.round(prof[j] / sum * 10000) / 10000 })),
               typical, candidates: cands, closest: dist(cands[0]) <= dist(cands[1]) ? cands[0] : cands[1],
               method: "Potencia relativa del EEG por banda (simulada en el modo demo)." };
    },

    async changeEpochs(id, changes) {
      await delay(90);
      const rec = find(id), d = base(rec);
      if (rec.finalized.by) fail("review_locked", "La revisión está finalizada. Reábrala para hacer cambios.");
      const at = nowISO();
      changes.forEach(({ epoch, stage }) => {
        const model = d.epochs.stage[epoch];
        const prev = epoch in rec.corrections ? rec.corrections[epoch].stage : model;
        if (stage == null && !(epoch in rec.corrections)) return;
        if (stage == null) delete rec.corrections[epoch];
        else rec.corrections[epoch] = { stage, author: USER, at };
        rec.history.unshift({ at, author: USER, action: stage == null ? "clear" : "set", epoch, stage, previous: prev,
                              old: STAGES[prev], new: STAGES[stage == null ? model : stage] });
      });
      save();
      return dynamic(rec);
    },

    async getChanges(id) {
      await delay(120);
      const rec = find(id), d = base(rec), ep = d.epochs, t0 = d.night.start_clock_s;
      const entries = Object.entries(rec.corrections).map(([e, c]) => [+e, c]).sort((a, b) => a[0] - b[0]);
      const changes = entries.filter(([e, c]) => c.stage !== ep.stage[e]).map(([e, c]) => ({
        epoch: e, clock_s: t0 != null ? t0 + e * EP : null, model_stage: ep.stage[e], reviewer_stage: c.stage,
        flagged: !!ep.review[e], author: c.author, at: c.at }));
      return { confirmed: entries.length - changes.length, corrected: changes.length,
               pending: ep.review.filter((f, i) => f && !(i in rec.corrections)).length, changes, review: dynamic(rec).review };
    },

    async reviewAction(id, { action, expected_corrected }) {
      await delay(150);
      const rec = find(id), before = dynamic(rec).review;
      if (action === "finalize") {
        if (rec.finalized.by) fail("already_finalized", "La revisión ya está finalizada.");
        if (expected_corrected != null && expected_corrected !== before.corrected) {
          fail("stale_summary", `Los cambios cambiaron mientras veía el resumen (ahora son ${before.corrected}).`);
        }
        rec.finalized = { by: USER, at: nowISO() };
      } else {
        if (!rec.finalized.by) fail("not_finalized", "La revisión no está finalizada.");
        rec.finalized = {};
      }
      log(rec, action, { old: before.status, new: dynamic(rec).review.status });
      save();
      return dynamic(rec);
    },

    async addNote(id, text) {
      await delay(120);
      const rec = find(id), t = (text || "").trim();
      if (!t) fail("empty_note", "Escriba la nota antes de guardarla.");
      const at = nowISO();
      rec.notes.unshift({ id: Date.now(), at, author: USER, text: t });
      log(rec, "note", { new: t });
      save();
      return { notes: rec.notes, history: rec.history.slice(0, 200) };
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
