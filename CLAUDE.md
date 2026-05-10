# handoff-plugin

## Release rules

- Before `git push`, bump the version in BOTH `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`. The two must stay in sync — users pull updates via the marketplace, so a stale marketplace version means the change does not ship.
