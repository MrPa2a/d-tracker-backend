import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { setCors } from '../cors';

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

export const handleObservations = async (req: VercelRequest, res: VercelResponse) => {
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
  let parsedBody: any;
  if (req.method !== 'GET') {
     // DELETE might have body or query param? Usually body for JSON APIs
     // Actually delete-observation.ts used body.
     try {
      parsedBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (err) {
      return res.status(400).json({ error: 'invalid_json' });
    }
  }

  // --- POST: Create Observation ---
  if (req.method === 'POST') {
    const result = createSchema.safeParse(parsedBody);
    if (!result.success) {
      return res.status(400).json({ error: 'validation_error', details: result.error.flatten() });
    }

    const { item_name, server, captured_at, price_unit_avg } = result.data;

    // MIGRATION V3: Insert into NEW table (observations) ONLY
    let v3Data = null;
    try {
      const { data: itemId, error: rpcError } = await supabase!.rpc('get_or_create_item_id', {
        p_name: item_name,
        p_ankama_id: null,
        p_category: null
      });

      if (!rpcError && itemId) {
        const { data: obsData, error: obsError } = await supabase!.from('observations').insert({
          item_id: itemId,
          server,
          price_unit_avg,
          captured_at,
          nb_lots: 1,
          source_client: 'manual_web_edit'
        }).select().single();

        if (!obsError) {
          v3Data = obsData;
        } else {
          console.error('Insert Error:', obsError);
          return res.status(500).json({ error: 'db_insert_failed', details: obsError.message });
        }
      } else {
        console.error('RPC Error:', rpcError);
        return res.status(500).json({ error: 'db_rpc_failed', details: rpcError?.message ?? 'Item ID not returned' });
      }
    } catch (e: any) {
      console.error('Exception:', e);
      return res.status(500).json({ error: 'internal_error', details: e.message });
    }

    return res.status(200).json({ status: 'ok', data: v3Data });
  }

  // --- PUT: Update Observation ---
  if (req.method === 'PUT') {
    const result = updateSchema.safeParse(parsedBody);
    if (!result.success) {
      return res.status(400).json({ error: 'validation_error', details: result.error.flatten() });
    }

    const { id, price_unit_avg } = result.data;

    // MIGRATION V3: Update NEW table (observations)
    // The ID comes from the frontend which reads from V3 tables.
    const { error } = await supabase
      .from('observations')
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

    // MIGRATION V3: Delete from NEW table (observations)
    const { error } = await supabase
      .from('observations')
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
