/**
 * Script de nettoyage des items dupliqués
 * 
 * Gère les cas où des items ont été créés manuellement sans ankama_id
 * mais existent maintenant avec un ankama_id correct.
 * 
 * Usage: npx ts-node scripts/cleanup_duplicate_items.ts [--dry-run]
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const DOFUSDB_API = 'https://api.dofusdb.fr';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

interface DofusDBItem {
  id: number;
  level: number;
  craftXpRatio?: number;
  name?: { fr: string };
  type?: { craftXpRatio?: number };
}

async function fetchDofusDBItem(ankamaId: number): Promise<DofusDBItem | null> {
  const response = await fetch(`${DOFUSDB_API}/items/${ankamaId}`, {
    headers: { 'User-Agent': 'DofusTracker/1.0' }
  });
  if (!response.ok) return null;
  return await response.json() as DofusDBItem;
}

function computeFinalRatio(item: DofusDBItem): number {
  const itemRatio = item.craftXpRatio;
  const typeRatio = item.type?.craftXpRatio;
  if (itemRatio !== undefined && itemRatio > 0) return itemRatio;
  if (typeRatio !== undefined && typeRatio > 0) return typeRatio;
  return -1;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🧹 DUPLICATE ITEMS CLEANUP');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`   Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE'}`);
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  // Items that have duplicates (one with ankama_id, one without)
  const duplicateMapping = [
    { 
      correctAnkamaId: 31630, 
      incorrectName: 'Draguosseuse de Domptueuse',
      correctName: 'Daguosseuse de Domptueuse'
    },
    { 
      correctAnkamaId: 31673, 
      incorrectName: 'Corne de Gryrafor',
      correctName: 'Corne de Gyrafor'
    },
    { 
      correctAnkamaId: 32328, 
      incorrectName: 'Fragment de carte de la Fuji Givrefoux',
      correctName: 'Fragment de carte de la Fuji Givrefoux 4/5'
    },
  ];
  
  for (const mapping of duplicateMapping) {
    console.log(`\n📦 Processing: "${mapping.incorrectName}" → "${mapping.correctName}"`);
    
    // Find the item without ankama_id (the one blocking)
    const { data: blockingItem } = await supabase
      .from('items')
      .select('id, ankama_id, name')
      .eq('name', mapping.correctName)
      .is('ankama_id', null)
      .single();
    
    // Find the correct item with ankama_id
    const { data: correctItem } = await supabase
      .from('items')
      .select('id, ankama_id, name')
      .eq('ankama_id', mapping.correctAnkamaId)
      .single();
    
    if (!blockingItem) {
      console.log(`   ⏭️ No blocking item found for "${mapping.correctName}"`);
      continue;
    }
    
    if (!correctItem) {
      console.log(`   ⏭️ Correct item not found for ankama_id ${mapping.correctAnkamaId}`);
      continue;
    }
    
    console.log(`   Found blocking item: id=${blockingItem.id} (no ankama_id)`);
    console.log(`   Found correct item: id=${correctItem.id}, ankama_id=${correctItem.ankama_id}`);
    
    // Check if the blocking item has any observations
    const { count: obsCount } = await supabase
      .from('observations')
      .select('id', { count: 'exact', head: true })
      .eq('item_id', blockingItem.id);
    
    console.log(`   Blocking item has ${obsCount || 0} observations`);
    
    if (DRY_RUN) {
      console.log(`   [DRY RUN] Would delete blocking item and rename correct item`);
      continue;
    }
    
    // Strategy: Delete the blocking item (it has no ankama_id, likely added manually)
    // First, migrate any observations to the correct item
    if (obsCount && obsCount > 0) {
      console.log(`   Migrating ${obsCount} observations to correct item...`);
      const { error: migrateErr } = await supabase
        .from('observations')
        .update({ item_id: correctItem.id })
        .eq('item_id', blockingItem.id);
      
      if (migrateErr) {
        console.error(`   ❌ Failed to migrate observations:`, migrateErr.message);
        continue;
      }
    }
    
    // Delete the blocking item
    console.log(`   Deleting blocking item...`);
    const { error: deleteErr } = await supabase
      .from('items')
      .delete()
      .eq('id', blockingItem.id);
    
    if (deleteErr) {
      console.error(`   ❌ Failed to delete:`, deleteErr.message);
      continue;
    }
    
    // Now rename the correct item
    console.log(`   Renaming correct item...`);
    const dbItem = await fetchDofusDBItem(mapping.correctAnkamaId);
    
    const { error: renameErr } = await supabase
      .from('items')
      .update({
        name: mapping.correctName,
        level: dbItem?.level || 200,
        craft_xp_ratio: dbItem ? computeFinalRatio(dbItem) : -1,
        updated_at: new Date().toISOString()
      })
      .eq('id', correctItem.id);
    
    if (renameErr) {
      console.error(`   ❌ Failed to rename:`, renameErr.message);
      continue;
    }
    
    console.log(`   ✅ Successfully cleaned up`);
  }
  
  // Handle the Patte d'Ecaflip special case
  console.log(`\n📦 Processing special case: "Patte d'Ecaflip"`);
  
  // The item with ankama_id 8941 has a modified name "Patte d'Ecaflip (8941)"
  // Item 8956 is the "correct" one already named "Patte d'Ecaflip"
  // Both are valid items - 8941 needs to keep a unique name
  
  // Fetch the correct name from DofusDB for 8941
  const item8941 = await fetchDofusDBItem(8941);
  const correctName8941 = item8941?.name?.fr;
  
  console.log(`   DofusDB name for 8941: "${correctName8941}"`);
  
  if (correctName8941 && correctName8941 !== "Patte d'Ecaflip") {
    // If DofusDB has a different name, use it
    console.log(`   8941 has different name in DofusDB, updating...`);
    
    if (!DRY_RUN) {
      const { error } = await supabase
        .from('items')
        .update({
          name: correctName8941,
          level: item8941?.level || 100,
          craft_xp_ratio: item8941 ? computeFinalRatio(item8941) : -1,
          updated_at: new Date().toISOString()
        })
        .eq('ankama_id', 8941);
      
      if (error) {
        console.error(`   ❌ Failed:`, error.message);
      } else {
        console.log(`   ✅ Updated successfully`);
      }
    } else {
      console.log(`   [DRY RUN] Would update to "${correctName8941}"`);
    }
  } else {
    // Both items have the same name in DofusDB - need a manual suffix
    console.log(`   Both 8941 and 8956 are "Patte d'Ecaflip" in DofusDB`);
    console.log(`   Keeping current names to maintain uniqueness`);
  }
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('✅ Cleanup complete!');
  console.log('═══════════════════════════════════════════════════════════════\n');
}

main().catch(console.error);
