// classifyModelsBody (discovery.ts): the content-aware half of admin
// test-connection. Some vendors (z.ai) authenticate /models but answer
// HTTP 200 with an auth-error JSON body — the classifier must read that as
// a FAILED probe while nonstandard-but-working providers stay lenient.
import { describe, expect, it } from 'vitest';
import { classifyModelsBody, type ModelsBodyClassification } from '../../src/worker/discovery';
import { loadFixtures } from './helpers';

describe('classifyModelsBody (golden)', () => {
  for (const case_ of loadFixtures('discovery-test.json')) {
    it(case_.name as string, () => {
      expect(classifyModelsBody(case_.body)).toEqual(case_.expected as ModelsBodyClassification);
    });
  }
});
