import { z } from 'zod';

export const MAX_ITEMS_PER_WARDROBE = 50; // TODO confirm with client
export const WARDROBE_PRIVACY = ['EVERYONE', 'FOLLOWERS', 'SELECTED', 'ONLY_ME'] as const;

const baseWardrobeFields = {
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(250).optional(),
  occasionId: z.string().uuid().nullable().optional(),
  coverPhotoPath: z.string().trim().min(1).optional(),
  selectedUserIds: z.array(z.string().uuid()).optional(),
};

export const createWardrobeSchema = z
  .object({
    ...baseWardrobeFields,
    privacy: z.enum(WARDROBE_PRIVACY).default('FOLLOWERS'),
    itemIds: z.array(z.string().uuid()).min(1).max(MAX_ITEMS_PER_WARDROBE),
  })
  .superRefine((data, ctx) => {
    if (data.privacy === 'SELECTED' && (!data.selectedUserIds || data.selectedUserIds.length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Choose at least one person.', path: ['selectedUserIds'] });
    }
  });

export const updateWardrobeSchema = z
  .object({
    ...baseWardrobeFields,
    privacy: z.enum(WARDROBE_PRIVACY).optional(),
    itemIds: z.array(z.string().uuid()).min(1).max(MAX_ITEMS_PER_WARDROBE).optional(),
    status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.privacy === 'SELECTED' && data.selectedUserIds && data.selectedUserIds.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Choose at least one person.', path: ['selectedUserIds'] });
    }
  });

export const createOccasionSchema = z.object({
  name: z.string().trim().min(1).max(40),
});