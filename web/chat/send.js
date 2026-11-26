export function createSendCoordinator({ submit, requestId, isAvailable, isBusy, onChange, onAccepted, status }) {
  let sending = false;
  let lastAttempt;
  let accepted = 0;

  function isRetry(body) {
    // Drafts replace their arrays on edits, so retries need not serialize images to compare them.
    return lastAttempt && lastAttempt.attachments === body.attachments &&
      lastAttempt.annotations === body.annotations && lastAttempt.text === body.text;
  }

  function canSend(body) {
    return !sending && isAvailable() && (!isBusy() || isRetry(body));
  }

  return {
    canSend,
    get sending() { return sending; },
    get accepted() { return accepted; },
    invalidateRetry(field) {
      if (lastAttempt?.[field]) lastAttempt = undefined;
    },
    async send(body, clearDraft) {
      if (!canSend(body)) return;
      // An unchanged retry reuses the ID when Pi may have accepted a send whose response was lost.
      if (!isRetry(body)) lastAttempt = { ...body, id: requestId() };
      sending = true;
      onChange();
      status("Sending to Pi…");
      try {
        const result = await submit({ ...body, requestId: lastAttempt.id });
        lastAttempt = undefined;
        clearDraft(result);
        accepted++;
        onAccepted(result);
        status("Sent to Pi.");
      } catch (error) {
        status(error.message || "Could not confirm the send. Your draft is still here.", true);
      } finally {
        sending = false;
        onChange();
      }
    },
  };
}
