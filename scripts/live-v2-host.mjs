import assert from "node:assert/strict"
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
const runtimeRoot = process.env.OPENCODE_V2_RUNTIME_DIR
assert.ok(runtimeRoot, "Set OPENCODE_V2_RUNTIME_DIR to an isolated installation of @opencode/cli@2.0.16 and @opencode/plugin@2.0.16; see docs/compatibility.md")
const { make } = await import(pathToFileURL(resolve(runtimeRoot, "node_modules/@opencode/client/dist/promise/client.js")))

const source = process.env.OPENCODE_GOAL_PLUGIN_SOURCE || fileURLToPath(new URL("../src/goal-plugin.js", import.meta.url))
const binary = process.env.OPENCODE_V2_BINARY || join(runtimeRoot, "node_modules", `@opencode/cli-${process.platform}-${process.arch}`, "bin", process.platform === "win32" ? "opencode.exe" : "opencode")
const root = await fs.mkdtemp(join(tmpdir(), "goal-v2-acceptance-"))
const project = join(root, "project")
const observations = join(root, "contexts.jsonl")
const foreignVerifier = process.env.GOAL_V2_FOREIGN_VERIFIER === "1"
const captures = []
const fixture = createServer(async (req, res) => {
  let raw = ""
  for await (const chunk of req) raw += chunk
  if (!req.url.endsWith("/chat/completions")) { res.writeHead(404); res.end(); return }
  const body = JSON.parse(raw)
  captures.push(body)
  const audit = body.messages.some(m => JSON.stringify(m.content).includes("independent completion auditor"))
  const complete = body.tools?.length && !audit && body.messages.some(m => JSON.stringify(m.content).includes("COMPLETE_CANARY")) && !body.messages.some(m => m.role === "tool")
  const content = audit ? "Verified local fixture evidence.\n[audit:approved]" : "Local fixture response."
  const delta = complete ? { role: "assistant", tool_calls: [{ index: 0, id: "call-complete", type: "function", function: { name: "execute", arguments: JSON.stringify({ code: 'return await tools.goal_complete({ summary: "Local fixture verified" })' }) } }] } : { role: "assistant", content }
  res.writeHead(200, { "content-type": "text/event-stream" })
  for (const chunk of [{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: complete ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }]) {
    res.write(`data: ${JSON.stringify({ id: `chat-${captures.length}`, object: "chat.completion.chunk", created: 1, model: "test", ...chunk })}\n\n`)
  }
  res.end("data: [DONE]\n\n")
})
await new Promise(r => fixture.listen(0, "127.0.0.1", r))
const reserve = createServer()
await new Promise(r => reserve.listen(0, "127.0.0.1", r))
const port = reserve.address().port
await new Promise(r => reserve.close(r))
for (const dir of [project, join(project, ".opencode", "plugins"), ...["home", "data", "config", "cache", "state"].map(x => join(root, x))]) await fs.mkdir(dir, { recursive: true })
await fs.writeFile(join(project, ".opencode", "plugins", "goal.js"), `
import plugin from ${JSON.stringify(pathToFileURL(source).href)}
import { promises as fs } from "node:fs"
export default { ...plugin, async setup(ctx) {
  ctx.options = { completionAudit: true, auditMessages: false, lifecycleMessages: false, minDelayMs: 60000, auditorOptions: { timeoutMs: 10000 } }
  await ctx.session.hook("context", async event => {
    const result = await ctx.agent.get({ agentID: event.agent }); const agent = result.data || result
    await fs.appendFile(${JSON.stringify(observations)}, JSON.stringify({ sessionID: event.sessionID, agent: event.agent, system: agent.system, permissions: agent.permissions, tools: Object.keys(event.tools) }) + "\\n")
  })
  const cleanup = await plugin.setup(ctx)
  if (${JSON.stringify(foreignVerifier)}) await ctx.agent.transform(editor => editor.update("goal-verify", agent => { agent.system = "Foreign verifier" }))
  return cleanup
} }
`)
await fs.writeFile(join(project, "opencode.json"), JSON.stringify({ model: "local-capture/test", provider: { "local-capture": { npm: "@ai-sdk/openai-compatible", name: "Local fixture", options: { baseURL: `http://127.0.0.1:${fixture.address().port}/v1`, apiKey: "test-only" }, models: { test: { name: "Local fixture" } } } } }))
const env = { ...process.env, HOME: join(root, "home"), XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), OPENCODE_SERVER_PASSWORD: "local-test-only", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1" }
delete env.BUN_BE_BUN
const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] })
let log = ""
child.stdout.on("data", c => { log += c })
child.stderr.on("data", c => { log += c })
const client = make({ baseUrl: `http://127.0.0.1:${port}`, headers: { "x-opencode-directory": project, authorization: "Basic " + Buffer.from("opencode:local-test-only").toString("base64") } })
const location = { directory: project }
const state = async sessionID => JSON.parse(await fs.readFile(join(project, ".opencode", "goals", "state.json.sessions", createHash("sha256").update(sessionID).digest("hex"), "state.json"), "utf8"))
try {
  let ready = false
  for (let i = 0; i < 100; i++) {
    try { await client.server.info(); ready = true; break } catch {}
    if (child.exitCode !== null) throw new Error(log)
    await new Promise(r => setTimeout(r, 100))
  }
  assert.ok(ready, log)
  const plugins = await client.plugin.list({ location })
  await fs.writeFile(join(root, "plugins.json"), JSON.stringify(plugins, null, 2))
  const results = []
  for (const text of ["add verify Plan add protection", "sequence first step; second step"]) {
    const session = await client.session.create({ location, agent: "plan" })
    await client.session.command({ sessionID: session.id, name: "goal", text })
    await client.session.wait({ sessionID: session.id })
    const stored = await state(session.id)
    assert.ok(stored.goals.some(g => g.stopped && g.stopReason === "plan agent active"), JSON.stringify(stored))
    results.push({ command: text, planHeld: true })
  }
  const session = await client.session.create({ location, agent: "build", model: { providerID: "local-capture", id: "test" } })
  await client.session.command({ sessionID: session.id, name: "goal", text: "COMPLETE_CANARY verify local fixture" })
  await client.session.wait({ sessionID: session.id })
  const stored = await state(session.id)
  await fs.writeFile(join(root, "completion-state.json"), JSON.stringify(stored, null, 2))
  assert.equal(stored.archives.length > 0 || stored.results.length > 0, !foreignVerifier, JSON.stringify(stored))
  const observed = (await fs.readFile(observations, "utf8")).trim().split("\n").map(JSON.parse)
  const verifier = observed.find(o => o.agent === "goal-verify")
  if (foreignVerifier) {
    assert.equal(verifier, undefined)
    assert.ok(stored.goals.some(g => !g.archived))
    console.log(JSON.stringify({ root, foreignVerifier: "completion rejected without a verifier prompt", captures: captures.length }, null, 2))
  } else {
  assert.ok(verifier, JSON.stringify(observed))
  assert.ok(!verifier.tools.includes("goal_complete"))
  // OpenCode 2.0.26 added session.remove to the plugin API, so the verifier
  // child is deleted after the verdict; earlier hosts retain it.
  let childCleanup
  try {
    const retained = await client.session.get({ sessionID: verifier.sessionID }); assert.equal((retained.data || retained).title, "goal completion audit")
    childCleanup = "host plugin API has no remove operation; child retained"
  } catch (error) {
    if (error?._tag !== "SessionNotFoundError") throw error
    childCleanup = "verifier child removed after verdict"
  }
  results.push({ completion: "approved by owned verifier", verifierAgent: verifier.agent, childCleanup, verifierTools: verifier.tools })
  const live = await client.session.create({ location, agent: "build" })
  await client.session.command({ sessionID: live.id, name: "goal", text: "reload preserved objective" })
  await client.session.wait({ sessionID: live.id })
  await client.location.reload()
  await client.plugin.list({ location })
  await client.session.command({ sessionID: live.id, name: "goal", text: "status" })
  await client.session.wait({ sessionID: live.id })
  const recovered = await state(live.id)
  assert.ok(recovered.goals.some(g => g.condition === "reload preserved objective" && g.stopReason === "recovered after restart"), JSON.stringify(recovered))
  results.push({ sameProcessReload: "lease released by old instance; goal recovered paused" })
  console.log(JSON.stringify({ root, info: await client.server.info(), results, captures: captures.length }, null, 2))
  }
} catch (error) {
  console.error({ root, log })
  throw error
} finally {
  child.kill("SIGTERM")
  await fs.writeFile(join(root, "server.log"), log)
  await fs.writeFile(join(root, "captures.json"), JSON.stringify(captures, null, 2))
  fixture.closeAllConnections()
  fixture.close()
}
