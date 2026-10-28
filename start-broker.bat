@echo off
rem QORGAN: запуск локального MQTT-брокера (слушает только этот компьютер, 127.0.0.1:1883).
rem Закрыть окно или Ctrl+C — остановить.
chcp 65001 >nul
cd /d "%~dp0"
where npm >nul 2>nul || (
  echo Node.js не найден. Установите Node.js 24 с https://nodejs.org/ и запустите снова.
  pause
  exit /b 1
)
if not exist "node_modules" (
  echo Первый запуск: устанавливаю зависимости ^(npm install^)...
  call npm install || goto fail
)
call npm run setup
call npm run mqtt:broker
pause
exit /b 0

:fail
echo Не удалось установить зависимости. Проверьте интернет и запустите снова.
pause
exit /b 1
