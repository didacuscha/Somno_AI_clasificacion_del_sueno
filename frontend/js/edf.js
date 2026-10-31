/* ════════════════════════════════════════════════════════════════════
   MAIA · lectura de encabezados EDF en el navegador
   ────────────────────────────────────────────────────────────────────
   Antes de subir nada, el tablero lee el encabezado del EDF (canales,
   frecuencias, hora de inicio, duración, edad y sexo) para que el usuario
   elija canales y ventana. Para un .zip se localiza el PSG en el
   directorio central y se descomprimen solo sus primeros bytes.
   La API vuelve a validar todo al recibir el archivo.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const td = new TextDecoder("ascii");
  const field = (u8, a, b) => td.decode(u8.subarray(a, b)).trim();

  function parsePatient(text) {
    const m = /(\d{1,3})\s*yr/i.exec(text);
    const p = text.trim().split(/\s+/);
    return {
      age: m && +m[1] >= 1 && +m[1] <= 120 ? +m[1] : null,
      sex: p[1] === "F" || p[1] === "M" ? p[1] : null
    };
  }

  /* encabezado completo (256 + ns·256 bytes) → datos útiles, o null si no es EDF */
  function parseHeader(u8, fileSize) {
    if (u8.length < 256 || field(u8, 0, 8) !== "0") return null;
    const ns = parseInt(field(u8, 252, 256), 10);
    if (!(ns > 0) || u8.length < 256 + ns * 256) return null;
    const col = (off, w) => Array.from({ length: ns }, (_, i) =>
      field(u8, 256 + off + i * w, 256 + off + (i + 1) * w));
    const labels = col(0, 16);
    const spr = col(ns * 216, 8).map(v => parseInt(v, 10) || 0);
    const recDur = parseFloat(field(u8, 244, 252)) || 0;
    let nRec = parseInt(field(u8, 236, 244), 10);
    if (!(nRec >= 0) && fileSize) {
      nRec = Math.floor((fileSize - 256 - ns * 256) / (2 * Math.max(1, spr.reduce((a, b) => a + b, 0))));
    }
    const fs = {};
    labels.forEach((l, i) => { fs[l] = recDur ? spr[i] / recDur : 0; });
    const t = field(u8, 176, 184).split(".").map(Number);
    const d = field(u8, 168, 176).split(".").map(Number);
    const okT = t.length === 3 && t.every(Number.isFinite);
    return {
      labels, fs,
      nChannels: ns,
      durationS: nRec >= 0 ? nRec * recDur : null,
      startClockS: okT ? t[0] * 3600 + t[1] * 60 + t[2] : null,
      startDate: d.length === 3 && d.every(Number.isFinite)
        ? new Date((d[2] >= 85 ? 1900 : 2000) + d[2], d[1] - 1, d[0]) : null,
      patient: parsePatient(field(u8, 8, 88)),
      annotationsOnly: labels.every(l => l === "EDF Annotations")
    };
  }

  async function readEdf(blob) {
    const head = new Uint8Array(await blob.slice(0, 256).arrayBuffer());
    const ns = parseInt(field(head, 252, 256), 10);
    if (!(ns > 0 && ns < 1000)) return null;
    return parseHeader(new Uint8Array(await blob.slice(0, 256 + ns * 256).arrayBuffer()), blob.size);
  }

  const concat = (parts, n) => {
    const out = new Uint8Array(n);
    let o = 0;
    parts.forEach(a => { out.set(a.subarray(0, Math.min(a.length, n - o)), o); o += a.length; });
    return out;
  };

  /* primeros bytes descomprimidos de una entrada del zip: lo justo para el encabezado */
  async function entryHead(file, entry) {
    const lh = new DataView(await file.slice(entry.lho, entry.lho + 30).arrayBuffer());
    if (lh.getUint32(0, true) !== 0x04034b50) return null;
    const start = entry.lho + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    const chunk = await file.slice(start, start + Math.min(entry.compSize || 524288, 524288)).arrayBuffer();
    if (entry.method === 0) return new Uint8Array(chunk);           // almacenado sin comprimir
    if (entry.method !== 8 || !("DecompressionStream" in window)) return null;
    const reader = new Blob([chunk]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    const parts = [];
    let got = 0, target = 256;
    try {
      while (got < target) {
        const { value, done } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        if (target === 256 && got >= 256) {                        // ya se sabe cuántos canales hay
          const ns = parseInt(field(concat(parts, 256), 252, 256), 10);
          if (ns > 0 && ns < 1000) target = 256 + ns * 256;
        }
      }
    } catch (e) { /* el flujo se corta al no darle el resto: ya tenemos el inicio */ }
    reader.cancel().catch(() => {});
    return concat(parts, got);
  }

  /* → { psg: {name, header}, hypnogram: {name} | null } o null si el zip no sirve */
  async function readZip(file) {
    const tailBuf = await file.slice(Math.max(0, file.size - 65558), file.size).arrayBuffer();
    const tail = new DataView(tailBuf);
    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) {
      if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const cdSize = tail.getUint32(eocd + 12, true), cdOfs = tail.getUint32(eocd + 16, true);
    const cd = new DataView(await file.slice(cdOfs, cdOfs + cdSize).arrayBuffer());
    const dec = new TextDecoder();
    const entries = [];
    let p = 0;
    while (p + 46 <= cd.byteLength && cd.getUint32(p, true) === 0x02014b50) {
      const nameLen = cd.getUint16(p + 28, true);
      const name = dec.decode(new Uint8Array(cd.buffer, p + 46, nameLen));
      const base = name.split("/").pop();
      if (/\.edf$/i.test(name) && !/__macosx/i.test(name) && !base.startsWith("._")) {
        entries.push({ name, base, method: cd.getUint16(p + 10, true), compSize: cd.getUint32(p + 20, true),
                       lho: cd.getUint32(p + 42, true), isHyp: /hypno/i.test(base) });
      }
      p += 46 + nameLen + cd.getUint16(p + 30, true) + cd.getUint16(p + 32, true);
    }
    const psg = entries.find(e => !e.isHyp), hyp = entries.find(e => e.isHyp);
    if (!psg) return { psg: null, hypnogram: hyp ? { name: hyp.base } : null };
    const head = await entryHead(file, psg);
    return { psg: { name: psg.base, header: head ? parseHeader(head) : null },
             hypnogram: hyp ? { name: hyp.base } : null };
  }

  /* mismas reglas que la API (app/channels.py), con los patrones que entrega GET /config */
  const normalize = label => label.trim().toLowerCase().replace(/[–—]/g, "-").replace(/[\s_.]+/g, "");

  function detect(labels, aliases) {
    const pats = Object.entries(aliases).map(([slot, ps]) => [slot, ps.map(p => new RegExp(p))]);
    const found = {};
    labels.forEach(label => {
      const n = normalize(label);
      for (const [slot, ps] of pats) {
        if (!found[slot] && ps.some(re => re.test(n))) { found[slot] = label; break; }
      }
    });
    return found;
  }

  window.MaiaEdf = { readEdf, readZip, detect, normalize, parsePatient };
})();
