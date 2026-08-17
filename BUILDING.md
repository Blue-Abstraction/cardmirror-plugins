# Building the native CardMirror Feature Installer

The feature payloads in this package are the known-good v0.9.3 baseline. The packaging layer is v1.0.0.

## Why there are two builds

PyInstaller builds native applications for the operating system it is running on. Build the Windows executable on Windows and the macOS application on macOS. The resulting end-user application does **not** require Python.

## Windows

Double-click `build-windows.bat` on a Windows development machine. It installs PyInstaller if necessary and produces:

`dist/CardMirror Feature Installer.exe`

That `.exe` is the file ordinary Windows users double-click. They do not need Python.

## macOS

Double-click `build-macos.command` on a Mac development machine. On first use, macOS may require allowing the script to run. It produces:

`dist/CardMirror Feature Installer.app`

That `.app` is the application ordinary Mac users open. They do not need Python.

## macOS patching note

Modifying files inside `CardMirror.app` invalidates CardMirror's original code signature. The installer therefore ad-hoc re-signs the modified CardMirror app using the system `codesign` command after installing or removing features. This has not yet been tested against a real CardMirror macOS release, so macOS remains experimental until that test is completed.

## Bundled features

- Round Report Creator
- Keyword Finder

The installer discovers features from `plugins/*/manifest.json`, so additional features can be added without redesigning the GUI.


## macOS / Homebrew Python

The macOS build script uses a local virtual environment at `.venv-macos-build`.
This avoids PEP 668 / `externally-managed-environment` errors from Homebrew Python.
Do not use `--break-system-packages`.

The virtual environment is only for building the installer. The finished
`CardMirror Feature Installer.app` remains standalone for end users.
