// Golden fixtures for upstream-failure → client-envelope mapping (M4 policy:
// status preserved, message preserved, type kept when the upstream declared
// one — mapped only when it belongs to the other vocabulary — else derived
// from status). Also pins the status→type derivation tables both dialects use
// for gateway-generated errors.
import { describe, expect, it } from 'vitest';
import { anthropicError, errorTypeForStatus as anthropicTypeForStatus, upstreamErrorToAnthropic } from '../../src/worker/dialects/anthropicMessages';
import { errorTypeForStatus as openAiTypeForStatus, openAiError, upstreamErrorToOpenAi } from '../../src/worker/dialects/openaiChat';
import { loadFixtures } from './helpers';

describe('upstream error mapping (golden)', () => {
  for (const case_ of loadFixtures('errors.json')) {
    it(case_.name as string, () => {
      const status = case_.status as number;
      const raw = case_.raw as string;
      const expected = case_.expected as Record<string, unknown>;
      if (case_.fn === 'toOpenAi') {
        expect(upstreamErrorToOpenAi(status, raw)).toEqual(expected);
      } else {
        expect(upstreamErrorToAnthropic(status, raw)).toEqual(expected);
      }
    });
  }
});

describe('openai status → error type derivation', () => {
  const cases: [number, string][] = [
    [400, 'invalid_request_error'],
    [401, 'authentication_error'],
    [403, 'permission_error'],
    [404, 'invalid_request_error'],
    [429, 'rate_limit_error'],
    [499, 'invalid_request_error'],
    [500, 'api_error'],
    [502, 'api_error'],
    [503, 'api_error'],
  ];
  it.each(cases)('%i → %s', (status, type) => {
    expect(openAiTypeForStatus(status)).toBe(type);
  });
});

describe('anthropic status → error type derivation', () => {
  const cases: [number, string][] = [
    [400, 'invalid_request_error'],
    [401, 'authentication_error'],
    [404, 'not_found_error'],
    [408, 'timeout_error'],
    [413, 'request_too_large'],
    [429, 'rate_limit_error'],
    [504, 'timeout_error'],
    [529, 'overloaded_error'],
    [500, 'api_error'],
    [419, 'invalid_request_error'],
  ];
  it.each(cases)('%i → %s', (status, type) => {
    expect(anthropicTypeForStatus(status)).toBe(type);
  });
});

describe('envelope builders', () => {
  it('openAiError fills type from status and allows overrides', () => {
    expect(openAiError(404, 'Model not found')).toEqual({
      error: { message: 'Model not found', type: 'invalid_request_error', param: null, code: null },
    });
    expect(openAiError(404, 'Nope', { code: 'model_not_found', param: 'model' })).toEqual({
      error: { message: 'Nope', type: 'invalid_request_error', param: 'model', code: 'model_not_found' },
    });
    expect(openAiError(500, 'Boom', { type: 'provider_misconfigured' }).error.type).toBe('provider_misconfigured');
  });

  it('anthropicError fills type from status and allows overrides', () => {
    expect(anthropicError(404, 'Model not found')).toEqual({
      type: 'error',
      error: { type: 'not_found_error', message: 'Model not found' },
    });
    expect(anthropicError(500, 'Boom', { type: 'provider_misconfigured' }).error.type).toBe('provider_misconfigured');
  });
});
