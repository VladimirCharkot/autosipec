@echo off
cd /d "%~dp0"
echo ===================================
echo   AUTOSIPEC - Carga automatica SIPEC-CBA
echo ===================================
echo.
where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js no esta instalado.
  echo Instalalo desde https://nodejs.org ^(version LTS recomendada^)
  echo.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo Node.js %%v detectado.
echo Instalando dependencias...
echo.
cmd /c npm install --no-audit

echo.
echo Verificando/instalando navegador Chromium para Playwright...
cmd /c npx playwright install chromium
if errorlevel 1 (
  echo.
  echo ERROR: No se pudo instalar el navegador Chromium.
  echo Verifica tu conexion a internet e intenta de nuevo.
  echo.
  pause
)
echo.
echo Iniciando servidor en http://localhost:3000 ...
echo ^(Cerra esta ventana para detener AUTOSIPEC^)
echo.
npm start
pause