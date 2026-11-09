import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma'; // CHECK: match how src/routes/profile.ts gets its Prisma client
import { supabase } from '../lib/supabase';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { createProfileSchema } from '../validators/profile';
import { notify } from '../lib/notify';

const router = Router();
router.use(requireAuth);

const BUCKET = 'closet-items';
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour, same as wardrobe covers - re-signed on every fetch

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
const authorSelect = { id: true, username: true, displayName: true, photoUrl: true };
const NEED_PROFILE = { error: 'Set up your profile first.', code: 'PROFILE_REQUIRED' };

async function hasProfile(id: string) {
  const p = await prisma.profile.findUnique({ where: { id }, select: { id: true } });
  return !!p;
}

/** Ids this user has blocked, or who have blocked this user - either direction excludes interaction. */
async function blockedEitherDirection(me: string): Promise<Set<string>> {
  const rows = await prisma.block.findMany({
    where: { OR: [{ blockerId: me }, { blockedId: me }] },
    select: { blockerId: true, blockedId: true },
  });
  const ids = new Set<string>();
  for (const r of rows) {
    ids.add(r.blockerId === me ? r.blockedId : r.blockerId);
  }
  return ids;
}

/** Whether `viewerId` may see `targetId`'s account-gated content: owner
 * always can; otherwise only if the account is public, or the viewer already
 * follows them. Used for Followers/Following lists and, as a first gate, the
 * Posts grid on another user's profile (individual posts can still be
 * stricter via their own privacy - see canViewPost). */
async function canViewFollowLists(targetId: string, viewerId: string): Promise<'ok' | 'blocked' | 'private' | 'not_found'> {
  if (targetId === viewerId) return 'ok';

  const blocked = await prisma.block.findFirst({
    where: { OR: [{ blockerId: viewerId, blockedId: targetId }, { blockerId: targetId, blockedId: viewerId }] },
  });
  if (blocked) return 'blocked';

  const target = await prisma.profile.findUnique({ where: { id: targetId }, select: { isPrivate: true } });
  if (!target) return 'not_found';
  if (!target.isPrivate) return 'ok';

  const follow = await prisma.follow.findUnique({
    where: { followerId_followingId: { followerId: viewerId, followingId: targetId } },
  });
  return follow?.status === 'ACCEPTED' ? 'ok' : 'private';
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

/** Per-post privacy check, independent of the author's own account privacy.
 * Mirrors wardrobe's canView exactly: owner always; block overrides
 * everything; EVERYONE/FOLLOWERS/SELECTED each checked the same way. */
async function canViewPost(post: { authorId: string; privacy: string; id: string }, viewerId: string): Promise<boolean> {
  if (post.authorId === viewerId) return true;

  const blocked = await prisma.block.findFirst({
    where: { OR: [{ blockerId: viewerId, blockedId: post.authorId }, { blockerId: post.authorId, blockedId: viewerId }] },
  });
  if (blocked) return false;

  if (post.privacy === 'EVERYONE') return true;
  if (post.privacy === 'FOLLOWERS') {
    const follow = await prisma.follow.findUnique({
      where: { followerId_followingId: { followerId: viewerId, followingId: post.authorId } },
    });
    return follow?.status === 'ACCEPTED';
  }
  if (post.privacy === 'SELECTED') {
    const selected = await prisma.postSelectedViewer.findUnique({
      where: { postId_viewerId: { postId: post.id, viewerId } },
    });
    return !!selected;
  }
  return false;
}

/** A post's privacy=SELECTED-aware Prisma where-clause fragment, combined
 * with an authorId filter the caller supplies. Used by /feed and
 * /users/:id/posts so pagination stays a single query rather than
 * fetch-then-filter in app code. */
function postVisibilityWhere(me: string) {
  return {
    OR: [{ privacy: { in: ['EVERYONE', 'FOLLOWERS'] } }, { privacy: 'SELECTED', selectedViewers: { some: { viewerId: me } } }],
  };
}

function postInclude(me: string): any {
  return {
    author: { select: authorSelect },
    wardrobe: { select: { id: true, name: true, _count: { select: { items: true } } } },
    itemTags: true,
    _count: { select: { likes: true, comments: true } },
    likes: { where: { userId: me }, select: { userId: true } },
    saves: { where: { userId: me }, select: { userId: true } },
  };
}

async function shapePosts(rows: any[]) {
  const paths = rows.map((p) => p.coverPhotoPath).filter(Boolean) as string[];
  const signed = await signPaths(paths);
  return rows.map((p) => ({
    id: p.id,
    imageUrl: p.coverPhotoPath ? signed[p.coverPhotoPath] ?? null : p.imageUrl,
    caption: p.caption,
    hashtags: p.hashtags ?? [],
    privacy: p.privacy,
    createdAt: p.createdAt,
    author: p.author,
    likeCount: p._count.likes,
    commentCount: p._count.comments,
    likedByMe: p.likes.length > 0,
    savedByMe: p.saves.length > 0,
    itemTags: p.itemTags.map((t: any) => ({ id: t.id, brand: t.brand, label: t.label, x: t.x, y: t.y })),
    wardrobe: p.wardrobe ? { id: p.wardrobe.id, name: p.wardrobe.name, itemCount: p.wardrobe._count.items } : null,
  }));
}

function commentInclude(me: string): any {
  return {
    author: { select: authorSelect },
    _count: { select: { likes: true } },
    likes: { where: { userId: me }, select: { userId: true } },
  };
}

function shapeComment(c: any) {
  return {
    id: c.id,
    postId: c.postId,
    parentId: c.parentId,
    body: c.body,
    createdAt: c.createdAt,
    author: c.author,
    likeCount: c._count.likes,
    likedByMe: c.likes.length > 0,
  };
}

// ---------- Feed (FR-609) ----------
router.get(
  '/feed',
  wrap(async (req, res) => {
    const me = uid(req);
    const limit = 10;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

    // Only ACCEPTED follows count. PENDING requests (private accounts) must not leak posts.
    const following = await prisma.follow.findMany({
      where: { followerId: me, status: 'ACCEPTED' },
      select: { followingId: true },
    });
    const blocked = await blockedEitherDirection(me);
    const authorIds = [me, ...following.map((f) => f.followingId)].filter((id) => !blocked.has(id));

    const rows = (await prisma.post.findMany({
      where: { authorId: { in: authorIds }, ...postVisibilityWhere(me) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: postInclude(me),
    })) as any[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    res.json({
      posts: await shapePosts(page),
      nextCursor: hasMore ? page[page.length - 1].id : null,
      followingCount: following.length,
    });
  })
);

// ---------- Suggested people ----------
router.get(
  '/suggested',
  wrap(async (req, res) => {
    const me = uid(req);
    const existing = await prisma.follow.findMany({ where: { followerId: me }, select: { followingId: true } });
    const blocked = await blockedEitherDirection(me);
    const exclude = [me, ...existing.map((f) => f.followingId), ...blocked];
    const users = await prisma.profile.findMany({
      where: { id: { notIn: exclude } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, username: true, displayName: true, bio: true, photoUrl: true },
    });
    res.json({ users });
  })
);

// ---------- My followers (people who follow me) ----------
// Used for: wardrobe "Selected People" privacy, Hide Story/Reel From, and
// the Followers list screen. Each row includes iFollowThem so the Followers
// screen can show "Following" vs "Follow" per person.
// Optional ?q= filters by username or display name.
router.get(
  '/followers',
  wrap(async (req, res) => {
    const me = uid(req);
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : undefined;

    const rows = await prisma.follow.findMany({
      where: {
        followingId: me,
        status: 'ACCEPTED',
        ...(q
          ? {
              follower: {
                OR: [
                  { username: { contains: q, mode: 'insensitive' } },
                  { displayName: { contains: q, mode: 'insensitive' } },
                ],
              },
            }
          : {}),
      },
      include: { follower: { select: authorSelect } },
      orderBy: { createdAt: 'desc' },
      take: 200, // TODO confirm pagination needs once follower counts grow
    });

    const myFollowing = await prisma.follow.findMany({
      where: { followerId: me, status: 'ACCEPTED' },
      select: { followingId: true },
    });
    const iFollowSet = new Set(myFollowing.map((f) => f.followingId));

    res.json({
      followers: rows.map((r) => ({ ...r.follower, iFollowThem: iFollowSet.has(r.follower.id) })),
    });
  })
);

// ---------- People I follow ----------
// Each row includes followsMe, so the Following screen can show a "Follows
// you" badge. Optional ?q= filters by username or display name.
router.get(
  '/following',
  wrap(async (req, res) => {
    const me = uid(req);
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : undefined;

    const rows = await prisma.follow.findMany({
      where: {
        followerId: me,
        status: 'ACCEPTED',
        ...(q
          ? {
              following: {
                OR: [
                  { username: { contains: q, mode: 'insensitive' } },
                  { displayName: { contains: q, mode: 'insensitive' } },
                ],
              },
            }
          : {}),
      },
      include: { following: { select: authorSelect } },
      orderBy: { createdAt: 'desc' },
      take: 200, // TODO confirm pagination needs once following counts grow
    });

    const myFollowers = await prisma.follow.findMany({
      where: { followingId: me, status: 'ACCEPTED' },
      select: { followerId: true },
    });
    const followsMeSet = new Set(myFollowers.map((f) => f.followerId));

    res.json({
      following: rows.map((r) => ({ ...r.following, followsMe: followsMeSet.has(r.following.id) })),
    });
  })
);

// ---------- Follow-list access check (no list data, just the verdict) ----------
// Used by the client to decide, before navigating anywhere, whether a tap on
// "Followers" / "Following" for another user should do anything at all. For a
// private account the viewer doesn't follow, the answer is 'private' and the
// client does nothing - no screen opens, no message is shown.
router.get(
  '/users/:id/follow-access',
  wrap(async (req, res) => {
    const access = await canViewFollowLists(param(req, 'id'), uid(req));
    res.json({ access });
  })
);

// ---------- Another user's followers/following ----------
// Enforces canViewFollowLists: public account, or viewer already follows
// them - otherwise 403 PRIVATE_ACCOUNT. Rows exclude anyone blocked in either
// direction relative to the viewer, even if they're a real follower/following
// edge of the target.
router.get(
  '/users/:id/followers',
  wrap(async (req, res) => {
    const me = uid(req);
    const targetId = param(req, 'id');

    const access = await canViewFollowLists(targetId, me);
    if (access === 'not_found') return res.status(404).json({ error: 'User not found.' });
    if (access === 'blocked') return res.status(404).json({ error: 'User not found.' });
    if (access === 'private') return res.status(403).json({ error: 'This account is private.', code: 'PRIVATE_ACCOUNT' });

    const blocked = await blockedEitherDirection(me);

    const rows = await prisma.follow.findMany({
      where: { followingId: targetId, status: 'ACCEPTED', followerId: { notIn: Array.from(blocked) } },
      include: { follower: { select: authorSelect } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const myFollowing = await prisma.follow.findMany({
      where: { followerId: me, status: 'ACCEPTED' },
      select: { followingId: true },
    });
    const iFollowSet = new Set(myFollowing.map((f) => f.followingId));

    res.json({
      followers: rows.map((r) => ({ ...r.follower, iFollowThem: iFollowSet.has(r.follower.id) })),
    });
  })
);

router.get(
  '/users/:id/following',
  wrap(async (req, res) => {
    const me = uid(req);
    const targetId = param(req, 'id');

    const access = await canViewFollowLists(targetId, me);
    if (access === 'not_found') return res.status(404).json({ error: 'User not found.' });
    if (access === 'blocked') return res.status(404).json({ error: 'User not found.' });
    if (access === 'private') return res.status(403).json({ error: 'This account is private.', code: 'PRIVATE_ACCOUNT' });

    const blocked = await blockedEitherDirection(me);

    const rows = await prisma.follow.findMany({
      where: { followerId: targetId, status: 'ACCEPTED', followingId: { notIn: Array.from(blocked) } },
      include: { following: { select: authorSelect } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const myFollowers = await prisma.follow.findMany({
      where: { followingId: me, status: 'ACCEPTED' },
      select: { followerId: true },
    });
    const followsMeSet = new Set(myFollowers.map((f) => f.followerId));

    res.json({
      following: rows.map((r) => ({ ...r.following, followsMe: followsMeSet.has(r.following.id) })),
    });
  })
);

// ---------- Another user's posts (profile's Posts grid) ----------
// Two layers of gating: the account-level check (public, or viewer already
// follows them) AND each individual post's own privacy - a SELECTED post not
// naming this viewer stays hidden even on an otherwise-visible public profile.
router.get(
  '/users/:id/posts',
  wrap(async (req, res) => {
    const me = uid(req);
    const targetId = param(req, 'id');

    const access = await canViewFollowLists(targetId, me);
    if (access === 'not_found') return res.status(404).json({ error: 'User not found.' });
    if (access === 'blocked') return res.status(404).json({ error: 'User not found.' });
    if (access === 'private') return res.status(403).json({ error: 'This account is private.', code: 'PRIVATE_ACCOUNT' });

    const rows = (await prisma.post.findMany({
      where: { authorId: targetId, ...postVisibilityWhere(me) },
      orderBy: { createdAt: 'desc' },
      take: 60,
      include: postInclude(me),
    })) as any[];

    res.json({ posts: await shapePosts(rows) });
  })
);

// ---------- General user search (any profile, not just followers) ----------
// Used by Block Search and the main Search screen's Accounts tab. Includes
// isFollowing so the Search screen can show Follow vs Following per result.
// Requires at least 2 characters.
router.get(
  '/search',
  wrap(async (req, res) => {
    const me = uid(req);
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length < 2) return res.json({ users: [] });

    const blocked = await blockedEitherDirection(me);
    const rows = await prisma.profile.findMany({
      where: {
        id: { notIn: [me, ...blocked] },
        OR: [
          { username: { contains: q, mode: 'insensitive' } },
          { displayName: { contains: q, mode: 'insensitive' } },
        ],
      },
      take: 20,
      select: authorSelect,
    });

    const myFollowing = await prisma.follow.findMany({
      where: { followerId: me, status: 'ACCEPTED' },
      select: { followingId: true },
    });
    const iFollowSet = new Set(myFollowing.map((f) => f.followingId));

    res.json({ users: rows.map((u) => ({ ...u, isFollowing: iFollowSet.has(u.id) })) });
  })
);

// ---------- Blocking ----------
router.get(
  '/blocks',
  wrap(async (req, res) => {
    const me = uid(req);
    const rows = await prisma.block.findMany({
      where: { blockerId: me },
      include: { blocked: { select: authorSelect } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ blocked: rows.map((r) => ({ ...r.blocked, blockedAt: r.createdAt })) });
  })
);

router.post(
  '/blocks/:id',
  wrap(async (req, res) => {
    const me = uid(req);
    const target = param(req, 'id');
    if (me === target) return res.status(400).json({ error: 'You cannot block yourself.' });

    const targetProfile = await prisma.profile.findUnique({ where: { id: target }, select: { id: true } });
    if (!targetProfile) return res.status(404).json({ error: 'User not found.' });

    await prisma.$transaction([
      prisma.block.upsert({
        where: { blockerId_blockedId: { blockerId: me, blockedId: target } },
        create: { blockerId: me, blockedId: target },
        update: {},
      }),
      // A block removes any existing follow relationship, both directions.
      prisma.follow.deleteMany({
        where: { OR: [{ followerId: me, followingId: target }, { followerId: target, followingId: me }] },
      }),
    ]);

    res.json({ ok: true });
  })
);

router.delete(
  '/blocks/:id',
  wrap(async (req, res) => {
    await prisma.block.deleteMany({ where: { blockerId: uid(req), blockedId: param(req, 'id') } });
    res.json({ ok: true });
  })
);

// ---------- Follow / unfollow ----------
router.post(
  '/follows/:id',
  wrap(async (req, res) => {
    const me = uid(req);
    const target = param(req, 'id');
    if (me === target) return res.status(400).json({ error: 'You cannot follow yourself.' });
    if (!(await hasProfile(me))) return res.status(409).json(NEED_PROFILE);

    const blocked = await prisma.block.findFirst({
      where: { OR: [{ blockerId: me, blockedId: target }, { blockerId: target, blockedId: me }] },
    });
    if (blocked) return res.status(403).json({ error: 'You cannot follow this account.' });

    const targetProfile = await prisma.profile.findUnique({
      where: { id: target },
      select: { id: true, isPrivate: true },
    });
    if (!targetProfile) return res.status(404).json({ error: 'User not found.' });

    const status = targetProfile.isPrivate ? 'PENDING' : 'ACCEPTED';
    await prisma.follow.upsert({
      where: { followerId_followingId: { followerId: me, followingId: target } },
      create: { followerId: me, followingId: target, status },
      update: {},
    });

    await notify({
      recipientId: target,
      actorId: me,
      type: status === 'PENDING' ? 'FOLLOW_REQUEST' : 'NEW_FOLLOWER',
    });

    res.json({ ok: true, status });
  })
);

router.delete(
  '/follows/:id',
  wrap(async (req, res) => {
    await prisma.follow.deleteMany({ where: { followerId: uid(req), followingId: param(req, 'id') } });
    res.json({ ok: true });
  })
);

// Accept/decline a PENDING follow request - :id is the FOLLOWER's id (the
// person who sent the request).
router.post(
  '/follows/:id/accept',
  wrap(async (req, res) => {
    const me = uid(req);
    const followerId = param(req, 'id');
    const result = await prisma.follow.updateMany({
      where: { followerId, followingId: me, status: 'PENDING' },
      data: { status: 'ACCEPTED' },
    });
    if (result.count === 0) return res.status(404).json({ error: 'Request not found.' });
    await notify({ recipientId: followerId, actorId: me, type: 'FOLLOW_ACCEPTED' });
    res.json({ ok: true });
  })
);

router.post(
  '/follows/:id/decline',
  wrap(async (req, res) => {
    const me = uid(req);
    const result = await prisma.follow.deleteMany({
      where: { followerId: param(req, 'id'), followingId: me, status: 'PENDING' },
    });
    if (result.count === 0) return res.status(404).json({ error: 'Request not found.' });
    res.json({ ok: true });
  })
);

// ---------- Create / delete post (FR-601, FR-602, FR-608) ----------
const PRIVACY_ENUM = z.enum(['EVERYONE', 'FOLLOWERS', 'SELECTED']);

const createPostSchema = z
  .object({
    imageUrl: z.string().url().optional(), // legacy path - plain external URL, no upload
    coverPhotoPath: z.string().optional(), // new path - storage path from the signed-upload flow
    caption: z.string().max(2200).optional(),
    privacy: PRIVACY_ENUM.default('FOLLOWERS'),
    selectedUserIds: z.array(z.string().uuid()).optional(),
    wardrobeId: z.string().uuid().optional(),
    itemTags: z
      .array(
        z.object({
          brand: z.string().trim().min(1).max(60),
          label: z.string().trim().max(80).optional(),
          x: z.number().min(0).max(1),
          y: z.number().min(0).max(1),
        })
      )
      .max(10)
      .optional(),
  })
  .refine((d) => !!d.imageUrl || !!d.coverPhotoPath, { message: 'A cover photo is required.' });

/** #word hashtags out of the caption, lowercased, deduplicated. Same style as
 * the comment @mention extraction already in this file. */
function extractHashtags(caption?: string): string[] {
  if (!caption) return [];
  const matches = caption.match(/#([a-zA-Z0-9_]{2,40})/g) ?? [];
  return Array.from(new Set(matches.map((h) => h.slice(1).toLowerCase())));
}

router.post(
  '/posts',
  wrap(async (req, res) => {
    const me = uid(req);
    const parsed = createPostSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid post.', details: parsed.error.flatten() });
    if (!(await hasProfile(me))) return res.status(409).json(NEED_PROFILE);

    const data = parsed.data;

    if (data.coverPhotoPath && !data.coverPhotoPath.startsWith(`${me}/`)) {
      return res.status(400).json({ error: 'Invalid cover photo reference.' });
    }

    if (data.wardrobeId) {
      const wardrobe = await prisma.wardrobe.findFirst({ where: { id: data.wardrobeId, ownerId: me, status: 'ACTIVE' } });
      if (!wardrobe) return res.status(404).json({ error: 'Wardrobe not found.' });
    }

    if (data.privacy === 'SELECTED' && data.selectedUserIds?.length) {
      const validFollowers = await prisma.follow.count({
        where: { followingId: me, followerId: { in: data.selectedUserIds }, status: 'ACCEPTED' },
      });
      if (validFollowers !== data.selectedUserIds.length) {
        return res.status(400).json({ error: 'You can only select people who follow you.' });
      }
    }

    const created = (await prisma.post.create({
      data: {
        authorId: me,
        imageUrl: data.imageUrl,
        coverPhotoPath: data.coverPhotoPath,
        caption: data.caption,
        hashtags: extractHashtags(data.caption),
        privacy: data.privacy,
        wardrobeId: data.wardrobeId,
        itemTags: { create: data.itemTags ?? [] },
        selectedViewers:
          data.privacy === 'SELECTED' && data.selectedUserIds
            ? { create: data.selectedUserIds.map((viewerId) => ({ viewerId })) }
            : undefined,
      },
      include: postInclude(me),
    })) as any;

    const [shaped] = await shapePosts([created]);
    res.status(201).json({ post: shaped });
  })
);

// Single post, for the Inspect screen's full-size cover view and as a
// standalone deep link. Full canViewPost check, not just the feed's
// query-level filter.
router.get(
  '/posts/:id',
  wrap(async (req, res) => {
    const me = uid(req);
    const row = (await prisma.post.findUnique({ where: { id: param(req, 'id') }, include: postInclude(me) })) as any;
    if (!row) return res.status(404).json({ error: 'Post not found.' });
    if (!(await canViewPost(row, me))) return res.status(404).json({ error: 'Post not found.' });
    const [shaped] = await shapePosts([row]);
    res.json({ post: shaped });
  })
);

// Inspect: the wardrobe's full item list, for a wardrobe-post. Access to the
// POST (already gated by privacy) is what gates this - the wardrobe's own
// current privacy is not re-checked, since the post carries its own gate.
router.get(
  '/posts/:id/wardrobe-items',
  wrap(async (req, res) => {
    const me = uid(req);
    const post = await prisma.post.findUnique({ where: { id: param(req, 'id') }, select: { id: true, authorId: true, privacy: true, wardrobeId: true } });
    if (!post) return res.status(404).json({ error: 'Post not found.' });
    if (!(await canViewPost(post, me))) return res.status(404).json({ error: 'Post not found.' });
    if (!post.wardrobeId) return res.json({ items: [] });

    const items = await prisma.wardrobeItem.findMany({
      where: { wardrobeId: post.wardrobeId },
      orderBy: { position: 'asc' },
      include: { item: { include: { category: true, photos: { orderBy: { position: 'asc' }, take: 1 } } } },
    });

    const paths = items.map((wi) => wi.item.photos[0]?.storagePath).filter(Boolean) as string[];
    const signed = await signPaths(paths);

    res.json({
      items: items.map((wi) => ({
        id: wi.item.id,
        category: wi.item.category.name,
        purchasePrice: wi.item.purchasePrice,
        thumbnailUrl: wi.item.photos[0] ? signed[wi.item.photos[0].storagePath] ?? null : null,
      })),
    });
  })
);

router.delete(
  '/posts/:id',
  wrap(async (req, res) => {
    const result = await prisma.post.deleteMany({ where: { id: param(req, 'id'), authorId: uid(req) } });
    if (result.count === 0) return res.status(404).json({ error: 'Post not found.' });
    res.json({ ok: true });
  })
);

// ---------- Like / save (FR-603, FR-606) ----------
router.post(
  '/posts/:id/like',
  wrap(async (req, res) => {
    const me = uid(req);
    const postId = param(req, 'id');
    if (!(await hasProfile(me))) return res.status(409).json(NEED_PROFILE);
    const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true, authorId: true } });
    if (!post) return res.status(404).json({ error: 'Post not found.' });
    await prisma.postLike.upsert({
      where: { postId_userId: { postId, userId: me } },
      create: { postId, userId: me },
      update: {},
    });
    await notify({ recipientId: post.authorId, actorId: me, type: 'LIKE', postId });
    res.json({ ok: true });
  })
);

router.delete(
  '/posts/:id/like',
  wrap(async (req, res) => {
    await prisma.postLike.deleteMany({ where: { postId: param(req, 'id'), userId: uid(req) } });
    res.json({ ok: true });
  })
);

router.post(
  '/posts/:id/save',
  wrap(async (req, res) => {
    const me = uid(req);
    const postId = param(req, 'id');
    if (!(await hasProfile(me))) return res.status(409).json(NEED_PROFILE);
    const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } });
    if (!post) return res.status(404).json({ error: 'Post not found.' });
    await prisma.savedPost.upsert({
      where: { postId_userId: { postId, userId: me } },
      create: { postId, userId: me },
      update: {},
    });
    res.json({ ok: true });
  })
);

router.delete(
  '/posts/:id/save',
  wrap(async (req, res) => {
    await prisma.savedPost.deleteMany({ where: { postId: param(req, 'id'), userId: uid(req) } });
    res.json({ ok: true });
  })
);

// ---------- Tagging people on posts (approval-gated) ----------
const createUserTagSchema = z.object({
  taggedUserId: z.string().uuid(),
  itemId: z.string().uuid().optional(),
});

router.post(
  '/posts/:id/tags',
  wrap(async (req, res) => {
    const me = uid(req);
    const postId = param(req, 'id');
    const parsed = createUserTagSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid tag.' });
    if (!(await hasProfile(me))) return res.status(409).json(NEED_PROFILE);

    const post = await prisma.post.findFirst({ where: { id: postId, authorId: me } });
    if (!post) return res.status(404).json({ error: 'Post not found.' });

    const target = await prisma.profile.findUnique({
      where: { id: parsed.data.taggedUserId },
      select: { id: true, whoCanTagMe: true, requireTagApproval: true },
    });
    if (!target) return res.status(404).json({ error: 'User not found.' });

    const blocked = await prisma.block.findFirst({
      where: { OR: [{ blockerId: me, blockedId: target.id }, { blockerId: target.id, blockedId: me }] },
    });
    if (blocked) return res.status(403).json({ error: 'You cannot tag this user.' });

    if (target.whoCanTagMe === 'NO_ONE') {
      return res.status(403).json({ error: 'This user does not allow tagging.' });
    }
    if (target.whoCanTagMe === 'FOLLOWING') {
      const theyFollowMe = await prisma.follow.findUnique({
        where: { followerId_followingId: { followerId: target.id, followingId: me } },
      });
      if (theyFollowMe?.status !== 'ACCEPTED') {
        return res.status(403).json({ error: 'This user only allows tags from people they follow.' });
      }
    }

    if (parsed.data.itemId) {
      const item = await prisma.item.findFirst({ where: { id: parsed.data.itemId, ownerId: target.id } });
      if (!item) return res.status(400).json({ error: 'That item does not belong to the tagged user.' });
    }

    const tag = await prisma.postUserTag.create({
      data: {
        postId,
        taggedUserId: target.id,
        itemId: parsed.data.itemId,
        status: target.requireTagApproval ? 'PENDING' : 'APPROVED',
      },
    });

    await notify({ recipientId: target.id, actorId: me, type: 'TAG', postId });

    res.status(201).json({ tag });
  })
);

// Tags on me (across any post) that are still waiting for my approval.
router.get(
  '/tags/pending',
  wrap(async (req, res) => {
    const me = uid(req);
    const rows = await prisma.postUserTag.findMany({
      where: { taggedUserId: me, status: 'PENDING' },
      include: {
        post: { include: { author: { select: authorSelect } } },
        item: { include: { category: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      tags: rows.map((t) => ({
        id: t.id,
        postId: t.postId,
        postAuthor: t.post.author,
        postCaption: t.post.caption,
        item: t.item ? { id: t.item.id, category: t.item.category.name } : null,
        createdAt: t.createdAt,
      })),
    });
  })
);

router.post(
  '/tags/:id/approve',
  wrap(async (req, res) => {
    const result = await prisma.postUserTag.updateMany({
      where: { id: param(req, 'id'), taggedUserId: uid(req), status: 'PENDING' },
      data: { status: 'APPROVED' },
    });
    if (result.count === 0) return res.status(404).json({ error: 'Tag not found.' });
    res.json({ ok: true });
  })
);

router.post(
  '/tags/:id/reject',
  wrap(async (req, res) => {
    const result = await prisma.postUserTag.updateMany({
      where: { id: param(req, 'id'), taggedUserId: uid(req), status: 'PENDING' },
      data: { status: 'REJECTED' },
    });
    if (result.count === 0) return res.status(404).json({ error: 'Tag not found.' });
    res.json({ ok: true });
  })
);

// ---------- Comments (FR-604), with minimal @mention recording ----------
router.get(
  '/posts/:id/comments',
  wrap(async (req, res) => {
    const me = uid(req);
    const rows = (await prisma.comment.findMany({
      where: { postId: param(req, 'id') },
      orderBy: { createdAt: 'asc' },
      include: commentInclude(me),
    })) as any[];
    res.json({ comments: rows.map(shapeComment) });
  })
);

const commentSchema = z.object({
  body: z.string().trim().min(1).max(1000),
  parentId: z.string().uuid().optional(),
});

/** Extracts @usernames from comment text and records a Mention for each one
 * whose whoCanMentionMe preference allows it, and notifies them. Disallowed
 * mentions are simply not recorded - they don't block the comment. */
async function recordMentions(commentId: string, postId: string, me: string, body: string) {
  const handles = Array.from(new Set((body.match(/@([a-zA-Z0-9_.]{3,30})/g) ?? []).map((h) => h.slice(1))));
  if (handles.length === 0) return;

  const users = await prisma.profile.findMany({
    where: { username: { in: handles } },
    select: { id: true, username: true, whoCanMentionMe: true },
  });

  const allowed: string[] = [];
  for (const u of users) {
    if (u.id === me) continue;
    if (u.whoCanMentionMe === 'EVERYONE') {
      allowed.push(u.id);
    } else if (u.whoCanMentionMe === 'FOLLOWING') {
      const theyFollowMe = await prisma.follow.findUnique({
        where: { followerId_followingId: { followerId: u.id, followingId: me } },
      });
      if (theyFollowMe?.status === 'ACCEPTED') allowed.push(u.id);
    }
    // NO_ONE: never recorded.
  }

  if (allowed.length > 0) {
    await prisma.mention.createMany({
      data: allowed.map((mentionedUserId) => ({ commentId, mentionedUserId })),
    });
    for (const mentionedUserId of allowed) {
      await notify({ recipientId: mentionedUserId, actorId: me, type: 'MENTION', postId, commentId });
    }
  }
}

router.post(
  '/posts/:id/comments',
  wrap(async (req, res) => {
    const me = uid(req);
    const postId = param(req, 'id');
    const parsed = commentSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Write a comment (max 1000 characters).' });
    if (!(await hasProfile(me))) return res.status(409).json(NEED_PROFILE);

    const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true, authorId: true } });
    if (!post) return res.status(404).json({ error: 'Post not found.' });

    let parentId: string | null = null;
    if (parsed.data.parentId) {
      const parent = await prisma.comment.findUnique({
        where: { id: parsed.data.parentId },
        select: { id: true, postId: true, parentId: true },
      });
      if (!parent || parent.postId !== postId) return res.status(400).json({ error: 'Invalid reply target.' });
      parentId = parent.parentId ?? parent.id; // one level of threading
    }

    const created = (await prisma.comment.create({
      data: { postId, authorId: me, parentId, body: parsed.data.body },
      include: commentInclude(me),
    })) as any;

    await notify({ recipientId: post.authorId, actorId: me, type: 'COMMENT', postId, commentId: created.id });
    await recordMentions(created.id, postId, me, parsed.data.body);

    res.status(201).json({ comment: shapeComment(created) });
  })
);

router.post(
  '/comments/:id/like',
  wrap(async (req, res) => {
    const me = uid(req);
    const commentId = param(req, 'id');
    if (!(await hasProfile(me))) return res.status(409).json(NEED_PROFILE);
    const c = await prisma.comment.findUnique({ where: { id: commentId }, select: { id: true } });
    if (!c) return res.status(404).json({ error: 'Comment not found.' });
    await prisma.commentLike.upsert({
      where: { commentId_userId: { commentId, userId: me } },
      create: { commentId, userId: me },
      update: {},
    });
    res.json({ ok: true });
  })
);

router.delete(
  '/comments/:id/like',
  wrap(async (req, res) => {
    await prisma.commentLike.deleteMany({ where: { commentId: param(req, 'id'), userId: uid(req) } });
    res.json({ ok: true });
  })
);

// ---------- Stories (24-hour ephemeral) ----------
const STORY_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Same shape as canViewPost, applied to stories. */
async function canViewStory(story: { authorId: string; privacy: string; id: string }, viewerId: string): Promise<boolean> {
  if (story.authorId === viewerId) return true;

  const blocked = await prisma.block.findFirst({
    where: { OR: [{ blockerId: viewerId, blockedId: story.authorId }, { blockerId: story.authorId, blockedId: viewerId }] },
  });
  if (blocked) return false;

  if (story.privacy === 'EVERYONE') return true;
  if (story.privacy === 'FOLLOWERS') {
    const follow = await prisma.follow.findUnique({
      where: { followerId_followingId: { followerId: viewerId, followingId: story.authorId } },
    });
    return follow?.status === 'ACCEPTED';
  }
  if (story.privacy === 'SELECTED') {
    const selected = await prisma.storySelectedViewer.findUnique({
      where: { storyId_viewerId: { storyId: story.id, viewerId } },
    });
    return !!selected;
  }
  return false;
}

const createStorySchema = z.object({
  imagePath: z.string().trim().min(1),
  caption: z.string().trim().max(200).optional(),
  privacy: PRIVACY_ENUM.default('FOLLOWERS'),
  selectedUserIds: z.array(z.string().uuid()).optional(),
  itemTags: z
    .array(
      z.object({
        brand: z.string().trim().min(1).max(60),
        label: z.string().trim().max(80).optional(),
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
      })
    )
    .max(10)
    .optional(),
});

router.post(
  '/stories',
  wrap(async (req, res) => {
    const me = uid(req);
    const parsed = createStorySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid story.', details: parsed.error.flatten() });
    if (!(await hasProfile(me))) return res.status(409).json(NEED_PROFILE);

    const data = parsed.data;
    if (!data.imagePath.startsWith(`${me}/`)) return res.status(400).json({ error: 'Invalid photo reference.' });

    if (data.privacy === 'SELECTED' && data.selectedUserIds?.length) {
      const validFollowers = await prisma.follow.count({
        where: { followingId: me, followerId: { in: data.selectedUserIds }, status: 'ACCEPTED' },
      });
      if (validFollowers !== data.selectedUserIds.length) {
        return res.status(400).json({ error: 'You can only select people who follow you.' });
      }
    }

    const created = await prisma.story.create({
      data: {
        authorId: me,
        imagePath: data.imagePath,
        caption: data.caption,
        privacy: data.privacy,
        expiresAt: new Date(Date.now() + STORY_LIFETIME_MS),
        itemTags: { create: data.itemTags ?? [] },
        selectedViewers:
          data.privacy === 'SELECTED' && data.selectedUserIds
            ? { create: data.selectedUserIds.map((viewerId) => ({ viewerId })) }
            : undefined,
      },
      include: { itemTags: true },
    });

    const signed = await signPaths([created.imagePath]);
    res.status(201).json({
      story: {
        id: created.id,
        imageUrl: signed[created.imagePath] ?? null,
        caption: created.caption,
        privacy: created.privacy,
        createdAt: created.createdAt,
        expiresAt: created.expiresAt,
        itemTags: created.itemTags.map((t) => ({ id: t.id, brand: t.brand, label: t.label, x: t.x, y: t.y })),
      },
    });
  })
);

// Stories bar: one bucket per author (you first, then everyone you follow
// with an active story), each with hasUnseen so the client can ring it.
router.get(
  '/stories/feed',
  wrap(async (req, res) => {
    const me = uid(req);
    const now = new Date();

    const following = await prisma.follow.findMany({ where: { followerId: me, status: 'ACCEPTED' }, select: { followingId: true } });
    const blocked = await blockedEitherDirection(me);
    const authorIds = [me, ...following.map((f) => f.followingId)].filter((id) => !blocked.has(id));

    const rows = await prisma.story.findMany({
      where: {
        authorId: { in: authorIds },
        expiresAt: { gt: now },
        OR: [{ privacy: { in: ['EVERYONE', 'FOLLOWERS'] } }, { privacy: 'SELECTED', selectedViewers: { some: { viewerId: me } } }],
      },
      orderBy: { createdAt: 'asc' },
      include: { author: { select: authorSelect }, views: { where: { viewerId: me }, select: { viewerId: true } } },
    });

    const signed = await signPaths(rows.map((s) => s.imagePath));

    const byAuthor = new Map<string, any[]>();
    const authors = new Map<string, any>();
    for (const s of rows) {
      authors.set(s.authorId, s.author);
      const list = byAuthor.get(s.authorId) ?? [];
      list.push({
        id: s.id,
        imageUrl: signed[s.imagePath] ?? null,
        caption: s.caption,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        viewedByMe: s.views.length > 0 || s.authorId === me,
      });
      byAuthor.set(s.authorId, list);
    }

    const buckets = Array.from(byAuthor.entries()).map(([authorId, stories]) => ({
      author: authors.get(authorId),
      hasUnseen: stories.some((s) => !s.viewedByMe),
      stories,
    }));

    // "Your Story" always first, then unseen-first ordering for everyone else.
    buckets.sort((a, b) => {
      if (a.author.id === me) return -1;
      if (b.author.id === me) return 1;
      return a.hasUnseen === b.hasUnseen ? 0 : a.hasUnseen ? -1 : 1;
    });

    res.json({ buckets });
  })
);

router.get(
  '/stories/:id',
  wrap(async (req, res) => {
    const me = uid(req);
    const story = await prisma.story.findUnique({
      where: { id: param(req, 'id') },
      include: { author: { select: authorSelect }, itemTags: true },
    });
    if (!story || story.expiresAt <= new Date()) return res.status(404).json({ error: 'Story not found.' });
    if (!(await canViewStory(story, me))) return res.status(404).json({ error: 'Story not found.' });

    if (story.authorId !== me) {
      await prisma.storyView.upsert({
        where: { storyId_viewerId: { storyId: story.id, viewerId: me } },
        create: { storyId: story.id, viewerId: me },
        update: {},
      });
    }

    const signed = await signPaths([story.imagePath]);
    res.json({
      story: {
        id: story.id,
        imageUrl: signed[story.imagePath] ?? null,
        caption: story.caption,
        privacy: story.privacy,
        author: story.author,
        createdAt: story.createdAt,
        expiresAt: story.expiresAt,
        itemTags: story.itemTags.map((t) => ({ id: t.id, brand: t.brand, label: t.label, x: t.x, y: t.y })),
      },
    });
  })
);

router.get(
  '/stories/:id/viewers',
  wrap(async (req, res) => {
    const me = uid(req);
    const story = await prisma.story.findFirst({ where: { id: param(req, 'id'), authorId: me } });
    if (!story) return res.status(404).json({ error: 'Story not found.' });

    const rows = await prisma.storyView.findMany({
      where: { storyId: story.id },
      orderBy: { createdAt: 'desc' },
      include: { viewer: { select: authorSelect } },
    });

    res.json({ totalViews: rows.length, viewers: rows.map((r) => ({ ...r.viewer, viewedAt: r.createdAt })) });
  })
);

router.delete(
  '/stories/:id',
  wrap(async (req, res) => {
    const me = uid(req);
    const story = await prisma.story.findFirst({ where: { id: param(req, 'id'), authorId: me } });
    if (!story) return res.status(404).json({ error: 'Story not found.' });
    await supabase.storage.from(BUCKET).remove([story.imagePath]);
    await prisma.story.delete({ where: { id: story.id } });
    res.json({ ok: true });
  })
);

export default router;