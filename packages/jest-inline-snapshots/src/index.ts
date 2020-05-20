import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

import * as json5 from 'json5'

import {AsymmetricMatcher} from 'expect/build/asymmetricMatchers'

import * as parser from '@babel/parser'
import traverse from '@babel/traverse'
import generate from '@babel/generator'
import * as bt from '@babel/types'
import {deepKeys, get, set} from './deep-keys'

// stolen from https://github.com/errwischt/stacktrace-parser/blob/3dec2937958f1c867e22bea7ae287d6085cf5266/src/stack-trace-parser.js#L121
const nodeRe = /^\s*at (?:((?:\[object object\])?[^\\/]+(?: \[as \S+\])?) )?\(?(.*?):(\d+)(?::(\d+))?\)?\s*$/i

type StackLine = ReturnType<typeof parseStackLine>
const parseStackLine = (line: string) => {
  const parts = nodeRe.exec(line)

  if (!parts) {
    return null
  }

  return {
    line,
    file: parts[2],
    methodName: parts[1] || 'UNKNOWN_FUNCTION',
    arguments: [],
    lineNumber: +parts[3],
    column: parts[4] ? +parts[4] : null,
  }
}

const parseStack = (stack: string | undefined) => (stack || '').split(/\r?\n/).slice(1).map(parseStackLine)

const filterStack = (stack: string | undefined, fn: (line: StackLine, index: number, array: StackLine[]) => unknown) =>
  stack &&
  parseStack(stack)
    .filter(fn)
    .map(line => line?.line)
    .join(os.EOL)
    .replace(/\r?\n\s+\n/g, os.EOL)

/** returns the parsed stack frame for the external call site. */
const getCallSite = () =>
  parseStack(Error().stack).find(s => s?.file && path.resolve(s.file) !== path.resolve(__filename)) || undefined

export const getClosingParen = (code: string, from: number, style = '()'): number => {
  const [open, close] = style.split('')
  if (code[from] !== open) {
    throw Error(`must start with a ${open} character`)
  }
  const recurse = (code: string, from: number): number => {
    if (from >= code.length) throw Error(`Expected to find ${close} but reached end of text`)
    if (code[from] === close) return from
    const next = from + 1
    if (code[next] === open) {
      const innerClose = recurse(code, next)
      return recurse(code, innerClose + 1)
    }
    return recurse(code, next)
  }
  return recurse(code, from)
}

export type Format = (code: string, filePath: string) => string | Promise<string>
export const defaultFormatter = ((): Format => {
  const ESLint = (() => {
    try {
      return require('eslint').ESLint
    } catch (e) {
      return null
    }
  })()
  if (!ESLint) {
    return code => code
  }
  const eslint = new ESLint({fix: true})
  return async (code, filePath) => {
    const [linted] = await eslint.lintText(code, {filePath})
    return linted.output || code
  }
})()

export const formatter = {
  format: defaultFormatter,
}

type Replacement = {start: number; end: number; text: string; file: string}
const replacements: Record<string, Replacement[]> = {}
afterAll(() =>
  Promise.all(
    Object.entries(replacements).map(async ([file, reps]) => {
      const unformattedCode = reps.reduceRight(
        (code, r) => code.slice(0, r.start) + r.text + code.slice(r.end),
        fs.readFileSync(file).toString()
      )
      fs.writeFileSync(file, await formatter.format(unformattedCode, file), 'utf8')
      console.log(`Updated ${reps.length} snapshot(s) in ${file}`)
    })
  )
)

const guessFormatting = (code: string) => {
  const lines = code.split(/\r?\n/)
  const withIndent = lines.map(s => s.match(/^\s+/)!).filter(Boolean)
  const minIndent = withIndent.sort((left, right) => left[0].length - right[0].length)[0]
  const quote = [`'`, `"`]
    .map(type => ({type, count: code.split(type).length}))
    .sort((left, right) => right.count - left.count)[0].type
  return {
    indent: minIndent?.[0] || '  ',
    quote,
  }
}

const REPLACEMENT_MARKER =
  'a_marker_to_allow_json5_to_parse_and_stringify_snapshot_objects_that_include_asymmetric_matchers_but_which_is_extremely_unlikely_to_be_found_in_any_real_snapshots_also_contains_no_special_characters_only_letters_and_underscores'

const replacementToken = (text: string) => `${REPLACEMENT_MARKER}__${Buffer.from(text).toString('base64')}`

export const expectShim = Object.assign(
  <T>(actual: T) => {
    const toMatchInlineSnapshot = (...args: unknown[]) => {
      try {
        if (args.length > 1) {
          throw Error(`String snapshot format is being used - updating will automatically migrate to object snapshots.`)
        }
        expect(actual).toEqual(args[0])
      } catch (assertError) {
        const errorPrefix = (() => {
          if (process.argv.includes('-u') || process.argv.includes('--updateSnapshot')) {
            return undefined
          }
          if (args.length == 0) {
            return (
              process.env.CI &&
              [
                'New snapshot was not written. The update flag must be explicitly passed to write a new snapshot.',
                'This is likely because this test is run in a continuous integration (CI) environment in which snapshots are not written by default.',
              ].join('\n\n')
            )
          }
          return `Snapshot failure (rerun with '-u' to update)`
        })()

        if (errorPrefix) {
          rethrowFromCallSite(assertError, errorPrefix)
        }

        const callSite = getCallSite()
        if (!callSite?.file) {
          throw Error(`Couldn't get call site to update snapshot after failure:\n\n${assertError}`)
        }

        const content = fs.readFileSync(callSite.file).toString()
        const lines = content.split('\n')
        const lineStart = lines.slice(0, callSite.lineNumber - 1).join('\n').length + 1

        const formatting = guessFormatting(content)
        const lineIndent = lines[callSite.lineNumber - 1].match(/^\s+/)?.[0] || formatting.indent

        const toMatchStart = content.indexOf('.toMatch', lineStart)
        const parenStart = content.indexOf('(', toMatchStart)
        const parenEnd = getClosingParen(content, parenStart)

        const snapObjVar = content.slice(parenStart + 1, parenEnd)
        const withStringPlaceholders = replaceAsymmetricMatchers(snapObjVar)

        // todo check `actual && typeof actual === 'object'` rather than `startsWith`
        const clonedActualValue = snapObjVar.startsWith('{') ? {} : actual
        const asymmetricMatchers = {}

        deepKeys(actual).forEach(path => {
          const placeholderLeafValue = get(withStringPlaceholders, path)
          const actualLeafValue = get(actual, path)

          const cloneValue =
            typeof placeholderLeafValue === 'string' && placeholderLeafValue.startsWith(REPLACEMENT_MARKER)
              ? placeholderLeafValue
              : actualLeafValue

          set(clonedActualValue, path, cloneValue)
          set(asymmetricMatchers, path, get(actual, path))
        })

        const isAsymmetricMatcher = (value: unknown) => value instanceof AsymmetricMatcher
        let asymmetricMatchersUsed = false
        deepKeys(args[0], isAsymmetricMatcher).forEach(path => {
          const value = get(args[0], path)
          if (isAsymmetricMatcher(value)) {
            asymmetricMatchersUsed = true
            set(asymmetricMatchers, path, value)
          }
        })

        const multiline = json5
          .stringify(clonedActualValue, {
            space: formatting.indent,
            quote: formatting.quote,
            replacer: (_key, val) => (typeof val === 'function' ? replacementToken('expect.any(Function)') : val),
          })
          .replace(/(\r?\n)/g, `$1${lineIndent}`)

        const jsonWithPlaceholders =
          multiline.length >= 40 || snapObjVar?.includes('\n')
            ? multiline
            : multiline.replace(/\n\s+/g, ' ').replace(/, }$/, ' }')

        const jsonWithReplacements = jsonWithPlaceholders.replace(
          new RegExp(`['"]${REPLACEMENT_MARKER}__([\\w=]+)['"]`, 'g'),
          (_match, b64) => Buffer.from(b64, 'base64').toString()
        )

        if (asymmetricMatchersUsed) {
          try {
            expect(actual).toMatchObject(asymmetricMatchers)
          } catch (e) {
            const prefix = `Explicit asymmetric matcher conditions were not satisfied. These must be removed manually to fix.\n${e.message}`
            rethrowFromCallSite(e, prefix)
          }
        }

        const replacement = {start: parenStart + 1, end: parenEnd, text: jsonWithReplacements, file: callSite.file}

        const lineAndColumn = (position: number) => {
          const lines = content.slice(0, position).split('\n')
          return {line: lines.length, column: lines[lines.length - 1].length}
        }
        const pos = lineAndColumn(replacement.start + 1)
        console.log(`Found snapshot to update at ${replacement.file}:${pos.line}:${pos.column}`)

        replacements[callSite.file] = replacements[callSite.file] || []
        replacements[callSite.file].push(replacement)
      }
    }
    return {toMatchInlineSnapshot}
  },
  {
    register: () => {
      const _global: {expect: typeof expect} = global as any
      const jestExpect = _global.expect

      _global.expect = Object.assign((...args: Parameters<typeof expect>) => {
        const expecter = jestExpect(...args)
        expecter.toMatchInlineSnapshot = (...snapshotArgs: any[]) =>
          expectShim(...args).toMatchInlineSnapshot(...snapshotArgs)
        return expecter
      }, jestExpect)
    },
  }
)

function replaceAsymmetricMatchers(snapObjVar: string) {
  const snapObjCode = `(${snapObjVar || '{}'})` // turns a literal into valid standalone javascript, even if there are two function args
  // limitations: only basic data expressions are allowed
  // no awaits, no casts like `as any`, no typescript- or flow-specific syntax of any kind
  // it has to be valid json5, except for things like `expect.anything()`
  const ast = parser.parse(snapObjCode)
  traverse(ast, {
    CallExpression: path => {
      if (typeof path.node.start === 'number' && typeof path.node.end === 'number') {
        const b64 = Buffer.from(snapObjCode.slice(path.node.start, path.node.end)).toString('base64')
        path.replaceWith(bt.stringLiteral(`${REPLACEMENT_MARKER}__${b64}`))
      }
    },
    SequenceExpression: path => {
      path.replaceWith(path.node.expressions[0])
    },
  })
  const withStringPlaceholders = json5.parse(
    generate(ast)
      .code.replace(/^\(/, '')
      .replace(/\)?;?$/, '')
  )
  return withStringPlaceholders
}

function rethrowFromCallSite(assertError: any, prefix: string): never {
  assertError.message = `${prefix}\n${assertError}`.trim()
  assertError.stack = filterStack(
    assertError.stack,
    frame => !frame?.file || path.resolve(frame.file) !== path.resolve(__filename)
  )
  throw assertError
}