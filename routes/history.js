const express = require('express');
const router = express.Router();
const { getDB } = require('../utils/database');

/**
 * GET /api/history
 * Query: ?page=1&limit=20&platform=youtube&status=completed
 */
router.get('/', (req, res) => {
  const db = getDB();
  const page     = Math.max(1, parseInt(req.query.page)  || 1);
  const limit    = Math.min(100, parseInt(req.query.limit) || 20);
  const offset   = (page - 1) * limit;
  const platform = req.query.platform;
  const status   = req.query.status;

  let where = [];
  let params = [];

  if (platform) { where.push('platform = ?'); params.push(platform); }
  if (status)   { where.push('status = ?');   params.push(status); }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const total = db.prepare(`SELECT COUNT(*) as count FROM download_history ${whereClause}`)
    .get(...params).count;

  const rows = db.prepare(`
    SELECT * FROM download_history ${whereClause}
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({
    success: true,
    data: rows,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

/**
 * GET /api/history/:id
 * Get a specific history record
 */
router.get('/:id', (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM download_history WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true, data: row });
});

/**
 * DELETE /api/history/:id
 */
router.delete('/:id', (req, res) => {
  const db = getDB();
  db.prepare('DELETE FROM download_history WHERE id = ?').run(req.params.id);
  res.json({ success: true, message: 'Record deleted' });
});

/**
 * DELETE /api/history
 * Clear all history
 */
router.delete('/', (req, res) => {
  const db = getDB();
  db.prepare('DELETE FROM download_history').run();
  res.json({ success: true, message: 'History cleared' });
});

module.exports = router;
