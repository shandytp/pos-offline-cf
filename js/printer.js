// Common BLE service UUIDs used by cheap ESC/POS thermal printers.
const BLE_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000fee7-0000-1000-8000-00805f9b34fb',
];

let conn = null;
const listeners = new Set();
const logListeners = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Remembers the biggest write size this printer actually accepted, across reconnects, so we
// don't re-waste a failed 200-byte attempt + backoff on every single new connection.
const CHUNK_KEY = 'pos-offline-printer-chunk';
const loadKnownChunk = () => { try { return Number(localStorage.getItem(CHUNK_KEY)) || 200; } catch { return 200; } };
const saveKnownChunk = (n) => { try { localStorage.setItem(CHUNK_KEY, String(n)); } catch { /* storage unavailable */ } };

function emit() {
  listeners.forEach((fn) => fn(status()));
}

function log(msg, level = 'info') {
  const line = { time: new Date(), msg, level };
  logListeners.forEach((fn) => fn(line));
  (level === 'error' ? console.error : console.log)(`[printer] ${msg}`);
}

export const onChange = (fn) => listeners.add(fn);
export const onLog = (fn) => logListeners.add(fn);
export const isConnected = () => !!conn;
export const status = () => (conn ? { connected: true, type: conn.type, name: conn.name } : { connected: false });

export async function connectBluetooth() {
  if (!navigator.bluetooth) {
    log('Web Bluetooth tidak tersedia di browser ini', 'error');
    throw new Error('Browser tidak mendukung Web Bluetooth. Gunakan Chrome di Android via HTTPS/localhost.');
  }
  log('Membuka dialog pilih perangkat Bluetooth…');
  const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
  log(`Perangkat dipilih: "${device.name || '(tanpa nama)'}" (id ${device.id.slice(0, 8)}…)`);

  log('Menyambungkan GATT server…');
  const server = await device.gatt.connect();
  log('GATT server tersambung. Mencari service…');

  const services = await server.getPrimaryServices();
  log(`Ditemukan ${services.length} service: ${services.map((s) => s.uuid).join(', ') || '(kosong)'}`);

  let ch = null, svcUuid = null;
  for (const svc of services) {
    const chars = await svc.getCharacteristics();
    log(`Service ${svc.uuid}: ${chars.length} characteristic (${chars.map((c) => c.uuid.slice(0, 8)).join(', ')})`);
    for (const c of chars) {
      if (c.properties.write || c.properties.writeWithoutResponse) {
        ch = c; svcUuid = svc.uuid;
        log(`Characteristic tulis dipakai: ${c.uuid} (service ${svc.uuid}, writeWithoutResponse=${c.properties.writeWithoutResponse})`);
        break;
      }
    }
    if (ch) break;
  }
  if (!ch) {
    log('Tidak ada characteristic yang bisa ditulis di printer ini', 'error');
    device.gatt.disconnect();
    throw new Error('Characteristic printer tidak ditemukan. Printer mungkin bukan BLE / ESC/POS.');
  }
  await disconnect();
  device.addEventListener('gattserverdisconnected', () => {
    log(`Printer "${device.name || ''}" terputus (gattserverdisconnected)`, 'error');
    if (conn?.device === device) { conn = null; emit(); }
  });
  conn = {
    type: 'Bluetooth',
    name: device.name || 'Printer Bluetooth',
    device,
    async write(data) {
      // 20ms used to be here. Confirmed by a clean log (zero errors, zero retries, "berhasil
      // terkirim") that still printed garbled: Android resolves writeValueWithoutResponse() the
      // moment the write is QUEUED on the OS's BLE stack, not once it's actually gone out over
      // the air. Queue faster than the real connection interval drains and Android can silently
      // drop/reorder bytes — no exception ever reaches JS, which is exactly why every previous
      // fix (chunk size, retry logic) never touched this: nothing here was ever failing loudly.
      const DELAY = 50;
      // The thermal head physically prints far slower (a few mm/s) than BLE can push bytes.
      // Without a pause, the printer's small receive buffer overflows mid-job and its firmware
      // drops the BLE connection to protect itself — exactly the "disconnects around byte
      // 12000" pattern. Stop every BREATHE_EVERY bytes and let it actually print/drain first.
      const BREATHE_EVERY = 3000, BREATHE_MS = 700;
      const writeOnce = (part) => (ch.properties.writeWithoutResponse ? ch.writeValueWithoutResponse(part) : ch.writeValue(part));

      // writeValueWithoutResponse gives no acknowledgment, so when it throws we genuinely do not
      // know how many bytes of that chunk already reached the printer over the air. Resuming at
      // the same offset risked re-sending (duplicating) bytes that had partially landed — that
      // silently shifted/corrupted the image from that point on, identically every time since the
      // same receipt bytes hit the same failure point. The only safe move is a full restart with
      // a smaller chunk size, not "carry on from here".
      const attemptSend = async (chunkSize) => {
        let i = 0, lastLoggedAt = 0, sinceBreathe = 0;
        while (i < data.length) {
          if (!device.gatt.connected) throw new Error(`Printer putus koneksi di byte ${i}/${data.length} (buffer kebanjiran / kehabisan daya?)`);
          const part = data.slice(i, i + chunkSize);
          await writeOnce(part); // let it throw straight up to attemptSend's caller — no resume-in-place
          i += part.length;
          sinceBreathe += part.length;
          if (i - lastLoggedAt >= 2000 || i >= data.length) {
            log(`${i}/${data.length} byte terkirim…`);
            lastLoggedAt = i;
          }
          if (sinceBreathe >= BREATHE_EVERY && i < data.length) {
            sinceBreathe = 0;
            await sleep(BREATHE_MS); // let the print head catch up before the buffer fills again
          } else {
            await sleep(DELAY);
          }
        }
      };

      // Different clone chipsets cap writes differently: some ("cat printer" boards) take
      // 200 bytes fine, others (plain BLE-UART bridges like HM-10/ff00, no MTU negotiated)
      // reject anything over the default ~20-byte ATT MTU. Step down instead of jumping
      // straight to the floor — this device might tolerate 100 or 50, which means far fewer
      // round-trips (and so a much faster print) than assuming the worst case every time.
      const STEPS = [200, 100, 50, 20];
      let stepIdx = Math.max(0, STEPS.indexOf(this.chunkSize || loadKnownChunk()));
      if (stepIdx === -1) stepIdx = 0;

      for (;;) {
        const chunkSize = STEPS[stepIdx];
        try {
          await attemptSend(chunkSize);
        } catch (e) {
          if (stepIdx >= STEPS.length - 1) {
            log(`Gagal kirim walau chunk sudah kecil (${chunkSize} byte): ${e.message}`, 'error');
            throw e;
          }
          stepIdx++;
          log(`Gagal di chunk ${chunkSize} byte (${e.message}) — ulang dari AWAL pake chunk ${STEPS[stepIdx]} byte (gak aman lanjut dari tengah, writeWithoutResponse gak kasih tau berapa byte yang kadung nyampe)…`, 'error');
          await sleep(150);
          continue;
        }
        this.chunkSize = chunkSize;
        saveKnownChunk(chunkSize); // remember what worked, so the next connection starts here instead of probing from 200
        log(`Semua ${data.length} byte terkirim ke printer (chunk ${chunkSize} byte)`);
        return;
      }
    },
    close: () => device.gatt.disconnect(),
  };
  log(`Terhubung ke "${conn.name}" lewat Bluetooth`);
  emit();
  return status();
}

export async function connectUSB() {
  if (!navigator.usb) {
    log('WebUSB tidak tersedia di browser ini', 'error');
    throw new Error('Browser tidak mendukung WebUSB. Gunakan Chrome di Android/desktop.');
  }
  log('Membuka dialog pilih perangkat USB…');
  const device = await navigator.usb.requestDevice({ filters: [] });
  log(`Perangkat dipilih: "${device.productName || '(tanpa nama)'}"`);
  await device.open();
  if (device.configuration === null) await device.selectConfiguration(1);
  let target = null;
  for (const iface of device.configuration.interfaces) {
    for (const alt of iface.alternates) {
      const ep = alt.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
      if (ep && (!target || alt.interfaceClass === 7)) {
        target = { iface: iface.interfaceNumber, alt: alt.alternateSetting, ep: ep.endpointNumber };
      }
    }
  }
  if (!target) {
    log('Endpoint bulk-out tidak ditemukan di perangkat USB ini', 'error');
    await device.close();
    throw new Error('Endpoint printer USB tidak ditemukan.');
  }
  log(`Endpoint ditemukan: interface ${target.iface}, endpoint ${target.ep}`);
  await device.claimInterface(target.iface);
  if (target.alt) await device.selectAlternateInterface(target.iface, target.alt);
  await disconnect();
  conn = {
    type: 'USB',
    name: device.productName || 'Printer USB',
    device,
    async write(data) {
      const chunks = Math.ceil(data.length / 4096);
      log(`Mengirim ${data.length} byte ke endpoint USB dalam ${chunks} chunk…`);
      for (let i = 0; i < data.length; i += 4096) await device.transferOut(target.ep, data.slice(i, i + 4096));
      log('Semua data terkirim ke printer');
    },
    close: () => device.close(),
  };
  log(`Terhubung ke "${conn.name}" lewat USB`);
  emit();
  return status();
}

if (navigator.usb) {
  navigator.usb.addEventListener('disconnect', (e) => {
    if (conn?.device === e.device) { conn = null; emit(); }
  });
}

export async function disconnect() {
  if (!conn) return;
  const c = conn;
  conn = null;
  log(`Memutuskan koneksi dari "${c.name}"`);
  try { await c.close(); } catch { /* already gone */ }
  emit();
}

export async function print(bytes) {
  if (!conn) {
    log('Tombol print ditekan tapi printer belum terhubung', 'error');
    throw new Error('Printer belum terhubung');
  }
  log(`Mulai cetak (${bytes.length} byte) ke ${conn.type} "${conn.name}"`);
  try {
    await conn.write(bytes);
    log('Cetak selesai, ESC/POS terkirim penuh');
  } catch (e) {
    log(`Gagal kirim ke printer: ${e.message}`, 'error');
    throw e;
  }
}
