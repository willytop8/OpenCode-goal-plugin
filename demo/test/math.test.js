import test from "node:test"
import assert from "node:assert/strict"
import { add } from "../src/math.js"

test("add returns the sum of two numbers", () => {
  assert.equal(add(2, 3), 5)
})

test("add handles negative numbers", () => {
  assert.equal(add(-1, -1), -2)
})
