# Security reporting

Please do not post API keys, access links, recordings, conversations or another person's data in public issues.

Use GitHub's private vulnerability reporting channel if available. Otherwise open a non-sensitive issue asking for a private reporting route; do not include exploit details or personal information.

Keep provider credentials and runtime configuration outside Git and the browser bundle. The supplied development runtime does not enable live providers. A live deployment needs explicit server configuration, exact Host/Origin checks, an owned Firestore store and server-side credentials.

If a credential is exposed, revoke or rotate it. Deleting a file does not remove copies from Git history, forks, downloads or provider systems.

Tests and automated scans reduce risk; they do not constitute a security certification.
