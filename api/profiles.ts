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
      // Check for unique constraint violation
      if (error.code === '23505') {
        return res.status(409).json({ error: 'conflict', message: 'Profile name already exists' });
      }
      return res.status(500).json({ error: 'database_error', message: error.message });
    }

    return res.status(201).json(data);
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method_not_allowed', message: 'Only GET and POST are allowed' });
}
