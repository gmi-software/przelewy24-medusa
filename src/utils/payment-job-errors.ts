export function getJobErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.cause) {
      const causeMessage = getJobErrorMessage(error.cause)

      if (causeMessage && causeMessage !== error.message) {
        return `${error.message}: ${causeMessage}`
      }
    }

    return error.message
  }

  if (typeof error === 'string') {
    return error
  }

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>

    if (typeof record.message === 'string') {
      return record.message
    }

    if (record.error) {
      return getJobErrorMessage(record.error)
    }

    if (Array.isArray(record.errors) && record.errors.length > 0) {
      return getJobErrorMessage(record.errors[0])
    }
  }

  return 'unknown'
}

export function isExpectedStalePaymentJobFailure(error: unknown): boolean {
  const message = getJobErrorMessage(error).toLowerCase()

  return (
    // a bare 404: "timed out after 4040ms" is a timeout, not a stale session
    /\b404\b/.test(message) ||
    message.includes('not found') ||
    message.includes('400 bad request') ||
    message.includes('verification failed')
  )
}
