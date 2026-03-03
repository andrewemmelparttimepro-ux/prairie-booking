const express = require('express');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── DATABASE ────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'bookings.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
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
  );

  CREATE TABLE IF NOT EXISTS blocked_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    block_date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    reason TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    'https://prairie-pumping-lightship.netlify.app',
    'http://localhost:3000',
    'http://localhost:8080',
    'http://127.0.0.1:5500',
    // allow all during development
    /\.netlify\.app$/
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Admin-Password']
}));
app.use(express.json());
app.use(express.static(__dirname));

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = 'BoredRoom2025!';

/**
 * Returns estimated hours given yard count.
 */
function yardsToHours(yards) {
  if (yards <= 30) return 2;
  if (yards <= 60) return 3;
  if (yards <= 100) return 4;
  if (yards <= 150) return 5;
  if (yards <= 200) return 6;
  return 8;
}

/**
 * Adds hours to HH:MM string, returns HH:MM (capped at 17:00).
 */
function addHours(timeStr, hours) {
  const [h, m] = timeStr.split(':').map(Number);
  const totalMins = h * 60 + m + hours * 60;
  const endH = Math.min(17, Math.floor(totalMins / 60));
  const endM = endH === 17 ? 0 : totalMins % 60;
  return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
}

/**
 * Converts HH:MM to minutes since midnight.
 */
function toMins(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Checks if two time ranges overlap.
 */
function overlaps(start1, end1, start2, end2) {
  return toMins(start1) < toMins(end2) && toMins(end1) > toMins(start2);
}

/**
 * Returns the day-of-week for a YYYY-MM-DD string (0=Sun, 6=Sat).
 */
function getDayOfWeek(dateStr) {
  // Parse in local time to avoid UTC offset issues
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

/**
 * Middleware: verify admin password header.
 */
function requireAdmin(req, res, next) {
  const pw = req.headers['x-admin-password'];
  if (pw !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Admin panel HTML
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

/**
 * GET /api/availability?date=YYYY-MM-DD
 * Returns 11 one-hour slots (6:00–16:00) with status.
 */
app.get('/api/availability', (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
  }

  // Sunday = 0, closed
  const dow = getDayOfWeek(date);
  if (dow === 0) {
    // Return all slots as unavailable
    const slots = [];
    for (let h = 6; h < 17; h++) {
      slots.push({
        time: `${String(h).padStart(2, '0')}:00`,
        status: 'unavailable',
        reason: 'Closed on Sundays'
      });
    }
    return res.json({ date, slots });
  }

  // Get approved bookings for this date
  const approvedBookings = db.prepare(
    `SELECT requested_start, requested_end FROM bookings WHERE requested_date = ? AND status = 'approved'`
  ).all(date);

  // Get pending bookings for this date
  const pendingBookings = db.prepare(
    `SELECT requested_start, requested_end FROM bookings WHERE requested_date = ? AND status = 'pending'`
  ).all(date);

  // Get blocked slots for this date
  const blockedSlots = db.prepare(
    `SELECT start_time, end_time FROM blocked_slots WHERE block_date = ?`
  ).all(date);

  const slots = [];
  for (let h = 6; h < 17; h++) {
    const slotStart = `${String(h).padStart(2, '0')}:00`;
    const slotEnd = `${String(h + 1).padStart(2, '0')}:00`;

    let status = 'available';

    // Check approved bookings and blocked slots → "booked"
    for (const b of approvedBookings) {
      if (overlaps(slotStart, slotEnd, b.requested_start, b.requested_end)) {
        status = 'booked';
        break;
      }
    }

    if (status === 'available') {
      for (const b of blockedSlots) {
        if (overlaps(slotStart, slotEnd, b.start_time, b.end_time)) {
          status = 'booked';
          break;
        }
      }
    }

    // Check pending bookings → "pending" (only if not already booked)
    if (status === 'available') {
      for (const b of pendingBookings) {
        if (overlaps(slotStart, slotEnd, b.requested_start, b.requested_end)) {
          status = 'pending';
          break;
        }
      }
    }

    slots.push({ time: slotStart, status });
  }

  res.json({ date, slots });
});

/**
 * POST /api/request
 * Body: { name, phone, date, startTime, yards, notes }
 */
app.post('/api/request', (req, res) => {
  const { name, phone, date, startTime, yards, notes } = req.body;

  // Validation
  if (!name || !phone || !date || !startTime || !yards) {
    return res.status(400).json({ error: 'Missing required fields: name, phone, date, startTime, yards' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
  }
  if (!/^\d{2}:\d{2}$/.test(startTime)) {
    return res.status(400).json({ error: 'Invalid startTime format. Use HH:MM.' });
  }

  const yardsNum = parseInt(yards);
  if (isNaN(yardsNum) || yardsNum < 1 || yardsNum > 9999) {
    return res.status(400).json({ error: 'Invalid yards value.' });
  }

  // Sunday check
  const dow = getDayOfWeek(date);
  if (dow === 0) {
    return res.status(400).json({ error: 'We are closed on Sundays.' });
  }

  // Business hours check
  const startMins = toMins(startTime);
  if (startMins < toMins('06:00') || startMins >= toMins('17:00')) {
    return res.status(400).json({ error: 'Start time must be between 6:00 AM and 5:00 PM.' });
  }

  const estimatedHours = yardsToHours(yardsNum);
  const endTime = addHours(startTime, estimatedHours);

  // Check availability: no overlap with approved bookings or blocked slots
  const approvedBookings = db.prepare(
    `SELECT requested_start, requested_end FROM bookings WHERE requested_date = ? AND status = 'approved'`
  ).all(date);

  const blockedSlots = db.prepare(
    `SELECT start_time, end_time FROM blocked_slots WHERE block_date = ?`
  ).all(date);

  for (const b of approvedBookings) {
    if (overlaps(startTime, endTime, b.requested_start, b.requested_end)) {
      return res.status(409).json({ error: 'That time slot conflicts with an existing booking. Please choose another time.' });
    }
  }

  for (const b of blockedSlots) {
    if (overlaps(startTime, endTime, b.start_time, b.end_time)) {
      return res.status(409).json({ error: 'That time slot is unavailable. Please choose another time.' });
    }
  }

  // Insert booking
  const stmt = db.prepare(`
    INSERT INTO bookings (name, phone, requested_date, requested_start, requested_end, yards, estimated_hours, notes, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `);
  const result = stmt.run(name, phone, date, startTime, endTime, yardsNum, estimatedHours, notes || null);

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(result.lastInsertRowid);

  // Log the new booking (Slack notification handled separately)
  console.log('📋 NEW BOOKING REQUEST:', JSON.stringify(booking, null, 2));

  res.json({ success: true, booking });
});

// ─── ADMIN ROUTES ─────────────────────────────────────────────────────────────

/**
 * GET /api/admin/requests?status=pending|approved|denied
 */
app.get('/api/admin/requests', requireAdmin, (req, res) => {
  const { status } = req.query;
  let bookings;
  if (status) {
    bookings = db.prepare('SELECT * FROM bookings WHERE status = ? ORDER BY requested_date, requested_start').all(status);
  } else {
    bookings = db.prepare('SELECT * FROM bookings ORDER BY requested_date, requested_start').all();
  }
  res.json(bookings);
});

/**
 * PUT /api/admin/requests/:id/approve
 */
app.put('/api/admin/requests/:id/approve', requireAdmin, (req, res) => {
  const { id } = req.params;
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  db.prepare("UPDATE bookings SET status = 'approved' WHERE id = ?").run(id);
  const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  console.log('✅ BOOKING APPROVED:', id, updated.name, updated.requested_date, updated.requested_start);
  res.json(updated);
});

/**
 * PUT /api/admin/requests/:id/deny
 */
app.put('/api/admin/requests/:id/deny', requireAdmin, (req, res) => {
  const { id } = req.params;
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  db.prepare("UPDATE bookings SET status = 'denied' WHERE id = ?").run(id);
  const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  console.log('❌ BOOKING DENIED:', id, updated.name, updated.requested_date, updated.requested_start);
  res.json(updated);
});

/**
 * POST /api/admin/block
 * Body: { date, startTime, endTime, reason }
 */
app.post('/api/admin/block', requireAdmin, (req, res) => {
  const { date, startTime, endTime, reason } = req.body;
  if (!date || !startTime || !endTime) {
    return res.status(400).json({ error: 'Missing required fields: date, startTime, endTime' });
  }
  const result = db.prepare(
    'INSERT INTO blocked_slots (block_date, start_time, end_time, reason) VALUES (?, ?, ?, ?)'
  ).run(date, startTime, endTime, reason || null);

  const slot = db.prepare('SELECT * FROM blocked_slots WHERE id = ?').get(result.lastInsertRowid);
  console.log('🚫 SLOT BLOCKED:', JSON.stringify(slot));
  res.json(slot);
});

/**
 * DELETE /api/admin/block/:id
 */
app.delete('/api/admin/block/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const slot = db.prepare('SELECT * FROM blocked_slots WHERE id = ?').get(id);
  if (!slot) return res.status(404).json({ error: 'Blocked slot not found' });

  db.prepare('DELETE FROM blocked_slots WHERE id = ?').run(id);
  console.log('🟢 BLOCK REMOVED:', id);
  res.json({ success: true });
});

/**
 * GET /api/admin/blocks - list all blocked slots
 */
app.get('/api/admin/blocks', requireAdmin, (req, res) => {
  const slots = db.prepare('SELECT * FROM blocked_slots ORDER BY block_date, start_time').all();
  res.json(slots);
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Prairie Booking API running on port ${PORT}`);
  console.log(`   Admin panel: http://localhost:${PORT}/admin`);
  console.log(`   Health: http://localhost:${PORT}/health`);
});
