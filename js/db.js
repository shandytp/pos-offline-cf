import { trxNo } from './receipt.js';

const DB_NAME = 'pos-offline';
const DB_VERSION = 1;
const STORES = ['products', 'transactions', 'stockMoves', 'settings'];
let dbPromise;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      const p = db.createObjectStore('products', { keyPath: 'id', autoIncrement: true });
      p.createIndex('sku', 'sku');
      const t = db.createObjectStore('transactions', { keyPath: 'id', autoIncrement: true });
      t.createIndex('date', 'date');
      const m = db.createObjectStore('stockMoves', { keyPath: 'id', autoIncrement: true });
      m.createIndex('date', 'date');
      db.createObjectStore('settings', { keyPath: 'key' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbPromise;
}

const req = (r) => new Promise((res, rej) => {
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

// fn must only await IndexedDB requests, otherwise the transaction auto-commits.
async function run(stores, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result, failure;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(failure || t.error);
    t.onabort = () => reject(failure || t.error || new Error('Transaksi database dibatalkan'));
    Promise.resolve().then(() => fn(t)).then(
      (r) => { result = r; },
      (err) => { failure = err; try { t.abort(); } catch { reject(err); } }
    );
  });
}

export const getAll = (store) => run([store], 'readonly', (t) => req(t.objectStore(store).getAll()));

export const getTransactions = (fromISO, toISO) => run(['transactions'], 'readonly', (t) =>
  req(t.objectStore('transactions').index('date').getAll(IDBKeyRange.bound(fromISO, toISO))));

export const DEFAULT_SETTINGS = {
  storeName: 'Toko Saya',
  address: '',
  phone: '',
  footer: 'Terima kasih atas kunjungan Anda',
  paper: '58',
  autoCut: false,
  autoPrint: true,
  printMode: 'raster',
};

export async function getSettings() {
  const row = await run(['settings'], 'readonly', (t) => req(t.objectStore('settings').get('app')));
  return { ...DEFAULT_SETTINGS, ...(row?.value || {}) };
}

export const saveSettings = (value) =>
  run(['settings'], 'readwrite', (t) => req(t.objectStore('settings').put({ key: 'app', value })));

export function saveProduct(input) {
  return run(['products', 'stockMoves'], 'readwrite', async (t) => {
    const ps = t.objectStore('products');
    const all = await req(ps.getAll());
    if (input.sku && all.some((p) => p.sku === input.sku && p.id !== input.id)) {
      throw new Error(`SKU "${input.sku}" sudah dipakai produk lain`);
    }
    const now = new Date().toISOString();
    const fields = {
      sku: input.sku, name: input.name, category: input.category,
      price: input.price, cost: input.cost, minStock: input.minStock, updatedAt: now,
    };
    if (input.id) {
      const cur = all.find((p) => p.id === input.id);
      if (!cur) throw new Error('Produk tidak ditemukan');
      const p = { ...cur, ...fields };
      await req(ps.put(p));
      return p;
    }
    const p = { ...fields, stock: Math.max(0, input.stock || 0), createdAt: now };
    p.id = await req(ps.add(p));
    if (p.stock) {
      t.objectStore('stockMoves').add({ date: now, productId: p.id, name: p.name, qty: p.stock, type: 'initial', note: 'Stok awal' });
    }
    return p;
  });
}

export const deleteProduct = (id) => run(['products'], 'readwrite', (t) => req(t.objectStore('products').delete(id)));

export function adjustStock(productId, delta, note) {
  return run(['products', 'stockMoves'], 'readwrite', async (t) => {
    const ps = t.objectStore('products');
    const p = await req(ps.get(productId));
    if (!p) throw new Error('Produk tidak ditemukan');
    if (p.stock + delta < 0) throw new Error(`Stok tidak boleh minus (stok sekarang ${p.stock})`);
    const now = new Date().toISOString();
    p.stock += delta;
    p.updatedAt = now;
    ps.put(p);
    t.objectStore('stockMoves').add({ date: now, productId, name: p.name, qty: delta, type: 'adjust', note: note || 'Penyesuaian' });
    return p;
  });
}

export function checkout(cart, { discount = 0, method = 'Tunai', paid = 0 }) {
  return run(['products', 'transactions', 'stockMoves'], 'readwrite', async (t) => {
    const ps = t.objectStore('products');
    const date = new Date().toISOString();
    const items = [];
    for (const c of cart) {
      const p = await req(ps.get(c.productId));
      if (!p) throw new Error('Ada produk di keranjang yang sudah dihapus');
      if (p.stock < c.qty) throw new Error(`Stok ${p.name} tidak cukup (sisa ${p.stock})`);
      p.stock -= c.qty;
      p.updatedAt = date;
      ps.put(p);
      items.push({ productId: p.id, sku: p.sku, name: p.name, price: p.price, cost: p.cost || 0, qty: c.qty });
    }
    const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
    const disc = Math.min(Math.max(0, discount), subtotal);
    const total = subtotal - disc;
    const pay = method === 'Tunai' ? paid : total;
    if (pay < total) throw new Error('Uang dibayar kurang dari total');
    const trx = { date, items, subtotal, discount: disc, total, method, paid: pay, change: pay - total, status: 'paid' };
    trx.id = await req(t.objectStore('transactions').add(trx));
    const ms = t.objectStore('stockMoves');
    for (const i of items) {
      ms.add({ date, productId: i.productId, name: i.name, qty: -i.qty, type: 'sale', note: `Penjualan ${trxNo(trx)}` });
    }
    return trx;
  });
}

export function voidTransaction(id) {
  return run(['products', 'transactions', 'stockMoves'], 'readwrite', async (t) => {
    const ts = t.objectStore('transactions');
    const trx = await req(ts.get(id));
    if (!trx) throw new Error('Transaksi tidak ditemukan');
    if (trx.status === 'void') throw new Error('Transaksi sudah dibatalkan');
    const now = new Date().toISOString();
    const ps = t.objectStore('products');
    const ms = t.objectStore('stockMoves');
    for (const i of trx.items) {
      const p = await req(ps.get(i.productId));
      if (!p) continue;
      p.stock += i.qty;
      p.updatedAt = now;
      ps.put(p);
      ms.add({ date: now, productId: p.id, name: p.name, qty: i.qty, type: 'void', note: `Batal ${trxNo(trx)}` });
    }
    trx.status = 'void';
    trx.voidedAt = now;
    ts.put(trx);
    return trx;
  });
}

export async function exportAll() {
  const out = { app: 'pos-offline', version: DB_VERSION, exportedAt: new Date().toISOString() };
  for (const s of STORES) out[s] = await getAll(s);
  return out;
}

export function importAll(data) {
  if (!data || data.app !== 'pos-offline' || !STORES.every((s) => Array.isArray(data[s]))) {
    throw new Error('File backup tidak valid');
  }
  return run(STORES, 'readwrite', async (t) => {
    for (const s of STORES) {
      const os = t.objectStore(s);
      await req(os.clear());
      for (const row of data[s]) os.put(row);
    }
  });
}
