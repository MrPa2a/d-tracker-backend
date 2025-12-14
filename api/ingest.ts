// api/ingest.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { setCors } from '../utils/cors';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ingestApiToken = process.env.INGEST_API_TOKEN;

let supabase: SupabaseClient | null = null;

if (!supabaseUrl || !supabaseServiceRoleKey || !ingestApiToken) {
  console.warn(
    'Missing env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, INGEST_API_TOKEN'
  );
} else {
  supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
}

// --------- Validation Zod ---------
const observationSchema = z.object({
  item_name: z.string().min(1).max(255),
  ankama_id: z.number().int().positive().optional(),
  server: z.string().min(1).max(255),
  captured_at: z.string().datetime(), // ISO 8601
  price_unit_avg: z.number().nonnegative(),
  nb_lots: z.number().int().positive(),
  source_client: z.string().min(1).max(255),
  client_version: z.string().max(50).optional(),
  raw_item_name: z.string().max(255).optional(),
  category: z.string().optional(),
});

type ObservationPayload = z.infer<typeof observationSchema>;

const bodySchema = z.union([
  observationSchema,
  z.array(observationSchema).nonempty(),
]);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 0) Vérifier que le backend est bien configuré
  if (!supabase || !ingestApiToken) {
    return res.status(500).json({
      error: 'backend_not_configured',
      message: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / INGEST_API_TOKEN',
    });
  }
  
  // 1) Méthode HTTP
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({
      error: 'method_not_allowed',
      message: 'Only POST /api/ingest is allowed',
    });
  }

  // 2) Auth simple via header Authorization: Bearer <token>
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Missing or invalid Authorization header',
    });
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (token !== ingestApiToken) {
    return res.status(403).json({
      error: 'forbidden',
      message: 'Invalid API token',
    });
  }

  // 3) Parsing du body JSON
  let parsedBody: unknown;
  try {
    parsedBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (err) {
    return res.status(400).json({
      error: 'invalid_json',
      message: 'Request body must be valid JSON',
    });
  }

  // 4) Validation avec Zod
  const result = bodySchema.safeParse(parsedBody);
  if (!result.success) {
    return res.status(400).json({
      error: 'validation_error',
      message: 'Payload validation failed',
      details: result.error.flatten(),
    });
  }

  const observations: ObservationPayload[] = Array.isArray(result.data)
    ? result.data
    : [result.data];

  // 5) Mapping vers les colonnes SQL (V3)
  // MIGRATION V3: On écrit UNIQUEMENT dans la nouvelle structure relationnelle
  
  const insertedIds: number[] = [];

  try {
    // Pour chaque observation, on appelle la fonction RPC d'ingestion intelligente
    const newObservationsPromises = observations.map(async (obs) => {
      const { data: obsId, error: rpcError } = await supabase!.rpc('ingest_observation', {
        p_item_name: obs.item_name,
        p_ankama_id: obs.ankama_id || null,
        p_server: obs.server,
        p_price_unit_avg: obs.price_unit_avg,
        p_nb_lots: obs.nb_lots,
        p_captured_at: obs.captured_at,
        p_source_client: obs.source_client,
        p_category: obs.category || null
      });

      if (rpcError) {
        console.error('Ingest RPC Error for item ' + obs.item_name, rpcError);
        return null;
      }

      return obsId; // Peut être null si doublon ignoré
    });

    const newObservationsResults = await Promise.all(newObservationsPromises);
    
    // On filtre les nulls (erreurs ou doublons ignorés)
    const validIds = newObservationsResults.filter((id): id is number => id !== null);
    insertedIds.push(...validIds);

  } catch (exception) {
    console.error('Ingest Exception:', exception);
    return res.status(500).json({
      error: 'internal_server_error',
      message: 'Unexpected error during ingestion',
    });
  }

  // 6) Check for missing images
  const missingImages: number[] = [];
  const gidsToCheck = observations
    .map(o => o.ankama_id)
    .filter((id): id is number => !!id);
  
  if (gidsToCheck.length > 0) {
    const uniqueGids = [...new Set(gidsToCheck)];
    const { data: itemsWithoutImages } = await supabase!
      .from('items')
      .select('ankama_id')
      .in('ankama_id', uniqueGids)
      .is('icon_url', null);
      
    if (itemsWithoutImages) {
      missingImages.push(...itemsWithoutImages.map(i => i.ankama_id));
    }
  }

  // 7) Réponse OK
  return res.status(201).json({
    status: 'ok',
    inserted: insertedIds.length,
    ids: insertedIds,
    missing_images: missingImages
  });
}
