/* eslint-disable @typescript-eslint/no-require-imports -- Tiny deterministic hook host; no new browser/test framework dependency. */
const Module = require('node:module');

// Runs the production hook, replacing only React's scheduling primitives.
// HTTP, clients, intent validation, Skills and Core are supplied separately by tests.
function mountSaveflow() {
  const values = []; let cursor = 0;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial;
      return [values[index], next => { values[index] = typeof next === 'function' ? next(values[index]) : next; }];
    },
    useRef(initial) { const index = cursor++; return values[index] ??= { current: initial }; },
    useEffect() { /* Hydration and storage are tested separately; no timers in this host. */ },
  };
  const load = Module._load;
  delete require.cache[require.resolve('../../src/lib/use-saveflow.ts')];
  try {
    Module._load = function (name, parent, ...rest) {
      return name === 'react' && parent?.filename.endsWith('use-saveflow.ts') ? hooks : load.call(this, name, parent, ...rest);
    };
    const { useSaveflow } = require('../../src/lib/use-saveflow.ts');
    const host = { current: undefined, render() { cursor = 0; return this.current = useSaveflow(); } };
    host.render(); host.current.setConsent(true); host.current.setAccessCode('recovery-test-access-1234'); host.render();
    return host;
  } finally { Module._load = load; }
}
module.exports = { mountSaveflow };
