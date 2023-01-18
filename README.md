# js-ipld-url-resolve
Resolver for IPLD URLs based on the js-IPFS DAG API. supports advanced features like schemas and escaping

## Features:

- Traverse IPLD URLs
- Support special character escaping in path segments (e.g. '/')
- Support for IPLD URL path segment parameter syntax using `;`
- Support IPLD Schemas as lenses during traversal
- Resolve Links during traversal of schemas
	- [x] Struct fields
	- [x] Map values
	- [x] List values
	- [ ] Union types
	- [ ] Links deeply nested within structs/maps
- ADL Registry for `schema` parameter to convert nodes
- Patch support
	- [x] Over plain nodes
	- [x] Over schema'd nodes
	- [x] Over ADLs

## API

```javascript
import { IPLDURLSystem } from 'js-ipld-url-resolve'

// You map provide an optional map of ADLs to use
const adls = new Map()

// This ADL will asynchronously stringify any data into a JSON string
// It's kinda useless, but you can make ADLs that return any JS object
// Whose properties can be getters that reuturn Promises that will get
// Automatically awaited during traversal.
// The `parameters` are the IPLDURL parameters for that node's segment
// Parameters might also be coming from the querystring if it's the root
adls.set('example', async (node, parameters, system) => JSON.stringify(node))

async function getNode(cid) {
    const {value} = ipfs.dag.get(cid)
    return value
}

const system = new IPLDURLSystem({
  getNode,
  adls
})

// Resolve some data from an IPLD URL
const data = await system.resolve('ipld://some_cid/some_path;schema=schema_cid;type=SchemaTypeName/plainpath/?adl=example')
```
