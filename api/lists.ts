import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { setCors } from '../utils/cors';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { mode } = req.query;

  // --- Items Mode (Add/Remove items from list) ---
  if (mode === 'items') {
    if (req.method === 'POST') {
      const { listId, itemId } = req.body;

      if (!listId || !itemId) {
        return res.status(400).json({ error: 'invalid_input', message: 'listId and itemId are required' });
      }

      const { error } = await supabase
        .from('list_items')
        .insert([{ list_id: listId, item_id: itemId }]);

      if (error) {
        // Ignore duplicate key error
        if (error.code === '23505') {
          return res.status(200).json({ message: 'Item already in list' });
        }
        console.error('Error adding item to list:', error);
        return res.status(500).json({ error: 'database_error', message: error.message });
      }

      return res.status(200).json({ message: 'Item added to list' });
    }

    if (req.method === 'DELETE') {
      const { listId, itemId } = req.query;

      if (!listId || !itemId) {
        return res.status(400).json({ error: 'invalid_input', message: 'listId and itemId are required' });
      }

      const { error } = await supabase
        .from('list_items')
        .delete()
        .eq('list_id', listId)
        .eq('item_id', itemId);

      if (error) {
        console.error('Error removing item from list:', error);
        return res.status(500).json({ error: 'database_error', message: error.message });
      }

      return res.status(200).json({ message: 'Item removed from list' });
    }
    
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // --- Lists Mode (CRUD Lists) ---

  if (req.method === 'GET') {
    const { profileId, server, range, id } = req.query;

    // 1. Fetch lists with basic item info (name, category)
    // Note: items table does not have server/price. We fetch category via relation.
    let query = supabase
      .from('lists')
      .select('*, list_items(item_id, items(name, categories(name)))');

    if (id) {
      query = query.eq('id', id);
    } else if (profileId) {
      query = query.or(`scope.eq.public,and(scope.eq.private,profile_id.eq.${profileId})`);
    } else {
      query = query.eq('scope', 'public');
    }

    const { data: listsData, error: listsError } = await query.order('created_at', { ascending: false });

    if (listsError) {
      console.error('Error fetching lists:', listsError);
      return res.status(500).json({ error: 'database_error', message: listsError.message });
    }

    // 2. Extract all unique item names to fetch their stats
    const allItemNames = new Set<string>();
    listsData.forEach((list: any) => {
      list.list_items.forEach((li: any) => {
        if (li.items?.name) {
          allItemNames.add(li.items.name);
        }
      });
    });

    // 3. Fetch stats (price, server) for these items
    // We use the RPC items_with_latest_stats_v3 and filter by item names
    // If a server is provided in query, we filter by it. Otherwise we might get multiple rows per item (one per server).
    // We'll prioritize the requested server, or 'Draconiros', or just the first one.
    let statsMap = new Map<string, any>();

    if (allItemNames.size > 0) {
      // Calculate from date based on range
      let fromDate = new Date();
      const r = (range as string) || '24h';
      
      if (r === '7d') fromDate.setDate(fromDate.getDate() - 7);
      else if (r === '30d') fromDate.setDate(fromDate.getDate() - 30);
      else if (r === '90d') fromDate.setDate(fromDate.getDate() - 90);
      else if (r === '365d') fromDate.setDate(fromDate.getDate() - 365);
      else fromDate.setDate(fromDate.getDate() - 1); // Default 24h

      const { data: statsData, error: statsError } = await supabase
        .rpc('items_with_variation_v3', {
          p_item_names: Array.from(allItemNames),
          p_server: server || null,
          p_from: fromDate.toISOString()
        });

      if (statsError) {
        console.error('Error fetching item stats for lists:', statsError);
        // We continue without stats if this fails, to at least show the lists
      } else if (statsData) {
        // Build a map: item_name -> stats
        // If multiple servers, we prefer the one matching 'server' param, or 'Draconiros', or just the latest.
        // Since we already filtered by server if provided, we just need to handle the case where no server was provided.
        // If no server provided, we might get duplicates. We'll pick 'Draconiros' if available, else the first one.
        
        // Group by item_name
        const grouped = new Map<string, any[]>();
        statsData.forEach((stat: any) => {
          if (!grouped.has(stat.item_name)) grouped.set(stat.item_name, []);
          grouped.get(stat.item_name)!.push(stat);
        });

        grouped.forEach((stats, name) => {
          let selected = stats[0];
          if (!server) {
             const draco = stats.find((s: any) => s.server === 'Draconiros');
             if (draco) selected = draco;
          }
          statsMap.set(name, selected);
        });
      }
    }

    // 4. Merge stats into the response
    const formattedData = listsData.map((list: any) => ({
      ...list,
      list_items: list.list_items.map((li: any) => {
        const itemName = li.items?.name || 'Unknown Item';
        const stats = statsMap.get(itemName);
        
        return {
          item_id: li.item_id,
          item_name: itemName,
          // Use category from items table join if available, else from stats
          category: li.items?.categories?.name || stats?.category,
          // Use stats for price and server
          server: stats?.server,
          last_price: stats?.last_price,
          previous_price: stats?.previous_price,
          last_observation_at: stats?.last_observation_at,
          average_price: stats?.average_price
        };
      }).filter((i: any) => i.item_name !== 'Unknown Item')
    }));

    return res.status(200).json(formattedData);
  }

  if (req.method === 'POST') {
    const { name, scope, profileId } = req.body;

    if (!name || !scope) {
      return res.status(400).json({ error: 'invalid_input', message: 'name and scope are required' });
    }

    if (scope === 'private' && !profileId) {
      return res.status(400).json({ error: 'invalid_input', message: 'profileId is required for private lists' });
    }

    const { data, error } = await supabase
      .from('lists')
      .insert([{ name, scope, profile_id: profileId }])
      .select()
      .single();

    if (error) {
      console.error('Error creating list:', error);
      return res.status(500).json({ error: 'database_error', message: error.message });
    }

    return res.status(200).json({ ...data, list_items: [] });
  }

  if (req.method === 'DELETE') {
    const { id } = req.query;

    if (!id) {
      return res.status(400).json({ error: 'invalid_input', message: 'id is required' });
    }

    const { error } = await supabase
      .from('lists')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Error deleting list:', error);
      return res.status(500).json({ error: 'database_error', message: error.message });
    }

    return res.status(200).json({ message: 'List deleted' });
  }

  return res.status(405).json({ error: 'method_not_allowed' });
}
