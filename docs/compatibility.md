# Compatibility policy

## Supported package surface

The latest published release is the supported line. Public compatibility covers:

- the package root and `opencode-goal-plugin/server` ESM exports
- the declarations exported by `index.d.ts`
- the documented `GoalPluginOptions` fields
- the documented OpenCode hook names
- the six canonical goal tools and five legacy tool aliases
- persisted-state recovery from versions documented in the changelog
- concurrent persistence for distinct OpenCode sessions in one project, with
  single-writer protection retained per session

The package requires Node.js 18 or newer and OpenCode 1.17.15 through the latest
compatible 1.x release. CI runs the complete unit suite on Node 18, 20, 22, and
24. Installed-package contracts compile TypeScript consumers using both NodeNext
and Bundler resolution and require a clean npm-tarball install to expose the
default agent-tool surface without a separately installed OpenCode helper package.

Filesystem-sensitive lifecycle tests run on Linux, macOS, and Windows. POSIX file
mode and symbolic-link protections are applied where the operating system supports
them; the plugin does not claim that Windows provides equivalent POSIX semantics.
The Windows job also runs the installed-package type, host, and tool contracts
so their portable npm launcher path is exercised in CI.

## OpenCode host compatibility

OpenCode's experimental hooks and SDK request shapes may change within the 1.x
line. Automated tests cover both current flattened session inputs and the legacy
generated-client shape, but a real-host smoke test remains required when hook or
SDK behavior changes. The current manual provider matrix is maintained in
[providers.md](providers.md).

OpenCode custom commands still become model turns. The plugin handles `/goal`
arguments in `command.execute.before` and mutates the host-retained parts array
in place so the turn contains the plugin-generated command result rather than
raw command text. This makes command routing deterministic, but does not turn the
hook into a direct-render API: the selected model remains responsible for the
visible response.

For objective-bearing commands, retained file attachments may be expanded by
OpenCode into synthetic Read/MCP text and file parts before `chat.message`. The
plugin correlates that host-resolved shape to the exact one-shot command and
generated message/session before treating it as plugin-owned. Each retained
file must yield at least one resolved companion part; a host-reported read error
pauses the goal without reclassifying the command as human intervention.

OpenCode 1.17.15 and 1.18.10 do not invoke
`experimental.chat.system.transform`. Control-command correctness therefore
comes from the rewritten turn's escaped reporting frame, fail-closed tool
blocking, and parent-correlated lifecycle suppression. The system transform
remains registered as additional protection for hosts that support it.

## Versioning

Semantic-versioning intent is:

- patch: compatible fixes, documentation, and stronger verification
- minor: backward-compatible options, hooks, commands, or tools
- major: removal or incompatible change to a documented public surface

`testInternals` is exported for diagnostics and the project's own tests; it is not
part of the semantic-version compatibility guarantee.
