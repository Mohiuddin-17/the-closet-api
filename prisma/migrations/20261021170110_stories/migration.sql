-- CreateTable
CREATE TABLE "stories" (
    "id" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "imagePath" TEXT NOT NULL,
    "caption" TEXT,
    "privacy" TEXT NOT NULL DEFAULT 'FOLLOWERS',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "story_selected_viewers" (
    "storyId" UUID NOT NULL,
    "viewerId" UUID NOT NULL,

    CONSTRAINT "story_selected_viewers_pkey" PRIMARY KEY ("storyId","viewerId")
);

-- CreateTable
CREATE TABLE "story_item_tags" (
    "id" UUID NOT NULL,
    "storyId" UUID NOT NULL,
    "brand" TEXT NOT NULL,
    "label" TEXT,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "story_item_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "story_views" (
    "storyId" UUID NOT NULL,
    "viewerId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "story_views_pkey" PRIMARY KEY ("storyId","viewerId")
);

-- CreateIndex
CREATE INDEX "stories_authorId_createdAt_idx" ON "stories"("authorId", "createdAt");

-- CreateIndex
CREATE INDEX "stories_expiresAt_idx" ON "stories"("expiresAt");

-- CreateIndex
CREATE INDEX "story_item_tags_storyId_idx" ON "story_item_tags"("storyId");

-- AddForeignKey
ALTER TABLE "stories" ADD CONSTRAINT "stories_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_selected_viewers" ADD CONSTRAINT "story_selected_viewers_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "stories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_selected_viewers" ADD CONSTRAINT "story_selected_viewers_viewerId_fkey" FOREIGN KEY ("viewerId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_item_tags" ADD CONSTRAINT "story_item_tags_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "stories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_views" ADD CONSTRAINT "story_views_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "stories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_views" ADD CONSTRAINT "story_views_viewerId_fkey" FOREIGN KEY ("viewerId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
