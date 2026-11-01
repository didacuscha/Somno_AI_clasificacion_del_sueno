"""Noches de prueba con un subconjunto aleatorio de los canales del modelo (US-08).

Para mostrar que el modelo funciona con cualquier combinación de canales, crea ~50
noches a partir de las noches de test del catálogo, cada una con una combinación
válida (siempre con al menos un EEG) que no es la de los cuatro canales: de las
32 noches × 12 combinaciones = 384 posibles se toma una muestra, repartida por
igual entre las 11 combinaciones incompletas. Cada noche nueva es una copia exacta
del PSG original (mismas muestras, sin recuantizar) sin los canales del modelo que
le «faltan»; conserva los que el modelo no usa (respiración, temperatura,
marcadores) y lleva el hipnograma de su noche como referencia.

Quedan en <destino>/<noche>-<combinación>/ (p. ej. subsets/SC4001E0-fpz_eog/), que el
catálogo muestra como «subconjunto» con sus canales disponibles, y en
<destino>/manifest.json queda la lista de lo que se generó.

    cd backend
    .venv/bin/python scripts/make_subset_nights.py --dry-run          # ver el plan
    .venv/bin/python scripts/make_subset_nights.py                    # catálogo configurado → <catálogo>/subsets/
    .venv/bin/python scripts/make_subset_nights.py \\
        --source s3://<bucket>/<prefijo>/ --dest s3://<bucket>/<prefijo>/subsets/

Con S3 usa las credenciales de AWS del entorno (nunca en el repositorio).
"""
import argparse
import json
import random
import shutil
import sys
import tempfile
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))      # backend/ (para importar app)

from app import catalog, channels, config  # noqa: E402
from app.pipeline import edf_io  # noqa: E402

ALL = list(config.SLOTS)
COMBOS = [c for c in ([*eeg, *extra] for eeg in (["fpz"], ["pz"], ["fpz", "pz"])
                      for extra in ([], ["eog"], ["emg"], ["eog", "emg"])) if len(c) < len(ALL)]


def plan(nights: list[dict], count: int, seed: int) -> list[tuple[dict, list[str]]]:
    """(noche, combinación) sin repetir, rotando por las combinaciones para que todas salgan."""
    rng = random.Random(seed)
    pool = {tuple(c): [n for n in nights if set(c) <= set(n["available"])] for c in COMBOS}
    for v in pool.values():
        rng.shuffle(v)
    order = [tuple(c) for c in COMBOS]
    rng.shuffle(order)
    out, i = [], 0
    while len(out) < count and any(pool.values()):
        combo = order[i % len(order)]
        if pool[combo]:
            out.append((pool[combo].pop(), list(combo)))
        i += 1
    return sorted(out, key=lambda x: (x[0]["id"], channels.combination_key(x[1])))


def folder_name(night: dict, combo: list[str]) -> str:
    return f"{night['label']}-{channels.combination_key(combo)}"


def build(src: catalog.Catalog, night: dict, combo: list[str], work: Path) -> Path:
    """Escribe en work/<carpeta>/ el PSG con solo esos canales del modelo y su hipnograma."""
    out = work / folder_name(night, combo)
    out.mkdir(parents=True, exist_ok=True)
    psg = src.fetch_psg(night)
    matched = night["channels"]["matched"]
    keep = [matched[s] for s in combo] + night["channels"]["unused"]
    edf_io.subset_edf(str(psg), str(out / night["psg"]), keep)
    hyp = src.fetch_hypnogram(night)
    if hyp:
        shutil.copyfile(hyp, out / night["hypnogram"])
    return out


def exists(dest, name: str, night: dict) -> bool:
    if isinstance(dest, catalog.S3Store):
        try:
            dest.client.head_object(Bucket=dest.bucket, Key=f"{dest.prefix}{name}/{night['psg']}")
            return True
        except Exception:
            return False
    return (dest.root / name / night["psg"]).exists()


def publish(dest, folder: Path):
    for f in folder.iterdir():
        if isinstance(dest, catalog.S3Store):
            dest.client.upload_file(str(f), dest.bucket, f"{dest.prefix}{folder.name}/{f.name}")
        else:
            (dest.root / folder.name).mkdir(parents=True, exist_ok=True)
            shutil.copyfile(f, dest.root / folder.name / f.name)


def write_manifest(dest, entries: list[dict]):
    body = json.dumps({"created_at": datetime.now().isoformat(timespec="seconds"), "nights": entries},
                      indent=2, ensure_ascii=False)
    if isinstance(dest, catalog.S3Store):
        dest.client.put_object(Bucket=dest.bucket, Key=f"{dest.prefix}manifest.json", Body=body.encode(),
                               ContentType="application/json")
    else:
        dest.root.mkdir(parents=True, exist_ok=True)
        (dest.root / "manifest.json").write_text(body)


def main(argv=None) -> list[dict]:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--source", default=config.CATALOG, help="catálogo de origen (carpeta o s3://bucket/prefijo/)")
    ap.add_argument("--dest", help="destino (por defecto <origen>/subsets/)")
    ap.add_argument("--count", type=int, default=50, help="noches a crear (por defecto 50)")
    ap.add_argument("--seed", type=int, default=2026, help="semilla: mismo valor, mismo plan")
    ap.add_argument("--split", default="test", choices=["test", "dev", "any"],
                    help="noches de origen según la partición del proyecto (por defecto test)")
    ap.add_argument("--overwrite", action="store_true", help="rehacer las que ya existen")
    ap.add_argument("--dry-run", action="store_true", help="solo mostrar el plan")
    args = ap.parse_args(argv)

    src = catalog.Catalog(catalog.make_store(args.source))
    dest_loc = args.dest or (args.source.rstrip("/") + "/" + config.SUBSET_PREFIX)
    dest = catalog.make_store(dest_loc)
    nights = [n for n in src.nights(refresh=True) if not n["subset"]
              and (args.split == "any" or n["split"] == args.split)
              and {"fpz", "pz"} & set(n["available"])]
    if not nights:
        sys.exit(f"No hay noches de origen en {args.source} (partición {args.split}).")
    todo = plan(nights, args.count, args.seed)
    print(f"{len(nights)} noches de origen en {src.store.location} · {len(todo)} subconjuntos → {dest.location}")
    entries = []
    with tempfile.TemporaryDirectory(prefix="subsets_") as tmp:
        for k, (night, combo) in enumerate(todo, 1):
            name = folder_name(night, combo)
            entry = {"folder": name, "source": night["id"], "channels": combo,
                     "combination": channels.combination_key(combo),
                     "combination_name": channels.combination_name(combo),
                     "psg": night["psg"], "hypnogram": night["hypnogram"]}
            entries.append(entry)
            line = f"[{k:>2}/{len(todo)}] {name:<28} {entry['combination_name']}"
            if args.dry_run:
                print(line)
                continue
            if not args.overwrite and exists(dest, name, night):
                print(line, "· ya existe")
                continue
            folder = build(src, night, combo, Path(tmp))
            publish(dest, folder)
            shutil.rmtree(folder, ignore_errors=True)
            print(line, "· listo")
    if not args.dry_run:
        write_manifest(dest, entries)
        print(f"Listo: {len(entries)} noches en {dest.location} (manifest.json con el detalle).")
    return entries


if __name__ == "__main__":
    main()
