# cua-driver

The Computer use gateway (`src/electron/libs/computer-use/`) runs
[Cua Driver](https://github.com/trycua/cua/tree/main/libs/cua-driver), a single
Rust binary under the MIT license, as a child process of the main process.

## Pinned version

| | |
| --- | --- |
| Version | `0.57.0` (GitHub release `cua-driver-rs-v0.57.0`, 2026-11-22) |
| Asset | `cua-driver-rs-0.57.0-darwin-universal-binary.tar.gz` (x86_64 + arm64) |
| SHA-256 | `917dfccdbbd5cbd90774cfa46292551b9a9e86bc719b878dbd21af14e38bb76b` (from that release's `SHA256SUMS`) |
| Upstream signature | Developer ID, team `YCK386LBJ7`, hardened runtime |

Aegis runs this version and no other: a binary that reports a different
version is refused (`driver-binary.ts`). Upstream publishes several releases a
day, all marked prerelease, and its tool schemas still change.

## Getting it

```sh
npm run fetch:cua-driver
```

downloads the asset from the GitHub release, checks the SHA-256 above, and
puts `cua-driver` and `cua-cursor-theme` in `native/cua-driver/dist/` (ignored
by git). Nothing is installed system-wide and no Python is involved.

Aegis looks for the binary in this order:

1. `AEGIS_CUA_DRIVER_PATH`
2. the path set in Settings → Browser → Computer use
3. `<app resources>/cua-driver/cua-driver` (for a packaged app; not bundled yet)
4. `native/cua-driver/dist/cua-driver`

When none is there, or the version differs, agents are not offered the tools
and Settings says why.

## Changing the version

Change `VERSION` and `SHA256` in `scripts/fetch-cua-driver.mjs` and
`CUA_DRIVER_VERSION` in `src/electron/libs/computer-use/driver-binary.ts`
together, in a change of its own. Then compare the driver's tool schemas
(`cua-driver describe <tool>`) for the tools named in
`src/electron/libs/computer-use/policy.ts`, and run
`npm run verify:computer-use` and `npm run verify:computer-use-live`.

## How it is run

`cua-driver serve --embedded --socket <userData>/computer-use/driver/driver.sock`
with telemetry and the update check off, its state under Aegis's own folder,
and a policy file that allows only the calls the gateway makes. See
`driver-host.ts`.
