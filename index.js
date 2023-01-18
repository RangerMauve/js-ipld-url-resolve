import { create as createTyped } from '@ipld/schema/typed.js'
import printify from '@ipld/printify'
import { toDSL } from '@ipld/schema/to-dsl.js'

import { CID } from 'multiformats/cid'
import { base32 } from 'multiformats/bases/base32'
import { base36 } from 'multiformats/bases/base36'

import { IPLDURL } from './ipldurl.js'

export { IPLDURL } from './ipldurl.js'

// Use as method to get the "raw" form of a node that's been wrapped with an ADL
export const SUBSTRATE = Symbol.for('ipld.substrate')

// Use as a method to detect if a given CID should be wrapped with an ADL
export const ADD_LENS = Symbol.for('ipld.add_lens')

export const DEFAULT_CID_BASES = base32.decoder.or(base36.decoder)

export class IPLDURLSystem {
  #getNode = null
  #saveNode = null

  constructor ({
    getNode,
    saveNode,
    adls = new Map(),
    cidBases = DEFAULT_CID_BASES
  }) {
    if (!getNode) throw new TypeError('Must provide a getNode function')
    if (!saveNode) throw new TypeError('Must provide a saveNode function')
    this.#getNode = getNode
    this.#saveNode = saveNode
    this.adls = adls
    this.cidBases = cidBases
  }

  async getNode (cid) {
    const node = await this.#getNode(cid)
    if (cid[ADD_LENS]) {
      return cid[ADD_LENS](node)
    }
    return node
  }

  async saveNode (...args) {
    return this.#saveNode(...args)
  }

  async resolve (url, { resolveFinalCID = true } = {}) {
    const {
      cid,
      segments,
      parameters: initialParameters,
      resolveFinal
    } = new IPLDURL(url)

    let data = await this.getNode(cid)

    if (initialParameters) {
      data = await this.#applyParameters(data, initialParameters)
    }

    let lastCID = cid

    for (const { name, parameters } of segments) {
      // This does enables ADLs to return promises for properties
      data = data[name]
      lastCID = null
      const asCID = CID.asCID(data)
      if (asCID) {
        lastCID = asCID
        data = await this.getNode(asCID)
      }
      data = await this.#applyParameters(data, parameters)
    }

    if (lastCID && (!resolveFinal && !resolveFinalCID)) {
      return lastCID
    }

    return data
  }

  async #applyParameters (origin, parameters) {
    let data = origin

    // If there's no parameters, there's nothing to do
    if (!parameters) return data

    const schema = parameters.get('schema')
    const type = parameters.get('type')
    const adl = parameters.get('adl')

    const asCID = CID.asCID(data)
    if (asCID) {
      data = await this.getNode(asCID)
    }

    if (schema) {
      data = await SchemaADL(data, { schema, type }, this)
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
    const {
      cid: root,
      segments,
      parameters: initialParameters
    } = new IPLDURL(url)

    // Track root CID

    let cid = root

    // Resolve the Node the URL is pointing to
    // Apply patches to it
    // Patch in the node's substrate

    const encoding = this.getCidEncoding(cid)

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

      const node = await this.getNode(cid)

      const wrapped = await this.#applyParameters(node, initialParameters)

      const modified = await this.#applyPatch(wrapped, allSegments, operation)

      let toSave = modified
      if (modified[SUBSTRATE]) {
        toSave = toSave[SUBSTRATE]()
      }
      cid = await this.saveNode(toSave, { encoding })
    }

    // After all the modifications have occured, print the resulting URL
    const finalURL = new IPLDURL(url)
    finalURL.cid = cid

    return finalURL.href
  }

  async #applyPatch (node, segments, operation) {
    // TODO apply / unapply lenses over nodes
    const { name, parameters } = segments[0]
    const asCID = CID.asCID(node)

    if (!segments.length) {
      // TODO: How do we account for this?
    }

    let data = node

    if (segments.length === 1) {
      if (asCID) {
        data = await this.getNode(asCID)
        data = await this.#applyParameters(data, parameters)
      }

      const modified = operation(data, name)

      if (!asCID) {
        return modified
      }
      const encoding = this.getCidEncoding(asCID)

      let toSave = modified
      if (modified[SUBSTRATE]) {
        toSave = toSave[SUBSTRATE]()
      }
      const newCID = await this.saveNode(toSave, { encoding })

      return newCID
    } else {
      const [{ name }, ...remainder] = segments

      if (asCID) {
        const data = await this.getNode(asCID)
        if (!(name in data)) throw new Error(`Path ${name} not found in node`)

        const existing = data[name]

        const wrapped = await this.#applyParameters(existing, parameters)
        const updated = await this.#applyPatch(wrapped, remainder, operation)
        const modified = { ...data, [name]: updated }

        const encoding = this.getCidEncoding(asCID)

        let toSave = modified
        if (modified[SUBSTRATE]) {
          toSave = await toSave[SUBSTRATE]()
        }
        const newCID = await this.saveNode(toSave, { encoding })
        return newCID
      }

      if (!(name in node)) throw new Error(`Path ${name} not found in node`)

      const existing = node[name]

      const wrapped = await this.#applyParameters(existing, parameters)
      const updated = await this.#applyPatch(wrapped, remainder, operation)
      let final = updated
      if (updated[SUBSTRATE]) {
        final = await final[SUBSTRATE]()
      }

      if (Array.isArray(node)) {
        const copy = node.slice()
        copy[name] = final
        return copy
      } else {
        return {
          ...node,
          [name]: final
        }
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
    const currentValue = node[name]
    if (currentValue !== value) throw new Error(`Test failed, ${name} expected to be ${value}, instead got ${node[name]}`)
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
    if (!(name in node)) throw new Error(`Cannot remove. Missing property ${name} in value ${node}`)
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
    if (!(name in node)) throw new Error(`Cannot replace. Missing property ${name} in value ${node}`)
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

  converted[SUBSTRATE] = function getSubstrate () {
    const rawForm = typedSchema.toRepresentation(this)
    return rawForm
  }

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

        asCID[ADD_LENS] = (node) => {
          return makeTyped(node, schemaDMT, expectedType, system)
        }

        return asCID
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

          asCID[ADD_LENS] = (node) => {
            return makeTyped(node, schemaDMT, expectedType, system)
          }

          return asCID
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

          asCID[ADD_LENS] = (node) => {
            return makeTyped(node, schemaDMT, expectedType, system)
          }
        }
      })
      return trapped
    }
  }

  return converted
}
