import type { LibraryRoot } from "../types";
import type { LibrarySummary, ReasonBucket, WorkGroup } from "./work-groups";

export interface WorkGroupSummary extends WorkGroup {
  fileCount: number;
  matchedFiles: number;
  unmatchedFiles: number;
}

export interface LibraryFacets {
  resolutions: string[];
  codecs: string[];
  genres: string[];
  years: number[];
}

export interface LibraryOverview {
  roots: LibraryRoot[];
  summary: LibrarySummary;
  unmatchedReport: ReasonBucket[];
}

export interface LibraryWorksPage {
  root: LibraryRoot;
  works: WorkGroupSummary[];
  total: number;
  page: number;
  pageSize: number;
  summary: LibrarySummary;
  facets: LibraryFacets;
  unmatchedReport: ReasonBucket[];
}
