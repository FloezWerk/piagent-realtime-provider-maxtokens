# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-06

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

<!-- [Unreleased] compares against the last tagged version; switch this link to
     compare/vX.Y.Z...HEAD once the first version is tagged. Versions link to
     their GitHub release page (created by release.yml); 0.1.0 has no tag yet
     (the first publish is manual), so it links to npm. -->
[Unreleased]: https://github.com/FloezWerk/piagent-realtime-provider-maxtokens/commits/main
[0.1.0]: https://www.npmjs.com/package/@floez-werk/piagent-realtime-provider-maxtokens/v/0.1.0
