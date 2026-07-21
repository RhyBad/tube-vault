/**
 * Feedback KO strings (partial — missing keys fall back to EN).
 */
const feedback: {
  feedback: {
    error: Record<string, string>;
    confirm: Record<string, string>;
    notification: Record<string, string>;
  };
} = {
  feedback: {
    error: {
      title: '문제가 발생했습니다',
      body: '불러오지 못했습니다. 다시 시도할 수 있습니다.',
    },
    confirm: {
      typePrompt: '확인하려면 {{text}} 을(를) 입력하세요',
    },
    notification: {
      unread: '읽지 않음',
    },
  },
};

export default feedback;
