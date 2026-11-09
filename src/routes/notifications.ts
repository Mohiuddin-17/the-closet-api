import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { supabase } from '../lib/supabase';
import { requireAuth } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

const BUCKET = 'closet-items';
const SIGNED_URL_TTL_SECONDS = 60 * 60;

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
const actorSelect = { id: true, username: true, displayName: true, photoUrl: true };

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

const notificationInclude = {
  actor: { select: actorSelect },
  post: { select: { id: true, imageUrl: true, coverPhotoPath: true } },
  comment: { select: { id: true, body: true } },
};

// ---------- List / unread count / mark read ----------
router.get(
  '/',
  wrap(async (req, res) => {
    const me = uid(req);
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const limit = 30;

    const rows = await prisma.notification.findMany({
      where: { recipientId: me },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: notificationInclude,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const paths = page.map((n) => n.post?.coverPhotoPath).filter(Boolean) as string[];
    const signed = await signPaths(paths);

    res.json({
      notifications: page.map((n) => ({
        id: n.id,
        type: n.type,
        read: n.read,
        createdAt: n.createdAt,
        actor: n.actor,
        postId: n.postId,
        postImageUrl: n.post ? (n.post.coverPhotoPath ? signed[n.post.coverPhotoPath] ?? null : n.post.imageUrl) : null,
        commentBody: n.comment?.body ?? null,
        conversationId: n.conversationId,
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    });
  })
);

router.get(
  '/unread-count',
  wrap(async (req, res) => {
    const count = await prisma.notification.count({ where: { recipientId: uid(req), read: false } });
    res.json({ count });
  })
);

router.post(
  '/:id/read',
  wrap(async (req, res) => {
    await prisma.notification.updateMany({
      where: { id: param(req, 'id'), recipientId: uid(req) },
      data: { read: true },
    });
    res.json({ ok: true });
  })
);

router.post(
  '/read-all',
  wrap(async (req, res) => {
    await prisma.notification.updateMany({ where: { recipientId: uid(req), read: false }, data: { read: true } });
    res.json({ ok: true });
  })
);

// ---------- Preferences (unchanged) ----------
const DEFAULTS = { pauseAll: false, likes: 'FOLLOWING', comments: 'EVERYONE', followRequests: true };

function shape(row: any) {
  return { pauseAll: row.pauseAll, likes: row.likes, comments: row.comments, followRequests: row.followRequests };
}

router.get(
  '/preferences',
  wrap(async (req, res) => {
    const row = await prisma.notificationPreference.findUnique({ where: { userId: uid(req) } });
    res.json({ preferences: row ? shape(row) : DEFAULTS });
  })
);

const level = z.enum(['OFF', 'FOLLOWING', 'EVERYONE']);
const updateSchema = z.object({
  pauseAll: z.boolean().optional(),
  likes: level.optional(),
  comments: level.optional(),
  followRequests: z.boolean().optional(),
});

router.put(
  '/preferences',
  wrap(async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid preferences.' });
    const me = uid(req);
    const row = await prisma.notificationPreference.upsert({
      where: { userId: me },
      create: { userId: me, ...parsed.data },
      update: parsed.data,
    });
    res.json({ preferences: shape(row) });
  })
);

export default router;