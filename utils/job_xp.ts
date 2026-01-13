
/**
 * Service de calcul d'XP pour les métiers Dofus (2.70+)
 * 
 * Formule validée par tests en jeu (Janvier 2026) :
 * XP = trunc((20 × craftXpRatio/100) × recipeLevel / (1 + 0.1 × delta^1.1))
 * 
 * Source : https://www.dofus.com/fr/forum/1782-dofus/2350232-formule-calcul-xp-metier-craft
 */

export class JobXpService {
  
  /**
   * Calcule l'XP totale requise pour atteindre un niveau donné.
   * Formule : 10 * L * (L-1)
   */
  static getTotalXpAtLevel(level: number): number {
    if (level <= 1) return 0;
    return 10 * level * (level - 1);
  }

  /**
   * Calcule l'XP requise pour passer du niveau L au niveau L+1.
   * Formule : 20 * L
   */
  static getXpForNextLevel(level: number): number {
    return 20 * level;
  }

  /**
   * Calcule le gain d'XP estimé pour une recette.
   * 
   * Formule : XP = trunc((20 × craftXpRatio/100) × recipeLevel × penaltyFactor)
   * 
   * @param jobLevel Niveau actuel du métier
   * @param recipeLevel Niveau de la recette
   * @param craftXpRatio Ratio d'XP de l'item (depuis DofusDB, fallback 100 si -1)
   */
  static getXpGain(jobLevel: number, recipeLevel: number, craftXpRatio: number): number {
    if (jobLevel < recipeLevel) return 0;

    // Coefficient = 20 × (ratio / 100)
    // Si ratio = -1 ou invalide, utiliser 100 (standard)
    const ratio = (craftXpRatio > 0) ? craftXpRatio : 100;
    const coefficient = 20 * (ratio / 100);
    
    const baseXp = coefficient * recipeLevel;
    const delta = jobLevel - recipeLevel;
    const penaltyFactor = this.getPenaltyFactor(delta);

    return Math.floor(baseXp * penaltyFactor);
  }

  /**
   * Calcule le facteur de pénalité en fonction de l'écart de niveau.
   * 
   * Formule validée : 1 / (1 + 0.1 × delta^1.1)
   */
  private static getPenaltyFactor(delta: number): number {
    if (delta <= 0) return 1;
    return 1 / (1 + 0.1 * Math.pow(delta, 1.1));
  }
}
