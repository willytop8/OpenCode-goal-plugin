import assert from "node:assert/strict"
import test from "node:test"

import { GoalPlugin, testInternals } from "../src/goal-plugin.js"

const { currentGoal, listSessionGoals } = testInternals

function random(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

async function command(hooks, sessionID, argumentsText) {
  const output = { parts: [] }
  await hooks["command.execute.before"](
    { command: "goal", sessionID, arguments: argumentsText },
    output,
  )
  return output.parts[0]?.text ?? ""
}

test("generated command sequences preserve the multi-goal lifecycle model", async () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const next = random(seed)
    const sessionID = `model-${seed}`
    const hooks = await GoalPlugin(
      { client: { session: {} } },
      { persistState: false, registerTools: false },
    )
    const model = { goals: [], focused: -1, running: false, serial: 0 }

    try {
      for (let step = 0; step < 100; step += 1) {
        const action = Math.floor(next() * 7)
        if (action === 0) {
          const objective = `set-${seed}-${model.serial++}`
          if (model.focused >= 0) model.goals.splice(model.focused, 1)
          model.goals.push(objective)
          model.focused = model.goals.length - 1
          model.running = true
          await command(hooks, sessionID, objective)
        } else if (action === 1 && model.goals.length < 10) {
          const objective = `add-${seed}-${model.serial++}`
          model.goals.push(objective)
          model.focused = model.goals.length - 1
          model.running = true
          await command(hooks, sessionID, `add ${objective}`)
        } else if (action === 2 && model.goals.length > 0) {
          const index = Math.floor(next() * model.goals.length)
          if (index !== model.focused) {
            model.focused = index
            model.running = true
          }
          await command(hooks, sessionID, `focus ${index + 1}`)
        } else if (action === 3 && model.focused >= 0) {
          model.running = false
          await command(hooks, sessionID, "pause")
        } else if (action === 4 && model.focused >= 0) {
          model.running = true
          await command(hooks, sessionID, "resume")
        } else if (action === 5 && model.focused >= 0) {
          const objective = `edit-${seed}-${model.serial++}`
          model.goals[model.focused] = objective
          model.running = true
          await command(hooks, sessionID, `edit ${objective}`)
        } else if (action === 6) {
          model.goals = []
          model.focused = -1
          model.running = false
          await command(hooks, sessionID, "clear")
        }

        const actualGoals = listSessionGoals(sessionID)
        const focused = currentGoal(sessionID)
        assert.deepEqual(actualGoals.map(({ condition }) => condition), model.goals, `seed ${seed}, step ${step}`)
        assert.equal(new Set(actualGoals.map(({ goalId }) => goalId)).size, actualGoals.length)
        assert.equal(focused?.condition, model.focused >= 0 ? model.goals[model.focused] : undefined)
        assert.equal(focused ? actualGoals.includes(focused) : false, model.focused >= 0)
        if (focused) assert.equal(focused.stopped, !model.running)
        for (const goal of actualGoals) {
          if (goal !== focused) assert.equal(goal.stopped, true)
        }
      }
    } finally {
      await hooks.dispose()
    }
  }
})
