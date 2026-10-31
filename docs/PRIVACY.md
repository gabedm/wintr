# Privacy

## Data flow

- Deliberate live listening sends microphone audio to Google's Gemini service for analysis. Wintr does not persist raw audio. A supported YouTube link is also processed by Google when that input is used.
- Qloo receives artist queries and discovery signals. Public artist/taste metadata and the selected musical relationship inform song selection.
- Apple receives catalogue/artist queries; artwork may be fetched from Apple's infrastructure. Opening an Apple Music link visits Apple's service.
- If configured, Ticketmaster receives discovered-artist queries for concerts. Date and city filters narrow the loaded list locally.
- The operator's Google Cloud/Firestore deployment stores private session and accounting records. App access expiry does not guarantee immediate physical deletion of database or provider copies.

## Browser storage

The Library keeps public song metadata on the device across sessions until removed. It does not save raw audio or private conversation records. Session and access cookies support server-side ownership; local Clear recovery markers help prevent a lost request from restoring private content.

## Controls and limits

Listening begins through a deliberate action. Stop, Clear and expiry revoke local work and access; they cannot recall bytes already sent to another service. Private music Session access lasts at most one hour. Clearing a Session and clearing the saved Library are separate actions.

Provider retention and an operator's accounting retention are separate from that one-hour access window. Consult the selected Google, Qloo, Apple and Ticketmaster terms and the privacy notice of the deployment you use. This source repository contains no live keys, private listener records or recordings.
