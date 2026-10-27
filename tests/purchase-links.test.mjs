import test from 'node:test';
import assert from 'node:assert/strict';
import { shoppingSearchLinks } from '../src/lib/purchase-links.mjs';

test('shopping links use gift preferences without disclosing banking or delivery details', () => {
  const links = shoppingSearchLinks({
    budget: { amount_minor: 100000, currency: 'CNY' }, funding_account_ref: 'private-account',
    date_expression: '2026-11-01 09:00-12:00', items: [{ category: 'flowers', quantity: 1 }, { category: 'cake', quantity: 1 }],
    preferences: { flower_colors: ['粉色'], flower_materials: ['玫瑰'], cake_flavors: ['水果'], cake_servings: 6,
      ingredient_exclusions: ['坚果'], occasion: 'private-recipient' },
  });
  assert.equal(links.length, 2);
  for (const link of links) {
    const url = new URL(link.url);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname, 'search.jd.com');
    assert.equal(url.pathname, '/Search');
    assert.doesNotMatch(link.url, /private-account|private-recipient|100000|2026-11-01|坚果/);
  }
  assert.match(links[0].query, /鲜花.*粉色.*玫瑰/);
  assert.match(links[1].query, /蛋糕.*水果.*6人/);
  assert.deepEqual(links[1].check_before_order, ['坚果']);
});

test('unknown category cannot turn a user preference into an arbitrary destination', () => {
  assert.deepEqual(shoppingSearchLinks({ items: [{ category: 'https://evil.example', quantity: 1 }] }), []);
});

test('unrecognized free text never leaks into external search URLs', () => {
  const [link] = shoppingSearchLinks({ items: [{ category: 'flowers', quantity: 1 }], preferences: {
    flower_colors: ['上海市某路123号', '13800000000', '粉色'], flower_materials: ['private@example.com', '玫瑰'],
  } });
  assert.match(link.query, /粉色.*玫瑰/);
  assert.doesNotMatch(link.url, /123|13800000000|private%40|example/);
});
