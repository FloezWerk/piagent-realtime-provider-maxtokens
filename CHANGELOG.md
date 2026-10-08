# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2](https://github.com/FloezWerk/piagent-realtime-provider-maxtokens/releases/tag/v0.1.2) - 2026-10-07

### Added

- The status line can show what the provider that served the call supports
  itself, in parentheses behind the current value: `MT:131k (Dig 944k)` (`Dig` is
  the provider's first three letters, `944k` its own output limit). Two settings
  control it: `statusProviderLimit` turns the parenthetical off,
  `statusProviderLimitTag` hides the tag and leaves only `(944k)`. The provider is
  read from the raw OpenRouter chunks, so it is known per response.
- The status value is colour-coded instead of marked with an arrow: neutral
  (`color`) while nothing is reduced, the warning colour (`colorClamped`, a dark
  yellow by default) from `clampWarnPercent` (default 1) percent of deviation, and
  the heavy colour (`colorClampedHeavy`, orange by default) above
  `clampAlertPercent` (default 10) percent, and the critical colour
  (`colorClampedCritical`, `#ff8080` by default) above `clampCriticalPercent`
  (default 50) percent. The deviation is how much the request value was reduced.
  Colours accept palette names, `#rgb`/`#rrggbb`, a 256-colour number and
  `bold:`/`reverse:` prefixes.
- A per-model lower bound for the cap (`minByModel`): the limit that is sent never
  drops below it, even when every endpoint publishes less.
- An opt-in diagnostic log (`log`, off by default) written to
  `provider-maxtokens.log`: whether a cache entry was used or a new lookup is
  needed, when a cached limit expired, the endpoints response (status, duration,
  endpoint count, cap and the limit of every provider), each request's decision
  and the provider that served the response.
- Commands `/provider-maxtokens min [<model-id> [<tokens|none>]]` and
  `/provider-maxtokens log <on|off>`.
- The provider parenthetical gained spaces: after the status value and between
  the provider tag and its limit (`MT:131k (Dig 944k)`).

### Changed

- `/provider-maxtokens status` now reports the configured minimum, the cap in
  use, the serving provider with its own limit, and the per-model reduction count.

## [0.1.1](https://github.com/FloezWerk/piagent-realtime-provider-maxtokens/releases/tag/v0.1.1) - 2026-10-07

### Changed

- Release process only, no user-facing change: this version is byte-identical to
  the manually published 0.1.0. It is the first release driven by a version tag
  and exercises the shared pipeline (guards, `npm run check`, README sync, npm
  publish with provenance, GitHub release with the package tarball).

## [0.1.0](https://www.npmjs.com/package/@floez-werk/piagent-realtime-provider-maxtokens/v/0.1.0) - 2026-10-06

### Added

- Rewrites the output limit (`max_completion_tokens`, or `max_tokens` when the
  model uses that field) in outgoing OpenRouter payloads to the smallest output
  limit among the model's provider endpoints. OpenRouter only routes to endpoints
  that can serve the requested length, and Pi sends the model-wide catalogue
  maximum - so endpoints publishing a lower limit were filtered out before
  routing.
- Resolves that limit from OpenRouter's public model endpoints route and caches it
  per model in `provider-maxtokens-cache.json`, so the request path never waits
  for a lookup.
- Refreshes a cached limit once it is older than the TTL (default: 60 minutes).
- Warms the cache for the session's scoped OpenRouter models on session start and
  for the selected model on a model switch.
- Falls back to a configurable cap when no fresh entry exists or a lookup fails,
  so requests keep working offline and for unknown models.
- Adds the `/provider-maxtokens` command with `status`, `on`, `off`, `toggle`,
  `refresh`, `clear`, `ttl <minutes>` and `cap <tokens>`.
- Adds the status bar entry `MT:<limit>` (`*` marks the fallback cap, `MT:off`
  when disabled).
- Adds settings under the root key `provider-maxtokens` in `settings.json`
  (`enabled`, `ttlMinutes`, `fallbackCap`).
- Leaves everything else alone: no provider is registered, `models.json` is
  neither read nor written, and no provider is pinned.

<!-- [Unreleased] compares against the last tagged version. Every version heading
     links to its GitHub release page (created by release.yml); 0.1.0 has no tag
     (the first publish was manual), so it links to npm. -->
[Unreleased]: https://github.com/FloezWerk/piagent-realtime-provider-maxtokens/compare/v0.1.2...HEAD
