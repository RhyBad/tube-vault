/**
 * Channels KO overrides — S2. Partial dict; any missing key falls back to EN at
 * runtime (fallbackLng). Copy lifted from the design STR `ko` block.
 */
export default {
  channels: {
    page: {
      title: '채널',
      subtitle:
        '아카이빙 중인 채널입니다. URL로 새 채널을 등록하면, YouTube에서 원본이 사라져도 사본은 보존됩니다.',
      count_one: '채널 {{count}}개 · 수집 중 {{active}}개',
      count_other: '채널 {{count}}개 · 수집 중 {{active}}개',
    },
    register: {
      title: '채널 등록',
      hint: '채널 URL을 붙여넣으세요. TubeVault가 채널을 확인한 뒤 백그라운드에서 영상을 열거합니다 — 여기서 기다릴 필요는 없어요.',
      placeholder: 'https://www.youtube.com/@handle',
      fieldLabel: '채널 URL',
      submit: '등록',
      submitBusy: '등록 중…',
      dismiss: '닫기',
      viewQueue: '대기열에서 보기',
      viewHome: '홈으로',
      retry: '다시 시도',
    },
    notice: {
      successTitle: '“{{name}}” 추가됨',
      successMsg:
        '백그라운드에서 영상을 열거하는 중입니다 — 몇 분 걸릴 수 있어요. 대기열에서 진행 상황을 확인하세요.',
      alreadyTitle: '“{{name}}” 은 이미 등록됨',
      alreadyMsg: '새 영상이 있는지 다시 확인하는 중입니다. 대기열에서 확인하세요.',
      notFoundTitle: '채널을 찾지 못했습니다',
      notFoundMsg:
        '이 URL을 YouTube 채널로 인식하지 못했습니다. 링크를 확인하세요 — 채널 페이지나 @핸들 URL이 가장 잘 됩니다.',
      notFoundField: '채널 URL이 아님',
      timeoutTitle: '시간이 걸리고 있습니다',
      timeoutMsg:
        '채널을 확인하기 전에 조회가 시간 초과됐습니다. 일시적일 가능성이 높으니 다시 시도하세요.',
      engineTitle: '아카이브 엔진 오류',
      engineMsg:
        'TubeVault가 YouTube에 연결해 채널을 확인하지 못했습니다. 잠시 후 다시 시도하세요.',
      genericTitle: '채널을 등록하지 못했습니다',
      genericMsg: 'URL을 확인하는 중 문제가 발생했습니다. 잠시 후 다시 시도하세요.',
    },
    row: {
      lastChecked: '마지막 확인',
      neverChecked: '아직 확인 안 됨',
      enumerating: '열거 중…',
      stoppedNote: '수집 중단됨 · 아카이브 보존',
      watchLiveLabel: '라이브 감시',
      watchOn: '라이브 감시: 켬 — {{name}}',
      watchOff: '라이브 감시: 끔 — {{name}}',
      moreActions: '추가 작업 — {{name}}',
      resume: '수집 재개',
    },
    menu: {
      stop: '수집 중단',
      stopHint: '아카이브 보존 · 되돌릴 수 있음',
      reactivate: '수집 재개',
      reactivateHint: '다시 열거하고 감시',
      delete: '채널·파일 삭제…',
      deleteHint: '영구 삭제 · 미디어 제거',
    },
    confirm: {
      unregTitle: '“{{name}}” 수집을 중단할까요?',
      unregDesc:
        '새 다운로드와 라이브 감시가 중단됩니다. 이미 아카이빙된 영상은 그대로 보존되고 계속 열람할 수 있어요. 언제든 다시 등록해 재개할 수 있습니다.',
      unregConfirm: '수집 중단',
      purgeTitle: '“{{name}}” 과(와) 파일을 삭제할까요?',
      purgeDesc:
        '채널과 디스크에 저장된 아카이브 영상 파일 {{n}}개가 영구 삭제됩니다. 되돌릴 수 없습니다. 사본을 유지하려면 “수집 중단”을 사용하세요.',
      purgeConfirm: '영구 삭제',
    },
    toast: {
      liveOnTitle: '라이브 감시 켜짐',
      liveOnMsg: '“{{name}}” 의 라이브 스트림을 감시합니다.',
      liveOffTitle: '라이브 감시 꺼짐',
      liveOffMsg: '“{{name}}” 의 라이브 감시를 중단했습니다.',
      unregTitle: '수집 중단됨',
      unregMsg: '“{{name}}” 아카이브는 보존 — 수집만 중단했습니다.',
      purgeTitle: '채널 삭제됨',
      purgeMsg: '“{{name}}” 과(와) 파일이 영구 삭제되었습니다.',
      reactTitle: '수집 재개됨',
      reactMsg: '“{{name}}” 을(를) 다시 열거하는 중입니다.',
      enumDoneTitle: '열거 완료',
      enumDoneMsg: '“{{name}}” 의 영상 수를 업데이트했습니다.',
      actionError: '문제가 발생했습니다 — 다시 시도하세요.',
    },
    empty: {
      title: '아직 채널이 없습니다',
      desc: '위에서 URL로 첫 채널을 등록해 아카이빙을 시작하세요. 원본이 나중에 삭제돼도 사본은 보존됩니다.',
    },
    error: {
      title: '채널을 불러오지 못했습니다',
      desc: '채널 목록을 불러오지 못했습니다. 이미 아카이빙된 항목에는 영향이 없습니다.',
    },
    loading: '채널 불러오는 중…',
    registered: '등록됨',
  },
} as const;
