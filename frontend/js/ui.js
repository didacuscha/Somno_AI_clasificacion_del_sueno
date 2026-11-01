/* ════════════════════════════════════════════════════════════════════
   MAIA · piezas de interfaz compartidas por las vistas
   (glosario con explicaciones, aviso flotante, confirmación modal,
    pasos del análisis, fechas y etiquetas)
   ════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const { esc } = MaiaUtil;
  const STG = MaiaCharts.STG;
  const $ = id => document.getElementById(id);

  /* ── glosario: una frase en lenguaje llano por término técnico (US-17) ──
     {thr} y {night} se reemplazan con las reglas que entrega la API. */
  const GLOSSARY = {
    epoch: ["Época", "Fragmento de 30 segundos del registro; a cada época se le asigna un estadio de sueño."],
    hypnogram: ["Hipnograma", "Gráfico del estadio de sueño (W, N1, N2, N3, REM) a lo largo de la noche, época por época."],
    final: ["Hipnograma final", "Los estadios del modelo con las decisiones del revisor encima: donde un especialista confirmó o corrigió, manda su decisión."],
    confidence: ["Confianza", "Probabilidad que el modelo le da al estadio que eligió: cuanto más alta, más seguro está."],
    threshold: ["Umbral de confianza", "Si la confianza de una época queda por debajo de {thr}, la época se marca para que un especialista la revise."],
    flagged: ["Épocas marcadas", "Épocas en las que el modelo no está seguro (confianza bajo {thr}) y que conviene que revise un especialista."],
    to_review: ["Por revisar", "Noches analizadas con épocas marcadas que nadie ha revisado todavía."],
    full_review: ["Revisión completa sugerida", "Si el modelo marca más del {night} de la noche, se recomienda revisarla entera y no solo las épocas marcadas."],
    delivered: ["Entregado sin revisión", "Porcentaje de épocas en que el modelo superó el umbral de confianza y que se pueden entregar sin revisión."],
    top2: ["Dos opciones más probables", "Los dos estadios a los que el modelo les da más probabilidad en esta época; cuando duda, el correcto suele ser uno de ellos."],
    context: ["Épocas vecinas", "Estadio de la época anterior y de la siguiente: ayuda a juzgar si la transición tiene sentido."],
    evidence: ["Evidencia de la señal", "Cómo se reparte la potencia del EEG por bandas de frecuencia en esta época, comparada con las épocas típicas de cada estadio en esta misma noche."],
    band_delta: ["Delta (0,5–4 Hz)", "Ondas lentas; predominan en el sueño profundo (N3)."],
    band_theta: ["Theta (4–8 Hz)", "Actividad típica de N1 y de REM."],
    band_alpha: ["Alfa (8–12 Hz)", "Ritmo de la vigilia relajada con los ojos cerrados."],
    band_sigma: ["Sigma (12–15 Hz)", "Banda de los husos de sueño, típicos de N2."],
    band_beta: ["Beta (15–30 Hz)", "Actividad rápida de la vigilia activa y de los microdespertares."],
    amplitude: ["Amplitud", "Altura con que se dibujan los trazos. «Ampliar» agranda las ondas; el valor en µV es lo que ocupa media fila."],
    window: ["Ventana de análisis", "Parte del registro que se envía al modelo: normalmente la noche, con las luces apagadas, sin la vigilia diurna."],
    lights_off: ["Apagado de luces", "Hora en que se apagaron las luces. Marca el inicio del tiempo en cama y de la latencia de sueño."],
    combination: ["Combinación de canales", "Las señales que recibe el modelo. Siempre lleva al menos un EEG; el EOG y el EMG lo complementan."],
    usable: ["Canales que usa el modelo", "El modelo tiene cuatro entradas: EEG Fpz-Cz, EEG Pz-Oz, EOG y EMG. Solo un canal del mismo tipo puede ir en cada una."],
    unused: ["No los usa el modelo", "Están en el archivo pero el modelo no los recibe (respiración, temperatura, marcadores…). No se pueden asignar a una entrada."],
    reference: ["Hipnograma de referencia", "Estadificación hecha a mano por un experto para esta misma noche. Sirve para medir cuánto acierta el modelo."],
    tib: ["Tiempo en cama", "Desde el apagado de luces (o el inicio de la ventana) hasta el final de la ventana analizada."],
    tst: ["Sueño total", "Minutos en N1, N2, N3 o REM dentro del tiempo en cama."],
    efficiency: ["Eficiencia del sueño", "Sueño total dividido por el tiempo en cama."],
    sol: ["Latencia de sueño", "Minutos desde el apagado de luces hasta la primera época de sueño."],
    rem_latency: ["Latencia REM", "Minutos desde que se durmió hasta la primera época de REM."],
    waso: ["Vigilia después de dormirse", "Minutos despierto entre la primera y la última época de sueño (WASO, por su sigla en inglés)."],
    awakenings: ["Despertares", "Veces que la persona estuvo despierta al menos 1 minuto seguido después de dormirse."],
    stage_pct: ["Porcentaje por estadio", "N1, N2, N3 y REM como porcentaje del sueño total; la vigilia, como porcentaje del tiempo en cama."],
    expected: ["Desempeño esperado", "Lo que obtuvo el modelo del proyecto con esta combinación en noches de prueba que nunca vio al entrenar."],
    f1_macro: ["F1 macro", "Promedio del acierto (F1) en los cinco estadios, de 0 a 1: le da el mismo peso a los estadios frecuentes y a los raros."],
    kappa: ["Kappa de Cohen", "Acuerdo entre el modelo y el experto descontando el que se daría por azar: 1 es acuerdo perfecto y 0, azar."],
    accuracy: ["Exactitud", "Porcentaje de épocas en que el modelo y el experto pusieron el mismo estadio."],
    f1: ["F1 por estadio", "Acierto en cada estadio, de 0 a 1: combina cuántas épocas de ese estadio encuentra el modelo y cuántas acierta."],
    confusion: ["Matriz de confusión", "Cruza el estadio del experto (filas) con el del modelo (columnas): la diagonal son los aciertos."],
    model_version: ["Versión del modelo", "Qué versión del modelo estadificó esta noche. Queda guardada con la noche aunque el modelo cambie."],
    audit: ["Bitácora", "Registro de cada cambio: quién, cuándo, qué hizo y el valor anterior y el nuevo. No se puede borrar."],
    subset: ["Noche con canales faltantes", "Copia de una noche de prueba a la que se le quitaron algunos canales del modelo, para ver cómo funciona sin todas las señales."],
    test_split: ["Noche del test", "Noche de un sujeto que el modelo del proyecto nunca vio al entrenar: mide su desempeño real."]
  };
  let rules = { thr: "0,65", night: "27,3 %" };
  const gloss = key => {
    const g = GLOSSARY[key];
    return g ? [g[0], g[1].replace("{thr}", rules.thr).replace("{night}", rules.night)] : null;
  };

  /* botón ⓘ con la explicación (se muestra al pasar el mouse, al enfocarlo con el teclado o al tocarlo) */
  function info(key) {
    const g = gloss(key);
    return g ? `<button type="button" class="info" data-g="${key}" aria-label="Qué significa: ${esc(g[0])}" aria-expanded="false">i</button>` : "";
  }
  /* los <span data-info="clave"> del HTML se vuelven botones ⓘ */
  function hydrate(root = document) {
    root.querySelectorAll("[data-info]").forEach(el => { el.outerHTML = info(el.dataset.info); });
  }

  let tipEl = null, tipFor = null, pinned = false;
  function showGloss(btn) {
    const g = gloss(btn.dataset.g);
    if (!g) return;
    if (!tipEl) {
      tipEl = Object.assign(document.body.appendChild(document.createElement("div")),
        { className: "gloss", id: "glossTip" });
      tipEl.setAttribute("role", "tooltip");
    }
    if (tipFor && tipFor !== btn) tipFor.setAttribute("aria-expanded", "false");
    tipFor = btn;
    tipEl.innerHTML = `<b>${esc(g[0])}</b>${esc(g[1])}`;
    btn.setAttribute("aria-expanded", "true");
    btn.setAttribute("aria-describedby", "glossTip");
    const r = btn.getBoundingClientRect(), w = Math.min(300, innerWidth - 24);
    tipEl.style.maxWidth = w + "px";
    tipEl.classList.add("on");
    const h = tipEl.offsetHeight;
    let x = Math.max(12, Math.min(innerWidth - w - 12, r.left + r.width / 2 - w / 2));
    let y = r.bottom + 8;
    if (y + h > innerHeight - 8) y = r.top - h - 8;
    tipEl.style.left = x + "px";
    tipEl.style.top = Math.max(8, y) + "px";
  }
  function hideGloss() {
    if (tipEl) tipEl.classList.remove("on");
    if (tipFor) { tipFor.setAttribute("aria-expanded", "false"); tipFor.removeAttribute("aria-describedby"); }
    tipFor = null;
    pinned = false;
  }
  document.addEventListener("mouseover", e => {
    const b = e.target.closest && e.target.closest(".info");
    if (b && !pinned) showGloss(b);
  });
  document.addEventListener("mouseout", e => {
    const b = e.target.closest && e.target.closest(".info");
    if (b && !pinned && !b.contains(e.relatedTarget)) hideGloss();
  });
  document.addEventListener("focusin", e => { if (e.target.classList && e.target.classList.contains("info")) showGloss(e.target); });
  document.addEventListener("focusout", e => { if (e.target.classList && e.target.classList.contains("info")) hideGloss(); });
  document.addEventListener("click", e => {
    const b = e.target.closest && e.target.closest(".info");
    if (b) {
      e.preventDefault();
      e.stopPropagation();
      if (pinned && tipFor === b) hideGloss(); else { showGloss(b); pinned = true; }
    } else if (pinned) hideGloss();
  }, true);
  window.addEventListener("scroll", () => { if (tipFor) hideGloss(); }, { passive: true });

  /* ── aviso flotante ── */
  let toastTimer = null;
  function toast(msg, isErr = false) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.toggle("err", isErr);
    el.classList.add("on");
    el.classList.remove("shake");                    // los avisos de error se sacuden (cada vez)
    if (isErr) { void el.offsetWidth; el.classList.add("shake"); }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("on"), isErr ? 5500 : 2600);
  }

  /* ── diálogos: abrir con el foco dentro, cerrar con Escape y devolver el foco ── */
  const openDialogs = [];
  function openDialog(id, { onClose, focus } = {}) {
    const el = $(id);
    openDialogs.push({ id, onClose, back: document.activeElement });
    el.classList.remove("hidden");
    const target = focus ? $(focus) : el.querySelector("button:not([disabled]), [tabindex]");
    if (target) target.focus();
  }
  function closeDialog(id, reason) {
    const i = openDialogs.findIndex(d => d.id === id);
    if (i < 0) return;
    const d = openDialogs.splice(i, 1)[0];
    $(id).classList.add("hidden");
    if (d.back && document.contains(d.back)) d.back.focus();
    if (d.onClose) d.onClose(reason);
  }
  /* Escape cierra primero la explicación abierta y, si no hay, el diálogo de encima */
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (tipFor) { hideGloss(); return; }
    if (openDialogs.length) closeDialog(openDialogs[openDialogs.length - 1].id, "escape");
  });
  ["modal", "finModal"].forEach(id => $(id).addEventListener("click", e => { if (e.target.id === id) closeDialog(id, "backdrop"); }));
  const modalOpen = () => openDialogs.length > 0;

  /* ── confirmación modal → Promise<boolean> ── */
  function confirm({ title, html, confirmLabel, danger = false }) {
    $("mTitle").textContent = title;
    $("mText").innerHTML = html;
    $("mConfirm").textContent = confirmLabel;
    $("mConfirm").classList.toggle("danger", danger);
    return new Promise(res => {
      let answer = false;
      $("mCancel").onclick = () => closeDialog("modal");
      $("mConfirm").onclick = () => { answer = true; closeDialog("modal"); };
      openDialog("modal", { focus: "mCancel", onClose: () => res(answer) });
    });
  }

  /* ── pasos del análisis (US-20) ── */
  /* ✓ y ✕ como trazos SVG: se pueden «dibujar» cuando el paso acaba de terminar */
  const MARK = {
    done: '<svg viewBox="0 0 12 12" width="12" height="12"><path pathLength="1" d="M2.4 6.4l2.4 2.4 4.8-5.1"/></svg>',
    failed: '<svg viewBox="0 0 12 12" width="12" height="12"><path pathLength="1" d="M3.2 3.2l5.6 5.6M8.8 3.2l-5.6 5.6"/></svg>'
  };
  function steps(el, progress, labels) {
    const list = (progress && progress.steps && progress.steps.length) ? progress.steps
      : (labels || []).map(s => ({ ...s, status: "pending" }));
    const state = { done: "listo", failed: "falló", running: "en curso", pending: "pendiente" };
    // la lista se redibuja en cada consulta: solo se anima el paso que CAMBIÓ a listo o falló
    const prev = el._st || null;
    let j = 0;
    const just = list.map((s, k) => (prev && prev[k] !== s.status && (s.status === "done" || s.status === "failed")) ? j++ : -1);
    el._st = list.map(s => s.status);
    el.innerHTML = list.map((s, k) => `<li class="${s.status}${just[k] >= 0 ? " just" : ""}"${just[k] >= 0 ? ` style="--j:${just[k]}"` : ""}>
      <span class="dot" aria-hidden="true">${MARK[s.status] || ""}</span>
      <span class="tx"><b>${esc(s.label)}<span class="hidden"> · ${state[s.status] || s.status}</span></b>${s.message ? `<span>${esc(s.message)}</span>` : ""}</span>
      <span class="sec">${s.status === "done" && s.seconds != null ? `${MaiaUtil.nf(s.seconds, 1)} s` : ""}</span></li>`).join("");
  }

  /* ── fechas ── */
  const MES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const parse = iso => new Date(iso);
  const dShort = d => `${d.getDate()} ${MES[d.getMonth()]} ${d.getFullYear()}`;
  const dTime = d => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const dLong = new Intl.DateTimeFormat("es-CO", { day: "numeric", month: "long", year: "numeric" });

  /* ── etiquetas ── */
  const stage = st => st == null || st < 0
    ? '<span class="st" style="background:var(--surface-3);color:var(--muted)">—</span>'
    : `<span class="st" style="background:${STG[st].c}">${STG[st].k}</span>`;

  function chips(slots, channels) {
    return `<span class="chips">${slots.map(s => {
      const c = channels[s] || { name: s, kind: "" };
      return `<span class="chip ${c.kind === "eeg" ? "eeg" : ""}">${esc(c.name)}</span>`;
    }).join("")}</span>`;
  }

  /* estado de la noche */
  const STATUS_TXT = {
    to_review: "Por revisar", full_review_suggested: "Revisión completa sugerida",
    in_review: "En revisión", finalized: "Finalizada"
  };
  function statusPill(r) {
    if (r.status === "queued") return '<span class="pill run"><span class="spin" style="width:9px;height:9px;margin-right:2px"></span>En cola</span>';
    if (r.status === "running") {
      const cur = r.progress && r.progress.steps ? r.progress.steps.find(s => s.status === "running") : null;
      return `<span class="pill run"><span class="spin" style="width:9px;height:9px;margin-right:2px"></span>${cur ? esc(cur.label) : "En proceso"}</span>`;
    }
    if (r.status === "failed") return `<span class="pill x" title="${esc(r.error || "")}">Falló</span>`;
    const rv = r.review || {};
    if (rv.status === "finalized" || rv.status === "signed_off") return '<span class="pill ok">Finalizada</span>';
    if (rv.status === "in_review") return `<span class="pill run">En revisión · ${rv.pending} pend.</span>`;
    if (rv.status === "full_review_suggested") return '<span class="pill x">Revisión completa sugerida</span>';
    return `<span class="pill w">Por revisar${rv.flagged ? ` · ${rv.flagged} marcadas` : ""}</span>`;
  }

  function kv(label, value, infoKey) {
    const div = document.createElement("div");
    div.className = "kv";
    div.innerHTML = `<span>${label}${infoKey ? info(infoKey) : ""}</span><span>${value}</span>`;
    return div;
  }

  const sexText = s => (s === "F" ? "mujer" : s === "M" ? "hombre" : null);

  window.MaiaUI = {
    $, toast, confirm, modalOpen, openDialog, closeDialog, parse, dShort, dTime, dLong, stage, chips,
    statusPill, STATUS_TXT, kv, sexText, info, hydrate, steps,
    setRules(thr, night) { rules = { thr, night }; }
  };
  hydrate();
})();
