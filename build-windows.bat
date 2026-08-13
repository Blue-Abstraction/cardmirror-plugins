@echo off
setlocal
cd /d "%~dp0"

echo ===============================================
echo   CardMirror Feature Installer - Windows Build
echo ===============================================
echo.

where py >nul 2>nul
if %errorlevel%==0 (
  set PY=py
) else (
  where python >nul 2>nul
  if %errorlevel% neq 0 (
    echo Python 3 was not found.
    echo Install Python 3, then run this file again.
    pause
    exit /b 1
  )
  set PY=python
)

%PY% -m pip install --upgrade pyinstaller
if %errorlevel% neq 0 goto :fail

%PY% -m PyInstaller --noconfirm --clean CardMirrorFeatureInstaller.spec
if %errorlevel% neq 0 goto :fail

echo.
echo Build complete.
echo Your standalone installer is in:
echo   dist\CardMirror Feature Installer.exe
start "" "%~dp0dist"
pause
exit /b 0

:fail
echo.
echo Build failed. Review the error above.
pause
exit /b 1
