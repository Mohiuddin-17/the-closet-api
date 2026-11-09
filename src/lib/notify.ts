import { prisma } from './prisma';

export type NotificationType =
  | 'LIKE'
  | 'COMMENT'
  | 'FOLLOW_REQUEST' // recipient = the person being followed, status PENDING (private account)
  | 'FOLLOW_ACCEPTED' // recipient = the follower, their pending request was accepted
  | 'NEW_FOLLOWER' // recipient = the person being followed, status ACCEPTED immediately (public account)
  | 'MESSAGE_REQUEST'
  | 'MENTION'
  | 'TAG';

/** Creates a notification row. Never notifies someone about their own
 * action, and never throws - a failed notification shouldn't break the
 * action that triggered it (a like still counts even if this write fails). */
export async function notify(params: {
  recipientId: string;
  actorId?: string;
  type: NotificationType;
  postId?: string;
  commentId?: string;
  conversationId?: string;
}) {
  if (params.actorId && params.actorId === params.recipientId) return;
  try {
    await prisma.notification.create({ data: params });
  } catch (e) {
    console.error('notify failed', e);
  }
}