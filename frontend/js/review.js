/* ════════════════════════════════════════════════════════════════════
   MAIA · vista de resultados y revisión del especialista
   ────────────────────────────────────────────────────────────────────
   - mientras el análisis corre, muestra su avance y consulta el registro;
   - al terminar: hipnograma, revisión época a época (con teclado),
     cola de épocas marcadas, arquitectura del sueño, concordancia y
     calidad del registro.
   Las correcciones se aplican al instante en pantalla y se envían a la
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
    corr: new Map(),             // época → estadio vigente del especialista
    sel: 0,
    view: "final",               // hipnograma: final | predicted
    cmView: "predicted",
    qFilt: "pending",
    autoAdvance: true,
    chain: Promise.resolve(),    // PATCH en orden
    inflight: 0,
    pollTimer: null,
    viewerTimer: null,
    go: () => {},
    onChange: () => {}
  };
  const V = C.SignalViewer;

  const locked = () => R.d && R.d.review && R.d.review.status === "signed_off";
  const isActive = () => !$("vRes").classList.contains("hidden") && !!R.d;
  const clockOf = i => (R.d.night.start_clock_s != null ? R.d.night.start_clock_s + i * R.d.night.epoch_s : null);
  const MODE_TXT = { reference: "Ventana de sueño del hipnograma (±30 min)", range: "Rango horario", full: "Registro completo" };
  const KIND_TXT = { provisional: "Provisional (YASA)", mock: "Simulado", sagemaker: "Stacking del proyecto (SageMaker)" };

  /* ══════════════ abrir un registro ══════════════ */
  async function open(id) {
    stopPolling();
    R.id = id;
    R.d = null;
    R.go("vRes");
    $("resBody").classList.add("hidden");
    $("procPanel").classList.add("hidden");
    $("failBox").classList.add("hidden");
    $("resFileName").innerHTML = '<span class="skel" style="width:220px">&nbsp;</span>';
    $("resFileMeta").textContent = "";
    try {
      route(await MaiaAPI.getRecord(id));
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
    $("resFileName").textContent = r.file_name;
    const at = UI.parse(r.created_at), sex = UI.sexText(r.sex);
    // en el resumen `channels` es la lista; en el detalle, un objeto con la selección
    const slots = Array.isArray(r.channels) ? r.channels : (r.channels || {}).selected || [];
    $("resFileMeta").innerHTML = [
      `${esc(r.subject_code)} · ${UI.dLong.format(at)}, ${UI.dTime(at)}`,
      sex || r.age ? [sex, r.age ? `${r.age} años` : null].filter(Boolean).join(", ") : null,
      UI.chips(slots, R.cfg.channels),
      r.created_by ? `por ${esc(r.created_by)}` : null
    ].filter(Boolean).join(" · ");
    $("btnCsv").disabled = r.status !== "done";
  }

  /* ── en proceso ── */
  function showProcessing(r) {
    $("procPanel").classList.remove("hidden");
    const steps = ["queued", "reading", "staging", "metrics"];
    const labels = { queued: "En cola", reading: "Leyendo el registro y los canales",
                     staging: "Estadificando con el modelo", metrics: "Calculando métricas" };
    const cur = Math.max(0, steps.indexOf((r.progress || {}).step || "queued"));
    $("procSteps").innerHTML = steps.map((s, i) =>
      `<div class="pstep ${i < cur ? "done" : i === cur ? "now" : ""}"><span class="dot">${i < cur ? "✓" : ""}</span>` +
      `${i === cur && r.progress && r.progress.message ? esc(r.progress.message) : labels[s]}</div>`).join("") +
      `<div class="pstep"><span class="dot"></span>Listo para revisar</div>`;
    const secs = Math.max(0, Math.round((Date.now() - UI.parse(r.created_at)) / 1000));
    $("procElapsed").textContent = secs < 90 ? `${secs} s` : `${Math.round(secs / 60)} min`;
    $("procCap").textContent = (r.progress || {}).step === "staging" && R.cfg.model && R.cfg.model.kind === "sagemaker"
      ? "El endpoint del modelo se apaga cuando no se usa: el primer análisis puede tardar unos minutos en encenderlo."
      : "El análisis corre en el servidor; puede salir de esta vista y volver después.";
    R.pollTimer = setTimeout(async () => {
      if (R.id !== r.id || $("vRes").classList.contains("hidden")) return;
      try { route(await MaiaAPI.getRecord(r.id)); } catch (e) { R.pollTimer = setTimeout(() => showProcessing(r), CFG.pollMs); }
    }, CFG.pollMs);
  }

  function stopPolling() { clearTimeout(R.pollTimer); R.pollTimer = null; }

  function showFailed(r) {
    $("procPanel").classList.add("hidden");
    $("failBox").classList.remove("hidden");
    $("failText").textContent = " " + (r.error || "Error desconocido.");
    R.onChange();
  }

  /* ══════════════ resultado ══════════════ */
  function show(d) {
    $("procPanel").classList.add("hidden");
    $("resBody").classList.remove("hidden");
    const first = !R.d || R.d.id !== d.id;
    R.d = d;
    R.corr = new Map(d.corrections.map(c => [c.epoch, c.stage]));
    if (first) {
      R.sel = nextPending(-1, 1) ?? d.epochs.review.indexOf(1);
      if (R.sel < 0) R.sel = 0;
      V.init($("c-signal"), d, {
        epoch: R.sel, win: V.win || 90, gain: 1, corr: R.corr, info: R.cfg.channels,
        channels: d.channels.selected.filter(s => s in d.channels.available), onSelect: select
      });
    }
    V.d = d;
    V.corr = R.corr;
    renderAlerts();
    renderTiles();
    renderHypno();
    renderChannelToggles();
    renderReviewBar();
    renderInspector();
    V.epoch = R.sel;
    V.render();
    renderQueue();
    renderArchitecture();
    renderAgreement();
    renderQuality();
    R.onChange();
  }

  function rerender() {
    if (!R.d || $("vRes").classList.contains("hidden")) return;
    renderHypno();
    renderArchitecture();
    renderAgreement();
    renderQuality();
    V.render();
  }

  /* ── avisos sobre el resultado ── */
  function renderAlerts() {
    const d = R.d, out = [];
    const alert = (cls, mark, title, body) =>
      `<div class="alert ${cls}"><span class="m">${mark}</span><span><span class="ti">${title}</span>${body}</span></div>`;
    const rv = d.review;
    if (rv.whole_night_recommended) {
      out.push(alert("c", "!", "Se sugiere revisar la noche completa.",
        `El modelo marcó el <b>${pct(rv.flagged_fraction)}</b> de las épocas, por encima del límite de ` +
        `${pct(d.model.night_review_fraction)} (percentil 90 de las noches de entrenamiento).`));
    }
    const ex = d.model.expected;
    if (ex.below_goal) {
      out.push(alert("w", "!", `${esc(d.combination_name)} queda por debajo de la meta del proyecto.`,
        `Con esta combinación el modelo del proyecto obtuvo MF1 <b>${nf(ex.test_mf1, 3)}</b> en el test, bajo la meta de ` +
        `${nf(ex.goal_mf1, 2)}. Si el registro tiene Fpz-Cz o EOG, agregarlos mejora la estadificación.`));
    }
    if (d.dataset && d.dataset.split === "dev") {
      out.push(alert("i", "i", "Noche del conjunto de desarrollo.",
        `El sujeto ${d.dataset.subject} se usó para entrenar el modelo del proyecto: con ese modelo, la concordancia ` +
        `de esta noche sería optimista. Las noches del test son las que miden el desempeño real.`));
    }
    if (d.model.kind !== "sagemaker") {
      const notes = (d.model.notes || []).map(n => `<li>${esc(n)}</li>`).join("");
      out.push(alert(d.model.kind === "mock" ? "w" : "i", "i",
        d.model.kind === "mock" ? "Resultados simulados." : "Modelo provisional.",
        (d.model.kind === "mock"
          ? "Este análisis no viene de ningún modelo entrenado: sirve para probar la aplicación."
          : `Estadificó <b>${esc(d.model.version)}</b>, un estadificador abierto, mientras se conecta el endpoint con el ` +
            "stacking del proyecto. El desempeño esperado que se muestra por combinación es el del modelo del proyecto.") +
        (notes ? `<ul>${notes}</ul>` : "")));
    }
    $("resAlerts").innerHTML = out.join("");
  }

  /* ── indicadores ── */
  function localReview() {
    const ep = R.d.epochs;
    let flagged = 0, resolved = 0, changed = 0;
    for (let i = 0; i < ep.review.length; i++) {
      if (ep.review[i]) { flagged++; if (R.corr.has(i)) resolved++; }
    }
    R.corr.forEach((s, i) => { if (s !== ep.stage[i]) changed++; });
    return { ...R.d.review, flagged, resolved, pending: flagged - resolved, corrected: changed };
  }

  function renderTiles() {
    const d = R.d, n = d.night.n_epochs, rv = localReview();
    $("rEpochs").textContent = fmtHM(n * d.night.epoch_s);
    $("rEpochsN").textContent = `${fmtInt(n)} épocas · ${MODE_TXT[d.night.window.mode].toLowerCase()}`;
    $("rCov").textContent = pct(1 - rv.flagged / n, 1);
    $("rCovN").textContent = `${fmtInt(n - rv.flagged)} épocas con confianza ≥ ${nf(d.model.threshold, 2)}`;
    $("rFlag").innerHTML = `${fmtInt(rv.flagged)} <small>(${pct(rv.flagged / n, 0)})</small>`;
    $("rFlagN").textContent = rv.flagged ? `${rv.pending} pendientes · ${rv.resolved} resueltas` : "ninguna época dudosa";
    const ag = d.agreement;
    if (ag && ag.predicted) {
      const fin = ag.final || ag.predicted;
      $("rAgrK").textContent = "Concordancia (κ)";
      $("rAgr").textContent = nf(fin.kappa, 3);
      $("rAgrN").textContent = `exactitud ${pct(fin.accuracy, 1)} · MF1 ${nf(fin.mf1, 3)}` +
        (R.corr.size ? " · con revisión" : "");
    } else {
      $("rAgrK").textContent = "Concordancia";
      $("rAgr").textContent = "—";
      $("rAgrN").textContent = "sin hipnograma de referencia";
    }
  }

  /* ── hipnograma ── */
  function renderHypno() {
    const d = R.d;
    const st = STG.map(s => `<span><i style="background:${s.c}"></i>${s.k}</span>`).join("");
    const rv = Object.entries(C.STATUS).map(([, v]) =>
      `<span><i style="background:var(${v.v})"></i>${v.label}</span>`).join("");
    $("hypLegend").innerHTML = st + '<span style="color:var(--muted)">·</span>' + rv +
      (d.epochs.reference ? '<span style="color:var(--muted)">· abajo: referencia del experto</span>' : "");
    C.renderHypnogram($("c-hypno"), d, {
      view: R.view, selected: R.sel, corr: R.corr, onSelect: select,
      viewRange: V.d ? V.range().map(t => t / d.night.epoch_s) : null
    });
  }

  /* ── visor ── */
  function renderChannelToggles() {
    const d = R.d;
    const slots = Object.keys(d.channels.available);
    $("chToggles").innerHTML = slots.map(s => {
      const info = R.cfg.channels[s] || { name: s };
      const used = d.channels.selected.includes(s);
      return `<button data-s="${s}" aria-pressed="${V.channels.includes(s)}" class="${used ? "" : "unused"}" ` +
        `title="${used ? "Canal usado por el modelo" : "Canal del archivo que el modelo no usó"}">${esc(info.name)}</button>`;
    }).join("");
  }

  function renderViewerSoon() {
    clearTimeout(R.viewerTimer);
    R.viewerTimer = setTimeout(() => V.render(), 70);
  }

  /* ── barra de avance de la revisión ── */
  function renderReviewBar() {
    const d = R.d, rv = localReview();
    const status = locked() ? "signed_off" : (R.corr.size ? "in_progress" : "pending");
    $("revStatus").className = "pill " + { signed_off: "ok", in_progress: "run", pending: "w" }[status];
    $("revStatus").textContent = { signed_off: "Finalizada", in_progress: "En revisión", pending: "Sin revisar" }[status];
    $("revProg").style.width = rv.flagged ? `${(100 * rv.resolved / rv.flagged).toFixed(1)}%` : "100%";
    if (locked()) {
      const at = UI.parse(d.review.signed_off_at);
      $("revText").innerHTML = `Finalizada por <b>${esc(d.review.signed_off_by)}</b> el ${UI.dLong.format(at)}, ` +
        `${UI.dTime(at)} · ${rv.corrected} cambio${rv.corrected === 1 ? "" : "s"}`;
    } else {
      $("revText").innerHTML = rv.flagged
        ? `<b>${rv.resolved}</b> de ${rv.flagged} épocas marcadas resueltas · ${rv.corrected} cambio${rv.corrected === 1 ? "" : "s"}`
        : `El modelo no marcó épocas · ${rv.corrected} cambio${rv.corrected === 1 ? "" : "s"}`;
    }
    $("btnSign").textContent = locked() ? "Reabrir revisión" : "Finalizar revisión";
    $("btnSign").classList.toggle("ghost", locked());
    $("btnSign").classList.toggle("cta", !locked());
  }

  /* ── inspector de la época seleccionada ── */
  function renderInspector() {
    const d = R.d, i = R.sel, ep = d.epochs, n = d.night.n_epochs, EP = d.night.epoch_s;
    const st = C.epochStatus(d, i, R.corr);
    const pred = ep.stage[i], fin = ep.final[i], p = ep.probs[i];
    const t = clockOf(i);
    const top2 = new Set([pred, ep.second[i]]);
    const statusTxt = {
      pending: '<span class="pill w">Marcada · pendiente</span>',
      confirmed: '<span class="pill ok">Confirmada</span>',
      corrected: `<span class="pill c">Corregida: ${STG[pred].k} → ${STG[fin].k}</span>`
    }[st] || '<span class="pill">Entregada por el modelo</span>';
    const who = R.d.corrections.find(c => c.epoch === i);
    $("insp").innerHTML = `
      <div class="ep"><span>Época ${i + 1} <span class="tm">de ${fmtInt(n)}</span></span>
        <span class="tm">${t != null ? `${clockHMS(t)} – ${clockHMS(t + EP)}` : ""}</span></div>
      <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">${statusTxt}</div>
      ${who && st ? `<div class="mini" style="margin-top:6px">por ${esc(who.author)}</div>` : ""}
      <h4>Probabilidades del modelo</h4>
      ${STG.map((s, k) => `<div class="pbar ${k === pred ? "top" : ""}"><span>${s.k}</span>
        <span class="tr"><span class="fi" style="display:block;width:${(100 * p[k]).toFixed(1)}%;background:${s.c}"></span></span>
        <span>${Math.round(100 * p[k])} %</span></div>`).join("")}
      ${ep.reference ? `<div class="mini" style="margin-top:6px">Referencia del experto: ${UI.stage(ep.reference[i])}</div>` : ""}
      <h4>Estadio final</h4>
      <div class="stagebtns">${STG.map((s, k) => `<button data-st="${k}" aria-pressed="${k === fin}"
        class="${top2.has(k) && k !== fin ? "sug" : ""}" ${locked() ? "disabled" : ""}
        style="${k === fin ? `background:${s.c}` : ""}" title="${s.k}${top2.has(k) ? " · opción del modelo" : ""}">
        ${s.k}<small>${["W", "1", "2", "3", "R"][k]}</small></button>`).join("")}</div>
      <div class="ibtns">
        <button class="ghost" id="iConfirm" ${locked() || (st === "confirmed") ? "disabled" : ""}
          title="Enter">✓ Confirmar ${STG[pred].k}</button>
        <button class="ghost" id="iRevert" ${locked() || !R.corr.has(i) ? "disabled" : ""}
          title="Retroceso">↺ Predicción</button>
      </div>
      ${locked() ? '<div class="mini">La revisión está finalizada. Reábrala para hacer cambios.</div>' : ""}
      <div class="inav">
        <button class="ghost" id="iPrev" ${i === 0 ? "disabled" : ""}>← Época</button>
        <button class="ghost" id="iNext" ${i === n - 1 ? "disabled" : ""}>Época →</button>
        <button class="ghost" id="iPrevF">« Pendiente</button>
        <button class="ghost" id="iNextF">Pendiente »</button>
      </div>
      <label class="chk"><input type="checkbox" id="iAuto" ${R.autoAdvance ? "checked" : ""}>
        Pasar a la siguiente al decidir</label>`;
    $("insp").querySelectorAll(".stagebtns button").forEach(b => b.onclick = () => setStage(+b.dataset.st));
    $("iConfirm").onclick = () => setStage(pred);
    $("iRevert").onclick = () => setStage(null);
    $("iPrev").onclick = () => select(i - 1);
    $("iNext").onclick = () => select(i + 1);
    $("iPrevF").onclick = () => jumpPending(-1);
    $("iNextF").onclick = () => jumpPending(1);
    $("iAuto").onchange = e => { R.autoAdvance = e.target.checked; };
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
    const lbl = { pending: '<span class="pill w">Pendiente</span>', confirmed: '<span class="pill ok">Confirmada</span>' };
    $("qBody").innerHTML = rows.length ? rows.map(i => {
      const st = C.epochStatus(d, i, R.corr), t = clockOf(i);
      return `<tr data-i="${i}" class="${i === R.sel ? "sel" : ""}"><td class="l">${i + 1}</td>
        <td class="l">${t != null ? clockHMS(t) : "—"}</td>
        <td class="l">${UI.stage(ep.stage[i])} ${Math.round(100 * ep.confidence[i])} %</td>
        <td class="l">${UI.stage(ep.second[i])} ${Math.round(100 * ep.probs[i][ep.second[i]])} %</td>
        <td class="l">${ep.reference ? UI.stage(ep.reference[i]) : "—"}</td>
        <td class="l">${st === "corrected" ? `<span class="pill c">→ ${STG[ep.final[i]].k}</span>` : (lbl[st] || "—")}</td></tr>`;
    }).join("") : `<tr><td class="l" colspan="6" style="color:var(--muted);cursor:default">${
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

  /* ── arquitectura del sueño ── */
  function renderArchitecture() {
    const d = R.d, m = d.metrics;
    const cols = [["Modelo", m.predicted], ["Final", m.final || m.predicted]];
    if (m.reference) cols.push(["Referencia", m.reference]);
    C.renderStageBars($("c-stages"), cols.map(([label, x]) => ({ label, stages: x.stages })));
    const rows = [
      ["Tiempo en cama", x => nf(x.tib_min) + " min"],
      ["Sueño total", x => nf(x.tst_min) + " min"],
      ["Eficiencia del sueño", x => x.efficiency_pct == null ? "—" : nf(x.efficiency_pct) + " %"],
      ["Latencia de sueño", x => x.sol_min == null ? "—" : nf(x.sol_min) + " min"],
      ["Latencia REM", x => x.rem_latency_min == null ? "—" : nf(x.rem_latency_min) + " min"],
      ["Vigilia tras dormirse (WASO)", x => x.waso_min == null ? "—" : nf(x.waso_min) + " min"],
      ["Despertares (≥ 1 min)", x => x.awakenings],
      ...["N1", "N2", "N3", "REM"].map(s => [`${s} (% del sueño)`, x => nf(x.stages[s].pct) + " %"])
    ];
    $("archTable").innerHTML = `<thead><tr><th class="l">Métrica</th>${cols.map(c => `<th>${c[0]}</th>`).join("")}</tr></thead>` +
      `<tbody>${rows.map(([label, f]) => `<tr style="cursor:default"><td class="l">${label}</td>` +
        cols.map(c => `<td>${f(c[1])}</td>`).join("") + "</tr>").join("")}</tbody>`;
  }

  /* ── concordancia ── */
  function renderAgreement() {
    const ag = R.d.agreement;
    $("agrPanel").classList.toggle("hidden", !(ag && ag.predicted));
    if (!(ag && ag.predicted)) return;
    const a = ag.predicted, f = ag.final || a;
    const delta = (x, y) => {
      const v = y - x;
      return Math.abs(v) < 0.0005 ? "sin cambio" : `${v > 0 ? "+" : "−"}${nf(Math.abs(v), 3)} con la revisión`;
    };
    const tile = (k, x, y, fmt) => `<div class="tile"><div class="k">${k}</div><div class="v">${fmt(x)}</div>
      <div class="n">${R.corr.size ? `final: ${fmt(y)} · ${delta(x, y)}` : "del modelo, antes de revisar"}</div></div>`;
    $("agrTiles").innerHTML = tile("Exactitud", a.accuracy, f.accuracy, v => pct(v, 1)) +
      tile("MF1", a.mf1, f.mf1, v => nf(v, 3)) + tile("κ de Cohen", a.kappa, f.kappa, v => nf(v, 3)) +
      `<div class="tile"><div class="k">Épocas comparadas</div><div class="v">${fmtInt(a.n_epochs)}</div>
       <div class="n">${fmtInt(R.d.night.n_epochs - a.n_epochs)} sin estadio en la referencia</div></div>`;
    const cm = R.cmView === "final" ? f : a;
    $("cmCol").textContent = R.cmView === "final" ? "final" : "modelo";
    C.renderConfusion($("c-cm"), cm.confusion, R.cmView === "final" ? "final" : "modelo");
    C.renderF1($("c-f1"), a, R.corr.size ? f : null);
  }

  /* ── registro, modelo y bitácora ── */
  function renderQuality() {
    const d = R.d, q = d.quality, f = q.file, nt = d.night, mo = d.model, ex = mo.expected;
    C.renderQuality($("c-quality"), q.composition);
    const start = f.start ? new Date(f.start) : null;
    $("kvFile").replaceChildren(
      UI.kv("Nombre", esc(f.name)),
      UI.kv("Tamaño", f.size_mb != null ? nf(f.size_mb) + " MB" : "—"),
      UI.kv("Inicio", start ? `${UI.dShort(start)}, ${clockHM(f.start_clock_s)}` : "—"),
      UI.kv("Duración total", fmtHM(f.total_duration_s)),
      UI.kv("Canales en el archivo", f.channels),
      UI.kv("Señal del visor", nf(f.sampling_hz, 0) + " Hz"),
      UI.kv("Sujeto · noche", d.dataset ? `${d.dataset.subject} · noche ${d.dataset.night} (${d.dataset.split === "test" ? "test" : "desarrollo"})` : "fuera del índice de Sleep-EDFx")
    );
    const w0 = clockOf(0), w1 = clockOf(nt.n_epochs);
    const loSrc = { manual: "indicada", "dataset-index": "índice de Sleep-EDFx" }[nt.lights_off_source];
    $("kvAnalysis").replaceChildren(
      UI.kv("Ventana", MODE_TXT[nt.window.mode]),
      UI.kv("Desde – hasta", w0 != null ? `${clockHM(w0)} – ${clockHM(w1)}` : "—"),
      UI.kv("Épocas de 30 s", fmtInt(nt.n_epochs)),
      UI.kv("Apagado de luces", nt.lights_off_clock ? `${nt.lights_off_clock} (${loSrc})` : "no indicado: inicio de la ventana"),
      UI.kv("Canales del modelo", d.channels.selected.map(s =>
        `${esc((R.cfg.channels[s] || {}).name || s)} ← ${esc(d.channels.map[s])}`).join("<br>")),
      UI.kv("Épocas sin estadio en la referencia", q.reference_unscored == null ? "sin referencia" : fmtInt(q.reference_unscored))
    );
    const tm = q.timings;
    $("kvModel").replaceChildren(
      UI.kv("Versión", esc(mo.version)),
      UI.kv("Tipo", KIND_TXT[mo.kind] || mo.kind),
      UI.kv("Combinación", `${esc(d.combination_name)} <span class="mini" style="margin:0">(${esc(d.combination)})</span>`),
      UI.kv("Umbral de confianza", nf(mo.threshold, 2)),
      UI.kv("Revisión completa si", `marca > ${pct(mo.night_review_fraction)}`),
      UI.kv("MF1 esperado (test)", `${nf(ex.test_mf1, 3)} [${nf(ex.test_ci[0], 3)}; ${nf(ex.test_ci[1], 3)}]`),
      UI.kv("κ esperado (test)", nf(ex.test_kappa, 3)),
      UI.kv("Tiempo", `lectura ${nf(tm.read_s)} s · modelo ${nf(tm.model_s)} s · total ${nf(tm.total_s)} s`)
    );
    renderHistory();
  }

  function renderHistory() {
    const h = R.d.history || [];
    const st = v => (v == null ? "—" : STG[v].k);
    $("histList").innerHTML = h.length ? h.map(e => {
      const at = UI.parse(e.at);
      const what = {
        set: e.stage === e.previous ? `confirmó la época ${e.epoch + 1} (${st(e.stage)})`
          : `cambió la época ${e.epoch + 1}: ${st(e.previous)} → <b>${st(e.stage)}</b>`,
        clear: `devolvió la época ${e.epoch + 1} a la predicción del modelo (estaba en ${st(e.previous)})`,
        sign_off: "<b>finalizó la revisión</b>",
        reopen: "reabrió la revisión"
      }[e.action] || e.action;
      return `<div><time>${UI.dShort(at)} ${UI.dTime(at)}</time>${esc(e.author)} ${what}</div>`;
    }).join("") : '<div style="color:var(--muted)">Todavía no hay cambios: el hipnograma final es el del modelo.</div>';
  }

  /* ══════════════ navegación y decisiones ══════════════ */
  function select(i) {
    if (!R.d) return;
    R.sel = Math.max(0, Math.min(R.d.night.n_epochs - 1, i));
    V.epoch = R.sel;
    renderInspector();
    renderHypno();
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
    const i = nextPending(R.sel, dir);
    if (i == null) UI.toast(dir > 0 ? "No hay más épocas pendientes hacia adelante." : "No hay épocas pendientes antes de esta.");
    else select(i);
  }

  function setStage(stage) {
    if (!R.d) return;
    if (locked()) { UI.toast("La revisión está finalizada. Reábrala para hacer cambios."); return; }
    const i = R.sel, ep = R.d.epochs, pred = ep.stage[i];
    const prev = R.corr.has(i) ? R.corr.get(i) : null;
    const wasFlagged = ep.review[i] === 1;
    if (stage === null && prev === null) return;
    if (stage !== null && prev === stage) { if (R.autoAdvance) advance(wasFlagged); return; }
    if (stage === null) R.corr.delete(i); else R.corr.set(i, stage);
    ep.final[i] = stage === null ? pred : stage;
    push(i, stage);
    afterLocalChange();
    if (stage !== null && R.autoAdvance) advance(wasFlagged);
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

  /* las correcciones viajan en orden; cuando no queda ninguna en camino, manda la API */
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
  }

  function applyServer(out) {
    const d = R.d;
    d.epochs.final = out.final;
    d.metrics.final = out.metrics_final;
    if (d.agreement) d.agreement.final = out.agreement_final;
    d.corrections = out.corrections;
    d.review = out.review;
    d.history = out.history;
    R.corr = new Map(out.corrections.map(c => [c.epoch, c.stage]));
    V.corr = R.corr;
    renderTiles();
    renderReviewBar();
    renderInspector();
    renderHypno();
    renderQueue();
    renderArchitecture();
    renderAgreement();
    renderHistory();
    R.onChange();
  }

  async function toggleSignOff() {
    if (!R.d) return;
    const id = R.d.id;
    if (!locked()) {
      const rv = localReview();
      const ok = await UI.confirm({
        title: "¿Finalizar la revisión?",
        html: rv.pending
          ? `Quedan <b>${rv.pending}</b> épocas marcadas sin revisar. Si finaliza, el hipnograma final las toma tal como ` +
            `las predijo el modelo. La revisión quedará firmada con su nombre y se puede reabrir.`
          : `Todas las épocas marcadas están resueltas (${rv.corrected} cambio${rv.corrected === 1 ? "" : "s"}). ` +
            "La revisión quedará firmada con su nombre y se puede reabrir.",
        confirmLabel: "Finalizar revisión"
      });
      if (!ok) return;
    }
    try {
      await R.chain;
      const out = await MaiaAPI.reviewAction(id, locked() ? "reopen" : "sign_off");
      if (R.d && R.d.id === id) applyServer(out);
      UI.toast(locked() ? "Revisión finalizada." : "Revisión reabierta.");
    } catch (e) {
      UI.toast(e.message || "No se pudo cambiar el estado de la revisión.", true);
    }
  }

  /* ══════════════ eventos ══════════════ */
  $("hypView").onclick = e => {
    const b = e.target.closest("button");
    if (!b) return;
    [...e.currentTarget.children].forEach(c => c.setAttribute("aria-pressed", String(c === b)));
    R.view = b.dataset.v;
    renderHypno();
  };
  $("cmView").onclick = e => {
    const b = e.target.closest("button");
    if (!b) return;
    [...e.currentTarget.children].forEach(c => c.setAttribute("aria-pressed", String(c === b)));
    R.cmView = b.dataset.v;
    renderAgreement();
  };
  $("qFilt").onclick = e => {
    const b = e.target.closest("button");
    if (!b) return;
    [...e.currentTarget.children].forEach(c => c.setAttribute("aria-pressed", String(c === b)));
    R.qFilt = b.dataset.f;
    renderQueue();
  };
  $("qBody").onclick = e => {
    const tr = e.target.closest("tr[data-i]");
    if (tr) select(+tr.dataset.i);
  };
  $("sigWin").onclick = e => {
    const b = e.target.closest("button");
    if (!b) return;
    [...e.currentTarget.children].forEach(c => c.setAttribute("aria-pressed", String(c === b)));
    V.win = +b.dataset.w;
    V.render();
    renderHypno();
  };
  $("chToggles").onclick = e => {
    const b = e.target.closest("button");
    if (!b) return;
    const s = b.dataset.s, on = V.channels.includes(s);
    if (on && V.channels.length === 1) return;          // siempre queda al menos un trazo
    V.channels = on ? V.channels.filter(c => c !== s)
      : Object.keys(R.d.channels.available).filter(c => c === s || V.channels.includes(c));
    renderChannelToggles();
    V.render();
  };
  $("gainUp").onclick = () => { V.gain = Math.min(8, V.gain * 1.5); V.render(); };
  $("gainDown").onclick = () => { V.gain = Math.max(0.25, V.gain / 1.5); V.render(); };
  $("btnSign").onclick = toggleSignOff;
  $("btnCsv").onclick = () => R.id && MaiaAPI.exportRecord(R.id).catch(e => UI.toast(e.message, true));
  $("btnRetry").onclick = () => R.go("vUp");

  const KEYS = { w: 0, W: 0, 0: 0, 1: 1, 2: 2, 3: 3, r: 4, R: 4, 5: 4 };
  document.addEventListener("keydown", e => {
    if (!isActive() || UI.modalOpen() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const dir = e.key === "ArrowRight" ? 1 : -1;
      e.preventDefault();
      if (e.shiftKey) jumpPending(dir); else select(R.sel + dir);
    } else if (e.key in KEYS) {
      e.preventDefault();
      setStage(KEYS[e.key]);
    } else if (e.key === "Enter" && e.target === document.body) {
      e.preventDefault();
      setStage(R.d.epochs.stage[R.sel]);
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      setStage(null);
    }
  });

  window.MaiaReview = {
    get cfg() { return R.cfg; },
    set cfg(v) { R.cfg = v; $("thrTxt").textContent = nf(v.confidence_threshold, 2); },
    init({ go, onChange }) { R.go = go; R.onChange = onChange; },
    open, rerender, stopPolling,
    currentId: () => R.id
  };
})();
