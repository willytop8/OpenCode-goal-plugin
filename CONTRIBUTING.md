# Contributing

Thanks for helping improve `opencode-goal-plugin`.

## Development

Use the pinned Node version when possible:

```sh
nvm use
```

Run the local checks before submitting changes:

```sh
npm test
npm run test:coverage
npm run smoke
npm run smoke:packed-host
npm run benchmark:behavior
npm run verify
npm run check
npm run pack:check
```

For behavior changes, add or update tests in `test/goal-plugin.test.js`.

## OpenCode Compatibility

This plugin depends on OpenCode plugin hooks, including experimental hooks. When changing hook usage, command behavior, or system-prompt transforms:

1. Check the current OpenCode plugin and command documentation.
2. Run `npm run smoke` and `npm run smoke:packed-host` to verify the source and installed-tarball host contracts.
3. Test against a real OpenCode install when possible.
4. Update the README compatibility snapshot if the tested surface changes.

`npm run smoke` verifies the package export path and `/goal` command hook without invoking a model. `npm run smoke:packed-host` installs the packed artifact in an isolated directory and checks the public hook/tool contract. `npm run benchmark:behavior` covers deterministic autonomy and token-efficiency scenarios. None replaces a real OpenCode smoke test after hook, SDK, or command behavior changes.

## Release checklist

Before publishing or tagging a release:

- update `CHANGELOG.md`
- run `npm test`
- run `npm run test:coverage`
- run `npm run smoke`
- run `npm run smoke:packed-host`
- run `npm run benchmark:behavior`
- run `npm run verify`
- run `npm run check`
- run `npm run pack:check`
- perform at least one manual OpenCode smoke test if hook behavior changed
- refresh compatibility notes if the tested OpenCode surface changed

## Pull Requests

Keep pull requests focused. Include:

- what changed
- why it changed
- the checks you ran
- any manual OpenCode smoke testing performed
