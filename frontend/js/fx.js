/* ════════════════════════════════════════════════════════════════════
   MAIA · micro-animaciones (sin dependencias)
   ────────────────────────────────────────────────────────────────────
   - Son efectos sobre elementos que YA muestran su estado final (Web
     Animations API): la interfaz nunca espera a una animación y una
     tecla nueva simplemente la reemplaza.
   - Muchas vistas se redibujan varias veces seguidas (cambio local →
     avance → respuesta de la API). Por eso los efectos aceptan `age`:
     los milisegundos ya transcurridos, para retomar donde iban en el
     elemento nuevo en vez de empezar de cero o cortarse.
   - Con «reducir movimiento» activado en el sistema no se anima nada.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const mq = matchMedia("(prefers-reduced-motion: reduce)");
  const enabled = () => !mq.matches && typeof Element.prototype.animate === "function";
  const EASE = "cubic-bezier(.2,.8,.2,1)";
  const now = () => performance.now();
  const cv = n => getComputedStyle(document.body).getPropertyValue(n).trim();
  /* #rrggbb + opacidad → #rrggbbaa (los colores del tema son hexadecimales) */
  const alpha = (c, a) => (/^#[0-9a-f]{6}$/i.test(c) ? c + Math.round(a * 255).toString(16).padStart(2, "0") : c);
  /* transform no aplica a elementos en línea */
  const blockish = el => { if (getComputedStyle(el).display === "inline") el.style.display = "inline-block"; };

  function play(el, frames, { age = 0, duration = 220, ...opts } = {}) {
    if (!el || !enabled() || age >= duration + (opts.delay || 0)) return null;
    try {
      const a = el.animate(frames, { duration, easing: EASE, ...opts });
      if (age > 0) a.currentTime = age;
      return a;
    } catch (e) { return null; }
  }

  /* el texto cambió dentro del mismo contexto (scope = noche) → entra con un leve desplazamiento */
  function tick(el, value, scope) {
    if (!el) return;
    const changed = el._fxScope === scope && el._fxVal !== undefined && el._fxVal !== value;
    el._fxScope = scope;
    el._fxVal = value;
    if (!changed) return;
    blockish(el);
    play(el, [{ transform: "translateY(-6px)", opacity: 0.2 }, { transform: "none", opacity: 1 }], { duration: 200 });
  }

  /* «no»: error de contraseña, canal que no se puede asignar */
  function shake(el) {
    if (!el) return;
    blockish(el);
    play(el, [
      { transform: "translateX(0)" }, { transform: "translateX(-7px)" }, { transform: "translateX(6px)" },
      { transform: "translateX(-4px)" }, { transform: "translateX(2px)" }, { transform: "translateX(0)" }
    ], { duration: 300, easing: "ease-out" });
  }

  /* algo quedó hecho (revisión finalizada) */
  function pop(el) {
    if (!el) return;
    blockish(el);
    play(el, [
      { transform: "scale(.85)", opacity: 0.4 },
      { transform: "scale(1.06)", opacity: 1, offset: 0.6 },
      { transform: "none", opacity: 1 }
    ], { duration: 250 });
  }

  /* anillo de color que se desvanece alrededor de un botón o una celda;
     base = sombra propia del elemento, para no perderla durante el efecto */
  function ring(el, colorVar, age = 0, base = "", scale = 1.04) {
    if (!el) return;
    const c = cv(colorVar), pre = base && base !== "none" ? base + ", " : "";
    play(el, [
      { boxShadow: `${pre}0 0 0 0 ${alpha(c, 0.6)}`, transform: `scale(${scale})` },
      { boxShadow: `${pre}0 0 0 8px ${alpha(c, 0)}`, transform: "none" }
    ], { duration: 250, easing: "ease-out", age });
  }

  /* números que cuentan de `from` a `to` (texto con fmt) */
  function countTo(el, from, to, fmt, duration = 250, age = 0) {
    if (!el) return;
    cancelAnimationFrame(el._fxRaf);
    if (!enabled() || from == null || from === to || age >= duration) { el.textContent = fmt(to); return; }
    const t0 = now() - age;
    const step = t => {
      const p = Math.min(1, Math.max(0, (t - t0) / duration)), e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(from + (to - from) * e);
      if (p < 1) el._fxRaf = requestAnimationFrame(step);
    };
    step(now());
  }

  /* barras que pasan de los anchos anteriores (en %, null = desde 0) a los suyos */
  function widths(els, from, age = 0) {
    els.forEach((el, k) => {
      const to = el.style.width, f = from && from[k] != null ? from[k] : 0;
      if (to && Math.abs(parseFloat(to) - f) > 0.3) play(el, [{ width: f + "%" }, { width: to }], { age });
    });
  }

  /* gráfico que se dibuja de izquierda a derecha */
  function reveal(el, age = 0) {
    play(el, [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }],
      { duration: 450, easing: "cubic-bezier(.4,0,.2,1)", age });
  }

  /* desplazamiento horizontal (el cursor del hipnograma viene de donde estaba) */
  function glide(el, dx, age = 0) {
    if (Math.abs(dx) > 0.5) play(el, [{ transform: `translateX(${dx}px)` }, { transform: "translateX(0)" }], { duration: 180, age });
  }

  /* destello que se apaga; sin animación posible, el elemento se quita */
  function fade(el, age = 0, peak = 0.5) {
    const a = play(el, [{ opacity: peak }, { opacity: 0 }], { duration: 520, easing: "ease-out", fill: "forwards", age });
    if (!a) el.remove();
  }

  /* subrayado que se desliza entre pestañas (role=tablist con aria-selected) */
  function tabInk(bar) {
    if (!bar || bar._ink) return;
    const ink = bar._ink = document.createElement("span");
    ink.className = "tabink still";
    ink.setAttribute("aria-hidden", "true");
    bar.classList.add("has-ink");
    bar.appendChild(ink);
    let placed = false;
    const place = animate => {
      const b = bar.querySelector('[aria-selected="true"]');
      if (!b || !b.offsetWidth) return;
      ink.classList.toggle("still", !animate || !placed);
      ink.style.width = b.offsetWidth + "px";
      ink.style.transform = `translateX(${b.offsetLeft}px)`;
      placed = true;
    };
    new MutationObserver(() => place(true)).observe(bar, { attributes: true, subtree: true, attributeFilter: ["aria-selected"] });
    if (window.ResizeObserver) new ResizeObserver(() => place(false)).observe(bar);
    place(false);
  }

  /* ── gráficas ──
     memo(el, key, W): lo que un contenedor recuerda entre redibujos de la MISMA gráfica
     (key = noche/vista). `age`: ms desde que apareció (entrada); track() detecta si los
     datos cambiaron y desde cuándo (transición de valores). Un cambio de ancho olvida
     las posiciones: redimensionar no anima nada. */
  function memo(el, key, W) {
    const t = now();
    let m = el._fxMemo;
    if (!m || m.key !== key) m = el._fxMemo = { key, born: t, W, cur: null, from: null, t0: t };
    if (m.W !== W) { m.W = W; m.cur = null; m.from = null; }
    m.age = t - m.born;
    return m;
  }
  const sameBox = (a, b) => a && b && Math.abs(a.x - b.x) < 0.3 && Math.abs(a.y - b.y) < 0.3 &&
    Math.abs(a.w - b.w) < 0.3 && Math.abs(a.h - b.h) < 0.3;
  /* boxes = {id: {x,y,w,h}}; devuelve {from, age} del último cambio (from = null: no hubo) */
  function track(m, boxes) {
    const ids = Object.keys(boxes), cur = m.cur;
    const same = cur && ids.length === Object.keys(cur).length && ids.every(k => sameBox(cur[k], boxes[k]));
    if (!same) { m.from = cur; m.cur = boxes; m.t0 = now(); }
    return { from: m.from, age: now() - m.t0 };
  }
  /* marca SVG ya dibujada en b que parte de a ({x,y,w,h} en unidades del SVG) */
  function morphBox(el, a, b, { age = 0, duration = 260, delay = 0, easing = EASE } = {}) {
    if (!el || !a || !b || !(b.w > 0) || !(b.h > 0) || sameBox(a, b)) return;
    const sx = a.w / b.w, sy = a.h / b.h, tx = a.x - b.x * sx, ty = a.y - b.y * sy;
    el.style.transformOrigin = "0 0";
    play(el, [{ transform: `translate(${tx}px, ${ty}px) scale(${sx}, ${sy})` }, { transform: "none" }],
      { duration, age, delay, easing, fill: "backwards" });
  }
  /* entrada escalonada de una marca pequeña (punto): crece desde su centro */
  function popIn(el, delay = 0, age = 0) {
    if (!el) return;
    el.style.transformBox = "fill-box";
    el.style.transformOrigin = "center";
    play(el, [{ transform: "scale(0)" }, { transform: "scale(1.18)", offset: 0.7 }, { transform: "none" }],
      { duration: 280, delay, age, fill: "backwards" });
  }

  /* selector segmentado (botones con aria-pressed): el fondo de la opción elegida se desliza */
  function segPill(bar) {
    if (!bar || bar._pill) return;
    const pill = bar._pill = document.createElement("span");
    pill.className = "segpill still";
    pill.setAttribute("aria-hidden", "true");
    bar.classList.add("has-pill");
    bar.prepend(pill);
    let placed = false;
    const place = animate => {
      const b = bar.querySelector(':scope > button[aria-pressed="true"]');
      if (!b || !b.offsetWidth) { if (!b) pill.style.opacity = "0"; return; }
      pill.classList.toggle("still", !animate || !placed);
      Object.assign(pill.style, {
        opacity: "1", width: b.offsetWidth + "px", height: b.offsetHeight + "px",
        transform: `translate(${b.offsetLeft}px, ${b.offsetTop}px)`
      });
      placed = true;
    };
    new MutationObserver(() => place(true)).observe(bar, { attributes: true, subtree: true, attributeFilter: ["aria-pressed"] });
    if (window.ResizeObserver) new ResizeObserver(() => place(false)).observe(bar);
    place(false);
  }

  /* onda desde el punto de clic en los botones principales */
  document.addEventListener("pointerdown", e => {
    const b = e.target.closest && e.target.closest(".cta");
    if (!b || b.disabled || !enabled()) return;
    const r = b.getBoundingClientRect(), size = Math.max(r.width, r.height) * 2.2;
    const dot = document.createElement("span");
    dot.className = "ripple";
    dot.setAttribute("aria-hidden", "true");
    Object.assign(dot.style, { width: size + "px", height: size + "px",
      left: (e.clientX - r.left - size / 2) + "px", top: (e.clientY - r.top - size / 2) + "px" });
    b.appendChild(dot);
    const a = play(dot, [{ transform: "scale(0)", opacity: 0.35 }, { transform: "scale(1)", opacity: 0 }],
      { duration: 380, easing: "ease-out" });
    if (a) a.onfinish = a.oncancel = () => dot.remove(); else dot.remove();
  });

  window.MaiaFX = { enabled, now, play, tick, shake, pop, ring, countTo, widths, reveal, glide, fade, tabInk, segPill,
    memo, track, morphBox, popIn, sameBox };
})();
