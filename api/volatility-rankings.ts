// api/volatility-rankings.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { setCors } from '../utils/cors';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ingestApiToken = process.env.INGEST_API_TOKEN;

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// Petit helper pour décoder les + et %xx vers des espaces/UTF-8 corrects
function decodeQueryValue(value: string | string[] | undefined): string | null {
  if (!value) return null;
  const v = Array.isArray(value) ? value[0] : value;
  try {
    return decodeURIComponent(v.replace(/\+/g, ' '));
  } catch {
    return v.replace(/\+/g, ' ');
  }
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

  const server = decodeQueryValue(req.query.server);
  const from = decodeQueryValue(req.query.from);
  const to = decodeQueryValue(req.query.to);
  const limit = decodeQueryValue(req.query.limit) ?? '10';
  const order = decodeQueryValue(req.query.order) ?? 'desc';

  if (!server || !from || !to) {
    return res.status(400).json({ error: 'Missing required parameters: server, from, to' });
  }

  // Validate order parameter
  if (order !== 'asc' && order !== 'desc') {
    return res.status(400).json({ error: 'Invalid order parameter. Must be "asc" or "desc"' });
  }

  try {
    const fromDate = new Date(from as string);
    const toDate = new Date(to as string);

    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date format' });
    }

    const limitNum = parseInt(limit as string, 10);
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
      return res.status(400).json({ error: 'Invalid limit. Must be between 1 and 100' });
    }

    const { data, error } = await supabase.rpc('volatility_rankings', {
      p_server: server,
      p_from: fromDate.toISOString().split('T')[0],
      p_to: toDate.toISOString().split('T')[0],
      p_limit: limitNum,
      p_order: order,
    });

    if (error) {
      console.error('Supabase RPC error:', error);
      return res.status(500).json({ error: error.message });
    }

    // Validate and normalize each ranking
    const rankings = (data || []).map((item: any) => ({
      item_name: item.item_name || '',
      server: item.server || '',
      volatility: typeof item.volatility === 'number' ? item.volatility : 0,
      last_price: typeof item.last_price === 'number' ? item.last_price : 0,
      pct_change: typeof item.pct_change === 'number' ? item.pct_change : 0,
      obs_count: typeof item.obs_count === 'number' ? Number(item.obs_count) : 0,
    }));

    return res.status(200).json(rankings);
  } catch (err) {
    console.error('Error in volatility-rankings:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
