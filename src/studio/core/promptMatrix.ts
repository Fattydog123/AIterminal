export interface MatrixDimension {
  readonly id: string
  readonly nodeId: string
  readonly parameter: string
  readonly values: readonly unknown[]
}

export interface MatrixCombination {
  readonly index: number
  readonly values: Readonly<Record<string, unknown>>
}

export interface MatrixPlan {
  readonly taskCount: number
  readonly imageCount: number
  readonly estimatedCost?: number
  readonly combinations: readonly MatrixCombination[]
  readonly requiresConfirmation: boolean
  readonly riskReasons: readonly string[]
}

export interface MatrixPlanOptions {
  readonly imagesPerTask?: number
  readonly costPerImage?: number
  readonly hardLimit?: number
  readonly confirmationTaskThreshold?: number
  readonly confirmationCostThreshold?: number
  readonly maxEstimatedCost?: number
}

export const planPromptMatrix = (
  dimensions: readonly MatrixDimension[],
  options: MatrixPlanOptions = {},
): MatrixPlan => {
  if (dimensions.length === 0) throw new Error('Prompt Matrix 至少需要一个维度')
  const hardLimit = options.hardLimit ?? 1_000
  if (!Number.isSafeInteger(hardLimit) || hardLimit < 1) throw new Error('Prompt Matrix hardLimit 必须是正整数')
  const dimensionIds = new Set<string>()
  const bindings = new Set<string>()
  dimensions.forEach((dimension) => {
    if (!dimension.id || !dimension.nodeId || !dimension.parameter || dimension.values.length === 0) {
      throw new Error('Prompt Matrix 维度不完整')
    }
    const binding = `${dimension.nodeId}.${dimension.parameter}`
    if (dimensionIds.has(dimension.id)) throw new Error(`Prompt Matrix 维度 ID 重复：${dimension.id}`)
    if (bindings.has(binding)) throw new Error(`Prompt Matrix 参数重复：${binding}`)
    dimensionIds.add(dimension.id)
    bindings.add(binding)
  })
  const taskCount = dimensions.reduce((count, dimension) => count * dimension.values.length, 1)
  if (!Number.isSafeInteger(taskCount) || taskCount > hardLimit) throw new Error(`Prompt Matrix 任务数超过上限 ${hardLimit}`)

  let combinations: MatrixCombination[] = [{ index: 0, values: {} }]
  dimensions.forEach((dimension) => {
    combinations = combinations.flatMap((combination) =>
      dimension.values.map((value) => ({
        index: 0,
        values: { ...combination.values, [`${dimension.nodeId}.${dimension.parameter}`]: value },
      })),
    )
  })
  combinations = combinations.map((combination, index) => ({ ...combination, index }))
  const imagesPerTask = options.imagesPerTask ?? 1
  if (!Number.isSafeInteger(imagesPerTask) || imagesPerTask < 1) throw new Error('每个任务的图片数必须是正整数')
  const imageCount = taskCount * imagesPerTask
  if (!Number.isSafeInteger(imageCount)) throw new Error('Prompt Matrix 图片数超出安全整数范围')
  if (options.costPerImage !== undefined && (!Number.isFinite(options.costPerImage) || options.costPerImage < 0)) {
    throw new Error('单图费用必须是非负有限数值')
  }
  if (options.maxEstimatedCost !== undefined
    && (!Number.isFinite(options.maxEstimatedCost) || options.maxEstimatedCost < 0)) {
    throw new Error('费用硬上限必须是非负有限数值')
  }
  const estimatedCost = options.costPerImage === undefined ? undefined : imageCount * options.costPerImage
  if (estimatedCost !== undefined && options.maxEstimatedCost !== undefined && estimatedCost > options.maxEstimatedCost) {
    throw new Error(`Prompt Matrix 预计费用 ${estimatedCost} 超过上限 ${options.maxEstimatedCost}`)
  }
  const taskThreshold = options.confirmationTaskThreshold ?? 1
  const costThreshold = options.confirmationCostThreshold ?? 0
  if (!Number.isSafeInteger(taskThreshold) || taskThreshold < 0) throw new Error('任务确认阈值必须是非负整数')
  if (!Number.isFinite(costThreshold) || costThreshold < 0) throw new Error('费用确认阈值必须是非负有限数值')
  const riskReasons: string[] = []
  if (taskCount > taskThreshold) riskReasons.push(`任务数 ${taskCount} 超过确认阈值 ${taskThreshold}`)
  if (estimatedCost === undefined) riskReasons.push('Provider 未提供费用估算')
  else if (estimatedCost > costThreshold) riskReasons.push(`预计费用 ${estimatedCost} 超过确认阈值 ${costThreshold}`)
  return {
    taskCount,
    imageCount,
    ...(estimatedCost === undefined ? {} : { estimatedCost }),
    combinations,
    requiresConfirmation: riskReasons.length > 0,
    riskReasons,
  }
}
