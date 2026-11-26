require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');
const { rateLimit } = require('express-rate-limit');
const { Pool } = require('pg');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const frontendPath = path.resolve(__dirname, '..');
const allowedOrigins = (process.env.FRONTEND_ORIGINS || 'http://localhost:5173,http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const statuses = ['Pending', 'Preparing', 'Out for Delivery', 'Delivered', 'Cancelled'];

app.disable('x-powered-by');
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - startedAt}ms`);
  });
  next();
});
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    const error = new Error('This origin is not allowed by CORS.');
    error.status = 403;
    return callback(error);
  }
}));
app.use(express.json({ limit: '32kb' }));

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requireAdmin(req, res, next) {
  const configuredKey = process.env.ADMIN_API_KEY;
  const suppliedKey = req.get('x-admin-key') || '';
  if (!configuredKey) return next(httpError(503, 'Admin actions are disabled until ADMIN_API_KEY is configured.'));
  const expected = Buffer.from(configuredKey);
  const supplied = Buffer.from(suppliedKey);
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
    return next(httpError(401, 'A valid admin key is required.'));
  }
  return next();
}

function validateMenuInput(body, partial) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'A JSON object is required.');
  const fields = {};
  if (!partial || Object.hasOwn(body, 'name')) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 100) {
      throw httpError(400, 'Name must be between 1 and 100 characters.');
    }
    fields.name = body.name.trim();
  }
  if (!partial || Object.hasOwn(body, 'category')) {
    if (!['Burgers', 'Sides', 'Drinks'].includes(body.category)) throw httpError(400, 'Category must be Burgers, Sides, or Drinks.');
    fields.category = body.category;
  }
  if (!partial || Object.hasOwn(body, 'price')) {
    if (!Number.isInteger(body.price) || body.price < 1 || body.price > 1000000) throw httpError(400, 'Price must be a positive whole number of PKR.');
    fields.price = body.price;
  }
  if (!partial || Object.hasOwn(body, 'is_available')) {
    if (typeof body.is_available !== 'boolean') throw httpError(400, 'is_available must be true or false.');
    fields.is_available = body.is_available;
  }
  if (partial && Object.keys(fields).length === 0) throw httpError(400, 'Provide at least one menu field to update.');
  return fields;
}

function validateOrder(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'A JSON object is required.');
  for (const [field, label, maxLength] of [
    ['customer_name', 'Customer name', 100],
    ['phone', 'Phone number', 40],
    ['address', 'Delivery address', 500]
  ]) {
    if (typeof body[field] !== 'string' || !body[field].trim() || body[field].trim().length > maxLength) {
      throw httpError(400, `${label} is required and must be no more than ${maxLength} characters.`);
    }
  }
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 50) {
    throw httpError(400, 'Add between 1 and 50 different menu items.');
  }
  const seen = new Set();
  const items = body.items.map((item) => {
    if (!item || !Number.isInteger(Number(item.id)) || Number(item.id) < 1 ||
        !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 50) {
      throw httpError(400, 'Each item needs a valid menu ID and a quantity between 1 and 50.');
    }
    const id = Number(item.id);
    if (seen.has(id)) throw httpError(400, 'Each menu item may only appear once in the items list.');
    seen.add(id);
    return { id, quantity: item.quantity };
  });
  return {
    customer_name: body.customer_name.trim(),
    phone: body.phone.trim(),
    address: body.address.trim(),
    items
  };
}

function formatOrder(row, items) {
  return {
    id: String(row.id),
    customer_name: row.customer_name,
    phone: row.phone,
    address: row.address,
    subtotal: Number(row.subtotal),
    delivery_fee: row.delivery_fee,
    total: Number(row.total),
    status: row.status,
    created_at: row.created_at,
    items: items.map((item) => ({
      id: item.menu_item_id === null ? null : item.menu_item_id,
      name: item.item_name,
      price: item.unit_price,
      quantity: item.quantity,
      subtotal: Number(item.line_total)
    }))
  };
}

async function loadOrders(whereSql = '', values = []) {
  const orders = await pool.query(`SELECT * FROM orders ${whereSql} ORDER BY created_at DESC`, values);
  if (orders.rows.length === 0) return [];
  const orderIds = orders.rows.map((order) => order.id);
  const itemRows = await pool.query(
    'SELECT * FROM order_items WHERE order_id = ANY($1::bigint[]) ORDER BY id',
    [orderIds]
  );
  const grouped = new Map();
  for (const item of itemRows.rows) {
    if (!grouped.has(String(item.order_id))) grouped.set(String(item.order_id), []);
    grouped.get(String(item.order_id)).push(item);
  }
  return orders.rows.map((order) => formatOrder(order, grouped.get(String(order.id)) || []));
}

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/menu', async (req, res, next) => {
  try {
    const conditions = [];
    const values = [];
    if (req.query.category) {
      if (!['Burgers', 'Sides', 'Drinks'].includes(req.query.category)) throw httpError(400, 'Unknown menu category.');
      values.push(req.query.category);
      conditions.push(`category = $${values.length}`);
    }
    if (req.query.available !== undefined) {
      if (!['true', 'false'].includes(req.query.available)) throw httpError(400, 'available must be true or false.');
      values.push(req.query.available === 'true');
      conditions.push(`is_available = $${values.length}`);
    }
    const result = await pool.query(
      `SELECT id, name, category, price, is_available FROM menu_items ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY id`
    );
    res.json(result.rows);
  } catch (error) { next(error); }
});

app.post('/api/menu', requireAdmin, async (req, res, next) => {
  try {
    const item = validateMenuInput(req.body, false);
    const result = await pool.query(
      'INSERT INTO menu_items (name, category, price, is_available) VALUES ($1, $2, $3, $4) RETURNING id, name, category, price, is_available',
      [item.name, item.category, item.price, item.is_available]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') return next(httpError(409, 'A menu item with this name already exists.'));
    return next(error);
  }
});

app.patch('/api/menu/:id', requireAdmin, async (req, res, next) => {
  try {
    if (!/^\d+$/.test(req.params.id)) throw httpError(400, 'Menu ID must be a positive integer.');
    const fields = validateMenuInput(req.body, true);
    const columns = { name: 'name', category: 'category', price: 'price', is_available: 'is_available' };
    const values = Object.values(fields);
    const assignments = Object.keys(fields).map((field, index) => `${columns[field]} = $${index + 1}`);
    values.push(Number(req.params.id));
    const result = await pool.query(
      `UPDATE menu_items SET ${assignments.join(', ')} WHERE id = $${values.length} RETURNING id, name, category, price, is_available`,
      values
    );
    if (!result.rowCount) throw httpError(404, 'Menu item not found.');
    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') return next(httpError(409, 'A menu item with this name already exists.'));
    return next(error);
  }
});

app.delete('/api/menu/:id', requireAdmin, async (req, res, next) => {
  try {
    if (!/^\d+$/.test(req.params.id)) throw httpError(400, 'Menu ID must be a positive integer.');
    const result = await pool.query('DELETE FROM menu_items WHERE id = $1 RETURNING id', [Number(req.params.id)]);
    if (!result.rowCount) throw httpError(404, 'Menu item not found.');
    res.status(204).end();
  } catch (error) { next(error); }
});

const orderLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many order attempts. Please wait a minute and try again.' }
});

app.post('/api/orders', orderLimiter, async (req, res, next) => {
  let client;
  try {
    const order = validateOrder(req.body);
    client = await pool.connect();
    await client.query('BEGIN');
    const menuResult = await client.query(
      'SELECT id, name, price, is_available FROM menu_items WHERE id = ANY($1::int[]) FOR SHARE',
      [order.items.map((item) => item.id)]
    );
    const menuById = new Map(menuResult.rows.map((item) => [item.id, item]));
    const orderItems = order.items.map((requested) => {
      const menuItem = menuById.get(requested.id);
      if (!menuItem) throw httpError(400, `Menu item ${requested.id} no longer exists.`);
      if (!menuItem.is_available) throw httpError(409, `${menuItem.name} is sold out.`);
      return {
        menu_item_id: menuItem.id,
        item_name: menuItem.name,
        unit_price: menuItem.price,
        quantity: requested.quantity,
        line_total: menuItem.price * requested.quantity
      };
    });
    const subtotal = orderItems.reduce((sum, item) => sum + item.line_total, 0);
    const deliveryFee = subtotal >= 2500 ? 0 : 200;
    const inserted = await client.query(
      `INSERT INTO orders (customer_name, phone, address, subtotal, delivery_fee, total)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [order.customer_name, order.phone, order.address, subtotal, deliveryFee, subtotal + deliveryFee]
    );
    for (const item of orderItems) {
      await client.query(
        `INSERT INTO order_items (order_id, menu_item_id, item_name, unit_price, quantity, line_total)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [inserted.rows[0].id, item.menu_item_id, item.item_name, item.unit_price, item.quantity, item.line_total]
      );
    }
    await client.query('COMMIT');
    res.status(201).json(formatOrder(inserted.rows[0], orderItems));
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch((rollbackError) => console.error('Order rollback failed:', rollbackError));
    return next(error);
  } finally {
    if (client) client.release();
  }
});

app.get('/api/orders', requireAdmin, async (req, res, next) => {
  try {
    if (req.query.status && !statuses.includes(req.query.status)) throw httpError(400, 'Unknown order status.');
    const where = req.query.status ? 'WHERE status = $1' : '';
    res.json(await loadOrders(where, req.query.status ? [req.query.status] : []));
  } catch (error) { next(error); }
});

app.get('/api/orders/:id', async (req, res, next) => {
  try {
    if (!/^\d+$/.test(req.params.id)) throw httpError(400, 'Order ID must be a positive integer.');
    const orders = await loadOrders('WHERE id = $1', [req.params.id]);
    if (!orders.length) throw httpError(404, 'Order not found.');
    const order = orders[0];
    res.json({
      id: order.id,
      status: order.status,
      created_at: order.created_at,
      total: order.total,
      items: order.items
    });
  } catch (error) { next(error); }
});

app.patch('/api/orders/:id', requireAdmin, async (req, res, next) => {
  try {
    if (!/^\d+$/.test(req.params.id)) throw httpError(400, 'Order ID must be a positive integer.');
    const { status } = req.body || {};
    if (!statuses.includes(status)) throw httpError(400, 'Choose a valid order status.');
    const current = await pool.query('SELECT status FROM orders WHERE id = $1', [req.params.id]);
    if (!current.rowCount) throw httpError(404, 'Order not found.');
    const nextByStatus = {
      Pending: ['Preparing', 'Cancelled'],
      Preparing: ['Out for Delivery', 'Cancelled'],
      'Out for Delivery': ['Delivered', 'Cancelled'],
      Delivered: [],
      Cancelled: []
    };
    if (!nextByStatus[current.rows[0].status].includes(status)) {
      throw httpError(409, `Cannot change an order from ${current.rows[0].status} to ${status}.`);
    }
    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [status, req.params.id]);
    res.json((await loadOrders('WHERE id = $1', [req.params.id]))[0]);
  } catch (error) { next(error); }
});

app.get('/styles.css', (req, res, next) => res.sendFile(path.join(frontendPath, 'styles.css'), next));
app.get('/app.js', (req, res, next) => res.sendFile(path.join(frontendPath, 'app.js'), next));
app.get(['/', '/kitchen'], (req, res, next) => res.sendFile(path.join(frontendPath, 'index.html'), next));
app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }));
app.use((req, res) => res.status(404).send('Page not found.'));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status || (error.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong. Please try again.' : error.message });
});

async function start() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Copy .env.example to .env and configure PostgreSQL.');
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, () => console.log(`ByteBurger is ready at http://localhost:${port}`));
  const shutdown = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((error) => {
  console.error('ByteBurger failed to start:', error.message);
  process.exitCode = 1;
});
