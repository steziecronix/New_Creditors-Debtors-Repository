// Mocks 'electron' so main.js can be required and its ipcMain handlers
// driven directly, in a plain Node process with no display. This only
// exists to verify the logic in main.js; it is NOT part of the shipped app.

const path = require('path');
const os = require('os');
const fs = require('fs');
const Module = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-test-'));
const tmpDocs = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-docs-'));

const handlers = {};
const fakeElectron = {
  app: {
    whenReady: () => Promise.resolve(),
    getPath: (name) => (name === 'userData' ? tmpUserData : name === 'documents' ? tmpDocs : os.tmpdir()),
    on: () => {},
    quit: () => {},
  },
  BrowserWindow: class {
    constructor() {}
    setMenuBarVisibility() {}
    loadFile() {}
    on() {}
    static getAllWindows() { return []; }
  },
  ipcMain: {
    handle: (channel, fn) => { handlers[channel] = fn; },
  },
  shell: { openPath: async () => {} },
};

// Intercept require('electron') only — everything else resolves normally.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return originalLoad.apply(this, arguments);
};

require('./main.js');

async function call(channel, payload) {
  if (!handlers[channel]) throw new Error(`No handler registered for ${channel}`);
  return handlers[channel](null, payload);
}

(async () => {
  // main.js's setup runs inside app.whenReady().then(...), which resolves as a
  // microtask/macrotask after require() returns synchronously — give it a tick.
  await new Promise(resolve => setTimeout(resolve, 50));

  const CH = require('./ipc-channels.js');
  let pass = 0, fail = 0;
  const check = (label, cond) => { if (cond) { pass++; console.log('  ok -', label); } else { fail++; console.log('  FAIL -', label); } };

  console.log('--- Seeded users ---');
  const owner = await call(CH.AUTH.LOGIN_OWNER, { username: 'paul.mwangi', password: 'admin123' });
  check('owner login works with seeded credentials', owner.role === 'admin');
  await call(CH.AUTH.LOGOUT, {});

  const cashier = await call(CH.AUTH.LOGIN_EMPLOYEE, { userId: owner.userId === 1 ? 2 : 2, pin: '1234' });
  check('cashier login works with seeded PIN', cashier.role === 'cashier');

  console.log('--- Products ---');
  const settings = await call(CH.SETTINGS.GET, {});
  check('settings row exists', settings.business_name === 'Paul Enterprises');

  const branches = await call(CH.BRANCHES.LIST, {});
  check('default Main Branch seeded', branches.some(b => b.name === 'Main Branch'));

  const product = await call(CH.PRODUCTS.CREATE, {
    name: 'Cooking Oil 2L', sku: 'GR-001', costPrice: 480, sellingPrice: 610, reorderLevel: 10, vatApplicable: true, vatRate: 16,
  });
  check('product created', product.name === 'Cooking Oil 2L');

  const stockBefore = await call(CH.STOCK.BRANCH_STOCK, { branchId: 1 });
  check('new product has a zero-stock row in Main Branch', stockBefore.find(s => s.product_id === product.id)?.quantity_on_hand === 0);

  console.log('--- Purchases increase stock ---');
  const supplier = await call(CH.SUPPLIERS.CREATE, { name: 'Kentaste Distributors' });
  await call(CH.PURCHASES.CREATE, {
    branchId: 1, supplierId: supplier.id, invoiceRef: 'INV-2201', amountPaid: 8540,
    items: [{ productId: product.id, quantity: 20, costPrice: 427 }],
  });
  const stockAfterPurchase = await call(CH.STOCK.BRANCH_STOCK, { branchId: 1 });
  const qty1 = stockAfterPurchase.find(s => s.product_id === product.id).quantity_on_hand;
  check('stock increased by purchase quantity (0 -> 20)', qty1 === 20);

  console.log('--- Sale decreases stock, computes VAT ---');
  const sale = await call(CH.SALES.CREATE, {
    branchId: 1, items: [{ productId: product.id, quantity: 3, unitPrice: 610 }],
    discount: 0, paymentMethod: 'Cash', amountPaid: 1893.8,
  });
  check('sale total includes 16% VAT (3 x 610 x 1.16 = 2122.8)', Math.abs(sale.total - 2122.8) < 0.01);

  const stockAfterSale = await call(CH.STOCK.BRANCH_STOCK, { branchId: 1 });
  const qty2 = stockAfterSale.find(s => s.product_id === product.id).quantity_on_hand;
  check('stock decreased by sale quantity (20 -> 17)', qty2 === 17);

  console.log('--- Credit sale updates customer balance ---');
  const customer = await call(CH.CUSTOMERS.CREATE, { name: 'James Otieno', phone: '0722987112' });
  const creditSale = await call(CH.SALES.CREATE, {
    branchId: 1, customerId: customer.id, items: [{ productId: product.id, quantity: 1, unitPrice: 610 }],
    discount: 0, paymentMethod: 'Credit', amountPaid: 0,
  });
  const customerAfter = (await call(CH.CUSTOMERS.DEBTORS, {})).find(c => c.id === customer.id);
  check('credit sale balance owed matches customer total_owed', Math.abs(customerAfter.total_owed - creditSale.balance) < 0.01);

  console.log('--- Payment history shows dated, itemized payments ---');
  await call(CH.CUSTOMERS.RECORD_PAYMENT, { customerId: customer.id, amount: 300, saleId: null });
  const history = await call(CH.CUSTOMERS.PAYMENT_HISTORY, { customerId: customer.id });
  check('payment history has one recorded payment', history.payments.length === 1);
  check('payment amount recorded correctly', history.payments[0].amount === 300);
  check('payment has a timestamp', typeof history.payments[0].date === 'string' && history.payments[0].date.length > 0);
  check('customer balance reduced by the payment', Math.abs(history.customer.total_owed - (creditSale.balance - 300)) < 0.01);

  console.log('--- Staff setup (admin only) ---');
  await call(CH.AUTH.LOGOUT, {});
  await call(CH.AUTH.LOGIN_OWNER, { username: 'paul.mwangi', password: 'admin123' });
  const newStaff = await call(CH.STAFF.CREATE, { name: 'Faith Njeri', username: 'faith.n', role: 'cashier', branchId: 1, pin: '5678' });
  check('new cashier account created', newStaff.username === 'faith.n');
  const staffList = await call(CH.STAFF.LIST, {});
  check('staff list has 3 users now (owner + grace + faith)', staffList.length === 3);

  console.log('--- Stock adjustment requires a reason ---');
  let threw = false;
  try { await call(CH.STOCK.ADJUST, { branchId: 1, productId: product.id, quantityChange: -1, reason: '' }); }
  catch (err) { threw = true; }
  check('adjustment without a reason is rejected', threw);

  console.log('--- Reports ---');
  const profit = await call(CH.REPORTS.PROFIT, { branchId: 1, from: '2020-01-01', to: '2030-01-01' });
  check('profit report returns a number', typeof profit.profit === 'number');

  console.log('--- Backup ---');
  const backup = await call(CH.BACKUP.RUN_NOW, {});
  check('backup file was written', fs.existsSync(backup.filePath));

  console.log('--- Licensing ---');
  const machineId = await call(CH.LICENSING.GET_MACHINE_ID, {});
  check('machine ID has expected shape (XXXX-XXXX-XXXX-XXXX)', /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(machineId));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(err => {
  console.error('TEST HARNESS ERROR:', err);
  process.exit(1);
});
