"""Piezas del análisis: canales, encabezado EDF, hipnograma, ventana, métricas y revisión."""
import numpy as np
import pytest

from app import channels
from app.pipeline import edf_io, hypnogram, metrics, review, window

SLEEP_EDF_LABELS = ["EEG Fpz-Cz", "EEG Pz-Oz", "EOG horizontal", "Resp oro-nasal",
                    "EMG submental", "Temp rectal", "Event marker"]


# ── canales ───────────────────────────────────────────────────────────
def test_detecta_los_canales_de_sleep_edf():
    assert channels.detect(SLEEP_EDF_LABELS) == {
        "fpz": "EEG Fpz-Cz", "pz": "EEG Pz-Oz", "eog": "EOG horizontal", "emg": "EMG submental"}


def test_detecta_variantes_de_nombre():
    found = channels.detect(["FPZ-CZ", "Pz_Oz", "E1-E2", "Chin EMG", "ECG"])
    assert found == {"fpz": "FPZ-CZ", "pz": "Pz_Oz", "eog": "E1-E2", "emg": "Chin EMG"}


def test_las_12_combinaciones_usan_los_nombres_del_proyecto():
    expected = {"fpz", "pz", "eeg2", "fpz_eog", "pz_eog", "eeg2_eog", "fpz_emg", "pz_emg",
                "eeg2_emg", "fpz_eog_emg", "pz_eog_emg", "eeg2_eog_emg"}
    combos = set()
    for eeg in (["fpz"], ["pz"], ["fpz", "pz"]):
        for extra in ([], ["eog"], ["emg"], ["eog", "emg"]):
            combos.add(channels.combination_key(eeg + extra))
    assert combos == expected
    assert channels.mask(["pz", "emg"]) == [False, True, False, True]


@pytest.mark.parametrize("selected, message", [
    ([], "al menos un canal"),
    (["eog", "emg"], "al menos un EEG"),
    (["fpz", "ecg"], "desconocido"),
])
def test_rechaza_selecciones_invalidas(selected, message):
    with pytest.raises(channels.InvalidSelection, match=message):
        channels.resolve(selected, None, SLEEP_EDF_LABELS)


def test_canal_ausente_y_asignacion_manual():
    labels = ["C4-M1", "LOC-M2"]
    with pytest.raises(channels.InvalidSelection, match="no tiene un canal reconocible"):
        channels.resolve(["fpz"], None, labels)
    assert channels.resolve(["fpz"], {"fpz": "C4-M1"}, labels) == {"fpz": "C4-M1"}
    with pytest.raises(channels.InvalidSelection, match="no está en el archivo"):
        channels.resolve(["fpz"], {"fpz": "F3-M2"}, labels)


# ── EDF ───────────────────────────────────────────────────────────────
def test_lee_el_encabezado(files):
    h = edf_io.read_header(str(files["psg"]))
    assert h["labels"][:3] == ["EEG Fpz-Cz", "EEG Pz-Oz", "EOG horizontal"]
    assert h["fs"]["EEG Fpz-Cz"] == 100 and h["fs"]["EMG submental"] == 1
    assert h["duration_s"] == 7200 and h["start_clock_s"] == 0
    assert h["patient"] == {"age": 33, "sex": "F"}
    assert not h["annotations_only"]
    assert edf_io.read_header(str(files["hyp"]))["annotations_only"]


def test_rechaza_lo_que_no_es_edf(tmp_path):
    bad = tmp_path / "x.edf"
    bad.write_bytes(b"esto no es un EDF" * 40)
    with pytest.raises(edf_io.InvalidFile):
        edf_io.read_header(str(bad))


def test_carga_la_ventana_alineada(files):
    series, sfreq = edf_io.load_signals(str(files["psg"]), ["EEG Fpz-Cz", "EMG submental"], 600, 1200)
    assert sfreq == 100
    assert series["EEG Fpz-Cz"].shape == (60000,) == series["EMG submental"].shape


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


# ── métricas ──────────────────────────────────────────────────────────
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
    ep = review.decide(probs, 0.65)
    assert ep["stage"] == [0, 1, 2] and ep["second"][1] == 0 and ep["review"] == [0, 1, 0]
    st = review.state(ep, {}, {}, 0.273)
    assert st["flagged"] == 1 and st["pending"] == 1 and st["whole_night_recommended"]
    st = review.state(ep, {1: 0, 2: 3}, {}, 0.273)   # la marcada se corrige a W y otra se cambia
    assert st["resolved"] == 1 and st["pending"] == 0 and st["corrected"] == 2
    assert st["status"] == "in_progress"
    assert review.final_stages(ep["stage"], {1: 0}) == [0, 0, 2]
    assert review.state(ep, {1: 1}, {"by": "Dra. X", "at": "hoy"}, 0.273)["confirmed"] == 1
