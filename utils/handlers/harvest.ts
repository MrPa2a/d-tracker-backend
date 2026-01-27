import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { setCors } from '../cors';

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

function parseNumberArray(value: string | string[] | undefined): number[] | null {
  if (!value) return null;
  const values = Array.isArray(value) ? value : [value];
  const numbers = values
    .flatMap(v => v.split(','))
    .map(v => Number(v))
    .filter(v => Number.isFinite(v));
  return numbers.length ? numbers : null;
}

function parseNumber(value: string | string[] | undefined): number | null {
  const raw = decodeQueryValue(value);
  if (!raw) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

async function handleJobs(req: VercelRequest, res: VercelResponse) {
  const { data, error } = await supabase
    .from('harvest_jobs')
    .select('id, name_fr, name_en, icon_id')
    .order('id', { ascending: true });

  if (error) return res.status(500).json({ error: 'db_error' });
  return res.status(200).json(data ?? []);
}

async function handleResources(req: VercelRequest, res: VercelResponse) {
  const jobIds = parseNumberArray(req.query.jobIds);
  const levelMin = parseNumber(req.query.levelMin);
  const levelMax = parseNumber(req.query.levelMax);

  let query = supabase
    .from('harvest_resources')
    .select('id, job_id, name_fr, name_en, level_min, icon_url');

  if (jobIds) {
    query = query.in('job_id', jobIds);
  }
  if (levelMin !== null) {
    query = query.gte('level_min', levelMin);
  }
  if (levelMax !== null) {
    query = query.lte('level_min', levelMax);
  }

  const { data, error } = await query.order('level_min', { ascending: true });

  if (error) return res.status(500).json({ error: 'db_error' });
  return res.status(200).json(data ?? []);
}

async function handleSubareas(req: VercelRequest, res: VercelResponse) {
  const resourceIds = parseNumberArray(req.query.resourceIds);
  if (!resourceIds) {
    return res.status(400).json({ error: 'resource_ids_required' });
  }

  // Get subareas that have these resources via map_resources -> map_positions -> subareas
  const { data: mapResources, error: mrError } = await supabase
    .from('map_resources')
    .select('resource_id, quantity, map_positions!inner(subarea_id)')
    .in('resource_id', resourceIds);

  if (mrError) return res.status(500).json({ error: 'db_error', details: mrError.message });

  // Aggregate by subarea_id and resource_id
  const subareaResourceMap = new Map<string, { resource_id: number; subarea_id: number; count: number }>();
  for (const mr of mapResources || []) {
    const subareaId = (mr.map_positions as any).subarea_id;
    const key = `${mr.resource_id}-${subareaId}`;
    if (subareaResourceMap.has(key)) {
      subareaResourceMap.get(key)!.count += mr.quantity;
    } else {
      subareaResourceMap.set(key, {
        resource_id: mr.resource_id,
        subarea_id: subareaId,
        count: mr.quantity,
      });
    }
  }

  // Get subarea details
  const subareaIds = [...new Set(Array.from(subareaResourceMap.values()).map(v => v.subarea_id))];
  if (subareaIds.length === 0) {
    return res.status(200).json([]);
  }

  const { data: subareas, error: subError } = await supabase
    .from('subareas')
    .select('id, name_fr, name_en, area_id')
    .in('id', subareaIds);

  if (subError) return res.status(500).json({ error: 'db_error', details: subError.message });

  const subareaMap = new Map(subareas?.map(s => [s.id, s]) || []);

  // Build response
  const result = Array.from(subareaResourceMap.values()).map(item => ({
    resource_id: item.resource_id,
    subarea_id: item.subarea_id,
    count: item.count,
    subareas: subareaMap.get(item.subarea_id) || null,
  }));

  return res.status(200).json(result);
}

async function handleMapPositions(req: VercelRequest, res: VercelResponse) {
  const subareaIds = parseNumberArray(req.query.subareaIds);

  let query = supabase
    .from('map_positions')
    .select('map_id, pos_x, pos_y, subarea_id');

  if (subareaIds) {
    query = query.in('subarea_id', subareaIds);
  }

  const { data, error } = await query;

  if (error) return res.status(500).json({ error: 'db_error' });
  return res.status(200).json(data ?? []);
}

/**
 * Get a grid of maps for the route map visualization.
 * Returns all map positions within a bounding box.
 */
async function handleMapsGrid(req: VercelRequest, res: VercelResponse) {
  const minX = parseNumber(req.query.minX);
  const maxX = parseNumber(req.query.maxX);
  const minY = parseNumber(req.query.minY);
  const maxY = parseNumber(req.query.maxY);
  const worldMap = parseNumber(req.query.worldMap) ?? 1;

  if (minX === null || maxX === null || minY === null || maxY === null) {
    return res.status(400).json({ error: 'bounds_required', message: 'minX, maxX, minY, maxY are required' });
  }

  // Limit grid size to prevent abuse (max 50x50 = 2500 cells)
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  if (width > 50 || height > 50) {
    return res.status(400).json({ error: 'grid_too_large', message: 'Grid cannot exceed 50x50' });
  }

  // Query maps within bounds
  // Use DISTINCT ON equivalent by selecting and deduping in JS
  const { data, error } = await supabase
    .from('map_positions')
    .select('map_id, pos_x, pos_y, subarea_id')
    .gte('pos_x', minX)
    .lte('pos_x', maxX)
    .gte('pos_y', minY)
    .lte('pos_y', maxY)
    .eq('world_map', worldMap);

  if (error) return res.status(500).json({ error: 'db_error', details: error.message });

  // Deduplicate by coordinates (keep first map_id for each position)
  const positionMap = new Map<string, { map_id: number; pos_x: number; pos_y: number; subarea_id: number }>();
  for (const row of data || []) {
    const key = `${row.pos_x},${row.pos_y}`;
    if (!positionMap.has(key)) {
      positionMap.set(key, row);
    }
  }

  const maps = Array.from(positionMap.values());

  return res.status(200).json({
    bounds: { minX, maxX, minY, maxY },
    total: maps.length,
    maps,
  });
}

// ============================================================================
// Route Optimization (TSP - Nearest Neighbor Algorithm)
// ============================================================================

interface OptimizeRequest {
  resourceIds: number[];
  startX?: number;
  startY?: number;
  maxMoves?: number;  // Budget total de déplacements (maps traversées)
  maxMaps?: number;   // Deprecated: kept for backwards compatibility
  excludeSubareaIds?: number[];
}

interface MapNode {
  map_id: number;
  pos_x: number;
  pos_y: number;
  subarea_id: number;
  subarea_name: string;
  resources: { id: number; name: string; icon_url: string | null; count: number }[];
}

interface RouteStep {
  order: number;
  map_id: number;
  pos_x: number;
  pos_y: number;
  subarea_id: number;
  subarea_name: string;
  resources: { id: number; name: string; icon_url: string | null; count: number }[];
  distance_from_prev: number;
}

function manhattanDistance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.abs(x2 - x1) + Math.abs(y2 - y1);
}

/**
 * Nearest Neighbor TSP algorithm with move budget
 * 
 * @param nodes - Maps with resources to visit
 * @param startX - Starting X coordinate
 * @param startY - Starting Y coordinate  
 * @param maxMoves - Maximum number of map transitions (moves between maps)
 * 
 * The algorithm stops when the next move would exceed the budget.
 * Move cost = Manhattan distance to the next node.
 * If we're already on a node (distance 0), it costs 0 moves.
 */
function optimizeRoute(
  nodes: MapNode[],
  startX: number,
  startY: number,
  maxMoves: number
): RouteStep[] {
  if (nodes.length === 0) return [];

  const route: RouteStep[] = [];
  const visited = new Set<number>();
  let currentX = startX;
  let currentY = startY;
  let totalMoves = 0;

  while (visited.size < nodes.length) {
    let nearestNode: MapNode | null = null;
    let nearestDistance = Infinity;
    let nearestIndex = -1;

    // Find nearest unvisited node
    for (let i = 0; i < nodes.length; i++) {
      if (visited.has(i)) continue;
      const node = nodes[i];
      const dist = manhattanDistance(currentX, currentY, node.pos_x, node.pos_y);
      if (dist < nearestDistance) {
        nearestDistance = dist;
        nearestNode = node;
        nearestIndex = i;
      }
    }

    if (!nearestNode) break;

    // Move cost = actual distance (0 if we're already there)
    const moveCost = nearestDistance;
    
    // Check if this move would exceed budget
    if (totalMoves + moveCost > maxMoves) break;

    visited.add(nearestIndex);
    totalMoves += moveCost;
    
    route.push({
      order: route.length + 1,
      map_id: nearestNode.map_id,
      pos_x: nearestNode.pos_x,
      pos_y: nearestNode.pos_y,
      subarea_id: nearestNode.subarea_id,
      subarea_name: nearestNode.subarea_name,
      resources: nearestNode.resources,
      distance_from_prev: nearestDistance,
    });

    currentX = nearestNode.pos_x;
    currentY = nearestNode.pos_y;
  }

  return route;
}

async function handleOptimize(req: VercelRequest, res: VercelResponse) {
  // Parse body
  let body: OptimizeRequest;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'invalid_json' });
  }

  // maxMoves = budget de déplacements (maps traversées, incluant maps vides)
  // maxMaps est gardé pour compatibilité mais converti en maxMoves
  const { resourceIds, startX = 0, startY = 0, maxMoves, maxMaps = 50, excludeSubareaIds = [] } = body;
  const moveBudget = maxMoves ?? maxMaps; // Priorité à maxMoves si fourni

  if (!resourceIds || !Array.isArray(resourceIds) || resourceIds.length === 0) {
    return res.status(400).json({ error: 'resource_ids_required' });
  }

  // 1. Get maps that have these resources (using new map_resources table)
  // This gives us REAL per-map quantities from /recoltables2
  const { data: mapResourcesData, error: mrError } = await supabase
    .from('map_resources')
    .select('map_id, resource_id, quantity')
    .in('resource_id', resourceIds);

  if (mrError) return res.status(500).json({ error: 'db_error', details: mrError.message });
  if (!mapResourcesData || mapResourcesData.length === 0) {
    return res.status(200).json({ route: [], total_distance: 0 });
  }

  // 2. Get the map IDs that have resources
  const mapIds = [...new Set(mapResourcesData.map(mr => mr.map_id))];

  // 3. Get map positions for these maps
  const { data: allMaps, error: mapError } = await supabase
    .from('map_positions')
    .select('map_id, pos_x, pos_y, subarea_id')
    .in('map_id', mapIds);

  if (mapError) return res.status(500).json({ error: 'db_error', details: mapError.message });
  if (!allMaps || allMaps.length === 0) {
    return res.status(200).json({ route: [], total_distance: 0 });
  }

  // 4. Filter by excluded subareas
  const filteredMaps = excludeSubareaIds.length > 0
    ? allMaps.filter(m => !excludeSubareaIds.includes(m.subarea_id))
    : allMaps;

  if (filteredMaps.length === 0) {
    return res.status(200).json({ route: [], total_distance: 0 });
  }

  // 5. Get subarea IDs and their info
  const subareaIds = [...new Set(filteredMaps.map(m => m.subarea_id))];
  
  const { data: subareas, error: subError } = await supabase
    .from('subareas')
    .select('id, name_fr')
    .in('id', subareaIds);

  if (subError) return res.status(500).json({ error: 'db_error', details: subError.message });

  const subareaMap = new Map(subareas?.map(s => [s.id, s.name_fr]) || []);

  // 6. Get resource names and icons
  const { data: resources, error: resError } = await supabase
    .from('harvest_resources')
    .select('id, name_fr, icon_url')
    .in('id', resourceIds);

  if (resError) return res.status(500).json({ error: 'db_error', details: resError.message });

  const resourceInfoMap = new Map(resources?.map(r => [r.id, { name: r.name_fr, icon_url: r.icon_url }]) || []);

  // 7. Build resources per map (from map_resources table - REAL per-map quantities!)
  const resourcesByMapId = new Map<number, { id: number; name: string; icon_url: string | null; count: number }[]>();
  for (const mr of mapResourcesData) {
    if (!resourcesByMapId.has(mr.map_id)) {
      resourcesByMapId.set(mr.map_id, []);
    }
    const info = resourceInfoMap.get(mr.resource_id);
    resourcesByMapId.get(mr.map_id)!.push({
      id: mr.resource_id,
      name: info?.name || `Resource ${mr.resource_id}`,
      icon_url: info?.icon_url || null,
      count: mr.quantity,
    });
  }

  // 8. Deduplicate maps by coordinates - keep one map per unique (x,y) position
  // Multiple maps at the same position are different "layers" (instances, variations)
  // For route optimization, we only care about unique positions
  // When merging, combine resources from all maps at same position
  const positionMap = new Map<string, { map: typeof filteredMaps[0]; resources: Map<number, { id: number; name: string; icon_url: string | null; count: number }> }>();
  for (const m of filteredMaps) {
    const key = `${m.pos_x},${m.pos_y}`;
    const mapResources = resourcesByMapId.get(m.map_id) || [];
    
    if (!positionMap.has(key)) {
      const resMap = new Map<number, { id: number; name: string; icon_url: string | null; count: number }>();
      for (const r of mapResources) {
        resMap.set(r.id, { ...r });
      }
      positionMap.set(key, { map: m, resources: resMap });
    } else {
      // Merge resources from overlapping maps at same position
      const existing = positionMap.get(key)!;
      for (const r of mapResources) {
        if (existing.resources.has(r.id)) {
          existing.resources.get(r.id)!.count += r.count;
        } else {
          existing.resources.set(r.id, { ...r });
        }
      }
    }
  }
  
  const nodes: MapNode[] = Array.from(positionMap.values()).map(({ map, resources }) => ({
    map_id: map.map_id,
    pos_x: map.pos_x,
    pos_y: map.pos_y,
    subarea_id: map.subarea_id,
    subarea_name: subareaMap.get(map.subarea_id) || `Subarea ${map.subarea_id}`,
    resources: Array.from(resources.values()),
  }));

  // 9. Optimize route using Nearest Neighbor with move budget
  const route = optimizeRoute(nodes, startX, startY, moveBudget);

  // 10. Calculate total distance (= total moves including empty map traversals)
  const totalDistance = route.reduce((sum, step) => sum + step.distance_from_prev, 0);

  return res.status(200).json({
    route,
    total_distance: totalDistance,
    total_moves: totalDistance,  // Alias for clarity
    total_maps: route.length,    // Maps with resources visited
    available_maps: nodes.length,
    move_budget: moveBudget,
  });
}

// ============================================================================
// User Routes CRUD
// ============================================================================

interface RouteBody {
  name: string;
  description?: string;
  target_job_ids: number[];
  target_resource_ids: number[];
  route_data: RouteStep[];
  is_public?: boolean;
}

/**
 * Get user ID from Supabase JWT token
 */
async function getUserFromToken(req: VercelRequest): Promise<string | null> {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  
  const token = authHeader.slice('Bearer '.length).trim();
  
  // Create a client with the user's token to verify it
  const userSupabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
  
  const { data: { user }, error } = await userSupabase.auth.getUser(token);
  
  if (error || !user) {
    return null;
  }
  
  return user.id;
}

async function handleRoutes(req: VercelRequest, res: VercelResponse) {
  const method = req.method;
  const routeId = decodeQueryValue(req.query.routeId);
  
  // GET public routes doesn't require auth
  if (method === 'GET' && decodeQueryValue(req.query.public) === 'true') {
    return handleGetPublicRoutes(req, res);
  }
  
  // All other operations require auth
  const userId = await getUserFromToken(req);
  if (!userId) {
    return res.status(401).json({ error: 'unauthorized', message: 'Invalid or missing auth token' });
  }
  
  switch (method) {
    case 'GET':
      return handleGetUserRoutes(req, res, userId);
    case 'POST':
      return handleCreateRoute(req, res, userId);
    case 'PUT':
      if (!routeId) {
        return res.status(400).json({ error: 'route_id_required' });
      }
      return handleUpdateRoute(req, res, userId, routeId);
    case 'DELETE':
      if (!routeId) {
        return res.status(400).json({ error: 'route_id_required' });
      }
      return handleDeleteRoute(req, res, userId, routeId);
    default:
      res.setHeader('Allow', 'GET, POST, PUT, DELETE');
      return res.status(405).json({ error: 'method_not_allowed' });
  }
}

async function handleGetPublicRoutes(req: VercelRequest, res: VercelResponse) {
  const jobIds = parseNumberArray(req.query.jobIds);
  
  let query = supabase
    .from('harvest_routes')
    .select('id, name, description, target_job_ids, target_resource_ids, route_data, created_at, user_id')
    .eq('is_public', true)
    .order('created_at', { ascending: false })
    .limit(50);
  
  if (jobIds) {
    query = query.overlaps('target_job_ids', jobIds);
  }
  
  const { data, error } = await query;
  
  if (error) return res.status(500).json({ error: 'db_error', details: error.message });
  return res.status(200).json(data ?? []);
}

async function handleGetUserRoutes(req: VercelRequest, res: VercelResponse, userId: string) {
  const { data, error } = await supabase
    .from('harvest_routes')
    .select('id, name, description, target_job_ids, target_resource_ids, route_data, is_public, created_at, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });
  
  if (error) return res.status(500).json({ error: 'db_error', details: error.message });
  return res.status(200).json(data ?? []);
}

async function handleCreateRoute(req: VercelRequest, res: VercelResponse, userId: string) {
  let body: RouteBody;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'invalid_json' });
  }
  
  const { name, description, target_job_ids, target_resource_ids, route_data, is_public = false } = body;
  
  if (!name || !target_job_ids || !target_resource_ids || !route_data) {
    return res.status(400).json({ 
      error: 'missing_fields', 
      message: 'name, target_job_ids, target_resource_ids, and route_data are required' 
    });
  }
  
  const { data, error } = await supabase
    .from('harvest_routes')
    .insert({
      user_id: userId,
      name,
      description: description || null,
      target_job_ids,
      target_resource_ids,
      route_data,
      is_public,
    })
    .select()
    .single();
  
  if (error) return res.status(500).json({ error: 'db_error', details: error.message });
  return res.status(201).json(data);
}

async function handleUpdateRoute(
  req: VercelRequest, 
  res: VercelResponse, 
  userId: string, 
  routeId: string
) {
  let body: Partial<RouteBody>;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'invalid_json' });
  }
  
  // Build update object with only provided fields
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;
  if (body.target_job_ids !== undefined) updates.target_job_ids = body.target_job_ids;
  if (body.target_resource_ids !== undefined) updates.target_resource_ids = body.target_resource_ids;
  if (body.route_data !== undefined) updates.route_data = body.route_data;
  if (body.is_public !== undefined) updates.is_public = body.is_public;
  
  const { data, error } = await supabase
    .from('harvest_routes')
    .update(updates)
    .eq('id', routeId)
    .eq('user_id', userId) // Security: only update own routes
    .select()
    .single();
  
  if (error) {
    if (error.code === 'PGRST116') {
      return res.status(404).json({ error: 'not_found', message: 'Route not found or not owned by you' });
    }
    return res.status(500).json({ error: 'db_error', details: error.message });
  }
  
  return res.status(200).json(data);
}

async function handleDeleteRoute(
  req: VercelRequest, 
  res: VercelResponse, 
  userId: string, 
  routeId: string
) {
  const { error, count } = await supabase
    .from('harvest_routes')
    .delete()
    .eq('id', routeId)
    .eq('user_id', userId); // Security: only delete own routes
  
  if (error) return res.status(500).json({ error: 'db_error', details: error.message });
  
  if (count === 0) {
    return res.status(404).json({ error: 'not_found', message: 'Route not found or not owned by you' });
  }
  
  return res.status(204).end();
}

export async function handleHarvest(req: VercelRequest, res: VercelResponse) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const mode = decodeQueryValue(req.query.mode) || 'jobs';

  // Routes mode - CRUD operations
  if (mode === 'routes') {
    return handleRoutes(req, res);
  }

  // POST only for optimize
  if (mode === 'optimize') {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'method_not_allowed' });
    }
    return handleOptimize(req, res);
  }

  // GET for all other modes
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  switch (mode) {
    case 'jobs':
      return handleJobs(req, res);
    case 'resources':
      return handleResources(req, res);
    case 'subareas':
      return handleSubareas(req, res);
    case 'map_positions':
      return handleMapPositions(req, res);
    case 'maps_grid':
      return handleMapsGrid(req, res);
    default:
      return res.status(400).json({ error: 'invalid_mode' });
  }
}
