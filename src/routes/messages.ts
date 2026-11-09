import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { supabase } from '../lib/supabase';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { notify } from '../lib/notify';

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
const authorSelect = { id: true, username: true, displayName: true, photoUrl: true };
const NEED_PROFILE = { error: 'Set up your profile first.', code: 'PROFILE_REQUIRED' };

async function hasProfile(id: string) {
  const p = await prisma.profile.findUnique({ where: { id }, select: { id: true } });
  return !!p;
}

async function isBlockedEitherWay(a: string, b: string): Promise<boolean> {
  const row = await prisma.block.findFirst({
    where: { OR: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] },
  });
  return !!row;
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

/** The other participant's row - used to compute unread counts and "Seen". */
async function otherParticipant(conversationId: string, me: string) {
  return prisma.conversationParticipant.findFirst({
    where: { conversationId, userId: { not: me } },
  });
}

async function shapeConversation(c: any, me: string) {
  const other = c.participants.find((p: any) => p.userId !== me);
  const myRow = c.participants.find((p: any) => p.userId === me);
  const lastMessage = c.messages[0] ?? null;

  const unreadCount = await prisma.message.count({
    where: {
      conversationId: c.id,
      senderId: { not: me },
      createdAt: myRow?.lastReadAt ? { gt: myRow.lastReadAt } : undefined,
    },
  });

  const paths = lastMessage?.imagePath ? [lastMessage.imagePath] : [];
  const signed = await signPaths(paths);

  return {
    id: c.id,
    otherUser: other?.user,
    status: myRow?.status,
    lastMessageAt: c.lastMessageAt,
    unreadCount,
    lastMessage: lastMessage
      ? {
          id: lastMessage.id,
          body: lastMessage.body,
          imageUrl: lastMessage.imagePath ? signed[lastMessage.imagePath] ?? null : null,
          senderId: lastMessage.senderId,
          createdAt: lastMessage.createdAt,
        }
      : null,
  };
}

const conversationInclude = {
  participants: { include: { user: { select: authorSelect } } },
  messages: { orderBy: { createdAt: 'desc' as const }, take: 1 },
};

// ---------- List conversations: Primary (ACCEPTED) or Requests (PENDING) ----------
router.get(
  '/conversations',
  wrap(async (req, res) => {
    const me = uid(req);
    const type = req.query.type === 'requests' ? 'PENDING' : 'ACCEPTED';

    const rows = await prisma.conversation.findMany({
      where: { participants: { some: { userId: me, status: type } } },
      orderBy: { lastMessageAt: 'desc' },
      include: conversationInclude,
      take: 100,
    });

    const conversations = await Promise.all(rows.map((c) => shapeConversation(c, me)));
    res.json({ conversations });
  })
);

router.get(
  '/conversations/requests/count',
  wrap(async (req, res) => {
    const me = uid(req);
    const count = await prisma.conversationParticipant.count({ where: { userId: me, status: 'PENDING' } });
    res.json({ count });
  })
);

// ---------- Start (or reopen) a conversation with someone ----------
const startSchema = z.object({ userId: z.string().uuid() });

router.post(
  '/conversations',
  wrap(async (req, res) => {
    const me = uid(req);
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request.' });
    const target = parsed.data.userId;

    if (target === me) return res.status(400).json({ error: 'You cannot message yourself.' });
    if (!(await hasProfile(me))) return res.status(409).json(NEED_PROFILE);

    const targetProfile = await prisma.profile.findUnique({ where: { id: target }, select: { id: true } });
    if (!targetProfile) return res.status(404).json({ error: 'User not found.' });

    if (await isBlockedEitherWay(me, target)) {
      return res.status(403).json({ error: 'You cannot message this account.' });
    }

    // Reuse the existing conversation between this exact pair, if one exists.
    const existing = await prisma.conversation.findFirst({
      where: {
        participants: { some: { userId: me } },
        AND: { participants: { some: { userId: target } } },
      },
      select: { id: true },
    });

    if (existing) {
      return res.json({ conversationId: existing.id });
    }

    const follow = await prisma.follow.findUnique({
      where: { followerId_followingId: { followerId: target, followingId: me } },
    });
    // The recipient's row starts PENDING UNLESS they already follow the
    // sender back - a request from someone who follows you lands straight
    // in Primary, matching how most DM apps treat mutual-interest senders.
    // TODO confirm this exact rule with the client; a simpler "always PENDING
    // for a first message" is an easy one-line change if preferred.
    const recipientStartsAccepted = follow?.status === 'ACCEPTED';

    const created = await prisma.conversation.create({
      data: {
        participants: {
          create: [
            { userId: me, status: 'ACCEPTED' },
            { userId: target, status: recipientStartsAccepted ? 'ACCEPTED' : 'PENDING' },
          ],
        },
      },
    });

    await notify({ recipientId: target, actorId: me, type: 'MESSAGE_REQUEST', conversationId: created.id });

    res.status(201).json({ conversationId: created.id });
  })
);

// Both participants' status/lastReadAt - used by the client to render the
// "Seen" indicator on first load, before any Realtime event has arrived.
router.get(
  '/conversations/:id/participants',
  wrap(async (req, res) => {
    const me = uid(req);
    const conversationId = param(req, 'id');
    const rows = await prisma.conversationParticipant.findMany({ where: { conversationId } });
    if (!rows.some((r) => r.userId === me)) return res.status(404).json({ error: 'Conversation not found.' });

    res.json({
      participants: rows.map((r) => ({ userId: r.userId, status: r.status, lastReadAt: r.lastReadAt })),
    });
  })
);

// ---------- Messages within a conversation ----------
async function requireMembership(conversationId: string, me: string) {
  return prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId: me } },
  });
}

router.get(
  '/conversations/:id/messages',
  wrap(async (req, res) => {
    const me = uid(req);
    const conversationId = param(req, 'id');
    const membership = await requireMembership(conversationId, me);
    if (!membership) return res.status(404).json({ error: 'Conversation not found.' });

    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const limit = 30;

    const rows = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const paths = page.map((m) => m.imagePath).filter(Boolean) as string[];
    const signed = await signPaths(paths);

    res.json({
      messages: page.map((m) => ({
        id: m.id,
        conversationId: m.conversationId,
        senderId: m.senderId,
        body: m.body,
        imageUrl: m.imagePath ? signed[m.imagePath] ?? null : null,
        createdAt: m.createdAt,
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    });
  })
);

const sendMessageSchema = z
  .object({
    body: z.string().trim().max(2000).optional(),
    imagePath: z.string().trim().optional(),
  })
  .refine((d) => !!d.body || !!d.imagePath, { message: 'A message needs text or a photo.' });

router.post(
  '/conversations/:id/messages',
  wrap(async (req, res) => {
    const me = uid(req);
    const conversationId = param(req, 'id');
    const parsed = sendMessageSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid message.' });
    if (!(await hasProfile(me))) return res.status(409).json(NEED_PROFILE);

    const membership = await requireMembership(conversationId, me);
    if (!membership) return res.status(404).json({ error: 'Conversation not found.' });
    if (membership.status !== 'ACCEPTED') {
      // Sending a message - whether you were PENDING (someone's first message
      // to you, now you're replying) or DECLINED (you declined, now changed
      // your mind) - counts as accepting your own side of the thread.
      await prisma.conversationParticipant.update({
        where: { conversationId_userId: { conversationId, userId: me } },
        data: { status: 'ACCEPTED' },
      });
    }

    const other = await otherParticipant(conversationId, me);
    if (other && (await isBlockedEitherWay(me, other.userId))) {
      return res.status(403).json({ error: 'You cannot message this account.' });
    }

    if (parsed.data.imagePath && !parsed.data.imagePath.startsWith(`${me}/`)) {
      return res.status(400).json({ error: 'Invalid photo reference.' });
    }

    const [message] = await prisma.$transaction([
      prisma.message.create({
        data: {
          conversationId,
          senderId: me,
          body: parsed.data.body,
          imagePath: parsed.data.imagePath,
        },
      }),
      prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } }),
      // A new message into a DECLINED thread reopens the OTHER side as a fresh request too.
      ...(other?.status === 'DECLINED'
        ? [
            prisma.conversationParticipant.update({
              where: { conversationId_userId: { conversationId, userId: other.userId } },
              data: { status: 'PENDING' },
            }),
          ]
        : []),
    ]);

    const signed = parsed.data.imagePath ? await signPaths([parsed.data.imagePath]) : {};
    res.status(201).json({
      message: {
        id: message.id,
        conversationId: message.conversationId,
        senderId: message.senderId,
        body: message.body,
        imageUrl: message.imagePath ? signed[message.imagePath] ?? null : null,
        createdAt: message.createdAt,
      },
    });
  })
);

// ---------- Accept / decline a request ----------
router.post(
  '/conversations/:id/accept',
  wrap(async (req, res) => {
    const result = await prisma.conversationParticipant.updateMany({
      where: { conversationId: param(req, 'id'), userId: uid(req), status: 'PENDING' },
      data: { status: 'ACCEPTED' },
    });
    if (result.count === 0) return res.status(404).json({ error: 'Request not found.' });
    res.json({ ok: true });
  })
);

router.post(
  '/conversations/:id/decline',
  wrap(async (req, res) => {
    const result = await prisma.conversationParticipant.updateMany({
      where: { conversationId: param(req, 'id'), userId: uid(req), status: 'PENDING' },
      data: { status: 'DECLINED' },
    });
    if (result.count === 0) return res.status(404).json({ error: 'Request not found.' });
    res.json({ ok: true });
  })
);

// ---------- Mark read ("Seen" for the other person) ----------
router.post(
  '/conversations/:id/read',
  wrap(async (req, res) => {
    const me = uid(req);
    const conversationId = param(req, 'id');
    const membership = await requireMembership(conversationId, me);
    if (!membership) return res.status(404).json({ error: 'Conversation not found.' });

    await prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId, userId: me } },
      data: { lastReadAt: new Date() },
    });
    res.json({ ok: true });
  })
);

export default router;