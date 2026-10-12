# Native FPK packaging

This template is for a non-Docker fnOS `.fpk` package.

The app is a Go HTTP service plus built static frontend. Building requires Go 1.23+, Node.js 22+, npm, and tar. The installed application needs no Node.js or Go runtime. A native FPK includes:

- `manifest`
- `cmd/main` and lifecycle scripts
- `app/server/dist`
- `app/server/fneditor` (a Linux executable built with `CGO_ENABLED=0`)
- `app/server/VERSION`
- `app/ui/index.cgi` and desktop assets

Build flow:

```bash
bash scripts/prepare-fpk-native.sh
bash scripts/package-fpk-native.sh
```

The first script installs frontend build dependencies, builds the frontend, cross-compiles the backend, and prepares `build/fpk-native/fncode`. Use `TARGET_ARCH=amd64` or `TARGET_ARCH=arm64` to choose the target architecture. The second script creates a package in `build/fpk-output`.

`cmd/main` starts the Go executable directly, preserving the existing port, root restrictions, version overrides, and application state location. `index.cgi` forwards the desktop entry and API traffic to the service.
