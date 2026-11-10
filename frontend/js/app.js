/* ════════════════════════════════════════════════════════════════════
   MAIA · lógica de la aplicación (sesión, navegación, registros y
   «Analizar nuevo»: catálogo de noches, PSG propio, canales y ventana).
   La vista de resultados y revisión vive en js/review.js.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const { nf, pct, clockHM, fmtHM, fmtInt, median, esc } = MaiaUtil;
  const C = MaiaCharts, UI = MaiaUI, $ = UI.$;

  let cfg = null;              // reglas del modelo (GET /config)
  let records = [];
  let filt = "all";
  let query = "";
  let listTimer = null;
  let catalog = null;          // {source, nights}
  let catFilt = "all";
  let catQuery = "";

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ══════════════ tema (claro / oscuro) ══════════════ */
  const THEME_KEY = "maia_theme";
  const ICONS = {
    light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5 5l1.7 1.7M17.3 17.3 19 19M19 5l-1.7 1.7M6.7 17.3 5 19"/></svg>',
    dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.4 14.2A8.2 8.2 0 0 1 9.8 3.6a8.2 8.2 0 1 0 10.6 10.6Z"/></svg>'
  };
  const themeButtons = () => ["btnTheme", "btnThemeLogin"].map($).filter(Boolean);

  function applyTheme(t, rerender = true) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* almacenamiento bloqueado */ }
    themeButtons().forEach(b => { b.innerHTML = t === "dark" ? ICONS.light : ICONS.dark; });
    if (rerender) {                       // el icono nuevo entra girando (sol ↔ luna)
      themeButtons().forEach(b => MaiaFX.play(b.firstElementChild,
        [{ transform: "rotate(-120deg) scale(.4)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 300 }));
    }
    if (rerender) {                       // los SVG leen los colores al dibujarse
      if (!$("vList").classList.contains("hidden") && records.length) renderStrip();
      if (!$("vUp").classList.contains("hidden")) updateCombo();
      MaiaReview.rerender();
    }
  }
  let savedTheme = null;
  try { savedTheme = localStorage.getItem(THEME_KEY); } catch (e) { /* idem */ }
  applyTheme(savedTheme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"), false);
  themeButtons().forEach(b => b.onclick = () =>
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));

  function countUp(el, to, fmt = v => String(Math.round(v))) {
    if (reducedMotion || !(to > 0)) { el.textContent = fmt(to); return; }
    const t0 = performance.now(), dur = 520;
    const step = now => {
      const p = Math.min(1, (now - t0) / dur);
      el.textContent = fmt(to * (p * (2 - p)));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ── navegación entre vistas ──
     Con View Transitions (si el navegador la tiene y no se pidió reducir movimiento) la vista
     saliente y la entrante se encadenan con un deslizamiento corto; opts.shared (la fila de
     Registros) se transforma en la tarjeta del encabezado de resultados. El cambio de DOM llega
     un cuadro después: go() devuelve una promesa que se cumple cuando la vista ya está visible. */
  const VIEWS = ["vList", "vUp", "vRes"];
  const useVT = !!document.startViewTransition && MaiaFX.enabled();
  if (useVT) document.documentElement.classList.add("has-vt");     // la transición reemplaza al viewIn de CSS
  function go(v, { shared } = {}) {
    const apply = vt => {
      VIEWS.forEach(id => $(id).classList.toggle("hidden", id !== v));
      document.body.dataset.view = v;                 // resultados usa el ancho de la pantalla (US-06)
      document.querySelectorAll("nav button").forEach(b =>
        b.setAttribute("aria-selected", String(b.dataset.v === v || (v === "vRes" && b.dataset.v === "vList"))));
      if (v !== "vRes") MaiaReview.stopPolling();
      if (v !== "vList") clearTimeout(listTimer);
      if (v === "vList") refreshList();
      if (v === "vUp") loadCatalog();
      window.scrollTo({ top: 0, behavior: vt ? "instant" : "smooth" });
    };
    const from = VIEWS.find(id => !$(id).classList.contains("hidden"));
    if (!useVT || !MaiaFX.enabled() || from === v) { apply(false); return Promise.resolve(); }
    const root = document.documentElement;
    root.dataset.vtdir = from && VIEWS.indexOf(v) < VIEWS.indexOf(from) ? "back" : "fwd";
    if (shared) shared.style.viewTransitionName = "rec";
    let t;
    try {
      t = document.startViewTransition(() => {
        if (shared) shared.style.viewTransitionName = "";
        if (shared && v === "vRes") $("resCard").style.viewTransitionName = "rec";
        apply(true);
      });
    } catch (e) {                         // p. ej. dos elementos con el mismo nombre: sin transición
      if (shared) shared.style.viewTransitionName = "";
      apply(false);
      return Promise.resolve();
    }
    Promise.resolve(t.finished).catch(() => {}).then(() => { $("resCard").style.viewTransitionName = ""; delete root.dataset.vtdir; });
    return Promise.resolve(t.updateCallbackDone).catch(() => {});
  }

  MaiaReview.init({ go, onChange: () => {} });

  /* ══════════════ vista REGISTROS ══════════════ */
  const done = () => records.filter(r => r.status === "done" && r.review);
  const finalized = r => r.review && (r.review.status === "finalized" || r.review.status === "signed_off");

  function renderTiles() {
    const ok = done();
    countUp($("tCount"), ok.length);
    const subjects = new Set(ok.map(r => r.subject_code)).size;
    const busy = records.filter(r => r.status === "queued" || r.status === "running").length;
    $("tCountN").textContent = `${subjects} sujeto${subjects === 1 ? "" : "s"} distintos` +
      (busy ? ` · ${busy} en proceso` : "");
    const todo = ok.filter(r => !finalized(r) && r.review.pending > 0);
    countUp($("tTodo"), todo.length);
    const pend = todo.reduce((a, r) => a + r.review.pending, 0);
    $("tTodoN").textContent = todo.length ? `${fmtInt(pend)} épocas marcadas pendientes` : "todo revisado";
    if (ok.length) {
      countUp($("tCov"), 100 * median(ok.map(r => 1 - r.review.flagged_fraction)), v => nf(v, 1) + " %");
    } else $("tCov").textContent = "—";
    countUp($("tWhole"), ok.filter(r => r.review.whole_night_recommended).length);
    $("tWholeN").textContent = `de ${ok.length} noche${ok.length === 1 ? "" : "s"}`;
  }

  function renderStrip() {
    const el = $("c-strip");
    el._onPick = id => MaiaReview.open(id);
    C.renderStrip(el, done(), cfg ? cfg.night_review_fraction : 0.273);
  }

  function renderTable() {
    const rows = records
      .filter(r => filt === "all"
        || (filt === "todo" && r.status === "done" && r.review && !finalized(r))
        || (filt === "whole" && r.review && r.review.whole_night_recommended)
        || (filt === "signed" && finalized(r)))
      .filter(r => !query || [r.subject_code, r.file_name, r.night_label, r.combination_name]
        .some(v => (v || "").toLowerCase().includes(query)));
    $("cnt").textContent = `${rows.length} registro${rows.length === 1 ? "" : "s"}`;
    if (!rows.length) {
      $("tb").innerHTML = `<tr><td class="l" colspan="8" style="color:var(--muted)">${
        records.length ? "Ningún registro coincide con el filtro." : "Aún no hay análisis: use «Analizar nuevo»."}</td></tr>`;
      return;
    }
    $("tb").replaceChildren(...rows.map((r, i) => {
      const tr = document.createElement("tr");
      tr.className = "anim click";
      tr.style.setProperty("--i", Math.min(i, 12));
      const at = UI.parse(r.created_at), rv = r.review;
      const busy = r.status === "queued" || r.status === "running";
      tr.innerHTML = `<td class="l"><b>${esc(r.subject_code)}</b>${r.dataset_split === "test"
          ? ' <span class="chip" title="Sujeto del test del proyecto">test</span>' : ""}${r.subset
          ? ' <span class="chip sub" title="Noche con canales faltantes">subconjunto</span>' : ""}</td>
        <td class="l" style="color:var(--muted);font-size:12.5px">${esc(r.file_name)}</td>
        <td class="l" style="color:var(--muted);white-space:nowrap">${UI.dShort(at)} · ${UI.dTime(at)}</td>
        <td class="l">${UI.chips(r.channels || [], cfg.channels)}</td>
        <td>${r.status === "done" ? fmtInt(r.n_epochs) : "—"}</td>
        <td>${rv ? `<b style="color:var(${rv.whole_night_recommended ? "--warn-text" : "--ink"})">${pct(rv.flagged_fraction, 0)}</b>` : "—"}</td>
        <td class="l">${UI.statusPill(r)}</td>
        <td style="text-align:right"><span class="actions">
          <button class="act del" title="Borrar registro" aria-label="Borrar registro" ${busy ? "disabled" : ""}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m5 5v6m4-6v6"/></svg>
          </button><span class="act" aria-hidden="true">→</span></span></td>`;
      // la fila se transforma en el encabezado de resultados (y su nombre ya se ve mientras carga)
      tr.onclick = () => MaiaReview.open(r.id, { shared: tr,
        label: r.night_label && r.night_label !== r.file_name ? `${r.night_label} · ${r.file_name}` : r.file_name });
      tr.querySelector(".del").onclick = e => { e.stopPropagation(); askDelete(r); };
      return tr;
    }));
  }

  async function refreshList() {
    clearTimeout(listTimer);
    if (!records.length) {
      $("cnt").textContent = "cargando…";
      $("tb").innerHTML = Array.from({ length: 4 }, () => `<tr>${Array.from({ length: 8 }, (_, i) =>
        `<td class="${i < 4 ? "l" : ""}"><span class="skel" style="width:${i === 1 ? 120 : 52}px">&nbsp;</span></td>`
      ).join("")}</tr>`).join("");
    }
    try {
      records = await MaiaAPI.listRecords();
      records.sort((a, b) => UI.parse(b.created_at) - UI.parse(a.created_at));
      renderTiles();
      renderTable();
      renderStrip();
    } catch (e) {
      $("cnt").textContent = e.message || "No se pudo cargar el listado.";
    }
    // mientras haya análisis en proceso, el listado se actualiza solo
    if (records.some(r => r.status === "queued" || r.status === "running") && !$("vList").classList.contains("hidden")) {
      listTimer = setTimeout(refreshList, 2500);
    }
  }

  async function askDelete(r) {
    const ok = await UI.confirm({
      title: "¿Borrar este registro?",
      html: `Se eliminará el análisis de <b>${esc(r.subject_code)}</b> (${esc(r.file_name)} · ` +
        `${UI.dShort(UI.parse(r.created_at))}), con sus decisiones, notas y bitácora. Esta acción no se puede deshacer.`,
      confirmLabel: "Borrar registro", danger: true
    });
    if (!ok) return;
    try {
      await MaiaAPI.deleteRecord(r.id);
      UI.toast("Registro borrado.");
      refreshList();
    } catch (e) {
      UI.toast(e.message || "No se pudo borrar el registro.", true);
    }
  }

  /* ══════════════ vista ANALIZAR: 1 · elegir la noche ══════════════ */
  const U = {
    source: null,          // {kind:"catalog", night} | {kind:"upload", upload}
    header: null,          // {labels, fs, duration_s, start_clock_s, patient}
    insp: null,            // canales del archivo según el servidor (channels.inspect)
    slots: {},             // entrada → {label, on}
    mode: "full",
    night: null,           // datos de Sleep-EDFx de la noche (apagado de luces, partición)
    uploading: null        // archivo que se está subiendo
  };
  const SLOT_ORDER = () => Object.keys(cfg.channels);
  const hasRef = () => !!(U.source && (U.source.kind === "catalog" ? U.source.night.has_hypnogram : U.source.upload.hypnogram));
  const keyFor = slots => {
    const s = new Set(slots);
    const eeg = s.has("fpz") && s.has("pz") ? "eeg2" : s.has("fpz") ? "fpz" : "pz";
    return eeg + (s.has("eog") ? "_eog" : "") + (s.has("emg") ? "_emg" : "");
  };
  const slotsFor = key => {
    const [eeg, ...rest] = key.split("_");
    return [...(eeg === "eeg2" ? ["fpz", "pz"] : [eeg]), ...rest];
  };
  const comboName = slots => SLOT_ORDER().filter(s => slots.includes(s)).map(s => cfg.channels[s].name).join(" + ");
  const toHM = s => clockHM(((s % 86400) + 86400) % 86400);
  const fromHM = v => { const [h, m] = v.split(":").map(Number); return h * 3600 + m * 60; };

  function showErr(el, msg) { el.textContent = msg; el.classList.add("show"); }
  function hideErr(el) { el.classList.remove("show"); }

  async function loadCatalog(refresh = false) {
    if (catalog && !refresh) return renderCatalog();
    $("catList").innerHTML = '<div class="catempty"><span class="spin"></span>Leyendo el catálogo…</div>';
    $("catRefresh").disabled = true;
    try {
      catalog = await MaiaAPI.listCatalog(refresh);
    } catch (e) {
      catalog = null;
      $("catList").innerHTML = `<div class="catempty">${esc(e.message)}<br>Puede subir su propio PSG más abajo.</div>`;
      $("catCount").textContent = "";
      return;
    } finally {
      $("catRefresh").disabled = false;
    }
    const src = catalog.source;
    $("catCap").innerHTML = src.kind === "s3"
      ? `Noches de prueba guardadas en <b>${esc(src.location)}</b>. Elija una para cargar sus canales; se descarga al analizarla.`
      : `Noches de prueba en el servidor (<b>${esc(src.location.split("/").slice(-2).join("/"))}</b>). Elija una para cargar sus canales.`;
    renderCatalog();
  }

  function nightText(n) {
    const who = [n.subject != null ? `sujeto ${String(n.subject).padStart(2, "0")}` : null,
                 n.night != null ? `noche ${n.night}` : null].filter(Boolean).join(", ");
    const pers = [UI.sexText(n.sex), n.age ? `${n.age} años` : null].filter(Boolean).join(", ");
    return { who, pers };
  }

  function renderCatalog() {
    if (!catalog) return;
    const q = catQuery;
    const list = catalog.nights.filter(n =>
      (catFilt === "all" || (catFilt === "test" && n.split === "test") || (catFilt === "subset" && n.subset)) &&
      (!q || [n.label, n.id, n.psg, nightText(n).who, n.split === "test" ? "test" : "desarrollo",
              n.subset ? "subconjunto canales faltantes" : "", n.available.map(s => cfg.channels[s].name + " " + s).join(" ")]
        .join(" ").toLowerCase().includes(q)));
    $("catCount").textContent = `${list.length} de ${catalog.nights.length} noche${catalog.nights.length === 1 ? "" : "s"}`;
    if (!list.length) {
      $("catList").innerHTML = `<div class="catempty">${catalog.nights.length
        ? "Ninguna noche coincide con la búsqueda." : "El catálogo está vacío."}</div>`;
      return;
    }
    const sel = U.source && U.source.kind === "catalog" ? U.source.night.id : null;
    $("catList").innerHTML = list.map(n => {
      const t = nightText(n);
      return `<button type="button" class="night" data-id="${esc(n.id)}" aria-pressed="${n.id === sel}">
        <span class="id">${esc(n.label)}</span>
        <span style="min-width:0"><span class="who">${esc(t.who || n.psg)}${t.pers ? ` · ${esc(t.pers)}` : ""}</span>
          <span class="mt">${UI.chips(n.available, cfg.channels)} <span>${fmtHM(n.header.duration_s)}</span>
          <span>${n.channels.total} canales en el archivo</span>${n.has_hypnogram ? "<span>· con hipnograma</span>" : ""}</span></span>
        <span class="tags">${n.subset ? '<span class="chip sub">canales faltantes</span>' : ""}${n.split === "test"
          ? '<span class="chip eeg">test</span>' : n.split === "dev" ? '<span class="chip">desarrollo</span>' : ""}</span>
      </button>`;
    }).join("");
    $("catList").querySelectorAll(".night").forEach(el => {
      el.onclick = () => pickNight(catalog.nights.find(n => n.id === el.dataset.id));
    });
  }

  function pickNight(n) {
    if (U.source && U.source.kind === "upload") clearUpload();
    U.source = { kind: "catalog", night: n };
    U.header = n.header;
    U.insp = n.channels;
    U.night = n.split ? n : null;
    renderCatalog();
    // la noche elegida se marca con un anillo azul que se desvanece
    const chosen = $("catList").querySelector('.night[aria-pressed="true"]');
    if (chosen) MaiaFX.ring(chosen, "--s1", 0, getComputedStyle(chosen).boxShadow, 1.01);
    configure();
    $("cfgPanel").scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
  }

  /* ── PSG propio (opción secundaria) ── */
  async function setFile(file, hypFile) {
    hideErr($("upErr"));
    if (!file) return;
    if (!/\.(edf|zip)$/i.test(file.name)) {
      return showErr($("upErr"), "Formato no aceptado: suba un PSG .edf (o un .zip con el PSG y su hipnograma).");
    }
    if (file.size > cfg.max_upload_mb * 1048576) {
      return showErr($("upErr"), `El archivo supera el límite de ${cfg.max_upload_mb} MB.`);
    }
    clearUpload();
    if (U.source && U.source.kind === "catalog") { U.source = null; renderCatalog(); configure(); }
    U.uploading = file;
    $("fileSel").classList.remove("hidden");
    $("fileSelName").textContent = file.name;
    $("fileSel").querySelector(".ic").textContent = /\.zip$/i.test(file.name) ? "ZIP" : "EDF";
    $("fileSelMeta").textContent = `${nf(file.size / 1048576)} MB · subiendo y revisando el archivo…`;
    $("upBar").classList.remove("hidden");
    $("upBar").firstElementChild.style.width = "0";
    $("fileSelRm").disabled = true;
    try {
      const up = await MaiaAPI.uploadPsg(file, hypFile, f => {
        $("upBar").firstElementChild.style.width = (100 * f).toFixed(1) + "%";
        if (f >= 1) $("fileSelMeta").textContent = `${nf(file.size / 1048576)} MB · el servidor está leyendo los canales…`;
      });
      if (U.uploading !== file) return;            // lo cambiaron mientras tanto
      U.uploading = null;
      U.source = { kind: "upload", upload: up };
      U.header = up.header;
      U.insp = up.channels;
      U.night = up.dataset;
      showUpload();
      configure();
      $("cfgPanel").scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
    } catch (e) {
      if (U.uploading !== file) return;
      U.uploading = null;
      $("fileSel").classList.add("hidden");
      $("fileInput").value = "";
      showErr($("upErr"), e.message || "No se pudo subir el archivo.");
    } finally {
      $("upBar").classList.add("hidden");
      $("fileSelRm").disabled = false;
    }
  }

  function showUpload() {
    const up = U.source.upload, h = up.header;
    const sex = UI.sexText(h.patient.sex);
    $("fileSelName").textContent = up.file_name;
    $("fileSelMeta").textContent = [
      `${nf(up.size_mb)} MB`, `${up.channels.total} canal${up.channels.total === 1 ? "" : "es"} · ${up.channels.usable} utilizable${up.channels.usable === 1 ? "" : "s"} por el modelo`,
      h.duration_s ? fmtHM(h.duration_s) + (h.start_clock_s != null ? ` desde las ${clockHM(h.start_clock_s)}` : "") : null,
      sex || h.patient.age ? [sex, h.patient.age ? h.patient.age + " años" : null].filter(Boolean).join(", ") : null
    ].filter(Boolean).join(" · ");
    const hyp = up.hypnogram;
    $("hypSel").classList.toggle("hidden", !hyp);
    $("btnAddHyp").classList.toggle("hidden", !!hyp);
    if (hyp) {
      $("hypSelName").textContent = hyp.name;
      $("hypSelMeta").textContent = "Hipnograma de referencia · sirve para comparar y para recortar la noche";
    }
  }

  async function setHyp(file) {
    hideErr($("upErr"));
    if (!file || !U.source || U.source.kind !== "upload") return;
    $("btnAddHyp").disabled = true;
    try {
      U.source.upload = await MaiaAPI.attachHypnogram(U.source.upload.id, file);
      showUpload();
      U.mode = "reference";
      renderWindow();
    } catch (e) {
      showErr($("upErr"), e.message || "No se pudo adjuntar el hipnograma.");
    } finally {
      $("btnAddHyp").disabled = false;
      $("hypInput").value = "";
    }
  }

  async function clearHyp() {
    if (!U.source || U.source.kind !== "upload") return;
    try {
      U.source.upload = await MaiaAPI.removeHypnogram(U.source.upload.id);
    } catch (e) { UI.toast(e.message, true); return; }
    showUpload();
    if (U.mode === "reference") U.mode = U.header.duration_s > 14 * 3600 ? "range" : "full";
    renderWindow();
  }

  /* quita el PSG subido (el servidor lo borra si todavía no se analizó) */
  function clearUpload() {
    U.uploading = null;
    if (U.source && U.source.kind === "upload") {
      MaiaAPI.deleteUpload(U.source.upload.id).catch(() => {});
      U.source = null;
      configure();
    }
    $("fileInput").value = "";
    $("hypInput").value = "";
    ["fileSel", "hypSel", "btnAddHyp"].forEach(id => $(id).classList.add("hidden"));
  }

  /* ══════════════ 2 · canales y 3 · ventana ══════════════ */
  function configure() {
    hideErr($("runErr"));
    if (!U.source) { $("cfgPanel").classList.add("hidden"); return; }
    $("cfgPanel").classList.remove("hidden");
    U.slots = {};
    SLOT_ORDER().forEach(s => {
      const label = U.insp.matched[s] || null;
      U.slots[s] = { label, on: !!label };
    });
    const n = U.night;
    const name = U.source.kind === "catalog" ? U.source.night.psg : U.source.upload.file_name;
    $("cfgSource").innerHTML = [
      `<b>${esc(name)}</b>`,
      U.source.kind === "catalog" && U.source.night.subset ? `noche con canales faltantes${UI.info("subset")}` : null,
      n && n.subject != null ? `sujeto ${n.subject}, noche ${n.night} de Sleep-EDFx (${n.split === "test"
        ? "test: el modelo no lo vio" : "desarrollo: el modelo se entrenó con él"})` : null
    ].filter(Boolean).join(" · ");
    const h = U.header;
    U.mode = hasRef() ? "reference" : (h.duration_s > 14 * 3600 ? "range" : "full");
    const lo = n && n.lights_off ? n.lights_off : "";
    $("lightsOff").value = lo;
    const start = lo ? fromHM(lo) : 22 * 3600;
    $("winStart").value = toHM(start);
    $("winEnd").value = toHM(start + 9 * 3600);
    renderChannels();
    renderWindow();
  }

  /* otra entrada (encendida) que ya usa esa etiqueta, o null */
  const usedBy = (label, except) => SLOT_ORDER().find(s => s !== except && U.slots[s].on && U.slots[s].label === label) || null;

  function renderChannels() {
    const h = U.header, insp = U.insp;
    $("chSummary").innerHTML = `<b>${insp.total} canal${insp.total === 1 ? "" : "es"} en el archivo</b> · ` +
      `${insp.usable} utilizable${insp.usable === 1 ? "" : "s"} por el modelo${UI.info("usable")}`;
    $("chGrid").innerHTML = SLOT_ORDER().map(slot => {
      const info = cfg.channels[slot], st = U.slots[slot], cands = insp.candidates[slot] || [];
      const avail = cands.length > 0;
      const fs = st.label ? h.fs[st.label] : null;
      const warns = [];
      if (st.label && st.label !== insp.matched[slot]) warns.push(`Asignado a mano: el modelo se entrenó con ${info.label}.`);
      if (slot === "emg" && fs > 1) warns.push("El modelo se entrenó con la envolvente del EMG a 1 Hz de Sleep-EDFx; un EMG crudo puede no ser comparable.");
      if (slot !== "emg" && fs && fs < 100) warns.push(`Frecuencia de ${nf(fs, 0)} Hz: el modelo se entrenó a 100 Hz.`);
      const opts = ['<option value="">— sin asignar —</option>'].concat(cands.map(l => {
        const other = usedBy(l, slot);
        return `<option value="${esc(l)}" ${l === st.label ? "selected" : ""} ${other ? "disabled" : ""}>${esc(l)}${
          other ? ` — en uso en ${esc(cfg.channels[other].name)}` : ""}</option>`;
      })).join("");
      return `<div class="chcard ${st.on ? "on" : ""} ${avail ? "" : "na"}" data-slot="${slot}">
        <label class="sw"><input type="checkbox" ${st.on ? "checked" : ""} ${avail ? "" : "disabled"}
          aria-label="Usar ${esc(info.label)}"><span></span></label>
        <div style="min-width:0">
          <div class="chname">${esc(info.label)} <span class="chip ${info.kind === "eeg" ? "eeg" : ""}">${info.kind.toUpperCase()}</span></div>
          ${avail ? `<div class="chsrc">Canal del archivo: <select aria-label="Canal del archivo para ${esc(info.label)}">${opts}</select>${
            fs ? ` · ${nf(fs, 0)} Hz` : ""}</div>`
            : `<div class="chsrc">El archivo no tiene ningún canal de ${info.kind.toUpperCase()}.</div>`}
          ${avail && !insp.matched[slot] ? `<div class="chsrc">El archivo no tiene ${esc(info.label)}; puede asignar a mano otro canal de ${info.kind.toUpperCase()}.</div>` : ""}
          ${warns.map(w => `<div class="chwarn">${esc(w)}</div>`).join("")}
        </div></div>`;
    }).join("");
    $("chGrid").querySelectorAll(".chcard").forEach(card => {
      const slot = card.dataset.slot, st = U.slots[slot];
      card.querySelector("input").onchange = e => {
        st.on = e.target.checked;
        if (st.on && (!st.label || usedBy(st.label, slot))) {       // asigna el primer canal libre de su tipo
          st.label = (U.insp.candidates[slot] || []).find(l => !usedBy(l, slot)) || null;
          if (!st.label) { st.on = false; UI.toast(`No queda un canal de ${cfg.channels[slot].kind.toUpperCase()} libre para ${cfg.channels[slot].name}.`); }
        }
        renderChannels();
        // se intentó encender una entrada sin canal libre (los demás ya están en uso): «no»
        if (e.target.checked && !st.on) MaiaFX.shake($("chGrid").querySelector(`.chcard[data-slot="${slot}"]`));
      };
      const sel = card.querySelector("select");
      if (sel) sel.onchange = e => {
        st.label = e.target.value || null;
        st.on = !!st.label;
        // una entrada apagada que tenía ese canal lo suelta
        SLOT_ORDER().forEach(s => { if (s !== slot && !U.slots[s].on && U.slots[s].label === st.label) U.slots[s].label = null; });
        renderChannels();
      };
    });
    const unused = insp.unused || [];
    $("unusedCh").classList.toggle("hidden", !unused.length);
    $("unusedCh").innerHTML = `<span class="lbl">En el archivo, no los usa el modelo${UI.info("unused")}</span>` +
      unused.map(l => `<span class="chip off">${esc(l)}</span>`).join("");
    updateCombo();
  }

  function selectedSlots() {
    return SLOT_ORDER().filter(s => U.slots[s] && U.slots[s].on && U.slots[s].label);
  }

  function expectedText(key) {
    const e = cfg.expected[key];
    if (!e) return "";
    return `Con esta combinación, el modelo del proyecto obtuvo en noches de prueba un F1 macro${UI.info("f1_macro")} de ` +
      `<b>${nf(e.test_mf1, 3)}</b> (intervalo ${nf(e.test_ci[0], 3)}–${nf(e.test_ci[1], 3)}) y una kappa de Cohen${UI.info("kappa")} ` +
      `de ${nf(e.test_kappa, 3)}, donde 1 es acuerdo perfecto con el experto.` +
      (e.test_mf1 < cfg.mf1_goal ? ` <span style="color:var(--warn-text)">Es de las combinaciones menos precisas: si el ` +
        "registro tiene Fpz-Cz o EOG, conviene agregarlos.</span>" : "");
  }

  /* la noche elegida: las barras de combinaciones vuelven a crecer al elegir otra */
  const sourceKey = () => !U.source ? "none"
    : U.source.kind === "catalog" ? "cat:" + U.source.night.id : "up:" + U.source.upload.id;

  function updateCombo() {
    if (!cfg || !U.source) return;
    const slots = selectedSlots();
    const names = Object.fromEntries(Object.keys(cfg.expected).map(k => [k, comboName(slotsFor(k))]));
    const hasEeg = slots.includes("fpz") || slots.includes("pz");
    if (!hasEeg) {
      $("comboName").textContent = "—";
      $("comboText").innerHTML = `<span style="color:var(--crit)">${slots.length ? "Seleccione al menos un EEG (Fpz-Cz o Pz-Oz): " +
        "el EOG y el EMG solo complementan al EEG." : "Seleccione al menos un canal."}</span>`;
      C.renderCombos($("c-combos"), cfg.expected, names, null, cfg.mf1_goal, { key: sourceKey() });
    } else {
      const key = keyFor(slots);
      $("comboName").textContent = comboName(slots);
      $("comboText").innerHTML = expectedText(key);
      C.renderCombos($("c-combos"), cfg.expected, names, key, cfg.mf1_goal, { key: sourceKey() });
    }
    validate();
  }

  function renderWindow() {
    const h = U.header;
    document.querySelectorAll("#winMode button").forEach(b => {
      const m = b.dataset.m;
      b.disabled = (m === "reference" && !hasRef()) || (m === "range" && h.start_clock_s == null);
      b.title = m === "reference" && !hasRef() ? "Necesita el hipnograma de referencia" : "";
      b.setAttribute("aria-pressed", String(m === U.mode));
    });
    document.querySelectorAll(".rangeOnly").forEach(el => el.classList.toggle("hidden", U.mode !== "range"));
    const span = h.start_clock_s != null && h.duration_s
      ? `el registro va de ${clockHM(h.start_clock_s)} a ${clockHM(h.start_clock_s + h.duration_s)}` : "";
    let txt = "";
    if (U.mode === "reference") {
      txt = "Desde 30 min antes del primer estadio de sueño del hipnograma hasta 30 min después del último: " +
        "el mismo recorte con que se entrenó y evaluó el modelo.";
    } else if (U.mode === "range") {
      let dur = "";
      if ($("winStart").value && $("winEnd").value) {
        let d = fromHM($("winEnd").value) - fromHM($("winStart").value);
        if (d <= 0) d += 86400;
        dur = ` ≈ ${fmtHM(d)} (${fmtInt(Math.floor(d / 30))} épocas).`;
      }
      txt = `Se analizan las épocas entre las dos horas${span ? ` (${span})` : ""}.${dur}`;
    } else {
      txt = h.duration_s ? `Se analizan las ${fmtHM(h.duration_s)} del archivo (${fmtInt(Math.floor(h.duration_s / 30))} épocas).` +
        (h.duration_s > 14 * 3600 ? " <b>Incluye la vigilia diurna</b>, que no forma parte de la noche con que se evaluó el modelo." : "")
        : "Se analiza el archivo completo.";
    }
    const loSrc = U.night && U.night.lights_off && $("lightsOff").value === U.night.lights_off ? " (del índice de Sleep-EDFx)" : "";
    $("winHelp").innerHTML = txt + "<br>El <b>apagado de luces</b>" + loSrc + " marca el inicio del tiempo en cama y de la " +
      "latencia de sueño; si se deja vacío, se toma el inicio de la ventana.";
    validate();
  }

  /* qué impide analizar (o null): se muestra junto al botón */
  function blocker() {
    if (!U.source) return "Elija una noche.";
    const slots = selectedSlots();
    if (!slots.length) return "Seleccione al menos un canal.";
    if (!(slots.includes("fpz") || slots.includes("pz"))) return "Seleccione al menos un EEG (Fpz-Cz o Pz-Oz).";
    const labels = slots.map(s => U.slots[s].label);
    if (new Set(labels).size < labels.length) return "Un mismo canal del archivo no puede ocupar dos entradas.";
    if (U.mode === "range" && !($("winStart").value && $("winEnd").value)) return "Indique la hora de inicio y la de fin.";
    return null;
  }

  function validate() {
    const why = blocker();
    $("btnRun").disabled = !!why || $("btnRun").dataset.busy === "1";
    $("runMsg").textContent = U.source ? (why || "") : "";
  }

  async function runAnalyze() {
    const btn = $("btnRun");
    hideErr($("runErr"));
    const channels = selectedSlots();
    const channelMap = {};
    channels.forEach(s => { if (U.slots[s].label !== U.insp.matched[s]) channelMap[s] = U.slots[s].label; });
    const source = U.source.kind === "catalog" ? { type: "catalog", id: U.source.night.id }
      : { type: "upload", id: U.source.upload.id };
    const label = U.source.kind === "catalog" ? U.source.night.label : U.source.upload.file_name;
    btn.dataset.busy = "1";
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>Enviando…';
    try {
      const r = await MaiaAPI.createAnalysis({
        source, channels, channelMap, windowMode: U.mode,
        startClock: U.mode === "range" ? $("winStart").value : null,
        endClock: U.mode === "range" ? $("winEnd").value : null,
        lightsOff: $("lightsOff").value || "none"
      });
      if (U.source && U.source.kind === "upload") {
        // la carga ya pertenece a un análisis: el formulario la suelta sin borrarla
        U.source = null; $("fileSel").classList.add("hidden"); $("hypSel").classList.add("hidden");
        $("btnAddHyp").classList.add("hidden"); $("fileInput").value = ""; configure();
      }
      MaiaReview.watch(r, `${label} · ${comboName(channels)}`);
    } catch (e) {
      showErr($("runErr"), e.message || "No se pudo iniciar el análisis.");
    } finally {
      btn.dataset.busy = "";
      btn.textContent = "Analizar →";
      validate();
    }
  }

  /* ══════════════ sesión ══════════════ */
  async function enterApp(user) {
    if (user) {
      $("userName").textContent = user.name || "Superusuario";
      $("userAv").textContent = user.initials || "SU";
    }
    try {
      cfg = await MaiaAPI.getConfig();
    } catch (e) {
      if (e.code === "unauthorized") return;
      cfg = null;
    }
    $("vLogin").classList.add("hidden");
    $("appHeader").classList.remove("hidden");
    if (!cfg) {
      go("vList");
      $("cnt").textContent = "No se pudo contactar la API. ¿Está corriendo el backend?";
      return;
    }
    UI.setRules(nf(cfg.confidence_threshold, 2), pct(cfg.night_review_fraction));
    MaiaReview.cfg = cfg;
    $("maxMb").textContent = cfg.max_upload_mb;
    $("nightLimit").textContent = pct(cfg.night_review_fraction);
    $("modelPill").textContent = `${cfg.model.name}${MaiaAPI.isMock() ? " · modo demo" : ""}`;
    $("modelPill").title = `Modelo que atiende los análisis: ${cfg.model.version} · umbral de confianza ${nf(cfg.confidence_threshold, 2)}`;
    go("vList");
  }

  function showLogin() {
    ["vList", "vUp", "vRes"].forEach(id => $(id).classList.add("hidden"));
    $("appHeader").classList.add("hidden");
    $("vLogin").classList.remove("hidden");
    MaiaReview.stopPolling();
    clearTimeout(listTimer);
    window.scrollTo({ top: 0 });
  }

  async function doLogin() {
    hideErr($("loginErr"));
    const btn = $("btnIn"), orig = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>Ingresando…';
    try {
      const user = await MaiaAPI.login($("usr").value.trim(), $("pwd").value);
      await enterApp(user);
    } catch (e) {
      showErr($("loginErr"), e.message || "No se pudo iniciar sesión.");
      MaiaFX.shake(document.querySelector("#vLogin .card"));
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  function doLogout() {
    MaiaAPI.clearSession();
    records = [];
    catalog = null;
    showLogin();
  }

  /* ══════════════ eventos ══════════════ */
  $("btnIn").onclick = doLogin;
  ["usr", "pwd"].forEach(id => $(id).addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); }));
  $("btnOut").onclick = doLogout;
  window.addEventListener("maia:unauthorized", showLogin);

  document.querySelector("nav").onclick = e => {
    const b = e.target.closest("button[data-v]");
    if (b) go(b.dataset.v);
  };
  $("btnNew").onclick = () => go("vUp");
  $("btnOther").onclick = () => go("vUp");
  $("backUp").onclick = () => go("vList");
  $("backRes").onclick = () => go("vList");
  $("btnExportAll").onclick = () => MaiaAPI.exportCorrections().catch(e => UI.toast(e.message, true));

  const chipFilter = (id, fn) => {
    $(id).onclick = e => {
      const b = e.target.closest("button");
      if (!b) return;
      [...e.currentTarget.children].forEach(c => c.setAttribute("aria-pressed", String(c === b)));
      fn(b.dataset.f);
    };
  };
  chipFilter("filt", f => { filt = f; renderTable(); });
  chipFilter("catFilt", f => { catFilt = f; renderCatalog(); });
  $("srch").addEventListener("input", e => { query = e.target.value.trim().toLowerCase(); renderTable(); });
  $("catSearch").addEventListener("input", e => { catQuery = e.target.value.trim().toLowerCase(); renderCatalog(); });
  $("catRefresh").onclick = () => loadCatalog(true);

  // PSG propio: clic, teclado y arrastre
  $("btnShowUpload").onclick = () => {
    const open = $("upArea").classList.toggle("hidden") === false;
    $("btnShowUpload").setAttribute("aria-expanded", String(open));
  };
  $("dz").onclick = () => $("fileInput").click();
  $("dz").onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("fileInput").click(); } };
  $("fileInput").addEventListener("change", e => setFile(e.target.files[0]));
  $("fileSelRm").onclick = () => clearUpload();
  $("btnAddHyp").onclick = () => $("hypInput").click();
  $("hypInput").addEventListener("change", e => setHyp(e.target.files[0]));
  $("hypSelRm").onclick = clearHyp;
  ["dragenter", "dragover"].forEach(ev => $("dz").addEventListener(ev, e => { e.preventDefault(); $("dz").classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => $("dz").addEventListener(ev, e => { e.preventDefault(); $("dz").classList.remove("over"); }));
  $("dz").addEventListener("drop", e => {
    const files = [...e.dataTransfer.files];
    const psg = files.find(f => !/hypno/i.test(f.name)) || files[0];
    const hyp = files.find(f => f !== psg && /\.edf$/i.test(f.name) && /hypno/i.test(f.name));
    setFile(psg, hyp);
  });

  // los gráficos se dibujan a la escala de su contenedor: al cambiar el ancho se redibujan
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!$("vList").classList.contains("hidden") && records.length) renderStrip();
      if (!$("vUp").classList.contains("hidden") && U.source) updateCombo();
      MaiaReview.rerender();
    }, 150);
  });

  $("winMode").onclick = e => {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    U.mode = b.dataset.m;
    renderWindow();
  };
  ["winStart", "winEnd", "lightsOff"].forEach(id => $(id).addEventListener("input", renderWindow));
  $("btnRun").onclick = runAnalyze;

  // subrayado que se desliza entre pestañas (navegación y vista clínica / desempeño)
  MaiaFX.tabInk(document.querySelector("nav"));
  MaiaFX.tabInk($("viewTabs"));
  // selectores segmentados (filtros, ventana, vista, tiempo, cola, matriz): la opción elegida se desliza
  document.querySelectorAll(".chipset, .seg").forEach(MaiaFX.segPill);

  window.MaiaApp = { go, refreshList };

  /* ══════════════ arranque ══════════════ */
  if (MaiaAPI.isLoggedIn()) enterApp(MaiaAPI.currentUser());
  else showLogin();
})();
