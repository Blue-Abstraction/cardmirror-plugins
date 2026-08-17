#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "================================================"
echo "  CardMirror Feature Installer - macOS Build"
echo "================================================"
echo

PYTHON_BIN="${PYTHON_BIN:-python3}"
VENV_DIR=".venv-macos-build"

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "ERROR: python3 was not found."
  echo "Install Python 3, then run this script again."
  exit 1
fi

echo "[1/5] Python:"
"$PYTHON_BIN" --version
echo

echo "[2/5] Creating isolated build environment..."
if [ ! -d "$VENV_DIR" ]; then
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

VENV_PY="$VENV_DIR/bin/python"
VENV_PIP="$VENV_DIR/bin/pip"
VENV_PYINSTALLER="$VENV_DIR/bin/pyinstaller"

echo "[3/5] Installing/updating build tools inside the virtual environment..."
"$VENV_PY" -m pip install --upgrade pip
"$VENV_PIP" install --upgrade pyinstaller

echo
echo "[4/5] Building CardMirror Feature Installer.app..."
rm -rf build dist

if [ -f "CardMirrorFeatureInstaller.spec" ]; then
  "$VENV_PYINSTALLER" --noconfirm --clean "CardMirrorFeatureInstaller.spec"
else
  echo "ERROR: CardMirrorFeatureInstaller.spec was not found."
  exit 1
fi

echo
echo "[5/5] Build complete."
echo

APP_PATH="dist/CardMirror Feature Installer.app"
if [ -d "$APP_PATH" ]; then
  if command -v codesign >/dev/null 2>&1; then
    echo "Applying local ad-hoc signature to installer..."
    codesign --force --deep --sign - "$APP_PATH" || true
  fi

  echo
  echo "Created:"
  echo "  $APP_PATH"
  echo
  echo "You can now double-click the app in Finder."
else
  echo "ERROR: Build finished but the .app was not found at:"
  echo "  $APP_PATH"
  exit 1
fi
