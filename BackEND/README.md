# ByteBurger

The Express server serves `index.html`, `styles.css`, and `app.js` from the project root and serves the REST API from the same origin. Supabase provides PostgreSQL storage for the menu and orders.

## Set up Supabase

1. In the Supabase project SQL Editor, run `supabase-migration.sql`. It adds menu columns to the existing `public."BurgerByte"` table and creates the order tables and atomic order-creation function. The migration stops without deleting data if the table already contains rows without menu names.
2. In Supabase project API settings, copy a server-side **secret key** (or the legacy `service_role` key). Keep it private; never put it in frontend code or commit it.
3. Copy `.env.example` to `.env` in `BackEND`. Set `SUPABASE_SERVICE_ROLE_KEY` to the server-side secret, and replace `ADMIN_API_KEY` with a private random secret.
4. From `BackEND`, run `npm install`, `npm run seed`, and `npm start`. Open `http://localhost:3000`; the kitchen board is at `http://localhost:3000/kitchen`.

The Supabase secret stays on the backend, where Row Level Security is enabled for the tables. Admin API routes additionally require the `x-admin-key` configured by `ADMIN_API_KEY`. `npm run seed` can be run again safely; it updates the starter item names, categories, and prices without changing their availability or existing orders. Existing local database files are left untouched but are no longer used by the app.

## API

- `GET /api/health` — server health endpoint.
- `GET /api/menu?category=Burgers&available=true` — list/filter menu items.
- `POST /api/menu`, `PATCH /api/menu/:id`, `DELETE /api/menu/:id` — protected menu management.
- `POST /api/orders` — validate and create an order using current database prices.
- `GET /api/orders?status=Pending` — admin-key-protected kitchen order list.
- `GET /api/orders/:id` — check order status without exposing customer contact details.
- `PATCH /api/orders/:id` — protected order status update.

Protected requests require `x-admin-key: <ADMIN_API_KEY>`. Configure `FRONTEND_ORIGINS` as a comma-separated list when serving the frontend from a different origin. Orders under PKR 2,500 have a PKR 200 delivery fee; delivery is free at or above PKR 2,500.
