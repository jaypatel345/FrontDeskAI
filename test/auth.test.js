import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app, callTool } from './helpers.js';
import { config } from '../src/config.js';

const basic = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

describe('/functions/* shared secret', () => {
  test('rejects a request with no secret header', async () => {
    const res = await callTool('search-knowledge-base', { query: 'botox' }, { secret: null });
    assert.equal(res.status, 401);
  });

  test('rejects a wrong secret', async () => {
    const res = await callTool('search-knowledge-base', { query: 'botox' }, { secret: 'wrong' });
    assert.equal(res.status, 401);
  });

  test('accepts the right secret', async () => {
    const res = await callTool('search-knowledge-base', { query: 'botox' });
    assert.equal(res.status, 200);
  });

  test('fails closed in production when no secret is configured', async () => {
    const saved = config.functionsSecret;
    config.functionsSecret = null;
    try {
      const res = await callTool('search-knowledge-base', { query: 'botox' }, { secret: 'anything' });
      assert.equal(res.status, 401);
    } finally {
      config.functionsSecret = saved;
    }
  });
});

describe('dashboard basic auth', () => {
  for (const path of ['/dashboard', '/api/dashboard/stats', '/api/dashboard/calls']) {
    test(`${path} asks for a login without credentials`, async () => {
      const res = await request(app).get(path);
      assert.equal(res.status, 401);
      assert.match(res.headers['www-authenticate'], /^Basic/);
    });
  }

  test('rejects a wrong password', async () => {
    const res = await request(app).get('/api/dashboard/stats').set('Authorization', basic('admin', 'nope'));
    assert.equal(res.status, 401);
  });

  test('rejects a wrong username', async () => {
    const res = await request(app).get('/api/dashboard/stats').set('Authorization', basic('root', config.dashboard.password));
    assert.equal(res.status, 401);
  });

  test('serves the page and API with the right login', async () => {
    const auth = basic('admin', config.dashboard.password);
    assert.equal((await request(app).get('/dashboard').set('Authorization', auth)).status, 200);
    assert.equal((await request(app).get('/api/dashboard/stats').set('Authorization', auth)).status, 200);
  });

  test('/health stays public', async () => {
    assert.equal((await request(app).get('/health')).status, 200);
  });
});
