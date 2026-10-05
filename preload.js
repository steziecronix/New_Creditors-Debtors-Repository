// preload.js
//
// Runs in an isolated context before the renderer HTML loads (contextIsolation
// stays ON, nodeIntegration stays OFF in main.js's BrowserWindow config).
// The renderer never touches Node or Electron directly — it only ever sees
// the flat `window.pos.*` object built here, and can only call the specific
// functions listed below.
//
// Every call is a thin wrapper around ipcRenderer.invoke(channel, payload),
// which returns a Promise the renderer can await. All the real logic —
// database queries, printing, license checks — lives in main.js's handlers
// (step 8), not here.

const { contextBridge, ipcRenderer } = require('electron');
const CH = require('./ipc-channels');

// Wrap invoke so every renderer call is forced through a single choke point;
// makes it trivial to add logging/error-shaping later without touching each API method.
function call(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
}

contextBridge.exposeInMainWorld('pos', {

  // ---- Auth (login.html) ----
  auth: {
    loginEmployee: (userId, pin) => call(CH.AUTH.LOGIN_EMPLOYEE, { userId, pin }),
    loginOwner: (username, password) => call(CH.AUTH.LOGIN_OWNER, { username, password }),
    logout: () => call(CH.AUTH.LOGOUT),
    currentSession: () => call(CH.AUTH.CURRENT_SESSION),
    listEmployees: () => call(CH.AUTH.LIST_EMPLOYEES),
  },

  // ---- Categories ----
  categories: {
    list: () => call(CH.CATEGORIES.LIST),
    getOrCreate: (name) => call(CH.CATEGORIES.GET_OR_CREATE, { name }),
  },

  // ---- Products / catalog ----
  products: {
    list: (filters) => call(CH.PRODUCTS.LIST, filters),
    get: (productId) => call(CH.PRODUCTS.GET, { productId }),
    create: (product) => call(CH.PRODUCTS.CREATE, product),
    update: (productId, changes) => call(CH.PRODUCTS.UPDATE, { productId, changes }),
    delete: (productId) => call(CH.PRODUCTS.DELETE, { productId }),
  },

  // ---- Stock ----
  stock: {
    branchStock: (branchId) => call(CH.STOCK.BRANCH_STOCK, { branchId }),
    lowStock: (branchId) => call(CH.STOCK.LOW_STOCK, { branchId }),
    adjust: (branchId, productId, quantityChange, reason) =>
      call(CH.STOCK.ADJUST, { branchId, productId, quantityChange, reason }),
  },

  // ---- Sales (employee-landing.html — New Sale tab) ----
  sales: {
    create: (sale) => call(CH.SALES.CREATE, sale),
    list: (filters) => call(CH.SALES.LIST, filters),
    get: (saleId) => call(CH.SALES.GET, { saleId }),
    refund: (saleId, items, reason) => call(CH.SALES.REFUND, { saleId, items, reason }),
    hold: (cart) => call(CH.SALES.HOLD, cart),
    listHeld: (branchId) => call(CH.SALES.LIST_HELD, { branchId }),
    resumeHeld: (heldSaleId) => call(CH.SALES.RESUME_HELD, { heldSaleId }),
  },

  // ---- Purchases / goods received (employee-landing.html — Add Stock tab) ----
  purchases: {
    create: (purchase) => call(CH.PURCHASES.CREATE, purchase),
    list: (filters) => call(CH.PURCHASES.LIST, filters),
  },

  suppliers: {
    list: () => call(CH.SUPPLIERS.LIST),
    create: (supplier) => call(CH.SUPPLIERS.CREATE, supplier),
  },

  // ---- Customers / debtors ----
  customers: {
    list: () => call(CH.CUSTOMERS.LIST),
    create: (customer) => call(CH.CUSTOMERS.CREATE, customer),
    recordPayment: (customerId, amount, saleId) =>
      call(CH.CUSTOMERS.RECORD_PAYMENT, { customerId, amount, saleId }),
    debtors: () => call(CH.CUSTOMERS.DEBTORS),
    paymentHistory: (customerId) => call(CH.CUSTOMERS.PAYMENT_HISTORY, { customerId }),
  },

  // ---- Staff (owner-dashboard.html — Staff Setup tab) ----
  staff: {
    list: () => call(CH.STAFF.LIST),
    create: (staffMember) => call(CH.STAFF.CREATE, staffMember),
    update: (userId, changes) => call(CH.STAFF.UPDATE, { userId, changes }),
    setActive: (userId, isActive) => call(CH.STAFF.SET_ACTIVE, { userId, isActive }),
    activityLog: (filters) => call(CH.STAFF.ACTIVITY_LOG, filters),
  },

  // ---- Shifts (clock in/out) ----
  shifts: {
    clockIn: (userId, branchId) => call(CH.SHIFTS.CLOCK_IN, { userId, branchId }),
    clockOut: (shiftId) => call(CH.SHIFTS.CLOCK_OUT, { shiftId }),
    current: (userId) => call(CH.SHIFTS.CURRENT, { userId }),
  },

  // ---- Reports (owner-dashboard.html — Reports tab) ----
  reports: {
    dailySales: (branchId, date) => call(CH.REPORTS.DAILY_SALES, { branchId, date }),
    salesRange: (branchId, from, to) => call(CH.REPORTS.SALES_RANGE, { branchId, from, to }),
    profit: (branchId, from, to) => call(CH.REPORTS.PROFIT, { branchId, from, to }),
    stock: (branchId) => call(CH.REPORTS.STOCK, { branchId }),
    purchases: (branchId, from, to) => call(CH.REPORTS.PURCHASES, { branchId, from, to }),
    debtors: () => call(CH.REPORTS.DEBTORS),
    expenses: (branchId, from, to) => call(CH.REPORTS.EXPENSES, { branchId, from, to }),
    // reportType matches the keys above ('dailySales' | 'salesRange' | 'profit' | 'stock' | 'purchases' | 'debtors' | 'expenses')
    exportExcel: (reportType, params) => call(CH.REPORTS.EXPORT_EXCEL, { reportType, params }),
    exportPdf: (reportType, params) => call(CH.REPORTS.EXPORT_PDF, { reportType, params }),
  },

  // ---- Settings (owner-dashboard.html — Settings tab) ----
  settings: {
    get: () => call(CH.SETTINGS.GET),
    update: (changes) => call(CH.SETTINGS.UPDATE, changes),
    // scope: 'today' | 'month' | 'full' — see main.js handler for exactly what each wipes.
    resetData: (scope) => call(CH.SETTINGS.RESET_DATA, { scope }),
  },

  // ---- Branches ----
  branches: {
    list: () => call(CH.BRANCHES.LIST),
    create: (branch) => call(CH.BRANCHES.CREATE, branch),
  },

  // ---- Printing (receipts + reports) ----
  printer: {
    list: () => call(CH.PRINTER.LIST),
    printReceipt: (saleId) => call(CH.PRINTER.PRINT_RECEIPT, { saleId }),
    printReport: (reportType, params) => call(CH.PRINTER.PRINT_REPORT, { reportType, params }),
  },

  // ---- Licensing (Section 6 of the design doc) ----
  licensing: {
    getMachineId: () => call(CH.LICENSING.GET_MACHINE_ID),
    getStatus: () => call(CH.LICENSING.GET_STATUS),
    activate: (licenseKey) => call(CH.LICENSING.ACTIVATE, { licenseKey }),
  },

  // ---- Backup ----
  backup: {
    runNow: () => call(CH.BACKUP.RUN_NOW),
    getLast: () => call(CH.BACKUP.GET_LAST),
  },

  // ---- App metadata, safe to expose read-only ----
  app: {
    version: process.env.npm_package_version || null,
    platform: process.platform,
  },
});
