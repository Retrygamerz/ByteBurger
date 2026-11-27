require('dotenv').config();

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { createDatabaseClient } = require('./database');
const { createSessionCookie, clearSessionCookie, readSession } = require('./session');

const app = express();
let supabase;
let realtimeChannel;
let menuCache;
const frontendPath = path.resolve(__dirname, '..');
const menuCacheMs = 30_000;
const allowedOrigins = (process.env.FRONTEND_ORIGINS || 'http://localhost:5173,http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const statuses = ['Pending', 'Preparing', 'Out for Delivery', 'Delivered', 'Cancelled'];
const kitchenStreams = new Set();
const menuStreams = new Set();
const trackingStreams = new Map();

function log(level, message, fields = {}) {
  const record = { timestamp: new Date().toISOString(), level, message, ...fields };
  console[level === 'error' ? 'error' : 'log'](JSON.stringify(record));
}

function safeRoutePath(pathname) {
  if (pathname.startsWith('/api/orders/track/')) {
    return pathname.replace(/^\/api\/orders\/track\/[^/]+/, '/api/orders/track/:trackingCode');
  }
  return pathname.replace(/^\/api\/orders\/[^/]+/, '/api/orders/:id');
}

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
app.use((req, res, next) => {
  const startedAt = Date.now();
  req.requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  res.on('finish', () => {
    log('info', 'http_request', {
      request_id: req.requestId,
      method: req.method,
      path: safeRoutePath(req.path),
      status: res.statusCode,
      duration_ms: Date.now() - startedAt
    });
  });
  next();
});
const isProduction = process.env.NODE_ENV === 'production';
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      styleSrcAttr: ["'unsafe-inline'"],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
      upgradeInsecureRequests: isProduction ? [] : null
    }
  },
  strictTransportSecurity: isProduction ? { maxAge: 15_552_000, includeSubDomains: true } : false
}));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    const error = new Error('This origin is not allowed by CORS.');
    error.status = 403;
    return callback(error);
  },
  credentials: true
}));
app.use(express.json({ limit: '32kb' }));

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requireAdmin(req, res, next) {
  const session = readSession(req.headers.cookie, process.env.SESSION_SECRET);
  if (!session || session.role !== 'admin') return next(httpError(401, 'Please sign in to the kitchen.'));
  req.session = session;
  return next();
}

function sendEvent(res, event, data) {
  if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function openEventStream(req, res, clients, initialEvent, initialData) {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  clients.add(res);
  if (initialEvent) sendEvent(res, initialEvent, initialData);
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': keepalive\n\n');
  }, 25_000);
  heartbeat.unref();
  res.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

function publish(clients, event, data) {
  for (const client of clients) sendEvent(client, event, data);
}

function publishOrderChange(order) {
  const event = { id: String(order.id), status: order.status };
  publish(kitchenStreams, 'order', event);
  if (order.tracking_code) {
    publish(trackingStreams.get(order.tracking_code) || new Set(), 'status', event);
  }
}

function invalidateMenu() {
  menuCache = null;
  publish(menuStreams, 'menu', { updated: true });
}

async function getMenu() {
  if (menuCache && Date.now() - menuCache.cachedAt < menuCacheMs) return menuCache.items;
  const { data, error } = await supabase
    .from('BurgerByte')
    .select('id, name, category, price, is_available')
    .order('id', { ascending: true });
  if (error) throw error;
  menuCache = { items: data, cachedAt: Date.now() };
  return data;
}

function getPublicOrder(order) {
  return {
    id: String(order.id),
    tracking_code: order.tracking_code,
    status: order.status,
    created_at: order.created_at,
    total: Number(order.total),
    items: order.byteburger_order_items.map((item) => ({
      id: item.menu_item_id === null ? null : Number(item.menu_item_id),
      name: item.item_name,
      price: Number(item.unit_price),
      quantity: item.quantity,
      subtotal: Number(item.line_total)
    }))
  };
}

function subscribeToDatabaseChanges() {
  realtimeChannel = supabase
    .channel('byteburger-server-events')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'byteburger_orders' }, (payload) => {
      const order = payload.new && payload.new.id ? payload.new : payload.old;
      if (order && order.id) publishOrderChange(order);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'BurgerByte' }, invalidateMenu)
    .subscribe((status, error) => {
      if (status === 'SUBSCRIBED') log('info', 'supabase_realtime_connected');
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        log('error', 'supabase_realtime_error', { status, error: error?.message });
      }
    });
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
    if (!item || !Number.isSafeInteger(Number(item.id)) || Number(item.id) < 1 ||
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

async function loadOrders(status) {
  let query = supabase
    .from('byteburger_orders')
    .select('*, byteburger_order_items(*)')
    .order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return data.map((order) => formatOrder(order, order.byteburger_order_items || []));
}

async function loadOrderById(id) {
  const { data, error } = await supabase
    .from('byteburger_orders')
    .select('*, byteburger_order_items(*)')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? formatOrder(data, data.byteburger_order_items || []) : null;
}

function formatOrder(row, items) {
  return {
    id: String(row.id),
    tracking_code: row.tracking_code,
    customer_name: row.customer_name,
    phone: row.phone,
    address: row.address,
    subtotal: Number(row.subtotal),
    delivery_fee: Number(row.delivery_fee),
    total: Number(row.total),
    status: row.status,
    created_at: row.created_at,
    items: items.map((item) => ({
      id: item.menu_item_id === null ? null : Number(item.menu_item_id),
      name: item.item_name,
      price: Number(item.unit_price),
      quantity: item.quantity,
      subtotal: Number(item.line_total)
    }))
  };
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please wait 15 minutes and try again.' }
});

app.get('/api/auth/session', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const session = readSession(req.headers.cookie, process.env.SESSION_SECRET);
  res.json({ authenticated: Boolean(session), role: session?.role || null });
});

app.post('/api/auth/login', loginLimiter, (req, res, next) => {
  const configuredKey = process.env.ADMIN_API_KEY || '';
  const suppliedKey = typeof req.body?.key === 'string' ? req.body.key : '';
  if (!configuredKey) return next(httpError(503, 'Kitchen sign-in is not configured.'));
  const expected = Buffer.from(configuredKey);
  const supplied = Buffer.from(suppliedKey);
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
    return next(httpError(401, 'Incorrect kitchen key.'));
  }
  res.set({
    'Cache-Control': 'no-store',
    'Set-Cookie': createSessionCookie(process.env.SESSION_SECRET, isProduction)
  });
  return res.json({ authenticated: true, role: 'admin' });
});

app.post('/api/auth/logout', (req, res) => {
  res.set({
    'Cache-Control': 'no-store',
    'Set-Cookie': clearSessionCookie(isProduction)
  });
  res.json({ authenticated: false });
});

app.get('/api/health', async (req, res, next) => {
  try {
    const { error } = await supabase.from('BurgerByte').select('id').limit(1);
    if (error) throw error;
    res.json({ status: 'ok' });
  } catch (error) { next(error); }
});

app.get('/api/menu', async (req, res, next) => {
  try {
    if (req.query.category) {
      if (!['Burgers', 'Sides', 'Drinks'].includes(req.query.category)) throw httpError(400, 'Unknown menu category.');
    }
    if (req.query.available !== undefined) {
      if (!['true', 'false'].includes(req.query.available)) throw httpError(400, 'available must be true or false.');
    }
    const items = await getMenu();
    const filtered = items.filter((item) =>
      (!req.query.category || item.category === req.query.category) &&
      (req.query.available === undefined || item.is_available === (req.query.available === 'true'))
    );
    const response = JSON.stringify(filtered);
    const etag = `"${crypto.createHash('sha256').update(response).digest('base64url')}"`;
    res.set({
      'Cache-Control': 'public, max-age=30, stale-while-revalidate=60',
      ETag: etag
    });
    if (req.get('if-none-match') === etag) return res.status(304).end();
    res.type('json').send(response);
  } catch (error) { next(error); }
});

app.get('/api/menu/events', (req, res) => openEventStream(req, res, menuStreams, 'connected', { connected: true }));

app.post('/api/menu', requireAdmin, async (req, res, next) => {
  try {
    const item = validateMenuInput(req.body, false);
    const { data, error } = await supabase
      .from('BurgerByte')
      .insert(item)
      .select('id, name, category, price, is_available')
      .single();
    if (error) throw error;
    invalidateMenu();
    res.status(201).json(data);
  } catch (error) {
    if (error.code === '23505') return next(httpError(409, 'A menu item with this name already exists.'));
    return next(error);
  }
});

app.patch('/api/menu/:id', requireAdmin, async (req, res, next) => {
  try {
    if (!/^\d+$/.test(req.params.id)) throw httpError(400, 'Menu ID must be a positive integer.');
    const fields = validateMenuInput(req.body, true);
    const { data, error } = await supabase
      .from('BurgerByte')
      .update(fields)
      .eq('id', req.params.id)
      .select('id, name, category, price, is_available')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw httpError(404, 'Menu item not found.');
    invalidateMenu();
    res.json(data);
  } catch (error) {
    if (error.code === '23505') return next(httpError(409, 'A menu item with this name already exists.'));
    return next(error);
  }
});

app.delete('/api/menu/:id', requireAdmin, async (req, res, next) => {
  try {
    if (!/^\d+$/.test(req.params.id)) throw httpError(400, 'Menu ID must be a positive integer.');
    const { data, error } = await supabase
      .from('BurgerByte')
      .delete()
      .eq('id', req.params.id)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw httpError(404, 'Menu item not found.');
    invalidateMenu();
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
  try {
    const idempotencyKey = req.get('idempotency-key') || '';
    if (!/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(idempotencyKey)) {
      throw httpError(400, 'A valid Idempotency-Key UUID header is required.');
    }
    const order = validateOrder(req.body);
    const { data, error } = await supabase.rpc('create_byteburger_order', {
      p_customer_name: order.customer_name,
      p_phone: order.phone,
      p_address: order.address,
      p_items: order.items,
      p_idempotency_key: idempotencyKey,
      p_tracking_code: crypto.randomBytes(24).toString('base64url')
    });
    if (error) {
      if (error.code === '22023') throw httpError(400, error.message);
      if (error.code === 'P0001') throw httpError(409, error.message);
      throw error;
    }
    publishOrderChange(data);
    res.status(201).json(data);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/orders', requireAdmin, async (req, res, next) => {
  try {
    if (req.query.status && !statuses.includes(req.query.status)) throw httpError(400, 'Unknown order status.');
    res.set('Cache-Control', 'no-store');
    res.json(await loadOrders(req.query.status));
  } catch (error) { next(error); }
});

app.get('/api/kitchen/events', requireAdmin, (req, res) => {
  openEventStream(req, res, kitchenStreams, 'connected', { connected: true });
});

app.get('/api/orders/track/:trackingCode/events', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('byteburger_orders')
      .select('id, tracking_code, status')
      .eq('tracking_code', req.params.trackingCode)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw httpError(404, 'Order tracking code not found.');
    if (!trackingStreams.has(data.tracking_code)) trackingStreams.set(data.tracking_code, new Set());
    const clients = trackingStreams.get(data.tracking_code);
    openEventStream(req, res, clients, 'status', { id: String(data.id), status: data.status });
    res.on('close', () => {
      if (clients.size === 0) trackingStreams.delete(data.tracking_code);
    });
  } catch (error) { next(error); }
});

app.get('/api/orders/track/:trackingCode', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('byteburger_orders')
      .select('id, tracking_code, status, created_at, total, byteburger_order_items(menu_item_id, item_name, unit_price, quantity, line_total)')
      .eq('tracking_code', req.params.trackingCode)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw httpError(404, 'Order tracking code not found.');
    res.set('Cache-Control', 'no-store').json(getPublicOrder(data));
  } catch (error) { next(error); }
});

app.get('/api/orders/:id', requireAdmin, async (req, res, next) => {
  try {
    if (!/^\d+$/.test(req.params.id)) throw httpError(400, 'Order ID must be a positive integer.');
    const order = await loadOrderById(req.params.id);
    if (!order) throw httpError(404, 'Order not found.');
    res.set('Cache-Control', 'no-store');
    res.json(order);
  } catch (error) { next(error); }
});

app.patch('/api/orders/:id', requireAdmin, async (req, res, next) => {
  try {
    if (!/^\d+$/.test(req.params.id)) throw httpError(400, 'Order ID must be a positive integer.');
    const { status } = req.body || {};
    if (!statuses.includes(status)) throw httpError(400, 'Choose a valid order status.');
    const { data: current, error: lookupError } = await supabase
      .from('byteburger_orders')
      .select('status')
      .eq('id', req.params.id)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (!current) throw httpError(404, 'Order not found.');
    if (current.status === status) {
      return res.json(await loadOrderById(req.params.id));
    }
    const nextByStatus = {
      Pending: ['Preparing', 'Cancelled'],
      Preparing: ['Out for Delivery', 'Cancelled'],
      'Out for Delivery': ['Delivered', 'Cancelled'],
      Delivered: [],
      Cancelled: []
    };
    if (!nextByStatus[current.status].includes(status)) {
      throw httpError(409, `Cannot change an order from ${current.status} to ${status}.`);
    }
    const { data: updated, error: updateError } = await supabase
      .from('byteburger_orders')
      .update({ status })
      .eq('id', req.params.id)
      .eq('status', current.status)
      .select('id')
      .maybeSingle();
    if (updateError) throw updateError;
    if (!updated) throw httpError(409, 'The order status changed before this update could be saved. Refresh and try again.');
    const order = await loadOrderById(req.params.id);
    publishOrderChange(order);
    res.json(order);
  } catch (error) { next(error); }
});

function sendFrontendFile(res, filename, next) {
  res.sendFile(path.join(frontendPath, filename), (error) => {
    if (error) next(error);
  });
}

app.get('/styles.css', (req, res, next) => sendFrontendFile(res, 'styles.css', next));
app.get('/app.js', (req, res, next) => sendFrontendFile(res, 'app.js', next));
app.get(['/', '/kitchen'], (req, res, next) => sendFrontendFile(res, 'index.html', next));
app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }));
app.use((req, res) => res.status(404).send('Page not found.'));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const databaseStatus = error.code === '23505' ? 409 :
    error.code === '23503' || error.code === '22023' ? 400 : 0;
  const status = error.status || databaseStatus || (error.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) {
    log('error', 'request_error', {
      request_id: req.requestId,
      method: req.method,
      path: safeRoutePath(req.path),
      error_code: error.code || error.type || 'unknown',
      stack: error.stack
    });
  }
  const message = status >= 500
    ? 'Something went wrong. Please try again.'
    : error.message || 'The database request could not be completed.';
  res.status(status).json({ error: message });
});

async function start() {
  if (!process.env.ADMIN_API_KEY) throw new Error('ADMIN_API_KEY is required for kitchen sign-in.');
  if (!process.env.SESSION_SECRET) throw new Error('SESSION_SECRET is required to sign kitchen sessions.');
  supabase = createDatabaseClient();
  const { error } = await supabase.from('BurgerByte').select('id, name, category, price, is_available').limit(1);
  if (error) {
    throw new Error(`Could not connect to Supabase or find the migrated BurgerByte table: ${error.message}`);
  }
  subscribeToDatabaseChanges();
  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, () => console.log(`ByteBurger is ready at http://localhost:${port} (Supabase)`));
  const shutdown = () => {
    server.close(async () => {
      if (realtimeChannel) await supabase.removeChannel(realtimeChannel);
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((error) => {
  console.error('ByteBurger failed to start:', error.message);
  process.exitCode = 1;
});
