// api/ingest.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

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
  server: z.string().min(1).max(255),
  captured_at: z.string().datetime(), // ISO 8601
  price_unit_avg: z.number().nonnegative(),
  nb_lots: z.number().int().positive(),
  source_client: z.string().min(1).max(255),
  client_version: z.string().max(50).optional(),
  raw_item_name: z.string().max(255).optional(),
});

type ObservationPayload = z.infer<typeof observationSchema>;

const bodySchema = z.union([
  observationSchema,
  z.array(observationSchema).nonempty(),
]);

export default async function handler(req: VercelRequest, res: VercelResponse) {
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

  // 5) Mapping vers les colonnes SQL
  const rows = observations.map((obs) => ({
    item_name: obs.item_name,
    server: obs.server,
    captured_at: obs.captured_at,
    price_unit_avg: obs.price_unit_avg,
    nb_lots: obs.nb_lots,
    source_client: obs.source_client,
    client_version: obs.client_version ?? null,
    raw_item_name: obs.raw_item_name ?? null,
  }));

  // 6) Insertion dans Supabase
  const { error } = await supabase.from('market_observations').insert(rows);

  if (error) {
    console.error('Supabase insert error:', error);
    return res.status(500).json({
      error: 'db_insert_failed',
      message: 'Failed to insert observations',
    });
  }

  // 7) Réponse OK
  return res.status(201).json({
    status: 'ok',
    inserted: rows.length,
  });
}
