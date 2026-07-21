/**
 * Resource merge. Each group slice owns DISTINCT top-level sections, so `en` and
 * `ko` are built with a shallow spread (no deep-merge needed). `en` is exported
 * `as const` — it is the single reference that types the t() keys (types.d.ts).
 * `ko` is a plain (partial) object; missing keys fall back to EN at runtime.
 *
 * Later phases extend these by importing their slice (e.g. status, shell, forms,
 * feedback, cards, notifications) and spreading it in here.
 */
import cardsEn from './cards.en';
import cardsKo from './cards.ko';
import channelEn from './channel.en';
import channelKo from './channel.ko';
import channelsEn from './channels.en';
import channelsKo from './channels.ko';
import commonEn from './common.en';
import commonKo from './common.ko';
import componentsEn from './components.en';
import componentsKo from './components.ko';
import feedbackEn from './feedback.en';
import feedbackKo from './feedback.ko';
import formsEn from './forms.en';
import formsKo from './forms.ko';
import homeEn from './home.en';
import homeKo from './home.ko';
import libraryEn from './library.en';
import libraryKo from './library.ko';
import liveEn from './live.en';
import liveKo from './live.ko';
import loginEn from './login.en';
import loginKo from './login.ko';
import notificationsEn from './notifications.en';
import notificationsKo from './notifications.ko';
import queueEn from './queue.en';
import queueKo from './queue.ko';
import settingsEn from './settings.en';
import settingsKo from './settings.ko';
import shellEn from './shell.en';
import shellKo from './shell.ko';
import statusEn from './status.en';
import statusKo from './status.ko';
import storageEn from './storage.en';
import storageKo from './storage.ko';
import videoEn from './video.en';
import videoKo from './video.ko';
import videosEn from './videos.en';
import videosKo from './videos.ko';

export const en = {
  ...commonEn,
  ...statusEn,
  ...componentsEn,
  ...formsEn,
  ...feedbackEn,
  ...cardsEn,
  ...shellEn,
  ...queueEn,
  ...homeEn,
  ...liveEn,
  ...loginEn,
  ...notificationsEn,
  ...videosEn,
  ...videoEn,
  ...channelEn,
  ...channelsEn,
  ...settingsEn,
  ...libraryEn,
  ...storageEn,
  // The DS `storage` gauge keys (components slice) and the S-ST screen keys share
  // the `storage` namespace — deep-merge so neither shallow-clobbers the other.
  storage: { ...componentsEn.storage, ...storageEn.storage },
} as const;

export const ko = {
  ...commonKo,
  ...statusKo,
  ...componentsKo,
  ...formsKo,
  ...feedbackKo,
  ...cardsKo,
  ...shellKo,
  ...queueKo,
  ...homeKo,
  ...liveKo,
  ...loginKo,
  ...notificationsKo,
  ...videosKo,
  ...videoKo,
  ...channelKo,
  ...channelsKo,
  ...settingsKo,
  ...libraryKo,
  ...storageKo,
  storage: { ...componentsKo.storage, ...storageKo.storage },
};
