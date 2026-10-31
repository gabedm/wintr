# Later upstream notices for historical packages

The locked production closure includes three MIT-declared versions whose published tarballs omit their complete notice. Their verified upstream notices are retained verbatim in `scripts/upstream-notices/` and the generated `/licenses/Software-NOTICES.txt`. No package, version or lockfile was changed to obtain them.

`sources.json` preserves publication provenance separately from each later notice and its applicability evidence. The offline notice generator checks the installed version, declared licence, locked integrity and saved notice hash; it does not fetch or silently update upstream material.

| Package | Publication commit | Later notice and applicability |
| --- | --- | --- |
| eastasianwidth@0.2.0 | `b89f04d44dc786885615e94cd6e2ba1ef7866fa4` | The [pinned maintainer clarification](https://raw.githubusercontent.com/komagata/eastasianwidth/f42b1e7b2a403d2050dda1141211b4e198e50e70/LICENSE-NOTES.md) explicitly assigns the [complete notice](https://raw.githubusercontent.com/komagata/eastasianwidth/1d41951a59d63fb2d77cda021050fc070cae424a/MIT-LICENSE.txt) to 0.2.0. The notice was added while the package was 0.3.0; applicability comes from that explicit clarification, rather than a claim that the later source is identical. Its copyright line has no year. |
| stream-events@1.0.5 | `b53b9533cbccbad8dd50633ab95b6f3fe4e6258e` | Its [immediate successor](https://github.com/stephenplusplus/stream-events/commit/5cd27e04319f81836fb8018df36f5c09534194ab) adds only `LICENSE`; package version remains 1.0.5 and installed `index.js`/`index.d.ts` match both commits. [Notice](https://raw.githubusercontent.com/stephenplusplus/stream-events/5cd27e04319f81836fb8018df36f5c09534194ab/LICENSE). |
| stubs@3.0.0 | `2d41d3ae487d3bb0b8c7511d254783eaad862d8f` | Its [immediate successor](https://github.com/stephenplusplus/stubs/commit/9f93d33b800f61a2c00f1582dc0f8cc14242219a) adds only `LICENSE`; package version remains 3.0.0 and installed `index.js`/`test.js` match both commits. [Notice](https://raw.githubusercontent.com/stephenplusplus/stubs/9f93d33b800f61a2c00f1582dc0f8cc14242219a/LICENSE). |

The saved notice SHA-256 values are, respectively, `94aa6016fb9d436508366433e9caba061443ca58f4c7eb515caec7badf90ae5a`, `2055fb6b0da08d07d70811043d7b8682ebbdba1e206f1ee511646ccb3f8f450d` and `cd01ce0baa2b903bb80911719424904a4a0eb589acb982d45b119dffe28b7f58`. The pinned eastasianwidth clarification has SHA-256 `652d0486b433ecd1e91c2a933f6d320f651bda1d7bb32ba50a48cf7329bb81b3`.

This closes the three missing-notice provenance records. The notices were not present in those original tarballs or publication commits. This record does not establish complete legal clearance, music/provider permissions, public-export hygiene or release authority; those remain separate gates.
