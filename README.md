<p align="center"><img src="src/client/public/assets/wintr-mobile-v1.svg" width="96" alt="Wintr snowflake"></p>

# Wintr

**Shazam on Steroids: discover your next favourite through Qloo.**

Wintr listens to music and helps you find what to play next. Gemini interprets the reference, Qloo supplies artist and taste connections, and Wintr finds verified recordings within those connections.

## What it does

- **Home:** listen to a short excerpt or use a YouTube song link. Discoveries appear in Recently found.
- **Library:** keep discovered songs on your device, search them and open them in Apple Music.
- **Concerts:** find upcoming shows from discovered artists, with location and date filters.

Built with React, TypeScript, Node.js, Gemini, Qloo, Apple's catalogue and Ticketmaster. The interface is designed for phones and also works on desktop.

## Run the development app

Use **Node 24.19.0** and **pnpm 11.25.0**.

Clone this repository, then run:

```sh
cd wintr
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm start:synthetic
```

Open **http://127.0.0.1:8787**. This is a labelled development preview with invented music results, no live providers and unavailable playback. For the synthetic YouTube flow, use `https://youtu.be/aaaaaaaaaaa`. Microphone permissions and a real discovery result are not provided by this mode.

`pnpm dev:synthetic` runs the development server. Ordinary `pnpm start` and `pnpm dev` leave live providers disabled.

## Use your own APIs

All API keys and runtime identities must be supplied by the operator **on the server**. This repository does not include live service access or an API allowance.

Live operation needs a Gemini API key, a Qloo API key, a Google Cloud runtime identity and Firestore, a stable sealing secret and a validated runtime configuration. Ticketmaster is optional. Apple's catalogue lookup needs no Apple Music user login. Adding keys to a `.env` file alone does not enable the live app.

See **[live setup and hosting](docs/HOSTING.md)** for the supported Cloud Run entry, secret names and configuration requirements. The Windows helper sources are included for developers, but do not come with a configured profile or credentials. Do not copy somebody else's private installation or runtime data.

## Check the source

```sh
pnpm typecheck
pnpm typecheck:emulator
pnpm exec vitest run --maxWorkers=2
pnpm build
```

The normal tests use invented fixtures. Emulator compilation does not start Firestore; [emulator instructions](docs/validation/FIRESTORE_EMULATOR.md) describe the separate local integration target. Windows helper compilation is available through `pnpm build:windows` on Windows.

## How Qloo contributes

Qloo resolves artists and provides the cultural connections that constrain the candidate artist pool. Gemini selects from first-party catalogue candidates within that pool, and Wintr verifies exact recording metadata before showing a listening destination. It can return no match rather than inventing a song. Qloo supplies taste connections, not acoustic measurements; candidate recordings are not themselves audio-analysed, and musical fit is a recommendation to judge by listening.

## Privacy

API keys stay server-side. Wintr does not persist raw audio. Private music Session access lasts at most one hour; Library song metadata remains on the device until removed. External services apply their own processing and retention terms. See [privacy](docs/PRIVACY.md) and [security reporting](SECURITY.md).

This public repository has a fresh source history and contains no private deployment configuration, listener records, recordings or developer credentials. Hosting an app from this code requires your own configuration, provider access and review of the relevant terms.

## Licence and credits

Original code is [MIT licensed](LICENSE). Third-party software, fonts, GeoNames city data, official service logos, artwork and provider content retain their respective terms. The app's [licence notices](src/client/public/licenses/) are included. An API key or this source licence does not grant rights to third-party music or artwork; check the conditions of your intended use.
