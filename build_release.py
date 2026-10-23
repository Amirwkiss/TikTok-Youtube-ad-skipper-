from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json

root = Path(__file__).resolve().parent
version = json.loads((root / "manifest.json").read_text(encoding="utf-8"))["version"]
desktop = [
    "audio-fingerprint.js", "audio-references.js", "background.js", "cloud.html", "cloud.js", "detector.js", "manifest.json",
    "offscreen.html", "offscreen.js", "PRIVACY.md", "README.md",
    "RELEASE_NOTES.md", "tiktok.js", "youtube.js"
]

for label, files, base in [("ad-skipper", desktop, root)]:
    archive = root.parent / f"{label}-{version}-test.zip"
    with ZipFile(archive, "w", ZIP_DEFLATED) as zipped:
        for name in files:
            zipped.write(base / name, name)
    with ZipFile(archive) as check:
        assert check.testzip() is None
        assert json.loads(check.read("manifest.json"))["version"] == version
    print(f"{archive}: {archive.stat().st_size} bytes")
