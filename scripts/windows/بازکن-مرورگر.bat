@echo off
chcp 65001 >nul
REM صبر می‌کنیم سرور بالا بیاید، سپس مرورگر را باز می‌کنیم
REM پورت از آرگومان اول گرفته می‌شود؛ پیش‌فرض 8080
set PORT=%~1
if "%PORT%"=="" set PORT=8080
timeout /t 6 /nobreak >nul
start "" http://localhost:%PORT%
exit /b
