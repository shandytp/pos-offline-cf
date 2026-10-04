# POS Offline — Requirements

## 1. Tujuan
Aplikasi kasir (POS) + inventory ringan untuk usaha kecil, jalan di HP/tablet **tanpa internet**, bisa cetak struk ke printer thermal kecil.

## 2. Arsitektur
| Aspek | Keputusan |
|---|---|
| Bentuk | PWA (web app yang di-install ke homescreen) — HTML/CSS/JS polos, tanpa build tool |
| Penyimpanan | IndexedDB di browser perangkat (tidak ada server / database cloud) |
| Offline | Service worker cache semua file app; setelah install pertama, jalan 100% offline |
| Printer | ESC/POS via Web Bluetooth (printer BLE) atau WebUSB (kabel USB OTG); fallback cetak via dialog print sistem |
| Browser target | Chrome / Edge di Android. iOS/Safari tidak mendukung Web Bluetooth & WebUSB |
| Backup | Export/import file JSON manual |

Kenapa tanpa database server: semua data hidup di satu perangkat. IndexedDB sudah merupakan database lokal bawaan browser, tidak perlu di-install. Risiko: data hilang jika data browser dihapus → wajib backup berkala (fitur export JSON).

## 3. Kebutuhan Fungsional

### F1. Inventory
- Tambah / edit / hapus produk: SKU/barcode, nama, kategori, harga jual, harga modal, stok, stok minimum.
- SKU unik (boleh kosong).
- Penyesuaian stok (tambah/kurang) dengan keterangan; semua perubahan tercatat di log pergerakan stok.
- Tandai produk dengan stok ≤ stok minimum.

### F2. Kasir (transaksi)
- Cari produk berdasarkan nama/SKU; scan barcode (scanner mode keyboard) + Enter langsung masuk keranjang.
- Keranjang: ubah qty, hapus item, diskon nominal.
- Metode bayar: Tunai, QRIS, Transfer, Debit. Tunai: input uang dibayar + tombol cepat, hitung kembalian.
- Tidak boleh jual melebihi stok.
- Checkout atomik: kurangi stok + simpan transaksi + log stok dalam satu transaksi database (gagal = batal semua).

### F3. Struk
- Format teks sederhana: nama toko, alamat, telp, nomor & tanggal transaksi, item, subtotal, diskon, total, bayar, kembali, catatan bawah.
- Lebar kertas 58 mm (32 karakter) atau 80 mm (48 karakter).
- Preview di layar, cetak ulang dari riwayat.

### F4. Printer
- Hubungkan printer thermal via Bluetooth (BLE) atau USB.
- Test print, auto-cut opsional, cetak otomatis setelah bayar opsional.
- Fallback: "Cetak via sistem" (Android print service, mis. app RawBT untuk printer Bluetooth classic).

### F5. Riwayat & Pembatalan
- Daftar transaksi per tanggal, lihat & cetak ulang struk.
- Batalkan transaksi: status void, stok dikembalikan, tidak dihitung di pendapatan.

### F6. Laporan
- Periode: hari ini, 7 hari, bulan ini, custom.
- Pendapatan, jumlah transaksi, item terjual, laba kotor (harga jual − modal), rata-rata per transaksi, per metode bayar.
- Produk terlaris, stok menipis, pergerakan stok terakhir.
- Export CSV.

### F7. Pengaturan & Backup
- Data toko untuk header/footer struk.
- Export/import backup JSON.
- Minta storage persisten agar browser tidak menghapus data otomatis.

## 4. Kebutuhan Non-Fungsional
- Jalan offline penuh setelah instalasi pertama.
- Responsif: HP (portrait) & tablet (landscape).
- Tanpa dependency eksternal / CDN.
- Aman dari XSS (render data pakai textContent), CSV aman dari formula injection.

## 5. Batasan Diketahui
- Web Bluetooth hanya untuk printer **BLE**. Printer Bluetooth Classic (SPP) saja tidak terdeteksi → pakai USB atau fallback print sistem (RawBT).
- Web Bluetooth/USB butuh HTTPS atau `localhost`.
- Koneksi printer perlu dipilih ulang tiap app dibuka (batasan keamanan browser).
- Data per perangkat; tidak sinkron antar perangkat (bisa pindah via backup JSON).
