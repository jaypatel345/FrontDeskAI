import { test } from 'node:test';
import assert from 'node:assert/strict';

// Each test file runs in its own process, so this low limit doesn't affect the other files.
process.env.FUNCTIONS_RATE_LIMIT_PER_MINUTE = '5';
const { callTool } = await import('./helpers.js');

test('/functions/* returns 429 once the per-minute limit is used up', async () => {
  for (let i = 0; i < 5; i++) {
    assert.equal((await callTool('search-knowledge-base', { query: 'botox' })).status, 200);
  }
  const blocked = await callTool('search-knowledge-base', { query: 'botox' });
  assert.equal(blocked.status, 429);
});

test('requests with a wrong secret count toward the limit too', async () => {
  const res = await callTool('search-knowledge-base', { query: 'botox' }, { secret: 'guess' });
  assert.equal(res.status, 429);
});
