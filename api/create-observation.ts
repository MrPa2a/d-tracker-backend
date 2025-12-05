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

const createSchema = z.object({
  item_name: z.string().min(1),
  server: z.string().min(1),
  captured_at: z.string().datetime(),
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

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
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

  const result = createSchema.safeParse(parsedBody);
  if (!result.success) {
    return res.status(400).json({ error: 'validation_error', details: result.error.flatten() });
  }

  const { item_name, server, captured_at, price_unit_avg } = result.data;

  // Insert into Supabase
  const { data, error } = await supabase
    .from('market_observations')
    .insert({
      item_name,
      server,
      captured_at,
      price_unit_avg,
      nb_lots: 1, // Default for manual entry
      source_client: 'manual_web_edit',
      raw_item_name: item_name
    })
    .select()
    .single();

  if (error) {
    console.error('Supabase insert error:', error);
    return res.status(500).json({ error: 'db_insert_failed', details: error.message });
  }

  return res.status(200).json({ status: 'ok', data });
}
