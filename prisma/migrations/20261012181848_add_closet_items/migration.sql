-- CreateTable
CREATE TABLE "closet_categories" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "closet_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "closet_items" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "careInstructions" TEXT,
    "purchasePrice" DOUBLE PRECISION,
    "isFavorite" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "closet_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "closet_item_photos" (
    "id" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "storagePath" TEXT NOT NULL,
    "angleLabel" TEXT,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "closet_item_photos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "closet_categories_ownerId_idx" ON "closet_categories"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "closet_categories_ownerId_name_key" ON "closet_categories"("ownerId", "name");

-- CreateIndex
CREATE INDEX "closet_items_ownerId_categoryId_idx" ON "closet_items"("ownerId", "categoryId");

-- CreateIndex
CREATE INDEX "closet_items_ownerId_status_idx" ON "closet_items"("ownerId", "status");

-- CreateIndex
CREATE INDEX "closet_item_photos_itemId_position_idx" ON "closet_item_photos"("itemId", "position");

-- AddForeignKey
ALTER TABLE "closet_categories" ADD CONSTRAINT "closet_categories_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closet_items" ADD CONSTRAINT "closet_items_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closet_items" ADD CONSTRAINT "closet_items_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "closet_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closet_item_photos" ADD CONSTRAINT "closet_item_photos_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "closet_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
