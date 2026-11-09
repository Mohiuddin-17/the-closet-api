-- CreateTable
CREATE TABLE "notification_preferences" (
    "userId" UUID NOT NULL,
    "pauseAll" BOOLEAN NOT NULL DEFAULT false,
    "likes" TEXT NOT NULL DEFAULT 'FOLLOWING',
    "comments" TEXT NOT NULL DEFAULT 'EVERYONE',
    "followRequests" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("userId")
);
