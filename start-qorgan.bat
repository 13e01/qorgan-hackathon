@echo off
rem QORGAN: сборка и запуск сайта и сервера на http://localhost:3000
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
call npm run build || goto fail
echo.
echo QORGAN запускается: откройте в браузере http://localhost:3000
call npm start
pause
exit /b 0

:fail
echo Не удалось подготовить QORGAN. Сообщение об ошибке — выше.
pause
exit /b 1
