const { chromium } = require('playwright');

const BASE = 'https://www.igualdadycalidadcba.gov.ar/SIPEC-CBA';

function log(level, message, extra = {}) {
  process.stdout.write(JSON.stringify({ level, message, ...extra }) + '\n');
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

// Navega de vuelta a la página de inscripción usando un POST programático
async function goToInscripcion(page, idFicha, idCurso) {
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.evaluate(({ base, idFicha, idCurso }) => {
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = `${base}/AccionesInscripcion.php`;
      [
        ['txtIdFicha', idFicha],
        ['txtIdCurso', idCurso],
        ['Inscribir capacitando', 'Ingresar'],
      ].forEach(([name, value]) => {
        const inp = document.createElement('input');
        inp.type = 'hidden';
        inp.name = name;
        inp.value = value;
        form.appendChild(inp);
      });
      document.body.appendChild(form);
      form.submit();
    }, { base: BASE, idFicha, idCurso }),
  ]);
}

// Hace click en "Aceptar" y espera la navegación resultante.
// Si no hay botón Aceptar visible, vuelve manualmente a la página de inscripción.
async function clickAceptarYVolver(page, idFicha, idCurso) {
  const aceptarBtn = page.locator(
    'input[value="Aceptar"], button:has-text("Aceptar"), a:has-text("Aceptar")'
  ).first();

  const visible = await aceptarBtn.isVisible().catch(() => false);
  if (visible) {
    // waitForNavigation puede no disparar si Aceptar solo hace un history.back()
    // por eso usamos una race entre navegación y timeout
    const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 6000 }).catch(() => null);
    await aceptarBtn.click();
    await navPromise;
  } else {
    await goToInscripcion(page, idFicha, idCurso);
  }
}

async function main() {
  const { usuario, password, cursoNombre, localidad, rows, headless } = await readStdin();

  const browser = await chromium.launch({ headless: !!headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Capturar el texto de cualquier dialog JS y aceptarlo automáticamente
  let lastDialogMessage = null;
  page.on('dialog', async dialog => {
    lastDialogMessage = dialog.message();
    await dialog.accept();
  });

  // Si el usuario cierra el browser (cualquier vía), terminamos el proceso limpiamente.
  // 'disconnected' es el evento más confiable cuando se cierra la ventana manualmente.
  browser.on('disconnected', () => {
    log('info', 'Ventana cerrada por el usuario.');
    process.exit(0);
  });

  try {
    // ── 1. Login ──────────────────────────────────────────────────────────────
    log('info', 'Navegando al sitio...');
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });

    log('info', 'Abriendo formulario de login...');
    await page.click('#btn-login', { timeout: 10000 });
    await page.waitForSelector('#user', { state: 'visible', timeout: 10000 });

    log('info', 'Ingresando credenciales...');
    await page.fill('#user', usuario);
    await page.fill('#pass', password);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.click('#btn-loginSipec'),
    ]);

    const cargaLink = page.locator('a[href*="SeleccionaCursoCarga"]');
    await cargaLink.waitFor({ timeout: 15000 }).catch(() => {
      throw new Error('Login fallido o no se encontró el menú principal. Verificá usuario y contraseña.');
    });
    log('info', 'Login exitoso.');

    // ── 2. Cargar Asistentes ──────────────────────────────────────────────────
    log('info', 'Navegando a "Cargar Asistentes"...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      cargaLink.click(),
    ]);

    // ── 3. Buscar el curso ────────────────────────────────────────────────────
    log('info', `Buscando curso "${cursoNombre}" en localidad "${localidad}"...`);

    const tableRows = await page.$$('table tr');
    let idFicha = null;
    let idCurso = null;
    let found = false;

    for (const row of tableRows) {
      const cells = await row.$$('td');
      if (cells.length < 8) continue;

      const nameText   = ((await cells[1].textContent()) || '').trim().toLowerCase();
      const localText  = ((await cells[2].textContent()) || '').trim().toLowerCase();
      const statusText = ((await cells[6].textContent()) || '').trim().toLowerCase();

      if (
        nameText.includes(cursoNombre.trim().toLowerCase()) &&
        localText.includes(localidad.trim().toLowerCase()) &&
        statusText.includes('abierto')
      ) {
        idFicha = await cells[7].$eval('input[name="txtIdFicha"]', el => el.value).catch(() => null);
        idCurso = await cells[7].$eval('input[name="txtIdCurso"]', el => el.value).catch(() => null);
        log('info', `Curso encontrado. ID Curso: ${idCurso}, ID Ficha: ${idFicha}`);

        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
          cells[7].$eval('input[type="submit"]', el => el.click()),
        ]);
        found = true;
        break;
      }
    }

    if (!found) {
      throw new Error(
        `No se encontró ningún curso con nombre que contenga "${cursoNombre}", ` +
        `localidad "${localidad}" y estado "Abierto".`
      );
    }

    // ── 4. Inscribir cada persona ─────────────────────────────────────────────
    const duplicates = [];   // DNIs duplicados
    const inscriptos = [];   // personas que se inscribieron OK (con su condicion)
    let errCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const person = rows[i];
      const tag = `[${i + 1}/${rows.length}]`;

      log('progress', `${tag} Inscribiendo DNI ${person.dni}...`, {
        current: i + 1,
        total: rows.length,
      });

      lastDialogMessage = null;

      try {
        await page.fill('#dni', '');
        await page.fill('#dni', person.dni);

        await page.fill('input[name="txtc"]', '');
        if (person.cue) await page.fill('input[name="txtc"]', person.cue);

        const rol = person.rol?.trim() || 'Docentes frente a alumnos';
        try {
          await page.selectOption('select[name="selectRol"]', { label: rol });
        } catch {
          log('warning', `${tag} Rol "${rol}" no encontrado, se mantiene el valor por defecto.`);
        }

        // Enviar y esperar página de resultado
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
          page.click('input[name="boton2"][value="Inscribir"]'),
        ]);

        // El resultado puede estar en el texto de la página o en un dialog JS capturado
        const pageText = ((await page.locator('body').textContent().catch(() => '')) || '');
        const resultText = lastDialogMessage || pageText;

        const isDuplicate = /duplicaci[oó]n|realizado.*capacitaci[oó]n.*otra.*instancia/i.test(resultText);
        const isSuccess   = /alumno\s*inscripto/i.test(resultText);

        if (isDuplicate) {
          log('duplicate', `${tag} DNI ${person.dni}: duplicado o ya certificado en otra instancia.`, {
            dni: person.dni,
          });
          duplicates.push(person.dni);
        } else if (isSuccess) {
          const match = resultText.match(/alumno\s*inscripto[:\s]+([^\n\r<]+)/i);
          const nombre = match ? match[1].trim() : person.dni;
          log('success', `${tag} DNI ${person.dni} inscripto: ${nombre}`);
          inscriptos.push(person);
        } else {
          const snippet = pageText.replace(/\s+/g, ' ').trim().slice(0, 300);
          log('error', `${tag} DNI ${person.dni}: respuesta inesperada.`, { detail: snippet });
          errCount++;
        }

        // Click "Aceptar" para volver al formulario de inscripción
        await clickAceptarYVolver(page, idFicha, idCurso);

      } catch (e) {
        log('error', `${tag} DNI ${person.dni}: excepción → ${e.message}`);
        errCount++;
        try {
          await goToInscripcion(page, idFicha, idCurso);
        } catch {
          log('fatal', 'No se pudo recuperar la navegación. Abortando.');
          break;
        }
      }
    }

    // ── 5. Resumen de duplicados ──────────────────────────────────────────────
    if (duplicates.length > 0) {
      log('duplicates_summary',
        `${duplicates.length} duplicado(s): ${duplicates.join(', ')}`,
        { duplicates }
      );
    }

    // ── 6. Establecer condiciones en la tabla ─────────────────────────────────
    if (inscriptos.length > 0) {
      log('info', 'Estableciendo condiciones en la tabla...');

      // Buscamos todas las filas de la tabla de alumnos ya inscriptos
      // (son las que tienen un <select> con opciones de condición)
      const allRows = await page.$$('table tr');
      let condicionesSet = 0;

      for (const row of allRows) {
        const condSelect = await row.$('select');
        if (!condSelect) continue;

        const rowText = ((await row.textContent()) || '').replace(/\s+/g, ' ');

        // Buscar qué persona de nuestra lista corresponde a esta fila
        const matched = inscriptos.find(p => rowText.includes(p.dni));
        if (!matched) continue;

        const condicion = matched.condicion?.trim() || 'Aprobado';
        try {
          await condSelect.selectOption({ label: condicion });
          condicionesSet++;
        } catch {
          try {
            await condSelect.selectOption({ value: condicion });
            condicionesSet++;
          } catch {
            log('warning', `No se pudo establecer condición "${condicion}" para DNI ${matched.dni}.`);
          }
        }
      }

      log('info', `Condiciones establecidas para ${condicionesSet} alumno(s).`);
    }

    // ── 7. Grabar ─────────────────────────────────────────────────────────────
    log('info', 'Haciendo click en Grabar...');
    const grabarBtn = page.locator('input[name="Grabar"][value="Grabar"]');

    if (await grabarBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      // ResultadoEvaluacion2() puede mostrar un dialog — será auto-aceptado
      await grabarBtn.click();
      await page.waitForTimeout(2000);
      log('info', 'Grabar ejecutado.');
    } else {
      log('warning', 'No se encontró el botón Grabar. Es posible que no haya inscriptos en la tabla.');
    }

    // ── 8. Fin: dejar ventana abierta ─────────────────────────────────────────
    const total = inscriptos.length;
    const dups  = duplicates.length;
    log('done',
      `Listo. ${total} inscripto(s), ${dups} duplicado(s), ${errCount} error(es). ` +
      `La ventana queda abierta para que puedas continuar manualmente.`,
      { ok: total, duplicates: dups, err: errCount }
    );

    // Mantener el proceso vivo hasta que el usuario cierre el browser o haga Stop.
    // El handler 'disconnected' arriba se encarga de hacer process.exit(0).
    await new Promise(resolve => browser.once('disconnected', resolve));

  } catch (e) {
    log('fatal', `Error fatal: ${e.message}`);
    await browser.close().catch(() => {});
    process.exit(1);
  }
  // Sin finally que cierre el browser — queremos que quede abierto
}

main().catch(e => {
  process.stdout.write(JSON.stringify({ level: 'fatal', message: e.message }) + '\n');
  process.exit(1);
});
