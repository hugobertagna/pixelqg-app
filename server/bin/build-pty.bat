@echo off
rem Compiles the ConPTY bridge of the integrated terminal (hq-pty.cs -> hq-pty.exe) with the
rem .NET Framework C# compiler that ships with Windows. PixelQG also does this automatically at
rem startup when hq-pty.exe is missing or older than hq-pty.cs.
setlocal
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo Compilateur C# introuvable : il faut le .NET Framework 4.x, fourni avec Windows.
  exit /b 1
)
"%CSC%" /nologo /codepage:65001 /target:exe /optimize+ /out:"%~dp0hq-pty.exe" "%~dp0hq-pty.cs"
if errorlevel 1 (
  echo La compilation de hq-pty.exe a echoue.
  exit /b 1
)
echo hq-pty.exe est pret.
exit /b 0
