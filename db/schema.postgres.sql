-- =====================================================================
-- Paul Enterprises POS — Postgres / Supabase Schema
-- Run once in the Supabase SQL editor (Project → SQL Editor → New query)
-- This is the online, multi-PC version of db/schema.sql (SQLite).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Settings — single-row table, business profile & app-wide defaults
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  business_name     TEXT NOT NULL DEFAULT 'Paul Enterprises',
  address           TEXT,
  phone             TEXT DEFAULT '0728752018',
  tax_id            TEXT,
  logo_path         TEXT,
  currency_symbol   TEXT NOT NULL DEFAULT 'KSh',
  default_tax_rate  REAL NOT NULL DEFAULT 16.0,
  receipt_footer    TEXT DEFAULT 'Thank you for shopping with us!',
  receipt_contact_line TEXT DEFAULT 'Call Us/WhatsApp/SMS: 0728752018. Asante Sana',
  low_stock_default INTEGER NOT NULL DEFAULT 10,
  theme             TEXT NOT NULL DEFAULT 'light' CHECK (theme IN ('light','dark')),
  sales_target_monthly REAL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Branches
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS branches (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  address     TEXT,
  phone       TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Users — admins & cashiers, PIN or password login
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  username       TEXT NOT NULL UNIQUE,
  password_hash  TEXT,
  pin_hash       TEXT,
  role           TEXT NOT NULL CHECK (role IN ('admin','cashier')),
  branch_id      INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_branch ON users(branch_id);

-- ---------------------------------------------------------------------
-- Categories
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id    SERIAL PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE
);

-- ---------------------------------------------------------------------
-- Products — shared catalog across branches
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  sku             TEXT UNIQUE,
  category_id     INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  unit            TEXT DEFAULT 'Piece',
  cost_price      REAL NOT NULL DEFAULT 0,
  selling_price   REAL NOT NULL DEFAULT 0,
  reorder_level   INTEGER NOT NULL DEFAULT 10,
  expiry_date     TEXT,
  vat_applicable  INTEGER NOT NULL DEFAULT 1 CHECK (vat_applicable IN (0,1)),
  vat_rate        REAL NOT NULL DEFAULT 16.0,
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);

-- ---------------------------------------------------------------------
-- BranchStock — stock tracked per branch, per product
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS branch_stock (
  id               SERIAL PRIMARY KEY,
  branch_id        INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  product_id       INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity_on_hand REAL NOT NULL DEFAULT 0,
  UNIQUE (branch_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_branchstock_product ON branch_stock(product_id);

-- ---------------------------------------------------------------------
-- Suppliers
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suppliers (
  id      SERIAL PRIMARY KEY,
  name    TEXT NOT NULL,
  phone   TEXT,
  notes   TEXT
);

-- ---------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  phone          TEXT,
  total_owed     REAL NOT NULL DEFAULT 0,
  home_branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Sales — one row per completed transaction
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales (
  id              SERIAL PRIMARY KEY,
  branch_id       INTEGER NOT NULL REFERENCES branches(id),
  receipt_no      TEXT NOT NULL UNIQUE,
  date_time       TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id         INTEGER NOT NULL REFERENCES users(id),
  customer_id     INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  subtotal        REAL NOT NULL DEFAULT 0,
  discount        REAL NOT NULL DEFAULT 0,
  tax             REAL NOT NULL DEFAULT 0,
  total           REAL NOT NULL DEFAULT 0,
  payment_method  TEXT NOT NULL CHECK (payment_method IN ('Cash','M-Pesa','Card','Credit','Split')),
  mpesa_ref       TEXT,
  amount_paid     REAL NOT NULL DEFAULT 0,
  balance         REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','held','refunded','void')),
  refund_of_sale_id INTEGER REFERENCES sales(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sales_branch_date ON sales(branch_id, date_time);
CREATE INDEX IF NOT EXISTS idx_sales_user ON sales(user_id);
CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(status);

-- ---------------------------------------------------------------------
-- SaleItems — line items per sale, VAT calculated line-by-line
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sale_items (
  id           SERIAL PRIMARY KEY,
  sale_id      INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id   INTEGER NOT NULL REFERENCES products(id),
  quantity     REAL NOT NULL,
  unit_price   REAL NOT NULL,
  discount     REAL NOT NULL DEFAULT 0,
  vat_rate     REAL NOT NULL DEFAULT 0,
  vat_amount   REAL NOT NULL DEFAULT 0,
  line_total   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saleitems_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_saleitems_product ON sale_items(product_id);

-- ---------------------------------------------------------------------
-- CustomerPayments — payments against a customer's credit balance
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_payments (
  id           SERIAL PRIMARY KEY,
  customer_id  INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  date         TIMESTAMPTZ NOT NULL DEFAULT now(),
  amount       REAL NOT NULL,
  sale_id      INTEGER REFERENCES sales(id) ON DELETE SET NULL,
  user_id      INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_custpay_customer ON customer_payments(customer_id);

-- ---------------------------------------------------------------------
-- StockPurchases — goods received from a supplier
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_purchases (
  id           SERIAL PRIMARY KEY,
  branch_id    INTEGER NOT NULL REFERENCES branches(id),
  supplier_id  INTEGER NOT NULL REFERENCES suppliers(id),
  date         TIMESTAMPTZ NOT NULL DEFAULT now(),
  invoice_ref  TEXT,
  total_cost   REAL NOT NULL DEFAULT 0,
  amount_paid  REAL NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'owed' CHECK (status IN ('paid','part-paid','owed')),
  user_id      INTEGER REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stockpurch_supplier ON stock_purchases(supplier_id);
CREATE INDEX IF NOT EXISTS idx_stockpurch_branch ON stock_purchases(branch_id);

-- ---------------------------------------------------------------------
-- StockPurchaseItems
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_purchase_items (
  id           SERIAL PRIMARY KEY,
  purchase_id  INTEGER NOT NULL REFERENCES stock_purchases(id) ON DELETE CASCADE,
  product_id   INTEGER NOT NULL REFERENCES products(id),
  quantity     REAL NOT NULL,
  cost_price   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_purchitems_purchase ON stock_purchase_items(purchase_id);

-- ---------------------------------------------------------------------
-- StockAdjustments — damages, losses, expiry, stock-take corrections
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_adjustments (
  id              SERIAL PRIMARY KEY,
  branch_id       INTEGER NOT NULL REFERENCES branches(id),
  product_id      INTEGER NOT NULL REFERENCES products(id),
  date            TIMESTAMPTZ NOT NULL DEFAULT now(),
  quantity_change REAL NOT NULL,
  reason          TEXT NOT NULL,
  user_id         INTEGER NOT NULL REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_stockadj_product ON stock_adjustments(product_id);

-- ---------------------------------------------------------------------
-- Expenses
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expenses (
  id           SERIAL PRIMARY KEY,
  branch_id    INTEGER NOT NULL REFERENCES branches(id),
  date         TIMESTAMPTZ NOT NULL DEFAULT now(),
  category     TEXT NOT NULL,
  description  TEXT,
  amount       REAL NOT NULL,
  paid_by      TEXT
);
CREATE INDEX IF NOT EXISTS idx_expenses_branch_date ON expenses(branch_id, date);

-- ---------------------------------------------------------------------
-- Shifts — clock in / clock out per cashier
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shifts (
  id          SERIAL PRIMARY KEY,
  branch_id   INTEGER NOT NULL REFERENCES branches(id),
  user_id     INTEGER NOT NULL REFERENCES users(id),
  clock_in    TIMESTAMPTZ NOT NULL DEFAULT now(),
  clock_out   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_shifts_user ON shifts(user_id);

-- ---------------------------------------------------------------------
-- ActivityLog — who did what and when (audit trail)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_log (
  id          SERIAL PRIMARY KEY,
  branch_id   INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  details     TEXT,
  timestamp   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_branch ON activity_log(branch_id);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log(user_id);

-- ---------------------------------------------------------------------
-- Seed data
-- ---------------------------------------------------------------------
INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

INSERT INTO branches (id, name, address)
VALUES (1, 'Main Branch', NULL)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- Realtime — lets every connected PC get pushed updates the instant
-- another PC writes a sale, payment, or stock change, instead of only
-- refreshing on a timer. Turn this on for the tables the dashboard and
-- till both watch live.
-- ---------------------------------------------------------------------
ALTER PUBLICATION supabase_realtime ADD TABLE sales, sale_items, branch_stock, customer_payments, customers, stock_purchases;
