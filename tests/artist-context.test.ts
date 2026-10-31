import { expect, it } from 'vitest';
import { artistContext, isSafeArtistContext } from '../src/shared/artist-context.js';
import { parseSupportedExternal } from '../src/server/providers/qloo.js';

const ids = { spotify: '1'.repeat(22), musicbrainz: '40000000-0000-4000-8000-000000000001', wikidata: 'Q900000000001' };
it.each(Object.entries(ids))('refuses terminal line controls in %s external identity before equivalence or public navigation', (service, id) => {
  expect(parseSupportedExternal({ [service]: [{ id }] })).toEqual({ [service]: [id] });
  for (const ending of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    expect(parseSupportedExternal({ [service]: [{ id: id + ending }] })).toEqual({});
    expect(artistContext(service, id + ending)).toBeUndefined();
    const valid = artistContext(service, id)!;
    expect(isSafeArtistContext({ ...valid, url: valid.url + ending })).toBe(false);
  }
});
