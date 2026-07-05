const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // serves your Keno game

// ========== Database ==========
const db = new sqlite3.Database('./keno.db');

db.serialize(() => {
  // Users table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT UNIQUE,
      balance REAL DEFAULT 0
    )
  `);
  // Used transaction IDs (prevents reuse)
  db.run(`
    CREATE TABLE IF NOT EXISTS used_transactions (
      transaction_id TEXT PRIMARY KEY,
      used_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Pending deposits
  db.run(`
    CREATE TABLE IF NOT EXISTS pending_deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      transaction_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
});

// ========== Helpers ==========
function getOrCreateUser(telegramId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId], (err, row) => {
      if (err) return reject(err);
      if (row) return resolve(row);
      db.run('INSERT INTO users (telegram_id, balance) VALUES (?, ?)', [telegramId, 0], function(err) {
        if (err) return reject(err);
        resolve({ id: this.lastID, telegram_id: telegramId, balance: 0 });
      });
    });
  });
}

function markTransactionUsed(transactionId) {
  return new Promise((resolve, reject) => {
    db.run('INSERT INTO used_transactions (transaction_id) VALUES (?)', [transactionId], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function isTransactionIdUsed(transactionId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM used_transactions WHERE transaction_id = ?', [transactionId], (err, row) => {
      if (err) reject(err);
      else resolve(!row); // true if NOT used
    });
  });
}

// ========== API Routes ==========

// Get balance
app.get('/api/balance', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  try {
    const user = await getOrCreateUser(userId);
    res.json({ balance: user.balance });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Submit deposit (pending)
app.post('/api/deposit', async (req, res) => {
  const { userId, amount, transactionId } = req.body;
  if (!userId || !amount || amount < 50 || !transactionId || transactionId.length < 4) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  try {
    const user = await getOrCreateUser(userId);

    // Check if transaction ID already used
    const available = await isTransactionIdUsed(transactionId);
    if (!available) {
      return res.status(400).json({ error: 'Transaction ID already submitted' });
    }

    // Insert pending deposit
    await new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO pending_deposits (user_id, amount, transaction_id, status) VALUES (?, ?, ?, ?)',
        [user.id, amount, transactionId, 'pending'],
        (err) => { if (err) reject(err); else resolve(); }
      );
    });

    // Mark as used (prevents duplicate submission)
    await markTransactionUsed(transactionId);

    res.json({ success: true, message: 'Deposit pending approval' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Withdraw (simple deduction – no actual transfer)
app.post('/api/withdraw', async (req, res) => {
  const { userId, amount, accountNumber } = req.body;
  if (!userId || !amount || amount < 50 || !accountNumber || accountNumber.length < 8) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  try {
    const user = await getOrCreateUser(userId);
    if (user.balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    const newBalance = user.balance - amount;
    await new Promise((resolve, reject) => {
      db.run('UPDATE users SET balance = ? WHERE id = ?', [newBalance, user.id], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    res.json({ success: true, newBalance });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== Admin Endpoints ==========

// Get all pending deposits (requires adminKey)
app.get('/api/admin/pending-deposits', async (req, res) => {
  const { adminKey } = req.query;
  if (adminKey !== process.env.ADMIN_SECRET && adminKey !== 'YOUR_ADMIN_SECRET') {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  try {
    const deposits = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM pending_deposits ORDER BY created_at DESC', (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
    res.json({ deposits });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Approve a deposit
app.post('/api/admin/approve-deposit', async (req, res) => {
  const { depositId, adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_SECRET && adminKey !== 'YOUR_ADMIN_SECRET') {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    // Get pending deposit
    const deposit = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM pending_deposits WHERE id = ? AND status = "pending"', [depositId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    if (!deposit) {
      return res.status(404).json({ error: 'Deposit not found or already processed' });
    }

    // Credit user
    const user = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM users WHERE id = ?', [deposit.user_id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const newBalance = user.balance + deposit.amount;
    await new Promise((resolve, reject) => {
      db.run('UPDATE users SET balance = ? WHERE id = ?', [newBalance, user.id], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Update deposit status
    await new Promise((resolve, reject) => {
      db.run('UPDATE pending_deposits SET status = "approved" WHERE id = ?', [depositId], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    res.json({ success: true, newBalance });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Reject a deposit
app.post('/api/admin/reject-deposit', async (req, res) => {
  const { depositId, adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_SECRET && adminKey !== 'YOUR_ADMIN_SECRET') {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    await new Promise((resolve, reject) => {
      db.run('UPDATE pending_deposits SET status = "rejected" WHERE id = ? AND status = "pending"', [depositId], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== Start Server ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
