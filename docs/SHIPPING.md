# Shipping the first release

Checklist for publishing `evalh` to npm for the first time. Run every step from the
repository root, in order.

## Pre-flight

- [ ] `npm ci` (clean dependency install).
- [ ] `npm run build` — must exit 0 (`tsc -p tsconfig.build.json`). Confirm `dist/cli.js`, `dist/index.js`, and `dist/main.js` exist.
- [ ] `npm test` — must exit 0 (`vitest --run`).
- [ ] `npm pack --dry-run` — confirm the tarball contains `dist/`, `README.md`, `CHANGELOG.md`, `LICENSE`, `docs/`, and `templates/`, and nothing from `src/`, `test/`, `tasks/`, `runs/`, `docker/`, or `node_modules/` (the `files` array in `package.json` controls this).
- [ ] Re-read `README.md` and `CHANGELOG.md`; make sure version references and docs links are current.

## Version bump and tag

- [ ] Bump the version with `npm version <major|minor|patch>` (this updates `package.json`, `package-lock.json`, and creates a git tag). Pick the intended public version — e.g. `npm version 1.0.0` for the first stable release.
- [ ] Add the release notes to `CHANGELOG.md` and commit them: `git commit -am "Release vX.Y.Z"`.
- [ ] If the tag was not created by `npm version`, create it: `git tag -a vX.Y.Z -m "vX.Y.Z"`.
- [ ] Push commits and tags: `git push && git push --tags`.

## Publish

- [ ] `npm whoami` and `npm config get registry` — confirm the correct account and registry.
- [ ] `npm login` if needed (and have 2FA ready).
- [ ] `npm publish` — do **not** use `--dry-run` when publishing. First-time publish needs no `--access` flag for an unscoped package.

## Post-publish verification

- [ ] `npm view evalh version` — confirm the published version matches the tag.
- [ ] `npm install -g evalh` — install the just-published package from the registry.
- [ ] `evalh doctor` — confirm it reports the active agent directory, git availability, and model config without errors.
- [ ] `evalh --help` — confirm the command list renders.
- [ ] From a checkout, `evalh list tasks` — final smoke test against the demo task.
