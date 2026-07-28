import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'
import type { StudioFlowEdge } from '../types.js'

export function ExposureEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
  selected,
}: EdgeProps<StudioFlowEdge>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  const dataType = data?.dataType ?? 'any'
  return (
    <>
      <BaseEdge
        className={`exposure-edge edge-${dataType} ${data?.active ? 'is-active' : ''} ${selected ? 'is-selected' : ''}`}
        id={id}
        {...(markerEnd ? { markerEnd } : {})}
        path={path}
      />
      {data?.label ? (
        <EdgeLabelRenderer>
          <span className="edge-label nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}>
            {data.label}
          </span>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}
