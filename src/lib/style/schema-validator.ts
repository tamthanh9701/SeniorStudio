import type { StyleClarificationAnswer } from './clarification-answers';
import type { StyleSchemaPatch } from './schema-patch';
import type { StyleInvariantContract } from './invariant-contract';

export const STYLE_SCHEMA_VALIDATION_VERSION = 'style_schema_validation_v1' as const;

export interface StyleSchemaValidationResult {
  version: typeof STYLE_SCHEMA_VALIDATION_VERSION;
  summary: string;
  confidence: number;
  patch: StyleSchemaPatch[];
  unresolved_questions: string[];
}

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function lower(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function schemaText(schema: unknown): string {
  const chunks: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === 'string') chunks.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (isRecord(value)) Object.values(value).forEach(visit);
  };
  visit(schema);
  return chunks.join(' ').toLowerCase();
}

function answerText(answer: StyleClarificationAnswer): string {
  return [answer.selected_option, ...(answer.selected_options || []), answer.custom_text]
    .filter(Boolean)
    .join(' ')
    .trim();
}

function allAnswerText(answers: StyleClarificationAnswer[]): string {
  return answers.map(answerText).join(' ').toLowerCase();
}

function splitCustomList(value?: string): string[] {
  if (!value) return [];
  return value
    .split(/,|;|\n|\u2022|-/g)
    .map((item) => item.trim())
    .filter((item) => item.length > 1);
}

function addPatch(patches: StyleSchemaPatch[], patch: StyleSchemaPatch) {
  patches.push({
    ...patch,
    confidence: Math.max(0, Math.min(1, Number(patch.confidence.toFixed(3)))),
  });
}

function includesAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function mentionsIntentionalPixelArt(value: string): boolean {
  return includesAny(value, ['pixelated/low-res là chủ đích', 'pixel art là chủ đích', 'pixel-art is intentional', 'preserve intentional pixel', '8-bit', '16-bit']);
}

function mentionsCleanLowResPolicy(value: string): boolean {
  return includesAny(value, ['không giữ low-res', 'clean/high-resolution', 'không giữ răng cưa', 'không giữ pixel grid', 'tránh checkerboard', 'tránh checkerboard/blur/nén ảnh']);
}

function mentionsPseudo3d(value: string): boolean {
  return includesAny(value, ['đổ bóng khối', 'do bong khoi', '3d nhẹ', '3d nhe', 'pseudo-3d', 'slight 3d', 'soft 3d', 'block shading', 'graphic shadow', 'graphic highlight']);
}

function mentionsOuterOnlyOutline(value: string): boolean {
  return includesAny(value, ['viền đen xung quanh', 'vien den xung quanh', 'outer black outline', 'black outline around', 'outside outline']);
}

function mentionsNoInnerOutline(value: string): boolean {
  return includesAny(value, ['bên trong icon bắt buộc không được có viền', 'ben trong icon bat buoc khong duoc co vien', 'no inner outline', 'no internal outline', 'without internal outline']);
}

function familyRenderingRule(answer: StyleClarificationAnswer, contract?: StyleInvariantContract | null): string | null {
  const text = lower(answerText(answer));
  if (answer.custom_text) return answer.custom_text.trim();
  if (text.includes('flatter') || text.includes('vector') || text.includes('graphic')) {
    return 'Flat/graphic 2D style. Preserve visible line/shape/color/composition rules from the references; avoid unrelated material realism unless the reference clearly uses it.';
  }
  if (text.includes('3d') || text.includes('rendered') || text.includes('material')) {
    return '3D/rendered material-based style. Preserve volume, material response, intentional highlights, shadows, and camera/perspective cues from the references.';
  }
  if (text.includes('painterly') || text.includes('hand-made') || text.includes('watercolor') || text.includes('textured')) {
    return 'Painterly/hand-made textured style. Preserve mark-making, pigment/brush/paper behavior, organic edge quality, and reference texture density.';
  }
  if (text.includes('realistic') || text.includes('photographic')) {
    return 'Realistic/photographic style. Preserve physically plausible lighting, material response, natural camera perspective, and real-world texture/detail behavior.';
  }
  if (text.includes('keep the detected')) return contract?.visual_family || null;
  return null;
}

function coreAxisRules(answer: StyleClarificationAnswer): string[] {
  const selected = answer.selected_options || [];
  const rules: string[] = [];
  for (const option of selected) {
    const text = lower(option);
    if (text.includes('line') || text.includes('outline') || text.includes('edge')) rules.push('line/edge system is core style DNA');
    if (text.includes('shape')) rules.push('shape language, proportions, and silhouette grammar are core style DNA');
    if (text.includes('color')) rules.push('palette and color roles are core style DNA');
    if (text.includes('lighting') || text.includes('shadow')) rules.push('value, lighting, and shadow behavior are core style DNA');
    if (text.includes('material')) rules.push('material rendering and surface finish are core style DNA');
    if (text.includes('texture') || text.includes('mark')) rules.push('texture, mark-making, and pattern placement are core style DNA');
    if (text.includes('composition') || text.includes('framing')) rules.push('composition, framing, crop, and negative space are core style DNA');
    if (text.includes('background')) rules.push('background/environment policy is core style DNA');
    if (text.includes('camera') || text.includes('perspective')) rules.push('camera, perspective, and lens behavior are core style DNA');
    if (text.includes('detail')) rules.push('detail density and complexity are core style DNA');
    if (text.includes('effects') || text.includes('sparkles') || text.includes('glow')) rules.push('motion/effects behavior is core style DNA only where selected');
    if (text.includes('post-processing') || text.includes('grain') || text.includes('bloom')) rules.push('post-processing and final finish are core style DNA');
  }
  return Array.from(new Set(rules));
}

function addOutlineCorrections(patches: StyleSchemaPatch[], sourceQuestionId: string, text: string) {
  if (mentionsOuterOnlyOutline(text)) {
    addPatch(patches, {
      op: 'append',
      path: 'artistic_style.rendering_style',
      value: 'Use a bold outer outline around the icon silhouette as a core style rule when the reference uses one.',
      reason: 'User explicitly confirmed an outer outline rule.',
      source_question_ids: [sourceQuestionId],
      confidence: 0.92,
    });
  }
  if (mentionsNoInnerOutline(text)) {
    addPatch(patches, {
      op: 'append',
      path: 'artistic_style.rendering_style',
      value: 'Inside the icon, do not add internal contour outlines; separate interior forms using fill color, block shading, and shape boundaries instead.',
      reason: 'User explicitly said the inside of the icon must not have outlines.',
      source_question_ids: [sourceQuestionId],
      confidence: 0.94,
    });
    addPatch(patches, {
      op: 'append',
      path: 'negative_prompt.avoid_artifacts',
      value: ['internal outlines inside the icon', 'colored inner contour lines', 'black internal line art', 'unwanted interior strokes'],
      reason: 'Guard against internal linework that violates the validated style.',
      source_question_ids: [sourceQuestionId],
      confidence: 0.92,
    });
  }
}

function addPseudo3dCorrections(patches: StyleSchemaPatch[], sourceQuestionId: string, text: string) {
  if (!mentionsPseudo3d(text)) return;
  addPatch(patches, {
    op: 'set',
    path: 'lighting.light_quality',
    value: 'Stylized 2D block shading and graphic highlights only; create a slight pseudo-3D icon effect without photoreal lighting.',
    reason: 'User confirmed 2D block shading / slight 3D effect.',
    source_question_ids: [sourceQuestionId],
    confidence: 0.9,
  });
  addPatch(patches, {
    op: 'set',
    path: 'lighting.special_lighting_effects',
    value: 'Allow small crisp graphic highlights and block shadows that match the reference; no glass orb, no realistic specular material, no glow unless present in the reference item.',
    reason: 'The style uses graphic highlight/shadow, not fully flat fill or realistic material.',
    source_question_ids: [sourceQuestionId],
    confidence: 0.88,
  });
  addPatch(patches, {
    op: 'set',
    path: 'material_texture.surface_finish',
    value: 'Clean stylized surface with controlled graphic highlights and block shadows; not photoreal material.',
    reason: 'Pseudo-3D icon styles should not be flattened or made photorealistic.',
    source_question_ids: [sourceQuestionId],
    confidence: 0.88,
  });
}

function addLowResArtifactPolicyPatches(params: {
  patches: StyleSchemaPatch[];
  sourceQuestionId: string;
  answerTextLower: string;
  draftSchemaText: string;
}) {
  const { patches, sourceQuestionId, answerTextLower, draftSchemaText } = params;
  const preservePixelArt = mentionsIntentionalPixelArt(answerTextLower);
  const cleanPolicy = mentionsCleanLowResPolicy(answerTextLower) || !preservePixelArt;

  if (preservePixelArt) {
    addPatch(patches, {
      op: 'set',
      path: 'generation_params.reference_artifact_policy',
      value: {
        preserve_resolution_artifacts: true,
        preserve_pixelation: true,
        preserve_aliasing: true,
        preserve_compression_artifacts: false,
        output_quality_target: 'preserve_intentional_pixel_art',
      },
      reason: 'User confirmed pixelation/low-resolution is intentional style, not an artifact.',
      source_question_ids: [sourceQuestionId],
      confidence: 0.92,
    });
    addPatch(patches, {
      op: 'set',
      path: 'technical_quality.resolution_quality',
      value: 'Intentional pixel-art / low-resolution aesthetic; preserve hard pixel edges and grid-aligned shape language while avoiding compression noise.',
      reason: 'Pixel/low-res aesthetic was confirmed by the user.',
      source_question_ids: [sourceQuestionId],
      confidence: 0.9,
    });
    addPatch(patches, {
      op: 'set',
      path: 'material_texture.pattern_detail',
      value: 'Intentional pixel grid or pixel-cluster texture when visible in the references.',
      reason: 'Pixel grid should be treated as style only after user confirmation.',
      source_question_ids: [sourceQuestionId],
      confidence: 0.9,
    });
    return;
  }

  if (!cleanPolicy) return;

  addPatch(patches, {
    op: 'set',
    path: 'generation_params.reference_artifact_policy',
    value: {
      preserve_resolution_artifacts: false,
      preserve_pixelation: false,
      preserve_aliasing: false,
      preserve_compression_artifacts: false,
      output_quality_target: 'clean_high_resolution_reconstruction',
    },
    reason: 'User did not confirm low-resolution artifacts as style; clean reconstruction is safer.',
    source_question_ids: [sourceQuestionId],
    confidence: 0.9,
  });
  addPatch(patches, {
    op: 'set',
    path: 'technical_quality.resolution_quality',
    value: 'Clean high-resolution reconstruction from low-resolution references; preserve intended style traits but do not preserve pixelation, aliasing, blur, compression, or low-res jaggedness.',
    reason: 'Low-resolution source quality should not become a generation style requirement.',
    source_question_ids: [sourceQuestionId],
    confidence: 0.9,
  });
  addPatch(patches, {
    op: 'set',
    path: 'artistic_style.surface_texture',
    value: 'Preserve intentional texture or mark-making only; do not preserve accidental pixel grid, jagged edges, or low-resolution artifacts unless explicitly requested.',
    reason: 'Separates real texture from source-resolution artifacts.',
    source_question_ids: [sourceQuestionId],
    confidence: 0.88,
  });
  addPatch(patches, {
    op: 'set',
    path: 'material_texture.pattern_detail',
    value: 'Reference-matched intentional texture only; no accidental pixel grid from low-resolution source images.',
    reason: 'Prevents low-res pixel structure from becoming style texture.',
    source_question_ids: [sourceQuestionId],
    confidence: 0.88,
  });
  addPatch(patches, {
    op: 'remove',
    path: 'negative_prompt.avoid_quality',
    value: ['High resolution', 'Smooth gradients'],
    reason: 'High resolution and controlled smooth graphic gradients should not be forbidden just because references are low-res.',
    source_question_ids: [sourceQuestionId],
    confidence: 0.86,
  });
  addPatch(patches, {
    op: 'remove',
    path: 'negative_prompt.avoid_artifacts',
    value: ['Anti-aliasing'],
    reason: 'Anti-aliasing can be necessary for clean high-resolution reconstruction.',
    source_question_ids: [sourceQuestionId],
    confidence: 0.86,
  });
  addPatch(patches, {
    op: 'append',
    path: 'negative_prompt.avoid_artifacts',
    value: [
      'low-resolution source artifacts',
      'jagged upscale edges',
      'visible pixel grid unless explicitly requested',
      'checkerboard transparency pattern',
      'compression artifacts',
      'blurred upscale artifacts',
    ],
    reason: 'Guard against preserving source artifacts from low-resolution references.',
    source_question_ids: [sourceQuestionId],
    confidence: 0.9,
  });
  addPatch(patches, {
    op: 'append',
    path: 'negative_prompt.avoid_styles',
    value: ['accidental pixel-art conversion caused only by low-resolution references'],
    reason: 'Pixel art should only be used if user confirms it as intentional style.',
    source_question_ids: [sourceQuestionId],
    confidence: 0.88,
  });

  if (includesAny(draftSchemaText, ['pixel art', 'pixel-art', '8-bit', '16-bit'])) {
    addPatch(patches, {
      op: 'set',
      path: 'style_name',
      value: 'Reference-Matched Clean Style',
      reason: 'Draft schema appeared to classify low-resolution evidence as Pixel Art without user confirmation.',
      source_question_ids: [sourceQuestionId],
      confidence: 0.82,
    });
    addPatch(patches, {
      op: 'append',
      path: 'artistic_style.rendering_style',
      value: 'Do not classify the style as pixel art solely because the uploaded references are small or low-resolution.',
      reason: 'Low-res artifact policy overrides accidental pixel-art classification.',
      source_question_ids: [sourceQuestionId],
      confidence: 0.86,
    });
  }
}

export function buildStyleSchemaValidationPatch(params: {
  draftSchema: unknown;
  draftContract?: StyleInvariantContract | null;
  answers: StyleClarificationAnswer[];
}): StyleSchemaValidationResult {
  const { draftSchema, draftContract, answers } = params;
  const patches: StyleSchemaPatch[] = [];
  const unresolved: string[] = [];
  const touched: string[] = [];
  const globalAnswerText = allAnswerText(answers);
  const draftSchemaText = schemaText(draftSchema);
  const hasPseudo3dIntent = mentionsPseudo3d(globalAnswerText);

  for (const answer of answers) {
    if (answer.skipped) {
      unresolved.push(answer.question_id);
      continue;
    }
    const selectedText = answerText(answer);
    const selectedLower = lower(selectedText);

    if (answer.question_id === 'confirm_low_res_artifact_intent') {
      addLowResArtifactPolicyPatches({
        patches,
        sourceQuestionId: answer.question_id,
        answerTextLower: selectedLower,
        draftSchemaText,
      });
      touched.push('low-res artifact policy');
    }

    if (answer.question_id === 'confirm_visual_family') {
      const rule = familyRenderingRule(answer, draftContract);
      if (rule) {
        addPatch(patches, {
          op: 'set',
          path: 'artistic_style.style_reference',
          value: rule,
          reason: 'User confirmed the intended visual/rendering family.',
          source_question_ids: [answer.question_id],
          confidence: answer.custom_text ? 0.92 : 0.86,
        });
        addPatch(patches, {
          op: 'set',
          path: 'artistic_style.rendering_style',
          value: `${rule} Use this as the primary style direction and keep other schema fields consistent with it.`,
          reason: 'Visual family confirmation should be reflected in the primary rendering rule.',
          source_question_ids: [answer.question_id],
          confidence: answer.custom_text ? 0.9 : 0.84,
        });
        addOutlineCorrections(patches, answer.question_id, selectedLower);
        addPseudo3dCorrections(patches, answer.question_id, selectedLower);
        touched.push('visual family');
      }
    }

    if (answer.question_id === 'replace_generic_labels' && answer.custom_text) {
      const customLower = lower(answer.custom_text);
      addPatch(patches, {
        op: 'set',
        path: 'artistic_style.style_reference',
        value: answer.custom_text,
        reason: 'User provided a concrete description to replace generic style labels.',
        source_question_ids: [answer.question_id],
        confidence: 0.94,
      });
      addPatch(patches, {
        op: 'set',
        path: 'artistic_style.rendering_style',
        value: answer.custom_text,
        reason: 'User-provided concrete description is the strongest rendering rule.',
        source_question_ids: [answer.question_id],
        confidence: 0.94,
      });
      addOutlineCorrections(patches, answer.question_id, customLower);
      addPseudo3dCorrections(patches, answer.question_id, customLower);
      touched.push('generic labels');
    }

    if (answer.question_id === 'confirm_content_vs_style') {
      const avoid: string[] = [];
      if (selectedLower.includes('chủ thể chính')) avoid.push('reference main subject unless requested');
      if (selectedLower.includes('props') || selectedLower.includes('phụ kiện')) avoid.push('reference-only props/accessories');
      if (selectedLower.includes('background') || selectedLower.includes('bối cảnh')) avoid.push('reference-only background/scene');
      if (selectedLower.includes('chữ') || selectedLower.includes('logo') || selectedLower.includes('brand')) avoid.push('reference text/logo/brand marks');
      avoid.push(...splitCustomList(answer.custom_text));
      if (avoid.length) {
        addPatch(patches, {
          op: 'append',
          path: 'negative_prompt.avoid_elements',
          value: avoid,
          reason: 'User clarified which reference content is not reusable style.',
          source_question_ids: [answer.question_id],
          confidence: 0.9,
        });
        touched.push('content to ignore');
      }
    }

    if (answer.question_id === 'confirm_core_axes') {
      const rules = coreAxisRules(answer);
      if (answer.custom_text) rules.push(answer.custom_text);
      if (rules.length) {
        addPatch(patches, {
          op: 'append',
          path: 'artistic_style.rendering_style',
          value: `User-confirmed core style axes: ${rules.join('; ')}.`,
          reason: 'User confirmed which style axes are core DNA.',
          source_question_ids: [answer.question_id],
          confidence: 0.82,
        });
        addPatch(patches, {
          op: 'append',
          path: 'negative_prompt.avoid_quality',
          value: ['drift away from user-confirmed core style axes'],
          reason: 'Core axes should be protected during generation.',
          source_question_ids: [answer.question_id],
          confidence: 0.82,
        });
        touched.push('core axes');
      }
    }

    if (answer.question_id === 'confirm_outline_role') {
      if (selectedLower.includes('bắt buộc')) {
        addPatch(patches, {
          op: 'append',
          path: 'artistic_style.rendering_style',
          value: 'Preserve the reference line/outline/edge system as core style DNA: maintain stroke weight, edge sharpness, color hierarchy, line consistency, and avoid blurred or weak outlines unless the reference uses them.',
          reason: 'User confirmed linework is mandatory.',
          source_question_ids: [answer.question_id],
          confidence: 0.9,
        });
        addPatch(patches, {
          op: 'append',
          path: 'negative_prompt.avoid_artifacts',
          value: ['weak outline', 'blurred edges', 'inconsistent stroke weight', 'line hierarchy drift'],
          reason: 'Mandatory linework needs explicit artifact guards.',
          source_question_ids: [answer.question_id],
          confidence: 0.88,
        });
      } else if (selectedLower.includes('không áp dụng') || selectedLower.includes('không quan trọng')) {
        addPatch(patches, {
          op: 'append',
          path: 'negative_prompt.avoid_styles',
          value: ['invented outline system not present in the reference'],
          reason: 'User confirmed linework is not a core style requirement.',
          source_question_ids: [answer.question_id],
          confidence: 0.82,
        });
      }
      touched.push('outline role');
    }

    if (answer.question_id === 'confirm_palette_flexibility') {
      let rule = 'Preserve reference color mood and main color families with moderate flexibility.';
      if (selectedLower.includes('rất chặt')) rule = 'Preserve palette strictly: keep detected HEX anchors, outline/fill/material/background color roles, saturation, and contrast close to the reference.';
      if (selectedLower.includes('linh hoạt')) rule = 'Palette is flexible: preserve overall color mood only, allowing subject-appropriate color substitutions.';
      if (selectedLower.includes('palette riêng') && answer.custom_text) rule = `Use this user-provided palette/rule: ${answer.custom_text}`;
      addPatch(patches, {
        op: 'set',
        path: 'color_palette.color_mood',
        value: rule,
        reason: 'User clarified palette strictness.',
        source_question_ids: [answer.question_id],
        confidence: 0.86,
      });
      touched.push('palette');
    }

    if (answer.question_id === 'confirm_material_lighting') {
      let lightingRule = 'Preserve lighting and material behavior from the reference.';
      let materialRule = 'Reference-matched surface finish and material response.';
      let avoid: string[] = [];
      if ((selectedLower.includes('flat') || selectedLower.includes('matte')) && !hasPseudo3dIntent) {
        lightingRule = 'Flat/matte graphic value behavior; avoid realistic material lighting, but preserve any flat graphic shadows explicitly visible in the references.';
        materialRule = 'Flat/matte stylized surface behavior; avoid realistic material response.';
        avoid = ['glossy material drift', 'glass/plastic rendering', 'realistic specular highlights'];
      } else if (selectedLower.includes('graphic') || hasPseudo3dIntent) {
        lightingRule = 'Use stylized 2D graphic highlights and block shadows only; keep them crisp and non-photorealistic to create the slight pseudo-3D game icon effect.';
        materialRule = 'Stylized icon surface with controlled graphic highlights and block shadows, not photoreal material.';
        avoid = ['photorealistic lighting drift', 'uncontrolled glossy rendering'];
      } else if (selectedLower.includes('material') || selectedLower.includes('gloss') || selectedLower.includes('specular')) {
        lightingRule = 'Preserve intentional material lighting, specular highlights, shadows, and surface response as core style behavior.';
        materialRule = 'Material/gloss/specular response is part of the style and must not be flattened.';
        avoid = ['flat vector simplification of material style'];
      } else if (selectedLower.includes('photoreal') || selectedLower.includes('cinematic')) {
        lightingRule = 'Photoreal/cinematic lighting is mandatory: preserve natural light falloff, shadows, lens/camera realism, and material response.';
        materialRule = 'Photoreal material texture and finish are core style DNA.';
        avoid = ['cartoon/vector simplification', 'unrealistic lighting'];
      }
      addPatch(patches, {
        op: 'set',
        path: 'lighting.light_quality',
        value: lightingRule,
        reason: 'User clarified lighting/material interpretation.',
        source_question_ids: [answer.question_id],
        confidence: 0.88,
      });
      addPatch(patches, {
        op: 'set',
        path: 'material_texture.surface_finish',
        value: materialRule,
        reason: 'User clarified material/surface finish behavior.',
        source_question_ids: [answer.question_id],
        confidence: 0.88,
      });
      if (avoid.length) {
        addPatch(patches, {
          op: 'append',
          path: 'negative_prompt.avoid_styles',
          value: avoid,
          reason: 'Guard against material/lighting drift opposite to user confirmation.',
          source_question_ids: [answer.question_id],
          confidence: 0.86,
        });
      }
      touched.push('material/lighting');
    }

    if (answer.question_id === 'confirm_background_policy') {
      let setting = 'Reference-matched background behavior; keep flexible for the requested content.';
      let backgroundElements = 'Use background behavior consistent with reference evidence.';
      let avoid: string[] = [];
      if (selectedLower.includes('plain') || selectedLower.includes('transparent') || selectedLower.includes('isolated')) {
        setting = 'Plain white or actual transparent isolated asset setting.';
        backgroundElements = 'No scene background; use actual alpha transparency when supported, otherwise plain white/off-white. Never draw a checkerboard transparency pattern.';
        avoid = ['busy scene background', 'room/interior/cafe background', 'unrequested environment', 'drawn checkerboard background', 'checkerboard transparency pattern'];
      } else if (selectedLower.includes('simple decorative')) {
        setting = 'Simple decorative background only.';
        backgroundElements = 'Minimal decorative background elements that support the subject without becoming a scene.';
        avoid = ['busy full scene', 'realistic interior background', 'drawn checkerboard background'];
      } else if (selectedLower.includes('full scene')) {
        setting = 'Full scene/environment is part of the style.';
        backgroundElements = 'Preserve scene/environment language from the reference when generating new content.';
        avoid = ['isolated-object simplification when a scene is required'];
      } else if (selectedLower.includes('studio')) {
        setting = 'Studio/product background.';
        backgroundElements = 'Use clean studio/product presentation background consistent with the reference.';
        avoid = ['drawn checkerboard background'];
      }
      addPatch(patches, {
        op: 'set',
        path: 'environment.setting',
        value: setting,
        reason: 'User clarified background/environment policy.',
        source_question_ids: [answer.question_id],
        confidence: 0.88,
      });
      addPatch(patches, {
        op: 'set',
        path: 'environment.background_elements',
        value: backgroundElements,
        reason: 'Background elements should follow user-confirmed policy.',
        source_question_ids: [answer.question_id],
        confidence: 0.86,
      });
      if (avoid.length) {
        addPatch(patches, {
          op: 'append',
          path: 'negative_prompt.avoid_elements',
          value: avoid,
          reason: 'Guard against background policy drift.',
          source_question_ids: [answer.question_id],
          confidence: 0.86,
        });
      }
      touched.push('background');
    }

    if (answer.question_id === 'confirm_texture_role') {
      let texture = 'Texture/mark-making follows the reference when visible.';
      if (selectedLower.includes('core')) texture = 'Texture/mark-making is core style DNA; preserve type, density, placement, and rhythm from the reference.';
      if (selectedLower.includes('supporting')) texture = 'Texture/mark-making is supporting; keep it subtle and reference-matched without overpowering the subject.';
      if (selectedLower.includes('optional')) texture = 'Texture/mark-making is optional; include only when it improves style consistency.';
      if (selectedLower.includes('không áp dụng')) texture = 'No texture requirement; avoid inventing texture not supported by the reference.';
      addPatch(patches, {
        op: 'set',
        path: 'material_texture.pattern_detail',
        value: texture,
        reason: 'User clarified texture/mark-making role.',
        source_question_ids: [answer.question_id],
        confidence: 0.86,
      });
      touched.push('texture');
    }

    if (answer.question_id === 'confirm_detail_density' && typeof answer.scale_value === 'number') {
      const value = answer.scale_value <= 3
        ? 'Low/minimal detail density. Keep forms simplified and avoid visual noise.'
        : answer.scale_value <= 7
          ? 'Medium detail density. Preserve reference-level detail without overcomplicating the subject.'
          : 'High detail density. Preserve rich/ornate/realistic detail where the reference supports it.';
      addPatch(patches, {
        op: 'set',
        path: 'technical_quality.detail_level',
        value,
        reason: 'User set preferred detail density.',
        source_question_ids: [answer.question_id],
        confidence: 0.82,
      });
      touched.push('detail density');
    }
  }

  const answered = answers.filter((answer) => !answer.skipped).length;
  const requiredAnswered = answers.filter((answer) => !answer.skipped && ['confirm_visual_family', 'confirm_low_res_artifact_intent', 'confirm_content_vs_style', 'confirm_core_axes'].includes(answer.question_id)).length;
  const confidence = Math.max(0.45, Math.min(0.95, 0.52 + answered * 0.045 + requiredAnswered * 0.06));

  return {
    version: STYLE_SCHEMA_VALIDATION_VERSION,
    summary: touched.length
      ? `Validated style schema using user answers. Updated: ${Array.from(new Set(touched)).join(', ')}.`
      : 'No schema-changing clarification answers were provided; draft schema was retained.',
    confidence,
    patch: patches,
    unresolved_questions: unresolved,
  };
}
