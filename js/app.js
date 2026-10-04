import * as db from './db.js';
import * as printer from './printer.js';
import { buildReceipt, buildTestReceipt, encodeEscPos, encodeEscPosRaster, renderReceipt, trxNo, fmtDateTime } from './receipt.js';

const $ = (s) => document.querySelector(s);
const rp = (n) => 'Rp' + Math.round(n || 0).toLocaleString('id-ID');
const int = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : 0; };

const state = { products: [], cart: [], settings: { ...db.DEFAULT_SETTINGS }, modalTrx: null };

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, isError ? 4500 : 2500);
}

async function guard(fn) {
  try { return await fn(); } catch (e) {
    console.error(e);
    if (e?.name !== 'NotFoundError' || !/cancel/i.test(e.message)) toast(e?.message || String(e), true);
  }
}

const emptyRow = (cols, text) => h('tr', {}, h('td', { colspan: cols, class: 'hint' }, text));

function parseDateInput(v) {
  const [y, m, d] = v.split('-').map(Number);
  return new Date(y, m - 1, d);
}
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const endOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
const toDateInput = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ---------- Navigation ---------- */
function showPage(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + name));
  if (name === 'riwayat') guard(renderHistory);
  if (name === 'laporan') guard(renderReport);
  if (name === 'pengaturan') { guard(renderStorageInfo); guard(renderVersionInfo); }
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.page)));

/* ---------- Products state ---------- */
async function refreshProducts() {
  state.products = (await db.getAll('products')).sort((a, b) => a.name.localeCompare(b.name));
  // Drop cart lines whose product vanished (e.g. after delete or import).
  state.cart = state.cart.filter((c) => state.products.some((p) => p.id === c.productId));
  renderCatalog();
  renderCart();
  renderInventory();
  const cats = [...new Set(state.products.map((p) => p.category).filter(Boolean))].sort();
  $('#categoryList').replaceChildren(...cats.map((c) => h('option', { value: c })));
}
const findProduct = (id) => state.products.find((p) => p.id === id);
const matches = (p, q) => !q || [p.name, p.sku, p.category].some((v) => (v || '').toLowerCase().includes(q));

/* ---------- Kasir ---------- */
function renderCatalog() {
  const q = $('#searchProduct').value.trim().toLowerCase();
  const list = state.products.filter((p) => matches(p, q));
  const grid = $('#productGrid');
  grid.replaceChildren(...list.map((p) => {
    const left = p.stock - (state.cart.find((c) => c.productId === p.id)?.qty || 0);
    return h('button', { class: 'product', disabled: left <= 0, onclick: () => addToCart(p.id) },
      h('span', { class: 'p-name' }, p.name),
      h('span', { class: 'p-price' }, rp(p.price)),
      h('span', { class: 'p-stock' + (p.stock <= (p.minStock || 0) ? ' low' : '') }, `Stok ${left}`));
  }));
  if (!list.length) {
    grid.append(h('p', { class: 'empty-msg' }, state.products.length ? 'Produk tidak ditemukan.' : 'Belum ada produk. Tambah dulu di menu Produk.'));
  }
}

function addToCart(id, n = 1) {
  const p = findProduct(id);
  if (!p) return;
  const item = state.cart.find((c) => c.productId === id);
  const qty = (item?.qty || 0) + n;
  if (qty > p.stock) { toast(`Stok ${p.name} tinggal ${p.stock}`, true); return; }
  if (qty <= 0) state.cart = state.cart.filter((c) => c.productId !== id);
  else if (item) item.qty = qty;
  else state.cart.push({ productId: id, qty });
  renderCart();
  renderCatalog();
}

function cartTotals() {
  const subtotal = state.cart.reduce((s, c) => s + (findProduct(c.productId)?.price || 0) * c.qty, 0);
  const discount = Math.min(Math.max(0, int($('#cartDiscount').value)), subtotal);
  return { subtotal, discount, total: subtotal - discount };
}

function renderCart() {
  $('#cartList').replaceChildren(...state.cart.map((c) => {
    const p = findProduct(c.productId);
    return h('li', {},
      h('div', {}, h('div', { class: 'c-name' }, p.name), h('div', { class: 'c-sub' }, `${rp(p.price)} / item`)),
      h('div', { class: 'c-total' }, rp(p.price * c.qty)),
      h('div', { class: 'qty' },
        h('button', { onclick: () => addToCart(p.id, -1), 'aria-label': 'Kurangi' }, '−'),
        h('span', {}, c.qty),
        h('button', { onclick: () => addToCart(p.id, 1), 'aria-label': 'Tambah' }, '+')),
      h('div', { style: 'text-align:right' },
        h('button', { class: 'small danger', onclick: () => addToCart(p.id, -c.qty) }, 'Hapus')));
  }));
  if (!state.cart.length) $('#cartList').append(h('li', { class: 'hint' }, 'Keranjang kosong'));

  const { subtotal, total } = cartTotals();
  const cash = $('#payMethod').value === 'Tunai';
  $('#cartSubtotal').textContent = rp(subtotal);
  $('#cartTotal').textContent = rp(total);
  $('#payAmount').disabled = !cash;
  const paid = int($('#payAmount').value);
  $('#payChange').textContent = cash && paid >= total ? rp(paid - total) : '-';

  const suggestions = cash && total > 0
    ? [...new Set([total, ...[5000, 10000, 20000, 50000, 100000].map((u) => Math.ceil(total / u) * u)])].slice(0, 5)
    : [];
  $('#quickPay').replaceChildren(...suggestions.map((v, i) =>
    h('button', { onclick: () => { $('#payAmount').value = v; renderCart(); } }, i === 0 ? 'Uang pas' : rp(v))));
  $('#checkoutBtn').disabled = !state.cart.length;
}

async function doCheckout() {
  if (!state.cart.length) return;
  const { discount, total } = cartTotals();
  const method = $('#payMethod').value;
  const paid = method === 'Tunai' ? int($('#payAmount').value) : total;
  if (method === 'Tunai' && paid < total) { toast('Uang dibayar kurang dari total', true); return; }
  $('#checkoutBtn').disabled = true;
  try {
    const trx = await db.checkout(state.cart, { discount, method, paid });
    state.cart = [];
    $('#cartDiscount').value = 0;
    $('#payAmount').value = '';
    await refreshProducts();
    toast(`Transaksi ${trxNo(trx)} tersimpan`);
    openReceipt(trx);
    if (state.settings.autoPrint && printer.isConnected()) await guard(() => printTrx(trx));
  } finally {
    renderCart();
  }
}

$('#searchProduct').addEventListener('input', renderCatalog);
$('#searchProduct').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const q = e.target.value.trim().toLowerCase();
  if (!q) return;
  const exact = state.products.find((p) => (p.sku || '').toLowerCase() === q);
  const list = state.products.filter((p) => matches(p, q));
  const target = exact || (list.length === 1 ? list[0] : null);
  if (target) {
    addToCart(target.id);
    e.target.value = '';
    renderCatalog();
  } else if (!list.length) toast('Produk tidak ditemukan', true);
});
$('#cartDiscount').addEventListener('input', renderCart);
$('#payAmount').addEventListener('input', renderCart);
$('#payMethod').addEventListener('change', renderCart);
$('#clearCart').addEventListener('click', () => { state.cart = []; renderCart(); renderCatalog(); });
$('#checkoutBtn').addEventListener('click', () => guard(doCheckout));

/* ---------- Receipt modal ---------- */
function openReceipt(trx) {
  state.modalTrx = trx;
  renderReceipt($('#receiptPreview'), buildReceipt(trx, state.settings));
  $('#modal').hidden = false;
}

async function encodeForPrint(receipt) {
  const opts = { cut: state.settings.autoCut };
  return state.settings.printMode === 'text' ? encodeEscPos(receipt, opts) : await encodeEscPosRaster(receipt, state.settings, opts);
}

async function printTrx(trx) {
  if (!printer.isConnected()) throw new Error('Printer belum terhubung. Hubungkan di Pengaturan, atau pakai "Cetak via sistem".');
  await printer.print(await encodeForPrint(buildReceipt(trx, state.settings)));
  toast('Struk dikirim ke printer');
}

$('#modalPrint').addEventListener('click', () => guard(() => printTrx(state.modalTrx)));
$('#modalSystemPrint').addEventListener('click', () => window.print());
$('#modalClose').addEventListener('click', () => { $('#modal').hidden = true; $('#searchProduct').focus(); });
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').hidden = true; });

/* ---------- Produk ---------- */
function renderInventory() {
  const q = $('#searchInventory').value.trim().toLowerCase();
  const rows = state.products.filter((p) => matches(p, q)).map((p) =>
    h('tr', { class: p.stock <= (p.minStock || 0) ? 'low' : '' },
      h('td', {}, p.sku || '-'),
      h('td', {}, p.name, p.category ? h('small', {}, ` · ${p.category}`) : null),
      h('td', { class: 'num' }, rp(p.price)),
      h('td', { class: 'num' }, rp(p.cost)),
      h('td', { class: 'num' }, p.stock),
      h('td', {}, h('div', { class: 'row-actions' },
        h('button', { class: 'small', onclick: () => editProduct(p) }, 'Edit'),
        h('button', { class: 'small', onclick: () => guard(() => restock(p)) }, 'Stok ±'),
        h('button', { class: 'small danger', onclick: () => guard(() => removeProduct(p)) }, 'Hapus')))));
  $('#inventoryBody').replaceChildren(...(rows.length ? rows : [emptyRow(6, 'Belum ada produk')]));
}

function resetProductForm() {
  const f = $('#productForm');
  f.reset();
  f.elements.id.value = '';
  f.elements.stock.disabled = false;
  $('#productFormTitle').textContent = 'Tambah produk';
  $('#productSubmit').textContent = 'Simpan produk';
}

function editProduct(p) {
  const f = $('#productForm');
  for (const k of ['id', 'sku', 'name', 'category', 'price', 'cost', 'stock', 'minStock']) f.elements[k].value = p[k] ?? '';
  f.elements.stock.disabled = true;
  $('#productFormTitle').textContent = `Edit: ${p.name} (ubah stok lewat tombol "Stok ±")`;
  $('#productSubmit').textContent = 'Update produk';
  f.scrollIntoView({ behavior: 'smooth' });
  f.elements.name.focus();
}

async function restock(p) {
  const raw = prompt(`Ubah stok "${p.name}" (sekarang ${p.stock}).\nAngka positif = tambah, negatif = kurangi:`, '');
  if (raw == null || raw.trim() === '') return;
  const delta = int(raw);
  if (!delta) throw new Error('Jumlah tidak valid');
  const note = prompt('Keterangan:', delta > 0 ? 'Restock' : 'Rusak / hilang');
  if (note == null) return;
  await db.adjustStock(p.id, delta, note.trim());
  await refreshProducts();
  toast(`Stok ${p.name} ${delta > 0 ? '+' : ''}${delta}`);
}

async function removeProduct(p) {
  if (!confirm(`Hapus produk "${p.name}"? Riwayat transaksi tetap tersimpan.`)) return;
  await db.deleteProduct(p.id);
  await refreshProducts();
  toast('Produk dihapus');
}

$('#productForm').addEventListener('submit', (e) => {
  e.preventDefault();
  guard(async () => {
    const el = e.target.elements;
    const data = {
      id: int(el.id.value) || undefined,
      sku: el.sku.value.trim(),
      name: el.name.value.trim(),
      category: el.category.value.trim(),
      price: int(el.price.value),
      cost: int(el.cost.value),
      stock: int(el.stock.value),
      minStock: int(el.minStock.value),
    };
    if (!data.name) throw new Error('Nama produk wajib diisi');
    if (data.price < 0 || data.cost < 0 || data.stock < 0 || data.minStock < 0) throw new Error('Angka tidak boleh negatif');
    await db.saveProduct(data);
    resetProductForm();
    await refreshProducts();
    toast('Produk disimpan');
  });
});
$('#productReset').addEventListener('click', resetProductForm);
$('#searchInventory').addEventListener('input', renderInventory);

/* ---------- Riwayat ---------- */
async function renderHistory() {
  const v = $('#historyDate').value;
  const list = v
    ? await db.getTransactions(startOfDay(parseDateInput(v)).toISOString(), endOfDay(parseDateInput(v)).toISOString())
    : await db.getAll('transactions');
  list.sort((a, b) => b.date.localeCompare(a.date));
  const rows = list.map((t) =>
    h('tr', { class: t.status === 'void' ? 'void' : '' },
      h('td', {}, trxNo(t)),
      h('td', {}, fmtDateTime(t.date)),
      h('td', { class: 'num' }, t.items.reduce((s, i) => s + i.qty, 0)),
      h('td', { class: 'num' }, rp(t.total)),
      h('td', {}, t.status === 'void' ? 'BATAL' : t.method),
      h('td', {}, h('div', { class: 'row-actions' },
        h('button', { class: 'small', onclick: () => openReceipt(t) }, 'Struk'),
        t.status !== 'void' && h('button', { class: 'small danger', onclick: () => guard(() => cancelTrx(t)) }, 'Batalkan')))));
  $('#historyBody').replaceChildren(...(rows.length ? rows : [emptyRow(6, 'Tidak ada transaksi')]));
}

async function cancelTrx(t) {
  if (!confirm(`Batalkan transaksi ${trxNo(t)} (${rp(t.total)})? Stok akan dikembalikan.`)) return;
  await db.voidTransaction(t.id);
  await refreshProducts();
  await renderHistory();
  toast('Transaksi dibatalkan, stok dikembalikan');
}

$('#historyDate').addEventListener('change', () => guard(renderHistory));
$('#historyAll').addEventListener('click', () => { $('#historyDate').value = ''; guard(renderHistory); });

/* ---------- Laporan ---------- */
function reportRange() {
  const now = new Date();
  const mode = $('#reportRange').value;
  if (mode === '7d') return { from: startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6)), to: endOfDay(now) };
  if (mode === 'month') return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: endOfDay(now) };
  if (mode === 'custom') {
    const f = $('#reportFrom').value, t = $('#reportTo').value;
    return { from: f ? startOfDay(parseDateInput(f)) : startOfDay(now), to: t ? endOfDay(parseDateInput(t)) : endOfDay(now) };
  }
  return { from: startOfDay(now), to: endOfDay(now) };
}

async function reportTransactions() {
  const { from, to } = reportRange();
  return db.getTransactions(from.toISOString(), to.toISOString());
}

async function renderReport() {
  const all = await reportTransactions();
  const trxs = all.filter((t) => t.status !== 'void');
  const revenue = trxs.reduce((s, t) => s + t.total, 0);
  const cogs = trxs.reduce((s, t) => s + t.items.reduce((a, i) => a + (i.cost || 0) * i.qty, 0), 0);
  const itemsSold = trxs.reduce((s, t) => s + t.items.reduce((a, i) => a + i.qty, 0), 0);
  const byMethod = {};
  trxs.forEach((t) => { byMethod[t.method] = (byMethod[t.method] || 0) + t.total; });

  const stat = (label, value) => h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value));
  $('#reportStats').replaceChildren(
    stat('Pendapatan', rp(revenue)),
    stat('Laba kotor', rp(revenue - cogs)),
    stat('Transaksi', trxs.length),
    stat('Item terjual', itemsSold),
    stat('Rata-rata / transaksi', rp(trxs.length ? revenue / trxs.length : 0)),
    stat('Dibatalkan', all.length - trxs.length),
    ...Object.entries(byMethod).map(([m, v]) => stat(`Via ${m}`, rp(v))));

  const agg = new Map();
  trxs.forEach((t) => t.items.forEach((i) => {
    const a = agg.get(i.productId) || { name: i.name, qty: 0, total: 0 };
    a.qty += i.qty;
    a.total += i.qty * i.price;
    agg.set(i.productId, a);
  }));
  const top = [...agg.values()].sort((a, b) => b.qty - a.qty).slice(0, 10);
  $('#topProducts').replaceChildren(...(top.length
    ? top.map((a) => h('tr', {}, h('td', {}, a.name), h('td', { class: 'num' }, a.qty), h('td', { class: 'num' }, rp(a.total))))
    : [emptyRow(3, 'Belum ada penjualan')]));

  const low = state.products.filter((p) => p.stock <= (p.minStock || 0)).sort((a, b) => a.stock - b.stock);
  $('#lowStock').replaceChildren(...(low.length
    ? low.map((p) => h('tr', { class: 'low' }, h('td', {}, p.name), h('td', { class: 'num' }, p.stock), h('td', { class: 'num' }, p.minStock || 0)))
    : [emptyRow(3, 'Semua stok aman')]));

  const moves = (await db.getAll('stockMoves')).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30);
  $('#stockMovesBody').replaceChildren(...(moves.length
    ? moves.map((m) => h('tr', {},
      h('td', {}, fmtDateTime(m.date)), h('td', {}, m.name),
      h('td', { class: 'num' }, (m.qty > 0 ? '+' : '') + m.qty), h('td', {}, m.note)))
    : [emptyRow(4, 'Belum ada pergerakan stok')]));
}

function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // block spreadsheet formula injection
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function exportCsv() {
  const trxs = await reportTransactions();
  const rows = [['No', 'Tanggal', 'Status', 'Metode', 'SKU', 'Produk', 'Qty', 'Harga', 'Modal', 'Jumlah', 'Diskon Trx', 'Total Trx']];
  trxs.forEach((t) => t.items.forEach((i) => rows.push([
    trxNo(t), fmtDateTime(t.date), t.status, t.method, i.sku, i.name, i.qty, i.price, i.cost, i.qty * i.price, t.discount, t.total,
  ])));
  const { from, to } = reportRange();
  download(`penjualan_${toDateInput(from)}_${toDateInput(to)}.csv`, '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\n'), 'text/csv');
}

$('#reportRange').addEventListener('change', () => {
  const custom = $('#reportRange').value === 'custom';
  $('#reportFrom').hidden = !custom;
  $('#reportTo').hidden = !custom;
  guard(renderReport);
});
$('#reportFrom').addEventListener('change', () => guard(renderReport));
$('#reportTo').addEventListener('change', () => guard(renderReport));
$('#exportCsv').addEventListener('click', () => guard(exportCsv));

/* ---------- Pengaturan ---------- */
function applySettings() {
  const s = state.settings;
  const f = $('#settingsForm').elements;
  for (const k of ['storeName', 'address', 'phone', 'footer', 'paper', 'printMode']) f[k].value = s[k] ?? '';
  f.autoCut.checked = !!s.autoCut;
  f.autoPrint.checked = !!s.autoPrint;
  $('#storeTitle').textContent = s.storeName || 'POS Offline';
  document.title = s.storeName ? `${s.storeName} · POS` : 'POS Offline';
  document.body.dataset.paper = s.paper;
}

$('#settingsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  guard(async () => {
    const f = e.target.elements;
    state.settings = {
      storeName: f.storeName.value.trim(), address: f.address.value.trim(), phone: f.phone.value.trim(),
      footer: f.footer.value.trim(), paper: f.paper.value, printMode: f.printMode.value,
      autoCut: f.autoCut.checked, autoPrint: f.autoPrint.checked,
    };
    await db.saveSettings(state.settings);
    applySettings();
    toast('Pengaturan disimpan');
  });
});

function updatePrinterUI(s) {
  const text = s.connected ? `${s.type}: ${s.name}` : 'belum terhubung';
  $('#printerChip').textContent = `Printer: ${text}`;
  $('#printerChip').classList.toggle('on', s.connected);
  $('#printerStatus').textContent = s.connected ? `Terhubung — ${text}` : 'Belum terhubung';
}
printer.onChange(updatePrinterUI);

const pad2log = (n) => String(n).padStart(2, '0');
printer.onLog(({ time, msg, level }) => {
  const box = $('#printerLog');
  const t = `${pad2log(time.getHours())}:${pad2log(time.getMinutes())}:${pad2log(time.getSeconds())}`;
  const line = h('div', { class: level === 'error' ? 'err' : '' }, `[${t}] ${msg}`);
  box.append(line);
  while (box.children.length > 300) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
});
$('#clearLog').addEventListener('click', () => { $('#printerLog').replaceChildren(); });
$('#copyLog').addEventListener('click', () => guard(async () => {
  const text = [...$('#printerLog').children].map((d) => d.textContent).join('\n');
  if (!text) { toast('Log masih kosong'); return; }
  await navigator.clipboard.writeText(text);
  toast('Log disalin ke clipboard');
}));

$('#printerChip').addEventListener('click', () => showPage('pengaturan'));
$('#connectBT').addEventListener('click', () => guard(async () => { await printer.connectBluetooth(); toast('Printer Bluetooth terhubung'); }));
$('#connectUSB').addEventListener('click', () => guard(async () => { await printer.connectUSB(); toast('Printer USB terhubung'); }));
$('#disconnectPrinter').addEventListener('click', () => guard(printer.disconnect));
$('#testPrint').addEventListener('click', () => guard(async () => {
  await printer.print(await encodeForPrint(buildTestReceipt(state.settings)));
  toast('Test print dikirim');
}));

$('#exportBackup').addEventListener('click', () => guard(async () => {
  const data = await db.exportAll();
  download(`backup-pos_${toDateInput(new Date())}.json`, JSON.stringify(data), 'application/json');
  toast('Backup diexport');
}));

$('#importBackup').addEventListener('change', (e) => guard(async () => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const data = JSON.parse(await file.text());
  if (!confirm('Import akan MENGGANTI semua data di perangkat ini dengan isi backup. Lanjutkan?')) return;
  await db.importAll(data);
  state.cart = [];
  state.settings = await db.getSettings();
  applySettings();
  await refreshProducts();
  toast('Backup berhasil diimport');
}));

async function renderStorageInfo() {
  if (!navigator.storage?.estimate) return;
  const { usage = 0 } = await navigator.storage.estimate();
  const persisted = await navigator.storage.persisted?.();
  $('#storageInfo').textContent =
    `Data terpakai: ${(usage / 1024 / 1024).toFixed(2)} MB. Penyimpanan permanen: ${persisted ? 'ya' : 'tidak (browser bisa menghapus data saat memori penuh — rajin backup)'}.`;
}

// So "udah update apa belum?" has a straight answer instead of guessing from symptoms — shows
// exactly which cache this device is actually serving from right now, ground truth, not intent.
async function renderVersionInfo() {
  const el = $('#versionInfo');
  if (!('caches' in window)) { el.textContent = 'Browser ini tidak pakai cache offline.'; return; }
  const keys = await caches.keys();
  const active = keys.find((k) => k.startsWith('pos-offline-')) || '(belum ada cache)';
  const reg = await navigator.serviceWorker?.getRegistration();
  const pending = reg?.waiting ? ' — ada update baru siap, akan aktif otomatis sebentar lagi' : reg?.installing ? ' — lagi download update…' : '';
  el.textContent = `Cache aktif di perangkat ini: ${active}${pending}`;
}

$('#checkUpdate').addEventListener('click', () => guard(async () => {
  const reg = await navigator.serviceWorker?.getRegistration();
  if (!reg) { toast('Service worker belum terdaftar', true); return; }
  await reg.update(); // bypass the normal "check at most once a day" throttle, force a check now
  await new Promise((r) => setTimeout(r, 800));
  await renderVersionInfo();
  toast(reg.waiting || reg.installing ? 'Update ditemukan, lagi dipasang…' : 'Sudah versi terbaru');
}));

/* ---------- Boot ---------- */
async function init() {
  navigator.storage?.persist?.().catch(() => {});
  state.settings = await db.getSettings();
  applySettings();
  $('#historyDate').value = toDateInput(new Date());
  await refreshProducts();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW gagal', e));
    // A new sw.js version activates in the background; reload once so the page actually
    // runs the new code instead of silently staying on what's already loaded in memory.
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return;
      reloaded = true;
      location.reload();
    });
  }
}

guard(init);
