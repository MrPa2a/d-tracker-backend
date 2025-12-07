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
    const { data, error } = await supabase
      .from('known_items')
      .select('gid, name');

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Convert to a map or list as preferred by client. 
    // Client expects a dictionary GID -> Name usually, but list is fine.
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    try {
      const body = createItemSchema.parse(req.body);
      
      const { error } = await supabase
        .from('known_items')
        .upsert({ gid: body.gid, name: body.name }, { onConflict: 'gid' });

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
