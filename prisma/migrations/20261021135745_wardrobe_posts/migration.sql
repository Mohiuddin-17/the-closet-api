-- AlterTable
ALTER TABLE "posts" ADD COLUMN     "coverPhotoPath" TEXT,
ADD COLUMN     "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "privacy" TEXT NOT NULL DEFAULT 'FOLLOWERS',
ADD COLUMN     "wardrobeId" UUID,
ALTER COLUMN "imageUrl" DROP NOT NULL;

-- CreateTable
CREATE TABLE "post_selected_viewers" (
    "postId" UUID NOT NULL,
    "viewerId" UUID NOT NULL,

    CONSTRAINT "post_selected_viewers_pkey" PRIMARY KEY ("postId","viewerId")
);

-- CreateIndex
CREATE INDEX "posts_wardrobeId_idx" ON "posts"("wardrobeId");

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_wardrobeId_fkey" FOREIGN KEY ("wardrobeId") REFERENCES "wardrobes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_selected_viewers" ADD CONSTRAINT "post_selected_viewers_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_selected_viewers" ADD CONSTRAINT "post_selected_viewers_viewerId_fkey" FOREIGN KEY ("viewerId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
