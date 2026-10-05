// Central list of every IPC channel name in the app.
// Both preload.js (renderer side) and main.js (main-process handlers, step 8)
// require this file, so a typo in a channel name fails loudly instead of
// silently returning "no handler registered" at runtime.

module.exports = {
  AUTH: {
    LOGIN_EMPLOYEE: 'auth:loginEmployee',
    LOGIN_OWNER: 'auth:loginOwner',
    LOGOUT: 'auth:logout',
    CURRENT_SESSION: 'auth:currentSession',
    // Pre-login only: lets the sign-in screen populate the "who's signing in"
    // dropdown with real active cashiers before a session exists. Deliberately
    // returns nothing sensitive (no password/PIN hashes) — see main.js handler.
    LIST_EMPLOYEES: 'auth:listEmployees',
  },
  CATEGORIES: {
    LIST: 'categories:list',
    GET_OR_CREATE: 'categories:getOrCreate',
  },
  PRODUCTS: {
    LIST: 'products:list',
    GET: 'products:get',
    CREATE: 'products:create',
    UPDATE: 'products:update',
    DELETE: 'products:delete',
  },
  STOCK: {
    BRANCH_STOCK: 'stock:branchStock',
    LOW_STOCK: 'stock:lowStock',
    ADJUST: 'stock:adjust',
  },
  SALES: {
    CREATE: 'sales:create',
    LIST: 'sales:list',
    GET: 'sales:get',
    REFUND: 'sales:refund',
    HOLD: 'sales:hold',
    LIST_HELD: 'sales:listHeld',
    RESUME_HELD: 'sales:resumeHeld',
  },
  PURCHASES: {
    CREATE: 'purchases:create',
    LIST: 'purchases:list',
  },
  SUPPLIERS: {
    LIST: 'suppliers:list',
    CREATE: 'suppliers:create',
  },
  CUSTOMERS: {
    LIST: 'customers:list',
    CREATE: 'customers:create',
    RECORD_PAYMENT: 'customers:recordPayment',
    DEBTORS: 'customers:debtors',
    PAYMENT_HISTORY: 'customers:paymentHistory',
  },
  STAFF: {
    LIST: 'staff:list',
    CREATE: 'staff:create',
    UPDATE: 'staff:update',
    SET_ACTIVE: 'staff:setActive',
    ACTIVITY_LOG: 'staff:activityLog',
  },
  SHIFTS: {
    CLOCK_IN: 'shifts:clockIn',
    CLOCK_OUT: 'shifts:clockOut',
    CURRENT: 'shifts:current',
  },
  REPORTS: {
    DAILY_SALES: 'reports:dailySales',
    SALES_RANGE: 'reports:salesRange',
    PROFIT: 'reports:profit',
    STOCK: 'reports:stock',
    PURCHASES: 'reports:purchases',
    DEBTORS: 'reports:debtors',
    EXPENSES: 'reports:expenses',
    EXPORT_EXCEL: 'reports:exportExcel',
    EXPORT_PDF: 'reports:exportPdf',
  },
  SETTINGS: {
    GET: 'settings:get',
    UPDATE: 'settings:update',
    RESET_DATA: 'settings:resetData',
  },
  BRANCHES: {
    LIST: 'branches:list',
    CREATE: 'branches:create',
  },
  PRINTER: {
    LIST: 'printer:list',
    PRINT_RECEIPT: 'printer:printReceipt',
    PRINT_REPORT: 'printer:printReport',
  },
  LICENSING: {
    GET_MACHINE_ID: 'licensing:getMachineId',
    GET_STATUS: 'licensing:getStatus',
    ACTIVATE: 'licensing:activate',
  },
  BACKUP: {
    RUN_NOW: 'backup:runNow',
    GET_LAST: 'backup:getLast',
  },
};
