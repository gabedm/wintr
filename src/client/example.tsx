import { EXAMPLE_SOURCE as EX } from '../shared/example-source.js';

// The approved public, licensed example: visible attribution and an explicit, editable draft fill. Nothing here
// sends, searches or downloads anything; it is not a recommendation and not a taste seed. Whether it is offered
// at all is decided by the server's derived capability (mode and the bound source policy), never by this file.

/** Title, creator, source and licence, with links to the creator's page and the licence text. */
export function ExampleAttribution({ className = 'support attribution' }: { className?: string }) {
  return (
    <p className={className}>
      “{EX.title}” by {EX.creator} (
      <a href={EX.sourcePage} target="_blank" rel="noopener noreferrer">
        {EX.creatorSite}
      </a>
      ). Licensed under{' '}
      <a href={EX.licenceUrl} target="_blank" rel="noopener noreferrer">
        {EX.licenceShort}
      </a>
      .
    </p>
  );
}

/** One compact line and one explicit action. Using it only fills the editable link and focus; Analyse stays the listener's. */
export function ExampleOffer({ onUse }: { onUse: () => void }) {
  return (
    <div className="example-offer" role="group" aria-label="Public example">
      <ExampleAttribution className="support" />
      <button type="button" className="suggestion" onClick={onUse}>
        Use this example
      </button>
    </div>
  );
}
