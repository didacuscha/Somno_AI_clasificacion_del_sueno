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
    records.forEach((r, i) => {
      const f = r.review.flagged_fraction, over = r.review.whole_night_recommended;
      const signed = r.review.status === "finalized";
      const c = S("circle", { cx: x(f), cy: 46, r: over ? 6.5 : 5.5,
        fill: CV(signed ? "--good" : over ? "--warn" : "--s1"), "fill-opacity": signed ? .9 : .75,
        stroke: CV("--surface-1"), "stroke-width": 2, style: "cursor:pointer" });
      c.addEventListener("mousemove", ev => Tip.show(
        `<span class="tt">${esc(r.subject_code)} · ${esc(r.combination_name)}</span>` +
        `${esc(r.file_name)}<br>Marcadas: <b>${pct(f)}</b> (${r.review.flagged} de ${fmtInt(r.n_epochs)} épocas)<br>` +
        (signed ? "Revisión finalizada" : `${r.review.pending} pendientes`), ev));
      c.addEventListener("mouseleave", Tip.hide);
      if (el._onPick) c.addEventListener("click", () => { Tip.hide(); el._onPick(r.id); });
      s.appendChild(c);
    });
    s.appendChild(T({ x: L, y: 96, "class": "axlbl" },
      "Porcentaje de épocas que el modelo marcó para revisión (confianza bajo el umbral) · verde: revisión finalizada · clic para abrir"));
    el.replaceChildren(s);
  }

  /* ── Las 12 combinaciones de canales con su MF1 de test (Tabla IV del informe) ── */
  function renderCombos(el, expected, names, selected, goal) {
    const keys = Object.keys(expected).sort((a, b) => expected[b].test_mf1 - expected[a].test_mf1);
    const W = fitW(el, 340, 640), rowH = 15, Tp = 6, L = 150, R = 50, H = Tp + keys.length * rowH + 30, pw = W - L - R;
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
      s.appendChild(T({ x: x(e.test_mf1) + 5, y: y + 10.5, "font-size": 10, fill: CV(on ? "--ink" : "--muted"),
        "font-weight": on ? 700 : 400 }, nf(e.test_mf1, 3)));
    });
    s.appendChild(T({ x: L, y: H - 2, "class": "axlbl" }, `F1 macro en el test (16 sujetos; 1 = perfecto) · línea punteada: meta ${nf(goal, 2)}`));
    el.replaceChildren(s);
  }

  /* ── Hipnograma de la noche con marcas de revisión, confianza y referencia ── */
  function renderHypnogram(el, d, { view, selected, viewRange, corr, onSelect }) {
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
    s.setAttribute("aria-label", "Hipnograma de la noche");
    const x = e => L + (e / n) * pw;
    const rowY = st => mainTop + ROWS.indexOf(st) * rowH + rowH / 2;

    ROWS.forEach((st, i) => {
      s.appendChild(S("rect", { x: L, y: mainTop + i * rowH, width: pw, height: rowH,
        fill: i % 2 ? CV("--surface-2") : "transparent", "fill-opacity": .6 }));
      s.appendChild(T({ x: L - 8, y: mainTop + i * rowH + rowH / 2 + 4, "text-anchor": "end",
        "font-size": 11, "font-weight": 650, fill: CV("--ink2") }, STG[st].k));
    });
    // horas
    const firstHour = T0 == null ? null : Math.ceil(T0 / 3600) * 3600;
    if (firstHour != null) {
      for (let t = firstHour; t <= T0 + n * EP; t += 3600) {
        const xx = x((t - T0) / EP);
        s.appendChild(S("line", { x1: xx, x2: xx, y1: mainTop, y2: confTop + confH, stroke: CV("--grid") }));
        s.appendChild(T({ x: xx, y: H - 6, "text-anchor": "middle", "class": "tick" }, clockHM(t)));
      }
    }
    // ventana visible del visor
    if (viewRange) {
      s.appendChild(S("rect", { x: x(viewRange[0]), y: mainTop - 4, width: Math.max(2, x(viewRange[1]) - x(viewRange[0])),
        height: mainH + 8, fill: CV("--ink"), "fill-opacity": .07, rx: 3 }));
    }
    // escalones: tramos horizontales por racha + conectores verticales
    let run = 0;
    for (let e = 1; e <= n; e++) {
      if (e === n || stages[e] !== stages[run]) {
        const st = stages[run], y = rowY(st), hh = st === 4 ? 9 : 6;
        s.appendChild(S("rect", { x: x(run), y: y - hh / 2, width: Math.max(1, x(e) - x(run)), height: hh,
          rx: 1.5, fill: STG[st].c }));
        if (e < n) s.appendChild(S("line", { x1: x(e), x2: x(e), y1: y, y2: rowY(stages[e]),
          stroke: CV("--axis"), "stroke-width": 1 }));
        run = e;
      }
    }
    // marcas de revisión (y épocas cambiadas aunque no estuvieran marcadas)
    s.appendChild(T({ x: L - 8, y: flagTop + 8, "text-anchor": "end", "class": "tick" }, "revisar"));
    s.appendChild(S("rect", { x: L, y: flagTop, width: pw, height: flagH, rx: 3, fill: CV("--surface-2") }));
    const tickW = Math.max(1.2, pw / n);
    for (let e = 0; e < n; e++) {
      const stt = epochStatus(d, e, corr);
      if (!stt) continue;
      s.appendChild(S("rect", { x: x(e), y: flagTop, width: tickW, height: flagH, fill: CV(STATUS[stt].v) }));
    }
    // confianza
    s.appendChild(T({ x: L - 8, y: confTop + 12, "text-anchor": "end", "class": "tick" }, "confianza"));
    const cy = v => confTop + confH - v * confH;
    let area = `M${L} ${cy(0)}`;
    for (let e = 0; e < n; e++) area += `L${x(e + 0.5).toFixed(1)} ${cy(ep.confidence[e]).toFixed(1)}`;
    area += `L${L + pw} ${cy(0)}Z`;
    s.appendChild(S("path", { d: area, fill: CV("--s1"), "fill-opacity": .22, stroke: CV("--s1"),
      "stroke-width": .8, "stroke-opacity": .7 }));
    const thr = d.model.threshold;
    s.appendChild(S("line", { x1: L, x2: L + pw, y1: cy(thr), y2: cy(thr), stroke: CV("--warn-text"),
      "stroke-dasharray": "4 3", "stroke-width": 1.2 }));
    s.appendChild(T({ x: L + pw - 2, y: cy(thr) - 4, "text-anchor": "end", "font-size": 10, fill: CV("--warn-text"),
      "font-weight": 600 }, `umbral ${nf(thr, 2)}`));
    // referencia
    if (hasRef) {
      s.appendChild(T({ x: L - 8, y: refTop + 11, "text-anchor": "end", "class": "tick" }, "experto"));
      let r0 = 0;
      for (let e = 1; e <= n; e++) {
        if (e === n || ep.reference[e] !== ep.reference[r0]) {
          const st = ep.reference[r0];
          s.appendChild(S("rect", { x: x(r0), y: refTop, width: Math.max(1, x(e) - x(r0)), height: refH,
            fill: st >= 0 ? STG[st].c : CV("--surface-3") }));
          r0 = e;
        }
      }
    }
    // época seleccionada
    if (selected != null) {
      const xs = x(selected + 0.5);
      s.appendChild(S("line", { x1: xs, x2: xs, y1: mainTop - 6, y2: refTop + refH + 2, stroke: CV("--ink"),
        "stroke-width": 1.6 }));
      s.appendChild(S("path", { d: `M${xs - 5} ${mainTop - 8}L${xs + 5} ${mainTop - 8}L${xs} ${mainTop - 2}Z`,
        fill: CV("--ink") }));
    }
    // interacción
    const xh = S("line", { y1: mainTop, y2: refTop + refH, stroke: CV("--ink2"), "stroke-dasharray": "3 3",
      opacity: 0, "class": "xhair" });
    s.appendChild(xh);
    const capt = S("rect", { x: L, y: 0, width: pw, height: refTop + refH + 4, fill: "transparent", "class": "capt" });
    const epochAt = ev => Math.max(0, Math.min(n - 1, Math.floor(((svgPt(s, ev, W, H).x - L) / pw) * n)));
    capt.addEventListener("mousemove", ev => {
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
    capt.addEventListener("click", ev => onSelect && onSelect(epochAt(ev)));
    s.appendChild(capt);
    el.replaceChildren(s);
  }

  /* ── Tiempo por estadio: modelo, final y referencia ── */
  function renderStageBars(el, rows) {
    const W = fitW(el, 360, 1080), L = 92, R = 12, rowH = 30, gap = 12, Tp = 4, pw = W - L - R;
    const H = Tp + rows.length * (rowH + gap) + 26;
    const s = svg(W, H);
    s.setAttribute("aria-label", "Minutos en cada estadio");
    const total = Math.max(...rows.map(r => STG.reduce((a, st) => a + (r.stages[st.k] ? r.stages[st.k].min : 0), 0)), 1);
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
        if (w > 58) s.appendChild(T({ x: cx + w / 2, y: y + rowH / 2 + 4, "text-anchor": "middle", "font-size": 11,
          "font-weight": 700, fill: k === 0 ? "#0b2340" : "#fff" }, `${st.k} ${Math.round(m)}′`));
        cx += w;
      });
    });
    s.appendChild(T({ x: L, y: H - 6, "class": "axlbl" },
      "Minutos por estadio (′ = minutos) · las barras miden lo mismo: la ventana analizada"));
    el.replaceChildren(s);
  }

  /* ── Matriz de confusión (tabla HTML con intensidad por fila) ── */
  function renderConfusion(el, cm, colLabel) {
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
  }

  /* ── F1 por estadio: modelo frente a final ── */
  function renderF1(el, a, b) {
    const W = fitW(el, 300, 520), H = 180, L = 34, R = 10, Tp = 10, B = 34, pw = W - L - R, ph = H - Tp - B;
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
      });
      s.appendChild(T({ x: gx, y: H - B + 16, "text-anchor": "middle", "font-size": 11.5, "font-weight": 650,
        fill: CV("--ink2") }, st.k));
    });
    s.appendChild(T({ x: L, y: H - 4, "class": "axlbl" }, b ? "barra clara: modelo · barra llena: final con revisión" : "F1 del modelo por estadio"));
    el.replaceChildren(s);
  }

  /* ── Composición del registro ── */
  function renderQuality(el, segs) {
    const kindCol = { outside: "--surface-3", window: "--s1" };
    const W = fitW(el, 360, 1080), H = 86, L = 10, R = 10, pw = W - L - R;
    const s = svg(W, H);
    s.setAttribute("aria-label", "Composición del registro");
    const tot = segs.reduce((a, v) => a + v.hours, 0) || 1;
    let cx = L;
    segs.forEach(seg => {
      const w = (seg.hours / tot) * pw, inv = seg.kind === "window";
      const rect = S("rect", { x: cx, y: 22, width: Math.max(w - 2, 1), height: 30, rx: 5, fill: CV(kindCol[seg.kind]) });
      rect.addEventListener("mousemove", ev => Tip.show(`<span class="tt">${seg.label}</span>` +
        `<b>${fmtHM(seg.hours * 3600)}</b> · ${nf(100 * seg.hours / tot, 1)} % del archivo`, ev));
      rect.addEventListener("mouseleave", Tip.hide);
      s.appendChild(rect);
      if (w > 120) {
        s.appendChild(T({ x: cx + w / 2, y: 35, "text-anchor": "middle", "font-size": 11.5, "font-weight": 600,
          fill: inv ? "#fff" : CV("--ink2") }, seg.label));
        s.appendChild(T({ x: cx + w / 2, y: 48, "text-anchor": "middle", "font-size": 11,
          fill: inv ? "#fff" : CV("--muted") }, nf(seg.hours) + " h"));
      }
      cx += w;
    });
    s.appendChild(T({ x: L, y: 12, "class": "axlbl" }, `Cómo se reparten las ${fmtHM(tot * 3600)} del archivo`));
    s.appendChild(T({ x: L, y: 74, "class": "axlbl" }, "Solo la ventana analizada se envía al modelo"));
    el.replaceChildren(s);
  }

  /* ── Visor de señal multicanal ──
     Pide la envolvente mín-máx a la API por ventana (nunca la señal cruda
     completa) y pinta de fondo el estadio final de cada época.             */
  const SCALE = { eeg: 100, eog: 250 };   // µV a media altura de la fila

  const SignalViewer = {
    d: null, el: null, win: 90, epoch: 0, channels: [], gain: 1, corr: null, info: {}, onSelect: null, _token: 0,

    init(el, d, opts) {
      Object.assign(this, { el, d }, opts);
    },

    range() {
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
      const my = ++this._token;
      const d = this.d, EP = d.night.epoch_s, T0 = d.night.start_clock_s, n = d.night.n_epochs;
      const [t0, t1] = this.range(), dur = t1 - t0;
      const chans = this.channels.length ? this.channels : [];
      const W = fitW(this.el, 340, 1080), L = 76, R = 8, Tp = 6, pw = W - L - R;
      // con pocos canales cada trazo crece; el EMG (envolvente lenta) va siempre en una fila baja
      const slow = slot => (d.channels.fs[slot] || 0) < 10;
      const tall = Math.max(66, Math.min(120, Math.floor(250 / Math.max(1, chans.filter(c => !slow(c)).length))));
      const rowH = slot => (slow(slot) ? 44 : tall);
      const TRK = 20, rowsH = chans.reduce((a, c) => a + rowH(c) + 6, 0);
      const H = Tp + rowsH + TRK + 34;

      this.el.classList.add("loading");
      let env = { traces: {} };
      if (chans.length) {
        try {
          env = await MaiaAPI.getSignal(d.id, t0, dur, Math.round(pw), chans);
        } catch (e) { this.el.classList.remove("loading"); return; }
      }
      if (my !== this._token) return;       // llegó tarde: hubo otra petición después
      this.el.classList.remove("loading");

      const s = svg(W, H);
      s.setAttribute("aria-label", "Señal del registro");
      const x = t => L + ((t - t0) / dur) * pw;
      const e0 = Math.floor(t0 / EP), e1 = Math.ceil(t1 / EP);
      const final = d.epochs.final;

      // fondo: estadio final por época; atenuadas las que no son la seleccionada
      for (let e = e0; e < e1; e++) {
        if (e < 0 || e >= n) continue;
        const a = Math.max(e * EP, t0), b = Math.min((e + 1) * EP, t1);
        s.appendChild(S("rect", { x: x(a), y: Tp, width: Math.max(x(b) - x(a), .6), height: rowsH,
          fill: STG[final[e]].c, "fill-opacity": .14 }));
        if (e !== this.epoch && this.win <= 300) s.appendChild(S("rect", { x: x(a), y: Tp, width: Math.max(x(b) - x(a), .6),
          height: rowsH, fill: CV("--surface-1"), "fill-opacity": .45 }));
        if (e > e0 && this.win <= 300) s.appendChild(S("line", { x1: x(e * EP), x2: x(e * EP), y1: Tp, y2: Tp + rowsH,
          stroke: CV("--axis"), "stroke-dasharray": "3 3" }));
      }
      if (this.epoch >= e0 && this.epoch < e1) {
        const a = Math.max(this.epoch * EP, t0), b = Math.min((this.epoch + 1) * EP, t1);
        s.appendChild(S("rect", { x: x(a) + 1, y: Tp + 1, width: Math.max(x(b) - x(a) - 2, 1), height: rowsH - 2,
          fill: "none", stroke: CV("--s1"), "stroke-width": 2, rx: 3 }));
      }

      // trazos
      let y0 = Tp;
      chans.forEach(slot => {
        const h = rowH(slot), mid = y0 + h / 2, tr = env.traces[slot];
        const info = this.info[slot] || { kind: "eeg", name: slot };
        const used = d.channels.selected.includes(slot);
        let amp = SCALE[info.kind];
        if (!amp && tr) amp = Math.max(1, ...tr.max.map(Math.abs), ...tr.min.map(Math.abs)) * 1.1;
        amp = (amp || 100) / this.gain;
        s.appendChild(S("line", { x1: L, x2: W - R, y1: mid, y2: mid, stroke: CV("--grid") }));
        s.appendChild(T({ x: L - 8, y: mid - 2, "text-anchor": "end", "font-size": 12, "font-weight": 650,
          fill: CV(used ? "--ink" : "--muted") }, info.name));
        s.appendChild(T({ x: L - 8, y: mid + 11, "text-anchor": "end", "font-size": 10.5, fill: CV("--muted") },
          `±${Math.round(amp)} µV${used ? "" : " · no usado"}`));
        if (tr) {
          const k = tr.min.length, yv = v => mid - (Math.max(-amp, Math.min(amp, v)) / amp) * (h / 2 - 2);
          let p = "M";
          for (let i = 0; i < k; i++) p += `${(L + (i / k) * pw).toFixed(1)} ${yv(tr.max[i]).toFixed(1)}${i < k - 1 ? "L" : ""}`;
          for (let i = k - 1; i >= 0; i--) p += `L${(L + (i / k) * pw).toFixed(1)} ${yv(tr.min[i]).toFixed(1)}`;
          // el trazo también lleva borde: una envolvente plana (EMG de 1 Hz) se ve como línea
          s.appendChild(S("path", { d: p + "Z", fill: CV(used ? "--ink2" : "--muted"), "fill-opacity": used ? .78 : .5,
            stroke: CV(used ? "--ink2" : "--muted"), "stroke-width": .9, "stroke-linejoin": "round" }));
        }
        y0 += h + 6;
      });

      // pista de estadios (el color nunca va solo: lleva la etiqueta)
      const ty = Tp + rowsH + 4;
      for (let e = e0; e < e1; e++) {
        if (e < 0 || e >= n) continue;
        const a = Math.max(e * EP, t0), b = Math.min((e + 1) * EP, t1), w = x(b) - x(a);
        s.appendChild(S("rect", { x: x(a) + .5, y: ty, width: Math.max(w - 1, .5), height: TRK - 4, rx: 3,
          fill: STG[final[e]].c }));
        if (w > 26) s.appendChild(T({ x: x(a) + w / 2, y: ty + 12, "text-anchor": "middle", "font-size": 10.5,
          "font-weight": 700, fill: "#fff" }, STG[final[e]].k));
        const stt = epochStatus(d, e, this.corr);
        if (stt && w > 6) s.appendChild(S("circle", { cx: x(b) - 5, cy: ty - 1, r: 3.5, fill: CV(STATUS[stt].v),
          stroke: CV("--surface-1"), "stroke-width": 1 }));
      }

      // eje x
      const fmt = dur <= 120 ? clockHMS : clockHM;
      const ticks = Math.max(2, Math.min(dur <= 90 ? Math.round(dur / 15) : 6, Math.floor(pw / 85)));
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
        const t = tAt(ev), e = Math.min(n - 1, Math.floor(t / EP)), X = x(t);
        xh.setAttribute("x1", X); xh.setAttribute("x2", X); xh.setAttribute("opacity", 1);
        Tip.show(`<span class="tt">${T0 != null ? clockHMS(T0 + t) + " · " : ""}época ${e + 1}</span>` +
          `Estadio final: <b>${STG[final[e]].k}</b>` + (e !== this.epoch ? "<br>Clic para revisar esta época" : ""), ev);
      });
      capt.addEventListener("mouseleave", () => { xh.setAttribute("opacity", 0); Tip.hide(); });
      capt.addEventListener("click", ev => {
        const e = Math.min(n - 1, Math.floor(tAt(ev) / EP));
        if (e !== this.epoch && this.onSelect) this.onSelect(e);
      });
      s.appendChild(capt);
      this.el.replaceChildren(s);
      const now = document.getElementById("sigNow");
      if (now) now.textContent = T0 != null ? `${fmt(T0 + t0)} – ${fmt(T0 + t1)}` : "";
    }
  };

  window.MaiaCharts = {
    STG, STATUS, Tip, epochStatus, renderStrip, renderCombos, renderHypnogram, renderStageBars,
    renderConfusion, renderF1, renderQuality, SignalViewer, SCALE
  };
})();
