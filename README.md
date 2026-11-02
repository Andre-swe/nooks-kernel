# Nooks Kernel

`@nooks/kernel` is a deterministic, local-first foundation for brick-construction workbenches and agents. It turns structured construction intent into parts, checks whether a model holds together, plans and reviews assembly, preserves the record of how a build changed, and supports both conventional bricks and Brain Flakes.

## What you can build with it

- A local brick workbench that places, moves, recolours, removes, validates, and plans parts.
- An agent harness that gives a model bounded construction actions, then independently checks the returned design.
- A benchmark or replay tool that compares construction trajectories and software validation outcomes.
- A Brain Flakes editor or agent loop using the same provenance and validation discipline.

The kernel's scope is deliberately narrow: it supplies deterministic geometry, rules, records, and data shapes. Your host supplies the interface, storage, model provider, authentication, permissions, and any network access.

## Install

```sh
npm install @nooks/kernel
```

The package is ES modules and requires Node.js 22 or newer. Import only the modules you need:

```js
import { VoxelGrid } from '@nooks/kernel/voxels';
import { validate } from '@nooks/kernel/validate';
```

The kernel is designed to be run by a person, an agent, a server, or a browser host. A host owns all I/O and must pass complete inputs into the kernel; kernel modules do not fetch data, access the DOM, read environment variables, or depend on clocks.

## Public surface

- `src/` — pure workbench, brick-agent, and Brain Flakes modules: placement, parts, decomposition, validation, planning, construction records, exports, and benchmarks.
- `schema/spatial-asset.schema.json` — public graph record shape, including provenance, evidence, contributors, rights, and immutable version lineage.
- `data/catalog/catalog.json` — a pinned part-and-colour availability input used by decomposition. Its origin is identified in the file and NOTICE.

This repository deliberately excludes product UI, API and authentication services, deployment configuration, community and sharing features, demos, commerce, real-place features, evaluation runs, source photos, and third-party runtime geometry. Do not infer that an omitted capability is open source.

## Bring your own agent

Use the kernel inside your own agent host. A typical loop is:

1. Give the agent a structured brief, model state, and permitted construction actions.
2. Apply the proposed action locally through the kernel.
3. Run the mechanical checks and return their explicit outcomes to the agent.
4. Save each accepted change as a new revision with the input hashes, kernel version, agent identity, and validation result.

## Attribution and licence

Nooks Kernel is licensed under [Apache-2.0](LICENSE). Redistributions and derivatives must preserve applicable copyright, trademark, and attribution notices, including [NOTICE](NOTICE). Third-party material is not relicensed by this repository.

Nooks' construction and evaluation work was inspired by [BrickBench / BrickAgent](https://github.com/kulits/BrickAgent) and [BrickWright](https://github.com/AvaLovelace1/brickwright), as well as [Bricky](https://maxencefaldor.github.io/bricky/). Their papers are [BrickBench](https://arxiv.org/abs/2610.12452v1) and [BrickWright](https://arxiv.org/abs/2610.31651v1). No code, dataset, result, or asset from Bricky is included here.

## Development

```sh
npm test
npm run audit:release
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes. The release audit is a guardrail, not a substitute for secret scanning and a human licence review before publication.
