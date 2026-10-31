/**
 * Configuration normalization for workspace prefill snapshots.
 *
 * @module @deepseek-ai/dsh-prefill-context/config
 */

import z from '@deepseek-ai/schemastery'

/** Default extensions treated as UTF-8 text. */
const DEFAULT_INCLUDE_EXTENSIONS = [
  '.asciidoc',
  '.astro',
  '.bash',
  '.bat',
  '.c',
  '.cc',
  '.cfg',
  '.clj',
  '.cljc',
  '.cljs',
  '.cmake',
  '.cmd',
  '.conf',
  '.cpp',
  '.cs',
  '.css',
  '.csv',
  '.cxx',
  '.dart',
  '.dockerfile',
  '.editorconfig',
  '.env.example',
  '.erl',
  '.ex',
  '.exs',
  '.f',
  '.f90',
  '.fish',
  '.gitattributes',
  '.gitignore',
  '.go',
  '.gql',
  '.gradle',
  '.graphql',
  '.groovy',
  '.h',
  '.hcl',
  '.hh',
  '.hpp',
  '.hrl',
  '.htm',
  '.html',
  '.ini',
  '.java',
  '.jl',
  '.js',
  '.json',
  '.json5',
  '.jsonc',
  '.jsx',
  '.kt',
  '.kts',
  '.less',
  '.lua',
  '.m',
  '.md',
  '.mdx',
  '.mjs',
  '.mm',
  '.mts',
  '.nim',
  '.nix',
  '.php',
  '.pl',
  '.pm',
  '.properties',
  '.proto',
  '.ps1',
  '.py',
  '.pyi',
  '.r',
  '.rb',
  '.rs',
  '.rst',
  '.sass',
  '.scala',
  '.scss',
  '.sh',
  '.sql',
  '.svelte',
  '.sv',
  '.svg',
  '.swift',
  '.tf',
  '.tfvars',
  '.toml',
  '.ts',
  '.tsv',
  '.tsx',
  '.txt',
  '.v',
  '.vhdl',
  '.vue',
  '.xml',
  '.yaml',
  '.yml',
  '.zig',
  '.zsh',
] as const

/** Default extensionless filenames included when present. */
const DEFAULT_INCLUDE_FILE_NAMES = [
  'AUTHORS',
  'Brewfile',
  'CHANGELOG',
  'CMakeLists.txt',
  'CODEOWNERS',
  'CONTRIBUTING',
  'Containerfile',
  'Dockerfile',
  'Gemfile',
  'GNUmakefile',
  'Jenkinsfile',
  'Justfile',
  'LICENSE',
  'Makefile',
  'NOTICE',
  'Procfile',
  'README',
  'Rakefile',
  'Taskfile',
  'Vagrantfile',
  'go.mod',
  'go.sum',
] as const

/** Default directory names never traversed, matched case-insensitively. */
const DEFAULT_EXCLUDED_DIRECTORIES = [
  '.aws',
  '.cache',
  '.git',
  '.gradle',
  '.hg',
  '.idea',
  '.kube',
  '.mypy_cache',
  '.next',
  '.nuxt',
  '.parcel-cache',
  '.pnpm-store',
  '.pytest_cache',
  '.ruff_cache',
  '.serverless',
  '.ssh',
  '.svelte-kit',
  '.svn',
  '.terraform',
  '.turbo',
  '.venv',
  '__pycache__',
  'bin',
  'bower_components',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'obj',
  'out',
  'target',
  'vendor',
  'venv',
] as const

/** Default filenames never included, matched case-insensitively. */
const DEFAULT_EXCLUDED_FILE_NAMES = [
  '.env',
  '.env.development',
  '.env.local',
  '.env.production',
  '.env.staging',
  '.env.test',
  '.envrc',
  '.htpasswd',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'credentials.json',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
  'kubeconfig',
  'secrets.json',
  'secrets.yaml',
  'secrets.yml',
] as const

/**
 * Default gitignore-style exclusions for generated, vendored, and secret
 * files. The negated example environment file stays visible so a project can
 * document its variable names.
 */
const DEFAULT_EXCLUDED_FILE_PATTERNS = [
  '.env*',
  '!.env.example',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.lock',
  '*-lock.json',
  '*-lock.yaml',
  'npm-shrinkwrap.json',
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.generated.*',
] as const

/** How often the workspace is rescanned for content changes. */
export type PrefillRefresh = 'turn' | 'step' | 'never'

/** Where the injected message is placed relative to the step's user messages. */
export type PrefillPosition = 'before' | 'after'

/** Which sessions receive snapshots. */
export type PrefillAgentScope = 'main' | 'all'

/** Row configuration for workspace prefill snapshots. */
export interface Config {
  /** Token budget for the first snapshot; the header reserve is subtracted from it. */
  budgetTokens?: number
  /** Token budget for the updated contents appended in one later turn. */
  deltaBudgetTokens?: number
  /** Fixed characters-per-token estimate used for every budget decision. */
  charsPerToken?: number
  /** Tokens reserved for the frame header and scan notes. */
  reserveTokens?: number
  /** Largest file read into a snapshot; larger files are reported and skipped. */
  maxFileBytes?: number
  /** Largest single file included by estimated tokens; larger files are skipped. */
  maxFileTokens?: number
  /** Largest number of eligible files collected in one scan. */
  maxFiles?: number
  /** Largest number of directory entries visited in one scan. */
  maxVisitedEntries?: number
  /** Largest directory depth below the workspace root. */
  maxDepth?: number
  /** Whether a new turn rescans; `step` rescans every step, `never` injects only the first snapshot. */
  refresh?: PrefillRefresh
  /** Insert the snapshot before or after the step's claimed user messages. */
  position?: PrefillPosition
  /** Sessions that receive snapshots: only top-level agents, or every agent including subagents. */
  agents?: PrefillAgentScope
  /** List paths whose contents were not included, subject to `indexBudgetTokens`. */
  includePathIndex?: boolean
  /** Token budget for the path index, which is appended in addition to the content budget. */
  indexBudgetTokens?: number
  /** Apply the workspace's `.gitignore` files while scanning. */
  respectGitignore?: boolean
  /** Register stable guidance about reading prefill messages in the system prompt. */
  guidance?: boolean
  /** Lowercase extensions treated as text; a leading dot is added when omitted. */
  includeExtensions?: string[]
  /** Exact filenames included regardless of extension. */
  includeFileNames?: string[]
  /** Directory names never traversed, matched case-insensitively. */
  excludedDirectories?: string[]
  /** Filenames never included, matched case-insensitively, checked before the include rules. */
  excludedFileNames?: string[]
  /**
   * Gitignore-style patterns never included, matched case-insensitively against
   * workspace-relative paths. A leading `!` re-includes a path; later patterns
   * win. File contents are not inspected.
   */
  excludedFilePatterns?: string[]
}

/** Validated configuration used by scanning, reading, and rendering. */
export interface ResolvedPrefillConfig {
  budgetTokens: number
  deltaBudgetTokens: number
  charsPerToken: number
  reserveTokens: number
  maxFileBytes: number
  maxFileTokens: number
  maxFiles: number
  maxVisitedEntries: number
  maxDepth: number
  refresh: PrefillRefresh
  position: PrefillPosition
  agents: PrefillAgentScope
  includePathIndex: boolean
  indexBudgetTokens: number
  respectGitignore: boolean
  guidance: boolean
  includeExtensions: readonly string[]
  includeFileNames: ReadonlySet<string>
  excludedDirectories: ReadonlySet<string>
  excludedFileNames: ReadonlySet<string>
  excludedFilePatterns: readonly string[]
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  budgetTokens: z.number().step(1).min(0).default(150_000),
  deltaBudgetTokens: z.number().step(1).min(0).default(32_000),
  charsPerToken: z.number().min(0.1).default(4),
  reserveTokens: z.number().step(1).min(0).default(1_024),
  maxFileBytes: z.number().step(1).min(0).default(1_048_576),
  maxFileTokens: z.number().step(1).min(0).default(32_000),
  maxFiles: z.number().step(1).min(1).default(20_000),
  maxVisitedEntries: z.number().step(1).min(1).default(100_000),
  maxDepth: z.number().step(1).min(1).default(32),
  refresh: z.union(['turn', 'step', 'never'] as const).default('turn'),
  position: z.union(['before', 'after'] as const).default('after'),
  agents: z.union(['main', 'all'] as const).default('all'),
  includePathIndex: z.boolean().default(true),
  indexBudgetTokens: z.number().step(1).min(0).default(4_000),
  respectGitignore: z.boolean().default(true),
  guidance: z.boolean().default(true),
  includeExtensions: z.array(z.string()).default([...DEFAULT_INCLUDE_EXTENSIONS]),
  includeFileNames: z.array(z.string()).default([...DEFAULT_INCLUDE_FILE_NAMES]),
  excludedDirectories: z.array(z.string()).default([...DEFAULT_EXCLUDED_DIRECTORIES]),
  excludedFileNames: z.array(z.string()).default([...DEFAULT_EXCLUDED_FILE_NAMES]),
  excludedFilePatterns: z.array(z.string()).default([...DEFAULT_EXCLUDED_FILE_PATTERNS]),
})

/**
 * Fill defaults and validate every deployment-varying setting.
 * @param config - row configuration as supplied by the Loader.
 * @returns the normalized configuration.
 * @throws TypeError when a numeric setting or name list cannot be used.
 */
export function resolveConfig(config: Config): ResolvedPrefillConfig {
  return {
    budgetTokens: nonNegativeInteger(config.budgetTokens ?? 150_000, 'budgetTokens'),
    deltaBudgetTokens: nonNegativeInteger(config.deltaBudgetTokens ?? 32_000, 'deltaBudgetTokens'),
    charsPerToken: positiveNumber(config.charsPerToken ?? 4, 'charsPerToken'),
    reserveTokens: nonNegativeInteger(config.reserveTokens ?? 1_024, 'reserveTokens'),
    maxFileBytes: nonNegativeInteger(config.maxFileBytes ?? 1_048_576, 'maxFileBytes'),
    maxFileTokens: nonNegativeInteger(config.maxFileTokens ?? 32_000, 'maxFileTokens'),
    maxFiles: positiveInteger(config.maxFiles ?? 20_000, 'maxFiles'),
    maxVisitedEntries: positiveInteger(config.maxVisitedEntries ?? 100_000, 'maxVisitedEntries'),
    maxDepth: positiveInteger(config.maxDepth ?? 32, 'maxDepth'),
    refresh: oneOf(config.refresh ?? 'turn', ['turn', 'step', 'never'], 'refresh'),
    position: oneOf(config.position ?? 'after', ['before', 'after'], 'position'),
    agents: oneOf(config.agents ?? 'all', ['main', 'all'], 'agents'),
    includePathIndex: config.includePathIndex ?? true,
    indexBudgetTokens: nonNegativeInteger(config.indexBudgetTokens ?? 4_000, 'indexBudgetTokens'),
    respectGitignore: config.respectGitignore ?? true,
    guidance: config.guidance ?? true,
    includeExtensions: normalizeExtensions(config.includeExtensions ?? [...DEFAULT_INCLUDE_EXTENSIONS]),
    includeFileNames: new Set(normalizeNames(config.includeFileNames ?? [...DEFAULT_INCLUDE_FILE_NAMES], 'includeFileNames')),
    excludedDirectories: new Set(normalizeNames(
      config.excludedDirectories ?? [...DEFAULT_EXCLUDED_DIRECTORIES],
      'excludedDirectories',
    ).map(name => name.toLowerCase())),
    excludedFileNames: new Set(normalizeNames(
      config.excludedFileNames ?? [...DEFAULT_EXCLUDED_FILE_NAMES],
      'excludedFileNames',
    ).map(name => name.toLowerCase())),
    excludedFilePatterns: normalizePatterns(
      config.excludedFilePatterns ?? [...DEFAULT_EXCLUDED_FILE_PATTERNS],
    ),
  }
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`prefill-context: ${field} must be a non-negative safe integer, got ${String(value)}`)
  }
  return value
}

function positiveInteger(value: number, field: string): number {
  const integer = nonNegativeInteger(value, field)
  if (integer === 0) throw new TypeError(`prefill-context: ${field} must be greater than zero`)
  return integer
}

function positiveNumber(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`prefill-context: ${field} must be a positive finite number, got ${String(value)}`)
  }
  return value
}

function oneOf<T extends string>(value: string, allowed: readonly T[], field: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new TypeError(
      `prefill-context: ${field} must be one of ${allowed.map(entry => JSON.stringify(entry)).join(', ')}, got ${JSON.stringify(value)}`,
    )
  }
  return value as T
}

function normalizeExtensions(values: readonly string[]): readonly string[] {
  const normalized = new Set<string>()
  for (const value of values) {
    const extension = value.trim().toLowerCase()
    if (extension.length === 0) throw new TypeError('prefill-context: includeExtensions entries must not be empty')
    normalized.add(extension.startsWith('.') ? extension : `.${extension}`)
  }
  return [...normalized]
}

function normalizeNames(values: readonly string[], field: string): string[] {
  const normalized = new Set<string>()
  for (const value of values) {
    const name = value.trim()
    if (name.length === 0) throw new TypeError(`prefill-context: ${field} entries must not be empty`)
    if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      throw new TypeError(`prefill-context: ${field} entries must be single path segments, got ${JSON.stringify(value)}`)
    }
    normalized.add(name)
  }
  return [...normalized]
}

function normalizePatterns(values: readonly string[]): readonly string[] {
  const normalized = new Set<string>()
  for (const value of values) {
    const pattern = value.trim()
    if (pattern.length === 0) {
      throw new TypeError('prefill-context: excludedFilePatterns entries must not be empty')
    }
    normalized.add(pattern)
  }
  return [...normalized]
}
