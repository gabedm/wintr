import type { HttpTransport, ProviderResponse } from './providers/http.js';

// Labelled local fixture for synthetic mode only. It answers the genuine Qloo
// client's requests with invented artists/tags so the graph path can be
// exercised locally. Every pool built from it is marked synthetic and the UI
// says it is not from Qloo. It never touches the network or any credential.
// A query containing "ambiguous" returns two namesakes to exercise the
// identity checkpoint; "nobody" returns no results.

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const body = (status: number, value: unknown): ProviderResponse => ({
  status,
  contentType: 'application/json',
  body: new TextEncoder().encode(JSON.stringify(value)),
});

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

export function createSyntheticQlooTransport(): HttpTransport {
  return async (req) => {
    if (req.signal.aborted) throw new Error('aborted');
    req.observer?.transportStarted();
    const p = req.url.searchParams;
    if (req.url.pathname === '/search') {
      const query = (p.get('query') ?? '').slice(0, 128);
      if (/nobody/i.test(query)) return body(404, {});
      const base = hash(query.toLowerCase()) % 100_000;
      const results = /ambiguous/i.test(query)
        ? [
            { entity_id: uuid(base * 10 + 1), name: query, subtype: 'urn:entity:artist', disambiguation: 'Synthetic band, formed 1990' },
            { entity_id: uuid(base * 10 + 2), name: query, subtype: 'urn:entity:artist', disambiguation: 'Synthetic solo artist' },
          ]
        : [{ entity_id: uuid(base * 10 + 1), name: query, subtype: 'urn:entity:artist', disambiguation: 'Synthetic fixture artist' }];
      return body(200, { results });
    }
    const seeds = (p.get('signal.interests.entities') ?? '').split(',');
    const base = hash(seeds.join()) % 100_000;
    if (p.get('filter.type') === 'urn:tag') {
      return body(200, {
        success: true,
        results: {
          tags: ['warm low end', 'close harmony', 'loose groove'].map((name, i) => ({
            tag_id: `urn:tag:synthetic:music:fixture_${i + 1}`,
            name: `Synthetic tag: ${name}`,
          })),
        },
      });
    }
    return body(200, {
      success: true,
      results: {
        entities: [1, 2, 3, 4, 5].map((i) => ({
          entity_id: uuid(5_000_000 + base * 10 + i),
          name: `Synthetic Neighbour ${String.fromCharCode(64 + i)}`,
          subtype: 'urn:entity:artist',
          query: { affinity: 1 - i / 10 },
        })),
      },
    });
  };
}
