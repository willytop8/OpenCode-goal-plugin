# Release process

Releases are deliberately verified before they are published. GitHub Actions does
not publish to npm automatically; the maintainer reviews and publishes the exact
artifact after all checks pass.

## Prepare

1. Start from a clean branch based on `main`.
2. Update the version in `package.json` and `package-lock.json` together.
3. Move relevant entries from `Unreleased` into a dated changelog section.
4. Run `npm ci` followed by `npm run release:check`.
5. Inspect `npm pack --json` and the generated tarball before publishing.

`release:check` runs the unit and coverage suites, consumer type compilation,
critical mutation contract, behavior benchmark, source and installed-artifact
smoke tests, full optional-peer tool registration, and package-content check.

## Publish

After the commit is reviewed and CI is green, create and push an annotated
`vX.Y.Z` tag at the same commit. The release workflow rejects a tag whose version
does not match `package.json`, reruns the complete release gate, and retains the
verified npm tarball as a workflow artifact.

Download that artifact, inspect it, and publish the tarball itself:

```sh
npm publish opencode-goal-plugin-X.Y.Z.tgz --access public
```

Confirm the registry digest and unpacked contents match the locally reviewed
artifact before drafting the GitHub release notes. Never rebuild or edit an
artifact after it has been published; prepare a new patch release instead.

## Trusted publishing

For a future fully automated publish, configure npm Trusted Publishing for this
repository and a narrowly scoped GitHub Actions workflow, keep `id-token: write`
only on the publish job, require the release environment, and publish with
provenance. Do not add a long-lived npm token to repository secrets.
