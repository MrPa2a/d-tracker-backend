
/**
 * Service de calcul d'XP pour les métiers Dofus (2.70+)
 * Basé sur des relevés empiriques et l'analyse communautaire.
 */

export interface JobXpConfig {
  // Coefficient multiplicateur pour l'XP de base
  // 20 pour les métiers de craft (Bijoutier, Cordonnier, etc.)
  // 1 pour les métiers de récolte/consommable (Paysan, etc.)
  xpCoefficient: number;
}

// Configuration par défaut par métier (ID Dofus)
// À compléter avec les IDs exacts
export const JOB_CONFIGS: Record<number, JobXpConfig> = {
  // Métiers de Craft
  16: { xpCoefficient: 20 }, // Bijoutier
  27: { xpCoefficient: 20 }, // Tailleur
  15: { xpCoefficient: 20 }, // Cordonnier
  11: { xpCoefficient: 20 }, // Forgeron
  13: { xpCoefficient: 20 }, // Sculpteur
  65: { xpCoefficient: 20 }, // Bricoleur
  60: { xpCoefficient: 20 }, // Façonneur
  
  // Métiers de Récolte/Craft (Ajustements empiriques)
  24: { xpCoefficient: 12 }, // Mineur (Ajusté suite aux retours: Ferrite/Eau OK, Aluminite surestimé avec 20)
  2: { xpCoefficient: 12 },  // Bûcheron (Similaire mineur pour les planches/substrats)
  
  // Métiers de Récolte/Consommable
  28: { xpCoefficient: 5 }, // Paysan (Ajusté: Farine Xavier ~200xp vs 960xp théorique)
  26: { xpCoefficient: 5 }, // Alchimiste
  36: { xpCoefficient: 5 }, // Pêcheur
  41: { xpCoefficient: 5 }, // Chasseur
};

export const DEFAULT_JOB_CONFIG: JobXpConfig = { xpCoefficient: 20 };

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
   * @param jobLevel Niveau actuel du métier
   * @param recipeLevel Niveau de la recette
   * @param jobId ID du métier (pour déterminer le coefficient)
   * @param recipeName Nom de la recette (optionnel, pour affiner le coefficient)
   * @param craftXpRatio Ratio d'XP spécifique à l'item (optionnel, prioritaire)
   */
  static getXpGain(jobLevel: number, recipeLevel: number, jobId: number, recipeName?: string, craftXpRatio?: number): number {
    // Si le niveau du métier est inférieur au niveau de la recette, on ne peut pas la crafter
    if (jobLevel < recipeLevel) return 0;

    // Base standard : 20 XP par niveau de recette
    const STANDARD_COEFF = 20;
    let xpCoefficient = STANDARD_COEFF;

    // Gestion du craftXpRatio (Pourcentage du standard)
    // 100 = 100% (Standard) => 20
    // 5 = 5% (Consommable) => 1
    // -1 ou undefined => 100% (Standard par défaut)
    
    let ratioPercentage = 100;

    if (craftXpRatio !== undefined && craftXpRatio > 0) {
      ratioPercentage = craftXpRatio;
    } 
    // Si pas de ratio DB, on assume Standard (100%)
    // Les exceptions manuelles sont supprimées car DofusDB est la source de vérité.

    xpCoefficient = STANDARD_COEFF * (ratioPercentage / 100);
    
    // XP de base = Coeff * Niveau Recette
    const baseXp = xpCoefficient * recipeLevel;

    // Calcul de la pénalité
    const delta = jobLevel - recipeLevel;
    const penaltyFactor = this.getPenaltyFactor(delta);

    return Math.floor(baseXp * penaltyFactor);
  }

  /**
   * Calcule le facteur de pénalité en fonction de l'écart de niveau.
   * Interpolation linéaire entre les points de données relevés.
   */
  private static getPenaltyFactor(delta: number): number {
    if (delta < 0) return 0; // Impossible théoriquement
    if (delta === 0) return 1.0;

    // Points de données (Delta, Ratio)
    // Basés sur les relevés Bijoutier/Mineur qui semblent les plus stables
    const points = [
      { d: 0, r: 1.0 },
      { d: 1, r: 0.9 },
      { d: 5, r: 0.65 }, // Interpolé
      { d: 10, r: 0.45 },
      { d: 20, r: 0.25 },
      { d: 30, r: 0.15 },
      { d: 40, r: 0.1 },
      { d: 100, r: 0 } // Asymptote vers 0
    ];

    // Trouver les deux points entourant le delta
    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];

      if (delta >= p1.d && delta <= p2.d) {
        // Interpolation linéaire
        const t = (delta - p1.d) / (p2.d - p1.d);
        return p1.r + t * (p2.r - p1.r);
      }
    }

    return 0;
  }
}
