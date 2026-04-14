'use strict';

const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname))); // HTMLを同階層に置く場合

// Top page always serves the latest responsive admin demo.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'demo_admin_responsive_v6.html'));
});

// ── DB 初期化 ─────────────────────────────────────────────────
const db = new Database('uma_bizflow.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
-- 勘定科目マスタ
CREATE TABLE IF NOT EXISTS accounts (
  code    TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  type    TEXT NOT NULL CHECK(type IN ('資産','負債','純資産','収益','費用'))
);

-- 仕訳帳（複式簿記）
CREATE TABLE IF NOT EXISTS journals (
  id      TEXT PRIMARY KEY,
  date    TEXT NOT NULL,
  debit   TEXT NOT NULL REFERENCES accounts(code),
  credit  TEXT NOT NULL REFERENCES accounts(code),
  amount  REAL NOT NULL CHECK(amount > 0),
  memo    TEXT DEFAULT ''
);

-- 顧客（CRM）
CREATE TABLE IF NOT EXISTS customers (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  company  TEXT DEFAULT '',
  email    TEXT DEFAULT '',
  phone    TEXT DEFAULT '',
  status   TEXT DEFAULT 'アクティブ',
  memo     TEXT DEFAULT '',
  created  TEXT NOT NULL
);

-- 案件
CREATE TABLE IF NOT EXISTS deals (
  id          TEXT PRIMARY KEY,
  customer_id TEXT REFERENCES customers(id),
  title       TEXT NOT NULL,
  amount      REAL DEFAULT 0,
  stage       TEXT DEFAULT '商談中',
  due_date    TEXT DEFAULT '',
  memo        TEXT DEFAULT '',
  created     TEXT NOT NULL
);

-- 商品マスタ
CREATE TABLE IF NOT EXISTS items (
  id       TEXT PRIMARY KEY,
  code     TEXT NOT NULL,
  name     TEXT NOT NULL,
  unit     TEXT DEFAULT '個',
  price    REAL DEFAULT 0,
  stock    INTEGER DEFAULT 0,
  memo     TEXT DEFAULT ''
);

-- 受注
CREATE TABLE IF NOT EXISTS orders (
  id          TEXT PRIMARY KEY,
  customer_id TEXT REFERENCES customers(id),
  date        TEXT NOT NULL,
  status      TEXT DEFAULT '受注確定',
  total       REAL DEFAULT 0,
  memo        TEXT DEFAULT '',
  created     TEXT NOT NULL
);

-- 受注明細
CREATE TABLE IF NOT EXISTS order_lines (
  id       TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id  TEXT REFERENCES items(id),
  name     TEXT NOT NULL,
  qty      INTEGER DEFAULT 1,
  price    REAL DEFAULT 0
);

-- 発注
CREATE TABLE IF NOT EXISTS purchase_orders (
  id          TEXT PRIMARY KEY,
  supplier    TEXT DEFAULT '',
  date        TEXT NOT NULL,
  status      TEXT DEFAULT '発注済',
  total       REAL DEFAULT 0,
  received    INTEGER DEFAULT 0,
  memo        TEXT DEFAULT '',
  created     TEXT NOT NULL
);

-- 発注明細
CREATE TABLE IF NOT EXISTS purchase_lines (
  id                  TEXT PRIMARY KEY,
  purchase_order_id   TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  item_id             TEXT REFERENCES items(id),
  name                TEXT NOT NULL,
  qty                 INTEGER DEFAULT 1,
  price               REAL DEFAULT 0
);

-- 請求書（インボイス対応）
CREATE TABLE IF NOT EXISTS invoices (
  id            TEXT PRIMARY KEY,
  invoice_no    TEXT NOT NULL,
  customer_id   TEXT REFERENCES customers(id),
  order_id      TEXT REFERENCES orders(id),
  issue_date    TEXT NOT NULL,
  due_date      TEXT DEFAULT '',
  status        TEXT DEFAULT '未収',
  subtotal      REAL DEFAULT 0,
  tax_rate      REAL DEFAULT 0.1,
  tax_amount    REAL DEFAULT 0,
  total         REAL DEFAULT 0,
  -- インボイス制度対応フィールド
  issuer_name   TEXT DEFAULT '',
  issuer_regno  TEXT DEFAULT '',   -- 適格請求書発行事業者登録番号
  memo          TEXT DEFAULT '',
  created       TEXT NOT NULL
);

-- 請求明細
CREATE TABLE IF NOT EXISTS invoice_lines (
  id          TEXT PRIMARY KEY,
  invoice_id  TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  qty         INTEGER DEFAULT 1,
  unit_price  REAL DEFAULT 0,
  tax_rate    REAL DEFAULT 0.1,
  amount      REAL DEFAULT 0
);

-- 入金・決済
CREATE TABLE IF NOT EXISTS payments (
  id          TEXT PRIMARY KEY,
  invoice_id  TEXT REFERENCES invoices(id),
  date        TEXT NOT NULL,
  amount      REAL NOT NULL CHECK(amount > 0),
  method      TEXT DEFAULT '銀行振込',
  memo        TEXT DEFAULT '',
  created     TEXT NOT NULL
);

-- ワークフロー申請
CREATE TABLE IF NOT EXISTS workflows (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  category    TEXT DEFAULT 'その他',
  applicant   TEXT DEFAULT '',
  status      TEXT DEFAULT '申請中',
  created     TEXT NOT NULL,
  approved_at TEXT DEFAULT ''
);
`);

// ── デフォルト勘定科目を挿入（初回のみ）─────────────────────
const defaultAccounts = [
  ['1110','現金預金','資産'],['1120','売掛金','資産'],['1130','商品','資産'],
  ['1500','建物','資産'],['1600','備品','資産'],
  ['2110','買掛金','負債'],['2200','短期借入金','負債'],['2300','未払金','負債'],
  ['3000','資本金','純資産'],['3100','繰越利益剰余金','純資産'],
  ['4110','売上高','収益'],['4200','受取利息','収益'],
  ['5110','仕入高','費用'],['5200','給与手当','費用'],
  ['5300','地代家賃','費用'],['5400','通信費','費用'],
  ['5500','旅費交通費','費用'],['5600','消耗品費','費用'],
  ['5700','広告宣伝費','費用'],['5800','減価償却費','費用'],
  ['5900','支払利息','費用'],['5999','雑費','費用'],
];
const insertAcct = db.prepare(
  'INSERT OR IGNORE INTO accounts(code,name,type) VALUES(?,?,?)'
);
defaultAccounts.forEach(([code,name,type]) => insertAcct.run(code,name,type));

// ── ヘルパー ─────────────────────────────────────────────────
const now = () => new Date().toISOString().slice(0,10);
const uid = () => uuidv4();

// 自動仕訳生成
function autoJournal(date, debit, credit, amount, memo) {
  db.prepare(
    'INSERT INTO journals(id,date,debit,credit,amount,memo) VALUES(?,?,?,?,?,?)'
  ).run(uid(), date, debit, credit, amount, memo);
}

// ══════════════════════════════════════════════════════════════
// 勘定科目 API
// ══════════════════════════════════════════════════════════════
app.get('/api/accounts', (req, res) => {
  res.json(db.prepare('SELECT * FROM accounts ORDER BY code').all());
});

app.post('/api/accounts', (req, res) => {
  const { code, name, type } = req.body;
  if (!code || !name || !type) return res.status(400).json({ error: 'code/name/type required' });
  try {
    db.prepare('INSERT INTO accounts(code,name,type) VALUES(?,?,?)').run(code, name, type);
    res.json({ ok: true });
  } catch(e) { res.status(409).json({ error: e.message }); }
});

app.delete('/api/accounts/:code', (req, res) => {
  const { code } = req.params;
  const used = db.prepare(
    'SELECT 1 FROM journals WHERE debit=? OR credit=? LIMIT 1'
  ).get(code, code);
  if (used) return res.status(409).json({ error: 'この科目は仕訳で使用中です' });
  db.prepare('DELETE FROM accounts WHERE code=?').run(code);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════
// 仕訳帳 API
// ══════════════════════════════════════════════════════════════
app.get('/api/journals', (req, res) => {
  const { from, to } = req.query;
  let sql = 'SELECT * FROM journals';
  const params = [];
  if (from && to) { sql += ' WHERE date BETWEEN ? AND ?'; params.push(from, to); }
  else if (from)  { sql += ' WHERE date >= ?'; params.push(from); }
  else if (to)    { sql += ' WHERE date <= ?'; params.push(to); }
  sql += ' ORDER BY date, id';
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/journals', (req, res) => {
  const { date, debit, credit, amount, memo } = req.body;
  if (!date || !debit || !credit || !amount)
    return res.status(400).json({ error: '日付・借方・貸方・金額必須' });
  const id = uid();
  db.prepare(
    'INSERT INTO journals(id,date,debit,credit,amount,memo) VALUES(?,?,?,?,?,?)'
  ).run(id, date, debit, credit, Number(amount), memo || '');
  res.json({ id });
});

app.delete('/api/journals/:id', (req, res) => {
  db.prepare('DELETE FROM journals WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// 試算表
app.get('/api/trial-balance', (req, res) => {
  const accounts = db.prepare('SELECT * FROM accounts ORDER BY code').all();
  const rows = accounts.map(a => {
    const dr = db.prepare('SELECT COALESCE(SUM(amount),0) as v FROM journals WHERE debit=?').get(a.code).v;
    const cr = db.prepare('SELECT COALESCE(SUM(amount),0) as v FROM journals WHERE credit=?').get(a.code).v;
    return { ...a, dr, cr, balance: dr - cr };
  });
  res.json(rows);
});

// P/L
app.get('/api/pl', (req, res) => {
  const accounts = db.prepare("SELECT * FROM accounts WHERE type IN ('収益','費用') ORDER BY code").all();
  const rows = accounts.map(a => {
    const dr = db.prepare('SELECT COALESCE(SUM(amount),0) as v FROM journals WHERE debit=?').get(a.code).v;
    const cr = db.prepare('SELECT COALESCE(SUM(amount),0) as v FROM journals WHERE credit=?').get(a.code).v;
    const bal = ['収益'].includes(a.type) ? cr - dr : dr - cr;
    return { ...a, balance: bal };
  });
  res.json(rows);
});

// B/S
app.get('/api/bs', (req, res) => {
  const accounts = db.prepare("SELECT * FROM accounts WHERE type IN ('資産','負債','純資産') ORDER BY code").all();
  const rows = accounts.map(a => {
    const dr = db.prepare('SELECT COALESCE(SUM(amount),0) as v FROM journals WHERE debit=?').get(a.code).v;
    const cr = db.prepare('SELECT COALESCE(SUM(amount),0) as v FROM journals WHERE credit=?').get(a.code).v;
    const bal = ['資産'].includes(a.type) ? dr - cr : cr - dr;
    return { ...a, balance: bal };
  });
  res.json(rows);
});

// ══════════════════════════════════════════════════════════════
// 顧客（CRM）API
// ══════════════════════════════════════════════════════════════
app.get('/api/customers', (req, res) => {
  const { q } = req.query;
  if (q) {
    res.json(db.prepare(
      "SELECT * FROM customers WHERE name LIKE ? OR company LIKE ? ORDER BY created DESC"
    ).all(`%${q}%`, `%${q}%`));
  } else {
    res.json(db.prepare('SELECT * FROM customers ORDER BY created DESC').all());
  }
});

app.post('/api/customers', (req, res) => {
  const { name, company, email, phone, status, memo } = req.body;
  if (!name) return res.status(400).json({ error: '顧客名必須' });
  const id = uid();
  db.prepare(
    'INSERT INTO customers(id,name,company,email,phone,status,memo,created) VALUES(?,?,?,?,?,?,?,?)'
  ).run(id, name, company||'', email||'', phone||'', status||'アクティブ', memo||'', now());
  res.json({ id });
});

app.put('/api/customers/:id', (req, res) => {
  const { name, company, email, phone, status, memo } = req.body;
  db.prepare(
    'UPDATE customers SET name=?,company=?,email=?,phone=?,status=?,memo=? WHERE id=?'
  ).run(name, company||'', email||'', phone||'', status||'アクティブ', memo||'', req.params.id);
  res.json({ ok: true });
});

app.delete('/api/customers/:id', (req, res) => {
  db.prepare('DELETE FROM customers WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// 案件
app.get('/api/deals', (req, res) => {
  res.json(db.prepare(
    'SELECT d.*, c.name as customer_name FROM deals d LEFT JOIN customers c ON d.customer_id=c.id ORDER BY d.created DESC'
  ).all());
});

app.post('/api/deals', (req, res) => {
  const { customer_id, title, amount, stage, due_date, memo } = req.body;
  if (!title) return res.status(400).json({ error: '案件名必須' });
  const id = uid();
  db.prepare(
    'INSERT INTO deals(id,customer_id,title,amount,stage,due_date,memo,created) VALUES(?,?,?,?,?,?,?,?)'
  ).run(id, customer_id||null, title, Number(amount)||0, stage||'商談中', due_date||'', memo||'', now());
  res.json({ id });
});

app.put('/api/deals/:id', (req, res) => {
  const { title, amount, stage, due_date, memo } = req.body;
  db.prepare(
    'UPDATE deals SET title=?,amount=?,stage=?,due_date=?,memo=? WHERE id=?'
  ).run(title, Number(amount)||0, stage, due_date||'', memo||'', req.params.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════
// 商品マスタ API
// ══════════════════════════════════════════════════════════════
app.get('/api/items', (req, res) => {
  res.json(db.prepare('SELECT * FROM items ORDER BY code').all());
});

app.post('/api/items', (req, res) => {
  const { code, name, unit, price, stock, memo } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'コード・品名必須' });
  const id = uid();
  db.prepare(
    'INSERT INTO items(id,code,name,unit,price,stock,memo) VALUES(?,?,?,?,?,?,?)'
  ).run(id, code, name, unit||'個', Number(price)||0, Number(stock)||0, memo||'');
  res.json({ id });
});

app.put('/api/items/:id', (req, res) => {
  const { name, unit, price, stock, memo } = req.body;
  db.prepare(
    'UPDATE items SET name=?,unit=?,price=?,stock=?,memo=? WHERE id=?'
  ).run(name, unit||'個', Number(price)||0, Number(stock)||0, memo||'', req.params.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════
// 受注 API（自動仕訳付き）
// ══════════════════════════════════════════════════════════════
app.get('/api/orders', (req, res) => {
  const orders = db.prepare(
    'SELECT o.*, c.name as customer_name FROM orders o LEFT JOIN customers c ON o.customer_id=c.id ORDER BY o.date DESC'
  ).all();
  orders.forEach(o => {
    o.lines = db.prepare('SELECT * FROM order_lines WHERE order_id=?').all(o.id);
  });
  res.json(orders);
});

app.post('/api/orders', (req, res) => {
  const { customer_id, date, memo, lines } = req.body;
  if (!date || !lines?.length) return res.status(400).json({ error: '日付・明細必須' });

  const total = lines.reduce((s, l) => s + (l.qty * l.price), 0);
  const id = uid();

  const insertOrder = db.prepare(
    'INSERT INTO orders(id,customer_id,date,status,total,memo,created) VALUES(?,?,?,?,?,?,?)'
  );
  const insertLine = db.prepare(
    'INSERT INTO order_lines(id,order_id,item_id,name,qty,price) VALUES(?,?,?,?,?,?)'
  );

  db.transaction(() => {
    insertOrder.run(id, customer_id||null, date, '受注確定', total, memo||'', now());
    lines.forEach(l => {
      insertLine.run(uid(), id, l.item_id||null, l.name, Number(l.qty), Number(l.price));
      // 在庫減算
      if (l.item_id) {
        db.prepare('UPDATE items SET stock = stock - ? WHERE id=?').run(Number(l.qty), l.item_id);
      }
    });
    // 自動仕訳: 売掛金 / 売上高
    autoJournal(date, '1120', '4110', total, `受注自動仕訳 #${id.slice(0,8)}`);
  })();

  res.json({ id, total });
});

app.put('/api/orders/:id', (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE orders SET status=? WHERE id=?').run(status, req.params.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════
// 発注 API（自動仕訳付き）
// ══════════════════════════════════════════════════════════════
app.get('/api/purchase-orders', (req, res) => {
  const pos = db.prepare('SELECT * FROM purchase_orders ORDER BY date DESC').all();
  pos.forEach(p => {
    p.lines = db.prepare('SELECT * FROM purchase_lines WHERE purchase_order_id=?').all(p.id);
  });
  res.json(pos);
});

app.post('/api/purchase-orders', (req, res) => {
  const { supplier, date, memo, lines } = req.body;
  if (!date || !lines?.length) return res.status(400).json({ error: '日付・明細必須' });

  const total = lines.reduce((s, l) => s + (l.qty * l.price), 0);
  const id = uid();

  const insertPO = db.prepare(
    'INSERT INTO purchase_orders(id,supplier,date,status,total,received,memo,created) VALUES(?,?,?,?,?,?,?,?)'
  );
  const insertLine = db.prepare(
    'INSERT INTO purchase_lines(id,purchase_order_id,item_id,name,qty,price) VALUES(?,?,?,?,?,?)'
  );

  db.transaction(() => {
    insertPO.run(id, supplier||'', date, '発注済', total, 0, memo||'', now());
    lines.forEach(l => {
      insertLine.run(uid(), id, l.item_id||null, l.name, Number(l.qty), Number(l.price));
    });
    // 自動仕訳: 仕入高 / 買掛金
    autoJournal(date, '5110', '2110', total, `発注自動仕訳 #${id.slice(0,8)}`);
  })();

  res.json({ id, total });
});

// 入荷確認（在庫加算）
app.post('/api/purchase-orders/:id/receive', (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'Not found' });
  if (po.received) return res.status(409).json({ error: '既に入荷済み' });

  const lines = db.prepare('SELECT * FROM purchase_lines WHERE purchase_order_id=?').all(po.id);
  db.transaction(() => {
    db.prepare('UPDATE purchase_orders SET status=?,received=1 WHERE id=?').run('入荷済', po.id);
    lines.forEach(l => {
      if (l.item_id) {
        db.prepare('UPDATE items SET stock = stock + ? WHERE id=?').run(l.qty, l.item_id);
      }
    });
  })();
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════
// 請求書（インボイス対応）API
// ══════════════════════════════════════════════════════════════
const INV_SEQ = { n: 1 };
function nextInvNo() {
  const row = db.prepare("SELECT invoice_no FROM invoices ORDER BY created DESC LIMIT 1").get();
  if (row) {
    const m = row.invoice_no.match(/(\d+)$/);
    if (m) INV_SEQ.n = parseInt(m[1]) + 1;
  }
  return `INV-${String(INV_SEQ.n++).padStart(6,'0')}`;
}

app.get('/api/invoices', (req, res) => {
  const invs = db.prepare(
    'SELECT i.*, c.name as customer_name FROM invoices i LEFT JOIN customers c ON i.customer_id=c.id ORDER BY i.issue_date DESC'
  ).all();
  res.json(invs);
});

app.get('/api/invoices/:id', (req, res) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  inv.lines = db.prepare('SELECT * FROM invoice_lines WHERE invoice_id=?').all(inv.id);
  const customer = inv.customer_id
    ? db.prepare('SELECT * FROM customers WHERE id=?').get(inv.customer_id)
    : null;
  res.json({ ...inv, customer });
});

app.post('/api/invoices', (req, res) => {
  const {
    customer_id, order_id, issue_date, due_date,
    issuer_name, issuer_regno, memo, lines, tax_rate
  } = req.body;
  if (!issue_date || !lines?.length) return res.status(400).json({ error: '発行日・明細必須' });

  const rate = Number(tax_rate) || 0.1;
  const subtotal = lines.reduce((s, l) => s + (l.qty * l.unit_price), 0);
  const tax_amount = Math.floor(subtotal * rate);
  const total = subtotal + tax_amount;
  const id = uid();
  const invoice_no = nextInvNo();

  const insertInv = db.prepare(`
    INSERT INTO invoices(id,invoice_no,customer_id,order_id,issue_date,due_date,status,
      subtotal,tax_rate,tax_amount,total,issuer_name,issuer_regno,memo,created)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const insertLine = db.prepare(
    'INSERT INTO invoice_lines(id,invoice_id,name,qty,unit_price,tax_rate,amount) VALUES(?,?,?,?,?,?,?)'
  );

  db.transaction(() => {
    insertInv.run(
      id, invoice_no, customer_id||null, order_id||null,
      issue_date, due_date||'', '未収',
      subtotal, rate, tax_amount, total,
      issuer_name||'', issuer_regno||'', memo||'', now()
    );
    lines.forEach(l => {
      const amt = l.qty * l.unit_price;
      insertLine.run(uid(), id, l.name, Number(l.qty), Number(l.unit_price), rate, amt);
    });
  })();

  res.json({ id, invoice_no, total });
});

// ══════════════════════════════════════════════════════════════
// 入金・決済 API（自動仕訳・消し込み付き）
// ══════════════════════════════════════════════════════════════
app.get('/api/payments', (req, res) => {
  res.json(db.prepare(
    'SELECT p.*, i.invoice_no FROM payments p LEFT JOIN invoices i ON p.invoice_id=i.id ORDER BY p.date DESC'
  ).all());
});

app.post('/api/payments', (req, res) => {
  const { invoice_id, date, amount, method, memo } = req.body;
  if (!date || !amount) return res.status(400).json({ error: '日付・金額必須' });

  const id = uid();
  db.transaction(() => {
    db.prepare(
      'INSERT INTO payments(id,invoice_id,date,amount,method,memo,created) VALUES(?,?,?,?,?,?,?)'
    ).run(id, invoice_id||null, date, Number(amount), method||'銀行振込', memo||'', now());

    // 請求書ステータス更新
    if (invoice_id) {
      const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(invoice_id);
      if (inv) {
        const paid = db.prepare(
          'SELECT COALESCE(SUM(amount),0) as v FROM payments WHERE invoice_id=?'
        ).get(invoice_id).v;
        const newStatus = paid >= inv.total ? '入金済' : '一部入金';
        db.prepare('UPDATE invoices SET status=? WHERE id=?').run(newStatus, invoice_id);
      }
    }
    // 自動仕訳: 現金預金 / 売掛金（消し込み）
    autoJournal(date, '1110', '1120', Number(amount),
      `入金消し込み${invoice_id ? ' ' + invoice_id.slice(0,8) : ''}`);
  })();

  res.json({ id });
});

// ══════════════════════════════════════════════════════════════
// ワークフロー API
// ══════════════════════════════════════════════════════════════
app.get('/api/workflows', (req, res) => {
  res.json(db.prepare('SELECT * FROM workflows ORDER BY created DESC').all());
});

app.post('/api/workflows', (req, res) => {
  const { title, category, applicant } = req.body;
  if (!title) return res.status(400).json({ error: 'タイトル必須' });
  const id = uid();
  db.prepare(
    'INSERT INTO workflows(id,title,category,applicant,status,created) VALUES(?,?,?,?,?,?)'
  ).run(id, title, category||'その他', applicant||'', '申請中', now());
  res.json({ id });
});

app.put('/api/workflows/:id', (req, res) => {
  const { status } = req.body;
  const approved_at = status === '承認済' ? now() : '';
  db.prepare('UPDATE workflows SET status=?,approved_at=? WHERE id=?')
    .run(status, approved_at, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/workflows/:id', (req, res) => {
  db.prepare('DELETE FROM workflows WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════
// ダッシュボード集計 API
// ══════════════════════════════════════════════════════════════
app.get('/api/dashboard', (req, res) => {
  const customers_count = db.prepare('SELECT COUNT(*) as n FROM customers').get().n;
  const orders_count    = db.prepare('SELECT COUNT(*) as n FROM orders').get().n;
  const invoices_total  = db.prepare("SELECT COALESCE(SUM(total),0) as v FROM invoices WHERE status='未収'").get().v;
  const revenue         = db.prepare("SELECT COALESCE(SUM(amount),0) as v FROM journals WHERE credit='4110'").get().v;
  const receivable      = db.prepare("SELECT COALESCE(SUM(amount),0) as v FROM journals WHERE debit='1120'").get().v;
  const received        = db.prepare("SELECT COALESCE(SUM(amount),0) as v FROM journals WHERE credit='1120'").get().v;
  const payable         = db.prepare("SELECT COALESCE(SUM(amount),0) as v FROM journals WHERE credit='2110'").get().v;

  res.json({
    customers_count,
    orders_count,
    invoices_unpaid: invoices_total,
    revenue,
    receivable: receivable - received,
    payable,
  });
});

// ── 起動 ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ UMA BizFlow server running → http://localhost:${PORT}`);
  console.log(`   DB: uma_bizflow.db`);
});
