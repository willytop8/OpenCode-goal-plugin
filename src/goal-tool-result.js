export function goalToolSuccess(message, data) {
  return { ok: true, message, ...(data === undefined ? {} : { data }) }
}

export function goalToolFailure(code, message) {
  return { ok: false, code, message }
}

export function serializeGoalToolResult(operation, result) {
  return JSON.stringify({
    version: 1,
    operation,
    ok: result.ok,
    ...(!result.ok ? { error: result.code } : {}),
    message: result.message,
    ...(result.data === undefined ? {} : { data: result.data }),
  })
}
