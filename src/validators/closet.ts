import { z } from 'zod';

export const ALLOWED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;
export const MAX_PHOTOS_PER_ITEM = 5; // TODO confirm with client
export const ANGLE_LABELS = ['front', 'side45', 'back', 'details'] as const;

const EXT_BY_TYPE: Record<(typeof ALLOWED_PHOTO_TYPES)[number], string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

export function extForContentType(contentType: string): string | null {
  return (EXT_BY_TYPE as Record<string, string>)[contentType] ?? null;
}

export const uploadUrlSchema = z.object({
  contentType: z.enum(ALLOWED_PHOTO_TYPES),
  // 'items' (default), 'wardrobes', 'posts', 'stories' or 'messages' - only
  // changes the storage path prefix, same private bucket either way.
  kind: z.enum(['items', 'wardrobes', 'posts', 'stories', 'messages']).optional(),
});

export const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(40),
});

const photoRefSchema = z.object({
  path: z.string().trim().min(1),
  angleLabel: z.enum(ANGLE_LABELS).optional(),
});

export const createItemSchema = z.object({
  categoryId: z.string().uuid(),
  careInstructions: z.string().trim().max(500).optional(),
  purchasePrice: z.number().min(0).max(1_000_000).optional(),
  isFavorite: z.boolean().optional(),
  photos: z.array(photoRefSchema).min(1).max(MAX_PHOTOS_PER_ITEM),
});

export const updateItemSchema = z.object({
  categoryId: z.string().uuid().optional(),
  careInstructions: z.string().trim().max(500).nullable().optional(),
  purchasePrice: z.number().min(0).max(1_000_000).nullable().optional(),
  isFavorite: z.boolean().optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
});

export const addPhotosSchema = z.object({
  photos: z.array(photoRefSchema).min(1).max(MAX_PHOTOS_PER_ITEM),
});