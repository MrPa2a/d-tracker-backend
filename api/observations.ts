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

const updateSchema = z.object({
  id: z.number().int().positive(),
  price_unit_avg: z.number().nonnegative(),
});

const deleteSchema = z.object({
  id: z.number().int().positive(),
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!supabase || !ingestApiToken) {
    return res.status(500).json({ error: 'backend_not_configured' });
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
  if (req.method !== 'GET' && req.method !== 'DELETE') { // DELETE might have body or query param? Usually body for JSON APIs
     // Actually delete-observation.ts used body.
     try {
      parsedBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (err) {
      return res.status(400).json({ error: 'invalid_json' });
    }
  } else if (req.method === 'DELETE') {
      // Try body first, if empty maybe query? But original used body.
      try {
        parsedBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      } catch (err) {
         // ignore if body is empty/invalid for now, validation will fail
      }
  }

  // --- POST: Create Observation ---
  if (req.method === 'POST') {
    const result = createSchema.safeParse(parsedBody);
    if (!result.success) {
      return res.status(400).json({ error: 'validation_error', details: result.error.flatten() });
    }

    const { item_name, server, captured_at, price_unit_avg } = result.data;

    const { data, error } = await supabase
      .from('market_observations')
      .insert({
        item_name,
        server,
        captured_at,
        price_unit_avg,
        nb_lots: 1,
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

  // --- PUT: Update Observation ---
  if (req.method === 'PUT') {
    const result = updateSchema.safeParse(parsedBody);
    if (!result.success) {
      return res.status(400).json({ error: 'validation_error', details: result.error.flatten() });
    }

    const { id, price_unit_avg } = result.data;

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

  // --- DELETE: Delete Observation ---
  if (req.method === 'DELETE') {
    const result = deleteSchema.safeParse(parsedBody);
    if (!result.success) {
      return res.status(400).json({ error: 'validation_error', details: result.error.flatten() });
    }

    const { id } = result.data;

    const { error } = await supabase
      .from('market_observations')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Supabase delete error:', error);
      return res.status(500).json({ error: 'db_delete_failed' });
    }

    return res.status(200).json({ status: 'ok', deleted_id: id });
  }

  res.setHeader('Allow', 'POST, PUT, DELETE');
  return res.status(405).json({ error: 'method_not_allowed' });
}
