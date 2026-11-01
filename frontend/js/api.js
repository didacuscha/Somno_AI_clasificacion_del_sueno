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
  const enc = encodeURIComponent;

  function authHeaders() {
    const t = sessionStorage.getItem(TOKEN_KEY);
    return t ? { Authorization: "Bearer " + t } : {};
  }

  function unauthorized() {
    MaiaAPI.clearSession();
    window.dispatchEvent(new CustomEvent("maia:unauthorized"));
    return { code: "unauthorized", message: "La sesión expiró. Inicie sesión de nuevo." };
  }

  async function request(path, { method = "GET", body, timeoutMs } = {}) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs || CFG.requestTimeoutMs);
    let res;
    try {
      res = await fetch(CFG.apiBase + path, {
        method,
        headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...authHeaders() },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal
      });
    } catch (e) {
      throw e.name === "AbortError"
        ? { code: "timeout", message: "La petición tardó demasiado. Intente de nuevo." }
        : { code: "network", message: "No se pudo contactar la API. ¿Está corriendo el backend?" };
    } finally {
      clearTimeout(to);
    }
    if (res.status === 401) throw unauthorized();
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

  /* subida multipart con avance (fetch no informa el avance de la subida) */
  function upload(path, fields, onProgress) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      Object.entries(fields).forEach(([k, v]) => { if (v) fd.append(k, v); });
      const xhr = new XMLHttpRequest();
      xhr.open("POST", CFG.apiBase + path);
      Object.entries(authHeaders()).forEach(([k, v]) => xhr.setRequestHeader(k, v));
      xhr.timeout = CFG.uploadTimeoutMs;
      xhr.upload.onprogress = e => { if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) { /* sin cuerpo */ }
        if (xhr.status === 401) return reject(unauthorized());
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
        const err = (data && data.error) || {};
        reject({ code: err.code || "http_" + xhr.status, message: err.message || `Error del servidor (${xhr.status}).` });
      };
      xhr.onerror = () => reject({ code: "network", message: "No se pudo contactar la API. ¿Está corriendo el backend?" });
      xhr.ontimeout = () => reject({ code: "timeout", message: "La subida tardó demasiado. Intente de nuevo." });
      xhr.send(fd);
    });
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

  const rec = id => "/records/" + enc(id);

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

    /* ── reglas del modelo y catálogo de noches ── */
    getConfig: () => useMock() ? MaiaMock.getConfig() : http("/config"),
    listCatalog: (refresh = false) => useMock() ? MaiaMock.listCatalog()
      : http("/catalog" + (refresh ? "?refresh=true" : ""), { timeoutMs: 120000 }),

    /* ── PSG propio: se sube primero y el servidor responde con sus canales ── */
    uploadPsg: (file, hypnogram, onProgress) => useMock() ? MaiaMock.uploadPsg(file, hypnogram)
      : upload("/uploads", { file, hypnogram }, onProgress),
    attachHypnogram: (id, file) => useMock() ? MaiaMock.attachHypnogram(id, file)
      : upload(`/uploads/${enc(id)}/hypnogram`, { file }),
    removeHypnogram: id => useMock() ? MaiaMock.removeHypnogram(id)
      : http(`/uploads/${enc(id)}/hypnogram`, { method: "DELETE" }),
    deleteUpload: id => useMock() ? MaiaMock.deleteUpload(id) : http(`/uploads/${enc(id)}`, { method: "DELETE" }),

    /* ── análisis (asíncronos: responden «en cola» y se consulta el registro) ── */
    createAnalysis({ source, channels, channelMap, windowMode, startClock, endClock, lightsOff }) {
      const body = {
        source, channels, channel_map: channelMap && Object.keys(channelMap).length ? channelMap : null,
        window_mode: windowMode || null, start_clock: startClock || null, end_clock: endClock || null,
        lights_off: lightsOff || "none"
      };
      return useMock() ? MaiaMock.createAnalysis(body) : http("/analyses", { method: "POST", body });
    },
    retry: id => useMock() ? MaiaMock.retry(id) : http(rec(id) + "/retry", { method: "POST" }),

    /* ── registros ── */
    async listRecords() {
      const out = useMock() ? await MaiaMock.listRecords() : await http("/records");
      return out.records;
    },
    getRecord: id => useMock() ? MaiaMock.getRecord(id) : http(rec(id)),
    deleteRecord: id => useMock() ? MaiaMock.deleteRecord(id) : http(rec(id), { method: "DELETE" }),

    /* ── señal por ventana (envolvente mín-máx, nunca la señal cruda) ── */
    getSignal(id, startS, durationS, points, channels) {
      if (useMock()) return MaiaMock.getSignal(id, startS, durationS, points, channels);
      return http(rec(id) + `/signal?start_s=${startS}&duration_s=${durationS}&points=${points}&channels=${channels.join(",")}`);
    },
    /* ── evidencia espectral de una época ── */
    getEvidence(id, epoch, channel) {
      if (useMock()) return MaiaMock.getEvidence(id, epoch, channel);
      return http(rec(id) + `/epochs/${epoch}/evidence` + (channel ? `?channel=${enc(channel)}` : ""));
    },

    /* ── revisión del especialista ── */
    changeEpochs: (id, changes) => useMock() ? MaiaMock.changeEpochs(id, changes)
      : http(rec(id) + "/epochs", { method: "PATCH", body: { changes } }),
    getChanges: id => useMock() ? MaiaMock.getChanges(id) : http(rec(id) + "/changes"),
    reviewAction: (id, action, expectedCorrected) => {
      const body = { action, expected_corrected: expectedCorrected ?? null };
      return useMock() ? MaiaMock.reviewAction(id, body) : http(rec(id) + "/review", { method: "POST", body });
    },
    addNote: (id, text) => useMock() ? MaiaMock.addNote(id, text)
      : http(rec(id) + "/notes", { method: "POST", body: { text } }),

    /* ── exportación ── */
    exportRecord: id => download(rec(id) + "/export.csv", "hipnograma.csv"),
    exportCorrections: () => download("/corrections/export.csv", "correcciones_somnoai.csv")
  };
})();
