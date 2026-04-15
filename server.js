'use strict';

const express = require('express');
const { open }  = require('sqlite');
const sqlite3   = require('sqlite3');
const cors      = require('cors');
const { v4: uuidv4 } = require('uuid');
const path      = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'demo_admin_responsive_v6.html'));
});

// ── メール送信 API（api/send-email.js を Express にマウント）────
// vercel.json の catch-all ルートが /api/send-email を server.js に
// 転送するため、ここで明示的に処理する
app.post('/api/send-email', require('./api/send-email'));

// ── ヘルパー ─────────────────────────────────────────────────
const now = () => new Date().toISOString().slice(0, 10);
const uid = () => uuidv4();

// ── DB 初期化 & サーバー起動 ──────────────────────────────────
// Vercel のサーバーレス環境はプロジェクトルートが読み取り専用のため /tmp を使用
const DB_PATH = process.env.VERCEL ? '/tmp/uma_bizflow.db' : 'uma_bizflow.db';

async function main() {
  const db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database,
  });

  await db.exec('PRAGMA journal_mode = WAL');
  await db.exec('PRAGMA foreign_keys = ON');

  // ── テーブル作成 ─────────────────────────────────────────────
  await db.exec(`
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
  id                TEXT PRIMARY KEY,
  purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  item_id           TEXT REFERENCES items(id),
  name              TEXT NOT NULL,
  qty               INTEGER DEFAULT 1,
  price             REAL DEFAULT 0
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
  issuer_name   TEXT DEFAULT '',
  issuer_regno  TEXT DEFAULT '',
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

  // ── デフォルト勘定科目（初回のみ）─────────────────────────
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
  for (const [code, name, type] of defaultAccounts) {
    await db.run(
      'INSERT OR IGNORE INTO accounts(code,name,type) VALUES(?,?,?)',
      code, name, type
    );
  }

  // 自動仕訳生成
  async function autoJournal(date, debit, credit, amount, memo) {
    await db.run(
      'INSERT INTO journals(id,date,debit,credit,amount,memo) VALUES(?,?,?,?,?,?)',
      uid(), date, debit, credit, amount, memo
    );
  }

  // ══════════════════════════════════════════════════════════════
  // 勘定科目 API
  // ══════════════════════════════════════════════════════════════
  app.get('/api/accounts', async (req, res) => {
    try {
      res.json(await db.all('SELECT * FROM accounts ORDER BY code'));
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/accounts', async (req, res) => {
    const { code, name, type } = req.body;
    if (!code || !name || !type) return res.status(400).json({ error: 'code/name/type required' });
    try {
      await db.run('INSERT INTO accounts(code,name,type) VALUES(?,?,?)', code, name, type);
      res.json({ ok: true });
    } catch(e) { res.status(409).json({ error: e.message }); }
  });

  app.delete('/api/accounts/:code', async (req, res) => {
    try {
      const used = await db.get(
        'SELECT 1 FROM journals WHERE debit=? OR credit=? LIMIT 1',
        req.params.code, req.params.code
      );
      if (used) return res.status(409).json({ error: 'この科目は仕訳で使用中です' });
      await db.run('DELETE FROM accounts WHERE code=?', req.params.code);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════
  // 仕訳帳 API
  // ══════════════════════════════════════════════════════════════
  app.get('/api/journals', async (req, res) => {
    try {
      const { from, to } = req.query;
      let sql = 'SELECT * FROM journals';
      const params = [];
      if (from && to) { sql += ' WHERE date BETWEEN ? AND ?'; params.push(from, to); }
      else if (from)  { sql += ' WHERE date >= ?'; params.push(from); }
      else if (to)    { sql += ' WHERE date <= ?'; params.push(to); }
      sql += ' ORDER BY date, id';
      res.json(await db.all(sql, ...params));
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/journals', async (req, res) => {
    const { date, debit, credit, amount, memo } = req.body;
    if (!date || !debit || !credit || !amount)
      return res.status(400).json({ error: '日付・借方・貸方・金額必須' });
    try {
      const id = uid();
      await db.run(
        'INSERT INTO journals(id,date,debit,credit,amount,memo) VALUES(?,?,?,?,?,?)',
        id, date, debit, credit, Number(amount), memo || ''
      );
      res.json({ id });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/journals/:id', async (req, res) => {
    try {
      await db.run('DELETE FROM journals WHERE id=?', req.params.id);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // 試算表
  app.get('/api/trial-balance', async (req, res) => {
    try {
      const accounts = await db.all('SELECT * FROM accounts ORDER BY code');
      const rows = await Promise.all(accounts.map(async a => {
        const dr = (await db.get('SELECT COALESCE(SUM(amount),0) as v FROM journals WHERE debit=?', a.code)).v;
        const cr = (await db.get('SELECT COALESCE(SUM(amount),0) as v FROM journals WHERE credit=?', a.code)).v;
        return { ...a, dr, cr, balance: dr - cr };
      }));
      res.json(rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // P/L
  app.get('/api/pl', async (req, res) => {
    try {
      const accounts = await db.all("SELECT * FROM accounts WHERE type IN ('収益','費用') ORDER BY code");
      const rows = await Promise.all(accounts.map(async a => {
        const dr = (await db.get('SELECT COALESCE(SUM(amount),0) as v FROM journals WHERE debit=?', a.code)).v;
        const cr = (await db.get('SELECT COALESCE(SUM(amount),0) as v FROM journals WHERE credit=?', a.code)).v;
        const bal = a.type === '収益' ? cr - dr : dr - cr;
        return { ...a, balance: bal };
      }));
      res.json(rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // B/S
  app.get('/api/bs', async (req, res) => {
    try {
      const accounts = await db.all("SELECT * FROM accounts WHERE type IN ('資産','負債','純資産') ORDER BY code");
      const rows = await Promise.all(accounts.map(async a => {
        const dr = (await db.get('SELECT COALESCE(SUM(amount),0) as v FROM journals WHERE debit=?', a.code)).v;
        const cr = (await db.get('SELECT COALESCE(SUM(amount),0) as v FROM journals WHERE credit=?', a.code)).v;
        const bal = a.type === '資産' ? dr - cr : cr - dr;
        return { ...a, balance: bal };
      }));
      res.json(rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════
  // 顧客（CRM）API
  // ══════════════════════════════════════════════════════════════
  app.get('/api/customers', async (req, res) => {
    try {
      const { q } = req.query;
      if (q) {
        res.json(await db.all(
          "SELECT * FROM customers WHERE name LIKE ? OR company LIKE ? ORDER BY created DESC",
          `%${q}%`, `%${q}%`
        ));
      } else {
        res.json(await db.all('SELECT * FROM customers ORDER BY created DESC'));
      }
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/customers', async (req, res) => {
    const { name, company, email, phone, status, memo } = req.body;
    if (!name) return res.status(400).json({ error: '顧客名必須' });
    try {
      const id = uid();
      await db.run(
        'INSERT INTO customers(id,name,company,email,phone,status,memo,created) VALUES(?,?,?,?,?,?,?,?)',
        id, name, company||'', email||'', phone||'', status||'アクティブ', memo||'', now()
      );
      res.json({ id });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/customers/:id', async (req, res) => {
    const { name, company, email, phone, status, memo } = req.body;
    try {
      await db.run(
        'UPDATE customers SET name=?,company=?,email=?,phone=?,status=?,memo=? WHERE id=?',
        name, company||'', email||'', phone||'', status||'アクティブ', memo||'', req.params.id
      );
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/customers/:id', async (req, res) => {
    try {
      await db.run('DELETE FROM customers WHERE id=?', req.params.id);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // 案件
  app.get('/api/deals', async (req, res) => {
    try {
      res.json(await db.all(
        'SELECT d.*, c.name as customer_name FROM deals d LEFT JOIN customers c ON d.customer_id=c.id ORDER BY d.created DESC'
      ));
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/deals', async (req, res) => {
    const { customer_id, title, amount, stage, due_date, memo } = req.body;
    if (!title) return res.status(400).json({ error: '案件名必須' });
    try {
      const id = uid();
      await db.run(
        'INSERT INTO deals(id,customer_id,title,amount,stage,due_date,memo,created) VALUES(?,?,?,?,?,?,?,?)',
        id, customer_id||null, title, Number(amount)||0, stage||'商談中', due_date||'', memo||'', now()
      );
      res.json({ id });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/deals/:id', async (req, res) => {
    const { title, amount, stage, due_date, memo } = req.body;
    try {
      await db.run(
        'UPDATE deals SET title=?,amount=?,stage=?,due_date=?,memo=? WHERE id=?',
        title, Number(amount)||0, stage, due_date||'', memo||'', req.params.id
      );
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════
  // 商品マスタ API
  // ══════════════════════════════════════════════════════════════
  app.get('/api/items', async (req, res) => {
    try {
      res.json(await db.all('SELECT * FROM items ORDER BY code'));
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/items', async (req, res) => {
    const { code, name, unit, price, stock, memo } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'コード・品名必須' });
    try {
      const id = uid();
      await db.run(
        'INSERT INTO items(id,code,name,unit,price,stock,memo) VALUES(?,?,?,?,?,?,?)',
        id, code, name, unit||'個', Number(price)||0, Number(stock)||0, memo||''
      );
      res.json({ id });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/items/:id', async (req, res) => {
    const { name, unit, price, stock, memo } = req.body;
    try {
      await db.run(
        'UPDATE items SET name=?,unit=?,price=?,stock=?,memo=? WHERE id=?',
        name, unit||'個', Number(price)||0, Number(stock)||0, memo||'', req.params.id
      );
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════
  // 受注 API（自動仕訳付き）
  // ══════════════════════════════════════════════════════════════
  app.get('/api/orders', async (req, res) => {
    try {
      const orders = await db.all(
        'SELECT o.*, c.name as customer_name FROM orders o LEFT JOIN customers c ON o.customer_id=c.id ORDER BY o.date DESC'
      );
      for (const o of orders) {
        o.lines = await db.all('SELECT * FROM order_lines WHERE order_id=?', o.id);
      }
      res.json(orders);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/orders', async (req, res) => {
    const { customer_id, date, memo, lines } = req.body;
    if (!date || !lines?.length) return res.status(400).json({ error: '日付・明細必須' });
    try {
      const total = lines.reduce((s, l) => s + (l.qty * l.price), 0);
      const id = uid();
      await db.run('BEGIN');
      try {
        await db.run(
          'INSERT INTO orders(id,customer_id,date,status,total,memo,created) VALUES(?,?,?,?,?,?,?)',
          id, customer_id||null, date, '受注確定', total, memo||'', now()
        );
        for (const l of lines) {
          await db.run(
            'INSERT INTO order_lines(id,order_id,item_id,name,qty,price) VALUES(?,?,?,?,?,?)',
            uid(), id, l.item_id||null, l.name, Number(l.qty), Number(l.price)
          );
          if (l.item_id) {
            await db.run('UPDATE items SET stock = stock - ? WHERE id=?', Number(l.qty), l.item_id);
          }
        }
        await autoJournal(date, '1120', '4110', total, `受注自動仕訳 #${id.slice(0,8)}`);
        await db.run('COMMIT');
      } catch(e) {
        await db.run('ROLLBACK');
        throw e;
      }
      res.json({ id, total });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/orders/:id', async (req, res) => {
    try {
      await db.run('UPDATE orders SET status=? WHERE id=?', req.body.status, req.params.id);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════
  // 発注 API（自動仕訳付き）
  // ══════════════════════════════════════════════════════════════
  app.get('/api/purchase-orders', async (req, res) => {
    try {
      const pos = await db.all('SELECT * FROM purchase_orders ORDER BY date DESC');
      for (const p of pos) {
        p.lines = await db.all('SELECT * FROM purchase_lines WHERE purchase_order_id=?', p.id);
      }
      res.json(pos);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/purchase-orders', async (req, res) => {
    const { supplier, date, memo, lines } = req.body;
    if (!date || !lines?.length) return res.status(400).json({ error: '日付・明細必須' });
    try {
      const total = lines.reduce((s, l) => s + (l.qty * l.price), 0);
      const id = uid();
      await db.run('BEGIN');
      try {
        await db.run(
          'INSERT INTO purchase_orders(id,supplier,date,status,total,received,memo,created) VALUES(?,?,?,?,?,?,?,?)',
          id, supplier||'', date, '発注済', total, 0, memo||'', now()
        );
        for (const l of lines) {
          await db.run(
            'INSERT INTO purchase_lines(id,purchase_order_id,item_id,name,qty,price) VALUES(?,?,?,?,?,?)',
            uid(), id, l.item_id||null, l.name, Number(l.qty), Number(l.price)
          );
        }
        await autoJournal(date, '5110', '2110', total, `発注自動仕訳 #${id.slice(0,8)}`);
        await db.run('COMMIT');
      } catch(e) {
        await db.run('ROLLBACK');
        throw e;
      }
      res.json({ id, total });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // 入荷確認（在庫加算）
  app.post('/api/purchase-orders/:id/receive', async (req, res) => {
    try {
      const po = await db.get('SELECT * FROM purchase_orders WHERE id=?', req.params.id);
      if (!po) return res.status(404).json({ error: 'Not found' });
      if (po.received) return res.status(409).json({ error: '既に入荷済み' });
      const lines = await db.all('SELECT * FROM purchase_lines WHERE purchase_order_id=?', po.id);
      await db.run('BEGIN');
      try {
        await db.run('UPDATE purchase_orders SET status=?,received=1 WHERE id=?', '入荷済', po.id);
        for (const l of lines) {
          if (l.item_id) {
            await db.run('UPDATE items SET stock = stock + ? WHERE id=?', l.qty, l.item_id);
          }
        }
        await db.run('COMMIT');
      } catch(e) {
        await db.run('ROLLBACK');
        throw e;
      }
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════
  // 請求書（インボイス対応）API
  // ══════════════════════════════════════════════════════════════
  async function nextInvNo() {
    const row = await db.get("SELECT invoice_no FROM invoices ORDER BY created DESC LIMIT 1");
    let n = 1;
    if (row) {
      const m = row.invoice_no.match(/(\d+)$/);
      if (m) n = parseInt(m[1]) + 1;
    }
    return `INV-${String(n).padStart(6,'0')}`;
  }

  app.get('/api/invoices', async (req, res) => {
    try {
      res.json(await db.all(
        'SELECT i.*, c.name as customer_name FROM invoices i LEFT JOIN customers c ON i.customer_id=c.id ORDER BY i.issue_date DESC'
      ));
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/invoices/:id', async (req, res) => {
    try {
      const inv = await db.get('SELECT * FROM invoices WHERE id=?', req.params.id);
      if (!inv) return res.status(404).json({ error: 'Not found' });
      inv.lines = await db.all('SELECT * FROM invoice_lines WHERE invoice_id=?', inv.id);
      const customer = inv.customer_id
        ? await db.get('SELECT * FROM customers WHERE id=?', inv.customer_id)
        : null;
      res.json({ ...inv, customer });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/invoices', async (req, res) => {
    const { customer_id, order_id, issue_date, due_date, issuer_name, issuer_regno, memo, lines, tax_rate } = req.body;
    if (!issue_date || !lines?.length) return res.status(400).json({ error: '発行日・明細必須' });
    try {
      const rate = Number(tax_rate) || 0.1;
      const subtotal = lines.reduce((s, l) => s + (l.qty * l.unit_price), 0);
      const tax_amount = Math.floor(subtotal * rate);
      const total = subtotal + tax_amount;
      const id = uid();
      const invoice_no = await nextInvNo();
      await db.run('BEGIN');
      try {
        await db.run(
          `INSERT INTO invoices(id,invoice_no,customer_id,order_id,issue_date,due_date,status,
            subtotal,tax_rate,tax_amount,total,issuer_name,issuer_regno,memo,created)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          id, invoice_no, customer_id||null, order_id||null,
          issue_date, due_date||'', '未収',
          subtotal, rate, tax_amount, total,
          issuer_name||'', issuer_regno||'', memo||'', now()
        );
        for (const l of lines) {
          const amt = l.qty * l.unit_price;
          await db.run(
            'INSERT INTO invoice_lines(id,invoice_id,name,qty,unit_price,tax_rate,amount) VALUES(?,?,?,?,?,?,?)',
            uid(), id, l.name, Number(l.qty), Number(l.unit_price), rate, amt
          );
        }
        await db.run('COMMIT');
      } catch(e) {
        await db.run('ROLLBACK');
        throw e;
      }
      res.json({ id, invoice_no, total });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════
  // 入金・決済 API（自動仕訳・消し込み付き）
  // ══════════════════════════════════════════════════════════════
  app.get('/api/payments', async (req, res) => {
    try {
      res.json(await db.all(
        'SELECT p.*, i.invoice_no FROM payments p LEFT JOIN invoices i ON p.invoice_id=i.id ORDER BY p.date DESC'
      ));
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/payments', async (req, res) => {
    const { invoice_id, date, amount, method, memo } = req.body;
    if (!date || !amount) return res.status(400).json({ error: '日付・金額必須' });
    try {
      const id = uid();
      await db.run('BEGIN');
      try {
        await db.run(
          'INSERT INTO payments(id,invoice_id,date,amount,method,memo,created) VALUES(?,?,?,?,?,?,?)',
          id, invoice_id||null, date, Number(amount), method||'銀行振込', memo||'', now()
        );
        if (invoice_id) {
          const inv = await db.get('SELECT * FROM invoices WHERE id=?', invoice_id);
          if (inv) {
            const paid = (await db.get(
              'SELECT COALESCE(SUM(amount),0) as v FROM payments WHERE invoice_id=?', invoice_id
            )).v;
            const newStatus = paid >= inv.total ? '入金済' : '一部入金';
            await db.run('UPDATE invoices SET status=? WHERE id=?', newStatus, invoice_id);
          }
        }
        await autoJournal(date, '1110', '1120', Number(amount),
          `入金消し込み${invoice_id ? ' ' + invoice_id.slice(0,8) : ''}`);
        await db.run('COMMIT');
      } catch(e) {
        await db.run('ROLLBACK');
        throw e;
      }
      res.json({ id });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════
  // ワークフロー API
  // ══════════════════════════════════════════════════════════════
  app.get('/api/workflows', async (req, res) => {
    try {
      res.json(await db.all('SELECT * FROM workflows ORDER BY created DESC'));
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/workflows', async (req, res) => {
    const { title, category, applicant } = req.body;
    if (!title) return res.status(400).json({ error: 'タイトル必須' });
    try {
      const id = uid();
      await db.run(
        'INSERT INTO workflows(id,title,category,applicant,status,created) VALUES(?,?,?,?,?,?)',
        id, title, category||'その他', applicant||'', '申請中', now()
      );
      res.json({ id });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/workflows/:id', async (req, res) => {
    const { status } = req.body;
    const approved_at = status === '承認済' ? now() : '';
    try {
      await db.run('UPDATE workflows SET status=?,approved_at=? WHERE id=?', status, approved_at, req.params.id);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/workflows/:id', async (req, res) => {
    try {
      await db.run('DELETE FROM workflows WHERE id=?', req.params.id);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════
  // ダッシュボード集計 API
  // ══════════════════════════════════════════════════════════════
  app.get('/api/dashboard', async (req, res) => {
    try {
      const customers_count = (await db.get('SELECT COUNT(*) as n FROM customers')).n;
      const orders_count    = (await db.get('SELECT COUNT(*) as n FROM orders')).n;
      const invoices_total  = (await db.get("SELECT COALESCE(SUM(total),0) as v FROM invoices WHERE status='未収'")).v;
      const revenue         = (await db.get("SELECT COALESCE(SUM(amount),0) as v FROM journals WHERE credit='4110'")).v;
      const receivable      = (await db.get("SELECT COALESCE(SUM(amount),0) as v FROM journals WHERE debit='1120'")).v;
      const received        = (await db.get("SELECT COALESCE(SUM(amount),0) as v FROM journals WHERE credit='1120'")).v;
      const payable         = (await db.get("SELECT COALESCE(SUM(amount),0) as v FROM journals WHERE credit='2110'")).v;
      res.json({
        customers_count,
        orders_count,
        invoices_unpaid: invoices_total,
        revenue,
        receivable: receivable - received,
        payable,
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── 起動 ────────────────────────────────────────────────────
  app.listen(PORT, () => {
    console.log(`✅ UMA BizFlow server running → http://localhost:${PORT}`);
    console.log(`   DB: uma_bizflow.db`);
  });
}

main().catch(err => {
  console.error('❌ サーバー起動エラー:', err.message);
  process.exit(1);
});
