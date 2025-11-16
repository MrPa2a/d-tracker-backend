// api/timeseries.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ingestApiToken = process.env.INGEST_API_TOKEN;

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

const allowedOrigins =
  process.env.NODE_ENV === 'production'
    ? ['https://dofus-tracker-web.vercel.app/']
    : ['http://localhost:5173', 'http://localhost:3000', 'https://dofus-tracker-web.vercel.app/'];

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

// Petit helper pour décoder les + et %xx vers des espaces/UTF-8 corrects
function decodeQueryValue(value: string | string[] | undefined): string | null {
  if (!value) return null;
  const v = Array.isArray(value) ? value[0] : value;

  // On remplace d'abord les + par des espaces (style x-www-form-urlencoded),
  // puis on passe un decodeURIComponent au cas où il y ait des %20, %C3%A9, etc.
  try {
    return decodeURIComponent(v.replace(/\+/g, ' '));
  } catch {
    // au pire, on renvoie juste avec + => ' ' quand même
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

  // ─────────────────────────────────────
  // 1) Params + décodage + / %xx
  // ─────────────────────────────────────
  const item = decodeQueryValue(req.query.item);
  const server = decodeQueryValue(req.query.server);
  const fromStr = decodeQueryValue(req.query.from);
  const toStr = decodeQueryValue(req.query.to);

  if (!item || !server) {
    return res.status(400).json({
      error: 'missing_params',
      message: 'Query params "item" and "server" are required',
    });
  }

  // ─────────────────────────────────────
  // 2) Gestion des dates (début/fin de journée)
  // ─────────────────────────────────────
  const now = new Date();

  let rawTo = toStr ? new Date(toStr) : new Date(now);
  let rawFrom = fromStr
    ? new Date(fromStr)
    : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  if (isNaN(rawFrom.getTime()) || isNaN(rawTo.getTime())) {
    return res.status(400).json({
      error: 'invalid_date',
      message: 'Invalid "from" or "to" date, expected ISO 8601 strings',
    });
  }

  const fromDateUtc = new Date(
    Date.UTC(
      rawFrom.getUTCFullYear(),
      rawFrom.getUTCMonth(),
      rawFrom.getUTCDate(),
      0,
      0,
      0,
      0
    )
  );

  const toDateUtc = new Date(
    Date.UTC(
      rawTo.getUTCFullYear(),
      rawTo.getUTCMonth(),
      rawTo.getUTCDate(),
      23,
      59,
      59,
      999
    )
  );

  const fromIso = fromDateUtc.toISOString();
  const toIso = toDateUtc.toISOString();

  console.log('[timeseries] incoming params:', {
    item,
    server,
    fromStr,
    toStr,
    fromIso,
    toIso,
  });

  try {
    // DEBUG : vérifier qu'on voit bien quelque chose dans la table brute
    const debugRaw = await supabase
      .from('market_observations')
      .select('captured_at, price_unit_avg')
      .eq('item_name', item)
      .eq('server', server)
      .gte('captured_at', fromIso)
      .lte('captured_at', toIso)
      .order('captured_at', { ascending: true })
      .limit(5);

    console.log('[timeseries] raw observations check:', {
      error: debugRaw.error,
      count: debugRaw.data?.length ?? 0,
      firstRows: debugRaw.data,
    });

    const { data, error } = await supabase.rpc('timeseries_daily', {
      p_item_name: item,
      p_server: server,
      p_from: fromIso,
      p_to: toIso,
    });

    if (error) {
      console.error('Supabase error in /api/timeseries:', error);
      return res.status(500).json({
        error: 'supabase_error',
        message: 'Failed to fetch timeseries_daily',
        details: error.message,
      });
    }

    console.log('[timeseries] rpc result:', {
      count: data?.length ?? 0,
      firstRow: data?.[0],
    });

    const payload = (data || []).map((row: any) => ({
      date: row.day,
      avg_price: row.avg_price,
    }));

    return res.status(200).json(payload);
  } catch (e: any) {
    console.error('Unexpected error in /api/timeseries:', e);
    return res.status(500).json({
      error: 'unexpected_error',
      message: 'Unexpected error in /api/timeseries',
      details: e?.message ?? String(e),
    });
  }
}
