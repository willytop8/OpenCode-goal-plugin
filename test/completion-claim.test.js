import assert from "node:assert/strict"
import test from "node:test"
import { serializeCompletionClaim } from "../src/completion-claim.js"

test("completion claims reject non-object input without throwing", () => {
  for (const input of [null, [], "done", 1]) {
    assert.deepEqual(serializeCompletionClaim(input), {
      ok: false,
      error: "summary must be a non-empty string",
    })
  }
})

test("manual not-run checks retain their explanation without undefined fields", () => {
  assert.deepEqual(
    serializeCompletionClaim({
      summary: "Reviewed manually",
      checks: [{ result: "not-run", explanation: "No executable test exists" }],
    }),
    {
      ok: true,
      evidence: [
        "Summary: Reviewed manually",
        "Check: manual check | not-run | No executable test exists",
      ].join("\n"),
    },
  )
})
