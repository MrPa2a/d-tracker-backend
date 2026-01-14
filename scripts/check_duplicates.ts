/**
 * Script to check for duplicate items by name
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function check() {
  const names = [
    'Daguosseuse de Domptueuse', 
    'Corne de Gyrafor', 
    'Fragment de carte de la Fuji Givrefoux 4/5', 
    "Patte d'Ecaflip"
  ];
  
  console.log('Checking for existing items with target names:\n');
  
  for (const name of names) {
    const { data } = await supabase
      .from('items')
      .select('id, ankama_id, name, level')
      .eq('name', name);
    
    console.log(`"${name}":`, data?.length ? data : 'NOT FOUND');
  }
  
  // Also check the items that need renaming
  console.log('\n\nItems that need renaming:');
  
  const ankamaIds = [31630, 31673, 32328, 8941, 8956];
  const { data: items } = await supabase
    .from('items')
    .select('id, ankama_id, name, level')
    .in('ankama_id', ankamaIds);
  
  for (const item of items || []) {
    console.log(`[${item.ankama_id}] "${item.name}" (level ${item.level})`);
  }
}

check();
