require('dotenv').config();

const { createDatabaseClient } = require('./database');

const items = [
  { name: 'Zinger Crunch Burger', category: 'Burgers', price: 550 },
  { name: 'Double Smash Beef', category: 'Burgers', price: 780 },
  { name: 'Loaded Masala Fries', category: 'Sides', price: 320 },
  { name: 'Spicy Peri Wings (6 pcs)', category: 'Sides', price: 450 },
  { name: 'Mint Margarita', category: 'Drinks', price: 220 }
];

async function seed() {
  const supabase = createDatabaseClient();
  for (const item of items) {
    const { data: existing, error: lookupError } = await supabase
      .from('BurgerByte')
      .select('id')
      .eq('name', item.name)
      .maybeSingle();
    if (lookupError) throw lookupError;

    const result = existing
      ? await supabase
        .from('BurgerByte')
        .update({ category: item.category, price: item.price })
        .eq('id', existing.id)
      : await supabase
        .from('BurgerByte')
        .insert({ ...item, is_available: true });

    if (result.error) throw result.error;
  }
  console.log(`Seeded ${items.length} ByteBurger menu items in Supabase.`);
}

seed().catch((error) => {
  console.error('Could not seed Supabase:', error.message);
  if (error.code === 'PGRST204' || error.code === 'PGRST205' || error.code === '42P01') {
    console.error('Run BackEND/supabase-migration.sql in the Supabase SQL Editor first.');
  }
  process.exitCode = 1;
});
