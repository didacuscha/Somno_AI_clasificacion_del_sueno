/* ════════════════════════════════════════════════════════════════════
   MAIA · piezas de interfaz compartidas por las vistas
   (aviso flotante, confirmación modal, fechas y etiquetas)
   ════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const { esc } = MaiaUtil;
  const STG = MaiaCharts.STG;
  const $ = id => document.getElementById(id);

  /* ── aviso flotante ── */
  let toastTimer = null;
  function toast(msg, isErr = false) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.toggle("err", isErr);
    el.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("on"), isErr ? 5000 : 2600);
  }

  /* ── confirmación modal → Promise<boolean> ── */
  let resolveModal = null;
  function confirm({ title, html, confirmLabel, danger = false }) {
    $("mTitle").textContent = title;
    $("mText").innerHTML = html;
    $("mConfirm").textContent = confirmLabel;
    $("mConfirm").classList.toggle("danger", danger);
    $("modal").classList.remove("hidden");
    $("mCancel").focus();
    return new Promise(res => { resolveModal = res; });
  }
  function closeModal(answer) {
    $("modal").classList.add("hidden");
    if (resolveModal) { resolveModal(answer); resolveModal = null; }
  }
  $("mCancel").onclick = () => closeModal(false);
  $("mConfirm").onclick = () => closeModal(true);
  $("modal").addEventListener("click", e => { if (e.target === $("modal")) closeModal(false); });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !$("modal").classList.contains("hidden")) closeModal(false);
  });
  const modalOpen = () => !$("modal").classList.contains("hidden");

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

  /* estado del registro en una píldora (listado y encabezado de resultados) */
  function statusPill(r) {
    if (r.status === "queued" || r.status === "running") return '<span class="pill run"><span class="spin" style="width:9px;height:9px;margin-right:2px"></span>En proceso</span>';
    if (r.status === "failed") return '<span class="pill x">Falló</span>';
    const rv = r.review || {};
    if (rv.status === "signed_off") return '<span class="pill ok">Finalizada</span>';
    if (!rv.flagged && !rv.corrected) return '<span class="pill">Sin marcas</span>';
    if (rv.status === "in_progress") return `<span class="pill run">En revisión · ${rv.pending} pend.</span>`;
    return `<span class="pill w">Sin revisar · ${rv.pending}</span>`;
  }

  function kv(label, value) {
    const div = document.createElement("div");
    div.className = "kv";
    div.innerHTML = `<span>${label}</span><span>${value}</span>`;
    return div;
  }

  const sexText = s => (s === "F" ? "mujer" : s === "M" ? "hombre" : null);

  window.MaiaUI = { $, toast, confirm, modalOpen, parse, dShort, dTime, dLong, stage, chips, statusPill, kv, sexText };
})();
