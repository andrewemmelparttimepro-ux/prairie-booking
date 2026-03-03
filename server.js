const express = require('express');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3001;

// ─── DATABASE ────────────────────────────────────────────────────────────────
const db = new sqlite3.Database(path.join(__dirname, 'bookings.db'), (err) => {
  if (err) { console.error('DB open error:', err); process.exit(1); }
  console.log('📦 Database opened');
});

// Promisify helpers
const dbRun = (sql, params = []) => new Promise((res, rej) =>
  db.run(sql, params, function(err) { err ? rej(err) : res(this); })
);
const dbGet = (sql, params = []) => new Promise((res, rej) =>
  db.get(sql, params, (err, row) => err ? rej(err) : res(row))
);
const dbAll = (sql, params = []) => new Promise((res, rej) =>
  db.all(sql, params, (err, rows) => err ? rej(err) : res(rows))
);

// Serialize init to ensure WAL + schema before serving requests
db.serialize(() => {
  db.run('PRAGMA journal_mode = WAL');
  db.run(`CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    requested_date TEXT NOT NULL,
    requested_start TEXT NOT NULL,
    requested_end TEXT NOT NULL,
    yards INTEGER NOT NULL,
    estimated_hours REAL NOT NULL,
    notes TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS blocked_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    block_date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    reason TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
});

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, cb) => cb(null, true), // allow all origins
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Admin-Password']
}));
app.use(express.json());

// Serve admin.html
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = 'BoredRoom2025!';

function yardsToHours(yards) {
  if (yards <= 30) return 2;
  if (yards <= 60) return 3;
  if (yards <= 100) return 4;
  if (yards <= 150) return 5;
  if (yards <= 200) return 6;
  return 8;
}

function addHours(timeStr, hours) {
  const [h, m] = timeStr.split(':').map(Number);
  const totalMins = h * 60 + m + hours * 60;
  const endH = Math.min(17, Math.floor(totalMins / 60));
  const endM = endH === 17 ? 0 : totalMins % 60;
  return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
}

function toMins(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function overlaps(s1, e1, s2, e2) {
  return toMins(s1) < toMins(e2) && toMins(e1) > toMins(s2);
}

function getDayOfWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

/**
 * GET /api/availability?date=YYYY-MM-DD
 */
app.get('/api/availability', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD.' });
    }

    const dow = getDayOfWeek(date);
    const TIMES = ['06:00','07:00','08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00'];

    if (dow === 0) {
      return res.json({ date, slots: TIMES.map(t => ({ time: t, status: 'unavailable', reason: 'Closed Sundays' })) });
    }

    const approved = await dbAll(
      `SELECT requested_start, requested_end FROM bookings WHERE requested_date = ? AND status = 'approved'`, [date]
    );
    const pending = await dbAll(
      `SELECT requested_start, requested_end FROM bookings WHERE requested_date = ? AND status = 'pending'`, [date]
    );
    const blocked = await dbAll(
      `SELECT start_time, end_time FROM blocked_slots WHERE block_date = ?`, [date]
    );

    const slots = TIMES.map(time => {
      const slotEnd = `${String(parseInt(time) + 1).padStart(2, '0')}:00`;
      let status = 'available';

      for (const b of [...approved, ...blocked.map(b => ({ requested_start: b.start_time, requested_end: b.end_time }))]) {
        const s = b.requested_start || b.start_time;
        const e = b.requested_end || b.end_time;
        if (overlaps(time, slotEnd, s, e)) { status = 'booked'; break; }
      }

      if (status === 'available') {
        for (const b of pending) {
          if (overlaps(time, slotEnd, b.requested_start, b.requested_end)) { status = 'pending'; break; }
        }
      }

      return { time, status };
    });

    res.json({ date, slots });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/request
 */
app.post('/api/request', async (req, res) => {
  try {
    const { name, phone, date, startTime, yards, notes } = req.body;

    if (!name || !phone || !date || !startTime || !yards) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date format.' });
    }

    const yardsNum = parseInt(yards);
    if (isNaN(yardsNum) || yardsNum < 1) {
      return res.status(400).json({ error: 'Invalid yards.' });
    }

    const dow = getDayOfWeek(date);
    if (dow === 0) return res.status(400).json({ error: 'Closed on Sundays.' });

    const startMins = toMins(startTime);
    if (startMins < toMins('06:00') || startMins >= toMins('17:00')) {
      return res.status(400).json({ error: 'Start time must be 6:00 AM – 5:00 PM.' });
    }

    const estimatedHours = yardsToHours(yardsNum);
    const endTime = addHours(startTime, estimatedHours);

    // Check for conflicts
    const approved = await dbAll(
      `SELECT requested_start, requested_end FROM bookings WHERE requested_date = ? AND status = 'approved'`, [date]
    );
    const blocked = await dbAll(
      `SELECT start_time as requested_start, end_time as requested_end FROM blocked_slots WHERE block_date = ?`, [date]
    );

    for (const b of [...approved, ...blocked]) {
      if (overlaps(startTime, endTime, b.requested_start, b.requested_end)) {
        return res.status(409).json({ error: 'Time slot conflicts with existing booking. Please choose another time.' });
      }
    }

    const result = await dbRun(
      `INSERT INTO bookings (name, phone, requested_date, requested_start, requested_end, yards, estimated_hours, notes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [name, phone, date, startTime, endTime, yardsNum, estimatedHours, notes || null]
    );

    const booking = await dbGet('SELECT * FROM bookings WHERE id = ?', [result.lastID]);
    console.log('📋 NEW BOOKING:', JSON.stringify(booking));

    res.json({ success: true, booking });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── ADMIN ────────────────────────────────────────────────────────────────────

app.get('/api/admin/requests', requireAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    const rows = status
      ? await dbAll('SELECT * FROM bookings WHERE status = ? ORDER BY requested_date, requested_start', [status])
      : await dbAll('SELECT * FROM bookings ORDER BY requested_date, requested_start');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/admin/requests/:id/approve', requireAdmin, async (req, res) => {
  try {
    await dbRun("UPDATE bookings SET status = 'approved' WHERE id = ?", [req.params.id]);
    const b = await dbGet('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    if (!b) return res.status(404).json({ error: 'Not found' });
    console.log('✅ APPROVED:', b.id, b.name, b.requested_date);
    res.json(b);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/admin/requests/:id/deny', requireAdmin, async (req, res) => {
  try {
    await dbRun("UPDATE bookings SET status = 'denied' WHERE id = ?", [req.params.id]);
    const b = await dbGet('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    if (!b) return res.status(404).json({ error: 'Not found' });
    console.log('❌ DENIED:', b.id, b.name);
    res.json(b);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/block', requireAdmin, async (req, res) => {
  try {
    const { date, startTime, endTime, reason } = req.body;
    if (!date || !startTime || !endTime) {
      return res.status(400).json({ error: 'date, startTime, endTime required' });
    }
    const result = await dbRun(
      'INSERT INTO blocked_slots (block_date, start_time, end_time, reason) VALUES (?, ?, ?, ?)',
      [date, startTime, endTime, reason || null]
    );
    const slot = await dbGet('SELECT * FROM blocked_slots WHERE id = ?', [result.lastID]);
    res.json(slot);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/admin/block/:id', requireAdmin, async (req, res) => {
  try {
    await dbRun('DELETE FROM blocked_slots WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/blocks', requireAdmin, async (req, res) => {
  try {
    const slots = await dbAll('SELECT * FROM blocked_slots ORDER BY block_date, start_time');
    res.json(slots);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Prairie Booking API on port ${PORT}`);
  console.log(`   Admin: /admin | Health: /health`);
});
