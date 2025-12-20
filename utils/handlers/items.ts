import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import Busboy from 'busboy';
import { setCors } from '../cors';

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

// Helper to remove accents
function removeAccents(str: string): string {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

const updateItemSchema = z.object({
  old_item_name: z.string().min(1),
  new_item_name: z.string().min(1),
  server: z.string().min(1),
  category: z.string().optional(),
});

export const handleItems = async (req: VercelRequest, res: VercelResponse) => {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method === 'POST') {
    const { type } = req.query;

    // Upload Icon
    if (type === 'icon') {
      const contentType = req.headers['content-type'] || '';
      
      // Check if it's a multipart request (file upload)
      if (contentType.includes('multipart/form-data')) {
        const busboy = Busboy({ headers: req.headers });
        let gid: string | null = null;
        let fileBuffer: Buffer | null = null;
        let mimeType: string = 'image/png';

        return new Promise<void>((resolve) => {
          busboy.on('field', (fieldname, val) => {
            if (fieldname === 'gid') {
              gid = val;
            }
          });

          busboy.on('file', (fieldname, file, info) => {
            const { mimeType: mime } = info;
            mimeType = mime;
            const chunks: Buffer[] = [];
            
            file.on('data', (data) => {
              chunks.push(data);
            });
            
            file.on('end', () => {
              fileBuffer = Buffer.concat(chunks);
            });
          });

          busboy.on('finish', async () => {
            if (!gid || !fileBuffer) {
              res.status(400).json({ error: 'Missing gid or file' });
              return resolve();
            }

            try {
              const fileName = `${gid}.png`;
              
              // 1. Upload to Storage
              const { data: uploadData, error: uploadError } = await supabase
                .storage
                .from('item-icons')
                .upload(fileName, fileBuffer, {
                  contentType: mimeType,
                  upsert: true
                });

              if (uploadError) {
                console.error('Upload error:', uploadError);
                res.status(500).json({ error: uploadError.message });
                return resolve();
              }

              // 2. Get Public URL
              const { data: { publicUrl } } = supabase
                .storage
                .from('item-icons')
                .getPublicUrl(fileName);

              // 3. Update Database
              const { error: dbError } = await supabase
                .from('items')
                .update({ icon_url: publicUrl })
                .eq('ankama_id', parseInt(gid));

              if (dbError) {
                console.error('DB Update error:', dbError);
                res.status(500).json({ error: dbError.message });
                return resolve();
              }

              res.status(200).json({ success: true, url: publicUrl });
              return resolve();

            } catch (e: any) {
              res.status(500).json({ error: e.message });
              return resolve();
            }
          });

          req.pipe(busboy);
        });
      }
    }
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

    // Manual body parsing if not already parsed
    let parsedBody: any = req.body;
    
    if (!parsedBody || Object.keys(parsedBody).length === 0) {
        let bodyStr = '';
        await new Promise<void>((resolve, reject) => {
            req.on('data', chunk => { bodyStr += chunk; });
            req.on('end', () => resolve());
            req.on('error', err => reject(err));
        });

        try {
          parsedBody = JSON.parse(bodyStr);
        } catch (err) {
          return res.status(400).json({ error: 'invalid_json' });
        }
    }

    const result = updateItemSchema.safeParse(parsedBody);
    if (!result.success) {
      return res.status(400).json({ error: 'validation_error', details: result.error.flatten() });
    }

    const { old_item_name, new_item_name, server, category } = result.data;

    // Logic to handle category update
    let category_id: number | null | undefined = undefined;

    if (category !== undefined) {
      if (category.trim() === '') {
        category_id = null;
      } else {
        // Check if category exists
        const { data: catData, error: catError } = await supabase
          .from('categories')
          .select('id')
          .eq('name', category)
          .single();

        if (catData) {
          category_id = catData.id;
        } else {
          // Create category
          const { data: newCat, error: createError } = await supabase
            .from('categories')
            .insert({ name: category })
            .select('id')
            .single();
          
          if (createError || !newCat) {
             console.error('Error creating category:', createError);
             return res.status(500).json({ error: 'category_creation_failed' });
          }
          category_id = newCat.id;
        }
      }
    }

    // MIGRATION V3: Update items table directly
    const updatePayload: any = { name: new_item_name };
    if (category_id !== undefined) {
        updatePayload.category_id = category_id;
    }

    const { error } = await supabase
      .from('items')
      .update(updatePayload)
      .eq('name', old_item_name);

    if (error) {
      console.error('Supabase update error:', error);
      return res.status(500).json({ error: 'db_update_failed' });
    }

    return res.status(200).json({ status: 'ok', old_item_name, new_item_name, server, category });
  }

  // --- DELETE: Delete Item ---
  if (req.method === 'DELETE') {
    // Auth check
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const token = authHeader.slice('Bearer '.length).trim();
    if (token !== ingestApiToken) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const { id } = req.query;
    if (!id) {
      return res.status(400).json({ error: 'Missing item id' });
    }

    const itemId = parseInt(id as string);
    if (isNaN(itemId)) {
      return res.status(400).json({ error: 'Invalid item id' });
    }

    const { error } = await supabase.rpc('delete_item_cascade', {
      p_item_id: itemId
    });

    if (error) {
      console.error('Supabase RPC error (delete_item_cascade):', error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ success: true });
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

        const { data, error } = await supabase.rpc('item_stats_v3', {
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
          category: rawStats.category,
          icon_url: rawStats.icon_url
        };

        return res.status(200).json(stats);
      } catch (err: any) {
        console.error('Error in item-stats:', err);
        return res.status(500).json({ error: 'internal_server_error', message: err.message });
      }
    }

    // 2. List Servers (mode=servers)
    if (mode === 'servers') {
      const { data, error } = await supabase.rpc('get_unique_servers_v3');
      if (error) {
        console.error('Supabase error in /api/items (servers):', error);
        return res.status(500).json({ error: 'database_error', message: error.message });
      }
      const servers = (data as any[]).map((d) => d.server);
      return res.status(200).json(servers);
    }

    // 2.5 Get Usage Stats (mode=usage_stats)
    if (mode === 'usage_stats') {
      const { id } = req.query;
      if (!id) {
        return res.status(400).json({ error: 'Missing item id' });
      }
      const itemId = parseInt(id as string);
      if (isNaN(itemId)) {
        return res.status(400).json({ error: 'Invalid item id' });
      }

      const { data, error } = await supabase.rpc('get_item_usage_stats', {
        p_item_id: itemId
      });

      if (error) {
        console.error('Supabase RPC error (get_item_usage_stats):', error);
        return res.status(500).json({ error: error.message });
      }

      return res.status(200).json(data);
    }

    // 3. Search Items (mode=search) - Unique items only
    if (mode === 'search') {
      const search = decodeQueryValue(req.query.search);
      const limit = parseInt((req.query.limit as string) || '10');

      if (!search) {
        return res.status(200).json([]);
      }

      const normalizedSearch = removeAccents(search);
      
      // Fetch more items to allow better sorting in memory
      const { data, error } = await supabase
        .from('items')
        .select('id, name, ankama_id, icon_url, is_craftable')
        .ilike('name', `%${normalizedSearch}%`)
        .limit(100);

      if (error) {
        console.error('Supabase error in /api/items (search):', error);
        return res.status(500).json({ error: 'database_error', message: error.message });
      }

      let results = (data || []).map((row: any) => ({
        id: row.id,
        item_name: row.name,
        ankama_id: row.ankama_id,
        icon_url: row.icon_url,
        is_craftable: row.is_craftable
      }));

      // Sort by relevance: Exact > StartsWith > Length
      results.sort((a, b) => {
        const nameA = removeAccents(a.item_name).toLowerCase();
        const nameB = removeAccents(b.item_name).toLowerCase();
        const searchLower = normalizedSearch.toLowerCase();

        const exactA = nameA === searchLower;
        const exactB = nameB === searchLower;
        if (exactA && !exactB) return -1;
        if (!exactA && exactB) return 1;

        const startsA = nameA.startsWith(searchLower);
        const startsB = nameB.startsWith(searchLower);
        if (startsA && !startsB) return -1;
        if (!startsA && startsB) return 1;

        return nameA.length - nameB.length;
      });

      return res.status(200).json(results.slice(0, limit));
    }

    // 3.5 Get Item Details (mode=details)
    if (mode === 'details') {
      const itemName = decodeQueryValue(req.query.item_name);
      
      if (!itemName) {
        return res.status(400).json({ error: 'Missing item_name' });
      }

      // First get the item
      const { data: itemData, error: itemError } = await supabase
        .from('items')
        .select('id, name, level, icon_url, ankama_id, category_id')
        .eq('name', itemName)
        .single();

      if (itemError || !itemData) {
        return res.status(404).json({ error: 'Item not found' });
      }

      // Get effects
      const { data: effectsData, error: effectsError } = await supabase
        .from('item_effects')
        .select('*')
        .eq('item_id', itemData.id)
        .order('order_index', { ascending: true });

      if (effectsError) {
        console.error('Error fetching effects:', effectsError);
      }

      // Fetch icons for these effects manually (to avoid strict FK constraints)
      let formattedEffects = effectsData || [];
      
      if (formattedEffects.length > 0) {
        const effectIds = [...new Set(formattedEffects.map((e: any) => e.effect_id))];
        
        const { data: iconsData } = await supabase
            .from('effect_icons')
            .select('effect_id, icon_url')
            .in('effect_id', effectIds);
            
        const iconMap = new Map();
        if (iconsData) {
            iconsData.forEach((icon: any) => {
                iconMap.set(icon.effect_id, icon.icon_url);
            });
        }

        formattedEffects = formattedEffects.map((effect: any) => ({
            ...effect,
            icon_url: iconMap.get(effect.effect_id) || null
        }));
      }

      return res.status(200).json({
        ...itemData,
        effects: formattedEffects
      });
    }

    // 4. List Items (Default - with stats)
    try {
      const { 
        limit = '200', 
        offset = '0', 
        sortBy = 'name', 
        sortOrder = 'asc',
      } = req.query;

      const search = decodeQueryValue(req.query.search);
      const server = decodeQueryValue(req.query.server);
      const category = decodeQueryValue(req.query.category);
      const limitVal = parseInt(limit as string);
      const offsetVal = parseInt(offset as string);

      console.log('Search params:', { search, server, category, limit, offset });

      const mapRow = (row: any) => ({
        id: row.id,
        item_name: row.item_name,
        ankama_id: row.ankama_id,
        server: row.server,
        last_observation_at: row.last_observation_at,
        last_price: row.last_price,
        category: row.category,
        average_price: row.average_price,
        icon_url: row.icon_url,
        is_craftable: row.is_craftable,
        usage_count: row.usage_count
      });

      // Smart Search Strategy for first page of search results
      if (search && offsetVal === 0) {
        const normalizedSearch = removeAccents(search);
        
        const buildQuery = () => {
            let q = supabase.rpc('items_with_latest_stats_v3');
            if (server) q = q.eq('server', server);
            if (category) q = q.eq('category', category);
            return q;
        };

        // Parallel queries for relevance
        const [exact, startsWith, contains] = await Promise.all([
          buildQuery().ilike('normalized_name', normalizedSearch).limit(10),
          buildQuery().ilike('normalized_name', `${normalizedSearch}%`).limit(20),
          buildQuery().ilike('normalized_name', `%${normalizedSearch}%`).limit(limitVal + 20)
        ]);

        if (exact.error) throw exact.error;
        if (startsWith.error) throw startsWith.error;
        if (contains.error) throw contains.error;

        const allItems = [
          ...(exact.data || []), 
          ...(startsWith.data || []), 
          ...(contains.data || [])
        ];

        // Deduplicate by ID
        const uniqueItems = Array.from(new Map(allItems.map(item => [item.id, item])).values());

        // Sort by relevance
        uniqueItems.sort((a, b) => {
          const nameA = removeAccents(a.item_name).toLowerCase();
          const nameB = removeAccents(b.item_name).toLowerCase();
          const searchLower = normalizedSearch.toLowerCase();

          const exactA = nameA === searchLower;
          const exactB = nameB === searchLower;
          if (exactA && !exactB) return -1;
          if (!exactA && exactB) return 1;

          const startsA = nameA.startsWith(searchLower);
          const startsB = nameB.startsWith(searchLower);
          if (startsA && !startsB) return -1;
          if (!startsA && startsB) return 1;

          return nameA.length - nameB.length;
        });

        return res.status(200).json(uniqueItems.slice(0, limitVal).map(mapRow));
      }

      let query = supabase.rpc('items_with_latest_stats_v3');

      if (server) {
        query = query.eq('server', server);
      }

      if (category) {
        query = query.eq('category', category);
      }

      if (search) {
        const normalizedSearch = removeAccents(search);
        query = query.ilike('normalized_name', `%${normalizedSearch}%`);
      }

      const sortColumn = sortBy === 'price' ? 'last_price' : 'normalized_name';
      query = query.order(sortColumn, { ascending: sortOrder === 'asc' });

      const from = offsetVal;
      const to = from + limitVal - 1;
      
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

      return res.status(200).json((data || []).map(mapRow));
    } catch (err: any) {
      console.error('Error in /api/items:', err);
      return res.status(500).json({ error: 'internal_server_error', message: err.message });
    }
  }

  res.setHeader('Allow', 'GET, PUT, DELETE');
  return res.status(405).json({ error: 'method_not_allowed' });
}
