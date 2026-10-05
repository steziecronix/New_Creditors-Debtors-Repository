// main.js
//
// Electron entry point. Responsibilities:
//   1. Open the app window, pointed at renderer/login.html
//   2. Open (or create) pos.sqlite3 in the OS's per-user AppData folder and
//      run db/schema.sql against it so a fresh install self-initializes
//   3. Register an ipcMain.handle() for every channel preload.js calls
//
// NOTE on licensing: key-validation logic (Step 11) is still inline for now.
// Step 10 is done — Machine ID generation lives in ./licensing/machine-id.js
// and main.js just requires it below.

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const Database = require('better-sqlite3');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { ThermalPrinter, PrinterTypes } = require('node-thermal-printer');
const CH = require('./ipc-channels');
const { getMachineId } = require('./licensing/machine-id');
const { validateLicenseKey } = require('./licensing/validate-key');

let mainWindow;
let db;

// In-memory session — a fresh login is required every app launch, which is
// the right behaviour for a shared shop terminal.
let session = null;

// In-memory held-sale carts (id -> cart). Not yet persisted to the database;
// see the SALES.HOLD handler below for why.
const heldSales = new Map();
let heldSaleCounter = 1;

// ---------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------
function userDataDir() {
  return app.getPath('userData'); // Windows: %APPDATA%/paul-enterprises-pos
}
function dbPath() {
  return path.join(userDataDir(), 'pos.sqlite3');
}
function backupsDir() {
  const dir = path.join(userDataDir(), 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function exportsDir() {
  const dir = path.join(app.getPath('documents'), 'Paul Enterprises POS Exports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------
// Database bootstrap
// ---------------------------------------------------------------------
function initDatabase() {
  db = new Database(dbPath());
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const schemaSql = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql); // every statement is CREATE TABLE IF NOT EXISTS — safe to re-run on every launch

  runMigrations(); // handles new columns on databases created before this version
  seedSettingsIfEmpty();
  seedDefaultBranchesIfEmpty();
  seedDefaultUsersIfEmpty(); // depends on a branch existing (branch_id FK) — must run after the branch seed
}

// schema.sql already seeds row id=1 via "INSERT OR IGNORE INTO settings (id) VALUES (1)",
// so in practice this is a safety net for older databases created before that line existed —
// it's a no-op on any fresh install, but keeps the app from ever showing an empty Settings
// screen if that seed line is ever removed or a DB predates it.
// "CREATE TABLE IF NOT EXISTS" in schema.sql never adds a column to a table
// that already exists on an older database — SQLite needs an explicit ALTER
// TABLE for that. Each block here is safe to run on every launch: it checks
// whether the column is already present before adding it.
function runMigrations() {
  const settingsCols = db.prepare("PRAGMA table_info(settings)").all().map(c => c.name);
  if (!settingsCols.includes('receipt_contact_line')) {
    db.exec("ALTER TABLE settings ADD COLUMN receipt_contact_line TEXT DEFAULT 'Call Us/WhatsApp/SMS: 0728752018. Asante Sana'");
  }
  if (!settingsCols.includes('printer_port')) {
    db.exec("ALTER TABLE settings ADD COLUMN printer_port TEXT");
  }
  if (!settingsCols.includes('printer_width')) {
    db.exec("ALTER TABLE settings ADD COLUMN printer_width INTEGER NOT NULL DEFAULT 32");
  }
  // Fill in the contact line / phone for databases that already had a settings
  // row before this column existed (ALTER TABLE ADD COLUMN with a DEFAULT only
  // applies that default to *new* rows in some SQLite versions, not existing ones).
  db.prepare("UPDATE settings SET receipt_contact_line = 'Call Us/WhatsApp/SMS: 0728752018. Asante Sana' WHERE id = 1 AND (receipt_contact_line IS NULL OR TRIM(receipt_contact_line) = '')").run();
  db.prepare("UPDATE settings SET phone = '0728752018' WHERE id = 1 AND (phone IS NULL OR TRIM(phone) = '')").run();
}

function seedSettingsIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM settings').get().n;
  if (count > 0) return;
  db.prepare('INSERT INTO settings (id, business_name) VALUES (1, ?)').run('Paul Enterprises');
}

// Fresh install has zero branches, but seedDefaultUsersIfEmpty() below inserts
// a cashier with branch_id = 1 — with foreign_keys=ON that insert fails unless
// a branch row already exists. Give a new install one real branch to start from.
function seedDefaultBranchesIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM branches').get().n;
  if (count > 0) return;
  db.prepare('INSERT INTO branches (name, address) VALUES (?, ?)').run('Main Branch', null);
}

// Gives a brand-new install a working Owner + Cashier login instead of an
// empty, unusable users table. Uses the same PIN/password hashing as real
// account creation (see hashSecret / verifySecret below).
function seedDefaultUsersIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return;

  const insertUser = db.prepare(`
    INSERT INTO users (name, username, password_hash, pin_hash, role, branch_id, is_active)
    VALUES (@name, @username, @password_hash, @pin_hash, @role, @branch_id, 1)
  `);

  insertUser.run({
    name: 'Paul Mwangi',
    username: 'paul.mwangi',
    password_hash: hashSecret('admin123'),
    pin_hash: null,
    role: 'admin',
    branch_id: null,
  });

  insertUser.run({
    name: 'Grace Kamau',
    username: 'grace.k',
    password_hash: null,
    pin_hash: hashSecret('1234'),
    role: 'cashier',
    branch_id: 1,
  });

  console.log('[db] First launch: seeded default owner (paul.mwangi / admin123) and cashier (Grace Kamau, PIN 1234). Change these from Staff Setup.');
}

// ---------------------------------------------------------------------
// Password / PIN hashing — scrypt, part of Node core (no extra dependency)
// ---------------------------------------------------------------------
function hashSecret(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}
function verifySecret(plain, stored) {
  if (!stored) return false;
  const [saltHex, hashHex] = stored.split(':');
  const salt = Buffer.from(saltHex, 'hex');
  const hash = Buffer.from(hashHex, 'hex');
  const check = crypto.scryptSync(String(plain), salt, 64);
  return crypto.timingSafeEqual(hash, check);
}

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------
function logActivity(branchId, userId, action, details) {
  db.prepare(`
    INSERT INTO activity_log (branch_id, user_id, action, details)
    VALUES (?, ?, ?, ?)
  `).run(branchId ?? null, userId ?? null, action, details ?? null);
}
function requireSession() {
  if (!session) throw new Error('Not signed in.');
  return session;
}
function requireAdmin() {
  const s = requireSession();
  if (s.role !== 'admin') throw new Error('Owner access required.');
  return s;
}

// ---------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------
function createWindow() {
  const iconPath = path.join(__dirname, 'renderer', 'assets', 'logo.ico');

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: '#E9EDF6',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload.js needs require('./ipc-channels') — sandboxed preloads can only require Node/Electron built-ins, not local project files. contextIsolation + nodeIntegration:false remain the real security boundary here.
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'login.html'));

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------
app.whenReady().then(() => {
  initDatabase();
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (db) db.close();
});

// ---------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------
function registerIpcHandlers() {

  // ===== AUTH =====
  ipcMain.handle(CH.AUTH.LOGIN_EMPLOYEE, (e, { userId, pin }) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(userId);
    if (!user || !verifySecret(pin, user.pin_hash)) throw new Error('Incorrect PIN.');

    const branch = user.branch_id ? db.prepare('SELECT * FROM branches WHERE id = ?').get(user.branch_id) : null;
    session = { userId: user.id, name: user.name, role: user.role, branchId: user.branch_id, branchName: branch ? branch.name : 'All Branches' };

    const shiftId = db.prepare(`INSERT INTO shifts (branch_id, user_id) VALUES (?, ?)`).run(user.branch_id, user.id).lastInsertRowid;
    session.shiftId = shiftId;

    logActivity(user.branch_id, user.id, 'Clocked in / signed in');
    return session;
  });

  ipcMain.handle(CH.AUTH.LOGIN_OWNER, (e, { username, password }) => {
    const user = db.prepare(`SELECT * FROM users WHERE username = ? AND role = 'admin' AND is_active = 1`).get(username);
    if (!user || !verifySecret(password, user.password_hash)) throw new Error('Incorrect username or password.');

    session = { userId: user.id, name: user.name, role: user.role, branchId: user.branch_id, branchName: 'All Branches' };
    logActivity(user.branch_id, user.id, 'Owner signed in');
    return session;
  });

  ipcMain.handle(CH.AUTH.LOGOUT, () => {
    if (session) {
      if (session.shiftId) {
        db.prepare(`UPDATE shifts SET clock_out = datetime('now') WHERE id = ? AND clock_out IS NULL`).run(session.shiftId);
      }
      logActivity(session.branchId, session.userId, 'Signed out');
    }
    session = null;
    return { success: true };
  });

  ipcMain.handle(CH.AUTH.CURRENT_SESSION, () => session);

  // Pre-login lookup for the sign-in screen's "Staff Member" dropdown.
  // No requireSession() on purpose — nobody is signed in yet at this point.
  // Only id/name/branch are exposed, never pin_hash/password_hash.
  ipcMain.handle(CH.AUTH.LIST_EMPLOYEES, () => {
    return db.prepare(`
      SELECT u.id, u.name, b.name AS branch_name
      FROM users u LEFT JOIN branches b ON b.id = u.branch_id
      WHERE u.role = 'cashier' AND u.is_active = 1
      ORDER BY u.name
    `).all();
  });

  // ===== CATEGORIES =====
  ipcMain.handle(CH.CATEGORIES.LIST, () => {
    requireSession();
    return db.prepare('SELECT * FROM categories ORDER BY name').all();
  });
  ipcMain.handle(CH.CATEGORIES.GET_OR_CREATE, (e, { name }) => {
    requireSession();
    if (!name || !name.trim()) throw new Error('Category name is required.');
    const trimmed = name.trim();
    const existing = db.prepare('SELECT * FROM categories WHERE name = ?').get(trimmed);
    if (existing) return existing;
    const id = db.prepare('INSERT INTO categories (name) VALUES (?)').run(trimmed).lastInsertRowid;
    return db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  });

  // ===== PRODUCTS =====
  ipcMain.handle(CH.PRODUCTS.LIST, (e, filters = {}) => {
    requireSession();
    const { search = '', categoryId = null, activeOnly = true } = filters || {};
    let sql = `
      SELECT p.*, c.name AS category_name
      FROM products p LEFT JOIN categories c ON c.id = p.category_id
      WHERE 1=1
    `;
    const params = [];
    if (activeOnly) sql += ' AND p.is_active = 1';
    if (categoryId) { sql += ' AND p.category_id = ?'; params.push(categoryId); }
    if (search) { sql += ' AND (p.name LIKE ? OR p.sku LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY p.name';
    return db.prepare(sql).all(...params);
  });

  ipcMain.handle(CH.PRODUCTS.GET, (e, { productId }) => {
    requireSession();
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) throw new Error('Product not found.');
    return product;
  });

  ipcMain.handle(CH.PRODUCTS.CREATE, (e, product) => {
    requireSession();
    const { name, sku = null, categoryId = null, unit = 'Piece', costPrice = 0, sellingPrice = 0,
      reorderLevel = 10, expiryDate = null, vatApplicable = true, vatRate = 16,
      // First Order Quantity — the initial stock count for a brand-new product
      // (e.g. "Kenbrest Bread, first order 50 pieces"). Optional; only applied
      // when > 0, to a single branch (defaults to the first branch on record).
      firstOrderQty = 0, initialBranchId = null } = product;
    if (!name) throw new Error('Product name is required.');

    const tx = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO products (name, sku, category_id, unit, cost_price, selling_price, reorder_level, expiry_date, vat_applicable, vat_rate)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(name, sku, categoryId, unit, costPrice, sellingPrice, reorderLevel, expiryDate, vatApplicable ? 1 : 0, vatRate);
      const productId = result.lastInsertRowid;

      // Give the new product a zero-stock row in every branch so it shows up everywhere immediately
      const branches = db.prepare('SELECT id FROM branches').all();
      const insertStock = db.prepare('INSERT OR IGNORE INTO branch_stock (branch_id, product_id, quantity_on_hand) VALUES (?, ?, 0)');
      branches.forEach(b => insertStock.run(b.id, productId));

      const qty = Number(firstOrderQty) || 0;
      if (qty > 0) {
        const targetBranchId = initialBranchId || (branches[0] && branches[0].id);
        if (targetBranchId) {
          db.prepare(`
            UPDATE branch_stock SET quantity_on_hand = quantity_on_hand + ? WHERE branch_id = ? AND product_id = ?
          `).run(qty, targetBranchId, productId);
          // Logged the same way as any other stock movement, so it shows up in the audit trail.
          db.prepare(`
            INSERT INTO stock_adjustments (branch_id, product_id, quantity_change, reason, user_id) VALUES (?, ?, ?, ?, ?)
          `).run(targetBranchId, productId, qty, 'First order quantity (new product)', session.userId);
        }
      }

      return productId;
    });

    const productId = tx();
    logActivity(session.branchId, session.userId, 'Added product', name + (Number(firstOrderQty) > 0 ? ` — first order ${firstOrderQty}` : ''));
    return db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  });

  ipcMain.handle(CH.PRODUCTS.UPDATE, (e, { productId, changes }) => {
    requireSession();
    const allowed = ['name', 'sku', 'category_id', 'unit', 'cost_price', 'selling_price', 'reorder_level', 'expiry_date', 'vat_applicable', 'vat_rate'];
    const fields = Object.keys(changes || {}).filter(k => allowed.includes(k));
    if (fields.length === 0) throw new Error('No valid fields to update.');
    const setSql = fields.map(f => `${f} = ?`).join(', ');
    db.prepare(`UPDATE products SET ${setSql} WHERE id = ?`).run(...fields.map(f => changes[f]), productId);
    logActivity(session.branchId, session.userId, 'Edited product', `#${productId}`);
    return db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  });

  ipcMain.handle(CH.PRODUCTS.DELETE, (e, { productId }) => {
    requireAdmin();
    // Soft delete — keeps sale_items history intact. If no row actually
    // matched (bad/stale id, or it was already inactive), .changes is 0 —
    // treat that as a real failure instead of reporting false success, so
    // the renderer's error path (not the optimistic-removal path) fires.
    const info = db.prepare('UPDATE products SET is_active = 0 WHERE id = ? AND is_active = 1').run(productId);
    if (info.changes === 0) {
      const exists = db.prepare('SELECT is_active FROM products WHERE id = ?').get(productId);
      if (!exists) throw new Error(`No product found with ID #${productId}. It may have been removed already.`);
      throw new Error(`Product #${productId} was already inactive — nothing to remove.`);
    }
    logActivity(session.branchId, session.userId, 'Removed product', `#${productId}`);
    const remainingCount = db.prepare('SELECT COUNT(*) AS c FROM products WHERE is_active = 1').get().c;
    return { success: true, remainingCount };
  });

  // ===== STOCK =====
  ipcMain.handle(CH.STOCK.BRANCH_STOCK, (e, { branchId }) => {
    requireSession();
    return db.prepare(`
      SELECT bs.*, p.name, p.sku, p.reorder_level, p.selling_price
      FROM branch_stock bs JOIN products p ON p.id = bs.product_id
      WHERE bs.branch_id = ? AND p.is_active = 1
      ORDER BY p.name
    `).all(branchId);
  });

  ipcMain.handle(CH.STOCK.LOW_STOCK, (e, { branchId }) => {
    requireSession();
    const sql = `
      SELECT bs.*, p.name, p.sku, p.reorder_level, b.name AS branch_name
      FROM branch_stock bs
      JOIN products p ON p.id = bs.product_id
      JOIN branches b ON b.id = bs.branch_id
      WHERE p.is_active = 1 AND bs.quantity_on_hand <= p.reorder_level
      ${branchId ? 'AND bs.branch_id = ?' : ''}
      ORDER BY bs.quantity_on_hand ASC
    `;
    return branchId ? db.prepare(sql).all(branchId) : db.prepare(sql).all();
  });

  ipcMain.handle(CH.STOCK.ADJUST, (e, { branchId, productId, quantityChange, reason }) => {
    const s = requireSession();
    if (!reason || !reason.trim()) throw new Error('A reason is required for every stock adjustment.');
    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO branch_stock (branch_id, product_id, quantity_on_hand) VALUES (?, ?, ?)
        ON CONFLICT(branch_id, product_id) DO UPDATE SET quantity_on_hand = quantity_on_hand + excluded.quantity_on_hand
      `).run(branchId, productId, quantityChange);
      db.prepare(`
        INSERT INTO stock_adjustments (branch_id, product_id, quantity_change, reason, user_id) VALUES (?, ?, ?, ?, ?)
      `).run(branchId, productId, quantityChange, reason, s.userId);
    });
    tx();
    logActivity(branchId, s.userId, 'Stock adjustment', `product #${productId}, ${quantityChange > 0 ? '+' : ''}${quantityChange} (${reason})`);
    return db.prepare('SELECT * FROM branch_stock WHERE branch_id = ? AND product_id = ?').get(branchId, productId);
  });

  // ===== SALES =====
  ipcMain.handle(CH.SALES.CREATE, (e, sale) => {
    const s = requireSession();
    const { branchId, customerId = null, items, discount = 0, paymentMethod, amountPaid, mpesaRef = null } = sale;
    if (!items || items.length === 0) throw new Error('A sale needs at least one item.');
    if (!['Cash', 'M-Pesa', 'Card', 'Credit', 'Split'].includes(paymentMethod)) throw new Error('Invalid payment method.');

    const tx = db.transaction(() => {
      let subtotal = 0, tax = 0;
      const lineRows = items.map(item => {
        const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.productId);
        if (!product) throw new Error(`Product #${item.productId} not found.`);
        const lineGross = item.quantity * item.unitPrice - (item.discount || 0);
        const vatRate = product.vat_applicable ? product.vat_rate : 0;
        const vatAmount = lineGross * (vatRate / 100);
        subtotal += lineGross;
        tax += vatAmount;
        return { productId: product.id, quantity: item.quantity, unitPrice: item.unitPrice, discount: item.discount || 0, vatRate, vatAmount, lineTotal: lineGross + vatAmount };
      });

      const total = subtotal + tax - discount;
      const balance = paymentMethod === 'Credit' ? Math.max(total - amountPaid, 0) : Math.max(total - amountPaid, 0);

      const receiptNo = `PE-${Date.now().toString().slice(-6)}`;
      const saleId = db.prepare(`
        INSERT INTO sales (branch_id, receipt_no, user_id, customer_id, subtotal, discount, tax, total, payment_method, mpesa_ref, amount_paid, balance, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed')
      `).run(branchId, receiptNo, s.userId, customerId, subtotal, discount, tax, total, paymentMethod, mpesaRef, amountPaid, balance).lastInsertRowid;

      const insertItem = db.prepare(`
        INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, discount, vat_rate, vat_amount, line_total)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const decrementStock = db.prepare(`
        UPDATE branch_stock SET quantity_on_hand = quantity_on_hand - ? WHERE branch_id = ? AND product_id = ?
      `);
      lineRows.forEach(li => {
        insertItem.run(saleId, li.productId, li.quantity, li.unitPrice, li.discount, li.vatRate, li.vatAmount, li.lineTotal);
        decrementStock.run(li.quantity, branchId, li.productId);
      });

      if (balance > 0 && customerId) {
        db.prepare('UPDATE customers SET total_owed = total_owed + ? WHERE id = ?').run(balance, customerId);
      }

      return saleId;
    });

    const saleId = tx();
    logActivity(branchId, s.userId, 'Completed sale', `#${saleId}`);
    return db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  });

  ipcMain.handle(CH.SALES.LIST, (e, filters = {}) => {
    requireSession();
    const { branchId = null, from = null, to = null, status = null } = filters || {};
    let sql = `
      SELECT sa.*, u.name AS cashier_name, b.name AS branch_name
      FROM sales sa JOIN users u ON u.id = sa.user_id JOIN branches b ON b.id = sa.branch_id
      WHERE 1=1
    `;
    const params = [];
    if (branchId) { sql += ' AND sa.branch_id = ?'; params.push(branchId); }
    if (from) { sql += ' AND sa.date_time >= ?'; params.push(from); }
    if (to) { sql += ' AND sa.date_time <= ?'; params.push(to); }
    if (status) { sql += ' AND sa.status = ?'; params.push(status); }
    sql += ' ORDER BY sa.date_time DESC LIMIT 500';
    return db.prepare(sql).all(...params);
  });

  ipcMain.handle(CH.SALES.GET, (e, { saleId }) => {
    requireSession();
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    if (!sale) throw new Error('Sale not found.');
    sale.items = db.prepare(`
      SELECT si.*, p.name AS product_name FROM sale_items si JOIN products p ON p.id = si.product_id WHERE si.sale_id = ?
    `).all(saleId);
    return sale;
  });

  ipcMain.handle(CH.SALES.REFUND, (e, { saleId, items, reason }) => {
    const s = requireSession();
    if (!reason || !reason.trim()) throw new Error('A reason is required for a refund.');
    const original = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    if (!original) throw new Error('Original sale not found.');

    const tx = db.transaction(() => {
      let refundTotal = 0;
      const restock = db.prepare('UPDATE branch_stock SET quantity_on_hand = quantity_on_hand + ? WHERE branch_id = ? AND product_id = ?');
      items.forEach(it => {
        refundTotal += it.lineTotal;
        restock.run(it.quantity, original.branch_id, it.productId);
      });

      const refundReceiptNo = `PE-R-${Date.now().toString().slice(-6)}`;
      const refundId = db.prepare(`
        INSERT INTO sales (branch_id, receipt_no, user_id, customer_id, subtotal, discount, tax, total, payment_method, amount_paid, balance, status, refund_of_sale_id)
        VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, 0, 'refunded', ?)
      `).run(original.branch_id, refundReceiptNo, s.userId, original.customer_id, -refundTotal, -refundTotal, original.payment_method, -refundTotal, saleId).lastInsertRowid;

      const insertItem = db.prepare(`INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, discount, vat_rate, vat_amount, line_total) VALUES (?, ?, ?, ?, 0, 0, 0, ?)`);
      items.forEach(it => insertItem.run(refundId, it.productId, -it.quantity, it.unitPrice, -it.lineTotal));

      return refundId;
    });

    const refundId = tx();
    logActivity(original.branch_id, s.userId, 'Refund issued', `sale #${saleId} → refund #${refundId} (${reason})`);
    return db.prepare('SELECT * FROM sales WHERE id = ?').get(refundId);
  });

  // "Hold sale" is in-memory only for now — it doesn't yet survive an app
  // restart. Persisting held carts to the sales table would need its status
  // CHECK constraint and NOT NULL payment_method relaxed for the 'held'
  // case; revisit once the schema is next touched.
  ipcMain.handle(CH.SALES.HOLD, (e, cart) => {
    const s = requireSession();
    const id = heldSaleCounter++;
    heldSales.set(id, { id, branchId: s.branchId, userId: s.userId, cart, heldAt: new Date().toISOString() });
    return { id };
  });
  ipcMain.handle(CH.SALES.LIST_HELD, (e, { branchId }) => {
    requireSession();
    return [...heldSales.values()].filter(h => !branchId || h.branchId === branchId);
  });
  ipcMain.handle(CH.SALES.RESUME_HELD, (e, { heldSaleId }) => {
    requireSession();
    const held = heldSales.get(heldSaleId);
    if (!held) throw new Error('That held sale is no longer available.');
    heldSales.delete(heldSaleId);
    return held;
  });

  // ===== PURCHASES / SUPPLIERS =====
  ipcMain.handle(CH.PURCHASES.CREATE, (e, purchase) => {
    const s = requireSession();
    const { branchId, supplierId, items, invoiceRef = null, amountPaid = 0 } = purchase;
    if (!items || items.length === 0) throw new Error('A purchase needs at least one item.');

    const tx = db.transaction(() => {
      const totalCost = items.reduce((sum, it) => sum + it.quantity * it.costPrice, 0);
      const status = amountPaid >= totalCost ? 'paid' : (amountPaid > 0 ? 'part-paid' : 'owed');

      const purchaseId = db.prepare(`
        INSERT INTO stock_purchases (branch_id, supplier_id, invoice_ref, total_cost, amount_paid, status, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(branchId, supplierId, invoiceRef, totalCost, amountPaid, status, s.userId).lastInsertRowid;

      const insertItem = db.prepare('INSERT INTO stock_purchase_items (purchase_id, product_id, quantity, cost_price) VALUES (?, ?, ?, ?)');
      const bumpStock = db.prepare(`
        INSERT INTO branch_stock (branch_id, product_id, quantity_on_hand) VALUES (?, ?, ?)
        ON CONFLICT(branch_id, product_id) DO UPDATE SET quantity_on_hand = quantity_on_hand + excluded.quantity_on_hand
      `);
      items.forEach(it => {
        insertItem.run(purchaseId, it.productId, it.quantity, it.costPrice);
        bumpStock.run(branchId, it.productId, it.quantity);
      });

      return purchaseId;
    });

    const purchaseId = tx();
    logActivity(branchId, s.userId, 'Recorded purchase', `#${purchaseId}`);
    return db.prepare('SELECT * FROM stock_purchases WHERE id = ?').get(purchaseId);
  });

  ipcMain.handle(CH.PURCHASES.LIST, (e, filters = {}) => {
    requireSession();
    const { branchId = null } = filters || {};
    let sql = `
      SELECT sp.*, s.name AS supplier_name, b.name AS branch_name
      FROM stock_purchases sp JOIN suppliers s ON s.id = sp.supplier_id JOIN branches b ON b.id = sp.branch_id
      WHERE 1=1
    `;
    const params = [];
    if (branchId) { sql += ' AND sp.branch_id = ?'; params.push(branchId); }
    sql += ' ORDER BY sp.date DESC LIMIT 500';
    const rows = db.prepare(sql).all(...params);
    const itemsStmt = db.prepare(`
      SELECT spi.quantity, p.name FROM stock_purchase_items spi JOIN products p ON p.id = spi.product_id WHERE spi.purchase_id = ?
    `);
    return rows.map(r => ({
      ...r,
      items_summary: itemsStmt.all(r.id).map(i => `${i.name} × ${i.quantity}`).join(', '),
    }));
  });

  ipcMain.handle(CH.SUPPLIERS.LIST, () => { requireSession(); return db.prepare('SELECT * FROM suppliers ORDER BY name').all(); });
  ipcMain.handle(CH.SUPPLIERS.CREATE, (e, supplier) => {
    requireSession();
    const { name, phone = null, notes = null } = supplier;
    if (!name) throw new Error('Supplier name is required.');
    const id = db.prepare('INSERT INTO suppliers (name, phone, notes) VALUES (?, ?, ?)').run(name, phone, notes).lastInsertRowid;
    return db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
  });

  // ===== CUSTOMERS =====
  ipcMain.handle(CH.CUSTOMERS.LIST, () => { requireSession(); return db.prepare('SELECT * FROM customers ORDER BY name').all(); });
  ipcMain.handle(CH.CUSTOMERS.CREATE, (e, customer) => {
    requireSession();
    const { name, phone = null, homeBranchId = null } = customer;
    if (!name) throw new Error('Customer name is required.');
    const id = db.prepare('INSERT INTO customers (name, phone, home_branch_id) VALUES (?, ?, ?)').run(name, phone, homeBranchId).lastInsertRowid;
    return db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  });
  ipcMain.handle(CH.CUSTOMERS.RECORD_PAYMENT, (e, { customerId, amount, saleId = null }) => {
    const s = requireSession();
    if (!amount || amount <= 0) throw new Error('Enter a payment amount greater than zero.');
    const tx = db.transaction(() => {
      db.prepare('INSERT INTO customer_payments (customer_id, amount, sale_id, user_id) VALUES (?, ?, ?, ?)').run(customerId, amount, saleId, s.userId);
      db.prepare('UPDATE customers SET total_owed = MAX(total_owed - ?, 0) WHERE id = ?').run(amount, customerId);
      if (saleId) db.prepare('UPDATE sales SET balance = MAX(balance - ?, 0), amount_paid = amount_paid + ? WHERE id = ?').run(amount, amount, saleId);
    });
    tx();
    logActivity(s.branchId, s.userId, 'Recorded customer payment', `customer #${customerId}, ${amount}`);
    return db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  });
  ipcMain.handle(CH.CUSTOMERS.DEBTORS, () => {
    requireSession();
    return db.prepare('SELECT * FROM customers WHERE total_owed > 0 ORDER BY total_owed DESC').all();
  });

  // Every payment ever recorded against this customer, newest first — this is
  // what lets the UI show "Paid KSh 700 — Wednesday, 14 Aug 2026" per line,
  // not just the current running balance.
  ipcMain.handle(CH.CUSTOMERS.PAYMENT_HISTORY, (e, { customerId }) => {
    requireSession();
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!customer) throw new Error('Customer not found.');
    const payments = db.prepare(`
      SELECT cp.*, u.name AS recorded_by
      FROM customer_payments cp LEFT JOIN users u ON u.id = cp.user_id
      WHERE cp.customer_id = ?
      ORDER BY cp.date DESC
    `).all(customerId);
    return { customer, payments };
  });

  // ===== STAFF =====
  ipcMain.handle(CH.STAFF.LIST, () => {
    requireAdmin();
    return db.prepare(`
      SELECT u.id, u.name, u.username, u.role, u.branch_id, u.is_active, b.name AS branch_name
      FROM users u LEFT JOIN branches b ON b.id = u.branch_id
      ORDER BY u.role, u.name
    `).all();
  });
  ipcMain.handle(CH.STAFF.CREATE, (e, staffMember) => {
    requireAdmin();
    const { name, username, role, branchId = null, pin = null, password = null } = staffMember;
    if (!name || !username || !role) throw new Error('Name, username, and role are required.');
    if (role === 'cashier' && (!pin || pin.length !== 4)) throw new Error('Cashiers need a 4-digit PIN.');
    if (role === 'admin' && !password) throw new Error('Admins need a password.');

    const id = db.prepare(`
      INSERT INTO users (name, username, password_hash, pin_hash, role, branch_id, is_active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(name, username, password ? hashSecret(password) : null, pin ? hashSecret(pin) : null, role, branchId).lastInsertRowid;

    logActivity(session.branchId, session.userId, 'Added staff account', name);
    return db.prepare('SELECT id, name, username, role, branch_id, is_active FROM users WHERE id = ?').get(id);
  });
  ipcMain.handle(CH.STAFF.UPDATE, (e, { userId, changes }) => {
    requireAdmin();
    const fields = [];
    const values = [];
    if (changes.name) { fields.push('name = ?'); values.push(changes.name); }
    if (changes.branchId !== undefined) { fields.push('branch_id = ?'); values.push(changes.branchId); }
    if (changes.pin) { fields.push('pin_hash = ?'); values.push(hashSecret(changes.pin)); }
    if (changes.password) { fields.push('password_hash = ?'); values.push(hashSecret(changes.password)); }
    if (fields.length === 0) throw new Error('No valid fields to update.');
    db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values, userId);
    logActivity(session.branchId, session.userId, 'Edited staff account', `#${userId}`);
    return db.prepare('SELECT id, name, username, role, branch_id, is_active FROM users WHERE id = ?').get(userId);
  });
  ipcMain.handle(CH.STAFF.SET_ACTIVE, (e, { userId, isActive }) => {
    requireAdmin();
    db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, userId);
    logActivity(session.branchId, session.userId, isActive ? 'Reactivated staff account' : 'Deactivated staff account', `#${userId}`);
    return { success: true };
  });
  ipcMain.handle(CH.STAFF.ACTIVITY_LOG, (e, filters = {}) => {
    requireAdmin();
    const { limit = 50 } = filters || {};
    return db.prepare(`
      SELECT al.*, u.name AS user_name FROM activity_log al LEFT JOIN users u ON u.id = al.user_id
      ORDER BY al.timestamp DESC LIMIT ?
    `).all(limit);
  });

  // ===== SHIFTS =====
  ipcMain.handle(CH.SHIFTS.CLOCK_IN, (e, { userId, branchId }) => {
    requireSession();
    const id = db.prepare('INSERT INTO shifts (branch_id, user_id) VALUES (?, ?)').run(branchId, userId).lastInsertRowid;
    return db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
  });
  ipcMain.handle(CH.SHIFTS.CLOCK_OUT, (e, { shiftId }) => {
    requireSession();
    db.prepare(`UPDATE shifts SET clock_out = datetime('now') WHERE id = ?`).run(shiftId);
    return db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId);
  });
  ipcMain.handle(CH.SHIFTS.CURRENT, (e, { userId }) => {
    requireSession();
    return db.prepare('SELECT * FROM shifts WHERE user_id = ? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1').get(userId) || null;
  });

  // ===== REPORTS =====
  ipcMain.handle(CH.REPORTS.DAILY_SALES, (e, { branchId, date }) => {
    requireSession();
    const day = date || new Date().toISOString().slice(0, 10);
    let sql = `SELECT * FROM sales WHERE date(date_time) = date(?) AND status = 'completed'`;
    const params = [day];
    if (branchId) { sql += ' AND branch_id = ?'; params.push(branchId); }
    const sales = db.prepare(sql).all(...params);
    const totals = sales.reduce((acc, s) => {
      acc.totalSales += s.total; acc.transactions += 1;
      acc.byMethod[s.payment_method] = (acc.byMethod[s.payment_method] || 0) + s.total;
      return acc;
    }, { totalSales: 0, transactions: 0, byMethod: {} });
    return { date: day, ...totals, sales };
  });

  ipcMain.handle(CH.REPORTS.SALES_RANGE, (e, { branchId, from, to }) => {
    requireSession();
    let sql = `SELECT * FROM sales WHERE date(date_time) BETWEEN date(?) AND date(?) AND status = 'completed'`;
    const params = [from, to];
    if (branchId) { sql += ' AND branch_id = ?'; params.push(branchId); }
    return db.prepare(sql + ' ORDER BY date_time DESC').all(...params);
  });

  ipcMain.handle(CH.REPORTS.PROFIT, (e, { branchId, from, to }) => {
    requireSession();
    let sql = `
      SELECT si.quantity, si.unit_price, si.line_total, p.cost_price
      FROM sale_items si
      JOIN sales sa ON sa.id = si.sale_id
      JOIN products p ON p.id = si.product_id
      WHERE date(sa.date_time) BETWEEN date(?) AND date(?) AND sa.status = 'completed'
    `;
    const params = [from, to];
    if (branchId) { sql += ' AND sa.branch_id = ?'; params.push(branchId); }
    const rows = db.prepare(sql).all(...params);
    const revenue = rows.reduce((a, r) => a + r.line_total, 0);
    const cost = rows.reduce((a, r) => a + r.quantity * r.cost_price, 0);
    return { revenue, cost, profit: revenue - cost };
  });

  ipcMain.handle(CH.REPORTS.STOCK, (e, { branchId }) => {
    requireSession();
    let sql = `
      SELECT bs.*, p.name, p.sku, p.selling_price, p.cost_price, p.reorder_level, b.name AS branch_name
      FROM branch_stock bs JOIN products p ON p.id = bs.product_id JOIN branches b ON b.id = bs.branch_id
      WHERE p.is_active = 1
    `;
    const params = [];
    if (branchId) { sql += ' AND bs.branch_id = ?'; params.push(branchId); }
    const rows = db.prepare(sql).all(...params);
    const valuation = rows.reduce((a, r) => a + r.quantity_on_hand * r.cost_price, 0);
    return { rows, valuation };
  });

  ipcMain.handle(CH.REPORTS.PURCHASES, (e, { branchId, from, to }) => {
    requireSession();
    let sql = `
      SELECT sp.*, s.name AS supplier_name FROM stock_purchases sp JOIN suppliers s ON s.id = sp.supplier_id
      WHERE date(sp.date) BETWEEN date(?) AND date(?)
    `;
    const params = [from, to];
    if (branchId) { sql += ' AND sp.branch_id = ?'; params.push(branchId); }
    return db.prepare(sql + ' ORDER BY sp.date DESC').all(...params);
  });

  ipcMain.handle(CH.REPORTS.DEBTORS, () => {
    requireSession();
    return db.prepare('SELECT * FROM customers WHERE total_owed > 0 ORDER BY total_owed DESC').all();
  });

  ipcMain.handle(CH.REPORTS.EXPENSES, (e, { branchId, from, to }) => {
    requireSession();
    let sql = `SELECT * FROM expenses WHERE date(date) BETWEEN date(?) AND date(?)`;
    const params = [from, to];
    if (branchId) { sql += ' AND branch_id = ?'; params.push(branchId); }
    return db.prepare(sql + ' ORDER BY date DESC').all(...params);
  });

  ipcMain.handle(CH.REPORTS.EXPORT_EXCEL, async (e, { reportType, params }) => {
    requireSession();
    const rows = await getReportRows(reportType, params);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(reportType);
    if (rows.length > 0) {
      ws.columns = Object.keys(rows[0]).map(key => ({ header: key, key, width: 18 }));
      ws.addRows(rows);
      ws.getRow(1).font = { bold: true };
    }
    const filePath = path.join(exportsDir(), `${reportType}-${Date.now()}.xlsx`);
    await wb.xlsx.writeFile(filePath);
    return { filePath };
  });

  ipcMain.handle(CH.REPORTS.EXPORT_PDF, async (e, { reportType, params }) => {
    requireSession();
    const rows = await getReportRows(reportType, params);
    const filePath = path.join(exportsDir(), `${reportType}-${Date.now()}.pdf`);
    await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40 });
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);
      doc.fontSize(16).text(`Paul Enterprises POS — ${reportType}`, { underline: true });
      doc.moveDown();
      doc.fontSize(9);
      rows.forEach(row => { doc.text(JSON.stringify(row)); });
      doc.end();
      stream.on('finish', resolve);
      stream.on('error', reject);
    });
    return { filePath };
  });

  // ===== SETTINGS =====
  ipcMain.handle(CH.SETTINGS.GET, () => db.prepare('SELECT * FROM settings WHERE id = 1').get());
  ipcMain.handle(CH.SETTINGS.UPDATE, (e, changes) => {
    requireAdmin();
    const allowed = ['business_name', 'address', 'phone', 'tax_id', 'logo_path', 'currency_symbol', 'default_tax_rate', 'receipt_footer', 'receipt_contact_line', 'printer_port', 'printer_width', 'low_stock_default', 'theme', 'sales_target_monthly'];
    const fields = Object.keys(changes || {}).filter(k => allowed.includes(k));
    if (fields.length === 0) throw new Error('No valid settings fields to update.');
    const setSql = fields.map(f => `${f} = ?`).join(', ') + ", updated_at = datetime('now')";
    db.prepare(`UPDATE settings SET ${setSql} WHERE id = 1`).run(...fields.map(f => changes[f]));
    return db.prepare('SELECT * FROM settings WHERE id = 1').get();
  });

  // Data reset — three scopes, all owner-only:
  //   'today' — deletes today's sales, purchases, stock adjustments, expenses,
  //             shifts and customer payments. Everything from earlier days stays.
  //   'month' — same, for the current calendar month.
  //   'full'  — wipes every transactional record AND every staff login except
  //             the owner account performing the reset, and zeroes every
  //             branch's stock counts back to 0. The product catalog,
  //             categories, branches and business settings are left alone —
  //             re-typing the whole shop's inventory is not what "reset"
  //             should mean, and it isn't a "name" that was asked to be cleared.
  //
  // 'today' and 'month' are bucketed by LOCAL calendar day/month (matching the
  // clock in the top bar), not by UTC. All date_time/date/clock_in columns are
  // stored in UTC (via SQLite's datetime('now')), so a straight UTC calendar-day
  // string compare (the old approach) silently misses anything recorded between
  // local midnight and local midnight+UTC-offset — e.g. in Nairobi (UTC+3), a
  // sale rung up at 1am local is still stamped with *yesterday's* UTC date, so
  // "Clear Today's Records" would skip it entirely. Computing an explicit local
  // day/month window and converting its boundaries to UTC for the comparison
  // fixes that regardless of what timezone the machine is in.
  ipcMain.handle(CH.SETTINGS.RESET_DATA, (e, { scope }) => {
    const s = requireAdmin();
    if (!['today', 'month', 'full'].includes(scope)) throw new Error('Invalid reset scope.');

    const tx = db.transaction(() => {
      if (scope === 'today' || scope === 'month') {
        const now = new Date();
        const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
        const start = scope === 'today' ? new Date(y, m, d, 0, 0, 0, 0) : new Date(y, m, 1, 0, 0, 0, 0);
        const end = scope === 'today' ? new Date(y, m, d + 1, 0, 0, 0, 0) : new Date(y, m + 1, 1, 0, 0, 0, 0);
        const toSql = (dt) => dt.toISOString().slice(0, 19).replace('T', ' ');
        const startSql = toSql(start), endSql = toSql(end);
        const range = (colName) => `${colName} >= ? AND ${colName} < ?`;
        const params = [startSql, endSql];

        db.prepare(`DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE ${range('date_time')})`).run(...params);
        db.prepare(`DELETE FROM sales WHERE ${range('date_time')}`).run(...params);
        db.prepare(`DELETE FROM stock_purchase_items WHERE purchase_id IN (SELECT id FROM stock_purchases WHERE ${range('date')})`).run(...params);
        db.prepare(`DELETE FROM stock_purchases WHERE ${range('date')}`).run(...params);
        db.prepare(`DELETE FROM stock_adjustments WHERE ${range('date')}`).run(...params);
        db.prepare(`DELETE FROM expenses WHERE ${range('date')}`).run(...params);
        db.prepare(`DELETE FROM shifts WHERE ${range('clock_in')}`).run(...params);
        db.prepare(`DELETE FROM customer_payments WHERE ${range('date')}`).run(...params);
      } else if (scope === 'full') {
        db.prepare('DELETE FROM sale_items').run();
        db.prepare('DELETE FROM sales').run();
        db.prepare('DELETE FROM stock_purchase_items').run();
        db.prepare('DELETE FROM stock_purchases').run();
        db.prepare('DELETE FROM stock_adjustments').run();
        db.prepare('DELETE FROM expenses').run();
        db.prepare('DELETE FROM shifts').run();
        db.prepare('DELETE FROM customer_payments').run();
        db.prepare('DELETE FROM customers').run();
        db.prepare('DELETE FROM activity_log').run();
        db.prepare('UPDATE branch_stock SET quantity_on_hand = 0').run();
        db.prepare('DELETE FROM users WHERE id != ?').run(s.userId); // keep the owner performing the reset
      }
    });
    tx();
    logActivity(scope === 'full' ? s.branchId : session.branchId, s.userId, 'Data reset', `scope: ${scope}`);
    return { success: true, scope };
  });

  // ===== BRANCHES =====
  ipcMain.handle(CH.BRANCHES.LIST, () => db.prepare('SELECT * FROM branches ORDER BY name').all());
  ipcMain.handle(CH.BRANCHES.CREATE, (e, branch) => {
    requireAdmin();
    const { name, address = null, phone = null } = branch;
    if (!name) throw new Error('Branch name is required.');
    const id = db.prepare('INSERT INTO branches (name, address, phone) VALUES (?, ?, ?)').run(name, address, phone).lastInsertRowid;
    return db.prepare('SELECT * FROM branches WHERE id = ?').get(id);
  });

  // ===== PRINTER =====
  // Direct ESC/POS printing over the printer's COM port (USB or Bluetooth SPP),
  // via node-thermal-printer. This bypasses Windows' GDI print pipeline entirely —
  // no "Generic / Text Only" driver needed, no page-size mismatch, no overlapping
  // text and no wasted paper from an assumed full-page feed. settings.printer_port
  // holds a value like '\\.\COM5' (see Settings → Receipt Printer in the dashboard);
  // settings.printer_width is the character width for the paper (32 for 58mm).
  function getReceiptPrinter(settings) {
    if (!settings.printer_port) return null;
    return new ThermalPrinter({
      type: PrinterTypes.EPSON,
      interface: settings.printer_port,
      width: settings.printer_width || 32,
      removeSpecialCharacters: false,
      options: { timeout: 5000 },
    });
  }

  function money(settings, amount) {
    return `${settings.currency_symbol} ${Number(amount).toFixed(0)}`;
  }

  ipcMain.handle(CH.PRINTER.LIST, () => {
    const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get();
    if (!settings.printer_port) {
      return { configured: false, printers: [], note: 'No thermal printer configured. Set the COM port in Settings → Receipt Printer.' };
    }
    return { configured: true, printers: [{ name: 'Receipt Printer', port: settings.printer_port, width: settings.printer_width }], note: null };
  });

  ipcMain.handle(CH.PRINTER.PRINT_RECEIPT, async (e, { saleId }) => {
    requireSession();
    const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get();
    const sale = db.prepare(`
      SELECT sa.*, u.name AS cashier_name, b.name AS branch_name
      FROM sales sa JOIN users u ON u.id = sa.user_id JOIN branches b ON b.id = sa.branch_id
      WHERE sa.id = ?
    `).get(saleId);
    if (!sale) throw new Error('Sale not found.');
    sale.items = db.prepare(`
      SELECT si.*, p.name AS product_name FROM sale_items si JOIN products p ON p.id = si.product_id WHERE si.sale_id = ?
    `).all(saleId);

    const printer = getReceiptPrinter(settings);
    if (!printer) {
      return { printed: false, note: 'No thermal printer configured — add the COM port in Settings → Receipt Printer.' };
    }

    try {
      printer.clear();
      printer.alignCenter();
      printer.bold(true);
      printer.println(settings.business_name || 'Paul Enterprises');
      printer.bold(false);
      printer.println('Official Sales Receipt');
      printer.println(`Receipt No. ${sale.receipt_no} \u00b7 ${sale.payment_method}`);
      printer.drawLine();

      printer.alignLeft();
      sale.items.forEach(it => {
        printer.leftRight(`${it.product_name} x${it.quantity}`, money(settings, it.line_total));
        printer.println(`  ${it.vat_rate > 0 ? `VAT ${it.vat_rate}% incl.` : 'VAT exempt'}`);
      });
      printer.drawLine();

      printer.leftRight('Subtotal', money(settings, sale.subtotal));
      printer.leftRight('VAT', money(settings, sale.tax));
      printer.leftRight('Discount', `- ${money(settings, sale.discount)}`);
      printer.bold(true);
      printer.setTextDoubleHeight();
      printer.leftRight('Total', money(settings, sale.total));
      printer.setTextNormal();
      printer.bold(false);

      printer.alignCenter();
      printer.newLine();
      printer.println(`Cashier: ${sale.cashier_name} \u00b7 ${sale.branch_name}`);
      printer.println(settings.receipt_footer || 'Thank you for shopping with us!');
      printer.println(settings.receipt_contact_line || '');
      printer.cut();

      await printer.execute();
      return { printed: true, note: null };
    } catch (err) {
      return { printed: false, note: `Print failed: ${err.message}` };
    }
  });

  ipcMain.handle(CH.PRINTER.PRINT_REPORT, () => {
    return { printed: false, note: 'Report printing to the thermal receipt printer isn\'t supported — use Export PDF/Excel from Reports instead.' };
  });

  // ===== LICENSING =====
  // Machine ID generation: ./licensing/machine-id.js
  // Key signature verification: ./licensing/validate-key.js
  // (Keys are issued offline with ./licensing/generate-license-key.js, run
  // by hand by the vendor — that file is never required here and never
  // ships in the packaged app; see licensing/keys/README.md.)
  const LICENSE_REASON_MESSAGES = {
    empty: 'Enter a license key.',
    malformed: 'That license key doesn\'t look right — check you copied the whole thing.',
    'unsupported-schema-version': 'This license key was issued by a newer version of this app. Please update the app and try again.',
    'bad-signature': 'That license key isn\'t valid for this app.',
    'machine-mismatch': 'That license key was issued for a different computer. Contact the vendor with this computer\'s Machine ID to get a new one.',
    expired: 'This license key has expired. Contact the vendor for a renewal.',
  };
  function readStoredLicenseKey() {
    const licenseFile = path.join(userDataDir(), 'license.key');
    if (!fs.existsSync(licenseFile)) return null;
    return fs.readFileSync(licenseFile, 'utf8');
  }
  ipcMain.handle(CH.LICENSING.GET_MACHINE_ID, () => getMachineId());
  ipcMain.handle(CH.LICENSING.GET_STATUS, () => {
    const machineId = getMachineId();
    const storedKey = readStoredLicenseKey();
    if (!storedKey) return { activated: false, machineId };
    // Re-validate on every check, not just "does the file exist" — this is
    // what makes an expiry date actually take effect once it passes,
    // instead of only being checked once at activation time.
    const result = validateLicenseKey(storedKey, machineId);
    return {
      activated: result.valid,
      machineId,
      customer: result.payload?.cust,
      edition: result.payload?.ed,
      expiresOn: result.payload?.exp || null,
      ...(result.valid ? {} : { reason: result.reason }),
    };
  });
  ipcMain.handle(CH.LICENSING.ACTIVATE, (e, { licenseKey }) => {
    requireAdmin();
    const machineId = getMachineId();
    const result = validateLicenseKey(licenseKey, machineId);
    if (!result.valid) {
      throw new Error(LICENSE_REASON_MESSAGES[result.reason] || 'That license key could not be activated.');
    }
    fs.writeFileSync(path.join(userDataDir(), 'license.key'), licenseKey.trim(), 'utf8');
    logActivity(session.branchId, session.userId, 'Activated license', result.payload.cust || '');
    return { activated: true, customer: result.payload.cust, edition: result.payload.ed, expiresOn: result.payload.exp || null };
  });

  // ===== BACKUP =====
  ipcMain.handle(CH.BACKUP.RUN_NOW, async () => {
    requireAdmin();
    const dest = path.join(backupsDir(), `pos-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite3`);
    await db.backup(dest); // better-sqlite3's built-in online backup — safe to run while the app is in use
    logActivity(session.branchId, session.userId, 'Manual backup', dest);
    return { filePath: dest };
  });
  ipcMain.handle(CH.BACKUP.GET_LAST, () => {
    const dir = backupsDir();
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.sqlite3'));
    if (files.length === 0) return null;
    const latest = files.map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtime })).sort((a, b) => b.t - a.t)[0];
    return { filePath: path.join(dir, latest.f), when: latest.t };
  });
}

// ---------------------------------------------------------------------
// Report row lookup shared by EXPORT_EXCEL / EXPORT_PDF
// ---------------------------------------------------------------------
async function getReportRows(reportType, params = {}) {
  const { branchId = null, from = null, to = null, date = null } = params || {};
  switch (reportType) {
    case 'dailySales': return db.prepare(`SELECT * FROM sales WHERE date(date_time) = date(?) ${branchId ? 'AND branch_id = ?' : ''}`).all(...(branchId ? [date || new Date().toISOString().slice(0, 10), branchId] : [date || new Date().toISOString().slice(0, 10)]));
    case 'salesRange': return db.prepare(`SELECT * FROM sales WHERE date(date_time) BETWEEN date(?) AND date(?) ${branchId ? 'AND branch_id = ?' : ''}`).all(...(branchId ? [from, to, branchId] : [from, to]));
    case 'stock': return db.prepare(`SELECT bs.*, p.name, p.sku FROM branch_stock bs JOIN products p ON p.id = bs.product_id ${branchId ? 'WHERE bs.branch_id = ?' : ''}`).all(...(branchId ? [branchId] : []));
    case 'purchases': return db.prepare(`SELECT * FROM stock_purchases WHERE date(date) BETWEEN date(?) AND date(?) ${branchId ? 'AND branch_id = ?' : ''}`).all(...(branchId ? [from, to, branchId] : [from, to]));
    case 'debtors': return db.prepare('SELECT * FROM customers WHERE total_owed > 0').all();
    case 'expenses': return db.prepare(`SELECT * FROM expenses WHERE date(date) BETWEEN date(?) AND date(?) ${branchId ? 'AND branch_id = ?' : ''}`).all(...(branchId ? [from, to, branchId] : [from, to]));
    default: throw new Error(`Unknown report type: ${reportType}`);
  }
}

// ---------------------------------------------------------------------
// Machine ID now lives in ./licensing/machine-id.js (imported above).
// Key-validation logic (Step 11) is still the placeholder check inline
// in the LICENSING.ACTIVATE handler above.
// ---------------------------------------------------------------------
