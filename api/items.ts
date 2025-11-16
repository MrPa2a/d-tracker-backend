// api/items.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ingestApiToken = process.env.INGEST_API_TOKEN;

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

const allowedOrigins =
  process.env.NODE_ENV === 'production'
    ? ['https://dofus-tracker-web.vercel.app/']
    : ['http://localhost:5173', 'http://localhost:3000', 'https://dofus-tracker-web.vercel.app/'];

function setCors(req: VercelRequest, res: VercelResponse) {
  const origin = req.headers.origin as string | undefined;

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type,Authorization'
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    // Réponse au preflight CORS
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res
      .status(405)
      .json({ error: 'method_not_allowed', message: 'Only GET is allowed' });
  }

  // 2) Auth simple via header Authorization: Bearer <token>
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Missing or invalid Authorization header',
    });
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (token !== ingestApiToken) {
    return res.status(403).json({
      error: 'forbidden',
      message: 'Invalid API token',
    });
  }

  try {
    const { data, error } = await supabase.rpc('items_with_latest_stats');

    if (error) {
      console.error('Supabase error in /api/items:', error);
      return res.status(500).json({
        error: 'supabase_error',
        message: 'Failed to fetch items_with_latest_stats',
        details: error.message,
      });
    }

    // On renvoie tel quel, ou on renomme les champs si tu veux.
    return res.status(200).json(
      (data || []).map((row: any) => ({
        item_name: row.item_name,
        server: row.server,
        last_observation_at: row.last_observation_at,
        last_price: row.last_price,
      }))
    );
  } catch (e: any) {
    console.error('Unexpected error in /api/items:', e);
    return res.status(500).json({
      error: 'unexpected_error',
      message: 'Unexpected error in /api/items',
      details: e?.message ?? String(e),
    });
  }
}
