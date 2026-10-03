/**
 * Accessibility-tree reading: types plus a pure formatter that turns the
 * `Accessibility.getFullAXTree` node list into a bounded, indented tree the
 * model can read (roles, names, and states). Unit-testable without a browser.
 * @module dsh-chrome/a11y
 */

/** Raw shape of one `Accessibility.getFullAXTree` node (subset we consume). */
export interface RawAxNode {
  nodeId: string
  ignored?: boolean
  role?: { value?: string }
  name?: { value?: unknown }
  value?: { value?: unknown }
  description?: { value?: unknown }
  properties?: Array<{ name?: string; value?: { value?: unknown } }>
  childIds?: string[]
}

/** Result of formatting one accessibility tree. */
export interface A11yTreeResult {
  /** Indented element tree with roles, names, and states. */
  tree: string
  /** Number of nodes rendered. */
  count: number
  /** Whether the node budget cut the walk short. */
  truncated: boolean
}

/** Properties worth surfacing in a node line, in display order. */
const SHOWN_PROPERTIES = [
  'focused',
  'focusable',
  'disabled',
  'required',
  'expanded',
  'checked',
  'pressed',
  'readonly',
  'multiselectable',
  'invalid',
  'autocomplete',
  'level',
  'valuenow',
  'valuetext',
] as const

/**
 * Render one AX node's interesting state properties as a `[k=v, …]` suffix.
 * Pure.
 */
export function formatAxProperties(node: RawAxNode): string {
  const byName = new Map<string, unknown>()
  for (const property of node.properties ?? []) {
    if (typeof property.name === 'string') byName.set(property.name, property.value?.value)
  }
  const parts: string[] = []
  for (const name of SHOWN_PROPERTIES) {
    if (!byName.has(name)) continue
    const value = byName.get(name)
    if (value === undefined || value === null || value === '' || value === false) continue
    parts.push(value === true ? name : `${name}=${String(value)}`)
  }
  return parts.length > 0 ? ` [${parts.join(', ')}]` : ''
}

/** Render one AX node as a single line (without indentation). Pure. */
export function formatAxNodeLine(node: RawAxNode): string {
  const role = node.role?.value ?? 'unknown'
  const name = typeof node.name?.value === 'string' && node.name.value.length > 0 ? ` "${node.name.value}"` : ''
  const description = typeof node.description?.value === 'string' && node.description.value.length > 0
    ? ` — ${node.description.value}`
    : ''
  const value = node.value?.value !== undefined && node.value?.value !== null && node.value?.value !== ''
    ? ` = ${String(node.value.value)}`
    : ''
  const ignored = node.ignored === true ? ' [ignored]' : ''
  return `${role}${name}${value}${description}${ignored}${formatAxProperties(node)}`
}

/**
 * Format a full AX node list as an indented tree, bounded by `maxNodes`
 * (depth-first from the roots — nodes with no parent in the list). Pure.
 *
 * Two readability prunes: presentation wrappers (role `none`, ignored) are
 * hoisted — their children render at the same depth — and `InlineTextBox`
 * implementation leaves are dropped entirely.
 */
export function formatAxTree(nodes: readonly RawAxNode[], maxNodes: number): A11yTreeResult {
  const byId = new Map(nodes.map(node => [node.nodeId, node]))
  const hasParent = new Set<string>()
  for (const node of nodes) {
    for (const childId of node.childIds ?? []) hasParent.add(childId)
  }
  const roots = nodes.filter(node => !hasParent.has(node.nodeId))
  const lines: string[] = []
  let truncated = false

  const isWrapper = (node: RawAxNode): boolean =>
    (node.role?.value ?? 'unknown') === 'none' && node.ignored === true
  const isNoise = (node: RawAxNode): boolean =>
    (node.role?.value ?? '') === 'InlineTextBox'

  const walk = (node: RawAxNode, depth: number): void => {
    if (isNoise(node)) return
    if (lines.length >= maxNodes) {
      truncated = true
      return
    }
    if (!isWrapper(node)) lines.push(`${'  '.repeat(depth)}- ${formatAxNodeLine(node)}`)
    for (const childId of node.childIds ?? []) {
      if (lines.length >= maxNodes) {
        truncated = true
        return
      }
      const child = byId.get(childId)
      if (child !== undefined) walk(child, isWrapper(node) ? depth : depth + 1)
    }
  }
  for (const root of roots) {
    if (lines.length >= maxNodes) {
      truncated = true
      break
    }
    walk(root, 0)
  }
  return { tree: lines.join('\n'), count: lines.length, truncated: truncated || lines.length >= maxNodes }
}

/**
 * Build a JS expression string that reads web storage bounded, as JSON.
 * Keys and values are embedded via JSON.stringify. Pure.
 */
export function storageReadExpression(kind: 'local' | 'session', key: string | undefined, maxChars: number): string {
  const store = kind === 'local' ? 'localStorage' : 'sessionStorage'
  if (key !== undefined) {
    const literal = JSON.stringify(key)
    return `(() => { const v = ${store}.getItem(${literal}); return JSON.stringify({ found: v !== null, value: v }); })()`
  }
  return `(() => { const s = ${store}; const out = {}; for (let i = 0; i < s.length; i++) { const k = s.key(i); let v = s.getItem(k) ?? ''; if (v.length > ${Math.max(0, Math.floor(maxChars))}) v = v.slice(0, ${Math.max(0, Math.floor(maxChars))}) + '…'; out[k] = v; } return JSON.stringify({ entries: out }); })()`
}

/** Build a JS expression that writes/removes/clears web storage. Pure. */
export function storageWriteExpression(
  kind: 'local' | 'session',
  operation: 'set' | 'remove' | 'clear',
  key: string | undefined,
  value: string | undefined,
): string {
  const store = kind === 'local' ? 'localStorage' : 'sessionStorage'
  switch (operation) {
    case 'set':
      return `${store}.setItem(${JSON.stringify(key ?? '')}, ${JSON.stringify(value ?? '')}); JSON.stringify({ ok: true })`
    case 'remove':
      return `${store}.removeItem(${JSON.stringify(key ?? '')}); JSON.stringify({ ok: true })`
    case 'clear':
      return `${store}.clear(); JSON.stringify({ ok: true, cleared: 'all' })`
  }
}
