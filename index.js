import { IPLDURL } from 'js-ipld-url'
import { create as createTyped } from '@ipld/schema/typed.js'
import { toDSL } from '@ipld/schema/to-dsl.js'
import { CID } from 'multiformats/cid'
import printify from '@ipld/printify'
import { base32 } from 'multiformats/bases/base32'
import { base36 } from 'multiformats/bases/base36'

export const DEFAULT_CID_BASES = base32.decoder.or(base36.decoder)

export default class IPLDURLSystem {
  constructor ({
    getNode,
    adls = new Map(),
    cidBases = DEFAULT_CID_BASES
  }) {
    if (!getNode) throw new TypeError('Must provide a getNode function')
    this.getNode = getNode
    this.adls = adls
    this.cidBases = cidBases
  }

  async resolve (url) {
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

    for (const { name, parameters } of segments) {
      // This does enables ADLs to return promises for properties
      data = await data[name]
      const asCID = CID.asCID(data)
      if (asCID) {
        data = await this.getNode(asCID)
      }
      data = await this.#applyParameters(data, parameters)
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
