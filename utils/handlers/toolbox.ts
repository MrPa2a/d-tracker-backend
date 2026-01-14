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
      const { 
        job_id, 
        from_level, 
        to_level, 
        max_quantity_per_recipe, 
        penalty_mode,
        // Custom penalty parameters (override preset if provided)
        custom_alpha,
        custom_threshold,
        custom_min_batch,
        custom_max_resource_usage
      } = req.body;

      if (!job_id || !from_level || !to_level) {
        return res.status(400).json({ error: 'Missing parameters for leveling mode' });
      }

      const fromLevel = parseInt(from_level);
      const toLevel = parseInt(to_level);
      const jobId = parseInt(job_id);
      const maxQtyPerRecipe = max_quantity_per_recipe ? parseInt(max_quantity_per_recipe) : null;
      
      // Penalty mode: 'none', 'low', 'medium', 'high'
      // Simulates HDV price increase when buying large quantities
      // minBatch: minimum crafts to commit to before reconsidering (prevents recipe oscillation)
      // maxResourceUsage: maximum total usage of any single ingredient (simulates HDV stock limit)
      // 
      // Design principle: higher penalty = stricter constraints = higher cost
      // maxResourceUsage / threshold ratio kept constant (~3x) so max penalty before exhaustion is similar
      // But higher modes have lower absolute limits, forcing more diversification
      const penaltyConfig = {
        none: { alpha: 0, threshold: Infinity, minBatch: 1, maxResourceUsage: Infinity },
        low: { alpha: 0.3, threshold: 3000, minBatch: 100, maxResourceUsage: 8000 },
        medium: { alpha: 0.5, threshold: 2000, minBatch: 75, maxResourceUsage: 5000 },
        high: { alpha: 0.8, threshold: 1200, minBatch: 50, maxResourceUsage: 3000 }
      };
      
      // Start with preset, then apply custom overrides
      const basePreset = penaltyConfig[penalty_mode as keyof typeof penaltyConfig] || penaltyConfig.none;
      const activePenalty = {
        alpha: custom_alpha !== undefined ? parseFloat(custom_alpha) : basePreset.alpha,
        threshold: custom_threshold !== undefined ? parseInt(custom_threshold) : basePreset.threshold,
        minBatch: custom_min_batch !== undefined ? parseInt(custom_min_batch) : basePreset.minBatch,
        maxResourceUsage: custom_max_resource_usage !== undefined ? parseInt(custom_max_resource_usage) : basePreset.maxResourceUsage
      };

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

      // 1b. If penalty mode is active, preload ingredients and prices for dynamic cost calculation
      interface RecipeIngredient {
        itemId: number;
        quantity: number;
        basePrice: number;
      }
      const recipeIngredientsMap: Map<number, RecipeIngredient[]> = new Map();
      const ingredientUsage: Map<number, number> = new Map(); // Track cumulative usage per ingredient
      
      if (activePenalty.alpha > 0) {
        // Fetch all ingredients for all recipes
        const recipeIds = recipes.map((r: { recipe_id: number }) => r.recipe_id);
        const { data: ingredientsData } = await supabase
          .from('recipe_ingredients')
          .select('recipe_id, item_id, quantity')
          .in('recipe_id', recipeIds);
        
        if (ingredientsData) {
          // Get unique ingredient IDs
          const ingredientIds = [...new Set(ingredientsData.map(i => i.item_id))];
          
          // Fetch prices for all ingredients
          const { data: pricesData } = await supabase
            .from('observations')
            .select('item_id, price_unit_avg')
            .eq('server', server)
            .in('item_id', ingredientIds)
            .order('captured_at', { ascending: false });
          
          // Build price map (latest price per item)
          const priceMap: Map<number, number> = new Map();
          if (pricesData) {
            for (const p of pricesData) {
              if (!priceMap.has(p.item_id)) {
                priceMap.set(p.item_id, p.price_unit_avg);
              }
            }
          }
          
          // Build ingredients map per recipe
          for (const ing of ingredientsData) {
            if (!recipeIngredientsMap.has(ing.recipe_id)) {
              recipeIngredientsMap.set(ing.recipe_id, []);
            }
            recipeIngredientsMap.get(ing.recipe_id)!.push({
              itemId: ing.item_id,
              quantity: ing.quantity,
              basePrice: priceMap.get(ing.item_id) || 0
            });
          }
        }
      }
      
      // Helper function to calculate penalized cost for a recipe
      const calculatePenalizedCost = (recipeId: number, baseCraftCost: number, craftQuantity: number): number => {
        if (activePenalty.alpha === 0) {
          return baseCraftCost * craftQuantity;
        }
        
        const ingredients = recipeIngredientsMap.get(recipeId);
        if (!ingredients || ingredients.length === 0) {
          return baseCraftCost * craftQuantity;
        }
        
        let totalPenalizedCost = 0;
        
        for (const ing of ingredients) {
          const currentUsage = ingredientUsage.get(ing.itemId) || 0;
          const ingQuantityNeeded = ing.quantity * craftQuantity;
          
          // Calculate average penalty across the quantity range
          // Integral of (1 + α * x/threshold) from currentUsage to currentUsage + ingQuantityNeeded
          // = ingQuantityNeeded + α/threshold * (currentUsage*ingQuantityNeeded + ingQuantityNeeded²/2)
          const { alpha, threshold } = activePenalty;
          const avgMultiplier = 1 + alpha * (currentUsage + ingQuantityNeeded / 2) / threshold;
          
          totalPenalizedCost += ing.basePrice * ingQuantityNeeded * avgMultiplier;
        }
        
        return totalPenalizedCost;
      };
      
      // Helper function to update ingredient usage after crafting
      const updateIngredientUsage = (recipeId: number, craftQuantity: number) => {
        if (activePenalty.alpha === 0) return;
        
        const ingredients = recipeIngredientsMap.get(recipeId);
        if (!ingredients) return;
        
        for (const ing of ingredients) {
          const currentUsage = ingredientUsage.get(ing.itemId) || 0;
          ingredientUsage.set(ing.itemId, currentUsage + ing.quantity * craftQuantity);
        }
      };

      // 2. Compute the plan
      const steps: LevelingStep[] = [];
      let currentLevel = fromLevel;
      let totalPlanCost = 0;
      let xpOverflow = 0; // Track XP overflow from previous level
      
      // Track quantity used per recipe for limiting
      const recipeUsage: Map<string, number> = new Map();

      let currentStep: LevelingStep | null = null;
      
      // Stability threshold: only switch recipes if new one is X% better
      // This prevents micro-oscillations between recipes with similar cost/XP
      const STABILITY_THRESHOLD = 0.05; // 5% improvement required to switch
      let lastChosenRecipeId: number | null = null;

      while (currentLevel < toLevel) {
        const xpRequired = JobXpService.getXpForNextLevel(currentLevel);
        let xpRemaining = Math.max(0, xpRequired - xpOverflow); // Subtract overflow from required XP
        
        // Helper: check how many crafts are possible before any ingredient is exhausted
        const getMaxCraftableBeforeExhaustion = (recipeId: number): number => {
          if (activePenalty.maxResourceUsage === Infinity) return Infinity;
          const ingredients = recipeIngredientsMap.get(recipeId);
          if (!ingredients || ingredients.length === 0) return Infinity;
          
          let maxCrafts = Infinity;
          for (const ing of ingredients) {
            const currentUsage = ingredientUsage.get(ing.itemId) || 0;
            const remainingResource = activePenalty.maxResourceUsage - currentUsage;
            if (remainingResource <= 0) return 0; // Ingredient exhausted
            const craftsWithThisIng = Math.floor(remainingResource / ing.quantity);
            maxCrafts = Math.min(maxCrafts, craftsWithThisIng);
          }
          return maxCrafts;
        };
        
        // Inner loop: we may need multiple recipes to complete one level if limits apply
        while (xpRemaining > 0) {
          let bestRecipe = null;
          let minCostPerXp = Infinity;
          let bestXpGain = 0;
          let bestRemainingQuota = Infinity;
          
          // Track current recipe's cost/XP for stability comparison
          let currentRecipeCostPerXp = Infinity;

          for (const recipe of recipes) {
            if (recipe.level > currentLevel) continue;
            
            // In realistic mode only: skip recipes with too large level gap
            // (XP penalty makes them inefficient AND it's unrealistic to craft low-level items at high levels)
            // In optimal mode, we want pure cost optimization regardless of level gap
            const levelDelta = currentLevel - recipe.level;
            if (activePenalty.alpha > 0 && levelDelta > 50) continue;
            
            // Check remaining quota for this recipe
            let remainingQuota = Infinity;
            if (maxQtyPerRecipe !== null) {
              const used = recipeUsage.get(recipe.recipe_id) || 0;
              remainingQuota = maxQtyPerRecipe - used;
              if (remainingQuota <= 0) continue; // Skip exhausted recipes
            }
            
            // Check if any ingredient is exhausted (resource limit reached)
            const maxCraftable = getMaxCraftableBeforeExhaustion(recipe.recipe_id);
            if (maxCraftable <= 0) continue; // Skip recipes with exhausted ingredients
            remainingQuota = Math.min(remainingQuota, maxCraftable);

            const xpGain = JobXpService.getXpGain(currentLevel, recipe.level, recipe.craft_xp_ratio ?? -1);
            
            if (xpGain <= 0) continue;

            const baseCost = recipe.craft_cost;
            
            // Skip recipes with no cost data (0 or null/undefined)
            if (!baseCost || baseCost <= 0) continue;

            // For penalty mode, estimate the cost including penalty for a batch
            // Use minBatch for comparison to get realistic cost when committing to multiple crafts
            let effectiveCostPerUnit = baseCost;
            if (activePenalty.alpha > 0) {
              const estimatedQty = Math.max(1, Math.min(activePenalty.minBatch, remainingQuota));
              const batchCost = calculatePenalizedCost(recipe.recipe_id, baseCost, estimatedQty);
              effectiveCostPerUnit = batchCost / estimatedQty;
            }

            const costPerXp = effectiveCostPerUnit / xpGain;
            
            // Track current recipe's cost/XP for stability comparison
            if (lastChosenRecipeId === recipe.recipe_id) {
              currentRecipeCostPerXp = costPerXp;
            }

            if (costPerXp < minCostPerXp) {
              minCostPerXp = costPerXp;
              bestRecipe = recipe;
              bestXpGain = xpGain;
              bestRemainingQuota = remainingQuota;
            }
          }

          if (!bestRecipe) {
            console.warn("No valid recipe found at level " + currentLevel + " for job " + jobId);
            break;
          }
          
          // Apply stability: if current recipe is still valid and close enough in cost, keep it
          if (lastChosenRecipeId !== null && 
              lastChosenRecipeId !== bestRecipe.recipe_id && 
              currentRecipeCostPerXp < Infinity) {
            // Only switch if new recipe is at least STABILITY_THRESHOLD better
            const improvementRatio = (currentRecipeCostPerXp - minCostPerXp) / currentRecipeCostPerXp;
            if (improvementRatio < STABILITY_THRESHOLD) {
              // Keep the current recipe instead
              const currentRecipe = recipes.find((r: { recipe_id: number }) => r.recipe_id === lastChosenRecipeId);
              if (currentRecipe) {
                // Recalculate for current recipe
                const currXpGain = JobXpService.getXpGain(currentLevel, currentRecipe.level, currentRecipe.craft_xp_ratio ?? -1);
                let currRemainingQuota = Infinity;
                if (maxQtyPerRecipe !== null) {
                  const used = recipeUsage.get(currentRecipe.recipe_id) || 0;
                  currRemainingQuota = maxQtyPerRecipe - used;
                }
                const currMaxCraftable = getMaxCraftableBeforeExhaustion(currentRecipe.recipe_id);
                currRemainingQuota = Math.min(currRemainingQuota, currMaxCraftable);
                
                if (currXpGain > 0 && currRemainingQuota > 0) {
                  bestRecipe = currentRecipe;
                  bestXpGain = currXpGain;
                  bestRemainingQuota = currRemainingQuota;
                }
              }
            }
          }
          
          // Update last chosen recipe
          lastChosenRecipeId = bestRecipe.recipe_id;

          // Calculate quantity needed to complete remaining XP
          let quantity = Math.ceil(xpRemaining / bestXpGain);
          
          // Apply minimum batch to prevent recipe oscillation in penalty mode
          // Once we choose a recipe, commit to at least minBatch crafts
          // BUT: limit minBatch to avoid absurd over-crafting (max 3x needed quantity)
          // EXCEPTION: Don't apply minBatch on the last level to avoid wasting kamas on useless overflow
          const isLastLevel = currentLevel >= toLevel - 1;
          if (!isLastLevel && activePenalty.minBatch > 1 && quantity < activePenalty.minBatch) {
            // Only apply minBatch if we have enough quota and it makes sense
            const proposedBatch = Math.min(activePenalty.minBatch, bestRemainingQuota);
            // Cap minBatch to max 3x the needed quantity to avoid massive overflow
            const cappedBatch = Math.min(proposedBatch, Math.max(quantity * 3, 10));
            if (cappedBatch > quantity) {
              quantity = cappedBatch;
            }
          }
          
          // Cap by remaining quota if limit applies
          if (maxQtyPerRecipe !== null && quantity > bestRemainingQuota) {
            quantity = bestRemainingQuota;
          }
          
          if (quantity <= 0) break;
          
          const xpGained = quantity * bestXpGain;
          
          // Calculate actual cost with penalty applied
          const stepCost = activePenalty.alpha > 0 
            ? calculatePenalizedCost(bestRecipe.recipe_id, bestRecipe.craft_cost, quantity)
            : quantity * bestRecipe.craft_cost;
          
          // Update ingredient usage for penalty tracking
          updateIngredientUsage(bestRecipe.recipe_id, quantity);
          
          // Track recipe usage for limiting
          const currentUsage = recipeUsage.get(bestRecipe.recipe_id) || 0;
          recipeUsage.set(bestRecipe.recipe_id, currentUsage + quantity);
          
          // Subtract from remaining XP for this level
          xpRemaining -= xpGained;

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
        }
        
        // Calculate overflow for next level
        // If we skipped this level entirely due to overflow, propagate remaining overflow
        const xpRequiredForLevel = JobXpService.getXpForNextLevel(currentLevel);
        if (xpOverflow > xpRequiredForLevel) {
          // Level was skipped - subtract this level's requirement from overflow
          xpOverflow = xpOverflow - xpRequiredForLevel;
          // Update endLevel of current step to reflect skipped levels
          if (currentStep) {
            currentStep.endLevel = currentLevel + 1;
          }
        } else if (xpRemaining < 0) {
          // We over-crafted - new overflow is the excess
          xpOverflow = -xpRemaining;
        } else {
          // Exactly finished or under-crafted (should not happen with correct logic)
          xpOverflow = 0;
        }

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
