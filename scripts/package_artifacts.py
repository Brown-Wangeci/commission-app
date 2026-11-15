"""Package the two serving artifacts into one reproducible archive.

The deployed scoring service must serve exactly the artifacts the reported
results come from. Rebuilding them on another platform gives a numerically
different model (docs/chapter5/evidence/hosted/scoring/model-comparison.md),
so they are published once as a GitHub release asset and the Render build
downloads that archive and checks its SHA-256 instead of rebuilding.

The archive is reproducible: entries are sorted, and every timestamp, owner
and permission is fixed, so the same files always give the same SHA-256.

Usage, from the repository root:
    python scripts/package_artifacts.py            write the archive and its .sha256
    python scripts/package_artifacts.py --check    only verify the recorded SHA-256
"""

from __future__ import annotations

import gzip
import hashlib
import io
import sys
import tarfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
ARTIFACT_DIRS = ["t0_none-isotonic-v1", "t7_none-isotonic-v1"]
ARCHIVE_NAME = "scoring-artifacts-v1.tar.gz"
CHECKSUM_FILE = REPO_ROOT / "artifacts" / f"{ARCHIVE_NAME}.sha256"
REQUIRED_FILES = ["calibrator.pkl", "manifest.json", "model.json"]


def artifact_files() -> list[Path]:
    """Every file in the two artifact folders, sorted; fails if one is missing."""
    files: list[Path] = []
    for name in ARTIFACT_DIRS:
        folder = REPO_ROOT / "artifacts" / name
        for required in REQUIRED_FILES:
            if not (folder / required).is_file():
                raise SystemExit(f"Missing {folder / required}; build or restore the artifacts first.")
        files.extend(sorted(path for path in folder.iterdir() if path.is_file()))
    return files


def tar_entry(path: Path) -> tuple[tarfile.TarInfo, bytes]:
    """A tar entry with fixed metadata, so only the content affects the hash."""
    data = path.read_bytes()
    info = tarfile.TarInfo(path.relative_to(REPO_ROOT).as_posix())
    info.size = len(data)
    info.mtime = 0
    info.mode = 0o644
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    return info, data


def archive_bytes(files: list[Path]) -> bytes:
    raw = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as zipped:
        with tarfile.open(fileobj=zipped, mode="w", format=tarfile.PAX_FORMAT) as tar:
            for path in files:
                info, data = tar_entry(path)
                tar.addfile(info, io.BytesIO(data))
    return raw.getvalue()


def recorded_hash() -> str:
    return CHECKSUM_FILE.read_text(encoding="utf-8").split()[0]


def main() -> None:
    digest = hashlib.sha256(archive_bytes(artifact_files())).hexdigest()
    if "--check" in sys.argv:
        matches = digest == recorded_hash()
        print(f"{ARCHIVE_NAME} from local artifacts: {digest} ({'matches' if matches else 'DIFFERS FROM'} the recorded hash)")
        raise SystemExit(0 if matches else 1)
    out = REPO_ROOT / ARCHIVE_NAME
    out.write_bytes(archive_bytes(artifact_files()))
    # Two spaces: the format `sha256sum -c` reads, as the Render build does.
    CHECKSUM_FILE.write_text(f"{digest}  {ARCHIVE_NAME}\n", encoding="utf-8", newline="\n")
    print(f"wrote {out.name} ({out.stat().st_size} bytes), sha256 {digest}")


if __name__ == "__main__":
    main()
