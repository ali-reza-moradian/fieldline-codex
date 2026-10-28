# Optional cloud browser check

This directory is a bounded investigation of whether the logged-out public DraftKings page can obtain its snapshot through an ordinary fresh browser in the hosting environment. It is separate from the application's dependencies and collectors. A successful browser launch alone is not a successful integration.

On a compatible Linux host with Node 24:

```sh
npm ci --prefix diagnostics
node diagnostics/browser-access.js
```

The check closes within two minutes and prints only response status, public endpoint paths, page title and entity counts. It does not print cookies, tokens or response bodies. Browser security and TLS verification remain enabled; it does not solve challenges or modify browser fingerprints. The serverless Chromium package supplies the executable, not its web-security-disabling argument list.

These dependencies are not installed by the root `npm ci` and are not needed for the default collectors. Resource usage and source access must be verified before considering a browser-based acquisition path for the app.
