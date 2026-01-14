/**
 * Script de synchronisation des items depuis DofusDB
 * 
 * Synchronise les données suivantes pour tous les items en base :
 *   - name: Nom français de l'item
 *   - level: Niveau de l'item
 *   - craft_xp_ratio: Ratio d'XP de craft (depuis l'item ou le type)
 * 
 * Usage: npx ts-node scripts/sync_items_from_dofusdb.ts [--dry-run] [--limit=N]
 * 
 * Options:
 *   --dry-run   Affiche les changements sans les appliquer
 *   --limit=N   Limite le nombre d'items à traiter (pour debug)
 *   --force     Force la mise à jour même si les données semblent identiques
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
const BATCH_SIZE = 50; // DofusDB limit
const UPDATE_BATCH_SIZE = 100; // Batch size for Supabase updates
const RATE_LIMIT_DELAY = 150; // ms between API calls

// Parse CLI args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE_UPDATE = args.includes('--force');
const limitArg = args.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1]) : null;

interface DofusDBItem {
  id: number;
  level: number;
  craftXpRatio?: number;
  name?: {
    fr: string;
    en?: string;
  };
  type?: {
    id: number;
    craftXpRatio?: number;
    name?: {
      fr: string;
    };
  };
}

interface DofusDBResponse {
  data: DofusDBItem[];
  total: number;
  skip: number;
  limit: number;
}

interface SupabaseItem {
  id: number;
  ankama_id: number;
  name: string;
  level: number | null;
  craft_xp_ratio: number | null;
}

interface ItemUpdate {
  id: number;
  ankama_id: number;
  old_name: string;
  new_name: string;
  old_level: number | null;
  new_level: number;
  old_craft_xp_ratio: number | null;
  new_craft_xp_ratio: number;
  changes: string[];
}

/**
 * Calcule le ratio d'XP final selon la logique DofusDB :
 * 1. craftXpRatio de l'item si > 0
 * 2. craftXpRatio du type si > 0
 * 3. -1 sinon (le code utilisera le fallback 100)
 */
function computeFinalRatio(item: DofusDBItem): number {
  const itemRatio = item.craftXpRatio;
  const typeRatio = item.type?.craftXpRatio;

  if (itemRatio !== undefined && itemRatio > 0) {
    return itemRatio;
  }
  if (typeRatio !== undefined && typeRatio > 0) {
    return typeRatio;
  }
  return -1;
}

/**
 * Fetch items from DofusDB API by batch
 */
async function fetchDofusDBItems(skip: number, limit: number): Promise<DofusDBResponse> {
  const url = `${DOFUSDB_API}/items?$limit=${limit}&$skip=${skip}`;
  
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'DofusTracker/1.0'
    }
  });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch items: ${response.status} ${response.statusText}`);
  }
  
  return await response.json() as DofusDBResponse;
}

/**
 * Fetch a single item from DofusDB by ID (for specific lookups)
 */
async function fetchDofusDBItemById(ankamaId: number): Promise<DofusDBItem | null> {
  const url = `${DOFUSDB_API}/items/${ankamaId}`;
  
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'DofusTracker/1.0'
    }
  });
  
  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error(`Failed to fetch item ${ankamaId}: ${response.status} ${response.statusText}`);
  }
  
  return await response.json() as DofusDBItem;
}

/**
 * Fetch all items from Supabase with their ankama_id
 */
async function fetchSupabaseItems(): Promise<SupabaseItem[]> {
  console.log('📥 Fetching items from Supabase...');
  
  const items: SupabaseItem[] = [];
  let from = 0;
  const PAGE_SIZE = 1000;
  
  while (true) {
    const { data, error } = await supabase
      .from('items')
      .select('id, ankama_id, name, level, craft_xp_ratio')
      .not('ankama_id', 'is', null)
      .range(from, from + PAGE_SIZE - 1);
    
    if (error) {
      console.error('❌ Failed to fetch Supabase items:', error);
      throw error;
    }
    
    if (!data || data.length === 0) break;
    
    items.push(...data);
    from += data.length;
    
    if (data.length < PAGE_SIZE) break;
  }
  
  console.log(`✅ Found ${items.length} items with ankama_id in Supabase\n`);
  return items;
}

/**
 * Build a map of DofusDB items indexed by ankama_id
 */
async function buildDofusDBItemsMap(): Promise<Map<number, DofusDBItem>> {
  console.log('📥 Fetching all items from DofusDB...');
  
  const itemsMap = new Map<number, DofusDBItem>();
  let skip = 0;
  let total = 0;
  
  while (true) {
    const data = await fetchDofusDBItems(skip, BATCH_SIZE);
    
    if (total === 0) {
      total = data.total;
      console.log(`   Total items on DofusDB: ${total}`);
    }
    
    if (data.data.length === 0) break;
    
    for (const item of data.data) {
      itemsMap.set(item.id, item);
    }
    
    skip += data.data.length;
    process.stdout.write(`\r   Fetched ${skip}/${total} items...`);
    
    // Rate limiting
    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY));
  }
  
  console.log(`\n✅ Fetched ${itemsMap.size} items from DofusDB\n`);
  return itemsMap;
}

/**
 * Compare and find items that need updates
 */
function findItemsToUpdate(
  supabaseItems: SupabaseItem[], 
  dofusDBMap: Map<number, DofusDBItem>
): ItemUpdate[] {
  console.log('🔍 Comparing items...');
  
  const updates: ItemUpdate[] = [];
  let notFound = 0;
  
  for (const sbItem of supabaseItems) {
    const dbItem = dofusDBMap.get(sbItem.ankama_id);
    
    if (!dbItem) {
      notFound++;
      continue;
    }
    
    const newName = dbItem.name?.fr || sbItem.name;
    const newLevel = dbItem.level ?? 1;
    const newCraftXpRatio = computeFinalRatio(dbItem);
    
    const changes: string[] = [];
    
    // Check name change
    if (newName !== sbItem.name) {
      changes.push(`name: "${sbItem.name}" → "${newName}"`);
    }
    
    // Check level change
    if (newLevel !== sbItem.level) {
      changes.push(`level: ${sbItem.level ?? 'null'} → ${newLevel}`);
    }
    
    // Check craft_xp_ratio change
    if (newCraftXpRatio !== sbItem.craft_xp_ratio) {
      changes.push(`craft_xp_ratio: ${sbItem.craft_xp_ratio ?? 'null'} → ${newCraftXpRatio}`);
    }
    
    if (changes.length > 0 || FORCE_UPDATE) {
      updates.push({
        id: sbItem.id,
        ankama_id: sbItem.ankama_id,
        old_name: sbItem.name,
        new_name: newName,
        old_level: sbItem.level,
        new_level: newLevel,
        old_craft_xp_ratio: sbItem.craft_xp_ratio,
        new_craft_xp_ratio: newCraftXpRatio,
        changes
      });
    }
  }
  
  console.log(`   Items to update: ${updates.length}`);
  console.log(`   Items not found in DofusDB: ${notFound}\n`);
  
  return updates;
}

/**
 * Apply updates to Supabase
 */
async function applyUpdates(updates: ItemUpdate[]): Promise<{ success: number; errors: number }> {
  if (DRY_RUN) {
    console.log('🔍 DRY RUN - No changes will be applied\n');
    console.log('Changes that would be made:');
    
    // Show sample changes
    const samplesToShow = Math.min(updates.length, 50);
    for (let i = 0; i < samplesToShow; i++) {
      const u = updates[i];
      console.log(`\n  [${u.ankama_id}] ${u.old_name}`);
      for (const change of u.changes) {
        console.log(`    - ${change}`);
      }
    }
    
    if (updates.length > samplesToShow) {
      console.log(`\n  ... and ${updates.length - samplesToShow} more items`);
    }
    
    return { success: updates.length, errors: 0 };
  }
  
  console.log('📤 Applying updates to Supabase...');
  
  let success = 0;
  let errors = 0;
  
  // Process in batches
  for (let i = 0; i < updates.length; i += UPDATE_BATCH_SIZE) {
    const batch = updates.slice(i, i + UPDATE_BATCH_SIZE);
    
    // Process each item in the batch
    for (const update of batch) {
      const { error } = await supabase
        .from('items')
        .update({
          name: update.new_name,
          level: update.new_level,
          craft_xp_ratio: update.new_craft_xp_ratio,
          updated_at: new Date().toISOString()
        })
        .eq('id', update.id);
      
      if (error) {
        console.error(`\n❌ Error updating item ${update.id} (${update.ankama_id}):`, error.message);
        errors++;
      } else {
        success++;
      }
    }
    
    process.stdout.write(`\r   Updated ${Math.min(i + UPDATE_BATCH_SIZE, updates.length)}/${updates.length}...`);
  }
  
  console.log('\n');
  return { success, errors };
}

/**
 * Also update recipe levels to match item levels
 */
async function syncRecipeLevels(): Promise<{ updated: number; errors: number }> {
  console.log('📤 Syncing recipe levels from item levels...');
  
  // Get all recipes with their result item's level
  const { data: recipes, error: fetchError } = await supabase
    .from('recipes')
    .select('id, level, result_item_id, items!result_item_id(level)')
    .order('id');
  
  if (fetchError) {
    console.error('❌ Failed to fetch recipes:', fetchError);
    return { updated: 0, errors: 1 };
  }
  
  let updated = 0;
  let errors = 0;
  
  for (const recipe of recipes || []) {
    const itemLevel = (recipe.items as any)?.level;
    
    if (itemLevel !== undefined && itemLevel !== recipe.level) {
      if (DRY_RUN) {
        console.log(`   Recipe ${recipe.id}: level ${recipe.level} → ${itemLevel}`);
        updated++;
      } else {
        const { error } = await supabase
          .from('recipes')
          .update({ level: itemLevel, updated_at: new Date().toISOString() })
          .eq('id', recipe.id);
        
        if (error) {
          errors++;
        } else {
          updated++;
        }
      }
    }
  }
  
  console.log(`   ✅ Recipe levels ${DRY_RUN ? 'would be' : ''} updated: ${updated}`);
  if (errors > 0) {
    console.log(`   ❌ Errors: ${errors}`);
  }
  console.log('');
  
  return { updated, errors };
}

/**
 * Generate a detailed report of changes by category
 */
function generateReport(updates: ItemUpdate[]): void {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('📊 DETAILED CHANGE REPORT');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  // Group by change type
  const nameChanges = updates.filter(u => u.changes.some(c => c.startsWith('name:')));
  const levelChanges = updates.filter(u => u.changes.some(c => c.startsWith('level:')));
  const xpRatioChanges = updates.filter(u => u.changes.some(c => c.startsWith('craft_xp_ratio:')));
  
  console.log(`📝 Name changes: ${nameChanges.length}`);
  if (nameChanges.length > 0 && nameChanges.length <= 20) {
    for (const u of nameChanges) {
      console.log(`   [${u.ankama_id}] "${u.old_name}" → "${u.new_name}"`);
    }
  } else if (nameChanges.length > 20) {
    for (let i = 0; i < 10; i++) {
      const u = nameChanges[i];
      console.log(`   [${u.ankama_id}] "${u.old_name}" → "${u.new_name}"`);
    }
    console.log(`   ... and ${nameChanges.length - 10} more`);
  }
  
  console.log(`\n📊 Level changes: ${levelChanges.length}`);
  if (levelChanges.length > 0 && levelChanges.length <= 20) {
    for (const u of levelChanges) {
      console.log(`   [${u.ankama_id}] ${u.old_name}: ${u.old_level} → ${u.new_level}`);
    }
  } else if (levelChanges.length > 20) {
    for (let i = 0; i < 10; i++) {
      const u = levelChanges[i];
      console.log(`   [${u.ankama_id}] ${u.old_name}: ${u.old_level} → ${u.new_level}`);
    }
    console.log(`   ... and ${levelChanges.length - 10} more`);
  }
  
  console.log(`\n⚡ Craft XP Ratio changes: ${xpRatioChanges.length}`);
  if (xpRatioChanges.length > 0 && xpRatioChanges.length <= 20) {
    for (const u of xpRatioChanges) {
      console.log(`   [${u.ankama_id}] ${u.old_name}: ${u.old_craft_xp_ratio} → ${u.new_craft_xp_ratio}`);
    }
  } else if (xpRatioChanges.length > 20) {
    for (let i = 0; i < 10; i++) {
      const u = xpRatioChanges[i];
      console.log(`   [${u.ankama_id}] ${u.old_name}: ${u.old_craft_xp_ratio} → ${u.new_craft_xp_ratio}`);
    }
    console.log(`   ... and ${xpRatioChanges.length - 10} more`);
  }
  
  console.log('\n');
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🚀 DOFUSDB ITEM SYNCHRONIZATION');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`   Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE'}`);
  console.log(`   Force update: ${FORCE_UPDATE ? 'YES' : 'NO'}`);
  if (LIMIT) console.log(`   Limit: ${LIMIT} items`);
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  try {
    // Step 1: Fetch all items from DofusDB
    const dofusDBMap = await buildDofusDBItemsMap();
    
    // Step 2: Fetch all items from Supabase
    let supabaseItems = await fetchSupabaseItems();
    
    // Apply limit if specified
    if (LIMIT) {
      supabaseItems = supabaseItems.slice(0, LIMIT);
      console.log(`   (Limited to ${LIMIT} items for testing)\n`);
    }
    
    // Step 3: Find items that need updates
    const updates = findItemsToUpdate(supabaseItems, dofusDBMap);
    
    if (updates.length === 0) {
      console.log('✅ All items are already up to date!\n');
      return;
    }
    
    // Generate detailed report
    generateReport(updates);
    
    // Step 4: Apply updates
    const { success, errors } = await applyUpdates(updates);
    
    // Step 5: Sync recipe levels
    const recipesResult = await syncRecipeLevels();
    
    // Final summary
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('📊 FINAL SUMMARY');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`   Items in Supabase:     ${supabaseItems.length}`);
    console.log(`   Items in DofusDB:      ${dofusDBMap.size}`);
    console.log(`   Items updated:         ${success}`);
    console.log(`   Item errors:           ${errors}`);
    console.log(`   Recipe levels synced:  ${recipesResult.updated}`);
    console.log(`   Recipe sync errors:    ${recipesResult.errors}`);
    console.log('═══════════════════════════════════════════════════════════════\n');
    
    if (DRY_RUN) {
      console.log('💡 Run without --dry-run to apply changes.\n');
    }
    
    console.log('✅ Done!');
  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

main().catch(console.error);
