@echo off
rem PixelQG launcher for Windows: double-click this file.
rem Extra options are passed through, e.g. start.bat --demo
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title PixelQG

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js est introuvable sur cet ordinateur.
  echo   Installe Node.js 20 ou plus récent depuis https://nodejs.org
  echo   puis relance start.bat.
  echo.
  pause
  exit /b 1
)

node server\server.js --open %*
if errorlevel 1 (
  echo.
  echo   PixelQG s'est arrêté avec une erreur, voir le message ci-dessus.
  echo.
  pause
)
endlocal
