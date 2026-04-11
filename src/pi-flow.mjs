export function shouldPersistLatestTesterFeedback(source) {
  return String(source ?? '').trim() !== 'tester_commit_plan'
}

export function deriveWorkflowStatus({
  developerStatus,
  testerStatus,
  verificationStatus,
}) {
  return (
    developerStatus === 'success'
    && testerStatus === 'success'
    && (
      verificationStatus === 'passed'
      || verificationStatus === 'skipped'
      || verificationStatus === 'not_run'
    )
  )
    ? 'success'
    : developerStatus === 'complete'
      ? 'complete'
      : developerStatus !== 'success'
        ? developerStatus
        : testerStatus !== 'success'
          ? testerStatus
          : verificationStatus
}

export function deriveFinalStatusWithVisualReview({
  workflowStatus,
  visualStatus,
}) {
  if (workflowStatus !== 'success') {
    return workflowStatus
  }

  if (visualStatus === 'failed' || visualStatus === 'timed_out' || visualStatus === 'blocked') {
    return visualStatus
  }

  return workflowStatus
}
