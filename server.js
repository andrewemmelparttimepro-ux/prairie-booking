const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── DATABASE ────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS prairie_bookings (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        requested_date TEXT NOT NULL,
        requested_start TEXT NOT NULL,
        requested_end TEXT NOT NULL,
        yards INTEGER NOT NULL,
        estimated_hours REAL NOT NULL,
        notes TEXT,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS prairie_blocked_slots (
        id SERIAL PRIMARY KEY,
        block_date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('📦 PostgreSQL tables initialized');
  } catch (err) {
    console.error('DB init error:', err);
    process.exit(1);
  }
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, cb) => cb(null, true),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Admin-Password']
}));
app.use(express.json());

// Serve static pages
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/book', (req, res) => res.sendFile(path.join(__dirname, 'book.html')));

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

    const approvedResult = await pool.query(
      `SELECT requested_start, requested_end FROM prairie_bookings WHERE requested_date = $1 AND status = 'approved'`, [date]
    );
    const pendingResult = await pool.query(
      `SELECT requested_start, requested_end FROM prairie_bookings WHERE requested_date = $1 AND status = 'pending'`, [date]
    );
    const blockedResult = await pool.query(
      `SELECT start_time, end_time FROM prairie_blocked_slots WHERE block_date = $1`, [date]
    );

    const approved = approvedResult.rows;
    const pending = pendingResult.rows;
    const blocked = blockedResult.rows;

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
    const approvedResult = await pool.query(
      `SELECT requested_start, requested_end FROM prairie_bookings WHERE requested_date = $1 AND status = 'approved'`, [date]
    );
    const blockedResult = await pool.query(
      `SELECT start_time as requested_start, end_time as requested_end FROM prairie_blocked_slots WHERE block_date = $1`, [date]
    );

    for (const b of [...approvedResult.rows, ...blockedResult.rows]) {
      if (overlaps(startTime, endTime, b.requested_start, b.requested_end)) {
        return res.status(409).json({ error: 'Time slot conflicts with existing booking. Please choose another time.' });
      }
    }

    const insertResult = await pool.query(
      `INSERT INTO prairie_bookings (name, phone, requested_date, requested_start, requested_end, yards, estimated_hours, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending') RETURNING *`,
      [name, phone, date, startTime, endTime, yardsNum, estimatedHours, notes || null]
    );

    const booking = insertResult.rows[0];
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
    let result;
    if (status) {
      result = await pool.query('SELECT * FROM prairie_bookings WHERE status = $1 ORDER BY requested_date, requested_start', [status]);
    } else {
      result = await pool.query('SELECT * FROM prairie_bookings ORDER BY requested_date, requested_start');
    }
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/admin/requests/:id/approve', requireAdmin, async (req, res) => {
  try {
    await pool.query("UPDATE prairie_bookings SET status = 'approved' WHERE id = $1", [req.params.id]);
    const result = await pool.query('SELECT * FROM prairie_bookings WHERE id = $1', [req.params.id]);
    const b = result.rows[0];
    if (!b) return res.status(404).json({ error: 'Not found' });
    console.log('✅ APPROVED:', b.id, b.name, b.requested_date);
    res.json(b);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/admin/requests/:id/deny', requireAdmin, async (req, res) => {
  try {
    await pool.query("UPDATE prairie_bookings SET status = 'denied' WHERE id = $1", [req.params.id]);
    const result = await pool.query('SELECT * FROM prairie_bookings WHERE id = $1', [req.params.id]);
    const b = result.rows[0];
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
    const result = await pool.query(
      'INSERT INTO prairie_blocked_slots (block_date, start_time, end_time, reason) VALUES ($1, $2, $3, $4) RETURNING *',
      [date, startTime, endTime, reason || null]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/admin/block/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM prairie_blocked_slots WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/blocks', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM prairie_blocked_slots ORDER BY block_date, start_time');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ─── START ────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Prairie Booking API on port ${PORT}`);
    console.log(`   Admin: /admin | Book: /book | Health: /health`);
  });
});
