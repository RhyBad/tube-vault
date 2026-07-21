/**
 * Forms EN strings — the micro-labels inside form controls (stepper button
 * aria-labels, the write-only secret field's status + affordances). Externalized
 * so KO switches them too (the i18n-audit rule; the design tool hardcoded some).
 */
export default {
  forms: {
    stepper: {
      decrement: 'Decrease',
      increment: 'Increase',
    },
    secret: {
      placeholderUnchanged: '•••••••••••• (unchanged)',
      placeholderEnter: 'Enter secret',
      keepHint: 'Leave blank to keep the current secret.',
      deleteHint: 'Cleared — saving will delete the stored secret.',
      setHint: 'Saving will replace the secret.',
      emptyHint: 'No secret stored.',
      reveal: 'Show secret',
      hide: 'Hide secret',
      clear: 'Clear stored secret',
    },
  },
} as const;
