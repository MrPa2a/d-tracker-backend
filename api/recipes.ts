import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { setCors } from '../utils/cors';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

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
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const mode = decodeQueryValue(req.query.mode);

  // --- Mode: Jobs ---
  if (mode === 'jobs') {
    try {
      const { data, error } = await supabase
        .from('jobs')
        .select('*')
        .order('name');
      
      if (error) throw error;
      return res.status(200).json(data);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  const server = decodeQueryValue(req.query.server);
  if (!server) {
    return res.status(400).json({ error: 'missing_server' });
  }

  // Parse params
  const minLevel = parseInt(decodeQueryValue(req.query.min_level) || '0');
  const maxLevel = parseInt(decodeQueryValue(req.query.max_level) || '200');
  const jobId = req.query.job_id ? parseInt(decodeQueryValue(req.query.job_id)!) : null;
  const minRoi = req.query.min_roi ? parseFloat(decodeQueryValue(req.query.min_roi)!) : null;
  const limit = parseInt(decodeQueryValue(req.query.limit) || '50');
  const offset = parseInt(decodeQueryValue(req.query.offset) || '0');
  const sortBy = decodeQueryValue(req.query.sort_by) || 'margin_desc';
  const search = decodeQueryValue(req.query.search);
  const recipeId = req.query.id ? parseInt(decodeQueryValue(req.query.id)!) : null;
  const resultItemId = req.query.item_id ? parseInt(decodeQueryValue(req.query.item_id)!) : null;

  try {
    const { data, error } = await supabase.rpc('get_recipes_with_stats', {
      p_server: server,
      p_min_level: minLevel,
      p_max_level: maxLevel,
      p_job_id: jobId,
      p_min_roi: minRoi,
      p_limit: limit,
      p_offset: offset,
      p_sort_by: sortBy,
      p_name_search: search,
      p_recipe_id: recipeId,
      p_result_item_id: resultItemId
    });

    if (error) {
      console.error('Supabase RPC Error:', error);
      return res.status(500).json({ error: error.message });
    }

    // If fetching a specific recipe, also fetch ingredients
    if (recipeId && data && data.length > 0) {
      const recipe = data[0];
      const { data: ingredients, error: ingError } = await supabase.rpc('get_recipe_ingredients', {
        p_recipe_id: recipeId,
        p_server: server
      });

      if (ingError) {
        console.error('Ingredients RPC Error:', ingError);
        recipe.ingredients = [];
      } else {
        recipe.ingredients = ingredients;
      }
      
      return res.status(200).json(recipe);
    }

    return res.status(200).json(data);
  } catch (err: any) {
    console.error('Server Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
