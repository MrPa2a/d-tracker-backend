import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export const handleBank = async (req: VercelRequest, res: VercelResponse) => {
  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

  // --- GET: Récupérer le contenu de la banque ---
  if (req.method === 'GET') {
    const { server, profileId } = req.query;

    if (!server) {
      return res.status(400).json({ error: 'invalid_input', message: 'server is required' });
    }

    try {
      let query = supabase
        .from('bank_items_view')
        .select('*')
        .eq('server', server)
        .order('item_name', { ascending: true });

      if (profileId) {
        query = query.eq('profile_id', profileId);
      }

      const { data, error } = await query;

      if (error) {
        console.error('Error fetching bank items:', error);
        return res.status(500).json({ error: 'database_error', message: error.message });
      }

      // Calculer les stats
      const totalItems = data?.reduce((sum, item) => sum + item.quantity, 0) || 0;
      const uniqueItems = data?.length || 0;
      const totalValue = data?.reduce((sum, item) => {
        return sum + (item.last_price || 0) * item.quantity;
      }, 0) || 0;

      return res.status(200).json({
        items: data || [],
        stats: {
          total_items: totalItems,
          unique_items: uniqueItems,
          total_value: totalValue
        }
      });

    } catch (error) {
      console.error('Error in GET bank:', error);
      return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
    }
  }

  // --- POST: Synchroniser le contenu de la banque ---
  if (req.method === 'POST') {
    // Auth check - utilise INGEST_API_TOKEN comme les autres routes
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'unauthorized', message: 'Missing authorization header' });
    }
    const token = authHeader.split(' ')[1];
    const expectedToken = process.env.INGEST_API_TOKEN;
    if (token !== expectedToken) {
      return res.status(401).json({ error: 'unauthorized', message: 'Invalid token' });
    }

    const { server, profileId, items, capturedAt } = req.body;

    if (!server) {
      return res.status(400).json({ error: 'invalid_input', message: 'server is required' });
    }
    if (!items || !Array.isArray(items)) {
      return res.status(400).json({ error: 'invalid_input', message: 'items must be an array' });
    }

    try {
      // Validate items structure
      for (const item of items) {
        if (typeof item.gid !== 'number' || typeof item.quantity !== 'number') {
          return res.status(400).json({ 
            error: 'invalid_input',
            message: 'Each item must have gid (number) and quantity (number)' 
          });
        }
      }

      // Call the sync function
      const { data, error } = await supabase.rpc('sync_bank_content', {
        p_server: server,
        p_profile_id: profileId || null,
        p_items: items,
        p_captured_at: capturedAt || new Date().toISOString()
      });

      if (error) {
        console.error('Error syncing bank:', error);
        return res.status(500).json({ error: 'database_error', message: error.message });
      }

      const result = data?.[0] || { inserted: 0, updated: 0, deleted: 0, unknown_gids: [] };

      console.log(`[Bank] Synced for ${server}: +${result.inserted} ~${result.updated} -${result.deleted}`);

      return res.status(201).json({
        success: true,
        message: `Bank synced: ${result.inserted} inserted, ${result.updated} updated, ${result.deleted} deleted`,
        stats: result,
        unknown_gids: result.unknown_gids || []
      });

    } catch (error) {
      console.error('Error in POST bank:', error);
      return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
    }
  }

  // --- DELETE: Vider la banque ---
  if (req.method === 'DELETE') {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'unauthorized', message: 'Missing authorization header' });
    }
    const token = authHeader.split(' ')[1];
    if (token !== process.env.INGEST_API_TOKEN) {
      return res.status(401).json({ error: 'unauthorized', message: 'Invalid token' });
    }

    const { server, profileId } = req.body;

    if (!server) {
      return res.status(400).json({ error: 'invalid_input', message: 'server is required' });
    }

    try {
      let query = supabase
        .from('bank_items')
        .delete()
        .eq('server', server);

      if (profileId) {
        query = query.eq('profile_id', profileId);
      }

      const { error, count } = await query;

      if (error) {
        console.error('Error deleting bank items:', error);
        return res.status(500).json({ error: 'database_error', message: error.message });
      }

      return res.status(200).json({
        success: true,
        message: `Deleted ${count || 'all'} items from bank`,
        deleted_count: count
      });

    } catch (error) {
      console.error('Error in DELETE bank:', error);
      return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'method_not_allowed' });
};
