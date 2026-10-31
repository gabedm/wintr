import { describe, expect, it } from 'vitest';
import { acceptSend, editDraft, initialComposer, settleSend } from '../src/client/draft.js';

describe('same-recording note correction rejected before admission', () => {
  it('restores the edited note when only the previous note is owned', () => {
    const reference = { canonicalUrl: 'https://www.youtube.com/watch?v=AAAAAAAAAAA', focus: { start: 0, end: 45 } };
    const draft = { url: reference.canonicalUrl, start: '00:00', end: '00:45', cue: 'keep the guitar contrast', focusEdited: true };
    const sent = acceptSend(editDraft(initialComposer(0), 0, draft), 0, { ref: reference, context: 'session-one' });
    const previous = { ...reference, cue: 'keep the groove' };
    const settled = settleSend(sent, 0, { working: false, blocked: false, expired: false, context: 'session-one', owned: previous });
    expect(settled.state.draft.cue).toBe('keep the guitar contrast');
    expect(settled.result).toBe('restored');
  });
});
