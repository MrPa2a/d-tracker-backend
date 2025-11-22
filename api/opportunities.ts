import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { setCors } from '../utils/cors';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ingestApiToken = process.env.INGEST_API_TOKEN;

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

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
  const limit = decodeQueryValue(req.query.limit) ?? '20';
  const minPriceStr = decodeQueryValue(req.query.min_price);
  const maxPriceStr = decodeQueryValue(req.query.max_price);

  if (!server || !from || !to) {
    return res.status(400).json({ error: 'Missing required parameters: server, from, to' });
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
    const minPrice = minPriceStr ? parseFloat(minPriceStr) : null;
    const maxPrice = maxPriceStr ? parseFloat(maxPriceStr) : null;

    const { data, error } = await supabase.rpc('investment_opportunities', {
      p_server: server,
      p_from: fromDate.toISOString().split('T')[0],
      p_to: toDate.toISOString().split('T')[0],
      p_limit: limitNum,
      p_min_price: minPrice,
      p_max_price: maxPrice,
    });

    if (error) {
      console.error('Supabase RPC error:', error);
      return res.status(500).json({ error: error.message });
    }

    const opportunities = (data || []).map((item: any) => ({
      item_name: item.item_name || '',
      server: item.server || '',
      current_price: typeof item.current_price === 'number' ? item.current_price : 0,
      ma7: typeof item.ma7 === 'number' ? item.ma7 : 0,
      volatility: typeof item.volatility === 'number' ? item.volatility : 0,
      target_price: typeof item.target_price === 'number' ? item.target_price : 0,
      discount_pct: typeof item.discount_pct === 'number' ? item.discount_pct : 0,
    }));

    return res.status(200).json(opportunities);
  } catch (err) {
    console.error('Error in opportunities:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
