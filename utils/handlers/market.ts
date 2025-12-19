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

export const handleMarket = async (req: VercelRequest, res: VercelResponse) => {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Auth
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
  const from = decodeQueryValue(req.query.from);
  const to = decodeQueryValue(req.query.to);
  const limitStr = decodeQueryValue(req.query.limit);
  const minPriceStr = decodeQueryValue(req.query.min_price);
  const maxPriceStr = decodeQueryValue(req.query.max_price);
  const filterItemsStr = decodeQueryValue(req.query.filterItems);
  const order = decodeQueryValue(req.query.order) ?? 'desc';
  const item = decodeQueryValue(req.query.item);

  if (!type || !server || !from || !to) {
    return res.status(400).json({ error: 'Missing required parameters: type, server, from, to' });
  }

  try {
    const fromDate = new Date(from as string);
    const toDate = new Date(to as string);

    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date format' });
    }

    const limit = limitStr ? parseInt(limitStr, 10) : 20;
    const minPrice = minPriceStr ? parseFloat(minPriceStr) : null;
    const maxPrice = maxPriceStr ? parseFloat(maxPriceStr) : null;
    const filterItems = filterItemsStr ? filterItemsStr.split(',').map(s => s.trim()).filter(Boolean) : null;

    let rpcName = '';
    let rpcParams: any = {
      p_server: server,
      p_from: fromDate.toISOString().split('T')[0],
      p_to: toDate.toISOString().split('T')[0],
    };

    switch (type) {
      case 'index':
        rpcName = 'market_index_v3';
        rpcParams.p_filter_items = filterItems;
        break;
      case 'movers':
        rpcName = 'get_movers_v3';
        rpcParams.p_limit = limit;
        rpcParams.p_min_price = minPrice;
        rpcParams.p_max_price = maxPrice;
        rpcParams.p_filter_items = filterItems;
        rpcParams.p_order = order; // 'asc', 'desc', or 'abs'
        break;
      case 'volatility':
        rpcName = 'get_volatility_rankings_v3';
        rpcParams.p_limit = limit;
        rpcParams.p_order = order;
        rpcParams.p_min_price = minPrice;
        rpcParams.p_max_price = maxPrice;
        rpcParams.p_filter_items = filterItems;
        break;
      case 'opportunities':
        rpcName = 'investment_opportunities_v3';
        rpcParams.p_limit = limit;
        rpcParams.p_min_price = minPrice;
        rpcParams.p_max_price = maxPrice;
        rpcParams.p_filter_items = filterItems;
        break;
      case 'sell-opportunities':
        rpcName = 'sell_opportunities_v3';
        rpcParams.p_limit = limit;
        rpcParams.p_min_price = minPrice;
        rpcParams.p_max_price = maxPrice;
        rpcParams.p_filter_items = filterItems;
        break;
      case 'stats':
        if (!item) {
          return res.status(400).json({ error: 'Missing required parameter: item' });
        }
        rpcName = 'item_stats_v3';
        rpcParams.p_item_name = item;
        break;
      default:
        return res.status(400).json({ error: 'invalid_type', message: `Unknown market type: ${type}` });
    }

    const { data, error } = await supabase.rpc(rpcName, rpcParams);

    if (error) {
      console.error(`Supabase RPC error (${rpcName}):`, error);
      return res.status(500).json({ error: error.message });
    }

    // Special handling for index (returns single object)
    if (type === 'index') {
      const rawIndex = data && data.length > 0 ? data[0] : null;
      if (!rawIndex) return res.status(200).json(null);
      return res.status(200).json({
        server: rawIndex.server || '',
        index_change: typeof rawIndex.index_change === 'number' ? rawIndex.index_change : 0,
        total_items: typeof rawIndex.total_items === 'number' ? Number(rawIndex.total_items) : 0,
      });
    }

    // Special handling for stats (returns single object)
    if (type === 'stats') {
      const rawStats = data && data.length > 0 ? data[0] : null;
      return res.status(200).json(rawStats);
    }

    return res.status(200).json(data);

  } catch (err: any) {
    console.error('Error in /api/market:', err);
    return res.status(500).json({ error: 'internal_server_error', message: err.message });
  }
}
