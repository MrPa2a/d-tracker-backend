import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

// Load env vars
const envPath = path.resolve(__dirname, '../.env.local');
console.log('Loading env from:', envPath);
dotenv.config({ path: envPath });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

const DOFUSDB_API = 'https://api.dofusdb.fr';

interface DofusDBItem {
  id: number;
  craftXpRatio?: number;
  type?: {
    craftXpRatio?: number;
  };
}

interface DofusDBResponse {
  data: DofusDBItem[];
}

async function fetchDofusDBItems(skip: number, limit: number): Promise<DofusDBResponse> {
  // Removing $select to ensure we get the full object including nested type relations
  const url = `${DOFUSDB_API}/items?$limit=${limit}&$skip=${skip}`;
  console.log('Fetching URL:', url);
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch items: ${response.statusText}`);
  }
  const json = await response.json() as DofusDBResponse;
  if (!json.data || json.data.length === 0) {
    console.log('Empty data received. Full response:', JSON.stringify(json));
  }
  return json;
}

async function updateItems() {
  console.log('Starting XP Ratio sync...');
  
  let skip = 0;
  const limit = 50;
  let totalProcessed = 0;
  let totalUpdated = 0;

  while (true) {
    try {
      console.log(`Fetching items skip=${skip}...`);
      const data = await fetchDofusDBItems(skip, limit);
      
      if (!data.data || data.data.length === 0) {
        break;
      }

      const updates = [];

      for (const item of data.data) {
        const ankamaId = item.id;
        let ratio = item.craftXpRatio;

        // Fallback to type ratio if item ratio is invalid (-1 usually means inherit or default)
        if (ratio === -1 || ratio === undefined) {
          if (item.type && item.type.craftXpRatio !== undefined && item.type.craftXpRatio !== -1) {
            ratio = item.type.craftXpRatio;
          }
        }

        // If we found a valid ratio (even 0 or 5 or 100), we update
        // Note: Some items might really have -1 if they are not craftable or have no XP logic.
        // But we are interested in positive ratios mostly.
        // However, storing -1 or null is fine.
        
        if (ratio !== undefined) {
            updates.push({
                ankama_id: ankamaId,
                craft_xp_ratio: ratio
            });
        }
      }

      // Batch update in Supabase
      // We can't do a massive bulk update easily with Supabase JS client for different values on different rows without upsert.
      // But upsert requires all columns or it might default others? No, upsert updates specified columns.
      // But we need to match on ankama_id.
      // Our items table primary key is `id` (UUID), but we have `ankama_id` (Int).
      // We should check if `ankama_id` is unique. It should be.
      
      // Let's do it one by one or in small batches if possible.
      // Supabase upsert works if we have a unique constraint on ankama_id.
      // Let's assume we do or we can use `id` if we fetch it first.
      
      // To be safe and simple, let's iterate and update. It's slower but safer for a script.
      // Or better: fetch all items from our DB that match these ankama_ids, then update them.
      
      const ankamaIds = updates.map(u => u.ankama_id);
      const { data: existingItems, error } = await supabase
        .from('items')
        .select('id, ankama_id')
        .in('ankama_id', ankamaIds);

      if (error) {
        console.error('Error fetching existing items:', error);
        continue;
      }

      const existingMap = new Map(existingItems.map(i => [i.ankama_id, i.id]));

      const promises = [];
      for (const update of updates) {
        const dbId = existingMap.get(update.ankama_id);
        if (dbId) {
          promises.push(
            supabase
              .from('items')
              .update({ craft_xp_ratio: update.craft_xp_ratio })
              .eq('id', dbId)
          );
          totalUpdated++;
        }
      }

      await Promise.all(promises);

      totalProcessed += data.data.length;
      skip += limit;
      
      // Optional: Sleep to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));

    } catch (err) {
      console.error('Error in loop:', err);
      break;
    }
  }

  console.log(`Sync complete. Processed: ${totalProcessed}, Updated: ${totalUpdated}`);
}

updateItems();
