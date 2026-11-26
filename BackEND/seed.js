require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const items = [
  ['Zinger Crunch Burger', 'Burgers', 550],
  ['Double Smash Beef', 'Burgers', 780],
  ['Loaded Masala Fries', 'Sides', 320],
  ['Spicy Peri Wings (6 pcs)', 'Sides', 450],
  ['Mint Margarita', 'Drinks', 220]
];

async function seed() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    for (const [name, category, price] of items) {
      await pool.query(
        `INSERT INTO menu_items (name, category, price, is_available)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (name) DO UPDATE SET category = EXCLUDED.category, price = EXCLUDED.price`,
        [name, category, price]
      );
    }
    console.log(`Seeded ${items.length} ByteBurger menu items.`);
  } finally {
    await pool.end();
  }
}

seed().catch((error) => {
  console.error('Could not seed the database:', error.message);
  process.exitCode = 1;
});
