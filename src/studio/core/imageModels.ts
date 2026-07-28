export const DEFAULT_IMAGE_MODEL = 'gpt-image-2'

/**
 * Image 2 has a materially different Images API contract from legacy
 * OpenAI-compatible providers. NewAPI may publish the same model as either
 * `image-2` or `gpt-image-2`; no other provider names are inferred here.
 */
export const isGptImage2Model = (model: string): boolean =>
  /^(?:gpt-)?image-2(?:$|-)/i.test(model.trim())

/**
 * Selects an OpenAI Images parameter contract after the endpoint protocol has
 * already been chosen from server metadata. This function never selects a
 * provider transport.
 */
export const isGptImageModel = (model: string): boolean =>
  isGptImage2Model(model) || /^gpt-image-/i.test(model.trim())

/**
 * The OpenAI-compatible Images contract does not define a seed field.
 * Keep it disabled until bounded server capability metadata explicitly adds it;
 * an opaque future model ID must never enable a provider extension by name.
 */
export const supportsImageSeed = (_model: string): boolean => false

export const supportsImageInputFidelity = (model: string): boolean => !isGptImage2Model(model)

export const usesImageArrayFormField = (model: string): boolean => isGptImageModel(model)
