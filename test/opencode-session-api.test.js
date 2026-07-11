import assert from "node:assert/strict"
import test from "node:test"
import { createOpenCodeSessionApi } from "../src/opencode-session-api.js"

const operations = ["messages", "promptAsync", "prompt", "update", "get", "create", "abort"]

function recordingClient(handler) {
  const calls = []
  return {
    calls,
    client: {
      session: Object.fromEntries(
        operations.map((operation) => [
          operation,
          async (input) => {
            calls.push({ operation, input })
            return handler(operation, input)
          },
        ]),
      ),
    },
  }
}

async function exercise(api) {
  return Promise.all([
    api.messages("s1", { limit: 4 }),
    api.promptAsync("s2", { parts: [{ type: "text", text: "continue" }] }),
    api.createChild("parent", { title: "child" }),
    api.prompt("s3", { parts: [] }),
    api.update("s4", { title: "renamed" }),
    api.abort("s5"),
    api.get("s5"),
  ])
}

test("uses current flattened SDK inputs and normalizes data responses", async () => {
  const host = recordingClient((_operation, input) => ({ data: input }))
  const results = await exercise(createOpenCodeSessionApi(host.client))

  assert.deepEqual(host.calls.map(({ input }) => input), [
    { sessionID: "s1", limit: 4 },
    { sessionID: "s2", parts: [{ type: "text", text: "continue" }] },
    { title: "child", parentID: "parent" },
    { sessionID: "s3", parts: [] },
    { sessionID: "s4", title: "renamed" },
    { sessionID: "s5" },
    { sessionID: "s5" },
  ])
  assert.deepEqual(results, host.calls.map(({ input }) => input))
})

test("falls back to legacy path/query/body inputs and remembers each operation", async () => {
  const host = recordingClient((_operation, input) => {
    if (!("path" in input) && !("body" in input)) {
      throw new TypeError("validation failed: required path or body")
    }
    return { data: input }
  })
  const api = createOpenCodeSessionApi(host.client)
  await exercise(api)
  await api.messages("again", { limit: 1 })

  const legacyCalls = host.calls.filter(({ input }) => "path" in input || "body" in input)
  assert.deepEqual(legacyCalls.map(({ input }) => input), [
    { path: { id: "s1" }, query: { limit: 4 } },
    { path: { id: "s2" }, body: { parts: [{ type: "text", text: "continue" }] } },
    { body: { title: "child", parentID: "parent" } },
    { path: { id: "s3" }, body: { parts: [] } },
    { path: { id: "s4" }, body: { title: "renamed" } },
    { path: { id: "s5" } },
    { path: { id: "s5" } },
    { path: { id: "again" }, query: { limit: 1 } },
  ])
  assert.equal(host.calls.filter(({ operation }) => operation === "messages").length, 3)
})

test("does not retry prompts after a real host or provider error", async () => {
  for (const error of [
    new Error("provider rate limit"),
    new TypeError("provider stream decoder crashed"),
  ]) {
    let calls = 0
    const client = { session: { promptAsync: async () => { calls += 1; throw error } } }
    const api = createOpenCodeSessionApi(client)
    await assert.rejects(api.promptAsync("s", { parts: [] }), (actual) => actual === error)
    assert.equal(calls, 1)
  }
})

test("supports an explicit legacy preference without probing", async () => {
  const host = recordingClient((_operation, input) => input)
  const api = createOpenCodeSessionApi(host.client, { preferredShape: "legacy" })
  await api.get("known")
  assert.deepEqual(host.calls[0].input, { path: { id: "known" } })
})
