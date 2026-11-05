const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Chromium de Playwright se guarda en userData (escribible en las 3 plataformas)
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(app.getPath('userData'), 'browsers');

let win;

function setStatus(text) {
  if (!win) return;
  const html = `<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#333"><div style="text-align:center"><h2>AUTOSIPEC</h2><p>${text}</p></div></body>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function chromiumInstalled() {
  try {
    return fs.existsSync(require('playwright').chromium.executablePath());
  } catch { return false; }
}

function installChromium() {
  return new Promise((resolve, reject) => {
    const cli = path.join(require.resolve('playwright/package.json'), '..', 'cli.js');
    const p = spawn(process.execPath, [cli, 'install', 'chromium'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`playwright install terminó con código ${code}`)));
  });
}

async function createWindow() {
  win = new BrowserWindow({ width: 1100, height: 800, title: 'AUTOSIPEC' });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  if (!chromiumInstalled()) {
    setStatus('Primera ejecución: descargando navegador (~150 MB). Puede tardar unos minutos...');
    try {
      await installChromium();
    } catch (e) {
      setStatus('No se pudo descargar el navegador. Verificá tu conexión a internet y reabrí la app.<br><small>' + e.message + '</small>');
      return;
    }
  }

  const port = await require('./server').start(0);
  win.loadURL(`http://127.0.0.1:${port}`);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
