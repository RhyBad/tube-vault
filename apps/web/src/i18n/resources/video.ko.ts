/**
 * Video KO strings — S5 video detail. Full parity with video.en.ts (missing keys
 * fall back to EN at runtime, but S5 ships complete). Tone matches the rest of
 * the KO catalog: calm, preservation-first, honorific-neutral.
 */
export default {
  video: {
    back: '뒤로',
    contentType: {
      REGULAR: '일반',
      SHORTS: '쇼츠',
      PREMIERE: '프리미어',
      LIVE: '라이브',
      MEMBERS_ONLY: '멤버 전용',
    },
    publishedLine: '{{date}} 게시 · {{rel}}',
    publishedUnknown: '게시일 알 수 없음',

    statusTitle: '상태',
    headline: {
      rescued: '구조됨 — 원본이 유튜브에서 사라지기 전에 이 사본을 지켜냈습니다.',
      HEALTHY: '정상 — 사본이 검증되었고, 원본도 아직 온라인에 있습니다.',
      VERIFYING: '검증 중 — 지금 이 사본을 원본과 대조하고 있습니다.',
      AWAITING_VERIFY:
        '완결성 검증 중 — 방금 끝난 라이브는 검증에 시간이 걸릴 수 있습니다. 별도 조치는 필요 없습니다.',
      DOWNLOADING: '다운로드 중 — 지금 보존 사본을 만들고 있습니다.',
      QUEUED: '대기 중 — 다운로드 슬롯을 기다리고 있습니다.',
      FAILED: '다운로드 실패 — 마지막 시도가 끝까지 가지 못했습니다. 다시 시도할 수 있습니다.',
      PARTIAL_KEPT: '부분 보존 — 녹화가 중간에 끊겼지만, 부분 사본을 보관하고 있습니다.',
      CANDIDATE: '아직 보존 안 됨 — 보관함의 후보 영상입니다.',
    },
    integrity: {
      verified: '검증됨 · sha256',
      partial: '미검증 · 부분 사본 보관',
      failed: '체크섬 없음 · 마지막 다운로드 실패',
      pending: '아직 미검증',
    },

    facts: {
      title: '세부 정보',
      type: '유형',
      resolution: '해상도',
      size: '크기',
      duration: '길이',
      added: '추가일',
      videoId: '영상 ID',
      checksum: 'SHA-256 체크섬',
    },

    description: {
      title: '설명',
    },

    download: '원본 다운로드',

    absent: {
      DOWNLOADING: {
        title: '사본을 만드는 중',
        body: '지금 원본을 다운로드하고 있습니다. 검증이 끝나는 순간 보존 파일과 체크섬이 여기에 나타납니다.',
      },
      QUEUED: {
        title: '다운로드 대기 중',
        body: '빈 슬롯을 기다리는 중입니다. 자동으로 시작되며, 진행 상황을 여기서 볼 수 있습니다.',
      },
      FAILED: {
        title: '다운로드가 끝나지 않음',
        body: '마지막 시도가 사본을 저장하기 전에 멈췄습니다. 손상된 것은 없으니, 다시 시도해 보존하세요.',
      },
      CANDIDATE: {
        title: '아직 보존 안 됨',
        body: '이 영상은 후보입니다 — 채널에서 발견됐지만 아직 저장되지 않았습니다. 원본에 무슨 일이 생기기 전에 다운로드해 검증된 사본을 보관하세요.',
      },
    },

    playerError: {
      e404: {
        title: '이 사본의 파일을 읽을 수 없음',
        body: '보관 기록상 이 사본은 정상이지만 미디어 파일이 응답하지 않았습니다 — 디스크에서 옮겨졌을 수 있습니다. 아래의 상태·체크섬·기록은 여전히 정확합니다.',
      },
      reload: '플레이어 새로고침',
    },

    actions: {
      title: '작업',
      retry: {
        FAILED: {
          title: '다운로드 다시 시도',
          hint: '유튜브의 봇 차단이 다운로드를 끊을 수 있습니다. 다시 시도하면 큐에 다시 넣습니다.',
          button: '다운로드 다시 시도',
        },
        PARTIAL_KEPT: {
          title: '이 녹화본',
          hint: '지난 라이브는 전체 재다운로드를 제공하지 않습니다 — 이 부분 사본이 우리가 보관하는 사본입니다.',
          button: '재다운로드',
        },
        CANDIDATE: {
          title: '이 영상 보존하기',
          hint: '채널에서 발견됐지만 아직 저장되지 않았습니다. 다운로드해 검증된 사본을 보관하세요.',
          button: '지금 다운로드',
        },
      },
      liveFailed: {
        title: '캡처가 완료되지 않았어요',
        hint: '이 라이브 캡처는 실패했고 다시 받을 수 없어요 — 지난 라이브 스트림은 다시 가져올 수 없습니다.',
      },
      controlTitle: '다운로드 진행 중',
      hint: {
        RUNNING: '약 {{eta}} 남음 · {{speed}}.',
        QUEUED: '다운로드 슬롯을 기다리는 중 — 곧 자동으로 시작됩니다.',
        PAUSED: '일시정지됨 — 부분 파일은 보관됩니다. 준비되면 재개하세요.',
      },
      preserved: {
        rescued: {
          title: '구조되어 안전함',
          body: '원본은 유튜브에서 사라졌습니다 — 검증된 사본만이 남았고, 상태는 정상입니다.',
        },
        ok: {
          title: '보존·검증 완료',
          body: '검증된 사본이 보관함에 안전하게 있습니다. 따로 하실 일은 없습니다.',
        },
      },
    },

    control: {
      pause: '일시정지',
      resume: '재개',
      cancel: '취소',
      pending: {
        pausing: '일시정지하는 중…',
        resuming: '재개하는 중…',
        canceling: '취소하는 중…',
      },
    },

    trail: {
      title: '기록',
      intro: '모든 상태 변화를 오래된 순으로 — 이 사본이 여기까지 온 과정입니다.',
      empty: '아직 기록이 없습니다.',
      copyAxis: '사본',
      sourceAxis: '원본',
      rescued: '제때 지켜냈습니다',
    },

    menu: {
      label: '더 보기',
      copyId: '영상 ID 복사',
      viewQueue: '큐에서 보기',
      copied: '영상 ID를 복사했습니다',
      copyFailed: '영상 ID를 복사하지 못했습니다',
    },

    loading: '영상 불러오는 중…',
    notFound: {
      title: '영상을 찾을 수 없음',
      body: '이 영상은 보관함에 없습니다. 제거되었을 수 있습니다.',
      cta: '보관함으로 돌아가기',
    },
    error: {
      title: '이 영상을 불러오지 못함',
      body: '세부 정보를 가져오는 중 문제가 발생했습니다. 다시 시도하세요.',
      retry: '다시 시도',
    },

    toast: {
      queued: '다운로드 큐에 넣음',
      queuedBody: '여기 또는 큐에서 진행 상황을 확인하세요.',
      nothing: '큐에 넣을 것 없음',
      nothingBody: '이 영상은 지금 다운로드할 수 있는 상태가 아닙니다.',
      liveRefused: '라이브 스트림은 재다운로드할 수 없음',
      liveRefusedBody:
        '지난 라이브 녹화는 최종본입니다 — 부분 사본이 우리가 보관하는 사본입니다. 전체 제어는 큐에서 할 수 있습니다.',
      full: '다운로드 큐가 가득 참',
      fullBody: '지금은 우선순위 공간이 소진됐습니다. 잠시 후 다시 시도하세요.',
      failed: '문제가 발생했습니다',
      controlUnavailable: '컨트롤을 잠시 사용할 수 없습니다 — 다시 시도하세요.',
      retry: '다시 시도',
    },
  },
};
