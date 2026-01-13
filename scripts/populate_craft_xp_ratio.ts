/**
 * Script de synchronisation des craft_xp_ratio depuis DofusDB vers la table recipes
 * 
 * Usage: npx ts-node scripts/populate_craft_xp_ratio.ts
 * 
 * Prérequis:
 *   1. Exécuter la migration SQL: sql/add_craft_xp_ratio.sql
 *   2. Variables d'environnement: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
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
const BATCH_SIZE = 100;

interface DofusDBRecipe {
  resultId: number;
  resultLevel: number;
  result?: {
    craftXpRatio?: number;
  };
  resultType?: {
    craftXpRatio?: number;
  };
}

interface DofusDBResponse {
  data: DofusDBRecipe[];
  total: number;
  skip: number;
  limit: number;
}

/**
 * Calcule le ratio final selon la logique DofusDB :
 * 1. result.craftXpRatio si > 0
 * 2. resultType.craftXpRatio si > 0
 * 3. -1 sinon (le code utilisera le fallback 100)
 */
function computeFinalRatio(recipe: DofusDBRecipe): number {
  const itemRatio = recipe.result?.craftXpRatio;
  const typeRatio = recipe.resultType?.craftXpRatio;

  if (itemRatio !== undefined && itemRatio > 0) {
    return itemRatio;
  }
  if (typeRatio !== undefined && typeRatio > 0) {
    return typeRatio;
  }
  return -1;
}

async function fetchDofusDBRecipes(skip: number, limit: number): Promise<DofusDBResponse> {
  const url = `${DOFUSDB_API}/recipes?$limit=${limit}&$skip=${skip}`;
  
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'DofusTracker/1.0'
    }
  });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch recipes: ${response.statusText}`);
  }
  
  return await response.json() as DofusDBResponse;
}

async function main() {
  console.log('🚀 Starting craft_xp_ratio population...\n');
  
  // Étape 1: Récupérer toutes les recettes de DofusDB
  console.log('📥 Fetching recipes from DofusDB...');
  
  let skip = 0;
  const ratioMap = new Map<number, number>(); // resultId -> ratio
  
  while (true) {
    const data = await fetchDofusDBRecipes(skip, BATCH_SIZE);
    
    if (data.data.length === 0) break;
    
    for (const recipe of data.data) {
      const ratio = computeFinalRatio(recipe);
      ratioMap.set(recipe.resultId, ratio);
    }
    
    skip += data.data.length;
    process.stdout.write(`\r   Fetched ${skip}/${data.total} recipes...`);
    
    // Petit délai pour ne pas surcharger l'API
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  console.log(`\n✅ Fetched ${ratioMap.size} recipes from DofusDB\n`);
  
  // Étape 2: Récupérer les recettes Supabase avec l'ankama_id de l'item résultat
  // Note: result_item_id est un ID interne, il faut joindre avec items pour avoir ankama_id
  console.log('📥 Fetching recipes from Supabase (avec ankama_id)...');
  
  const supabaseRecipes: { id: string; ankama_id: number }[] = [];
  let from = 0;
  const PAGE_SIZE = 1000;
  
  while (true) {
    // Jointure avec items pour récupérer l'ankama_id
    const { data, error } = await supabase
      .from('recipes')
      .select('id, items!result_item_id(ankama_id)')
      .range(from, from + PAGE_SIZE - 1);
    
    if (error) {
      console.error('❌ Failed to fetch Supabase recipes:', error);
      process.exit(1);
    }
    
    if (!data || data.length === 0) break;
    
    // Transformer les données pour avoir ankama_id directement
    for (const r of data) {
      const ankama_id = (r.items as any)?.ankama_id;
      if (ankama_id) {
        supabaseRecipes.push({ id: r.id, ankama_id });
      }
    }
    
    from += data.length;
    
    if (data.length < PAGE_SIZE) break;
  }
  
  console.log(`✅ Found ${supabaseRecipes.length} recipes in Supabase\n`);
  
  // Étape 3: Préparer les mises à jour
  console.log('🔄 Preparing updates...');
  
  const updates: { id: string; craft_xp_ratio: number }[] = [];
  let matched = 0;
  let notFound = 0;
  
  for (const recipe of supabaseRecipes) {
    const ratio = ratioMap.get(recipe.ankama_id);
    
    if (ratio !== undefined) {
      updates.push({
        id: recipe.id,
        craft_xp_ratio: ratio
      });
      matched++;
    } else {
      notFound++;
    }
  }
  
  console.log(`   ✅ Matched: ${matched}`);
  console.log(`   ⚠️  Not found in DofusDB: ${notFound}\n`);
  
  // Étape 4: Appliquer les mises à jour individuellement
  console.log('📤 Updating Supabase...');
  
  let updated = 0;
  let errors = 0;
  
  for (const update of updates) {
    const { error } = await supabase
      .from('recipes')
      .update({ craft_xp_ratio: update.craft_xp_ratio })
      .eq('id', update.id);
    
    if (error) {
      console.error(`\n❌ Update error for ${update.id}:`, error.message);
      errors++;
    } else {
      updated++;
    }
    
    if (updated % 100 === 0) {
      process.stdout.write(`\r   Updated ${updated}/${updates.length}...`);
    }
  }
  
  process.stdout.write(`\r   Updated ${updated}/${updates.length}...`);
  console.log('\n');
  
  // Résumé
  console.log('═══════════════════════════════════════');
  console.log('📊 SUMMARY');
  console.log('═══════════════════════════════════════');
  console.log(`   DofusDB recipes:     ${ratioMap.size}`);
  console.log(`   Supabase recipes:    ${supabaseRecipes.length}`);
  console.log(`   Matched & updated:   ${updated}`);
  console.log(`   Not found:           ${notFound}`);
  console.log(`   Errors:              ${errors}`);
  console.log('═══════════════════════════════════════\n');
  
  // Vérification finale
  console.log('🔍 Verification - Sample ratios:');
  
  const { data: sample } = await supabase
    .from('recipes')
    .select('result_item_id, craft_xp_ratio')
    .neq('craft_xp_ratio', -1)
    .limit(5);
  
  if (sample) {
    for (const r of sample) {
      console.log(`   Item ${r.result_item_id}: ratio = ${r.craft_xp_ratio}`);
    }
  }
  
  console.log('\n✅ Done!');
}

main().catch(console.error);
