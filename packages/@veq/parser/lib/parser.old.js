'use strict'

const { parse: acornParse } = require('acorn')
const walk = require('acorn-walk')
const assert = require('assert')

const onLabelSidesFromNode = node => {
  assert.equal(node.body.type, 'ExpressionStatement')
  const sideNode = node.body.expression
  const sides = []
  if (sideNode.type === 'Identifier') sides.push(sideNode.name)
  else if (sideNode.type === 'SequenceExpression') {
    assert(sideNode.expressions.every(node => node.type === 'Identifier'))
    sides.push(...sideNode.expressions.map(node => node.name))
  }
  assert(sides.every(side => [ 'server', 'client' ].includes(side)), 'invalid side')
  return sides
}

const walkAll = (o, c) => {
  for (const k in o) {
    c(o[k])
    if (typeof o[k] === 'object') walkAll(o[k], c)
  }
}

const sharedAdd = name => `$$shared.add('${name}', ${name})`
const varCodeFromNode = (node, source) => {
  switch (node.type) {
    case 'Identifier': // shorthand
      return `; ${sharedAdd(node.name)};`
    case 'AssignmentExpression': {
      const leftNode = node.left
      if (leftNode.type === 'Identifier') {
        return `; const ${leftNode.name} = ${source.slice(node.right.start, node.right.end)}; ${sharedAdd(leftNode.name)};`
      }
      if (leftNode.type === 'ObjectPattern' || leftNode.type === 'ArrayPattern') {
        const keyNames = []
        walkAll(leftNode, node => node && node.type === 'Identifier' && keyNames.push(node.name))
        return `; const ${source.slice(node.start, node.end)}; ${Array.from(new Set(keyNames)).map(sharedAdd).join('; ')};`
      }
      throw new SyntaxError('shared: unacceptable code')
    }
    default:
      throw new SyntaxError('shared: unacceptable code type')
  }
}

const parseShared = (node, source) => {
  switch (node.type) {
    case 'Identifier': // shorthand
      return { identifiers: [ node.name ], code: '' }
    case 'AssignmentExpression': {
      const leftNode = node.left
      if (leftNode.type === 'Identifier') return {
        identifiers: [ leftNode.name ],
        code: `; const ${leftNode.name} = ${source.slice(node.right.start, node.right.end)};`,
      }
      if (leftNode.type === 'ObjectPattern' || leftNode.type === 'ArrayPattern') {
        const keyNames = []
        walkAll(leftNode, node => node && node.type === 'Identifier' && keyNames.push(node.name))
        return { identifiers: Array.from(new Set(keyNames)), code: `; const ${source.slice(node.start, node.end)};` }
      }
      throw new SyntaxError('shared: unacceptable code')
    }
    default:
      throw new SyntaxError('shared: unacceptable code type')
  }
}

const functionTypes = [ 'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression' ]
const parentTypes = [ ...functionTypes, 'Program' ]
const blockTypes = [ 'BlockStatement', 'Program' ]

const typeFromSides = sides => {
  sides = Array.from(new Set(sides))
  if (sides.length === 1) return { server: 's', client: 'c' }[sides[0]]
  if (sides.length === 2) {
    if (sides.includes('server') && sides.includes('client')) return 'cs'
  }
  throw new SyntaxError(`sides ${sides.join(', ')} are not allowed`)
}
const parentFromAncestors = ancestors => ancestors.filter(n => parentTypes.includes(n.type)).reduceRight(n => n)
const blockFromAncestors = ancestors => ancestors.filter(n => blockTypes.includes(n.type)).reduceRight(n => n)
const pushIfInBlock = (array, block) => (node, ancestors) => blockFromAncestors(ancestors) === block ? array.push(node) : null
const pushIfEqualTo = (array, node) => node1 => node1 === node ? array.push(node) : null
const nodeEnv = (node, block) => {
  const nodes = []
  walk.ancestor(block, {
    [node.type]: pushIfEqualTo(nodes, node),
    LabeledStatement: pushIfInBlock(nodes, block),
  })
  console.log(nodes)
  const index = nodes.indexOf(node)
  const findOnLabel = nodes => nodes.find(node => node.type === 'LabeledStatement' && node.label.name === 'on') || null
  const nextOnLabel = findOnLabel(nodes.slice(index + 1))
  const prevOnLabel = findOnLabel(nodes.slice(0, index).reverse())
  const start = prevOnLabel ? prevOnLabel.end : block.start
  const end = nextOnLabel ? nextOnLabel.start : block.end
  return { block, blockLabels: nodes, nextOnLabel, prevOnLabel, start, end }
}
const blockIsInScope = (parent, child) => {
  if (parent === child) return true
  let isInScope = false
  walk.ancestor(parent, {
    [child.type] (node, ancestors) {
      if (node === child && parentFromAncestors(ancestors) === parent) isInScope = true
    },
  })
  return isInScope
}
class ControlBlock {
  constructor (options) {
    for (const key in options) this[key] = options[key]
    if (!this.slots) this.slots = []
  }

  static fromAst (ast, source) {
    const type = ast.type === 'BlockStatement' ? 'b' : ast.type === 'Program' ? 'p' : ''
    assert.notStrictEqual(type, '', 'CB.fromAst: Invalid root node type')
    const isRoot = ast.type === 'Program'
    if (isRoot) ast.parent = ast
    const root = new ControlBlock({ start: ast.start, end: ast.end, type, code: source.slice(ast.start, ast.end) })
    const onEntries = [ { virtual: true, prev: null, sides: 'c', start: ast.start, block: ast } ]
    const blocks = new Set()
    walk.ancestor(ast.parent, {
      LabeledStatement (labelNode, ancestors) {
        if (labelNode.label.name !== 'on') return
        const block = blockFromAncestors(ancestors)
        if (isRoot) {
          const parent = parentFromAncestors(ancestors)
          if (!parent.async && parent.type !== 'Program') throw new SyntaxError('on: is only allowed in async functions and root')
          block.parent = parent
        }
        if (block !== ast) return blocks.add(block)
        const { prevOnLabel, nextOnLabel, end } = nodeEnv(labelNode, block)
        const sides = onLabelSidesFromNode(labelNode)
        onEntries.push({ node: labelNode, prev: prevOnLabel, next: nextOnLabel, sides, start: labelNode.end, end, block })
      },
    })
    onEntries[0].next = onEntries[1] ? onEntries[1].node : null
    onEntries[0].end = onEntries[1] ? onEntries[1].start : null
    for (const block of blocks) root.slots.push(ControlBlock.fromAst(block, source))
    const onBlocks = onEntries.map(n => new ControlBlock({ start: n.start, end: n.end, type: typeFromSides(n.sides), shared: new Set(), code: source.slice(n.start, n.end) }))
    for (const [ k, b ] of onBlocks.entries()) {
      const onEntry = onEntries[k]
      if (onEntry.prev) b.prev = onBlocks[onEntries.findIndex(s => s.node === onEntry.prev)]
      if (onEntry.next) b.next = onBlocks[onEntries.findIndex(s => s.node === onEntry.next)]
      // TODO: improve efficiency
      walk.ancestor(ast.parent, {
        LabeledStatement (labelNode, ancestors) {
          if (labelNode.label.name !== 'shared') return
          if (labelNode.start > onEntry.end || labelNode.end < onEntry.start) return
          const block = blockFromAncestors(ancestors)
          if (!block.parent || !blockIsInScope(block.parent, onEntry.block)) return
          assert(!isRoot, 'shared: is not available on root scope')
          assert.strictEqual(labelNode.body.type, 'ExpressionStatement')
          const { prevOnLabel } = nodeEnv(labelNode, block.parent)
          const contextArray = prevOnLabel ? onLabelSidesFromNode(prevOnLabel) : [ 'client' ]
          assert.strictEqual(contextArray.length, 1, 'shared: is not available in common code slices')
          const { identifiers, code } = parseShared(labelNode.body.expression, source)
          root.slots.push(new ControlBlock({ type: 'r', start: labelNode.start, end: labelNode.end, code }))
          identifiers.forEach(i => b.shared.add(i))
        },
      })
    }
    root.slots.push(...onBlocks)
    return root
  }
}

const walkBlock = (node, source, modifications, isRoot) => {
  const labelNodes = []
  const sharedCode = []
  walk.ancestor(node, {
    LabeledStatement (labelNode, ancestors) {
      const label = labelNode.label.name
      const parent = ancestors.filter(node => parentTypes.includes(node.type)).reduceRight(a => a)
      if (parent !== node || (label !== 'on' && label !== 'shared')) return
      if (!node.async && !isRoot) throw new SyntaxError('on: and shared: is only allowed in async functions and root')
      const block = ancestors.filter(n => blockTypes.includes(n.type)).reduceRight(n => n)
      const blockLabels = []
      walk.ancestor(block, {
        LabeledStatement (innerLabelNode, ancestors) {
          const innerBlock = ancestors.filter(n => blockTypes.includes(n.type)).reduceRight(n => n)
          if (innerBlock !== block) return
          blockLabels.push(innerLabelNode)
        },
      })
      const labelPosition = blockLabels.indexOf(labelNode)
      const nextOnLabel = blockLabels.slice(labelPosition).find(node => node.label.name === 'on') || null
      const lastOnLabel = blockLabels.slice(0, labelPosition - 1).find(node => node.label.name === 'on') || null
      switch (label) {
        case 'on': {
          const sides = onLabelSidesFromNode(labelNode)
          const nextSides = nextOnLabel ? onLabelSidesFromNode(nextOnLabel) : null

          // server
          if (sides.includes('server')) if (isRoot) {
            if (!nextOnLabel || !nextSides.includes('server')) {
              const start = labelNode.end
              const end = nextOnLabel ? nextOnLabel.start : node.end
              modifications.server.push({ start, end })
            }
          } else { // not root
            // TODO: dedupe
            if (!nextOnLabel || !nextSides.includes('server')) {
              const start = labelNode.end
              const end = nextOnLabel ? nextOnLabel.start : node.end
              labelNodes.push({ node: labelNode, start, end })
            }
          }

          // client
          // TODO
          break
        }

        case 'shared': {
          assert(!isRoot, 'shared: is not available on root scope')
          assert.equal(labelNode.body.type, 'ExpressionStatement')
          const varNode = labelNode.body.expression
          const contextArray = lastOnLabel ? onLabelSidesFromNode(lastOnLabel) : [ 'client' ]
          assert.equal(contextArray.length, 1, 'shared: is not available in common code slices')
          const isClient = context === 'client'
          const varCode = varCodeFromNode(varNode, source)
          // TODO
        }
      }
    },
  })
}

const parse = exports.parse = function parse (source) {
  const ast = acornParse(source, { sourceType: 'module', ecmaVersion: 'latest' })
  const cb = ControlBlock.fromAst(ast, source)
  console.log(require('circular-json').stringify(cb, null, 2))
  return
  const modifications = { server: [], client: [] }
  const blockVisitors = { Program: node => walkBlock(node, source, modifications, true) }
  for (const f of functionTypes) blockVisitors[f] = node => walkBlock(node, source, modifications, false)
  walk.simple(ast, blockVisitors)
  console.log(modifications.server.map(({ start, end }) => source.slice(start, end)))
}

const code = require('fs').readFileSync(require.resolve('../../../example/todo.vue')).toString()
parse(code.slice(code.indexOf('<script>') + 9, code.indexOf('</script>')))
