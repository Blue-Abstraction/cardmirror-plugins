import os, re, sys, json, shutil, hashlib, time, subprocess, platform
from pathlib import Path
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

APP_NAME = "CardMirror Feature Installer"
INSTALLER_VERSION = "1.2.6"
FEATURE_ROOT = "cardmirror-features"
BEGIN = "<!-- CardMirror Feature Installer BEGIN -->"
END = "<!-- CardMirror Feature Installer END -->"

def app_dir():
    # PyInstaller one-file builds extract bundled resources to sys._MEIPASS.
    # Source/development builds continue to use the script directory.
    frozen_root = getattr(sys, "_MEIPASS", None)
    return Path(frozen_root).resolve() if frozen_root else Path(__file__).resolve().parent

def load_manifests():
    out = []
    root = app_dir() / "plugins"
    if not root.exists():
        return out
    for mf in sorted(root.glob("*/manifest.json")):
        try:
            data = json.loads(mf.read_text(encoding="utf-8"))
            data["_dir"] = mf.parent
            if data.get("id") and data.get("name") and data.get("file"):
                out.append(data)
        except Exception:
            pass
    return out

PLUGINS = load_manifests()

def renderer_from_selection(p):
    p = Path(p).expanduser()
    # Windows/Linux unpacked CardMirror root.
    candidates = [
        p / "resources" / "renderer",
        # macOS .app bundle.
        p / "Contents" / "Resources" / "renderer",
        # User may select Resources or renderer directly.
        p / "renderer",
        p,
    ]
    for r in candidates:
        if (r / "index.html").is_file():
            return r.resolve()
    return None

def display_root(renderer):
    r = Path(renderer)
    # renderer -> resources -> app root (Windows)
    if r.name.lower() == "renderer" and r.parent.name.lower() == "resources":
        parent = r.parent.parent
        if parent.name == "Contents" and parent.parent.suffix.lower() == ".app":
            return parent.parent
        return parent
    return r

def looks_like_cardmirror(renderer):
    if not renderer or not (renderer / "index.html").is_file():
        return False
    root = display_root(renderer)
    if sys.platform == "darwin":
        return root.suffix.lower() == ".app" or "cardmirror" in root.name.lower()
    return (root / "cardmirror.exe").exists() or "cardmirror" in root.name.lower()

def find_candidates():
    found = []
    if sys.platform == "win32":
        bases = [
            os.environ.get("LOCALAPPDATA"),
            os.environ.get("PROGRAMFILES"),
            os.environ.get("PROGRAMFILES(X86)"),
        ]
        for raw in filter(None, bases):
            b = Path(raw)
            guesses = [
                b / "CardMirror", b / "cardmirror",
                b / "Programs" / "CardMirror", b / "Programs" / "cardmirror"
            ]
            for g in guesses:
                r = renderer_from_selection(g)
                if r and looks_like_cardmirror(r):
                    found.append(r)
            prog = b / "Programs"
            if prog.exists():
                try:
                    for exe in prog.glob("**/cardmirror.exe"):
                        r = renderer_from_selection(exe.parent)
                        if r and looks_like_cardmirror(r):
                            found.append(r)
                except Exception:
                    pass
    elif sys.platform == "darwin":
        guesses = [
            Path("/Applications/CardMirror.app"),
            Path.home() / "Applications" / "CardMirror.app",
        ]
        for g in guesses:
            r = renderer_from_selection(g)
            if r and looks_like_cardmirror(r):
                found.append(r)

    out, seen = [], set()
    for r in found:
        key = str(r).lower()
        if key not in seen:
            seen.add(key); out.append(r)
    return out

def is_running():
    try:
        if sys.platform == "win32":
            out = subprocess.check_output(
                ["tasklist", "/FI", "IMAGENAME eq cardmirror.exe"],
                text=True, stderr=subprocess.DEVNULL
            )
            return "cardmirror.exe" in out.lower()
        if sys.platform == "darwin":
            # Exact main-process match. Using `pgrep -ifl CardMirror` also
            # matches this installer because its own name contains CardMirror.
            result = subprocess.run(["pgrep", "-x", "CardMirror"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return result.returncode == 0
    except Exception:
        return False
    return False

def ensure_install_writable(renderer):
    renderer = Path(renderer)
    probe = renderer / ".cardmirror-feature-installer-write-test"
    try:
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
    except Exception as exc:
        root = display_root(renderer)
        if sys.platform == "darwin":
            raise RuntimeError(
                f"CardMirror is not writable at {root}.\n\n"
                "Move CardMirror.app to a location your user account can modify "
                "(for example ~/Applications), or adjust its permissions, then try again."
            ) from exc
        raise RuntimeError(f"CardMirror is not writable at {root}. Try running the installer with appropriate permissions.") from exc

def resign_macos(renderer):
    if sys.platform != "darwin":
        return
    app = display_root(renderer)
    if app.suffix.lower() != ".app":
        return
    # Editing resources invalidates the original macOS code signature. An
    # ad-hoc local signature lets the modified app launch normally again.
    proc = subprocess.run(
        ["codesign", "--force", "--deep", "--sign", "-", str(app)],
        capture_output=True, text=True
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "codesign failed").strip()
        raise RuntimeError(
            "CardMirror was patched, but macOS could not re-sign the modified app.\n\n" + detail
        )

def installed_manifest_path(renderer):
    return renderer / FEATURE_ROOT / "installed.json"

def read_installed(renderer):
    p = installed_manifest_path(renderer)
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}

def clean_injections(text):
    # Remove unified installer block.
    text = re.sub(re.escape(BEGIN) + r".*?" + re.escape(END), "", text, flags=re.I | re.S)

    # Migrate/remove all old standalone Round Report patch blocks.
    old_rr = (
        r'\s*<!-- Round Report Creator patch -->\s*'
        r'<script\s+type="module"\s+src="\./roundreport/round-report-plugin\.js(?:\?[^"]*)?"></script>\s*'
        r'<!-- Round Report Creator patch -->\s*'
    )
    text = re.sub(old_rr, "\n", text, flags=re.I)
    return text

def install_selected(renderer, selected_ids):
    renderer = Path(renderer)
    if is_running():
        raise RuntimeError("CardMirror is currently running. Close CardMirror completely and try again.")
    ensure_install_writable(renderer)
    idx = renderer / "index.html"
    if not idx.is_file():
        raise RuntimeError("Could not find CardMirror's renderer/index.html.")

    text = idx.read_text(encoding="utf-8", errors="strict")
    clean = clean_injections(text)

    # First unified-installer backup. If the old Round Report patcher already made
    # a pristine backup, prefer it so Remove All can restore the official index.
    backup = renderer / "index.html.cardmirror-features-original"
    old_backup = renderer / "index.html.roundreport-original"
    if not backup.exists():
        if old_backup.exists():
            shutil.copy2(old_backup, backup)
        else:
            backup.write_text(clean, encoding="utf-8", newline="")

    feature_dir = renderer / FEATURE_ROOT
    feature_dir.mkdir(parents=True, exist_ok=True)

    selected = []
    tags = []
    for manifest in PLUGINS:
        pid = manifest["id"]
        dest_dir = feature_dir / pid
        if pid in selected_ids:
            src = manifest["_dir"] / manifest["file"]
            if not src.is_file():
                raise RuntimeError(f"Missing payload for {manifest['name']}: {src.name}")
            dest_dir.mkdir(parents=True, exist_ok=True)
            # Copy every payload file supplied by the feature except its
            # installer manifest. This lets features keep hidden persistent
            # assets such as Keyword Finder's keyword-state.json alongside
            # plugin.js without exposing them to the user.
            for payload in manifest["_dir"].iterdir():
                if payload.is_file() and payload.name != "manifest.json":
                    target = dest_dir / payload.name
                    # Features may declare state/config files that should
                    # survive an installer upgrade. This keeps the installer
                    # generic as more optional features are added.
                    persistent = set(manifest.get("persistentFiles", []))
                    if payload.name in persistent and target.exists():
                        continue
                    shutil.copy2(payload, target)
            selected.append({
                "id": pid,
                "name": manifest["name"],
                "version": manifest.get("version", "0"),
            })
            tags.append(
                f'    <script type="module" src="./{FEATURE_ROOT}/{pid}/plugin.js?v={manifest.get("version","0")}"></script>'
            )
        elif dest_dir.exists():
            shutil.rmtree(dest_dir, ignore_errors=True)

    # Remove legacy standalone payload after migration.
    legacy = renderer / "roundreport"
    if legacy.exists():
        shutil.rmtree(legacy, ignore_errors=True)

    block = ""
    if tags:
        block = "\n    " + BEGIN + "\n" + "\n".join(tags) + "\n    " + END + "\n"

    if not re.search(r"</head>", clean, flags=re.I):
        raise RuntimeError("CardMirror index.html does not contain </head>.")
    patched = re.sub(r"</head>", block + "</head>", clean, count=1, flags=re.I)

    tmp = renderer / "index.html.cardmirror-features-tmp"
    tmp.write_text(patched, encoding="utf-8", newline="")
    os.replace(tmp, idx)

    record = {
        "installerVersion": INSTALLER_VERSION,
        "installedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "platform": platform.platform(),
        "features": selected,
    }
    installed_manifest_path(renderer).write_text(json.dumps(record, indent=2), encoding="utf-8")

    verify = idx.read_text(encoding="utf-8", errors="replace")
    for item in selected:
        needle = f'./{FEATURE_ROOT}/{item["id"]}/plugin.js'
        if needle not in verify:
            raise RuntimeError(f"Verification failed for {item['name']}.")
    resign_macos(renderer)
    return selected

def remove_all(renderer):
    renderer = Path(renderer)
    if is_running():
        raise RuntimeError("CardMirror is currently running. Close CardMirror completely and try again.")
    ensure_install_writable(renderer)
    idx = renderer / "index.html"
    backup = renderer / "index.html.cardmirror-features-original"
    if backup.exists():
        shutil.copy2(backup, idx)
    else:
        text = idx.read_text(encoding="utf-8", errors="strict")
        idx.write_text(clean_injections(text), encoding="utf-8", newline="")
    shutil.rmtree(renderer / FEATURE_ROOT, ignore_errors=True)
    shutil.rmtree(renderer / "roundreport", ignore_errors=True)
    resign_macos(renderer)

class Installer:
    def __init__(self):
        self.win = tk.Tk()
        self.win.title(APP_NAME)
        self.win.geometry("720x720")
        self.win.minsize(680, 620)

        candidates = find_candidates()
        initial = display_root(candidates[0]) if candidates else ""
        self.pathvar = tk.StringVar(value=str(initial) if initial else "")
        self.status = tk.StringVar(value="Select CardMirror and choose the features you want installed.")
        self.vars = {}

        outer = ttk.Frame(self.win, padding=20)
        outer.pack(fill="both", expand=True)

        ttk.Label(outer, text="CardMirror Feature Installer", font=("Segoe UI", 19, "bold")).pack(anchor="w")
        ttk.Label(
            outer,
            text="Install optional debate features directly into your existing CardMirror application.",
            wraplength=650
        ).pack(anchor="w", pady=(4, 18))

        ttk.Label(outer, text="CardMirror installation", font=("Segoe UI", 10, "bold")).pack(anchor="w")
        row = ttk.Frame(outer)
        row.pack(fill="x", pady=(5, 15))
        ttk.Entry(row, textvariable=self.pathvar).pack(side="left", fill="x", expand=True)
        ttk.Button(row, text="Browse…", command=self.browse).pack(side="left", padx=(8,0))

        ttk.Separator(outer).pack(fill="x", pady=(0,14))
        ttk.Label(outer, text="Features", font=("Segoe UI", 12, "bold")).pack(anchor="w")

        feature_box = ttk.Frame(outer)
        feature_box.pack(fill="x", pady=(8, 12))

        for manifest in PLUGINS:
            v = tk.BooleanVar(value=False)
            self.vars[manifest["id"]] = v
            item = ttk.Frame(feature_box)
            item.pack(fill="x", pady=7)
            cb = ttk.Checkbutton(item, variable=v, text=manifest["name"])
            cb.pack(anchor="w")
            ttk.Label(item, text=manifest.get("description",""), wraplength=610).pack(anchor="w", padx=(25,0), pady=(2,0))

        self.detected = ttk.Label(outer, text="", wraplength=650)
        self.detected.pack(anchor="w", pady=(4,12))

        buttons = ttk.Frame(outer)
        buttons.pack(fill="x", pady=(4,0))
        ttk.Button(buttons, text="Install Selected", command=self.install).pack(side="left")
        ttk.Button(buttons, text="Remove All Features", command=self.remove).pack(side="left", padx=8)
        ttk.Button(buttons, text="Exit", command=self.win.destroy).pack(side="right")

        ttk.Label(outer, textvariable=self.status, wraplength=650).pack(anchor="w", pady=(20,0))
        self.pathvar.trace_add("write", lambda *_: self.refresh())
        self.refresh()

    def browse(self):
        if sys.platform == "darwin":
            p = filedialog.askopenfilename(
                title="Select CardMirror.app",
                filetypes=[("macOS applications", "*.app"), ("All files", "*")],
            )
            if not p:
                p = filedialog.askdirectory(title="Select CardMirror.app or its renderer folder")
        else:
            p = filedialog.askdirectory(title="Select the folder containing cardmirror.exe")
        if p:
            self.pathvar.set(p)

    def renderer(self):
        p = self.pathvar.get().strip().strip('"')
        return renderer_from_selection(p) if p else None

    def refresh(self):
        r = self.renderer()
        if not r or not looks_like_cardmirror(r):
            self.detected.config(text="CardMirror not detected. Choose the application/install folder.")
            return
        installed = read_installed(r)
        installed_map = {x.get("id"): x for x in installed.get("features", []) if isinstance(x, dict)}
        # Also detect the old v0.6 Round Report installation during migration.
        idx_text = (r / "index.html").read_text(encoding="utf-8", errors="replace")
        old_rr = "Round Report Creator patch" in idx_text
        labels = []
        for manifest in PLUGINS:
            pid = manifest["id"]
            if pid in installed_map or (pid == "round-report" and old_rr):
                labels.append(manifest["name"])
                self.vars[pid].set(True)
        suffix = ", ".join(labels) if labels else "none"
        self.detected.config(text=f"CardMirror detected: {display_root(r)}\nCurrently installed features: {suffix}")

    def install(self):
        r = self.renderer()
        if not r or not looks_like_cardmirror(r):
            messagebox.showerror(APP_NAME, "Select a valid CardMirror installation first.")
            return
        selected = {pid for pid, var in self.vars.items() if var.get()}
        if not selected:
            messagebox.showwarning(APP_NAME, "Select at least one feature, or use Remove All Features.")
            return
        try:
            installed = install_selected(r, selected)
            names = "\n".join("• " + x["name"] for x in installed)
            self.status.set("Installation complete. Launch CardMirror normally.")
            messagebox.showinfo(APP_NAME, "Installed successfully:\n\n" + names + "\n\nLaunch CardMirror normally.")
            self.refresh()
        except Exception as e:
            messagebox.showerror(APP_NAME, str(e))
            self.status.set("Installation failed.")

    def remove(self):
        r = self.renderer()
        if not r or not looks_like_cardmirror(r):
            messagebox.showerror(APP_NAME, "Select a valid CardMirror installation first.")
            return
        if not messagebox.askyesno(APP_NAME, "Remove all features installed by this patcher?"):
            return
        try:
            remove_all(r)
            for v in self.vars.values():
                v.set(False)
            self.status.set("All patcher features removed.")
            messagebox.showinfo(APP_NAME, "All CardMirror Feature Installer features were removed.")
            self.refresh()
        except Exception as e:
            messagebox.showerror(APP_NAME, str(e))
            self.status.set("Removal failed.")

if __name__ == "__main__":
    Installer().win.mainloop()
