/**
 * Forms KO strings (partial — missing keys fall back to EN at runtime).
 */
const forms: {
  forms: {
    stepper: Record<string, string>;
    secret: Record<string, string>;
  };
} = {
  forms: {
    stepper: {
      decrement: '감소',
      increment: '증가',
    },
    secret: {
      placeholderEnter: '비밀 값 입력',
      placeholderUnchanged: '•••••••••••• (변경 없음)',
      keepHint: '비워 두면 기존 비밀 값이 유지됩니다.',
      deleteHint: '지움 — 저장하면 저장된 비밀 값이 삭제됩니다.',
      setHint: '저장하면 비밀 값이 교체됩니다.',
      emptyHint: '저장된 비밀 값이 없습니다.',
      reveal: '비밀 값 표시',
      hide: '비밀 값 숨기기',
      clear: '저장된 비밀 값 지우기',
    },
  },
};

export default forms;
