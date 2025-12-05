import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { setCors } from '../utils/cors';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ingestApiToken = process.env.INGEST_API_TOKEN;

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// Helper for decoding query params
function decodeQueryValue(value: string | string[] | undefined): string | null {
  if (!value) return null;
  const v = Array.isArray(value) ? value[0] : value;
  try {
    return decodeURIComponent(v.replace(/\+/g, ' '));
  } catch {
    return v.replace(/\+/g, ' ');
  }
}

const updateItemSchema = z.object({
  old_item_name: z.string().min(1),
  new_item_name: z.string().min(1),
  server: z.string().min(1),
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // --- PUT: Update Item ---
  if (req.method === 'PUT') {
    // Auth check
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const token = authHeader.slice('Bearer '.length).trim();
    if (token !== ingestApiToken) {
      return res.status(403).json({ error: 'forbidden' });
    }

    let parsedBody: unknown;
    try {
      parsedBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (err) {
      return res.status(400).json({ error: 'invalid_json' });
    }

    const result = updateItemSchema.safeParse(parsedBody);
    if (!result.success) {
      return res.status(400).json({ error: 'validation_error', details: result.error.flatten() });
    }

    const { old_item_name, new_item_name, server } = result.data;

    const { error } = await supabase
      .from('market_observations')
      .update({ item_name: new_item_name })
      .eq('item_name', old_item_name)
      .eq('server', server);

    if (error) {
      console.error('Supabase update error:', error);
      return res.status(500).json({ error: 'db_update_failed' });
    }

    return res.status(200).json({ status: 'ok', old_item_name, new_item_name, server });
  }

  // --- GET: List Items or Item Stats ---
  if (req.method === 'GET') {
    const { mode } = req.query;

    // 1. Item Stats
    if (mode === 'stats') {
      // Auth check
      const authHeader = req.headers['authorization'];
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'unauthorized' });
      }
      const token = authHeader.slice('Bearer '.length).trim();
      if (token !== ingestApiToken) {
        return res.status(403).json({ error: 'forbidden' });
      }

      const item = decodeQueryValue(req.query.item);
      const server = decodeQueryValue(req.query.server);
      const from = decodeQueryValue(req.query.from);
      const to = decodeQueryValue(req.query.to);

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

        const rawStats = data && data.length > 0 ? data[0] : null;
        
        if (!rawStats) {
          return res.status(200).json(null);
        }

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
      } catch (err: any) {
        console.error('Error in item-stats:', err);
        return res.status(500).json({ error: 'internal_server_error', message: err.message });
      }
    }

    // 2. List Servers (mode=servers)
    if (mode === 'servers') {
      const { data, error } = await supabase.rpc('get_unique_servers');
      if (error) {
        console.error('Supabase error in /api/items (servers):', error);
        return res.status(500).json({ error: 'database_error', message: error.message });
      }
      const servers = (data as any[]).map((d) => d.server);
      return res.status(200).json(servers);
    }

    // 3. List Items (Default)
    try {
      const { 
        limit = '200', 
        offset = '0', 
        search = '', 
        sortBy = 'name', 
        sortOrder = 'asc',
        server
      } = req.query;

      let query = supabase.rpc('items_with_latest_stats');

      if (server) {
        query = query.eq('server', server as string);
      }

      if (search) {
        query = query.ilike('item_name', `%${search}%`);
      }

      const sortColumn = sortBy === 'price' ? 'last_price' : 'item_name';
      query = query.order(sortColumn, { ascending: sortOrder === 'asc' });

      const from = parseInt(offset as string);
      const to = from + parseInt(limit as string) - 1;
      
      query = query.range(from, to);

      const { data, error } = await query;

      if (error) {
        console.error('Supabase error in /api/items:', error);
        return res.status(500).json({
          error: 'supabase_error',
          message: 'Failed to fetch items_with_latest_stats',
          details: error.message,
        });
      }

      return res.status(200).json(
        (data || []).map((row: any) => ({
          item_name: row.item_name,
          server: row.server,
          last_observation_at: row.last_observation_at,
          last_price: row.last_price,
        }))
      );
    } catch (err: any) {
      console.error('Error in /api/items:', err);
      return res.status(500).json({ error: 'internal_server_error', message: err.message });
    }
  }

  res.setHeader('Allow', 'GET, PUT');
  return res.status(405).json({ error: 'method_not_allowed' });
}
