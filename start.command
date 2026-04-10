#!/bin/bash
# Doble click en este archivo desde Finder para iniciar AUTOSIPEC

cd "$(dirname "$0")"

echo "==================================================="
echo "  AUTOSIPEC - Carga automatica SIPEC-CBA"
echo "==================================================="
echo ""

# Verificar Node.js
if ! command -v node &> /dev/null; then
  echo "ERROR: Node.js no está instalado."
  echo "Instalalo desde https://nodejs.org (LTS recomendado)"
  echo ""
  read -p "Presionà Enter para cerrar..."
  exit 1
fi

echo "Node.js $(node --version) detectado."

# Instalar dependencias si no existen
if [ ! -d "node_modules" ]; then
  echo ""
  echo "Primera ejecución: instalando dependencias..."
  npm install
  echo ""
  echo "Descargando navegador Chromium para Playwright..."
  npx playwright install chromium
  echo ""
fi

echo ""
echo "Iniciando servidor en http://localhost:3000 ..."
echo "(Cerrá esta ventana para detener AUTOSIPEC)"
echo ""

npm start
