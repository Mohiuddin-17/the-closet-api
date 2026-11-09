-- CreateTable
CREATE TABLE "wardrobe_occasions" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wardrobe_occasions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wardrobes" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "occasionId" UUID,
    "coverPhotoPath" TEXT,
    "privacy" TEXT NOT NULL DEFAULT 'FOLLOWERS',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wardrobes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wardrobe_items" (
    "wardrobeId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "wardrobe_items_pkey" PRIMARY KEY ("wardrobeId","itemId")
);

-- CreateTable
CREATE TABLE "wardrobe_selected_viewers" (
    "wardrobeId" UUID NOT NULL,
    "viewerId" UUID NOT NULL,

    CONSTRAINT "wardrobe_selected_viewers_pkey" PRIMARY KEY ("wardrobeId","viewerId")
);

-- CreateIndex
CREATE INDEX "wardrobe_occasions_ownerId_idx" ON "wardrobe_occasions"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "wardrobe_occasions_ownerId_name_key" ON "wardrobe_occasions"("ownerId", "name");

-- CreateIndex
CREATE INDEX "wardrobes_ownerId_status_idx" ON "wardrobes"("ownerId", "status");

-- CreateIndex
CREATE INDEX "wardrobe_items_itemId_idx" ON "wardrobe_items"("itemId");

-- AddForeignKey
ALTER TABLE "wardrobe_occasions" ADD CONSTRAINT "wardrobe_occasions_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wardrobes" ADD CONSTRAINT "wardrobes_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wardrobes" ADD CONSTRAINT "wardrobes_occasionId_fkey" FOREIGN KEY ("occasionId") REFERENCES "wardrobe_occasions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wardrobe_items" ADD CONSTRAINT "wardrobe_items_wardrobeId_fkey" FOREIGN KEY ("wardrobeId") REFERENCES "wardrobes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wardrobe_items" ADD CONSTRAINT "wardrobe_items_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "closet_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wardrobe_selected_viewers" ADD CONSTRAINT "wardrobe_selected_viewers_wardrobeId_fkey" FOREIGN KEY ("wardrobeId") REFERENCES "wardrobes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wardrobe_selected_viewers" ADD CONSTRAINT "wardrobe_selected_viewers_viewerId_fkey" FOREIGN KEY ("viewerId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
