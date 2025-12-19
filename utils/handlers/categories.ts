import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { setCors } from '../cors';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

export const handleCategories = async (req: VercelRequest, res: VercelResponse) => {
  // CORS is handled in the main handler, but we can keep it here for safety or remove it if the main handler does it.
  // It's better to let the main handler do it once, but if we call this function directly, we might want it.
  // However, if the main handler does it, doing it again might add duplicate headers.
  // Let's assume the main handler will handle CORS for the OPTIONS request, but for the actual response, we might need it?
  // setCors sets headers. Setting them twice is usually fine if values are same.
  // But let's keep it to be safe as we are just moving code.
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { data, error } = await supabase
    .from('categories')
    .select('id, name')
    .order('name');

  if (error) {
    console.error('Error fetching categories:', error);
    return res.status(500).json({ error: 'db_error' });
  }

  return res.status(200).json(data);
}
