import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { supabase } from '../lib/supabase';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { createOccasionSchema, createWardrobeSchema, updateWardrobeSchema } from '../validators/wardrobe';

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
const ownerSelect = { id: true, username: true, displayName: true, photoUrl: true };

async function hasProfile(id: string) {
  const p = await prisma.profile.findUnique({ where: { id }, select: { id: true } });
  return !!p;
}

function ownsPath(me: string, path: string) {
  return path.startsWith(`${me}/`);
}

async function signPaths(paths: string[]): Promise<Record<string, string>> {
  const unique = Array.from(new Set(paths));
  if (unique.length === 0) return {};
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(unique, SIGNED_URL_TTL_SECONDS);
  if (error || !data) return {};
  const map: Record<string, string> = {};
  for (const row of data) {
    if (row.signedUrl && row.path) map[row.path] = row.signedUrl;
  }
  return map;
}

function shapeOccasion(o: any) {
  return o ? { id: o.id, name: o.name } : null;
}

/** True if `viewerId` is allowed to see this wardrobe. A block in either
 * direction overrides everything else, even for the wardrobe's own owner
 * trying to re-check - though owners always pass the earlier owner check first. */
async function canView(wardrobe: { ownerId: string; privacy: string; id: string }, viewerId: string): Promise<boolean> {
  if (wardrobe.ownerId === viewerId) return true;

  const blocked = await prisma.block.findFirst({
    where: { OR: [{ blockerId: viewerId, blockedId: wardrobe.ownerId }, { blockerId: wardrobe.ownerId, blockedId: viewerId }] },
  });
  if (blocked) return false;

  if (wardrobe.privacy === 'ONLY_ME') return false;
  if (wardrobe.privacy === 'EVERYONE') return true;
  if (wardrobe.privacy === 'FOLLOWERS') {
    const follow = await prisma.follow.findUnique({
      where: { followerId_followingId: { followerId: viewerId, followingId: wardrobe.ownerId } },
    });
    return follow?.status === 'ACCEPTED';
  }
  if (wardrobe.privacy === 'SELECTED') {
    const selected = await prisma.wardrobeSelectedViewer.findUnique({
      where: { wardrobeId_viewerId: { wardrobeId: wardrobe.id, viewerId } },
    });
    return !!selected;
  }
  return false;
}

// coverPhotoPath (the raw storage path) is included alongside coverUrl (the
// signed, time-limited URL) - the same way creating a wardrobe already lets
// the client pass a raw storage path. This is what lets "Post to Feed"
// default to the wardrobe's real cover without a new server round-trip.
async function shapeWardrobeList(rows: any[]) {
  const paths: string[] = [];
  for (const w of rows) {
    if (w.coverPhotoPath) paths.push(w.coverPhotoPath);
  }
  const signed = await signPaths(paths);
  return rows.map((w) => ({
    id: w.id,
    name: w.name,
    occasion: shapeOccasion(w.occasion),
    coverPhotoPath: w.coverPhotoPath ?? null,
    coverUrl: w.coverPhotoPath ? signed[w.coverPhotoPath] ?? null : null,
    privacy: w.privacy,
    status: w.status,
    itemCount: w._count.items,
    createdAt: w.createdAt,
  }));
}

async function shapeWardrobeDetail(w: any) {
  const itemPaths = w.items.map((wi: any) => wi.item.photos[0]?.storagePath).filter(Boolean) as string[];
  const paths = w.coverPhotoPath ? [w.coverPhotoPath, ...itemPaths] : itemPaths;
  const signed = await signPaths(paths);
  return {
    id: w.id,
    name: w.name,
    description: w.description,
    occasion: shapeOccasion(w.occasion),
    coverPhotoPath: w.coverPhotoPath ?? null,
    coverUrl: w.coverPhotoPath ? signed[w.coverPhotoPath] ?? null : null,
    privacy: w.privacy,
    status: w.status,
    owner: w.owner,
    itemCount: w.items.length,
    items: w.items.map((wi: any) => ({
      id: wi.item.id,
      category: { id: wi.item.category.id, name: wi.item.category.name },
      thumbnailUrl: wi.item.photos[0] ? signed[wi.item.photos[0].storagePath] ?? null : null,
    })),
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

const wardrobeInclude = {
  owner: { select: ownerSelect },
  occasion: true,
  items: {
    orderBy: { position: 'asc' as const },
    include: { item: { include: { category: true, photos: { orderBy: { position: 'asc' as const }, take: 1 } } } },
  },
};

// ---------- Discover (cross-user; Search screen's Wardrobes tab and its
// pre-search "Recent Wardrobes" grid) ----------
// Deliberately EVERYONE-privacy only, even for the account's own followers:
// a global discovery feed would otherwise leak a FOLLOWERS-privacy wardrobe's
// cover photo to people who aren't allowed to see it, before the normal
// per-wardrobe privacy check in GET /:id ever runs. Optional ?q= matches
// wardrobe name, occasion name, or owner username/display name.
router.get(
  '/discover',
  wrap(async (req, res) => {
    const me = uid(req);
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : undefined;

    const blocked = await prisma.block.findMany({
      where: { OR: [{ blockerId: me }, { blockedId: me }] },
      select: { blockerId: true, blockedId: true },
    });
    const blockedIds = new Set<string>();
    for (const b of blocked) blockedIds.add(b.blockerId === me ? b.blockedId : b.blockerId);

    const rows = await prisma.wardrobe.findMany({
      where: {
        privacy: 'EVERYONE',
        status: 'ACTIVE',
        ownerId: { notIn: [...blockedIds] },
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { occasion: { name: { contains: q, mode: 'insensitive' } } },
                { owner: { username: { contains: q, mode: 'insensitive' } } },
                { owner: { displayName: { contains: q, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 40,
      include: { owner: { select: ownerSelect }, occasion: true, _count: { select: { items: true } } },
    });

    const paths = rows.map((w) => w.coverPhotoPath).filter(Boolean) as string[];
    const signed = await signPaths(paths);

    res.json({
      wardrobes: rows.map((w) => ({
        id: w.id,
        name: w.name,
        occasion: shapeOccasion(w.occasion),
        coverUrl: w.coverPhotoPath ? signed[w.coverPhotoPath] ?? null : null,
        itemCount: w._count.items,
        owner: w.owner,
        createdAt: w.createdAt,
      })),
    });
  })
);

// ---------- Occasions (same pattern as closet categories) ----------
router.get(
  '/occasions',
  wrap(async (req, res) => {
    const me = uid(req);
    const rows = await prisma.wardrobeOccasion.findMany({ where: { ownerId: me }, orderBy: { name: 'asc' } });
    res.json({ occasions: rows.map((o) => ({ id: o.id, name: o.name })) });
  })
);

router.post(
  '/occasions',
  wrap(async (req, res) => {
    const me = uid(req);
    const parsed = createOccasionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Enter an occasion name.' });
    if (!(await hasProfile(me))) return res.status(409).json(NEED_PROFILE);

    const existing = await prisma.wardrobeOccasion.findFirst({
      where: { ownerId: me, name: { equals: parsed.data.name, mode: 'insensitive' } },
    });
    if (existing) return res.status(409).json({ error: 'You already have an occasion with that name.' });

    const occasion = await prisma.wardrobeOccasion.create({ data: { ownerId: me, name: parsed.data.name } });
    res.status(201).json({ occasion: { id: occasion.id, name: occasion.name } });
  })
);

// ---------- Wardrobes ----------
router.get(
  '/',
  wrap(async (req, res) => {
    const me = uid(req);
    const statusParam = typeof req.query.status === 'string' ? req.query.status : 'ACTIVE';
    const where: any = { ownerId: me };
    if (statusParam !== 'ALL') where.status = statusParam;

    const rows = await prisma.wardrobe.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { occasion: true, _count: { select: { items: true } } },
    });
    res.json({ wardrobes: await shapeWardrobeList(rows) });
  })
);

// Another user's wardrobes, filtered to only what the requesting user can
// actually see. Always ACTIVE only - archived wardrobes are never shown to
// anyone but the owner, and the owner uses GET / (with ?status=) for those.
router.get(
  '/user/:userId',
  wrap(async (req, res) => {
    const me = uid(req);
    const ownerId = param(req, 'userId');

    const blocked = await prisma.block.findFirst({
      where: { OR: [{ blockerId: me, blockedId: ownerId }, { blockerId: ownerId, blockedId: me }] },
    });
    if (blocked) return res.json({ wardrobes: [] });

    const rows = await prisma.wardrobe.findMany({
      where: { ownerId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      include: { occasion: true, _count: { select: { items: true } } },
    });

    if (ownerId === me) {
      return res.json({ wardrobes: await shapeWardrobeList(rows) });
    }

    // Two lookups cover every privacy tier without an N+1 query per wardrobe.
    const followEdge = await prisma.follow.findUnique({
      where: { followerId_followingId: { followerId: me, followingId: ownerId } },
    });
    const isFollower = followEdge?.status === 'ACCEPTED';

    const selectedRows = await prisma.wardrobeSelectedViewer.findMany({
      where: { viewerId: me, wardrobe: { ownerId } },
      select: { wardrobeId: true },
    });
    const selectedWardrobeIds = new Set(selectedRows.map((r) => r.wardrobeId));

    const visible = rows.filter((w) => {
      if (w.privacy === 'EVERYONE') return true;
      if (w.privacy === 'FOLLOWERS') return isFollower;
      if (w.privacy === 'SELECTED') return selectedWardrobeIds.has(w.id);
      return false; // ONLY_ME
    });

    res.json({ wardrobes: await shapeWardrobeList(visible) });
  })
);

router.get(
  '/:id',
  wrap(async (req, res) => {
    const me = uid(req);
    const wardrobe = await prisma.wardrobe.findUnique({ where: { id: param(req, 'id') }, include: wardrobeInclude });
    if (!wardrobe) return res.status(404).json({ error: 'Wardrobe not found.' });
    if (!(await canView(wardrobe, me))) return res.status(404).json({ error: 'Wardrobe not found.' });
    res.json({ wardrobe: await shapeWardrobeDetail(wardrobe) });
  })
);

router.post(
  '/',
  wrap(async (req, res) => {
    const me = uid(req);
    const parsed = createWardrobeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid wardrobe.', details: parsed.error.flatten() });
    if (!(await hasProfile(me))) return res.status(409).json(NEED_PROFILE);

    const data = parsed.data;

    const items = await prisma.item.findMany({
      where: { id: { in: data.itemIds }, ownerId: me },
      include: { photos: { orderBy: { position: 'asc' }, take: 1 } },
    });
    if (items.length !== data.itemIds.length) {
      return res.status(400).json({ error: 'One or more selected items could not be found.' });
    }

    if (data.occasionId) {
      const occasion = await prisma.wardrobeOccasion.findFirst({ where: { id: data.occasionId, ownerId: me } });
      if (!occasion) return res.status(404).json({ error: 'Occasion not found.' });
    }

    if (data.coverPhotoPath && !ownsPath(me, data.coverPhotoPath)) {
      return res.status(400).json({ error: 'Invalid cover photo reference.' });
    }

    if (data.privacy === 'SELECTED' && data.selectedUserIds?.length) {
      const validFollowers = await prisma.follow.count({
        where: { followingId: me, followerId: { in: data.selectedUserIds }, status: 'ACCEPTED' },
      });
      if (validFollowers !== data.selectedUserIds.length) {
        return res.status(400).json({ error: 'You can only select people who follow you.' });
      }
    }

    // Default cover: the first photo of the first item, in the order the user picked them.
    const itemById = new Map(items.map((i) => [i.id, i]));
    const defaultCoverPath = data.coverPhotoPath ?? itemById.get(data.itemIds[0])?.photos[0]?.storagePath ?? null;

    const created = await prisma.wardrobe.create({
      data: {
        ownerId: me,
        name: data.name,
        description: data.description,
        occasionId: data.occasionId ?? undefined,
        coverPhotoPath: defaultCoverPath,
        privacy: data.privacy,
        items: { create: data.itemIds.map((itemId, i) => ({ itemId, position: i })) },
        selectedViewers:
          data.privacy === 'SELECTED' && data.selectedUserIds
            ? { create: data.selectedUserIds.map((viewerId) => ({ viewerId })) }
            : undefined,
      },
      include: wardrobeInclude,
    });

    res.status(201).json({ wardrobe: await shapeWardrobeDetail(created) });
  })
);

router.patch(
  '/:id',
  wrap(async (req, res) => {
    const me = uid(req);
    const wardrobeId = param(req, 'id');
    const parsed = updateWardrobeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid update.', details: parsed.error.flatten() });

    const existing = await prisma.wardrobe.findFirst({ where: { id: wardrobeId, ownerId: me } });
    if (!existing) return res.status(404).json({ error: 'Wardrobe not found.' });

    const data = parsed.data;

    if (data.occasionId) {
      const occasion = await prisma.wardrobeOccasion.findFirst({ where: { id: data.occasionId, ownerId: me } });
      if (!occasion) return res.status(404).json({ error: 'Occasion not found.' });
    }

    if (data.coverPhotoPath && !ownsPath(me, data.coverPhotoPath)) {
      return res.status(400).json({ error: 'Invalid cover photo reference.' });
    }

    const nextPrivacy = data.privacy ?? existing.privacy;
    if (nextPrivacy === 'SELECTED' && data.selectedUserIds?.length) {
      const validFollowers = await prisma.follow.count({
        where: { followingId: me, followerId: { in: data.selectedUserIds }, status: 'ACCEPTED' },
      });
      if (validFollowers !== data.selectedUserIds.length) {
        return res.status(400).json({ error: 'You can only select people who follow you.' });
      }
    }

    if (data.itemIds) {
      const items = await prisma.item.findMany({ where: { id: { in: data.itemIds }, ownerId: me } });
      if (items.length !== data.itemIds.length) {
        return res.status(400).json({ error: 'One or more selected items could not be found.' });
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.wardrobe.update({
        where: { id: wardrobeId },
        data: {
          name: data.name,
          description: data.description,
          occasionId: data.occasionId === null ? null : data.occasionId,
          coverPhotoPath: data.coverPhotoPath,
          privacy: data.privacy,
          status: data.status,
        },
      });

      if (data.itemIds) {
        await tx.wardrobeItem.deleteMany({ where: { wardrobeId } });
        await tx.wardrobeItem.createMany({
          data: data.itemIds.map((itemId, i) => ({ wardrobeId, itemId, position: i })),
        });
      }

      if (data.privacy) {
        await tx.wardrobeSelectedViewer.deleteMany({ where: { wardrobeId } });
        if (data.privacy === 'SELECTED' && data.selectedUserIds) {
          await tx.wardrobeSelectedViewer.createMany({
            data: data.selectedUserIds.map((viewerId) => ({ wardrobeId, viewerId })),
          });
        }
      }
    });

    const updated = await prisma.wardrobe.findUnique({ where: { id: wardrobeId }, include: wardrobeInclude });
    res.json({ wardrobe: await shapeWardrobeDetail(updated) });
  })
);

router.delete(
  '/:id',
  wrap(async (req, res) => {
    const me = uid(req);
    const wardrobeId = param(req, 'id');
    const existing = await prisma.wardrobe.findFirst({ where: { id: wardrobeId, ownerId: me } });
    if (!existing) return res.status(404).json({ error: 'Wardrobe not found.' });

    // Deleting a wardrobe never deletes the items it references.
    await prisma.wardrobe.delete({ where: { id: wardrobeId } });
    res.json({ ok: true });
  })
);

export default router;