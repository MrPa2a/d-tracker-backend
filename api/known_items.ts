import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { setCors } from '../utils/cors';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

const createItemSchema = z.object({
  gid: z.number().int().positive(),
  name: z.string().min(1),
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method === 'GET') {
    // MIGRATION V3: On lit depuis la table items avec le flag is_manually_added
    const { data, error } = await supabase
      .from('items')
      .select('ankama_id, name')
      .eq('is_manually_added', true);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Mapping pour compatibilité client (ankama_id -> gid)
    const mappedData = data?.map((row) => ({
      gid: row.ankama_id,
      name: row.name,
    }));

    return res.status(200).json(mappedData);
  }

  if (req.method === 'POST') {
    try {
      const body = createItemSchema.parse(req.body);
      
      // MIGRATION V3: On écrit dans items
      // On utilise le nom comme clé de réconciliation
      const { error } = await supabase
        .from('items')
        .upsert({ 
          name: body.name, 
          ankama_id: body.gid,
          is_manually_added: true 
        }, { onConflict: 'name' });

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(400).json({ error: 'Invalid body' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
