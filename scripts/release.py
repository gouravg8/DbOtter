#!/usr/bin/env python3
"""Checks a release's files and writes its latest.json (the file installed apps read to
find updates). Used by .github/workflows/build.yml; runs locally too:

    python3 scripts/release.py <dir with the built files> <tag, e.g. v0.0.3>

Every installer must be there with its .sig, carry the tag's version, and have a signature
made by the project's updater key (the public half is in src-tauri/tauri.conf.json) over
exactly that file. Anything else stops the release: an installed app would refuse the
update anyway, after telling the user one is available.

A .sig is minisign: base64 of four lines (untrusted comment, signature, trusted comment,
global signature). The signature is Ed25519 over the BLAKE2b-512 of the file; the global
signature is over the signature plus the trusted comment.
"""

import base64
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

REPO = "gouravg8/DbOtter"
ROOT = Path(__file__).resolve().parent.parent

# updater platform -> installer file name pattern; a .deb install looks for its own
# entry first, then the plain linux one (the AppImage)
PLATFORMS = {
    "windows-x86_64": "DbOtter_{v}_x64-setup.exe",
    "windows-x86_64-nsis": "DbOtter_{v}_x64-setup.exe",
    "linux-x86_64": "DbOtter_{v}_amd64.AppImage",
    "linux-x86_64-appimage": "DbOtter_{v}_amd64.AppImage",
    "linux-x86_64-deb": "DbOtter_{v}_amd64.deb",
}


def fail(msg: str):
    sys.exit(f"release check failed: {msg}")


def minisign_lines(b64: str) -> list[str]:
    return base64.b64decode(b64.strip()).decode().splitlines()


def public_key() -> tuple[bytes, Ed25519PublicKey]:
    conf = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())
    raw = base64.b64decode(minisign_lines(conf["plugins"]["updater"]["pubkey"])[1])
    if raw[:2] != b"Ed" or len(raw) != 42:
        fail("the updater public key in tauri.conf.json isn't a minisign Ed25519 key")
    return raw[2:10], Ed25519PublicKey.from_public_bytes(raw[10:])


def check_signature(file: Path, sig_text: str, key_id: bytes, key: Ed25519PublicKey):
    lines = minisign_lines(sig_text)
    if len(lines) < 4 or not lines[2].startswith("trusted comment: "):
        fail(f"{file.name}.sig isn't a minisign signature")
    sig = base64.b64decode(lines[1])
    if sig[:2] != b"ED" or len(sig) != 74:
        fail(f"{file.name}.sig isn't a prehashed Ed25519 signature")
    if sig[2:10] != key_id:
        fail(f"{file.name} was signed with another key than the one in tauri.conf.json")
    try:
        key.verify(sig[10:], hashlib.blake2b(file.read_bytes()).digest())
        key.verify(base64.b64decode(lines[3]), sig[10:] + lines[2][len("trusted comment: "):].encode())
    except InvalidSignature:
        fail(f"{file.name} doesn't match its signature (a file from another build?)")


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    folder, tag = Path(sys.argv[1]), sys.argv[2]
    version = tag.removeprefix("v")
    conf_version = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())["version"]
    if version != conf_version:
        fail(f"tag {tag} but tauri.conf.json says {conf_version}: bump the version first")

    key_id, key = public_key()
    platforms = {}
    for platform, pattern in PLATFORMS.items():
        name = pattern.format(v=version)
        file, sig = folder / name, folder / f"{name}.sig"
        if not file.is_file() or not sig.is_file():
            fail(f"{name} or its .sig is missing from {folder}")
        sig_text = sig.read_text().strip()
        check_signature(file, sig_text, key_id, key)
        platforms[platform] = {
            "signature": sig_text,
            "url": f"https://github.com/{REPO}/releases/download/{tag}/{name}",
        }
        print(f"ok  {platform:24} {name}")

    latest = {
        "version": version,
        "notes": f"DbOtter {version}: see the release page for what's new.",
        "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platforms": platforms,
    }
    (folder / "latest.json").write_text(json.dumps(latest, indent=2) + "\n")
    print(f"wrote {folder / 'latest.json'}")


if __name__ == "__main__":
    main()
