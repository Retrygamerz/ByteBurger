# ByteBurger

The Express server serves `index.html`, `styles.css`, and `app.js` from the project root and serves the REST API from the same origin. PostgreSQL is used for menu and order storage.

## Run locally

1. Install Node.js 18 or newer and PostgreSQL.
2. Create a database named `byteburger`.
3. In `BackEND`, copy `.env.example` to `.env` and set `DATABASE_URL` and a private `ADMIN_API_KEY`.
4. Run `npm install`, then `npm run seed` to create the tables and load the starter menu.
5. Run `npm start` and open `http://localhost:3000`. The kitchen board is at `http://localhost:3000/kitchen`.

The server creates/updates the database tables on startup. `npm run seed` can be run again safely; it updates the five starter menu entries without deleting orders or changing availability.

## API

- `GET /api/health` — server health endpoint.
- `GET /api/menu?category=Burgers&available=true` — list/filter menu items.
- `POST /api/menu`, `PATCH /api/menu/:id`, `DELETE /api/menu/:id` — protected menu management.
- `POST /api/orders` — validate and create an order using current database prices.
- `GET /api/orders?status=Pending` — admin-key-protected kitchen order list.
- `GET /api/orders/:id` — check order status without exposing customer contact details.
- `PATCH /api/orders/:id` — protected order status update.

Protected requests require `x-admin-key: <ADMIN_API_KEY>`. Configure `FRONTEND_ORIGINS` as a comma-separated list when serving the frontend from a different origin. Orders under PKR 2,500 have a PKR 200 delivery fee; delivery is free at or above PKR 2,500.
