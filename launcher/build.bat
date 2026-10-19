@echo off
rem Builds "PixelQG.exe" with the C# compiler that ships with Windows (.NET Framework 4).
cd /d "%~dp0"
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
node make-icon.js || exit /b 1
if not exist dist mkdir dist
"%CSC%" /nologo /codepage:65001 /target:winexe /optimize+ /win32icon:pixelqg.ico /out:"dist\PixelQG.exe" /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll /r:System.Management.dll PixelQG.cs || exit /b 1
echo Compilation terminee : %~dp0dist\PixelQG.exe
