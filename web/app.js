import { CanonicalHost, WIT_CONTRACT } from './lib/canonical-abi.js';
import {
  calldataGas,
  decodeCalldata,
  decodeParams,
  encodeCall,
  encodeParams,
  randomBytes32,
} from './lib/ethereum-abi.js';
import { checksum, grayscaleJS, maxChannelDiff, syntheticFrame } from './lib/filters.js';
import { bytesToHex, keccak256 } from './lib/keccak.js';
import { loadInstance, WasmImageProcessor } from './lib/wasm.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const DEMO_WIDTH = 640;
const DEMO_HEIGHT = 480;
const ETH_SIGNATURE = 'registerFilter(bytes32,string,uint8,uint32,bytes32)';
const ETH_RETURN_TYPES = ['string', 'uint8', 'uint32', 'bytes32', 'bool'];

const state = {
  processors: {},
  backend: 'c',
  source: 'pattern',
  running: true,
  video: null,
  stream: null,
  manifest: null,
  msEma: 0,
  frameEma: 0,
  frameCount: 0,
  eth: null,
  comparing: false,
};

const canvas = $('#canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
canvas.width = DEMO_WIDTH;
canvas.height = DEMO_HEIGHT;

function showBootError(error) {
  const box = $('#boot-error');
  const detail = $('#boot-error-detail');
  box.hidden = false;
  detail.textContent = `${error?.message ?? error} — ejecutá "npm run dev" y abrí http://localhost:8080/`;
  console.error(error);
}

function renderKv(container, rows) {
  container.replaceChildren(
    ...rows.map(([label, value]) => {
      const row = document.createElement('div');
      row.className = 'kv__row';
      const key = document.createElement('span');
      key.textContent = label;
      const val = document.createElement('b');
      val.textContent = value;
      row.append(key, val);
      return row;
    }),
  );
}

function renderSteps(steps) {
  const root = $('#abi-steps');
  root.replaceChildren(
    ...steps.map((step, index) => {
      const row = document.createElement('div');
      row.className = 'step';

      const number = document.createElement('span');
      number.className = 'step__n';
      number.textContent = String(index + 1);

      const body = document.createElement('div');
      const title = document.createElement('b');
      title.textContent = step.title;
      const detail = document.createElement('p');
      detail.textContent = step.detail;
      body.append(title, detail);

      const code = document.createElement('code');
      code.textContent = step.code;

      row.append(number, body, code);
      return row;
    }),
  );
}

function formatInt(value) {
  return new Intl.NumberFormat('es-AR').format(value);
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

function activatePanel(name, updateHash = true) {
  const tabs = $$('.tab');
  if (!tabs.some((tab) => tab.dataset.panel === name)) return;

  for (const tab of tabs) {
    const active = tab.dataset.panel === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  for (const panel of $$('.panel')) {
    panel.classList.toggle('is-active', panel.id === `panel-${name}`);
  }
  if (updateHash) history.replaceState(null, '', `#${name}`);
}

function setupTabs() {
  for (const tab of $$('.tab')) {
    tab.addEventListener('click', () => activatePanel(tab.dataset.panel));
    tab.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();
      const tabs = $$('.tab');
      const index = tabs.indexOf(tab);
      const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      activatePanel(next.dataset.panel);
    });
  }

  const initial = location.hash.slice(1);
  if (initial) activatePanel(initial, false);
}

/* ------------------------------------------------------------------ */
/* Demo WASM                                                           */
/* ------------------------------------------------------------------ */

function drawPattern(time) {
  const width = canvas.width;
  const height = canvas.height;

  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#0b2a4a');
  gradient.addColorStop(0.5, '#0f766e');
  gradient.addColorStop(1, '#3b1d70');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  for (let i = 0; i < 4; i++) {
    const x = width * (0.5 + 0.36 * Math.cos(time * 0.6 + i * 1.7));
    const y = height * (0.5 + 0.32 * Math.sin(time * 0.45 + i * 2.1));
    const radius = 80 + 30 * Math.sin(time + i);
    const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
    glow.addColorStop(0, `hsla(${(i * 78 + time * 22) % 360}, 92%, 66%, 0.55)`);
    glow.addColorStop(1, 'transparent');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.save();
  ctx.globalAlpha = 0.1;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  for (let x = -height; x < width; x += 30) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + height, height);
    ctx.stroke();
  }
  ctx.restore();

  ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
  ctx.font = '700 46px ui-monospace, "Cascadia Code", monospace';
  ctx.fillText('WASM 02', 30, 72);
  ctx.font = '500 16px ui-monospace, "Cascadia Code", monospace';
  ctx.fillStyle = 'rgba(226, 232, 240, 0.82)';
  ctx.fillText('RGBA · 60 fps · memoria lineal', 32, 102);

  const barWidth = ((time * 120) % (width + 160)) - 80;
  ctx.fillStyle = 'rgba(34, 211, 238, 0.85)';
  ctx.fillRect(barWidth, height - 28, 80, 4);
}

function processFrame(data) {
  if (state.backend === 'js') {
    grayscaleJS(data);
    return;
  }
  const processor = state.processors[state.backend];
  if (!processor) {
    grayscaleJS(data);
    return;
  }
  const view = processor.process(data);
  data.set(view);
}

function updateTelemetry(elapsed, frameMs) {
  state.msEma = state.msEma === 0 ? elapsed : state.msEma * 0.9 + elapsed * 0.1;
  state.frameEma = state.frameEma === 0 ? frameMs : state.frameEma * 0.9 + frameMs * 0.1;
  state.frameCount++;

  if (state.frameCount % 6 !== 0) return;

  const fps = 1000 / Math.max(state.frameEma, 0.001);
  const mpix = DEMO_WIDTH * DEMO_HEIGHT / 1e6 / Math.max(state.msEma / 1000, 1e-6);

  $('#stat-fps').textContent = String(Math.round(fps));
  $('#stat-ms').textContent = state.msEma.toFixed(2);
  $('#stat-mp').textContent = String(Math.round(mpix));
  $('#meter-bar').style.width = `${Math.min(100, (state.msEma / 16.67) * 100)}%`;
}

function loop(now) {
  requestAnimationFrame(loop);

  const frameMs = now - (state.lastFrame ?? now);
  state.lastFrame = now;

  if (state.source === 'camera' && state.video && state.video.readyState >= 2) {
    ctx.drawImage(state.video, 0, 0, DEMO_WIDTH, DEMO_HEIGHT);
  } else {
    drawPattern(now / 1000);
  }

  if (!state.running) return;

  const image = ctx.getImageData(0, 0, DEMO_WIDTH, DEMO_HEIGHT);
  const start = performance.now();
  processFrame(image.data);
  const elapsed = performance.now() - start;
  ctx.putImageData(image, 0, 0);

  updateTelemetry(elapsed, frameMs);
}

function setBackend(key) {
  state.backend = key;
  state.msEma = 0;
  state.frameEma = 0;
  state.frameCount = 0;

  const labels = {
    c: 'C · wasm',
    cpp: 'C++ · wasm',
    js: 'JavaScript',
  };
  $('#backend-label').textContent = labels[key] ?? key;

  const size = key === 'js' ? null : state.manifest?.modules?.[key]?.bytes;
  $('#stat-size').textContent = size ? `${(size / 1024).toFixed(1)} KB` : '—';
}

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: DEMO_WIDTH }, height: { ideal: DEMO_HEIGHT } },
      audio: false,
    });

    state.stream?.getTracks().forEach((track) => track.stop());
    state.stream = stream;

    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    await video.play();

    state.video = video;
    state.source = 'camera';
    $('#canvas-badge').textContent = 'cámara web';
    $('#demo-status').textContent =
      'Cámara activa. Cada frame se copia a la memoria lineal y se procesa in-place.';
  } catch (error) {
    state.source = 'pattern';
    $('#source-select').value = 'pattern';
    $('#canvas-badge').textContent = 'patrón sintético';
    $('#demo-status').textContent = `No se pudo abrir la cámara (${error?.name ?? 'error'}). Se usa el patrón sintético.`;
  }
}

function stopCamera() {
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  state.video = null;
  state.source = 'pattern';
  $('#canvas-badge').textContent = 'patrón sintético';
  $('#demo-status').textContent =
    'Escribiendo el frame en la memoria lineal y llamando a apply_grayscale(ptr, n).';
}

function verifyPixels() {
  const image = ctx.getImageData(0, 0, DEMO_WIDTH, DEMO_HEIGHT);
  const expected = Uint8ClampedArray.from(image.data);
  grayscaleJS(expected);

  const processor = state.processors.c;
  if (!processor) {
    $('#demo-status').textContent = 'El módulo C no está disponible.';
    return;
  }

  const view = processor.process(image.data);
  const diff = maxChannelDiff(expected, view);
  $('#demo-status').textContent =
    diff === 0
      ? '✓ C y JavaScript producen exactamente el mismo frame (diferencia máxima: 0).'
      : `Diferencia máxima entre C y JavaScript: ${diff}.`;
}

/** Espera a que el navegador pinte, pero no se cuelga en pestañas ocultas. */
function nextPaint(timeout = 150) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, timeout);
  });
}

async function runComparison() {
  if (state.comparing) return;
  state.comparing = true;

  const button = $('#compare');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Midiendo…';
  await nextPaint();

  try {
    const width = 1280;
    const height = 720;
    const iterations = 40;
    const source = syntheticFrame(width, height, 0);
    const entries = [];

    const jsBuffer = Uint8ClampedArray.from(source);
    for (let i = 0; i < 8; i++) grayscaleJS(jsBuffer);
    let start = performance.now();
    for (let i = 0; i < iterations; i++) grayscaleJS(jsBuffer);
    let ms = (performance.now() - start) / iterations;
    entries.push({
      key: 'js',
      label: 'JavaScript',
      ms,
      checksum: checksum(jsBuffer),
    });

    for (const key of ['c', 'cpp']) {
      const processor = state.processors[key];
      if (!processor) continue;

      processor.process(source);
      const fn = processor.exports[processor.exportName];
      for (let i = 0; i < 8; i++) fn(processor.ptr, width * height);
      start = performance.now();
      for (let i = 0; i < iterations; i++) fn(processor.ptr, width * height);
      ms = (performance.now() - start) / iterations;

      const result = new Uint8Array(processor.memory.buffer, processor.ptr, width * height * 4);
      entries.push({
        key,
        label: key === 'c' ? 'C · puntero a función' : 'C++ · virtual',
        ms,
        checksum: checksum(result),
      });
    }

    const baseline = entries.find((entry) => entry.key === 'js')?.ms ?? 1;
    const slowest = Math.max(...entries.map((entry) => entry.ms));
    const bars = $('#compare-bars');
    bars.replaceChildren();

    for (const entry of entries.toSorted((a, b) => a.ms - b.ms)) {
      const row = document.createElement('div');
      row.className = 'bar-row';

      const label = document.createElement('span');
      label.textContent = entry.label;

      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('i');

      const value = document.createElement('b');
      value.textContent = `${entry.ms.toFixed(2)} ms · ${(baseline / entry.ms).toFixed(2)}×`;

      bar.append(fill);
      row.append(label, bar, value);
      bars.append(row);

      requestAnimationFrame(() => {
        fill.style.width = `${(entry.ms / slowest) * 100}%`;
      });
    }

    const allMatch = entries.every((entry) => entry.checksum === entries[0].checksum);
    $('#compare-card').hidden = false;
    $('#compare-note').textContent =
      `Frame de ${(width * height / 1e6).toFixed(2)} MP, ${iterations} iteraciones tras 8 de warmup. ` +
      `Solo el kernel (sin copias ni canvas). Checksums ${allMatch ? 'idénticos ✓' : 'distintos ✗'}. ` +
      'En este lazo tan simple, el JIT de V8 es muy competitivo; la ventaja de WASM aparece en predictibilidad, ' +
      'ausencia de GC y en módulos que ya existen en C/C++/Rust.';
  } catch (error) {
    $('#compare-note').textContent = `No se pudo medir: ${error.message}`;
    $('#compare-card').hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = original;
    state.comparing = false;
  }
}

/* ------------------------------------------------------------------ */
/* ABI canónica                                                        */
/* ------------------------------------------------------------------ */

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function runCanonical(host) {
  const name = $('#abi-name').value || 'grayscale';
  const width = clampInt($('#abi-width').value, 1, 64, 12);
  const height = clampInt($('#abi-height').value, 1, 64, 8);
  const mode = Number($('#abi-mode').value);
  $('#abi-width').value = String(width);
  $('#abi-height').value = String(height);

  host.reset();
  const pixels = syntheticFrame(width, height, performance.now() / 500);
  const string = host.lowerString(name);

  let result;
  let output;
  let lowered;
  try {
    ({ result, pixels: output, lowered } = host.processImage({ pixels, width, height, mode }));
  } catch (error) {
    $('#abi-status').textContent = `Error: ${error.message}`;
    return;
  }

  const modeName = ['grayscale', 'invert', 'sepia'][mode] ?? String(mode);

  renderSteps([
    {
      title: 'string → UTF-8',
      detail: `"${name}" ocupa ${string.utf8Length} bytes UTF-8, pero ${string.utf16Length} code units en JavaScript.`,
      code: `ptr=${string.ptr}, len=${string.len}`,
    },
    {
      title: 'list<u8> → (ptr, len)',
      detail: `${formatInt(pixels.length)} bytes de píxeles, alineación 1. No se serializa: queda en la memoria lineal.`,
      code: `ptr=${lowered.list.ptr}, len=${lowered.list.len}`,
    },
    {
      title: 'record { data, width, height } + mode',
      detail: 'El record se aplana en parámetros escalares, sin padding.',
      code: `[${lowered.params.join(', ')}]`,
    },
    {
      title: `process_rgba(..., ${modeName})`,
      detail:
        result >= 0
          ? `Procesó ${formatInt(result)} píxeles in-place y devolvió un i32.`
          : `El módulo rechazó el frame (código ${result}).`,
      code: `ret=${result}`,
    },
  ]);

  const start = Math.min(string.ptr, lowered.list.ptr);
  const end = Math.max(string.ptr + string.len, lowered.list.ptr + lowered.list.len);
  const lines = host.hexdump(start, end - start, 320);
  $('#abi-hexdump').textContent = lines
    .map(
      (line) =>
        `${line.offset.toString(16).padStart(8, '0')}  ${line.hex}  |${line.ascii}|`,
    )
    .join('\n');

  const pages = host.memory.buffer.byteLength / 65536;
  $('#abi-memory-pill').textContent = `${pages} páginas · ${(host.memory.buffer.byteLength / 1024).toFixed(0)} KB`;

  renderKv($('#abi-summary'), [
    ['bytes RGBA', formatInt(pixels.length)],
    ['UTF-8 bytes / UTF-16 units', `${string.utf8Length} / ${string.utf16Length}`],
    ['asignaciones', String(host.allocations)],
    ['retorno', String(result)],
  ]);

  const abiCanvas = $('#abi-canvas');
  abiCanvas.width = width;
  abiCanvas.height = height;
  abiCanvas.style.aspectRatio = `${width} / ${height}`;
  abiCanvas
    .getContext('2d')
    .putImageData(new ImageData(new Uint8ClampedArray(output), width, height), 0, 0);

  $('#abi-status').textContent =
    result >= 0
      ? 'Listo: el string y el frame están en la misma memoria lineal; el resultado se leyó del mismo puntero.'
      : 'El módulo devolvió un error de validación.';
}

/* ------------------------------------------------------------------ */
/* ABI Ethereum                                                        */
/* ------------------------------------------------------------------ */

function renderEthWords(encoded) {
  const body = $('#eth-words-body');
  body.replaceChildren(
    ...encoded.words.map((word) => {
      const row = document.createElement('tr');
      const cells = [
        String(word.index),
        String(word.offset),
        word.kind,
        word.hex,
        word.display,
      ];
      for (const [index, value] of cells.entries()) {
        const cell = document.createElement('td');
        cell.textContent = value;
        if (index === 3) cell.title = word.hex;
        row.append(cell);
      }
      return row;
    }),
  );
  $('#eth-words-pill').textContent = `${encoded.words.length} palabras`;
}

function updateEthCost(calldata) {
  const gas = calldataGas(calldata);
  const oneMegabyte = 1024 * 1024;
  const oneMbGas = 21000 + 16 * oneMegabyte;
  const blockLimit = 30_000_000;

  const container = $('#eth-cost');
  container.replaceChildren();

  const items = [
    {
      label: 'Esta llamada',
      value: `${formatInt(gas.totalGas)} gas`,
      note: `${formatInt(gas.totalBytes)} bytes · ${formatInt(gas.zeroBytes)} ceros`,
    },
    {
      label: 'Un frame de 1 MB',
      value: `${formatInt(oneMbGas)} gas`,
      note: 'solo calldata, sin ejecución',
    },
    {
      label: 'Equivalente en bloques',
      value: `${(oneMbGas / blockLimit).toFixed(2)}`,
      note: `límite de bloque: ${formatInt(blockLimit)} gas`,
    },
  ];

  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'cost__item';
    const label = document.createElement('span');
    label.textContent = item.label;
    const value = document.createElement('strong');
    value.textContent = item.value;
    const note = document.createElement('small');
    note.textContent = item.note;
    card.append(label, value, note);
    container.append(card);
  }
}

function runEthEncode() {
  const name = $('#eth-name').value || 'filtro';
  const mode = Number($('#eth-mode').value);
  const version = clampInt($('#eth-version').value, 0, 0xffffffff, 0);
  const paramsHash = $('#eth-hash').value.trim();

  if (!/^0x[0-9a-fA-F]{64}$/.test(paramsHash)) {
    renderKv($('#eth-summary'), [['error', 'paramsHash debe ser 0x + 64 dígitos hex']]);
    return;
  }

  const id = bytesToHex(keccak256(name));

  let encoded;
  try {
    encoded = encodeCall(ETH_SIGNATURE, [
      { type: 'bytes32', name: 'id', value: id },
      { type: 'string', name: 'name', value: name },
      { type: 'uint8', name: 'mode', value: mode },
      { type: 'uint32', name: 'version', value: version },
      { type: 'bytes32', name: 'paramsHash', value: paramsHash },
    ]);
  } catch (error) {
    renderKv($('#eth-summary'), [['error', error.message]]);
    return;
  }

  state.eth = { encoded, name, mode, version, paramsHash, id };
  $('#eth-calldata').value = encoded.calldata;

  renderEthWords(encoded);
  renderKv($('#eth-summary'), [
    ['firma', ETH_SIGNATURE],
    ['selector', encoded.selector],
    ['id (keccak del nombre)', id],
    ['calldata', `${formatInt(encoded.calldata.length / 2 - 1)} bytes`],
    ['gas intrínseco', `${formatInt(calldataGas(encoded.calldata).totalGas)} gas`],
  ]);
  $('#eth-decoded').replaceChildren();
  $('#eth-return').replaceChildren();
  updateEthCost(encoded.calldata);
}

function runEthDecode() {
  const calldata = $('#eth-calldata').value.trim();
  if (!calldata) {
    renderKv($('#eth-decoded'), [['error', 'Primero codificá una llamada']]);
    return;
  }

  try {
    const decoded = decodeCalldata(ETH_SIGNATURE, calldata);
    const [id, name, mode, version, paramsHash] = decoded.values;
    renderKv($('#eth-decoded'), [
      ['id', id],
      ['name', name],
      ['mode', String(mode)],
      ['version', String(version)],
      ['paramsHash', paramsHash],
      ['selector ✓', calldata.slice(0, 10)],
    ]);
  } catch (error) {
    renderKv($('#eth-decoded'), [['error', error.message]]);
  }
}

function runEthReturn() {
  const eth = state.eth;
  if (!eth) {
    runEthEncode();
    return;
  }

  const encoded = encodeParams([
    { type: 'string', name: 'name', value: eth.name },
    { type: 'uint8', name: 'mode', value: eth.mode },
    { type: 'uint32', name: 'version', value: eth.version },
    { type: 'bytes32', name: 'paramsHash', value: eth.paramsHash },
    { type: 'bool', name: 'enabled', value: true },
  ]);
  const values = decodeParams(ETH_RETURN_TYPES, encoded.hex);

  renderKv($('#eth-return'), [
    ['returndata', `${formatInt(encoded.hex.length / 2 - 1)} bytes`],
    ['name', values[0]],
    ['mode', String(values[1])],
    ['version', String(values[2])],
    ['paramsHash', values[3]],
    ['enabled', String(values[4])],
  ]);
}

function setupEthereum() {
  $('#eth-hash').value = randomBytes32();

  $('#eth-encode').addEventListener('click', runEthEncode);
  $('#eth-decode').addEventListener('click', runEthDecode);
  $('#eth-return-btn').addEventListener('click', runEthReturn);
  $('#eth-random').addEventListener('click', () => {
    $('#eth-hash').value = randomBytes32();
    runEthEncode();
  });

  runEthEncode();
}

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */

async function boot() {
  if (location.protocol === 'file:') {
    throw new Error('La demo necesita un servidor HTTP. Ejecutá "npm run dev" y abrí http://localhost:8080/.');
  }

  setupTabs();
  $('#wit-code').textContent = WIT_CONTRACT;

  const cppPromise = loadInstance('./assets/grayscale_cpp.wasm').catch((error) => {
    console.warn('C++ no disponible:', error);
    return null;
  });
  const manifestPromise = fetch('./assets/manifest.json')
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);

  const [cInstance, cppInstance, abiInstance, manifest] = await Promise.all([
    loadInstance('./assets/grayscale.wasm'),
    cppPromise,
    loadInstance('./assets/grayscale.wasm'),
    manifestPromise,
  ]);

  state.manifest = manifest;

  state.processors.c = new WasmImageProcessor(cInstance, 'apply_grayscale');
  if (cppInstance) {
    state.processors.cpp = new WasmImageProcessor(cppInstance, 'apply_grayscale_cpp');
  } else {
    const option = $('#backend-select option[value="cpp"]');
    option.disabled = true;
    option.textContent = 'C++ · no disponible';
  }

  if (manifest?.modules) {
    for (const [key, info] of Object.entries(manifest.modules)) {
      const cell = document.querySelector(`[data-size="${key}"]`);
      if (cell) cell.textContent = `${(info.bytes / 1024).toFixed(1)} KB`;
    }
    $('#compiler-pill').textContent = manifest.compiler
      ? `${manifest.compiler.kind} ${manifest.compiler.version}`
      : 'binarios precompilados';
    $('#manifest-note').textContent =
      `Tamaños reales de web/assets, generados el ${new Date(manifest.generatedAt).toLocaleString('es-AR')}.`;
  }

  const canonicalHost = new CanonicalHost(abiInstance);

  setBackend('c');
  $('#source-select').addEventListener('change', (event) => {
    if (event.target.value === 'camera') startCamera();
    else stopCamera();
  });
  $('#backend-select').addEventListener('change', (event) => setBackend(event.target.value));
  $('#running').addEventListener('change', (event) => {
    state.running = event.target.checked;
  });
  $('#compare').addEventListener('click', runComparison);
  $('#verify').addEventListener('click', verifyPixels);
  $('#abi-run').addEventListener('click', () => runCanonical(canonicalHost));

  setupEthereum();
  runCanonical(canonicalHost);
  requestAnimationFrame(loop);
}

boot().catch(showBootError);
