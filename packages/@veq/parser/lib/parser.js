'use strict'

const espree = require('espree')
const eslintScope = require('eslint-scope')
const estraverse = require('estraverse')
const uuid = require('uuid').v4

const server = 'server', client = 'client'

const identifiersFromLabelNode = label => {
  const childNode = label.body.expression
  if (childNode.type === 'Identifier') {
    // on: server
    return [ childNode ]
  }
  else if (childNode.type === 'SequenceExpression') {
    // on: server, client
    if (childNode.expressions.some(node => node.type !== 'Identifier')) throw new SyntaxError('TODO')
    return childNode.expressions
  }
  throw new SyntaxError('TODO')
}
class NodeState {
  constructor (labelNode) {
    /** @type { import('estree').Identifier[] } */
    this.sideIdentifiers = identifiersFromLabelNode(labelNode)
    // TODO
    this.global = false
    this.sessionRequired = false
    // TODO: check sides
    /** @type { ('server' | 'client')[] } */
    this.sides = this.sideIdentifiers.map(id => id.name)
    /** @type { Set<string> } */
    this.inNames = new Set()
    /** @type { Set<string> } */
    this.outNames = new Set()
    // TODO: pick a better ID
    this.id = uuid()
  }
}

/** @param { string } source */
const parse = exports.parse = source => {
  /** @type { import('estree').Program } */
  const ast = espree.parse(source, { ecmaVersion: 12, sourceType: 'module', range: true })
  if (ast.body[0].type !== 'LabeledStatement' || ast.body[0].label.name !== 'on') {
    throw new SyntaxError('TODO')
  }
  const scopeManager = eslintScope.analyze(ast)
  /** @type { import('estree').LabeledStatement[] } */
  const onLabels = []
  /** @type { Map<import('estree').LabeledStatement, NodeState> } */
  const nodeState = new Map()
  const functionTypes = [ 'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression' ]
  const functionStack = []
  estraverse.traverse(ast, {
    enter (node) {
      if (functionTypes.includes(node.type)) functionStack.unshift(node)
      if (node.type === 'LabeledStatement' && node.label.name === 'on') {
        if (functionStack[0] && !functionStack[0].async) throw new SyntaxError('TODO')
        if (node.body.type !== 'ExpressionStatement') throw new SyntaxError('TODO')
        nodeState.set(node, new NodeState(node))
        onLabels.push(node)
        return estraverse.VisitorOption.Skip
      }
    },
    leave (node) { if (functionStack[0] === node) functionStack.shift() }
  })
  onLabels.sort((a, b) => a.range[0] - b.range[0])
  /*
   * TODO: parse code blocks
   * example:
   * 
   * on: client
   * console.log(1)
   * try {
   *   on: server
   *   console.log(2)
   * } catch (e) { // HERE
   *   console.log(3) // should be on client
   * }
   */
  const onBlocks = onLabels.map((label, i) => ({ label, start: label.range[1], end: i === onLabels.length - 1 ? source.length : onLabels[i + 1].range[0] }))
  const blockFromNode = node => onBlocks.find(block => block.end >= node.end)
  if (functionStack.length !== 0) throw new Error('TODO')
  const onIdentifiers = onLabels.flatMap(label => label.sideIdentifiers)
  /** @type { import('eslint-scope').Reference[] } */
  const references = scopeManager
    .scopes
    .flatMap(scope => scope.references)
    .filter(ref => !onIdentifiers.includes(ref.identifier))
  for (const ref of references) {
    if (!ref.resolved) continue
    const { identifier, resolved } = ref
    const identifierBlock = blockFromNode(identifier)
    const resolvedBlock = blockFromNode(resolved.defs[0].name)
    if (identifierBlock === resolvedBlock) continue
    const identifierState = nodeState.get(identifierBlock.label)
    const resolvedState = nodeState.get(resolvedBlock.label)
    if ([ identifierState, resolvedState ].every(state => state.sides.includes(server))) {
      identifierState.sessionRequired = true
      continue
    }
    if ([ identifierState, resolvedState ].every(state => state.sides.includes(client))) continue
    identifierState.inNames.add(identifier.name)
    resolvedState.outNames.add(identifier.name)
  }
  return {
    server: onBlocks
      .filter(block => nodeState.get(block.label).sides.includes(server))
      .map(block => {
        const state = nodeState.get(block.label)
        return {
          id: state.id,
          sessionRequired: state.sessionRequired,
          code: `
; ${state.inNames.size > 0 ? `const { ${Array.from(state.inNames).join(', ') } } = __veqIn` : '' }
; ${source.slice(block.start, block.end)}
; __veqOut = { ${ Array.from(state.outNames).join(', ') } }
;`,
        }
      }),
  }
}

const code = require('fs').readFileSync(require.resolve('../../../example/todo.vue')).toString()
const result = parse(code.slice(code.indexOf('<script>') + 9, code.indexOf('</script>')))

console.log(result.server.map(x => x.code).join('\n\n'))
