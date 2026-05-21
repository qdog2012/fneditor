# Native FPK packaging

This template is for a non-Docker fnOS `.fpk` package.

The app is a Node.js service plus built static frontend. A native FPK should include:

- `manifest`
- `cmd/main` and lifecycle scripts
- `app/server/dist`
- `app/server/server`
- `app/server/node_modules`
- `app/server/runtime/node`
- `app/server/package.json`
- `app/server/package-lock.json`

Build flow:

1. Build the web app with `npm run build`.
2. Prepare a staging directory from this template.
3. Copy `dist`, `server`, `package.json`, and `package-lock.json` into `app/server`.
4. Run `npm ci --omit=dev` inside `app/server`.
5. Download a Linux Node.js runtime into `app/server/runtime/node`.
6. Use fnOS `fnpack` or Fnpackup to package the staging directory into `.fpk`.

`cmd/main` starts `server/index.js` directly and stores state in the app data directory.
