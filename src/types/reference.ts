import { z } from 'zod';

// --- Version API Surface Reference Schema ---
// These reference files serve as ground truth for both automated AST checks
// and as context provided to the LLM judge. They list valid APIs, unavailable APIs,
// and version-specific behaviors for each library version.

export const LibraryNameSchema = z.enum(['next', 'react', 'ai', 'trpc', 'zod']);

/**
 * Schema for Version API Surface reference JSON files.
 * Flexible enough to accommodate different library types while maintaining
 * a consistent core structure.
 */
export const VersionApiSurfaceSchema = z.object({
  /** Library identifier */
  library: LibraryNameSchema,

  /** Major version string (e.g., "13", "16", "3", "4") */
  version: z.string(),

  /** APIs that are synchronous in this version */
  sync_apis: z.array(z.string()).default([]),

  /** APIs that are async (require await) in this version */
  async_apis: z.array(z.string()).default([]),

  /** How params are accessed: "direct" (sync object) or "promise" (async) */
  params_type: z.enum(['direct', 'promise', 'n/a']).optional(),

  /** Proxy/middleware file name (Next.js specific) */
  proxy_file: z.string().optional(),

  /** Proxy/middleware function name (Next.js specific) */
  proxy_function: z.string().optional(),

  /**
   * Available imports organized by module path.
   * Maps import path -> array of available export names.
   * Use ["*"] to indicate all exports are available.
   */
  available_imports: z.record(z.string(), z.array(z.string())).default({}),

  /** APIs that are NOT available in this version */
  unavailable_apis: z.array(z.string()).default([]),

  /**
   * APIs that were available in the previous version but removed/renamed in this one.
   * Useful for understanding migration breaking changes.
   */
  removed_from_previous: z.array(z.string()).default([]),

  /** Available hooks (React-specific) */
  available_hooks: z.array(z.string()).default([]),

  /** Hooks NOT available in this version (React-specific) */
  unavailable_hooks: z.array(z.string()).default([]),

  /** Available types/interfaces exported by the library */
  available_types: z.array(z.string()).default([]),

  /** Types NOT available in this version */
  unavailable_types: z.array(z.string()).default([]),

  /** Rendering API details (React-specific) */
  rendering: z
    .object({
      /** Entry point API (e.g., "ReactDOM.render", "createRoot") */
      entry_api: z.string(),
      /** Import path for the entry API */
      import_path: z.string(),
      /** Deprecated rendering APIs */
      deprecated: z.array(z.string()).default([]),
    })
    .optional(),

  /** Caching behavior defaults (Next.js-specific) */
  caching_defaults: z.record(z.string(), z.string()).optional(),

  /** Required files for certain features (Next.js-specific) */
  required_files: z.record(z.string(), z.string()).optional(),

  /** Key features introduced or changed in this version */
  key_features: z.array(z.string()).default([]),

  /** Breaking changes from the previous version */
  breaking_changes: z.array(z.string()).default([]),

  /** Additional notes about version-specific behavior */
  notes: z.array(z.string()).default([]),
});

export type VersionApiSurface = z.infer<typeof VersionApiSurfaceSchema>;
