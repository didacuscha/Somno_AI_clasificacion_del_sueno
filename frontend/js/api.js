/* ════════════════════════════════════════════════════════════════════
   MAIA · cliente de API
   ────────────────────────────────────────────────────────────────────
   Fachada única que usa el resto del tablero. Según js/config.js:
     - apiBase = null → delega en el backend simulado (js/mock.js)
     - apiBase = URL  → habla HTTP con la API real (docs/API_CONTRACT.md)
   Errores siempre normalizados a: { code, message }
   ════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const CFG = window.MAIA_CONFIG;
  const useMock = () => !CFG.apiBase;

  const TOKEN_KEY = "maia_token";
  const USER_KEY = "maia_user";

  function authHeaders() {
    const t = sessionStorage.getItem(TOKEN_KEY);
    return t ? { Authorization: "Bearer " + t } : {};
  }

  async function request(path, { method = "GET", body, isForm = false, timeoutMs } = {}) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs || CFG.requestTimeoutMs);
    let res;
    try {
      res = await fetch(CFG.apiBase + path, {
        method,
        headers: {
          ...(isForm ? {} : body ? { "Content-Type": "application/json" } : {}),
          ...authHeaders()
        },
        body: isForm ? body : body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal
      });
    } catch (e) {
      throw e.name === "AbortError"
        ? { code: "timeout", message: "La petición tardó demasiado. Intente de nuevo." }
        : { code: "network", message: "No se pudo contactar la API. ¿Está corriendo el backend?" };
    } finally {
      clearTimeout(to);
    }
    if (res.status === 401) {
      MaiaAPI.clearSession();
      window.dispatchEvent(new CustomEvent("maia:unauthorized"));
      throw { code: "unauthorized", message: "La sesión expiró. Inicie sesión de nuevo." };
    }
    return res;
  }

  async function http(path, opts) {
    const res = await request(path, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { /* respuestas sin cuerpo */ }
    if (!res.ok) {
      const err = (data && data.error) || {};
      throw { code: err.code || "http_" + res.status, message: err.message || "Error del servidor (" + res.status + ")." };
    }
    return data;
  }

  /* descarga un CSV autenticado (un <a href> no puede mandar el token) */
  async function download(path, fallbackName) {
    if (useMock()) return MaiaMock.download(path, fallbackName);
    const res = await request(path);
    if (!res.ok) throw { code: "http_" + res.status, message: "No se pudo descargar el archivo." };
    const name = (/filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "") || [])[1] || fallbackName;
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  window.MaiaAPI = {
    isMock: useMock,

    /* ── sesión ── */
    isLoggedIn: () => !!sessionStorage.getItem(TOKEN_KEY),
    currentUser() {
      try { return JSON.parse(sessionStorage.getItem(USER_KEY)) || null; } catch (e) { return null; }
    },
    clearSession() {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(USER_KEY);
    },
    async login(username, password) {
      const out = useMock()
        ? await MaiaMock.login(username, password)
        : await http("/auth/login", { method: "POST", body: { username, password } });
      sessionStorage.setItem(TOKEN_KEY, out.token);
      sessionStorage.setItem(USER_KEY, JSON.stringify(out.user));
      return out.user;
    },

    /* ── reglas del modelo y noches disponibles ── */
    getConfig: () => useMock() ? MaiaMock.getConfig() : http("/config"),
    async listDemos() {
      const out = useMock() ? await MaiaMock.listDemos() : await http("/demos");
      return out.demos;
    },
    async lookupNight(fileName) {
      const out = useMock() ? await MaiaMock.lookupNight(fileName)
        : await http("/dataset/lookup?file_name=" + encodeURIComponent(fileName));
      return out.night;
    },

    /* ── análisis (asíncronos: responden «en cola» y se consulta el registro) ── */
    createAnalysis({ file, hypnogram, channels, channelMap, windowMode, startClock, endClock, lightsOff }) {
      if (useMock()) return MaiaMock.createAnalysis(arguments[0]);
      const fd = new FormData();
      fd.append("file", file);
      if (hypnogram) fd.append("hypnogram", hypnogram);
      fd.append("channels", channels.join(","));
      if (channelMap && Object.keys(channelMap).length) fd.append("channel_map", JSON.stringify(channelMap));
      if (windowMode) fd.append("window_mode", windowMode);
      if (startClock) fd.append("start_clock", startClock);
      if (endClock) fd.append("end_clock", endClock);
      fd.append("lights_off", lightsOff || "none");
      return http("/analyses", { method: "POST", body: fd, isForm: true, timeoutMs: CFG.uploadTimeoutMs });
    },
    createDemoAnalysis({ demoId, channels, channelMap, windowMode, startClock, endClock, lightsOff }) {
      if (useMock()) return MaiaMock.createDemoAnalysis(arguments[0]);
      return http("/analyses/demo", { method: "POST", body: {
        demo_id: demoId, channels, channel_map: channelMap || null, window_mode: windowMode || null,
        start_clock: startClock || null, end_clock: endClock || null, lights_off: lightsOff || "none" } });
    },

    /* ── registros ── */
    async listRecords() {
      const out = useMock() ? await MaiaMock.listRecords() : await http("/records");
      return out.records;
    },
    getRecord: id => useMock() ? MaiaMock.getRecord(id) : http("/records/" + encodeURIComponent(id)),
    deleteRecord: id => useMock() ? MaiaMock.deleteRecord(id)
      : http("/records/" + encodeURIComponent(id), { method: "DELETE" }),

    /* ── señal por ventana (envolvente mín-máx, nunca la señal cruda) ── */
    getSignal(id, startS, durationS, points, channels) {
      if (useMock()) return MaiaMock.getSignal(id, startS, durationS, points, channels);
      const q = `?start_s=${startS}&duration_s=${durationS}&points=${points}&channels=${channels.join(",")}`;
      return http("/records/" + encodeURIComponent(id) + "/signal" + q);
    },

    /* ── revisión del especialista ── */
    changeEpochs(id, changes) {
      if (useMock()) return MaiaMock.changeEpochs(id, changes);
      return http("/records/" + encodeURIComponent(id) + "/epochs", { method: "PATCH", body: { changes } });
    },
    reviewAction(id, action) {
      if (useMock()) return MaiaMock.reviewAction(id, action);
      return http("/records/" + encodeURIComponent(id) + "/review", { method: "POST", body: { action } });
    },

    /* ── exportación ── */
    exportRecord: id => download("/records/" + encodeURIComponent(id) + "/export.csv", "hipnograma.csv"),
    exportCorrections: () => download("/corrections/export.csv", "correcciones_somnoai.csv")
  };
})();
