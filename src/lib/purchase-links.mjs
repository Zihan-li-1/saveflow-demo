const words = value => Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()).slice(0, 5).map(item => item.trim().slice(0, 80)) : [];
const searchTerms = {
  flower_colors: { pink: '粉色', white: '白色', yellow: '黄色', mixed: '混色', '粉色': '粉色', '白色': '白色', '黄色': '黄色', '混色': '混色' },
  flower_materials: { rose: '玫瑰', tulip: '郁金香', sunflower: '向日葵', carnation: '康乃馨', lily: '百合', '玫瑰': '玫瑰', '郁金香': '郁金香', '向日葵': '向日葵', '康乃馨': '康乃馨', '百合': '百合' },
  cake_flavors: { fruit: '水果', chocolate: '巧克力', strawberry: '草莓', vanilla: '香草', '水果': '水果', '巧克力': '巧克力', '草莓': '草莓', '香草': '香草' },
};
const allowed = (value, field) => words(value).map(word => searchTerms[field][word]).filter(Boolean);

/** Search links contain only shopping preferences. No account, budget, address or recipient leaves SaveFlow. */
export function shoppingSearchLinks(slots = {}) {
  const preferences = slots.preferences ?? {};
  return (slots.items ?? []).filter(item => ['flowers', 'cake'].includes(item.category)).map(item => {
    const flowers = item.category === 'flowers';
    const query = [flowers ? '鲜花花束' : '生日蛋糕',
      ...(flowers ? [...allowed(preferences.flower_colors, 'flower_colors'), ...allowed(preferences.flower_materials, 'flower_materials')]
        : [...allowed(preferences.cake_flavors, 'cake_flavors'), Number.isSafeInteger(preferences.cake_servings) && preferences.cake_servings >= 1 && preferences.cake_servings <= 100 ? `${preferences.cake_servings}人` : ''])]
      .filter(Boolean).slice(0, 11).join(' ');
    const url = new URL('https://search.jd.com/Search');
    url.searchParams.set('keyword', query);
    return { category: item.category, label: flowers ? '在京东搜索鲜花' : '在京东搜索蛋糕', query, url: url.toString(),
      check_before_order: flowers ? words(preferences.flower_exclusions) : words(preferences.ingredient_exclusions) };
  });
}
