/* ════════════════════════════════════════════════════════════════════
   MAIA · vista de resultados y revisión del especialista
   ────────────────────────────────────────────────────────────────────
   - avance del análisis paso a paso (diálogo que no se cierra solo);
   - vista clínica: hipnograma, revisión época a época (épocas vecinas,
     dos opciones más probables y evidencia de la señal), arquitectura
     del sueño, notas, detalles y bitácora;
   - «Desempeño del modelo»: lo técnico (acuerdo con la referencia,
     matriz de confusión, F1, desempeño esperado), aparte.
   Las decisiones se aplican al instante en pantalla y se envían a la
   API en orden; la respuesta de la API es la que manda al final.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const { nf, pct, clockHM, clockHMS, fmtHM, fmtInt, esc } = MaiaUtil;
  const C = MaiaCharts, STG = C.STG, UI = MaiaUI, $ = UI.$;
  const CFG = window.MAIA_CONFIG;

  const R = {
    cfg: { channels: {} },       // GET /config
    d: null,                     // registro mostrado (status done)
    id: null,                    // registro abierto (puede estar en proceso)
    corr: new Map(),             // época → estadio vigente del revisor
    sel: 0,
    view: "final",               // hipnograma: final | predicted
    cmView: "predicted",
    qFilt: "pending",
    tab: "clin",
    autoAdvance: true,
    chain: Promise.resolve(),    // PATCH en orden
    inflight: 0,
    pollTimer: null,
    viewerTimer: null,
    ev: new Map(),               // evidencia: "época|canal" → respuesta
    evBusy: new Set(),           // evidencia: claves pedidas que aún no llegan
    evGen: 0,                    // sube con cada decisión: las respuestas viejas no se guardan
    evTimer: null,
    evLast: "",                  // última evidencia dibujada: queda atenuada mientras llega la nueva
    evOpen: true,                // evidencia visible (se puede ocultar; vuelve a verse al abrir otra noche)
    evChannel: null,
    watch: null,                 // análisis que sigue el diálogo de avance
    flash: null,                 // última decisión {epoch, kind: ok|corr, t0}: su destello
    morph: {},                   // barras del inspector: de qué valores vienen y desde cuándo
    arch: null,                  // cifras de arquitectura: de qué valores vienen y desde cuándo
    hist: null,                  // bitácora: qué entrada la encabezaba (para resaltar las nuevas)
    freshNote: false,            // la nota recién guardada se resalta al dibujarse
    hypZoom: null,               // tramo acercado del hipnograma [e0, e1] en épocas (US-08)
    hypNote: false,              // aviso «las dos vistas coinciden» tras tocar la vista (US-01)
    go: () => {},
    onChange: () => {}
  };
  const V = C.SignalViewer;

  /* ── micro-animaciones (js/fx.js) ──
     Las vistas se redibujan varias veces por decisión (local → avance → API): cada
     efecto guarda cuándo empezó y el elemento nuevo lo retoma con esa edad. */
  const FX = window.MaiaFX;
  const FLASH = { ok: "--good", corr: "--corr" };
  const flashAge = () => (R.flash ? FX.now() - R.flash.t0 : Infinity);

  /* barras (probabilidades, bandas): pasan de los valores que mostraban a los nuevos */
  function morph(kind, els, key) {
    const t = FX.now(), m = R.morph[kind], vals = els.map(e => parseFloat(e.style.width) || 0);
    const same = m && m.key === key && m.vals.length === vals.length && m.vals.every((v, k) => Math.abs(v - vals[k]) <= 0.3);
    if (!same) R.morph[kind] = { key, vals, from: m ? m.vals : null, t0: t };
    const cur = R.morph[kind];
    FX.widths(els, cur.from && cur.from.length === vals.length ? cur.from : null, t - cur.t0);
  }

  const locked = () => R.d && R.d.review && (R.d.review.status === "finalized" || R.d.review.status === "signed_off");
  const isActive = () => !$("vRes").classList.contains("hidden") && !!R.d && R.tab === "clin";
  const clockOf = i => (R.d.night.start_clock_s != null ? R.d.night.start_clock_s + i * R.d.night.epoch_s : null);
  const MODE_TXT = { reference: "Noche según el hipnograma (±30 min)", range: "Rango horario", full: "Registro completo" };
  const stepLabels = () => R.cfg.steps || [];

  /* ══════════════ avance de un análisis recién lanzado (US-20) ══════════════ */
  function watch(summary, title) {
    stopWatch();
    R.watch = { id: summary.id, title, t0: Date.now() };
    $("procTitle").textContent = "Analizando la noche";
    $("procSub").textContent = title;
    UI.openDialog("procModal", { onClose: stopWatch });
    renderWatch(summary);
    pollWatch();
  }
  function stopWatch() {
    if (R.watch) clearTimeout(R.watch.timer);
    R.watch = null;
  }
  function pollWatch() {
    const w = R.watch;
    if (!w) return;
    w.timer = setTimeout(async () => {
      if (R.watch !== w) return;
      try {
        const r = await MaiaAPI.getRecord(w.id);
        if (R.watch !== w) return;
        renderWatch(r);
        if (r.status === "queued" || r.status === "running") pollWatch();
      } catch (e) { pollWatch(); }
    }, CFG.pollMs);
  }
  function renderWatch(r) {
    const w = R.watch;
    UI.steps($("procSteps"), r.progress, stepLabels());
    const secs = Math.max(0, Math.round((Date.now() - w.t0) / 1000));
    $("procElapsed").textContent = secs < 90 ? `${secs} s` : `${Math.round(secs / 60)} min`;
    const btns = $("procBtns"), msg = $("procMsg");
    if (r.status === "done") {
      const rv = r.review || {};
      $("procTitle").textContent = "Análisis listo";
      $("procElapsed").className = "pill ok";
      msg.className = "procmsg ok";
      msg.innerHTML = `${fmtInt(rv.n_epochs || r.n_epochs)} épocas estadificadas · ${fmtInt(rv.flagged || 0)} marcadas para revisar ` +
        `(${pct(rv.flagged_fraction || 0, 1)}).` + (rv.whole_night_recommended ? " Se sugiere revisar la noche completa." : "");
      btns.innerHTML = '<button class="ghost" id="pwClose">Cerrar</button><button class="cta" id="pwOpen">Ver resultados</button>';
      $("pwOpen").onclick = () => { const id = w.id; UI.closeDialog("procModal"); open(id); };
      $("pwClose").onclick = () => UI.closeDialog("procModal");
      $("pwOpen").focus();
      R.onChange();
    } else if (r.status === "failed") {
      $("procTitle").textContent = "El análisis no se pudo completar";
      $("procElapsed").className = "pill x";
      $("procElapsed").textContent = "falló";
      msg.className = "procmsg x";
      msg.textContent = (r.error || "Error desconocido.") + " No se guardó ningún resultado de esta noche.";
      btns.innerHTML = '<button class="ghost" id="pwClose">Cerrar</button><button class="ghost" id="pwConf">Cambiar la configuración</button>' +
        '<button class="cta" id="pwRetry">Reintentar</button>';
      $("pwClose").onclick = () => UI.closeDialog("procModal");
      $("pwConf").onclick = () => { UI.closeDialog("procModal"); R.go("vUp"); };
      $("pwRetry").onclick = async () => {
        try {
          const again = await MaiaAPI.retry(w.id);
          w.t0 = Date.now();
          $("procTitle").textContent = "Analizando la noche";
          renderWatch(again);
          pollWatch();
        } catch (e) { msg.textContent = e.message || "No se pudo reintentar."; }
      };
      $("pwRetry").focus();
      R.onChange();
    } else {
      $("procElapsed").className = "pill run";
      msg.className = "procmsg";
      msg.textContent = "El análisis corre en el servidor. Si cierra esta ventana sigue en segundo plano y queda en Registros.";
      if (!$("pwBg")) {
        btns.innerHTML = '<button class="ghost" id="pwBg">Seguir en segundo plano</button>';
        $("pwBg").onclick = () => {
          UI.closeDialog("procModal");
          R.go("vList");
          UI.toast("El análisis sigue en el servidor. Su avance se ve aquí, en Registros.");
        };
      }
    }
  }

  /* ══════════════ abrir un registro ══════════════ */
  /* opts.shared: elemento de origen (la fila de Registros) que se transforma en el encabezado;
     opts.label: el nombre de la noche, para mostrarlo ya en vez del esqueleto de carga */
  async function open(id, opts = {}) {
    stopPolling();
    R.id = id;
    R.d = null;
    // con transición entre vistas el cambio de vista llega un cuadro después: se espera antes de
    // dibujar, porque las gráficas toman el ancho de su contenedor visible
    const shown = R.go("vRes", { shared: opts.shared });
    $("resBody").classList.add("hidden");
    $("procPanel").classList.add("hidden");
    $("failBox").classList.add("hidden");
    if (opts.label) $("resFileName").textContent = opts.label;
    else $("resFileName").innerHTML = '<span class="skel" style="width:220px">&nbsp;</span>';
    $("resFileMeta").textContent = "";
    try {
      const r = await MaiaAPI.getRecord(id);
      await shown;
      route(r);
    } catch (e) {
      UI.toast(e.message || "No se pudo abrir el registro.", true);
      R.go("vList");
    }
  }

  function route(r) {
    if (r.id !== R.id) return;
    header(r);
    if (r.status === "done") return show(r);
    if (r.status === "failed") return showFailed(r);
    showProcessing(r);
  }

  function header(r) {
    $("resFileName").textContent = r.night_label && r.night_label !== r.file_name ? `${r.night_label} · ${r.file_name}` : r.file_name;
    const at = UI.parse(r.created_at), sex = UI.sexText(r.sex);
    // en el resumen `channels` es la lista; en el detalle, un objeto con la selección
    const slots = Array.isArray(r.channels) ? r.channels : (r.channels || {}).selected || [];
    $("resFileMeta").innerHTML = [
      `${esc(r.subject_code)} · ${UI.dLong.format(at)}, ${UI.dTime(at)}`,
      sex || r.age ? [sex, r.age ? `${r.age} años` : null].filter(Boolean).join(", ") : null,
      UI.chips(slots, R.cfg.channels),
      r.subset ? '<span class="chip sub">canales faltantes</span>' : null,
      r.created_by ? `por ${esc(r.created_by)}` : null
    ].filter(Boolean).join(" · ");
    $("btnCsv").disabled = r.status !== "done";
  }

  /* ── en proceso (abierto desde Registros) ── */
  function showProcessing(r) {
    $("procPanel").classList.remove("hidden");
    UI.steps($("procSteps2"), r.progress, stepLabels());
    const secs = Math.max(0, Math.round((Date.now() - UI.parse(r.created_at)) / 1000));
    $("procElapsed2").textContent = secs < 90 ? `${secs} s` : `${Math.round(secs / 60)} min`;
    R.pollTimer = setTimeout(async () => {
      if (R.id !== r.id || $("vRes").classList.contains("hidden")) return;
      try { route(await MaiaAPI.getRecord(r.id)); } catch (e) { R.pollTimer = setTimeout(() => showProcessing(r), CFG.pollMs); }
    }, CFG.pollMs);
  }

  function stopPolling() { clearTimeout(R.pollTimer); R.pollTimer = null; }

  function showFailed(r) {
    $("procPanel").classList.add("hidden");
    $("failBox").classList.remove("hidden");
    $("failText").textContent = r.error || "Error desconocido.";
    UI.steps($("failSteps"), r.progress, stepLabels());
    R.onChange();
  }

  /* ══════════════ resultado ══════════════ */
  function show(d) {
    $("procPanel").classList.add("hidden");
    $("failBox").classList.add("hidden");
    $("resBody").classList.remove("hidden");
    const first = !R.d || R.d.id !== d.id;
    R.d = d;
    R.corr = new Map(d.corrections.map(c => [c.epoch, c.stage]));
    if (first) {
      R.ev.clear();
      R.evGen++;
      R.evLast = "";
      R.evOpen = true;
      R.evChannel = null;
      R.flash = null;
      R.morph = {};
      R.arch = null;
      $("c-hypno")._fx = null;                      // el hipnograma se vuelve a dibujar de izquierda a derecha
      R.hypZoom = null;
      R.hypNote = false;
      R.sel = nextPending(-1, 1) ?? d.epochs.review.indexOf(1);
      if (R.sel < 0) R.sel = 0;
      V.init($("c-signal"), d, {
        epoch: R.sel, win: V.win || 90, gain: 1, corr: R.corr, info: R.cfg.channels,
        channels: d.channels.selected.filter(s => s in d.channels.available), onSelect: select,
        onZoom: () => renderZoom()
      });
      renderZoom({ hyp: false });
      $("epGotoIn").value = "";
      $("epGotoErr").textContent = "";
      $("epGotoIn").removeAttribute("aria-invalid");
      setTab("clin");
    }
    V.d = d;
    V.corr = R.corr;
    renderAlerts();
    renderTiles();
    renderHypno();
    renderChannelToggles();
    renderGain();
    renderReviewBar();
    renderInspector();
    V.epoch = R.sel;
    V.render();
    renderQueue();
    renderArchitecture();
    renderNotes();
    renderDetails();
    renderPerformance();
    R.onChange();
  }

  function rerender() {
    if (!R.d || $("vRes").classList.contains("hidden")) return;
    renderHypno();
    renderArchitecture();
    renderDetails();
    renderPerformance();
    V.render();
  }

  function setTab(tab) {
    R.tab = tab;
    document.querySelectorAll("#viewTabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    $("clinView").classList.toggle("hidden", tab !== "clin");
    $("perfView").classList.toggle("hidden", tab !== "perf");
    if (R.d) { if (tab === "perf") renderPerformance(); else { renderHypno(); renderArchitecture(); V.render(); } }
  }

  const alertBox = (cls, mark, title, body) =>
    `<div class="alert ${cls}"><span class="m">${mark}</span><span><span class="ti">${title}</span>${body}</span></div>`;

  /* ── avisos (vista clínica: en lenguaje llano, sin métricas de evaluación) ── */
  function renderAlerts() {
    const d = R.d, out = [], rv = d.review;
    if (rv.whole_night_recommended) {
      out.push(alertBox("c", "!", "Se sugiere revisar la noche completa.",
        `El modelo marcó el <b>${pct(rv.flagged_fraction)}</b> de las épocas, más que el límite de ` +
        `${pct(d.model.night_review_fraction)}: en esta noche duda más de lo habitual.`));
    }
    if (d.model.expected && d.model.expected.below_goal) {
      out.push(alertBox("w", "!", `${esc(d.combination_name)} es de las combinaciones de canales menos precisas.`,
        "Conviene revisar con más atención. Si el registro tiene Fpz-Cz o EOG, agregarlos mejora la estadificación."));
    }
    {
      // qué modelo estadificó la noche (cada noche guarda el suyo) y sus avisos
      const ABOUT = {
        mock: "Este análisis no viene de ningún modelo entrenado: sirve para probar la aplicación.",
        provisional: "Es un estadificador abierto que se usa mientras se integra el modelo del proyecto.",
        proyecto: "El sistema del proyecto de grado: XGBoost sobre rasgos de la señal y una red CNN/Transformer, combinados por un meta-modelo.",
      };
      const notes = (d.model.notes || []).map(n => `<li>${esc(n)}</li>`).join("");
      out.push(alertBox(d.model.kind === "mock" ? "w" : "i", "i",
        d.model.kind === "mock" ? "Resultados simulados." : `Estadificado con el ${esc((d.model.name || "Modelo provisional").replace(/^./, c => c.toLowerCase()))}.`,
        (ABOUT[d.model.kind] || "") + (notes ? `<ul>${notes}</ul>` : "")));
    }
    $("resAlerts").innerHTML = out.join("");
  }

  /* ── indicadores ── */
  function localReview() {
    const ep = R.d.epochs;
    let flagged = 0, resolved = 0, changed = 0, confirmed = 0;
    for (let i = 0; i < ep.review.length; i++) {
      if (ep.review[i]) { flagged++; if (R.corr.has(i)) resolved++; }
    }
    R.corr.forEach((s, i) => { if (s !== ep.stage[i]) changed++; else confirmed++; });
    return { ...R.d.review, flagged, resolved, pending: flagged - resolved, corrected: changed, confirmed };
  }

  function statusNow() {
    if (locked()) return "finalized";
    if (R.corr.size) return "in_review";
    return R.d.review.whole_night_recommended ? "full_review_suggested" : "to_review";
  }

  function renderTiles() {
    const d = R.d, n = d.night.n_epochs, rv = localReview();
    $("rEpochs").textContent = fmtHM(n * d.night.epoch_s);
    $("rEpochsN").textContent = `${fmtInt(n)} épocas · ${MODE_TXT[d.night.window.mode].toLowerCase()}`;
    $("rCov").textContent = pct(1 - rv.flagged / n, 1);
    $("rCovN").textContent = `${fmtInt(n - rv.flagged)} épocas con confianza ≥ ${nf(d.model.threshold, 2)}`;
    $("rFlag").innerHTML = `${fmtInt(rv.flagged)} <small>(${pct(rv.flagged / n, 0)})</small>`;
    $("rFlagN").textContent = rv.flagged ? `${rv.pending} pendientes · ${rv.resolved} resueltas` : "ninguna época dudosa";
    FX.tick($("rFlagN"), $("rFlagN").textContent, d.id);
    const st = statusNow();
    $("rStatus").textContent = UI.STATUS_TXT[st];
    $("rStatus").style.color = `var(${{ finalized: "--ok-text", full_review_suggested: "--crit", in_review: "--s1", to_review: "--warn-text" }[st]})`;
    $("rStatusN").textContent = locked()
      ? `por ${d.review.finalized_by || d.review.signed_off_by}`
      : `${rv.confirmed} confirmada${rv.confirmed === 1 ? "" : "s"} · ${rv.corrected} corregida${rv.corrected === 1 ? "" : "s"}`;
    FX.tick($("rStatusN"), $("rStatusN").textContent, d.id);
  }

  /* ── hipnograma ── */
  function renderHypno() {
    const d = R.d;
    // data-hl: al pasar el mouse por un estadio (o un estado de revisión) se resalta en toda la noche
    const st = STG.map((s, k) => `<span data-hl="s${k}"><i style="background:${s.c}"></i>${s.k}</span>`).join("");
    const rv = Object.entries(C.STATUS).map(([key, v]) =>
      `<span data-hl="f-${key}"><i style="background:var(${v.v})"></i>${v.label}</span>`).join("");
    $("hypLegend").innerHTML = st + '<span style="color:var(--muted)">·</span>' + rv +
      `<span style="color:var(--muted)">· confianza${UI.info("confidence")} con el umbral${UI.info("threshold")}</span>` +
      (d.epochs.reference ? `<span style="color:var(--muted)">· abajo: experto${UI.info("reference")}</span>` : "");
    const age = flashAge();
    C.renderHypnogram($("c-hypno"), d, {
      view: R.view, selected: R.sel, corr: R.corr, onSelect: select,
      viewRange: V.d ? V.range().map(t => t / d.night.epoch_s) : null,
      flash: age < 520 ? { epoch: R.flash.epoch, color: FLASH[R.flash.kind], age } : null,
      zoom: R.hypZoom, onZoom: setHypZoom
    });
    renderHypHead();
  }

  /* qué muestra el hipnograma (vista y tramo) y, si la vista no cambia nada, por qué (US-01, US-08) */
  function renderHypHead() {
    const d = R.d, rv = localReview(), c = rv.corrected, z = R.hypZoom;
    const viewTxt = R.view === "predicted"
      ? (c ? `Mostrando solo el modelo, sin ${c === 1 ? "la corrección" : `las ${c} correcciones`} del revisor. ` : "Mostrando solo el modelo. ")
      : (c ? `Mostrando el hipnograma final: el modelo con ${c} corrección${c === 1 ? "" : "es"} del revisor. ` : "");
    let zoomTxt = "Haga clic en cualquier momento de la noche para revisar esa época, o arrastre para acercar un tramo.";
    if (z) {
      const a = clockOf(z[0]), b = clockOf(z[1]), len = fmtHM((z[1] - z[0]) * d.night.epoch_s);
      zoomTxt = `Acercado${a != null ? ` de ${clockHM(a)} a ${clockHM(b)}` : ""} (${len}). Arrastre para acercar más; ` +
        "doble clic o «Ver toda la noche» para volver.";
    }
    $("hypCap").textContent = viewTxt + zoomTxt;
    $("hypReset").classList.toggle("hidden", !z);
    if (c) R.hypNote = false;
    const note = $("hypNote");
    note.classList.toggle("hidden", !R.hypNote);
    if (R.hypNote) {
      note.textContent = "Aún no hay cambios de revisión: las dos vistas coinciden. " + (rv.confirmed
        ? "Las épocas confirmadas conservan el estadio del modelo; solo una corrección cambia el hipnograma final."
        : "Cuando corrija una época, la vista «Final» la mostrará con su nuevo estadio.");
    }
  }

  function setHypZoom(z) {
    if (!R.d) return;
    const n = R.d.night.n_epochs;
    R.hypZoom = z ? [Math.max(0, z[0]), Math.min(n, z[1])] : null;
    renderHypno();
  }

  /* zoom de tiempo del visor (US-07): «Zoom −/+», cuánto se ve, ‹ › para moverse con el mismo
     zoom (inactivas en el borde de la época) y cómo volver */
  function renderZoom({ hyp = true } = {}) {
    const on = !!R.d && V.zoomed();
    const span = on ? Math.round((V.zoom[1] - V.zoom[0]) * 10) / 10 : 0;
    $("zoomVal").textContent = on ? `${nf(span, span % 1 ? 1 : 0)} s` : "sin zoom";
    $("zoomPlus").disabled = !R.d || !V.canZoom(1);
    $("zoomMinus").disabled = !on;
    $("panBtns").classList.toggle("hidden", !on);
    $("zoomReset").classList.toggle("hidden", !on);
    $("panL").disabled = !on || !V.canPan(-1);
    $("panR").disabled = !on || !V.canPan(1);
    if (hyp && R.d) renderHypno();
  }

  /* ── visor: canales y amplitud (US-19) ── */
  function renderChannelToggles() {
    const d = R.d;
    const slots = Object.keys(d.channels.available);
    $("chToggles").innerHTML = slots.map(s => {
      const info = R.cfg.channels[s] || { name: s };
      const used = d.channels.selected.includes(s);
      return `<button data-s="${s}" aria-pressed="${V.channels.includes(s)}" class="${used ? "" : "unused"}" ` +
        `title="${used ? "Canal usado por el modelo" : "Canal del archivo que el modelo no usó en este análisis"}">${esc(info.name)}</button>`;
    }).join("");
  }

  function renderGain() {
    const g = V.gain, kinds = [...new Set(V.channels.map(s => (R.cfg.channels[s] || {}).kind))];
    const parts = kinds.filter(k => C.SCALE[k]).map(k => `${k.toUpperCase()} ±${Math.round(C.SCALE[k] / g)} µV`);
    $("gainOut").textContent = `×${nf(g, g < 1 ? 2 : 1)}${parts.length ? " · " + parts.join(", ") : ""}`;
    FX.tick($("gainOut"), $("gainOut").textContent, R.d.id);
    $("gainUp").disabled = g >= 8 - 1e-9;
    $("gainDown").disabled = g <= 0.25 + 1e-9;
  }

  function renderViewerSoon() {
    clearTimeout(R.viewerTimer);
    R.viewerTimer = setTimeout(() => V.render(), 70);
  }

  /* ── barra de avance de la revisión ── */
  function renderReviewBar() {
    const d = R.d, rv = localReview(), status = statusNow();
    $("revStatus").className = "pill " + { finalized: "ok", in_review: "run", to_review: "w", full_review_suggested: "x" }[status];
    $("revStatus").textContent = UI.STATUS_TXT[status];
    $("revProg").style.width = rv.flagged ? `${(100 * rv.resolved / rv.flagged).toFixed(1)}%` : "100%";
    if (locked()) {
      const at = UI.parse(d.review.finalized_at || d.review.signed_off_at);
      $("revText").innerHTML = `Finalizada por <b>${esc(d.review.finalized_by || d.review.signed_off_by)}</b> el ${UI.dLong.format(at)}, ` +
        `${UI.dTime(at)} · ${rv.corrected} cambio${rv.corrected === 1 ? "" : "s"}`;
    } else {
      $("revText").innerHTML = rv.flagged
        ? `<b>${rv.resolved}</b> de ${rv.flagged} épocas marcadas resueltas · ${rv.corrected} cambio${rv.corrected === 1 ? "" : "s"}`
        : `El modelo no marcó épocas · ${rv.corrected} cambio${rv.corrected === 1 ? "" : "s"}`;
    }
    FX.tick($("revText"), $("revText").innerHTML, d.id);
    $("btnSign").textContent = locked() ? "Reabrir revisión" : "Finalizar revisión";
    $("btnSign").classList.toggle("ghost", locked());
    $("btnSign").classList.toggle("cta", !locked());
  }

  /* ── inspector de la época seleccionada ── */
  const authorOf = i => (R.d.corrections.find(c => c.epoch === i) || {}).author;

  function originText(i) {
    const st = C.epochStatus(R.d, i, R.corr);
    if (st === "confirmed") return `confirmada${authorOf(i) ? " · " + authorOf(i) : ""}`;
    if (st === "corrected") return `corregida${authorOf(i) ? " · " + authorOf(i) : ""}`;
    if (st === "pending") return "pendiente";
    return "modelo";
  }

  function contextCell(i, label) {
    const n = R.d.night.n_epochs;
    if (i < 0) return `<div><div class="w">${label}</div><div class="edge">Inicio del registro</div></div>`;
    if (i >= n) return `<div><div class="w">${label}</div><div class="edge">Fin del registro</div></div>`;
    const fin = R.d.epochs.final[i];
    return `<button type="button" class="ctxbtn" data-go="${i}" title="Ir a la época ${i + 1}"><div class="w">${label} · ${i + 1}</div>
      <div class="sv" style="color:${STG[fin].c}">${STG[fin].k}</div><div class="o">${esc(originText(i))}</div></button>`;
  }

  function renderInspector() {
    const d = R.d, i = R.sel, ep = d.epochs, n = d.night.n_epochs, EP = d.night.epoch_s;
    const st = C.epochStatus(d, i, R.corr);
    const pred = ep.stage[i], second = ep.second[i], fin = ep.final[i], p = ep.probs[i];
    const decided = R.corr.has(i), flagged = ep.review[i] === 1;
    const t = clockOf(i);
    // estado de la época: la que el modelo entregó con confianza no se confunde con una pendiente (US-04)
    const statusTxt = {
      pending: '<span class="pill w">Marcada · pendiente</span>',
      confirmed: '<span class="pill ok">✓ Confirmada</span>',
      corrected: `<span class="pill c">Corregida: ${STG[pred].k} → ${STG[fin].k}</span>`
    }[st] || `<span class="pill auto" title="El modelo la entregó con confianza de al menos ${nf(d.model.threshold, 2)}: no está marcada para revisar. Puede cambiarla si quiere.">` +
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
      '<path d="M5.2 8.3l1.9 1.9 3.8-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      `No requiere revisión · confianza ${Math.round(100 * ep.confidence[i])} %</span>`;
    const who = authorOf(i);
    const KEY = ["W", "1", "2", "3", "R"];
    // 1.ª opción = confirmar el estadio del modelo; 2.ª u otro estadio = corregir (US-03)
    // la 1.ª opción se señala como vigente cuando la época no está marcada y nadie decidió
    const cur = !decided && !flagged;
    const opt = (k, rank) => `<button type="button" data-st="${k}" aria-pressed="${decided && fin === k}" ${locked() ? "disabled" : ""}
        class="${rank === 1 && cur ? "cur" : ""}"
        title="${rank === 1 ? `Confirmar ${STG[k].k}, el estadio del modelo (tecla A o Enter)` : `Corregir a ${STG[k].k} (tecla B)`}"><span class="r">${rank}.ª opción</span>
        <span class="s"><i style="background:${STG[k].c}"></i>${STG[k].k}</span><span class="p">${Math.round(100 * p[k])} % de probabilidad</span></button>`;
    const others = STG.map((_, k) => k).filter(k => k !== pred && k !== second);
    // tres columnas de tarjetas: la época y sus vecinas con las probabilidades debajo; las opciones;
    // la evidencia de la señal (US-04 del diseño aprobado)
    $("insp").innerHTML = `
      <div class="icol">
        <section class="icard" aria-label="Época seleccionada">
          <div class="ep"><span class="en">Época ${fmtInt(i + 1)} <span class="of">de ${fmtInt(n)}</span></span>
            ${t != null ? `<span class="tchip">${clockHMS(t)} – ${clockHMS(t + EP)}</span>` : ""}</div>
          <div class="epst">${statusTxt}
            ${who && st ? `<span class="mini" style="margin:0">por ${esc(who)}</span>` : ""}</div>
          <h4 class="sep">Épocas vecinas${UI.info("context")}</h4>
          <div class="ctx">${contextCell(i - 1, "Anterior")}
            <div class="cur"><div class="w">Esta · ${i + 1}</div><div class="sv" style="color:${decided || !flagged ? STG[fin].c : "var(--warn-text)"}">${decided || !flagged ? STG[fin].k : "?"}</div>
              <div class="o">${esc(originText(i))}</div></div>
            ${contextCell(i + 1, "Siguiente")}</div>
        </section>
        <section class="icard fill" aria-label="Probabilidades del modelo">
          <div class="ihead"><h4>Probabilidades del modelo${UI.info("confidence")}</h4><span class="ihint">Distribución total</span></div>
          ${STG.map((s, k) => `<div class="pbar ${k === pred ? "top" : ""}"><span>${s.k}</span>
            <span class="tr"><span class="fi" style="display:block;width:${(100 * p[k]).toFixed(1)}%;background:${s.c}"></span></span>
            <span>${Math.round(100 * p[k])} %</span></div>`).join("")}
        </section>
      </div>
      <section class="icard" aria-label="Opciones del modelo">
        <h4>${flagged ? "El modelo duda entre" : "Opciones del modelo"}${UI.info("top2")}</h4>
        <div class="top2" id="iTop2">${opt(pred, 1)}${opt(second, 2)}</div>
        <div class="dhint">La 1.ª opción confirma el estadio del modelo; la 2.ª u otro estadio lo corrigen.</div>
        <div class="otherlbl">Otro estadio</div>
        <div class="stagebtns">${others.map(k => `<button data-st="${k}" aria-pressed="${decided && k === fin}"
          ${locked() ? "disabled" : ""} style="${decided && k === fin ? `background:${STG[k].c}` : ""}" title="Corregir a ${STG[k].k} · tecla ${KEY[k]}">
          ${STG[k].k}<small>${KEY[k]}</small></button>`).join("")}</div>
        <div class="igap"></div>
        <div class="ifoot">
          <button class="ghost wide" id="iRevert" ${locked() || !decided ? "disabled" : ""}
            title="${decided ? `Quita su decisión: la época vuelve al estadio que propuso el modelo (${STG[pred].k}). Tecla Retroceso.` : "Todavía no decidió nada en esta época."}">↺ Deshacer mi decisión</button>
          ${locked() ? '<div class="mini" style="margin-top:8px">La revisión está finalizada. Reábrala para hacer cambios.</div>' : ""}
          <label class="chk"><input type="checkbox" id="iAuto" ${R.autoAdvance ? "checked" : ""}>
            Pasar a la siguiente pendiente al decidir</label>
        </div>
      </section>
      <section class="icard" aria-label="Evidencia de la señal">
        <div class="ihead"><h4>Evidencia de la señal${UI.info("evidence")}</h4>
          <button type="button" class="linkbtn evtgl" id="iEvTgl" aria-controls="iEvid" aria-expanded="${R.evOpen}">${R.evOpen ? "Ocultar evidencia" : "Mostrar evidencia"}</button></div>
        <div id="iEvid"></div>
      </section>`;
    $("insp").querySelectorAll("button[data-st]").forEach(b => b.onclick = () => setStage(+b.dataset.st));
    $("insp").querySelectorAll("button[data-go]").forEach(b => b.onclick = () => select(+b.dataset.go));
    $("iRevert").onclick = () => setStage(null);
    $("iAuto").onchange = e => { R.autoAdvance = e.target.checked; };
    $("iEvTgl").onclick = e => {
      R.evOpen = !R.evOpen;
      e.currentTarget.textContent = R.evOpen ? "Ocultar evidencia" : "Mostrar evidencia";
      e.currentTarget.setAttribute("aria-expanded", String(R.evOpen));
      renderEvidence();
    };
    renderNav();
    // las probabilidades pasan de las de la época anterior a las de esta
    morph("p", [...$("insp").querySelectorAll(".pbar .fi")], i);
    // decisión recién tomada: anillo verde (confirmada) o morado (corregida) donde se ve esa época
    const age = flashAge();
    if (age < 250) {
      const c = FLASH[R.flash.kind], e = R.flash.epoch, box = $("insp");
      if (e === i) {
        box.querySelectorAll('button[aria-pressed="true"]').forEach(b => FX.ring(b, c, age));
        const cur = box.querySelector(".ctx .cur");
        FX.ring(cur, c, age, getComputedStyle(cur).boxShadow);
      } else if (Math.abs(e - i) === 1) {             // pasó a la época vecina: el anillo va en «Anterior»/«Siguiente»
        FX.ring(box.querySelector(e < i ? ".ctx > :first-child" : ".ctx > :last-child"), c, age);
      }
    }
    renderEvidence();
  }

  /* ── navegación bajo el visor: anterior/siguiente, deslizador e «Ir a la época» (US-05) ── */
  const scrubLabel = i => {
    const t = clockOf(i);
    return `Época ${fmtInt(i + 1)} de ${fmtInt(R.d.night.n_epochs)}${t != null ? " · " + clockHMS(t) : ""}`;
  };
  function renderNav() {
    const n = R.d.night.n_epochs, i = R.sel, sl = $("epSlider");
    $("iPrev").disabled = i === 0;
    $("iNext").disabled = i === n - 1;
    sl.max = n;
    sl.value = i + 1;
    $("epSliderOut").textContent = scrubLabel(i);
    $("epGotoIn").max = n;
  }

  function gotoEpoch(e) {
    e.preventDefault();
    if (!R.d) return;
    const n = R.d.night.n_epochs, raw = $("epGotoIn").value.trim(), v = Number(raw);
    const bad = !raw || !Number.isInteger(v) || v < 1 || v > n;
    $("epGotoIn").setAttribute("aria-invalid", String(bad));
    $("epGotoErr").textContent = bad ? `Esta noche tiene ${fmtInt(n)} épocas: escriba un número del 1 al ${fmtInt(n)}.` : "";
    if (!bad) select(v - 1);
  }

  /* ── evidencia espectral (US-11): visible en todas las épocas, se puede ocultar ── */
  function renderEvidence() {
    const el = $("iEvid"), i = R.sel, d = R.d;
    if (!el) return;
    el.classList.remove("loading");
    el.removeAttribute("aria-busy");
    if (!R.evOpen) {
      clearTimeout(R.evTimer);
      el.innerHTML = '<p class="evoff">Oculta. Con «Mostrar evidencia» vuelve a ver cómo se reparte la potencia del EEG por bandas en esta época.</p>';
      return;
    }
    const key = `${i}|${R.evChannel || ""}`;
    const ev = R.ev.get(key);
    if (!ev) {
      // mientras llega, queda la evidencia anterior atenuada (la tarjeta no cambia de alto)
      el.innerHTML = R.evLast || '<div class="evskel"><span class="spin"></span>Calculando la potencia por bandas…</div>';
      el.classList.add("loading");
      el.setAttribute("aria-busy", "true");
      clearTimeout(R.evTimer);
      R.evTimer = setTimeout(() => fetchEvidence(d, i, key), 120);   // al recorrer épocas rápido, solo se pide la última
      return;
    }
    if (ev.error) { el.innerHTML = `<div class="mini" style="margin:0;color:var(--crit)">${esc(ev.error)}</div>`; return; }
    const cands = ev.candidates.map(k => STG[k].k);
    const typ = ev.candidates.map(k => ev.typical[STG[k].k]);
    const rows = ev.bands.map((b, j) => {
      const vals = [b.value, ...typ.map(t => t ? t.values[j] : null)].filter(v => v != null);
      const top = Math.max(...vals, 0.01) * 1.18;
      const mk = typ.map((t, k) => t ? `<span class="mk c${k + 1}" style="left:${(100 * t.values[j] / top).toFixed(1)}%"
        title="${cands[k]} típica en esta noche: ${pct(t.values[j], 0)}"></span>` : "").join("");
      return `<div class="band"><span class="bn">${esc(b.label)}${UI.info("band_" + b.key)}</span>
        <span class="bt" title="Esta época: ${b.value == null ? "—" : pct(b.value, 0)}">${b.value == null ? "" :
          `<span class="fi" style="width:${(100 * b.value / top).toFixed(1)}%"></span>`}${mk}</span>
        <span class="bv">${b.value == null ? "—" : pct(b.value, 0)}</span></div>`;
    }).join("");
    const chOpts = ev.channels.length > 1 ? `<select id="iEvCh" aria-label="Canal de EEG">${ev.channels.map(s =>
      `<option value="${s}" ${s === ev.channel ? "selected" : ""}>${esc((R.cfg.channels[s] || {}).name || s)}</option>`).join("")}</select>`
      : `<b>${esc(ev.channel_name)}</b>`;
    const hint = ev.closest != null ? `Por su reparto de frecuencias, esta época se parece más a una <b>${STG[ev.closest].k}</b> típica de esta noche.`
      : "No hay suficientes épocas seguras de los dos estadios en esta noche para compararlas.";
    el.innerHTML = `<div class="evid">
      <div class="head"><span>Potencia relativa del EEG</span>${chOpts}</div>
      ${rows}
      <div class="evleg"><span><i style="background:var(--ink2);opacity:.75"></i>esta época</span>${typ.map((t, k) => t
        ? `<span><i class="c${k + 1}" style="width:4px"></i>${cands[k]} típica, ${k + 1}.ª opción (${t.n} épocas)</span>` : "").join("")}</div>
      <div class="igap"></div>
      <div class="ifoot"><div class="evhint">${hint}</div>
        <div class="mini" style="margin-top:6px">Cada fila tiene su propia escala. ${esc(ev.method)}</div></div></div>`;
    R.evLast = el.innerHTML;
    morph("band", [...el.querySelectorAll(".band .bt .fi")], `${i}|${ev.channel}`);
    if ($("iEvCh")) $("iEvCh").onchange = e => { R.evChannel = e.target.value; renderEvidence(); };
  }

  function fetchEvidence(d, i, key) {
    if (!R.d || R.d.id !== d.id || R.sel !== i || !R.evOpen || R.ev.has(key) || R.evBusy.has(key)) return;
    const gen = R.evGen;
    R.evBusy.add(key);
    MaiaAPI.getEvidence(d.id, i, R.evChannel)
      .then(out => { if (gen === R.evGen) R.ev.set(key, out); })
      .catch(e => { if (gen === R.evGen) R.ev.set(key, { error: e.message || "No se pudo calcular la evidencia." }); })
      .finally(() => {
        R.evBusy.delete(key);
        if (R.d && R.d.id === d.id && R.sel === i) renderEvidence();
      });
  }

  /* ── cola de épocas ── */
  function renderQueue() {
    const d = R.d, ep = d.epochs, rows = [];
    for (let i = 0; i < ep.stage.length; i++) {
      const st = C.epochStatus(d, i, R.corr);
      const keep = R.qFilt === "pending" ? st === "pending"
        : R.qFilt === "flagged" ? ep.review[i] === 1
        : st === "corrected";
      if (keep) rows.push(i);
    }
    $("qCount").textContent = `${fmtInt(rows.length)} época${rows.length === 1 ? "" : "s"}`;
    FX.tick($("qCount"), $("qCount").textContent, d.id);
    const lbl = { pending: '<span class="pill w">Pendiente</span>', confirmed: '<span class="pill ok">Confirmada</span>' };
    $("qBody").innerHTML = rows.length ? rows.map(i => {
      const st = C.epochStatus(d, i, R.corr), t = clockOf(i);
      return `<tr data-i="${i}" class="click ${i === R.sel ? "sel" : ""}"><td class="l">${i + 1}</td>
        <td class="l">${t != null ? clockHMS(t) : "—"}</td>
        <td class="l">${UI.stage(ep.stage[i])} ${Math.round(100 * ep.confidence[i])} %</td>
        <td class="l">${UI.stage(ep.second[i])} ${Math.round(100 * ep.probs[i][ep.second[i]])} %</td>
        <td class="l">${st === "corrected" ? `<span class="pill c">→ ${STG[ep.final[i]].k}</span>` : (lbl[st] || "—")}</td></tr>`;
    }).join("") : `<tr><td class="l" colspan="5" style="color:var(--muted)">${
      R.qFilt === "pending" ? "No quedan épocas pendientes." : R.qFilt === "changed" ? "Aún no hay cambios." : "El modelo no marcó épocas."}</td></tr>`;
  }

  function markQueueSelection() {
    $("qBody").querySelectorAll("tr").forEach(tr => {
      const on = +tr.dataset.i === R.sel;
      tr.classList.toggle("sel", on);
      if (on) {        // desplaza solo la caja de la cola, nunca la página
        const box = tr.closest(".queue");
        const top = tr.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
        if (top < box.scrollTop + 30 || top > box.scrollTop + box.clientHeight - 40) box.scrollTop = top - box.clientHeight / 2;
      }
    });
  }

  /* ── arquitectura del sueño del hipnograma final (US-05, US-21) ── */
  const ARCH = [
    ["tib", "Tiempo en cama", x => [nf(x.tib_min, 0), "min"]],
    ["tst", "Sueño total", x => [nf(x.tst_min, 0), "min"]],
    ["efficiency", "Eficiencia del sueño", x => x.efficiency_pct == null ? ["—", ""] : [nf(x.efficiency_pct), "%"]],
    ["sol", "Latencia de sueño", x => x.sol_min == null ? ["—", ""] : [nf(x.sol_min), "min"]],
    ["rem_latency", "Latencia REM", x => x.rem_latency_min == null ? ["—", ""] : [nf(x.rem_latency_min), "min"]],
    ["waso", "Vigilia después de dormirse (WASO)", x => x.waso_min == null ? ["—", ""] : [nf(x.waso_min), "min"]],
    ["awakenings", "Despertares de 1 min o más", x => [String(x.awakenings), ""]]
  ];

  /* campo numérico y decimales de cada cifra (para que cuente al cambiar) */
  const ARCH_NUM = { tib: ["tib_min", 0], tst: ["tst_min", 0], efficiency: ["efficiency_pct", 1], sol: ["sol_min", 1],
    rem_latency: ["rem_latency_min", 1], waso: ["waso_min", 1], awakenings: ["awakenings", 0] };

  function renderArchitecture() {
    const m = R.d.metrics, f = m.final || m.predicted;
    const hrs = v => v == null ? "" : `≈ ${fmtHM(v * 60)}`;
    $("archGrid").innerHTML = ARCH.map(([key, label, fn]) => {
      const [v, u] = fn(f);
      const sub = key === "tib" ? hrs(f.tib_min) : key === "tst" ? hrs(f.tst_min) : "";
      return `<div class="arch"><div class="k">${label}${UI.info(key)}</div><div class="v"><span class="num" data-k="${key}">${v}</span>${u ? `<small>${u}</small>` : ""}</div>
        ${sub ? `<div class="n">${sub}</div>` : ""}</div>`;
    }).join("");
    // las cifras cuentan: desde 0 al abrir la noche; desde el valor anterior cuando una decisión las cambia
    const t = FX.now(), vals = {}, a = R.arch, same = a && a.rid === R.d.id;
    for (const k in ARCH_NUM) vals[k] = f[ARCH_NUM[k][0]];
    if (!same || Object.keys(vals).some(k => vals[k] !== a.vals[k])) {
      R.arch = { rid: R.d.id, vals, from: same ? a.vals : null, t0: t, dur: same ? 250 : 450 };
    }
    const cur = R.arch;
    $("archGrid").querySelectorAll(".num").forEach(el => {
      const k = el.dataset.k, to = vals[k];
      if (to == null) return;
      const from = cur.from ? cur.from[k] : 0;
      FX.countTo(el, from == null ? to : from, to, v => nf(v, ARCH_NUM[k][1]), cur.dur, t - cur.t0);
    });
    C.renderStageBars($("c-stages"), [{ label: "Final", stages: f.stages }], { key: R.d.id });
    $("stageTable").innerHTML = `<thead><tr><th class="l">Estadio</th><th>Minutos</th><th>Porcentaje${UI.info("stage_pct")}</th></tr></thead><tbody>` +
      ["N1", "N2", "N3", "REM", "W"].map(s => `<tr><td class="l"><span class="st" style="background:${STG.find(x => x.k === s).c}">${s}</span></td>
        <td>${nf(f.stages[s].min, 1)}</td><td>${nf(f.stages[s].pct, 1)} % <span class="mini" style="margin:0">${s === "W"
          ? "del tiempo en cama" : "del sueño"}</span></td></tr>`).join("") + "</tbody>";
    $("archCap").innerHTML = "Calculada sobre el hipnograma final" + UI.info("final") + ": los estadios que confirmó o " +
      "corrigió un revisor y, en el resto, los del modelo. Se recalcula con cada cambio" +
      (R.d.night.lights_off_clock ? `, desde el apagado de luces (${esc(R.d.night.lights_off_clock)}).` : ", desde el inicio de la ventana.");
  }

  /* ── notas del técnico (US-15) ── */
  function renderNotes() {
    const notes = R.d.notes || [];
    const fresh = R.freshNote;                       // la nota recién guardada (la primera: van de nueva a vieja)
    R.freshNote = false;
    $("noteList").innerHTML = notes.length ? notes.map((n, k) => {
      const at = UI.parse(n.at);
      return `<div class="note${fresh && k === 0 ? " fresh" : ""}"><div class="who"><b>${esc(n.author)}</b> · ${UI.dShort(at)}, ${UI.dTime(at)}</div>
        <div class="tx">${esc(n.text)}</div></div>`;
    }).join("") : '<div class="mini" style="margin:0">Todavía no hay notas para esta noche.</div>';
    noteCount();
  }
  function noteCount() {
    const len = $("noteText").value.trim().length, max = R.cfg.max_note_chars || 2000;
    $("noteCnt").textContent = len ? `${len} de ${max} caracteres` : "";
    $("noteCnt").style.color = len > max ? "var(--crit)" : "";
    $("btnNote").disabled = !len || len > max;
  }
  async function saveNote() {
    const text = $("noteText").value.trim(), id = R.d.id;
    if (!text) return;
    $("btnNote").disabled = true;
    try {
      const out = await MaiaAPI.addNote(id, text);
      if (!R.d || R.d.id !== id) return;
      R.d.notes = out.notes;
      R.d.history = out.history;
      $("noteText").value = "";
      R.freshNote = true;
      renderNotes();
      renderHistory();
      UI.toast("Nota guardada.");
    } catch (e) {
      UI.toast(e.message || "No se pudo guardar la nota.", true);
      noteCount();
    }
  }

  /* ── detalles del análisis y bitácora (US-04, US-03) ── */
  function renderDetails() {
    const d = R.d, q = d.quality, f = q.file, nt = d.night, mo = d.model, si = d.source_info || {};
    C.renderQuality($("c-quality"), q.composition, { key: d.id });
    const start = f.start ? new Date(f.start) : null;
    const unused = d.channels.unused || [];
    const src = si.type === "catalog" ? `Catálogo${si.location ? ` (${esc(si.location)})` : ""}`
      : si.type === "upload" || d.source === "upload" ? "PSG subido por el usuario" : "Noche demo del servidor";
    $("kvFile").replaceChildren(
      UI.kv("Noche", esc(si.label || d.night_label || d.file_name) + (d.subset ? ' <span class="chip sub">canales faltantes</span>' : "")),
      UI.kv("Origen", src),
      UI.kv("Sujeto · noche", d.dataset ? `${d.dataset.subject} · noche ${d.dataset.night} (${d.dataset.split === "test" ? "test" : "desarrollo"})` : "fuera del índice de Sleep-EDFx"),
      UI.kv("Archivo", `${esc(f.name)}${f.size_mb != null ? ` · ${nf(f.size_mb)} MB` : ""}`),
      UI.kv("Inicio del registro", start ? `${UI.dShort(start)}, ${clockHM(f.start_clock_s)}` : "—"),
      UI.kv("Duración total", fmtHM(f.total_duration_s)),
      UI.kv("Canales en el archivo", `${f.channels}${unused.length ? ` · sin usar: ${unused.map(esc).join(", ")}` : ""}`)
    );
    const w0 = clockOf(0), w1 = clockOf(nt.n_epochs);
    const loSrc = { manual: "indicada", "dataset-index": "índice de Sleep-EDFx" }[nt.lights_off_source];
    $("kvAnalysis").replaceChildren(
      UI.kv("Ventana", MODE_TXT[nt.window.mode], "window"),
      UI.kv("Desde – hasta", w0 != null ? `${clockHM(w0)} – ${clockHM(w1)}` : "—"),
      UI.kv("Épocas de 30 s", fmtInt(nt.n_epochs), "epoch"),
      UI.kv("Apagado de luces", nt.lights_off_clock ? `${nt.lights_off_clock} (${loSrc})` : "no indicado: inicio de la ventana", "lights_off"),
      UI.kv("Canales del modelo", d.channels.selected.map(s =>
        `${esc((R.cfg.channels[s] || {}).name || s)} ← ${esc(d.channels.map[s])}`).join("<br>"), "combination")
    );
    const fin = d.finished_at ? UI.parse(d.finished_at) : null;
    $("kvModel").replaceChildren(
      UI.kv("Modelo", esc(mo.name || mo.kind)),
      UI.kv("Versión", esc(mo.version), "model_version"),
      UI.kv("Umbral de confianza", nf(mo.threshold, 2), "threshold"),
      UI.kv("Revisión completa si marca más de", pct(mo.night_review_fraction), "full_review"),
      UI.kv("Analizado", fin ? `${UI.dShort(fin)}, ${UI.dTime(fin)}${d.created_by ? ` · ${esc(d.created_by)}` : ""}` : "—")
    );
    renderHistory();
  }

  const STATUS_LOW = s => (UI.STATUS_TXT[s] || s || "—").toLowerCase();
  /* entradas nuevas de la bitácora (van de la más nueva a la más vieja): las que quedaron
     por encima de la que antes encabezaba la lista; con la lista vacía, todas */
  const histKey = e => `${e.at}|${e.action}|${e.epoch}|${e.new}`;
  function freshHistory(h) {
    const top = h.length ? histKey(h[0]) : null, prev = R.hist;
    R.hist = { rid: R.d.id, top };
    if (!prev || prev.rid !== R.d.id || prev.top === top) return 0;
    if (prev.top === null) return Math.min(h.length, 6);
    const k = h.findIndex(e => histKey(e) === prev.top);
    return k < 0 ? 0 : Math.min(k, 6);
  }

  function renderHistory() {
    const h = R.d.history || [];
    const v = x => `<span class="chg">${esc(x == null ? "—" : x)}</span>`;
    const fresh = freshHistory(h);
    $("histList").innerHTML = h.length ? h.map((e, k) => {
      const at = UI.parse(e.at), ep = e.epoch != null ? e.epoch + 1 : null;
      const what = {
        set: e.old === e.new || e.stage === e.previous ? `confirmó la época ${ep} (${v(e.new)})`
          : `cambió la época ${ep}: ${v(e.old)} → <b>${v(e.new)}</b>`,
        clear: `devolvió la época ${ep} al estadio del modelo: ${v(e.old)} → ${v(e.new)}`,
        finalize: `<b>finalizó la revisión</b>${e.old ? ` (${STATUS_LOW(e.old)} → finalizada)` : ""}`,
        sign_off: "<b>finalizó la revisión</b>",
        reopen: `reabrió la revisión${e.new ? ` (finalizada → ${STATUS_LOW(e.new)})` : ""}`,
        note: `agregó una nota: «${esc((e.new || "").length > 90 ? e.new.slice(0, 90) + "…" : e.new)}»`,
        retry: "reintentó el análisis (falló → en cola)"
      }[e.action] || esc(e.action);
      return `<div${k < fresh ? ' class="fresh"' : ""}><time>${UI.dShort(at)} ${UI.dTime(at)}</time>${esc(e.author)} ${what}</div>`;
    }).join("") : '<div style="color:var(--muted)">Todavía no hay cambios: el hipnograma final es el del modelo.</div>';
  }

  /* ══════════════ desempeño del modelo (US-16) ══════════════ */
  function renderPerformance() {
    const d = R.d, mo = d.model, ex = mo.expected || {}, cfg = R.cfg;
    const out = [];
    if (d.dataset && d.dataset.split === "dev") {
      out.push(alertBox("i", "i", "Noche del conjunto de desarrollo.",
        `El sujeto ${d.dataset.subject} se usó para entrenar el modelo del proyecto: con ese modelo, el acuerdo ` +
        `de esta noche sería optimista. Las noches del test son las que miden el desempeño real.`));
    }
    $("perfAlerts").innerHTML = out.join("");
    // desempeño esperado
    $("expName").textContent = d.combination_name;
    $("expCap").innerHTML = esc(mo.expected_source || cfg.expected_source || "Desempeño de test por combinación.") +
      (mo.kind === "provisional" ? ". Este análisis lo hizo el modelo provisional, que puede rendir distinto." : ".");
    $("expText").innerHTML = ex.test_mf1 != null
      ? `F1 macro${UI.info("f1_macro")} <b>${nf(ex.test_mf1, 3)}</b> (intervalo ${nf(ex.test_ci[0], 3)}–${nf(ex.test_ci[1], 3)}) · ` +
        `kappa de Cohen${UI.info("kappa")} ${nf(ex.test_kappa, 3)} · F1 de N1 ${nf(ex.test_f1_n1, 3)}` +
        (ex.below_goal ? `<br><span style="color:var(--warn-text)">Bajo la meta del proyecto (F1 macro ${nf(ex.goal_mf1, 2)}).</span>` : "")
      : "Sin datos de desempeño para esta combinación.";
    if (cfg.expected) {
      const names = Object.fromEntries(Object.keys(cfg.expected).map(k => {
        const [eeg, ...rest] = k.split("_");
        const sl = [...(eeg === "eeg2" ? ["fpz", "pz"] : [eeg]), ...rest];
        return [k, Object.keys(cfg.channels).filter(s => sl.includes(s)).map(s => cfg.channels[s].name).join(" + ")];
      }));
      if (R.tab === "perf") C.renderCombos($("c-combos2"), cfg.expected, names, d.combination, cfg.mf1_goal, { key: d.id });
    }
    renderAgreement();
    renderArchCompare();
    const q = d.quality, tm = q.timings || {};
    $("kvTech").replaceChildren(
      UI.kv("Combinación (clave)", esc(d.combination)),
      UI.kv("Señal guardada para el visor", nf(q.file.sampling_hz, 0) + " Hz"),
      UI.kv("Épocas sin estadio en la referencia", q.reference_unscored == null ? "sin referencia" : fmtInt(q.reference_unscored)),
      UI.kv("Intentos del análisis", String(d.attempts || 1))
    );
    $("kvTimes").replaceChildren(
      UI.kv("Leer la señal", tm.read_s != null ? nf(tm.read_s, 2) + " s" : "—"),
      UI.kv("Modelo", tm.model_s != null ? nf(tm.model_s, 2) + " s" : "—"),
      UI.kv("Total", tm.total_s != null ? nf(tm.total_s, 2) + " s" : "—")
    );
  }

  function renderAgreement() {
    const ag = R.d.agreement, has = !!(ag && ag.predicted);
    $("agrPanel").classList.toggle("hidden", !has);
    $("noRef").classList.toggle("hidden", has);
    if (!has || R.tab !== "perf") return;
    const a = ag.predicted, f = ag.final || a;
    const delta = (x, y) => {
      const v = y - x;
      return Math.abs(v) < 0.0005 ? "sin cambio" : `${v > 0 ? "+" : "−"}${nf(Math.abs(v), 3)} con la revisión`;
    };
    const tile = (k, info, x, y, fmt) => `<div class="tile"><div class="k">${k}${UI.info(info)}</div><div class="v">${fmt(x)}</div>
      <div class="n">${R.corr.size ? `final: ${fmt(y)} · ${delta(x, y)}` : "del modelo, antes de revisar"}</div></div>`;
    $("agrTiles").innerHTML = tile("Exactitud", "accuracy", a.accuracy, f.accuracy, v => pct(v, 1)) +
      tile("F1 macro", "f1_macro", a.mf1, f.mf1, v => nf(v, 3)) + tile("Kappa de Cohen", "kappa", a.kappa, f.kappa, v => nf(v, 3)) +
      `<div class="tile"><div class="k">Épocas comparadas</div><div class="v">${fmtInt(a.n_epochs)}</div>
       <div class="n">${fmtInt(R.d.night.n_epochs - a.n_epochs)} sin estadio en la referencia</div></div>`;
    const cm = R.cmView === "final" ? f : a;
    $("cmCol").textContent = R.cmView === "final" ? "final" : "modelo";
    C.renderConfusion($("c-cm"), cm.confusion, R.cmView === "final" ? "final" : "modelo", { key: R.d.id });
    C.renderF1($("c-f1"), a, R.corr.size ? f : null, { key: R.d.id });
  }

  function renderArchCompare() {
    const m = R.d.metrics;
    const cols = [["Modelo", m.predicted], ["Final", m.final || m.predicted]];
    if (m.reference) cols.push(["Experto", m.reference]);
    const rows = ARCH.map(([, label, fn]) => [label, x => fn(x).join(" ").trim()])
      .concat(["N1", "N2", "N3", "REM"].map(s => [`${s} (% del sueño)`, x => nf(x.stages[s].pct) + " %"]));
    $("archCompare").innerHTML = `<thead><tr><th class="l">Métrica</th>${cols.map(c => `<th>${c[0]}</th>`).join("")}</tr></thead>` +
      `<tbody>${rows.map(([label, fn]) => `<tr><td class="l">${label}</td>` +
        cols.map(c => `<td>${fn(c[1])}</td>`).join("") + "</tr>").join("")}</tbody>`;
  }

  /* ══════════════ navegación y decisiones ══════════════ */
  function select(i) {
    if (!R.d) return;
    const n = R.d.night.n_epochs;
    R.sel = Math.max(0, Math.min(n - 1, i));
    const z = R.hypZoom;
    if (z && (R.sel < z[0] || R.sel >= z[1])) {        // fuera del tramo acercado: el tramo se corre hasta ella
      const w = z[1] - z[0], a = Math.max(0, Math.min(n - w, R.sel + 0.5 - w / 2));
      R.hypZoom = [a, a + w];
    }
    V.epoch = R.sel;
    renderInspector();
    renderHypno();
    renderZoom({ hyp: false });
    markQueueSelection();
    renderViewerSoon();
  }

  /* siguiente época marcada y sin resolver en la dirección dir (o null) */
  function nextPending(from, dir) {
    const ep = R.d.epochs, n = ep.review.length;
    for (let i = from + dir; i >= 0 && i < n; i += dir) {
      if (ep.review[i] && !R.corr.has(i)) return i;
    }
    return null;
  }

  function jumpPending(dir) {
    if (!R.d) return;
    const i = nextPending(R.sel, dir);
    if (i == null) UI.toast(dir > 0 ? "No hay más épocas pendientes hacia adelante." : "No hay épocas pendientes antes de esta.");
    else select(i);
  }

  /* decide el estadio de una época (null = volver al modelo); la de la selección por omisión */
  function setStage(stage, epoch = R.sel, { advance: adv = true } = {}) {
    if (!R.d) return;
    if (locked()) { UI.toast("La revisión está finalizada. Reábrala para hacer cambios."); return; }
    const i = epoch, ep = R.d.epochs, pred = ep.stage[i];
    const prev = R.corr.has(i) ? R.corr.get(i) : null;
    const wasFlagged = ep.review[i] === 1;
    if (stage === null && prev === null) return;
    if (stage !== null && prev === stage) { if (adv && R.autoAdvance) advance(wasFlagged); return; }
    if (stage === null) R.corr.delete(i); else R.corr.set(i, stage);
    ep.final[i] = stage === null ? pred : stage;
    R.flash = stage === null ? null : { epoch: i, kind: stage === pred ? "ok" : "corr", t0: FX.now() };
    R.ev.clear();                                   // los perfiles típicos dependen del hipnograma final
    R.evGen++;
    const p = push(i, stage);
    afterLocalChange();
    if (stage !== null && adv && R.autoAdvance) advance(wasFlagged);
    return p;
  }

  function advance(wasFlagged) {
    if (wasFlagged) {
      const nxt = nextPending(R.sel, 1);
      if (nxt != null) return select(nxt);
      if (nextPending(-1, 1) == null) UI.toast("No quedan épocas marcadas pendientes. Puede finalizar la revisión.");
      return;
    }
    if (R.sel < R.d.night.n_epochs - 1) select(R.sel + 1);
  }

  function afterLocalChange() {
    renderTiles();
    renderReviewBar();
    renderInspector();
    renderHypno();
    renderQueue();
    renderViewerSoon();
  }

  /* las decisiones viajan en orden; cuando no queda ninguna en camino, manda la API */
  function push(epoch, stage) {
    const id = R.d.id;
    R.inflight++;
    R.chain = R.chain.then(() => MaiaAPI.changeEpochs(id, [{ epoch, stage }]))
      .then(out => { if (--R.inflight === 0 && R.d && R.d.id === id) applyServer(out); })
      .catch(e => {
        R.inflight--;
        UI.toast(e.message || "No se pudo guardar el cambio.", true);
        if (R.d && R.d.id === id) MaiaAPI.getRecord(id).then(show).catch(() => {});
      });
    return R.chain;
  }

  function applyServer(out) {
    const d = R.d;
    d.epochs.final = out.final;
    d.metrics.final = out.metrics_final;
    if (d.agreement) d.agreement.final = out.agreement_final;
    d.corrections = out.corrections;
    d.review = out.review;
    d.history = out.history;
    if (out.notes) d.notes = out.notes;
    R.corr = new Map(out.corrections.map(c => [c.epoch, c.stage]));
    V.corr = R.corr;
    renderTiles();
    renderReviewBar();
    renderInspector();
    renderHypno();
    renderQueue();
    renderArchitecture();
    renderHistory();
    renderPerformance();
    R.onChange();
  }

  /* ── finalizar con el resumen de cambios a la vista (US-14) ── */
  let fin = null;            // resumen abierto: {id, expected}
  async function openFinalize() {
    const id = R.d.id;
    try { await R.chain; } catch (e) { /* ya avisado */ }
    let s;
    try { s = await MaiaAPI.getChanges(id); } catch (e) { UI.toast(e.message || "No se pudo leer el resumen.", true); return; }
    if (!R.d || R.d.id !== id) return;
    fin = { id, expected: s.corrected };
    renderFinalize(s);
    if ($("finModal").classList.contains("hidden")) UI.openDialog("finModal", { focus: "finCancel", onClose: () => { fin = null; } });
  }

  function renderFinalize(s) {
    $("finConf").textContent = fmtInt(s.confirmed);
    $("finCorr").textContent = fmtInt(s.corrected);
    $("finPend").textContent = fmtInt(s.pending);
    // todas las decisiones (confirmadas y corregidas); una API anterior solo manda las corregidas
    const list = s.decisions || s.changes.map(c => ({ ...c, kind: "corrected" }));
    $("finBody").innerHTML = list.length
      ? `<div class="finlist"><table><thead><tr><th class="l">Época</th><th class="l">Hora</th><th class="l">Decisión</th>
          <th class="l">Modelo</th><th class="l">Su estadio</th><th></th></tr></thead><tbody>${list.map(c => `<tr>
          <td class="l">${c.epoch + 1}${c.flagged ? ' <span class="mini" style="margin:0">marcada</span>' : ""}</td>
          <td class="l">${c.clock_s != null ? clockHMS(c.clock_s) : "—"}</td>
          <td class="l">${c.kind === "confirmed" ? '<span class="pill ok">✓ Confirmada</span>' : '<span class="pill c">Corregida</span>'}</td>
          <td class="l">${UI.stage(c.model_stage)}</td><td class="l">${UI.stage(c.reviewer_stage)}</td>
          <td><button class="ghost" data-undo="${c.epoch}" data-kind="${c.kind}" data-flagged="${c.flagged ? 1 : 0}"
            title="${c.kind === "confirmed" ? `Quitar la confirmación de la época ${c.epoch + 1}` : `Devolver la época ${c.epoch + 1} al estadio del modelo`}">↺ Deshacer</button></td>
          </tr>`).join("")}</tbody></table></div>`
      : '<p class="mtext" style="margin:14px 0 0">Todavía no confirmó ni corrigió ninguna época: el hipnograma final es el del modelo.</p>';
    $("finText").innerHTML = (s.pending ? `Quedan <b>${s.pending}</b> épocas marcadas sin revisar: el hipnograma final las toma ` +
      "tal como las predijo el modelo. " : "") + "La revisión quedará finalizada con su nombre y se puede reabrir.";
    $("finBody").querySelectorAll("[data-undo]").forEach(b => b.onclick = async () => {
      const e = +b.dataset.undo, model = R.d.epochs.stage[e];
      b.disabled = true;
      await setStage(null, e, { advance: false });
      UI.toast(b.dataset.kind === "confirmed"
        ? `Época ${e + 1}: se quitó la confirmación${b.dataset.flagged === "1" ? "; vuelve a quedar pendiente" : ""}.`
        : `Época ${e + 1} devuelta al estadio del modelo (${STG[model].k}).`);
      openFinalize();
    });
  }

  async function confirmFinalize() {
    if (!fin) return;
    const { id, expected } = fin;
    $("finConfirm").disabled = true;
    try {
      const out = await MaiaAPI.reviewAction(id, "finalize", expected);
      UI.closeDialog("finModal");
      if (R.d && R.d.id === id) {
        applyServer(out);
        FX.pop($("revStatus"));                     // «Finalizada»: el sello se nota
        FX.pop($("rStatus"));
      }
      UI.toast("Revisión finalizada.");
    } catch (e) {
      if (e.code === "stale_summary") { UI.toast(e.message, true); openFinalize(); }
      else UI.toast(e.message || "No se pudo finalizar la revisión.", true);
    } finally {
      $("finConfirm").disabled = false;
    }
  }

  async function toggleFinalize() {
    if (!R.d) return;
    if (!locked()) return openFinalize();
    const id = R.d.id;
    const ok = await UI.confirm({ title: "¿Reabrir la revisión?", confirmLabel: "Reabrir revisión",
      html: "Podrá volver a confirmar o corregir épocas. La reapertura queda en la bitácora." });
    if (!ok) return;
    try {
      const out = await MaiaAPI.reviewAction(id, "reopen");
      if (R.d && R.d.id === id) applyServer(out);
      UI.toast("Revisión reabierta.");
    } catch (e) {
      UI.toast(e.message || "No se pudo reabrir la revisión.", true);
    }
  }

  /* ══════════════ eventos ══════════════ */
  const chipset = (id, fn) => {
    $(id).onclick = e => {
      const b = e.target.closest("button");
      if (!b) return;
      [...e.currentTarget.children].forEach(c => c.setAttribute("aria-pressed", String(c === b)));
      fn(b);
    };
  };
  chipset("hypView", b => {
    R.view = b.dataset.v;
    R.hypNote = !!R.d && localReview().corrected === 0;   // sin correcciones las dos vistas son iguales: se dice
    renderHypno();
    if (R.hypNote) FX.pop($("hypNote"));
  });
  chipset("cmView", b => { R.cmView = b.dataset.v; renderAgreement(); });
  chipset("qFilt", b => { R.qFilt = b.dataset.f; renderQueue(); });
  chipset("sigWin", b => { V.win = +b.dataset.w; V.zoom = null; V.render(); renderZoom(); });
  // botones fijos del visor: tras un clic con el mouse sueltan el foco, para que Enter siga
  // confirmando la época y no vuelva a pulsar el botón (con «Pendiente »» saltaría la época sin
  // confirmarla). Con el teclado (Tab + Enter, detail 0) el foco se queda para poder repetir.
  const onTap = (id, fn) => { $(id).onclick = e => { if (e.detail) e.currentTarget.blur(); fn(); }; };
  onTap("zoomReset", () => V.setZoom(null));
  onTap("zoomPlus", () => R.d && V.zoomStep(1));
  onTap("zoomMinus", () => R.d && V.zoomStep(-1));
  onTap("panL", () => R.d && V.pan(-1));
  onTap("panR", () => R.d && V.pan(1));
  onTap("hypReset", () => setHypZoom(null));
  onTap("iPrev", () => select(R.sel - 1));
  onTap("iNext", () => select(R.sel + 1));
  onTap("iPrevF", () => jumpPending(-1));
  onTap("iNextF", () => jumpPending(1));
  // deslizador: mientras se arrastra solo cambia la etiqueta; al soltar se abre esa época
  $("epSlider").addEventListener("input", e => { if (R.d) $("epSliderOut").textContent = scrubLabel(+e.target.value - 1); });
  $("epSlider").addEventListener("change", e => { if (R.d) select(+e.target.value - 1); });
  $("epGoto").addEventListener("submit", gotoEpoch);
  $("epGotoIn").addEventListener("input", () => { $("epGotoErr").textContent = ""; $("epGotoIn").removeAttribute("aria-invalid"); });
  $("viewTabs").onclick = e => { const b = e.target.closest("button[data-tab]"); if (b) setTab(b.dataset.tab); };
  // leyenda del hipnograma → resaltar ese estadio o estado (el hipnograma lee data-focus de su contenedor)
  const hypFocus = v => { if (v) $("c-hypno").dataset.focus = v; else delete $("c-hypno").dataset.focus; };
  $("hypLegend").addEventListener("mouseover", e => { const it = e.target.closest("[data-hl]"); hypFocus(it && it.dataset.hl); });
  $("hypLegend").addEventListener("mouseleave", () => hypFocus(null));
  $("qBody").onclick = e => {
    const tr = e.target.closest("tr[data-i]");
    if (tr) select(+tr.dataset.i);
  };
  $("chToggles").onclick = e => {
    const b = e.target.closest("button");
    if (!b) return;
    const s = b.dataset.s, on = V.channels.includes(s);
    if (on && V.channels.length === 1) {                // siempre queda al menos un trazo
      UI.toast("Debe quedar al menos un canal a la vista.");
      return;
    }
    V.channels = on ? V.channels.filter(c => c !== s)
      : Object.keys(R.d.channels.available).filter(c => c === s || V.channels.includes(c));
    renderChannelToggles();
    renderGain();
    V.render();
  };
  $("gainUp").onclick = () => { V.gain = Math.min(8, V.gain * 1.5); renderGain(); V.render(); };
  $("gainDown").onclick = () => { V.gain = Math.max(0.25, V.gain / 1.5); renderGain(); V.render(); };
  $("btnSign").onclick = toggleFinalize;
  $("finCancel").onclick = () => UI.closeDialog("finModal");
  $("finConfirm").onclick = confirmFinalize;
  $("btnCsv").onclick = () => R.id && MaiaAPI.exportRecord(R.id).catch(e => UI.toast(e.message, true));
  $("btnRetry").onclick = async () => {
    try {
      const r = await MaiaAPI.retry(R.id);
      $("failBox").classList.add("hidden");
      watch(r, $("resFileName").textContent);
      showProcessing(r);
    } catch (e) { UI.toast(e.message || "No se pudo reintentar.", true); }
  };
  $("btnReconfig").onclick = () => R.go("vUp");
  $("noteText").addEventListener("input", noteCount);
  $("noteText").addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveNote(); });
  $("btnNote").onclick = saveNote;

  const KEYS = { w: 0, W: 0, 0: 0, 1: 1, 2: 2, 3: 3, r: 4, R: 4, 5: 4 };
  document.addEventListener("keydown", e => {
    if (!isActive() || UI.modalOpen() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const dir = e.key === "ArrowRight" ? 1 : -1;
      e.preventDefault();
      if (e.shiftKey) jumpPending(dir); else select(R.sel + dir);
    } else if (e.key === "a" || e.key === "A" || e.key === "b" || e.key === "B") {
      e.preventDefault();
      setStage(/a/i.test(e.key) ? R.d.epochs.stage[R.sel] : R.d.epochs.second[R.sel]);
    } else if (e.key in KEYS) {
      e.preventDefault();
      setStage(KEYS[e.key]);
    } else if (e.key === "Enter" && e.target === document.body) {
      e.preventDefault();
      setStage(R.d.epochs.stage[R.sel]);
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      setStage(null);
    } else if (e.key === "Escape") {
      if (V.zoom) V.setZoom(null);
      else if (R.hypZoom) setHypZoom(null);
    }
  });

  window.MaiaReview = {
    get cfg() { return R.cfg; },
    set cfg(v) { R.cfg = v; $("thrTxt").textContent = nf(v.confidence_threshold, 2); },
    init({ go, onChange }) { R.go = go; R.onChange = onChange; },
    open, watch, rerender, stopPolling,
    currentId: () => R.id
  };
})();
