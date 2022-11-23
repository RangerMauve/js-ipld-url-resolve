import { create as createTyped } from '@ipld/schema/typed.js'
import printify from '@ipld/printify'
import { toDSL } from '@ipld/schema/to-dsl.js'

import { CID } from 'multiformats/cid'
import { base32 } from 'multiformats/bases/base32'
import { base36 } from 'multiformats/bases/base36'

import { IPLDURL } from './ipldurl.js'

export const DEFAULT_CID_BASES = base32.decoder.or(base36.decoder)

export class IPLDURLSystem {
  constructor ({
    getNode,
    saveNode,
    adls = new Map(),
    cidBases = DEFAULT_CID_BASES
  }) {
    if (!getNode) throw new TypeError('Must provide a getNode function')
    if (!saveNode) throw new TypeError('Must provide a saveNode function')
    this.getNode = getNode
    this.saveNode = saveNode
    this.adls = adls
    this.cidBases = cidBases
  }

  async resolve (url, { resolveFinalCID = new URL(url).pathname.endsWith('/') } = {}) {
    const { hostname: root, segments, searchParams } = new IPLDURL(url)

    const cid = CID.parse(root, this.cidBases).toV1()
    let data = await this.getNode(cid)

    const initialParameters = {}
    let shouldProcessRoot = false
    if (searchParams.has('schema')) {
      shouldProcessRoot = true
      initialParameters.schema = searchParams.get('schema')
      initialParameters.type = searchParams.get('type')
    }
    if (searchParams.has('adl')) {
      // TODO Should other parameters be passed to the ADL function?
      shouldProcessRoot = true
      initialParameters.adl = searchParams.get('adl')
    }
    if (shouldProcessRoot) {
      data = await this.#applyParameters(data, initialParameters)
    }

    let lastCID = root
    for (const { name, parameters } of segments) {
      // This does enables ADLs to return promises for properties
      data = await data[name]
      lastCID = null
      const asCID = CID.asCID(data)
      if (asCID) {
        lastCID = asCID
        data = await this.getNode(asCID)
      }
      data = await this.#applyParameters(data, parameters)
    }

    if (!resolveFinalCID && lastCID) {
      return lastCID
    }

    return data
  }

  async #applyParameters (origin, { schema, adl, ...parameters }) {
    let data = origin

    const asCID = CID.asCID(data)
    if (asCID) {
      data = await this.getNode(asCID)
    }

    if (schema) {
      data = await SchemaADL(data, { schema, ...parameters }, this)
    }

    if (adl) {
      if (!this.adls.has(adl)) {
        const known = [...this.adls.keys()].join(', ')
        throw new Error(`Unknown ADL type ${adl}. Must be one of ${known}`)
      }
      data = await this.adls.get(adl)(data, parameters, this)
    }

    return data
  }

  async patch (url, patchset) {
    // TODO: Throw error on invalid lenses
    const { hostname: root, segments } = new IPLDURL(url)

    // Track root CID
    let cid = CID.parse(root, this.cidBases).toV1()

    for (const { op, path, value, from } of patchset) {
      const pathSegments = patchPathToSegments(path)
      const allSegments = segments.concat(pathSegments)
      let operation = null
      if (op === 'add') {
        operation = makeAdd(value)
      } else if (op === 'remove') {
        operation = makeRemove()
      } else if (op === 'replace') {
        operation = makeReplace(value)
      } else if (op === 'copy') {
        const fromSegments = patchPathToSegments(from)

        const fromURL = new IPLDURL(url)
        fromURL.hostname = cid.toString()
        fromURL.segments = segments.concat(fromSegments)

        const fromValue = await this.resolve(fromURL.href, { resolveFinalCID: false })

        operation = makeAdd(fromValue)
      } else if (op === 'move') {
        const fromSegments = patchPathToSegments(from)
        const fullFromSegments = segments.concat(fromSegments)

        const fromURL = new IPLDURL(url)
        fromURL.hostname = cid.toString()
        fromURL.segments = fullFromSegments

        const fromValue = await this.resolve(fromURL.href, { resolveFinalCID: false })

        cid = await this.#applyPatch(cid, fullFromSegments, makeRemove())

        operation = makeAdd(fromValue)
      } else if (op === 'test') {
        // TODO: Support deep equals for arrays and objects along with CIDs
        operation = makeEqual(value)
      } else {
        throw new Error(`Invalid patch operation type ${op}`)
      }

      cid = await this.#applyPatch(cid, allSegments, operation)
    }

    // After all the modifications have occured, print the resulting URL
    const finalURL = new IPLDURL(url)
    finalURL.hostname = cid.toV1().toString()

    return finalURL.href
  }

  async #applyPatch (node, segments, operation) {
    // TODO apply / unapply lenses over nodes
    const { name } = segments[0]
    const asCID = CID.asCID(node)

    if (!segments.length) {
      // TODO: How do we account for this?
    }

    if (segments.length === 1) {
      if (asCID) {
        const data = await this.getNode(asCID)

        const modified = operation(data, name)

        const encoding = this.getCidEncoding(asCID)
        const newCID = await this.saveNode(modified, { encoding })

        return newCID
      }
      return operation(node, name)
    } else {
      const [{ name }, ...remainder] = segments

      if (asCID) {
        const data = await this.getNode(asCID)
        if (!(name in data)) throw new Error(`Path ${name} not found in node`)

        const existing = data[name]

        const updated = await this.#applyPatch(existing, remainder, operation)
        const modified = { ...data, [name]: updated }

        const encoding = this.getCidEncoding(asCID)
        const newCID = await this.saveNode(modified, { encoding })
        return newCID
      }
      if (!(name in node)) throw new Error(`Path ${name} not found in node`)
      const existing = node[name]
      const updated = await this.#applyPatch(existing, remainder, operation)
      return {
        ...node,
        [name]: updated
      }
    }
  }

  getCidEncoding (cid) {
    const code = cid.code
    if (code === 0x71) return 'dag-cbor'
    if (code === 0x0129) return 'dag-json'
    throw new Error('Unknown codec, only dag-cobor and dag-json supported for patch')
  }
}

function makeEqual (value) {
  return (node, name) => {
    // TODO: Account for deep equals of arrays/links/objects
    if (node[name] !== value) throw new Error(`Test failed, ${name} expected to be ${value}, instead got ${node[name]}`)
    return node
  }
}

function makeAdd (value) {
  return (node, name) => {
    // Detect list and insert
    if (Array.isArray(node)) {
      const copy = node.slice()
      if (name === '-') {
        copy.push(value)
      } else {
        const index = parseInt(name, 10)
        copy.splice(index, 0, value)
      }
      return copy
    }
    const updated = { ...node, [name]: value }
    return updated
  }
}

function makeRemove () {
  return (node, name) => {
    if (!(name in node)) throw new Error(`Cannot remove. Missing property ${name} in value`)
    if (Array.isArray(node)) {
      const copy = node.slice()
      const index = parseInt(name, 10)
      copy.splice(index, 1)
      return copy
    }
    const copy = { ...node }
    delete copy[name]
    return copy
  }
}
function makeReplace (value) {
  return (node, name) => {
    if (!(name in node)) throw new Error(`Cannot replace. Missing property ${name} in value`)
    if (Array.isArray(node)) {
      const copy = node.slice()
      const index = parseInt(name, 10)
      copy.splice(index, 1, value)
      return copy
    }
    const updated = { ...node, [name]: value }
    return updated
  }
}

function patchPathToSegments (path) {
  if (path.startsWith('/')) return patchPathToSegments(path.slice(1))
  if (path.endsWith('/')) return patchPathToSegments(path.slice(0, -1))
  return path.split('/').map((name) => {
    return { name }
  })
}

export async function SchemaADL (node, { schema, type }, system) {
  if (!schema || !type) {
    throw new TypeError('Must specify which type to use with the schema parameter')
  }

  const schemaCID = CID.parse(schema, system.cidBases)
  const schemaDMT = await system.getNode(schemaCID)
  const converted = makeTyped(node, schemaDMT, type, system)

  return converted
}

function makeTyped (node, schemaDMT, type, system) {
  const typedSchema = createTyped(schemaDMT, type)
  const converted = typedSchema.toTyped(node)

  if (!converted) {
    const dataView = printify(node)
    const schemaDSL = toDSL(schemaDMT)
    throw new Error(`Data did not match schema\nData: ${dataView}\nSchema: ${schemaDSL}`)
  }

  const typeDMT = schemaDMT.types[type]

  // TODO: Account for union types and deeply nested links in structs
  if (typeDMT.struct) {
    const trapped = new Proxy(converted, {
      get (target, property) {
        const value = target[property]
        const propertySchema = typeDMT.struct.fields[property]
        const expectedType = propertySchema?.type?.link?.expectedType
        if (!expectedType) return value
        const asCID = CID.asCID(value)
        if (!asCID) return value
        return system.getNode(asCID).then((resolved) => {
          return makeTyped(resolved, schemaDMT, expectedType, system)
        })
      }
    })
    return trapped
  } else if (typeDMT.map) {
    let valueType = typeDMT.map.valueType
    if (typeof valueType === 'string') {
      valueType = schemaDMT.types[valueType]
    }
    if (valueType?.link?.expectedType) {
      const expectedType = valueType.link.expectedType
      const trapped = new Proxy(converted, {
        get (target, property) {
          const value = target[property]
          const asCID = CID.asCID(value)
          if (!asCID) return value
          return system.getNode(asCID).then((resolved) => {
            return makeTyped(resolved, schemaDMT, expectedType, system)
          })
        }
      })
      return trapped
    }
  } else if (typeDMT.list) {
    let valueType = typeDMT.map.valueType
    if (typeof valueType === 'string') {
      valueType = schemaDMT.types[valueType]
    }
    if (valueType?.link?.expectedType) {
      const expectedType = valueType.link.expectedType
      const trapped = new Proxy(converted, {
        get (target, property) {
          const value = target[property]
          const asCID = CID.asCID(value)
          if (!asCID) return value
          return system.getNode(asCID).then((resolved) => {
            return makeTyped(resolved, schemaDMT, expectedType, system)
          })
        }
      })
      return trapped
    }
  }

  return converted
}
