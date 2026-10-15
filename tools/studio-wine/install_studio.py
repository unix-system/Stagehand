#!/usr/bin/env python3
"""Install Roblox Studio (WindowsStudio64) into a versions directory, the way Vinegar does it.

Standard library only. Run with `python3 -I`.

Steps:
  1. resolve the current deployment GUID from clientsettings (or --guid)
  2. fetch <guid>-rbxPkgManifest.txt from a setup mirror
  3. learn the package -> directory map from the installer executable's .rdata (fallback: built-in map)
  4. download (md5-verified, cached) and extract every package; Roblox zips use '\\' in entry names
  5. write AppSettings.xml and ClientSettings/ClientAppSettings.json (renderer FFlags)

    python3 -I tools/studio-wine/install_studio.py [--renderer opengl|d3d11|d3d11fl10|vulkan] [--guid version-...]
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import hashlib
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

BINARY_TYPE = "WindowsStudio64"
VERSION_URLS = [
    "https://clientsettingscdn.roblox.com/v2/client-version/" + BINARY_TYPE,
    "https://clientsettings.roblox.com/v2/client-version/" + BINARY_TYPE,
]
MIRRORS = [
    "https://setup.rbxcdn.com",
    "https://roblox-setup.cachefly.net",
    "https://s3.amazonaws.com/setup.roblox.com",
]
RENDERERS = {"d3d11": "D3D11", "vulkan": "Vulkan", "d3d11fl10": "D3D11FL10", "opengl": "OpenGL"}
APP_SETTINGS = (
    '<?xml version="1.0" encoding="UTF-8"?>\r\n<Settings>\r\n'
    "        <ContentFolder>content</ContentFolder>\r\n"
    "        <BaseUrl>http://www.roblox.com</BaseUrl>\r\n</Settings>\r\n"
)
# Known Studio layout, used only if the installer's embedded map cannot be read.
FALLBACK_DIRS = {
    "ApplicationConfig.zip": "ApplicationConfig/", "BuiltInPlugins.zip": "BuiltInPlugins/",
    "BuiltInStandalonePlugins.zip": "BuiltInStandalonePlugins/", "Libraries.zip": "",
    "LibrariesQt5.zip": "", "Plugins.zip": "Plugins/", "Qml.zip": "Qml/", "RibbonConfig.zip": "RibbonConfig/",
    "RobloxStudio.zip": "", "StudioFonts.zip": "StudioFonts/", "WebView2.zip": "",
    "WebView2RuntimeInstaller.zip": "WebView2RuntimeInstaller/", "redist.zip": "", "shaders.zip": "shaders/",
    "ssl.zip": "ssl/", "content-avatar.zip": "content/avatar/", "content-configs.zip": "content/configs/",
    "content-fonts.zip": "content/fonts/", "content-models.zip": "content/models/",
    "content-qt_translations.zip": "content/qt_translations/", "content-sky.zip": "content/sky/",
    "content-sounds.zip": "content/sounds/", "content-studio_svg_textures.zip": "content/studio_svg_textures/",
    "content-terrain.zip": "PlatformContent/pc/terrain/", "content-textures2.zip": "content/textures/",
    "content-textures3.zip": "PlatformContent/pc/textures/", "content-translations.zip": "content/translations/",
    "content-platform-fonts.zip": "PlatformContent/pc/fonts/",
    "content-platform-dictionaries.zip": "PlatformContent/pc/shared_compression_dictionaries/",
    "content-api-docs.zip": "content/api_docs/", "extracontent-luapackages.zip": "ExtraContent/LuaPackages/",
    "extracontent-models.zip": "ExtraContent/models/", "extracontent-places.zip": "ExtraContent/places/",
    "extracontent-scripts.zip": "ExtraContent/scripts/", "extracontent-textures.zip": "ExtraContent/textures/",
    "extracontent-translations.zip": "ExtraContent/translations/",
}


def log(msg: str) -> None:
    print(f"[install-studio] {msg}", file=sys.stderr, flush=True)


def http_get(url: str, retries: int = 3, timeout: int = 60) -> bytes:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "stagehand-studio-wine"}), timeout=timeout) as r:
                return r.read()
        except (urllib.error.URLError, TimeoutError, OSError) as e:  # noqa: PERF203
            last = e
            time.sleep(2 ** attempt)
    raise RuntimeError(f"GET {url} failed: {last}")


def download(url: str, dest: Path, retries: int = 3) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    last: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "stagehand-studio-wine"}), timeout=120) as r, part.open("wb") as f:
                shutil.copyfileobj(r, f, 1 << 20)
            part.replace(dest)
            return
        except (urllib.error.URLError, TimeoutError, OSError) as e:  # noqa: PERF203
            last = e
            time.sleep(2 ** attempt)
    raise RuntimeError(f"download {url} failed: {last}")


def md5sum(path: Path) -> str:
    h = hashlib.md5()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def resolve_guid(explicit: str | None) -> tuple[str, str]:
    if explicit:
        return explicit, "?"
    for url in VERSION_URLS:
        try:
            info = json.loads(http_get(url))
            return info["clientVersionUpload"], info.get("version", "?")
        except Exception as e:  # noqa: BLE001
            log(f"version lookup via {url} failed: {e}")
    raise SystemExit("could not resolve the Studio version")


def pick_mirror() -> str:
    for m in MIRRORS:
        try:
            http_get(m + "/version", retries=1, timeout=15)
            return m
        except Exception:  # noqa: BLE001
            continue
    raise SystemExit("no reachable setup mirror")


def package_url(mirror: str, guid: str, name: str) -> str:
    return f"{mirror}/channel/common/{guid}-{name}"


def parse_manifest(text: str) -> list[tuple[str, str, int, int]]:
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    if not lines or lines[0] != "v0":
        raise SystemExit(f"unexpected manifest header {lines[:1]}")
    body = lines[1:]
    if len(body) % 4:
        raise SystemExit("manifest is not groups of 4 lines")
    return [(body[i], body[i + 1], int(body[i + 2]), int(body[i + 3])) for i in range(0, len(body), 4)]


JSON_BLOB = re.compile(rb'\x00(\{"[^\x00]{20,}?"\})\x00')


def scan_directory_map(installer: bytes) -> dict[str, str] | None:
    """The installer embeds `{"Pkg.zip": "dir\\", ...}` as a NUL-delimited string (see rbxbin)."""
    for m in JSON_BLOB.finditer(installer):
        try:
            d = json.loads(m.group(1))
        except ValueError:
            continue
        if isinstance(d, dict) and "RobloxStudio.zip" in d:
            return {k: v.replace("\\", "/") for k, v in d.items()}
    return None


def extract(zip_path: Path, dest: Path) -> int:
    dest.mkdir(parents=True, exist_ok=True)
    root = dest.resolve()
    n = 0
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            name = info.filename.replace("\\", "/")
            if not name or name.endswith("/"):
                continue
            target = (dest / name).resolve()
            if root != target and root not in target.parents:
                raise SystemExit(f"refusing to extract {info.filename!r} outside {dest}")
            target.parent.mkdir(parents=True, exist_ok=True)
            with z.open(info) as src, target.open("wb") as out:
                shutil.copyfileobj(src, out, 1 << 20)
            n += 1
    return n


def renderer_fflags(renderer: str) -> dict[str, bool]:
    want = RENDERERS[renderer]
    flags: dict[str, bool] = {}
    for r in RENDERERS.values():
        flags["FFlagDebugGraphicsPrefer" + r] = r == want
        flags["FFlagDebugGraphicsDisable" + r] = r != want
    return flags


def coerce(v: str) -> object:
    if v.lower() in ("true", "false"):
        return v.lower() == "true"
    try:
        return int(v)
    except ValueError:
        return v


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    home = Path(os.environ.get("STAGEHAND_STUDIO_HOME") or Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share") / "stagehand-studio")
    ap.add_argument("--home", type=Path, default=home, help=f"install root (default {home})")
    ap.add_argument("--guid", help="deployment GUID (version-...) instead of the current LIVE one")
    ap.add_argument("--renderer", choices=sorted(RENDERERS), default="opengl")
    ap.add_argument("--fflag", action="append", default=[], metavar="KEY=VALUE", help="extra FFlag (repeatable)")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--prune", action="store_true", help="remove other installed versions")
    ap.add_argument("--flags-only", action="store_true", help="only rewrite ClientAppSettings.json of the installed version")
    a = ap.parse_args()

    versions = a.home / "versions"
    cache = a.home / "cache" / "packages"
    guid, version = resolve_guid(a.guid)
    dest = versions / guid
    log(f"studio {version} ({guid}) -> {dest}")

    if not a.flags_only and not (dest / "RobloxStudioBeta.exe").exists():
        mirror = pick_mirror()
        log(f"mirror {mirror}")
        pkgs = parse_manifest(http_get(package_url(mirror, guid, "rbxPkgManifest.txt")).decode())
        pkgs = [p for p in pkgs if p[0] != "RobloxStudioInstaller.exe"]
        pkgs.sort(key=lambda p: p[2])
        try:
            dirs = scan_directory_map(http_get(package_url(mirror, guid, "RobloxStudioInstaller.exe"))) or {}
            log(f"directory map from installer: {len(dirs)} entries")
        except Exception as e:  # noqa: BLE001
            log(f"installer map unavailable ({e}); using built-in map")
            dirs = {}
        if not dirs:
            dirs = dict(FALLBACK_DIRS)
        unknown = [p[0] for p in pkgs if p[0] not in dirs]
        if unknown:
            raise SystemExit(f"no directory mapping for packages: {unknown}")

        total = sum(p[2] for p in pkgs)
        log(f"{len(pkgs)} packages, {total / 1e6:.0f} MB to download")
        staging = versions / (guid + ".partial")
        if staging.exists():
            shutil.rmtree(staging)

        def job(p: tuple[str, str, int, int]) -> str:
            name, sum_, _, _ = p
            src = cache / sum_
            if not (src.exists() and md5sum(src) == sum_):
                download(package_url(mirror, guid, name), src)
                got = md5sum(src)
                if got != sum_:
                    raise RuntimeError(f"{name}: md5 {got} != {sum_}")
            n = extract(src, staging / dirs[name])
            return f"{name}: {n} files -> {dirs[name] or '.'}"

        with cf.ThreadPoolExecutor(max_workers=a.jobs) as ex:
            for msg in ex.map(job, pkgs):
                log(msg)
        (staging / "AppSettings.xml").write_text(APP_SETTINGS, newline="")
        staging.rename(dest)
        log("installed")

    if not (dest / "RobloxStudioBeta.exe").exists():
        raise SystemExit(f"{dest} has no RobloxStudioBeta.exe")

    flags: dict[str, object] = renderer_fflags(a.renderer)
    for kv in a.fflag:
        k, _, v = kv.partition("=")
        flags[k] = coerce(v)
    cs = dest / "ClientSettings"
    cs.mkdir(exist_ok=True)
    (cs / "ClientAppSettings.json").write_text(json.dumps(flags, indent=2, sort_keys=True) + "\n")
    log(f"renderer {RENDERERS[a.renderer]}; wrote {cs / 'ClientAppSettings.json'}")

    if a.prune:
        for other in versions.iterdir():
            if other.is_dir() and other.name != guid:
                log(f"pruning {other}")
                shutil.rmtree(other)
    print(dest)
    return 0


if __name__ == "__main__":
    sys.exit(main())
