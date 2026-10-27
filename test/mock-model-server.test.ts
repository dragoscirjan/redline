import { expect, it } from 'vitest';
import { startErrorServer, startMockServer } from './helpers/model-server.ts';

it('can stop a fixture again after its process has already closed', async () => {
  const server = await startMockServer();
  await server.stop();
  await server.stop();
}, 2000);

it('serves controlled HTTP errors without recording request bodies or headers', async () => {
  const server = await startErrorServer(401, 'Invalid fixture key');
  try {
    const result = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, { method: 'POST', body: 'fixture data' });
    expect(result.status).toBe(401);
    expect(await result.json()).toMatchObject({ error: { message: 'Invalid fixture key' } });
    expect(server.requests()).toBe(1);
  } finally { await server.stop(); }
});
