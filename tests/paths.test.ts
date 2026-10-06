import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBasePath, publicPath } from '../shared/paths';

test('public paths support both localhost root and a stripped reverse-proxy prefix', () => {
  for (const resource of ['api/config', 'api/login', 'api/live', 'pcm-worklet.js']) {
    assert.equal(publicPath('/', resource), `/${resource}`);
    assert.equal(publicPath('/translation', resource), `/translation/${resource}`);
    assert.equal(publicPath('/translation/', `/${resource}`), `/translation/${resource}`);
  }
});

test('base paths reject values unsafe for URLs and cookie paths', () => {
  assert.equal(normalizeBasePath(''), '/');
  for (const path of ['translation', '//example.com', '/translation/../', '/x; Secure', '/x?query', '/x\n']) {
    assert.throws(() => normalizeBasePath(path));
  }
});
