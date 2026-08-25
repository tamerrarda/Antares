import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
import { z } from "astro:content";

// `deck` is this site's own field: the one-line statement of a page's claim that
// sits under every title. Starlight has `description` (which goes in the head and
// nowhere else), so the deck is carried separately and rendered by the PageTitle
// override in `src/components/`.
export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: z.object({
        deck: z.string().optional(),
      }),
    }),
  }),
};
