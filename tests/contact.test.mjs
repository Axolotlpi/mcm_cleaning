import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import Mailgun from 'mailgun.js';
import { handler } from '../netlify/functions/contact.mjs';

const valid = { name: 'Test User', email: 'visitor@example.com', phone: '5550100', service: 'Cleaning', message: 'Test only' };
const event = (body = valid) => ({ httpMethod: 'POST', body: JSON.stringify(body) });
let savedEnv, calls, logs, failure;
beforeEach(() => {
  savedEnv = { ...process.env };
  Object.assign(process.env, { MG_KEY: 'fake-secret-sentinel', MG_DOMAIN: 'mg.example.com', MG_FROM: 'sender@example.com', MG_TO: 'owner@example.com' });
  delete process.env.MG_TEMPLATE;
  calls = []; logs = []; failure = null;
  for (const method of ['log', 'error', 'warn']) mock.method(console, method, (...args) => logs.push(inspect(args)));
  mock.method(Mailgun.prototype, 'client', () => ({ messages: { create: async (domain, data) => {
    calls.push({ domain, data });
    if (failure) throw failure;
    return { id: 'test-message' };
  } } }));
});
afterEach(() => {
  mock.restoreAll();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

test('successful submission never logs environment secrets', async () => {
  const response = await handler(event());
  assert.equal(response.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(logs.join('').includes('fake-secret-sentinel'), false);
});

test('provider failures do not leak credentials through SDK errors', async () => {
  failure = Object.assign(new Error('fake-secret-sentinel'), { status: 401, details: { key: 'fake-secret-sentinel' } });
  const response = await handler(event());
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.includes('fake-secret-sentinel'), false);
  assert.equal(logs.join('').includes('fake-secret-sentinel'), false);
  assert.match(logs.join(''), /401/);
});

for (const [label, request, status] of [
  ['non-POST', { httpMethod: 'GET' }, 405],
  ['invalid JSON', { httpMethod: 'POST', body: '{' }, 400],
  ['missing fields', event({}), 400],
  ['invalid email', event({ ...valid, email: 'invalid' }), 400],
]) {
  test(`rejects ${label} without contacting Mailgun`, async () => {
    assert.equal((await handler(request)).statusCode, status);
    assert.equal(calls.length, 0);
  });
}

test('missing server configuration fails without contacting Mailgun', async () => {
  delete process.env.MG_KEY;
  assert.equal((await handler(event())).statusCode, 500);
  assert.equal(calls.length, 0);
});

test('plain message includes form details and configured sender/recipient', async () => {
  assert.equal((await handler(event())).statusCode, 200);
  assert.equal(calls[0].domain, 'mg.example.com');
  assert.equal(calls[0].data.from, 'sender@example.com');
  assert.equal(calls[0].data.to, 'owner@example.com');
  assert.match(calls[0].data.text, /visitor@example.com/);
  assert.match(calls[0].data.html, /Test only/);
});

test('configured template receives the submitted form variables', async () => {
  process.env.MG_TEMPLATE = 'contact-template';
  assert.equal((await handler(event())).statusCode, 200);
  assert.equal(calls[0].data.template, 'contact-template');
  assert.deepEqual(JSON.parse(calls[0].data['h:X-Mailgun-Variables']), valid);
});
