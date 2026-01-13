import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { JobXpService } from '../job_xp';

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

interface AlmanaxDay {
  date: string;
  quantity: number;
  bonus_description: string;
  item: {
    id: number;
    name: string;
    icon_url: string;
    level: number;
    last_price?: number;
    avg_price_7d?: number;
  };
}

async function handleAlmanax(req: VercelRequest, res: VercelResponse) {
  const server = decodeQueryValue(req.query.server) || 'Draconiros';
  try {
    const { data: calendarData, error: calendarError } = await supabase
      .from('almanax_calendar')
      .select(`
        date,
        quantity,
        bonus_description,
        item:items (
          id,
          name,
          icon_url,
          level
        )
      `)
      .gte('date', new Date().toISOString().split('T')[0])
      .order('date', { ascending: true })
      .limit(90);

    if (calendarError) throw calendarError;
    if (!calendarData) return res.status(200).json([]);

    // Extract item IDs to fetch prices
    // @ts-ignore
    const itemIds = calendarData.map(d => d.item?.id).filter(id => !!id);

    if (itemIds.length > 0) {
      // Fetch latest prices (naive approach: get all observations for these items in last 24h)
      // Better: use a view or distinct on.
      // For now, let's just get the latest observation for each item.
      
      // We can use the 'observations' table.
      // Since we can't easily do "latest per group" in simple supabase select without RPC or View,
      // we will fetch recent observations and process in memory (limit to last 3 days to be safe)
      
      const threeDaysAgo = new Date();
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
      
      const { data: obsData } = await supabase
        .from('observations')
        .select('item_id, price:price_unit_avg, timestamp:captured_at')
        .eq('server', server)
        .in('item_id', itemIds)
        .gte('captured_at', threeDaysAgo.toISOString())
        .order('captured_at', { ascending: false });

      const priceMap: Record<number, number> = {};
      if (obsData) {
        for (const obs of obsData) {
          if (!priceMap[obs.item_id]) {
            priceMap[obs.item_id] = obs.price;
          }
        }
      }

      // Attach prices
      for (const day of calendarData) {
        // @ts-ignore
        if (day.item && day.item.id) {
            // @ts-ignore
            day.item.last_price = priceMap[day.item.id] || null;
        }
      }
    }

    return res.status(200).json(calendarData);

  } catch (error: any) {
    console.error('Error in almanax:', error);
    return res.status(500).json({ error: error.message });
  }
}

interface Ingredient {
  id: number;
  name: string;
  imgUrl: string;
  quantity: number;
  price: number;
}

interface LevelingStep {
  startLevel: number;
  endLevel: number;
  recipeId: number;
  recipeName: string;
  recipeLevel: number;
  quantity: number;
  xpPerCraft: number;
  costPerCraft: number;
  totalCost: number;
  totalXp: number;
  imgUrl?: string;
  ingredients?: Ingredient[];
}

interface LevelingPlan {
  jobId: number;
  fromLevel: number;
  toLevel: number;
  totalCost: number;
  steps: LevelingStep[];
}

export async function handleToolbox(req: VercelRequest, res: VercelResponse) {
  // Allow both GET and POST
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const server = decodeQueryValue(req.query.server) || req.body.server;
  const mode = decodeQueryValue(req.query.mode) || req.body.mode;

  if (mode === 'almanax') {
    return handleAlmanax(req, res);
  }

  if (!server) {
    return res.status(400).json({ error: 'server_required' });
  }

  try {
    if (mode === 'consumables') {
      // 1. Get all items that have Life (110) or Energy (139) effects
      const { data: effectsData, error: effectsError } = await supabase
        .from('item_effects')
        .select('item_id, effect_id, min_value, max_value')
        .in('effect_id', [110, 139]);

      if (effectsError) throw effectsError;

      if (!effectsData || effectsData.length === 0) {
        return res.json([]);
      }

      // Group effects by item_id
      const itemStats: Record<number, { life: number, energy: number }> = {};
      const itemIds = new Set<number>();

      for (const row of effectsData) {
        const id = row.item_id;
        itemIds.add(id);
        if (!itemStats[id]) itemStats[id] = { life: 0, energy: 0 };

        // For consumables, min_value is the value.
        if (row.effect_id === 110) itemStats[id].life += row.min_value;
        if (row.effect_id === 139) itemStats[id].energy += row.min_value;
      }

      const idsArray = Array.from(itemIds);

      // 2. Get Item Details (Name, Image)
      const { data: itemsData, error: itemsError } = await supabase
        .from('items')
        .select('id, name, icon_url, level')
        .in('id', idsArray);

      if (itemsError) throw itemsError;

      // 3. Get Latest Prices for these items on the server
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const { data: pricesData, error: pricesError } = await supabase
        .from('observations')
        .select('item_id, price_unit_avg, captured_at')
        .eq('server', server)
        .in('item_id', idsArray)
        .gte('captured_at', sevenDaysAgo.toISOString())
        .order('captured_at', { ascending: false });

      if (pricesError) throw pricesError;

      // Map latest price
      const priceMap: Record<number, number> = {};
      const processedItems = new Set<number>();

      if (pricesData) {
        for (const obs of pricesData) {
          if (!processedItems.has(obs.item_id)) {
            priceMap[obs.item_id] = obs.price_unit_avg;
            processedItems.add(obs.item_id);
          }
        }
      }

      // 4. Combine everything
      const result = itemsData?.map(item => {
        const stats = itemStats[item.id];
        const price = priceMap[item.id] || 0;
        
        return {
          id: item.id,
          name: item.name,
          img: item.icon_url,
          level: item.level || 1,
          stats: {
            life: stats.life,
            energy: stats.energy
          },
          price: price
        };
      }).filter(item => item.price > 0);

      return res.json(result);
    }

    if (mode === 'leveling') {
      const { job_id, from_level, to_level } = req.body;

      if (!job_id || !from_level || !to_level) {
        return res.status(400).json({ error: 'Missing parameters for leveling mode' });
      }

      const fromLevel = parseInt(from_level);
      const toLevel = parseInt(to_level);
      const jobId = parseInt(job_id);

      if (fromLevel >= toLevel) {
        return res.status(400).json({ error: 'from_level must be less than to_level' });
      }

      // 1. Fetch all relevant recipes with stats (prices)
      const { data: recipes, error } = await supabase.rpc('get_recipes_with_stats', {
        p_server: server,
        p_min_level: 1,
        p_max_level: toLevel,
        p_job_id: jobId,
        p_limit: 2000,
        p_sort_by: 'level_asc',
        p_recipe_id: null,
        p_result_item_id: null
      });

      if (error) throw error;

      if (!recipes || recipes.length === 0) {
        return res.status(404).json({ error: 'No recipes found for this job' });
      }

      // 2. Compute the plan
      const steps: LevelingStep[] = [];
      let currentLevel = fromLevel;
      let totalPlanCost = 0;
      let xpOverflow = 0; // Track XP overflow from previous level

      let currentStep: LevelingStep | null = null;

      while (currentLevel < toLevel) {
        const xpRequired = JobXpService.getXpForNextLevel(currentLevel);
        const xpRemaining = Math.max(0, xpRequired - xpOverflow); // Subtract overflow from required XP
        
        let bestRecipe = null;
        let minCostPerXp = Infinity;
        let bestXpGain = 0;

        for (const recipe of recipes) {
          if (recipe.level > currentLevel) continue;

          const xpGain = JobXpService.getXpGain(currentLevel, recipe.level, recipe.craft_xp_ratio ?? -1);
          
          if (xpGain <= 0) continue;

          const cost = recipe.craft_cost || Infinity;
          
          if (cost === Infinity) continue;

          const costPerXp = cost / xpGain;

          if (costPerXp < minCostPerXp) {
            minCostPerXp = costPerXp;
            bestRecipe = recipe;
            bestXpGain = xpGain;
          }
        }

        if (!bestRecipe) {
          console.warn("No valid recipe found at level " + currentLevel + " for job " + jobId);
          break;
        }

        // Calculate quantity based on remaining XP needed (after overflow)
        const quantity = xpRemaining > 0 ? Math.ceil(xpRemaining / bestXpGain) : 0;
        const xpGained = quantity * bestXpGain;
        const stepCost = quantity * bestRecipe.craft_cost;
        
        // Calculate overflow for next level
        xpOverflow = (xpOverflow + xpGained) - xpRequired;

        if (currentStep && currentStep.recipeId === bestRecipe.recipe_id) {
          currentStep.endLevel = currentLevel + 1;
          currentStep.quantity += quantity;
          currentStep.totalCost += stepCost;
          currentStep.totalXp += xpRequired;
        } else {
          if (currentStep) {
            steps.push(currentStep);
          }
          currentStep = {
            startLevel: currentLevel,
            endLevel: currentLevel + 1,
            recipeId: bestRecipe.recipe_id,
            recipeName: bestRecipe.result_item_name,
            recipeLevel: bestRecipe.level,
            quantity: quantity,
            xpPerCraft: bestXpGain,
            costPerCraft: bestRecipe.craft_cost,
            totalCost: stepCost,
            totalXp: xpRequired,
            imgUrl: bestRecipe.result_item_icon
          };
        }

        totalPlanCost += stepCost;
        currentLevel++;
      }

      if (currentStep) {
        steps.push(currentStep);
      }

      // 3. Enrich with ingredients
      const recipeIds = Array.from(new Set(steps.map(s => s.recipeId)));
      
      if (recipeIds.length > 0) {
        const { data: ingredientsData, error: ingredientsError } = await supabase
          .from('recipe_ingredients')
          .select(`
            recipe_id,
            quantity,
            items (
              id,
              name,
              icon_url
            )
          `)
          .in('recipe_id', recipeIds);

        if (!ingredientsError && ingredientsData) {
          const ingredientsMap: Record<number, Ingredient[]> = {};
          const allIngredientIds = new Set<number>();
          
          for (const row of ingredientsData) {
            const rid = row.recipe_id;
            if (!ingredientsMap[rid]) ingredientsMap[rid] = [];
            
            // @ts-ignore
            const itemData = row.items;
            const item = Array.isArray(itemData) ? itemData[0] : itemData;

            if (item) {
                allIngredientIds.add(item.id);
                ingredientsMap[rid].push({
                    id: item.id,
                    name: item.name,
                    imgUrl: item.icon_url,
                    quantity: row.quantity,
                    price: 0
                });
            }
          }

          // Fetch prices for ingredients
          if (allIngredientIds.size > 0) {
            const { data: pricesData } = await supabase
                .from('observations')
                .select('item_id, price_unit_avg')
                .eq('server', server)
                .in('item_id', Array.from(allIngredientIds))
                .order('captured_at', { ascending: false });

            const priceMap: Record<number, number> = {};
            if (pricesData) {
                const seen = new Set<number>();
                for (const p of pricesData) {
                    if (!seen.has(p.item_id)) {
                        priceMap[p.item_id] = p.price_unit_avg;
                        seen.add(p.item_id);
                    }
                }
            }

            // Assign prices
            for (const rid in ingredientsMap) {
                for (const ing of ingredientsMap[rid]) {
                    ing.price = priceMap[ing.id] || 0;
                }
            }
          }

          for (const step of steps) {
            step.ingredients = ingredientsMap[step.recipeId] || [];
          }
        }
      }

      const plan: LevelingPlan = {
        jobId,
        fromLevel,
        toLevel: currentLevel,
        totalCost: totalPlanCost,
        steps
      };

      return res.status(200).json(plan);
    }

    return res.status(400).json({ error: 'invalid_mode' });

  } catch (error: any) {
    console.error('Error in toolbox:', error);
    return res.status(500).json({ error: error.message });
  }
}
