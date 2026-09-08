@echo off
chcp 65001 >nul
title راهکار - سامانه جامع سازمانی و مالی
setlocal

REM ------------------------------------------------------------------
REM  این فایل می‌تواند از دو جا اجرا شود:
REM    1) ریشه‌ی پروژه (کنار package.json)  →  scripts\windows\...
REM    2) بسته‌ی قابل‌حمل (dist-win\راهکار)  →  کنارِ همین فایل
REM  در هر دو حالت، پوشه‌ی کاری روی جایی تنظیم می‌شود که package.json هست.
REM ------------------------------------------------------------------
if exist "%~dp0package.json" (
  cd /d "%~dp0"
) else if exist "%~dp0..\..\package.json" (
  cd /d "%~dp0..\.."
) else (
  cd /d "%~dp0"
)

echo.
echo  ============================================
echo    راهکار - سامانه جامع سازمانی و مالی
echo  ============================================
echo.

REM بررسی وجود Node.js
where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js روی این رایانه نصب نیست.
  echo  لطفاً Node.js نسخه 20.19 یا بالاتر را نصب کنید:
  echo  https://nodejs.org
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODEV=%%v
echo  نسخه Node.js شما: %NODEV%

REM خواندن پورت از فایل .env (اگر بود)، وگرنه 8080
set PORT=8080
if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
    if /i "%%a"=="PORT" set PORT=%%b
  )
)

REM نصب وابستگی‌ها در نخستین اجرا
if not exist "node_modules\tsx\package.json" (
  echo.
  echo  در حال نصب وابستگی‌ها ... یک بار انجام می‌شود و نیاز به اینترنت دارد.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo  نصب ناموفق بود. از اتصال اینترنت مطمئن شوید و دوباره اجرا کنید.
    pause
    exit /b 1
  )
)

REM اگر خروجیِ ساخت وجود ندارد، بساز (فقط در ریشه‌ی پروژه؛ بسته‌ی قابل‌حمل dist آماده دارد)
if not exist "dist\index.html" (
  if exist "vite.config.ts" (
    echo.
    echo  در حال ساخت خروجی برنامه ...
    call npm run build
    if errorlevel 1 (
      echo  ساخت ناموفق بود.
      pause
      exit /b 1
    )
  )
)

echo.
echo  برنامه روی آدرس زیر باز می‌شود:
echo  http://localhost:%PORT%
echo.
echo  برای توقف، همین پنجره را ببندید (یا Ctrl+C).
echo.

REM باز کردن مرورگر پس از آماده شدن سرور
if exist "%~dp0بازکن-مرورگر.bat" start "" /B cmd /c ""%~dp0بازکن-مرورگر.bat" %PORT%"

REM نکته: JWT_SECRET لازم نیست دستی تنظیم شود؛ سرور خودش یک کلید پایدار در پوشه‌ی .data می‌سازد.
REM اگر خواستید، در فایل .env مقدار JWT_SECRET (حداقل 32 کاراکتر) را بگذارید.
set NODE_ENV=production
node --import tsx server/index.ts

echo.
echo  سرور متوقف شد.
pause
endlocal
