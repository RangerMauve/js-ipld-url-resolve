import { IPLDURLSystem, IPLDURL } from './index.js'

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
  const system = new IPLDURLSystem({ getNode, saveNode })
  const cid = await put({ hello: 'world' })
  const url = `ipld://${cid}/hello`

  const resolved = await system.resolve(url)

  t.equal(resolved, 'world', 'resolved expected value')
})

test('Interpret root data via schema type', async (t) => {
  const system = new IPLDURLSystem({ getNode, saveNode })
  const schemaCID = await addSchema(`
    type Example {String:String} representation listpairs
  `)
  const dataCID = await put([
    ['Hello', 'World'],
    ['Goodbye', 'Cyberspace']
  ])
  const url = `ipld://${dataCID};schema=${schemaCID};type=Example/`

  const resolved = await system.resolve(url)

  t.deepEqual(resolved, {
    Hello: 'World',
    Goodbye: 'Cyberspace'
  }, 'Parsed data into expected structure')
})

test('Interpret nested data via schema type', async (t) => {
  const system = new IPLDURLSystem({ getNode, saveNode })
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
  const system = new IPLDURLSystem({ getNode, saveNode })
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
  const url = `ipld://${dataCID};schema=${schemaCID};type=Example/Goodbye/`

  const resolved = await system.resolve(url)

  t.deepEqual(resolved, expected, 'Parsed data into expected structure')
})

test('Traverse over links', async (t) => {
  const system = new IPLDURLSystem({ getNode, saveNode })

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

  const subURL = rootURL + 'example/'

  const expected2 = 'Hello, World?'
  const resolved2 = await system.resolve(subURL)

  t.deepEqual(resolved2, expected2, 'Resolved data pointed to by link')
})

test('Preserve schema type when traversing Links', async (t) => {
  const system = new IPLDURLSystem({ getNode, saveNode })

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
  const url = `ipld://${cid2};schema=${schemaCID};type=Example/Goodbye/`

  const resolved = await system.resolve(url)

  t.deepEqual(resolved, expected, 'Parsed data into expected structure')
})

test('Traverse segments with / in the name', async (t) => {
  const system = new IPLDURLSystem({ getNode, saveNode })

  const weirdPath = 'hello/world'
  const cid = await put({
    [weirdPath]: 'Fancy!'
  })

  const url = `ipld://${cid}/${encodeURIComponent(weirdPath)}/`

  const resolved = await system.resolve(url)

  t.equal(resolved, 'Fancy!', 'Resolved data at nested path')
})

test('Patch, add and move on root', async (t) => {
  const cid = await put({
    hello: ['world']
  })

  const patches = [
    { op: 'add', path: '/hello/0', value: 'cruel' },
    { op: 'move', path: '/goodbye', from: '/hello' }
  ]

  const url = `ipld://${cid}/`

  const system = new IPLDURLSystem({ getNode, saveNode })

  const updatedURL = await system.patch(url, patches)

  // It's determenistic! 🤯
  const expectedURL = 'ipld://bafyreiaigmnxp4ehbvt4nptoof2w7dixyanblnq3lfvxslulsrzkcpk3ni/'

  t.equal(updatedURL, expectedURL, 'Got expected result URL')

  const resolved = await system.resolve(updatedURL)

  const expected = {
    goodbye: ['cruel', 'world']
  }

  t.deepEqual(resolved, expected, 'Got expected structure')
})

test('Patch accross Link boundry', async (t) => {
  const cid1 = await put({
    hello: ['world']
  })

  const cid2 = await put({
    example: cid1
  })

  const patches = [
    { op: 'add', path: '/example/hello/0', value: 'cruel' },
    { op: 'move', path: '/example/goodbye', from: '/example/hello' }
  ]

  const url = `ipld://${cid2}/`

  const system = new IPLDURLSystem({ getNode, saveNode })

  const updatedURL = await system.patch(url, patches)

  // It's determenistic! 🤯
  const expectedURL = 'ipld://bafyreiaeh5ftdg5qmvaxsj54dm25ja5kd5446hpst3zy3u7qcx42v54f5a/'

  t.equal(updatedURL, expectedURL, 'Got expected result URL')

  const resolved = await system.resolve(updatedURL + 'example/')

  const expected = {
    goodbye: ['cruel', 'world']
  }

  t.deepEqual(resolved, expected, 'Got expected structure')
})

test.only('Patch over schema', async (t) => {
  const system = new IPLDURLSystem({ getNode, saveNode })

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

  const patches = [
    { op: 'replace', path: '/Goodbye', value: 'Cruel World' }
  ]

  const updatedURL = await system.patch(url, patches)

  // It's determenistic! 🤯
  const expectedURL = 'ipld://bafyreihg26bnrowvbnm4tqismqubtjowpnoeh364iifnlsgcnr7unmnc7u/example;schema=bafyreideyq75einxa57fkeqkgguwcbsxmuloxzmtdtzn6ft4nsijybbu6q;type=Example'

  t.equal(updatedURL, expectedURL, 'Got expected result URL')

  const resolved = await system.resolve(updatedURL)

  const expected = {
    Hello: 'World',
    Goodbye: 'Cruel World'
  }

  t.deepEqual(resolved, expected, 'Got expected structure')

  const expectedRaw = {
    example: [
      ['Hello', 'World'],
      ['Goodbye', 'Cruel World']
    ]
  }

  const { cid: updatedCid } = new IPLDURL(updatedURL)
  const updatedRawURL = `ipld://${updatedCid}/`
  const resolvedRaw = await system.resolve(updatedRawURL)
  t.deepEqual(resolvedRaw, expectedRaw, 'Got expected raw structure')
})

test.skip('Patch over schema with link')

test.skip('Patch over ADL')

test.skip('Path over link that links to a link')

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

async function saveNode (data, { encoding = 'dag-cbor', ...opts } = {}) {
  return node.dag.put(data, {
    storeCodec: encoding,
    ...opts
  })
}
