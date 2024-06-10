// import { sha256 } from "@noble/hashes/sha256"
import { blake3 } from "@noble/hashes/blake3"

import { NodeStore } from "./NodeStore.js"
import { Key, Node } from "./interface.js"
import { assert, hashEntry } from "./utils.js"

export class Builder {
	public readonly K: number
	public readonly Q: number

	private readonly limit: number
	private nodeCount = 1

	constructor(readonly store: NodeStore) {
		this.K = store.metadata.K
		this.Q = store.metadata.Q
		this.limit = Number((1n << 32n) / BigInt(this.Q))
	}

	public set(key: Uint8Array, value: Uint8Array): void {
		const hash = hashEntry(key, value, this.store.metadata)
		this.store.setNode({ level: 0, key, hash, value })
		this.nodeCount += 1
	}

	public finalize(): Node {
		let level = 0
		while (this.nodeCount > 1) {
			this.nodeCount = this.buildLevel(level++)
		}

		const root = this.store.getNode(level, null)
		assert(root !== null, "root not found")
		return root
	}

	private buildLevel(level: number): number {
		const iter = this.store.nodes(level)

		const next = () => {
			const { done, value } = iter.next()
			return done ? null : value
		}

		try {
			let nodeCount = 0

			let node = next()
			assert(node !== null, "level is empty")
			assert(node.level === level && node.key === null, "first node was not an anchor")

			let key: Key = node.key
			let hash = blake3.create({ dkLen: this.K })
			hash.update(node.hash)

			while (true) {
				node = next()

				if (node === null) {
					const result = hash.digest()
					this.store.setNode({ level: level + 1, key, hash: result })
					nodeCount++
					break
				}

				assert(node.level === level, "unexpected node level")
				if (this.isBoundary(node)) {
					const result = hash.digest()
					this.store.setNode({ level: level + 1, key, hash: result })
					nodeCount++
					key = node.key
					hash = blake3.create({ dkLen: this.K })
					hash.update(node.hash)
				} else {
					hash.update(node.hash)
				}
			}

			return nodeCount
		} finally {
			if (iter.return !== undefined) {
				const { done, value } = iter.return()
				assert(done && value === undefined) // ???
			}
		}
	}

	private isBoundary(node: Node): boolean {
		const view = new DataView(node.hash.buffer, node.hash.byteOffset, 4)
		return view.getUint32(0) < this.limit
	}
}
