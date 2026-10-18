import { z } from "zod";

export const MediaTypeSchema = z.enum(["movie", "tv"]);
export const RootMediaTypeSchema = z.enum(["movie", "tv", "mixed"]);

export type MediaType = z.infer<typeof MediaTypeSchema>;
export type RootMediaType = z.infer<typeof RootMediaTypeSchema>;
