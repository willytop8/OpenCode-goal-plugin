import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const repository = new URL("..", import.meta.url)
const root = await mkdtemp(join(tmpdir(), "opencode-goal-plugin-packed-tools-"))
const packDirectory = join(root, "pack")
const projectDirectory = join(root, "consumer")
const cacheDirectory = join(root, "npm-cache")
const npmEnvironment = { ...process.env, npm_config_cache: cacheDirectory }
const sourceManifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
const peerVersion = sourceManifest.devDependencies?.["@opencode-ai/plugin"]
assert.match(peerVersion ?? "", /^\d+\.\d+\.\d+$/, "a pinned @opencode-ai/plugin devDependency is required")

const expectedTools = [
  "clear_goal",
  "get_goal",
  "get_goal_history",
  "goal_block",
  "goal_complete",
  "goal_pause",
  "goal_resume",
  "goal_set",
  "goal_status",
  "set_goal",
  "update_goal",
]

try {
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(projectDirectory, { recursive: true }),
    mkdir(cacheDirectory, { recursive: true }),
  ])
  await writeFile(join(projectDirectory, "package.json"), JSON.stringify({ private: true, type: "module" }))

  const packResult = JSON.parse(execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", packDirectory],
    { cwd: repository, encoding: "utf8", env: npmEnvironment },
  ))
  assert.equal(packResult.length, 1)
  const tarball = join(packDirectory, packResult[0].filename)

  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--cache", cacheDirectory, tarball, `@opencode-ai/plugin@${peerVersion}`],
    { cwd: projectDirectory, stdio: "pipe", env: npmEnvironment },
  )

  const installedRoot = join(projectDirectory, "node_modules", "opencode-goal-plugin")
  const manifest = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"))
  const installed = await import(pathToFileURL(join(installedRoot, manifest.main)).href)
  const hooks = await installed.GoalPlugin(
    { client: { session: {} }, directory: projectDirectory },
    { persistState: false },
  )

  assert.deepEqual(Object.keys(hooks.tool ?? {}).sort(), expectedTools)
  for (const name of expectedTools) {
    assert.equal(typeof hooks.tool[name].execute, "function", `${name} must be executable`)
  }

  const config = {}
  await hooks.config(config)
  assert.equal(config.agent["goal-verify"].permission["*"], "deny")
  assert.equal(config.agent["goal-verify"].permission.read, "allow")
  assert.equal(config.agent["goal-verify"].tools.edit, false)
  await hooks.dispose()

  console.log(`packed tool contract passed (${manifest.name}@${manifest.version}; ${expectedTools.length} tools)`)
} finally {
  await rm(root, { recursive: true, force: true })
}
