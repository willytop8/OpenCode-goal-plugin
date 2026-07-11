import assert from "node:assert/strict"
import test from "node:test"
import { createOpenCodeSessionApi } from "../src/opencode-session-api.js"

const operations = ["messages", "promptAsync", "prompt", "update", "get", "create", "delete", "abort"]

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
    api.delete("s4"),
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
    { sessionID: "s4" },
    { sessionID: "s5" },
    { sessionID: "s5" },
  ])
  assert.deepEqual(results, host.calls.map(({ input }) => input))
})

test("falls back to legacy inputs and remembers read-only operation shapes", async () => {
  const host = recordingClient((_operation, input) => {
    if (!("path" in input) && !("body" in input)) {
      throw new TypeError("validation failed: required path or body")
    }
    return { data: input }
  })
  const api = createOpenCodeSessionApi(host.client)
  await Promise.all([
    api.messages("s1", { limit: 4 }),
    api.get("s5"),
  ])
  await api.messages("again", { limit: 1 })

  const legacyCalls = host.calls.filter(({ input }) => "path" in input || "body" in input)
  assert.deepEqual(legacyCalls.map(({ input }) => input), [
    { path: { id: "s1" }, query: { limit: 4 } },
    { path: { id: "s5" } },
    { path: { id: "again" }, query: { limit: 1 } },
  ])
  assert.equal(host.calls.filter(({ operation }) => operation === "messages").length, 3)
  assert.equal(host.calls.filter(({ operation }) => operation === "get").length, 2)
})

test("never replays mutating operations after an argument-shape TypeError", async () => {
  const mutatingCalls = [
    [
      "promptAsync",
      (api) => api.promptAsync("s1", { parts: [] }),
      { sessionID: "s1", parts: [] },
      { path: { id: "s1" }, body: { parts: [] } },
    ],
    [
      "create",
      (api) => api.createChild("parent", { title: "child" }),
      { title: "child", parentID: "parent" },
      { body: { title: "child", parentID: "parent" } },
    ],
    [
      "prompt",
      (api) => api.prompt("s2", { parts: [] }),
      { sessionID: "s2", parts: [] },
      { path: { id: "s2" }, body: { parts: [] } },
    ],
    [
      "update",
      (api) => api.update("s3", { title: "renamed" }),
      { sessionID: "s3", title: "renamed" },
      { path: { id: "s3" }, body: { title: "renamed" } },
    ],
    ["delete", (api) => api.delete("s3"), { sessionID: "s3" }, { path: { id: "s3" } }],
    ["abort", (api) => api.abort("s4"), { sessionID: "s4" }, { path: { id: "s4" } }],
  ]

  for (const preferredShape of ["flat", "legacy"]) {
    for (const [operation, call, flatInput, legacyInput] of mutatingCalls) {
      const host = recordingClient(() => {
        throw new TypeError("validation failed: required path or body")
      })
      const api = createOpenCodeSessionApi(host.client, { preferredShape })

      await assert.rejects(call(api), /validation failed/)
      assert.deepEqual(host.calls, [
        { operation, input: preferredShape === "flat" ? flatInput : legacyInput },
      ])
    }
  }
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
