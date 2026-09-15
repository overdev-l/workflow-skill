import { useEffect, useLayoutEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import './WorkflowGraph.css'
import {
  Check,
  Clock3,
  Crosshair,
  FileSpreadsheet,
  FileText,
  Files,
  FolderOpen,
  GitBranch,
  Globe2,
  Layers,
  Mail,
  Maximize2,
  Terminal,
  Zap,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import type { Workflow, WorkflowNode } from '@workflow-skill/workflow-model'
import { useI18n } from '../i18n'

interface WorkflowGraphProps {
  workflow: Workflow
  compact?: boolean
  selectedNodeId?: string | null
  onNodeSelect?: (node: WorkflowNode | null) => void
}

const appIcons: Record<string, typeof Files> = {
  finder: FolderOpen,
  excel: FileSpreadsheet,
  sheets: FileSpreadsheet,
  preview: FileText,
  mail: Mail,
  slack: Mail,
  figma: Layers,
  linear: GitBranch,
  notion: FileText,
  terminal: Terminal,
  wait: Clock3,
  action: Zap,
  done: Check,
}

function getNodeIcon(node: WorkflowNode) {
  if (node.id === 'done') return Check
  if (node.kind === 'wait') return Clock3
  if (node.kind === 'http') return Globe2
  if (node.app) {
    const key = node.app.toLowerCase()
    if (appIcons[key]) return appIcons[key]
  }
  return appIcons[node.id] || Files
}

interface LayoutNode {
  node: WorkflowNode
  x: number
  y: number
  width: number
  height: number
  col: number
  row: number
  stepNum: number
}

interface LayoutEdge {
  fromId: string
  toId: string
  startX: number
  startY: number
  endX: number
  endY: number
  pathD: string
}

export function WorkflowGraph({
  workflow,
  compact = false,
  selectedNodeId: controlledSelectedId,
  onNodeSelect,
}: WorkflowGraphProps) {
  const { resolvedLocale } = useI18n()
  const isZh = resolvedLocale === 'zh-CN'
  const graphLabelId = useId()
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pendingCenter = useRef<{ x: number; y: number } | null>(null)
  const dragOrigin = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const [panning, setPanning] = useState(false)

  const activeSelectedId = controlledSelectedId !== undefined ? controlledSelectedId : internalSelectedId

  // Topological Column Assignment & Smooth Spline Calculation
  const layout = useMemo(() => {
    const nodes = workflow?.nodes || []
    const edges = workflow?.edges || []

    const inDegree: Record<string, number> = {}
    const outgoing: Record<string, string[]> = {}
    nodes.forEach((n) => {
      inDegree[n.id] = 0
      outgoing[n.id] = []
    })

    edges.forEach((e) => {
      if (inDegree[e.to] !== undefined) inDegree[e.to]++
      if (outgoing[e.from]) outgoing[e.from].push(e.to)
    })

    const colAssign: Record<string, number> = {}
    const queue: string[] = []

    nodes.forEach((n) => {
      if (inDegree[n.id] === 0) {
        colAssign[n.id] = 0
        queue.push(n.id)
      }
    })

    while (queue.length > 0) {
      const curr = queue.shift()!
      const currCol = colAssign[curr] ?? 0
      for (const next of outgoing[curr] || []) {
        if (inDegree[next] === undefined) continue
        colAssign[next] = Math.max(colAssign[next] ?? 0, currCol + 1)
        inDegree[next]--
        if (inDegree[next] === 0) queue.push(next)
      }
    }

    nodes.forEach((n, idx) => {
      if (colAssign[n.id] === undefined) colAssign[n.id] = idx
    })

    const columns: Record<number, WorkflowNode[]> = {}
    nodes.forEach((n) => {
      const col = colAssign[n.id] ?? 0
      if (!columns[col]) columns[col] = []
      columns[col].push(n)
    })

    const nodeWidth = 156
    const nodeHeight = 56
    const colSpacing = 76
    const rowSpacing = 20
    const startX = 28

    const colKeys = Object.keys(columns)
      .map(Number)
      .sort((a, b) => a - b)

    let maxColHeight = 0
    colKeys.forEach((colIdx) => {
      const colNodes = columns[colIdx]
      const totalHeight = colNodes.length * nodeHeight + (colNodes.length - 1) * rowSpacing
      if (totalHeight > maxColHeight) maxColHeight = totalHeight
    })

    const stageHeight = Math.max(340, maxColHeight + 80)
    const centerY = stageHeight / 2

    const layoutNodes: LayoutNode[] = []
    const nodePosMap: Record<string, { x: number; y: number; width: number; height: number }> = {}

    let counter = 1
    colKeys.forEach((colIdx) => {
      const colNodes = columns[colIdx]
      const totalHeight = colNodes.length * nodeHeight + (colNodes.length - 1) * rowSpacing
      const startY = centerY - totalHeight / 2

      colNodes.forEach((node, rowIdx) => {
        const x = startX + colIdx * (nodeWidth + colSpacing)
        const y = startY + rowIdx * (nodeHeight + rowSpacing)
        const layoutNode = {
          node,
          x,
          y,
          width: nodeWidth,
          height: nodeHeight,
          col: colIdx,
          row: rowIdx,
          stepNum: counter++,
        }
        layoutNodes.push(layoutNode)
        nodePosMap[node.id] = { x, y, width: nodeWidth, height: nodeHeight }
      })
    })

    const maxCol = Math.max(...colKeys, 0)
    const stageWidth = Math.max(760, startX * 2 + (maxCol + 1) * (nodeWidth + colSpacing) - colSpacing)

    const layoutEdges: LayoutEdge[] = []
    edges.forEach((edge) => {
      const fromPos = nodePosMap[edge.from]
      const toPos = nodePosMap[edge.to]
      if (fromPos && toPos) {
        const startX = fromPos.x + fromPos.width
        const startY = fromPos.y + fromPos.height / 2
        const endX = toPos.x
        const endY = toPos.y + toPos.height / 2
        const deltaX = endX - startX
        const cp1x = startX + deltaX * 0.48
        const cp2x = startX + deltaX * 0.52

        const pathD = `M ${startX} ${startY} C ${cp1x} ${startY}, ${cp2x} ${endY}, ${endX} ${endY}`
        layoutEdges.push({
          fromId: edge.from,
          toId: edge.to,
          startX,
          startY,
          endX,
          endY,
          pathD,
        })
      }
    })

    return { layoutNodes, layoutEdges, stageWidth, stageHeight }
  }, [workflow])

  const centerView = (x: number, y: number, scale: number) => {
    const viewport = scrollRef.current
    if (!viewport) return
    viewport.scrollTo({
      left: Math.max(0, x * scale - viewport.clientWidth / 2),
      top: Math.max(0, y * scale - viewport.clientHeight / 2),
      behavior: 'instant',
    })
  }

  useLayoutEffect(() => {
    const point = pendingCenter.current
    if (point) {
      centerView(point.x, point.y, zoom)
      pendingCenter.current = null
    }
  }, [zoom])

  useEffect(() => {
    setZoom(1)
    pendingCenter.current = null
    scrollRef.current?.scrollTo({ left: 0, top: 0, behavior: 'instant' })
  }, [workflow.id])

  const changeZoom = (next: number) => {
    const viewport = scrollRef.current
    if (!viewport) return
    pendingCenter.current = {
      x: (viewport.scrollLeft + viewport.clientWidth / 2) / zoom,
      y: (viewport.scrollTop + viewport.clientHeight / 2) / zoom,
    }
    setZoom(Math.min(2, Math.max(0.005, next)))
  }

  const fitView = () => {
    const viewport = scrollRef.current
    if (!viewport) return
    const next = Math.min(1, (viewport.clientWidth - 16) / layout.stageWidth,
      (viewport.clientHeight - 16) / layout.stageHeight)
    pendingCenter.current = null
    setZoom(Math.max(0.005, next))
    viewport.scrollTo({ left: 0, top: 0, behavior: 'instant' })
  }

  const locateSelected = () => {
    const target = layout.layoutNodes.find((n) => n.node.id === activeSelectedId)
    if (!target) return
    const point = { x: target.x + target.width / 2, y: target.y + target.height / 2 }
    if (zoom < 0.5) {
      pendingCenter.current = point
      setZoom(1)
    } else centerView(point.x, point.y, zoom)
  }

  const handleGraphKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const nodes = layout.layoutNodes
    if (!nodes.length) return
    const current = nodes.findIndex((n) => n.node.id === activeSelectedId)
    let next: number
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = Math.min(nodes.length - 1, current + 1)
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = Math.max(0, current - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = nodes.length - 1
    else return
    event.preventDefault()
    const target = nodes[next]
    setInternalSelectedId(target.node.id)
    onNodeSelect?.(target.node)
    const button = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-node-id]'))
      .find((el) => el.dataset.nodeId === target.node.id)
    button?.focus({ preventScroll: true })
    const point = { x: target.x + target.width / 2, y: target.y + target.height / 2 }
    if (zoom < 0.5) {
      pendingCenter.current = point
      setZoom(1)
    } else centerView(point.x, point.y, zoom)
  }

  if (compact) {
    return (
      <div className="flow-mini-spark" aria-label={`${workflow.name} ${isZh ? '步骤简图' : 'step preview'}`}>
        {workflow.nodes.slice(0, 5).map((node, i) => (
          <span
            key={node.id}
            className={`spark-dot ${node.kind === 'wait' ? 'is-wait' : ''}`}
            title={`${i + 1}. ${node.label}`}
          />
        ))}
        {workflow.nodes.length > 5 ? (
          <span className="spark-more font-mono">+{workflow.nodes.length - 5}</span>
        ) : null}
      </div>
    )
  }

  return (
    <section className="flow-graph-container" aria-labelledby={graphLabelId}>
      <h3 id={graphLabelId} className="sr-only">
        {workflow.name} {isZh ? '完整工作流拓扑' : 'complete workflow graph'}
      </h3>
      <div className="flow-canvas-toolbar" aria-label={isZh ? '画布视图' : 'Canvas view'}>
        <span className="flow-canvas-hint">{isZh ? '拖动画布 · 方向键选择步骤' : 'Drag to pan · Arrow keys select steps'}</span>
        <div className="flow-canvas-actions">
          <button type="button" className="btn btn--sm" onClick={() => changeZoom(zoom / 1.25)}
            aria-label={isZh ? '缩小画布' : 'Zoom out'} disabled={zoom <= 0.005}>
            <ZoomOut size={12} />
          </button>
          <span className="font-mono flow-canvas-scale">{Math.round(zoom * 1000) / 10}%</span>
          <button type="button" className="btn btn--sm" onClick={() => changeZoom(zoom * 1.25)}
            aria-label={isZh ? '放大画布' : 'Zoom in'} disabled={zoom >= 2}>
            <ZoomIn size={12} />
          </button>
          <button type="button" className="btn btn--sm" onClick={fitView}
            aria-label={isZh ? '适应画布' : 'Fit view'} title={isZh ? '适应画布' : 'Fit view'}>
            <Maximize2 size={12} />
          </button>
          <button type="button" className="btn btn--sm" onClick={locateSelected} disabled={!activeSelectedId}
            aria-label={isZh ? '定位选中步骤' : 'Locate selected step'} title={isZh ? '定位选中步骤' : 'Locate selected step'}>
            <Crosshair size={12} />
          </button>
        </div>
      </div>
      <div className={`flow-graph__scroll${panning ? ' is-panning' : ''}`} ref={scrollRef}
        tabIndex={layout.layoutNodes.length ? -1 : 0} onKeyDown={handleGraphKeyDown}
        aria-label={isZh ? '流程画布，使用方向键选择步骤' : 'Workflow canvas, use arrow keys to select steps'}
        onPointerDown={(event) => {
          if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
          const viewport = event.currentTarget
          dragOrigin.current = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop }
          viewport.setPointerCapture(event.pointerId)
          setPanning(true)
        }}
        onPointerMove={(event) => {
          const origin = dragOrigin.current
          if (!origin) return
          event.currentTarget.scrollLeft = origin.left - (event.clientX - origin.x)
          event.currentTarget.scrollTop = origin.top - (event.clientY - origin.y)
        }}
        onPointerUp={(event) => {
          dragOrigin.current = null
          setPanning(false)
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onLostPointerCapture={() => { dragOrigin.current = null; setPanning(false) }}
      >
        <div
          className="flow-graph__stage-scaler"
          style={{
            width: `${layout.stageWidth * zoom}px`,
            height: `${layout.stageHeight * zoom}px`,
            minWidth: `${layout.stageWidth * zoom}px`,
            minHeight: `${layout.stageHeight * zoom}px`,
            position: 'relative',
            margin: '0 auto',
          }}
        >
          <div
            className="flow-graph__stage"
            style={{
              width: `${layout.stageWidth}px`,
              height: `${layout.stageHeight}px`,
              transform: `scale(${zoom})`,
              transformOrigin: 'top left',
              position: 'absolute',
              top: 0,
              left: 0,
            }}
          >
          {/* Animated Living Data Splines with Real Traveling Particles */}
          <svg
            className="flow-graph__svg"
            viewBox={`0 0 ${layout.stageWidth} ${layout.stageHeight}`}
            aria-hidden="true"
          >
            {layout.layoutEdges.map((edge) => {
              const isConnectedToSelected =
                Boolean(activeSelectedId) &&
                (edge.fromId === activeSelectedId || edge.toId === activeSelectedId)
              const isDimmed = Boolean(activeSelectedId) && !isConnectedToSelected

              return (
                <g
                  key={`${edge.fromId}->${edge.toId}`}
                  className={`edge-group ${isConnectedToSelected ? 'is-highlighted' : ''} ${isDimmed ? 'is-dimmed' : ''}`}
                >
                  {/* Base Track */}
                  <path d={edge.pathD} className="flow-edge-base" />

                  {/* Flow Pulse Wire */}
                  <path d={edge.pathD} className="flow-edge-pulse" />

                  {/* Traveling Energy Signal Packet */}
                  <circle r={isConnectedToSelected ? "3.2" : "2.2"} className="flow-edge-packet">
                    <animateMotion
                      dur={isConnectedToSelected ? "1.8s" : "3.6s"}
                      repeatCount="indefinite"
                      path={edge.pathD}
                    />
                  </circle>

                  {/* Anchor Rings */}
                  <circle cx={edge.startX} cy={edge.startY} r="3" className="flow-edge-anchor" />
                  <circle cx={edge.endX} cy={edge.endY} r="3" className="flow-edge-anchor" />
                </g>
              )
            })}
          </svg>

          {/* Tactile Flow Step Nodes */}
          {layout.layoutNodes.map(({ node, x, y, width, height, stepNum }) => {
            const Icon = getNodeIcon(node)
            const isSelected = activeSelectedId === node.id
            const isWait = node.kind === 'wait'
            const isDone = node.id === 'done'

            return (
              <button
                key={node.id}
                type="button"
                className={`flow-node ${isSelected ? 'is-selected' : ''} ${isWait ? 'is-wait' : ''} ${isDone ? 'is-done' : ''}`}
                style={{
                  left: `${x}px`,
                  top: `${y}px`,
                  width: `${width}px`,
                  minHeight: `${height}px`,
                }}
                data-node-id={node.id}
                tabIndex={isSelected || (!activeSelectedId && stepNum === 1) ? 0 : -1}
                aria-label={`${stepNum}. ${node.app ? node.app + ': ' : ''}${node.label}`}
                aria-pressed={isSelected}
                onClick={() => {
                  const nextId = isSelected ? null : node.id
                  setInternalSelectedId(nextId)
                  onNodeSelect?.(isSelected ? null : node)
                }}
              >
                {isSelected ? <span className="flow-node__ripple" /> : null}

                <div className={`flow-node__icon ${isWait ? 'is-waiting-icon' : ''}`}>
                  <Icon size={15} />
                </div>
                <div className="flow-node__content">
                  <div className="flow-node__topline">
                    <span className="flow-node__stepnum font-mono">{String(stepNum).padStart(2, '0')}</span>
                    {node.app ? <span className="flow-node__app font-mono">{node.app}</span> : null}
                  </div>
                  <span className="flow-node__title" title={node.label}>
                    {node.label}
                  </span>
                </div>
              </button>
            )
          })}
          </div>
        </div>
      </div>
    </section>
  )
}
