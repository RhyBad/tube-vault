/**
 * Feedback EN strings — the defaults for the "moment" components (error state,
 * type-to-confirm prompt, notification a11y). Callers usually pass their own
 * copy; these are the sensible fallbacks.
 */
export default {
  feedback: {
    error: {
      title: 'Something went wrong',
      body: "This didn't load. You can try again.",
    },
    confirm: {
      typePrompt: 'Type {{text}} to confirm',
    },
    notification: {
      unread: 'Unread',
    },
  },
} as const;
