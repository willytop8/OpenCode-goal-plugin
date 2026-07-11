import assert from "node:assert/strict"
import test from "node:test"

import { applyNativeGoalConfig } from "../src/native-agent-config.js"

test("registers native goal and read-only verifier agents", () => {
  const config = {}
  assert.equal(applyNativeGoalConfig(config), config)
  assert.equal(config.agent.goal.mode, "primary")
  assert.match(config.agent.goal.prompt, /verification evidence/)
  assert.equal(config.agent["goal-verify"].mode, "subagent")
  assert.equal(config.agent["goal-verify"].hidden, true)
  assert.equal(config.agent["goal-verify"].permission.edit, "deny")
  assert.equal(config.agent["goal-verify"].permission.bash, "deny")
  assert.equal(config.agent["goal-verify"].tools.bash, false)
  assert.equal(config.agent["goal-verify"].tools.edit, false)
  assert.equal(config.agent["goal-verify"].tools.goal_complete, false)
})

test("preserves user-defined agents and is idempotent", () => {
  const custom = { description: "mine", mode: "primary" }
  const config = { agent: { goal: custom } }
  applyNativeGoalConfig(config)
  applyNativeGoalConfig(config)
  assert.equal(config.agent.goal, custom)
  assert.equal(Object.keys(config.agent).length, 2)
})

test("supports custom names and registration opt-out", () => {
  const custom = {}
  applyNativeGoalConfig(custom, { goalAgentName: "objective", verifierAgentName: "objective-check" })
  assert.ok(custom.agent.objective)
  assert.ok(custom.agent["objective-check"])

  const disabled = {}
  applyNativeGoalConfig(disabled, { registerAgents: false })
  assert.deepEqual(disabled, {})
})

test("validates config and agent names at the boundary", () => {
  assert.throws(() => applyNativeGoalConfig(null), /mutable config object/)
  assert.throws(() => applyNativeGoalConfig({}, { goalAgentName: "" }), /non-empty string/)
  assert.throws(() => applyNativeGoalConfig({}, { verifierAgentName: 42 }), /non-empty string/)
  assert.throws(() => applyNativeGoalConfig({}, { goalAgentName: "same", verifierAgentName: "same" }), /must be different/)
  assert.throws(() => applyNativeGoalConfig({}, { verifierAgentName: " verifier " }), /surrounding whitespace/)
  assert.throws(
    () => applyNativeGoalConfig({ agent: { verifier: {} } }, { verifierAgentName: "verifier", requireVerifierOwnership: true }),
    /cannot safely use existing agent/,
  )
})
