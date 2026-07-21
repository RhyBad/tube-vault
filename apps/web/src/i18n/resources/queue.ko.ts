/**
 * Queue KO strings — partial by design (any omission falls back to EN at
 * runtime). Mirrors the queue.en shape; plural suffix keys (_one/_other) resolve
 * via i18next even though Korean has one plural form.
 */
const queue = {
  queue: {
    title: '작업 큐',
    subtitle: '진행 중·대기 중이거나 최근 종료된 다운로드.',
    loading: '큐 불러오는 중…',
    tabs: {
      active: '활성',
      failed: '실패',
      completed: '완료',
      canceled: '취소',
    },
    filter: {
      channel: '채널',
      allChannels: '모든 채널',
    },
    col: {
      video: '영상',
      status: '상태',
      progress: '진행',
      order: '순서',
      try: '시도',
      actions: '작업',
    },
    row: {
      order: '순서 {{priority}}',
      orderUnknown: '순서 —',
      position: '#{{position}}',
      orderTip: '우선순위 {{priority}}',
      orderTipUnknown: '우선순위 없음 (레거시 작업)',
      orderRunning: '지금 다운로드 중',
      attempt_other: '{{count}}회차',
      unknownTotal: '크기 미상',
      waitingSlot: '슬롯 대기 중',
      waitingRetry: '재시도 대기 중',
      timeQueued: '{{time}} 큐잉됨',
      timeStarted: '{{time}} 시작됨',
      timePaused: '{{time}} 일시정지됨',
      timeFinished: '{{time}} 종료됨',
      openLog: '이벤트 로그 보기',
      hideLog: '이벤트 로그 숨기기',
      dragHandle: '드래그하여 순서 변경',
      more: '추가 작업',
    },
    sheet: {
      label: '{{title}} 추가 작업',
      selectForBulk: '일괄 선택',
    },
    pending: {
      canceling: '취소 중…',
      pausing: '정지 중…',
      resuming: '재개 중…',
      moving: '이동 중…',
    },
    actions: {
      cancel: '취소',
      pause: '일시정지',
      resume: '재개',
      moveTop: '맨 위로',
      moveBottom: '맨 아래로',
      requeue: '재큐',
      select: '선택',
      selectDone: '완료',
      selectAll: '전체 선택',
    },
    reorder: {
      runningLocked: '다운로드 중인 작업은 순서를 변경할 수 없습니다',
    },
    newJobs_other: '새 작업 {{count}}건 — 새로고침',
    bulk: {
      cancel: '취소',
      pause: '일시정지',
      resume: '재개',
    },
    empty: {
      active: {
        title: '큐가 비어 있습니다',
        body: '대기 중이거나 진행 중인 다운로드가 없습니다.',
        cta: '라이브러리에서 큐잉',
      },
      failed: {
        title: '실패한 작업 없음',
        body: '다운로드 실패한 작업이 여기에 표시됩니다.',
      },
      completed: {
        title: '완료된 작업 없음',
        body: '완료된 다운로드가 여기에 표시됩니다.',
      },
      canceled: {
        title: '취소한 작업 없음',
        body: '취소한 작업이 여기에 표시됩니다.',
      },
      filtered: {
        title: '이 채널에 해당하는 작업 없음',
        body: '선택한 채널의 대기 중이거나 최근 다운로드가 없습니다.',
        clear: '채널 필터 지우기',
      },
    },
    error: {
      title: '큐를 불러오지 못했습니다',
      body: '큐를 가져오는 중 문제가 발생했습니다.',
      retry: '다시 시도',
    },
    confirm: {
      cancelTitle: '이 다운로드를 취소할까요?',
      cancelBody: '작업이 중단되고 부분 다운로드는 삭제됩니다. 나중에 다시 큐잉할 수 있습니다.',
      cancelConfirm: '다운로드 취소',
      cancelDismiss: '유지',
      bulkCancelTitle: '{{count}}개 다운로드를 취소할까요?',
      bulkCancelBody: '각 작업이 중단되고 부분 다운로드는 삭제됩니다.',
      bulkCancelDismiss: '모두 유지',
    },
    toast: {
      full: '큐가 가득 찼습니다 — 잠시 후 다시 시도하세요.',
      controlUnavailable: '제어 채널을 사용할 수 없습니다 — 다시 시도하세요.',
      resumeFailed: '재개하지 못했습니다 — 여전히 일시정지 상태입니다. 다시 시도하세요.',
      resumeLegacy: '이 작업은 재개할 수 없습니다 — 취소 후 다시 큐잉하세요.',
      bulkDone_other: '{{count}}개 작업 완료.',
      bulkPartial: '{{ok}}개 완료, {{failed}}개 실패.',
      requeued_other: '{{count}}개 영상 큐잉됨.',
      requeuePartial: '{{enqueued}}개 큐잉, {{skipped}}개 제외.',
      requeueNone: '큐잉할 항목 없음 — 이미 큐잉되었거나 대상이 아닙니다.',
    },
    log: {
      title: '이벤트 로그',
      job: '작업 {{id}}',
      refresh: '새로고침',
      loading: '이벤트 불러오는 중…',
      empty: '이 작업에 기록된 이벤트가 없습니다.',
      error: '이벤트 로그를 불러오지 못했습니다.',
      close: '이벤트 로그 닫기',
      snapshot_other: '스냅샷 · 이벤트 {{count}}개',
    },
  },
};

export default queue;
