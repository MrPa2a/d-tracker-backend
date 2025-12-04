import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { setCors } from '../utils/cors';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ingestApiToken = process.env.INGEST_API_TOKEN;

let supabase: SupabaseClient | null = null;

if (supabaseUrl && supabaseServiceRoleKey) {
  supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
}

const updateSchema = z.object({
  id: z.number().int().positive(),
  price_unit_avg: z.number().nonnegative(),
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!supabase || !ingestApiToken) {
    return res.status(500).json({ error: 'backend_not_configured' });
  }

  if (req.method !== 'PUT') {
    res.setHeader('Allow', 'PUT');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Auth
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const token = authHeader.slice('Bearer '.length).trim();
  if (token !== ingestApiToken) {
    return res.status(403).json({ error: 'forbidden' });
  }

  // Parse Body
  let parsedBody: unknown;
  try {
    parsedBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (err) {
    return res.status(400).json({ error: 'invalid_json' });
  }

  const result = updateSchema.safeParse(parsedBody);
  if (!result.success) {
    return res.status(400).json({ error: 'validation_error', details: result.error.flatten() });
  }

  const { id, price_unit_avg } = result.data;

  // Update Supabase
  const { error } = await supabase
    .from('market_observations')
    .update({ price_unit_avg })
    .eq('id', id);

  if (error) {
    console.error('Supabase update error:', error);
    return res.status(500).json({ error: 'db_update_failed' });
  }

  return res.status(200).json({ status: 'ok', updated_id: id });
}
