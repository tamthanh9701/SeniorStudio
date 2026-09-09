import type { StyleInvariantContract, StyleSchemaQualityScore } from './invariant-contract';
import type { StylePropertyAxisId } from './analysis-framework';
import type { ReferencePreprocessSummary } from './reference-preprocess';

export type StyleClarificationQuestionType = 'single_choice' | 'multi_choice' | 'short_text' | 'scale';
export type StyleClarificationQuestionPriority = 'required' | 'recommended' | 'optional';

export interface StyleClarificationQuestion {
  id: string;
  axis: StylePropertyAxisId | 'global';
  priority: StyleClarificationQuestionPriority;
  type: StyleClarificationQuestionType;
  question: string;
  help_text: string;
  options?: string[];
  default_answer?: string | string[] | number | null;
  schema_target: string[];
  reason: string;
}

export interface StyleClarificationQuestionSet {
  version: 'style_clarification_questions_v1';
  status: 'needs_user_confirmation' | 'optional_confirmation';
  questions: StyleClarificationQuestion[];
  recommended_next_action: 'ask_user_before_generation' | 'can_generate_but_user_confirmation_improves_schema';
}

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function textFromSchema(schema: unknown): string {
  if (!isRecord(schema)) return '';
  const chunks: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === 'string') chunks.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (isRecord(value)) Object.values(value).forEach(visit);
  };
  visit(schema);
  return chunks.join(' ').toLowerCase();
}

function includesAny(text: string, needles: string[]) {
  return needles.some((needle) => text.includes(needle));
}

function hasIssue(score: StyleSchemaQualityScore | null | undefined, type: string) {
  return Boolean(score?.issues?.some((issue) => issue.type === type));
}

function addUnique(target: StyleClarificationQuestion[], question: StyleClarificationQuestion) {
  if (!target.some((item) => item.id === question.id)) target.push(question);
}

function familyOptions(contract?: StyleInvariantContract | null): string[] {
  const detected = contract?.visual_family || 'Detected style';
  return [
    `Keep the detected family: ${detected}`,
    'Make it flatter / more graphic / more vector-like',
    'Make it more 3D / rendered / material-based',
    'Make it more painterly / hand-made / textured',
    'Make it more realistic / photographic',
    'Use a custom description I will provide',
  ];
}

function hasLowResArtifactRisk(schemaText: string, referenceSummary?: ReferencePreprocessSummary | null): boolean {
  return Boolean(
    referenceSummary?.qualityReport?.hasLowResolutionReferences ||
    includesAny(schemaText, ['low resolution', 'low-resolution', 'pixel grid', 'pixelated', '8-bit', '16-bit', 'anti-aliasing']),
  );
}

export function buildStyleClarificationQuestions(params: {
  schema: unknown;
  contract?: StyleInvariantContract | null;
  schemaQuality?: StyleSchemaQualityScore | null;
  referenceSummary?: ReferencePreprocessSummary | null;
}): StyleClarificationQuestionSet {
  const { schema, contract, schemaQuality, referenceSummary } = params;
  const questions: StyleClarificationQuestion[] = [];
  const schemaText = textFromSchema(schema);
  const familyId = contract?.visual_family_id || 'unknown';
  const lowConfidence = (contract?.confidence ?? 0) < 0.72 || (schemaQuality?.overall ?? 0) < 0.72;
  const isFlatIcon = familyId === 'transparent_sticker_icon' || familyId === 'flat_vector_icon';
  const isMaterialStyle = familyId === 'glossy_3d' || familyId === 'photoreal';
  const isPainterly = familyId === 'watercolor' || familyId === 'line_art';
  const lowResArtifactRisk = hasLowResArtifactRisk(schemaText, referenceSummary);
  const hasGraphicLighting = includesAny(schemaText, [
    'highlight',
    'shadow',
    'core shadow',
    'drop shadow',
    'đổ bóng',
    '3d nhẹ',
    'slight 3d',
    'pseudo-3d',
    'isometric',
    'reflectivity',
    'specular',
  ]);

  addUnique(questions, {
    id: 'confirm_visual_family',
    axis: 'visual_family',
    priority: 'required',
    type: 'single_choice',
    question: 'Style family nào là đúng nhất với hướng bạn muốn xây dựng?',
    help_text: 'AI có thể nhận diện gần đúng, nhưng user cần xác nhận để schema không bị khóa sai family.',
    options: familyOptions(contract),
    default_answer: contract?.visual_family ? `Keep the detected family: ${contract.visual_family}` : null,
    schema_target: ['artistic_style.medium', 'artistic_style.style_reference', 'artistic_style.rendering_style', 'draft_style_invariant_contract.visual_family'],
    reason: 'Visual family là quyết định gốc ảnh hưởng tới outline, material, lighting, texture, background và negative prompt.',
  });

  if (lowResArtifactRisk) {
    addUnique(questions, {
      id: 'confirm_low_res_artifact_intent',
      axis: 'post_processing',
      priority: 'required',
      type: 'single_choice',
      question: 'Ảnh reference có vẻ low-res hoặc dễ bị nhầm thành pixel-art. Bạn muốn xử lý đặc điểm low-res như thế nào?',
      help_text: 'Câu này giúp tách style thật khỏi artifact do ảnh mẫu nhỏ, bị nén, răng cưa, pixelated hoặc checkerboard preview.',
      options: [
        'Không giữ low-res: dùng style này nhưng output phải clean/high-resolution hơn',
        'Có, pixelated/low-res là chủ đích của style',
        'Chỉ giữ độ đơn giản, không giữ răng cưa/pixel grid',
        'Không chắc, giữ theo reference nhưng tránh checkerboard/blur/nén ảnh',
      ],
      default_answer: referenceSummary?.qualityReport?.recommendedPolicy?.output_quality_target === 'clean_high_resolution_reconstruction'
        ? 'Không giữ low-res: dùng style này nhưng output phải clean/high-resolution hơn'
        : 'Không chắc, giữ theo reference nhưng tránh checkerboard/blur/nén ảnh',
      schema_target: ['technical_quality.resolution_quality', 'artistic_style.surface_texture', 'material_texture.pattern_detail', 'negative_prompt.avoid_artifacts', 'generation_params.reference_artifact_policy'],
      reason: 'Low-resolution references can make the LLM incorrectly preserve source artifacts as style. User confirmation decides whether to clean or preserve pixelation.',
    });
  }

  addUnique(questions, {
    id: 'confirm_content_vs_style',
    axis: 'negative_transfer',
    priority: 'required',
    type: 'multi_choice',
    question: 'Những thứ nào trong ảnh reference chỉ là nội dung mẫu, không được copy sang ảnh mới?',
    help_text: 'Ví dụ: shopping cart, túi đồ, nhân vật, bối cảnh, chữ, props. Những thứ này nên vào content_to_ignore.',
    options: [
      'Chủ thể chính trong reference chỉ là ví dụ, không copy',
      'Props/phụ kiện trong reference không copy',
      'Background/scene trong reference không copy',
      'Chữ/logo/brand trong reference không copy',
      'Một số motif được phép giữ vì là style DNA',
      'Tôi sẽ tự ghi rõ',
    ],
    default_answer: contract?.content_to_ignore?.length ? contract.content_to_ignore : null,
    schema_target: ['subject', 'subject_object', 'environment', 'negative_prompt.avoid_elements', 'draft_style_invariant_contract.content_to_ignore'],
    reason: 'Tách content khỏi style giúp tránh việc model copy shopping cart/bag/tree/room thay vì chỉ học nét vẽ.',
  });

  addUnique(questions, {
    id: 'confirm_core_axes',
    axis: 'global',
    priority: 'required',
    type: 'multi_choice',
    question: 'Những thuộc tính nào là DNA bắt buộc của style này?',
    help_text: 'Chỉ chọn các yếu tố nếu thiếu nó thì ảnh sẽ không còn giống style nữa.',
    options: [
      'Line/outline/edge behavior',
      'Shape language / proportions / silhouette',
      'Color palette / color roles',
      'Lighting / value / shadow behavior',
      'Material rendering / surface finish',
      'Texture / mark-making / pattern',
      'Composition / framing / crop / negative space',
      'Background / environment policy',
      'Camera / perspective / lens behavior',
      'Detail density / complexity',
      'Effects / particles / glow / sparkles',
      'Post-processing / grain / bloom / film grade',
    ],
    default_answer: contract?.must_match?.length ? contract.must_match : null,
    schema_target: ['draft_style_invariant_contract.must_match', 'draft_style_fingerprint', 'artistic_style', 'technical_quality'],
    reason: 'Generation cần hard-lock core axes, còn supporting/optional axes không nên ép quá mạnh.',
  });

  if (lowConfidence || hasIssue(schemaQuality, 'too_generic')) {
    addUnique(questions, {
      id: 'replace_generic_labels',
      axis: 'visual_family',
      priority: 'recommended',
      type: 'short_text',
      question: 'Bạn mô tả style này bằng 1–2 câu cụ thể như thế nào, tránh các từ chung chung như cute, modern, playful?',
      help_text: 'Ví dụ tốt: “icon casual game 2D, viền đen ngoài icon, bên trong không có viền, màu tươi, đổ bóng khối tạo 3D nhẹ, nền trong suốt”.',
      schema_target: ['style_name', 'artistic_style.style_reference', 'artistic_style.rendering_style', 'mood_atmosphere'],
      reason: 'Schema hiện có thể còn dùng nhãn rộng khiến model suy diễn nhiều style khác nhau.',
    });
  }

  if (isFlatIcon || includesAny(schemaText, ['outline', 'line art', 'stroke', 'vector', 'sticker', 'icon'])) {
    addUnique(questions, {
      id: 'confirm_outline_role',
      axis: 'line_edge_system',
      priority: isFlatIcon ? 'required' : 'recommended',
      type: 'single_choice',
      question: 'Outline/linework có phải yếu tố bắt buộc của style không?',
      help_text: 'Nếu chọn bắt buộc, schema sẽ khóa màu, độ dày, độ crisp và hierarchy của outline.',
      options: [
        'Bắt buộc, outline/linework là DNA chính',
        'Có nhưng chỉ là hỗ trợ',
        'Không quan trọng',
        'Không áp dụng cho style này',
      ],
      default_answer: isFlatIcon ? 'Bắt buộc, outline/linework là DNA chính' : null,
      schema_target: ['artistic_style.rendering_style', 'draft_style_invariant_contract.outline_system', 'negative_prompt.avoid_artifacts'],
      reason: 'Nhiều lỗi drift xảy ra khi model không biết outline là core hay optional.',
    });
  }

  addUnique(questions, {
    id: 'confirm_palette_flexibility',
    axis: 'color_palette',
    priority: 'recommended',
    type: 'single_choice',
    question: 'Màu sắc cần giữ chính xác đến mức nào?',
    help_text: 'Điều này quyết định schema khóa HEX/palette roles chặt hay chỉ giữ mood màu chung.',
    options: [
      'Rất chặt: giữ gần đúng palette/HEX/outline/fill roles',
      'Vừa phải: giữ mood và nhóm màu chính',
      'Linh hoạt: chỉ cần cùng cảm giác màu',
      'Tôi sẽ cung cấp palette riêng',
    ],
    default_answer: isFlatIcon ? 'Rất chặt: giữ gần đúng palette/HEX/outline/fill roles' : 'Vừa phải: giữ mood và nhóm màu chính',
    schema_target: ['color_palette', 'draft_style_fingerprint.palette_system', 'draft_style_invariant_contract.should_match'],
    reason: 'Palette quá rộng làm ảnh ra không đồng đều; palette quá chặt lại có thể làm mất linh hoạt nếu style không phụ thuộc màu.',
  });

  if (isFlatIcon || isMaterialStyle || includesAny(schemaText, ['gloss', 'glass', 'matte', 'plastic', 'material', 'highlight', 'shadow'])) {
    addUnique(questions, {
      id: 'confirm_material_lighting',
      axis: 'material_rendering',
      priority: 'recommended',
      type: 'single_choice',
      question: 'Lighting/material nên được hiểu như thế nào?',
      help_text: 'Câu này tránh lỗi style flat bị glossy, hoặc style 2D đổ bóng khối bị làm phẳng sai.',
      options: [
        'Flat/matte, gần như không có ánh sáng vật lý',
        'Có highlight/shadow graphic nhưng không realistic',
        'Có material/gloss/specular vì đó là style chính',
        'Photoreal/cinematic lighting là bắt buộc',
        'Không chắc, giữ theo reference',
      ],
      default_answer: isMaterialStyle
        ? 'Có material/gloss/specular vì đó là style chính'
        : hasGraphicLighting
          ? 'Có highlight/shadow graphic nhưng không realistic'
          : isFlatIcon
            ? 'Flat/matte, gần như không có ánh sáng vật lý'
            : 'Không chắc, giữ theo reference',
      schema_target: ['lighting', 'material_texture', 'negative_prompt.avoid_styles', 'draft_style_invariant_contract.fill_system'],
      reason: 'Đây là điểm quyết định giữa flat icon, 2D đổ bóng khối, glossy 3D, photoreal, watercolor, hoặc các style lai.',
    });
  }

  addUnique(questions, {
    id: 'confirm_background_policy',
    axis: 'background_environment',
    priority: 'recommended',
    type: 'single_choice',
    question: 'Background trong ảnh mới nên xử lý thế nào?',
    help_text: 'Nếu reference là isolated asset thì không nên invent scene; nếu reference là scene style thì không nên xóa background.',
    options: [
      'Plain white/transparent, object isolated',
      'Simple decorative background only',
      'Full scene/environment là một phần của style',
      'Studio/product background',
      'Giữ linh hoạt theo từng content',
    ],
    default_answer: isFlatIcon ? 'Plain white/transparent, object isolated' : 'Giữ linh hoạt theo từng content',
    schema_target: ['environment', 'composition', 'negative_prompt.avoid_elements', 'draft_style_invariant_contract.composition_system'],
    reason: 'Background policy sai là một trong các nguyên nhân lớn làm ảnh lệch style.',
  });

  if (isPainterly || includesAny(schemaText, ['texture', 'hatching', 'grain', 'paper', 'brush', 'stripe', 'pixel'])) {
    addUnique(questions, {
      id: 'confirm_texture_role',
      axis: 'surface_texture',
      priority: 'recommended',
      type: 'single_choice',
      question: 'Texture/mark-making có vai trò thế nào trong style?',
      help_text: 'Ví dụ: sọc/hatching trong vector, giấy/pigment trong watercolor, grain trong film, pixel dithering trong pixel art.',
      options: [
        'Core: thiếu texture là sai style',
        'Supporting: có nhẹ thôi',
        'Optional: có cũng được, không có cũng được',
        'Không áp dụng',
      ],
      default_answer: isPainterly ? 'Core: thiếu texture là sai style' : 'Supporting: có nhẹ thôi',
      schema_target: ['material_texture.pattern_detail', 'artistic_style.surface_texture', 'draft_style_invariant_contract.texture_system'],
      reason: 'Texture nếu bị ép sai loại sẽ khiến watercolor thành vector stripes hoặc vector thành glossy bands.',
    });
  }

  addUnique(questions, {
    id: 'confirm_detail_density',
    axis: 'detail_density',
    priority: 'optional',
    type: 'scale',
    question: 'Mức độ chi tiết nên nằm ở đâu?',
    help_text: '1 = cực tối giản, 5 = trung bình, 10 = rất nhiều chi tiết/ornate/realistic.',
    default_answer: isFlatIcon ? 3 : 5,
    schema_target: ['technical_quality.detail_level', 'subject.subject_details', 'draft_style_invariant_contract.should_match'],
    reason: 'Detail density ảnh hưởng lớn tới sự đồng đều giữa các ảnh output.',
  });

  const requiredCount = questions.filter((question) => question.priority === 'required').length;
  return {
    version: 'style_clarification_questions_v1',
    status: requiredCount > 0 || lowConfidence ? 'needs_user_confirmation' : 'optional_confirmation',
    questions: questions.slice(0, 9),
    recommended_next_action: requiredCount > 0 || lowConfidence
      ? 'ask_user_before_generation'
      : 'can_generate_but_user_confirmation_improves_schema',
  };
}
