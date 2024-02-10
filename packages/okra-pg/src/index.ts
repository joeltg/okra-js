import pg from "pg"

import { blake3 } from "@noble/hashes/blake3"
import { Key, Node, assert } from "@canvas-js/okra"

type NodeRecord = { level: number; key: Uint8Array | null; hash: Uint8Array; value: Uint8Array | null }

export class Tree {
	private readonly K: number
	private readonly Q: number
	private readonly LIMIT: number
	private readonly LIMIT_KEY: Uint8Array
	private readonly LEAF_ANCHOR_HASH: Uint8Array

	private readonly client: pg.Client

	public static async initialize(client: pg.Client, options: { K?: number; Q?: number; clear?: boolean } = {}) {
		const tree = new Tree(client, options)

		await tree.client.connect()

		await tree.client.query(
			`CREATE TABLE IF NOT EXISTS nodes (level INTEGER NOT NULL, key BYTEA, hash BYTEA NOT NULL, value BYTEA)`,
		)
		await tree.client.query(`CREATE UNIQUE INDEX IF NOT EXISTS node_index ON nodes(level, key)`)

		await tree.client.query(`
DROP PROCEDURE IF EXISTS deletenode;
CREATE OR REPLACE PROCEDURE deletenode(level_ INTEGER, key_ BYTEA) AS $$
    DELETE FROM nodes WHERE level = level_ AND ((nodes.key ISNULL AND key_ ISNULL) OR (key = key_));
$$ LANGUAGE SQL;
`)

		if (options.clear) {
			await tree.client.query(`TRUNCATE nodes`)
		}

		await tree.setNode({ level: 0, key: null, hash: tree.LEAF_ANCHOR_HASH })

		return tree
	}

	constructor(client: pg.Client, options: { K?: number; Q?: number } = {}) {
		this.client = client
		this.K = options.K ?? 16 // key size
		this.Q = options.Q ?? 32 // target width
		this.LIMIT = Number((1n << 32n) / BigInt(this.Q))
		this.LIMIT_KEY = new Uint8Array(4)
		new DataView(this.LIMIT_KEY.buffer, this.LIMIT_KEY.byteOffset, this.LIMIT_KEY.byteLength).setUint32(0, this.LIMIT)
		this.LEAF_ANCHOR_HASH = blake3(new Uint8Array([]), { dkLen: this.K })
	}

	public async getRoot(): Promise<Node> {
		const { rows } = await this.client.query(`SELECT * FROM nodes ORDER BY level DESC LIMIT 1`)
		const { level, key, hash } = rows[0] as NodeRecord
		return { level, key, hash }
	}

	public async set(key: Uint8Array, value: Uint8Array) {
		const oldLeaf = await this.getNode(0, key)
		const hash = this.hashEntry(key, value)
		const newLeaf: Node = { level: 0, key, hash, value }

		await this.replace(oldLeaf, newLeaf)
	}

	public async delete(key: Uint8Array) {
		const node = await this.getNode(0, key)
		if (node === null) {
			return
		}

		if (node.key !== null && this.isBoundary(node)) {
			this.deleteParents(0, key)
		}

		this.deleteNode(0, key)

		const firstSibling = await this.getFirstSibling(node)
		if (firstSibling.key === null) {
			await this.updateAnchor(1)
		} else {
			await this.update(1, firstSibling.key)
		}
	}

	private async update(level: number, key: Key) {
		const oldNode = await this.getNode(level, key)
		const hash = await this.getHash(level, key)
		const newNode: Node = { level, key, hash }
		await this.replace(oldNode, newNode)
	}

	private async replace(oldNode: Node | null, newNode: Node) {
		if (oldNode !== null && this.isBoundary(oldNode)) {
			await this.replaceBoundary(newNode)
		} else {
			const firstSibling = await this.getFirstSibling(newNode)

			await this.setNode(newNode)
			if (this.isBoundary(newNode)) {
				await this.createParents(newNode.level, newNode.key)
			}

			if (firstSibling.key == null) {
				await this.updateAnchor(newNode.level + 1)
			} else {
				await this.update(newNode.level + 1, firstSibling.key)
			}
		}
	}

	private async replaceBoundary(node: Node) {
		if (this.isBoundary(node)) {
			await this.setNode(node)
			await this.update(node.level + 1, node.key)
		} else {
			await this.setNode(node)
			await this.deleteParents(node.level, node.key)

			const firstSibling = await this.getFirstSibling(node)
			if (firstSibling.key === null) {
				await this.updateAnchor(node.level + 1)
			} else {
				await this.update(node.level + 1, firstSibling.key)
			}
		}
	}

	private async updateAnchor(level: number) {
		const hash = await this.getHash(level, null)
		await this.setNode({ level, key: null, hash })

		const { rows } = await this.client.query(
			`SELECT key FROM nodes WHERE level = $1 AND key NOTNULL ORDER BY key LIMIT 1`,
			[level],
		)
		if (rows.length === 0) {
			await this.deleteParents(level, null)
		} else {
			await this.updateAnchor(level + 1)
		}
	}

	private async deleteParents(level: number, key: Key) {
		const node = await this.getNode(level + 1, key)
		if (node !== null) {
			await this.deleteNode(level + 1, key)
			await this.deleteParents(level + 1, key)
		}
	}

	private async createParents(level: number, key: Key) {
		const hash = await this.getHash(level + 1, key)
		const node: Node = { level: level + 1, key, hash }
		await this.setNode(node)
		if (this.isBoundary(node)) {
			await this.createParents(level + 1, key)
		}
	}

	private async getFirstSibling(node: Node): Promise<Node> {
		if (node.key === null) {
			return node
		}

		const { rows } = await this.client.query(
			`SELECT * FROM nodes WHERE level = $1 AND (key ISNULL OR (key <= $2 AND hash < $3)) ORDER BY key DESC NULLS LAST LIMIT 1`,
			[node.level, node.key, this.LIMIT_KEY],
		)
		const firstSibling = rows[0] as NodeRecord | undefined

		assert(firstSibling !== undefined, "expected firstSibling !== undefined")
		const { level, key, hash } = firstSibling
		return { level, key, hash }
	}

	private async getHash(level: number, key: Key): Promise<Uint8Array> {
		const hash = blake3.create({ dkLen: this.K })

		const limit = this.LIMIT_KEY
		const { rows } = await this.client.query(
			`SELECT * FROM nodes WHERE level = $1 - 1 AND (cast($2 as bytea) ISNULL OR (key NOTNULL AND key >= $2)) AND (
				key ISNULL OR key < (
SELECT key FROM nodes WHERE level = $1 - 1 AND key NOTNULL AND (cast($2 as bytea) ISNULL OR key > $2) AND hash < $3 ORDER BY key ASC NULLS FIRST LIMIT 1
) OR NOT EXISTS (SELECT 1 FROM nodes WHERE level = $1 - 1 AND key NOTNULL AND (cast($2 as bytea) ISNULL OR key > $2) AND hash < $3)
			) ORDER BY key ASC NULLS FIRST`,
			[level, key, limit],
		)
		const children = rows as { hash: Uint8Array }[]

		for (const child of children) {
			hash.update(child.hash)
		}

		return hash.digest()
	}

	private async getNode(level: number, key: Key): Promise<Node | null> {
		const { rows } = await this.client.query(
			`SELECT * FROM nodes WHERE level = $1 AND ((key ISNULL AND cast($2 as bytea) ISNULL) OR (key = $2))`,
			[level, key],
		)
		const row = rows[0] as NodeRecord | undefined

		if (row === undefined) {
			return null
		}

		const { hash, value } = row
		if (value === null) {
			return { level, key, hash }
		} else {
			return { level, key, hash, value }
		}
	}

	private async setNode({ level, key, hash, value }: Node) {
		if ((await this.getNode(level, key)) === null) {
			await this.client.query(`INSERT INTO nodes VALUES ($1, $2, $3, $4)`, [level, key, hash, value ?? null])
		} else {
			await this.client.query(
				`UPDATE nodes SET hash = $1, value = $2 WHERE level = $3 AND ((key ISNULL AND cast($4 as bytea) ISNULL) OR (key = $4))`,
				[hash, value ?? null, level, key],
			)
		}
	}

	private async deleteNode(level: number, key: Key) {
		await this.client.query(`CALL deletenode($1, cast($2 as bytea));`, [level, key])
	}

	private isBoundary({ hash }: Node) {
		const view = new DataView(hash.buffer, hash.byteOffset, hash.byteLength)
		return view.getUint32(0) < this.LIMIT
	}

	private static size = new ArrayBuffer(4)
	private static view = new DataView(Tree.size)

	private hashEntry(key: Uint8Array, value: Uint8Array): Uint8Array {
		const hash = blake3.create({ dkLen: this.K })
		Tree.view.setUint32(0, key.length)
		hash.update(new Uint8Array(Tree.size))
		hash.update(key)
		Tree.view.setUint32(0, value.length)
		hash.update(new Uint8Array(Tree.size))
		hash.update(value)
		return hash.digest()
	}
}
