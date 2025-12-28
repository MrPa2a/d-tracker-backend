import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// Configuration
const DAYS_TO_FILL = 90; // How many days ahead to maintain
const MAX_DAYS_PER_RUN = 5; // Limit per execution to stay within Vercel timeout (~10s hobby)

// Types
interface DofusDbItem {
  id: number;
  name: { fr: string };
  level?: number;
  iconId?: number;
  type?: { superTypeId?: number };
}

interface AlmanaxData {
  iconId: number;
  quantity: number;
  bonus: string;
}

/**
 * Fetch Krosmoz almanax page for a specific date
 */
async function fetchAlmanaxDay(dateStr: string): Promise<string | null> {
  const url = `https://www.krosmoz.com/en/almanax/${dateStr}`;
  
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    if (!response.ok) {
      console.error(`Failed to fetch ${url}: ${response.status}`);
      return null;
    }
    
    return await response.text();
  } catch (error) {
    console.error(`Error fetching ${url}:`, error);
    return null;
  }
}

/**
 * Parse almanax page HTML to extract item icon ID, quantity, and bonus
 */
function parseAlmanaxPage(html: string): AlmanaxData | null {
  // Find the offering image to get icon ID
  // <img src="https://static.ankama.com/dofus/www/game/items/200/40658.w75h75.png" ...>
  const imgMatch = html.match(/static\.ankama\.com\/dofus\/www\/game\/items\/\d+\/(\d+)\.w75h75\.png/);
  if (!imgMatch) {
    console.log('Could not find offering image');
    return null;
  }
  
  const iconId = parseInt(imgMatch[1], 10);
  
  // Find quantity: "Find 1 Ebonite and take the offering"
  let quantity = 1;
  const textMatch = html.match(/Find (\d+) .+ and take the offering/);
  if (textMatch) {
    quantity = parseInt(textMatch[1], 10);
  }
  
  // Extract bonus description
  let bonus = 'Bonus';
  const bonusMatch = html.match(/<h4>DOFUS bonuses and quests<\/h4>\s*<div class="more">\s*<p>(.+?)<\/p>/s);
  if (bonusMatch) {
    bonus = bonusMatch[1]
      .replace(/<[^>]+>/g, '') // Remove HTML tags
      .replace(/\n/g, ' ')     // Remove newlines
      .trim();
  }
  
  return { iconId, quantity, bonus };
}

/**
 * Resolve item from DofusDB using icon ID
 */
async function resolveItemFromDofusDb(iconId: number): Promise<DofusDbItem | null> {
  const url = `https://api.dofusdb.fr/items?iconId=${iconId}&$limit=10`;
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Failed to fetch DofusDB for icon ${iconId}`);
      return null;
    }
    
    const data = await response.json() as { data?: DofusDbItem[] };
    const items: DofusDbItem[] = data.data || [];
    
    if (items.length === 0) {
      return null;
    }
    
    // Filter out quest items (SuperType 14) unless it's the only option
    const nonQuestItems = items.filter(item => item.type?.superTypeId !== 14);
    
    return nonQuestItems.length > 0 ? nonQuestItems[0] : items[0];
  } catch (error) {
    console.error(`Error fetching DofusDB for icon ${iconId}:`, error);
    return null;
  }
}

/**
 * Get or create an item in the database
 */
async function getOrCreateItem(ankamaId: number, itemData: DofusDbItem): Promise<number | null> {
  // Check if item already exists
  const { data: existingItem, error: selectError } = await supabase
    .from('items')
    .select('id')
    .eq('ankama_id', ankamaId)
    .single();
  
  if (existingItem) {
    return existingItem.id;
  }
  
  if (selectError && selectError.code !== 'PGRST116') {
    // PGRST116 = no rows found, which is expected
    console.error('Error checking existing item:', selectError);
    return null;
  }
  
  // Create new item
  const name = itemData.name.fr;
  const level = itemData.level || 1;
  const iconUrl = itemData.iconId 
    ? `https://api.dofusdb.fr/img/items/${itemData.iconId}.png` 
    : null;
  
  console.log(`Creating item ${name} (Ankama ID: ${ankamaId})...`);
  
  const { data: newItem, error: insertError } = await supabase
    .from('items')
    .insert({
      name,
      ankama_id: ankamaId,
      level,
      icon_url: iconUrl,
      is_manually_added: true
    })
    .select('id')
    .single();
  
  if (insertError) {
    console.error('Error creating item:', insertError);
    return null;
  }
  
  return newItem.id;
}

/**
 * Get dates that need to be filled (missing from almanax_calendar)
 */
async function getMissingDates(): Promise<string[]> {
  const today = new Date();
  const datesToCheck: string[] = [];
  
  for (let i = 0; i < DAYS_TO_FILL; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() + i);
    datesToCheck.push(date.toISOString().split('T')[0]);
  }
  
  // Get existing dates from database
  const { data: existingDates, error } = await supabase
    .from('almanax_calendar')
    .select('date')
    .in('date', datesToCheck);
  
  if (error) {
    console.error('Error fetching existing dates:', error);
    return [];
  }
  
  const existingSet = new Set(
    (existingDates || []).map(d => d.date)
  );
  
  return datesToCheck.filter(date => !existingSet.has(date));
}

/**
 * Process a single almanax day
 */
async function processAlmanaxDay(dateStr: string): Promise<boolean> {
  console.log(`Processing ${dateStr}...`);
  
  const html = await fetchAlmanaxDay(dateStr);
  if (!html) {
    return false;
  }
  
  const almanaxData = parseAlmanaxPage(html);
  if (!almanaxData) {
    console.log(`  Failed to parse ${dateStr}`);
    return false;
  }
  
  console.log(`  Found Icon ID: ${almanaxData.iconId}, Quantity: ${almanaxData.quantity}`);
  
  const itemData = await resolveItemFromDofusDb(almanaxData.iconId);
  if (!itemData) {
    console.log(`  Could not resolve item for icon ${almanaxData.iconId}`);
    return false;
  }
  
  const ankamaId = itemData.id;
  const itemName = itemData.name.fr;
  console.log(`  Resolved to: ${itemName} (Ankama ID: ${ankamaId})`);
  
  const itemId = await getOrCreateItem(ankamaId, itemData);
  if (!itemId) {
    return false;
  }
  
  // Upsert almanax entry
  const { error: upsertError } = await supabase
    .from('almanax_calendar')
    .upsert({
      date: dateStr,
      item_id: itemId,
      quantity: almanaxData.quantity,
      bonus_description: almanaxData.bonus,
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'date'
    });
  
  if (upsertError) {
    console.error(`  Error upserting almanax for ${dateStr}:`, upsertError);
    return false;
  }
  
  console.log(`  Successfully added ${dateStr}`);
  return true;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Verify this is a legitimate cron request from Vercel
  // Vercel cron jobs use 'vercel-cron/1.0' as user agent
  const userAgent = req.headers['user-agent'] || '';
  const authHeader = req.headers['authorization'];
  const apiToken = process.env.INGEST_API_TOKEN;
  
  // In production, verify the request is from Vercel cron
  // Allow local testing without auth
  const isVercelCron = userAgent.includes('vercel-cron');
  const isAuthorized = apiToken && authHeader === `Bearer ${apiToken}`;
  const isLocal = process.env.VERCEL_ENV !== 'production';
  
  if (!isVercelCron && !isAuthorized && !isLocal) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  console.log('Starting Almanax cron job...');
  
  try {
    // Get dates that need to be filled
    const missingDates = await getMissingDates();
    
    if (missingDates.length === 0) {
      console.log('All dates are up to date');
      return res.status(200).json({
        success: true,
        message: 'All dates are up to date',
        processed: 0,
        remaining: 0
      });
    }
    
    console.log(`Found ${missingDates.length} missing dates`);
    
    // Process only a limited number of dates per run to stay within timeout
    const datesToProcess = missingDates.slice(0, MAX_DAYS_PER_RUN);
    let successCount = 0;
    
    for (const dateStr of datesToProcess) {
      const success = await processAlmanaxDay(dateStr);
      if (success) {
        successCount++;
      }
    }
    
    const remaining = missingDates.length - datesToProcess.length;
    
    return res.status(200).json({
      success: true,
      message: `Processed ${successCount}/${datesToProcess.length} dates`,
      processed: successCount,
      attempted: datesToProcess.length,
      remaining
    });
  } catch (error) {
    console.error('Cron job error:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}
