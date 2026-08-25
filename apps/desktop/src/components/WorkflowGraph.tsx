import { useId, useMemo, useState } from 'react'
import {
  Check,
  Clock3,
  FileSpreadsheet,
  FileText,
  Files,
  FolderOpen,
  GitBranch,
  Layers,
  Mail,
  Terminal,
  Zap,
} from 'lucide-react'
import type { Workflow, WorkflowNode } from '@workflow-skill/workflow-model'

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
  const graphLabelId = useId()
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(null)

  const activeSelectedId = controlledSelectedId !== undefined ? controlledSelectedId : internalSelectedId

  // Topological Column Assignment & Smooth Spline Calculation
  const layout = useMemo(() => {
    const nodes = workflow.nodes
    const edges = workflow.edges

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

    if (queue.length === 0 && nodes.length > 0) {
      colAssign[nodes[0].id] = 0
      queue.push(nodes[0].id)
    }

    while (queue.length > 0) {
      const curr = queue.shift()!
      const currCol = colAssign[curr] ?? 0
      for (const next of outgoing[curr] || []) {
        const nextCol = Math.max(colAssign[next] ?? 0, currCol + 1)
        colAssign[next] = nextCol
        queue.push(next)
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
    const centerY = 120

    const layoutNodes: LayoutNode[] = []
    const nodePosMap: Record<string, { x: number; y: number; width: number; height: number }> = {}

    const colKeys = Object.keys(columns)
      .map(Number)
      .sort((a, b) => a - b)

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
    const stageHeight = 240

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

  if (compact) {
    return (
      <div className="flow-mini-spark" aria-label={`${workflow.name} 步骤简图`}>
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
        {workflow.name} 完整工作流拓扑
      </h3>

      <div className="flow-graph__scroll">
        <div
          className="flow-graph__stage"
          style={{ width: `${layout.stageWidth}px`, height: `${layout.stageHeight}px` }}
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
                    <span className="flow-node__stepnum font-mono">0{stepNum}</span>
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
    </section>
  )
}
