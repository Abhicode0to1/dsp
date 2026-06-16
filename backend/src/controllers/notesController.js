const { pool } = require('../config/database');

async function verifyCustomerAccess(customerId, userId, role) {
  if (role === 'admin') return true;
  const [[row]] = await pool.query(
    'SELECT id FROM tickets WHERE customer_id = ? AND assigned_agent_id = ? LIMIT 1',
    [customerId, userId]
  );
  return !!row;
}

exports.getNotes = async (req, res) => {
  try {
    if (!(await verifyCustomerAccess(req.params.customerId, req.user.id, req.user.role)))
      return res.status(403).json({ error: 'Forbidden' });
    const [notes] = await pool.query(
      `SELECT cn.*, u.name AS author_name
       FROM customer_notes cn JOIN users u ON u.id = cn.author_id
       WHERE cn.customer_id = ?
       ORDER BY cn.created_at DESC`,
      [req.params.customerId]
    );
    res.json({ notes });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.addNote = async (req, res) => {
  try {
    if (!(await verifyCustomerAccess(req.params.customerId, req.user.id, req.user.role)))
      return res.status(403).json({ error: 'Forbidden' });
    const { note } = req.body;
    if (!note?.trim()) return res.status(400).json({ error: 'Note required' });
    const [result] = await pool.query(
      'INSERT INTO customer_notes (customer_id, author_id, note) VALUES (?, ?, ?)',
      [req.params.customerId, req.user.id, note.trim()]
    );
    const [[newNote]] = await pool.query(
      `SELECT cn.*, u.name AS author_name FROM customer_notes cn JOIN users u ON u.id = cn.author_id WHERE cn.id = ?`,
      [result.insertId]
    );
    res.status(201).json({ note: newNote });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.deleteNote = async (req, res) => {
  try {
    const [[note]] = await pool.query('SELECT * FROM customer_notes WHERE id = ?', [req.params.id]);
    if (!note) return res.status(404).json({ error: 'Not found' });
    if (note.author_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    await pool.query('DELETE FROM customer_notes WHERE id = ?', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};
