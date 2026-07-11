# Compatibility policy

## Supported package surface

The latest published release is the supported line. Public compatibility covers:

- the package root and `opencode-goal-plugin/server` ESM exports
- the declarations exported by `index.d.ts`
- the documented `GoalPluginOptions` fields
- the documented OpenCode hook names
- the six canonical goal tools and five legacy tool aliases
- persisted-state recovery from versions documented in the changelog

The package requires Node.js 18 or newer and OpenCode 1.17.15 through the latest
compatible 1.x release. CI runs the complete unit suite on Node 18, 20, 22, and
24. Installed-package contracts compile TypeScript consumers using both NodeNext
and Bundler resolution and load the npm tarball with and without the optional
`@opencode-ai/plugin` peer.

Filesystem-sensitive lifecycle tests run on Linux, macOS, and Windows. POSIX file
mode and symbolic-link protections are applied where the operating system supports
them; the plugin does not claim that Windows provides equivalent POSIX semantics.

## OpenCode host compatibility

OpenCode's experimental hooks and SDK request shapes may change within the 1.x
line. Automated tests cover both current flattened session inputs and the legacy
generated-client shape, but a real-host smoke test remains required when hook or
SDK behavior changes. The current manual provider matrix is maintained in
[providers.md](providers.md).

## Versioning

Semantic-versioning intent is:

- patch: compatible fixes, documentation, and stronger verification
- minor: backward-compatible options, hooks, commands, or tools
- major: removal or incompatible change to a documented public surface

`testInternals` is exported for diagnostics and the project's own tests; it is not
part of the semantic-version compatibility guarantee.
