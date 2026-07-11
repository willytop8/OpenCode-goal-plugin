const GOAL_AGENT_PROMPT = `Execute explicit goals persistently. Use goal tools to track state and checkpoints. Make concrete progress; claim completion only with verification evidence. Report only genuine blockers.`

const VERIFIER_AGENT_PROMPT = `Independently verify the claim against the goal, constraints, evidence, and workspace. Use only the read, glob, and grep tools; never edit, execute commands, call other tools, or mutate goal state. Approve only when proven; otherwise give one actionable reason.`

export function applyNativeGoalConfig(config, options = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("OpenCode config hook requires a mutable config object")
  }
  if (options.registerAgents === false) return config

  const goalAgentName = options.goalAgentName ?? "goal"
  const verifierAgentName = options.verifierAgentName ?? "goal-verify"
  if (typeof goalAgentName !== "string" || !goalAgentName.trim()) {
    throw new TypeError("goalAgentName must be a non-empty string")
  }
  if (typeof verifierAgentName !== "string" || !verifierAgentName.trim()) {
    throw new TypeError("verifierAgentName must be a non-empty string")
  }
  if (goalAgentName !== goalAgentName.trim() || verifierAgentName !== verifierAgentName.trim()) {
    throw new TypeError("goal and verifier agent names cannot have surrounding whitespace")
  }
  if (goalAgentName === verifierAgentName) {
    throw new TypeError("goalAgentName and verifierAgentName must be different")
  }

  config.agent ||= {}
  if (options.requireVerifierOwnership && config.agent[verifierAgentName]) {
    throw new Error(
      `completionAudit cannot safely use existing agent ${JSON.stringify(verifierAgentName)}; choose an unused verifierAgentName`,
    )
  }
  config.agent[goalAgentName] ||= {
    description: "Execute an explicit user goal with persistent progress and evidence-gated completion.",
    mode: "primary",
    prompt: GOAL_AGENT_PROMPT,
  }
  config.agent[verifierAgentName] ||= {
    description: "Independently verify a goal completion claim without modifying the workspace.",
    mode: "subagent",
    hidden: true,
    prompt: VERIFIER_AGENT_PROMPT,
    permission: {
      "*": "deny",
      read: "allow",
      glob: "allow",
      grep: "allow",
      edit: "deny",
      bash: "deny",
    },
    tools: {
      bash: false,
      write: false,
      edit: false,
      patch: false,
      goal_set: false,
      goal_update: false,
      goal_pause: false,
      goal_resume: false,
      goal_block: false,
      goal_complete: false,
      goal_cancel: false,
      set_goal: false,
      update_goal: false,
      clear_goal: false,
    },
  }
  return config
}

export const nativeAgentConfigInternals = Object.freeze({
  GOAL_AGENT_PROMPT,
  VERIFIER_AGENT_PROMPT,
})
