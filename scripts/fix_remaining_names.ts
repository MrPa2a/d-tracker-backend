/**
 * Script de correction manuelle des noms d'items
 * 
 * Ce script gère les cas spéciaux de renommage :
 * 1. Swaps de noms (items qui ont échangé leurs noms)
 * 2. Corrections simples (items avec noms erronés pointant vers un nom déjà pris)
 * 
 * Usage: npx ts-node scripts/fix_remaining_names.ts [--dry-run]
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

interface DofusDBItem {
  id: number;
  level: number;
  craftXpRatio?: number;
  name?: {
    fr: string;
  };
  type?: {
    craftXpRatio?: number;
  };
}

/**
 * Fetch item details from DofusDB
 */
async function fetchDofusDBItem(ankamaId: number): Promise<DofusDBItem | null> {
  const url = `${DOFUSDB_API}/items/${ankamaId}`;
  
  const response = await fetch(url, {
    headers: { 'User-Agent': 'DofusTracker/1.0' }
  });
  
  if (!response.ok) return null;
  
  return await response.json() as DofusDBItem;
}

/**
 * Compute final XP ratio
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

interface RenameAction {
  ankamaId: number;
  currentName: string;
  newName: string;
  newLevel?: number;
  newCraftXpRatio?: number;
  conflictAnkamaId?: number;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🔧 REMAINING NAME FIXES');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`   Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE'}`);
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  // Items with known conflicts from the sync errors
  const conflictAnkamaIds = [
    // Piou amulettes and chapeaux (swaps)
    8216, 8217, 8246, 8247,
    // Other specific items
    8941, // Patte d'Ecaflip
    31630, 31673, 32328
  ];
  
  // Fetch current state from Supabase
  const { data: items } = await supabase
    .from('items')
    .select('id, ankama_id, name, level, craft_xp_ratio')
    .in('ankama_id', conflictAnkamaIds);
  
  if (!items || items.length === 0) {
    console.log('No items found to fix.');
    return;
  }
  
  console.log(`Found ${items.length} items to analyze:\n`);
  
  const actions: RenameAction[] = [];
  
  for (const item of items) {
    const dbItem = await fetchDofusDBItem(item.ankama_id);
    if (!dbItem) {
      console.log(`   [${item.ankama_id}] Not found in DofusDB`);
      continue;
    }
    
    const correctName = dbItem.name?.fr;
    if (!correctName) continue;
    
    if (correctName !== item.name) {
      // Check if there's a conflict
      const { data: conflict } = await supabase
        .from('items')
        .select('id, ankama_id, name')
        .eq('name', correctName)
        .neq('ankama_id', item.ankama_id)
        .single();
      
      actions.push({
        ankamaId: item.ankama_id,
        currentName: item.name,
        newName: correctName,
        newLevel: dbItem.level,
        newCraftXpRatio: computeFinalRatio(dbItem),
        conflictAnkamaId: conflict?.ankama_id
      });
      
      console.log(`   [${item.ankama_id}] "${item.name}" → "${correctName}"${conflict ? ` (conflict with ${conflict.ankama_id})` : ''}`);
    } else {
      console.log(`   [${item.ankama_id}] "${item.name}" - OK`);
    }
    
    await new Promise(r => setTimeout(r, 100));
  }
  
  if (actions.length === 0) {
    console.log('\n✅ All items have correct names!');
    return;
  }
  
  console.log(`\n📤 Processing ${actions.length} renames...`);
  
  if (DRY_RUN) {
    console.log('\n🔍 DRY RUN - No changes will be applied');
    return;
  }
  
  // Group by swap pairs and single renames
  const swapPairs: [RenameAction, RenameAction][] = [];
  const singleRenames: RenameAction[] = [];
  const processed = new Set<number>();
  
  for (const action of actions) {
    if (processed.has(action.ankamaId)) continue;
    
    if (action.conflictAnkamaId) {
      // Check if the conflict is also in our actions (= swap)
      const counterpart = actions.find(a => a.ankamaId === action.conflictAnkamaId);
      if (counterpart && counterpart.newName === action.currentName) {
        // This is a swap pair
        swapPairs.push([action, counterpart]);
        processed.add(action.ankamaId);
        processed.add(counterpart.ankamaId);
      } else {
        // Single rename with conflict - need special handling
        // First, delete the conflicting item if it's a duplicate or rename it with suffix
        console.log(`\n   ⚠️ [${action.ankamaId}] has conflict with [${action.conflictAnkamaId}] - manual intervention may be needed`);
        singleRenames.push(action);
        processed.add(action.ankamaId);
      }
    } else {
      singleRenames.push(action);
      processed.add(action.ankamaId);
    }
  }
  
  // Apply swap pairs
  for (const [a1, a2] of swapPairs) {
    console.log(`\n   Swapping: [${a1.ankamaId}] "${a1.currentName}" ↔ [${a2.ankamaId}] "${a2.currentName}"`);
    
    // Step 1: Rename first item to temp
    const tempName = `__TEMP_SWAP_${a1.ankamaId}_${Date.now()}`;
    const { error: err1 } = await supabase
      .from('items')
      .update({ name: tempName })
      .eq('ankama_id', a1.ankamaId);
    
    if (err1) {
      console.error(`   ❌ Failed temp rename for ${a1.ankamaId}:`, err1.message);
      continue;
    }
    
    // Step 2: Rename second to its final name
    const { error: err2 } = await supabase
      .from('items')
      .update({ 
        name: a2.newName,
        level: a2.newLevel,
        craft_xp_ratio: a2.newCraftXpRatio,
        updated_at: new Date().toISOString()
      })
      .eq('ankama_id', a2.ankamaId);
    
    if (err2) {
      console.error(`   ❌ Failed rename for ${a2.ankamaId}:`, err2.message);
      await supabase.from('items').update({ name: a1.currentName }).eq('ankama_id', a1.ankamaId);
      continue;
    }
    
    // Step 3: Rename first to its final name
    const { error: err3 } = await supabase
      .from('items')
      .update({ 
        name: a1.newName,
        level: a1.newLevel,
        craft_xp_ratio: a1.newCraftXpRatio,
        updated_at: new Date().toISOString()
      })
      .eq('ankama_id', a1.ankamaId);
    
    if (err3) {
      console.error(`   ❌ Failed rename for ${a1.ankamaId}:`, err3.message);
      continue;
    }
    
    console.log(`   ✅ Swapped successfully`);
  }
  
  // Apply single renames (without conflicts)
  for (const action of singleRenames) {
    if (action.conflictAnkamaId) {
      console.log(`\n   ⏭️ Skipping [${action.ankamaId}] - has conflict that needs manual resolution`);
      continue;
    }
    
    console.log(`\n   Renaming: [${action.ankamaId}] "${action.currentName}" → "${action.newName}"`);
    
    const { error } = await supabase
      .from('items')
      .update({ 
        name: action.newName,
        level: action.newLevel,
        craft_xp_ratio: action.newCraftXpRatio,
        updated_at: new Date().toISOString()
      })
      .eq('ankama_id', action.ankamaId);
    
    if (error) {
      console.error(`   ❌ Failed:`, error.message);
    } else {
      console.log(`   ✅ Success`);
    }
  }
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('✅ Done!');
  console.log('═══════════════════════════════════════════════════════════════\n');
}

main().catch(console.error);
