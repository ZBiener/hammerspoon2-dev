# Hammerspoon 2 development

This repository contains the TypeScript sources and build tools for the Spoons
used by the live config in `../system-config/hammerspoon2`.

Build and test from this directory:

```sh
npm ci
npm run test:snippet-coach
```

The build compiles both Spoons and deploys their `.spoon2` bundles to
`../system-config/hammerspoon2/Spoons/`. Reload the Hammerspoon 2 config to
load the updated bundles.

Sources are under `spoons/`; generated bundles are deployment output and are
ignored by the live config repository.
