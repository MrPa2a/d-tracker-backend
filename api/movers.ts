// api/movers.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ingestApiToken = process.env.INGEST_API_TOKEN;

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

const allowedOrigins =
  process.env.NODE_ENV === 'production'
    ? ['https://dofus-tracker-web.vercel.app']
    : ['http://localhost:5173', 'http://localhost:3000'];

function setCors(req: VercelRequest, res: VercelResponse) {
  const origin = req.headers.origin as string | undefined;

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type,Authorization'
  );
}

function decodeQueryValue(value: string | string[] | undefined): string | null {
  if (!value) return null;
  const v = Array.isArray(value) ? value[0] : value;
  try {
    return decodeURIComponent(v.replace(/\+/g, ' '));
  } catch {
    return v.replace(/\+/g, ' ');
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res
      .status(405)
      .json({ error: 'method_not_allowed', message: 'Only GET is allowed' });
  }

  // Auth
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

  const server = decodeQueryValue(req.query.server);
  const fromStr = decodeQueryValue(req.query.from);
  const toStr = decodeQueryValue(req.query.to);
  const limitStr = decodeQueryValue(req.query.limit) ?? '10';

  if (!server) {
    return res.status(400).json({
      error: 'missing_params',
      message: 'Query param "server" is required',
    });
  }

  const now = new Date();
  const rawTo = toStr ? new Date(toStr) : new Date(now);
  const rawFrom = fromStr
    ? new Date(fromStr)
    : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  if (isNaN(rawFrom.getTime()) || isNaN(rawTo.getTime())) {
    return res.status(400).json({
      error: 'invalid_date',
      message: 'Invalid "from" or "to" date, expected ISO 8601 strings',
    });
  }

  const fromDateUtc = new Date(Date.UTC(rawFrom.getUTCFullYear(), rawFrom.getUTCMonth(), rawFrom.getUTCDate(), 0, 0, 0, 0));
  const toDateUtc = new Date(Date.UTC(rawTo.getUTCFullYear(), rawTo.getUTCMonth(), rawTo.getUTCDate(), 23, 59, 59, 999));

  const fromIso = fromDateUtc.toISOString();
  const toIso = toDateUtc.toISOString();
  const limit = Math.max(1, Math.min(200, parseInt(limitStr, 10) || 10));

  console.log('[movers] incoming params:', { server, fromIso, toIso, limit });

  try {
    // We expect a Postgres RPC function named "movers" to exist in the DB.
    // It should accept p_server, p_from, p_to, p_limit and return rows with
    // item_name, server, last_price, pct_change (percent over period).
    const { data, error } = await supabase.rpc('movers', {
      p_server: server,
      p_from: fromIso,
      p_to: toIso,
      p_limit: limit,
    });

    if (error) {
      console.error('Supabase error in /api/movers rpc:', error);
      // If function is missing, return helpful guidance and 501
      if (String(error.message || '').toLowerCase().includes('function') || String(error.code || '').toLowerCase().includes('42883')) {
        return res.status(501).json({
          error: 'missing_rpc',
          message: 'Database function "movers" is missing. Check your RPC functions in the database.'
        });
      }

      return res.status(500).json({
        error: 'supabase_error',
        message: 'Failed to call movers rpc',
        details: error.message,
      });
    }

    return res.status(200).json(data || []);
  } catch (e: any) {
    console.error('Unexpected error in /api/movers:', e);
    return res.status(500).json({
      error: 'unexpected_error',
      message: 'Unexpected error in /api/movers',
      details: e?.message ?? String(e),
    });
  }
}
