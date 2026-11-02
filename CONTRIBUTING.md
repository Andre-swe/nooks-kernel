# Contributing

Contributions are licensed under [Apache-2.0](LICENSE). Preserve [NOTICE](NOTICE) and add an accurate notice for every third-party component, dataset, fixture, or generated asset.

Keep all source modules deterministic and pure: no DOM, network, filesystem, environment-variable, or clock access. Do not add product APIs, account logic, telemetry, customer data, private test fixtures, or service configuration.

Every model must preserve provenance and validation. AI-inferred elements must remain `ai-inference`, never `observed`.

Run `npm test` and `npm run audit:release` before a pull request. A release requires a maintainer's human review for secrets, privacy, licences, and source provenance.
