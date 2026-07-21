/** Live KO overrides — S7. Partial by design; any missing key falls back to EN. */
export default {
  live: {
    error: {
      title: '이 영역을 불러오지 못했어요',
      desc: '연결이 끊겼어요. 놓친 건 없으니 다시 시도해 주세요.',
    },
    captures: {
      eyebrow: '라이브 · 지금 시청 중',
      title: '진행 중인 캡처',
      sub: '지금 보관함에 녹화되고 있는 방송입니다.',
      loading: '진행 중인 캡처 불러오는 중…',
      detected: '방송을 감지했어요 — 곧 녹화가 시작됩니다.',
      empty: {
        title: '진행 중인 방송 없음',
        desc: '감시 중인 채널이 방송을 시작하면 여기에서 실시간으로 볼 수 있어요 — 놓친 건 없어요.',
        cta: '채널 라이브 감시하기',
      },
    },
    channels: {
      eyebrow: '수집 대상',
      title: '감시 중인 채널',
      sub: 'TubeVault가 라이브 방송을 확인하는 채널입니다.',
      loading: '감시 중인 채널 불러오는 중…',
      toggle: '라이브 감시',
      paused: '감시 일시중지',
      undo: '되돌리기',
      pausedToast: '감시 일시중지 — 진행 중인 캡처는 계속돼요.',
      watchingToast: '라이브 감시 · 켜짐.',
      toggleError: '라이브 감시 변경에 실패했어요 — 다시 시도해 주세요.',
      cred: {
        title:
          '멤버 전용 라이브를 캡처하려면 유효한 YouTube 인증이 필요해요 — 없으면 일부는 건너뛸 수 있어요.',
        action: '설정에서 확인',
      },
      empty: {
        title: '감시 중인 채널 없음',
        desc: '채널의 라이브 감시를 켜면 방송을 자동으로 저장해요.',
        cta: '채널 추가',
      },
    },
    recent: {
      eyebrow: '녹화본',
      title: '최근 종료된 방송',
      sub: '종료되어 보관된 라이브 방송입니다.',
      loading: '최근 종료된 방송 불러오는 중…',
      reassure: '방금 끝난 라이브는 확인에 시간이 걸릴 수 있어요 — 별도 조치 불필요.',
      empty: {
        title: '최근 종료된 방송 없음',
        desc: '라이브 방송이 끝나면 여기에 표시돼요.',
      },
    },
  },
};
