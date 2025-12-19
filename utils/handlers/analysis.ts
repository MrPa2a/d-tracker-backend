import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { setCors } from '../cors';

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

export const handleAnalysis = async (req: VercelRequest, res: VercelResponse) => {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Auth (Optional for read-only? market.ts requires it. Let's require it for consistency)
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const token = authHeader.slice('Bearer '.length).trim();
  if (token !== ingestApiToken) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const type = decodeQueryValue(req.query.type);
  const server = decodeQueryValue(req.query.server);

  if (!type || !server) {
    return res.status(400).json({ error: 'Missing required parameters: type, server' });
  }

  try {
    let rpcName = '';
    let rpcParams: any = {
      p_server: server,
    };

    if (type === 'scanner') {
      rpcName = 'market_scanner_v3';
      
      const minPrice = decodeQueryValue(req.query.min_price);
      const maxPrice = decodeQueryValue(req.query.max_price);
      const minProfit = decodeQueryValue(req.query.min_profit);
      const minMargin = decodeQueryValue(req.query.min_margin);
      const freshness = decodeQueryValue(req.query.freshness);
      const minVol = decodeQueryValue(req.query.min_volatility);
      const maxVol = decodeQueryValue(req.query.max_volatility);
      const categories = decodeQueryValue(req.query.categories);
      const limit = decodeQueryValue(req.query.limit);
      const period = decodeQueryValue(req.query.period);
      const filterItems = decodeQueryValue(req.query.filter_items);

      if (minPrice) rpcParams.p_min_price = parseFloat(minPrice);
      if (maxPrice) rpcParams.p_max_price = parseFloat(maxPrice);
      if (minProfit) rpcParams.p_min_profit = parseFloat(minProfit);
      if (minMargin) rpcParams.p_min_margin = parseFloat(minMargin);
      if (freshness) rpcParams.p_freshness_hours = parseInt(freshness, 10);
      if (minVol) rpcParams.p_min_volatility = parseFloat(minVol);
      if (maxVol) rpcParams.p_max_volatility = parseFloat(maxVol);
      if (categories) rpcParams.p_categories = categories.split(',').map(s => s.trim()).filter(Boolean);
      if (limit) rpcParams.p_limit = parseInt(limit, 10);
      if (period) rpcParams.p_period_days = parseInt(period, 10);
      if (filterItems) rpcParams.p_filter_items = filterItems.split(',').map(s => s.trim()).filter(Boolean);

    } else if (type === 'trends') {
      rpcName = 'market_trends_v1';

      const minPrice = decodeQueryValue(req.query.min_price);
      const maxPrice = decodeQueryValue(req.query.max_price);
      const period = decodeQueryValue(req.query.period);
      const trendType = decodeQueryValue(req.query.trend_type);
      const limit = decodeQueryValue(req.query.limit);
      const categories = decodeQueryValue(req.query.categories);
      const filterItems = decodeQueryValue(req.query.filter_items);

      if (minPrice) rpcParams.p_min_price = parseFloat(minPrice);
      if (maxPrice) rpcParams.p_max_price = parseFloat(maxPrice);
      rpcParams.p_period_days = period ? parseInt(period, 10) : 30;
      rpcParams.p_trend_type = trendType || 'bullish';
      rpcParams.p_limit = limit ? parseInt(limit, 10) : 50;
      
      if (categories) rpcParams.p_categories = categories.split(',').map(s => s.trim()).filter(Boolean);
      if (filterItems) rpcParams.p_filter_items = filterItems.split(',').map(s => s.trim()).filter(Boolean);

    } else {
      return res.status(400).json({ error: 'invalid_type', message: `Unknown analysis type: ${type}` });
    }

    const { data, error } = await supabase.rpc(rpcName, rpcParams);

    if (error) {
      console.error(`Supabase RPC error (${rpcName}):`, error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json(data);

  } catch (err: any) {
    console.error('Error in /api/analysis:', err);
    return res.status(500).json({ error: 'internal_server_error', message: err.message });
  }
}
