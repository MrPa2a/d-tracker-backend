/**
 * Script d'ingestion des données de récolte depuis DofusDB (V2)
 * 
 * Utilise l'endpoint /recoltables2 pour avoir les ressources PAR MAP (pas par zone)
 * 
 * Synchronise vers Supabase :
 *   - harvest_jobs : Métiers de récolte
 *   - harvest_resources : Ressources récoltables
 *   - subareas : Zones du jeu
 *   - map_positions : Positions des maps avec ressources
 *   - map_resources : Quantités exactes par map/ressource (NOUVELLE TABLE)
 * 
 * Usage: npx ts-node scripts/ingest_harvest_data_v2.ts [--dry-run]
 * 
 * Prérequis:
 *   Variables d'environnement: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

// Load env vars
const envPath = path.resolve(__dirname, '../.env.local');
console.log('📂 Loading env from:', envPath);
dotenv.config({ path: envPath });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

const DOFUSDB_API = 'https://api.dofusdb.fr';
const RATE_LIMIT_DELAY = 150; // ms between API calls

// Métiers de récolte (IDs DofusDB)
const HARVEST_JOBS: Record<number, { name_fr: string; name_en: string }> = {
  2: { name_fr: 'Bûcheron', name_en: 'Lumberjack' },
  24: { name_fr: 'Mineur', name_en: 'Miner' },
  26: { name_fr: 'Alchimiste', name_en: 'Alchemist' },
  28: { name_fr: 'Paysan', name_en: 'Farmer' },
  36: { name_fr: 'Pêcheur', name_en: 'Fisherman' },
};
const HARVEST_JOB_IDS = Object.keys(HARVEST_JOBS).map(Number);

// Parse CLI args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

// ============================================================================
// API Helpers
// ============================================================================

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchDofusDB<T>(endpoint: string): Promise<T> {
  const url = `${DOFUSDB_API}${endpoint}`;
  console.log(`  📡 GET ${url}`);
  
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`DofusDB API error: ${response.status} ${response.statusText}`);
  }
  
  await sleep(RATE_LIMIT_DELAY);
  return response.json() as Promise<T>;
}

// ============================================================================
// Types
// ============================================================================

interface DofusDBJob {
  id: number;
  iconId: number;
  name: { fr: string; en?: string };
}

interface DofusDBSkill {
  id: number;
  parentJobId: number;
  gatheredRessourceItem: number;
  levelMin: number;
  name: { fr: string };
  item?: {
    id: number;
    name: { fr: string; en?: string };
    img?: string;
  };
}

interface DofusDBSubarea {
  id: number;
  areaId: number;
  name: { fr: string; en?: string };
}

interface RecoltableMap {
  id: number; // mapId
  resources: number[]; // resourceIds present on this map
  details: Record<string, number>; // { "resourceId": quantity }
  pos: {
    posX: number;
    posY: number;
    subAreaId: number;
    worldMap: number;
    outdoor?: boolean;
  };
}

interface RecoltablesResponse {
  total: number;
  limit: number;
  skip: number;
  data: RecoltableMap[];
}

// ============================================================================
// Ingestion Steps
// ============================================================================

async function ingestJobs(): Promise<void> {
  console.log('\n🔧 Step 1: Ingesting harvest jobs...');
  
  const response = await fetchDofusDB<{ data: DofusDBJob[] }>('/jobs');
  const jobIconIds: Record<number, number> = {};
  for (const job of response.data) {
    jobIconIds[job.id] = job.iconId;
  }
  
  console.log(`  Upserting ${HARVEST_JOB_IDS.length} harvest jobs`);
  
  for (const jobId of HARVEST_JOB_IDS) {
    const jobInfo = HARVEST_JOBS[jobId];
    
    if (DRY_RUN) {
      console.log(`    - ${jobId}: ${jobInfo.name_fr}`);
      continue;
    }
    
    const { error } = await supabase
      .from('harvest_jobs')
      .upsert({
        id: jobId,
        name_fr: jobInfo.name_fr,
        name_en: jobInfo.name_en,
        icon_id: jobIconIds[jobId] || null,
      }, { onConflict: 'id' });
    
    if (error) {
      console.error(`    ❌ Error upserting job ${jobId}:`, error.message);
    } else {
      console.log(`    ✅ ${jobInfo.name_fr}`);
    }
  }
}

interface ResourceInfo {
  id: number;
  jobId: number;
  skillId: number;
  nameFr: string;
  nameEn: string | null;
  levelMin: number;
  iconUrl: string | null;
}

async function ingestResources(): Promise<Map<number, ResourceInfo>> {
  console.log('\n🌿 Step 2: Ingesting resources (from skills)...');
  
  const resourceMap = new Map<number, ResourceInfo>();
  
  for (const jobId of HARVEST_JOB_IDS) {
    const response = await fetchDofusDB<{ data: DofusDBSkill[]; total: number }>(
      `/skills?parentJobId=${jobId}&$limit=100`
    );
    
    const gatheringSkills = response.data.filter(s => s.gatheredRessourceItem > 0);
    console.log(`  📦 ${HARVEST_JOBS[jobId].name_fr}: ${gatheringSkills.length} gathering skills`);
    
    for (const skill of gatheringSkills) {
      const item = skill.item;
      if (!item || !item.id) continue;
      
      resourceMap.set(item.id, {
        id: item.id,
        jobId: skill.parentJobId,
        skillId: skill.id,
        nameFr: item.name.fr,
        nameEn: item.name.en || null,
        levelMin: skill.levelMin,
        iconUrl: item.img || null,
      });
      
      if (!DRY_RUN) {
        const { error } = await supabase
          .from('harvest_resources')
          .upsert({
            id: item.id,
            job_id: skill.parentJobId,
            skill_id: skill.id,
            name_fr: item.name.fr,
            name_en: item.name.en || null,
            level_min: skill.levelMin,
            icon_url: item.img || null,
          }, { onConflict: 'id' });
        
        if (error) {
          console.error(`    ❌ Error upserting resource ${item.id}:`, error.message);
        }
      }
      
      console.log(`    ✅ ${item.name.fr} (Lv.${skill.levelMin})`);
    }
  }
  
  console.log(`  Total resources: ${resourceMap.size}`);
  return resourceMap;
}

async function ingestRecoltables(resourceMap: Map<number, ResourceInfo>): Promise<{
  subareaIds: Set<number>;
  mapResourceData: Array<{ mapId: number; resourceId: number; quantity: number }>;
  mapPositionData: Map<number, { posX: number; posY: number; subareaId: number }>;
}> {
  console.log('\n🗺️ Step 3: Ingesting recoltables (maps with resources)...');
  
  const subareaIds = new Set<number>();
  const mapResourceData: Array<{ mapId: number; resourceId: number; quantity: number }> = [];
  const mapPositionData = new Map<number, { posX: number; posY: number; subareaId: number }>();
  
  // IMPORTANT: L'API DofusDB ne retourne pas toutes les maps si on ne filtre pas par ressource !
  // On doit donc itérer sur chaque ressource et récupérer ses maps via:
  // /recoltables2?resources[$in][]=<resourceId>&$skip=X&$limit=50
  
  const resourceIds = Array.from(resourceMap.keys());
  console.log(`  Processing ${resourceIds.length} resources...`);
  
  const BATCH_SIZE = 50;
  let totalMapsProcessed = 0;
  
  for (const resourceId of resourceIds) {
    const resourceInfo = resourceMap.get(resourceId)!;
    let skip = 0;
    let total = 0;
    let resourceMaps = 0;
    
    do {
      const response = await fetchDofusDB<RecoltablesResponse>(
        `/recoltables2?resources[$in][]=${resourceId}&$skip=${skip}&$limit=${BATCH_SIZE}&lang=fr`
      );
      
      if (skip === 0) {
        total = response.total;
      }
      
      for (const map of response.data) {
        // V1: Only Monde des Douze (worldMap = 1)
        if (map.pos.worldMap !== 1) continue;
        
        // Store position (may already exist from another resource)
        if (!mapPositionData.has(map.id)) {
          mapPositionData.set(map.id, {
            posX: map.pos.posX,
            posY: map.pos.posY,
            subareaId: map.pos.subAreaId,
          });
          totalMapsProcessed++;
        }
        
        subareaIds.add(map.pos.subAreaId);
        
        // Get quantity for THIS resource from details
        const quantity = map.details[resourceId.toString()] || 1;
        
        mapResourceData.push({
          mapId: map.id,
          resourceId,
          quantity,
        });
        
        resourceMaps++;
      }
      
      skip += BATCH_SIZE;
      
    } while (skip < total);
    
    console.log(`    ✅ ${resourceInfo.nameFr}: ${resourceMaps} maps (total API: ${total})`);
  }
  
  console.log(`  ✅ Found ${totalMapsProcessed} unique maps with harvest resources`);
  console.log(`  ✅ Found ${mapResourceData.length} map-resource pairs`);
  console.log(`  ✅ Found ${subareaIds.size} unique subareas`);
  
  return { subareaIds, mapResourceData, mapPositionData };
}

async function ingestSubareas(subareaIds: Set<number>): Promise<void> {
  console.log('\n📍 Step 4: Ingesting subareas...');
  console.log(`  Processing ${subareaIds.size} subareas...`);
  
  let processed = 0;
  
  for (const subareaId of subareaIds) {
    try {
      const subarea = await fetchDofusDB<DofusDBSubarea>(`/subareas/${subareaId}`);
      
      if (!DRY_RUN) {
        const { error } = await supabase
          .from('subareas')
          .upsert({
            id: subarea.id,
            area_id: subarea.areaId,
            name_fr: subarea.name.fr,
            name_en: subarea.name.en || null,
          }, { onConflict: 'id' });
        
        if (error) {
          console.error(`    ❌ Error upserting subarea ${subareaId}:`, error.message);
        }
      }
      
      processed++;
      if (processed % 20 === 0) {
        console.log(`    Processed ${processed}/${subareaIds.size} subareas...`);
      }
    } catch (e: any) {
      console.error(`    ❌ Error fetching subarea ${subareaId}:`, e.message);
    }
  }
  
  console.log(`  ✅ Completed ${processed} subareas`);
}

async function saveMapPositions(
  mapPositionData: Map<number, { posX: number; posY: number; subareaId: number }>
): Promise<void> {
  console.log('\n📍 Step 5: Saving map positions...');
  
  if (DRY_RUN) {
    console.log(`  Would save ${mapPositionData.size} map positions`);
    return;
  }
  
  // Batch upsert in chunks
  const CHUNK_SIZE = 500;
  const allRecords = Array.from(mapPositionData.entries()).map(([mapId, pos]) => ({
    map_id: mapId,
    pos_x: pos.posX,
    pos_y: pos.posY,
    subarea_id: pos.subareaId,
  }));
  
  let processed = 0;
  for (let i = 0; i < allRecords.length; i += CHUNK_SIZE) {
    const chunk = allRecords.slice(i, i + CHUNK_SIZE);
    
    const { error } = await supabase
      .from('map_positions')
      .upsert(chunk, { onConflict: 'map_id' });
    
    if (error) {
      console.error(`    ❌ Error upserting map positions:`, error.message);
    }
    
    processed += chunk.length;
    console.log(`    Saved ${processed}/${allRecords.length} map positions...`);
  }
  
  console.log(`  ✅ Saved ${allRecords.length} map positions`);
}

async function saveMapResources(
  mapResourceData: Array<{ mapId: number; resourceId: number; quantity: number }>
): Promise<void> {
  console.log('\n🌾 Step 6: Saving map resources (per-map quantities)...');
  
  if (DRY_RUN) {
    console.log(`  Would save ${mapResourceData.length} map-resource pairs`);
    return;
  }
  
  // Note: Table already cleaned in Step 0
  
  // Batch insert in chunks
  const CHUNK_SIZE = 500;
  const allRecords = mapResourceData.map(mr => ({
    map_id: mr.mapId,
    resource_id: mr.resourceId,
    quantity: mr.quantity,
  }));
  
  let processed = 0;
  for (let i = 0; i < allRecords.length; i += CHUNK_SIZE) {
    const chunk = allRecords.slice(i, i + CHUNK_SIZE);
    
    const { error } = await supabase
      .from('map_resources')
      .insert(chunk);
    
    if (error) {
      console.error(`    ❌ Error inserting map resources:`, error.message);
    }
    
    processed += chunk.length;
    console.log(`    Saved ${processed}/${allRecords.length} map-resource pairs...`);
  }
  
  console.log(`  ✅ Saved ${allRecords.length} map-resource pairs`);
}

// ============================================================================
// Main
// ============================================================================

/**
 * Clean all existing harvest data before fresh ingestion
 */
async function cleanExistingData(): Promise<void> {
  console.log('\n🧹 Step 0: Cleaning existing harvest data...');
  
  if (DRY_RUN) {
    console.log('  Would clean: map_resources, map_positions, resource_distribution, subareas, harvest_resources, harvest_jobs');
    return;
  }
  
  // Order matters due to foreign key constraints!
  // Delete from child tables first, then parent tables
  
  const tables = [
    'map_resources',        // References map_positions and harvest_resources
    'resource_distribution', // References harvest_resources (obsolete but clean it)
    'map_positions',        // References subareas
    'subareas',             // References areas
    'harvest_resources',    // References harvest_jobs
    'harvest_jobs',         // No dependencies
  ];
  
  for (const table of tables) {
    const { error, count } = await supabase
      .from(table)
      .delete()
      .neq('id', -99999); // Delete all rows (workaround: delete where id != impossible value)
    
    if (error) {
      // Try alternative for tables with different PK
      const { error: error2 } = await supabase
        .from(table)
        .delete()
        .gte('id', 0)
        .or('id.lt.0');
      
      if (error2) {
        console.log(`    ⚠️  Could not clean ${table}: ${error.message}`);
      } else {
        console.log(`    ✅ Cleaned ${table}`);
      }
    } else {
      console.log(`    ✅ Cleaned ${table}`);
    }
  }
  
  console.log('  🧹 All tables cleaned');
}

async function main(): Promise<void> {
  console.log('🌾 Harvest Data Ingestion Script V2');
  console.log('===================================');
  console.log('Using /recoltables2 endpoint for accurate per-map data');
  
  if (DRY_RUN) {
    console.log('⚠️  DRY RUN MODE - No changes will be made');
  }
  
  const startTime = Date.now();
  
  try {
    // Step 0: Clean existing data (fresh start)
    await cleanExistingData();
    
    // Step 1: Jobs
    await ingestJobs();
    
    // Step 2: Resources (from skills)
    const resourceMap = await ingestResources();
    
    // Step 3: Recoltables (maps with resources) - main data source!
    const { subareaIds, mapResourceData, mapPositionData } = await ingestRecoltables(resourceMap);
    
    // Step 4: Subareas
    await ingestSubareas(subareaIds);
    
    // Step 5: Map Positions
    await saveMapPositions(mapPositionData);
    
    // Step 6: Map Resources (new!)
    await saveMapResources(mapResourceData);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✅ Ingestion completed in ${duration}s`);
    
    // Summary
    console.log('\n📊 Summary:');
    console.log(`  - ${HARVEST_JOB_IDS.length} harvest jobs`);
    console.log(`  - ${resourceMap.size} resources`);
    console.log(`  - ${subareaIds.size} subareas`);
    console.log(`  - ${mapPositionData.size} maps with positions`);
    console.log(`  - ${mapResourceData.length} map-resource pairs`);
    
  } catch (error: any) {
    console.error('\n❌ Ingestion failed:', error.message);
    process.exit(1);
  }
}

main();
