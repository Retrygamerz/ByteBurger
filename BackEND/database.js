const { createClient } = require('@supabase/supabase-js');

function createDatabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error('SUPABASE_URL is required. Set it in BackEND/.env.');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required. Add the server-side service role key to BackEND/.env.');

  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    }
  });
}

module.exports = { createDatabaseClient };
