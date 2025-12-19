import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { setCors } from '../cors';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ingestApiToken = process.env.INGEST_API_TOKEN;

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

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

export const handleTimeseries = async (req: VercelRequest, res: VercelResponse) => {
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
    // On récupère directement les observations brutes pour avoir tous les points (intraday)
    // MIGRATION V3: On passe par la table observations et on joint items
    const { data, error } = await supabase
      .from('observations')
      .select('id, captured_at, price_unit_avg, items!inner(name)')
      .eq('items.name', item)
      .eq('server', server)
      .gte('captured_at', fromIso)
      .lte('captured_at', toIso)
      .order('captured_at', { ascending: true });

    if (error) {
      console.error('Supabase error in /api/timeseries:', error);
      return res.status(500).json({
        error: 'supabase_error',
        message: 'Failed to fetch timeseries',
        details: error.message,
      });
    }

    console.log('[timeseries] result:', {
      count: data?.length ?? 0,
      firstRow: data?.[0],
    });

    const payload = (data || []).map((row: any) => ({
      id: row.id,
      date: row.captured_at,
      avg_price: row.price_unit_avg,
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
