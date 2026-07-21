/** Login KO overrides — S0. Partial by design; any missing key falls back to EN. */
export default {
  login: {
    lead: '계속하려면 접속 시크릿을 입력하세요.',
    secretLabel: '접속 시크릿',
    placeholder: '접속 시크릿 입력',
    reveal: '시크릿 표시',
    hide: '시크릿 숨기기',
    submit: '로그인',
    busy: '로그인 중…',
    capsHint: 'Caps Lock이 켜져 있습니다',
    error: {
      invalid: '인증 정보가 올바르지 않습니다.',
      malformed: '요청에 문제가 있습니다.',
      rate: '시도가 너무 많습니다. 잠시 후 다시 시도하세요.',
      generic: '문제가 발생했습니다. 다시 시도하세요.',
    },
    cooldown: '{{time}} 후 다시 시도',
    success: {
      title: '잠금 해제됨',
      sub: '보관소로 이동하는 중…',
    },
    footer: '단일 사용자 보관소 · 세션 12시간 유지',
    theme: {
      toDark: '다크 테마로 전환',
      toLight: '라이트 테마로 전환',
    },
    lang: {
      group: '언어',
      en: 'EN',
      ko: '한국어',
    },
  },
};
