import { describe, expect, it } from 'vitest';
import { assembleStream, parseGrounding } from '../src/server/providers/gemini-catalogue.js';
import { parseCandidateSelection } from '../src/server/providers/gemini-candidate-selector.js';

const candidate = () => ({ content: { role: 'model', parts: [{ text: 'NO SUPPORTED CHOICE' }] }, finishReason: 'STOP' });

describe('audited native response boundaries', () => {
  it.each([
    { safetyRatings: [{ blocked: true }] },
    { safetyRatings: [{ blocked: 'false' }] },
    { safetyRatings: {} },
    { safetyRatings: [null] },
  ])('rejects unsafe or malformed candidate ratings %j', fields => {
    expect(() => assembleStream([{ candidates: [{ ...candidate(), ...fields }] }])).toThrow();
  });
  it.each([
    { safetyRatings: [{ blocked: true }] },
    { safetyRatings: [{ blocked: 'false' }] },
    { blockReason: {} },
    null,
  ])('rejects unsafe or malformed prompt feedback %j', promptFeedback => {
    expect(() => assembleStream([{ promptFeedback, candidates: [candidate()] }])).toThrow();
  });
  it.each([
    { role: 'user', parts: [{ text: 'NO SUPPORTED CHOICE' }] },
    { role: null, parts: [{ text: 'NO SUPPORTED CHOICE' }] },
    { parts: [{ text: 'NO SUPPORTED CHOICE', thought: 'true' }] },
    { parts: [{ text: 'NO SUPPORTED CHOICE', thoughtSignature: {} }] },
    { parts: [{ text: 'NO SUPPORTED CHOICE', functionCall: {} }] },
    'not content',
  ])('rejects malformed or unsupported content %j', content => {
    expect(() => assembleStream([{ candidates: [{ ...candidate(), content }] }])).toThrow();
  });
  it.each(['continue-me', {}, null])('does not accept STOP with continuation %j', continuationToken => {
    expect(() => assembleStream([{ continuationToken, candidates: [candidate()] }])).toThrow();
  });
  it('retains valid partial chunks, thought signatures, safe ratings and usage', () => {
    const result = assembleStream([
      { promptFeedback: { safetyRatings: [{ blocked: false }] }, candidates: [{ content: { parts: [{ thought: true, text: 'private thinking' }] } }] },
      { candidates: [{ content: { parts: [{ text: 'NO SUPPORTED CHOICE', thoughtSignature: 'opaque-signature' }] } }] },
      { candidates: [{ finishReason: 'STOP', safetyRatings: [{ blocked: false }] }], usageMetadata: { totalTokenCount: 20 } },
    ]);
    expect(result.text).toBe('NO SUPPORTED CHOICE');
    expect(result.usage).toEqual({ totalTokenCount: 20 });
  });
  it.each([{ queries: [123] }, { queries: ['x'.repeat(201)] }, { queries: Array.from({ length: 11 }, (_, i) => `query ${i}`) }])('refuses malformed native query units %j', ({ queries: webSearchQueries }) => {
    expect(() => parseGrounding({ webSearchQueries }, 'NO SUPPORTED CHOICE')).toThrow();
  });
  it('preserves a complete valid query unit exactly', () => {
    const queries = ['invented recording one', 'invented recording two'];
    expect(parseGrounding({ webSearchQueries: queries }, 'text').queries).toEqual(queries);
  });
});

describe('opaque candidate handles stay out of public fit prose', () => {
  const first = 'a'.repeat(24), second = 'b'.repeat(24);
  it.each([first, second])('rejects any supplied private handle echoed in a note', echoed => {
    expect(() => parseCandidateSelection(JSON.stringify({ choices: [{ candidateRef: first, fitHypothesis: `Try ${echoed} for this groove.` }] }), new Set([first, second]))).toThrow();
  });
  it('allows an ordinary tentative note', () => {
    expect(parseCandidateSelection(JSON.stringify({ choices: [{ candidateRef: first, fitHypothesis: 'A possible direction for the chosen contrast.' }] }), new Set([first]))).toHaveLength(1);
  });
});

it.each(['planInventedPrivate000001', 'associationInventedRef0001', 'artistInventedPrivate001'])('rejects prompt-owned handle %s in public prose', privateRef => {
  const ref = 'candidateInvented000001';
  const text = JSON.stringify({ choices: [{ candidateRef: ref, fitHypothesis: `Try ${privateRef} for this groove.` }] });
  expect(() => parseCandidateSelection(text, new Set([ref]), new Set([privateRef]))).toThrow();
});
