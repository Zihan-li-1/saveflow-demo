// Entirely synthetic: no actual merchant, inventory or offer is represented.
export const giftCatalog = ['flowers', 'cake'].flatMap(category => Array.from({ length: 8 }, (_, i) => ({
  product_ref: `demo_${category}_${i + 1}`, sku_ref: `demo_${category}_${i + 1}_standard`,
  merchant_ref: category === 'flowers' ? 'demo_merchant_flower' : 'demo_merchant_cake', merchant_name: category === 'flowers' ? '演示鲜花店' : '演示蛋糕店', category,
  name: category === 'flowers' ? ['粉色玫瑰花束', '白色郁金香', '向日葵花束', '混色康乃馨', '百合花束', '简约花盒', '异地花束', '限量花盒'][i] : ['水果蛋糕', '巧克力蛋糕', '草莓蛋糕', '坚果蛋糕', '香草蛋糕', '派对蛋糕', '异地蛋糕', '限量蛋糕'][i],
  price_minor: (category === 'flowers' ? 30000 : 40000) + i * 2000,
  delivery_fee_minor: 1500, packaging_fee_minor: 0, inventory: i === 7 ? 0 : 10,
  regions: [i === 6 ? 'demo-other-region' : 'demo-shanghai'], allergens_known: i !== 4,
  ingredients: category === 'cake' ? (i === 3 ? ['milk', 'egg', 'wheat', 'nuts'] : ['milk', 'egg', 'wheat']) : [],
  color: ['pink', 'white', 'yellow', 'mixed', 'white', 'pink', 'white', 'pink'][i],
  material: ['rose', 'tulip', 'sunflower', 'carnation', 'lily', 'rose', 'tulip', 'rose'][i],
  scent: i === 4 ? 'strong' : 'light', flavor: ['fruit', 'chocolate', 'strawberry', 'nuts', 'vanilla', 'fruit', 'fruit', 'fruit'][i], servings: 6,
  canonical_url: `/products/demo_${category}_${i + 1}`, synthetic_demo_only: true,
})));
