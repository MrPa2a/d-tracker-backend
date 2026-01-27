import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { setCors } from '../cors';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

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

export const handleConsumables = async (req: VercelRequest, res: VercelResponse) => {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const server = decodeQueryValue(req.query.server);

  if (!server) {
    return res.status(400).json({ error: 'server_required' });
  }

  try {
    // 1. Get all items that have Life (110) or Energy (139) effects
    const { data: effectsData, error: effectsError } = await supabase
      .from('item_effects')
      .select('item_id, effect_id, min_value, max_value')
      .in('effect_id', [110, 139]);

    if (effectsError) throw effectsError;

    if (!effectsData || effectsData.length === 0) {
      return res.json([]);
    }

    // Group effects by item_id
    const itemStats: Record<number, { life: number, energy: number }> = {};
    const itemIds = new Set<number>();

    for (const row of effectsData) {
      const id = row.item_id;
      itemIds.add(id);
      if (!itemStats[id]) itemStats[id] = { life: 0, energy: 0 };

      // For consumables, min_value is the value.
      // If multiple lines (e.g. 2 lines of life), sum them? Usually it's one line.
      if (row.effect_id === 110) itemStats[id].life += row.min_value;
      if (row.effect_id === 139) itemStats[id].energy += row.min_value;
    }

    const idsArray = Array.from(itemIds);

    // 2. Get Item Details (Name, Image)
    const { data: itemsData, error: itemsError } = await supabase
      .from('items')
      .select('id, name, icon_url, level')
      .in('id', idsArray);

    if (itemsError) throw itemsError;

    // 3. Get Latest Prices for these items on the server
    // No time filter - we want the latest price regardless of age (like items_with_latest_stats_v3)
    const { data: pricesData, error: pricesError } = await supabase
      .from('observations')
      .select('item_id, price_unit_avg, captured_at')
      .eq('server', server)
      .in('item_id', idsArray)
      .order('captured_at', { ascending: false });

    if (pricesError) throw pricesError;

    // Map latest price (first occurrence per item since ordered by captured_at DESC)
    const priceMap: Record<number, number> = {};
    const processedItems = new Set<number>();

    if (pricesData) {
      for (const obs of pricesData) {
        if (!processedItems.has(obs.item_id)) {
          priceMap[obs.item_id] = obs.price_unit_avg;
          processedItems.add(obs.item_id);
        }
      }
    }

    // 4. Combine everything
    const result = itemsData?.map(item => {
      const stats = itemStats[item.id];
      const price = priceMap[item.id] || 0;
      
      return {
        id: item.id,
        name: item.name,
        img: item.icon_url,
        level: item.level || 1,
        stats: {
          life: stats.life,
          energy: stats.energy
        },
        price: price
      };
    }).filter(item => item.price > 0); // Only return items with a known price? Or return all? User might want to see items even if no price.
    // Let's return all, frontend can filter "No Price".

    return res.json(result);

  } catch (error: any) {
    console.error('Error in toolbox/consumables:', error);
    return res.status(500).json({ error: error.message });
  }
}
