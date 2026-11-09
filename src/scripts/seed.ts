import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const creators = [
  { id: 'a1b2c3d4-0001-4000-8000-000000000001', username: 'elena_rostova', displayName: 'Elena Rostova', bio: 'Stylist - Paris', photoUrl: 'https://i.pravatar.cc/150?img=47' },
  { id: 'a1b2c3d4-0002-4000-8000-000000000002', username: 'amara_okafor', displayName: 'Amara Okafor', bio: 'Tailor and tastemaker - Lagos', photoUrl: 'https://i.pravatar.cc/150?img=32' },
  { id: 'a1b2c3d4-0003-4000-8000-000000000003', username: 'lucas_meyer', displayName: 'Lucas Meyer', bio: 'Menswear editor - Berlin', photoUrl: 'https://i.pravatar.cc/150?img=12' },
  { id: 'a1b2c3d4-0004-4000-8000-000000000004', username: 'sana_malik', displayName: 'Sana Malik', bio: 'Vintage collector - Karachi', photoUrl: 'https://i.pravatar.cc/150?img=44' },
];

// Real stock photos of anonymous models, verified working and free to use
// under the Unsplash License - not photos of any named public figure, which
// is never usable here regardless of context. LoremFlickr (category-filtered
// placeholders) has shut down; Picsum has no way to filter by subject, which
// is why earlier attempts returned random scenery.
const WOMAN_PORTRAIT = 'https://images.unsplash.com/photo-1622738010740-4b8e34702474?w=800&h=1000&fit=crop&q=80';
const WOMAN_DRESS = 'https://images.unsplash.com/photo-1722548388475-58539487e863?w=800&h=1000&fit=crop&q=80';
const MAN_JACKET = 'https://images.unsplash.com/photo-1496088941920-f7d451d95bf4?w=800&h=1000&fit=crop&q=80';

const posts = [
  { id: 'b1b2c3d4-0001-4000-8000-000000000001', author: 0, imageUrl: WOMAN_PORTRAIT, caption: 'Structured blazer, soft denim. Paris mornings. #styling #parisfashion', tags: [{ brand: 'Saint Laurent', label: 'Blazer', x: 0.5, y: 0.32 }] },
  { id: 'b1b2c3d4-0002-4000-8000-000000000002', author: 0, imageUrl: WOMAN_DRESS, caption: 'Weekend capsule: three pieces, five looks. #capsulewardrobe', tags: [{ brand: 'Prada', label: 'Knit top', x: 0.42, y: 0.4 }, { brand: 'Levi\'s', label: '501 jeans', x: 0.5, y: 0.75 }] },
  { id: 'b1b2c3d4-0003-4000-8000-000000000003', author: 1, imageUrl: WOMAN_DRESS, caption: 'Hand-tailored agbada, finished this week. #tailoring #handmade', tags: [] },
  { id: 'b1b2c3d4-0004-4000-8000-000000000004', author: 1, imageUrl: WOMAN_PORTRAIT, caption: 'Colour study: cobalt and cream. #colour #ootd', tags: [{ brand: 'Gucci', label: 'Silk scarf', x: 0.6, y: 0.25 }] },
  { id: 'b1b2c3d4-0005-4000-8000-000000000005', author: 2, imageUrl: MAN_JACKET, caption: 'Autumn layers. Wool, leather, one good boot. #menswear', tags: [{ brand: 'Louis Vuitton', label: 'Leather jacket', x: 0.48, y: 0.38 }] },
  { id: 'b1b2c3d4-0006-4000-8000-000000000006', author: 3, imageUrl: WOMAN_PORTRAIT, caption: 'Found this 1970s embroidered shawl at a flea market. #vintage #thrifted', tags: [] },
];

const comments = [
  { id: 'c1b2c3d4-0001-4000-8000-000000000001', post: 0, author: 1, body: 'The proportions here are perfect.', parent: null as number | null },
  { id: 'c1b2c3d4-0002-4000-8000-000000000002', post: 0, author: 2, body: 'Need this exact look for spring.', parent: null as number | null },
  { id: 'c1b2c3d4-0003-4000-8000-000000000003', post: 0, author: 0, body: 'Thank you! The blazer is vintage.', parent: 0 },
];

async function main() {
  if (process.argv.includes('--clean')) {
    const res = await prisma.profile.deleteMany({ where: { id: { in: creators.map((c) => c.id) } } });
    console.log('Removed ' + res.count + ' demo creators (their posts and comments go with them).');
    return;
  }

  for (const c of creators) {
    await prisma.profile.upsert({ where: { id: c.id }, update: {}, create: { ...c } });
  }

  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    await prisma.post.upsert({
      where: { id: p.id },
      update: {},
      create: {
        id: p.id,
        authorId: creators[p.author].id,
        imageUrl: p.imageUrl,
        caption: p.caption,
        createdAt: new Date(Date.now() - i * 5 * 3600000),
        itemTags: { create: p.tags },
      },
    });
  }

  for (let i = 0; i < comments.length; i++) {
    const c = comments[i];
    await prisma.comment.upsert({
      where: { id: c.id },
      update: {},
      create: {
        id: c.id,
        postId: posts[c.post].id,
        authorId: creators[c.author].id,
        parentId: c.parent === null ? null : comments[c.parent].id,
        body: c.body,
        createdAt: new Date(Date.now() - (comments.length - i) * 20 * 60000),
      },
    });
  }

  console.log('Seeded ' + creators.length + ' demo creators, ' + posts.length + ' posts, ' + comments.length + ' comments.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());