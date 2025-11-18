// api/item-stats.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ingestApiToken = process.env.INGEST_API_TOKEN;

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

const allowedOrigins =
  process.env.NODE_ENV === 'production'
    ? ['https://dofus-tracker-web.vercel.app']
    : ['http://localhost:5173', 'http://localhost:3000'];

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
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res
      .status(405)
      .json({ error: 'method_not_allowed', message: 'Only GET is allowed' });
  }

  // Auth
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

  const { item, server, from, to } = req.query;

  if (!item || !server || !from || !to) {
    return res.status(400).json({ error: 'Missing required parameters: item, server, from, to' });
  }

  try {
    const fromDate = new Date(from as string);
    const toDate = new Date(to as string);

    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date format' });
    }

    const { data, error } = await supabase.rpc('item_stats', {
      p_item_name: item,
      p_server: server,
      p_from: fromDate.toISOString().split('T')[0],
      p_to: toDate.toISOString().split('T')[0],
    });

    if (error) {
      console.error('Supabase RPC error:', error);
      return res.status(500).json({ error: error.message });
    }

    // Return first row or null, with validation
    const rawStats = data && data.length > 0 ? data[0] : null;
    
    if (!rawStats) {
      return res.status(200).json(null);
    }

    // Validate and normalize stats
    const stats = {
      item_name: rawStats.item_name || '',
      server: rawStats.server || '',
      volatility: typeof rawStats.volatility === 'number' ? rawStats.volatility : 0,
      median_price: typeof rawStats.median_price === 'number' ? rawStats.median_price : 0,
      signal: ['buy', 'sell', 'neutral'].includes(rawStats.signal) ? rawStats.signal : 'neutral',
      ma7: typeof rawStats.ma7 === 'number' ? rawStats.ma7 : 0,
      current_price: typeof rawStats.current_price === 'number' ? rawStats.current_price : 0,
    };

    return res.status(200).json(stats);
  } catch (err) {
    console.error('Error in item-stats:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
