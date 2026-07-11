import test from "node:test"
import assert from "node:assert/strict"
import { goalToolFailure, goalToolSuccess, serializeGoalToolResult } from "../src/goal-tool-result.js"

test("goal tool result serializer emits stable success and error envelopes", () => {
  assert.deepEqual(JSON.parse(serializeGoalToolResult("status", goalToolSuccess("ready", { turns: 2 }))), {
    version: 1, operation: "status", ok: true, message: "ready", data: { turns: 2 },
  })
  assert.deepEqual(JSON.parse(serializeGoalToolResult("pause", goalToolFailure("no_active_goal", "localized prose"))), {
    version: 1, operation: "pause", ok: false, error: "no_active_goal", message: "localized prose",
  })
})
