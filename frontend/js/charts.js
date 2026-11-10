/* ════════════════════════════════════════════════════════════════════
   MAIA · capa de gráficos (SVG puro, sin dependencias)
   Todas las funciones reciben DATOS (del contrato de la API) y un
   contenedor. Nada aquí conoce de dónde vienen los datos.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  /* ── utilidades compartidas ── */
  const S = (t, a = {}) => {
    const e = document.createElementNS("http://www.w3.org/2000/svg", t);
    for (const k in a) e.setAttribute(k, a[k]);
    return e;
  };
  const T = (a, txt) => Object.assign(S("text", a), { textContent: txt });
  const svg = (w, h) => S("svg", { viewBox: `0 0 ${w} ${h}`, role: "img" });
  const CV = n => getComputedStyle(document.body).getPropertyValue(n).trim();
  // los gráficos se dibujan a la escala de su contenedor: el texto conserva su tamaño real
  const fitW = (el, min, fallback) => Math.max(min, Math.round(el.clientWidth || fallback));

  const nf = (v, d = 1) => (v == null ? "—" : v.toFixed(d).replace(".", ",").replace("-", "−"));
  const pct = (v, d = 1) => (v == null ? "—" : nf(100 * v, d) + " %");
  const pad2 = n => String(n).padStart(2, "0");
  const clockHM = s => pad2(Math.floor(s / 3600) % 24) + ":" + pad2(Math.floor(s / 60) % 60);
  const clockHMS = s => clockHM(s) + ":" + pad2(Math.floor(s) % 60);
  const fmtHM = s => {
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return h > 0 ? `${h} h ${pad2(m)} min` : `${m} min`;
  };
  const fmtInt = n => (n == null ? "—" : n.toLocaleString("es-CO"));
  const median = arr => {
    if (!arr.length) return 0;
    const a = [...arr].sort((x, y) => x - y), m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  window.MaiaUtil = { nf, pct, clockHM, clockHMS, fmtHM, fmtInt, median, esc };

  /* ── tooltip flotante compartido ── */
  const Tip = (() => {
    let el = null;
    const ensure = () => el || (el = Object.assign(
      document.body.appendChild(document.createElement("div")), { className: "tipbox" }));
    return {
      show(html, ev) {
        const t = ensure();
        t.innerHTML = html;
        let x = ev.clientX + 14, y = ev.clientY + 14;
        if (x + 300 > innerWidth) x = ev.clientX - 306;
        if (y + 120 > innerHeight) y = ev.clientY - 112;
        t.style.left = x + "px";
        t.style.top = y + "px";
        t.classList.add("on");
      },
      hide() { el && el.classList.remove("on"); }
    };
  })();

  /* micro-animaciones (js/fx.js, cargado antes); sin él, las gráficas se dibujan igual */
  const FX = window.MaiaFX || null;

  /* hover: la marca bajo el puntero se destaca y las demás de su grupo se atenúan */
  function emphasis(marks) {
    const clear = () => marks.forEach(o => o.classList.remove("dim", "lift"));
    marks.forEach(mk => {
      mk.classList.add("hm");
      mk.addEventListener("mouseenter", () => marks.forEach(o => {
        o.classList.toggle("dim", o !== mk);
        o.classList.toggle("lift", o === mk);
      }));
      mk.addEventListener("mouseleave", clear);
    });
  }

  /* barras: crecen desde su base al aparecer (entrada) o pasan de su caja anterior (cambio).
     items = [{el, id, box, base, k}] · base = caja de partida en la entrada · k = orden */
  function animateBars(m, items, { stagger = 40, enter = 320 } = {}) {
    if (!FX) return null;
    const boxes = {};
    items.forEach(it => { boxes[it.id] = it.box; });
    const ch = FX.track(m, boxes);
    items.forEach(it => {
      if (!ch.from) FX.morphBox(it.el, it.base, it.box, { age: m.age, delay: it.k * stagger, duration: enter });
      else FX.morphBox(it.el, ch.from[it.id] || it.base, it.box, { age: ch.age });
    });
    return ch;
  }

  const svgPt = (svgEl, ev, vbW, vbH) => {
    const r = svgEl.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * (vbW / r.width), y: (ev.clientY - r.top) * (vbH / r.height) };
  };

  /* Estadios: rampa ordinal de azules (claro = superficial); REM en otro tono */
  const STG = [
    { k: "W", c: "#86b6ef" },
    { k: "N1", c: "#5598e7" },
    { k: "N2", c: "#2a78d6" },
    { k: "N3", c: "#184f95" },
    { k: "REM", c: "#eb6834" }
  ];
  const ROWS = [0, 4, 1, 2, 3];            // orden clínico de arriba abajo: W, REM, N1, N2, N3
  const STATUS = {
    pending: { label: "Pendiente", v: "--warn" },
    confirmed: { label: "Confirmada", v: "--good" },
    corrected: { label: "Corregida", v: "--corr" }
  };

  /* estado de revisión de una época: pending | confirmed | corrected | null */
  function epochStatus(d, i, corr) {
    const c = corr.get(i);
    if (c != null) return c === d.epochs.stage[i] ? "confirmed" : "corrected";
    return d.epochs.review[i] ? "pending" : null;
  }

  /* ── Épocas marcadas por noche (vista Registros) ── */
  function renderStrip(el, records, limit) {
    const W = fitW(el, 360, 1080), H = 100, L = 14, R = 14, pw = W - L - R, hi = 0.6;
    const s = svg(W, H);
    s.setAttribute("aria-label", "Fracción de épocas marcadas por noche");
    const x = v => L + (Math.min(hi, Math.max(0, v)) / hi) * pw;
    s.appendChild(S("rect", { x: L, y: 36, width: pw, height: 20, rx: 10, fill: CV("--surface-3") }));
    s.appendChild(S("rect", { x: x(limit), y: 36, width: x(hi) - x(limit), height: 20, rx: 10,
      fill: CV("--warn"), "fill-opacity": .22 }));
    [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6].forEach(t => {
      s.appendChild(S("line", { x1: x(t), x2: x(t), y1: 31, y2: 61, stroke: CV("--axis"), "stroke-dasharray": "3 3" }));
      s.appendChild(T({ x: x(t), y: 78, "text-anchor": "middle", "class": "tick" }, Math.round(t * 100) + " %"));
    });
    s.appendChild(S("line", { x1: x(limit), x2: x(limit), y1: 28, y2: 64, stroke: CV("--warn-text"), "stroke-width": 1.5 }));
    s.appendChild(T({ x: x(limit) + 6, y: 24, "class": "dlbl", fill: CV("--warn-text") },
      `revisión completa > ${nf(100 * limit)} %`));
    // cada noche nueva aparece con un pop (escalonado la primera vez); las ya vistas no se repiten
    const seen = el._seen || (el._seen = new Set()), dots = [];
    let fresh = 0;
    records.forEach((r, i) => {
      const f = r.review.flagged_fraction, over = r.review.whole_night_recommended;
      const signed = r.review.status === "finalized";
      const c = S("circle", { cx: x(f), cy: 46, r: over ? 6.5 : 5.5, "class": "sdot",
        fill: CV(signed ? "--good" : over ? "--warn" : "--s1"), "fill-opacity": signed ? .9 : .75,
        stroke: CV("--surface-1"), "stroke-width": 2, "pointer-events": "none" });
      // área de 24 px para apuntar (el punto pinta 11–13 px)
      const hit = S("circle", { cx: x(f), cy: 46, r: 12, fill: "transparent", style: "cursor:pointer" });
      hit.addEventListener("mousemove", ev => Tip.show(
        `<span class="tt">${esc(r.subject_code)} · ${esc(r.combination_name)}</span>` +
        `${esc(r.file_name)}<br>Marcadas: <b>${pct(f)}</b> (${r.review.flagged} de ${fmtInt(r.n_epochs)} épocas)<br>` +
        (signed ? "Revisión finalizada" : `${r.review.pending} pendientes`), ev));
      hit.addEventListener("mouseenter", () => dots.forEach(o => {
        o.classList.toggle("dim", o !== c);
        o.classList.toggle("lift", o === c);
      }));
      hit.addEventListener("mouseleave", () => { Tip.hide(); dots.forEach(o => o.classList.remove("dim", "lift")); });
      if (el._onPick) hit.addEventListener("click", () => { Tip.hide(); el._onPick(r.id); });
      s.appendChild(c);
      s.appendChild(hit);
      dots.push(c);
      if (!seen.has(r.id)) {
        seen.add(r.id);
        if (FX) FX.popIn(c, Math.min(fresh++, 14) * 45);
      }
    });
    s.appendChild(T({ x: L, y: 96, "class": "axlbl" },
      "Porcentaje de épocas que el modelo marcó para revisión (confianza bajo el umbral) · verde: revisión finalizada · clic para abrir"));
    el.replaceChildren(s);
  }

  /* ── Las 12 combinaciones de canales con su MF1 de test (Tabla IV del informe) ── */
  function renderCombos(el, expected, names, selected, goal, { key = "combos" } = {}) {
    const keys = Object.keys(expected).sort((a, b) => expected[b].test_mf1 - expected[a].test_mf1);
    const W = fitW(el, 340, 640), rowH = 15, Tp = 6, L = 150, R = 50, H = Tp + keys.length * rowH + 30, pw = W - L - R;
    const items = [], byKey = {};
    const lo = 0.70, hi = 0.80;
    const x = v => L + ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * pw;
    const s = svg(W, H);
    s.setAttribute("aria-label", "F1 macro en el test por combinación de canales");
    [0.70, 0.75, 0.80].forEach(t => {
      s.appendChild(S("line", { x1: x(t), x2: x(t), y1: Tp - 2, y2: Tp + keys.length * rowH,
        stroke: CV(t === goal ? "--warn-text" : "--grid"), "stroke-dasharray": t === goal ? "4 3" : "none" }));
      s.appendChild(T({ x: x(t), y: Tp + keys.length * rowH + 13, "text-anchor": "middle", "class": "tick" },
        nf(t, 2)));
    });
    keys.forEach((k, i) => {
      const e = expected[k], y = Tp + i * rowH, on = k === selected;
      s.appendChild(T({ x: L - 8, y: y + 10.5, "text-anchor": "end", "font-size": on ? 11 : 10.5,
        "font-weight": on ? 700 : 400, fill: CV(on ? "--ink" : "--muted") }, names[k] || k));
      s.appendChild(S("line", { x1: x(e.test_ci[0]), x2: x(e.test_ci[1]), y1: y + 7, y2: y + 7,
        stroke: CV(on ? "--s1" : "--axis"), "stroke-width": 1.2 }));
      const bar = S("rect", { x: L, y: y + 3, width: Math.max(2, x(e.test_mf1) - L), height: 8, rx: 3,
        fill: CV(e.test_mf1 < goal ? "--warn" : "--s1"), "fill-opacity": on ? 1 : .35 });
      bar.addEventListener("mousemove", ev => Tip.show(
        `<span class="tt">${esc(names[k] || k)}</span>F1 macro en el test <b>${nf(e.test_mf1, 3)}</b> ` +
        `(intervalo ${nf(e.test_ci[0], 3)}–${nf(e.test_ci[1], 3)})<br>kappa de Cohen ${nf(e.test_kappa, 3)} · F1 de N1 ${nf(e.test_f1_n1, 3)}` +
        `<br>en validación cruzada: F1 macro ${nf(e.cv_mf1, 3)}`, ev));
      bar.addEventListener("mouseleave", Tip.hide);
      s.appendChild(bar);
      const box = { x: L, y: y + 3, w: Math.max(2, x(e.test_mf1) - L), h: 8 };
      items.push({ el: bar, id: k, box, base: { ...box, w: 0 }, k: i });
      byKey[k] = bar;
      s.appendChild(T({ x: x(e.test_mf1) + 5, y: y + 10.5, "font-size": 10, fill: CV(on ? "--ink" : "--muted"),
        "font-weight": on ? 700 : 400 }, nf(e.test_mf1, 3)));
    });
    s.appendChild(T({ x: L, y: H - 2, "class": "axlbl" }, `F1 macro en el test (16 sujetos; 1 = perfecto) · línea punteada: meta ${nf(goal, 2)}`));
    el.replaceChildren(s);
    emphasis(items.map(it => it.el));
    if (!FX) return;
    // las barras crecen desde el eje al aparecer; al cambiar de combinación, la elegida se enciende
    const m = FX.memo(el, key, W);
    animateBars(m, items, { stagger: 25, enter: 380 });
    if (m.sel !== undefined && m.sel !== selected) {
      if (byKey[selected]) FX.play(byKey[selected], [{ fillOpacity: 0.35 }, { fillOpacity: 1 }], { duration: 260 });
      if (byKey[m.sel]) FX.play(byKey[m.sel], [{ fillOpacity: 1 }, { fillOpacity: 0.35 }], { duration: 260 });
    }
    m.sel = selected;
  }

  /* ── Hipnograma de la noche con marcas de revisión, confianza y referencia ──
     zoom: [e0, e1] (en épocas) muestra solo ese tramo de la noche (US-08). Arrastrar sobre el
     gráfico elige un tramo (onZoom([e0, e1])) y el doble clic vuelve a la noche completa
     (onZoom(null)); un clic sin arrastrar elige la época, como siempre. */
  let clipSeq = 0;
  function dragZoom(s, capt, { W, H, L, pw, y, h, at, min, onZoom, onClick, host, onDouble }) {
    // arrastre horizontal → tramo [a, b] en las unidades de at(); un clic sin arrastre → onClick;
    // dos clics seguidos en el mismo punto → onDouble. El doble clic se mide aquí y no con el evento
    // dblclick: el primer clic elige la época y el gráfico se vuelve a dibujar, así que el navegador
    // no lo dispara. El último clic se guarda en `host`, el contenedor, que no se reemplaza.
    let drag = null;
    const px = ev => svgPt(s, ev, W, H).x;
    capt.addEventListener("pointerdown", ev => {
      if (ev.button !== 0) return;
      drag = { v: at(ev), x: px(ev), moved: false, rect: null };
      try { capt.setPointerCapture(ev.pointerId); } catch (e) { /* sin captura: igual funciona dentro del gráfico */ }
    });
    capt.addEventListener("pointermove", ev => {
      if (!drag || !onZoom) return;
      const x1 = px(ev);
      if (!drag.moved && Math.abs(x1 - drag.x) < 6) return;
      drag.moved = true;
      Tip.hide();
      const xa = Math.max(L, Math.min(drag.x, x1)), xb = Math.min(L + pw, Math.max(drag.x, x1));
      if (!drag.rect) drag.rect = s.insertBefore(S("rect", { y, height: h, rx: 3, "class": "zsel" }), capt);
      drag.rect.setAttribute("x", xa);
      drag.rect.setAttribute("width", Math.max(1, xb - xa));
    });
    capt.addEventListener("pointerup", ev => {
      const dr = drag;
      drag = null;
      if (!dr || ev.button !== 0) return;
      if (dr.rect) dr.rect.remove();
      if (!dr.moved) {
        const last = host && host._tap, t = ev.timeStamp;
        const dbl = !!onDouble && !!last && t - last.t < 400 &&
          Math.abs(ev.clientX - last.x) < 8 && Math.abs(ev.clientY - last.y) < 8;
        if (host) host._tap = dbl ? null : { t, x: ev.clientX, y: ev.clientY };
        return dbl ? onDouble() : onClick && onClick(ev);
      }
      if (host) host._tap = null;
      Tip.hide();
      const b = at(ev), lo = Math.min(dr.v, b), hi = Math.max(dr.v, b);
      if (hi - lo >= min) onZoom([lo, hi]);
    });
    capt.addEventListener("pointercancel", () => { if (drag && drag.rect) drag.rect.remove(); drag = null; });
  }

  function renderHypnogram(el, d, { view, selected, viewRange, corr, onSelect, flash, zoom, onZoom }) {
    const ep = d.epochs, n = d.night.n_epochs, EP = d.night.epoch_s, T0 = d.night.start_clock_s;
    const stages = view === "predicted" ? ep.stage : ep.final;
    const hasRef = Array.isArray(ep.reference);
    const W = fitW(el, 360, 1080), L = 70, R = 12, pw = W - L - R;
    const rowH = 26, mainTop = 8, mainH = rowH * 5;
    const flagTop = mainTop + mainH + 10, flagH = 10;
    const confTop = flagTop + flagH + 10, confH = 46;
    const refTop = confTop + confH + 12, refH = hasRef ? 14 : 0;
    const H = refTop + refH + (hasRef ? 30 : 18);
    const s = svg(W, H);
    s.setAttribute("aria-label", zoom ? "Hipnograma: tramo acercado de la noche" : "Hipnograma de la noche");
    // tramo visible [z0, z1) en épocas; a0..a1 son las épocas que se dibujan
    const z0 = zoom ? Math.max(0, zoom[0]) : 0, z1 = zoom ? Math.min(n, zoom[1]) : n, span = Math.max(1e-6, z1 - z0);
    const a0 = Math.max(0, Math.floor(z0)), a1 = Math.min(n, Math.ceil(z1));
    const x = e => L + ((e - z0) / span) * pw;
    const rowY = st => mainTop + ROWS.indexOf(st) * rowH + rowH / 2;
    // lo que depende del tiempo va recortado al área del gráfico (con zoom se sale por los lados)
    const clipId = `hypclip${++clipSeq}`;
    const clip = S("clipPath", { id: clipId });
    clip.appendChild(S("rect", { x: L, y: 0, width: pw, height: H }));
    s.appendChild(S("defs")).appendChild(clip);

    // micro-animaciones: el hipnograma se redibuja con cada selección, así que se recuerda por
    // noche qué mostraba (cursor, ventana del visor, vista) y cuándo empezó cada efecto
    const now = FX ? FX.now() : 0;
    let fx = el._fx;
    if (!fx || fx.rid !== d.id) fx = el._fx = { rid: d.id, born: now, W };
    const zk = zoom ? `${z0.toFixed(2)}|${z1.toFixed(2)}` : "";
    if (fx.W !== W || fx.zk !== zk) { fx.W = W; fx.zk = zk; fx.selX = null; fx.glide = null; fx.vr = null; fx.vrMove = null; }
    // cambio de vista (final ↔ solo el modelo): de qué estadios se viene, para que los tramos corregidos salten
    if (fx.view && fx.view !== view) fx.sw = { from: fx.stages, view, t0: now };
    fx.view = view;
    fx.stages = Array.from(stages);

    ROWS.forEach((st, i) => {
      s.appendChild(S("rect", { x: L, y: mainTop + i * rowH, width: pw, height: rowH,
        fill: i % 2 ? CV("--surface-2") : "transparent", "fill-opacity": .6 }));
      s.appendChild(T({ x: L - 8, y: mainTop + i * rowH + rowH / 2 + 4, "text-anchor": "end",
        "font-size": 11, "font-weight": 650, fill: CV("--ink2") }, STG[st].k));
    });
    // horas (con zoom, marcas más finas: 30, 15, 10, 5… minutos)
    if (T0 != null) {
      const vis = span * EP, most = Math.max(2, Math.floor(pw / 80));
      const step = !zoom ? 3600 : [60, 120, 300, 600, 900, 1800, 3600].find(st => vis / st <= most) || 3600;
      for (let t = Math.ceil((T0 + z0 * EP) / step) * step; t <= T0 + z1 * EP; t += step) {
        const xx = x((t - T0) / EP);
        s.appendChild(S("line", { x1: xx, x2: xx, y1: mainTop, y2: confTop + confH, stroke: CV("--grid") }));
        s.appendChild(T({ x: xx, y: H - 6, "text-anchor": "middle", "class": "tick" }, clockHM(t)));
      }
    }
    const plot = s.appendChild(S("g", { "clip-path": `url(#${clipId})` }));
    // ventana visible del visor
    if (viewRange) {
      const vr = { x: x(viewRange[0]), y: mainTop - 4, w: Math.max(2, x(viewRange[1]) - x(viewRange[0])), h: mainH + 8 };
      const band = plot.appendChild(S("rect", { x: vr.x, y: vr.y, width: vr.w, height: vr.h,
        fill: CV("--ink"), "fill-opacity": .07, rx: 3 }));
      // la franja sigue al visor: se desliza al cambiar de época y cambia de ancho con el zoom de tiempo
      if (FX) {
        if (fx.vr && !FX.sameBox(fx.vr, vr)) fx.vrMove = { from: fx.vr, to: vr, t0: now };
        fx.vr = vr;
        if (fx.vrMove && FX.sameBox(fx.vrMove.to, vr)) FX.morphBox(band, fx.vrMove.from, vr, { age: now - fx.vrMove.t0, duration: 240 });
      }
    }
    // escalones: tramos horizontales por racha + conectores verticales
    const stepsG = plot.appendChild(S("g"));
    let run = a0;
    for (let e = a0 + 1; e <= a1; e++) {
      if (e === a1 || stages[e] !== stages[run]) {
        const st = stages[run], y = rowY(st), hh = st === 4 ? 9 : 6;
        // clases hs/s{estadio}: la leyenda resalta un estadio en toda la noche (data-focus del contenedor)
        stepsG.appendChild(S("rect", { x: x(run), y: y - hh / 2, width: Math.max(1, x(e) - x(run)), height: hh,
          rx: 1.5, fill: STG[st].c, "class": `hs s${st}` }));
        if (e < a1) stepsG.appendChild(S("line", { x1: x(e), x2: x(e), y1: y, y2: rowY(stages[e]),
          stroke: CV("--axis"), "stroke-width": 1, "class": "hs-c" }));
        run = e;
      }
    }
    // final ↔ solo el modelo: los tramos que cambió la revisión saltan de su estadio anterior al nuevo
    // (con borde morado de «corregida») mientras el resto aparece con un fundido corto
    if (fx.sw && (now - fx.sw.t0 > 500 || fx.sw.view !== view)) fx.sw = null;
    if (FX && fx.sw && fx.sw.from && fx.sw.from.length === n && FX.enabled()) {
      const age = now - fx.sw.t0, from = fx.sw.from;
      FX.play(stepsG, [{ opacity: 0.2 }, { opacity: 1 }], { duration: 300, age });
      const spans = [];
      for (let e = 0; e < n; e++) {
        if (from[e] === stages[e]) continue;
        const last = spans[spans.length - 1];
        if (last && last.e1 === e && last.from === from[e] && last.to === stages[e]) last.e1 = e + 1;
        else spans.push({ e0: e, e1: e + 1, from: from[e], to: stages[e] });
      }
      spans.forEach(sp => {
        const hh = sp.to === 4 ? 9 : 6, dy = rowY(sp.from) - rowY(sp.to);
        const g = plot.appendChild(S("rect", { x: x(sp.e0), y: rowY(sp.to) - hh / 2, width: Math.max(2, x(sp.e1) - x(sp.e0)),
          height: hh, rx: 1.5, fill: STG[sp.to].c, stroke: CV("--corr"), "stroke-width": 1.2, "pointer-events": "none" }));
        if (!FX.play(g, [{ transform: `translateY(${dy}px)`, opacity: 1 }, { transform: "none", opacity: 1, offset: 0.75 },
          { transform: "none", opacity: 0 }], { duration: 440, age, fill: "forwards" })) g.remove();
      });
    }
    // marcas de revisión (y épocas cambiadas aunque no estuvieran marcadas)
    s.appendChild(T({ x: L - 8, y: flagTop + 8, "text-anchor": "end", "class": "tick" }, "revisar"));
    plot.appendChild(S("rect", { x: L, y: flagTop, width: pw, height: flagH, rx: 3, fill: CV("--surface-2") }));
    const tickW = Math.max(1.2, pw / span);
    for (let e = a0; e < a1; e++) {
      const stt = epochStatus(d, e, corr);
      if (!stt) continue;
      plot.appendChild(S("rect", { x: x(e), y: flagTop, width: tickW, height: flagH, fill: CV(STATUS[stt].v),
        "class": `fl f-${stt}` }));
    }
    // confianza
    s.appendChild(T({ x: L - 8, y: confTop + 12, "text-anchor": "end", "class": "tick" }, "confianza"));
    const cy = v => confTop + confH - v * confH;
    let area = `M${x(a0).toFixed(1)} ${cy(0)}`;
    for (let e = a0; e < a1; e++) area += `L${x(e + 0.5).toFixed(1)} ${cy(ep.confidence[e]).toFixed(1)}`;
    area += `L${x(a1).toFixed(1)} ${cy(0)}Z`;
    plot.appendChild(S("path", { d: area, fill: CV("--s1"), "fill-opacity": .22, stroke: CV("--s1"),
      "stroke-width": .8, "stroke-opacity": .7 }));
    const thr = d.model.threshold;
    s.appendChild(S("line", { x1: L, x2: L + pw, y1: cy(thr), y2: cy(thr), stroke: CV("--warn-text"),
      "stroke-dasharray": "4 3", "stroke-width": 1.2 }));
    s.appendChild(T({ x: L + pw - 2, y: cy(thr) - 4, "text-anchor": "end", "font-size": 10, fill: CV("--warn-text"),
      "font-weight": 600 }, `umbral ${nf(thr, 2)}`));
    // referencia
    if (hasRef) {
      s.appendChild(T({ x: L - 8, y: refTop + 11, "text-anchor": "end", "class": "tick" }, "experto"));
      let r0 = a0;
      for (let e = a0 + 1; e <= a1; e++) {
        if (e === a1 || ep.reference[e] !== ep.reference[r0]) {
          const st = ep.reference[r0];
          plot.appendChild(S("rect", { x: x(r0), y: refTop, width: Math.max(1, x(e) - x(r0)), height: refH,
            fill: st >= 0 ? STG[st].c : CV("--surface-3"), "class": st >= 0 ? `hs s${st}` : "hs" }));
          r0 = e;
        }
      }
    }
    // época recién decidida: destello verde (confirmada) o morado (corregida)
    if (FX && flash && flash.epoch >= 0 && flash.epoch < n && FX.enabled()) {
      const fw = Math.max(9, 3 * tickW), fr = S("rect", { x: x(flash.epoch + 0.5) - fw / 2, y: mainTop - 4, width: fw,
        height: flagTop + flagH - mainTop + 4, rx: 2, fill: CV(flash.color), opacity: 0, "pointer-events": "none" });
      plot.appendChild(fr);
      FX.fade(fr, flash.age);
    }
    // época seleccionada
    if (selected != null) {
      const xs = x(selected + 0.5), cur = S("g");
      cur.appendChild(S("line", { x1: xs, x2: xs, y1: mainTop - 6, y2: refTop + refH + 2, stroke: CV("--ink"),
        "stroke-width": 1.6 }));
      cur.appendChild(S("path", { d: `M${xs - 5} ${mainTop - 8}L${xs + 5} ${mainTop - 8}L${xs} ${mainTop - 2}Z`,
        fill: CV("--ink") }));
      plot.appendChild(cur);
      if (FX) {
        if (fx.selX != null && Math.abs(fx.selX - xs) > 0.5) fx.glide = { dx: fx.selX - xs, to: xs, t0: now };
        fx.selX = xs;
        if (fx.glide && fx.glide.to === xs) FX.glide(cur, fx.glide.dx, now - fx.glide.t0);
      }
    }
    if (FX) FX.reveal(s, now - fx.born);
    // interacción
    const xh = S("line", { y1: mainTop, y2: refTop + refH, stroke: CV("--ink2"), "stroke-dasharray": "3 3",
      opacity: 0, "class": "xhair" });
    s.appendChild(xh);
    const capt = S("rect", { x: L, y: 0, width: pw, height: refTop + refH + 4, fill: "transparent", "class": "capt" });
    const eAt = ev => z0 + Math.max(0, Math.min(1, (svgPt(s, ev, W, H).x - L) / pw)) * span;
    const epochAt = ev => Math.max(0, Math.min(n - 1, Math.floor(eAt(ev))));
    capt.addEventListener("mousemove", ev => {
      if (ev.buttons) { xh.setAttribute("opacity", 0); Tip.hide(); return; }    // arrastrando: sin tooltip
      const e = epochAt(ev), xx = x(e + 0.5);
      xh.setAttribute("x1", xx); xh.setAttribute("x2", xx); xh.setAttribute("opacity", 1);
      const stt = epochStatus(d, e, corr);
      Tip.show(`<span class="tt">${T0 != null ? clockHMS(T0 + e * EP) + " · " : ""}época ${e + 1}</span>` +
        `Modelo: <b>${STG[ep.stage[e]].k}</b> (confianza ${Math.round(ep.confidence[e] * 100)} %) · 2.ª opción ${STG[ep.second[e]].k}` +
        (stt === "corrected" ? `<br>Final: <b>${STG[ep.final[e]].k}</b> (corregida)` : "") +
        (stt ? `<br>${STATUS[stt].label}` : "") +
        (hasRef ? `<br>Experto: ${ep.reference[e] >= 0 ? STG[ep.reference[e]].k : "sin estadio"}` : ""), ev);
    });
    capt.addEventListener("mouseleave", () => { xh.setAttribute("opacity", 0); Tip.hide(); });
    // arrastrar: acercar un tramo de al menos 4 épocas (2 min); clic: elegir la época
    // doble clic con zoom: la noche completa
    dragZoom(s, capt, { W, H, L, pw, y: mainTop - 4, h: refTop + refH + 6 - mainTop, at: eAt, min: 4, onZoom,
      onClick: ev => onSelect && onSelect(epochAt(ev)),
      host: el, onDouble: zoom && onZoom ? () => onZoom(null) : null });
    s.appendChild(capt);
    el.replaceChildren(s);
  }

  /* ── Tiempo por estadio: modelo, final y referencia ── */
  function renderStageBars(el, rows, { key = "stages" } = {}) {
    const W = fitW(el, 360, 1080), L = 92, R = 12, rowH = 30, gap = 12, Tp = 4, pw = W - L - R;
    const H = Tp + rows.length * (rowH + gap) + 26;
    const s = svg(W, H);
    s.setAttribute("aria-label", "Minutos en cada estadio");
    const total = Math.max(...rows.map(r => STG.reduce((a, st) => a + (r.stages[st.k] ? r.stages[st.k].min : 0), 0)), 1);
    const items = [], labels = [];
    rows.forEach((r, i) => {
      const y = Tp + i * (rowH + gap);
      s.appendChild(T({ x: L - 10, y: y + rowH / 2 + 4, "text-anchor": "end", "font-size": 12, "font-weight": 600,
        fill: CV("--ink2") }, r.label));
      let cx = L;
      STG.forEach((st, k) => {
        const m = r.stages[st.k] ? r.stages[st.k].min : 0, w = (m / total) * pw;
        if (w <= 0) return;
        const rect = S("rect", { x: cx, y, width: Math.max(w - 1.5, .5), height: rowH, rx: 4, fill: st.c });
        rect.addEventListener("mousemove", ev => Tip.show(`<span class="tt">${r.label} · ${st.k}</span>` +
          `<b>${nf(m, 1)} min</b> · ${nf(r.stages[st.k].pct, 1)} % ${k === 0 ? "del tiempo en cama" : "del sueño total"}`, ev));
        rect.addEventListener("mouseleave", Tip.hide);
        s.appendChild(rect);
        const id = `${i}|${st.k}`, box = { x: cx, y, w: Math.max(w - 1.5, .5), h: rowH };
        items.push({ el: rect, id, box, base: { ...box, w: 0 }, k });
        if (w > 58) labels.push([s.appendChild(T({ x: cx + w / 2, y: y + rowH / 2 + 4, "text-anchor": "middle", "font-size": 11,
          "font-weight": 700, fill: k === 0 ? "#0b2340" : "#fff", "pointer-events": "none" }, `${st.k} ${Math.round(m)}′`)), id]);
        cx += w;
      });
    });
    s.appendChild(T({ x: L, y: H - 6, "class": "axlbl" },
      "Minutos por estadio (′ = minutos) · las barras miden lo mismo: la ventana analizada"));
    el.replaceChildren(s);
    emphasis(items.map(it => it.el));
    if (!FX) return;
    // los segmentos se construyen de izquierda a derecha; con una decisión, pasan del ancho anterior al nuevo
    const m = FX.memo(el, key, W);
    const ch = animateBars(m, items, { stagger: 70, enter: 300 });
    labels.forEach(([t, id]) => {
      if (!ch.from) FX.play(t, [{ opacity: 0 }, { opacity: 1 }], { age: m.age, delay: 330, duration: 200, fill: "backwards" });
      else if (!ch.from[id] || ch.from[id].w !== m.cur[id].w) FX.play(t, [{ opacity: 0 }, { opacity: 1 }], { age: ch.age, duration: 260 });
    });
  }

  /* ── Matriz de confusión (tabla HTML con intensidad por fila) ── */
  function renderConfusion(el, cm, colLabel, { key = "cm" } = {}) {
    const rows = cm.map(r => r.reduce((a, b) => a + b, 0));
    const head = `<tr><th></th>${STG.map(s => `<th>${s.k}</th>`).join("")}<th>n</th></tr>`;
    const body = cm.map((r, i) => `<tr><th style="text-align:right">${STG[i].k}</th>` + r.map((v, j) => {
      const f = rows[i] ? v / rows[i] : 0;
      const base = i === j ? "--s1" : "--crit";
      const alpha = Math.round((i === j ? 12 + 78 * f : 8 + 70 * f));
      const ink = f > 0.55 ? "#fff" : "var(--ink)";
      return `<td title="Referencia ${STG[i].k} → ${colLabel} ${STG[j].k}: ${v} épocas (${nf(100 * f)} % de la fila)" ` +
        `style="background:color-mix(in srgb,var(${base}) ${v ? alpha : 0}%,var(--surface-2));color:${ink}">` +
        `${v ? Math.round(100 * f) + "%" : "·"}</td>`;
    }).join("") + `<th>${rows[i]}</th></tr>`).join("");
    el.innerHTML = `<table class="cm">${head}${body}</table>`;
    if (!FX || !FX.enabled()) return;
    // entrada: las celdas aparecen en diagonal; cambio (modelo ↔ final, una decisión): del color anterior al nuevo
    const m = FX.memo(el, key, 0), t = FX.now();
    const tds = [...el.querySelectorAll("td")], cols = tds.map(td => getComputedStyle(td).backgroundColor);
    if (m.cols && m.cols.some((c, k) => c !== cols[k])) { m.fromCols = m.cols; m.changedAt = t; }
    m.cols = cols;
    tds.forEach((td, k) => {
      const i = Math.floor(k / 5), j = k % 5;
      if (!m.changedAt) {
        FX.play(td, [{ opacity: 0, transform: "scale(.8)" }, { opacity: 1, transform: "none" }],
          { duration: 220, delay: (i + j) * 30, age: m.age, fill: "backwards" });
      } else if (m.fromCols[k] !== cols[k]) {
        FX.play(td, [{ backgroundColor: m.fromCols[k] }, { backgroundColor: cols[k] }], { duration: 300, age: t - m.changedAt });
      }
    });
  }

  /* ── F1 por estadio: modelo frente a final ── */
  function renderF1(el, a, b, { key = "f1" } = {}) {
    const W = fitW(el, 300, 520), H = 180, L = 34, R = 10, Tp = 10, B = 34, pw = W - L - R, ph = H - Tp - B;
    const items = [];
    const s = svg(W, H);
    s.setAttribute("aria-label", "F1 por estadio");
    const y = v => Tp + ph - v * ph;
    [0, 0.5, 1].forEach(v => {
      s.appendChild(S("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: CV("--grid") }));
      s.appendChild(T({ x: L - 6, y: y(v) + 4, "text-anchor": "end", "class": "tick" }, nf(v, 1)));
    });
    const gw = pw / STG.length, bw = b ? gw * 0.32 : gw * 0.5;
    STG.forEach((st, i) => {
      const gx = L + i * gw + gw / 2;
      [[a, 0], [b, 1]].forEach(([set, j]) => {
        if (!set) return;
        const v = set.f1[st.k] || 0;
        const bx = b ? gx - bw - 2 + j * (bw + 4) : gx - bw / 2;
        const r = S("rect", { x: bx, y: y(v), width: bw, height: Math.max(0, y(0) - y(v)), rx: 3, fill: st.c,
          "fill-opacity": j ? 1 : (b ? .45 : 1) });
        r.addEventListener("mousemove", ev => Tip.show(`<span class="tt">${st.k} · ${j ? "final" : "modelo"}</span>F1 <b>${nf(v, 3)}</b>`, ev));
        r.addEventListener("mouseleave", Tip.hide);
        s.appendChild(r);
        const box = { x: bx, y: y(v), w: bw, h: Math.max(0, y(0) - y(v)) };
        items.push({ el: r, id: `${st.k}|${j}`, box, base: { ...box, y: y(0), h: 0 }, k: i });
      });
      s.appendChild(T({ x: gx, y: H - B + 16, "text-anchor": "middle", "font-size": 11.5, "font-weight": 650,
        fill: CV("--ink2") }, st.k));
    });
    s.appendChild(T({ x: L, y: H - 4, "class": "axlbl" }, b ? "barra clara: modelo · barra llena: final con revisión" : "F1 del modelo por estadio"));
    el.replaceChildren(s);
    emphasis(items.map(it => it.el));
    // las barras suben desde el eje; con la revisión, la barra «final» crece o cambia desde la anterior
    if (FX) animateBars(FX.memo(el, key, W), items, { stagger: 45, enter: 320 });
  }

  /* ── Composición del registro ── */
  function renderQuality(el, segs, { key = "quality" } = {}) {
    const kindCol = { outside: "--surface-3", window: "--s1" };
    const W = fitW(el, 360, 1080), H = 86, L = 10, R = 10, pw = W - L - R;
    const s = svg(W, H);
    s.setAttribute("aria-label", "Composición del registro");
    const tot = segs.reduce((a, v) => a + v.hours, 0) || 1;
    const items = [], labels = [];
    let cx = L;
    segs.forEach((seg, k) => {
      const w = (seg.hours / tot) * pw, inv = seg.kind === "window";
      const rect = S("rect", { x: cx, y: 22, width: Math.max(w - 2, 1), height: 30, rx: 5, fill: CV(kindCol[seg.kind]) });
      rect.addEventListener("mousemove", ev => Tip.show(`<span class="tt">${seg.label}</span>` +
        `<b>${fmtHM(seg.hours * 3600)}</b> · ${nf(100 * seg.hours / tot, 1)} % del archivo`, ev));
      rect.addEventListener("mouseleave", Tip.hide);
      s.appendChild(rect);
      const box = { x: cx, y: 22, w: Math.max(w - 2, 1), h: 30 };
      items.push({ el: rect, id: String(k), box, base: { ...box, w: 0 }, k });
      if (w > 120) {
        labels.push(s.appendChild(T({ x: cx + w / 2, y: 35, "text-anchor": "middle", "font-size": 11.5, "font-weight": 600,
          fill: inv ? "#fff" : CV("--ink2"), "pointer-events": "none" }, seg.label)));
        labels.push(s.appendChild(T({ x: cx + w / 2, y: 48, "text-anchor": "middle", "font-size": 11,
          fill: inv ? "#fff" : CV("--muted"), "pointer-events": "none" }, nf(seg.hours) + " h")));
      }
      cx += w;
    });
    s.appendChild(T({ x: L, y: 12, "class": "axlbl" }, `Cómo se reparten las ${fmtHM(tot * 3600)} del archivo`));
    s.appendChild(T({ x: L, y: 74, "class": "axlbl" }, "Solo la ventana analizada se envía al modelo"));
    el.replaceChildren(s);
    emphasis(items.map(it => it.el));
    if (!FX) return;
    // los tramos del archivo se construyen de izquierda a derecha y luego aparecen sus etiquetas
    const m = FX.memo(el, key, W);
    animateBars(m, items, { stagger: 90, enter: 300 });
    labels.forEach(t => FX.play(t, [{ opacity: 0 }, { opacity: 1 }], { age: m.age, delay: 300 + 90 * segs.length, duration: 200, fill: "backwards" }));
  }

  /* ── Visor de señal multicanal ──
     Pide la envolvente mín-máx a la API por ventana (nunca la señal cruda
     completa) y pinta de fondo el estadio final de cada época.             */
  const SCALE = { eeg: 100, eog: 250 };   // µV a media altura de la fila
  // niveles de «Zoom +», en fracciones de la época: 15 s, 10 s, 5 s y 2 s con épocas de 30 s
  const ZOOM_FR = [1 / 2, 1 / 3, 1 / 6, 1 / 15];

  const SignalViewer = {
    d: null, el: null, win: 90, epoch: 0, channels: [], gain: 1, corr: null, info: {}, onSelect: null, _token: 0,
    zoom: null, onZoom: null,          // zoom de tiempo (US-07): [t0, t1] en segundos de la ventana

    init(el, d, opts) {
      Object.assign(this, { el, d, zoom: null }, opts);
    },

    /* el zoom vale mientras la época elegida esté dentro del tramo acercado */
    zoomHas(e) {
      const z = this.zoom, EP = this.d.night.epoch_s;
      return !!z && (e + 1) * EP > z[0] && e * EP < z[1];
    },
    zoomed() { return !!this.d && this.zoomHas(this.epoch); },
    setZoom(z) {
      this.zoom = z;
      // el tramo acercado tiene que incluir la época elegida: si no, se elige la del centro del tramo
      if (z && !this.zoomHas(this.epoch)) {
        const e = Math.max(0, Math.min(this.d.night.n_epochs - 1, Math.floor((z[0] + z[1]) / 2 / this.d.night.epoch_s)));
        this.epoch = e;
        if (this.onSelect) this.onSelect(e);
      }
      this.render();
      if (this.onZoom) this.onZoom();
    },

    /* hasta dónde se puede correr un tramo de `span` segundos: dentro de la época elegida si es más
       corto que ella; si es más largo, mientras la época siga entera a la vista */
    panLimits(span) {
      const EP = this.d.night.epoch_s, a = this.epoch * EP, b = a + EP, total = this.d.night.n_epochs * EP;
      return span < EP - 1e-6 ? [a, b] : [Math.max(0, b - span), Math.min(total, a + span)];
    },
    canPan(dir) {
      if (!this.zoomed()) return false;
      const [z0, z1] = this.zoom, [lo, hi] = this.panLimits(z1 - z0);
      return dir < 0 ? z0 > lo + 0.05 : z1 < hi - 0.05;
    },
    /* ‹ › : el tramo acercado se corre medio tramo hacia ese lado, con la misma escala */
    pan(dir) {
      if (!this.canPan(dir)) return;
      const [z0, z1] = this.zoom, span = z1 - z0, [lo, hi] = this.panLimits(span);
      const a = Math.max(lo, Math.min(hi - span, z0 + (dir * span) / 2));
      this.setZoom([a, a + span]);
    },
    canZoom(dir) {
      if (!this.d) return false;
      if (dir < 0) return this.zoomed();
      const [r0, r1] = this.range();
      return r1 - r0 > ZOOM_FR[ZOOM_FR.length - 1] * this.d.night.epoch_s + 1e-6;
    },
    /* «Zoom +» / «Zoom −»: un nivel, centrado en lo que se ve (sin zoom, en la época elegida);
       alejar desde el nivel más abierto vuelve a la ventana elegida */
    zoomStep(dir) {
      const EP = this.d.night.epoch_s, levels = ZOOM_FR.map(f => f * EP), on = this.zoomed();
      const [r0, r1] = this.range(), span = r1 - r0;
      const next = dir > 0 ? levels.find(s => s < span - 1e-6) : [...levels].reverse().find(s => s > span + 1e-6);
      if (next == null) { if (dir < 0 && on) this.setZoom(null); return; }
      const c = on ? (r0 + r1) / 2 : (this.epoch + 0.5) * EP, [lo, hi] = this.panLimits(next);
      const a = Math.max(lo, Math.min(hi - next, c - next / 2));
      this.setZoom([a, a + next]);
    },

    range() {
      if (this.zoom && this.zoomHas(this.epoch)) return [this.zoom[0], this.zoom[1]];
      const EP = this.d.night.epoch_s, total = this.d.night.n_epochs * EP;
      let t0;
      if (this.win <= 30) t0 = this.epoch * EP;
      else if (this.win <= 90) t0 = (this.epoch - 1) * EP;
      else t0 = (this.epoch + 0.5) * EP - this.win / 2;
      t0 = Math.max(0, Math.min(total - this.win, t0));
      return [t0, Math.min(total, t0 + this.win)];
    },

    async render() {
      if (!this.d || !this.el) return;
      if (this.zoom && !this.zoomHas(this.epoch)) {      // se eligió otra época fuera del tramo: sin zoom
        this.zoom = null;
        if (this.onZoom) this.onZoom();
      }
      const my = ++this._token;
      const d = this.d, EP = d.night.epoch_s, T0 = d.night.start_clock_s, n = d.night.n_epochs;
      const [t0, t1] = this.range(), dur = t1 - t0;
      const chans = this.channels.length ? this.channels : [];
      const W = fitW(this.el, 340, 1080), L = 76, R = 8, Tp = 6, pw = W - L - R;
      // con pocos canales cada trazo crece; el EMG (envolvente lenta) va siempre en una fila baja
      const slow = slot => (d.channels.fs[slot] || 0) < 10;
      const tall = Math.max(66, Math.min(120, Math.floor(250 / Math.max(1, chans.filter(c => !slow(c)).length))));
      const baseH = slot => (slow(slot) ? 44 : tall);

      this.el.classList.add("loading");
      let env = { traces: {} };
      if (chans.length) {
        try {
          env = await MaiaAPI.getSignal(d.id, t0, dur, Math.round(pw), chans);
        } catch (e) { this.el.classList.remove("loading"); return; }
      }
      if (my !== this._token) return;       // llegó tarde: hubo otra petición después
      this.el.classList.remove("loading");

      // alto de cada fila (amplitud sin recortes): la escala (px por µV) la fija la amplitud elegida;
      // si los picos de lo que se ve no caben en el alto base, la fila crece en medios pasos hasta que
      // entren (con tope), y al bajar la amplitud vuelve a encogerse
      const geo = {};
      chans.forEach(slot => {
        const tr = env.traces[slot], info = this.info[slot] || { kind: "eeg" };
        const peak = tr ? Math.max(0, ...tr.max.map(Math.abs), ...tr.min.map(Math.abs)) : 0;
        const amp0 = SCALE[info.kind] || (tr ? Math.max(1, peak) * 1.1 : 100);
        const half0 = baseH(slot) / 2 - 2, k = half0 / (amp0 / this.gain), need = peak * k;
        const half = need > half0 ? Math.min(Math.max(4 * half0, 200), (half0 * Math.ceil((2 * need) / half0)) / 2) : half0;
        geo[slot] = { h: 2 * half + 4, k, amp: half / k, clipped: need > half + 0.5 };
      });
      const TRK = 20, rowsH = chans.reduce((a, c) => a + geo[c].h + 6, 0);
      const H = Tp + rowsH + TRK + 34;

      const s = svg(W, H);
      s.setAttribute("aria-label", "Señal del registro");
      const x = t => L + ((t - t0) / dur) * pw;
      const e0 = Math.floor(t0 / EP), e1 = Math.ceil(t1 / EP);
      const final = d.epochs.final;

      // lo que depende del tiempo (fondo, trazos, pista) va en un grupo que se desliza al cambiar
      // de época, recortado al área del gráfico para no invadir las etiquetas de los canales
      const clipId = `sigclip${my}`;
      const clip = S("clipPath", { id: clipId });
      clip.appendChild(S("rect", { x: L, y: 0, width: pw, height: H }));
      s.appendChild(S("defs")).appendChild(clip);
      const slide = S("g");
      s.appendChild(S("g", { "clip-path": `url(#${clipId})` })).appendChild(slide);
      // partes que se animan por separado: fondo, una fila por canal (trazo y etiquetas) y la pista
      const bgG = slide.appendChild(S("g")), rows = {};

      // fondo: estadio final por época; atenuadas las que no son la seleccionada
      for (let e = e0; e < e1; e++) {
        if (e < 0 || e >= n) continue;
        const a = Math.max(e * EP, t0), b = Math.min((e + 1) * EP, t1);
        bgG.appendChild(S("rect", { x: x(a), y: Tp, width: Math.max(x(b) - x(a), .6), height: rowsH,
          fill: STG[final[e]].c, "fill-opacity": .14 }));
        if (e !== this.epoch && dur <= 300) bgG.appendChild(S("rect", { x: x(a), y: Tp, width: Math.max(x(b) - x(a), .6),
          height: rowsH, fill: CV("--surface-1"), "fill-opacity": .45 }));
        if (e > e0 && dur <= 300) bgG.appendChild(S("line", { x1: x(e * EP), x2: x(e * EP), y1: Tp, y2: Tp + rowsH,
          stroke: CV("--axis"), "stroke-dasharray": "3 3", "vector-effect": "non-scaling-stroke" }));
      }
      let box = null, boxBox = null;
      if (this.epoch >= e0 && this.epoch < e1) {
        const a = Math.max(this.epoch * EP, t0), b = Math.min((this.epoch + 1) * EP, t1);
        boxBox = { x: x(a) + 1, y: Tp + 1, w: Math.max(x(b) - x(a) - 2, 1), h: rowsH - 2 };
        box = s.appendChild(S("rect", { x: boxBox.x, y: boxBox.y, width: boxBox.w, height: boxBox.h,
          fill: "none", stroke: CV("--s1"), "stroke-width": 2, rx: 3, "vector-effect": "non-scaling-stroke" }));
      }

      // trazos
      let y0 = Tp;
      chans.forEach(slot => {
        const g = geo[slot], h = g.h, mid = y0 + h / 2, tr = env.traces[slot], amp = g.amp;
        const info = this.info[slot] || { kind: "eeg", name: slot };
        const used = d.channels.selected.includes(slot);
        const rowG = slide.appendChild(S("g")), labG = s.appendChild(S("g"));
        rows[slot] = { mid, h, k: g.k, rowG, labG };
        rowG.appendChild(S("line", { x1: L, x2: W - R, y1: mid, y2: mid, stroke: CV("--grid") }));
        labG.appendChild(T({ x: L - 8, y: mid - 2, "text-anchor": "end", "font-size": 12, "font-weight": 650,
          fill: CV(used ? "--ink" : "--muted") }, info.name));
        labG.appendChild(T({ x: L - 8, y: mid + 11, "text-anchor": "end", "font-size": 10.5, fill: CV("--muted") },
          `±${Math.round(amp)} µV${used ? "" : " · no usado"}`));
        if (g.clipped) {            // ni con el tope de alto caben los picos: se avisa que el trazo va recortado
          const w = labG.appendChild(T({ x: L - 8, y: mid + 24, "text-anchor": "end", "font-size": 10.5, "font-weight": 600,
            fill: CV("--warn-text") }, "recortada"));
          w.appendChild(S("title")).textContent = "Hay picos más altos que el alto máximo de la fila. Baje la amplitud para verlos completos.";
        }
        if (tr) {
          const k = tr.min.length, yv = v => mid - Math.max(-amp, Math.min(amp, v)) * g.k;
          let p = "M";
          for (let i = 0; i < k; i++) p += `${(L + (i / k) * pw).toFixed(1)} ${yv(tr.max[i]).toFixed(1)}${i < k - 1 ? "L" : ""}`;
          for (let i = k - 1; i >= 0; i--) p += `L${(L + (i / k) * pw).toFixed(1)} ${yv(tr.min[i]).toFixed(1)}`;
          // el trazo también lleva borde: una envolvente plana (EMG de 1 Hz) se ve como línea
          // (non-scaling-stroke: el borde no engorda mientras el zoom de tiempo estira el trazo)
          rowG.appendChild(S("path", { d: p + "Z", fill: CV(used ? "--ink2" : "--muted"), "fill-opacity": used ? .78 : .5,
            stroke: CV(used ? "--ink2" : "--muted"), "stroke-width": .9, "stroke-linejoin": "round",
            "vector-effect": "non-scaling-stroke" }));
        }
        y0 += h + 6;
      });

      // pista de estadios (el color nunca va solo: lleva la etiqueta)
      const ty = Tp + rowsH + 4, trackG = slide.appendChild(S("g"));
      for (let e = e0; e < e1; e++) {
        if (e < 0 || e >= n) continue;
        const a = Math.max(e * EP, t0), b = Math.min((e + 1) * EP, t1), w = x(b) - x(a);
        trackG.appendChild(S("rect", { x: x(a) + .5, y: ty, width: Math.max(w - 1, .5), height: TRK - 4, rx: 3,
          fill: STG[final[e]].c }));
        if (w > 26) trackG.appendChild(T({ x: x(a) + w / 2, y: ty + 12, "text-anchor": "middle", "font-size": 10.5,
          "font-weight": 700, fill: "#fff" }, STG[final[e]].k));
        const stt = epochStatus(d, e, this.corr);
        if (stt && w > 6) trackG.appendChild(S("circle", { cx: x(b) - 5, cy: ty - 1, r: 3.5, fill: CV(STATUS[stt].v),
          stroke: CV("--surface-1"), "stroke-width": 1 }));
      }

      // eje x
      // con zoom de pocos segundos, las marcas van cada segundo y con décimas
      const fmt = dur < 20 ? (v => clockHMS(v) + "," + Math.floor((v % 1) * 10)) : dur <= 120 ? clockHMS : clockHM;
      const per = dur <= 12 ? 1 : dur <= 40 ? 5 : 15;
      const ticks = Math.max(2, Math.min(dur <= 90 ? Math.round(dur / per) : 6, Math.floor(pw / 85)));
      for (let i = 0; i <= ticks; i++) {
        const t = t0 + (i / ticks) * dur;
        s.appendChild(T({ x: x(t), y: H - 12, "text-anchor": "middle", "class": "tick" },
          T0 != null ? fmt(T0 + t) : nf(t / 60, 1) + " min"));
      }

      // interacción: hora y estadio bajo el cursor; clic para elegir época
      const xh = S("line", { y1: Tp, y2: Tp + rowsH + TRK, stroke: CV("--ink2"), "stroke-dasharray": "3 3", opacity: 0, "class": "xhair" });
      s.appendChild(xh);
      const capt = S("rect", { x: L, y: Tp, width: pw, height: rowsH + TRK, fill: "transparent", "class": "capt" });
      const tAt = ev => t0 + Math.max(0, Math.min(1, (svgPt(s, ev, W, H).x - L) / pw)) * dur;
      capt.addEventListener("mousemove", ev => {
        if (ev.buttons) { xh.setAttribute("opacity", 0); Tip.hide(); return; }  // arrastrando: sin tooltip
        const t = tAt(ev), e = Math.min(n - 1, Math.floor(t / EP)), X = x(t);
        xh.setAttribute("x1", X); xh.setAttribute("x2", X); xh.setAttribute("opacity", 1);
        Tip.show(`<span class="tt">${T0 != null ? clockHMS(T0 + t) + " · " : ""}época ${e + 1}</span>` +
          `Estadio final: <b>${STG[final[e]].k}</b>` + (e !== this.epoch ? "<br>Clic para revisar esta época" : "") +
          "<br>Arrastre para acercar un tramo", ev);
      });
      capt.addEventListener("mouseleave", () => { xh.setAttribute("opacity", 0); Tip.hide(); });
      // arrastrar: acercar al menos 2 s de señal; clic: elegir la época bajo el cursor;
      // doble clic con zoom: quitarlo
      dragZoom(s, capt, { W, H, L, pw, y: Tp, h: rowsH + TRK, at: tAt, min: 2, onZoom: z => this.setZoom(z),
        onClick: ev => {
          const e = Math.min(n - 1, Math.floor(tAt(ev) / EP));
          if (e !== this.epoch && this.onSelect) this.onSelect(e);
        },
        host: this.el, onDouble: this.zoomed() ? () => this.setZoom(null) : null });
      s.appendChild(capt);
      const oldH = this.el.offsetHeight;
      this.el.replaceChildren(s);

      // movimiento respecto de lo que se veía antes (misma noche y mismo ancho):
      //  - zoom de tiempo (30 s ↔ 30 min): la señal se estira o comprime desde la escala anterior
      //  - canales: las filas que quedan se reacomodan, la nueva entra y el visor cambia de alto
      //  - otra época cerca, o ‹ › con zoom: el contenido llega desde donde estaba (se desliza)
      //  - salto lejano: la señal entra desde el lado del salto
      //  - misma ventana con otra amplitud: las ondas se estiran desde la escala anterior y las
      //    filas que crecen o se encogen se reacomodan
      //  - el recuadro de la época elegida pasa de su caja anterior a la nueva
      //  - si el visor cambia de alto, crece o se encoge en vez de saltar
      const prev = this._prev, chKey = chans.join(",");
      if (FX && FX.enabled() && prev && prev.id === d.id && prev.W === W) {
        const dur280 = { duration: 280 };
        const dx = ((t0 - prev.t0) / dur) * pw;
        const moved = prev.ch !== chKey || prev.gain !== this.gain || prev.rowsH !== rowsH;
        if (prev.dur !== dur) {
          const k = dur / prev.dur, sx = ((t0 - prev.t0) / prev.dur) * pw;
          slide.style.transformOrigin = `${L}px 0`;
          FX.play(slide, [{ transform: `translate(${sx}px, 0) scaleX(${k})` }, { transform: "none" }], { duration: 340 });
        } else if (moved && Math.abs(dx) <= 0.5) {
          const pr = prev.rows || {};
          chans.forEach(slot => {
            const r = rows[slot], o = pr[slot];
            if (o) {
              const dy = o.mid - r.mid;
              r.rowG.style.transformOrigin = `0 ${r.mid}px`;
              FX.play(r.rowG, [{ transform: `translateY(${dy}px) scaleY(${o.k / r.k})` }, { transform: "none" }], dur280);
              FX.play(r.labG, [{ transform: `translateY(${dy}px)` }, { transform: "none" }], dur280);
            } else {
              [r.rowG, r.labG].forEach(g => FX.play(g, [{ opacity: 0, transform: "translateY(-10px)" }, { opacity: 1, transform: "none" }],
                { duration: 280, delay: 60, fill: "backwards" }));
            }
          });
          if (prev.rowsH && rowsH && prev.rowsH !== rowsH) {
            bgG.style.transformOrigin = `0 ${Tp}px`;
            FX.play(bgG, [{ transform: `scaleY(${prev.rowsH / rowsH})` }, { transform: "none" }], dur280);
          }
          if (prev.ty !== ty) FX.play(trackG, [{ transform: `translateY(${prev.ty - ty}px)` }, { transform: "none" }], dur280);
        } else if (Math.abs(dx) > 0.5 && Math.abs(dx) < pw * 0.9) {
          FX.play(slide, [{ transform: `translateX(${dx}px)` }, { transform: "none" }], { duration: 230 });
        } else if (Math.abs(dx) >= pw * 0.9) {
          const dir = t0 > prev.t0 ? 1 : -1;            // hacia adelante entra por la derecha
          FX.play(slide, [{ transform: `translateX(${dir * 70}px)`, opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 260 });
        }
        const newH = this.el.offsetHeight;
        if (Math.abs(newH - oldH) > 2) {
          this.el.style.overflow = "hidden";
          const a = FX.play(this.el, [{ height: oldH + "px" }, { height: newH + "px" }], dur280);
          if (a) a.onfinish = a.oncancel = () => { this.el.style.overflow = ""; }; else this.el.style.overflow = "";
        }
        if (box && prev.box) FX.morphBox(box, prev.box, boxBox, { duration: 260 });
      }
      const rowsMemo = {};
      chans.forEach(slot => { rowsMemo[slot] = { mid: rows[slot].mid, h: rows[slot].h, k: rows[slot].k }; });
      this._prev = { id: d.id, W, dur, t0, gain: this.gain, ch: chKey, box: boxBox, rows: rowsMemo, rowsH, ty };
      const now = document.getElementById("sigNow");
      if (now) now.textContent = T0 != null ? `${fmt(T0 + t0)} – ${fmt(T0 + t1)}` : "";
    }
  };

  window.MaiaCharts = {
    STG, STATUS, Tip, epochStatus, renderStrip, renderCombos, renderHypnogram, renderStageBars,
    renderConfusion, renderF1, renderQuality, SignalViewer, SCALE
  };
})();
