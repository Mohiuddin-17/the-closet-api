-- AlterTable
ALTER TABLE "profiles" ADD COLUMN     "defaultWardrobePrivacy" TEXT NOT NULL DEFAULT 'FOLLOWERS',
ADD COLUMN     "requireTagApproval" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "whoCanMentionMe" TEXT NOT NULL DEFAULT 'EVERYONE',
ADD COLUMN     "whoCanTagMe" TEXT NOT NULL DEFAULT 'EVERYONE';

-- CreateTable
CREATE TABLE "blocks" (
    "blockerId" UUID NOT NULL,
    "blockedId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocks_pkey" PRIMARY KEY ("blockerId","blockedId")
);

-- CreateTable
CREATE TABLE "post_user_tags" (
    "id" UUID NOT NULL,
    "postId" UUID NOT NULL,
    "taggedUserId" UUID NOT NULL,
    "itemId" UUID,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_user_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mentions" (
    "id" UUID NOT NULL,
    "commentId" UUID NOT NULL,
    "mentionedUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mentions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "blocks_blockedId_idx" ON "blocks"("blockedId");

-- CreateIndex
CREATE INDEX "post_user_tags_postId_idx" ON "post_user_tags"("postId");

-- CreateIndex
CREATE INDEX "post_user_tags_taggedUserId_status_idx" ON "post_user_tags"("taggedUserId", "status");

-- CreateIndex
CREATE INDEX "mentions_mentionedUserId_idx" ON "mentions"("mentionedUserId");

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blockerId_fkey" FOREIGN KEY ("blockerId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blockedId_fkey" FOREIGN KEY ("blockedId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_user_tags" ADD CONSTRAINT "post_user_tags_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_user_tags" ADD CONSTRAINT "post_user_tags_taggedUserId_fkey" FOREIGN KEY ("taggedUserId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_user_tags" ADD CONSTRAINT "post_user_tags_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "closet_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_mentionedUserId_fkey" FOREIGN KEY ("mentionedUserId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
