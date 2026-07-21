-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "CopyState" AS ENUM ('CANDIDATE', 'QUEUED', 'DOWNLOADING', 'VERIFYING', 'HEALTHY', 'FAILED', 'PARTIAL_KEPT');

-- CreateEnum
CREATE TYPE "SourceState" AS ENUM ('AVAILABLE', 'GEO_BLOCKED', 'PRIVATE', 'MEMBERS_ONLY', 'AGE_GATED', 'DELETED', 'TRANSIENT_ERROR', 'RATE_LIMITED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ContentType" AS ENUM ('REGULAR', 'SHORTS', 'PREMIERE', 'LIVE', 'MEMBERS_ONLY');

-- CreateEnum
CREATE TYPE "StatusAxis" AS ENUM ('COPY', 'SOURCE');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('DOWNLOAD', 'VERIFY', 'ENUMERATE', 'LIVE_PROBE', 'LIVE_CAPTURE');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "ErrorKind" AS ENUM ('BOT_WALL', 'RATE_LIMITED', 'AUTH', 'GEO_BLOCKED', 'SOURCE_GONE', 'TRANSIENT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "QualityCap" AS ENUM ('UNLIMITED', 'P2160', 'P1440', 'P1080', 'P720');

-- CreateEnum
CREATE TYPE "SubtitleMode" AS ENUM ('NONE', 'MANUAL', 'AUTO', 'BOTH');

-- CreateEnum
CREATE TYPE "LiveSessionState" AS ENUM ('DETECTED', 'CAPTURING', 'ENDED_NORMAL', 'ENDED_INTERRUPTED', 'FAILED');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('UNVERIFIED', 'VERIFIED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "NotificationChannelType" AS ENUM ('TELEGRAM', 'DISCORD', 'GOTIFY', 'NTFY', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR');

-- CreateTable
CREATE TABLE "Channel" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT,
    "thumbnailUrl" TEXT,
    "watchLive" BOOLEAN NOT NULL DEFAULT false,
    "qualityCap" "QualityCap",
    "subtitleMode" "SubtitleMode",
    "lastEnumeratedAt" TIMESTAMP(3),
    "lastLivePollAt" TIMESTAMP(3),
    "nextLivePollAt" TIMESTAMP(3),
    "lastLiveSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Video" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "contentType" "ContentType" NOT NULL DEFAULT 'REGULAR',
    "copyState" "CopyState" NOT NULL DEFAULT 'CANDIDATE',
    "sourceState" "SourceState" NOT NULL DEFAULT 'UNKNOWN',
    "publishedAt" TIMESTAMP(3),
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "mediaExt" TEXT,
    "sizeBytes" BIGINT,
    "checksumSha256" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "sourceDurationSeconds" DOUBLE PRECISION,

    CONSTRAINT "Video_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoStatusEvent" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "axis" "StatusAxis" NOT NULL,
    "oldState" TEXT NOT NULL,
    "newState" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VideoStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "type" "JobType" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "videoId" TEXT,
    "channelId" TEXT,
    "bullJobId" TEXT,
    "priority" INTEGER,
    "payload" JSONB,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "progressPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "downloadedBytes" BIGINT NOT NULL DEFAULT 0,
    "totalBytes" BIGINT,
    "speedBps" DOUBLE PRECISION,
    "etaSeconds" INTEGER,
    "currentFile" TEXT,
    "stagingDir" TEXT,
    "error" TEXT,
    "errorKind" "ErrorKind",
    "summary" TEXT,
    "enqueuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "level" "LogLevel" NOT NULL DEFAULT 'INFO',
    "message" TEXT NOT NULL,
    "context" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "downloadConcurrency" INTEGER NOT NULL DEFAULT 1,
    "qualityCap" "QualityCap" NOT NULL DEFAULT 'UNLIMITED',
    "subtitleMode" "SubtitleMode" NOT NULL DEFAULT 'BOTH',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Credential" (
    "id" TEXT NOT NULL DEFAULT 'youtube',
    "encryptedBlob" BYTEA NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "failureStreak" INTEGER NOT NULL DEFAULT 0,
    "lastVerifiedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiveSession" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "state" "LiveSessionState" NOT NULL DEFAULT 'DETECTED',
    "captureJobId" TEXT,
    "outputDir" TEXT,
    "isPartial" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "lastHeartbeatAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiveSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationChannel" (
    "id" TEXT NOT NULL,
    "type" "NotificationChannelType" NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "minSeverity" "Severity" NOT NULL DEFAULT 'INFO',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" "Severity" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "channelId" TEXT,
    "videoId" TEXT,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissedAt" TIMESTAMP(3),

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Channel_nextLivePollAt_idx" ON "Channel"("nextLivePollAt");

-- CreateIndex
CREATE INDEX "Video_channelId_copyState_idx" ON "Video"("channelId", "copyState");

-- CreateIndex
CREATE INDEX "Video_copyState_idx" ON "Video"("copyState");

-- CreateIndex
CREATE INDEX "Video_title_idx" ON "Video"("title");

-- CreateIndex
CREATE INDEX "VideoStatusEvent_videoId_at_idx" ON "VideoStatusEvent"("videoId", "at");

-- CreateIndex
CREATE INDEX "Job_type_status_idx" ON "Job"("type", "status");

-- CreateIndex
CREATE INDEX "Job_status_priority_idx" ON "Job"("status", "priority");

-- CreateIndex
CREATE INDEX "Job_videoId_type_status_idx" ON "Job"("videoId", "type", "status");

-- CreateIndex
CREATE INDEX "JobEvent_jobId_createdAt_idx" ON "JobEvent"("jobId", "createdAt");

-- CreateIndex
CREATE INDEX "LiveSession_channelId_state_idx" ON "LiveSession"("channelId", "state");

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- CreateIndex
CREATE INDEX "Notification_dedupeKey_createdAt_idx" ON "Notification"("dedupeKey", "createdAt");

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoStatusEvent" ADD CONSTRAINT "VideoStatusEvent_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobEvent" ADD CONSTRAINT "JobEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveSession" ADD CONSTRAINT "LiveSession_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Raw-SQL PARTIAL UNIQUE indexes (cannot be expressed in schema.prisma).
-- Keep in sync with the note at the top of prisma/schema.prisma.
--
-- ux_job_active_download: at most ONE active (QUEUED/RUNNING/PAUSED) DOWNLOAD
-- job per video — race backstop for bulk enqueue / reconciler double-adds.
-- ux_live_session_active: at most ONE active (DETECTED/CAPTURING) live session
-- per video — guards against twin capture jobs.
-- ---------------------------------------------------------------------------

-- CreateIndex (partial unique, raw SQL)
CREATE UNIQUE INDEX "ux_job_active_download" ON "Job"("videoId") WHERE "type" = 'DOWNLOAD' AND "status" IN ('QUEUED','RUNNING','PAUSED');

-- CreateIndex (partial unique, raw SQL)
CREATE UNIQUE INDEX "ux_live_session_active" ON "LiveSession"("videoId") WHERE "state" IN ('DETECTED','CAPTURING');
