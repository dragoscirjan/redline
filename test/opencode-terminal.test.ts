import assert from 'node:assert/strict';
import test from 'node:test';
import { OPENCODE_TEXT_DELTA_PREFIX, OPENCODE_TEXT_END_PREFIX, ReviewBackendOutputConsumer } from '../src/review-stream.js';

function consumer(): ReviewBackendOutputConsumer {
  return new ReviewBackendOutputConsumer({ backend: 'opencode', sessionId: 'coordinator', sink: { async accept() {} } });
}
function forwarded(messageID: string, sessionID = 'coordinator'): string {
  return OPENCODE_TEXT_DELTA_PREFIX + JSON.stringify({ version: 1, sessionID, messageID, partID: 'text-part', delta: '' });
}
function terminal(messageID: string, reason: string): string {
  return JSON.stringify({ type: 'step_finish', sessionID: 'native-generated-session', part: {
    type: 'step-finish', sessionID: 'native-generated-session', messageID, reason,
  } });
}

test('OpenCode coordinator non-stop terminals fail closed without retaining raw reason text', async () => {
  for (const reason of ['length', 'error', 'tool-calls', 'content-filter', 'CREDENTIAL_SENTINEL']) {
    const output = consumer();
    await output.pushHarnessLine(forwarded('assistant'));
    await output.pushHarnessLine(terminal('assistant', reason));
    assert.match(output.terminalFailure as string, /OpenCode assistant ended with/u);
    assert.doesNotMatch(output.terminalFailure as string, /CREDENTIAL_SENTINEL/u);
  }
});

test('OpenCode later native stop clears only a coordinator-bound failure', async () => {
  const output = consumer();
  await output.pushHarnessLine(forwarded('first'));
  await output.pushHarnessLine(terminal('first', 'length'));
  await output.pushHarnessLine(terminal('child', 'stop'));
  assert.equal(output.terminalFailure, 'OpenCode assistant ended with length');
  await output.pushHarnessLine(forwarded('second'));
  await output.pushHarnessLine(terminal('second', 'stop'));
  assert.equal(output.terminalFailure, undefined);
});

test('OpenCode unrelated-session forwarded messages cannot bind terminal state', async () => {
  const output = consumer();
  await output.pushHarnessLine(forwarded('child', 'other-session'));
  await output.pushHarnessLine(terminal('child', 'length'));
  assert.equal(output.terminalFailure, undefined);
});

test('OpenCode native finish before forwarded alias is retained until identity binding', async () => {
  const output = consumer();
  await output.pushHarnessLine(terminal('assistant', 'length'));
  assert.equal(output.terminalFailure, undefined);
  await output.pushHarnessLine(OPENCODE_TEXT_END_PREFIX + JSON.stringify({ version: 1, sessionID: 'coordinator', messageID: 'assistant' }));
  assert.equal(output.terminalFailure, 'OpenCode assistant ended with length');
});

test('OpenCode delayed binding cannot replace a later successful terminal with an earlier failure', async () => {
  const output = consumer();
  await output.pushHarnessLine(terminal('old', 'length'));
  await output.pushHarnessLine(terminal('new', 'stop'));
  await output.pushHarnessLine(forwarded('new'));
  await output.pushHarnessLine(forwarded('old'));
  assert.equal(output.terminalFailure, undefined);
});

test('OpenCode terminal identities and message counts are bounded', async () => {
  const malformed = consumer();
  await assert.rejects(malformed.pushHarnessLine(terminal('x'.repeat(257), 'stop')), /malformed/u);
  const terminals = consumer();
  const messages = consumer();
  for (let i = 0; i < 1024; i += 1) {
    await terminals.pushHarnessLine(terminal(String(i), 'stop'));
    await messages.pushHarnessLine(forwarded(String(i)));
  }
  await assert.rejects(terminals.pushHarnessLine(terminal('overflow', 'stop')), /limit exceeded/u);
  await assert.rejects(messages.pushHarnessLine(forwarded('overflow')), /limit exceeded/u);
});
