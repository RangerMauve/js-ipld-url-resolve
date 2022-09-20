import IPLDURLSystem from './index.js'

import { create } from 'ipfs-core'
import { fromDSL } from '@ipld/schema/from-dsl.js'

import test from 'tape'

const node = await create({
  silent: true,
  config: {
    Bootstrap: []
  },
  libp2p: {
    nat: {
      enabled: false
    }
  }
})

test.onFinish(() => {
  node.stop()
})

test('Load simple value from URL', async (t) => {
  const system = new IPLDURLSystem({ getNode })
  const cid = await put({ hello: 'world' })
  const url = `ipld://${cid}/hello`

  const resolved = await system.resolve(url)

  t.equal(resolved, 'world', 'resolved expected value')
})

test('Interpret root data via schema type', async (t) => {
  const system = new IPLDURLSystem({ getNode })
  const schemaCID = await addSchema(`
    type Example {String:String} representation listpairs
  `)
  const dataCID = await put([
    ['Hello', 'World'],
    ['Goodbye', 'Cyberspace']
  ])
  const url = `ipld://${dataCID}/?schema=${schemaCID}&type=Example`

  const resolved = await system.resolve(url)

  t.deepEqual(resolved, {
    Hello: 'World',
    Goodbye: 'Cyberspace'
  }, 'Parsed data into expected structure')
})

test('Interpret nested data via schema type', async (t) => {
  const system = new IPLDURLSystem({ getNode })
  const schemaCID = await addSchema(`
    type Example {String:String} representation listpairs
  `)
  const dataCID = await put({
    example: [
      ['Hello', 'World'],
      ['Goodbye', 'Cyberspace']
    ]
  })
  const url = `ipld://${dataCID}/example;schema=${schemaCID};type=Example`

  const resolved = await system.resolve(url)

  t.deepEqual(resolved, {
    Hello: 'World',
    Goodbye: 'Cyberspace'
  }, 'Parsed data into expected structure')
})

test('Apply schema for sub-nodes during pathing', async (t) => {
  const system = new IPLDURLSystem({ getNode })
  const schemaCID = await addSchema(`
    type Example struct {
      Hello String
      Goodbye NestedExample
    } representation tuple
    type NestedExample struct {
      region String
    } representation tuple
  `)
  const dataCID = await put(
    ['Hello', ['Cyberspace']]
  )

  const expected = {
    region: 'Cyberspace'
  }
  const url = `ipld://${dataCID}/Goodbye?schema=${schemaCID}&type=Example`

  const resolved = await system.resolve(url)

  t.deepEqual(resolved, expected, 'Parsed data into expected structure')
})

test('Traverse over links', async (t) => {
  const system = new IPLDURLSystem({ getNode })

  const cid1 = await put('Hello, World?')
  const cid2 = await put({
    example: cid1
  })

  const rootURL = `ipld://${cid2}/`

  const expected1 = {
    example: cid1
  }

  const resolved1 = await system.resolve(rootURL)

  t.deepEqual(resolved1, expected1, 'Resolved data with CID present')

  const subURL = rootURL + 'example'

  const expected2 = 'Hello, World?'
  const resolved2 = await system.resolve(subURL)

  t.deepEqual(resolved2, expected2, 'Resolved data pointed to by link')
})

test('Preserve schema type when traversing Links', async (t) => {
  const system = new IPLDURLSystem({ getNode })

  const schemaCID = await addSchema(`
    type Example struct {
      Hello String
      Goodbye &NestedExample
    } representation tuple
    type NestedExample struct {
      region String
    } representation tuple
  `)

  const cid1 = await put(['Cyberspace'])
  const cid2 = await put(['Hello', cid1])

  const expected = {
    region: 'Cyberspace'
  }
  const url = `ipld://${cid2}/Goodbye?schema=${schemaCID}&type=Example`

  const resolved = await system.resolve(url)

  t.deepEqual(resolved, expected, 'Parsed data into expected structure')
})

test('Traverse segments with / in the name', async (t) => {
  const system = new IPLDURLSystem({ getNode })

  const weirdPath = 'hello/world'
  const cid = await put({
    [weirdPath]: 'Fancy!'
  })

  const url = `ipld://${cid}/${encodeURIComponent(weirdPath)}/`

  const resolved = await system.resolve(url)

  t.equal(resolved, 'Fancy!', 'Resolved data at nested path')
})

async function addSchema (dslString) {
  // Convert to DMT
  const dmt = fromDSL(dslString)
  // Add to IPFS node
  const cid = put(dmt)
  // Return CID
  return cid
}

async function put (data) {
  return node.dag.put(data)
}

async function getNode (cid) {
  const { value } = await node.dag.get(cid)
  return value
}
