import { createServer } from 'node:http';

// Trusted synthetic fixture, never loaded from a reviewed repository.
const mode = process.env.REDLINE_MOCK_MODE;
const key = 'synthetic-container-model-key-do-not-persist';
const server = createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += String(part);
  const body = JSON.parse(raw || '{}');
  console.log(JSON.stringify({ type: 'request', path: req.url ?? '', authorization: req.headers.authorization, body }));
  if (mode === 'hang') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting for cancellation\n\n'); return; }
  if (mode === 'busy' || mode === 'unauthorized') {
    res.writeHead(mode === 'busy' ? 503 : 401, { 'content-type': 'application/json', 'retry-after-ms': '1', 'retry-after': '0' });
    const text = JSON.stringify({ error: { message: mode === 'busy' ? 'Service temporarily unavailable' : 'Invalid API key ' + key,
      type: mode === 'busy' ? 'server_error' : 'authentication_error' } });
    for (let offset = 0; offset < text.length; offset += 8) res.write(text.slice(offset, offset + 8)); res.end(); return;
  }
  const fileId = /\\?"fileId\\?"\s*:\s*\\?"(\d{6})\\?"/u.exec(raw)?.[1] ?? '000001';
  const reply = JSON.stringify({ version: 4, fileId, outcome: 'findings', reason: 'Scripted supported defect.', contextRequests: [], findings: [{
    title: 'Fixture contract changed', dimensions: ['correctness'], category: 'correctness', classification: 'defect', severity: 'high', confidence: 0.9,
    side: 'RIGHT', startLine: 1, endLine: 1, evidence: 'new', supportingEvidence: [], graphReferences: [],
    impactPath: { status: 'partial', steps: [], limitation: 'This deterministic fixture uses file-only evidence.' },
    behavioralContract: 'The fixture requires old.', failureScenario: 'The changed value is new.', reachability: 'The changed line is the fixture entry.',
    rootCause: 'The changed value no longer matches the contract.', impact: 'The new line violates the fixture contract.', blastRadius: 'One fixture line.',
    reversibility: 'reversible', assumptions: [], counterEvidence: [], uncertainty: 'No extra context is available in this fixture.',
    fix: 'Restore old.', regressionTest: 'Assert the fixture retains old.', verification: { status: 'unverified', reason: 'Scripted integration fixture.' },
    remediationStatus: 'proposed', suggestedChange: 'old',
  }] });
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (let i = 0; i < reply.length; i += 32) res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'test-model',
      choices: [{ index: 0, delta: { content: reply.slice(i, i + 32) }, finish_reason: null }] }) + '\n\n');
    res.end('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  } else {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: 'test-model', choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  }
});
server.listen(3000, '0.0.0.0', () => console.log(JSON.stringify({ type: 'ready' })));
