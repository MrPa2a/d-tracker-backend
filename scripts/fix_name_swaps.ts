/**
 * Script de correction des swaps de noms d'items
 * 
 * Ce script gère les cas où des items ont échangé leurs noms (ex: Piou Jaune ↔ Piou Vert)
 * en utilisant des noms temporaires pour éviter les conflits d'unicité.
 * 
 * Usage: npx ts-node scripts/fix_name_swaps.ts [--dry-run]
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

// Parse CLI args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

interface NameSwapPair {
  ankamaId1: number;
  currentName1: string;
  newName1: string;
  ankamaId2: number;
  currentName2: string;
  newName2: string;
}

/**
 * Fetch item name from DofusDB
 */
async function fetchItemName(ankamaId: number): Promise<string | null> {
  const url = `${DOFUSDB_API}/items/${ankamaId}?$select[]=name`;
  
  const response = await fetch(url, {
    headers: { 'User-Agent': 'DofusTracker/1.0' }
  });
  
  if (!response.ok) return null;
  
  const data = await response.json() as { name?: { fr?: string } };
  return data.name?.fr || null;
}

/**
 * Find items that need name swaps by checking DofusDB
 * Focus on known problematic items (Piou items that swapped colors, etc.)
 */
async function findNameSwaps(): Promise<NameSwapPair[]> {
  console.log('🔍 Finding items with name conflicts...\n');
  
  // Known swap patterns based on the sync errors
  // These are ankama_ids that failed with duplicate key errors
  const knownConflictAnkamaIds = [
    8222, 8229, 8236, 8240, 8233, 8217, 8216, 8223, 8228, 8241, 8247, 8246, 8941,
    31630, 31673, 32328, 16023, 31655, 31625, 31523,
    9687, 9688, 9690 // Pierres d'âme
  ];
  
  // Get all items from Supabase for these IDs
  const { data: items, error } = await supabase
    .from('items')
    .select('id, ankama_id, name')
    .in('ankama_id', knownConflictAnkamaIds);
  
  if (error || !items) {
    console.error('Failed to fetch items:', error);
    return [];
  }
  
  // Build a map of name -> item for all items
  const { data: allItems } = await supabase
    .from('items')
    .select('id, ankama_id, name')
    .not('ankama_id', 'is', null);
  
  const nameToItem = new Map<string, { id: number; ankama_id: number; name: string }>();
  for (const item of allItems || []) {
    nameToItem.set(item.name, item);
  }
  
  const swaps: NameSwapPair[] = [];
  const checked = new Set<number>();
  
  // Check each known conflict item against DofusDB
  for (const item of items) {
    if (checked.has(item.ankama_id)) continue;
    
    const correctName = await fetchItemName(item.ankama_id);
    if (!correctName || correctName === item.name) continue;
    
    // This item has a different name in DofusDB
    // Check if there's another item in our DB with the correct name
    const conflictingItem = nameToItem.get(correctName);
    
    if (conflictingItem && conflictingItem.ankama_id !== item.ankama_id) {
      // Check if the conflicting item also needs a swap
      const conflictCorrectName = await fetchItemName(conflictingItem.ankama_id);
      
      if (conflictCorrectName && conflictCorrectName === item.name) {
        // This is a swap pair!
        swaps.push({
          ankamaId1: item.ankama_id,
          currentName1: item.name,
          newName1: correctName,
          ankamaId2: conflictingItem.ankama_id,
          currentName2: conflictingItem.name,
          newName2: conflictCorrectName
        });
        
        checked.add(item.ankama_id);
        checked.add(conflictingItem.ankama_id);
        
        console.log(`   Found swap pair:`);
        console.log(`     [${item.ankama_id}] "${item.name}" ↔ [${conflictingItem.ankama_id}] "${conflictingItem.name}"`);
      }
    }
    
    // Small delay to not overwhelm DofusDB API
    await new Promise(r => setTimeout(r, 100));
  }
  
  return swaps;
}

/**
 * Apply name swaps using temporary names
 */
async function applyNameSwaps(swaps: NameSwapPair[]): Promise<void> {
  if (swaps.length === 0) {
    console.log('\n✅ No name swaps needed!');
    return;
  }
  
  console.log(`\n📤 Applying ${swaps.length} name swaps...`);
  
  if (DRY_RUN) {
    console.log('\n🔍 DRY RUN - No changes will be applied');
    for (const swap of swaps) {
      console.log(`\n   Would swap:`);
      console.log(`     [${swap.ankamaId1}] "${swap.currentName1}" → "${swap.newName1}"`);
      console.log(`     [${swap.ankamaId2}] "${swap.currentName2}" → "${swap.newName2}"`);
    }
    return;
  }
  
  for (const swap of swaps) {
    console.log(`\n   Processing swap for ankama_ids ${swap.ankamaId1} ↔ ${swap.ankamaId2}...`);
    
    // Step 1: Rename first item to a temporary name
    const tempName = `__TEMP_SWAP_${swap.ankamaId1}_${Date.now()}`;
    
    const { error: err1 } = await supabase
      .from('items')
      .update({ name: tempName, updated_at: new Date().toISOString() })
      .eq('ankama_id', swap.ankamaId1);
    
    if (err1) {
      console.error(`   ❌ Failed to set temp name for ${swap.ankamaId1}:`, err1.message);
      continue;
    }
    
    // Step 2: Rename second item to its new name (was first item's name)
    const { error: err2 } = await supabase
      .from('items')
      .update({ name: swap.newName2, updated_at: new Date().toISOString() })
      .eq('ankama_id', swap.ankamaId2);
    
    if (err2) {
      console.error(`   ❌ Failed to rename ${swap.ankamaId2}:`, err2.message);
      // Rollback step 1
      await supabase.from('items').update({ name: swap.currentName1 }).eq('ankama_id', swap.ankamaId1);
      continue;
    }
    
    // Step 3: Rename first item to its new name (was second item's name)
    const { error: err3 } = await supabase
      .from('items')
      .update({ name: swap.newName1, updated_at: new Date().toISOString() })
      .eq('ankama_id', swap.ankamaId1);
    
    if (err3) {
      console.error(`   ❌ Failed to rename ${swap.ankamaId1}:`, err3.message);
      // Rollback
      await supabase.from('items').update({ name: swap.currentName2 }).eq('ankama_id', swap.ankamaId2);
      await supabase.from('items').update({ name: swap.currentName1 }).eq('ankama_id', swap.ankamaId1);
      continue;
    }
    
    console.log(`   ✅ Swapped: "${swap.currentName1}" ↔ "${swap.currentName2}"`);
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🔄 NAME SWAP FIXER');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`   Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE'}`);
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  try {
    const swaps = await findNameSwaps();
    await applyNameSwaps(swaps);
    
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('📊 SUMMARY');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`   Swap pairs found: ${swaps.length}`);
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
