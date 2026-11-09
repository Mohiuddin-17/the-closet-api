import { randomUUID } from 'crypto';
import { Router, Response } from 'express';
import { z } from 'zod';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { prisma } from '../lib/prisma';
import { supabase } from '../lib/supabase';
import { createProfileSchema, updateProfileSchema } from '../validators/profile';
import { ALLOWED_PHOTO_TYPES, extForContentType } from '../validators/closet';

const router = Router();

// Avatars live in their own PUBLIC bucket, unlike every other photo in this
// app (garments, wardrobe covers), which use private signed URLs. Avatars get
// embedded broadly - headers, suggested-user cards, comments - and a URL that
// expires hourly would be a poor fit there.
const AVATAR_BUCKET = 'profile-avatars';

async function shapeProfile(id: string) {
  const profile = await prisma.profile.findUnique({ where: { id } });
  if (!profile) return null;
  const [postsCount, followersCount, followingCount] = await Promise.all([
    prisma.post.count({ where: { authorId: id } }),
    prisma.follow.count({ where: { followingId: id, status: 'ACCEPTED' } }),
    prisma.follow.count({ where: { followerId: id, status: 'ACCEPTED' } }),
  ]);
  return { ...profile, postsCount, followersCount, followingCount };
}

router.post('/', requireAuth, async (req: AuthedRequest, res: Response) => {
  const parseResult = createProfileSchema.safeParse(req.body);

  if (!parseResult.success) {
    return res.status(400).json({ error: 'Invalid input', details: parseResult.error.flatten() });
  }

  const existing = await prisma.profile.findUnique({ where: { id: req.userId as string } });
  if (existing) {
    return res.status(409).json({ error: 'Profile already exists for this user' });
  }

  const usernameTaken = await prisma.profile.findUnique({ where: { username: parseResult.data.username } });
  if (usernameTaken) {
    return res.status(409).json({ error: 'Username is already taken' });
  }

  const profile = await prisma.profile.create({
    data: {
      id: req.userId as string,
      username: parseResult.data.username,
      displayName: parseResult.data.displayName,
      bio: parseResult.data.bio,
    },
  });

  // A brand new profile always starts at zero; no need to query counts here.
  res.status(201).json({ ...profile, postsCount: 0, followersCount: 0, followingCount: 0 });
});

router.get('/me', requireAuth, async (req: AuthedRequest, res: Response) => {
  const shaped = await shapeProfile(req.userId as string);
  if (!shaped) return res.status(404).json({ error: 'Profile not found' });
  res.json(shaped);
});

router.patch('/me', requireAuth, async (req: AuthedRequest, res: Response) => {
  const me = req.userId as string;
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  }

  const existing = await prisma.profile.findUnique({ where: { id: me } });
  if (!existing) return res.status(404).json({ error: 'Profile not found' });

  const data = parsed.data;

  if (data.username && data.username !== existing.username) {
    const taken = await prisma.profile.findUnique({ where: { username: data.username } });
    if (taken) return res.status(409).json({ error: 'Username is already taken' });
  }

  await prisma.profile.update({
    where: { id: me },
    data: {
      username: data.username,
      displayName: data.displayName,
      bio: data.bio,
      pronouns: data.pronouns,
      website: data.website,
      photoUrl: data.photoUrl,
      isPrivate: data.isPrivate,
      defaultWardrobePrivacy: data.defaultWardrobePrivacy,
      whoCanTagMe: data.whoCanTagMe,
      requireTagApproval: data.requireTagApproval,
      whoCanMentionMe: data.whoCanMentionMe,
    },
  });

  const shaped = await shapeProfile(me);
  res.json(shaped);
});

// Deletes the caller's own account. The Profile row is removed first, which
// cascades through every table that references it (items, wardrobes, posts,
// follows, blocks - all onDelete: Cascade in schema.prisma). The Supabase
// auth user is removed separately, since Prisma has no model for Supabase's
// own auth schema.
router.delete('/me', requireAuth, async (req: AuthedRequest, res: Response) => {
  const me = req.userId as string;

  await prisma.profile.deleteMany({ where: { id: me } });

  const { error } = await supabase.auth.admin.deleteUser(me);
  if (error) {
    return res
      .status(502)
      .json({ error: 'Account data was removed, but the login itself could not be deleted: ' + error.message });
  }

  res.json({ ok: true });
});

const avatarUploadSchema = z.object({
  contentType: z.enum(ALLOWED_PHOTO_TYPES),
});

router.post('/avatar-upload-url', requireAuth, async (req: AuthedRequest, res: Response) => {
  const me = req.userId as string;
  const parsed = avatarUploadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Unsupported photo type.' });

  const ext = extForContentType(parsed.data.contentType);
  if (!ext) return res.status(400).json({ error: 'Unsupported photo type.' });

  const path = `${me}/${randomUUID()}.${ext}`;
  const { data, error } = await supabase.storage.from(AVATAR_BUCKET).createSignedUploadUrl(path);
  if (error || !data) return res.status(502).json({ error: 'Could not prepare upload.' });

  const { data: pub } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path);

  res.json({ signedUrl: data.signedUrl, publicUrl: pub.publicUrl });
});

// Public profile view for another user - basic info + counts are always
// visible (matches how private accounts behave elsewhere: you can see who
// someone is before deciding whether to follow them). Actual CONTENT
// (follower/following lists, posts) is gated separately per-endpoint, not
// here - see canViewFollowLists in routes/social.ts, reused for posts too.
router.get('/:id', requireAuth, async (req: AuthedRequest, res: Response) => {
  const me = req.userId as string;
  const targetId = String(req.params.id); // Express types this as string | string[] here; it's always a single string in practice.

  if (targetId === me) {
    return res.status(400).json({ error: 'Use GET /profiles/me for your own profile.' });
  }

  const blocked = await prisma.block.findFirst({
    where: { OR: [{ blockerId: me, blockedId: targetId }, { blockerId: targetId, blockedId: me }] },
  });
  if (blocked) return res.status(404).json({ error: 'User not found.' });

  const profile = await prisma.profile.findUnique({ where: { id: targetId } });
  if (!profile) return res.status(404).json({ error: 'User not found.' });

  const [postsCount, followersCount, followingCount, followEdge] = await Promise.all([
    prisma.post.count({ where: { authorId: targetId } }),
    prisma.follow.count({ where: { followingId: targetId, status: 'ACCEPTED' } }),
    prisma.follow.count({ where: { followerId: targetId, status: 'ACCEPTED' } }),
    prisma.follow.findUnique({ where: { followerId_followingId: { followerId: me, followingId: targetId } } }),
  ]);

  res.json({
    id: profile.id,
    username: profile.username,
    displayName: profile.displayName,
    bio: profile.bio,
    photoUrl: profile.photoUrl,
    isPrivate: profile.isPrivate,
    postsCount,
    followersCount,
    followingCount,
    isFollowing: followEdge?.status === 'ACCEPTED',
    followStatus: followEdge?.status ?? null, // 'ACCEPTED' | 'PENDING' | null
  });
});

export default router;