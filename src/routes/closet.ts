import { randomUUID } from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { supabase } from '../lib/supabase';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import {
  addPhotosSchema,
  createCategorySchema,
  createItemSchema,
  extForContentType,
  MAX_PHOTOS_PER_ITEM,
  updateItemSchema,
  uploadUrlSchema,
} from '../validators/closet';

const router = Router();
router.use(requireAuth);

const BUCKET = 'closet-items';
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour - TODO confirm with client

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, _next: NextFunction) => {
    fn(req, res).catch((err) => {
      console.error(err);
      res.status(500).json({ error: 'Something went wrong.' });
    });
  };

const uid = (req: Request) => (req as any).userId as string;
const param = (req: Request, name: string) => String((req.params as any)[name]);
const NEED_PROFILE = { error: 'Set up your profile first.', code: 'PROFILE_REQUIRED' };

async function hasProfile(id: string) {
  const p = await prisma.profile.findUnique({ where: { id }, select: { id: true } });
  return !!p;
}

/** A photo path must belong to this user's own folder - prevents attaching someone else's upload. */
function ownsPath(me: string, path: string) {
  return path.startsWith(`${me}/`);
}

async function signPaths(paths: string[]): Promise<Record<string, string>> {
  if (paths.length === 0) return {};
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);
  if (error || !data) return {};
  const map: Record<string, string> = {};
  for (const row of data) {
    if (row.signedUrl && row.path) map[row.path] = row.signedUrl;
  }
  return map;
}

function shapeCategory(c: any) {
  return { id: c.id, name: c.name };
}

async function shapeItemList(items: any[]) {
  const thumbPaths = items.map((i) => i.photos[0]?.storagePath).filter(Boolean) as string[];
  const signed = await signPaths(thumbPaths);
  return items.map((i) => ({
    id: i.id,
    category: shapeCategory(i.category),
    isFavorite: i.isFavorite,
    status: i.status,
    thumbnailUrl: i.photos[0] ? signed[i.photos[0].storagePath] ?? null : null,
    createdAt: i.createdAt,
  }));
}

async function shapeItemDetail(i: any) {
  const paths = i.photos.map((p: any) => p.storagePath);
  const signed = await signPaths(paths);
  return {
    id: i.id,
    category: shapeCategory(i.category),
    careInstructions: i.careInstructions,
    purchasePrice: i.purchasePrice,
    isFavorite: i.isFavorite,
    status: i.status,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    photos: i.photos.map((p: any) => ({
      id: p.id,
      url: signed[p.storagePath] ?? null,
      angleLabel: p.angleLabel,
      position: p.position,
    })),
  };
}

// ---------- Categories ----------
router.get(
  '/categories',
  wrap(async (req, res) => {
    const me = uid(req);
    const rows = await prisma.category.findMany({ where: { ownerId: me }, orderBy: { name: 'asc' } });
    res.json({ categories: rows.map(shapeCategory) });
  })
);

router.post(
  '/categories',
  wrap(async (req, res) => {
    const me = uid(req);
    const parseResult = createCategorySchema.safeParse(req.body);

    if (!parseResult.success) {
      return res.status(400).json({ error: 'Enter a category name.' });
    }

    if (!(await hasProfile(me))) return res.status(409).json(NEED_PROFILE);

    const existing = await prisma.category.findFirst({
      where: { ownerId: me, name: { equals: parseResult.data.name, mode: 'insensitive' } },
    });
    if (existing) return res.status(409).json({ error: 'You already have a category with that name.' });

    const category = await prisma.category.create({ data: { ownerId: me, name: parseResult.data.name } });
    res.status(201).json({ category: shapeCategory(category) });
  })
);

// ---------- Photo upload URLs ----------
router.post(
  '/photos/upload-url',
  wrap(async (req, res) => {
    const me = uid(req);
    const parsed = uploadUrlSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Unsupported photo type.' });
    if (!(await hasProfile(me))) return res.status(409).json(NEED_PROFILE);

    const ext = extForContentType(parsed.data.contentType);
    if (!ext) return res.status(400).json({ error: 'Unsupported photo type.' });

    const kind = parsed.data.kind ?? 'items';
    // Server chooses the path - the client never picks its own path or owner id.
    const path = `${me}/${kind}/${randomUUID()}.${ext}`;
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error || !data) return res.status(502).json({ error: 'Could not prepare upload.' });

    res.json({ path, signedUrl: data.signedUrl, token: data.token });
  })
);

// ---------- Items ----------
router.get(
  '/items',
  wrap(async (req, res) => {
    const me = uid(req);
    const categoryId = typeof req.query.categoryId === 'string' ? req.query.categoryId : undefined;
    const statusParam = typeof req.query.status === 'string' ? req.query.status : 'ACTIVE';
    const where: any = { ownerId: me };
    if (statusParam !== 'ALL') where.status = statusParam;
    if (categoryId) where.categoryId = categoryId;

    const rows = await prisma.item.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { category: true, photos: { orderBy: { position: 'asc' }, take: 1 } },
    });
    res.json({ items: await shapeItemList(rows) });
  })
);

router.get(
  '/items/:id',
  wrap(async (req, res) => {
    const me = uid(req);
    const item = await prisma.item.findFirst({
      where: { id: param(req, 'id'), ownerId: me },
      include: { category: true, photos: { orderBy: { position: 'asc' } } },
    });
    if (!item) return res.status(404).json({ error: 'Item not found.' });
    res.json({ item: await shapeItemDetail(item) });
  })
);

router.post(
  '/items',
  wrap(async (req, res) => {
    const me = uid(req);
    const parsed = createItemSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid item.' });
    if (!(await hasProfile(me))) return res.status(409).json(NEED_PROFILE);

    const badPath = parsed.data.photos.find((p) => !ownsPath(me, p.path));
    if (badPath) return res.status(400).json({ error: 'Invalid photo reference.' });

    const category = await prisma.category.findFirst({ where: { id: parsed.data.categoryId, ownerId: me } });
    if (!category) return res.status(404).json({ error: 'Category not found.' });

    const created = await prisma.item.create({
      data: {
        ownerId: me,
        categoryId: category.id,
        careInstructions: parsed.data.careInstructions,
        purchasePrice: parsed.data.purchasePrice,
        isFavorite: parsed.data.isFavorite ?? false,
        photos: {
          create: parsed.data.photos.map((p, i) => ({
            storagePath: p.path,
            angleLabel: p.angleLabel,
            position: i,
          })),
        },
      },
      include: { category: true, photos: { orderBy: { position: 'asc' } } },
    });

    res.status(201).json({ item: await shapeItemDetail(created) });
  })
);

router.patch(
  '/items/:id',
  wrap(async (req, res) => {
    const me = uid(req);
    const itemId = param(req, 'id');
    const parsed = updateItemSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid update.' });

    const existing = await prisma.item.findFirst({ where: { id: itemId, ownerId: me } });
    if (!existing) return res.status(404).json({ error: 'Item not found.' });

    if (parsed.data.categoryId) {
      const category = await prisma.category.findFirst({ where: { id: parsed.data.categoryId, ownerId: me } });
      if (!category) return res.status(404).json({ error: 'Category not found.' });
    }

    const updated = await prisma.item.update({
      where: { id: itemId },
      data: {
        categoryId: parsed.data.categoryId,
        careInstructions: parsed.data.careInstructions,
        purchasePrice: parsed.data.purchasePrice,
        isFavorite: parsed.data.isFavorite,
        status: parsed.data.status,
      },
      include: { category: true, photos: { orderBy: { position: 'asc' } } },
    });

    res.json({ item: await shapeItemDetail(updated) });
  })
);

router.delete(
  '/items/:id',
  wrap(async (req, res) => {
    const me = uid(req);
    const itemId = param(req, 'id');
    const existing = await prisma.item.findFirst({
      where: { id: itemId, ownerId: me },
      include: { photos: true },
    });
    if (!existing) return res.status(404).json({ error: 'Item not found.' });

    // FR-309/310, BR-008: deleting an item used in a wardrobe must warn first.
    const wardrobeCount = await prisma.wardrobeItem.count({ where: { itemId } });
    if (wardrobeCount > 0) {
      return res.status(409).json({
        error: `This item is used in ${wardrobeCount} wardrobe${wardrobeCount === 1 ? '' : 's'}. Remove it from ${
          wardrobeCount === 1 ? 'that wardrobe' : 'those wardrobes'
        } first.`,
        code: 'ITEM_IN_USE',
        wardrobeCount,
      });
    }

    const paths = existing.photos.map((p) => p.storagePath);
    if (paths.length > 0) {
      await supabase.storage.from(BUCKET).remove(paths);
    }
    await prisma.item.delete({ where: { id: itemId } });
    res.json({ ok: true });
  })
);

// ---------- Item photos ----------
router.post(
  '/items/:id/photos',
  wrap(async (req, res) => {
    const me = uid(req);
    const itemId = param(req, 'id');
    const parsed = addPhotosSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid photos.' });

    const badPath = parsed.data.photos.find((p) => !ownsPath(me, p.path));
    if (badPath) return res.status(400).json({ error: 'Invalid photo reference.' });

    const item = await prisma.item.findFirst({
      where: { id: itemId, ownerId: me },
      include: { photos: true },
    });
    if (!item) return res.status(404).json({ error: 'Item not found.' });

    const nextCount = item.photos.length + parsed.data.photos.length;
    if (nextCount > MAX_PHOTOS_PER_ITEM) {
      return res.status(400).json({ error: `An item can have at most ${MAX_PHOTOS_PER_ITEM} photos.` });
    }

    const startPosition = item.photos.length;
    await prisma.itemPhoto.createMany({
      data: parsed.data.photos.map((p, i) => ({
        itemId,
        storagePath: p.path,
        angleLabel: p.angleLabel,
        position: startPosition + i,
      })),
    });

    const updated = await prisma.item.findUnique({
      where: { id: itemId },
      include: { category: true, photos: { orderBy: { position: 'asc' } } },
    });
    res.status(201).json({ item: await shapeItemDetail(updated) });
  })
);

router.delete(
  '/items/:id/photos/:photoId',
  wrap(async (req, res) => {
    const me = uid(req);
    const itemId = param(req, 'id');
    const photoId = param(req, 'photoId');

    const item = await prisma.item.findFirst({ where: { id: itemId, ownerId: me } });
    if (!item) return res.status(404).json({ error: 'Item not found.' });

    const photo = await prisma.itemPhoto.findFirst({ where: { id: photoId, itemId } });
    if (!photo) return res.status(404).json({ error: 'Photo not found.' });

    await supabase.storage.from(BUCKET).remove([photo.storagePath]);
    await prisma.itemPhoto.delete({ where: { id: photoId } });
    res.json({ ok: true });
  })
);

export default router;