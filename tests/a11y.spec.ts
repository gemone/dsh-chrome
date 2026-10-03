import { describe, expect, it } from 'vitest'
import {
  formatAxNodeLine,
  formatAxProperties,
  formatAxTree,
  storageReadExpression,
  storageWriteExpression,
  type RawAxNode,
} from '../src/a11y.ts'

function node(overrides: Partial<RawAxNode> & { nodeId: string }): RawAxNode {
  return { role: { value: 'generic' }, ...overrides }
}

describe('AX node formatting', () => {
  it('renders role, name, value, description, and ignored flag', () => {
    expect(formatAxNodeLine(node({ nodeId: '1' }))).toBe('generic')
    expect(formatAxNodeLine(node({ nodeId: '1', role: { value: 'heading' }, name: { value: 'Hello' } }))).toBe('heading "Hello"')
    expect(formatAxNodeLine(node({ nodeId: '1', role: { value: 'textbox' }, value: { value: 'typed text' } }))).toBe('textbox = typed text')
    expect(formatAxNodeLine(node({ nodeId: '1', description: { value: 'helper text' } }))).toBe('generic — helper text')
    expect(formatAxNodeLine(node({ nodeId: '1', ignored: true }))).toBe('generic [ignored]')
  })

  it('renders only meaningful state properties', () => {
    const line = formatAxNodeLine(node({
      nodeId: '1',
      properties: [
        { name: 'focused', value: { value: true } },
        { name: 'disabled', value: { value: false } },
        { name: 'level', value: { value: 2 } },
        { name: 'expanded', value: { value: true } },
        { name: 'irrelevant', value: { value: 'skip' } },
      ],
    }))
    expect(line).toContain('[focused, expanded, level=2]')
    expect(line).not.toContain('disabled')
    expect(line).not.toContain('irrelevant')
  })

  it('formatAxProperties handles missing properties', () => {
    expect(formatAxProperties({ nodeId: '1' })).toBe('')
  })
})

describe('AX tree formatting', () => {
  const tree: RawAxNode[] = [
    node({ nodeId: 'root', role: { value: 'main' }, childIds: ['a', 'b'] }),
    node({ nodeId: 'a', role: { value: 'heading' }, name: { value: 'Title' } }),
    node({ nodeId: 'b', role: { value: 'button' }, name: { value: 'Go' }, childIds: ['c'] }),
    node({ nodeId: 'c', role: { value: 'StaticText' }, name: { value: 'Go' } }),
  ]

  it('renders an indented depth-first tree from roots', () => {
    const result = formatAxTree(tree, 10)
    expect(result.count).toBe(4)
    expect(result.truncated).toBe(false)
    expect(result.tree.split('\n')).toEqual([
      '- main',
      '  - heading "Title"',
      '  - button "Go"',
      '    - StaticText "Go"',
    ])
  })

  it('truncates at the node budget (roots first)', () => {
    const result = formatAxTree(tree, 2)
    expect(result.count).toBe(2)
    expect(result.truncated).toBe(true)
    expect(result.tree).not.toContain('button')
  })

  it('tolerates orphan nodes (children whose parent is missing)', () => {
    const orphans: RawAxNode[] = [
      node({ nodeId: 'x', role: { value: 'link' }, name: { value: 'orphan' } }),
      node({ nodeId: 'y', role: { value: 'list' }, childIds: ['missing'] }),
    ]
    const result = formatAxTree(orphans, 10)
    expect(result.count).toBe(2)
    expect(result.tree).toContain('link "orphan"')
  })
})

describe('web-storage expressions', () => {
  it('reads a single key and all keys with caps', () => {
    expect(storageReadExpression('local', 'token', 100))
      .toBe('(() => { const v = localStorage.getItem("token"); return JSON.stringify({ found: v !== null, value: v }); })()')
    const all = storageReadExpression('session', undefined, 50)
    expect(all).toContain('sessionStorage')
    expect(all).toContain('slice(0, 50)')
  })

  it('escapes keys and values via JSON.stringify', () => {
    const set = storageWriteExpression('local', 'set', 'ke"y', 'va"l\\ue')
    expect(set).toContain('"ke\\"y"')
    expect(set).toContain('"va\\"l\\\\ue"')
    expect(storageWriteExpression('session', 'remove', 'k', undefined)).toContain('sessionStorage.removeItem("k")')
    expect(storageWriteExpression('local', 'clear', undefined, undefined)).toContain('localStorage.clear()')
  })
})
