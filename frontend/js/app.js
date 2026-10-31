/* ════════════════════════════════════════════════════════════════════
   MAIA · lógica de la aplicación (sesión, navegación, registros y carga)
   La vista de resultados y revisión vive en js/review.js.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const { nf, pct, clockHM, fmtHM, fmtInt, median, esc } = MaiaUtil;
  const C = MaiaCharts, UI = MaiaUI, $ = UI.$;
  const CFG = window.MAIA_CONFIG;

  let cfg = null;              // reglas del modelo (GET /config)
  let records = [];
  let filt = "all";
  let query = "";
  let listTimer = null;
  let demos = null;
  let showAllDemos = false;

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

  /* ── navegación entre vistas ── */
  function go(v) {
    ["vList", "vUp", "vRes"].forEach(id => $(id).classList.toggle("hidden", id !== v));
    document.querySelectorAll("nav button").forEach(b =>
      b.setAttribute("aria-selected", String(b.dataset.v === v || (v === "vRes" && b.dataset.v === "vList"))));
    if (v !== "vRes") MaiaReview.stopPolling();
    if (v !== "vList") clearTimeout(listTimer);
    if (v === "vList") refreshList();
    if (v === "vUp") loadDemos();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  MaiaReview.init({ go, onChange: () => {} });

  /* ══════════════ vista REGISTROS ══════════════ */
  const done = () => records.filter(r => r.status === "done" && r.review);

  function renderTiles() {
    const ok = done();
    countUp($("tCount"), ok.length);
    const subjects = new Set(ok.map(r => r.subject_code)).size;
    const busy = records.filter(r => r.status === "queued" || r.status === "running").length;
    $("tCountN").textContent = `${subjects} sujeto${subjects === 1 ? "" : "s"} distintos` +
      (busy ? ` · ${busy} en proceso` : "");
    const todo = ok.filter(r => r.review.status !== "signed_off" && r.review.pending > 0);
    countUp($("tTodo"), todo.length);
    const pend = todo.reduce((a, r) => a + r.review.pending, 0);
    $("tTodoN").textContent = todo.length ? `${fmtInt(pend)} épocas pendientes` : "todo revisado";
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
        || (filt === "todo" && r.status === "done" && r.review && r.review.status !== "signed_off")
        || (filt === "whole" && r.review && r.review.whole_night_recommended)
        || (filt === "signed" && r.review && r.review.status === "signed_off"))
      .filter(r => !query || r.subject_code.toLowerCase().includes(query) || r.file_name.toLowerCase().includes(query));
    $("cnt").textContent = `${rows.length} registro${rows.length === 1 ? "" : "s"}`;
    if (!rows.length) {
      $("tb").innerHTML = `<tr><td class="l" colspan="8" style="color:var(--muted);cursor:default">${
        records.length ? "Ningún registro coincide con el filtro." : "Aún no hay análisis: use «Analizar nuevo»."}</td></tr>`;
      return;
    }
    $("tb").replaceChildren(...rows.map((r, i) => {
      const tr = document.createElement("tr");
      tr.className = "anim";
      tr.style.setProperty("--i", Math.min(i, 12));
      const at = UI.parse(r.created_at), rv = r.review;
      const busy = r.status === "queued" || r.status === "running";
      tr.innerHTML = `<td class="l"><b>${esc(r.subject_code)}</b>${r.dataset_split === "test"
          ? ' <span class="chip" title="Sujeto del test del proyecto">test</span>' : ""}</td>
        <td class="l" style="color:var(--muted);font-size:12px">${esc(r.file_name)}</td>
        <td class="l" style="color:var(--muted);white-space:nowrap">${UI.dShort(at)} · ${UI.dTime(at)}</td>
        <td class="l">${UI.chips(r.channels || [], cfg.channels)}</td>
        <td>${r.status === "done" ? fmtInt(r.n_epochs) : "—"}</td>
        <td>${rv ? `<b style="color:var(${rv.whole_night_recommended ? "--warn-text" : "--ink"})">${pct(rv.flagged_fraction, 0)}</b>` : "—"}</td>
        <td class="l">${UI.statusPill(r)}</td>
        <td style="text-align:right"><span class="actions">
          <button class="act del" title="Borrar registro" aria-label="Borrar registro" ${busy ? "disabled" : ""}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m5 5v6m4-6v6"/></svg>
          </button><span class="act">→</span></span></td>`;
      tr.onclick = () => MaiaReview.open(r.id);
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
      listTimer = setTimeout(refreshList, 3000);
    }
  }

  async function askDelete(r) {
    const ok = await UI.confirm({
      title: "¿Borrar este registro?",
      html: `Se eliminará el análisis de <b>${esc(r.subject_code)}</b> (${esc(r.file_name)} · ` +
        `${UI.dShort(UI.parse(r.created_at))}), con sus correcciones y su bitácora. Esta acción no se puede deshacer.`,
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

  /* ══════════════ vista ANALIZAR ══════════════ */
  const U = {
    source: null,          // {kind:"file", file, psgName} | {kind:"demo", demo}
    hyp: null,             // archivo de hipnograma aparte
    zipHyp: null,          // nombre del hipnograma dentro del .zip
    header: null,          // encabezado del PSG (puede faltar si el navegador no abre el .zip)
    detected: {},
    slots: {},             // modalidad → {label, on}
    mode: "full",
    night: null            // noche del índice de Sleep-EDFx, si corresponde
  };
  const hasRef = () => !!(U.hyp || U.zipHyp || (U.source && U.source.kind === "demo" && U.source.demo.has_hypnogram));

  function showErr(el, msg) { el.textContent = msg; el.classList.add("show"); }
  function hideErr(el) { el.classList.remove("show"); }

  const SLOT_ORDER = () => Object.keys(cfg.channels);
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

  async function loadDemos() {
    if (demos) return renderDemos();
    try {
      demos = await MaiaAPI.listDemos();
    } catch (e) {
      $("demoList").innerHTML = `<div class="mini">${esc(e.message)}</div>`;
      return;
    }
    renderDemos();
  }

  function renderDemos() {
    if (!demos.length) {
      $("demoList").innerHTML = '<div class="mini">No hay noches del dataset en el servidor ' +
        "(<code>backend/data/demo/download_demos.sh</code> las descarga).</div>";
      return;
    }
    const list = showAllDemos ? demos : demos.slice(0, 4);
    const sel = U.source && U.source.kind === "demo" ? U.source.demo.id : null;
    $("demoList").innerHTML = list.map(d => {
      const sex = UI.sexText(d.sex);
      const slots = SLOT_ORDER().filter(s => d.detected[s]);
      return `<div class="filerow demo ${d.id === sel ? "sel" : ""}" data-id="${d.id}" role="button" tabindex="0">
        <div class="ic">EDF</div>
        <div style="min-width:0"><div class="nm">${d.id} · sujeto ${String(d.subject).padStart(2, "0")}, noche ${d.night}
          ${d.split === "test" ? '<span class="chip eeg">test</span>' : '<span class="chip">desarrollo</span>'}</div>
          <div class="mt">${sex}, ${d.age} años · ${UI.chips(slots, cfg.channels)} · ${fmtHM(d.header.duration_s)}
          ${d.has_hypnogram ? "· con hipnograma" : ""}</div></div></div>`;
    }).join("") + (demos.length > 4 ? `<button class="linkbtn" id="btnAllDemos">${showAllDemos
      ? "Mostrar menos" : `Ver las ${demos.length} noches disponibles`}</button>` : "");
    $("demoList").querySelectorAll(".filerow.demo").forEach(el => {
      const pick = () => pickDemo(demos.find(d => d.id === el.dataset.id));
      el.onclick = pick;
      el.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } };
    });
    if ($("btnAllDemos")) $("btnAllDemos").onclick = () => { showAllDemos = !showAllDemos; renderDemos(); };
  }

  function pickDemo(d) {
    clearFile(false);
    U.source = { kind: "demo", demo: d };
    U.header = { labels: d.header.labels, fs: d.header.fs, durationS: d.header.duration_s,
                 startClockS: d.header.start_clock_s, patient: { age: d.age, sex: d.sex } };
    U.night = d;
    renderDemos();
    configure();
    $("cfgPanel").scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
  }

  async function setFile(file) {
    hideErr($("upErr"));
    if (!file) return;
    if (!/\.(edf|zip)$/i.test(file.name)) {
      return showErr($("upErr"), "Formato no aceptado: cargue un .edf o un .zip con el par PSG + hipnograma.");
    }
    if (file.size > cfg.max_upload_mb * 1048576) {
      return showErr($("upErr"), `El archivo supera el límite de ${cfg.max_upload_mb} MB.`);
    }
    const isZip = /\.zip$/i.test(file.name);
    let header = null, psgName = file.name, zipHyp = null;
    try {
      if (isZip) {
        const z = await MaiaEdf.readZip(file);
        if (!z) return showErr($("upErr"), "El .zip está dañado o no es un zip válido.");
        if (!z.psg) return showErr($("upErr"), "El .zip no contiene el PSG (.edf con la señal).");
        header = z.psg.header;
        psgName = z.psg.name;
        zipHyp = z.hypnogram ? z.hypnogram.name : null;
      } else {
        header = await MaiaEdf.readEdf(file);
        if (!header) return showErr($("upErr"), "El archivo no es un EDF válido (encabezado ilegible).");
      }
    } catch (e) { header = null; }
    if (header && header.annotationsOnly) {
      return showErr($("upErr"), "Ese archivo es solo el hipnograma (anotaciones, sin señal). Cargue primero el PSG " +
        "y luego agregue el hipnograma como referencia.");
    }
    demoDeselect();
    U.source = { kind: "file", file, psgName };
    U.header = header;
    U.zipHyp = zipHyp;
    U.hyp = null;
    U.night = null;
    try { U.night = await MaiaAPI.lookupNight(psgName); } catch (e) { /* sin índice */ }
    if (U.source.file !== file) return;              // cambiaron de archivo mientras tanto
    const mb = nf(file.size / 1048576) + " MB";
    $("fileSelName").textContent = isZip ? `${file.name} → ${psgName}` : file.name;
    $("fileSel").querySelector(".ic").textContent = isZip ? "ZIP" : "EDF";
    const sex = header ? UI.sexText(header.patient.sex) : null;
    $("fileSelMeta").textContent = [
      mb,
      header ? `${header.nChannels} canales` : "encabezado no legible en el navegador (se verificará al subir)",
      header && header.durationS ? fmtHM(header.durationS) + (header.startClockS != null ? ` desde las ${clockHM(header.startClockS)}` : "") : null,
      header && (sex || header.patient.age) ? [sex, header.patient.age ? header.patient.age + " años" : null].filter(Boolean).join(", ") : null,
      zipHyp ? "incluye hipnograma" : null
    ].filter(Boolean).join(" · ");
    $("fileSel").classList.remove("hidden");
    $("btnAddHyp").classList.toggle("hidden", !!zipHyp);
    $("hypSel").classList.add("hidden");
    configure();
  }

  async function setHyp(file) {
    hideErr($("upErr"));
    if (!file) return;
    if (!/\.edf$/i.test(file.name)) return showErr($("upErr"), "El hipnograma debe ser un .edf (EDF+ con anotaciones).");
    const h = await MaiaEdf.readEdf(file).catch(() => null);
    if (!h || !h.annotationsOnly) {
      return showErr($("upErr"), "Ese archivo no parece un hipnograma: debe ser un EDF+ que solo trae anotaciones de estadios.");
    }
    U.hyp = file;
    $("hypSelName").textContent = file.name;
    $("hypSelMeta").textContent = "Hipnograma de referencia · se usa para la concordancia y la ventana de sueño";
    $("hypSel").classList.remove("hidden");
    $("btnAddHyp").classList.add("hidden");
    configure();
  }

  function clearHyp() {
    U.hyp = null;
    $("hypInput").value = "";
    $("hypSel").classList.add("hidden");
    $("btnAddHyp").classList.toggle("hidden", !(U.source && U.source.kind === "file"));
    configure();
  }

  function demoDeselect() {
    if (U.source && U.source.kind === "demo") { U.source = null; renderDemos(); }
  }

  function clearFile(reconfigure = true) {
    if (U.source && U.source.kind === "file") U.source = null;
    U.hyp = null; U.zipHyp = null;
    $("fileInput").value = "";
    $("hypInput").value = "";
    ["fileSel", "hypSel", "btnAddHyp"].forEach(id => $(id).classList.add("hidden"));
    if (reconfigure) configure();
  }

  /* ── paso 2 y 3: canales y ventana ── */
  function configure() {
    hideErr($("runErr"));
    if (!U.source) { $("cfgPanel").classList.add("hidden"); return; }
    $("cfgPanel").classList.remove("hidden");
    const h = U.header;
    U.detected = h ? MaiaEdf.detect(h.labels, cfg.channel_aliases) : {};
    U.slots = {};
    SLOT_ORDER().forEach(s => {
      const label = h ? U.detected[s] || null : s;    // sin encabezado: la API verificará
      U.slots[s] = { label, on: !!label };
    });
    const src = U.source.kind === "demo" ? U.source.demo.psg : U.source.psgName;
    const n = U.night;
    $("cfgSource").innerHTML = [
      `<b>${esc(src)}</b>`,
      h ? `${h.labels.length} canales en el archivo` : null,
      n ? `sujeto ${n.subject}, noche ${n.night} de Sleep-EDFx (${n.split === "test"
        ? "test: el modelo no lo vio" : "desarrollo: el modelo se entrenó con él"})` : null
    ].filter(Boolean).join(" · ");

    U.mode = hasRef() ? "reference" : (h && h.durationS > 14 * 3600 ? "range" : "full");
    const lo = n && n.lights_off ? n.lights_off : "";
    $("lightsOff").value = lo;
    const start = lo ? fromHM(lo) : 22 * 3600;
    $("winStart").value = toHM(start);
    $("winEnd").value = toHM(start + 9 * 3600);
    renderChannels();
    renderWindow();
  }

  function renderChannels() {
    const h = U.header;
    const labels = h ? h.labels.filter(l => l !== "EDF Annotations") : [];
    $("chGrid").innerHTML = SLOT_ORDER().map(slot => {
      const info = cfg.channels[slot], st = U.slots[slot], avail = !!st.label;
      const fs = avail && h ? h.fs[st.label] : null;
      const warns = [];
      if (avail && h && st.label !== U.detected[slot]) warns.push(`Asignado a mano: el modelo se entrenó con ${info.label}.`);
      if (slot === "emg" && fs > 1) warns.push("El modelo se entrenó con la envolvente del EMG a 1 Hz de Sleep-EDFx; un EMG crudo puede no ser comparable.");
      if (slot !== "emg" && fs && fs < 100) warns.push(`Frecuencia de ${nf(fs, 0)} Hz: el modelo se entrenó a 100 Hz.`);
      const opts = ['<option value="">— sin asignar —</option>']
        .concat(labels.map(l => `<option value="${esc(l)}" ${l === st.label ? "selected" : ""}>${esc(l)}</option>`)).join("");
      return `<div class="chcard ${st.on ? "on" : ""} ${avail ? "" : "na"}" data-slot="${slot}">
        <label class="sw"><input type="checkbox" ${st.on ? "checked" : ""} ${avail ? "" : "disabled"}
          aria-label="Usar ${esc(info.label)}"><span></span></label>
        <div style="min-width:0">
          <div class="chname">${esc(info.label)} <span class="chip ${info.kind === "eeg" ? "eeg" : ""}">${info.kind.toUpperCase()}</span></div>
          <div class="chsrc">${h ? `Canal del archivo: <select aria-label="Canal del archivo para ${esc(info.label)}">${opts}</select>`
            : "Se verificará al subir el archivo"}${fs ? ` · ${nf(fs, 0)} Hz` : ""}</div>
          ${!avail && h ? '<div class="chwarn">No se encontró en el archivo. Puede asignarle un canal a mano.</div>' : ""}
          ${warns.map(w => `<div class="chwarn">${esc(w)}</div>`).join("")}
        </div></div>`;
    }).join("");
    $("chGrid").querySelectorAll(".chcard").forEach(card => {
      const slot = card.dataset.slot, st = U.slots[slot];
      card.querySelector("input").onchange = e => { st.on = e.target.checked; renderChannels(); };
      const sel = card.querySelector("select");
      if (sel) sel.onchange = e => { st.label = e.target.value || null; st.on = !!st.label; renderChannels(); };
    });
    const used = new Set(Object.values(U.slots).filter(s => s.label).map(s => s.label));
    const other = labels.filter(l => !used.has(l));
    $("otherCh").textContent = other.length ? `Otros canales del archivo, que el modelo no usa: ${other.join(", ")}.` : "";
    updateCombo();
  }

  function selectedSlots() {
    return SLOT_ORDER().filter(s => U.slots[s] && U.slots[s].on && U.slots[s].label);
  }

  function updateCombo() {
    if (!cfg || !U.source) return;
    const slots = selectedSlots();
    const names = Object.fromEntries(Object.keys(cfg.expected).map(k => [k, comboName(slotsFor(k))]));
    const hasEeg = slots.includes("fpz") || slots.includes("pz");
    if (!hasEeg) {
      $("comboName").textContent = "—";
      $("comboText").innerHTML = '<span style="color:var(--crit)">Seleccione al menos un EEG (Fpz-Cz o Pz-Oz): ' +
        "el EOG y el EMG solo complementan al EEG.</span>";
      C.renderCombos($("c-combos"), cfg.expected, names, null, cfg.mf1_goal);
    } else {
      const key = keyFor(slots), e = cfg.expected[key];
      $("comboName").textContent = comboName(slots);
      $("comboText").innerHTML = `Con esta combinación, el modelo del proyecto obtuvo en el test MF1 ` +
        `<b>${nf(e.test_mf1, 3)}</b> [${nf(e.test_ci[0], 3)}; ${nf(e.test_ci[1], 3)}] y κ ${nf(e.test_kappa, 3)}.` +
        (e.test_mf1 < cfg.mf1_goal ? ` <span style="color:var(--warn-text)">Queda bajo la meta de MF1 ` +
          `${nf(cfg.mf1_goal, 2)}: si el registro tiene Fpz-Cz o EOG, conviene agregarlos.</span>` : "");
      C.renderCombos($("c-combos"), cfg.expected, names, key, cfg.mf1_goal);
    }
    validate();
  }

  function renderWindow() {
    const h = U.header;
    document.querySelectorAll("#winMode button").forEach(b => {
      const m = b.dataset.m;
      b.disabled = (m === "reference" && !hasRef()) || (m === "range" && h && h.startClockS == null);
      b.title = m === "reference" && !hasRef() ? "Necesita el hipnograma de referencia" : "";
      b.setAttribute("aria-pressed", String(m === U.mode));
    });
    document.querySelectorAll(".rangeOnly").forEach(el => el.classList.toggle("hidden", U.mode !== "range"));
    const span = h && h.startClockS != null && h.durationS
      ? `el registro va de ${clockHM(h.startClockS)} a ${clockHM(h.startClockS + h.durationS)}` : "";
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
      txt = h && h.durationS ? `Se analizan las ${fmtHM(h.durationS)} del archivo (${fmtInt(Math.floor(h.durationS / 30))} épocas).` +
        (h.durationS > 14 * 3600 ? " <b>Incluye la vigilia diurna</b>, que no forma parte de la ventana con que se evaluó el modelo." : "")
        : "Se analiza el archivo completo.";
    }
    const loSrc = U.night && $("lightsOff").value === U.night.lights_off ? " (del índice de Sleep-EDFx)" : "";
    $("winHelp").innerHTML = txt + "<br>El <b>apagado de luces</b>" + loSrc + " alimenta la hora de la noche (un rasgo " +
      "del modelo) y la latencia de sueño; si se deja vacío, se toma el inicio de la ventana.";
    validate();
  }

  function validate() {
    const slots = selectedSlots();
    const ok = !!U.source && (slots.includes("fpz") || slots.includes("pz"))
      && (U.mode !== "range" || ($("winStart").value && $("winEnd").value));
    $("btnRun").disabled = !ok;
  }

  async function runAnalyze() {
    const btn = $("btnRun"), original = btn.textContent;
    hideErr($("runErr"));
    const channels = selectedSlots();
    const channelMap = {};
    if (U.header) channels.forEach(s => { if (U.slots[s].label !== U.detected[s]) channelMap[s] = U.slots[s].label; });
    const payload = {
      channels, channelMap, windowMode: U.mode,
      startClock: U.mode === "range" ? $("winStart").value : null,
      endClock: U.mode === "range" ? $("winEnd").value : null,
      lightsOff: $("lightsOff").value || "none"
    };
    btn.disabled = true;
    btn.innerHTML = `<span class="spin"></span>${U.source.kind === "file" ? "Subiendo el registro…" : "Enviando…"}`;
    try {
      const r = U.source.kind === "demo"
        ? await MaiaAPI.createDemoAnalysis({ demoId: U.source.demo.id, ...payload })
        : await MaiaAPI.createAnalysis({ file: U.source.file, hypnogram: U.hyp, ...payload });
      clearFile(false);
      U.source = null;
      $("cfgPanel").classList.add("hidden");
      if (demos) renderDemos();
      MaiaReview.open(r.id);
    } catch (e) {
      showErr($("runErr"), e.message || "No se pudo iniciar el análisis.");
    } finally {
      btn.textContent = original;
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
    MaiaReview.cfg = cfg;
    $("maxMb").textContent = cfg.max_upload_mb;
    $("nightLimit").textContent = pct(cfg.night_review_fraction);
    const kind = { provisional: "provisional", mock: "simulado", sagemaker: "SageMaker" }[cfg.model.kind] || cfg.model.kind;
    $("modelPill").textContent = `Modelo ${kind}${MaiaAPI.isMock() ? " · modo demo" : ""}`;
    $("modelPill").title = `Modelo que atiende los análisis: ${cfg.model.version}`;
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
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  function doLogout() {
    MaiaAPI.clearSession();
    records = [];
    demos = null;
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

  $("filt").onclick = e => {
    const b = e.target.closest("button");
    if (!b) return;
    [...e.currentTarget.children].forEach(c => c.setAttribute("aria-pressed", String(c === b)));
    filt = b.dataset.f;
    renderTable();
  };
  $("srch").addEventListener("input", e => { query = e.target.value.trim().toLowerCase(); renderTable(); });

  // carga: clic, teclado y arrastre
  $("dz").onclick = () => $("fileInput").click();
  $("dz").onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("fileInput").click(); } };
  $("fileInput").addEventListener("change", e => setFile(e.target.files[0]));
  $("fileSelRm").onclick = () => clearFile();
  $("btnAddHyp").onclick = () => $("hypInput").click();
  $("hypInput").addEventListener("change", e => setHyp(e.target.files[0]));
  $("hypSelRm").onclick = clearHyp;
  ["dragenter", "dragover"].forEach(ev => $("dz").addEventListener(ev, e => { e.preventDefault(); $("dz").classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => $("dz").addEventListener(ev, e => { e.preventDefault(); $("dz").classList.remove("over"); }));
  $("dz").addEventListener("drop", e => {
    const files = [...e.dataTransfer.files];
    const psg = files.find(f => !/hypno/i.test(f.name)) || files[0];
    const hyp = files.find(f => f !== psg && /\.edf$/i.test(f.name));
    setFile(psg).then(() => { if (hyp && U.source && U.source.kind === "file") setHyp(hyp); });
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

  /* ══════════════ arranque ══════════════ */
  if (MaiaAPI.isLoggedIn()) enterApp(MaiaAPI.currentUser());
  else showLogin();
})();
