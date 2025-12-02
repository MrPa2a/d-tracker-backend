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

  if (req.method === 'GET') {
    const { profileId } = req.query;

    if (!profileId || typeof profileId !== 'string') {
      return res.status(400).json({ error: 'invalid_input', message: 'profileId is required' });
    }

    const { data, error } = await supabase
      .from('profile_favorites')
      .select('item_name')
      .eq('profile_id', profileId);

    if (error) {
      console.error('Error fetching favorites:', error);
      return res.status(500).json({ error: 'database_error', message: error.message });
    }

    // Return just the list of strings
    const favorites = data.map((row: any) => row.item_name);
    return res.status(200).json(favorites);
  }

  if (req.method === 'POST') {
    const { profileId, itemName } = req.body;

    if (!profileId || !itemName) {
      return res.status(400).json({ error: 'invalid_input', message: 'profileId and itemName are required' });
    }

    const { error } = await supabase
      .from('profile_favorites')
      .insert([{ profile_id: profileId, item_name: itemName }]);

    if (error) {
      console.error('Error adding favorite:', error);
      if (error.code === '23505') {
        // Already exists, just ignore
        return res.status(200).json({ message: 'Already a favorite' });
      }
      return res.status(500).json({ error: 'database_error', message: error.message });
    }

    return res.status(201).json({ message: 'Added to favorites' });
  }

  if (req.method === 'DELETE') {
    // Support both body and query params for DELETE
    let profileId = req.body.profileId || req.query.profileId;
    let itemName = req.body.itemName || req.query.itemName;

    if (!profileId || !itemName) {
      return res.status(400).json({ error: 'invalid_input', message: 'profileId and itemName are required' });
    }

    const { error } = await supabase
      .from('profile_favorites')
      .delete()
      .eq('profile_id', profileId)
      .eq('item_name', itemName);

    if (error) {
      console.error('Error removing favorite:', error);
      return res.status(500).json({ error: 'database_error', message: error.message });
    }

    return res.status(200).json({ message: 'Removed from favorites' });
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'method_not_allowed', message: 'Only GET, POST, DELETE are allowed' });
}
