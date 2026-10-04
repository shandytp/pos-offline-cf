const pad2 = (n) => String(n).padStart(2, '0');
const num = (n) => Math.round(n || 0).toLocaleString('id-ID');

export function trxNo(t) {
  const d = new Date(t.date);
  return `${String(d.getFullYear()).slice(2)}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${String(t.id).padStart(5, '0')}`;
}

export function fmtDateTime(iso) {
  const d = new Date(iso);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function lr(left, right, w) {
  left = String(left);
  right = String(right);
  const space = w - left.length - right.length;
  if (space >= 1) return left + ' '.repeat(space) + right;
  return left.slice(0, Math.max(0, w - right.length - 1)) + ' ' + right;
}

function wrap(text, w) {
  const out = [];
  let cur = '';
  for (let word of String(text).split(/\s+/).filter(Boolean)) {
    while (word.length > w) {
      if (cur) { out.push(cur); cur = ''; }
      out.push(word.slice(0, w));
      word = word.slice(w);
    }
    if (!word) continue;
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= w) cur += ' ' + word;
    else { out.push(cur); cur = word; }
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

export function buildReceipt(trx, s) {
  const w = s.paper === '80' ? 48 : 32;
  const ops = [];
  const line = (text = '', o = {}) => ops.push({ text, ...o });
  const sep = () => line('-'.repeat(w));

  wrap(s.storeName || 'TOKO', Math.floor(w / 2)).forEach((t) => line(t, { align: 'center', bold: true, big: true }));
  if (s.address) wrap(s.address, w).forEach((t) => line(t, { align: 'center' }));
  if (s.phone) line(s.phone, { align: 'center' });
  sep();
  line(lr('No', trxNo(trx), w));
  line(lr('Tanggal', fmtDateTime(trx.date), w));
  if (trx.status === 'void') line('*** DIBATALKAN ***', { align: 'center', bold: true });
  sep();
  for (const it of trx.items) {
    wrap(it.name, w).forEach((t) => line(t));
    line(lr(`  ${it.qty} x ${num(it.price)}`, num(it.qty * it.price), w));
  }
  sep();
  line(lr('Subtotal', num(trx.subtotal), w));
  if (trx.discount) line(lr('Diskon', '-' + num(trx.discount), w));
  line(lr('TOTAL', num(trx.total), w), { bold: true });
  line(lr(trx.method, num(trx.paid), w));
  if (trx.method === 'Tunai') line(lr('Kembali', num(trx.change), w));
  sep();
  if (s.footer) wrap(s.footer, w).forEach((t) => line(t, { align: 'center' }));
  return { ops, width: w };
}

export function buildTestReceipt(s) {
  const w = s.paper === '80' ? 48 : 32;
  return {
    width: w,
    ops: [
      { text: 'TEST PRINT', align: 'center', bold: true, big: true },
      { text: s.storeName || '', align: 'center' },
      { text: '-'.repeat(w) },
      { text: lr('Lebar kertas', `${s.paper} mm`, w) },
      { text: lr('Karakter/baris', String(w), w) },
      { text: '1234567890'.repeat(5).slice(0, w) },
      { text: 'Printer OK', align: 'center', bold: true },
    ],
  };
}

function toAscii(text) {
  const clean = String(text).normalize('NFD').replace(/[̀-ͯ]/g, '');
  const bytes = [];
  for (const ch of clean) {
    const c = ch.charCodeAt(0);
    bytes.push(c >= 32 && c <= 126 ? c : 0x3f);
  }
  return bytes;
}

export function encodeEscPos({ ops }, { cut = false } = {}) {
  const out = [0x1b, 0x40, 0x1b, 0x74, 0x00];
  for (const op of ops) {
    out.push(0x1b, 0x61, op.align === 'center' ? 1 : op.align === 'right' ? 2 : 0);
    out.push(0x1b, 0x45, op.bold ? 1 : 0);
    out.push(0x1d, 0x21, op.big ? 0x11 : 0x00);
    out.push(...toAscii(op.text), 0x0a);
  }
  out.push(0x1b, 0x61, 0, 0x1b, 0x45, 0, 0x1d, 0x21, 0);
  out.push(0x1b, 0x64, 4);
  if (cut) out.push(0x1d, 0x56, 0x42, 0x00);
  return new Uint8Array(out);
}

// Cheap BLE thermal printers (Phomemo T02/M02 and clones) have no font ROM — they only
// understand raw raster bit images (ESC/POS "GS v 0"). Rendering to canvas first works on
// every ESC/POS printer (raster is part of the spec), unlike plain ASCII text commands.
function renderToCanvas({ ops, width: chars }, s) {
  const dotsWidth = s.paper === '80' ? 576 : 384; // 203dpi: 384 dots = 48mm print area (confirmed T02 spec)
  const canvas = document.createElement('canvas');
  canvas.width = dotsWidth;
  const ctx = canvas.getContext('2d');

  ctx.font = '24px monospace';
  const probeWidth = ctx.measureText('M'.repeat(chars)).width;
  const fontSize = Math.max(8, Math.floor(24 * (dotsWidth / probeWidth)));
  // Tighter spacing than a screen UI would use: every extra row of pixels here is more bytes
  // over an already slow BLE link, and this only has to be legible on thermal paper, not pretty.
  const lineHeight = Math.round(fontSize * 1.2);
  const bigScale = 1.35;
  const margin = 3;

  let height = margin * 2;
  for (const op of ops) height += Math.round(lineHeight * (op.big ? bigScale : 1));
  canvas.height = height;

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, dotsWidth, height);
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'top';

  let y = margin;
  for (const op of ops) {
    const size = Math.round(fontSize * (op.big ? bigScale : 1));
    ctx.font = `${op.bold ? 'bold ' : ''}${size}px monospace`;
    const text = op.text || '';
    const textWidth = ctx.measureText(text).width;
    let x = margin;
    if (op.align === 'center') x = Math.max(margin, (dotsWidth - textWidth) / 2);
    else if (op.align === 'right') x = Math.max(margin, dotsWidth - textWidth - margin);
    ctx.fillText(text, x, y);
    y += Math.round(lineHeight * (op.big ? bigScale : 1));
  }
  return canvas;
}

export function encodeEscPosRaster(receipt, s, { cut = false } = {}) {
  const canvas = renderToCanvas(receipt, s);
  const { width: dotsWidth, height } = canvas;
  const { data } = canvas.getContext('2d').getImageData(0, 0, dotsWidth, height);
  const bytesPerRow = dotsWidth / 8;

  const out = [0x1b, 0x40]; // ESC @: init
  const MAX_ROWS = 255; // printer buffer limit per raster block (documented for this printer class)
  for (let y0 = 0; y0 < height; y0 += MAX_ROWS) {
    const rows = Math.min(MAX_ROWS, height - y0);
    // GS v 0: print raster bit image — m=0 normal, then width/height in bytes, little-endian 16bit
    out.push(0x1d, 0x76, 0x30, 0x00, bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff, rows & 0xff, (rows >> 8) & 0xff);
    for (let y = y0; y < y0 + rows; y++) {
      for (let bx = 0; bx < bytesPerRow; bx++) {
        let byte = 0;
        for (let bit = 0; bit < 8; bit++) {
          const idx = (y * dotsWidth + bx * 8 + bit) * 4;
          const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
          if (lum < 180) byte |= 0x80 >> bit; // dark pixel -> dot printed (bit=1), MSB first
        }
        out.push(byte);
      }
    }
  }
  out.push(0x1b, 0x64, 4); // feed
  if (cut) out.push(0x1d, 0x56, 0x42, 0x00);
  return new Uint8Array(out);
}

export function renderReceipt(el, { ops, width }) {
  el.style.setProperty('--cols', width);
  el.replaceChildren(...ops.map((op) => {
    const div = document.createElement('div');
    div.className = ['a-' + (op.align || 'left'), op.bold && 'b', op.big && 'big'].filter(Boolean).join(' ');
    div.textContent = op.text || ' ';
    return div;
  }));
}
