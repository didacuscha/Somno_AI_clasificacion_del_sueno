"""Capturas de pantalla de la guía de uso (frontend/guia/img/*.jpg).

Abre el tablero en Chrome sin ventana (protocolo DevTools), recorre las vistas que explica la guía
y guarda cada captura con sus marcadores numerados ya dibujados, para que los números del texto de
la guía coincidan con la imagen aunque la interfaz cambie un poco.

⚠ Toma decisiones de revisión y sube un PSG demo: córralo SOLO contra una instancia local
desechable (base vacía con las noches demo), nunca contra el servidor desplegado.

    # 1 · instancia local con una base temporal, en el puerto 8000 (el tablero busca ahí la API);
    #     con la base vacía lanza los 4 análisis de muestra
    SOMNOAI_DATA_DIR=/tmp/somnoai-guia SOMNOAI_DEMO_DIR=$PWD/backend/data/demo SOMNOAI_MODEL=provisional \
    SOMNOAI_USERS='{"especialista": {"password": "<clave>", "name": "Especialista de sueño"}}' \
      backend/.venv/bin/uvicorn app.main:app --app-dir backend --port 8000

    # 2 · capturas (la clave va por variable de entorno, no como argumento)
    SOMNOAI_GUIA_PASSWORD=<clave> backend/.venv/bin/python docs/guia/capturas.py

    # 3 · el PDF: sh docs/guia/generar_pdf.sh

Necesita Google Chrome y el paquete `websockets` (ya viene en el entorno del backend).
"""
import argparse
import asyncio
import base64
import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

from websockets.asyncio.client import connect

ROOT = Path(__file__).resolve().parents[2]
DEMO = ROOT / "backend" / "data" / "demo"
CHROME = os.environ.get("CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")

# Lo que cambia entre instalaciones y no debe salir en la guía: qué modelo está activo.
# Busca un elemento por CSS, o por su texto con "text:<css>|<comienzo del texto>" (p. ej. etiquetas del SVG).
FIND_JS = """const find = s => { if (!s.startsWith('text:')) return document.querySelector(s);
  const [css, t] = s.slice(5).split('|'); return [...document.querySelectorAll(css)].find(e => e.textContent.trim().startsWith(t)); };"""

HIDE_CSS = """
header{position:static!important}
.mpill{display:none!important}
#resAlerts .alert.i{display:none!important}
.toast{display:none!important}
.gmark{position:absolute;z-index:9999;width:26px;height:26px;border-radius:50%;background:#111;color:#fff;
  font:700 14px/22px system-ui,-apple-system,sans-serif;text-align:center;border:2px solid #fff;
  box-shadow:0 0 0 1.5px #111,0 3px 8px rgba(0,0,0,.35);pointer-events:none}
"""


class Page:
    def __init__(self, ws):
        self.ws, self.n = ws, 0

    async def send(self, method, **params):
        self.n += 1
        mid = self.n
        await self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        while True:
            msg = json.loads(await self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})

    async def js(self, expr):
        out = await self.send("Runtime.evaluate", expression=expr, awaitPromise=True, returnByValue=True)
        if "exceptionDetails" in out:
            raise RuntimeError(f"JS: {out['exceptionDetails'].get('exception', {}).get('description', expr)}")
        return out.get("result", {}).get("value")

    async def wait(self, cond, timeout=60, what=None):
        t0 = time.time()
        while time.time() - t0 < timeout:
            if await self.js(f"!!({cond})"):
                return
            await asyncio.sleep(0.15)
        raise TimeoutError(what or cond)

    async def click(self, sel):
        ok = await self.js(f"(() => {{ const e = document.querySelector({json.dumps(sel)}); if (!e) return false; e.click(); return true; }})()")
        if not ok:
            raise RuntimeError(f"no encontré {sel}")

    async def key(self, k, shift=False):
        await self.js(f"document.body.dispatchEvent(new KeyboardEvent('keydown', {{key: {json.dumps(k)}, shiftKey: {str(shift).lower()}, bubbles: true}}))")
        await asyncio.sleep(0.35)

    async def marks(self, items):
        """Marcadores numerados junto a elementos: [(n, selector, lugar)]; lugar tl, tr (esquinas), t, b (arriba,
        abajo), l, r (izquierda, derecha) o c (centro)."""
        await self.js("document.querySelectorAll('.gmark').forEach(m => m.remove())")
        for n, sel, at in items:
            ok = await self.js(f"""(() => {{
              {FIND_JS} const e = find({json.dumps(sel)}); if (!e) return false;
              const r = e.getBoundingClientRect(), x0 = r.left + scrollX, y0 = r.top + scrollY, s = 13;
              const pos = {{tl: [x0 - s, y0 - s], tr: [x0 + r.width - s, y0 - s], l: [x0 - 2 * s - 4, y0 + r.height / 2 - s],
                           r: [x0 + r.width + 4, y0 + r.height / 2 - s], c: [x0 + r.width / 2 - s, y0 + r.height / 2 - s],
                           t: [x0 + r.width / 2 - s, y0 - 2 * s - 3], b: [x0 + r.width / 2 - s, y0 + r.height + 3]}}[{json.dumps(at)}];
              const m = document.createElement('div'); m.className = 'gmark'; m.textContent = {json.dumps(str(n))};
              m.style.left = Math.max(2, pos[0]) + 'px'; m.style.top = Math.max(2, pos[1]) + 'px';
              document.body.appendChild(m); return true; }})()""")
            if not ok:
                raise RuntimeError(f"marcador {n}: no encontré {sel}")

    async def shot(self, out, sels, pad=12, extra_bottom=0):
        """Captura la caja que encierra a los selectores (en coordenadas de la página)."""
        await self.js(f"(() => {{ {FIND_JS} find({json.dumps(sels[0])}).scrollIntoView({{block: 'center'}}); }})()")
        await asyncio.sleep(0.5)
        box = await self.js(f"""(() => {{ {FIND_JS}
          const rs = {json.dumps(sels)}.map(find).filter(Boolean).map(e => e.getBoundingClientRect());
          if (!rs.length) return null;
          const x = Math.min(...rs.map(r => r.left)), y = Math.min(...rs.map(r => r.top));
          const X = Math.max(...rs.map(r => r.right)), Y = Math.max(...rs.map(r => r.bottom));
          return {{x: x + scrollX, y: y + scrollY, w: X - x, h: Y - y}}; }})()""")
        if not box:
            raise RuntimeError(f"no encontré {sels}")
        clip = {"x": max(0, box["x"] - pad), "y": max(0, box["y"] - pad),
                "width": box["w"] + 2 * pad, "height": box["h"] + 2 * pad + extra_bottom, "scale": 1}
        res = await self.send("Page.captureScreenshot", format="jpeg", quality=88, clip=clip,
                              captureBeyondViewport=True)
        out.write_bytes(base64.b64decode(res["data"]))
        await self.js("document.querySelectorAll('.gmark').forEach(m => m.remove())")
        print(f"  {out.name}  {int(clip['width'])}×{int(clip['height'])}  {out.stat().st_size // 1024} KB")


def api(base, path, token=None, body=None, method=None):
    req = urllib.request.Request(base + "/api/v1" + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json",
                                          **({"Authorization": "Bearer " + token} if token else {})})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


async def run(args):
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    pw = os.environ.get("SOMNOAI_GUIA_PASSWORD")
    if not pw:
        raise SystemExit("Falta la variable SOMNOAI_GUIA_PASSWORD con la clave del usuario.")

    # la noche para la revisión: SC4001E0 (unas 7 h de noche) con Fpz-Cz + EOG; se analiza si no existe
    token = api(args.url, "/auth/login", body={"username": args.user, "password": pw})["token"]
    recs = api(args.url, "/records", token)
    recs = recs.get("records", recs) if isinstance(recs, dict) else recs
    pick = next((r for r in recs if r["file_name"] == "SC4001E0-PSG.edf" and sorted(r["channels"]) == ["eog", "fpz"]), None)
    if not pick:
        pick = api(args.url, "/analyses", token, {"source": {"type": "catalog", "id": "SC4001E0-PSG.edf"},
                                                    "channels": ["fpz", "eog"]})
    for _ in range(600):
        pick = api(args.url, f"/records/{pick['id']}", token)
        if pick["status"] in ("done", "failed"):
            break
        time.sleep(1)
    if pick["status"] != "done":
        raise SystemExit(f"El análisis de la noche para la revisión no terminó: {pick.get('error') or pick['status']}")

    prof = tempfile.mkdtemp(prefix="somnoai-guia-chrome-")
    port = 9333
    chrome = subprocess.Popen([CHROME, "--headless=new", f"--remote-debugging-port={port}", f"--user-data-dir={prof}",
                               "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--lang=es-CO",
                               "--window-size=1440,1000", "about:blank"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(240):                       # el primer arranque de Chrome puede tardar
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=1)
                break
            except OSError:
                time.sleep(0.25)
        else:
            raise SystemExit("Chrome no abrió el puerto de depuración (¿está instalado en CHROME?).")
        tgt = json.load(urllib.request.urlopen(urllib.request.Request(
            f"http://127.0.0.1:{port}/json/new?about:blank", method="PUT")))
        async with connect(tgt["webSocketDebuggerUrl"], max_size=None) as ws:
            p = Page(ws)
            await p.send("Page.enable")
            await p.send("Runtime.enable")
            await p.send("Emulation.setLocaleOverride", locale="es-CO")
            await p.send("Emulation.setDeviceMetricsOverride", width=1440, height=1000, deviceScaleFactor=2, mobile=False)
            await p.send("Emulation.setEmulatedMedia", features=[{"name": "prefers-reduced-motion", "value": "reduce"},
                                                                  {"name": "prefers-color-scheme", "value": "light"}])
            await p.send("Page.addScriptToEvaluateOnNewDocument",
                         source="try{localStorage.setItem('maia_theme','light')}catch(e){}")
            await p.send("Page.navigate", url=args.url + "/")
            await p.wait("document.readyState === 'complete' && document.getElementById('btnIn')")
            await p.js(f"(() => {{ const s = document.createElement('style'); s.textContent = {json.dumps(HIDE_CSS)}; document.head.appendChild(s); }})()")

            # ── ingresar ──
            print("Ingresar")
            await p.js(f"document.getElementById('usr').value = {json.dumps(args.user)}; document.getElementById('pwd').value = {json.dumps(pw)}")
            await p.marks([(1, "#usr", "l"), (2, "#pwd", "l"), (3, "#btnIn", "l")])
            await p.shot(out / "ingresar.jpg", ["#vLogin .card"], pad=40)
            await p.click("#btnIn")
            await p.wait("!document.getElementById('vList').classList.contains('hidden') && document.querySelectorAll('#tb tr').length >= 5 && !document.querySelector('#tb .skel')")
            await asyncio.sleep(1.2)

            # ── registros ──
            print("Registros")
            await p.marks([(1, "#tTodo", "tr"), (2, "#tWhole", "tr"), (3, "#filt", "l"), (4, "#tb tr:first-child .pill", "r"),
                           (5, "#btnNew", "l"), (6, "#btnExportAll", "r")])
            await p.shot(out / "registros.jpg", ["#vList .stitle", "#vList > .panel:last-child"])

            # ── analizar: catálogo y canales ──
            print("Analizar nuevo")
            await p.click('nav button[data-v="vUp"]')
            await p.wait("document.querySelectorAll('#catList .night').length > 0")
            await p.click("#catList .night")
            await p.wait("!document.getElementById('cfgPanel').classList.contains('hidden')")
            await asyncio.sleep(0.8)
            await p.marks([(1, "#catSearch", "tl"), (2, "#catFilt", "tl"), (3, '#catList .night[aria-pressed="true"]', "l"),
                           (4, "#btnShowUpload", "l")])
            await p.shot(out / "analizar-catalogo.jpg", ["#vUp > .panel:not(#cfgPanel)"])
            await p.marks([(1, "#chSummary", "l"), (2, "#chGrid .chcard select", "r"), (3, "#comboBox", "tl"), (4, "#winMode", "tl"),
                           (5, "#lightsOff", "r"), (6, "#btnRun", "l")])
            await p.shot(out / "analizar-canales.jpg", ["#cfgPanel"])

            # ── subir un PSG propio ──
            print("Subir PSG")
            await p.click("#btnShowUpload")
            await p.wait("!document.getElementById('upArea').classList.contains('hidden')")
            doc = await p.send("DOM.getDocument")
            async def set_file(sel, path):
                node = await p.send("DOM.querySelector", nodeId=doc["root"]["nodeId"], selector=sel)
                await p.send("DOM.setFileInputFiles", nodeId=node["nodeId"], files=[str(path)])
            await set_file("#fileInput", DEMO / "SC4001E0-PSG.edf")
            await p.wait("document.getElementById('upBar').classList.contains('hidden') && !document.getElementById('fileSel').classList.contains('hidden')", 180, "subida del PSG")
            await set_file("#hypInput", DEMO / "SC4001EC-Hypnogram.edf")
            await p.wait("!document.getElementById('hypSel').classList.contains('hidden')", 60, "hipnograma")
            await asyncio.sleep(0.8)
            await p.marks([(1, "#dz", "l"), (2, "#fileSel", "l"), (3, "#hypSel", "l")])
            await p.shot(out / "subir-psg.jpg", ["#btnShowUpload", "#upArea"], pad=40)

            # ── análisis en curso ──
            print("Avance del análisis")
            await p.click('#winMode button[data-m="reference"]')
            await asyncio.sleep(0.3)
            await p.click("#btnRun")
            await p.wait("!document.getElementById('procModal').classList.contains('hidden')", 30)
            await p.wait("document.querySelector('#procSteps li.running') || document.getElementById('pwOpen')", 120, "pasos del análisis")
            await asyncio.sleep(0.3)
            await p.shot(out / "analisis-avance.jpg", ["#procModal .mbox"], pad=2)
            await p.wait("document.getElementById('pwOpen')", 600, "análisis")
            await p.click("#pwOpen")
            await asyncio.sleep(1)

            # ── resultados de la noche elegida ──
            print("Resultados")
            await p.js(f"MaiaReview.open({json.dumps(pick['id'])})")
            await p.wait("!document.getElementById('resBody').classList.contains('hidden') && document.querySelector('#c-hypno svg') && document.querySelector('#c-signal svg')", 60)
            await asyncio.sleep(1.5)
            await p.marks([(1, "#revStatus", "t"), (2, "#btnReview", "t"), (3, "#btnExport", "t"), (4, "#rCov", "tr"), (5, "#rFlag", "tr")])
            await p.shot(out / "resultados.jpg", ["#vRes .scope", "#clinView .tiles"])

            # ── revisión: unas decisiones para que se vean confirmadas y corregidas ──
            print("Revisión")
            await p.click("#btnReview")
            await p.wait("document.getElementById('btnReview').textContent.includes('Finalizar')", 30)
            await asyncio.sleep(0.6)
            await p.key("ArrowRight", shift=True)          # primera marcada pendiente
            for _ in range(4):
                await p.key("a")                           # confirmar la 1.ª opción (pasa a la siguiente pendiente)
            await p.key("b")                               # corregir a la 2.ª opción
            await p.key("a")
            await p.key("b")
            for _ in range(3):
                await p.key("a")
            await asyncio.sleep(1.2)
            await p.wait("document.getElementById('saveState').textContent.includes('Guardado')", 30, "guardado")

            # hipnograma con las marcas de revisión
            await p.marks([(1, "#hypView", "tl"), (2, "#hypLegend", "l"), (3, "text:#c-hypno text|revisar", "l"),
                           (4, "text:#c-hypno text|confianza", "l"), (5, "text:#c-hypno text|experto", "l")])
            await p.shot(out / "hipnograma.jpg", ["#clinView > .panel:has(#c-hypno)"])

            # el visor y el inspector sobre una marcada pendiente
            await p.key("ArrowRight", shift=True)
            await p.wait("document.querySelector('#iEvid .evid')", 60, "evidencia de la señal")
            await asyncio.sleep(1.2)
            await p.marks([(1, "#sigWin", "t"), (2, "#gainDown", "tl"), (3, "#zoomPlus", "tr"), (4, "#chToggles", "l"),
                           (5, "#c-signal", "l"), (6, "#iPrevF", "tl"), (7, "#epGoto", "r"), (8, "#saveState", "r")])
            await p.shot(out / "revision-visor.jpg", ["#wsPanel .revbar", "#wsPanel .ws > div:first-child"], pad=40)
            await p.marks([(1, "#insp section[aria-label='Época seleccionada']", "tr"),
                           (2, "#insp section[aria-label='Probabilidades del modelo']", "tr"),
                           (3, "#iTop2", "tl"), (4, "#insp .stagebtns", "tl"), (5, "#iRevert", "l"),
                           (6, "#insp section[aria-label='Evidencia de la señal']", "tr"), (7, "#iEvid .evhint", "l")])
            await p.shot(out / "revision-inspector.jpg", ["#insp"])

            # cola de épocas
            await p.marks([(1, "#qFilt", "tl"), (2, "#qBody tr:first-child", "l")])
            await p.shot(out / "cola.jpg", ["#clinView > .panel:has(#qBody)"])

            # arquitectura del sueño
            await p.shot(out / "arquitectura.jpg", ["#clinView > .panel:has(#archGrid) h3", "#archGrid"])

            # resumen antes de finalizar (no se finaliza)
            print("Finalizar")
            await p.click("#btnReview")
            await p.wait("!document.getElementById('finModal').classList.contains('hidden') && document.querySelector('#finBody table')", 30)
            await asyncio.sleep(0.8)
            await p.marks([(1, "#finModal .fincounts", "tl"), (2, "#finBody [data-undo]", "l"), (3, "#finConfirm", "tl")])
            await p.shot(out / "finalizar.jpg", ["#finModal .mbox"], pad=2)
            await p.click("#finCancel")
    finally:
        chrome.terminate()
        shutil.rmtree(prof, ignore_errors=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default="http://127.0.0.1:8000")
    ap.add_argument("--user", default="especialista")
    ap.add_argument("--out", default=str(ROOT / "frontend" / "guia" / "img"))
    asyncio.run(run(ap.parse_args()))
