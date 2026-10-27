/** Unknown facts never satisfy an explicitly requested hard restriction. */
export function matchesGiftPreferences(p, pref = {}) {
  if (p.category === 'flowers') return (!pref.flower_colors?.length || pref.flower_colors.includes(p.color)) &&
    (!pref.flower_materials?.length || pref.flower_materials.includes(p.material)) && !pref.flower_exclusions?.includes(p.material) &&
    (!pref.scent_preference || pref.scent_preference === 'any' || p.scent === pref.scent_preference);
  const aliases = { nuts: 'nuts', 坚果: 'nuts', 花生: 'nuts', milk: 'milk', 牛奶: 'milk', 乳制品: 'milk', egg: 'egg', 鸡蛋: 'egg', wheat: 'wheat', 小麦: 'wheat' };
  const exclusions = (pref.ingredient_exclusions ?? []).map(x => Object.hasOwn(aliases, x) ? aliases[x] : undefined);
  if (exclusions.some(x => x === undefined)) return false;
  return (!exclusions.length || (p.allergens_known && !exclusions.some(x => p.ingredients.includes(x)))) &&
    (!pref.cake_flavors?.length || pref.cake_flavors.includes(p.flavor)) && (!pref.cake_servings || p.servings >= pref.cake_servings);
}
