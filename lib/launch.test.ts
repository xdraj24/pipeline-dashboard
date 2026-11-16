import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { HEADLESS_ALLOWED_TOOLS } from './launch.ts';

test('headless launches allow the same tools as the pipeline', () => {
  const libSh = readFileSync(new URL('../web/scripts/pipeline/lib.sh', import.meta.url), 'utf8');
  const pipelineTools = libSh.match(/--allowedTools "([^"]+)"/)?.[1];
  assert.equal(HEADLESS_ALLOWED_TOOLS, pipelineTools);
});

test('headless launches allow Bash', () => {
  assert.ok(HEADLESS_ALLOWED_TOOLS.split(',').includes('Bash'));
});
