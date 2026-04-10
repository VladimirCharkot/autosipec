const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { spawn } = require('child_process');
const path = require('path');
const { exec } = require('child_process');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- SSE state ---
const sseClients = new Set();
let isRunning = false;
let currentProcess = null;

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => res.write(msg));
}

// --- Endpoints ---

// Real-time log stream (Server-Sent Events)
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);
  res.write(`event: status\ndata: ${JSON.stringify({ isRunning })}\n\n`);

  req.on('close', () => sseClients.delete(res));
});

// Parse Excel file
app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });

    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (!raw.length) return res.status(400).json({ error: 'El archivo está vacío o no tiene datos' });

    // Show available columns to help diagnose mapping issues
    const cols = Object.keys(raw[0]);

    const CONDICIONES = { aprobado: 'Aprobado', desaprobado: 'Desaprobado', ausente: 'Ausente', asistente: 'Asistente' };

    const rows = raw
      .map(r => {
        const condRaw = String(
          r['Condición'] || r['Condicion'] || r['condicion'] || r['CONDICION'] || r['Estado'] || ''
        ).trim().toLowerCase();
        return {
          dni:      String(r['DNI'] || r['dni'] || r['Dni'] || r['D.N.I.'] || '').trim(),
          cue:      String(r['CUE'] || r['cue'] || r['Cue'] || r['CUE+Anexo'] || '').trim(),
          rol:      String(r['Rol'] || r['rol'] || r['ROL'] || r['Cargo'] || r['cargo'] || '').trim(),
          condicion: CONDICIONES[condRaw] || 'Aprobado',
        };
      })
      .filter(r => r.dni.length >= 7);

    if (!rows.length) {
      return res.status(400).json({
        error: `No se encontró columna DNI. Columnas detectadas: ${cols.join(', ')}`,
      });
    }

    res.json({ rows, total: rows.length, columns: cols });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Start automation
app.post('/api/run', (req, res) => {
  if (isRunning) {
    return res.status(409).json({ error: 'Ya hay una automatización en curso' });
  }

  const { usuario, password, cursoNombre, localidad, rows, headless } = req.body;

  if (!usuario || !password || !cursoNombre || !localidad) {
    return res.status(400).json({ error: 'Faltan campos requeridos (usuario, contraseña, curso, localidad)' });
  }
  if (!rows || !rows.length) {
    return res.status(400).json({ error: 'No hay filas para procesar. Cargá un Excel primero.' });
  }

  res.json({ ok: true });

  isRunning = true;
  broadcast('status', { isRunning: true });
  broadcast('log', { level: 'info', message: 'Iniciando automatización...' });

  const config = JSON.stringify({ usuario, password, cursoNombre, localidad, rows, headless: !!headless });

  currentProcess = spawn('node', [path.join(__dirname, 'automation.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  currentProcess.stdin.write(config);
  currentProcess.stdin.end();

  currentProcess.stdout.on('data', data => {
    data.toString().trim().split('\n').filter(Boolean).forEach(line => {
      try {
        broadcast('log', JSON.parse(line));
      } catch {
        broadcast('log', { level: 'info', message: line });
      }
    });
  });

  currentProcess.stderr.on('data', data => {
    const msg = data.toString().trim();
    if (msg) broadcast('log', { level: 'error', message: msg });
  });

  currentProcess.on('close', code => {
    isRunning = false;
    currentProcess = null;
    broadcast('status', { isRunning: false });
    if (code !== 0 && code !== null) {
      broadcast('log', { level: 'error', message: `Proceso terminó inesperadamente (código ${code})` });
    }
  });
});

// Stop automation
app.post('/api/stop', (req, res) => {
  if (currentProcess) {
    currentProcess.kill('SIGTERM');
    currentProcess = null;
    isRunning = false;
    broadcast('status', { isRunning: false });
    broadcast('log', { level: 'warning', message: 'Automatización detenida por el usuario.' });
  }
  res.json({ ok: true });
});

// Start server
const PORT = 3000;
app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\nAUTOSIPEC corriendo en ${url}\n`);
  const cmd =
    process.platform === 'darwin' ? `open ${url}` :
    process.platform === 'win32' ? `start ${url}` :
    `xdg-open ${url}`;
  setTimeout(() => exec(cmd), 800);
});
