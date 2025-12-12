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

  // --- Favorites Mode ---
  if (mode === 'favorites') {
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
        return res.status(500).json({ error: 'database_error', message: error.message });
      }

      return res.status(201).json({ status: 'ok' });
    }

    if (req.method === 'DELETE') {
      const { profileId, itemName } = req.body;

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

      return res.status(200).json({ status: 'ok' });
    }
  }

  // --- Profiles Mode (Default) ---
  if (req.method === 'GET') {
    // List all profiles
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .order('name');

    if (error) {
      console.error('Error fetching profiles:', error);
      return res.status(500).json({ error: 'database_error', message: error.message });
    }

    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    // Create a new profile
    const { name } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'invalid_input', message: 'Name is required' });
    }

    const { data, error } = await supabase
      .from('profiles')
      .insert([{ name }])
      .select()
      .single();

    if (error) {
      console.error('Error creating profile:', error);
      if (error.code === '23505') {
        return res.status(409).json({ error: 'conflict', message: 'Profile name already exists' });
      }
      return res.status(500).json({ error: 'database_error', message: error.message });
    }

    return res.status(201).json(data);
  }

  if (req.method === 'DELETE') {
    const { id } = req.query;

    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'invalid_input', message: 'id is required' });
    }

    const { error } = await supabase
      .from('profiles')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Error deleting profile:', error);
      return res.status(500).json({ error: 'database_error', message: error.message });
    }

    return res.status(200).json({ status: 'ok' });
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'method_not_allowed' });
}
