// Ported from Restyle commit dfab2fea903923e4a19171cc4a2eb4cf4144d8ae
// (src/lib/reference-preprocess.ts) with a refactored boundary: the module only
// accepts in-memory bytes uploaded to the server. It NEVER fetches URLs or
// data URLs — that would reintroduce the SSRF surface the original had.
//
// `source` is renamed to `id` (the style_references row id / upload id) in stats.

export type ReferenceAssetFormat =
  | 'transparent_sticker'
  | 'isolated_asset'
  | 'full_scene'
  | 'unknown';

export type ReferenceArtifactRisk = 'low' | 'medium' | 'high' | 'unknown';
export type PixelArtAmbiguity = 'clear_pixel_art' | 'likely_low_res_artifact' | 'ambiguous' | 'unknown';
export type ReferenceOutputQualityTarget =
  | 'clean_high_resolution_reconstruction'
  | 'preserve_intentional_pixel_art'
  | 'preserve_source_texture';

export interface ReferenceArtifactPolicy {
  preserve_resolution_artifacts: boolean;
  preserve_pixelation: boolean;
  preserve_aliasing: boolean;
  preserve_compression_artifacts: boolean;
  output_quality_target: ReferenceOutputQualityTarget;
}

export interface ReferenceQualityReport {
  megapixels: number | null;
  is_low_resolution: boolean;
  is_tiny_icon_source: boolean;
  aliasing_risk: ReferenceArtifactRisk;
  pixel_grid_risk: ReferenceArtifactRisk;
  compression_artifact_risk: ReferenceArtifactRisk;
  upscaled_source_risk: ReferenceArtifactRisk;
  likely_artifacts: string[];
  pixel_art_vs_low_res_icon: PixelArtAmbiguity;
  recommended_policy: ReferenceArtifactPolicy;
}

export interface ReferenceQualitySummary {
  hasLowResolutionReferences: boolean;
  lowResolutionCount: number;
  tinyIconSourceCount: number;
  pixelArtAmbiguity: PixelArtAmbiguity;
  likelyArtifacts: string[];
  recommendedPolicy: ReferenceArtifactPolicy;
  warnings: string[];
}

export interface ReferencePreprocessStats {
  id: string;
  ok: boolean;
  mimeType: string | null;
  byteLength: number | null;
  width: number | null;
  height: number | null;
  hasAlpha: boolean | null;
  transparentRatio: number | null;
  dominantColors: string[];
  assetFormat: ReferenceAssetFormat;
  quality: ReferenceQualityReport;
  warnings: string[];
}

export interface ReferencePreprocessSummary {
  total: number;
  ok: number;
  failed: number;
  hasAnyAlpha: boolean;
  dominantAssetFormat: ReferenceAssetFormat;
  dominantColors: string[];
  qualityReport: ReferenceQualitySummary;
  stats: ReferencePreprocessStats[];
  warnings: string[];
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8]);

const CLEAN_RECONSTRUCTION_POLICY: ReferenceArtifactPolicy = {
  preserve_resolution_artifacts: false,
  preserve_pixelation: false,
  preserve_aliasing: false,
  preserve_compression_artifacts: false,
  output_quality_target: 'clean_high_resolution_reconstruction',
};

const PRESERVE_PIXEL_ART_POLICY: ReferenceArtifactPolicy = {
  preserve_resolution_artifacts: true,
  preserve_pixelation: true,
  preserve_aliasing: true,
  preserve_compression_artifacts: false,
  output_quality_target: 'preserve_intentional_pixel_art',
};

function isPng(buffer: Buffer): boolean {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
}

function isJpeg(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer.subarray(0, 2).equals(JPEG_SIGNATURE);
}

function parsePngMetadata(buffer: Buffer): Pick<ReferencePreprocessStats, 'width' | 'height' | 'hasAlpha' | 'transparentRatio' | 'dominantColors'> & { warnings: string[] } {
  const warnings: string[] = [];
  if (!isPng(buffer) || buffer.length < 33) {
    return { width: null, height: null, hasAlpha: null, transparentRatio: null, dominantColors: [], warnings };
  }

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const colorType = buffer[25];
  const hasAlphaByColorType = colorType === 4 || colorType === 6;
  let hasTransparencyChunk = false;
  const paletteColors: string[] = [];

  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) break;

    if (type === 'tRNS') hasTransparencyChunk = true;
    if (type === 'PLTE') {
      for (let i = dataStart; i + 2 < dataEnd && paletteColors.length < 8; i += 3) {
        const r = buffer[i].toString(16).padStart(2, '0');
        const g = buffer[i + 1].toString(16).padStart(2, '0');
        const b = buffer[i + 2].toString(16).padStart(2, '0');
        paletteColors.push(`#${r}${g}${b}`.toUpperCase());
      }
    }
    if (type === 'IEND') break;
    offset = dataEnd + 4;
  }

  if (hasAlphaByColorType || hasTransparencyChunk) {
    warnings.push('PNG contains alpha/transparency; flatten to off-white for visual analysis and preserve transparent background policy.');
  }

  return {
    width,
    height,
    hasAlpha: hasAlphaByColorType || hasTransparencyChunk,
    // Without decoding IDAT we cannot compute a true transparent pixel ratio safely.
    transparentRatio: null,
    dominantColors: Array.from(new Set(paletteColors)),
    warnings,
  };
}

function parseJpegDimensions(buffer: Buffer): Pick<ReferencePreprocessStats, 'width' | 'height'> {
  if (!isJpeg(buffer)) return { width: null, height: null };
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof && offset + 8 < buffer.length) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    if (!length || length < 2) break;
    offset += 2 + length;
  }
  return { width: null, height: null };
}

function inferAssetFormat(stats: Pick<ReferencePreprocessStats, 'hasAlpha' | 'width' | 'height'>): ReferenceAssetFormat {
  if (stats.hasAlpha) return 'transparent_sticker';
  if (stats.width && stats.height) {
    const ratio = stats.width / stats.height;
    if (ratio > 0.75 && ratio < 1.35) return 'isolated_asset';
  }
  return 'unknown';
}

function riskFromDimension(width: number | null, height: number | null, byteLength: number | null): ReferenceQualityReport {
  const megapixels = width && height ? Number(((width * height) / 1_000_000).toFixed(4)) : null;
  const minSide = width && height ? Math.min(width, height) : null;
  const maxSide = width && height ? Math.max(width, height) : null;
  const isTinyIconSource = Boolean(minSide && maxSide && minSide <= 96 && maxSide <= 256);
  const isLowResolution = Boolean(
    (minSide && minSide <= 160) ||
    (maxSide && maxSide <= 256) ||
    (megapixels !== null && megapixels <= 0.08),
  );
  const likelyArtifacts: string[] = [];
  if (isLowResolution) likelyArtifacts.push('low-resolution source detail limit');
  if (isTinyIconSource) likelyArtifacts.push('tiny icon source; style may be confused with pixel art');
  if (byteLength && byteLength < 6_000) likelyArtifacts.push('very small file size; possible compression or quantization artifacts');

  const aliasingRisk: ReferenceArtifactRisk = isTinyIconSource ? 'high' : isLowResolution ? 'medium' : 'low';
  const pixelGridRisk: ReferenceArtifactRisk = isTinyIconSource ? 'high' : isLowResolution ? 'medium' : 'low';
  const compressionRisk: ReferenceArtifactRisk = byteLength && byteLength < 6_000 ? 'medium' : 'low';
  const upscaledRisk: ReferenceArtifactRisk = isLowResolution ? 'medium' : 'low';
  const ambiguity: PixelArtAmbiguity = isTinyIconSource
    ? 'ambiguous'
    : isLowResolution
      ? 'likely_low_res_artifact'
      : 'unknown';

  return {
    megapixels,
    is_low_resolution: isLowResolution,
    is_tiny_icon_source: isTinyIconSource,
    aliasing_risk: aliasingRisk,
    pixel_grid_risk: pixelGridRisk,
    compression_artifact_risk: compressionRisk,
    upscaled_source_risk: upscaledRisk,
    likely_artifacts: likelyArtifacts,
    pixel_art_vs_low_res_icon: ambiguity,
    recommended_policy: isLowResolution ? CLEAN_RECONSTRUCTION_POLICY : {
      preserve_resolution_artifacts: false,
      preserve_pixelation: false,
      preserve_aliasing: false,
      preserve_compression_artifacts: false,
      output_quality_target: 'preserve_source_texture',
    },
  };
}

function mergeColors(items: ReferencePreprocessStats[]): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    for (const color of item.dominantColors) {
      if (!seen.has(color)) seen.add(color);
      if (seen.size >= 12) return Array.from(seen);
    }
  }
  return Array.from(seen);
}

function dominantFormat(items: ReferencePreprocessStats[]): ReferenceAssetFormat {
  const counts: Record<ReferenceAssetFormat, number> = {
    transparent_sticker: 0,
    isolated_asset: 0,
    full_scene: 0,
    unknown: 0,
  };
  for (const item of items) counts[item.assetFormat] += 1;
  return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] as ReferenceAssetFormat) || 'unknown';
}

function summarizeQuality(items: ReferencePreprocessStats[]): ReferenceQualitySummary {
  const lowResolutionCount = items.filter((item) => item.quality.is_low_resolution).length;
  const tinyIconSourceCount = items.filter((item) => item.quality.is_tiny_icon_source).length;
  const likelyArtifacts = Array.from(new Set(items.flatMap((item) => item.quality.likely_artifacts))).slice(0, 12);
  const pixelArtAmbiguity: PixelArtAmbiguity = tinyIconSourceCount > 0
    ? 'ambiguous'
    : lowResolutionCount > 0
      ? 'likely_low_res_artifact'
      : 'unknown';
  const hasLowResolutionReferences = lowResolutionCount > 0;
  const warnings = hasLowResolutionReferences
    ? [
      'One or more references are low-resolution. Treat pixelation, jagged edges, blur, compression, and checkerboard previews as source artifacts unless the user confirms they are intentional style traits.',
    ]
    : [];

  return {
    hasLowResolutionReferences,
    lowResolutionCount,
    tinyIconSourceCount,
    pixelArtAmbiguity,
    likelyArtifacts,
    recommendedPolicy: hasLowResolutionReferences ? CLEAN_RECONSTRUCTION_POLICY : {
      preserve_resolution_artifacts: false,
      preserve_pixelation: false,
      preserve_aliasing: false,
      preserve_compression_artifacts: false,
      output_quality_target: 'preserve_source_texture',
    },
    warnings,
  };
}

const UNKNOWN_QUALITY: ReferenceQualityReport = {
  megapixels: null,
  is_low_resolution: false,
  is_tiny_icon_source: false,
  aliasing_risk: 'unknown',
  pixel_grid_risk: 'unknown',
  compression_artifact_risk: 'unknown',
  upscaled_source_risk: 'unknown',
  likely_artifacts: [],
  pixel_art_vs_low_res_icon: 'unknown',
  recommended_policy: {
    preserve_resolution_artifacts: false,
    preserve_pixelation: false,
    preserve_aliasing: false,
    preserve_compression_artifacts: false,
    output_quality_target: 'preserve_source_texture',
  },
};

export async function preprocessReferenceImage(reference: { id: string; buffer: Buffer; mimeType: string }): Promise<ReferencePreprocessStats> {
  const { id, buffer, mimeType } = reference;
  try {
    const normalizedMime = mimeType?.split(';')[0]?.trim() || (isPng(buffer) ? 'image/png' : isJpeg(buffer) ? 'image/jpeg' : null);
    const png = parsePngMetadata(buffer);
    const jpeg = png.width && png.height ? { width: null, height: null } : parseJpegDimensions(buffer);
    const width = png.width || jpeg.width;
    const height = png.height || jpeg.height;
    const quality = riskFromDimension(width, height, buffer.length);
    const qualityWarnings = quality.is_low_resolution
      ? ['Reference is low-resolution; do not preserve pixelation/aliasing/compression artifacts as style unless user confirms intentional pixel art or low-res aesthetic.']
      : [];
    const baseStats = {
      id,
      ok: true,
      mimeType: normalizedMime,
      byteLength: buffer.length,
      width,
      height,
      hasAlpha: png.hasAlpha,
      transparentRatio: png.transparentRatio,
      dominantColors: png.dominantColors,
      quality,
      warnings: [...png.warnings, ...qualityWarnings],
    };
    return {
      ...baseStats,
      assetFormat: inferAssetFormat(baseStats),
    };
  } catch (error) {
    return {
      id,
      ok: false,
      mimeType: null,
      byteLength: null,
      width: null,
      height: null,
      hasAlpha: null,
      transparentRatio: null,
      dominantColors: [],
      assetFormat: 'unknown',
      quality: UNKNOWN_QUALITY,
      warnings: [error instanceof Error ? error.message : 'Failed to preprocess reference image.'],
    };
  }
}

export type ReferenceInput = { id: string; buffer: Buffer; mimeType: string };

export async function preprocessReferences(references: ReferenceInput[]): Promise<ReferencePreprocessSummary> {
  const stats = await Promise.all(references.map((reference) => preprocessReferenceImage(reference)));
  const okStats = stats.filter((item) => item.ok);
  const qualityReport = summarizeQuality(okStats);
  const warnings = [
    ...stats.flatMap((item) => item.warnings.map((warning) => `${item.id}: ${warning}`)),
    ...qualityReport.warnings,
  ];

  return {
    total: references.length,
    ok: okStats.length,
    failed: stats.length - okStats.length,
    hasAnyAlpha: okStats.some((item) => item.hasAlpha === true),
    dominantAssetFormat: dominantFormat(okStats),
    dominantColors: mergeColors(okStats),
    qualityReport,
    stats,
    warnings,
  };
}
