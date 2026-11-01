"""Piezas del análisis: canales, EDF, épocas, adaptador del modelo, evidencia espectral,
hipnograma, ventana, métricas, revisión y catálogo."""
import io

import numpy as np
import pytest

from app import catalog, channels
from app.model.adapter import InvalidModelOutput, StagingRequest, StagingResult, validate
from app.pipeline import edf_io, epochs, hypnogram, metrics, review, spectral, window
from edf_utils import write_psg

SLEEP_EDF_LABELS = ["EEG Fpz-Cz", "EEG Pz-Oz", "EOG horizontal", "Resp oro-nasal",
                    "EMG submental", "Temp rectal", "Event marker"]


# ── canales (US-09, US-10) ────────────────────────────────────────────
def test_detecta_los_canales_de_sleep_edf():
    assert channels.detect(SLEEP_EDF_LABELS) == {
        "fpz": "EEG Fpz-Cz", "pz": "EEG Pz-Oz", "eog": "EOG horizontal", "emg": "EMG submental"}


def test_detecta_variantes_de_nombre():
    found = channels.detect(["FPZ-CZ", "Pz_Oz", "E1-E2", "Chin EMG", "ECG"])
    assert found == {"fpz": "FPZ-CZ", "pz": "Pz_Oz", "eog": "E1-E2", "emg": "Chin EMG"}


def test_separa_las_entradas_del_modelo_de_los_otros_canales():
    insp = channels.inspect(SLEEP_EDF_LABELS + ["EDF Annotations"])
    assert insp["total"] == 7 and insp["usable"] == 4          # «7 canales en el archivo · 4 utilizables»
    assert insp["unused"] == ["Resp oro-nasal", "Temp rectal", "Event marker"]
    assert insp["matched"]["fpz"] == "EEG Fpz-Cz"
    # solo los canales del mismo tipo se pueden asignar a una entrada
    assert insp["candidates"]["fpz"] == ["EEG Fpz-Cz", "EEG Pz-Oz"]
    assert insp["candidates"]["emg"] == ["EMG submental"]
    assert channels.kind_of("C4-M1") == "eeg" and channels.kind_of("LOC-M2") == "eog"
    assert channels.kind_of("ECG") is None and channels.kind_of("Temp rectal") is None


def test_las_12_combinaciones_usan_los_nombres_del_proyecto():
    expected = {"fpz", "pz", "eeg2", "fpz_eog", "pz_eog", "eeg2_eog", "fpz_emg", "pz_emg",
                "eeg2_emg", "fpz_eog_emg", "pz_eog_emg", "eeg2_eog_emg"}
    combos = set()
    for eeg in (["fpz"], ["pz"], ["fpz", "pz"]):
        for extra in ([], ["eog"], ["emg"], ["eog", "emg"]):
            combos.add(channels.combination_key(eeg + extra))
    assert combos == expected
    assert channels.mask(["pz", "emg"]) == [False, True, False, True]


@pytest.mark.parametrize("selected, cmap, message", [
    ([], None, "Seleccione al menos un canal"),
    (["eog", "emg"], None, "al menos un EEG"),
    (["fpz", "ecg"], None, "desconocido"),
    (["fpz", "emg"], {"emg": "Temp rectal"}, "no lo usa"),               # canal que no es del modelo
    (["fpz", "pz"], {"fpz": "EEG Pz-Oz"}, "dos entradas"),               # mismo canal en dos entradas
    (["fpz", "eog"], {"fpz": "EOG horizontal"}, "solo acepta un canal de EEG"),
])
def test_rechaza_asignaciones_invalidas(selected, cmap, message):
    with pytest.raises(channels.InvalidSelection, match=message):
        channels.resolve(selected, cmap, SLEEP_EDF_LABELS)


def test_canal_ausente_y_asignacion_manual():
    labels = ["C4-M1", "LOC-M2", "Flow"]
    with pytest.raises(channels.InvalidSelection, match="no tiene un canal reconocible"):
        channels.resolve(["fpz"], None, labels)
    assert channels.resolve(["fpz", "eog"], {"fpz": "C4-M1", "eog": "LOC-M2"}, labels) == {
        "fpz": "C4-M1", "eog": "LOC-M2"}
    with pytest.raises(channels.InvalidSelection, match="no está en el archivo"):
        channels.resolve(["fpz"], {"fpz": "F3-M2"}, labels)


# ── EDF y épocas ──────────────────────────────────────────────────────
def test_lee_el_encabezado(files):
    h = edf_io.read_header(str(files["psg"]))
    assert h["labels"][:3] == ["EEG Fpz-Cz", "EEG Pz-Oz", "EOG horizontal"]
    assert h["fs"]["EEG Fpz-Cz"] == 100 and h["fs"]["EMG submental"] == 1
    assert h["duration_s"] == 7200 and h["start_clock_s"] == 0
    assert h["patient"] == {"age": 33, "sex": "F"}
    assert not h["annotations_only"]
    assert edf_io.read_header(str(files["hyp"]))["annotations_only"]
    # el mismo encabezado sale de los primeros bytes (lectura por rango en S3)
    raw = files["psg"].read_bytes()[:edf_io.HEADER_PROBE]
    assert edf_io.parse_header(raw, files["psg"].stat().st_size)["labels"] == h["labels"]


def test_rechaza_lo_que_no_es_edf(tmp_path):
    bad = tmp_path / "x.edf"
    bad.write_bytes(b"esto no es un EDF" * 40)
    with pytest.raises(edf_io.InvalidFile):
        edf_io.read_header(str(bad))


def test_lee_la_ventana_a_frecuencia_nativa_y_la_divide_en_epocas(files):
    raw = edf_io.read_window(str(files["psg"]), ["EEG Fpz-Cz", "EMG submental"], 600, 1200)
    x, fs = raw["EEG Fpz-Cz"]
    assert fs == 100 and x.shape == (60000,)
    assert raw["EMG submental"][1] == 1 and raw["EMG submental"][0].shape == (600,)
    ep = epochs.split(x, fs, 20, 30)
    assert ep.shape == (20, 3000) and np.array_equal(ep[1], x[3000:6000])
    assert epochs.split(*raw["EMG submental"], 20, 30).shape == (20, 30)
    with pytest.raises(edf_io.InvalidFile, match="truncado"):
        epochs.split(x, fs, 21, 30)
    common, top = edf_io.to_common_rate(raw)
    assert top == 100 and common["EMG submental"].shape == (60000,)


def test_copia_un_edf_con_solo_algunos_canales(files, tmp_path):
    dst = tmp_path / "sub.edf"
    edf_io.subset_edf(str(files["psg"]), str(dst), ["EEG Pz-Oz", "Resp oro-nasal"])
    h = edf_io.read_header(str(dst))
    assert h["labels"] == ["EEG Pz-Oz", "Resp oro-nasal"] and h["duration_s"] == 7200
    a = edf_io.read_window(str(files["psg"]), ["EEG Pz-Oz"], 0, 300)["EEG Pz-Oz"][0]
    b = edf_io.read_window(str(dst), ["EEG Pz-Oz"], 0, 300)["EEG Pz-Oz"][0]
    assert np.array_equal(a, b)                         # mismas muestras, sin recuantizar


# ── adaptador del modelo (US-01) ──────────────────────────────────────
def _req(n=10):
    return StagingRequest(record_id="x", epochs={"fpz": np.zeros((n, 3000), np.float32)}, fs={"fpz": 100.0},
                          labels={"fpz": "EEG Fpz-Cz"}, start_epoch=0, lights_off_s=None)


def _probs(n=10):
    p = np.full((n, 5), 0.1)
    p[:, 2] = 0.6
    return p


def test_la_salida_valida_del_adaptador_pasa():
    stages, probs = validate(StagingResult(stages=[2] * 10, probs=_probs()), _req())
    assert stages.tolist() == [2] * 10 and np.allclose(probs.sum(axis=1), 1)
    assert _req().combination == "fpz" and _req().mask == [True, False, False, False]


@pytest.mark.parametrize("res, message", [
    (StagingResult(stages=[2] * 9, probs=_probs(9)), "faltan 1"),                       # épocas faltantes
    (StagingResult(stages=[2] * 10, probs=_probs()[:, :4]), "5 probabilidades"),
    (StagingResult(stages=[2] * 10, probs=_probs() * 0.9), "suman 0.900"),              # no suman 1
    (StagingResult(stages=[2] * 9, probs=_probs()), "estadio de 9"),
    (StagingResult(stages=[1] * 10, probs=_probs()), "más probable"),                   # estadio ≠ argmax
    (StagingResult(stages=[7] * 10, probs=_probs()), "fuera de 0"),
    (StagingResult(stages=[2] * 10, probs=-_probs()), "inválidas"),
])
def test_la_salida_invalida_del_adaptador_falla_con_un_mensaje_claro(res, message):
    with pytest.raises(InvalidModelOutput, match=message):
        validate(res, _req())


# ── evidencia espectral (US-11) ───────────────────────────────────────
@pytest.mark.parametrize("freq, band", [(2, 0), (6, 1), (10, 2), (13.5, 3), (20, 4)])
def test_la_potencia_relativa_cae_en_la_banda_de_la_frecuencia(freq, band):
    t = np.arange(3000) / 100
    x = 50 * np.sin(2 * np.pi * freq * t) + np.random.default_rng(0).normal(0, 1, 3000)
    p = spectral.band_powers(x, 100.0)
    assert p.shape == (1, 5) and int(np.nanargmax(p[0])) == band and p[0, band] > 0.8
    assert abs(np.nansum(p[0]) - 1) < 0.05


def test_perfiles_tipicos_por_estadio():
    powers = np.vstack([np.tile([0.6, 0.2, 0.1, 0.05, 0.05], (8, 1)), np.tile([0.2, 0.3, 0.1, 0.3, 0.1], (8, 1))])
    stages = [3] * 8 + [2] * 8
    typ = spectral.typical_profiles(powers, stages, [True] * 16, min_epochs=5)
    assert set(typ) == {2, 3} and typ[3]["values"][0] == 0.6 and typ[2]["n"] == 8
    assert spectral.typical_profiles(powers, stages, [False] * 16) == {}
    assert spectral.closest([0.55, 0.22, 0.1, 0.07, 0.06], typ, [2, 3]) == 3
    assert spectral.closest([0.25, 0.3, 0.1, 0.25, 0.1], typ, [3, 2]) == 2
    assert spectral.closest([0.25, 0.3, 0.1, 0.25, 0.1], typ, [3, 4]) is None     # sin perfil de REM


# ── hipnograma y ventana ──────────────────────────────────────────────
def test_lee_el_hipnograma_y_la_ventana_de_sueno(files):
    ref = hypnogram.read_reference(str(files["hyp"]), 240)
    assert (ref[:80] == 0).all() and ref[80] == 1
    assert ref[116] == 3 and ref[126] == 3          # S3 y S4 se unen en N3
    assert (ref[156:158] == -1).all()               # «Movement time» queda sin estadio
    assert hypnogram.sleep_window(ref) == (20, 220)


def test_modos_de_ventana(files):
    h = edf_io.read_header(str(files["psg"]))
    ref = hypnogram.read_reference(str(files["hyp"]), 240)
    assert window.resolve("reference", h, ref) == {"mode": "reference", "start_epoch": 20, "end_epoch": 220}
    assert window.resolve("full", h, None)["end_epoch"] == 240
    assert window.resolve("range", h, None, "00:30", "01:45") == {"mode": "range", "start_epoch": 60, "end_epoch": 210}
    with pytest.raises(edf_io.InvalidFile, match="fuera del registro"):
        window.resolve("range", h, None, "23:00", "01:00")
    with pytest.raises(edf_io.InvalidFile, match="necesita el hipnograma"):
        window.resolve("reference", h, None)
    with pytest.raises(edf_io.InvalidFile, match="demasiado corta"):
        window.resolve("range", h, None, "00:30", "00:35")
    assert window.lights_off("00:38", h) == 38 * 60


# ── métricas (US-05) ──────────────────────────────────────────────────
def test_arquitectura_del_sueno():
    # 4 de vigilia, sueño (con 2 de vigilia en medio), REM y 2 de vigilia al final
    s = [0, 0, 0, 0, 1, 2, 2, 3, 3, 0, 0, 2, 4, 4, 0, 0]
    m = metrics.architecture(s)
    assert m["tib_min"] == 8.0 and m["tst_min"] == 4.0
    assert m["sol_min"] == 2.0 and m["rem_latency_min"] == 4.0
    assert m["waso_min"] == 1.0 and m["awakenings"] == 1
    assert m["stages"]["N2"] == {"min": 1.5, "pct": 37.5}
    assert m["efficiency_pct"] == 50.0
    # con el apagado de luces en la época 2 el tiempo en cama se acorta
    assert metrics.architecture(s, lights_off_epoch=2)["tib_min"] == 7.0


def test_concordancia():
    ref = np.array([0, 1, 2, 2, 3, 4, -1])
    perfect = metrics.agreement(ref.clip(0), ref)
    assert perfect["accuracy"] == 1.0 and perfect["kappa"] == 1.0 and perfect["n_epochs"] == 6
    a = metrics.agreement([0, 2, 2, 2, 3, 4, 0], ref)
    assert a["accuracy"] == round(5 / 6, 3)
    assert a["confusion"][1][2] == 1                # un N1 de la referencia se predijo N2
    assert a["f1"]["N1"] == 0.0


# ── regla de confianza y revisión ─────────────────────────────────────
def test_decision_y_estado_de_la_revision():
    probs = np.array([[0.9, 0.05, 0.03, 0.01, 0.01],    # W segura
                      [0.30, 0.50, 0.15, 0.0, 0.05],     # N1 dudosa → revisar, 2.ª opción W
                      [0.0, 0.2, 0.7, 0.1, 0.0]])        # N2 segura
    ep = review.decide(probs.argmax(axis=1), probs, 0.65)
    assert ep["stage"] == [0, 1, 2] and ep["second"][1] == 0 and ep["review"] == [0, 1, 0]
    assert ep["confidence"] == [0.9, 0.5, 0.7]
    st = review.state(ep, {}, {}, 0.273)
    assert st["flagged"] == 1 and st["pending"] == 1 and st["whole_night_recommended"]
    assert st["status"] == "full_review_suggested"            # 1 de 3 > 27,3 %
    assert review.state(ep, {}, {}, 0.5)["status"] == "to_review"
    st = review.state(ep, {1: 0, 2: 3}, {}, 0.273)   # la marcada se corrige a W y otra se cambia
    assert st["resolved"] == 1 and st["pending"] == 0 and st["corrected"] == 2
    assert st["status"] == "in_review"
    assert review.final_stages(ep["stage"], {1: 0}) == [0, 0, 2]
    fin = review.state(ep, {1: 1}, {"by": "Dra. X", "at": "hoy"}, 0.273)
    assert fin["confirmed"] == 1 and fin["status"] == "finalized" and fin["finalized_by"] == "Dra. X"


def test_resumen_de_cambios_antes_de_finalizar():
    detail = {"epochs": {"stage": [0, 1, 2, 2], "review": [0, 1, 1, 0]},
              "night": {"start_clock_s": 3600, "epoch_s": 30}}
    corr = {1: {"stage": 1, "author": "A", "at": "t"}, 2: {"stage": 3, "author": "A", "at": "t"},
            3: {"stage": 4, "author": "B", "at": "t"}}
    s = review.changes(detail, corr)
    assert s["confirmed"] == 1 and s["corrected"] == 2 and s["pending"] == 0
    assert [(c["epoch"], c["model_stage"], c["reviewer_stage"]) for c in s["changes"]] == [(2, 2, 3), (3, 2, 4)]
    assert s["changes"][0]["clock_s"] == 3660


# ── catálogo (US-06) ──────────────────────────────────────────────────
def test_catalogo_local_empareja_psg_e_hipnograma(files, tmp_path):
    root = tmp_path / "cat"
    (root / "subsets" / "SC4001E0-pz").mkdir(parents=True)
    (root / "SC4001E0-PSG.edf").write_bytes(files["psg"].read_bytes())
    (root / "SC4001EC-Hypnogram.edf").write_bytes(files["hyp"].read_bytes())
    edf_io.subset_edf(str(files["psg"]), str(root / "subsets/SC4001E0-pz/SC4001E0-PSG.edf"), ["EEG Pz-Oz"])
    (root / "subsets/SC4001E0-pz/SC4001EC-Hypnogram.edf").write_bytes(files["hyp"].read_bytes())
    nights = catalog.Catalog(catalog.LocalStore(root)).nights()
    assert [(n["id"], n["subset"], n["has_hypnogram"]) for n in nights] == [
        ("SC4001E0-PSG.edf", False, True), ("subsets/SC4001E0-pz/SC4001E0-PSG.edf", True, True)]
    assert nights[0]["available"] == ["fpz", "pz", "eog", "emg"] and nights[1]["available"] == ["pz"]
    assert nights[0]["subject"] == 0 and nights[0]["split"] == "test" and nights[0]["label"] == "SC4001E0"


class FakeS3:
    """Lo justo de boto3 para el catálogo: listar, leer por rango y descargar."""

    def __init__(self, objects: dict[str, bytes]):
        self.objects, self.reads = objects, []

    def get_paginator(self, _):
        objs = self.objects

        class P:
            def paginate(self, Bucket, Prefix):
                yield {"Contents": [{"Key": k, "Size": len(v), "ETag": f'"{hash(v)}"'}
                                    for k, v in objs.items() if k.startswith(Prefix)]}
        return P()

    def get_object(self, Bucket, Key, Range):
        a, b = (int(x) for x in Range.removeprefix("bytes=").split("-"))
        self.reads.append((Key, b - a + 1))
        return {"Body": io.BytesIO(self.objects[Key][a:b + 1])}

    def head_object(self, Bucket, Key):
        return {"ContentLength": len(self.objects[Key])}

    def download_file(self, Bucket, Key, path, Callback=None):
        open(path, "wb").write(self.objects[Key])
        if Callback:
            Callback(len(self.objects[Key]))


def test_catalogo_en_s3_lee_solo_encabezados_y_descarga_al_analizar(files):
    psg, hyp = files["psg"].read_bytes(), files["hyp"].read_bytes()
    s3 = FakeS3({"noches/SC4001E0-PSG.edf": psg, "noches/SC4001EC-Hypnogram.edf": hyp, "otro/x.edf": psg})
    cat = catalog.Catalog(catalog.make_store("s3://bucket/noches", client=s3))
    nights = cat.nights()
    assert [n["id"] for n in nights] == ["SC4001E0-PSG.edf"] and nights[0]["has_hypnogram"]
    assert cat.source == {"kind": "s3", "location": "s3://bucket/noches/"}
    assert all(size <= edf_io.HEADER_PROBE for _, size in s3.reads)    # listar no baja la noche entera
    assert cat.nights() is nights                                      # en cache
    path = cat.fetch_psg(nights[0])
    assert path.read_bytes() == psg and cat.fetch_psg(nights[0]) == path    # segunda vez, de la cache local
    assert cat.fetch_hypnogram(nights[0]).read_bytes() == hyp


def test_psg_sin_canales_del_modelo(tmp_path):
    from conftest import START
    p = tmp_path / "solo-resp.edf"
    write_psg(p, {"Resp oro-nasal": (np.zeros(3600), 1.0), "Temp rectal": (np.zeros(3600), 1.0)}, START)
    insp = channels.inspect(edf_io.read_header(str(p))["labels"])
    assert insp["usable"] == 0 and insp["total"] == 2 and not insp["has_eeg"]
