import test, { ExecutionContext } from "ava"
import { text } from "node:stream/consumers"

import pg from "pg"

import { Sha256Hasher, Blake3Hasher, Tree } from "@canvas-js/okra-pg"
import { blake3 } from "@noble/hashes/blake3"

import {
	Sha256Hasher as SqliteSha256Hasher,
	Blake3Hasher as SqliteBlake3Hasher,
	Tree as SqliteTree,
} from "@canvas-js/okra-sqlite"

test.serial("compare pg to sqlite(1000)", async (t) => {
	const path = "postgresql://localhost:5432/test" // TODO
	const client = new pg.Client(path)

	const hasher = new Sha256Hasher({ size: new ArrayBuffer(4), K: 16 })
	const tree = await Tree.initialize(client, { K: 16, Q: 4, clear: true, hasher })
	const sqliteHasher = new SqliteSha256Hasher({ size: new ArrayBuffer(4), K: 16 })
	const sqliteTree = new SqliteTree(null, { K: 16, Q: 4, hasher: sqliteHasher })

	const buffer = new ArrayBuffer(4)
	const view = new DataView(buffer)
	for (let i = 0; i < 1000; i++) {
		view.setUint32(0, i)
		const key = new Uint8Array(buffer, 0, 4)
		const value = blake3(key, { dkLen: 4 })
		await tree.set(key, value)
		await sqliteTree.set(key, value)
	}

	const pgRoot = await tree.getRoot()
	await client.end()

	t.deepEqual(pgRoot, sqliteTree.getRoot())

	t.log("YAY")
	t.pass()
})

test.serial("compare pg to sqlite(100) with interleaved deletes", async (t) => {
	const path = "postgresql://localhost:5432/test" // TODO
	const client = new pg.Client(path)

	const hasher = new Sha256Hasher({ size: new ArrayBuffer(4), K: 16 })
	const tree = await Tree.initialize(client, { K: 16, Q: 4, clear: true, hasher })
	const sqliteHasher = new SqliteSha256Hasher({ size: new ArrayBuffer(4), K: 16 })
	const sqliteTree = new SqliteTree(null, { K: 16, Q: 4, hasher: sqliteHasher })

	const buffer = new ArrayBuffer(4)
	const view = new DataView(buffer)

	for (let i = 0; i < 100; i++) {
		view.setUint32(0, i)
		const key = new Uint8Array(buffer, 0, 4)
		const value = blake3(key, { dkLen: 4 })
		await tree.set(key, value)
		await sqliteTree.set(key, value)

		if (i > 50 && i % 2 === 0) {
			view.setUint32(0, i - 50)
			const key = new Uint8Array(buffer, 0, 4)

			await tree.delete(key)
			await sqliteTree.delete(key)
		}
	}

	for (let i = 0; i < 100; i++) {
		view.setUint32(0, i)
		const key = new Uint8Array(buffer, 0, 4)
		t.deepEqual(await tree.getValue(key), sqliteTree.getValue(key))
	}

	const pgRoot = await tree.getRoot()
	await client.end()

	t.deepEqual(pgRoot, sqliteTree.getRoot())

	t.log("YAY")
	t.pass()
})
