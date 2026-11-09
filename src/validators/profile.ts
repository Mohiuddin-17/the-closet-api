import { z } from 'zod';

const usernamePattern = /^[a-zA-Z0-9_.]+$/;
const visibilityEnum = z.enum(['EVERYONE', 'FOLLOWERS', 'SELECTED', 'ONLY_ME']);
const tagAudienceEnum = z.enum(['EVERYONE', 'FOLLOWING', 'NO_ONE']);

export const createProfileSchema = z.object({
  username: z.string().min(3).max(30).regex(usernamePattern, 'Only letters, numbers, underscores, and periods allowed'),
  displayName: z.string().min(1).max(50).optional(),
  bio: z.string().max(300).optional(),
});

export const updateProfileSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(30)
    .regex(usernamePattern, 'Only letters, numbers, underscores, and periods allowed')
    .optional(),
  displayName: z.string().min(1).max(50).nullable().optional(),
  bio: z.string().max(300).nullable().optional(),
  pronouns: z.string().max(30).nullable().optional(),
  // Permissive on purpose: the design's example ("sortech.com/elena.fit") has
  // no protocol. TODO confirm with client whether this should be validated as
  // a strict URL later.
  website: z.string().trim().max(200).nullable().optional(),
  photoUrl: z.string().url().nullable().optional(),
  isPrivate: z.boolean().optional(),
  // Pre-fills the Publish screen's privacy choice for new wardrobes only -
  // each wardrobe's own privacy field is what's actually enforced.
  defaultWardrobePrivacy: visibilityEnum.optional(),
  whoCanTagMe: tagAudienceEnum.optional(),
  requireTagApproval: z.boolean().optional(),
  whoCanMentionMe: tagAudienceEnum.optional(),
});