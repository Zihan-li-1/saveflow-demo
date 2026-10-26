export function nextPurchaseQuestion(slots) {
  const prefs = slots.preferences ?? {}, items = slots.items ?? [];
  const flower = items.some(i => i.category === 'flowers'), cake = items.some(i => i.category === 'cake');
  const prompts = [
    [cake, 'ingredient_exclusions', '蛋糕有哪些需要避开的原料？明确没有时可说“原料不限”；不确定可以先浏览，但不能认定过敏原安全。'],
    [cake, 'cake_servings', '蛋糕大约供几个人分享？'],
    [cake, 'cake_flavors', '蛋糕喜欢什么口味？例如水果、巧克力，或明确说口味不限。'],
    [flower, 'flower_materials', '鲜花喜欢哪些花材？例如玫瑰、郁金香，或明确说花材不限。'],
    [flower, 'flower_colors', '鲜花希望什么颜色？例如粉色、白色、黄色或混色。'],
    [flower, 'scent_preference', '香味有要求吗？例如不要香味、淡香或不限。'],
  ];
  return prompts.find(([relevant, field]) => relevant && !Object.hasOwn(prefs, field))?.[2] ?? '已记录这些偏好。可以浏览候选，也可继续告诉我需要纠正的地方。';
}
const values = { pink: '粉色', white: '白色', yellow: '黄色', mixed: '混色', rose: '玫瑰', tulip: '郁金香', sunflower: '向日葵', carnation: '康乃馨', lily: '百合',
  none: '无香', light: '淡香', any: '不限', fruit: '水果', chocolate: '巧克力', strawberry: '草莓', vanilla: '香草', nuts: '坚果', milk: '乳制品', egg: '鸡蛋', wheat: '小麦' };
export function purchaseValueLabel(value) {
  if (Array.isArray(value)) return value.length ? value.map(purchaseValueLabel).join('、') : '明确不限';
  return typeof value === 'string' && Object.hasOwn(values, value) ? values[value] : String(value);
}
