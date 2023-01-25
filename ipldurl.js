import { CID } from 'multiformats/cid'
import { base32 } from 'multiformats/bases/base32'
import { base36 } from 'multiformats/bases/base36'

export const SEGMENT_SEPARATOR = '/'
export const PARAMETER_SEPARATOR = ';'
export const PARAMETER_SEPARATOR_REGEX = /;/g
export const ENCODED_SEPARATOR = '%3B'
export const ENCODED_SEPARATOR_REGEX = /%3B/g

export const PARAMETER_EQUALS = '='

export const DEFAULT_CID_BASES = base32.decoder.or(base36.decoder)

export class IPLDURL extends URL {
  constructor (...args) {
    super(...args)
    if (this.protocol !== 'ipld:') {
      throw new Error('IPLD URLs must start with `ipld://`')
    }
  }

  get resolveFinal () {
    return this.pathname.endsWith('/')
  }

  get parameters () {
    const raw = this.hostname.split(PARAMETER_SEPARATOR).slice(1)
    return new IPLDURLParameters(raw)
  }

  set parameters (parameters) {
    const cid = this.cid
    const parsedParameters = new IPLDURLParameters(parameters)

    this.hostname = cid.toString() + parsedParameters.toString()
  }

  set cid (cid) {
    const parameters = this.parameters
    this.hostname = cid.toString() + parameters.toString()
  }

  get cid () {
    const raw = this.hostname.split(PARAMETER_SEPARATOR)[0]
    return CID.parse(raw, DEFAULT_CID_BASES).toV1()
  }

  get segments () {
    return IPLDURLSegments.decode(this.pathname.slice(1))
  }

  set segments (segments) {
    this.pathname = IPLDURLSegments.encode(segments)
  }
}

export class IPLDURLSegments {
  static encode (segments) {
    if (!segments || !segments.length) return ''
    return segments
      .map((segment) => {
        if (typeof segment === 'string') {
          return encode(segment)
        } else if (segment instanceof IPLDURLSegment) {
          return segment.toString()
        } else if ((typeof segment === 'object') && ('name' in segment)) {
          const segmentObject = new IPLDURLSegment(segment.name, segment.parameters)
          return segmentObject.toString()
        } else {
          throw new Error('Segment must be a string name, an IPLDURLSegment object, or a plain object with a `name` and `parameters`')
        }
      })
      .join('/')
  }

  static decode (pathname) {
    if (!pathname || !pathname.length) return []
    const segments = pathname
      .split(SEGMENT_SEPARATOR)
      .map((segment) => new IPLDURLSegment(segment))
    if (pathname.endsWith('/')) {
      segments.pop()
    }
    return segments
  }
}

export class IPLDURLParameters {
  #entries = []

  constructor (parameters) {
    if (!parameters) {
      // This is fine, it's null
    } else if (parameters instanceof IPLDURLParameters) {
      this.#entries = [...parameters.entries()]
    } else {
      let toAdd = []
      if (typeof parameters === 'string') {
        toAdd = parameters.split(PARAMETER_SEPARATOR)
          .map((pair) => {
            const [key, value] = pair.split(PARAMETER_EQUALS)
            return [decodeURIComponent(key), decodeURIComponent(value)]
          })
      } else if (parameters[Symbol.iterator]) {
        toAdd = parameters
      } else {
        toAdd = Object.entries(parameters)
      }

      for (const entry of toAdd) {
        if (Array.isArray(entry)) {
          const [key, value] = entry
          if (Array.isArray(value)) {
            for (const subValue of value) {
              this.#entries.push([key, subValue])
            }
          } else {
            this.#entries.push([key, value])
          }
        } else {
          const [key, value] = entry.split(PARAMETER_EQUALS)
          this.#entries.push([
            decodeURIComponent(key),
            decodeURIComponent(value)
          ])
        }
      }
    }
  }

  [Symbol.iterator] () {
    return this.entries()
  }

  get (key) {
    for (const [entryKey, value] of this.#entries) {
      if (entryKey === key) return value
    }
    return null
  }

  set (key, value) {
    for (const entry of this.#entries) {
      const [entryKey] = entry
      if (entryKey !== key) continue
      entry[1] = value
      return
    }
    this.#entries.push([key, value])
  }

  append (key, value) {
    this.#entries.push([key, value])
  }

  delete (key) {
    this.#entries = this.#entries.filter(([entryKey]) => entryKey !== key)
  }

  getAll (key) {
    return this.#entries
      .filter(([entryKey]) => entryKey === key)
      .map(([entryKey, value]) => value)
  }

  has (key) {
    for (const [entryKey] of this.#entries) {
      if (entryKey === key) return true
    }
    return false
  }

  * entries () {
    yield * this.#entries
  }

  * keys () {
    yield * this.entries.map(([key]) => key)
  }

  * values () {
    yield * this.entries.map(([key, value]) => value)
  }

  toString () {
    const segments = this.#entries.map(([key, value]) => {
      return `;${encode(key)}=${encode(value)}`
    })

    return segments.join('')
  }
}

export class IPLDURLSegment {
  #parameters = null
  #name = ''

  constructor (name, init) {
    const hasInit = init !== undefined
    if (hasInit) {
      this.name = name
      if (init) {
        this.parameters = init
      }
    } else {
      const [realName, ...paramPairs] = name.split(PARAMETER_SEPARATOR)
      this.name = realName
      this.parameters = paramPairs
    }
  }

  #inspect () {
    return this.name + ' ' + JSON.stringify(this.parameters)
  }

  [Symbol.for('Deno.customInspect')] () {
    return this.#inspect()
  }

  [Symbol.for('nodejs.util.inspect.custom')] () {
    return this.#inspect()
  }

  get name () {
    return this.#name
  }

  set name (name) {
    this.#name = decodeURIComponent(name)
  }

  get parameters () {
    return this.#parameters
  }

  set parameters (parameters) {
    this.#parameters = new IPLDURLParameters(parameters)
  }

  toString () {
    const encodedName = encode(this.#name)

    return encodedName + this.#parameters.toString()
  }
}

function encode (string) {
  return encodeURIComponent(string)
    .replace(PARAMETER_SEPARATOR_REGEX, ENCODED_SEPARATOR)
}
