import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePrompt } from '../api/src/ai/prompts.js';

test('preview requires the exact prompt fields and substitutes values once', () => {
  const body = 'Write a biography for {{artist_name}} about {{genres}} for {{event_type}}.';
  const fields = { artist_name: '{{genres}}', genres: 'jazz', event_type: 'gala' };
  assert.equal(resolvePrompt('bio', body, fields), 'Write a biography for {{genres}} about jazz for gala.');
  assert.throws(() => resolvePrompt('bio', body + ' {{extra}}', fields), { code: 'INVALID_PROMPT' });
  assert.throws(() => resolvePrompt('bio', body, { ...fields, extra: 'unused' }), { code: 'INVALID_PROMPT_FIELDS' });
  assert.throws(() => resolvePrompt('bio', body.replace('{{genres}}', '{{ genres }}'), fields), { code: 'INVALID_PROMPT' });
});
