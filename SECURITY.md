# Security and release safety

Do not report security issues in public issues. Send a private report to the repository owner with reproduction steps and impact.

Before publishing a release, run `npm run audit:release` and independently scan the staged Git content. Do not commit credentials, real endpoints, customer or contributor data, source images, internal paths, deployment configuration, or non-cleared third-party assets.
